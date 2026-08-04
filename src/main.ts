import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import {
  fetchDevicesAuto,
  getActiveRide,
  getTrackedRide,
  type BoundaryLayer,
  type DeviceInclude,
} from "./api.ts";
import { createMap } from "./map.ts";
import { initialTheme, startSunSync, ThemeControl } from "./theme.ts";
import {
  Devices,
  DEVICE_INTERACTIVE_LAYERS,
  ALL_RIDE_TYPES,
  ALL_MODELS,
  gaugeColor,
  iconPreviewURL,
  whenModelIconsReady,
  hideMapTooltip,
  type RideType,
  type ModelKey,
  modelKeyOf,
  type QualityFilter,
  type IconStyle,
  type ModelIcon,
  type DataSource,
  type GaugeDisplay,
  type GaugeThickness,
  type GaugePlacement,
} from "./devices.ts";
import { RecommendedDevices } from "./recommend.ts";
import { Overlays } from "./overlays.ts";
import { renderCompliance } from "./compliance.ts";
import { Freshness } from "./freshness.ts";
import { Clusters } from "./clusters.ts";
import {
  AreaFilter,
  type AreaFilterElements,
  type AreaFilterState,
} from "./area-filter.ts";
import { FilterChips, type Chip } from "./filter-chips.ts";
import { Locate } from "./locate.ts";
import { RideHud, isLiveRideEntry, type RideHudTrackControl } from "./ride-hud.ts";
import { RideWizard } from "./ride-wizard.ts";
import { EquityRanks } from "./equity.ts";
import { HexDensity, type HexSize, type HexMetric } from "./hexdensity.ts";
import { consumePendingMagicLink } from "./auth-magic-link.ts";
import { promptGoogleOneTap } from "./auth-google.ts";
import { loadAuthConfig, type AuthConfig } from "./auth-config.ts";
import { refreshSessionIfStale } from "./auth-session.ts";
import { openRideModal, wireRideModal } from "./ride-modal.ts";
import { wireRideDeepLink } from "./ride-deeplink.ts";
import {
  createRideSessionStore,
  recoverRideSession,
  recoveryForServerConflict,
  type RideRecoveryDeps,
  type RideRecoveryNote,
  type RideRecoveryOutcome,
  type RideSessionStore,
} from "./ride-session.ts";
import { showResumeOrEnd } from "./ride-resume-prompt.ts";
import { openTrackStore, type TrackStore } from "./track-store.ts";
import { wireRideScreenAuth } from "./ride-screen-auth.ts";
import {
  wireRideScreenSelect,
  type RideOptionsPanelBuilder,
} from "./ride-screen-select.ts";
import { wireRideScreenDest } from "./ride-screen-dest.ts";
import { wireRideScreenRoutes } from "./ride-screen-routes.ts";
import { wireRideScreenStart } from "./ride-screen-start.ts";
import { wireRidePost } from "./ride-post.ts";
import {
  renderRideOptionsPanel,
  applyCascades,
  defaultRideOptionsFor,
  loadRideModePoints,
  type ResolvedRideModePoints,
} from "./ride-settings.ts";
import { renderSignedInAccount, type AccountHandle } from "./account.ts";
import { buildLoginPanel, type LoginPanelHandle } from "./account-login.ts";
import { createMapPick } from "./map-pick.ts";
import { createTrackRoute } from "./track-route.ts";
import {
  buildLocalDataPanel,
  type LocalDataHandle,
} from "./account-local-data.ts";
import { createHomeWorkPins } from "./home-work-pins.ts";
import {
  ACCOUNT_TAB_IDS,
  createAccountTabs,
  takeTabHint,
  writeTabHint,
  type AccountTabId,
} from "./account-tabs.ts";
import { type EquityRank } from "./config.ts";
import { indexFeature, type IndexedFeature } from "./geo.ts";
import { OVERLAY_BY_LAYER, OVERLAYS, REFRESH_MS } from "./config.ts";
import { getAuth, isAuthenticated } from "./map-auth.js";
import { initInstallPrompt } from "./install-prompt.ts";
import {
  initChrome,
  setRibbonOpen,
  closeAllPopups,
  registerPopupCloser,
} from "./chrome.ts";
import { wireFilterPresets, type FilterSnapshot } from "./filter-presets.ts";
import {
  wireLeaderboard,
  createLayerPause,
  type LayerPause,
} from "./leaderboard.ts";

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

/** Local ride tracks are recorded without an account (a private ride has no
 *  server ride id at all), so gating the tab on sign-in also hides a guest's
 *  own recordings from them — including the only control that deletes one.
 *  Kept as specified, isolated here so it is a one-line reversal. */
const GATE_LOCAL_TAB_ON_AUTH = true;

const theme0 = initialTheme();
document.documentElement.dataset.theme = theme0;
const { map, geolocate } = createMap("map", theme0);
// Added AFTER createMap (which registers geolocate in top-left) so the
// theme toggle sits directly right of the location control once chrome.ts
// adopts the corner into the top bar.
map.addControl(new ThemeControl(theme0), "top-left");
initChrome();
if (import.meta.env.DEV) (window as unknown as { __map: unknown }).__map = map;
const locate = new Locate(map, geolocate);
const devices = new Devices(map, locate);
// Profile location picking. The drawer gets these as callbacks so account.ts
// never imports maplibre — and so its tests never need a map.
const homeWorkPins = createHomeWorkPins(map);
const trackRoute = createTrackRoute(map);
const mapPick = createMapPick(map, {
  onModeChange: (active) => {
    // Slide the drawer out of the way (it covers the map on a phone) and
    // stop device taps from opening a popup over the chosen point.
    document.body.classList.toggle("is-map-picking", active);
    devices.setPickActive(active);
  },
});
// The single ride-mode session doc every Screen 1–6 module (ride-screen-*.ts)
// reads and writes through — created once here, never inside a screen module,
// so the wizard has exactly one session, not one per screen. Persists to
// localStorage on every transition (ride-session.ts's own concern); recovery
// on load (crash/reload/409) is F3's seat, not wired here.
// `legacyEndRide: false` (F4): `endRide` (the LIVE "rider taps End Ride
// mid-ride" action) now lands a tracked ride on `ending(8)` like every other
// path into it, instead of skipping straight to `done`. This was the F3
// interim's job while there was no Screen 8 to hand off to — the legacy HUD
// summary owned the minimal `PATCH /end` itself back then (ride-hud.ts's
// now-retired `reportTrackedRideEnd`). F4 landed Screen 8 as a real module
// (`ride-post.ts`, wired below), and ride-hud.ts's `endRide()` now branches
// on a tracked ride to `handOffTrackedRideEnd()` — sealing the final local
// batch and dispatching `{type:"endRide"}` WITHOUT sending any `PATCH /end`
// itself (that invariant belongs to Screen 8's own buttons now — see
// ride-session.ts's END-REPORT INVARIANT header comment) and WITHOUT
// rendering the legacy "summary" DOM, which is what makes flipping this flag
// safe: there is no longer a competing legacy render for `wireRideScreen8`'s
// reactive mount to double up against. Private/guest rides are untouched —
// `reduceRideSession`'s `endRide` case already sends them straight to `done`
// regardless of this flag (master Part 0 gates Screen 8 on "a Veo device was
// selected, i.e. not a private ride"), and ride-hud.ts keeps their legacy
// client-only summary permanently.
const rideSession: RideSessionStore = createRideSessionStore({
  legacyEndRide: false,
});
const overlays = new Overlays(map, need("choropleth-legend"));
const equity = new EquityRanks(overlays, () => renderEquityMetric());
const hexDensity = new HexDensity(map, need("hexbin-legend"));
// Hex density and the region choropleth both shade the map by count, so only
// one runs at a time — turning one on clears the other. Assigned by their
// wire functions.
let clearChoropleth: () => void = () => {};
let clearHexDensity: () => void = () => {};
// 🏆 Leaderboard pause controllers for hex density / the region choropleth
// (frontend plan's Leaderboard section). Placeholder no-ops until
// wireHexDensity()/wireChoropleth() run and replace them with the
// real-backed controllers — same bootstrapping shape as clearHexDensity/
// clearChoropleth above.
let hexDensityPause: LayerPause<HexSize | null> = createLayerPause(
  { getActive: () => null, apply: () => {} },
  null,
);
let choroplethPause: LayerPause<BoundaryLayer | null> = createLayerPause(
  { getActive: () => null, apply: () => {} },
  null,
);
const freshness = new Freshness(
  need("freshness"),
  need("freshness-text"),
  need("freshness-count"),
  need("freshness-map"),
);

/** Filtered devices inside the current viewport, for the pill's Map line. */
function countDevicesInViewport(): number {
  const bounds = map.getBounds();
  let n = 0;
  for (const f of devices.visibleFeatures()) {
    const [lng, lat] = f.geometry.coordinates;
    if (bounds.contains([lng, lat])) n++;
  }
  return n;
}
const clusters = new Clusters(
  map,
  need("cluster-list"),
  need<HTMLInputElement>("cluster-min"),
  need<HTMLButtonElement>("cluster-find"),
  need<HTMLSelectElement>("cluster-region-layer"),
  overlays,
);
// Mode switches sweep every open floating surface (closeAllPopups).
registerPopupCloser(() => devices.closePopup());
registerPopupCloser(() => clusters.closePopup());
registerPopupCloser(hideMapTooltip);

// Populated by buildLayerToggles so AreaFilter can programmatically check
// the matching overlay box when the user picks a category.
const layerInputs = new Map<BoundaryLayer, HTMLInputElement>();

// ---------- Active-filter chips ----------
// One chip per live constraint, floating over the map so closed drawers
// never hide state. The wire* functions below stash just enough of their
// internal state here for refreshChips() to read, and each chip's ✕
// resets the originating control through its normal event path so the
// drawer UI stays in sync.
const chips = new FilterChips(need("filter-chips"));
let rideTypesOn: ReadonlySet<RideType> = new Set(ALL_RIDE_TYPES);
let modelsOn: ReadonlySet<ModelKey> = new Set(ALL_MODELS);
let minBatteryPct = 0;
let qualityOn: QualityFilter = "any";
let lastAreaState: AreaFilterState | null = null;
// Chip-clear + preset hooks, assigned by their wire* functions.
let clearRideTypeFilter: () => void = () => {};
let clearModelFilter: () => void = () => {};
let clearBatteryMin: () => void = () => {};
let clearQualityFilter: () => void = () => {};
let setQualityFilter: (value: QualityFilter) => void = () => {};
let resetAllFilters: () => void = () => {};
let resetIconography: () => void = () => {};
// Ride mode fetches the lean payload (the API's low-end-phone diet); the
// analysis surface needs the h3 + rank extras. Assigned by wireModes /
// startRefreshLoop.
let leanFetch = false;
let requestRefresh: () => void = () => {};

function fetchIncludes(): DeviceInclude[] {
  return leanFetch ? [] : ["h3", "ranks"];
}

const RIDE_TYPE_CHIP_LABEL: Record<RideType, string> = {
  standing: "🛴 Standing only",
  sitting: "🚲 Seated only",
};

const QUALITY_CHIP_LABEL: Partial<Record<QualityFilter, string>> = {
  "no-risk": "Hiding high-risk",
  "ok-only": "✓ Reliable only",
};

/** One entry per live constraint — the chip label plus its clear hook.
 *  Three consumers, one label source: the floating chips, the preset name
 *  suggestion, and the wizard's carried-filters summary. */
