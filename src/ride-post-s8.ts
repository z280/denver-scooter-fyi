// Screen 8 — post-ride cost summary + New Destination / "I ended my ride in
// Veo" (frontend plan, `ride-post.ts` row's S8 slice; master Part 0 Screen 8;
// F4 Phase, simplified in a later friction-reduction pass — see below).
//   Ride time: __:__ (stop)
//   Est Cost: Unlock $ + Per Min $ + Tax $ = Total $
//   ** The Veo app is your bill **
//   [New Destination] [I ended my ride in Veo]
//
// ---------------------------------------------------------------------------
// FRICTION-REDUCTION REWRITE — dropped the rider-entered battery%/cost/
// minutes form and the separate [Rush Quit] shortcut around it.
//
// Two real bugs motivated this, both confirmed against a live signed-in ride:
//
//  1. The dedicated "I ended my ride in Veo" form (`renderVeoForm`, since
//     removed) re-ran this module's own `render()` on every keystroke into
//     any of its three text fields. `render()` did `card.replaceChildren()`
//     (destroying every existing input, including whichever one currently
//     held focus) and then unconditionally focused the FIRST focusable
//     element in the freshly rebuilt DOM — always the battery field, since it
//     was first in tab order. Typing into the SECOND or THIRD field (cost,
//     minutes) therefore yanked focus back to the battery field after every
//     single character: those two fields were, in practice, nearly
//     impossible to type into. `render()` here now only ever runs off a
//     state change that isn't "the rider is mid-keystroke" (there are no
//     more text fields on this screen at all), so this class of bug can't
//     recur — see the module's remaining `render()` for the surviving
//     (harmless, button-only) focus-on-render behavior.
//  2. Because that form could almost never be completed, riders had no way
//     to reach [Submit] — so `endTrackedRide` never fired, `endReported`
//     never dispatched, and the ride never progressed to Screen 9/10's
//     donation flow. [Rush Quit] (the "get me out of this form" escape
//     hatch) explicitly dispatched `rushQuit` instead of `endReported` — by
//     design skipping S9/S10 entirely — so even riders who escaped the
//     broken form that way still never got asked to donate or earn points.
//
// The fix: stop asking for battery%/cost/minutes at all. The server already
// derives its own end-of-ride battery reading from the GBFS feed
// (`TrackedRide.gbfs_end_battery_percent`) independently of anything a rider
// types, `total_cost_cents`/`reported_battery_percent`/`reported_minutes`/
// `reported_plan` are all optional on `EndRideIn` (api.ts), and Screens 9/10
// already implement exactly the "ask at the end, only if there's data"
// donation flow this rewrite leans on — they were never the problem, Screen
// 8's form was. One button now does what both old buttons did combined:
// send the minimal end report (`buildMinimalEndBody` — same body as the old
// [Rush Quit]) and ALWAYS dispatch `endReported` with fresh gate facts, so
// every ride reaches the survey/eligibility check every other button used to
// skip.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ARCHITECTURE — why this is a standalone floating module, not a
// `registerRideScreen("8", …)` call into `ride-modal.ts`.
//
// `ride-modal.ts`'s `ScreenId` is `"1" | "2" | "2.5" | "3" | "4" | "6"` and
// its `RIDE_SCREEN_FLOW` / `resolveStartScreen` / `nextFlowScreen` machinery
// is hard-wired to that six-screen wizard: the flow array has no seat for an
// id it doesn't list, and `RideModal` itself is never exported — only the
// module-level `openRideModal()`/`closeRideModal()` functions are, so a
// second, independent shell is the only way to add a screen this module
// cannot register into. `ride-modal.ts` is a SHARED file this lane does not
// own (house rules), so extending `ScreenId` there is out of scope here —
// flagged in this lane's `shared_file_edits` for the integrator, same as
// `ride-settings.ts` built its own `.ranks-modal`-shell replica rather than
// wait for `devices.ts`'s module-private `openFloatingModal` to be exported.
//
// So: Screen 8 is its OWN floating overlay (`wireRideScreen8` below),
// mounted/unmounted purely off `ride-session.ts`'s `phaseOf(doc) ===
// "ending(8)"` — copying `ride-wizard.ts`'s discipline (createElement only,
// a `render()` rebuild helper, a teardown list, a hooks/deps interface) at
// the module level instead of through `RideScreenContext`. It reuses
// `openRideModal` (imported, not edited) for [New Destination]'s "loop back
// to Screen 3".
//
// Deliberately NOT imported: `ride-hud.ts` (would drag in maplibre-gl,
// devices.ts, ride-nav-hud.ts — a lot of weight for one 3-line pure
// function) and `track-store.ts`'s heavier chain/crypto surface (Screen 8
// only needs `openTrackStore().readTip()` for the `endReported` dispatch's
// required `RideGateFacts`, never batch/crypto internals). `minimalEndReport`
// is intentionally re-derived byte-for-byte below rather than imported.
// ---------------------------------------------------------------------------
// NEW-DESTINATION GAP — RESOLVED in the final F4 integration/review pass.
//
// [New Destination] dispatches `newDestination` (doc → `wizard:3`, same
// rideId/chain) and then calls `openRideModal({ fastForwardTo: "3" })` to
// bring the wizard chrome back up. `resolveStartScreen` (ride-modal.ts)
// always walks its flow from Screen 1, returning the FIRST registered,
// non-skipped screen — this lane originally flagged that Screen 2's
// registration (`ride-screen-select.ts`'s `wireRideScreenSelect`) had no
// `skip()` at all, so the fast-forward landed back on Screen 2 (re-pick a
// device) instead of Screen 3. Fixed by giving Screen 2 exactly the skip
// predicate this note proposed: skip when `doc.state === "wizard" &&
// doc.rideId !== null` — true only for this loop (a fresh wizard "open"
// always starts with `rideId: null`), false for a normal device pick. See
// `ride-screen-select.ts`'s own comment on that registration, and
// `ride-screen-select.test.ts`'s "Screen 2 — skip gate for the S8 [New
// Destination] loop" describe block for the regression coverage.
// ---------------------------------------------------------------------------
// RECOVERY-NOTE GAP — RESOLVED (integration pass).
//
// `ride-session.ts`'s `recoverRideSession` can land a reloaded doc straight
// on `ending(8)` with `note: "ride_expired"` (the watch elapsed before the
// rider tapped End Ride). `main.ts` now threads `recoverActiveRide()`'s
// resolved `outcome.note` through to `wireRidePost({ recoveryNote, ... })`
// (called from inside `recoverActiveRide().then(...)`, after the recovery
// pass settles), so `deps.recoveryNote` below is populated on that path.
// ---------------------------------------------------------------------------

