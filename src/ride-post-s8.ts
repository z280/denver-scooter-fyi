// Screen 8 — post-ride cost summary + Rush Quit / New Destination / "I ended
// my ride in Veo" (frontend plan, `ride-post.ts` row's S8 slice; master Part
// 0 Screen 8; F4 Phase). Owner's copy, verbatim:
//
//   "End your ride in the Veo app. Note the cost and battery % of your
//   scooter after ending, and don't forget to come back here though to
//   contribute and earn points."
//   Ride time: __:__ (stop)
//   Est Cost: Unlock $ + Per Min $ + Tax $ = Total $
//   ** The Veo app is your bill **
//   [Rush Quit] [New Destination] [I ended my ride in Veo]
//
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
  billableMinutes,
  formatCents,
  planFor,
  savedRatePlan,
  toApiRatePlan,
  type RideCostBreakdown,
} from "./ride-cost.ts";
import {
  phaseOf,
  type RideGateFacts,
  type RideRecoveryNote,
  type RideSessionDoc,
  type RideSessionStore,
} from "./ride-session.ts";
import { applyNativeNumericInput } from "./ride-keypad.ts";
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

/** §10's `reported_minutes` prefill: `billableMinutes` (ride-cost.ts,
 *  per-started-minute ceil), clamped to the field's own `≤1440` bound —
 *  `billableMinutes` alone can't exceed that for any ride inside the 3 h
 *  watch window, but a stalled reload recovering hours later must not hand
 *  the API a value it will 422 on. */
export function prefillReportedMinutes(elapsedMs: number): number {
  return Math.min(1440, billableMinutes(elapsedMs));
}

export function isValidBatteryPercent(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 100;
}

/** §10: "integer minutes, ≤1440" (api.ts's own `EndRideIn.reported_minutes`
 *  doc). Lower-bounded at 1 — a ride that reached Screen 8 was, by
 *  construction, at least momentarily live. */
export function isValidReportedMinutes(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 1440;
}

const DOLLARS_PATTERN = /^\d{1,6}(\.\d{1,2})?$/;

/** Parse a rider-typed dollar amount ("4", "4.5", "4.50") into integer
 *  cents, or null for anything that isn't a plain non-negative amount with
 *  at most two decimal places (a manually re-typed Veo receipt, not a
 *  calculator expression). */
export function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!DOLLARS_PATTERN.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : null;
}

/** The plan label up to the em dash — "Resident w/ VeoPlus Pass" rather than
 *  the full rate-detail string, which the cost breakdown above already
 *  itemizes. */
export function planDisplayLabel(key: RatePlanKey): string {
  return planFor(key).label.split(" — ")[0];
}

/** Rush Quit's minimal `PATCH /end` body — `EndRideIn`'s required fields
 *  only. Byte-for-byte the same shape as `ride-hud.ts`'s `minimalEndReport`
 *  (see the module header's ARCHITECTURE note on why this isn't imported). */
export function buildMinimalEndBody(nowMs: number, fix: LngLat): EndRideIn {
  return {
    ended_at: new Date(nowMs).toISOString(),
    end_lat: fix.lat,
    end_lon: fix.lng,
  };
}

export interface FullEndFormValues {
  /** Rider-entered, 0–100. Feeds A2's `soc_end_percent`. */
  batteryPercent: number;
  /** Rider-entered, integer cents. Informational/stored — never the bill. */
  costCents: number;
  /** §10, prefilled from `prefillReportedMinutes`, rider-editable. */
  reportedMinutes: number;
  /** §10 — the rider's CURRENT rate plan, converted via `toApiRatePlan`
   *  before it reaches the wire (the API vocabulary has no `_plus`
   *  variants). */
  planKey: RatePlanKey;
}

/** "I ended my ride in Veo"'s full `PATCH /end` body: the minimal fields plus
 *  the rider-entered battery/cost and the §10 fields. */