function activeFilterChips(): Chip[] {
  const active: Chip[] = [];

  if (rideTypesOn.size < ALL_RIDE_TYPES.length) {
    const only = [...rideTypesOn][0];
    active.push({
      id: "ride-type",
      label: only ? RIDE_TYPE_CHIP_LABEL[only] : "🚫 No ride types",
      onClear: clearRideTypeFilter,
    });
  }

  if (modelsOn.size < ALL_MODELS.length) {
    const names = [...modelsOn].map(
      (m) => m[0].toUpperCase() + m.slice(1),
    );
    active.push({
      id: "models",
      label: names.length ? `Models: ${names.join(", ")}` : "🚫 No models",
      onClear: clearModelFilter,
    });
  }

  const hideCb = need<HTMLInputElement>("hide-unavailable");
  if (hideCb.checked) {
    active.push({
      id: "availability",
      label: "Hiding unavailable",
      onClear: () => {
        hideCb.checked = false;
        hideCb.dispatchEvent(new Event("change"));
      },
    });
  }

  if (minBatteryPct > 0) {
    active.push({
      id: "battery",
      label: `🔋 ≥ ${minBatteryPct}%`,
      onClear: clearBatteryMin,
    });
  }

  const qualityLabel = QUALITY_CHIP_LABEL[qualityOn];
  if (qualityLabel) {
    active.push({
      id: "quality",
      label: qualityLabel,
      onClear: clearQualityFilter,
    });
  }

  const display = lastAreaState?.display;
  if (lastAreaState?.polygons && display) {
    const layerLabel = OVERLAY_BY_LAYER[display.layer].label;
    active.push({
      id: "area",
      label: display.subset
        ? `📍 ${display.subset.length} × ${layerLabel}`
        : `📍 ${layerLabel}`,
      onClear: () => {
        const enable = need<HTMLInputElement>("area-filter-enable");
        enable.checked = false;
        enable.dispatchEvent(new Event("change"));
      },
    });
  }

  return active;
}

function refreshChips(): void {
  chips.render(activeFilterChips());
}

/** Human one-liner of the live filters, emoji stripped — "Standing only ·
 *  ≥ 50% · Reliable only". Empty string when nothing is filtered. */
function filterSummary(): string {
  return activeFilterChips()
    .map((c) =>
      c.label
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" · ");
}

// Kick off network-independent work immediately so dots/compliance arrive fast.
// Analysis is the default surface, so the first fetch carries the full
// include set (h3 for hex density, ranks for the Battery Rankings modal).
const devicesPromise = fetchDevicesAuto(undefined, fetchIncludes()).catch((e) => {
  console.error("initial device fetch failed", e);
  return null;
});
void renderCompliance(need("compliance")).catch((e) => {
  console.error("compliance render failed", e);
});
wireAccount();
const rideHud = wireRideHud();
startSunSync();
wireFreshnessCollapse();
initInstallPrompt();

// If the user just followed a magic link (?ml=<token>), redeem it before the
// account UI settles; on success reload so every fetch goes out authenticated.
// Inert when no token is present, so it's harmless before the endpoints exist.
//
// The promise is KEPT (rather than `void`ed) because `?ride=` must be consumed
// AFTER `?ml=`: on success the reload re-enters authenticated with the deep link
// still in the URL, so wireRideDeepLink (down in the map-load block) stands down
// until this settles — resolving `true` means "a reload is coming, leave the URL
// alone", `false` means "the deep link is yours".
//
// With no link to redeem, this is also where the silent session refresh runs
// (ride-mode F1): rider sessions are 30-day sliding, so a token older than a
// day gets rotated once per load. Every guard lives inside auth-session.ts —
// stale-only, one attempt per load, compare-and-set on the write, and a 401 that
// clears nothing another tab has since rotated — so this stays a fire-and-forget
// line. Sequenced AFTER the redemption decision on purpose: a freshly minted
// magic-link session must never race a rotation of the token it replaces.
const magicLinkSettled: Promise<boolean> = consumePendingMagicLink().then(
  (ok) => {
    if (ok) location.reload();
    else void refreshSessionIfStale();
    return ok;
  },
);

// Google One Tap: for signed-out visitors, auto-prompt the top-right One Tap
// dialog on load — but only if the backend's /auth/config says Google is
// enabled (the single source of truth) and hands back a client id. GIS
// manages its own cooldown so this isn't nagging. Signed-in users are skipped.
if (!isAuthenticated()) {
  void loadAuthConfig().then((cfg) => {
    if (cfg.googleEnabled && cfg.googleClientId && !isAuthenticated()) {
      void promptGoogleOneTap(cfg.googleClientId, {
        onSignedIn: () => location.reload(),
      });
    }
  });
}

// ---------- Ride HUD ----------

// The v1∪v2 disadvantaged-area polygons power the HUD's equity-ride flags.
// Fetched lazily on first ride and cached (loadBoundary caches too).
let equityZonesCache: Promise<IndexedFeature[]> | null = null;
function equityZones(): Promise<IndexedFeature[]> {
  equityZonesCache ??= Promise.all([
    overlays.loadBoundary("v1"),
    overlays.loadBoundary("v2"),
  ]).then((responses) =>
    responses.flatMap((r) => r.features.map((f) => indexFeature(f))),
  );
  return equityZonesCache;
}

// The 🧭 Ride button (data-mode="riding") is bound in wireModes() alongside
// the other two modes — a separate binding here would double-fire once the
// mode-bar query matches it.
function wireRideHud(): RideHud {
  return new RideHud(need("ride-hud"), equityZones, map, devices, {
    session: rideSession,
  });
}

// ---------- F3: local track-store (lazy singleton) ----------

// One IndexedDB (or in-memory fallback) connection for the whole app —
// opened lazily on first need (a ride's start, or a reload's recovery) so a
// plain map visitor who never rides never touches IndexedDB at all. Shared by
// `recoverActiveRide` and Screen 6's `onRideStarted` hook below.
let trackStorePromise: Promise<TrackStore> | null = null;
function getTrackStore(): Promise<TrackStore> {
  trackStorePromise ??= openTrackStore();
  return trackStorePromise;
}

// ---------- F3: reload / 409 recovery ----------

/** Reconcile the persisted ride-session doc against the server and local
 *  track-store BEFORE the rider does anything — `wireRideModal`'s `onWired`
 *  hook, per its own doc comment. This is the phase's other central
 *  integration seam (alongside the shared watchPosition callback): it is
 *  what makes "reload mid-ride restores HUD + tracking within ~3 s" actually
 *  true instead of just a paused-BRB resume.
 *
 *  Scope: `restore_riding` (a plain reload mid-ride) and `seal_and_end` (the
 *  watch expired before an explicit end) are acted on automatically — both
 *  are unambiguous, no rider decision needed. `prompt_resume_or_end` (a
 *  genuine doc/server conflict) is left alone entirely: it needs a rider
 *  choice this phase has no Screen-8-adjacent UI to collect yet (F4's
 *  territory), so silently picking a side would be worse than doing nothing.
 *  Every other outcome (`reopen_wizard`, `restore_wizard`, `restore_screen`,
 *  `local_end`, `none`) still gets its recovered doc persisted, so storage
 *  stays consistent with what the recovery table decided, but drives no
 *  further UI — F4 territory.
 *
 *  Returns the outcome's `note` (F4): `seal_and_end` can land the recovered
 *  doc straight on `ending(8)` with `note: "ride_expired"` (the watch elapsed
 *  before the rider tapped End Ride) — Screen 8 shows that as a "your ride
 *  expired" banner, but only if it learns about it. `ride-post.ts`'s
 *  `wireRidePost` reads `recoveryNote` once at wire time (recovery is a
 *  once-per-page-load reconciliation), so the call site below wires it only
 *  after this promise settles — see that call site's own comment. */
/** Shared by both recovery triggers (see the module comment above
 *  `recoverActiveRide` for why one function serves boot recovery AND
 *  Screen 6's 409): the pieces `recoverRideSession`/`recoveryForServerConflict`
 *  need to reconcile against the server and local track-store, minus the
 *  per-call `doc`/`probeWhenNoDoc` fields each caller supplies itself. */
function baseRecoveryDeps(): Omit<RideRecoveryDeps, "doc" | "probeWhenNoDoc"> {
  return {
    getActiveRide: () => getActiveRide(),
    getTrackedRide: (rideId) => getTrackedRide(rideId),
    // Lazy on purpose: `readTrackTip` is only ever CALLED when there is a
    // live/private ride (or a server conflict) to reconcile — a plain
    // visitor never triggers this, so `getTrackStore()`'s `openTrackStore()`
    // call — and therefore IndexedDB — stays untouched for them, matching
    // this module's own "opened lazily on first need" comment above.
    readTrackTip: async (trackId) => (await getTrackStore()).readTip(trackId),
    isAuthenticated: () => isAuthenticated(),
  };
}

/** Push the live session doc's `RideOptions.cost_hud` into the HUD.
 *
 *  Called immediately before EVERY `beginHandoff` — the wizard's Screen 6
 *  hand-off, a reload's `restore_riding`, and a resume-or-end resume — so
 *  the preference survives every route into the riding view rather than only
 *  the one a rider happened to be tested on. With no doc (nothing to read a
 *  preference from) it leaves the HUD's default alone rather than guessing.
 *
 *  Runs before the handoff so the first paint already agrees: the device
 *  card's pre-ride survey promises ride mode "starts without visible HUD
 *  cost", and a readout that flashes up for one frame is not that. */
function applyCostHudPreference(): void {
  const doc = rideSession.current();
  if (doc) rideHud.setCostHudVisible(doc.options.cost_hud);
}

/** Turn a `prompt_resume_or_end` outcome into the rider's actual choice
 *  (review fix — this used to be silently dropped). Shared by both triggers:
 *  a reload finding a server ride the local doc didn't expect, and Screen
 *  6's `POST /tracked-rides` 409 (see `wireRideScreenStart`'s
 *  `onServerConflict` hook below). */
function presentResumeOrEnd(outcome: RideRecoveryOutcome): void {
  showResumeOrEnd(outcome, {
    session: rideSession,
    locate,
    getTrackStore,
    onResumed: (ride, startedAtMs, recorder) => {
      // Same `cost_hud` application as the Screen 6 handoff below: a rider
      // who turned the readout off before the ride must not get it back
      // just because they reloaded or resumed from another tab.
      applyCostHudPreference();
      rideHud.beginHandoff({ rideId: ride.id, startedAtMs, recorder });
    },
  });
}

async function recoverActiveRide(): Promise<RideRecoveryNote | null> {
  let outcome: Awaited<ReturnType<typeof recoverRideSession>>;
  try {
    outcome = await recoverRideSession({
      doc: rideSession.current(),
      ...baseRecoveryDeps(),
      // Discover a server-active ride even when THIS device's local doc is
      // missing/idle/done — the 409 UX reached via a plain reload (review
      // fix: previously unset, so that case wasn't discovered until the
      // rider's next failed start).
      probeWhenNoDoc: true,
    });
  } catch (e) {
    console.error("ride recovery failed", e);
    return null;
  }

  if (outcome.action === "prompt_resume_or_end") {
    presentResumeOrEnd(outcome);
    return outcome.note;
  }
  if (outcome.doc) rideSession.replace(outcome.doc);
  if (outcome.action !== "restore_riding" && outcome.action !== "seal_and_end") {
    return outcome.note;
  }

  let recorder: RideHudTrackControl | null = null;
  if (outcome.resume) {
    try {
      const trackStore = await getTrackStore();
      const resumed = await trackStore.resumeRide(outcome.resume.trackId, {
        signing: outcome.resume.signing,
        isPrivate: outcome.doc?.private ?? false,
      });
      recorder = resumed.recorder;
      // `seal_and_end`'s own promise (ride-session.ts's recovery-table
      // comment on this branch): seal whatever survived right now, rather
      // than leaving the chain open indefinitely with no Screen 8 yet to
      // trigger a seal on the rider's behalf.
      if (outcome.action === "seal_and_end") await recorder.finish();
    } catch (e) {
      console.error("ride recovery: resuming the local track recorder failed", e);
    }
  }
  if (outcome.action === "restore_riding" && outcome.doc) {
    applyCostHudPreference();
    rideHud.beginHandoff({
      rideId: outcome.doc.rideId,
      startedAtMs: outcome.doc.startedAtMs ?? Date.now(),
      recorder,
    });
  }
  return outcome.note;
}

