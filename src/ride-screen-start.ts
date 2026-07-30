// Screen 6 — "Start in Veo" (frontend plan, `ride-screen-start.ts` row;
// master Part 0 Screen 6: "Most similar to the current pre-start page. Since
// the scooter and its start link are known: offer Android and Apple
// 'Start in Veo' buttons which trigger a default 10 s countdown; an
// 'I already started' button skips the countdown. After countdown or manual
// start, ride mode initiates.").
//
// This is the reducer's ONLY seat for `rideStarted` (`ride-session.ts`:
// legal only from phase `countdown` or `wizard:6`), so it owns the single
// `POST /tracked-rides` call for this flow — the master's data-flow diagram
// ("S6 start) → POST /tracked-rides") and the reducer's own recovery-table
// comment ("crash before `startTrackedRide` resolved … reopen the wizard at
// `wizard:6`") both anchor the call here, not earlier in the wizard.
//
// ---------------------------------------------------------------------------
// DEVIATION — the skip predicate's scope, and what it leaves unstarted.
//
// The lane brief is explicit: skip unless a Screen 2 device selection
// resolves to a real (non-"own") Veo device AND `RideOptions.cost_hud` is on
// — quoting the master doc's own Screen 6 heading verbatim: "(specific Veo
// device + cost-HUD tracking opted)". Implemented exactly as `startScreenSkip`
// below.
//
// Flagging for the integrator: taken literally, this means an "own device"
// ride or a device ride with the cost HUD toggled off never lands on Screen 6
// at all — and since `rideStarted` has no OTHER legal entry point in the
// current reducer, neither flavor of ride has any way to reach `riding`
// through this wizard as it stands today. Master Part 0 clearly intends "My
// own Device" to be a first-class Screen 2 choice, so this is very likely a
// real gap rather than an intentional one — but resolving it means either (a)
// a second, simpler "just start" screen/branch for the skip case, which is a
// product-copy decision (this lane doesn't have the owner's copy for that
// state and didn't want to invent it unreviewed), or (b) revisiting whether
// `cost_hud` was really meant to gate this screen at all, as opposed to
// merely describing the "why a countdown" framing. Left for the integrator /
// owner to resolve; this module implements the literal instruction and does
// not silently reinterpret it.
// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------
// SCOPE NOTE — track-store is deliberately NOT touched here.
//
// `startTrackedRide`'s response carries `track_signing` (the per-ride HMAC
// key material `track-store.ts` needs to start recording), but wiring
// `openTrackStore()` / `TrackRecorder.startServerRide()` is Phase F3's job
// ("live track-store integration", a separate lane) together with the shared
// `watchPosition` feed. This screen's contract with that lane is the
// `onRideStarted` hook below: it fires with the full `StartedTrackedRide`
// (track_signing included) right after the session dispatch, before
// `ctx.next()` hands off to the HUD, so whichever module owns the recorder
// can start it before any fix arrives. Until that lane wires the hook, this
// screen still compiles and works — `onRideStarted` is optional.
// ---------------------------------------------------------------------------

import {
  registerRideScreen,
  type RideScreen,
  type RideScreenContext,
} from "./ride-modal.ts";
import type { Locate, LngLat } from "./locate.ts";
import { veoDeepLink } from "./config.ts";
import {
  selectedDevice,
  type RideSessionDoc,
  type RideSessionSelectedDevice,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  ApiError,
  startTrackedRide as defaultStartTrackedRide,
  type StartedTrackedRide,
  type StartTrackedRideIn,
} from "./api.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Screen 6's default countdown, in seconds. MUST match `ride-hud.ts`'s own
 *  default delay (the `<option selected>` in its `#hud-delay` picker) — the
 *  master vision names "a default 10 s countdown" once, and the legacy HUD's
 *  in-page countdown is that same default until F3 retires it. `ride-hud.ts`
 *  is out of this lane's edit scope (a sibling F3 lane owns it), so this
 *  constant can't import the other side's value — instead, this module's own
 *  test file reads `ride-hud.ts`'s SOURCE to pull the live default out of it,
 *  so the two can never silently drift apart without a failing test flagging
 *  it. Do not "fix" this test by hardcoding a second literal `10`. */