import {
  ApiError,
  endTrackedRide as defaultEndTrackedRide,
  type EndRideIn,
  type TrackedRide,
} from "./api.ts";
import type { RatePlanKey } from "./config.ts";
import type { Locate, LngLat } from "./locate.ts";
import { openRideModal as defaultOpenRideModal } from "./ride-modal.ts";
import {
  currentTaxRate,
  estimateWithTax,
  formatCents,
  planFor,
  savedRatePlan,
  type RideCostBreakdown,
} from "./ride-cost.ts";
import {
  phaseOf,
  type RideGateFacts,
  type RideRecoveryNote,
  type RideSessionDoc,
  type RideSessionStore,
} from "./ride-session.ts";
import { openTrackStore } from "./track-store.ts";
import { trapFocusWithin } from "./modal-focus-trap.ts";

// ---------------------------------------------------------------------------
// Pure helpers — cost breakdown, clock, validation, request bodies. Kept
// import-light and framework-free so every one of these is directly
// unit-testable with no DOM and no fakes beyond plain values.
// ---------------------------------------------------------------------------

/** Elapsed ms since the ride started, floored at 0. `startedAtMs === null`
 *  (should not happen for a ride that reached `ending(8)` — the reducer only
 *  gets there from `riding`, which always sets it — but a hand-edited/
 *  version-skewed doc must not throw) reads as "just started". */
export function frozenElapsedMs(
  startedAtMs: number | null,
  nowMs: number,
): number {
  if (startedAtMs === null) return 0;
  return Math.max(0, nowMs - startedAtMs);
}

/** "M:SS" — the vision's `Ride time: __:__ (stop)` skeleton, frozen the
 *  instant Screen 8 mounts (the "(stop)" in the copy). Deliberately the same
 *  shape as `ride-hud.ts`'s private `formatClock`, re-derived rather than
 *  imported (see the module header's ARCHITECTURE note). */