// ---------- Ride mode wizard (Screens 1–6) ----------

// Resolved 🏆 point values for ride-settings.ts's three trophy-row ℹ modals.
// Kicked off once, lazily, the first time the wizard is actually wired (see
// `warmRideModePoints()` below) rather than unconditionally at boot — the
// `scooter-fyi-ride-modal` dev flag gates the whole feature, so a plain map
// visitor should never trigger this fetch. loadRideModePoints() never
// throws — offline / pre-A1 it resolves to the same baked-in fallback
// renderRideOptionsPanel already defaults to, so `rideModePoints` staying
// `undefined` until this settles is harmless.
let rideModePoints: ResolvedRideModePoints | undefined;
function warmRideModePoints(): void {
  void loadRideModePoints().then((points) => {
    rideModePoints = points;
  });
}

/** Bridges ride-settings.ts's `renderRideOptionsPanel` (Screen 2's "Ride Mode
 *  Options" content) into ride-screen-select.ts's `RideOptionsPanelBuilder`
 *  seam for Screen 2's secondary pane — the two lanes' own interface
 *  contracts, glued here since only the integrator can see both. */
const buildRideOptionsPanel: RideOptionsPanelBuilder = (container, hooks) => {
  const doc = rideSession.current();
  const context = {
    private: doc?.private ?? false,
    authenticated: isAuthenticated(),
  };
  const options = doc?.options ?? defaultRideOptionsFor(context);
  const panel = renderRideOptionsPanel({
    options,
    context,
    onChange: (next) => {
      rideSession.dispatch({ type: "setOptions", options: next });
    },
    onOpenUsuals: hooks.onUsuals,
    usualsAvailable: hooks.hasUsuals,
    points: rideModePoints,
  });
  container.append(panel.element);

  // `renderRideOptionsPanel` deliberately never renders [NEXT >>] — that
  // button belongs to ride-screen-select.ts / this integrator seam (see
  // both modules' own module-boundary comments), not to the options-panel
  // lane. The panel's own `.ride-settings__actions` row already holds
  // [Usuals] (hidden when unavailable) right-aligned — append NEXT into
  // THAT same row (rather than a second wrapping div) so the two buttons
  // share one row exactly like `buildFallbackOptionsPanel`'s reference
  // shape, instead of rendering as two separately-aligned rows whenever
  // Usuals happens to be visible. Falls back to a standalone row in the
  // (should-never-happen) case that row isn't found, so NEXT is never
  // silently dropped if ride-settings.ts's internal markup changes later.
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "login-btn";
  nextBtn.textContent = "NEXT >>";
  nextBtn.disabled = !hooks.canProceed;
  nextBtn.addEventListener("click", hooks.onNext);
  const usualsRow = panel.element.querySelector<HTMLElement>(".ride-settings__actions");
  if (usualsRow) {
    usualsRow.append(nextBtn);
  } else {
    const actions = document.createElement("div");
    actions.className = "ride-wizard__actions";
    actions.append(nextBtn);
    container.append(actions);
  }

  return { dispose: () => panel.destroy() };
};

// ---------- Sun-synced theme ----------

// Auto mode (theme follows sunrise/sunset in Denver) lives in the map's
// three-state ☀/☾ ThemeControl now; here we only resume it on boot.

// ---------- Recommended Devices ----------

// The persistent home of the Find-a-ride interview's ranked picks; re-ranks
// on every filter change. Created at map load, fed by the wizard's
// onInterviewDone hook in wireModes().
let recommended: RecommendedDevices | null = null;

function wireRecommended(): void {
  recommended = new RecommendedDevices(
    need("recommended-body"),
    devices,
    locate,
    map,
  );
}

