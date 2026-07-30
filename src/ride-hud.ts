// The in-ride companion: a full-screen, glanceable 2D HUD. During a ride it
// shows exactly three things — speed, elapsed cost, equity flag — in huge
// type; everything else (comparisons, distance, advocacy) waits for the
// end-of-ride summary. All browser-API, zero backend.
//
// The clock is an estimate: we can't see Veo's billing clock, so start
// offers a countdown ("I'll start the scooter in N seconds" — set up the
// phone, then scan the QR) and the running clock has ±15s/±1m nudges to
// square it with the Veo app mid-ride.

import maplibregl, { type Map as MLMap } from "maplibre-gl";
import { pointInAny, type IndexedFeature } from "./geo.ts";
import { distanceMeters, type LngLat } from "./locate.ts";
import { FIRST_DEVICE_LAYER, ALL_MODELS, type ModelKey } from "./devices.ts";

/** The slice of the device layer the HUD drives: ride-scoped tap behavior
 *  and on-map visibility filtering. */
export interface RideDeviceControl {
  setRideActive(on: boolean): void;
  setRideModelFilter(models: ReadonlySet<ModelKey> | null): void;
  /** True while a device details popup is open — the follow-cam holds the
   *  camera still so the popup doesn't drift out from under the reader. */
  hasOpenPopup(): boolean;
}
import { applyTheme, currentTheme, initialTheme } from "./theme.ts";
import { RATE_PLANS, COMPARATOR, type RatePlanKey } from "./config.ts";
import {
  comparatorCostCents,
  formatCents,
  planFor,
  rideCostCents,
  savedRatePlan,
  saveRatePlan,
} from "./ride-cost.ts";
import { closeAllPopups } from "./chrome.ts";
import { endTrackedRide, type EndRideIn } from "./api.ts";
import type { RideSessionStore, RideState as RideSessionState } from "./ride-session.ts";
import type { TrackFix, TrackRecorder } from "./track-store.ts";

// ---------------------------------------------------------------------------
// F3: tracked-ride seams (frontend plan, `ride-hud.ts` module-map row + the
// F3 phase section). This module never CREATES a ride-session doc or a
// track-store recorder — `ride-screen-start.ts` (F2) owns the former,
// whichever module wires the Screen 6 → HUD handoff owns the latter's
// lifecycle (opening/resuming IndexedDB is async and belongs with the rest
// of that recovery machinery). ride-hud.ts only CONSUMES both: it feeds the
// shared watchPosition into an already-live recorder, and it dispatches the
// one ride-session action it ever needs (`endRide`, for the F3 interim
// minimal end-report — see `reportTrackedRideEnd` below).
// ---------------------------------------------------------------------------

/** The recorder methods ride-hud.ts calls — a `Pick`, not the whole
 *  `TrackRecorder`, so a fake in tests (or a future alternate implementation)
 *  only has to satisfy what this module actually uses. */
export type RideHudTrackControl = Pick<TrackRecorder, "addFix" | "finish">;

/** The one ride-session action ride-hud.ts ever dispatches. */
export type RideHudSessionControl = Pick<RideSessionStore, "dispatch">;

export interface RideHudDeps {
  /** Wired once the tracking-integration lane (or the integrator) attaches
   *  the shared `RideSessionStore` — omit it and ride-hud.ts behaves exactly
   *  as it does today (a legacy, session-doc-free HUD): the F3 interim end
   *  report in `reportTrackedRideEnd` simply has nothing to dispatch to. */
  session?: RideHudSessionControl;
}

/** What `beginHandoff` needs to put the HUD straight into `riding` for a ride
 *  already started elsewhere (the wizard's Screen 6 countdown/"I already
 *  started", or a reload recovery's `restore_riding` outcome) — skipping the
 *  legacy armed/countdown screens entirely. */
export interface TrackedRideHandoff {
  /** null for a private/guest ride: no `tracked_rides` row exists, so BRB and
   *  End Ride keep ride-hud's original, untracked behavior for it. */
  rideId: string | null;
  startedAtMs: number;
  /** Already-recording (or resumed) track-store recorder, or null when this
   *  ride isn't recording (a private ride with tracking unavailable/off, or
   *  the tracking-integration lane hasn't attached one yet — see
   *  `attachTrackRecorder`). ride-hud.ts never creates or resumes one. */
  recorder: RideHudTrackControl | null;
}

// ---------------------------------------------------------------------------
// Pure decision helpers — extracted so the branches the F3 phase section
// calls out ("the rideModels-empty-push decision, the BRB tracked-vs-private
// branch decision, the interim end-report field set") are unit-testable
// without a DOM, a Map, or geolocation. The class methods below call these
// rather than re-implementing the same conditions inline.
// ---------------------------------------------------------------------------

/** Which model filter to push to the device layer for a given "Show"
 *  selection. Every model selected (the ride-start default is now EMPTY, not
 *  every model — see `RideHud`'s `rideModels` field) means "no filter" (also
 *  shows unrecognized hardware); anything else, including the empty set,
 *  restricts to exactly that set — an empty set is `setRideModelFilter`'s
 *  documented "show none" path, which is what makes ride start hide every
 *  scooter by default. */
export function rideModelFilterFor(
  models: ReadonlySet<ModelKey>,
): ReadonlySet<ModelKey> | null {
  return models.size === ALL_MODELS.length ? null : new Set(models);
}

/** BRB's tracked-vs-private branch (frontend plan, Phase F3 "BRB" note): a
 *  tracked ride (a server `rideId`) keeps its clock anchored and its
 *  recording running straight through BRB — only the HUD's visual display
 *  leaves and returns. A private/guest/legacy ride (`rideId === null`) keeps
 *  the original stop-the-watcher-and-freeze-the-clock behavior, unchanged. */
export type BrbStrategy = "continue_tracking" | "freeze_and_stop";

export function brbStrategyFor(rideId: string | null): BrbStrategy {
  return rideId !== null ? "continue_tracking" : "freeze_and_stop";
}

/** The F3 interim End Ride report's field set (frontend plan, Phase F3 "ride
 *  end" note): `endTrackedRide`'s REQUIRED fields only — `ended_at`,
 *  `end_lat`, `end_lon`. The §10 fields (`reported_minutes`,
 *  `reported_plan`) and the rider-entered battery/cost are Screen 8's, which
 *  doesn't exist until F4's `ride-post.ts` lands — sending them here would be
 *  inventing data the rider was never asked for. */
export function minimalEndReport(endedAtMs: number, pos: LngLat): EndRideIn {
  return {
    ended_at: new Date(endedAtMs).toISOString(),
    end_lat: pos.lat,
    end_lon: pos.lng,
  };
}

