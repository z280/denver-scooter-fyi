// Screen 6 — automatic ride start.
//
// This used to be the "Start in Veo" page: Android/Apple deep-link buttons, a
// 10 s countdown, and an "I already started" skip. That page assumed every
// rider was coordinating with the Veo app, which made the flow hostile to
// non-Veo riders (and one tap slower for everyone). It is gone: this screen
// now starts ride mode by itself the moment it mounts with a location fix —
// no buttons, no countdown, no Veo branding. A Veo rider unlocks their
// scooter in the Veo app on their own schedule; the device popup's own
// "▶️ Start in Veo" deep link (devices.ts) still exists for that.
//
// The screen itself stays IN the flow because it is the reducer's ONLY seat
// for `rideStarted` (`ride-session.ts`: legal from phase `countdown` or
// `wizard:6`), so it owns the single `POST /tracked-rides` call for this
// flow — the master's data-flow diagram ("S6 start) → POST /tracked-rides")
// and the reducer's own recovery-table comment ("crash before
// `startTrackedRide` resolved … reopen the wizard at `wizard:6`") both anchor
// the call here. Recovery that reopens at `wizard:6` now simply re-attempts
// the start automatically.
//
// ---------------------------------------------------------------------------
// FIX (carried over) — guest/private rides must never call the authed-only
// start endpoint.
//
// `startTrackedRide` (api.ts) is `authedFetchJSON`-backed — session-authed,
// 401s with no bearer token. A guest's real-device pick is still a PRIVATE
// ride (`ride-screen-select.ts`'s `syncSessionDevice` sets `doc.private`
// accordingly), and `ride-session.ts`'s `rideStarted` action supports a
// `rideId: null` / `private: true` local-only start for exactly this case.
// `finishStart` below branches on `doc.private`: a private ride never
// attempts the network call and instead starts locally, matching the master
// glossary's guest ride ("no server key, no points; tracks stay local"). An
// own-device ("My Scooter/Bike") ride is ALWAYS private and takes the same
// branch.
//
// ---------------------------------------------------------------------------
// SCOPE NOTE — track-store is deliberately NOT touched here.
//
// `startTrackedRide`'s response carries `track_signing` (the per-ride HMAC
// key material `track-store.ts` needs to start recording). This screen's
// contract with that lane is the `onRideStarted` hook below: it fires with
// the full `StartedTrackedRide` (track_signing included) right after the
// session dispatch, before `ctx.next()` hands off to the HUD, so whichever
// module owns the recorder can start it before any fix arrives.
// `onPrivateRideStarted` is the private-ride mirror.
// ---------------------------------------------------------------------------

import {
  registerRideScreen,
  type RideScreen,
  type RideScreenContext,
} from "./ride-modal.ts";
import type { Locate, LngLat } from "./locate.ts";
import {
  isOwnDevice,
  selectedDevice,
  type RideSessionDoc,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  ApiError,
  startTrackedRide as defaultStartTrackedRide,
  type StartedTrackedRide,
  type StartTrackedRideIn,
} from "./api.ts";

// ---------------------------------------------------------------------------
// Skip predicate
// ---------------------------------------------------------------------------

/** Screen 6 runs for any selected device — own or real — and skips only
 *  when nothing was picked at all. */
export function startScreenSkip(doc: RideSessionDoc | null): boolean {
  if (!doc) return true;
  return doc.device === null;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type SessionLike = Pick<RideSessionStore, "current" | "dispatch">;

/** Read-only: GPS enablement is Screen 1's job, this screen only reads the
 *  resolved fix (the ride's `start_lat`/`start_lon`) and reacts to a late one
 *  arriving. */
export type LocateLike = Pick<Locate, "current" | "onFix">;

export interface RideScreenStartDeps {
  session: SessionLike;
  locate: LocateLike;
  /** Injected for tests; defaults to `startTrackedRide` from api.ts. */
  startTrackedRide?(
    body: StartTrackedRideIn,
    signal?: AbortSignal,
  ): Promise<StartedTrackedRide>;
  /** Fires once, right after a successful start (session already dispatched
   *  `rideStarted`, before `ctx.next()` hands off) — see the module's SCOPE
   *  NOTE. Optional so this lane's own tests, and any build before the
   *  track-store lane wires it, don't need a fake. */
  onRideStarted?(ride: StartedTrackedRide): void;
  /** Fires once, right after a successful PRIVATE start (session already
   *  dispatched `rideStarted` with this same `trackKeyId`, before
   *  `ctx.next()` hands off) — the private-ride mirror of `onRideStarted`.
   *  Lets the integrator mint the local `TrackRecorder` under the SAME id
   *  the session doc already carries: `track-store.ts`'s
   *  `resumeRide(trackId, {isPrivate: true})` mints a brand-new private ride
   *  under a caller-supplied id when no local record exists yet (see that
   *  function's own doc comment) — the one-ID contract this hook exists to
   *  make possible. Optional for the same reasons as `onRideStarted`. */
  onPrivateRideStarted?(trackKeyId: string): void;
  /** Fires when `startTrackedRide` throws a 409 — "an active ride already
   *  exists" (that function's own doc comment: "the resume-or-end prompt's
   *  trigger"). The caller fetches the conflicting ride and shows the shared
   *  prompt (`ride-resume-prompt.ts`'s `showResumeOrEnd`, built from
   *  `ride-session.ts`'s exported `recoveryForServerConflict`) instead of
   *  this screen's own dead-end static error copy. Optional: omitted falls
   *  back to `describeStartError`'s static 409 message (tests, or any build
   *  before this hook is wired). */
  onServerConflict?(): void;
  /** Clock injection for tests; defaults to `Date.now`. Only used as a
   *  fallback when the server's own `started_at` fails to parse, and as the
   *  private-ride start clock (there is no server `started_at` to prefer). */
  now?(): number;
  /** Injected for tests (deterministic ids); defaults to
   *  `crypto.getRandomValues`. Only used for a private/guest ride's local
   *  `trackKeyId` — a real server ride's id comes from the API response. */
  randomBytes?(n: number): Uint8Array;
}

/** Register Screen 6. Call once at startup; returns an unregister function
 *  for tests/HMR. */
export function wireRideScreenStart(deps: RideScreenStartDeps): () => void {
  return registerRideScreen("6", {
    skip: () => startScreenSkip(deps.session.current()),
    factory: (ctx) => buildStartScreen(ctx, deps),
  });
}

// ---------------------------------------------------------------------------
// Copy / formatting helpers
// ---------------------------------------------------------------------------

function describeStartError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "You already have an active ride running — check another tab or device, or come back once it's finished.";
    }
    if (err.status === 404) {
      return "That scooter isn't in the live feed anymore — go back and pick another.";
    }
  }
  return "Couldn't start the ride — check your connection and try again.";
}