map.on("load", async () => {
  devices.addLayers();
  buildLayerToggles();
  wireRideTypes();
  wireModels();
  wireHideUnavailable();
  wireBatterySlider();
  wireQuality();
  wireClearFilters();
  wireIconography();
  wireRecommended();
  wireChoropleth();
  wireHexDensity();
  // 🏆 Leaderboard: the single wireX() entry point (frontend plan's
  // Leaderboard section). Must come after wireChoropleth()/wireHexDensity()
  // above — that's what replaces choroplethPause/hexDensityPause from their
  // placeholder no-ops with the real-backed controllers this needs to pause.
  // The profile button is looked up by its stable selector (index.html gives
  // it no id); the null-guard is defensive only — it's static markup and
  // should always be found.
  const profileBtn = document.querySelector<HTMLButtonElement>(
    '.topbar__right .drawer-tab[data-drawer="account"]',
  );
  if (profileBtn) {
    wireLeaderboard(map, profileBtn, {
      devices,
      closeAllPopups,
      hexDensityPause,
      choroplethPause,
    });
  }
  wireDrawers();
  const areaFilter = wireAreaFilter();
  applyFilterSnapshot = makeApplyFilterSnapshot(areaFilter);
  wireModes();
  wireFilterPresets({
    snapshot: snapshotFilters,
    apply: (s) => applyFilterSnapshot(s),
    suggestName: () => filterSummary() || "All devices",
  });
  wireEquityRanks();

  // Direct manipulation: clicking a visible region polygon toggles it in
  // the area filter (clicks on device dots/clusters keep their popups).
  overlays.enableRegionClicks((layer, regionName) => {
    void areaFilter.toggleRegionFromMap(layer, regionName);
  }, DEVICE_INTERACTIVE_LAYERS);

  // Keep the freshness pill's Filters line in sync with every filter
  // change (the first fire happens right after a setData() too), and the
  // Map line with both filter changes and camera moves.
  devices.onCountsChange((visible, total) => {
    freshness.setCounts(visible, total);
    freshness.setViewportCount(countDevicesInViewport());
  });
  map.on("moveend", () => {
    freshness.setViewportCount(countDevicesInViewport());
  });

  const resp = await devicesPromise;
  if (resp) {
    devices.setData(resp);
    equity.update(resp.features);
    const visible = devices.visibleFeatures();
    clusters.update(visible);
    freshness.update(
      resp.metadata.snapshot_time,
      visible.length,
      resp.metadata.device_count,
    );
  } else {
    freshness.error();
  }

  // ---------- Ride wizard (F1 shell + F2 screens + F3 wiring) ----------
  // F3 flips the 🧭 Ride button on by default (frontend plan, "Entry") — see
  // wireModes()'s `case "riding"` (ride-hud.ts's `isLiveRideEntry` guard) —
  // so this wizard wiring is now unconditional: the button calls
  // `openRideModal()` whenever no ride is live, which needs a real, registered
  // screen behind it rather than the `scooter-fyi-ride-modal` dev flag's old
  // placeholder. `isRideModalEnabled`/`RIDE_MODAL_FLAG_KEY` (ride-modal.ts)
  // are dead code now — left for ride-modal.ts's own owner to prune.
  //
  // Wired after the first device response because a `?ride=plate:` link
  // reverse-resolves the plate against the UNFILTERED device set — an empty list
  // would send an otherwise-resolvable plate down the manual path. The
  // vehicle-identifier form does not need the list, so this still runs when the
  // fetch failed.
  wireRideModal({
    // F3 recovery seat (ride-modal.ts's own doc comment): reconcile the
    // persisted session doc against the server / local track-store BEFORE
    // anything renders, and silently resume the HUD + recording when a ride
    // was already live across the reload — the phase's real acceptance bar
    // ("reload mid-ride restores HUD + tracking within ~3 s"). Fire-and-forget
    // for the rest of boot: recovery is async (it may hit the network), and
    // nothing else should wait on it.
    //
    // F4: Screens 8/9/10 (`ride-post.ts`) wire only once this settles, not
    // alongside the wireRideScreenX calls below, so `wireRidePost`'s
    // `recoveryNote` dep (read once, at wire time) can carry
    // `recoverActiveRide`'s resolved note straight through — see that
    // function's own doc comment. `recoverRideSession` can land a reloaded
    // doc directly on `ending(8)` (the `seal_and_end` outcome, watch expired
    // before the rider tapped End Ride) via `rideSession.replace()`, which
    // bypasses the reducer's `legacyEndRide` gate entirely — so Screen 8
    // already renders correctly for THAT path regardless of the flag. The
    // *live* "rider taps End Ride mid-ride" path also reaches `ending(8)`
    // now (`legacyEndRide: false` above + ride-hud.ts's `handOffTrackedRideEnd`
    // hand-off), and recovery reliably resolves within a few seconds of load
    // — long before a rider could organically reach End Ride — so deferring
    // this wiring until recovery settles still costs nothing in practice.
    onWired: () => {
      void recoverActiveRide().then((recoveryNote) => {
        wireRidePost({
          session: rideSession,
          locate,
          recoveryNote,
          // Screen 9's pane-header point values — same already-warmed value
          // Screen 2's ℹ modals use (see `warmRideModePoints()` below); a
          // getter so a still-in-flight fetch at wire time is still picked
          // up by the time a rider could ever actually reach Screen 9.
          points: () => rideModePoints,
          // Review fix: share the SAME TrackStore instance the ride was
          // recorded into (this module's own lazy singleton, above) rather
          // than letting Screens 8/9/10 each open an independent
          // `openTrackStore()` — with IndexedDB unavailable, every
          // independent call degrades to a brand-new, empty in-memory
          // adapter that never sees this tab's recorded batches.
          getTrackStore,
          // Review fix: Screen 8 prefers the ride's own last fix over a
          // fresh `Locate.current()` read (see `ride-hud.ts`'s `getLastFix`
          // doc comment for why).
          getLastFix: () => rideHud.getLastFix(),
        });
      });
    },
    // The entry's id is a 16-hex `vehicle_identifier` on the `?ride=<hex>`
    // path but a `device_id` on the `?ride=plate:` path (GbfsPlates' reverse
    // lookup speaks device_id — gbfs.ts's index is keyed on Veo's bike_id).
    // Accept either and hand jumpToDevice the device_id it matches popups on.
    jumpToDevice: (id) => {
      const want = id.toLowerCase();
      const feat = devices
        .allFeatures()
        .find(
          (f) =>
            f.properties.device_id === id ||
            String(f.properties.vehicle_identifier ?? "").toLowerCase() ===
              want,
        );
      if (!feat) return;
      const [lng, lat] = feat.geometry.coordinates;
      devices.jumpToDevice(feat.properties.device_id, lng, lat);
    },
    // Every open (a deep link, or a later re-entry) starts one fresh session
    // doc — `reduceRideSession`'s own guard rejects this over a live/post
    // ride, so a re-entry mid-ride can never clobber it. Guest-vs-private is
    // NOT decided here: it defaults to `false` and Screen 2's device pick
    // (own device vs. a real Veo scooter) is what actually derives it.
    onOpen: (entry) => {
      const context = { private: false, authenticated: isAuthenticated() };
      const base = defaultRideOptionsFor(context);
      // The device card's "Use in Ride Mode" survey (`ride-preflight.ts`)
      // already asked about navigation / save-tracks / cost-HUD, so its
      // answers seed the fresh doc instead of the product defaults. Run
      // through `applyCascades` rather than spreading straight in: turning
      // save_tracks OFF has to suppress battery_modeling and nav_improvement
      // exactly as it does when Screen 2's own panel toggles it, and a
      // shortcut that skipped the cascades would be the one path that can
      // produce an options blob the wizard itself would call illegal.
      const options = entry.preflight
        ? applyCascades({ ...base, ...entry.preflight }, context)
        : base;
      rideSession.dispatch({ type: "open", options });

      // The survey path also pre-selects the DEVICE, which is normally
      // Screen 2's job. It has to be done here rather than left to that
      // screen, because the whole premise of "Use in Ride Mode" is that the
      // rider already answered "which scooter?" by opening its popup — so
      // Screen 2 skips itself for this entry (see its own skip predicate),
      // and with nothing setting `doc.device` the flow would reach Screen 6,
      // find no device, skip that too, and run off the end without ever
      // dispatching `rideStarted`.
      //
      // `private` mirrors `ride-screen-select.ts`'s `syncSessionDevice`
      // exactly: a guest's real-device pick is still a private ride, because
      // `POST /tracked-rides` is session-authed and there is no account to
      // attribute a row to.
      if (entry.preflight && entry.vehicleIdentifier) {
        const want = entry.vehicleIdentifier.toLowerCase();
        const feat = devices
          .allFeatures()
          .find(
            (f) =>
              String(f.properties.vehicle_identifier ?? "").toLowerCase() ===
              want,
          );
        rideSession.dispatch({
          type: "setDevice",
          device: {
            vehicleIdentifier: want,
            // The popup's own resolved plate is preferred: it is what built
            // the deep link the rider may already have tapped, and the map
            // payload carries no plate on the public path.
            plate: entry.plate ?? null,
            model: feat ? modelKeyOf(feat.properties) : null,
            // Same as Screen 2: no rider-entered battery %, the server
            // derives its own reading from the feed.
            batteryConfirmed: null,
          },
          private: !isAuthenticated(),
        });
      }
    },
    // Every screen change — including the first, right after `onOpen` above
    // picks screen "1" — persists the shell's actual current screen onto the
    // session doc, so a reload mid-wizard (F3's recovery) knows where the
    // rider was. `ScreenId` (ride-modal.ts) and `WizardScreenId`
    // (ride-session.ts) are member-for-member identical unions (see both
    // files' own comments), so this needs no cast.
    onScreenChange: (id) => {
      rideSession.dispatch({ type: "goto", screen: id });
    },
    // Screen 6 ran off the end of RIDE_SCREEN_FLOW: the wizard is handing off
    // to the HUD (frontend plan, "Screen 6 → HUD handoff" — F3's other central
    // integration seam). `ride-screen-start.ts` already dispatched
    // `rideStarted` (private and tracked rides both reach here), so the
    // session doc already carries the ride's identity — read it straight back
    // rather than threading it through yet another hook. The local track
    // recorder for a TRACKED ride is attached moments later by
    // `onRideStarted` below (an unavoidable one-microtask gap: opening
    // IndexedDB is async and `RideHud.attachTrackRecorder` is built exactly
    // for filling it in after `beginHandoff` already put the HUD on screen).
    onComplete: () => {
      const doc = rideSession.current();
      if (!doc || doc.state !== "riding") return;
      applyCostHudPreference();
      rideHud.beginHandoff({
        rideId: doc.rideId,
        startedAtMs: doc.startedAtMs ?? Date.now(),
        recorder: null,
      });
    },
  });
  // Screens 1–6 (phase F2). Each `wireRideScreenX` call registers its own
  // screen(s) into ride-modal.ts's registry (`registerRideScreen`) — no
  // further main.ts wiring needed per screen beyond handing it the shared
  // `rideSession`/`locate`/`devices` instances every lane's report asked
  // for. Order doesn't matter (registration is a plain Map keyed by screen
  // id), but auth is wired first so its GPS-permission priming has the most
  // lead time before the rider can reach it (ride-screen-auth.ts's own
  // module note).
  wireRideScreenAuth({ locate });
  wireRideScreenSelect({
    devices,
    locate,
    session: rideSession,
    buildOptionsPanel: buildRideOptionsPanel,
  });
  wireRideScreenDest({ session: rideSession, locate });
  wireRideScreenRoutes({ session: rideSession, locate, devices });
  wireRideScreenStart({
    session: rideSession,
    locate,
    // F3's other half of the Screen 6 → HUD handoff (see `onComplete` above):
    // a TRACKED ride's `track_signing` only exists in this hook's argument,
    // so this is the one place that can seed `track-store`. Fire-and-forget —
    // `onComplete` has already shown the HUD by the time this resolves;
    // `attachTrackRecorder` is exactly the seam for wiring one in slightly
    // late.
    onRideStarted: (ride) => {
      if (!ride.track_signing) {
        console.error(
          "ride start: server response carried no track_signing — recording cannot start",
        );
        return;
      }
      const signing = ride.track_signing;
      void (async () => {
        try {
          const trackStore = await getTrackStore();
          const recorder = await trackStore.startServerRide(signing);
          rideHud.attachTrackRecorder(recorder);
        } catch (e) {
          console.error("ride start: opening the local track recorder failed", e);
        }
      })();
    },
    // Private/guest ride mirror of `onRideStarted` above (review fix): fires
    // with the SAME `trackKeyId` the session doc already carries, so
    // `resumeRide` mints its local record under that exact id rather than a
    // second, unrelated one — see `ride-screen-start.ts`'s doc comment on
    // this hook and `track-store.ts`'s `resumeRide` doc comment on minting a
    // brand-new private ride under a caller-supplied id.
    onPrivateRideStarted: (trackKeyId) => {
      void (async () => {
        try {
          const trackStore = await getTrackStore();
          const resumed = await trackStore.resumeRide(trackKeyId, {
            isPrivate: true,
          });
          rideHud.attachTrackRecorder(resumed.recorder);
        } catch (e) {
          console.error(
            "ride start: opening the local private track recorder failed",
            e,
          );
        }
      })();
    },
    // Review fix: `startTrackedRide`'s 409 ("an active ride already exists")
    // used to render a dead-end static message. Fetch the conflicting ride
    // and show the same resume-or-end prompt boot recovery uses
    // (`recoveryForServerConflict` + `presentResumeOrEnd`, above) instead.
    onServerConflict: () => {
      void (async () => {
        try {
          const active = await getActiveRide();
          if (!active) return; // race: the conflicting ride ended already
          const outcome = await recoveryForServerConflict(
            { doc: rideSession.current(), ...baseRecoveryDeps() },
            active,
            rideSession.current(),
          );
          presentResumeOrEnd(outcome);
        } catch (e) {
          console.error(
            "ride start: fetching the conflicting active ride failed",
            e,
          );
        }
      })();
    },
  });
  warmRideModePoints();
  // `?ride=` is consumed only once `?ml=` has definitively NOT been redeemed.
  // ride-deeplink.ts carries the same guard, but it can only reach for it
  // while `?ml=` is still in the URL — and redemption strips the param in a
  // `finally` just before it reloads, so by the time this runs the param can
  // already be gone with a reload in flight. Consuming `?ride=` there would
  // replaceState it away and the reloaded document would land with no deep
  // link. Gating on the promise covers that window too; the hook below stays
  // wired so the module's own guard still holds on the other ordering.
  void magicLinkSettled.then((redeemed) => {
    if (redeemed) return;
    wireRideDeepLink({
      magicLinkSettled,
      // allFeatures(), never visibleFeatures(): a leftover model / battery /
      // quality / area filter must not hide the scooter the rider is holding.
      deviceIds: () =>
        devices.allFeatures().map((f) => f.properties.device_id),
    });
  });

  // Warm the default-selected ranks' polygons so the estimate populates.
  void equity.warm();
  startRefreshLoop();
});

// ---------- Controls ----------

function buildLayerToggles(): void {
  const list = need("layer-list");
  for (const def of OVERLAYS) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "layer-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = def.layer;
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await overlays.toggle(def.layer, input.checked);
      } catch (e) {
        console.error(`overlay ${def.layer} failed`, e);
        input.checked = false;
      } finally {
        input.disabled = false;
      }
    });

    const swatch = document.createElement("span");
    swatch.className = "layer-item__swatch";
    swatch.style.background = def.color;
    swatch.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "layer-item__label";
    text.textContent = def.label;

    label.append(input, swatch, text);
    li.append(label);
    list.append(li);
    layerInputs.set(def.layer, input);
  }
}

/** Programmatically enable an overlay (used when the area filter activates). */
function setOverlayChecked(layer: BoundaryLayer, checked: boolean): void {
  const cb = layerInputs.get(layer);
  if (!cb || cb.checked === checked) return;
  cb.checked = checked;
  cb.dispatchEvent(new Event("change"));
}

/** Generic single-select segmented control. Returns a programmatic setter
 *  (used by presets/chips) keyed on the same value the buttons carry. */
function wireSeg(
  rootSel: string,
  valueOf: (b: HTMLButtonElement) => string,
  onChange: (value: string) => void,
): (value: string) => void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`${rootSel} .seg-btn`),
  );
  const select = (btn: HTMLButtonElement): void => {
    for (const b of btns) {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    onChange(valueOf(btn));
  };
  btns.forEach((btn, i) => {
    btn.addEventListener("click", () => select(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = btns[(i + 1) % btns.length];
        next.focus();
        select(next);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = btns[(i - 1 + btns.length) % btns.length];
        prev.focus();
        select(prev);
      }
    });
  });
  return (value) => {
    const btn = btns.find((b) => valueOf(b) === value);
    if (btn && !btn.classList.contains("is-active")) select(btn);
  };
}

/** Multi-toggle button group where everything starts enabled and a click
 *  disables that one member. Returns a "re-enable everything" resetter. */
function wireToggleGroup<T extends string>(
  btns: HTMLButtonElement[],
  valueOf: (b: HTMLButtonElement) => T,
  all: readonly T[],
  onChange: (enabled: Set<T>) => void,
): () => void {
  const enabled = new Set<T>(all);
  const sync = (): void => {
    for (const b of btns) {
      const on = enabled.has(valueOf(b));
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    onChange(new Set(enabled));
  };
  for (const btn of btns) {
    btn.addEventListener("click", () => {
      const v = valueOf(btn);
      if (enabled.has(v)) enabled.delete(v);
      else enabled.add(v);
      sync();
    });
  }
  return () => {
    if (enabled.size === all.length) return;
    for (const v of all) enabled.add(v);
    sync();
  };
}

function wireRideTypes(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      "#ride-type-filter .toggle-pill",
    ),
  );
  clearRideTypeFilter = wireToggleGroup(
    btns,
    (b) => b.dataset.ride as RideType,
    ALL_RIDE_TYPES,
    (enabled) => {
      rideTypesOn = enabled;
      devices.setRideTypes(enabled);
      clusters.update(devices.visibleFeatures());
      refreshChips();
    },
  );
}

function wireModels(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#model-filter .toggle-card"),
  );
  clearModelFilter = wireToggleGroup(
    btns,
    (b) => b.dataset.model as ModelKey,
    ALL_MODELS,
    (enabled) => {
      modelsOn = enabled;
      devices.setModels(enabled);
      clusters.update(devices.visibleFeatures());
      refreshChips();
    },
  );
}

function wireQuality(): void {
  const set = wireSeg(
    "#quality-seg",
    (b) => b.dataset.quality ?? "any",
    (v) => {
      qualityOn = v as QualityFilter;
      devices.setQuality(qualityOn);
      clusters.update(devices.visibleFeatures());
      refreshChips();
    },
  );
  setQualityFilter = (value) => set(value);
  clearQualityFilter = () => set("any");
}