/** Is a tracked ride already live, such that a second 🧭 tap must resume the
 *  HUD instead of opening a fresh wizard over a running ride? (frontend plan,
 *  "Entry" + Phase F3's entry-point flag flip.) Covers both a same-tab BRB'd
 *  ride (the HUD's own `paused` flag — `RideHud.isPaused()`) and the
 *  persisted session doc still reading `riding`/`countdown` (e.g. immediately
 *  after a reload, before the tracking-integration lane's resume flow has
 *  re-attached the HUD via `beginHandoff`). Exported so main.ts's entry-point
 *  guard is a one-line call, and so the condition is unit-testable without
 *  constructing a `RideHud` or a `RideSessionStore`. */
export function isLiveRideEntry(
  hudPaused: boolean,
  sessionDocState: RideSessionState | null | undefined,
): boolean {
  return (
    hudPaused || sessionDocState === "riding" || sessionDocState === "countdown"
  );
}

type HudState = "hidden" | "armed" | "countdown" | "riding" | "summary";

/** Speed EMA smoothing factor — heavy enough that GPS jitter doesn't make
 *  the number twitch, light enough to feel live. */
const SPEED_ALPHA = 0.35;
/** Ignore fixes implying > 45 mph — GPS teleports, not scooters. */
const MAX_PLAUSIBLE_MPS = 20;

/** Follow-cam framing during a ride: zoomed in, pitched for a 3D-ish
 *  perspective, bearing tracking the direction of travel. */
const RIDE_ZOOM = 17;
const RIDE_PITCH = 60;
/** Analog speedometer full-scale, in mph. Denver caps scooters ~15 mph, so
 *  18 gives a little headroom with the top of the dial as a "too fast" zone. */
const SPEEDO_MAX_MPH = 18;
/** Dial sweep: needle travels from -135° (empty, lower-left) to +135°
 *  (full, lower-right) — a classic 270° automotive gauge. */
const SPEEDO_SWEEP = 270;
const SPEEDO_START = -135;
const MPS_TO_MPH = 2.23694;
/** Below this speed heading is unreliable, so we hold the last good bearing
 *  rather than spinning the map on GPS noise while stopped. */
const BEARING_MIN_MPS = 1.5;
const BUILDINGS_3D_LAYER = "ride-buildings-3d";
/** Fraction of viewport height to push the rider's marker BELOW center, so
 *  the road ahead (bearing-up) fills most of the screen instead of the
 *  ground already behind them. ~0.3 puts the dot ~80% of the way down. */
const RIDE_FOCUS_OFFSET_FRAC = 0.3;

/** 3D-building extrusion fill per app theme (paint expression territory —
 *  MapLibre paints don't read CSS variables). */
function buildingsColor(): string {
  return currentTheme() === "dark" ? "#1b2733" : "#d3d7e0";
}

export class RideHud {
  private state: HudState = "hidden";
  private root: HTMLElement;
  private watchId: number | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private tickTimer: number | undefined;
  private countdownTimer: number | undefined;

  private startedAt = 0;
  private smoothedMps = 0;
  private distanceM = 0;
  private lastFix: { pos: LngLat; t: number } | null = null;
  private startPos: LngLat | null = null;
  private startedInZone = false;
  private userMarker: maplibregl.Marker | null = null;
  private lastBearing = 0;
  private following = false;
  private needleEl: SVGElement | null = null;
  /** Map camera state captured on ride start, restored on exit. */
  private savedView: { center: LngLat; zoom: number; pitch: number; bearing: number } | null = null;
  /** Which models the follow-cam shows (HUD "Show" pills). Reset to EMPTY at
   *  the start of each ride (F3: hide every scooter by default) — the rider
   *  re-shows models on demand via the wrench panel's chips. All-selected
   *  means no filter (also shows unrecognized hardware); anything else,
   *  including empty, restricts to that set (see `rideModelFilterFor`). */
  private rideModels = new Set<ModelKey>();
  /** A ride "backgrounded" via BRB: the HUD is hidden and the map returns to
   *  Analysis / Find wheels, but the ride state (counter) is preserved so
   *  reopening the HUD resumes it. */
  private paused = false;
  /** Fired whenever the HUD leaves the screen (End Ride, summary Done, or
   *  BRB) — wireModes uses it to hand the mode bar back to whichever mode
   *  was active before the HUD covered it. */
  private onHidden: (() => void) | null = null;
  /** Elapsed ms captured at BRB, so the clock resumes from where it paused
   *  instead of counting the time spent away. */
  private pausedElapsedMs = 0;
  /** Set only for a ride that has a `tracked_rides` row (F3 handoff /
   *  `beginHandoff`); null for the legacy armed→start flow and for a
   *  private/guest ride. The sole discriminator `brbStrategyFor` and the F3
   *  interim end-report branch on — see the module's pure-helpers section. */
  private trackedRideId: string | null = null;
  /** The live track-store recorder for the current ride, or null when this
   *  ride isn't recording. Independent of `trackedRideId`: a private/guest
   *  ride can still record locally (Save Ride Tracks on), just never donate
   *  it. ride-hud.ts only feeds it fixes and seals it — see the module's F3
   *  seams note. */
  private trackRecorder: RideHudTrackControl | null = null;
  /** Dispatches the F3 interim End Ride report onto the shared ride-session
   *  doc. Null when the integrator hasn't wired one — see `RideHudDeps`. */
  private readonly session: RideHudSessionControl | null;

