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
import { EQUITY_DISCOUNT_NOTICE } from "./equity-areas.ts";
import { distanceMeters, type LngLat } from "./locate.ts";
import {
  FIRST_DEVICE_LAYER,
  ALL_MODELS,
  ROVER_AREA_WARNING,
  type ModelKey,
} from "./devices.ts";

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
  billableMinutes,
  comparatorPassQuote,
  equityAreaCostCents,
  formatCents,
  planFor,
  rideCostCents,
  savedRatePlan,
  saveRatePlan,
} from "./ride-cost.ts";
import { closeAllPopups } from "./chrome.ts";
import { MODEL_NAMES } from "./model-catalog.ts";
import { dropNativeUndoHistory } from "./ios-shake-undo.ts";
// F4: `endTrackedRide` itself is no longer called from this module — Screen 8
// (`ride-post-s8.ts`) owns the ride's single `PATCH /end` now (see
// `handOffTrackedRideEnd` below). `EndRideIn` stays imported for
// `minimalEndReport`'s return type, which stays exported/tested as a pure
// function even though this class no longer calls it itself.
import type { EndRideIn } from "./api.ts";
import { isOwnDevice, selectedDevice } from "./ride-session.ts";
import type { RideSessionStore, RideState as RideSessionState } from "./ride-session.ts";
import type { TrackAddResult, TrackFix, TrackRecorder } from "./track-store.ts";
import { createNavHud, decodePolyline, type NavHud } from "./ride-nav-hud.ts";
import { colorForProfile } from "./ride-screen-routes.ts";
import type { RideRouteLineHandle } from "./ride-route-line.ts";
import { trailCoordsFromBatches, type RideTrailHandle } from "./ride-trail.ts";

// ---------------------------------------------------------------------------
// F3: tracked-ride seams (frontend plan, `ride-hud.ts` module-map row + the
// F3 phase section). This module never CREATES a ride-session doc or a
// track-store recorder — `ride-screen-start.ts` (F2) owns the former,
// whichever module wires the Screen 6 → HUD handoff owns the latter's
// lifecycle (opening/resuming IndexedDB is async and belongs with the rest
// of that recovery machinery). ride-hud.ts only CONSUMES both: it feeds the
// shared watchPosition into an already-live recorder, and it dispatches the
// one ride-session action it ever needs (`endRide` — F4: seals the final
// batch and hands a tracked ride off to Screen 8, see
// `handOffTrackedRideEnd` below; a private ride still gets the original
// client-only close-out via `endPrivateRide`).
// ---------------------------------------------------------------------------

/** The recorder methods ride-hud.ts calls — a `Pick`, not the whole
 *  `TrackRecorder`, so a fake in tests (or a future alternate implementation)
 *  only has to satisfy what this module actually uses.
 *
 *  `batches` is OPTIONAL where the other two are required: it exists only to
 *  seed the live trail with what a RESUMED ride already recorded before the
 *  reload (see `seedTrail`), and a recorder that cannot answer that question
 *  simply draws its trail from the next fix onward — a degraded picture, not
 *  a broken ride. Keeping it optional also means every existing
 *  `{ addFix, finish }` fake still satisfies this type. */
export type RideHudTrackControl = Pick<TrackRecorder, "addFix" | "finish"> &
  Partial<Pick<TrackRecorder, "batches">>;

/** The one ride-session action ride-hud.ts ever dispatches, plus a read of
 *  the live doc — the integrator's `case "riding"` guard already reads
 *  `RideSessionStore.current()` directly for `isLiveRideEntry`, and this
 *  module needs the same read internally to know whether the current ride
 *  has a `route` to mount the Screen 7 nav overlay against (see
 *  `mountNavHud` below) — it never WRITES `route`/`dest`, only reads them. */
export type RideHudSessionControl = Pick<RideSessionStore, "dispatch" | "current">;