export function formatFrozenClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Screen 8's `Est Cost: Unlock $ + Per Min $ + Tax $ = Total $` — layered on
 *  `estimateWithTax` (ride-cost.ts), never recomputed from raw minutes, so
 *  the equity plan's free-minutes credit (and every other per-plan rule)
 *  stays honest. `planKey` null (should not happen — every ride has SOME
 *  saved plan default) falls back to `resident`. */
export function screen8CostBreakdown(
  elapsedMs: number,
  planKey: RatePlanKey | null,
  taxRate: number = currentTaxRate(),
): RideCostBreakdown {
  return estimateWithTax(planFor(planKey ?? "resident"), elapsedMs, taxRate);
}

/** The single end-report body every "I ended my ride in Veo" tap sends —
 *  `EndRideIn`'s required fields only. No rider-entered battery/cost/minutes
 *  (see the module header's FRICTION-REDUCTION REWRITE note for why): the
 *  server derives its own end battery reading from the GBFS feed
 *  independently, and the rest were optional fields nobody needs to type.
 *  Byte-for-byte the same shape as `ride-hud.ts`'s `minimalEndReport` (see
 *  the module header's ARCHITECTURE note on why this isn't imported). */
export function buildMinimalEndBody(nowMs: number, fix: LngLat): EndRideIn {
  return {
    ended_at: new Date(nowMs).toISOString(),
    end_lat: fix.lat,
    end_lon: fix.lng,
  };
}

/** A 409 on `PATCH /end` means "already reported" — by another tab, or a
 *  prior attempt that actually landed despite a client-side timeout/abort.
 *  Either way the end IS reported; treat it as success rather than a scary
 *  dead end (see the module's button-handler comments for how each button
 *  uses this). */
export function isAlreadyReportedError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

export function describeEndReportError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return "This ride is no longer on the server — it may already have been removed.";
  }
  return "Couldn't reach the server — check your connection and try again.";
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type SessionLike = Pick<
  RideSessionStore,
  "current" | "dispatch" | "subscribe"
>;

/** Read-only: Screen 8 only reads the freshest resolved fix for the end
 *  report (both buttons that send one need SOME coordinate — `EndRideIn`
 *  requires it) and reacts to a late one arriving; GPS enablement is
 *  Screen 1's job. Same `Locate` instance every other ride screen shares. */
export type LocateLike = Pick<Locate, "current" | "onFix">;

export interface RideScreen8Deps {
  session: SessionLike;
  locate: LocateLike;
  /** Injected for tests; defaults to `endTrackedRide` from api.ts. */
  endTrackedRide?(
    rideId: string,
    body: EndRideIn,
    signal?: AbortSignal,
  ): Promise<TrackedRide>;
  /** The ride's own last-known GPS fix (`RideHud.getLastFix()`, threaded in
   *  by `main.ts` — this module deliberately never imports `ride-hud.ts`
   *  itself, see the module ARCHITECTURE note). Preferred over
   *  `locate.current()` for both end-report buttons (review fix): `Locate`
   *  expires its fix after 5 minutes and may never have been started at all
   *  on the GPS-permission-skip path, whereas the ride's actual last fix is
   *  known good for as long as the ride was tracked. Defaults to a stub
   *  returning `null` (tests, or a private ride the HUD never tracked),
   *  which simply falls through to `locate.current()`. */
  getLastFix?(): LngLat | null;
  /** [New Destination]'s wizard reopen. Injected for tests; defaults to
   *  `openRideModal` from ride-modal.ts. See the module's NEW-DESTINATION
   *  GAP note for what this does and does not solve on its own today. */
  openRideModal?(entry: { fastForwardTo: "3" }): void;
  /** Resolves `RideGateFacts` for the `endReported` dispatch — the exact
   *  `(waypointCount + pendingCount) > 0` rule `ride-session.ts`'s own
   *  recovery table uses. Injected for tests; defaults to a lazily-opened
   *  `openTrackStore()` + `readTip(trackId)`. */
  getGateFacts?(trackId: string | null): Promise<RideGateFacts>;
  /** Clock injection for tests; defaults to `Date.now`. */
  now?(): number;
  /** Tax rate for the cost breakdown; defaults to `currentTaxRate()`
   *  (ride-cost.ts's last `/meta/pricing` refresh, or its baked-in
   *  default). */
  taxRate?(): number;
  /** The rider's current rate plan; defaults to `savedRatePlan()`. */
  ratePlan?(): RatePlanKey | null;
  /** A note to surface when this mount is a reload landing straight on
   *  `ending(8)` (ride-session.ts's `seal_and_end`/"ride_expired" recovery
   *  outcome) rather than a live End Ride tap. Static, read once at wire
   *  time — see the module's RECOVERY-NOTE GAP note. */
  recoveryNote?: RideRecoveryNote | null;
  /** Where Screen 8 mounts; defaults to `document.body`. Tests inject a
   *  detached container so nothing here touches the real DOM tree. */
  mountRoot?: HTMLElement;
}