// ---------- Filter snapshots (saved presets + ride-mode carry-over) ----------

/** Capture exactly what the Filters drawer owns. Area keeps only the
 *  display selection — polygons re-resolve on apply. */
function snapshotFilters(): FilterSnapshot {
  const display = lastAreaState?.display;
  return {
    rideTypes: [...rideTypesOn],
    models: [...modelsOn],
    hideUnavailable: need<HTMLInputElement>("hide-unavailable").checked,
    minBattery: minBatteryPct,
    quality: qualityOn,
    area: display ? { layer: display.layer, subset: display.subset } : null,
  };
}

/** Click each multi-toggle member into the wanted state so the group's own
 *  handler (and the whole map→clusters→chips sync path) runs normally. */
function setToggleGroup(
  rootSel: string,
  key: "ride" | "model",
  want: ReadonlySet<string>,
): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    `${rootSel} button`,
  )) {
    const value = btn.dataset[key];
    if (!value) continue;
    if (btn.classList.contains("is-active") !== want.has(value)) btn.click();
  }
}

/** Drive every Filters-drawer control to match the snapshot, through each
 *  control's normal event path. The area restore is async (boundary fetch);
 *  callers disable their trigger until this settles. Assigned inside
 *  map.on("load") once the AreaFilter exists. */
let applyFilterSnapshot: (s: FilterSnapshot) => Promise<void> = () =>
  Promise.resolve();

function makeApplyFilterSnapshot(areaFilter: AreaFilter) {
  return async (s: FilterSnapshot): Promise<void> => {
    setToggleGroup("#ride-type-filter", "ride", new Set(s.rideTypes));
    setToggleGroup("#model-filter", "model", new Set(s.models));
    const hideCb = need<HTMLInputElement>("hide-unavailable");
    if (hideCb.checked !== s.hideUnavailable) {
      hideCb.checked = s.hideUnavailable;
      hideCb.dispatchEvent(new Event("change"));
    }
    const slider = need<HTMLInputElement>("battery-min");
    if (slider.value !== String(s.minBattery)) {
      slider.value = String(s.minBattery);
      slider.dispatchEvent(new Event("input"));
    }
    setQualityFilter(s.quality);
    await areaFilter.applySelection(s.area);
  };
}

function wireClearFilters(): void {
  resetAllFilters = () => {
    clearRideTypeFilter();
    clearModelFilter();
    clearBatteryMin();
    clearQualityFilter();
    const hideCb = need<HTMLInputElement>("hide-unavailable");
    if (hideCb.checked) {
      hideCb.checked = false;
      hideCb.dispatchEvent(new Event("change"));
    }
    const areaCb = need<HTMLInputElement>("area-filter-enable");
    if (areaCb.checked) {
      areaCb.checked = false;
      areaCb.dispatchEvent(new Event("change"));
    }
  };
  need<HTMLButtonElement>("clear-filters").addEventListener("click", () =>
    resetAllFilters(),
  );
}

function wireHideUnavailable(): void {
  const cb = need<HTMLInputElement>("hide-unavailable");
  cb.addEventListener("change", () => {
    devices.setHideUnavailable(cb.checked);
    clusters.update(devices.visibleFeatures());
    refreshChips();
  });
}

function wireBatterySlider(): void {
  const slider = need<HTMLInputElement>("battery-min");
  const out = need<HTMLOutputElement>("battery-min-value");
  const syncVisual = (): void => {
    const v = Number(slider.value);
    // The slider wears the gauge's color for its current value, so the
    // control and the map rings speak the same language.
    const color = gaugeColor(v);
    slider.style.accentColor = v === 0 ? "" : color;
    out.textContent = v === 0 ? "Off" : `≥ ${v}%`;
    out.style.color = v === 0 ? "" : color;
  };
  slider.addEventListener("input", () => {
    syncVisual();
    minBatteryPct = Number(slider.value);
    devices.setMinBattery(minBatteryPct);
    clusters.update(devices.visibleFeatures());
    refreshChips();
  });
  syncVisual();
  clearBatteryMin = () => {
    if (slider.value === "0") return;
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
  };
}

// ---------- Iconography ----------

// Icon style (ride type / model / data), independent icon-data and
// gauge-data sources, the gauge toggle (default on), contextual example
// rows rendered with the real icon renderer, and the on-map legend.
/** Enlarge a preview icon in a dismissible modal overlay. Closes on the ✕, on
 *  a backdrop tap (an "additional tap"), or Escape. Moves focus into the
 *  dialog on open and restores it to the trigger on close. */
function openIconLightbox(url: string, label: string): void {
  document.querySelector(".icon-lightbox")?.remove();
  const returnFocusTo =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement("div");
  overlay.className = "icon-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", `${label} — enlarged icon`);

  const box = document.createElement("div");
  box.className = "icon-lightbox__box";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-lightbox__close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  const big = document.createElement("img");
  big.className = "icon-lightbox__img";
  big.src = url;
  big.alt = label;
  const cap = document.createElement("div");
  cap.className = "icon-lightbox__cap";
  cap.textContent = label;
  box.append(close, big, cap);
  overlay.append(box);

  const dismiss = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    returnFocusTo?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") dismiss();
  };
  // Explicit close button — stop its click from double-firing via the overlay.
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });
  // The overlay covers the whole screen, so a tap anywhere — backdrop or the
  // enlarged icon itself ("additional tap") — dismisses it.
  overlay.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  close.focus(); // move keyboard focus into the dialog
}