export const START_COUNTDOWN_S = 10;

// ---------------------------------------------------------------------------
// Skip predicate
// ---------------------------------------------------------------------------

/** Master Part 0 Screen 6 heading, verbatim condition: "specific Veo device +
 *  cost-HUD tracking opted". `selectedDevice` returns null for "own device"
 *  and for no selection at all, so both are folded into the same "not
 *  applicable" branch. See the module DEVIATION note above for what this
 *  means for own-device / cost_hud-off rides. */
export function startScreenSkip(doc: RideSessionDoc | null): boolean {
  if (!doc) return true;
  const device = selectedDevice(doc.device);
  return !(device !== null && doc.options.cost_hud === true);
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
  /** Clock injection for tests; defaults to `Date.now`. Only used as a
   *  fallback when the server's own `started_at` fails to parse. */
  now?(): number;
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

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function deviceSummaryLabel(device: RideSessionSelectedDevice): string {
  const name = device.model ? titleCase(device.model) : "Scooter";
  return device.plate ? `${name} — plate ${device.plate}` : name;
}

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

// ---------------------------------------------------------------------------
// Screen build
// ---------------------------------------------------------------------------

function buildStartScreen(
  ctx: RideScreenContext,
  deps: RideScreenStartDeps,
): RideScreen {
  const doc0 = deps.session.current();
  const device0 = doc0 ? selectedDevice(doc0.device) : null;

  // Defensive: `startScreenSkip` should have kept the router off this screen
  // for anything else, but a stray direct `ctx.go("6")` (or a test harness
  // building the factory straight) must not crash — never strand the rider
  // inside a broken dialog (`ride-modal.ts`'s own discipline for a throwing
  // factory).
  if (!doc0 || !device0) {
    const root = el("div", "ride-wizard__body ride-screen-start");
    root.append(
      el("p", "ride-wizard__lede", "No scooter selected"),
      el(
        "p",
        "ride-wizard__hint",
        "Go back and pick the scooter you're standing next to before starting in Veo.",
      ),
    );
    return { title: "Start in Veo", primary: root };
  }

  let destroyed = false;
  let mode: "idle" | "counting" = "idle";
  let busy = false;
  let remaining = START_COUNTDOWN_S;
  let errorMessage: string | null = null;
  let fix: LngLat | null = deps.locate.current();
  let countdownTimer: number | undefined;
  let abortController: AbortController | null = null;

  const root = el("div", "ride-wizard__body ride-screen-start");

  function canStart(): boolean {
    return !busy && mode === "idle" && fix !== null;
  }

  function render(): void {
    root.replaceChildren();
    if (busy) {
      root.append(el("p", "ride-wizard__lede", "Starting your ride…"));
      return;
    }
    if (mode === "counting") {
      renderCounting();
      return;
    }
    renderIdle();
  }

  function renderIdle(): void {
    const doc = deps.session.current();
    const device = doc ? selectedDevice(doc.device) : null;
    if (!doc || !device) {
      root.append(
        el(
          "p",
          "ride-wizard__hint",
          "Go back and pick the scooter you're standing next to before starting in Veo.",
        ),
      );
      return;
    }

    root.append(el("p", "ride-wizard__lede", deviceSummaryLabel(device)));
    root.append(
      el(
        "p",
        "ride-wizard__hint",
        `Tap Start in Veo, then unlock the scooter in the app. Ride mode begins ${START_COUNTDOWN_S}s later — or tap "I already started" if you've already unlocked it.`,
      ),
    );

    if (fix === null) {
      root.append(
        el(
          "p",
          "ride-wizard__hint",
          "Waiting for your location before we can start the ride…",
        ),
      );
    }

    if (errorMessage) {
      const err = el("p", "ride-modal__hint", errorMessage);
      err.setAttribute("role", "status");
      err.setAttribute("aria-live", "polite");
      root.append(err);
    }

    const plate = device.plate || null;
    // Both buttons resolve the SAME Adjust universal link — one `href`
    // computed once and assigned to both anchors, byte-identical by
    // construction (Android/Apple are per-platform labels only; Adjust's own
    // redirect handles app-vs-store routing — see the module map row).
    const href = plate ? veoDeepLink(plate) : null;

    const actions = el("div", "ride-wizard__actions");
    const androidBtn = el(
      "a",
      "login-btn",
      "▶️ Start in Veo — Android",
    ) as HTMLAnchorElement;
    const appleBtn = el(
      "a",
      "login-btn",
      "▶️ Start in Veo — iPhone",
    ) as HTMLAnchorElement;
    for (const a of [androidBtn, appleBtn]) {
      if (href) {
        a.href = href;
      } else {
        a.removeAttribute("href");
      }
      const disabled = !canStart();
      a.toggleAttribute("disabled", disabled);
      a.setAttribute("aria-disabled", disabled ? "true" : "false");
      a.addEventListener("click", (e) => {
        if (!canStart()) {
          e.preventDefault();
          return;
        }
        onStartTapped();
      });
    }

    const alreadyBtn = el(
      "button",
      "login-btn login-btn--secondary",
      "I already started",
    );
    alreadyBtn.type = "button";
    alreadyBtn.disabled = !canStart();
    alreadyBtn.addEventListener("click", () => onAlreadyStarted());

    actions.append(androidBtn, appleBtn, alreadyBtn);
    root.append(actions);
    if (!plate) {
      root.append(
        el(
          "p",
          "ride-wizard__hint",
          "We don't have this scooter's plate yet — you can still start once you're on the scooter.",
        ),
      );
    }
  }

  function renderCounting(): void {
    const card = el("div", "ride-screen-start__countdown");
    card.append(
      el(
        "div",
        "ride-screen-start__countdown-digit",
        String(Math.max(0, remaining)),
      ),
      el(
        "p",
        "ride-wizard__hint",
        "Scan the QR and start the scooter — the clock starts when this hits zero.",
      ),
    );
    const cancelBtn = el(
      "button",
      "login-btn login-btn--secondary",
      "Cancel",
    );
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => onCancelCountdown());
    card.append(cancelBtn);
    root.append(card);
  }

  // ---------------- actions ----------------

  function onStartTapped(): void {
    if (!canStart()) return;
    errorMessage = null;
    mode = "counting";
    remaining = START_COUNTDOWN_S;
    // Screen 6's own transition — legal only from `wizard:6` (ride-session.ts).
    deps.session.dispatch({ type: "startCountdown" });
    render();
    countdownTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(countdownTimer);
        countdownTimer = undefined;
        void finishStart();
      } else {
        render();
      }
    }, 1000);
  }

  function onAlreadyStarted(): void {
    if (!canStart()) return;
    errorMessage = null;
    // The `beginCountdown(0)` equivalent: straight to `finishStart` without
    // ever dispatching `startCountdown` — `rideStarted` is legal directly
    // from `wizard:6` (ride-session.ts), so no phase change is needed first.
    void finishStart();
  }

  function onCancelCountdown(): void {
    if (countdownTimer !== undefined) {
      window.clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
    mode = "idle";
    // The only legal way back off an un-started countdown (ride-session.ts:
    // "Cancelling an un-started countdown is the only way back off Screen 6").
    deps.session.dispatch({ type: "goto", screen: "6" });
    render();
  }

  async function finishStart(): Promise<void> {
    if (destroyed) return;
    const doc = deps.session.current();
    const device = doc ? selectedDevice(doc.device) : null;
    const fixNow = deps.locate.current();
    if (!doc || !device || !fixNow) {
      mode = "idle";
      errorMessage = "We lost your location or scooter selection — try again.";
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
      mode = "idle";
      errorMessage = describeStartError(err);
      // `goto` back to Screen 6 is a no-op from `wizard:6` and the sanctioned
      // un-start from `countdown` — legal from both paths that lead here.
      deps.session.dispatch({ type: "goto", screen: "6" });
      render();
    }
  }

  // ---------------- mount ----------------

  render();
  const unFix = deps.locate.onFix((pos) => {
    if (destroyed) return;
    fix = pos;
    if (mode === "idle" && !busy) render();
  });
  ctx.onCleanup(unFix);
  ctx.onCleanup(() => {
    if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
    abortController?.abort();
  });

  return {
    title: "Start in Veo",
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