interface ResolvedDeps {
  session: SessionLike;
  locate: LocateLike;
  endTrackedRide(
    rideId: string,
    body: EndRideIn,
    signal?: AbortSignal,
  ): Promise<TrackedRide>;
  getLastFix(): LngLat | null;
  openRideModal(entry: { fastForwardTo: "3" }): void;
  getGateFacts(trackId: string | null): Promise<RideGateFacts>;
  now(): number;
  taxRate(): number;
  ratePlan(): RatePlanKey | null;
  recoveryNote: RideRecoveryNote | null;
  mountRoot: HTMLElement;
}

async function defaultGetGateFacts(
  trackId: string | null,
): Promise<RideGateFacts> {
  if (!trackId) return { hasWaypoints: false };
  try {
    const store = await openTrackStore();
    const tip = await store.readTip(trackId);
    return {
      hasWaypoints: (tip?.waypointCount ?? 0) + (tip?.pendingCount ?? 0) > 0,
    };
  } catch {
    // Offline, IndexedDB unavailable, or a hostile private-mode browser: no
    // waypoints CONFIRMED locally, which is the honest answer either way —
    // Screen 10 (if reached by some other path) will not over-claim data
    // this device cannot see.
    return { hasWaypoints: false };
  }
}

function resolveDeps(deps: RideScreen8Deps): ResolvedDeps {
  return {
    session: deps.session,
    locate: deps.locate,
    endTrackedRide: deps.endTrackedRide ?? defaultEndTrackedRide,
    getLastFix: deps.getLastFix ?? (() => null),
    openRideModal: deps.openRideModal ?? defaultOpenRideModal,
    getGateFacts: deps.getGateFacts ?? defaultGetGateFacts,
    now: deps.now ?? (() => Date.now()),
    taxRate: deps.taxRate ?? currentTaxRate,
    ratePlan: deps.ratePlan ?? savedRatePlan,
    recoveryNote: deps.recoveryNote ?? null,
    mountRoot: deps.mountRoot ?? document.body,
  };
}

// ---------------------------------------------------------------------------
// Wiring — mount/unmount purely off `phaseOf(doc) === "ending(8)"`. No
// `main.ts` change needed beyond the single call this exports (see this
// lane's `shared_file_edits`): `wireRideScreen8({ session: rideSession,
// locate })` once at startup, alongside the existing `wireRideScreenX` calls.
// ---------------------------------------------------------------------------

interface MountedScreen8 {
  destroy(): void;
}

/** Wire Screen 8. Call once at startup; returns a full teardown (subscribe +
 *  any live mount) for tests/HMR. */
export function wireRideScreen8(deps: RideScreen8Deps): () => void {
  const resolved = resolveDeps(deps);
  let mounted: MountedScreen8 | null = null;

  function syncToPhase(doc: RideSessionDoc | null): void {
    const inPhase = doc !== null && phaseOf(doc) === "ending(8)";
    if (inPhase && !mounted && doc) {
      mounted = mountRideScreen8(doc, resolved, () => {
        mounted = null;
      });
    } else if (!inPhase && mounted) {
      mounted.destroy();
      mounted = null;
    }
  }

  syncToPhase(resolved.session.current());
  const unsubscribe = resolved.session.subscribe((doc) => syncToPhase(doc));

  return () => {
    unsubscribe();
    mounted?.destroy();
    mounted = null;
  };
}