function wireIconography(): void {
  const styleDetail = need("icono-style-detail");
  const gaugeBody = need("gauge-body");
  const gaugeDetail = need("icono-gauge-detail");
  const iconDataSection = need("icon-data-section");
  const legendEl = need("icon-legend");
  const legendToggle = need<HTMLInputElement>("legend-toggle");
  const gauge = need<HTMLInputElement>("gauge-toggle");

  // Local mirrors of the devices-side iconography state, for rendering.
  let style: IconStyle = "data"; // default per Zeke (PR #37)
  let modelIcon: ModelIcon = "comic";
  let iconData: DataSource = "reliability";
  let gaugeData: DataSource = "battery";
  let thickness: GaugeThickness = "standard";
  let placement: GaugePlacement = "gap";
  const THICK_CHAR: Record<GaugeThickness, string> = {
    thin: "T",
    standard: "S",
    large: "L",
    xlarge: "X",
  };
  const PLACE_CHAR: Record<GaugePlacement, string> = {
    surrounding: "S",
    gap: "G",
    biggap: "B",
  };
  /** Ring spec → full icon key carrying the current design options, so the
   *  example rows and legend preview exactly what the map will draw. */
  const k = (inner: string, ring: string): string =>
    `ik|${inner}|${ring}|${THICK_CHAR[thickness]}${PLACE_CHAR[placement]}`;

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (
    key: string,
    title: string,
    overlay?: { text: string; color: string },
  ): HTMLImageElement => {
    const img = el("img", "icono-preview");
    const preview = iconPreviewURL(key, overlay);
    img.src = preview.url;
    // Canvases vary by design (rings grow outward from a fixed badge), so
    // previews scale to match the map's relative sizes.
    const size = Math.round(preview.logicalPx * 0.8);
    img.width = size;
    img.height = size;
    img.alt = title;
    img.title = `${title} — tap to enlarge`;
    // Tap any preview to inspect it at a legible size (item: enlarge-on-tap).
    img.addEventListener("click", () => openIconLightbox(preview.url, title));
    return img;
  };
  const item = (
    key: string,
    label: string,
    overlay?: { text: string; color: string },
  ): HTMLElement => {
    const row = el("div", "icono-item");
    row.append(icon(key, label, overlay), el("span", undefined, label));
    return row;
  };

  // Comic-vs-letter switch for the Model style, rebuilt with the detail rows.
  const modelIconToggle = (): HTMLElement => {
    const seg = el("div", "segmented icono-modelicon");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Model icon style");
    for (const [val, label] of [
      ["comic", "Comic"],
      ["letter", "Letter"],
    ] as const) {
      const b = el("button", "seg-btn", label);
      b.type = "button";
      b.setAttribute("role", "radio");
      const on = modelIcon === val;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
      b.addEventListener("click", () => {
        if (modelIcon === val) return;
        modelIcon = val;
        devices.setModelIcon(modelIcon);
        renderAll();
      });
      seg.append(b);
    }
    return seg;
  };

  // Only details pertinent to the selected icon style.
  const renderStyleDetail = (): void => {
    styleDetail.replaceChildren();
    if (style === "use") {
      styleDetail.append(
        el("p", "icono-detail__title", "Ride Types:"),
        item(k("use-sitting", "off"), "Seated"),
        item(k("use-standing", "off"), "Standing"),
      );
    } else if (style === "model") {
      const c = modelIcon === "comic";
      styleDetail.append(
        el("p", "icono-detail__title", "Device Models"),
        modelIconToggle(),
        item(k(c ? "msvg-astro" : "ml-astro", "off"), "Veo Astro — Standing scooter"),
        item(k(c ? "msvg-cosmo" : "ml-cosmo", "off"), "Veo Cosmo — One passenger glider (no pedals)"),
        item(k(c ? "msvg-apollo" : "ml-apollo", "off"), "Veo Apollo — Two passenger e-bike w/ pedals"),
        item(k(c ? "msvg-trike" : "ml-trike", "off"), "Veo Trike — Three-wheel seated trike w/ cargo basket"),
      );
    } else {
      styleDetail.append(
        el(
          "p",
          "icono-detail__note",
          "Data display shows battery % or reliability indicator icon for each device.",
        ),
      );
      if (iconData === "battery") {
        styleDetail.append(
          item(k("db-3", "off"), "100%", { text: "100", color: "#ffffff" }),
          item(k("db-1", "off"), "50%", { text: "50", color: "#3a2a00" }),
          item(k("db-0", "off"), "25%", { text: "25", color: "#ffffff" }),
        );
      } else {
        styleDetail.append(
          item(k("dr-ok", "off"), "Likely Ridable"),
          item(k("dr-unknown", "off"), "Unknown"),
          item(k("dr-risk", "off"), "High Risk"),
        );
      }
    }
  };

  // Gauge section: nothing below the toggle line when off; examples match
  // the selected gauge data when on.
  const renderGaugeDetail = (): void => {
    gaugeBody.hidden = !gauge.checked;
    gaugeDetail.replaceChildren();
    if (!gauge.checked) return;
    if (gaugeData === "battery") {
      gaugeDetail.append(
        item(k("x", "b-100"), "Full"),
        item(k("x", "b-50"), "50%"),
        item(k("x", "b-25"), "25%"),
      );
    } else {
      gaugeDetail.append(
        item(k("x", "r-ok"), "Likely ridable"),
        item(k("x", "r-unknown"), "Unknown"),
        item(k("x", "r-risk"), "Questionable"),
      );
    }
  };

  // On-map legend: every icon + gauge-ring permutation for the current
  // settings, docked below the ribbon; hover for descriptions. A collapsed
  // ribbon's rect is parked off-screen, so the legend hangs from the top
  // bar instead.
  const positionLegend = (): void => {
    const tabs = document.getElementById("drawer-tabs");
    const topbar = document.getElementById("topbar");
    const anchor =
      document.body.classList.contains("ribbon-open") && tabs ? tabs : topbar;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    legendEl.style.top = `${Math.round(rect.bottom + 10)}px`;
  };
  const renderLegend = (): void => {
    legendEl.hidden = !legendToggle.checked;
    if (!legendToggle.checked) return;
    legendEl.replaceChildren();
    const head = (text: string): HTMLElement =>
      el("span", "icon-legend__head", text);

    legendEl.append(head("Icons"));
    if (style === "use") {
      legendEl.append(
        icon(k("use-sitting", "off"), "Seated ride (Cosmo glider, Apollo e-bike or Trike)"),
        icon(k("use-standing", "off"), "Standing scooter (Astro)"),
      );
    } else if (style === "model") {
      const c = modelIcon === "comic";
      legendEl.append(
        icon(k(c ? "msvg-astro" : "ml-astro", "off"), "Veo Astro — standing scooter"),
        icon(k(c ? "msvg-cosmo" : "ml-cosmo", "off"), "Veo Cosmo — one passenger glider (no pedals)"),
        icon(k(c ? "msvg-apollo" : "ml-apollo", "off"), "Veo Apollo — two passenger e-bike w/ pedals"),
        icon(k(c ? "msvg-trike" : "ml-trike", "off"), "Veo Trike — three-wheel seated trike w/ cargo basket"),
        icon(k(c ? "model-unk" : "ml-unk", "off"), "Unrecognized model — tap its pin to tell us!"),
      );
    } else if (iconData === "battery") {
      legendEl.append(
        icon(k("db-3", "off"), "Battery: top quartile", { text: "100", color: "#ffffff" }),
        icon(k("db-2", "off"), "Battery: 50–75% quartile", { text: "65", color: "#1f3a14" }),
        icon(k("db-1", "off"), "Battery: 25–50% quartile", { text: "40", color: "#3a2a00" }),
        icon(k("db-0", "off"), "Battery: bottom quartile", { text: "15", color: "#ffffff" }),
        icon(k("db-x", "off"), "No battery data"),
      );
    } else {
      legendEl.append(
        icon(k("dr-ok", "off"), "Likely ridable"),
        icon(k("dr-unknown", "off"), "Unknown reliability"),
        icon(k("dr-risk", "off"), "High risk — rendered faded on the map"),
      );
    }

    if (gauge.checked) {
      legendEl.append(head("Gauge"));
      if (gaugeData === "battery") {
        legendEl.append(
          icon(k("x", "b-100"), "Gauge ring: 100% battery — full green ring"),
          icon(k("x", "b-75"), "Gauge ring: ~75% battery"),
          icon(k("x", "b-50"), "Gauge ring: ~50% battery (amber)"),
          icon(k("x", "b-25"), "Gauge ring: ~25% battery (red)"),
          icon(k("x", "b-x"), "Gauge ring: no battery data (thin gray outline)"),
        );
      } else {
        legendEl.append(
          icon(k("x", "r-ok"), "Gauge ring: likely ridable"),
          icon(k("x", "r-unknown"), "Gauge ring: unknown reliability"),
          icon(k("x", "r-risk"), "Gauge ring: questionable — high risk"),
        );
      }
    }
    positionLegend();
  };
  const renderAll = (): void => {
    renderStyleDetail();
    renderGaugeDetail();
    renderLegend();
  };

  const setGaugeSrc = wireSeg(
    "#data-source-seg",
    (b) => b.dataset.source ?? "battery",
    (v) => {
      gaugeData = v as DataSource;
      devices.setGaugeData(gaugeData);
      renderAll();
    },
  );
  const opposite = (s: DataSource): DataSource =>
    s === "battery" ? "reliability" : "battery";
  const setIconSrc = wireSeg(
    "#icon-data-seg",
    (b) => b.dataset.source ?? "reliability",
    (v) => {
      iconData = v as DataSource;
      devices.setIconData(iconData);
      // Keep the icon and ring showing different signals: flip the gauge to
      // the opposite source (icon reliability → battery ring, and vice
      // versa) whenever the gauge is on.
      if (gauge.checked) setGaugeSrc(opposite(iconData));
      renderAll();
    },
  );
  const setStyle = wireSeg(
    "#icon-style-seg",
    (b) => b.dataset.style ?? "use",
    (v) => {
      style = v as IconStyle;
      devices.setIconStyle(style);
      iconDataSection.hidden = style !== "data";
      // Entering Data icons: point the gauge at whatever the badge isn't
      // showing, so the two stay complementary.
      if (style === "data" && gauge.checked) setGaugeSrc(opposite(iconData));
      renderAll();
    },
  );
  // 📐 Design Options.
  let gaugeDisplayOn: GaugeDisplay = "always";
  const setDisplay = wireSeg(
    "#gauge-display-seg",
    (b) => b.dataset.display ?? "always",
    (v) => {
      gaugeDisplayOn = v as GaugeDisplay;
      devices.setGaugeDisplay(gaugeDisplayOn);
    },
  );

  // ✋ Touch-aware hover: no hover-dependent options on a touch device.
  // Reactive, not one-shot — a 2-in-1 detaching its keyboard flips this
  // live. When hover support goes away with the gauge already on "hover",
  // coerce it back to "always" — otherwise the gauges vanish with no
  // visible control to bring them back.
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
  const hoverOptBtn = document.querySelector<HTMLButtonElement>(
    '#gauge-display-seg [data-display="hover"]',
  );
  const tooltipSection = need("tooltip-section");
  const syncHoverGate = (): void => {
    const ok = canHover.matches;
    if (hoverOptBtn) hoverOptBtn.hidden = !ok;
    tooltipSection.hidden = !ok;
    if (!ok && gaugeDisplayOn === "hover") setDisplay("always");
  };
  canHover.addEventListener("change", syncHoverGate);
  syncHoverGate();
  const setThickness = wireSeg(
    "#gauge-thickness-seg",
    (b) => b.dataset.thickness ?? "standard",
    (v) => {
      thickness = v as GaugeThickness;
      devices.setGaugeThickness(thickness);
      renderAll(); // examples + legend preview the new ring weight
    },
  );
  const setPlacement = wireSeg(
    "#gauge-placement-seg",
    (b) => b.dataset.placement ?? "surrounding",
    (v) => {
      placement = v as GaugePlacement;
      devices.setGaugePlacement(placement);
      renderAll();
    },
  );
  gauge.addEventListener("change", () => {
    devices.setGauge(gauge.checked);
    // Turning the ring on in Data mode: default it to the badge's opposite.
    if (gauge.checked && style === "data") setGaugeSrc(opposite(iconData));
    renderAll();
  });
  // ✨ Icon size: scales the on-map badges (and their % text overlays).
  // The drawer previews keep their fixed size — they demonstrate style,
  // not scale.
  const iconSize = need<HTMLInputElement>("icon-size");
  const iconSizeValue = need("icon-size-value");
  const applyIconSize = (): void => {
    const pct = Number(iconSize.value) || 100;
    iconSizeValue.textContent = `${pct}%`;
    devices.setIconScale(pct / 100);
  };
  iconSize.addEventListener("input", applyIconSize);
  // ✨ Essentials-on-hover tooltip.
  const tooltipToggle = need<HTMLInputElement>("tooltip-toggle");
  tooltipToggle.addEventListener("change", () =>
    devices.setHoverTooltip(tooltipToggle.checked),
  );
  legendToggle.addEventListener("change", renderLegend);
  window.addEventListener("resize", () => {
    if (legendToggle.checked) positionLegend();
  });
  // Ribbon toggling moves the legend's anchor between strip and top bar.
  window.addEventListener("scooter:ribbon", () => {
    if (legendToggle.checked) positionLegend();
  });

  resetIconography = () => {
    if (modelIcon !== "comic") {
      modelIcon = "comic";
      devices.setModelIcon("comic");
    }
    setStyle("data");
    setIconSrc("reliability");
    setGaugeSrc("battery");
    setDisplay("always");
    setThickness("standard");
    setPlacement("gap");
    if (iconSize.value !== "100") {
      iconSize.value = "100";
      applyIconSize();
    }
    if (!gauge.checked) {
      gauge.checked = true;
      gauge.dispatchEvent(new Event("change"));
    }
    if (!tooltipToggle.checked) {
      tooltipToggle.checked = true;
      tooltipToggle.dispatchEvent(new Event("change"));
    }
  };

  // Model badges decode async — refresh previews once they land.
  void whenModelIconsReady().then(renderAll);
  renderAll();
}

function wireChoropleth(): void {
  const select = need<HTMLSelectElement>("choropleth-select");
  const applyChoropleth = async (layer: BoundaryLayer | null): Promise<void> => {
    select.disabled = true;
    try {
      await overlays.setChoropleth(layer);
    } catch (e) {
      console.error("choropleth failed", e);
      select.value = "";
      await overlays.setChoropleth(null);
    } finally {
      select.disabled = false;
    }
  };
  // 🏆 Leaderboard: while open, a pick here only updates the stored value —
  // the real overlays.setChoropleth call is deferred to the leaderboard's
  // close() (leaderboard.ts's LayerPause). Unchanged (applies immediately)
  // when the leaderboard has never been opened.
  choroplethPause = createLayerPause<BoundaryLayer | null>(
    {
      getActive: () => (select.value || null) as BoundaryLayer | null,
      apply: applyChoropleth,
    },
    null,
  );
  // Reset to Off without re-triggering the change handler's side effects.
  clearChoropleth = () => {
    if (!select.value) return;
    select.value = "";
    choroplethPause.recordChange(null);
  };
  select.addEventListener("change", () => {
    const layer = (select.value || null) as BoundaryLayer | null;
    if (layer) clearHexDensity(); // mutually exclusive with hex density
    choroplethPause.recordChange(layer);
  });
}

function wireHexDensity(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#hexbin-seg .seg-btn"),
  );
  const metricRow = need("hexbin-metric-row");
  const metricSelect = need<HTMLSelectElement>("hexbin-metric-select");

  // 🏆 Leaderboard: see wireChoropleth()'s matching comment — same deferred-
  // apply-while-open behavior, mirrored for the hex-density seg control.
  hexDensityPause = createLayerPause<HexSize | null>(
    {
      getActive: () =>
        (btns.find((b) => b.classList.contains("is-active"))?.dataset.hex ||
          null) as HexSize | null,
      apply: (size) => void hexDensity.setSize(size),
    },
    null,
  );

  const select = (btn: HTMLButtonElement): void => {
    for (const b of btns) {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    const size = (btn.dataset.hex || "") as HexSize | "";
    if (size) clearChoropleth(); // mutually exclusive with the choropleth
    metricRow.hidden = !size;
    hexDensityPause.recordChange(size || null);
  };
  // Reset to Off (used when the choropleth takes over).
  clearHexDensity = () => {
    const off = btns.find((b) => b.dataset.hex === "");
    if (off && !off.classList.contains("is-active")) select(off);
  };
  btns.forEach((btn, i) => {
    btn.addEventListener("click", () => select(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = btns[(i + 1) % btns.length];
        next.focus();
        select(next);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = btns[(i - 1 + btns.length) % btns.length];
        prev.focus();
        select(prev);
      }
    });
  });

  metricSelect.addEventListener("change", () => {
    hexDensity.setMetric(metricSelect.value as HexMetric);
  });
}

function wireAreaFilter(): AreaFilter {
  const elements: AreaFilterElements = {
    enable: need<HTMLInputElement>("area-filter-enable"),
    body: need("area-filter-body"),
    category: need<HTMLSelectElement>("area-filter-category"),
    multi: need("area-filter-multi"),
    search: need<HTMLInputElement>("area-filter-search"),
    options: need("area-filter-options"),
    status: need("area-filter-status"),
    clear: need<HTMLButtonElement>("area-filter-clear"),
  };
  // The overlay layer the area filter currently "owns" — when it changes (or
  // becomes null), we release the prior layer: clear its subset filter and
  // turn its checkbox off, so manually re-enabling it shows all polygons.
  let managed: BoundaryLayer | null = null;

  return new AreaFilter(overlays, elements, (state) => {
    devices.setAreaFilter(state.polygons);
    lastAreaState = state;

    const nextLayer = state.display?.layer ?? null;
    if (managed && managed !== nextLayer) {
      void overlays.setSubset(managed, null);
      setOverlayChecked(managed, false);
    }
    if (state.display) {
      void overlays.setSubset(state.display.layer, state.display.subset);
      setOverlayChecked(state.display.layer, true);
    }
    managed = nextLayer;

    clusters.update(devices.visibleFeatures());
    refreshChips();
  });
}