export function buildFullEndBody(
  nowMs: number,
  fix: LngLat,
  values: FullEndFormValues,
): EndRideIn {
  return {
    ...buildMinimalEndBody(nowMs, fix),
    reported_battery_percent: values.batteryPercent,
    total_cost_cents: values.costCents,
    reported_minutes: values.reportedMinutes,
    reported_plan: toApiRatePlan(values.planKey),
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
  const frozenNowMs = deps.now();
  const elapsedMs = frozenElapsedMs(doc.startedAtMs, frozenNowMs);
  const rideId = doc.rideId;

  const backdrop = el("div", "ride-post-modal");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "ride-post-s8-title");
  const card = el("div", "ride-post-modal__card ride-post-s8");
  backdrop.append(card);

  let destroyed = false;
  let mode: "summary" | "veo-form" = "summary";
  let busy = false;
  let error: string | null = null;
  let batteryRaw = "";
  let costRaw = "";
  let minutesRaw = String(prefillReportedMinutes(elapsedMs));
  let abortController: AbortController | null = null;

  const planKey = deps.ratePlan() ?? "resident";
  const breakdown = screen8CostBreakdown(elapsedMs, planKey, deps.taxRate());

  // House rule: "anything modal" needs a focus trap (see
  // modal-focus-trap.ts's own header for why this isn't ride-modal.ts's
  // private one). `isActive` reads `destroyed` so ONE listener pair survives
  // every `render()` rebuild instead of being re-attached per paint.
  const untrapFocus = trapFocusWithin(backdrop, () => !destroyed);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    untrapFocus();
    abortController?.abort();
    backdrop.remove();
    onClosed();
  }

  function render(): void {
    card.replaceChildren();
    if (mode === "summary") {
      card.append(renderSummary());
    } else {
      card.append(renderVeoForm());
    }
    const focusTarget = card.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled])",
    );
    try {
      focusTarget?.focus();
    } catch {
      /* detached — nothing to focus yet */
    }
  }

  // ---------------- summary mode ----------------

  function renderSummary(): HTMLElement {
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
        "Note the cost and battery % of your scooter after ending, and don't forget to come back here though to contribute and earn points.",
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
      row("Ride time", `${formatFrozenClock(elapsedMs)} (stop)`),
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
    const rushBtn = actionButton("Rush Quit", "login-btn--secondary", () =>
      void onRushQuit(),
    );
    const newDestBtn = actionButton("New Destination", "login-btn--secondary", () =>
      onNewDestination(),
    );
    const veoBtn = actionButton("I ended my ride in Veo", "", () =>
      onOpenVeoForm(),
    );
    for (const btn of [rushBtn, newDestBtn, veoBtn]) btn.disabled = busy;
    actions.append(rushBtn, newDestBtn, veoBtn);
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

  // ---------------- Rush Quit ----------------

  async function onRushQuit(): Promise<void> {
    if (busy || !rideId) return;
    const fix = deps.locate.current();
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
    // No S9/S10 — the sealed track stays in IDB, undonated. The `dispatch`
    // triggers `wireRideScreen8`'s subscribe callback, which unmounts this
    // screen once the phase leaves `ending(8)`.
    deps.session.dispatch({ type: "rushQuit" });
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

  // ---------------- "I ended my ride in Veo" ----------------

  function onOpenVeoForm(): void {
    if (busy) return;
    mode = "veo-form";
    error = null;
    render();
  }

  function onBackToSummary(): void {
    if (busy) return;
    mode = "summary";
    error = null;
    render();
  }

  function parsedBattery(): number | null {
    if (batteryRaw === "") return null;
    const n = Number.parseInt(batteryRaw, 10);
    return Number.isFinite(n) ? n : null;
  }

  function parsedMinutes(): number | null {
    if (minutesRaw === "") return null;
    const n = Number.parseInt(minutesRaw, 10);
    return Number.isFinite(n) ? n : null;
  }

  function canSubmitVeoForm(): boolean {
    const battery = parsedBattery();
    const minutes = parsedMinutes();
    const cents = parseDollarsToCents(costRaw);
    return (
      battery !== null &&
      isValidBatteryPercent(battery) &&
      minutes !== null &&
      isValidReportedMinutes(minutes) &&
      cents !== null
    );
  }

  function renderVeoForm(): HTMLElement {
    const wrap = el("div", "ride-post-s8__body ride-post-s8__form");
    const title = el("h2", "ride-modal__lede", "I ended my ride in Veo");
    title.id = "ride-post-s8-title";
    wrap.append(title);
    wrap.append(
      el(
        "p",
        "ride-modal__hint",
        `Rate plan: ${planDisplayLabel(planKey)}`,
      ),
    );

    const batteryField = numericField(
      "End battery %",
      batteryRaw,
      "0–100, from the Veo app",
      (value) => {
        batteryRaw = value.replace(/\D+/g, "").slice(0, 3);
        render();
      },
    );
    const costField = currencyField(
      "Actual cost",
      costRaw,
      "Total shown in the Veo app receipt",
      (value) => {
        costRaw = value;
        render();
      },
    );
    const minutesField = numericField(
      "Ride time reported (minutes)",
      minutesRaw,
      "Prefilled from this device's clock — edit if the Veo app disagrees",
      (value) => {
        minutesRaw = value.replace(/\D+/g, "").slice(0, 4);
        render();
      },
    );
    wrap.append(batteryField.wrap, costField.wrap, minutesField.wrap);

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
    const backBtn = actionButton("Back", "login-btn--secondary", () =>
      onBackToSummary(),
    );
    backBtn.disabled = busy;
    const submitBtn = actionButton("Submit", "", () => void onSubmitVeoForm());
    submitBtn.disabled = busy || !canSubmitVeoForm();
    actions.append(backBtn, submitBtn);
    wrap.append(actions);

    return wrap;
  }

  async function onSubmitVeoForm(): Promise<void> {
    if (busy || !rideId || !canSubmitVeoForm()) return;
    const battery = parsedBattery();
    const minutes = parsedMinutes();
    const cents = parseDollarsToCents(costRaw);
    if (battery === null || minutes === null || cents === null) return;
    const fix = deps.locate.current();
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
    const body = buildFullEndBody(deps.now(), fix, {
      batteryPercent: battery,
      costCents: cents,
      reportedMinutes: minutes,
      planKey,
    });
    try {
      await deps.endTrackedRide(rideId, body, abortController.signal);
    } catch (e) {
      if (destroyed) return;
      if (!isAlreadyReportedError(e)) {
        busy = false;
        error = describeEndReportError(e);
        render();
        return;
      }
      // Already reported (see onRushQuit's identical branch for why this is
      // treated as success, not failure).
    }
    if (destroyed) return;
    const facts = await deps.getGateFacts(rideId);
    if (destroyed) return;
    deps.session.dispatch({ type: "endReported", facts });
  }

  // Attach BEFORE the first render: `render()`'s own focus-on-mount only
  // works on a connected node — focusing a detached one is a silent no-op.
  deps.mountRoot.append(backdrop);
  render();
  const unFix = deps.locate.onFix(() => {
    if (destroyed || busy) return;
    // A late fix can only ever clear the "we need a GPS fix" error — it never
    // repaints the cost breakdown (frozen at mount) or resets typed form
    // values, so a full `render()` is safe and cheap.
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

function row(label: string, value: string): HTMLElement {
  const wrap = el("p", "ride-post-s8__row");
  wrap.append(el("strong", undefined, `${label}: `), document.createTextNode(value));
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

function numericField(
  label: string,
  value: string,
  hint: string,
  onInput: (value: string) => void,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const field = el("label", "ride-post-s8__field");
  field.append(el("span", "ride-post-s8__field-label", label));
  const input = el("input", "select") as HTMLInputElement;
  input.type = "text";
  input.value = value;
  input.setAttribute("aria-label", label);
  applyNativeNumericInput(input, { maxLength: 4 });
  input.addEventListener("input", () => onInput(input.value));
  field.append(input, el("span", "ride-post-s8__field-hint", hint));
  return { wrap: field, input };
}

/** Digits + at most one decimal point — `sanitizeNumeric` (ride-keypad.ts)
 *  strips ALL non-digits, which would make a dollar amount uneditable, so
 *  this field gets its own light filter instead. */
function sanitizeCurrencyInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return (
    cleaned.slice(0, firstDot + 1) +
    cleaned.slice(firstDot + 1).replace(/\./g, "")
  );
}

function currencyField(
  label: string,
  value: string,
  hint: string,
  onInput: (value: string) => void,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const field = el("label", "ride-post-s8__field");
  field.append(el("span", "ride-post-s8__field-label", label));
  const input = el("input", "select") as HTMLInputElement;
  input.type = "text";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.placeholder = "0.00";
  input.value = value;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => {
    input.value = sanitizeCurrencyInput(input.value);
    onInput(input.value);
  });
  field.append(input, el("span", "ride-post-s8__field-hint", hint));
  return { wrap: field, input };
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