function mountRideScreen8(
  doc: RideSessionDoc,
  deps: ResolvedDeps,
  onClosed: () => void,
): MountedScreen8 {
  const rideId = doc.rideId;

  const backdrop = el("div", "ride-post-modal");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "ride-post-s8-title");
  const card = el("div", "ride-post-modal__card ride-post-s8");
  backdrop.append(card);

  let destroyed = false;
  let busy = false;
  let error: string | null = null;
  let abortController: AbortController | null = null;

  // The clock/cost breakdown stay LIVE (the frontend plan: "the clock keeps
  // running while the rider finishes in Veo") until `stopClock()` freezes
  // them — either the rider's own (stop) press, or an implicit stop the
  // instant they tap "I ended my ride in Veo" without having pressed it
  // first. Review fix: these used to be frozen the instant this modal
  // mounted.
  let stoppedElapsedMs: number | null = null;
  let clockTimer: number | undefined;

  function liveElapsedMs(): number {
    return stoppedElapsedMs ?? frozenElapsedMs(doc.startedAtMs, deps.now());
  }

  function stopClock(): void {
    if (stoppedElapsedMs !== null) return;
    stoppedElapsedMs = liveElapsedMs();
    if (clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  }

  const planKey = deps.ratePlan() ?? "resident";

  // House rule: "anything modal" needs a focus trap (see
  // modal-focus-trap.ts's own header for why this isn't ride-modal.ts's
  // private one). `isActive` reads `destroyed` so ONE listener pair survives
  // every `render()` rebuild instead of being re-attached per paint.
  const untrapFocus = trapFocusWithin(backdrop, () => !destroyed);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (clockTimer !== undefined) window.clearInterval(clockTimer);
    untrapFocus();
    abortController?.abort();
    backdrop.remove();
    onClosed();
  }

  function render(): void {
    card.replaceChildren();
    card.append(renderSummary());
    const focusTarget = card.querySelector<HTMLElement>("button:not([disabled])");
    try {
      focusTarget?.focus();
    } catch {
      /* detached — nothing to focus yet */
    }
  }

  // ---------------- summary mode ----------------

  function renderSummary(): HTMLElement {
    const elapsedMs = liveElapsedMs();
    const breakdown = screen8CostBreakdown(elapsedMs, planKey, deps.taxRate());
    const wrap = el("div", "ride-post-s8__body");
    const title = el(
      "h2",
      "ride-modal__lede",
      "End your ride in the Veo app",
    );
    title.id = "ride-post-s8-title";
    wrap.append(title);
    wrap.append(
      el(
        "p",
        "ride-modal__hint",
        "End your ride in the Veo app, then tap below to check in — if you saved your ride tracks, you'll have the chance to donate them for leaderboard points.",
      ),
    );

    if (deps.recoveryNote === "ride_expired") {
      wrap.append(
        el(
          "p",
          "ride-post-s8__note ride-post-s8__note--warn",
          "Your ride expired before you ended it — you can still report the end and donate your track below.",
        ),
      );
    }

    wrap.append(
      clockRow(
        elapsedMs,
        stoppedElapsedMs === null
          ? () => {
              stopClock();
              render();
            }
          : null,
      ),
    );
    wrap.append(costBreakdownRows(breakdown));
    wrap.append(
      el(
        "p",
        "ride-post-s8__bill-note",
        "** The Veo app is your bill **",
      ),
    );

    if (error) {
      const err = el("p", "ride-post-s8__error", error);
      err.setAttribute("role", "status");
      err.setAttribute("aria-live", "polite");
      wrap.append(err);
    }
    if (busy) {
      wrap.append(el("p", "ride-modal__hint", "Working…"));
    }

    const actions = el("div", "ride-wizard__actions ride-post-s8__actions");
    const newDestBtn = actionButton("New Destination", "login-btn--secondary", () =>
      onNewDestination(),
    );
    const endBtn = actionButton("I ended my ride in Veo", "", () =>
      void onEndRide(),
    );
    for (const btn of [newDestBtn, endBtn]) btn.disabled = busy;
    actions.append(newDestBtn, endBtn);
    wrap.append(actions);

    return wrap;
  }

  function costBreakdownRows(b: RideCostBreakdown): HTMLElement {
    const dl = el("dl", "ride-post-s8__cost");
    dl.append(
      costRow("Unlock", b.unlock),
      costRow("Per Min", b.perMin),
      costRow("Tax", b.tax),
      costRow("Total", b.total, true),
    );
    return dl;
  }

  function costRow(label: string, cents: number, total = false): HTMLElement {
    const frag = el("div", `ride-post-s8__cost-row${total ? " ride-post-s8__cost-row--total" : ""}`);
    frag.append(
      el("dt", undefined, label),
      el("dd", undefined, formatCents(cents)),
    );
    return frag;
  }

  /** The ride's last fix, preferring `RideHud.getLastFix()` over
   *  `locate.current()` (see the module's `getLastFix` doc comment / the
   *  review fix this implements) — used by both end-report buttons below. */
  function resolveEndFix(): LngLat | null {
    return deps.getLastFix() ?? deps.locate.current();
  }

  // ---------------- "I ended my ride in Veo" ----------------

  /** The single end-of-ride action (formerly split across "Rush Quit" —
   *  minimal report, explicitly skipping S9/S10 — and a separate "I ended my
   *  ride in Veo" form that collected battery/cost/minutes before doing the
   *  same plus `endReported`). See the module header's FRICTION-REDUCTION
   *  REWRITE note: there is no more form to shortcut past, so there is only
   *  one action now, and it always checks for donatable data afterward. */
  async function onEndRide(): Promise<void> {
    if (busy || !rideId) return;
    // Implicit stop for a rider who never pressed (stop).
    stopClock();
    const fix = resolveEndFix();
    if (!fix) {
      error =
        "We need a GPS fix to end your ride — check location services and try again.";
      render();
      return;
    }
    busy = true;
    error = null;
    render();
    abortController = new AbortController();
    try {
      await deps.endTrackedRide(
        rideId,
        buildMinimalEndBody(deps.now(), fix),
        abortController.signal,
      );
    } catch (e) {
      if (destroyed) return;
      if (!isAlreadyReportedError(e)) {
        busy = false;
        error = describeEndReportError(e);
        render();
        return;
      }
      // 409 = already reported (another tab, or a prior attempt that landed
      // despite a client-side failure) — the end IS reported either way, so
      // proceed exactly as on success.
    }
    if (destroyed) return;
    const facts = await deps.getGateFacts(rideId);
    if (destroyed) return;
    deps.session.dispatch({ type: "endReported", facts });
  }

  // ---------------- New Destination ----------------

  function onNewDestination(): void {
    if (busy) return;
    // No `PATCH /end` — that is the whole point of the invariant
    // (ride-session.ts's header comment). Dispatch FIRST: the modal's
    // `onScreenChange` hook fires a `goto` that is only legal once
    // `doc.state === "wizard"`, which this transition sets synchronously.
    const transition = deps.session.dispatch({ type: "newDestination" });
    if (!transition?.accepted) return;
    deps.openRideModal({ fastForwardTo: "3" });
  }

  // Attach BEFORE the first render: `render()`'s own focus-on-mount only
  // works on a connected node — focusing a detached one is a silent no-op.
  deps.mountRoot.append(backdrop);
  render();
  // Ticks the live clock/cost breakdown while unstopped — cleared by
  // `stopClock()` and by `destroy()`.
  clockTimer = window.setInterval(() => {
    if (destroyed || stoppedElapsedMs !== null) return;
    render();
  }, 1000);
  const unFix = deps.locate.onFix(() => {
    if (destroyed || busy) return;
    // A late fix can only ever clear the "we need a GPS fix" error — the
    // cost breakdown/clock are already live (or already frozen), so this is
    // always safe and cheap.
    if (error && error.startsWith("We need a GPS fix")) {
      error = null;
      render();
    }
  });

  return {
    destroy(): void {
      unFix();
      destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Small DOM builders
// ---------------------------------------------------------------------------

/** "Ride time" row — a real Stop control while live, frozen text once
 *  stopped. */
function clockRow(elapsedMs: number, onStop: (() => void) | null): HTMLElement {
  const wrap = el("p", "ride-post-s8__row");
  wrap.append(el("strong", undefined, "Ride time: "));
  wrap.append(document.createTextNode(`${formatFrozenClock(elapsedMs)} `));
  if (onStop) {
    const stopBtn = el("button", "ride-post-s8__stop-btn", "(stop)");
    stopBtn.type = "button";
    stopBtn.setAttribute("aria-label", "Stop the ride clock");
    stopBtn.addEventListener("click", onStop);
    wrap.append(stopBtn);
  } else {
    wrap.append(el("span", "ride-post-s8__stopped", "(stopped)"));
  }
  return wrap;
}

function actionButton(
  label: string,
  extraClass: string,
  onClick: () => void,
): HTMLButtonElement {
  const cls = extraClass ? `login-btn ${extraClass}` : "login-btn";
  const btn = el("button", cls.trim(), label) as HTMLButtonElement;
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

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