// ---------- Use-case modes ----------

// Three modes on one bar. "Find wheels" (data-mode="ride") runs the guided
// wizard (ride-wizard.ts): location consent → interview → ranked options;
// while it's active the analysis drawer tabs hide. "Analysis" is the full
// civic/data surface with every drawer. "Ride" (data-mode="riding") opens
// the full-screen HUD — it covers all chrome, so its button is never seen
// selected; what matters is that closing the HUD hands the bar back to
// whichever mode was active before. The profile button in the top bar is
// shared by all three. Exiting Find-wheels mode — declining consent,
// closing the wizard, or tapping Analysis — resets iconography/overlays to
// their fresh-load defaults and restores the filters exactly as they stood
// on entry, so the wizard's presets never leak and a visit never destroys
// the analysis setup. The bar always shows the current mode: tweaking
// filters or iconography does NOT drop it to a "custom" state (per Zeke,
// PR #37 — the old capture-phase toCustom listener is gone).
function wireModes(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      "#mode-switch .mode-btn[data-mode]",
    ),
  );
  let rideActive = false;

  const setActive = (mode: string | null): void => {
    for (const b of btns) {
      const on = b.dataset.mode === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  const setChecked = (id: string, on: boolean): void => {
    const cb = need<HTMLInputElement>(id);
    if (cb.checked !== on) {
      cb.checked = on;
      cb.dispatchEvent(new Event("change"));
    }
  };
  const setSelect = (id: string, value: string): void => {
    const sel = need<HTMLSelectElement>(id);
    if (sel.value !== value) {
      sel.value = value;
      sel.dispatchEvent(new Event("change"));
    }
  };
  const setDrawer = (id: string | null): void => {
    const open = document.querySelector<HTMLButtonElement>(".drawer-tab.is-active");
    if (open && open.dataset.drawer !== id) open.click();
    if (id) {
      // Synthetic clicks land on hidden tabs too — with the ribbon
      // collapsed that would open a drawer with no visible origin, so
      // reveal the strip first.
      setRibbonOpen(true);
      const tab = document.querySelector<HTMLButtonElement>(
        `.drawer-tab[data-drawer="${id}"]`,
      );
      if (tab && !tab.classList.contains("is-active")) tab.click();
    }
  };
  const clearOverlays = (): void => {
    for (const input of layerInputs.values()) {
      if (input.checked) {
        input.checked = false;
        input.dispatchEvent(new Event("change"));
      }
    }
  };

  // Fresh-load defaults. Exiting ride mode runs this so the map comes back
  // "normal": every filter cleared, iconography back to its defaults
  // (device-use badges, battery gauge on), overlays and the walk line gone.
  const applyNormal = (): void => {
    resetAllFilters();
    resetIconography();
    setSelect("choropleth-select", "");
    clearHexDensity();
    clearOverlays();
    setDrawer(null);
    locate.clearLine();
  };

  // Map preset behind the wizard: a clean slate showing available devices.
  const applyRide = (): void => {
    resetAllFilters();
    setChecked("hide-unavailable", true);
    setSelect("choropleth-select", "");
    clearOverlays();
    setDrawer(null);
  };

  const applyAnalysis = (): void => {
    resetAllFilters();
    setSelect("choropleth-select", "v1");
    setDrawer("compliance");
  };

  /** Swap the visible surface: ride hides the analysis tabs (Account stays)
   *  and reveals the HUD button; the map container also resizes when the
   *  wizard docks as a side panel on small screens. */
  const setRideSurface = (on: boolean): void => {
    rideActive = on;
    leanFetch = on; // riders get the lean payload; analysis gets extras
    document.body.classList.toggle("mode-ride", on);
    map.resize();
  };

  // The map only reserves the right strip while the wizard is actually
  // docked (mobile). Once the interview hands off to the ranked list the
  // wizard hides, so drop the reservation and resize — otherwise the map
  // stays shrunk and leaves an empty white bar where the panel used to be.
  const setWizardDocked = (on: boolean): void => {
    document.body.classList.toggle("wizard-open", on);
    map.resize();
  };

  // Filters as they stood when ride mode was entered. Snapshotted BEFORE
  // wizard.start() — onConsentGranted fires applyRide() (a resetAllFilters)
  // at step one, so by interview time the live state is already gone. The
  // summary string is captured alongside for the same reason. Restored by
  // option 4 (before the ranking runs) and unconditionally on exit.
  let rideEntrySnapshot: FilterSnapshot | null = null;
  let rideEntrySummary = "";

  const wizard = new RideWizard(need("ride-wizard"), locate, {
    onConsentGranted: () => applyRide(),
    onExit: () => exitRide(),
    onLoginHint: () => {
      const tab = document.querySelector<HTMLButtonElement>(
        '.drawer-tab[data-drawer="account"]',
      );
      if (!tab || tab.classList.contains("is-active")) return;
      // The hint is asking them to sign in, so open on the doors. Only stamp
      // it when we are actually about to click, so the hint can't be left
      // behind to hijack some later, unrelated open.
      tab.dataset.accountTab = "login";
      tab.click();
    },
    filterSummary: () => rideEntrySummary,
    // Interview finished: the Recommended Devices drawer takes over as the
    // home of the ranked list (and keeps re-ranking with the filters).
    onInterviewDone: (priority, typeChoice, from, carryOverFilters) => {
      setWizardDocked(false);
      const finish = (): void => {
        recommended?.setContext({ from, priority, typeChoice });
        setDrawer("recommended");
      };
      if (carryOverFilters && rideEntrySnapshot) {
        // Option 4: re-apply the mode-entry snapshot BEFORE the ranking
        // runs — rankDevices() already ranks over visibleFeatures(), so
        // restoring the filters is the whole feature.
        const snap = rideEntrySnapshot;
        void applyFilterSnapshot(snap).then(finish);
      } else {
        finish();
      }
    },
  });

  const exitRide = (): void => {
    if (!rideActive) return;
    closeAllPopups();
    if (wizard.isOpen()) wizard.close();
    setWizardDocked(false);
    setRideSurface(false);
    applyNormal();
    // ALWAYS restore the filters as they stood on entry — option 4 or not.
    // Merely visiting Find wheels must never destroy the analysis setup,
    // and a wiped exit also poisons the next visit's snapshot (the likely
    // shape of the option-4 bug reported on PR #37).
    if (rideEntrySnapshot) {
      void applyFilterSnapshot(rideEntrySnapshot);
    }
    rideEntrySnapshot = null;
    // Recommendations are scoped to one Find-a-ride session: drop them so
    // re-entering never shows a stale list from the prior location/answers.
    recommended?.clear();
    setActive("analysis");
    // Ride-mode ticks fetched the lean payload; refresh now so analysis
    // tools (hex density, battery rankings) get their fields back promptly.
    requestRefresh();
  };

  const enterRide = (): void => {
    closeAllPopups();
    // Re-tapping the active Find-wheels button restarts the wizard, but
    // must NOT re-snapshot: applyRide() already wiped the live state on
    // first entry, so a second capture would replace the rider's analysis
    // setup with the wipe — the exact loss the snapshot exists to prevent.
    if (!rideActive) {
      rideEntrySnapshot = snapshotFilters();
      rideEntrySummary = filterSummary();
    }
    setDrawer(null);
    setRideSurface(true);
    setActive("ride");
    wizard.start();
    setWizardDocked(true);
  };

  // Which mode the bar returns to when the HUD closes (End Ride, summary
  // Done, or BRB) — captured when the HUD opens, since the HUD covers the
  // bar and a "selected" Ride button is never actually seen.
  let hudReturnMode: string | null = "analysis";
  rideHud.setOnHidden(() => setActive(hudReturnMode));

  for (const btn of btns) {
    btn.addEventListener("click", () => {
      switch (btn.dataset.mode) {
        case "riding":
          // 🧭 now opens the Screens 1–6 wizard by default (frontend plan,
          // "Entry" — F3 flips this on unconditionally; no dev-flag gate
          // here) UNLESS a tracked ride is already live, in which case a
          // second tap must resume the HUD (whose paused path resumes
          // correctly) instead of opening a fresh wizard over a running ride
          // — `ride-session.ts`'s own `open` reducer guard rejects exactly
          // that anyway, but the button should never even attempt it.
          // "Live" (`isLiveRideEntry`) covers both a same-tab BRB'd ride
          // (the HUD's own `paused` flag) and the session doc still reading
          // `riding`/`countdown` (e.g. right after a reload, before the
          // tracking-integration lane's resume flow has re-attached the HUD).
          closeAllPopups();
          if (isLiveRideEntry(rideHud.isPaused(), rideSession.current()?.state)) {
            hudReturnMode =
              btns.find(
                (b) =>
                  b.classList.contains("is-active") && b.dataset.mode !== "riding",
              )?.dataset.mode ?? null;
            setActive("riding");
            rideHud.open();
          } else {
            openRideModal();
          }
          break;
        case "ride":
          enterRide();
          break;
        default:
          closeAllPopups();
          if (rideActive) {
            exitRide(); // back to a normal map — no surprise choropleth
          } else {
            applyAnalysis();
            setActive("analysis");
          }
      }
    });
  }
}

// ---------- Equity ranks ----------

// Rank toggles (1–6, default 1+2) drive a live "% of the fleet in the
// selected ranks" estimate and the "Equity Ranking (Selected)" map overlay.
// The two overlay checkboxes (one in Areas, one beside the toggles) mirror
// each other and the underlying overlay state.
function wireEquityRanks(): void {
  const rankBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#rank-toggles .rank-btn"),
  );
  const overlayInputs = [
    need<HTMLInputElement>("equity-selected-overlay"),
    need<HTMLInputElement>("equity-selected-overlay-mirror"),
  ];

  const syncRankButtons = () => {
    const selected = equity.getSelected();
    for (const btn of rankBtns) {
      const on = selected.has(Number(btn.dataset.rank) as EquityRank);
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  };
  syncRankButtons();

  for (const btn of rankBtns) {
    btn.addEventListener("click", async () => {
      const rank = Number(btn.dataset.rank) as EquityRank;
      const nowOn = !equity.getSelected().has(rank);
      btn.disabled = true;
      try {
        await equity.toggleRank(rank, nowOn);
      } finally {
        btn.disabled = false;
      }
      syncRankButtons();
    });
  }

  const setOverlay = async (visible: boolean, source: HTMLInputElement) => {
    for (const input of overlayInputs) input.checked = visible;
    source.disabled = true;
    try {
      await equity.setOverlayVisible(visible);
    } finally {
      source.disabled = false;
    }
  };
  for (const input of overlayInputs) {
    input.addEventListener("change", () => void setOverlay(input.checked, input));
  }
}

function renderEquityMetric(): void {
  const el = document.getElementById("equity-rank-metric");
  if (!el) return;
  const selected = [...equity.getSelected()].sort((a, b) => a - b);
  if (selected.length === 0) {
    el.textContent = "Select one or more ranks to estimate.";
    return;
  }
  const { percent, inside, total } = equity.estimate();
  const ranks = `Ranks ${selected.join(", ")}`;
  if (percent === null) {
    el.textContent = equity.isUnavailable()
      ? "Equity-rank boundaries aren't published yet — check back once the city map is live."
      : `${ranks}: computing…`;
    return;
  }
  el.innerHTML =
    `<strong>${percent.toFixed(1)}%</strong> of devices are in ` +
    `<span class="equity-metric__ranks">${ranks}</span> right now ` +
    `<span class="equity-metric__count">(${inside.toLocaleString()} of ${total.toLocaleString()})</span>`;
}

function wireDrawers(): void {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".drawer-tab"),
  );
  const drawers = new Map<string, HTMLElement>();
  for (const tab of tabs) {
    const id = tab.dataset.drawer;
    if (!id) continue;
    const drawer = document.getElementById(`drawer-${id}`);
    if (drawer) drawers.set(id, drawer);
  }

  let active: string | null = null;

  const setActive = (id: string | null): void => {
    active = id;
    for (const tab of tabs) {
      const isActive = tab.dataset.drawer === id;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-pressed", String(isActive));
    }
    for (const [drawerId, drawer] of drawers) {
      const open = drawerId === id;
      drawer.classList.toggle("is-open", open);
      drawer.setAttribute("aria-hidden", String(!open));
    }
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const id = tab.dataset.drawer ?? null;
      setActive(active === id ? null : id);
    });
  }

  for (const drawer of drawers.values()) {
    const closeBtn = drawer.querySelector<HTMLButtonElement>(".drawer-close");
    closeBtn?.addEventListener("click", () => {
      const id = drawer.id.replace(/^drawer-/, "");
      setActive(null);
      // Return focus to the tab so keyboard users don't lose their place.
      const tab = tabs.find((t) => t.dataset.drawer === id);
      tab?.focus();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && active) {
      const lastActive = active;
      setActive(null);
      const tab = tabs.find((t) => t.dataset.drawer === lastActive);
      tab?.focus();
    }
  });
}