export interface RideHudDeps {
  /** Wired once the tracking-integration lane (or the integrator) attaches
   *  the shared `RideSessionStore` — omit it and ride-hud.ts behaves exactly
   *  as it does today (a legacy, session-doc-free HUD): `handOffTrackedRideEnd`
   *  has nothing to dispatch to, and the Screen 7 nav overlay never mounts
   *  (no doc to read a `route` off of). */
  session?: RideHudSessionControl;
  /** The live breadcrumb layer (`ride-trail.ts`), drawn on the same map this
   *  HUD follow-cams. Injected rather than created here for the same reason
   *  `map`/`deviceCtl` are: this module drives ride-mode behavior, main.ts
   *  owns which map objects exist. Omit it and the HUD behaves exactly as it
   *  did before — recording still happens, it just isn't drawn. */
  trail?: RideTrailHandle;
  /** The planned-pathway layer (`ride-route-line.ts`) — the Screen 4 route
   *  the nav overlay is guiding along, superimposed on the same map. Injected
   *  for the same reason `trail` is. Omit it and navigation behaves exactly
   *  as before: instructions only, no line on the map. */
  routeLine?: RideRouteLineHandle;
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
  /** GPS fixes seen this ride — the summary's "Waypoints" figure. A plain
   *  count of what the shared watchPosition delivered, deliberately NOT read
   *  from the trail or the track recorder: it stays meaningful with Save
   *  Ride Tracks off, and it has no ordering hazard against `endRide`'s
   *  trail wipe. */
  private fixCount = 0;
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
  /** The live breadcrumb of this ride's recorded track, or null when the
   *  integrator wired no trail layer — see `RideHudDeps.trail`. Fed from the
   *  SAME shared watchPosition callback as `trackRecorder`, but only once the
   *  recorder has confirmed a fix was actually saved (see `onFix`): the line
   *  is a picture of the local track, so drawing a point the store rejected
   *  or failed to write would be a picture of something that doesn't
   *  exist. */
  private readonly trail: RideTrailHandle | null;
  /** The planned pathway drawn on the map while the nav overlay guides along
   *  it, or null when the integrator wired none — see `RideHudDeps.routeLine`.
   *  Drawn/replaced only from `mountNavHud` (initial route + off-route
   *  re-routes), hidden with the follow-cam through BRB, wiped on nav dismiss
   *  and at ride end. */
  private readonly routeLine: RideRouteLineHandle | null;
  /** Bumped on every `enterRiding`. The trail seed for a resumed ride is read
   *  out of IndexedDB asynchronously, and a ride can end (and another begin)
   *  before that read lands — this is what stops one ride's history from
   *  being drawn under the next one. */
  private rideGeneration = 0;
  /** Whether THIS ride draws a trail: Save Ride Tracks is the option whose
   *  own copy promises the rider they can "trace where you've been on the map
   *  display", so turning it off has to take the line away too, not just the
   *  donation. Captured once per ride from the session doc (Screen 2 is
   *  pre-ride; nothing moves it mid-ride), and true for the legacy
   *  session-free armed→countdown→start path, which has no options blob to
   *  read and whose rider never opted out of anything. */
  private trailOn = true;
  /** Screen 7 turn-by-turn overlay for the current ride, or null when no
   *  route is active (out-of-coverage / nav off) or the session isn't wired.
   *  Fed from the SAME shared watchPosition callback as `trackRecorder` (see
   *  `onFix`) — the phase's central integration seam. Lives in its own
   *  persistent child element (`navHudContainer`) rather than inside the
   *  `renderRiding()` template string, so a BRB resume's full innerHTML
   *  rebuild can re-parent it without losing its internal route progress
   *  (matched shape index, current maneuver, off-route timers). */
  private navHud: NavHud | null = null;
  private navHudContainer: HTMLElement | null = null;
  /** A press-and-hold dismiss on the nav overlay's own corner arrow silences
   *  it for the rest of THIS ride — `mountNavHud` must not resurrect it on
   *  the next BRB resume's `renderRiding()` call. Reset in `enterRiding`. */
  private navDismissed = false;

  /** Whether the live HUD shows its ≈ cost readout.
   *
   *  This is `RideOptions.cost_hud` finally being READ. It never was before:
   *  `ride-settings.ts`'s header records that the pre-ride "Est. Veo Cost
   *  HUD" row was removed precisely because the field it wrote was dead —
   *  the cost display was unconditional, driven only by `ride-cost.ts`'s
   *  always-on rate-plan preference. The device card's pre-ride survey asks
   *  about it again and promises the ride "starts without visible HUD cost",
   *  so the toggle has to actually do something now.
   *
   *  Defaults ON, matching the previous unconditional behaviour: every entry
   *  point that does not explicitly say otherwise gets exactly what it got
   *  before. Only the ≈ cost readout is affected — the ride clock, speed and
   *  the post-ride summary are all separate surfaces and stay put. */
  private costHudVisible = true;

  /** The last preference PUSHED via `setCostHudVisible`, or null if it was
   *  never called. Kept separately from `costHudVisible` (the live per-ride
   *  flag) so a session-less ride can reset to something honest: the pushed
   *  preference if there is one, else the documented always-on default —
   *  never whatever the PREVIOUS ride's doc derived (review fix: an
   *  own-device ride force-off used to survive into an unrelated legacy
   *  quick-start ride, whose rider never opted out of anything). */
  private costHudPref: boolean | null = null;

  /** True while the CURRENT ride is "My own Device". Captured once per ride
   *  in `enterRiding` (nothing moves it mid-ride). The Veo cost counter is
   *  a picture of Veo's per-minute billing clock, and an own-device ride has
   *  no such clock running — so this forces the counter off for the ride and
   *  drops its wrench-panel toggle entirely (there is nothing meaningful to
   *  turn back on). Also drops the legacy summary's cost/comparator rows for
   *  the same reason. */
  private ownDeviceRide = false;

  /** Whether the live HUD shows the bottom-right analog speedometer and the
   *  top-right digital mph readout (`RideOptions.speedometer`, finally read —
   *  ride-settings.ts's header records the field was never consumed before).
   *  Seeded per ride from the session doc — `"classic"` shows both (the ℹ
   *  copy's "ON by default both a classic and digital readout"), `"digital"`
   *  only the digital, `"none"` neither; a session-less legacy ride shows
   *  both, exactly as it always did — and flippable mid-ride from the wrench
   *  panel's Display chips. Ride-scoped, like the ☀/☾ toggle: no
   *  persistence. */
  private speedoClassicVisible = true;
  private speedoDigitalVisible = true;

  /** Whether the top-left ride clock shows. Independent of the cost flag —
   *  the rider can watch the timer without being shown a price (or vice
   *  versa; the two share the TL stack but hide separately). Always starts
   *  ON: there is no pre-ride option for it, it's a wrench-panel Display
   *  chip like the speedometers, ride-scoped and unpersisted. The wrench
   *  panel's own adjust clock stays visible regardless — you can't nudge a
   *  clock you can't see. */
  private timerVisible = true;