  constructor(
    container: HTMLElement,
    /** Lazily resolves the v1∪v2 equity polygons for the start/end flags. */
    private readonly equityZones: () => Promise<IndexedFeature[]>,
    /** The main map — the HUD frames it and drives a follow-cam during a
     *  ride, so the rider sees themselves move instead of a blank panel. */
    private readonly map: MLMap,
    /** Device layer control: ride-scoped tap behavior + visibility filter. */
    private readonly deviceCtl: RideDeviceControl,
    /** F3 tracked-ride seams — optional so every pre-F3 call site (and every
     *  test that only needs the legacy HUD) keeps compiling unchanged. */
    deps: RideHudDeps = {},
  ) {
    this.root = container;
    this.session = deps.session ?? null;
    this.root.addEventListener("click", (e) => this.onClick(e));
    // Re-acquire the wake lock when the tab comes back (the browser
    // silently releases it on hide).
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.state === "riding") void this.acquireWakeLock();
    });
    // The HUD's night palette rides on the app theme (data-theme CSS), but
    // the 3D buildings are a MapLibre paint — recolor them on theme change,
    // whichever control (HUD ☀/☾, map toggle, sun-sync) flipped it.
    window.addEventListener("scooter:theme", () => {
      if (this.map.getLayer(BUILDINGS_3D_LAYER)) {
        this.map.setPaintProperty(
          BUILDINGS_3D_LAYER,
          "fill-extrusion-color",
          buildingsColor(),
        );
      }
    });
  }

  /** Open the HUD. A ride backgrounded via BRB resumes where it left off;
   *  otherwise show the pre-ride start screen. */
  open(): void {
    if (this.paused) {
      void this.resumeRide();
      return;
    }
    // Fresh attempt at the ride companion — give the landscape tip another
    // chance even if it was dismissed last time around.
    this.setLandscapeHintDismissed(false);
    this.setState("armed");
  }

  /** True while a ride is backgrounded via BRB. main.ts's entry-point guard
   *  (`wireModes()`, case "riding") reads this — via `isLiveRideEntry` —
   *  to decide whether a second 🧭 tap should resume the HUD instead of
   *  opening a fresh wizard over a running ride. */
  isPaused(): boolean {
    return this.paused;
  }

  /** Enter the riding view for a ride already started elsewhere: the
   *  wizard's Screen 6 → HUD handoff (frontend plan, `ride-hud.ts` row), or a
   *  reload recovery's `restore_riding` outcome. Skips the legacy
   *  armed/countdown screens entirely — `handoff` supplies the ride's
   *  identity and start time, this only wires the live view around it.
   *  Idempotent while already riding, so a redundant recovery call can't
   *  restart sensors mid-ride. */
  beginHandoff(handoff: TrackedRideHandoff): void {
    if (this.state === "riding") return;
    void this.enterImmersive();
    this.enterRiding({
      startedAtMs: handoff.startedAtMs,
      rideId: handoff.rideId,
      recorder: handoff.recorder,
    });
  }

  /** Attach (or replace, or clear) the live track-store recorder for the
   *  CURRENT ride — for a recorder that finishes an async open/resume
   *  slightly after `beginHandoff()` already put the HUD on screen, or for
   *  the tracking-integration lane to hand over a freshly re-imported one
   *  after a reload. A no-op call with the HUD not riding is harmless. */
  attachTrackRecorder(recorder: RideHudTrackControl | null): void {
    this.trackRecorder = recorder;
  }

  /** We're encouraging landscape, not enforcing it — the tip (pre-ride note
   *  + in-ride badge) is dismissible, and dismissing either one silences
   *  both for the rest of this ride attempt. Orientation reactivity itself
   *  stays pure CSS (see .hud-rotate-badge / .hud-note--landscape); this
   *  just gates it off entirely once dismissed. No backing field — the
   *  body class alone is the source of truth, since nothing ever reads
   *  the state back in JS. */
  private setLandscapeHintDismissed(v: boolean): void {
    document.body.classList.toggle("landscape-hint-dismissed", v);
  }

  /** Shared pre-ride landscape tip markup (armed + countdown cards). */
  private landscapeHintMarkup(): string {
    return `
      <p class="hud-note hud-note--landscape">
        ${rotateIconMarkup("hud-hint-icon")}
        <span>Tip: the ride view works best in landscape.</span>
        <button type="button" class="hud-hint-x" data-hud="dismiss-landscape-hint" aria-label="Dismiss tip">&times;</button>
      </p>`;
  }

  /** Register the close hook (see onHidden). Last registration wins. */
  setOnHidden(fn: () => void): void {
    this.onHidden = fn;
  }

  private setState(state: HudState): void {
    const wasHidden = this.state === "hidden";
    this.state = state;
    this.root.hidden = state === "hidden";
    // Only the riding state is a transparent frame over the live map; the
    // others are solid cards. `ride-active` on <body> hides the app chrome
    // (drawers, mode pill, chips, map controls) for every non-hidden state.
    const riding = state === "riding";
    this.root.classList.toggle("is-riding", riding);
    document.body.classList.toggle("ride-active", state !== "hidden");
    // Long-press-to-open device taps only while the follow-cam is live; drop
    // the ride-scoped visibility filter whenever we leave it.
    this.deviceCtl.setRideActive(riding);
    if (!riding) this.deviceCtl.setRideModelFilter(null);
    if (state === "armed") this.renderArmed();
    if (state === "hidden" && !wasHidden) this.onHidden?.();
  }

  // ---------- Pre-ride ----------

  private renderArmed(): void {
    const rate = savedRatePlan();
    const options = RATE_PLANS.map(
      (p) =>
        `<option value="${p.key}" ${p.key === rate ? "selected" : ""}>${p.label}</option>`,
    ).join("");
    this.root.innerHTML = `
      <div class="hud-card">
        <h2 class="hud-title">Ride companion</h2>
        <p class="hud-note">Speed, ride clock, and a cost estimate while you ride.
          The clock is unofficial — nudge it anytime to match the Veo app.</p>
        ${this.landscapeHintMarkup()}
        <label class="hud-field">
          <span>My Veo rate</span>
          <select id="hud-rate" class="select">
            <option value="" ${rate ? "" : "selected"} disabled>Choose your rate…</option>
            ${options}
          </select>
        </label>
        <div class="hud-start-row">
          <button type="button" class="hud-btn hud-btn--primary" data-hud="start-now">Start now</button>
          <button type="button" class="hud-btn" data-hud="start-delay">Start in
            <select id="hud-delay" class="hud-inline-select">
              <option>5</option><option selected>10</option><option>15</option><option>30</option>
            </select>s
          </button>
        </div>
        <button type="button" class="hud-btn hud-btn--ghost" data-hud="close">Close</button>
      </div>`;
    // Don't let the delay <select> tap bubble into the surrounding button.
    this.root
      .querySelector("#hud-delay")
      ?.addEventListener("click", (e) => e.stopPropagation());
  }

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-hud]");
    if (!btn) return;
    switch (btn.dataset.hud) {
      case "close":
        this.stopSensors();
        this.exitFollowCam();
        this.exitImmersive();
        this.restoreTheme();
        this.setState("hidden");
        break;
      case "start-now":
        this.beginCountdown(0);
        break;
      case "start-delay": {
        const sel = this.root.querySelector<HTMLSelectElement>("#hud-delay");
        this.beginCountdown(Number(sel?.value ?? 10));
        break;
      }
      case "cancel-countdown":
        window.clearInterval(this.countdownTimer);
        this.setState("armed");
        break;
      case "toggle-night":
        // Flips the WHOLE app (CSS tokens + basemap flavor), not just the
        // HUD — the constructor's theme listener recolors the 3D buildings.
        // Deliberately ride-scoped: no persistence, and sun-sync stays
        // enabled. A mid-ride glance at the other theme must not steal the
        // user's durable preference; exiting the HUD restores the resolved
        // theme (sun-sync > stored > OS).
        applyTheme(currentTheme() === "dark" ? "light" : "dark");
        break;
      case "adjust":
        this.root
          .querySelector(".hud-adjust-panel")
          ?.toggleAttribute("hidden");
        break;
      case "nudge":
        // Shift the *start* time: +15s on the clock means the ride started
        // 15s earlier, so subtract from startedAt.
        this.startedAt -= Number(btn.dataset.ms);
        // Never let the clock go negative.
        this.startedAt = Math.min(this.startedAt, Date.now());
        this.renderTick();
        break;
      case "reset-clock":
        this.startedAt = Date.now();
        this.renderTick();
        break;
      case "dismiss-landscape-hint":
        this.setLandscapeHintDismissed(true);
        break;
      case "exit":
        this.showExitPrompt();
        break;
      case "exit-cancel":
        this.hideExitPrompt();
        break;
      case "brb":
        this.pauseRide();
        break;
      case "end":
        void this.endRide();
        break;
      case "stop-tracking":
        this.showStopTrackingPrompt();
        break;
      case "stop-tracking-confirm":
        void this.confirmStopTracking();
        break;
      case "stop-tracking-cancel":
        this.hideStopTrackingPrompt();
        break;
      case "dev": {
        const model = btn.dataset.model as ModelKey;
        if (this.rideModels.has(model)) this.rideModels.delete(model);
        else this.rideModels.add(model);
        const on = this.rideModels.has(model);
        btn.classList.toggle("is-on", on);
        btn.setAttribute("aria-pressed", String(on));
        this.applyRideModels();
        break;
      }
      case "done":
        this.exitImmersive();
        this.restoreTheme();
        this.setState("hidden");
        break;
    }
  }

  /** Chips for the adjust panel's "Show" row, reflecting the current
   *  selection. Deselecting all hides every device from the follow-cam. */
  private deviceChipsMarkup(): string {
    return ALL_MODELS
      .map((m) => {
        const on = this.rideModels.has(m);
        const label = m[0].toUpperCase() + m.slice(1);
        return `<button type="button" class="hud-chip${on ? " is-on" : ""}" data-hud="dev" data-model="${m}" aria-pressed="${on}">${label}</button>`;
      })
      .join("");
  }

  /** Push the current model selection to the map — see `rideModelFilterFor`
   *  for the all/partial/none decision. */
  private applyRideModels(): void {
    this.deviceCtl.setRideModelFilter(rideModelFilterFor(this.rideModels));
  }

  // ---------- Leave the ride view (exit door → End Ride / BRB) ----------

  /** Prominent prompt over the live HUD: End Ride (finish + summary) or BRB
   *  (background the ride, keep the counter). Dismissible via Cancel. */
  private showExitPrompt(): void {
    if (this.root.querySelector('[data-hud-prompt="exit"]')) return;
    const el = document.createElement("div");
    el.className = "hud-exit-prompt";
    el.dataset.hudPrompt = "exit";
    el.innerHTML = `
      <div class="hud-exit-card" role="dialog" aria-label="Leave ride view">
        <p class="hud-exit-title">Leave the ride view?</p>
        <div class="hud-exit-actions">
          <button type="button" class="hud-btn hud-btn--end" data-hud="end">End Ride</button>
          <button type="button" class="hud-btn hud-btn--primary" data-hud="brb">BRB</button>
        </div>
        <p class="hud-exit-note">BRB pauses the ride and keeps your counter —
          hop into Analysis or Find wheels, then resume from 🧭 Ride.</p>
        <button type="button" class="hud-btn hud-btn--ghost" data-hud="exit-cancel">Cancel</button>
      </div>`;
    this.root.appendChild(el);
  }

  private hideExitPrompt(): void {
    this.root.querySelector('[data-hud-prompt="exit"]')?.remove();
  }

  /** The wrench panel's "Stop tracking" confirm — same visual treatment as
   *  the exit prompt (`.hud-exit-prompt`/`.hud-exit-card`), a distinct
   *  `data-hud-prompt` so the two never collide when queried/dismissed. Copy
   *  must say contribution points are effectively forfeited: the chain's
   *  last waypoint won't correlate with the GBFS end, which server-side
   *  validation treats as `end_mismatch` — an INELIGIBLE verdict paying zero
   *  awards, not a reduced one (frontend plan, `ride-hud.ts` "wrench panel"
   *  note). */
  private showStopTrackingPrompt(): void {
    if (this.root.querySelector('[data-hud-prompt="stop-tracking"]')) return;
    const el = document.createElement("div");
    el.className = "hud-exit-prompt";
    el.dataset.hudPrompt = "stop-tracking";
    el.innerHTML = `
      <div class="hud-exit-card" role="dialog" aria-label="Stop tracking this ride">
        <p class="hud-exit-title">Stop tracking this ride?</p>
        <p class="hud-exit-note">We seal what's recorded so far and stop right
          here — your ride keeps going. Because your last saved point won't
          line up with wherever you actually finish, that's a location
          mismatch, not just a shorter track, so this ride will very likely
          come back ineligible for contribution points rather than reduced —
          unless you're already within about 150 m / 10 min of your real
          drop-off.</p>
        <div class="hud-exit-actions">
          <button type="button" class="hud-btn hud-btn--end" data-hud="stop-tracking-confirm">Stop tracking</button>
          <button type="button" class="hud-btn hud-btn--primary" data-hud="stop-tracking-cancel">Keep tracking</button>
        </div>
      </div>`;
    this.root.appendChild(el);
  }

  private hideStopTrackingPrompt(): void {
    this.root.querySelector('[data-hud-prompt="stop-tracking"]')?.remove();
  }

  /** Seal the final partial batch and halt further recording — the ride and
   *  HUD keep running. Removes the wrench panel's button directly rather than
   *  a full `renderRiding()` (which would also close the panel and reset any
   *  other transient UI state mid-adjustment). */
  private async confirmStopTracking(): Promise<void> {
    this.hideStopTrackingPrompt();
    const recorder = this.trackRecorder;
    if (!recorder) return;
    this.trackRecorder = null; // halt further recording immediately
    this.root.querySelector('[data-hud="stop-tracking"]')?.remove();
    try {
      await recorder.finish();
    } catch (e) {
      console.error("stop tracking: sealing the final track batch failed", e);
    }
  }

  /** BRB: background the ride. A tracked ride (F3 adaptation) keeps its clock
   *  anchored and its shared watcher + track-store recording running — only
   *  the HUD's visual display leaves; a private/guest/legacy ride keeps the
   *  original behavior: the watcher stops and the counter freezes (resumes
   *  from here, not counting the time away). Either way the HUD hides so the
   *  map chrome (Analysis / Find wheels) returns. */
  private pauseRide(): void {
    this.hideExitPrompt();
    if (brbStrategyFor(this.trackedRideId) === "continue_tracking") {
      // Release the wake lock and the tick/countdown timers (nothing to
      // render while hidden) but keep the geolocation watch alive — see
      // `stopSensors`'s `keepGeoWatch` option and `onFix`'s `following` gate,
      // which stops it from moving a map the rider isn't looking at.
      this.stopSensors({ keepGeoWatch: true });
    } else {
      this.pausedElapsedMs = Date.now() - this.startedAt;
      this.stopSensors();
    }
    this.paused = true;
    this.exitFollowCam();
    this.exitImmersive();
    this.restoreTheme();
    this.setState("hidden");
  }

  /** Come back from BRB: restore the riding view. A tracked ride's clock was
   *  never touched and its watcher never stopped (see `pauseRide`), so only
   *  the visual pieces need re-mounting; a private/guest/legacy ride
   *  continues the clock from where it froze and restarts the watcher.
   *  Invoked from open() (a user gesture, so immersive fullscreen/landscape
   *  can re-engage). */
  private async resumeRide(): Promise<void> {
    this.paused = false;
    const tracked = brbStrategyFor(this.trackedRideId) === "continue_tracking";
    if (!tracked) {
      this.startedAt = Date.now() - this.pausedElapsedMs;
    }
    void this.enterImmersive();
    this.setState("riding");
    this.renderRiding();
    // `setState` cleared the ride-model filter on the way to `hidden` — push
    // the (unchanged) current selection back (frontend plan: "resumeRide
    // needs the SAME re-push").
    this.applyRideModels();
    this.enterFollowCam();
    if (!tracked) this.startSensors();
    void this.acquireWakeLock();
  }

  /** Undo any ride-scoped ☀/☾ flips: re-resolve the theme from its durable
   *  sources (sun-sync > stored choice > OS). No-op when nothing changed,
   *  so the basemap isn't rebuilt on every HUD exit. */
  private restoreTheme(): void {
    const resolved = initialTheme();
    if (resolved !== currentTheme()) applyTheme(resolved);
  }

  /** Best-effort immersive landscape: fullscreen the HUD and lock to
   *  landscape. Both are gated by browser support and only work from a user
   *  gesture / while fullscreen, so every call is guarded and failures are
   *  silent — the CSS still adapts to whatever orientation the OS gives us. */
  private async enterImmersive(): Promise<void> {
    try {
      // Fullscreen the whole document, NOT the HUD element — the follow-cam
      // map (#map) is a sibling of the HUD, so fullscreening just the HUD
      // would drop the map out of the fullscreen subtree and leave a black
      // void behind the frame.
      const el = document.documentElement as HTMLElement & {
        requestFullscreen?: () => Promise<void>;
      };
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen();
      }
    } catch {
      /* fullscreen denied — layout still reflows for landscape */
    }
    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      await orientation?.lock?.("landscape");
    } catch {
      /* orientation lock unsupported (desktop, iOS Safari) — that's fine */
    }
  }

  private exitImmersive(): void {
    try {
      (screen.orientation as ScreenOrientation & { unlock?: () => void })?.unlock?.();
    } catch {
      /* nothing to unlock */
    }
    try {
      if (document.fullscreenElement) void document.exitFullscreen?.();
    } catch {
      /* not in fullscreen */
    }
  }

  private beginCountdown(seconds: number): void {
    const rateSel = this.root.querySelector<HTMLSelectElement>("#hud-rate");
    const rate = (rateSel?.value || savedRatePlan() || "") as RatePlanKey | "";
    if (!rate) {
      rateSel?.classList.add("is-error");
      rateSel?.focus();
      return;
    }
    saveRatePlan(rate);

    // Go immersive from within this click gesture (both start paths pass
    // through here): fullscreen + a best-effort landscape lock, because the
    // whole reason Ride mode exists is that the Veo app has no landscape
    // view and the phone is mounted sideways on the handlebars.
    void this.enterImmersive();

    if (seconds <= 0) {
      void this.startRide();
      return;
    }
    this.setState("countdown");
    let remaining = seconds;
    const render = () => {
      this.root.innerHTML = `
        <div class="hud-card hud-card--countdown">
          <div class="hud-countdown">${remaining}</div>
          <p class="hud-note">Scan the QR and start the scooter — the clock
            starts when this hits zero.</p>
          ${this.landscapeHintMarkup()}
          <button type="button" class="hud-btn hud-btn--ghost" data-hud="cancel-countdown">Cancel</button>
        </div>`;
    };
    render();
    this.countdownTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(this.countdownTimer);
        void this.startRide();
      } else {
        render();
      }
    }, 1000);
  }

  // ---------- Riding ----------

  /** Fresh ride entry, shared by the legacy armed→countdown→start flow and
   *  `beginHandoff`'s wizard/reload handoff — the two ways a ride can begin.
   *  Resets every per-ride accumulator, hides every scooter by default (F3;
   *  see `rideModelFilterFor`), closes any lingering popups/tooltips, and
   *  starts the single shared watchPosition (F3; see `onFix`/`startSensors`). */
  private enterRiding(opts: {
    startedAtMs: number;
    rideId: string | null;
    recorder: RideHudTrackControl | null;
  }): void {
    this.startedAt = opts.startedAtMs;
    this.trackedRideId = opts.rideId;
    this.trackRecorder = opts.recorder;
    this.smoothedMps = 0;
    this.distanceM = 0;
    this.lastFix = null;
    this.startPos = null;
    this.startedInZone = false;
    this.lastBearing = 0;
    this.paused = false;
    this.pausedElapsedMs = 0;
    this.rideModels = new Set(); // every ride starts hiding every scooter
    this.setState("riding");
    this.renderRiding();
    this.applyRideModels();
    closeAllPopups();
    this.enterFollowCam();
    this.startSensors();
    void this.acquireWakeLock();
  }

  private async startRide(): Promise<void> {
    this.enterRiding({ startedAtMs: Date.now(), rideId: null, recorder: null });
  }

  /** Pitch the map into follow-cam framing and raise 3D buildings. Camera
   *  then tracks each GPS fix in onFix(). */
  private enterFollowCam(): void {
    const c = this.map.getCenter();
    this.savedView = {
      center: { lng: c.lng, lat: c.lat },
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
    };
    this.map.easeTo({ pitch: RIDE_PITCH, zoom: RIDE_ZOOM, duration: 600 });
    this.addBuildings3D();
    this.userMarker ??= new maplibregl.Marker({ element: makeUserDot() });
    this.following = true;
  }

  /** Restore the pre-ride 2D view and remove ride-only map decorations. */
  private exitFollowCam(): void {
    if (!this.following) return;
    this.following = false;
    this.userMarker?.remove();
    this.removeBuildings3D();
    if (this.savedView) {
      this.map.easeTo({
        center: [this.savedView.center.lng, this.savedView.center.lat],
        zoom: this.savedView.zoom,
        pitch: this.savedView.pitch,
        bearing: this.savedView.bearing,
        duration: 500,
      });
      this.savedView = null;
    } else {
      this.map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
    }
  }

  /** Raise building footprints into extrusions for a 3D feel. The basemap's
   *  vector tiles may not carry heights, so we coalesce to a modest uniform
   *  height — enough for a pitched cityscape. Inserted beneath the device
   *  pins so scooters stay visible. No-op if the buildings layer is absent. */
  private addBuildings3D(): void {
    if (this.map.getLayer(BUILDINGS_3D_LAYER)) return;
    const style = this.map.getStyle();
    const buildings = style.layers?.find(
      (l) => (l as { "source-layer"?: string })["source-layer"] === "buildings",
    ) as { source?: string } | undefined;
    if (!buildings?.source) return;
    const before = this.map.getLayer(FIRST_DEVICE_LAYER)
      ? FIRST_DEVICE_LAYER
      : undefined;
    try {
      this.map.addLayer(
        {
          id: BUILDINGS_3D_LAYER,
          type: "fill-extrusion",
          source: buildings.source,
          "source-layer": "buildings",
          paint: {
            "fill-extrusion-color": buildingsColor(),
            "fill-extrusion-height": [
              "coalesce",
              ["to-number", ["get", "render_height"]],
              ["to-number", ["get", "height"]],
              12,
            ],
            "fill-extrusion-base": [
              "coalesce",
              ["to-number", ["get", "render_min_height"]],
              0,
            ],
            "fill-extrusion-opacity": 0.85,
          },
        },
        before,
      );
    } catch {
      /* source-layer name differs in this basemap — pitched 2D is fine */
    }
  }

  private removeBuildings3D(): void {
    if (this.map.getLayer(BUILDINGS_3D_LAYER)) {
      this.map.removeLayer(BUILDINGS_3D_LAYER);
    }
  }

  private renderRiding(): void {
    // The map IS the screen. Only tiny cutouts sit over it, one per corner:
    //   top-left  — ride clock, ≈ cost just below it (F3 relocation — was
    //               bottom-left, sharing that corner with the round buttons)
    //   top-right — digital mph (transparent, contrasting)
    //   bottom-left  — ONLY the three round buttons now (exit/end/adjust)
    //   bottom-right — analog speedometer with an animated needle
    const rateOptions = RATE_PLANS.map(
      (p) =>
        `<option value="${p.key}" ${p.key === savedRatePlan() ? "selected" : ""}>${p.label}</option>`,
    ).join("");
    this.root.innerHTML = `
      <div class="hud-live">
        <div class="hud-corner hud-corner--tl">
          <div class="hud-tl-stack">
            <span id="hud-clock" class="hud-readout hud-readout--clock">0:00</span>
            <span id="hud-cost" class="hud-readout hud-readout--cost hud-readout--cost-sub"></span>
          </div>
        </div>
        <div class="hud-corner hud-corner--tr">
          <span class="hud-readout hud-readout--mph"><b id="hud-mph">0</b><i>mph</i></span>
        </div>
        <div id="hud-zone" class="hud-zone-badge" hidden>🏷️ Equity zone</div>
        <div class="hud-rotate-badge">
          <button type="button" class="hud-rotate-badge__close" data-hud="dismiss-landscape-hint" aria-label="Dismiss">&times;</button>
          ${rotateIconMarkup("hud-rotate-badge__icon")}
          <span class="hud-rotate-badge__text">Landscape works best</span>
        </div>
        <div class="hud-corner hud-corner--bl">
          <div class="hud-cutout-btns">
            <button type="button" class="hud-round-btn" data-hud="exit" aria-label="Leave ride view">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </button>
            <button type="button" class="hud-round-btn hud-round-btn--stop" data-hud="end" aria-label="End ride">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
            </button>
            <button type="button" class="hud-round-btn" data-hud="adjust" aria-label="Adjust time and rate">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.121 2.121 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="hud-corner hud-corner--br">${speedoMarkup()}</div>

        <div class="hud-adjust-panel" hidden>
          <div id="hud-adjust-clock" class="hud-adjust-clock">0:00</div>
          <div class="hud-adjust-row">
            <button type="button" class="hud-btn" data-hud="nudge" data-ms="-60000">−1m</button>
            <button type="button" class="hud-btn" data-hud="nudge" data-ms="-15000">−15s</button>
            <button type="button" class="hud-btn" data-hud="reset-clock">reset</button>
            <button type="button" class="hud-btn" data-hud="nudge" data-ms="15000">+15s</button>
            <button type="button" class="hud-btn" data-hud="nudge" data-ms="60000">+1m</button>
          </div>
          <label class="hud-field">
            <span>Rate</span>
            <select id="hud-rate-live" class="select">${rateOptions}</select>
          </label>
          <div class="hud-adjust-row hud-devrow">
            <span class="hud-devrow__label">Show</span>
            ${this.deviceChipsMarkup()}
          </div>
          ${this.stopTrackingRowMarkup()}
          <div class="hud-adjust-row">
            <button type="button" class="hud-btn" data-hud="toggle-night">☀ / ☾ theme</button>
            <button type="button" class="hud-btn hud-btn--primary" data-hud="adjust">Done</button>
          </div>
        </div>
      </div>`;
    this.needleEl = this.root.querySelector<SVGElement>("#speedo-needle");
    // Live rate change from the adjust panel — recompute the cost ticker.
    this.root
      .querySelector<HTMLSelectElement>("#hud-rate-live")
      ?.addEventListener("change", (e) => {
        saveRatePlan((e.target as HTMLSelectElement).value as RatePlanKey);
        this.renderTick();
      });
    window.clearInterval(this.tickTimer);
    this.tickTimer = window.setInterval(() => this.renderTick(), 1000);
    this.renderTick();
  }

  /** Wrench panel's "Stop tracking" row — only while there is something to
   *  stop AND a tracked ride to have contribution points on (the confirm
   *  copy is specifically about donation eligibility, which never applies to
   *  a private ride). */
  private stopTrackingRowMarkup(): string {
    if (!this.trackRecorder || this.trackedRideId === null) return "";
    return `
          <div class="hud-adjust-row">
            <button type="button" class="hud-btn hud-btn--end" data-hud="stop-tracking">Stop tracking</button>
          </div>`;
  }

  private renderTick(): void {
    if (this.state !== "riding") return;
    const elapsed = Date.now() - this.startedAt;
    const clockText = formatClock(elapsed);
    const clock = this.root.querySelector("#hud-clock");
    if (clock) clock.textContent = clockText;
    const adjustClock = this.root.querySelector("#hud-adjust-clock");
    if (adjustClock) adjustClock.textContent = clockText;
    const cost = this.root.querySelector("#hud-cost");
    const rate = savedRatePlan();
    if (cost && rate) {
      cost.textContent = `≈ ${formatCents(rideCostCents(planFor(rate), elapsed))}`;
    }
    const mphValue = this.smoothedMps * MPS_TO_MPH;
    const mph = this.root.querySelector("#hud-mph");
    if (mph) mph.textContent = String(Math.round(mphValue));
    // Sweep the analog needle (CSS transition animates the motion).
    if (this.needleEl) {
      const clamped = Math.max(0, Math.min(SPEEDO_MAX_MPH, mphValue));
      const deg = SPEEDO_START + (clamped / SPEEDO_MAX_MPH) * SPEEDO_SWEEP;
      this.needleEl.style.transform = `rotate(${deg}deg)`;
    }
  }

  private startSensors(): void {
    if (!("geolocation" in navigator)) return;
    this.watchId = navigator.geolocation.watchPosition(
      (fix) => this.onFix(fix),
      () => {
        /* speed just stays at 0 without fixes; the clock still works */
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }

  private onFix(fix: GeolocationPosition): void {
    const pos: LngLat = { lng: fix.coords.longitude, lat: fix.coords.latitude };
    const t = fix.timestamp;

    if (!this.startPos) {
      this.startPos = pos;
      void this.flagEquityStart(pos);
    }

    // Prefer the device-reported speed; derive from successive fixes when
    // the platform doesn't provide one.
    let mps = fix.coords.speed;
    if ((mps === null || !Number.isFinite(mps)) && this.lastFix) {
      const dt = (t - this.lastFix.t) / 1000;
      if (dt > 0.5) mps = distanceMeters(this.lastFix.pos, pos) / dt;
    }
    if (mps !== null && Number.isFinite(mps!) && mps! <= MAX_PLAUSIBLE_MPS) {
      this.smoothedMps =
        this.smoothedMps + SPEED_ALPHA * (Math.max(0, mps!) - this.smoothedMps);
    }

    if (this.lastFix) {
      const step = distanceMeters(this.lastFix.pos, pos);
      const dt = (t - this.lastFix.t) / 1000;
      // Accumulate only plausible movement so GPS drift while stopped at a
      // light doesn't inflate the ride distance.
      if (dt > 0 && step / dt <= MAX_PLAUSIBLE_MPS && step > 1) {
        this.distanceM += step;
      }
    }
    this.lastFix = { pos, t };

    // Shared watchPosition (F3): every fix feeds track-store too, regardless
    // of follow-cam / BRB state — a backgrounded TRACKED ride keeps recording
    // (see `pauseRide`'s tracked branch, which deliberately leaves this
    // watcher running through BRB). This is the only place ride-hud.ts ever
    // calls into track-store's per-fix API; nothing here posts to the
    // retired per-waypoint upload endpoint.
    if (this.trackRecorder) {
      const trackFix: TrackFix = {
        tMs: fix.timestamp,
        lat: fix.coords.latitude,
        lon: fix.coords.longitude,
        accM: fix.coords.accuracy,
      };
      void this.trackRecorder.addFix(trackFix);
    }

    // Drive the follow-cam only while it's actually mounted. BRB tears it
    // down (`exitFollowCam`) without necessarily stopping a tracked ride's
    // watcher, so a fix arriving mid-BRB must not move a map the rider is
    // looking at for something else (Analysis / Find wheels).
    if (this.following) {
      if (
        fix.coords.heading !== null &&
        Number.isFinite(fix.coords.heading) &&
        this.smoothedMps >= BEARING_MIN_MPS
      ) {
        this.lastBearing = fix.coords.heading;
      }
      this.userMarker?.setLngLat([pos.lng, pos.lat]).addTo(this.map);
      // Hold the camera still while a device popup is open, so it doesn't
      // slide out from under the rider mid-read. The marker still tracks;
      // recentering resumes on the next fix after the popup closes.
      if (!this.deviceCtl.hasOpenPopup()) {
        this.map.easeTo({
          center: [pos.lng, pos.lat],
          // Push the focal point down so the rider sits low on screen and
          // sees the road ahead. Screen-space offset, so it stays "toward
          // the bottom" regardless of which way the bearing-up map is
          // rotated.
          offset: [0, this.map.getContainer().clientHeight * RIDE_FOCUS_OFFSET_FRAC],
          bearing: this.lastBearing,
          pitch: RIDE_PITCH,
          zoom: RIDE_ZOOM,
          duration: 700,
        });
      }
    }
    this.renderTick();
  }

  private async flagEquityStart(pos: LngLat): Promise<void> {
    try {
      const zones = await this.equityZones();
      this.startedInZone = pointInAny(pos.lng, pos.lat, zones);
      const el = this.root.querySelector<HTMLElement>("#hud-zone");
      if (el) el.hidden = !this.startedInZone;
    } catch {
      /* zones unavailable — flag simply doesn't show */
    }
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
      };
      this.wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      /* unsupported or denied — screen may sleep, everything else works */
    }
  }

  /** `keepGeoWatch` is BRB's tracked-ride escape hatch (`pauseRide`): release
   *  the wake lock and the tick/countdown timers (nothing renders while
   *  hidden) but leave the geolocation watch — and therefore track-store
   *  recording — running. Every other call site wants the full stop. */
  private stopSensors(opts: { keepGeoWatch?: boolean } = {}): void {
    if (!opts.keepGeoWatch) {
      if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    window.clearInterval(this.tickTimer);
    window.clearInterval(this.countdownTimer);
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  // ---------- Summary ----------

  private async endRide(): Promise<void> {
    const elapsed = Date.now() - this.startedAt;
    const endPos = this.lastFix?.pos ?? null;
    this.stopSensors();
    this.exitFollowCam();

    // F3 interim (ride-post.ts / Screen 8 don't exist until F4): a tracked
    // ride's End Ride owns the minimal PATCH /end itself — required so an
    // unreported end doesn't 409 the rider's next ride start. Fire-and-forget
    // so a slow/offline network never blocks the summary the rider is about
    // to see; failures are logged, not surfaced, and a later reload's
    // recovery table picks the loose end back up (see `reportTrackedRideEnd`).
    if (this.trackedRideId !== null) {
      void this.reportTrackedRideEnd(this.trackedRideId, endPos ?? this.startPos);
    }

    let endedInZone = false;
    if (endPos) {
      try {
        endedInZone = pointInAny(
          endPos.lng,
          endPos.lat,
          await this.equityZones(),
        );
      } catch {
        /* flag stays off */
      }
    }

    const rate = savedRatePlan();
    const plan = planFor(rate ?? "resident");
    const veoCents = rideCostCents(plan, elapsed);
    const limeCents = comparatorCostCents(elapsed);
    const deltaCents = veoCents - limeCents;
    const miles = this.distanceM / 1609.344;
    const zoneRide = this.startedInZone || endedInZone;

    const rows: string[] = [
      row("Duration", formatClock(elapsed)),
      row("Distance", `${miles.toFixed(1)} mi`),
      row(
        `Est. Veo cost (${plan.key.replace("_plus", ", VeoPlus")})`,
        formatCents(veoCents),
      ),
      row(`With ${COMPARATOR.name}'s typical pricing`, formatCents(limeCents)),
    ];

    const veoPlusLine = plan.veoPlus
      ? `<p class="hud-note">VeoPlus Pass applied — unlock fee waived.</p>`
      : "";

    const monopolyLine =
      deltaCents > 0
        ? `<p class="hud-note hud-note--pointed">You paid ≈ ${formatCents(deltaCents)} more because Denver has one operator.
           A ${formatCents(COMPARATOR.weekPassCents)}/week ${COMPARATOR.name} pass would cover this in
           ${Math.max(1, Math.ceil(COMPARATOR.weekPassCents / Math.max(1, limeCents)))} rides.</p>`
        : "";

    const zoneLine = zoneRide
      ? `<p class="hud-zone">🏷️ This ride ${this.startedInZone ? "started" : "ended"} in an equity zone —
         Veo owes you the contract discount. Open the Veo app → History and check your receipt.</p>`
      : "";

    this.setState("summary");
    this.root.innerHTML = `
      <div class="hud-card">
        <h2 class="hud-title">Ride summary</h2>
        <dl class="hud-summary">${rows.join("")}</dl>
        ${veoPlusLine}
        ${zoneLine}
        ${monopolyLine}
        <p class="hud-note">Estimates from this device's clock and GPS — your Veo receipt is the bill.</p>
        <button type="button" class="hud-btn hud-btn--primary" data-hud="done">Done</button>
      </div>`;
  }

  /** F3 interim End Ride report (frontend plan, Phase F3 "ride end" note):
   *  seals the final track-store batch, sends the MINIMAL `PATCH /end`
   *  (`minimalEndReport` — ended_at/end_lat/end_lon only; the §10 fields are
   *  Screen 8's, in F4), then marks the session doc `done` — requires the
   *  store to have been created with `legacyEndRide: true` (see this
   *  module's header note and the integrator report; without it the doc
   *  lands on `ending(8)` instead, a screen that doesn't exist yet in F3).
   *  Best-effort throughout: a failure here must not strand the rider on the
   *  summary screen — the doc simply stays unreported, and a later reload's
   *  recovery table (`seal_and_end` / the 409 prompt) picks the loose end
   *  back up. */
  private async reportTrackedRideEnd(
    rideId: string,
    pos: LngLat | null,
  ): Promise<void> {
    const recorder = this.trackRecorder;
    this.trackRecorder = null; // stop feeding fixes into a ride that is over
    try {
      await recorder?.finish();
    } catch (e) {
      console.error("end ride: sealing the final track batch failed", e);
    }
    if (!pos) {
      console.error(
        "end ride: no GPS fix available — the minimal /end report was skipped",
      );
      return;
    }
    try {
      await endTrackedRide(rideId, minimalEndReport(Date.now(), pos));
      this.session?.dispatch({ type: "endRide" });
    } catch (e) {
      console.error("end ride: reporting the minimal /end failed", e);
    }
  }
}

function row(label: string, value: string): string {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

/** Rotate-hint glyph: a phone that visibly rotates portrait↔landscape (CSS
 *  keyframes, see .rotate-icon__phone), ringed by a static rotate arrow so
 *  the cue still reads correctly with the animation frozen
 *  (prefers-reduced-motion — a bare paused phone rectangle wouldn't say
 *  "rotate" on its own). Shared between the compact pre-ride note and the
 *  larger in-ride card; `sizeClass` picks the rendered footprint. */
function rotateIconMarkup(sizeClass: string): string {
  return `<svg class="${sizeClass}" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="86 119.4" transform="rotate(-40 24 24)" opacity="0.55"/>
    <polygon points="40.5,10.5 44.5,15 38.5,16.5" fill="currentColor" opacity="0.55"/>
    <rect class="rotate-icon__phone" x="17" y="11" width="14" height="26" rx="3.5" stroke="currentColor" stroke-width="2.5"/>
  </svg>`;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The rider's position marker on the follow-cam: a bright dot with a soft
 *  pulsing halo, legible against both day and night basemaps. */
function makeUserDot(): HTMLElement {
  const el = document.createElement("div");
  el.className = "ride-user-dot";
  return el;
}

// ---------- Analog speedometer ----------

const SPEEDO_CX = 100;
const SPEEDO_CY = 100;
const SPEEDO_R = 84;

/** Point on the dial at `mph` and `radius` (SVG coords). 0° = straight up,
 *  angle increases clockwise, matching the needle's rotate(). */
function speedoPoint(mph: number, radius: number): [number, number] {
  const deg = SPEEDO_START + (mph / SPEEDO_MAX_MPH) * SPEEDO_SWEEP;
  const a = (deg * Math.PI) / 180;
  return [SPEEDO_CX + radius * Math.sin(a), SPEEDO_CY - radius * Math.cos(a)];
}

/** Static markup for a car-style dial: outer track, a caution band near the
 *  top of the range, tick marks + numerals every 3 mph, and the needle
 *  (id=speedo-needle) that renderTick() rotates. */
function speedoMarkup(): string {
  const [tx, ty] = speedoPoint(0, SPEEDO_R);
  const [ux, uy] = speedoPoint(SPEEDO_MAX_MPH, SPEEDO_R);
  const track = `<path d="M ${r(tx)} ${r(ty)} A ${SPEEDO_R} ${SPEEDO_R} 0 1 1 ${r(ux)} ${r(uy)}" class="speedo-track"/>`;

  // Caution band 15→18 mph (Denver's cap sits ~15).
  const [cx0, cy0] = speedoPoint(15, SPEEDO_R);
  const [cx1, cy1] = speedoPoint(SPEEDO_MAX_MPH, SPEEDO_R);
  const caution = `<path d="M ${r(cx0)} ${r(cy0)} A ${SPEEDO_R} ${SPEEDO_R} 0 0 1 ${r(cx1)} ${r(cy1)}" class="speedo-caution"/>`;

  let ticks = "";
  for (let t = 0; t <= SPEEDO_MAX_MPH; t++) {
    const major = t % 3 === 0;
    const [x1, y1] = speedoPoint(t, SPEEDO_R - 3);
    const [x2, y2] = speedoPoint(t, SPEEDO_R - (major ? 15 : 8));
    ticks += `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" class="speedo-tick${major ? " speedo-tick--major" : ""}"/>`;
    if (major) {
      const [lx, ly] = speedoPoint(t, SPEEDO_R - 30);
      ticks += `<text x="${r(lx)}" y="${r(ly)}" class="speedo-num">${t}</text>`;
    }
  }

  return `
    <svg class="speedo" viewBox="0 0 200 200" role="img" aria-label="Speedometer, 0 to ${SPEEDO_MAX_MPH} mph">
      <circle cx="100" cy="100" r="96" class="speedo-face"/>
      ${track}${caution}${ticks}
      <text x="100" y="150" class="speedo-unit">mph</text>
      <polygon id="speedo-needle" class="speedo-needle" points="96.5,100 103.5,100 100,26" style="transform: rotate(${SPEEDO_START}deg)"/>
      <circle cx="100" cy="100" r="8" class="speedo-hub"/>
    </svg>`;
}

/** Round to 2 dp to keep the generated SVG path strings compact. */
function r(n: number): number {
  return Math.round(n * 100) / 100;
}