// ---------- Freshness pill mobile collapse ----------

// On narrow screens the three-line pill shrinks to just the status dot;
// tapping expands it for a few seconds. Expansion is tap-triggered and
// collapse is idle-triggered (never tap-toggled) so a stray second tap
// can't flicker it shut while someone is reading.
function wireFreshnessCollapse(): void {
  const root = need("freshness");
  const modeSwitch = need("mode-switch");
  const mq = window.matchMedia("(max-width: 640px)");
  let expanded = false;
  let idleTimer: number | undefined;

  const sync = (): void => {
    root.classList.toggle("freshness--collapsed", mq.matches && !expanded);
    // While the pill is tap-expanded, its three lines of text can reach
    // well past the mode pill's own footprint — lift the pill clear rather
    // than let it sit on top of (and hide) that text. Read the freshness
    // pill's live rendered height instead of hardcoding one: the class
    // toggle above already applied, so this reflects the current expanded
    // or collapsed size exactly, including whatever the actual device
    // counts/timestamp text needs.
    const lifted = mq.matches && expanded;
    modeSwitch.style.setProperty(
      "--freshness-lift",
      lifted ? `${Math.ceil(root.getBoundingClientRect().height) + 10}px` : "0px",
    );
  };
  const scheduleCollapse = (): void => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      expanded = false;
      sync();
    }, 6_000);
  };

  root.addEventListener("click", () => {
    if (!mq.matches) return;
    expanded = true;
    sync();
    scheduleCollapse();
  });
  mq.addEventListener("change", () => {
    expanded = false;
    window.clearTimeout(idleTimer);
    sync();
  });
  sync();
}

// ---------- Account drawer ----------

// Renders the Account drawer body based on map-auth state and keeps the
// expiry countdown live. Also wires sign-in / sign-out handlers.
function wireAccount(): void {
  const body = document.getElementById("account-body");
  if (!body) return;

  let countdownTimer: number | undefined;
  // Backend sign-in capabilities (null until /auth/config resolves).
  let authCfg: AuthConfig | null = null;
  // Handle for the signed-in panel (account.ts); null while signed out.
  let signedIn: AccountHandle | null = null;
  // Handle for the sign-in doors (account-login.ts); null while signed in.
  let loginPanel: LoginPanelHandle | null = null;
  // Handle for the Local Data tab; null until it has been built.
  let localData: LocalDataHandle | null = null;
  // Key of the state the current DOM was built for. Same key → refresh in
  // place instead of rebuilding, so the minute tick and focus events don't
  // destroy open editors or a half-typed sign-in form.
  let renderedKey: string | null = null;
  // Sign-in form state that must survive the one legitimate signed-out
  // rebuild (auth-config resolving): a typed address and an already-sent
  // code. Codes are 3/hour per email — wiping one is expensive.
  const signedOutState = { email: "", sentEmail: "", phone: "", sentPhone: "" };

  // Why the gate line is a status region: activating a dimmed tab has to say
  // something, and a disabled control that silently ignores you is worse than
  // no control at all.
  const gateHint = document.createElement("p");
  gateHint.className = "account-hint account-gate-hint";
  gateHint.setAttribute("role", "status");
  gateHint.hidden = true;

  // The strip is built ONCE and never torn down: render() below replaces
  // panel CONTENTS, so the rider's chosen tab survives both the auth-config
  // rebuild and a token change, exactly as signedOutState survives them.
  const tabs = createAccountTabs(body, {
    initial: takeTabHint() ?? "login",
    onShow: (id) => {
      gateHint.hidden = true;
      // GIS needs a laid-out container, so a Login panel that was hidden at
      // build time gets its button on first show.
      if (id === "login") loginPanel?.renderGoogle();
      // The drawn route belongs to this tab; leaving it should take the line
      // off the map with it.
      if (id === "local") void localData?.refresh();
      else localData?.clearSelection();
    },
    onBlocked: (id) => {
      const what = id === "local" ? "Local Data" : id === "profile" ? "Profile" : "Community";
      gateHint.textContent = `Sign in to use ${what}.`;
      gateHint.hidden = false;
    },
  });
  tabs.panel("login").prepend(gateHint);

  const buildSignedOut = (): void => {
    loginPanel = buildLoginPanel(tabs.panel("login"), {
      cfg: authCfg,
      state: signedOutState,
      // The session is persisted by the door itself; reload so every fetch
      // picks up the bearer token — landing on Profile, which is what a
      // brand-new account most needs filled in.
      onSignedIn: () => {
        writeTabHint("profile");
        location.reload();
      },
    });
    if (tabs.selected() === "login") loginPanel.renderGoogle();
  };

  const render = (): void => {
    window.clearTimeout(countdownTimer);
    const auth = getAuth();
    const key = auth ? `in:${auth.token}` : `out:${authCfg ? 1 : 0}`;
    if (key === renderedKey) {
      // Same state — update the countdown in place; nothing rebuilds, so
      // open editors and half-typed forms survive.
      signedIn?.refresh();
    } else {
      renderedKey = key;
      signedIn?.dispose();
      signedIn = null;
      loginPanel?.dispose();
      loginPanel = null;
      localData?.dispose();
      localData = null;
      for (const id of ACCOUNT_TAB_IDS) tabs.panel(id).replaceChildren();
      tabs.panel("login").append(gateHint);
      gateHint.hidden = true;

      const on = !!auth;
      tabs.setEnabled("profile", on);
      tabs.setEnabled("community", on);
      tabs.setEnabled("local", on || !GATE_LOCAL_TAB_ON_AUTH);
      if (!tabs.isEnabled(tabs.selected())) tabs.select("login", { force: true });

      if (auth) {
        signedIn = renderSignedInAccount(tabs.panel("login"), auth, {
          setAdminSession: (on2) => devices.setAdminSession(on2),
          // A rejected token has already been cleared from storage;
          // re-running render() lands in the signed-out branch.
          onAuthLost: () => render(),
          pickLocation: (kind) =>
            mapPick.pick({
              hint:
                kind === "home"
                  ? "Tap the map to set your home"
                  : "Tap the map to set your work",
            }),
          onLocationsChanged: (points) => homeWorkPins.set(points),
          onCompletenessChanged: (complete) =>
            tabs.setFlagged("profile", !complete),
          // Null until /auth/config resolves — the row treats unknown as
          // "don't offer yet" rather than flashing a button that may vanish.
          smsEnabled: () => authCfg?.smsEnabled ?? null,
          panels: {
            login: tabs.panel("login"),
            profile: tabs.panel("profile"),
            community: tabs.panel("community"),
          },
        });
      } else {
        buildSignedOut();
      }

      if (tabs.isEnabled("local")) {
        localData = buildLocalDataPanel(tabs.panel("local"), {
          // main.ts's lazy singleton — never a second openTrackStore(), which
          // would read an empty in-memory store when IndexedDB is missing.
          getTrackStore,
          route: trackRoute,
          isSignedIn: () => !!getAuth(),
        });
        if (tabs.selected() === "local") void localData.refresh();
      }
    }
    // Re-check once a minute while signed in: keeps the countdown current
    // and notices local expiry (getAuth() self-clears past `expires`).
    if (auth) countdownTimer = window.setTimeout(render, 60_000);
  };

  // Deep links: whoever opens the drawer can name the tab it should land on
  // by stamping the trigger first (the leaderboard's "Open profile" wants
  // Community, the ride wizard's sign-in hint wants Login).
  const accountBtn = document.querySelector<HTMLElement>(
    '.topbar__right .drawer-tab[data-drawer="account"]',
  );
  accountBtn?.addEventListener("click", () => {
    const want = accountBtn.dataset.accountTab as AccountTabId | undefined;
    delete accountBtn.dataset.accountTab;
    if (want) tabs.select(want);
  });

  // The strip pins below the drawer's own sticky header, which means it needs
  // that header's height. Measure it rather than hard-coding a number that
  // would drift with the font or the breakpoint.
  const drawer = document.getElementById("drawer-account");
  const header = drawer?.querySelector<HTMLElement>(".drawer-header");
  if (drawer && header) {
    const syncHeaderHeight = (): void => {
      const h = header.getBoundingClientRect().height;
      if (h > 0) drawer.style.setProperty("--drawer-header-h", `${Math.round(h)}px`);
    };
    syncHeaderHeight();
    // The height is only measurable once the drawer is actually laid out.
    accountBtn?.addEventListener("click", () => {
      window.requestAnimationFrame(syncHeaderHeight);
    });
    window.addEventListener("resize", syncHeaderHeight);
  }

  render();

  // The Google door is driven by the backend's /auth/config (single source of
  // truth). Fetch it once and re-render when it lands so the button appears or
  // stays hidden to match the server — no compile-time frontend flag.
  void loadAuthConfig().then((cfg) => {
    authCfg = cfg;
    render();
  });

  // If the session expires mid-tab (or apiFetch cleared it after a 401),
  // the visible state will drift. Re-check on focus so the UI catches up.
  window.addEventListener("focus", render);
}

// ---------- Refresh loop ----------

function startRefreshLoop(): void {
  let inFlight: AbortController | null = null;

  const tick = async () => {
    if (document.hidden) return;
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const resp = await fetchDevicesAuto(inFlight.signal, fetchIncludes());
      devices.setData(resp);
      equity.update(resp.features);
      const visible = devices.visibleFeatures();
      clusters.update(visible);
      freshness.update(
        resp.metadata.snapshot_time,
        visible.length,
        resp.metadata.device_count,
      );
      void overlays.refreshChoropleth();
      void hexDensity.refresh();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("refresh failed", e);
        freshness.error();
      }
    }
  };

  requestRefresh = () => void tick();
  setInterval(tick, REFRESH_MS);
  // Refresh immediately when the tab becomes visible again after being hidden.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void tick();
  });
}