  constructor(
    container: HTMLElement,
    /** Lazily resolves the city's official Equity Area polygons for the
     *  start/end flags — the same map the on-screen indicator and the
     *  compliance numbers use. */
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
    this.trail = deps.trail ?? null;
    this.routeLine = deps.routeLine ?? null;
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

  /** Show or hide the live ≈ cost readout (`RideOptions.cost_hud`).
   *
   *  Safe to call before, during or after a ride: it stamps the flag and
   *  re-syncs whatever is currently on screen, so the wizard can set it in
   *  the same breath as `beginHandoff()` without caring which ran first.
   *  Hiding uses the `hidden` attribute rather than removing the node, so a
   *  rider who changes their rate plan mid-ride and flips it back finds the
   *  readout already up to date.
   *
   *  Note `enterRiding` re-derives this flag from the session doc whenever a
   *  live one exists (including forcing it off for an own-device ride, which
   *  Veo isn't billing) — so a pre-handoff call matters mainly for the
   *  session-less legacy path, where there is no doc to derive from. */
  setCostHudVisible(visible: boolean): void {
    this.costHudPref = visible;
    this.costHudVisible = visible;
    this.syncCostVisibility();
    if (this.state === "riding") this.renderTick();
  }

  private syncCostVisibility(): void {
    const cost = this.root.querySelector<HTMLElement>("#hud-cost");
    if (cost) cost.hidden = !this.costHudVisible;
  }

  /** Attach (or replace, or clear) the live track-store recorder for the
   *  CURRENT ride — for a recorder that finishes an async open/resume
   *  slightly after `beginHandoff()` already put the HUD on screen, or for
   *  the tracking-integration lane to hand over a freshly re-imported one
   *  after a reload. A no-op call with the HUD not riding is harmless. */
  attachTrackRecorder(recorder: RideHudTrackControl | null): void {
    this.trackRecorder = recorder;
    // A recorder arriving late is the normal case for the wizard's Screen 6
    // handoff (opening IndexedDB is async) and the only case for a reload
    // recovery that re-imports one. Either way the trail has to catch up on
    // whatever that recorder already holds — for a freshly started ride
    // that's nothing, which `seedTrail` handles by drawing nothing.
    if (recorder) this.seedTrail(recorder);
  }

  /** Draw what a recorder has ALREADY sealed, under whatever this ride has
   *  drawn live so far. Only a resumed ride has anything to seed — a reload
   *  mid-ride, or the resume-or-end prompt's Resume — but the fresh-start
   *  path runs the same code with an empty batch list rather than needing the
   *  caller to know which case it's in.
   *
   *  Best-effort throughout: a trail is a picture, and failing to redraw the
   *  first half of one must never take a live ride down with it. */
  private seedTrail(recorder: RideHudTrackControl): void {
    if (this.state !== "riding") return;
    if (!this.trail || !this.trailOn || !recorder.batches) return;
    const generation = this.rideGeneration;
    void recorder
      .batches()
      .then((batches) => {
        // Another ride has since begun — drawing this now would put one
        // ride's history under another's.
        if (generation !== this.rideGeneration) return;
        // …or THIS ride ended while the read was in flight, in which case
        // `endRide` has already wiped the trail and a late prepend would
        // paint it back onto a map with no ride on it. `trailOn` is the same
        // flag `onFix` checks and for the same reason; deliberately NOT a
        // `state === "riding"` check, because BRB leaves the riding state
        // with the ride (and its recording) still going — a seed that lands
        // mid-BRB must still be there when the rider resumes.
        if (!this.trailOn) return;
        this.trail?.prepend(trailCoordsFromBatches(batches));
      })
      .catch((e) => {
        console.error("ride trail: reading already-recorded batches failed", e);
      });
  }

  /** The ride's own last-known GPS fix — the same one `endRide()`'s equity
   *  check and the F3 legacy private-ride summary already read internally.
   *  Exposed (review fix) so Screen 8 (`ride-post-s8.ts`, which deliberately
   *  never imports this module — see its own ARCHITECTURE note) can prefer
   *  the ride's actual last fix over a fresh `Locate.current()` read, which
   *  expires after 5 minutes and may never have been started at all on the
   *  GPS-permission-skip path. `stopSensors()` (called at ride end, before
   *  this would ever be read) only clears the watch/timers — it never
   *  touches `lastFix` — so this stays valid through end-of-ride and the
   *  handoff into Screen 8. Reset to null at the start of every ride (see
   *  `enterRiding`), so a stale fix from a PRIOR ride can never leak into a
   *  new one. */
  getLastFix(): LngLat | null {
    return this.lastFix?.pos ?? null;
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
    const wasRiding = this.state === "riding";
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
    // Crossing into the riding view is the last quiet moment before the deck
    // starts shaking: drop focus and take our one shot at emptying WebKit's
    // undo queue, so an "Undo Typing" alert can't ride along (see
    // ios-shake-undo.ts — the wizard's fields avoid filling it in the first
    // place; this catches anything typed before that guard applied).
    if (riding && !wasRiding) dropNativeUndoHistory();
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
      case "display": {
        const key = btn.dataset.display;
        let on: boolean;
        if (key === "timer") {
          on = this.timerVisible = !this.timerVisible;
        } else if (key === "cost") {
          on = this.costHudVisible = !this.costHudVisible;
        } else if (key === "classic") {
          on = this.speedoClassicVisible = !this.speedoClassicVisible;
        } else if (key === "digital") {
          on = this.speedoDigitalVisible = !this.speedoDigitalVisible;
        } else {
          break;
        }
        btn.classList.toggle("is-on", on);
        btn.setAttribute("aria-pressed", String(on));
        this.syncDisplayVisibility();
        // A cost readout flipped back on mid-ride must show the CURRENT
        // figure, not whatever was last painted into it.
        this.renderTick();
        break;
      }
      case "dev": {
        const model = btn.dataset.model as ModelKey;
        if (this.rideModels.has(model)) this.rideModels.delete(model);
        else this.rideModels.add(model);
        const on = this.rideModels.has(model);
        btn.classList.toggle("is-on", on);
        btn.setAttribute("aria-pressed", String(on));
        // Rover service-area caveat, mirroring the Filters drawer's note:
        // visible whenever the Show selection includes the Rover.
        const note = this.root.querySelector<HTMLElement>("#hud-rover-note");
        if (note) note.hidden = !this.rideModels.has("trike");
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

  /** Chips for the adjust panel's "Display" row: per-readout ON/OFF for the
   *  top-left ride timer, the estimated Veo cost counter, the bottom-right
   *  classic (analog) speedometer, and the top-right digital mph. Timer and
   *  cost toggle independently — showing the clock without a price is a
   *  first-class choice. The cost chip is omitted entirely on an own-device
   *  ride — there is no Veo billing clock to picture, so a toggle for it
   *  would only re-enable a number that means nothing. (The rate-plan
   *  selection the cost estimate prices against is the wrench panel's
   *  existing "Rate" select, directly above this row.) */
  private displayChipsMarkup(): string {
    const chip = (key: string, label: string, on: boolean): string =>
      `<button type="button" class="hud-chip${on ? " is-on" : ""}" data-hud="display" data-display="${key}" aria-pressed="${on}">${label}</button>`;
    const chips: string[] = [chip("timer", "Timer", this.timerVisible)];
    if (!this.ownDeviceRide) {
      chips.push(chip("cost", "Est. cost", this.costHudVisible));
    }
    chips.push(
      chip("classic", "Speedo classic", this.speedoClassicVisible),
      chip("digital", "Speedo digital", this.speedoDigitalVisible),
    );
    return chips.join("");
  }

  /** Push the three display flags into whatever riding DOM is on screen.
   *  Corners are hidden wholesale (the `[hidden]` attribute — style.css's
   *  global `[hidden] { display: none !important }` makes it stick against
   *  `.hud-corner`'s own `display: flex`); the cost readout keeps its
   *  existing per-tick `hidden` re-assertion in `renderTick`. */
  private syncDisplayVisibility(): void {
    const digital = this.root.querySelector<HTMLElement>(".hud-corner--tr");
    if (digital) digital.hidden = !this.speedoDigitalVisible;
    const classic = this.root.querySelector<HTMLElement>(".hud-corner--br");
    if (classic) classic.hidden = !this.speedoClassicVisible;
    // The clock element alone, not the TL corner — the cost readout shares
    // that stack and hides on its own flag.
    const clock = this.root.querySelector<HTMLElement>("#hud-clock");
    if (clock) clock.hidden = !this.timerVisible;
    this.syncCostVisibility();
  }

  /** Chips for the adjust panel's "Show" row, reflecting the current
   *  selection. Deselecting all hides every device from the follow-cam. */
  private deviceChipsMarkup(): string {
    return ALL_MODELS
      .map((m) => {
        const on = this.rideModels.has(m);
        // MODEL_NAMES, never a capitalized key: the raw "trike" key is how
        // Rovers leaked out as "Trike" (model-catalog.ts) — this chip row
        // was the one surface PR 63's sweep missed, disagreeing with the
        // Rover note right beside it.
        const label = MODEL_NAMES[m] ?? m[0].toUpperCase() + m.slice(1);
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
    this.rideGeneration += 1;
    // Save Ride Tracks decides whether this ride gets a line at all; the
    // trail starts empty either way, so a prior ride's breadcrumb can never
    // survive into this one.
    this.trailOn = this.session?.current()?.options.save_tracks ?? true;
    // Per-ride display flags, read off the LIVE doc only (same stale-doc
    // guard as `mountNavHud`: the legacy quick-start path never touches the
    // session, and a prior wizard ride's `done` doc must not leak ITS display
    // preferences into an unrelated ride).
    const docNow = this.session?.current();
    const liveDoc = docNow?.state === "riding" ? docNow : null;
    this.ownDeviceRide =
      liveDoc !== null &&
      (isOwnDevice(liveDoc.device) || liveDoc.options.own_device === true);
    if (liveDoc) {
      // The own-device guard is the fix for the cost counter applying to
      // rides Veo isn't billing: `cost_hud` ON still yields a hidden counter
      // when the rider brought their own wheels.
      this.costHudVisible = liveDoc.options.cost_hud && !this.ownDeviceRide;
      this.speedoClassicVisible = liveDoc.options.speedometer === "classic";
      this.speedoDigitalVisible = liveDoc.options.speedometer !== "none";
    } else {
      // Session-less legacy ride: both speedometers, as always, and the
      // cost flag re-resolved from the last EXPLICIT push (a pre-handoff
      // `setCostHudVisible` call) or the documented always-on default —
      // never left as whatever the previous ride's doc derived, which would
      // leak an own-device force-off (or a wizard opt-out) into an
      // unrelated ride this rider never configured.
      this.costHudVisible = this.costHudPref ?? true;
      this.speedoClassicVisible = true;
      this.speedoDigitalVisible = true;
    }
    this.timerVisible = true;
    this.trail?.reset();
    // A prior ride's planned pathway must never survive into this one —
    // `mountNavHud` (via `renderRiding` below) redraws it from the CURRENT
    // session doc's route, if there is one.
    this.routeLine?.clear();
    this.smoothedMps = 0;
    this.distanceM = 0;
    this.fixCount = 0;
    this.lastFix = null;
    this.startPos = null;
    this.startedInZone = false;
    this.lastBearing = 0;
    this.paused = false;
    this.pausedElapsedMs = 0;
    this.rideModels = new Set(); // every ride starts hiding every scooter
    // Fresh ride: any nav overlay from a PRIOR ride this HUD instance already
    // showed (armed → countdown → riding → summary → hidden → armed again)
    // must not leak into this one — `mountNavHud` (called from `renderRiding`
    // below) rebuilds it from scratch against the CURRENT session doc's route.
    this.navHud?.dispose();
    this.navHud = null;
    this.navHudContainer = null;
    this.navDismissed = false;
    this.setState("riding");
    this.renderRiding();
    this.applyRideModels();
    closeAllPopups();
    this.enterFollowCam();
    // After `enterFollowCam` (which is what makes the trail visible), so a
    // resumed ride's already-recorded line is on screen from the first frame
    // of the riding view rather than appearing a beat later.
    if (opts.recorder) this.seedTrail(opts.recorder);
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
    this.trail?.setVisible(true);
    this.routeLine?.setVisible(true);
  }

  /** Restore the pre-ride 2D view and remove ride-only map decorations. */
  private exitFollowCam(): void {
    if (!this.following) return;
    this.following = false;
    this.userMarker?.remove();
    this.removeBuildings3D();
    // Hidden, not cleared: BRB hands the map back to Analysis / Find wheels
    // with the ride (and a tracked ride's recording) still running, and the
    // rider's breadcrumb has no business drawn across a map they opened for
    // something else. `endRide` is what actually forgets it.
    this.trail?.setVisible(false);
    // Same rule for the planned pathway: hidden through BRB, forgotten only
    // on nav dismiss or ride end.
    this.routeLine?.setVisible(false);
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
        <div id="hud-zone" class="hud-zone-badge" hidden>🏷️ Equity Area · $0.13/min</div>
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
          <p id="hud-rover-note" class="control-hint control-hint--warning"${this.rideModels.has("trike") ? "" : " hidden"}>${ROVER_AREA_WARNING}</p>
          <div class="hud-adjust-row hud-devrow">
            <span class="hud-devrow__label">Display</span>
            ${this.displayChipsMarkup()}
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
    // The innerHTML assignment above just discarded any nav overlay DOM from
    // before this render (fresh ride start, or a BRB resume) — re-mount it.
    const liveEl = this.root.querySelector<HTMLElement>(".hud-live");
    if (liveEl) this.mountNavHud(liveEl);
    // The rebuilt corners come back visible — re-assert the display flags so
    // a BRB resume (or theme flip) keeps whatever the rider toggled off.
    this.syncDisplayVisibility();
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

  /** Screen 7 turn-by-turn overlay (F3's other central integration seam,
   *  alongside `onFix`'s shared watchPosition): mount it into `liveEl` — the
   *  freshly rebuilt `.hud-live` from THIS `renderRiding()` call — whenever
   *  the current ride has an active route to navigate. Called on every
   *  `renderRiding()` (fresh ride start AND every BRB resume, since both
   *  wholesale-replace `this.root.innerHTML`): if a `NavHud` from this same
   *  ride already exists, its container is simply re-parented into the fresh
   *  DOM rather than rebuilt, so a resume never loses matched-route progress
   *  (shape index, current maneuver, off-route timers). A ride with no route
   *  (nav off, out of coverage, or no session wired) never mounts one at all
   *  — `ride-nav-hud.ts`'s own contract: only construct it when a route is
   *  active. */
  private mountNavHud(liveEl: HTMLElement): void {
    if (this.navHud) {
      if (this.navHudContainer) liveEl.appendChild(this.navHudContainer);
      return;
    }
    if (this.navDismissed) return;
    const doc = this.session?.current();
    // `state === "riding"` guards against a STALE doc: the legacy armed →
    // countdown → `startRide()` path (no wizard involved) never touches
    // `rideSession` at all, so without this check a rider who finishes a
    // wizard ride (leaving a `done` doc with THAT ride's route still on it)
    // and later taps the pre-wizard "Start now" button for an unrelated
    // quick ride would incorrectly inherit the old ride's nav directions.
    const route = doc?.state === "riding" ? doc.route : null;
    const dest = doc?.state === "riding" ? doc.dest : null;
    if (!doc || !route || !dest) return;
    // Superimpose the pathway itself on the map, in the chosen profile's
    // Screen 4 color, with the retained destination marked — the picture the
    // maneuver instructions describe. Drawn before the overlay is built so
    // the line is on the map from the same frame the instructions appear.
    const routeColor = colorForProfile(route.profile);
    const destPoint: [number, number] = [dest.lon, dest.lat];
    this.routeLine?.set(decodePolyline(route.polyline), {
      color: routeColor,
      dest: destPoint,
    });
    const overlay = document.createElement("div");
    liveEl.appendChild(overlay);
    this.navHudContainer = overlay;
    this.navHud = createNavHud(overlay, {
      route,
      dest: { lat: dest.lat, lon: dest.lon },
      vehicleModel: selectedDevice(doc.device)?.model ?? null,
      onRouteUpdate: (update) => {
        // An off-route re-route swapped the guidance geometry in place —
        // redraw the drawn pathway to match, same color (a re-route only
        // ever re-requests the originally selected profile).
        this.routeLine?.set(update.coordinates, {
          color: routeColor,
          dest: destPoint,
        });
      },
      onDismiss: () => {
        // Dismissing guidance takes the pathway off the map too — the line
        // is part of the guidance, not part of the base ride view.
        this.routeLine?.clear();
        // Tear-down already happened inside ride-nav-hud.ts itself — just
        // forget our references so a later BRB resume doesn't try to
        // re-parent a container nav-hud has already emptied, and so it stays
        // gone (`navDismissed`) rather than reappearing on the next resume.
        this.navDismissed = true;
        this.navHud = null;
        this.navHudContainer = null;
      },
      onCompress: () => {
        /* No other HUD chrome currently needs to react to the nav panel
         * opening — the corner readouts and the nav bar/panel occupy
         * non-overlapping screen regions by design (frontend plan: the nav
         * bar docks top-center between the TL clock/cost stack and the TR
         * mph readout). Left as an explicit no-op rather than omitted, so a
         * future corner that DOES need to yield space has an obvious place
         * to react from. */
      },
    });
  }

  private renderTick(): void {
    if (this.state !== "riding") return;
    const elapsed = Date.now() - this.startedAt;
    const clockText = formatClock(elapsed);
    const clock = this.root.querySelector("#hud-clock");
    if (clock) clock.textContent = clockText;
    const adjustClock = this.root.querySelector("#hud-adjust-clock");
    if (adjustClock) adjustClock.textContent = clockText;
    const cost = this.root.querySelector<HTMLElement>("#hud-cost");
    const rate = savedRatePlan();
    if (cost) {
      // `hidden` is re-asserted on every tick rather than only at handoff:
      // `renderRiding()` rebuilds this node wholesale (a BRB resume, a theme
      // flip), and a rebuilt node would come back visible with the flag
      // still off.
      cost.hidden = !this.costHudVisible;
      if (rate && this.costHudVisible) {
        cost.textContent = `≈ ${formatCents(rideCostCents(planFor(rate), elapsed))}`;
      }
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
    this.fixCount += 1;

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

    // Shared watchPosition (F3): every fix feeds track-store AND the Screen 7
    // nav overlay, regardless of follow-cam / BRB state — a backgrounded
    // TRACKED ride keeps recording (see `pauseRide`'s tracked branch, which
    // deliberately leaves this watcher running through BRB), and a nav
    // overlay's matched-route progress must keep advancing right along with
    // it. This is the ONE place ride-hud.ts ever calls into either
    // track-store's per-fix API or ride-nav-hud.ts's; nothing here posts to
    // the retired per-waypoint upload endpoint, and neither call touches the
    // network directly (a nav re-route is the sole exception, internal to
    // ride-nav-hud.ts and rate-limited there).
    if (this.trackRecorder) {
      const trackFix: TrackFix = {
        tMs: fix.timestamp,
        lat: fix.coords.latitude,
        lon: fix.coords.longitude,
        accM: fix.coords.accuracy,
      };
      const recorder = this.trackRecorder;
      // The trail extends only on a fix the recorder confirms it SAVED. It
      // rejects a duplicate or back-dated timestamp (the API's strict
      // monotonicity check) and an out-of-range coordinate, and it resolves
      // only after the write actually lands — so drawing on `accepted` is
      // what keeps the line an honest picture of the local track rather than
      // of the raw GPS feed. `Promise.resolve` normalizes the return value,
      // because this recorder is a structural type: a caller's fake need only
      // be call-compatible, and a synchronous stub returning nothing would
      // otherwise make `.then` throw inside the shared watchPosition
      // callback. It does NOT catch a stub that throws synchronously — the
      // call is evaluated first either way — which is the same exposure this
      // line has always had, and which the real `TrackRecorder.addFix` (a
      // promise chain from its first statement) cannot produce.
      void Promise.resolve(recorder.addFix(trackFix)).then(
        (result: TrackAddResult | undefined) => {
          if (!result?.accepted) return;
          // A ride that ended (or stopped tracking) while this write was in
          // flight must not gain one last breadcrumb afterwards.
          if (recorder !== this.trackRecorder || !this.trailOn) return;
          this.trail?.push([fix.coords.longitude, fix.coords.latitude]);
        },
        (e: unknown) => {
          // The fix was not saved, so there is nothing to draw. Logged rather
          // than swallowed: this is the local-storage failure the fallback
          // warning exists for.
          console.error("ride trail: recording a waypoint failed", e);
        },
      );
    }
    this.navHud?.feedFix(fix.coords.latitude, fix.coords.longitude, fix.coords.accuracy);

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
    this.stopSensors();
    this.exitFollowCam();
    // The ride is over, so the live trail is too — unlike BRB, which only
    // hides it. The track itself is untouched in IndexedDB: the account
    // drawer's Local Data tab (`track-route.ts`) is where a FINISHED ride is
    // looked at, with its own layers and its own fit-to-the-whole-path
    // framing. `trailOn` goes down FIRST, so a write that was still in flight
    // when the rider tapped End Ride can't land one last breadcrumb on a map
    // that has already been wiped (see `onFix`'s guard).
    this.trailOn = false;
    this.trail?.clear();
    this.routeLine?.clear();
    this.navHud?.dispose();
    this.navHud = null;
    this.navHudContainer = null;

    // F4: `ride-post.ts` (Screens 8-10, wired from main.ts alongside this
    // HUD) now owns the whole post-ride funnel for a TRACKED ride — the
    // legacy client-only summary below is retired for that case (frontend
    // plan's ride-hud.ts module-map row: "the summary state is replaced by a
    // handoff to ride-post.ts ... for tracked rides only"). Per the state
    // machine's END-REPORT INVARIANT (ride-session.ts's header comment) the
    // ride's single `PATCH /end` fires from SCREEN 8's own buttons, never on
    // merely entering `ending(8)` — so this handler's only remaining job on
    // a tracked ride is to seal the local chain's final batch and hand the
    // session off; see `handOffTrackedRideEnd` for why it must not call
    // `endTrackedRide` itself anymore (that was the F3 interim's job,
    // retired now that Screen 8 exists to do it with the rider-entered
    // battery/cost/§10 fields) and must not render the card below.
    if (this.trackedRideId !== null) {
      await this.handOffTrackedRideEnd();
      return;
    }

    // Private/guest ride: unchanged from F3. There is no `PATCH /end` to
    // send at all (master Part 0 gates Screen 8 on "a Veo device was
    // selected, i.e. not a private ride") — but the session doc still has to
    // close out to `done`, or it is left stranded on `riding` forever:
    // `reduceRideSession`'s `open` guard rejects starting a NEW ride while
    // any doc reads `isRideLive`, and `isLiveRideEntry` would keep routing
    // the next 🧭 tap back into `rideHud.open()`'s legacy armed screen
    // instead of the wizard. The legacy client-only summary card below is
    // this branch's PERMANENT experience, not an interim one (the module
    // map: "private/guest rides keep the legacy client-only summary
    // permanently").
    const elapsed = Date.now() - this.startedAt;
    const endPos = this.lastFix?.pos ?? null;
    void this.endPrivateRide();

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

    const miles = this.distanceM / 1609.344;

    // Own-device ride: no Veo bill, no comparator, no Veo-specific equity
    // discount — none of the money copy describes a transaction that
    // happened. The summary is exactly three facts about the ride itself:
    // time, distance, and the waypoints this device saw.
    if (this.ownDeviceRide) {
      const rows = [
        row("Duration", formatClock(elapsed)),
        row("Distance", `${miles.toFixed(1)} mi`),
        row("Waypoints", String(this.fixCount)),
      ];
      this.setState("summary");
      this.root.innerHTML = `
      <div class="hud-card">
        <h2 class="hud-title">Ride summary</h2>
        <dl class="hud-summary">${rows.join("")}</dl>
        <p class="hud-note">Estimates from this device's clock and GPS.</p>
        <button type="button" class="hud-btn hud-btn--primary" data-hud="done">Done</button>
      </div>`;
      return;
    }

    const rate = savedRatePlan();
    const plan = planFor(rate ?? "resident");
    const veoCents = rideCostCents(plan, elapsed);
    // The comparator is pass-based now: the realistic alternative to Veo's
    // metered bill is buying a block of Lime minutes up front (unlocks
    // included), so that's what the ride is priced against — the smallest
    // pass on the published ladder that covers it (stacked for 2h+ rides;
    // see comparatorPassQuote for why it's the ladder, not a min-cost mix).
    const passQuote = comparatorPassQuote(elapsed);
    const deltaCents = veoCents - passQuote.cents;
    const zoneRide = this.startedInZone || endedInZone;

    // A ride that touched an Equity Area should be billed at the contract's
    // own rate ($1 + 13¢/min, Exhibit C), whatever tier the rider is on.
    // That number is the entire point of the flag: "you may be owed a
    // discount" is a thing to shrug at, "you should have been charged $2.30"
    // is a thing to go and check.
    const equityAreaCents = zoneRide ? equityAreaCostCents(elapsed) : null;

    const rows: string[] = [
      row("Duration", formatClock(elapsed)),
      row("Distance", `${miles.toFixed(1)} mi`),
      row(
        `Est. Veo cost (${plan.key.replace("_plus", ", VeoPlus")})`,
        formatCents(veoCents),
      ),
    ];
    if (equityAreaCents !== null) {
      rows.push(
        row("Should be (Equity Area rate)", formatCents(equityAreaCents)),
      );
    }
    rows.push(row(`With a ${COMPARATOR.name} pass`, formatCents(passQuote.cents)));

    const veoPlusLine = plan.veoPlus
      ? `<p class="hud-note">VeoPlus Pass applied — unlock fee waived.</p>`
      : "";

    const passDesc =
      passQuote.passCount === 1
        ? `a ${formatCents(passQuote.cents)} ${COMPARATOR.name} pass (${passQuote.minutes} min, free unlock)`
        : `${formatCents(passQuote.cents)} in ${COMPARATOR.name} passes (${passQuote.minutes} min total, free unlocks)`;
    // The pass covers whole blocks of minutes, so a ride rarely uses it all —
    // say what's left, because that remainder is more rides for the same
    // money and is half the point of comparing against a pass.
    const leftoverMin = passQuote.minutes - billableMinutes(elapsed);
    const leftoverClause =
      leftoverMin > 0
        ? `, and you'd have ${leftoverMin} minute${leftoverMin === 1 ? "" : "s"} left to use`
        : "";
    const monopolyLine =
      deltaCents > 0
        ? `<p class="hud-note hud-note--pointed">You paid ≈ ${formatCents(deltaCents)} more because Denver has one operator —
           ${passDesc} would have covered this ride${leftoverClause}.</p>`
        : "";

    // The exact contract terms, not a paraphrase: this is the sentence a
    // rider may end up quoting at Veo support, and the screenshot ask is
    // the part that makes the difference provable later.
    // Only claim an overcharge when the plan rate actually exceeds the area
    // rate. An Access-tier rider inside their 60 free minutes already pays
    // less than $1 + 13¢/min, and telling them they were overcharged would
    // send them to support with a complaint that is not true.
    const owedCents =
      equityAreaCents !== null ? veoCents - equityAreaCents : 0;
    const owedClause =
      owedCents > 0
        ? ` At your usual rate this ride would be ${formatCents(veoCents)}, so the discount is worth about ${formatCents(owedCents)} here.`
        : "";
    const zoneLine = zoneRide
      ? `<p class="hud-zone">🏷️ This ride ${this.startedInZone ? "started" : "ended"} in an Equity Area.
         ${EQUITY_DISCOUNT_NOTICE} That rate carries a $1 unlock, so expect
         about ${formatCents(equityAreaCents ?? 0)} for ${billableMinutes(elapsed)} min.${owedClause}
         Open the Veo app → History to check.</p>`
      : "";

    this.setState("summary");
    this.root.innerHTML = `
      <div class="hud-card">
        <h2 class="hud-title">Ride summary</h2>
        <dl class="hud-summary">${rows.join("")}</dl>
        ${veoPlusLine}
        ${zoneLine}
        ${monopolyLine}
        <p class="hud-note">Estimates from this device's clock and GPS — your Veo receipt is the bill.
          ${COMPARATOR.name} pass pricing includes unlocks (no $1 unlock charge).</p>
        <button type="button" class="hud-btn hud-btn--primary" data-hud="done">Done</button>
      </div>`;
  }

  /** F4 hand-off (frontend plan, ride-hud.ts module-map row): seal the final
   *  local batch and close the HUD's own view — no `PATCH /end` here (that
   *  invariant belongs to Screen 8's own buttons now, per
   *  ride-session.ts's END-REPORT INVARIANT header comment) and no legacy
   *  summary DOM. `ride-post-s8.ts`'s `wireRideScreen8` is subscribed to the
   *  shared session store (`main.ts` wires it once, at boot, well before a
   *  rider could organically reach End Ride) and mounts its own full-screen
   *  `.ride-post-modal` overlay reactively the instant the `endRide` dispatch
   *  below lands the doc on `ending(8)` — dispatching BEFORE hiding this view
   *  means Screen 8 is already in the DOM by the time the HUD's own view
   *  disappears, so there is never a blank frame and never a double-render of
   *  two competing post-ride surfaces (the risk this flow's `legacyEndRide`
   *  interim guarded against — see `main.ts`'s ride-session store comment).
   *  Best-effort on the seal: a failure there must not strand the rider with
   *  neither the HUD nor Screen 8 on screen — the doc still transitions and
   *  Screen 10's waypoint gate simply sees fewer (or zero) waypoints. */
  private async handOffTrackedRideEnd(): Promise<void> {
    const recorder = this.trackRecorder;
    this.trackRecorder = null; // stop feeding fixes into a ride that is over
    try {
      await recorder?.finish();
    } catch (e) {
      console.error("end ride: sealing the final track batch failed", e);
    }
    this.exitImmersive();
    this.restoreTheme();
    this.session?.dispatch({ type: "endRide" });
    this.setState("hidden");
  }

  /** Close out a private/guest ride (or a legacy, session-free quick-start
   *  ride) from `endRide`: seal whatever local recording exists and
   *  dispatch the session doc straight to `done`. There is no `PATCH /end`
   *  to send for a private ride (see `endRide`'s comment), so — unlike
   *  `handOffTrackedRideEnd` — nothing here needs to wait on the network;
   *  this stays `async`/fire-and-forget only because `recorder.finish()`
   *  itself is. A no-op `dispatch` when there is no live doc at all (the
   *  legacy armed→countdown→`startRide()` path never touches
   *  `ride-session.ts`) — `reduceRideSession`'s own "no session"/"nothing
   *  to end" guards reject it harmlessly. */
  private async endPrivateRide(): Promise<void> {
    const recorder = this.trackRecorder;
    this.trackRecorder = null; // stop feeding fixes into a ride that is over
    try {
      await recorder?.finish();
    } catch (e) {
      console.error("end ride: sealing the final track batch failed", e);
    }
    this.session?.dispatch({ type: "endRide" });
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