/** The server's own `started_at` is the authoritative clock (it is what the
 *  ride row itself was created with); the client `now()` is only a fallback
 *  for the — extremely unlikely — case that field fails to parse. */
function resolveStartedAtMs(ride: StartedTrackedRide, now: () => number): number {
  const ms = Date.parse(ride.started_at);
  return Number.isFinite(ms) ? ms : now();
}

/** `private-<hex>` local track id (ride-session.ts's `RideSessionDoc.
 *  trackKeyId` doc: "a `private-<hex>` local id for a private one"; the same
 *  convention `track-store.ts`'s own `startPrivateRide` uses). Generated here
 *  rather than imported from `track-store.ts` — this is only what the SESSION
 *  transition needs to identify the local, unsigned recording it names. */
function randomPrivateTrackId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(6);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `private-${hex}`;
}

function defaultRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Screen build
// ---------------------------------------------------------------------------

function buildStartScreen(
  ctx: RideScreenContext,
  deps: RideScreenStartDeps,
): RideScreen {
  const doc0 = deps.session.current();
  const device0 = doc0 ? selectedDevice(doc0.device) : null;
  const own0 = doc0 ? isOwnDevice(doc0.device) : false;

  // Defensive: `startScreenSkip` should have kept the router off this screen
  // for anything else, but a stray direct `ctx.go("6")` (or a test harness
  // building the factory straight) must not crash — never strand the rider
  // inside a broken dialog (`ride-modal.ts`'s own discipline for a throwing
  // factory).
  if (!doc0 || (!device0 && !own0)) {
    const root = el("div", "ride-wizard__body ride-screen-start");
    root.append(
      el("p", "ride-wizard__lede", "No ride selected"),
      el(
        "p",
        "ride-wizard__hint",
        "Go back and pick the device you're about to ride.",
      ),
    );
    return { title: "Starting ride", primary: root };
  }

  let destroyed = false;
  let busy = false;
  /** The one automatic attempt has fired. A failed attempt hands the rider a
   *  visible "Try again" instead of retrying invisibly forever. */
  let attempted = false;
  let errorMessage: string | null = null;
  let fix: LngLat | null = deps.locate.current();
  let abortController: AbortController | null = null;

  const root = el("div", "ride-wizard__body ride-screen-start");

  function canStart(): boolean {
    return !busy && fix !== null;
  }

  /** Fire the automatic start once the preconditions hold. Called at mount
   *  and again on every location fix — at mount there is very often no fix
   *  yet (Screen 1 primed the permission; the first reading can lag), and
   *  the auto-start must wait for it rather than failing on the spot. */
  function maybeAutoStart(): void {
    if (attempted || destroyed || !canStart()) return;
    attempted = true;
    void finishStart();
  }

  function render(): void {
    root.replaceChildren();
    if (busy) {
      root.append(el("p", "ride-wizard__lede", "Starting your ride…"));
      return;
    }

    // A settled failed attempt: the rider gets a visible way forward rather
    // than an invisible retry loop. On the 409 path `errorMessage` is null —
    // the resume-or-end prompt is telling the story — but Try again still
    // shows in case that prompt was dismissed.
    if (attempted) {
      root.append(el("p", "ride-wizard__lede", "Ride mode didn't start"));
      if (errorMessage) {
        const err = el("p", "ride-modal__hint", errorMessage);
        err.setAttribute("role", "status");
        err.setAttribute("aria-live", "polite");
        root.append(err);
      }
      const actions = el("div", "ride-wizard__actions");
      const retryBtn = el("button", "login-btn", "Try again");
      retryBtn.type = "button";
      retryBtn.disabled = !canStart();
      retryBtn.addEventListener("click", () => {
        if (!canStart()) return;
        errorMessage = null;
        void finishStart();
      });
      actions.append(retryBtn);
      root.append(actions);
      return;
    }

    root.append(el("p", "ride-wizard__lede", "Starting ride mode…"));
    if (fix === null) {
      root.append(
        el(
          "p",
          "ride-wizard__hint",
          "Waiting for your location before we can start the ride…",
        ),
      );
    }
  }

  async function finishStart(): Promise<void> {
    if (destroyed) return;
    const doc = deps.session.current();
    const device = doc ? selectedDevice(doc.device) : null;
    const own = doc ? isOwnDevice(doc.device) : false;
    const fixNow = deps.locate.current();
    if (!doc || (!device && !own) || !fixNow) {
      errorMessage = "We lost your location or ride selection — try again.";
      deps.session.dispatch({ type: "goto", screen: "6" });
      render();
      return;
    }

    // Guest / private ride (see the module FIX note): never attempt the
    // authed-only `POST /tracked-rides` — it would throw NO_AUTH for a
    // signed-out rider every time. An own-device ("My Scooter/Bike") ride is
    // ALWAYS private and takes this same branch. Start locally instead: no
    // `rideId`, a freshly generated local `trackKeyId`, `private: true`.
    // `onPrivateRideStarted` fires with the SAME `trackKeyId` just
    // dispatched, so the caller can attach a local `TrackRecorder` under
    // that exact id (`track-store.ts`'s `resumeRide(trackId, {isPrivate:
    // true})` mints a brand-new private ride keyed on a caller-supplied id
    // when no local record exists yet) instead of the two modules
    // independently generating two unrelated ids.
    if (doc.private) {
      const nowFn = deps.now ?? (() => Date.now());
      const randomBytesFn = deps.randomBytes ?? defaultRandomBytes;
      const trackKeyId = randomPrivateTrackId(randomBytesFn);
      deps.session.dispatch({
        type: "rideStarted",
        rideId: null,
        startedAtMs: nowFn(),
        trackKeyId,
        private: true,
      });
      deps.onPrivateRideStarted?.(trackKeyId);
      ctx.next();
      return;
    }

    // Non-private: a server-tracked ride, which requires a real device — an
    // own-device ride is always private (see above) and never reaches here.
    // Defensive only; the guard above and `startScreenSkip` already ensure
    // this in practice.
    if (!device) {
      errorMessage = "We lost your location or ride selection — try again.";
      deps.session.dispatch({ type: "goto", screen: "6" });
      render();
      return;
    }

    busy = true;
    render();
    abortController = new AbortController();
    const body: StartTrackedRideIn = {
      vehicle_identifier: device.vehicleIdentifier,
      start_lat: fixNow.lat,
      start_lon: fixNow.lng,
      ride_options: doc.options,
    };
    if (device.batteryConfirmed !== null) {
      body.reported_start_battery_percent = device.batteryConfirmed;
    }

    try {
      const started = await (
        deps.startTrackedRide ?? defaultStartTrackedRide
      )(body, abortController.signal);
      if (destroyed) return;
      const nowFn = deps.now ?? (() => Date.now());
      deps.session.dispatch({
        type: "rideStarted",
        rideId: started.id,
        startedAtMs: resolveStartedAtMs(started, nowFn),
        trackKeyId: started.id,
        private: false,
      });
      deps.onRideStarted?.(started);
      ctx.next();
    } catch (err) {
      if (destroyed) return;
      busy = false;
      if (err instanceof ApiError && err.status === 409 && deps.onServerConflict) {
        // The resume-or-end prompt's trigger (see `startTrackedRide`'s own
        // doc comment) — hand off to the caller instead of a dead-end
        // static message; it fetches the conflicting ride and shows the
        // shared prompt (`ride-resume-prompt.ts`). `errorMessage` stays
        // null: the prompt is telling the story.
        errorMessage = null;
        deps.onServerConflict();
      } else {
        errorMessage = describeStartError(err);
      }
      // `goto` back to Screen 6 is a legal no-op from `wizard:6`.
      deps.session.dispatch({ type: "goto", screen: "6" });
      render();
    }
  }

  // ---------------- mount ----------------

  render();
  maybeAutoStart();
  const unFix = deps.locate.onFix((pos) => {
    if (destroyed) return;
    fix = pos;
    if (!busy) render();
    // A late first fix is the common path: Screen 1 primed the permission,
    // but the reading itself usually lands after this screen has mounted.
    maybeAutoStart();
  });
  ctx.onCleanup(unFix);
  ctx.onCleanup(() => {
    abortController?.abort();
  });

  return {
    title: "Starting ride",
    primary: root,
    destroy() {
      destroyed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// DOM helper (the repo's own `el()`, verbatim in spirit)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
