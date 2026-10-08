import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import "./stats.css";

import {
  fetchDevicesAuto,
  getActiveRide,
  getTrackedRide,
  type BoundaryLayer,
  type DeviceInclude,
  fetchProfile,
  claimDibsAsMine,
  liveDibs,
  registerDibs,
  releaseDibs,
  updateProfile,
  type SavedPlace,
} from "./api.ts";
import { createMap } from "./map.ts";
import { ALL_SELECTED, modelsOf } from "./model-filter.ts";
import {
  hasAnswers,
  isLiveIntent,
  rideButtonCopy,
  rideButtonIntent,
} from "./ride-reentry.ts";
import { initialTheme, mountThemeModes, startSunSync } from "./theme.ts";
import { RecenterControl } from "./recenter.ts";
import { wireMyDibs, type MyDibsHandle } from "./my-dibs.ts";
import { openDibsCertificate, showDibsAlertToast } from "./dibs-certificate.ts";
import { createDibsNotifier, requestDibsNotifications } from "./dibs-notify.ts";
import {
  Devices,
  DEVICE_INTERACTIVE_LAYERS,
  ALL_MODELS,
  MODELS_BY_RIDE_TYPE,
  gaugeColor,
  iconPreviewURL,
  whenModelIconsReady,
  hideMapTooltip,
  type ModelKey,
  modelKeyOf,
  type QualityFilter,
  type IconStyle,
  type ModelIcon,
  type DataSource,
  type GaugeDisplay,
  type GaugeThickness,
  type GaugePlacement,
  openFloatingModal,
  FIRST_DEVICE_LAYER,
} from "./devices.ts";
import { RecommendedDevices } from "./recommend.ts";
import { Overlays } from "./overlays.ts";
import { renderCompliance } from "./compliance.ts";
import { renderFleetStats } from "./fleet-stats.ts";
import { ensureRoverZoneLayers, setRoverZoneVisible } from "./rover-zone.ts";
import { fetchSurveyOptions, listTrackedRides, submitRiderStory } from "./api.ts";
import { mountStoryPanel, type StoryPanel } from "./rider-story-sheet.ts";
import { openComplianceCalendar } from "./compliance-calendar.ts";
import { Freshness } from "./freshness.ts";
import { Clusters } from "./clusters.ts";
import {
  AreaFilter,
  type AreaFilterElements,
  type AreaFilterState,
} from "./area-filter.ts";
import { FilterChips, type Chip } from "./filter-chips.ts";
import {
  FEATURE_FILTER_KEYS,
  openConfirmFeatures,
  type FeatureFilterKey,
} from "./device-features.ts";
import { Locate, distanceMeters } from "./locate.ts";
import {
  MicromobilityZones,
  type ZoneGroup,
} from "./micromobility-zones.ts";
import { requestLocationOnLoad } from "./locate-on-load.ts";
import { RideHud, type RideHudTrackControl } from "./ride-hud.ts";
import { RideWizard } from "./ride-wizard.ts";
import { EquityAreaMap } from "./equity-map.ts";
import { openEquityReceiptForm } from "./equity-receipt-form.ts";
import { equityAreaFeatures, isInEquityArea } from "./equity-areas.ts";
import { ensureBands } from "./map-bands.ts";
import { MapInspector, SPOT_INSPECT_TITLE, buildSpotHtml } from "./map-inspect.ts";
import { NUDGE_DELAY_MS, TripleTapNudge } from "./triple-tap-nudge.ts";
import {
  HexDensity,
  TERRITORY_HEX_SIZE,
  TERRITORY_METRIC,
  type HexSize,
  type HexMetric,
} from "./hexdensity.ts";
import { consumePendingMagicLink } from "./auth-magic-link.ts";
import { promptGoogleOneTap } from "./auth-google.ts";
import { loadAuthConfig, type AuthConfig } from "./auth-config.ts";
import { refreshSessionIfStale } from "./auth-session.ts";
import { openRideModal, wireRideModal } from "./ride-modal.ts";
import { wireRideDeepLink } from "./ride-deeplink.ts";
import { resolvePlate, sharedPlateIndex } from "./plates.ts";
import { vehicleDisplayName } from "./vehicle-name.ts";
import {
  createRideSessionStore,
  recoverRideSession,
  recoveryForServerConflict,
  type RideRecoveryDeps,
  type RideRecoveryNote,
  type RideRecoveryOutcome,
  type RideSessionStore,
  isRideLive,
  isPostRide,
  isWizardScreen,
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
import { createHomeBar, type HomeBarHandle } from "./home-bar.ts";
import { createTripPins } from "./trip-pins.ts";
import { startWalkLeg, type WalkLegHandle } from "./walk-leg.ts";
import { goneMessage, watchDevice, type DeviceWatchHandle } from "./device-watch.ts";
import { createArrivalPanel, type ArrivalPanelHandle } from "./arrival-panel.ts";
import { reportFailedStart } from "./ride-failed-start.ts";
import { plateFromQr, wireQrUtility } from "./qr-utility.ts";
import { openQrScanner } from "./qr-scan.ts";
import {
  qrRideAction,
  qrRideMessage,
  resolveScannedPlate,
  type ScannedVehicle,
} from "./qr-ride-scan.ts";
import { submitDeviceReport } from "./reports.ts";
import { learnFromReceipt } from "./cost-calibration.ts";
import { precheckReceipt } from "./receipt-precheck.ts";
import { buildTripPanel, type TripPanelHandle } from "./trip-panel.ts";
import { clearPendingTrip, peekPendingTrip } from "./pending-trip.ts";
import {
  activeTrip,
  endTrip,
  legDestination,
  legEndsAtHandOff,
  startTrip,
  tripComplete,
} from "./trip-legs.ts";
import {
  showMovedToast,
  wireDeviceNotifyPanel,
  type DeviceNotifyPanelHandle,
} from "./device-notify-panel.ts";
import {
  WATCH_RULES,
  createDeviceNotifier,
  isWatched,
  loadWatches,
  requestMovedNotifications,
  unwatchMoved,
  watchMoved,
  watchSlotsLeft,
  type DeviceNow,
} from "./device-notify.ts";
import {
  wireRideSpecPanel,
  type RideSpecPanelHandle,
} from "./ride-spec-panel.ts";
import {
  callDibs,
  dibsExpiresAt,
  dibsOn,
  dropDibs,
  recordProgress,
  saveDibs,
  type Dibs,
  loadDibs,
} from "./dibs.ts";
import { autoDibs, dibsSmsAlerts } from "./dibs-prefs.ts";
import {
  setPendingTrip,
  takePendingTrip,
  type TripPlace,
} from "./pending-trip.ts";
import {
  saveCorrection,
  savedCorrection,
  spansOf,
} from "./free-minutes-control.ts";
import type { RideSpan } from "./free-minutes.ts";
import { createPlanListPanel, type PlanListPanelHandle } from "./plan-list-panel.ts";
import { defaultSpec, specSummary, type RideSpec } from "./ride-spec.ts";
import {
  TWO_PASSENGER_MIN_BATTERY,
  TWO_PASSENGER_MODELS,
  applyTwoPassengers,
  conflictsWithSpec,
  setTwoPassengers,
  twoPassengerNote,
  twoPassengers,
} from "./passenger-mode.ts";
import {
  applyInterview,
  interviewNote,
  type InterviewAnswers,
} from "./interview-spec.ts";
import { MODEL_NAMES } from "./model-catalog.ts";
import type { PlanRow } from "./plan-list.ts";
import {
  planningFreeMinuteEstimate,
  searchPlans,
  type PlanSearchDeps,
} from "./plan-search.ts";
import { browserVoiceDeps, createRideVoice } from "./ride-voice.ts";
import { currentTaxRate, effectiveRatePlan, planFor } from "./ride-cost.ts";
import { createTrackRoute } from "./track-route.ts";
import { createRideTrail } from "./ride-trail.ts";
import { createRideRouteLine } from "./ride-route-line.ts";
import { createRoutePreview } from "./route-preview.ts";
import { openAnalyticsReport } from "./admin-analytics.ts";
import {
  buildLocalDataPanel,
  type LocalDataHandle,
} from "./account-local-data.ts";
import { createHomeWorkPins } from "./home-work-pins.ts";
import { readSlot } from "./favorite-slots.ts";
import {
  buildInRidePanel,
  type InRidePanelHandle,
} from "./account-inride.ts";
import {
  buildNavPanel,
  type NavPanelHandle,
} from "./account-nav.ts";
import {
  startSavedPlacesSync,
  syncSavedPlacesFromProfile,
} from "./saved-places-sync.ts";
import {
  ACCOUNT_TAB_IDS,
  createAccountTabs,
  takeTabHint,
} from "./account-tabs.ts";
import { pointInAny, type IndexedFeature } from "./geo.ts";
import { OVERLAY_BY_LAYER, OVERLAYS, RATE_PLANS, REFRESH_MS } from "./config.ts";
import { getAuth, isAuthenticated } from "./map-auth.js";
import { initInstallPrompt } from "./install-prompt.ts";
import { installUndoFreeTyping } from "./ios-shake-undo.ts";
import {
  initChrome,
  installBrandMark,
  setRibbonOpen,
  yieldRibbonToDrawer,
  restoreRibbonAfterDrawer,
  closeAllPopups,
  registerPopupCloser,
} from "./chrome.ts";
import {
  effectiveModels,
  wireFilterPresets,
  type FilterSnapshot,
} from "./filter-presets.ts";
import {
  initTelemetry,
  setAuthState,
  setTelemetryOptOut,
  telemetryOptedOut,
  track,
} from "./telemetry.ts";
import {
  wireLeaderboardPanel,
  type LeaderboardPanelHandle,
} from "./leaderboard-panel.ts";
import {
  maybeShowOnboarding,
  showOnboarding,
  type OnboardingHooks,
} from "./onboarding.ts";
import { showTipOnce } from "./discovery-tips.ts";

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

/** Local ride tracks are recorded without an account (a private ride has no
 *  server ride id at all), so gating this tab on sign-in hid a guest's own
 *  recordings from them — including the only control that deletes one, and
 *  (once the standing preference moved here) the only switch that stops the
 *  recording in the first place. A guest could be recorded with no way to
 *  look at it, delete it, or turn it off.
 *
 *  So: OFF. The tab is reachable signed out. Nothing behind it leaks anything
 *  — every track it lists was recorded by this device and never left it, and
 *  the one action that does upload (donate) is gated separately on
 *  `isSignedIn`, which the panel already takes as a dep.
 *
 *  Kept as a named constant rather than deleted: it is the honest record of a
 *  decision that was made deliberately in both directions. */
const GATE_LOCAL_TAB_ON_AUTH = false;

const theme0 = initialTheme();
document.documentElement.dataset.theme = theme0;
const { map, geolocate } = createMap("map", theme0);
// No ThemeControl on the map any more. Theme is a preference about the app,
// not a control that moves you around the map, and it now lives in the
// Account drawer's header as three named modes — see `mountThemeModes`.
initChrome();
installBrandMark();
setAuthState(isAuthenticated());
initTelemetry();
// About drawer's "Allow private analytics" switch — a purely local choice,
// meaningful signed-in or out, so it lives outside wireAccount().
{
  const toggle = document.getElementById(
    "about-telemetry-toggle",
  ) as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = !telemetryOptedOut();
    toggle.addEventListener("change", () => {
      setTelemetryOptOut(!toggle.checked);
    });
  }
}
if (import.meta.env.DEV) (window as unknown as { __map: unknown }).__map = map;
const locate = new Locate(map, geolocate);

// Recenter goes in the same top-left corner as geolocate, so chrome.ts adopts
// both into the top bar's left cluster and they read as one pair: "am I
// locating" and "put me back in the middle". It hides itself when it has
// nothing to do — see recenter.ts.
//
// Registered AFTER `locate` exists, not up beside the map's other controls:
// addControl runs onAdd synchronously, and onAdd subscribes to locate.onFix,
// so registering it earlier hit the const's temporal dead zone and threw
// before the map ever rendered. Typechecked fine; only running it showed it.
map.addControl(
  new RecenterControl({
    current: () => locate.current(),
    onFix: (cb) => locate.onFix(() => cb()),
  }),
  "top-left",
);
const devices = new Devices(map, locate);
// The rider's Home and Work on the map. Drawn from the favourite SLOTS — the
// only place either is set — rather than from the profile's `home_lat` /
// `work_lat` columns, which is what they used to follow. Two consequences, both
// wanted: a SIGNED-OUT rider gets their pins, which they never did before
// despite the slots having always worked without an account; and the pins
// cannot disagree with the rows that fill them.
const homeWorkPins = createHomeWorkPins(map);
/** Repaint the pins from the slots. Called at boot and whenever a favourite
 *  changes — there is nothing to fetch, so there is nothing to await. */
function syncHomeWorkPins(): void {
  const point = (slot: { place: { lat: number; lon: number } | null }) =>
    slot.place ? { lat: slot.place.lat, lng: slot.place.lon } : null;
  homeWorkPins.set({ home: point(readSlot("home")), work: point(readSlot("work")) });
}
const trackRoute = createTrackRoute(map);
// Two different jobs, two different sets of layers on the same map (see
// ride-trail.ts's header): `trackRoute` draws a FINISHED ride from the account
// drawer's Local Data tab and frames the camera around it; `rideTrail` is the
// live breadcrumb ride mode draws under the rider, fix by fix, while the
// follow-cam owns the camera.
const rideTrail = createRideTrail(map);
// The third set of route-shaped layers on this map: the PLANNED pathway the
// Screen 7 nav overlay is guiding along, drawn beneath `rideTrail`'s live
// breadcrumb so where-you've-been covers where-you-should-go.
const rideRouteLine = createRideRouteLine(map);
// Screen 4's route choices, drawn on this same map behind the wizard's
// bottom sheet (ride-screen-routes.ts's sheet presentation).
const routePreview = createRoutePreview(map);
// The destination/start pins the home bar puts on the map.
const tripPins = createTripPins(map);
// The walk to the scooter, drawn with the same module as the ride route but
// its own source ids and its own colour — see ride-route-line.ts's prefix.
const walkLine = createRideRouteLine(map, "walk-route");
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
// The city's official Equity Area map: the polygon overlay (off by
// default) and the on-screen "$0.13/min" indicator. Replaces the equity-rank
// estimator, whose whole premise — that the city hadn't said which ranks
// bind the SLA — stopped being true in August 2026.
const equityAreas = new EquityAreaMap(
  map,
  need("equity-indicator"),
  (t, b, onOpen) => openFloatingModal(t, b, onOpen),
  () => openEquityReceipt(),
);
/** "Didn't get the discount?" — the receipt form, opened from the explainer.
 *  The explainer closes first: the form is the next step, and two stacked
 *  dialogs would each want Escape. A function declaration, and only ever
 *  called from a click, so nothing it reads can be in its TDZ at startup. */
function openEquityReceipt(): void {
  document
    .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")
    ?.click();
  openEquityReceiptForm({
    isSignedIn: () => isAuthenticated(),
    openSignIn: () => {
      const tab = document.querySelector<HTMLButtonElement>(
        '.topbar__right .drawer-tab[data-drawer="account"]',
      );
      if (!tab || tab.classList.contains("is-active")) return;
      tab.dataset.accountTab = "login";
      tab.click();
    },
    pickOnMap: (hint) => mapPick.pick({ hint }),
    // §11.2: the receipt is the only place Veo's own billed minutes ever reach
    // us, so a filed one is the chance to learn what our clock has been
    // missing. The form has a plate and a charge date and cannot match either
    // to a ride; this can, and refuses to guess when the day held more than
    // one. Fire-and-forget: a rider filing a receipt is not waiting on our
    // cost estimate, and a failed rides fetch must not turn into an error on
    // a form that already succeeded.
    // The local pre-check: run §8.4's bar over what the rider typed, before
    // the receipt image is uploaded. A receipt whose own figures match the
    // Equity Area rate has nothing to claim, so there is nothing to spend a
    // phone connection and eighteen months of storage on — and nothing for a
    // server to read, which is the cost this saves.
    precheck: async (facts) => {
      const start = facts.pinStart;
      const end = facts.pinEnd;
      let inArea: boolean | null = null;
      if (start !== null || end !== null) {
        try {
          const zones = await equityAreaFeatures();
          inArea =
            (start !== null && pointInAny(start.lng, start.lat, zones)) ||
            (end !== null && pointInAny(end.lng, end.lat, zones));
        } catch {
          // Left as null: "we did not look", which sends.
        }
      }
      return precheckReceipt({
        minutes: facts.minutes,
        totalCents: facts.totalCents,
        startedOrEndedInArea: inArea,
        // The rider's own declared tier. `unknown` resolves to null, which is
        // `tier_unresolved` — and that sends, because without a tier there is
        // no expected charge to compare against.
        rate: RATE_PLANS.find((p) => p.key === facts.declaredRatePlan) ?? null,
        taxRate: currentTaxRate(),
      });
    },
    onReceiptFiled: (facts) => void learnFromFiledReceipt(facts),
    returnFocusTo: document.getElementById("equity-indicator"),
  });
}

/** Turn a filed receipt into a calibration sample, or do nothing.
 *
 *  Signed out there is no rides list to match against, which is also when
 *  there are no tracked rides to have a receipt for. */
async function learnFromFiledReceipt(facts: {
  veoMinutes: number;
  chargeDate: string;
}): Promise<void> {
  if (!isAuthenticated()) return;
  try {
    const { rides } = await listTrackedRides({ limit: 40 });
    learnFromReceipt({
      spans: spansOf(rides),
      chargeDate: facts.chargeDate,
      veoMinutes: facts.veoMinutes,
    });
  } catch {
    // Nothing to report and nothing to retry: the next receipt is another
    // chance, and the calibration refuses to act on one sample anyway.
  }
}
/** Denver's own slow / no-parking / no-ride zones (DOTI, via a CORA request).
 *  See `micromobility-zones.ts` for the provenance and for what the city's
 *  rulebook does and does not tell us. */
const zones = new MicromobilityZones(map, fetch, (t, b) => openFloatingModal(t, b));
const hexDensity = new HexDensity(map, need("hexbin-legend"), {
  // The territory readout's "claim your colors" hint lands on Community,
  // where the ruling colors it's pointing at actually live.
  openProfile: () => {
    const btn = document.querySelector<HTMLElement>(
      '.topbar__right .drawer-tab[data-drawer="account"]',
    );
    if (!btn) return;
    btn.dataset.accountTab = "community";
    btn.click();
  },
});
// Hex density and the region choropleth both shade the map by count, so only
// one runs at a time — turning one on clears the other. Assigned by their
// wire functions.
let clearChoropleth: () => void = () => {};
let clearHexDensity: () => void = () => {};
// 🏆 Set Territory Control on or off from outside the Areas drawer (the
// Leaderboard panel's switch). Assigned by wireHexDensity() — the seg
// buttons and the metric <select> are its state, so it has to drive them
// rather than the HexDensity instance directly, or the two controls would
// disagree about what the map is showing.
let setTerritoryShading: (on: boolean) => void = () => {};
/** The two gated doors to a move-watch, assigned inside `map.on("load")` once
 *  the notifier and the Tools panel exist. Module-level for the same reason
 *  `resumeLiveRide` is: the callers are a device-popup handler and Screen 8,
 *  neither of which can reach into that closure.
 *
 *  Both default to refusing, which is the right default for a capability whose
 *  whole design is about not being available by accident. */
let armDibsWatch: (claim: Dibs) => string | null = () => null;
let armRideEndWatch: (
  vehicleIdentifier: string,
  name: string,
  at: { lat: number; lon: number },
) => boolean = () => false;
let leaderboardPanel: LeaderboardPanelHandle | null = null;
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
// Tools drawer: confirm features for a scooter identified by its QR code
// alone — no map tap, no vehicle preselected. The scan is mandatory (it is
// the only statement of WHICH scooter), so the modal opens in requireQr
// mode; status is unknowable until the server resolves the scan, and the
// modal hides its status badge when no vehicle is passed.
need<HTMLButtonElement>("tools-confirm-qr").addEventListener("click", () => {
  openConfirmFeatures({
    requireQr: true,
    status: "needs_features_confirmed",
  });
});
// The ribbon's QR tool: one scan, a dial in front of it deciding what the scan
// does. See `qr-utility.ts` for why it is a dial and not two buttons, and
// `qr-ride-scan.ts` for the four things a scan can mean to a ride. The listener
// itself lives over there behind `wireQrUtility` — the house rule is one
// `wireX()` call per surface and no new top-level wiring in this module.
wireQrUtility({
  button: need<HTMLButtonElement>("ribbon-qr"),
  // Mode `features` hands the payload straight on and parses nothing: the
  // server resolves which scooter the scan names (`qr_raw_value` on the
  // feature report), which is why this mode works for a scooter that is not
  // in the live feed at all and the ride mode below does not.
  onConfirmFeatures: (rawValue) => {
    track("qr_utility", { mode: "features" });
    openConfirmFeatures({
      requireQr: true,
      status: "needs_features_confirmed",
      prefillQr: rawValue,
    });
  },
  onRideScan: (rawValue) => handleQrRideScan(rawValue),
});
// Equity Compliance moved off the ribbon into Tools: the (hidden) ribbon
// tab still owns the drawer via wireDrawers, so opening it is one
// programmatic click — which also closes the Tools drawer, exactly like a
// visible tab switch would.
need<HTMLButtonElement>("tools-open-compliance").addEventListener("click", () => {
  // Hard-fail like need(): this button is the ONLY visible way into the
  // compliance drawer now, so a silently-missing tab would strand it.
  const tab = document.querySelector<HTMLButtonElement>(
    '.drawer-tab[data-drawer="compliance"]',
  );
  if (!tab) throw new Error("compliance drawer tab missing from the ribbon");
  tab.click();
});
// Public, unlike the admin reports below — the hourly fleet history is the
// same aggregate count the map footer already shows, just over time.
// The compliance calendar, reachable from two places on purpose: Tools,
// where a rider browsing what the app can do will find it, and inside
// Equity Compliance, where someone already reading today's number wants
// "and what about the other days".
for (const id of ["tools-compliance-calendar", "compliance-open-calendar"]) {
  need<HTMLButtonElement>(id).addEventListener("click", () => {
    openComplianceCalendar();
  });
}

need<HTMLButtonElement>("tools-devices-history").addEventListener("click", () => {
  openAnalyticsReport("devices");
});
need<HTMLButtonElement>("tools-admin-traffic").addEventListener("click", () => {
  openAnalyticsReport("traffic");
});
need<HTMLButtonElement>("tools-admin-events").addEventListener("click", () => {
  openAnalyticsReport("events");
});
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
/** The ideal-scooter bridge. Null when its markup is absent (a page that
 *  does not carry the Filters drawer). */
let rideSpecPanel: RideSpecPanelHandle | null = null;
/** The model selection, DERIVED (Phase 6 §6.3). This used to be a third copy
 *  of the filter — a module-level `Set` written only by the Filters drawer's
 *  toggle handler. Once the ride HUD's pills began writing the one shared
 *  selection, that copy went stale on every pill tap, and `snapshotFilters`
 *  reads it: an attached ride spec compares the live filters against its
 *  projection to decide whether the rider has edited it, so a stale snapshot
 *  left the spec claiming to show "only my ideal scooters" over a map the
 *  pills had changed underneath it.
 *
 *  Reading through `devices` instead makes that detach work by itself, which
 *  is what §6.4 means by reusing `noticeFilterChange` rather than inventing a
 *  second notion of "this no longer matches". */
function modelsOn(): ReadonlySet<ModelKey> {
  return modelsOf(devices.modelSelection_());
}
let minBatteryPct = 0;
let qualityOn: QualityFilter = "any";
let featuresOn: ReadonlySet<FeatureFilterKey> = new Set();
let lastAreaState: AreaFilterState | null = null;
// Chip-clear + preset hooks, assigned by their wire* functions.
/** "Notify me if moved", in the Tools drawer. Null until boot wires it. */
let notifyPanel: DeviceNotifyPanelHandle | null = null;

/** The thing that actually tells the rider. Created eagerly rather than at
 *  boot, because the bell's handler and the panel's Stop both need to clear its
 *  per-vehicle bookkeeping and neither should have to care whether a watch list
 *  has been painted yet. Holds only counters — nothing it does costs anything
 *  until a watch exists. */
const deviceNotifier = createDeviceNotifier({
  inApp: (message, watch) => showMovedToast(message, () => showMovedDevice(watch)),
  // Tapping the notification lands on the scooter it is about rather than a
  // cold map. Wherever it is NOW: the message deliberately carries no
  // coordinates, so this is the rider's way of finding out where it went.
  onOpen: (watch) => showMovedDevice(watch),
  // THE WATCH ENDS WITH THE ANSWER. The rider asked one question — has it gone
  // — and it has been answered; a watch left running would re-ask it about a
  // scooter that is now somewhere else entirely, and the comparison point it
  // was armed with is stale the moment the thing moves.
  onFired: (watch) => {
    unwatchMoved(watch.vehicleIdentifier);
    notifyPanel?.refresh();
    devices.refreshOpenPopup();
  },
});

/** Is this scooter already unavailable, and if so in the rider's words?
 *
 *  Null when it is parked and rentable, which is the only state a move-watch
 *  has anything to say about. Reads the same two flags the watcher does, and
 *  keeps them apart in the copy: `is_reserved` means IN USE on this operator
 *  (somebody is riding it), while `is_disabled` is the operator having pulled
 *  it — from the rider's side both mean "not yours to wait for", but they are
 *  not the same sentence and must not be told as one. */
function currentlyUnavailable(vehicleIdentifier: string): string | null {
  const f = devices
    .allFeatures()
    .find((x) => x.properties.vehicle_identifier === vehicleIdentifier);
  // Absent from the feed is not a reason to refuse: the popup was opened from
  // it, so this is a race with a refresh rather than a fact about the scooter.
  if (!f) return null;
  const p = f.properties as unknown as Record<string, unknown>;
  const truthy = (v: unknown): boolean => v === true || v === "true" || v === 1;
  if (truthy(p.is_reserved)) {
    return "Someone's riding this one right now — there's nothing to watch for yet.";
  }
  if (truthy(p.is_disabled)) {
    return "Veo isn't renting this one out at the moment, so there's nothing to watch for yet.";
  }
  return null;
}

/** Take the rider to a watched scooter — wherever it is NOW, falling back to
 *  where it was when the watch was armed. The alert carries no coordinates
 *  (`device-notify.ts`'s rule, and `ALONG_THE_WAY_PLAN` §4.4's), so this is how
 *  they find out where it went; a scooter that has left the feed entirely still
 *  gets them to the spot it left from, which is more use than nothing. */
function showMovedDevice(watch: { vehicleIdentifier: string; lat: number; lon: number }): void {
  const f = devices
    .allFeatures()
    .find((x) => x.properties.vehicle_identifier === watch.vehicleIdentifier);
  const at = f
    ? (f.geometry.coordinates as [number, number])
    : ([watch.lon, watch.lat] as [number, number]);
  map.easeTo({ center: at, zoom: 17 });
}
let clearModelFilter: () => void = () => {};
let clearFeatureFilter: () => void = () => {};
let clearBatteryMin: () => void = () => {};
let clearQualityFilter: () => void = () => {};
let setQualityFilter: (value: QualityFilter) => void = () => {};
let resetAllFilters: () => void = () => {};
// The lean payload (the API's low-end-phone diet) is for 3D NAVIGATION — the
// one remaining mode, where the phone is doing follow-cam work and nothing on
// screen can use the h3 or rank extras anyway. It used to follow the invisible
// find-a-ride mode instead, which meant merely opening the wizard silently
// changed what the map knew, and leaving it needed a refresh to get the fields
// back. Read live off the body class the HUD owns, so there is no second flag
// to keep in step.

/** Put the map's iconography back to its defaults. Kept — and now reachable
 *  only from the Analysis preset, which is a deliberate, rider-chosen action.
 *  It used to fire from `applyNormal()` whenever somebody merely LEFT the
 *  find-a-ride flow, which is how a rider's chosen icon style disappeared
 *  without them asking. Assigned by wireIconography. */
let resetIconography: () => void = () => {};

function fetchIncludes(): DeviceInclude[] {
  return document.body.classList.contains("ride-active") ? [] : ["h3", "ranks"];
}

const QUALITY_CHIP_LABEL: Partial<Record<QualityFilter, string>> = {
  "no-risk": "Hiding high-risk",
  "ok-only": "✓ Likely rideable",
};

const FEATURE_CHIP_LABEL: Record<FeatureFilterKey, string> = {
  bell: "🔔 Bell",
  basket: "🧺 Basket",
  cup_holder: "🥤 Cup holder",
  missing: "¯\\_(ツ)_/¯ Missing data",
};

/** One entry per live constraint — the chip label plus its clear hook.
 *  Three consumers, one label source: the floating chips, the preset name
 *  suggestion, and the wizard's carried-filters summary. */
function activeFilterChips(): Chip[] {
  const active: Chip[] = [];

  const pickedModels = modelsOn();
  if (pickedModels.size < ALL_MODELS.length) {
    // Capitalized key ≠ display name for the three-wheeler: the internal
    // key stays "trike" (presets/sprites/wire format) but riders know it
    // as the Rover.
    const names = [...pickedModels].map((m) =>
      m === "trike" ? "Rover" : m[0].toUpperCase() + m.slice(1),
    );
    active.push({
      id: "models",
      label: names.length ? `Models: ${names.join(", ")}` : "🚫 No models",
      onClear: clearModelFilter,
    });
  }

  if (featuresOn.size > 0) {
    // Iterate the canonical key list so the chip's order is stable no
    // matter the order the pills were tapped in.
    const labels = FEATURE_FILTER_KEYS.filter((k) => featuresOn.has(k)).map(
      (k) => FEATURE_CHIP_LABEL[k],
    );
    active.push({
      id: "features",
      label: labels.join(" + "),
      onClear: clearFeatureFilter,
    });
  }

  // THE CHIP MARKS THE EXCEPTION, NOT THE RULE. Hiding unavailable vehicles
  // is the default now, so a chip saying so would sit there permanently
  // announcing that nothing unusual is happening — which is how a chip row
  // stops being read. The chip appears only when a rider has turned the
  // default OFF, and clearing it restores the default.
  const hideCb = need<HTMLInputElement>("hide-unavailable");
  if (!hideCb.checked) {
    active.push({
      id: "availability",
      label: "+ Unavailable",
      onClear: () => setHideUnavailableControl(true),
    });
  }

  if (devices.reachFilterOn()) {
    active.push({
      id: "reach",
      label: "🔋 Can reach my destination",
      onClear: () => {
        const cb = need<HTMLInputElement>("reach-filter");
        cb.checked = false;
        cb.dispatchEvent(new Event("change"));
      },
    });
  }

  // Rude mode gets a chip for the same reason "+ Unavailable" does: it is a
  // departure from the default, and a rider who left it on last week should
  // be able to see that from the map rather than by opening a drawer.
  const rudeCb = need<HTMLInputElement>("ignore-dibs");
  if (rudeCb.checked) {
    active.push({
      id: "ignore-dibs",
      label: "😤 Ignoring dibs",
      onClear: () => {
        rudeCb.checked = false;
        rudeCb.dispatchEvent(new Event("change"));
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
 *  ≥ 50% · Likely rideable". Empty string when nothing is filtered. */
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
/** §11.1's voice, one per app. Built eagerly rather than per ride so the mute
 *  survives one — and because `createRideVoice` touches nothing until it is asked
 *  to speak: `browserVoiceDeps()` feature-detects and hands back nulls where a
 *  platform lacks either half.
 *
 *  Declared HERE, above `wireRideHud()`'s call, not beside the function: the
 *  call runs at module load and reads it, and a `const` read before its line
 *  is a ReferenceError that stopped main.ts before any vehicle was drawn
 *  (2026-10-07, ~11 h blank map). `main-boot-order.test.ts` fails on that
 *  ordering now, and `scripts/smoke.mjs` fails on the boot it produces. */
const rideVoice = createRideVoice(browserVoiceDeps());

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

// The HUD's equity-ride flags. These used to be the UNION of the two
// candidate maps (v1 ∪ v2) — the generous reading, chosen because the city
// had not said which one bound the contract and flagging a ride the rider
// might be owed a discount for beat missing one. The city has since said,
// so the union is no longer the honest answer: the official map is, and it
// is the same map the on-screen indicator and the compliance numbers use.
// equity-areas.ts caches the fetch, so a ride pays for it at most once.
function equityZones(): Promise<IndexedFeature[]> {
  return equityAreaFeatures();
}

function wireRideHud(): RideHud {
  return new RideHud(need("ride-hud"), equityZones, map, devices, {
    session: rideSession,
    trail: rideTrail,
    routeLine: rideRouteLine,
    voice: rideVoice,
    // §11.3's cliff, from the same estimate §2.2's control and the plan list use.
    // One source for the hour, so the warning and the plan prices cannot disagree
    // about it.
    //
    // NULL IN TWO CASES, and they are different reasons for the same silence:
    //
    //   * a tier with no allowance (four of the five), where the estimate itself
    //     is null. There is no cliff to warn about.
    //   * a SIGNED-OUT Access rider, whose estimate is the pessimistic zero. That
    //     figure is right for pricing — §2.2 argues for it — and wrong to speak
    //     aloud: "your free minutes are used up" said on every ride to somebody
    //     who may have a full hour is a confident false statement, and it trains
    //     them to ignore the one warning that matters. Silence is the honest
    //     version of a guess.
    //
    // A signed-in rider with a genuinely exhausted hour DOES get it, because that
    // figure was counted rather than assumed.
    freeMinutesAtStart: () => {
      const estimate = planningFreeMinuteEstimate(
        planSearchDeps(),
        planFor(effectiveRatePlan()),
      );
      if (estimate === null || estimate.basis === "signed_out") return null;
      return estimate.remainingMinutes;
    },
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
// three named modes in the Account drawer now; here we only resume it on boot.

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
  // The ranked list's Route button walks in-app rather than opening Google or
  // Apple Maps — the app ranked these for you; handing you to a different app
  // to reach the one you picked was the odd part.
  recommended.setWalkTo((req) => void beginWalkToVehicle(req));
  // The Recommended tab stays out of the menu until there is something in it.
  // `hidden` alone is not enough here — `.drawer-tab` sets
  // `display: inline-flex`, which has beaten `hidden` in this codebase
  // before — so the class carries it and `.drawer-tab[hidden]` backs it up.
  {
    const tab = document.querySelector<HTMLButtonElement>(
      '.drawer-tab[data-drawer="recommended"]',
    );
    if (tab) {
      recommended.setAvailabilityListener((hasList) => {
        tab.hidden = !hasList;
      });
    }
  }
}

map.on("load", async () => {
  // The pins add a source and three layers, so this cannot run before the
  // style exists — `createHomeWorkPins`'s `ensureLayers` calls `addSource`
  // unguarded and maplibre throws "Style is not done loading." Calling it at
  // module load took the whole boot down, and only a real browser showed it:
  // the previous code reached `set()` for the first time from a resolved
  // profile fetch, which could not possibly land this early.
  syncHomeWorkPins();
  // Ask for location now. Almost every number this app shows is relative to
  // where the rider is standing — the walk estimate on every popup, the
  // "worth the walk" ranking, the 75 m proximity gates, which scooter Screen 2
  // preselects — and until now all of it waited behind a button a first-time
  // visitor had no reason to press. `locate-on-load.ts` owns the three rules
  // (never re-ask a rider who declined, never ask twice, and a granted
  // permission must be silent); it never throws, so this is not awaited and
  // nothing below it depends on the answer.
  void requestLocationOnLoad({
    trigger: () => locate.trigger(),
    hasFix: () => locate.current() !== null,
  });
  devices.addLayers();
  // Open the area bands (map-bands.ts) right under the scooters before any
  // area layer exists, so zones > equity > territory however late each
  // one is first drawn.
  ensureBands(map);
  buildLayerToggles();
  wireModels();
  wireFeatureFilter();
  wireHideUnavailable();
  wireFilterAccordion();
  wireBatterySlider();
  wireQuality();
  wireQuickFilters();
  wireClearFilters();
  wireIconography();
  wireRecommended();
  wireChoropleth();
  wireHexDensity();
  wireMapInspector();
  // 🏆 Leaderboard panel. Must come after wireHexDensity() — that's what
  // assigns `setTerritoryShading`, which the panel's switch drives.
  leaderboardPanel = wireLeaderboardPanel(
    {
      toggle: need<HTMLInputElement>("leaderboard-territory-toggle"),
      mutedToggle: need<HTMLInputElement>("leaderboard-muted-toggle"),
      regionalBody: need("leaderboard-regional-body"),
      aboutBody: need("leaderboard-about-body"),
      scheduleBody: need("leaderboard-schedule-body"),
    },
    {
      setTerritory: (on) => setTerritoryShading(on),
      setTerritoryMuted: (muted) => hexDensity.setTerritoryMuted(muted),
    },
  );
  wireDrawers();
  // Theme, in the Account drawer's header above the tabs. Mounted for the
  // life of the page: the drawer's body is rebuilt on every auth change, and
  // a control that reset itself each time a rider signed in or out would be
  // the kind of flicker the header exists to avoid.
  mountThemeModes(need("theme-modes"));
  wireFreeRide();
  // §11.9: the subscription that offers the rest of the way once a leg
  // closes. Wired once at startup, like every other session watcher.
  wireNextLegHandoff();
  // The founder's note is collapsed by default; opening it is a real signal
  // about what people read on the About page, so it goes through our own
  // telemetry like every other interaction. `toggle` fires on close too —
  // only the open is interesting, and counting both would make the number
  // mean "interactions" rather than "reads".
  for (const id of ["about-founder", "about-caveats"]) {
    const acc = document.getElementById(id);
    if (acc instanceof HTMLDetailsElement) {
      acc.addEventListener("toggle", () => {
        if (acc.open) track("about_founder_open", { section: id });
      });
    }
  }
  // Ride-flow text fields apply their own edits so nothing lands in WebKit's
  // undo queue — see ios-shake-undo.ts for why a queue left non-empty means
  // an "Undo Typing" alert on every bump for the rest of the ride. One
  // delegated listener, installed for the life of the page: the wizard
  // rebuilds its screens constantly, and marked fields opt in as they mount.
  installUndoFreeTyping(document);
  const areaFilter = wireAreaFilter();
  applyFilterSnapshot = makeApplyFilterSnapshot(areaFilter);
  wireModes();
  // After wireModes: the home bar drives the (now hidden) mode buttons, so
  // their listeners have to exist before it can hand a trip to one.
  homeBar = wireHomeBar();
  // 🧭 Use in Ride Mode goes to the walk flow when a destination is already
  // known, and falls through to the preflight survey when it is not.
  devices.setRideInterceptor(beginWalkToVehicle);
  // Whose name goes on a certificate. The signed-in display name when there is
  // one, and an honest anonymous form when there is not — never a fabricated
  // identity, since the whole artifact is an assertion about who did what.
  devices.setDibsClaimant(() => dibsClaimant);
  // A signed-out rider is the common case and not an error — skip the fetch
  // rather than burning a guaranteed 401, same as ride-screen-dest does.
  if (isAuthenticated()) {
    void fetchProfile()
      .then(setDibsClaimantFromProfile)
      .catch(() => {
        /* the anonymous form is a fine certificate */
      });
  }
  wireFilterPresets({
    snapshot: snapshotFilters,
    apply: (s) => applyFilterSnapshot(s),
    suggestName: () => filterSummary() || "All devices",
  });
  // The ideal-scooter bridge rides the SAME seam as the presets — one
  // function to read the drawer, one to drive it — so there is no second
  // notion anywhere of what "the current filters" are.
  rideSpecPanel = wireRideSpecPanel({
    snapshot: snapshotFilters,
    apply: (s) => applyFilterSnapshot(s),
  });
  // THE SPEC REACHES THE RIDE (§6.4). Honouring it needs no wiring any more —
  // a spec projects onto the one model filter, and the HUD's pills read that
  // same value — but a rider opening the Show row to a selection they did not
  // make on this screen deserves to be told where it came from, and what the
  // next tap will detach. Read through a function, because a pill tap ends the
  // attachment while the HUD is still up.
  rideHud.setAttachedSpecName(() => rideSpecPanel?.activeSpecName() ?? null);
  wireEquityAreas();
  wireMicromobilityZones();
  wireRoverZone(map);
  wireIgnoreDibs();
  wireDibsAlerts();
  wireReachFilter();
  // "Notify me if moved", in Tools where Favorite Scooters used to be. The
  // popup's 🔔 and this panel's Stop buttons write to the same local store, so
  // there is one list and one set of sentences rather than two that drift.
  notifyPanel = wireDeviceNotifyPanel({
    section: need("tools-notify-moved"),
    list: need("notify-moved-list"),
    status: need("notify-moved-status"),
    locate,
    onShowOnMap: (w) => map.easeTo({ center: [w.lon, w.lat], zoom: 17 }),
    // Dropping a watch from the panel has to un-press the bell on an open
    // popup and clear the notifier's bookkeeping for that vehicle, or a
    // re-armed watch inherits a miss count from the one before it.
    // The panel's Stop goes through here rather than straight to the store, so
    // the notifier's per-vehicle bookkeeping is cleared in the same breath — a
    // watch re-armed later must not inherit the old one's miss count or its
    // already-fired flag.
    remove: (vehicleIdentifier) => {
      const next = unwatchMoved(vehicleIdentifier);
      deviceNotifier.forget(vehicleIdentifier);
      return next;
    },
    // ...and the bell on an open popup has to un-press.
    onChanged: () => devices.refreshOpenPopup(),
  });
  // NO BELL ON THE DEVICE POPUP. There used to be one, and removing it is the
  // point rather than a side effect — see `device-notify.ts`'s header. A watch
  // armable from any scooter on the map is a "tell me when this address's
  // occupant leaves" alert, and no amount of rider convenience pays for that.
  //
  // The capability now has exactly two doors, both of which require the rider
  // to already be connected to the specific vehicle, and both of which arm the
  // watch as part of something else they were doing:
  //
  //   * CLAIMING ONE while building a route — `devices.ts`'s "I'll ride this
  //     one" calls dibs, and `armDibsWatch` below rides along with the claim.
  //   * FINISHING A RIDE on it — Screen 8 offers it once, and only then.
  //
  // What stays here is the un-arming: Tools lists what is being watched and
  // stops it, which is the surface a rider needs when they want this OFF.

  /** Arm the move-watch that rides along with a dibs claim.
   *
   *  Returns the sentence to show, or null when nothing was armed — the caller
   *  is mid-confirmation and a silent no-op is better than a second dialog.
   *  Everything that can refuse does so quietly: the cap, a vehicle that is
   *  already unavailable (arming would fire on the next refresh and consume
   *  the watch), and a claim with no expiry to inherit. */
  armDibsWatch = (claim: Dibs): string | null => {
    const watches = loadWatches();
    if (isWatched(watches, claim.vehicleIdentifier)) return null;
    if (watchSlotsLeft(watches, "dibs") <= 0) return null;
    if (currentlyUnavailable(claim.vehicleIdentifier)) return null;
    track("device_notify_moved", { action: "on", origin: "dibs" });
    watchMoved({
      vehicleIdentifier: claim.vehicleIdentifier,
      name: claim.vehicleName,
      lat: claim.lat,
      lon: claim.lon,
      since: Date.now(),
      origin: "dibs",
      // THE CLAIM'S OWN DEATH, not a duration of this feature's choosing. A
      // watch that outlived the dibs it rests on would be a watch on a
      // scooter the rider has no remaining connection to, which is the whole
      // thing being prevented.
      expiresAt: dibsExpiresAt(claim),
    });
    deviceNotifier.forget(claim.vehicleIdentifier);
    void requestMovedNotifications();
    notifyPanel?.refresh();
    return `We'll tell you if ${claim.vehicleName} moves before you get there.`;
  };

  devices.setClaimWatchHook((claim) => armDibsWatch(claim));

  /** Arm the one-per-ride watch Screen 8 offers. Same refusals, plus its own
   *  two-hour ceiling from `WATCH_RULES`. */
  armRideEndWatch = (vehicleIdentifier, name, at) => {
    const watches = loadWatches();
    if (watchSlotsLeft(watches, "ride_end") <= 0 && !isWatched(watches, vehicleIdentifier)) {
      return false;
    }
    track("device_notify_moved", { action: "on", origin: "ride_end" });
    watchMoved({
      vehicleIdentifier,
      name,
      lat: at.lat,
      lon: at.lon,
      since: Date.now(),
      origin: "ride_end",
      expiresAt: Date.now() + WATCH_RULES.ride_end.ttlMs,
    });
    deviceNotifier.forget(vehicleIdentifier);
    void requestMovedNotifications();
    notifyPanel?.refresh();
    return true;
  };

  // My dibs, in Tools. Kept in step with the map: releasing one from here has
  // to un-dim that scooter and rebuild any open popup, which is exactly what
  // `refreshLiveDibs` already does for a claim landing.
  myDibs = wireMyDibs({
    section: need("tools-my-dibs"),
    list: need("my-dibs-list"),
    onOpenCertificate: (d: Dibs) => openDibsCertificate(d),
    onRelease: (d: Dibs) => {
      if (d.registration) void releaseDibs(d.registration.id);
    },
    // Re-fetch rather than mutate a local copy: the server has just been told
    // to expire the row, and its answer is the one every other rider sees.
    onChanged: () => refreshLiveDibs(),
  });

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
    // Every filter change lands here, which is exactly what the ideal-scooter
    // toggle needs: it clears itself the moment the map stops matching the
    // spec it claims to be showing. Reusing this rather than adding a second
    // change signal keeps "the filters changed" a single fact.
    rideSpecPanel?.onFiltersChanged();
    // ...and the chip row, for the same reason. The drawer's own handlers call
    // `refreshChips` directly, which was enough while the drawer was the only
    // writer — but the ride HUD's "Show" pills now write the same filter, and a
    // pill tap left the chips describing the pre-ride selection. The chips are
    // hidden during a ride, so the damage showed up AFTER it: a rider who set
    // Show to `none` came back to an empty map with no chip and no ✕ to clear
    // it until they opened the drawer. One signal, every writer.
    refreshChips();
  });
  map.on("moveend", () => {
    freshness.setViewportCount(countDevicesInViewport());
  });

  const resp = await devicesPromise;
  if (resp) {
    devices.setData(resp);
    window.dispatchEvent(new Event("scooter:devices-refreshed"));
    refreshLiveDibs();
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
  // F3 flipped the ride entry on by default (frontend plan, "Entry"), so this
  // wizard wiring is unconditional: an entry calls `openRideModal()` whenever
  // no ride is live, which needs a real, registered screen behind it rather
  // than the `scooter-fyi-ride-modal` dev flag's old placeholder. The 🧭 mode
  // button that used to be that entry is gone (§6.2); the top bar's ride
  // button and the home bar are the entries now. `isRideModalEnabled`/`RIDE_MODAL_FLAG_KEY` (ride-modal.ts)
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
          // Screen 8's post-ride move-watch offer — the second of the
          // capability's two doors. `canOffer` is asked before the control is
          // drawn so a rider whose one slot is spent is never shown an offer
          // that would refuse them.
          canOfferMoveWatch: (vid) =>
            watchSlotsLeft(loadWatches(), "ride_end") > 0 &&
            !isWatched(loadWatches(), vid) &&
            !currentlyUnavailable(vid),
          armMoveWatch: (vid, name, at) => armRideEndWatch(vid, name, at),
        });
      });
    },
    // The entry's id is normally a 16-hex `vehicle_identifier` (both `?ride=`
    // forms produce one now — `/vehicles/resolve` answers with it), but a
    // `device_id` is accepted too. Hand jumpToDevice the device_id it matches
    // popups on.
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
    // THE DOOR. Nothing builds a wizard over a ride that is already running.
    //
    // The reducer has always rejected `open` from a live or post-ride doc,
    // but the rejection arrived too late to matter: `onOpen` runs with the
    // shell already in the document, and the returned transition was
    // discarded. So the wizard mounted, read a doc that said `riding`, and
    // kept trying to start a ride that was already live — the rider who
    // stepped out with BRB and then tapped a scooter had no way out but
    // closing the app.
    //
    // A ride that is live is not an entry to serve, it is an entry to
    // ANSWER: the rider is reaching for the ride they are already on, so
    // hand them the HUD. A post-ride doc is the same shape of mistake with a
    // different destination — Screens 8/9/10 are still waiting on them, and
    // `ride-post.ts` owns that surface, so leave the doc alone and say so
    // rather than opening a wizard that would be rejected anyway.
    beforeOpen: (entry) => {
      const doc = rideSession.current();
      if (!doc) return true;
      // SCREEN 8'S [NEW DESTINATION] IS NOT AN ENTRY TO TURN AWAY.
      //
      // `newDestination` lands the doc on `wizard:3` keeping the ride's id and
      // chain, and then reopens the wizard to ask where to next — so the doc it
      // produces is `wizard` + screen "3" + a non-null `rideId`, which is
      // exactly what `isRideLive` reports as live. Deflecting it sent the rider
      // to the HUD with `dest` and `route` already nulled by the reducer and no
      // way left to choose a new destination.
      //
      // The loop says so with `resume`, the same flag the free-ride button uses
      // to mean "take me back to what I was doing" — and only in the wizard,
      // because a doc that says `riding` has a HUD up and must never have a
      // wizard built over it however the entry is labelled.
      if (entry.resume === true && doc.state === "wizard") return true;
      if (isRideLive(doc)) {
        // The HUD's own `open()` resumes a BRB'd ride where it paused (and
        // re-attaches a reloaded one), which is exactly what the rider was
        // asking for. `hudReturnMode` is captured by the mode bar, so going
        // through the ribbon button keeps the "where do I land on exit"
        // bookkeeping in the one place that owns it.
        resumeLiveRide();
        return false;
      }
      if (isPostRide(doc)) {
        // Nothing to resume and nothing to start. Screens 8/9/10 mount off
        // `phaseOf(doc)` through their own subscription (`ride-post.ts`), so
        // the screen the rider still owes an answer to is already on top of
        // everything — there is no "re-show" to do, only a wizard not to
        // build underneath it.
        return false;
      }
      return true;
    },
    // Every open (a deep link, or a later re-entry) starts one fresh session
    // doc — `reduceRideSession`'s own guard rejects this over a live/post
    // ride, so a re-entry mid-ride can never clobber it. Guest-vs-private is
    // NOT decided here: it defaults to `false` and Screen 2's device pick
    // (own device vs. a real Veo scooter) is what actually derives it.
    onOpen: (entry) => {
      // A RESUME IS NOT AN OPEN. `open` seeds a blank doc, so dispatching it
      // for a rider coming back to a wizard they left mid-answer silently
      // drops their scooter, destination and route. The free-ride button's
      // own comment already promised this would never happen — but the
      // promise was only kept as far as choosing to call `openRideModal`,
      // and `open` fired anyway one layer down. With a doc that still holds
      // answers, keep it and let `resolveStartScreen` put them back on the
      // screen they left.
      const live = rideSession.current();
      if (entry.resume && live && live.state === "wizard" && hasAnswers(live)) {
        homeBar?.collapse();
        return;
      }
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
      // A trip planned on the home bar answers two of these before the
      // wizard opens: "got my own" IS `own_device`, and having named a
      // destination is what `navigation` means. Folded in here, through
      // `applyCascades` like every other seed, so the wizard can never be
      // handed an options blob it would call illegal.
      //
      // "started" is NOT `own_device`, which is the whole reason it is a third
      // answer rather than a second label on that one — there is a rental
      // running, so the ride is tracked against a real vehicle and the cost
      // readout keeps the default that `own_device` would have forced off.
      // `=== "own"` already says so; it is spelled out because the obvious
      // reading of "they already have wheels" is the wrong one here.
      const trip = takePendingTrip();
      const fromHomeBar = trip
        ? { own_device: trip.wheels === "own", navigation: true }
        : {};
      // A free ride answers all three of the wizard's questions by declining
      // them: whatever you are riding is your own, there is nowhere to
      // navigate to, and there is no Veo meter to price.
      const fromFreeRide = entry.freeRide
        ? { own_device: true, navigation: false, cost_hud: false }
        : {};
      const options = entry.preflight
        ? applyCascades(
            { ...base, ...entry.preflight, ...fromHomeBar, ...fromFreeRide },
            context,
          )
        : applyCascades({ ...base, ...fromHomeBar, ...fromFreeRide }, context);
      homeBar?.collapse();
      rideSession.dispatch({ type: "open", options });
      // The rider already said where they are going, so Screen 3 opens with
      // the answer in hand rather than asking the same question twice. It
      // still SHOWS — changing your mind about the destination is exactly
      // what that screen is for — but Next is live the moment it mounts.
      if (trip) {
        // §11.9: on a multi-leg plan THIS LEG ends at the next hand-off, not at
        // the far end of the trip. Seeding the final destination here is what
        // navigated a rider on leg one straight past the scooter they were
        // meant to switch to — the app routing around its own plan.
        const legTrip = activeTrip();
        const legDest = legTrip === null ? null : legDestination(legTrip);
        const dest =
          legDest !== null && legTrip !== null && legEndsAtHandOff(legTrip)
            ? legDest
            : { label: trip.dest.label, lat: trip.dest.lat, lon: trip.dest.lon };
        rideSession.dispatch({ type: "setDest", dest });
        // AND THE DEVICE, for an own-device trip. `own_device: true` in the
        // OPTIONS is not the same as a device on the doc, and Screen 6 skips
        // itself on `doc.device === null` — so setting only the option made
        // Screen 2 skip (correctly) and Screen 6 skip (fatally), and the flow
        // ran off the end without ever dispatching `rideStarted`. A rider who
        // said "got my own" and picked a route watched the wizard close and
        // nothing happen.
        if (trip.wheels === "own") {
          rideSession.dispatch({ type: "setDevice", device: { own: true } });
        }
      }

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
      // ...OR when the rider walked to it. `deviceConfirmed` says they
      // committed to this vehicle; without setting the device here the doc
      // stayed empty, Screen 2 refused to skip, and somebody who had just
      // walked three blocks to a specific scooter was asked which scooter —
      // with the navigation and save-tracks toggles alongside it, which is
      // how a rider ends up with navigation off on a trip they chose a
      // destination for. Same shape as the own-device bug: an entry that
      // means "device known" has to actually put the device on the doc.
      // Same rule as the own-device home-bar trip above: `own_device: true`
      // in the OPTIONS is not a device on the DOC, and Screen 6 skips itself
      // on `doc.device === null` — which is exactly how a "started" ride ends
      // up with no HUD and no recorder.
      if (entry.freeRide) {
        rideSession.dispatch({ type: "setDevice", device: { own: true } });
      }
      if ((entry.preflight || entry.deviceConfirmed) && entry.vehicleIdentifier) {
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
  wireRideScreenAuth({
    locate,
    // A rider with a destination on the session is mid-task; Screen 1 stops
    // pitching an account at them and gates on location alone.
    hasDestination: () => (rideSession.current()?.dest ?? null) !== null,
  });
  wireRideScreenSelect({
    devices,
    locate,
    session: rideSession,
    buildOptionsPanel: buildRideOptionsPanel,
  });
  wireRideScreenDest({
    session: rideSession,
    locate,
    // The same one-shot picker the Profile tab uses for home/work. Its
    // `onModeChange` already dims the drawer and suppresses device popups;
    // the wizard's own sheet is hidden by the `is-map-picking` body class
    // (style.css), since the map has to be visible to tap it.
    pickOnMap: () =>
      mapPick.pick({ hint: "Tap the map to drop a pin on your destination" }),
  });
  wireRideScreenRoutes({ session: rideSession, locate, devices, routePreview });
  wireRideScreenStart({
    session: rideSession,
    locate,
    // §11.5's "Before": the same unfiltered range lookup the HUD takes for the
    // during-ride warning, from the same object, so the two tiers of one
    // question cannot be reading different numbers.
    rangeMetersFor: (id) => devices.rangeMetersFor(id),
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
    });
  });

  // Start watching the map for the equity-area indicator. Loads the
  // polygons lazily and reveals the chip on the first move after they land.
  equityAreas.wire();
  startRefreshLoop();

  // First-run tour + progressive discovery tips. Wired last, and the reason has
  // changed: the CTA used to drive the mode bar (gone), then find-wheels mode,
  // and now opens the home bar's own question — so `homeBar` must be assigned,
  // which it is, further up this same handler.
  wireOnboarding();
});

// ---------- Onboarding & progressive discovery ----------

/** Whether the intro tour opens itself on a first visit.
 *
 *  BACK ON (§7.3). It was turned off "while the tour is rewritten", and the
 *  rewrite has landed: the two screens describing a UI that moved are rewritten,
 *  and the CTA lands on a real question instead of clicking an element Phase 6
 *  deleted. The point of this being one line is that turning it on is a
 *  decision, not a revert. */
const ONBOARDING_AUTOSHOW = true;

// The tour (onboarding.ts) auto-shows once per browser and is replayable from
// the About drawer.
//
// ITS FINAL CTA OPENS THE HOME BAR'S OWN QUESTION — "where are you going?" —
// rather than putting the map into find-wheels mode. The tour has just spent
// eight screens explaining what the app knows about scooters; the useful next
// move is the one question the app needs from the rider, and answering it now
// reaches the plan list. Find-wheels mode is a map state, not a question, so
// ending there left the rider looking at dots and working out what to do.
//
// `openForTrip`, NOT `openForDestination`: the latter answers one question for
// another surface and dispatches nothing, so a tour ending there would collect
// a destination and quietly drop it.
//
// The legend and the one-time "tap any scooter" nudge stay — they are about
// reading the map, which the rider is about to do either way.
function wireOnboarding(): void {
  const hooks: OnboardingHooks = {
    onStartExploring: () => {
      // FALLS BACK RATHER THAN NO-OPPING. `homeBar` is module-level and
      // nullable, so `homeBar?.openForTrip()` alone would make this CTA do
      // nothing at all if the ordering above ever changed — which is the exact
      // failure §7.1 describes, reintroduced with a new cause and no symptom.
      // Find-wheels mode is a worse ending than the question, and an infinitely
      // better one than a button that does nothing.
      if (homeBar) homeBar.openForTrip();
      else enterFindWheels();
      const legend = document.getElementById(
        "legend-toggle",
      ) as HTMLInputElement | null;
      if (legend && !legend.checked) {
        legend.checked = true;
        legend.dispatchEvent(new Event("change"));
      }
      showTipOnce(
        "tap-scooter",
        "Tap any scooter to learn why it's recommended.",
      );
    },
  };

  document
    .getElementById("about-replay-tour")
    ?.addEventListener("click", () => {
      closeAllPopups();
      showOnboarding(hooks);
    });

  // Progressive discovery: first High-Risk popup explains the
  // classification (devices.ts dispatches the event with the tier).
  window.addEventListener("scooter:popup-open", (e) => {
    const tier = (e as CustomEvent<{ tier?: string }>).detail?.tier;
    if (tier === "risk") {
      showTipOnce(
        "high-risk",
        "This classification is based on failed starts, dwell time, rider reports, and other rideability signals.",
      );
    }
  });

  // Progressive discovery: first time Territory Control shading goes on.
  const territoryToggle = document.getElementById(
    "leaderboard-territory-toggle",
  ) as HTMLInputElement | null;
  territoryToggle?.addEventListener("change", () => {
    if (territoryToggle.checked) {
      showTipOnce(
        "territory",
        "Hexes wear the colors of whoever leads them. Keep contributing nearby to claim and defend yours.",
      );
    }
  });

  // AUTO-SHOW IS OFF, deliberately and temporarily.
  //
  // The tour walks through a UI that has moved on — the three-way mode bar it
  // demonstrates no longer exists, and several screens describe surfaces that
  // have since moved. A tour that confidently describes the wrong app is
  // worse than no tour: it is the first thing a new rider sees, and it
  // teaches them things they then have to unlearn.
  //
  // Still REPLAYABLE from About, so it stays reachable and testable, and
  // turning it back on is one line rather than a revert.
  if (ONBOARDING_AUTOSHOW) maybeShowOnboarding(hooks);
}

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
  trackId?: string,
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
    btn.addEventListener("click", () => {
      // Only real gestures that change the value count — programmatic
      // setter replays (presets, chips) go through the returned function
      // below and emit nothing, and re-clicking the active segment is a
      // no-op change not worth an event.
      if (trackId && !btn.classList.contains("is-active"))
        track("control_change", { control: trackId });
      select(btn);
    });
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
  trackId?: string,
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
      // Synthetic clicks from setToggleGroup are state-driving, not
      // gestures — see drivingToggleGroup's comment.
      if (trackId && !drivingToggleGroup) {
        track("control_change", { control: trackId });
      }
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

// NO RIDE-TYPE FILTER, and no ride-type → model sync.
//
// The sitting/standing control was a second way to say something the model
// toggles already said. Posture is DERIVED from the model, and not loosely:
// the API's ingest maps one Veo vehicle-type id to both the model name and the
// sitting/standing value (`_KNOWN_VEHICLE_TYPES`), so for a recognized model
// the two can never disagree. "Seated only" was "Cosmo or Apollo or Rover"
// with extra steps.
//
// Being redundant is not what made it worth deleting. What made it worth
// deleting is that the redundancy was LOAD-BEARING: `syncModelsToRideTypes`
// existed because the two controls could combine into a filter that shows
// nothing ("Seated" plus an Astro-only model pick), and it had to be careful —
// preserving a narrower model pick that could still produce the enabled types,
// expanding only in the genuinely dead case, one-directional so a model tap
// never rewrote the pills. All of that is gone with the control it guarded.
//
// WHAT STAYS, deliberately: `rideTypeOf` (the device icon's sprite picks
// `use-sitting`/`use-standing`), `MODELS_BY_RIDE_TYPE` (the ride spec's
// model-widening rung — "anything you'd sit on the same way"), and the
// `vehicle_use_type` field itself, which on the API side is a SplitDimension in
// the equity-compliance metrics and is described there as the
// accessibility-relevant split. Deleting the concept would delete an
// accessibility metric; only the redundant control is going.

/** "I'm rude AF" — other people's claims stop dimming the map.
 *
 *  The claims are still REAL: the popup still names whoever holds one, the
 *  certificate still validates, and "I'll ride this one" is still blocked on
 *  somebody else's scooter. This hides the courtesy, not the fact — which is
 *  the only version of this toggle worth shipping, since dibs is a social
 *  convention and an app that let you switch off other people's existence
 *  would just be a worse app. */
function wireIgnoreDibs(): void {
  const cb = need<HTMLInputElement>("ignore-dibs");
  cb.addEventListener("change", () => {
    devices.setIgnoreDibs(cb.checked);
    track("control_change", { control: "ignore_dibs", value: cb.checked ? "on" : "off" });
    refreshChips();
  });
}

/** "Only ones that can get me there," and what you would arrive with.
 *
 *  THE CHEAP TIER of the will-it-make-it question. `/route/options` already
 *  answers it properly, from the pessimistic end of the battery model's band
 *  — but that costs a routing call per scooter, and a filter that has to
 *  route the whole visible fleet is not a filter. Every device already
 *  carries `current_range_meters`, so this needs no network at all. See
 *  `reach.ts` for what the two approximations are and why they are honest
 *  enough to filter with and not to promise with.
 *
 *  The row only exists while a trip does. The filter is a claim about a
 *  SPECIFIC destination, so it cannot be a standing preference: clearing the
 *  trip clears the filter, because there is nothing left to reach.
 *
 *  The DESTINATION is pushed to the map whenever there is one, independently
 *  of the checkbox. The card's "what you'd arrive with" line depends on having
 *  somewhere to arrive, not on the rider having asked for the map to be
 *  thinned — those were one field once, and the estimate went missing for
 *  everyone who never found the filter. */
function wireReachFilter(): void {
  const row = document.getElementById("reach-row");
  const cb = need<HTMLInputElement>("reach-filter");

  const sync = (): void => {
    const trip = peekPendingTrip();
    if (row) row.hidden = trip === null;
    if (trip === null && cb.checked) {
      // The destination went; so does the claim about it.
      cb.checked = false;
    }
    // The destination and the filter are pushed SEPARATELY. The card's
    // arrival line needs somewhere to arrive; hiding the ones that cannot
    // make it is a different ask, and a rider who has not ticked the filter
    // should still be told what they would arrive with.
    devices.setTripDest(trip ? { lat: trip.dest.lat, lon: trip.dest.lon } : null);
    devices.setReachFilter(cb.checked && trip !== null);
    refreshChips();
  };

  cb.addEventListener("change", () => {
    track("control_change", {
      control: "reach_filter",
      value: cb.checked ? "on" : "off",
    });
    sync();
  });
  // The trip can change from anywhere — the home bar, the arrival panel's
  // Change button, a flow ending — so re-read it rather than trying to be
  // told about every writer.
  window.addEventListener("scooter:trip-changed", sync);
  sync();
}

/** Drive the Availability checkbox through its normal change path. */
function setHideUnavailableControl(hide: boolean): void {
  const cb = need<HTMLInputElement>("hide-unavailable");
  if (cb.checked === hide) return;
  cb.checked = hide;
  cb.dispatchEvent(new Event("change"));
}

/** Drive the battery slider through its normal input path. */
function setMinBatteryControl(pct: number): void {
  const slider = need<HTMLInputElement>("battery-min");
  if (slider.value === String(pct)) return;
  slider.value = String(pct);
  slider.dispatchEvent(new Event("input"));
}

/** Quick Filters: one tap sets a handful of the drawer's controls, through
 *  each control's normal event path — a quick filter is a shortcut into the
 *  same state the sections below own, not a separate filter mode, so
 *  everything stays individually adjustable (and chip-clearable) after.
 *  Controls a set doesn't mention are left alone on purpose: tapping
 *  "Decent Rides" with an area filter on means decent rides in that area. */
function wireQuickFilters(): void {
  const sets: Record<string, () => void> = {
    // Plenty of charge, the likely-rideable tier only, nothing reserved
    // or out of service.
    charged: () => {
      setMinBatteryControl(60);
      setQualityFilter("ok-only");
      setHideUnavailableControl(true);
    },
    // Softer cut: drop the high-risk tier and near-dead batteries.
    decent: () => {
      setMinBatteryControl(20);
      setQualityFilter("no-risk");
      setHideUnavailableControl(true);
    },
    // Seated rides only. Now says it directly in models rather than setting a
    // ride type and relying on a sync to turn the Astro off in step —
    // `MODELS_BY_RIDE_TYPE` is the same mapping that sync read, so this is the
    // identical selection by a shorter route.
    "no-standing": () => {
      setToggleGroup(
        "#model-filter",
        "model",
        new Set<string>(MODELS_BY_RIDE_TYPE.sitting),
      );
      setHideUnavailableControl(true);
    },
  };
  // TWO PASSENGERS IS A TOGGLE, not a one-shot like the three above it.
  //
  // Those three set some controls and are done — tapping one twice does the
  // same thing twice. This one is a STATE the rider leaves on, because it is a
  // fact about the trip they are taking rather than a view they are applying,
  // and it has to be turnable off without hunting through the sections it
  // touched. So it owns its own storage, reports its state through
  // `aria-pressed`, and says what it is enforcing underneath.
  const twoUpBtn = document.querySelector<HTMLButtonElement>(
    '#quick-filters [data-quick="two-up"]',
  );
  const twoUpNote = document.getElementById("two-up-note");
  const renderTwoUp = (): void => {
    const on = twoPassengers();
    twoUpBtn?.setAttribute("aria-pressed", String(on));
    twoUpBtn?.classList.toggle("is-active", on);
    if (!twoUpNote) return;
    const note = twoPassengerNote(rideSpecPanel?.activeSpec() ?? defaultSpec());
    twoUpNote.textContent = note ?? "";
    twoUpNote.hidden = note === null;
    // The contradiction gets the warning treatment; the ordinary "here is what
    // I am enforcing" line does not. Only one of the two is a problem.
    twoUpNote.classList.toggle(
      "control-hint--warning",
      on && conflictsWithSpec(rideSpecPanel?.activeSpec() ?? defaultSpec()),
    );
  };
  twoUpBtn?.addEventListener("click", () => {
    const next = !twoPassengers();
    track("control_change", { control: "quick-two-up", value: next ? "on" : "off" });
    if (!setTwoPassengers(next)) {
      // Said out loud rather than swallowed. A rider who believes this is on,
      // and whose next reload turns it off, gets offered a one-seater for a
      // trip they are taking with somebody.
      if (twoUpNote) {
        twoUpNote.textContent =
          "Couldn't save that on this device — it will switch itself off if you reload.";
        twoUpNote.hidden = false;
        twoUpNote.classList.add("control-hint--warning");
      }
      return;
    }
    // The map half, so the fleet on screen is the fleet the planner will use.
    // Only on the way ON: turning it off must not reset filters the rider set
    // for their own reasons, which they would then have to put back by hand.
    if (next) {
      setToggleGroup("#model-filter", "model", new Set<string>(TWO_PASSENGER_MODELS));
      setMinBatteryControl(TWO_PASSENGER_MIN_BATTERY);
      setQualityFilter("no-risk");
      setHideUnavailableControl(true);
    }
    renderTwoUp();
  });
  // A spec edit can turn a conflict on or off while this drawer is open.
  window.addEventListener("scooter:spec-changed", renderTwoUp);
  renderTwoUp();

  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    "#quick-filters button",
  )) {
    const apply = sets[btn.dataset.quick ?? ""];
    if (!apply) continue;
    btn.addEventListener("click", () => {
      track("control_change", { control: `quick-${btn.dataset.quick}` });
      apply();
    });
  }
}

function wireModels(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#model-filter .toggle-card"),
  );
  // Rover service-area caveat: shown when the rider is deliberately
  // filtering FOR rovers (the Rover card on within a narrowed selection).
  // Hidden in the everything-on default — it is a note about choosing
  // rovers, not a banner on the drawer.
  const roverNote = need<HTMLParagraphElement>("rover-area-note");
  // NOT `wireToggleGroup`'s own clear. That closure guards on its LOCAL mirror
  // of which boxes are ticked (`if (enabled.size === all.length) return`), and
  // the ride HUD's "Show" pills write the shared filter without touching it —
  // so after a pill narrowed the selection the mirror still read "everything
  // on", the guard returned early, and the ✕ did nothing. The chip row lives
  // OUTSIDE the drawer, so it is reachable without the drawer's on-open
  // re-sync; wiring `refreshChips` to every filter change is what made that
  // chip (and its dead ✕) appear in the first place.
  //
  // `devices` is the authority. Set it, then bring the buttons into line —
  // which is a no-op when they are already right, and a real sync when the
  // drawer is the surface that narrowed it.
  void wireToggleGroup(
    btns,
    (b) => b.dataset.model as ModelKey,
    ALL_MODELS,
    (enabled) => {
      // No local mirror to update: `setModels` below writes the one selection
      // and `modelsOn()` reads it back.
      roverNote.hidden = !(
        enabled.has("trike") && enabled.size < ALL_MODELS.length
      );
      devices.setModels(enabled);
      clusters.update(devices.visibleFeatures());
      refreshChips();
    },
    "models",
  );
  clearModelFilter = () => {
    devices.setModelSelection(ALL_SELECTED);
    setToggleGroup("#model-filter", "model", new Set<string>(ALL_MODELS));
    roverNote.hidden = true;
    clusters.update(devices.visibleFeatures());
    refreshChips();
  };
}

function wireFeatureFilter(): void {
  // A REQUIRE filter, so it can't ride on wireToggleGroup (whose contract is
  // "everything starts enabled, tap to hide"): here nothing starts selected,
  // empty = off, and each pill ADDS a constraint. See matchesFeatureFilter
  // (device-features.ts) for the AND/¯\_(ツ)_/¯ semantics.
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#feature-filter .toggle-pill"),
  );
  const selected = new Set<FeatureFilterKey>();
  const sync = (): void => {
    for (const b of btns) {
      const on = selected.has(b.dataset.feature as FeatureFilterKey);
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    featuresOn = new Set(selected);
    devices.setFeatureFilter(featuresOn);
    clusters.update(devices.visibleFeatures());
    refreshChips();
  };
  for (const btn of btns) {
    btn.addEventListener("click", () => {
      track("control_change", { control: "features" });
      const v = btn.dataset.feature as FeatureFilterKey;
      if (selected.has(v)) selected.delete(v);
      else selected.add(v);
      sync();
    });
  }
  clearFeatureFilter = () => {
    if (selected.size === 0) return;
    selected.clear();
    sync();
  };
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
    "quality",
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
    models: [...modelsOn()],
    // The lineup as of this save, so a model added AFTER can be told apart
    // from one the saver deselected (see effectiveModels) — absence from
    // `models` alone can't distinguish the two, which is how pre-Rover
    // presets used to hide every Rover.
    knownModels: [...ALL_MODELS],
    features: FEATURE_FILTER_KEYS.filter((k) => featuresOn.has(k)),
    hideUnavailable: need<HTMLInputElement>("hide-unavailable").checked,
    minBattery: minBatteryPct,
    quality: qualityOn,
    area: display ? { layer: display.layer, subset: display.subset } : null,
  };
}

/** Click each multi-toggle member into the wanted state so the group's own
 *  handler (and the whole map→clusters→chips sync path) runs normally. */
/** True while setToggleGroup is driving buttons programmatically, so
 *  wireToggleGroup can tell a synthetic click from a rider's tap and skip
 *  the `control_change` telemetry for it — the same programmatic-replay
 *  suppression wireSeg already does for its setter. Without this, one
 *  quick filter recorded a burst of control_change events for controls the
 *  rider never touched. (It also stopped a ride-type tap recording a phantom
 *  "models" gesture through the old ride-type → model sync; that sync and the
 *  control that drove it are gone, but the quick filters still replay.) */
let drivingToggleGroup = false;

function setToggleGroup(
  rootSel: string,
  key: "model" | "feature",
  want: ReadonlySet<string>,
): void {
  // Save/restore rather than set/clear. The known re-entrant path is gone with
  // the ride-type sync — a Quick Filter used to drive the ride-type buttons,
  // whose handler drove the model buttons — but this stays: `applyFilterSnapshot`
  // still drives several groups in one pass, and an inner call blanking the flag
  // would unsuppress telemetry for the rest of the outer drive. Keeping the
  // save/restore costs two lines; trading it for the assumption that nothing
  // will ever nest again costs a silent burst of phantom gestures.
  const wasDriving = drivingToggleGroup;
  drivingToggleGroup = true;
  try {
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      `${rootSel} button`,
    )) {
      const value = btn.dataset[key];
      if (!value) continue;
      if (btn.classList.contains("is-active") !== want.has(value)) btn.click();
    }
  } finally {
    drivingToggleGroup = wasDriving;
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
    // No ride-type group to drive: an old preset's `rideTypes` says nothing
    // its `models` does not already say, because posture is derived from the
    // model upstream (see the note above `wireModels`).
    // effectiveModels, not s.models verbatim: a model the preset never knew
    // about (saved before it joined the lineup) defaults to ON rather than
    // being read as deselected.
    setToggleGroup("#model-filter", "model", effectiveModels(s));
    // Presets saved before the Features filter existed carry no `features`
    // member — that reads as "no selection", which clears the live one.
    setToggleGroup("#feature-filter", "feature", new Set(s.features ?? []));
    setHideUnavailableControl(s.hideUnavailable);
    setMinBatteryControl(s.minBattery);
    setQualityFilter(s.quality);
    await areaFilter.applySelection(s.area);
  };
}

function wireClearFilters(): void {
  resetAllFilters = () => {
    clearModelFilter();
    clearFeatureFilter();
    clearBatteryMin();
    clearQualityFilter();
    // RESET, not clear — restores the DEFAULT, which is hiding reserved and
    // out-of-service vehicles, rather than turning every constraint off.
    // `false` here meant a rider who tapped this to get out of a narrow
    // filter got the whole broken fleet dumped onto their map, which is not
    // what anyone means by "start again". Showing those is an opt-in
    // (the "+ Unavailable" chip), so un-opting-in is the reset.
    setHideUnavailableControl(true);
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
  // Push the markup's default INTO the layer at wire time. The checkbox is
  // checked in the HTML and Devices starts with its own `hideUnavailable =
  // false`, so without this the control and the map disagree until somebody
  // happens to toggle it — the map showing reserved scooters while the panel
  // insists they are hidden.
  devices.setHideUnavailable(cb.checked);
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
        item(k(c ? "msvg-trike" : "ml-trike", "off"), "Veo Rover — Three-wheel seated trike w/ cargo basket"),
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
        icon(k("use-sitting", "off"), "Seated ride (Cosmo glider, Apollo e-bike or Rover)"),
        icon(k("use-standing", "off"), "Standing scooter (Astro)"),
      );
    } else if (style === "model") {
      const c = modelIcon === "comic";
      legendEl.append(
        icon(k(c ? "msvg-astro" : "ml-astro", "off"), "Veo Astro — standing scooter"),
        icon(k(c ? "msvg-cosmo" : "ml-cosmo", "off"), "Veo Cosmo — one passenger glider (no pedals)"),
        icon(k(c ? "msvg-apollo" : "ml-apollo", "off"), "Veo Apollo — two passenger e-bike w/ pedals"),
        icon(k(c ? "msvg-trike" : "ml-trike", "off"), "Veo Rover — three-wheel seated trike w/ cargo basket"),
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
    "gauge-data-source",
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
    "icon-data",
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
    "icon-style",
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
    "gauge-display",
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
    "gauge-thickness",
  );
  const setPlacement = wireSeg(
    "#gauge-placement-seg",
    (b) => b.dataset.placement ?? "surrounding",
    (v) => {
      placement = v as GaugePlacement;
      devices.setGaugePlacement(placement);
      renderAll();
    },
    "gauge-placement",
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
  // Reset to Off without re-triggering the change handler's side effects.
  clearChoropleth = () => {
    if (!select.value) return;
    select.value = "";
    void applyChoropleth(null);
  };
  select.addEventListener("change", () => {
    const layer = (select.value || null) as BoundaryLayer | null;
    if (layer) clearHexDensity(); // mutually exclusive with hex density
    void applyChoropleth(layer);
  });
}

/** What "Shade by" falls back to when Territory Control is switched off from
 *  the Leaderboard panel — leaving the select on a metric whose data is no
 *  longer showing would keep the size buttons locked for no visible reason. */
const DEFAULT_HEX_METRIC: HexMetric = "device_count";

/** Triple-tap anywhere on the map (map-inspect.ts). Sources in stacking
 *  order, top first, matching map-bands.ts: the city's zones, a drawn Equity
 *  Area, a territory / hex cell, a shaded region (choropleth or boundary
 *  overlay), then an Equity Area whose overlay is off, then the plain-spot
 *  card. Plus the weekly "tap tap tap" nudge, which
 *  retires itself the first time the gesture is used. */
const tripleTapNudge = new TripleTapNudge();
function wireMapInspector(): void {
  const inspector = new MapInspector(map, {
    sources: [
      zones,
      equityAreas,
      hexDensity,
      overlays.inspectSource((t, b) => openFloatingModal(t, b)),
      equityAreas.hiddenAreaSource(),
    ],
    fallback: (ll) => ({
      key: "spot",
      open: () =>
        openFloatingModal(
          SPOT_INSPECT_TITLE,
          buildSpotHtml({
            zones: !zones.isVisible("rules")
              ? "off"
              : zones.isLoaded()
                ? "shown"
                : "not_loaded",
            inEquityArea: isInEquityArea(ll.lng, ll.lat),
          }),
        ),
    }),
    onTriple: () => tripleTapNudge.learned(),
    // While picking a spot, a tap drops the pin; it must not start a run.
    suspended: () => mapPick.isPicking(),
  });
  inspector.attach();
  map.once("idle", () => {
    setTimeout(() => {
      // Never over an open card or drawer: it will be due again next visit.
      if (document.querySelector(".ranks-modal, .drawer.is-open")) return;
      tripleTapNudge.maybeShow();
    }, NUDGE_DELAY_MS);
  });
}

function wireHexDensity(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#hexbin-seg .seg-btn"),
  );
  const metricRow = need("hexbin-metric-row");
  const metricSelect = need<HTMLSelectElement>("hexbin-metric-select");
  const sizeLockedHint = need("hexbin-size-locked");

  const activeSize = (): HexSize | "" =>
    (btns.find((b) => b.classList.contains("is-active"))?.dataset.hex ||
      "") as HexSize | "";

  /** Territory control is computed per H3 r8 cell and nowhere else, so the
   *  other two sizes are disabled rather than left to redraw the same
   *  hexagons under a different label. "Off" stays live — turning the
   *  shading off is how you get back out — and picking any other metric
   *  unlocks everything again. */
  const applySizeLock = (locked: boolean): void => {
    for (const b of btns) {
      const size = b.dataset.hex || "";
      // `disabled` alone: it carries the semantics (unclickable, out of the
      // tab order, announced as disabled) AND the styling, via
      // `.seg-btn:disabled`. A parallel class would be a second thing to
      // keep in sync for no added behavior.
      b.disabled = locked && size !== "" && size !== TERRITORY_HEX_SIZE;
    }
    sizeLockedHint.hidden = !locked;
  };

  /** The single path that changes what the hexagon layer shows. Everything
   *  — the seg buttons, the "Shade by" select, the choropleth takeover, the
   *  Leaderboard panel's switch — routes through here, so the two controls
   *  and the map can never disagree about the current view. */
  const apply = (size: HexSize | "", metric: HexMetric): void => {
    const territory = metric === TERRITORY_METRIC;
    // Snap: there is no medium/small answer for this metric to show.
    if (territory && size) size = TERRITORY_HEX_SIZE;
    for (const b of btns) {
      const on = (b.dataset.hex || "") === size;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    metricSelect.value = metric;
    metricRow.hidden = !size;
    applySizeLock(territory);
    if (size) clearChoropleth(); // mutually exclusive with the choropleth
    void hexDensity.setView(size || null, metric);
    leaderboardPanel?.syncTerritory(!!size && territory);
  };

  // Reset to Off (used when the choropleth takes over). Keeps the metric
  // pick, so turning hexagons back on shows what was showing before.
  clearHexDensity = () => {
    if (activeSize()) apply("", metricSelect.value as HexMetric);
  };

  // The Leaderboard panel's Show Territory Control switch. Turning it off
  // also drops back to the default metric, which is what unlocks the size
  // buttons.
  setTerritoryShading = (on: boolean) => {
    if (on) apply(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    else if (metricSelect.value === TERRITORY_METRIC) {
      apply("", DEFAULT_HEX_METRIC);
    }
  };

  /** Arrow-key neighbor, wrapping, skipping whatever the current metric
   *  locked out — a disabled button must not be landable, or the roving
   *  focus dead-ends on it. */
  const step = (from: number, dir: 1 | -1): HTMLButtonElement | null => {
    const n = btns.length;
    for (let hop = 1; hop <= n; hop++) {
      const b = btns[(((from + dir * hop) % n) + n) % n];
      if (!b.disabled) return b;
    }
    return null;
  };

  btns.forEach((btn, i) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      track("hex_tool", { tool: btn.dataset.hex || "off" });
      apply((btn.dataset.hex || "") as HexSize | "", metricSelect.value as HexMetric);
    });
    btn.addEventListener("keydown", (e) => {
      const dir =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? -1
            : 0;
      if (!dir) return;
      e.preventDefault();
      const next = step(i, dir);
      if (!next) return;
      next.focus();
      apply((next.dataset.hex || "") as HexSize | "", metricSelect.value as HexMetric);
    });
  });

  metricSelect.addEventListener("change", () => {
    apply(activeSize(), metricSelect.value as HexMetric);
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

/** Hand the rider back the ride they are already on, instead of a wizard
 *  built over it. Assigned by `wireModes`, which owns the mode bar's
 *  "where do I land when the HUD closes" bookkeeping; a no-op before the bar
 *  is wired, which is only reachable if an entry fires during boot. */
let resumeLiveRide: () => void = () => {};

function wireModes(): void {
  // NO MODE BAR (§6.2). `#mode-switch` is gone from `index.html`, and with it
  // `setActive` and the `is-active`/`aria-pressed` bookkeeping it kept on two
  // buttons that had been `hidden` since the home bar took over — state nobody
  // could see, on elements nobody could press.
  let rideActive = false;

  const setSelect = (id: string, value: string): void => {
    const sel = need<HTMLSelectElement>(id);
    if (sel.value !== value) {
      sel.value = value;
      sel.dispatchEvent(new Event("change"));
    }
  };
  closeDrawer = () => setDrawer(null);
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

  // Fresh-load defaults. Exiting ride mode runs this so the map comes back
  // "normal": every filter cleared, iconography back to its defaults
  // (device-use badges, battery gauge on), overlays and the walk line gone.
  // Map preset behind the wizard: a clean slate showing available devices.
  // ONE MAP. Finding a ride used to switch the map into a third mode nobody
  // could see or choose: it wiped the rider's filters, forced
  // hide-unavailable on, cleared the choropleth and overlays, hid the Areas,
  // Tools and Compliance tabs, revealed a Recommended tab that existed
  // nowhere else, and fetched a leaner payload. None of that was visible as a
  // mode, none of it was switchable, and all of it had to be snapshotted and
  // undone on the way out — which is where the "merely visiting Find wheels
  // destroyed my analysis setup" bug came from.
  //
  // So there is no ride surface any more. The map keeps whatever the rider
  // set, every tab stays where it is, and the only mode left is the one a
  // rider actually chooses: 3D navigation, which takes the whole screen and
  // announces itself.

  // NO ANALYSIS MODE. There is no third mode, because there were never three
  // things to be in.
  //
  // "Analysis" was a PRESET from the old bottom mode bar: it reset filters
  // and iconography, forced a choropleth, and opened Equity Compliance. Every
  // one of those side effects has since been removed as a bug in its own
  // right, and what was left — `setDrawer("compliance")` — is just opening a
  // drawer, which is what a drawer tab already does. Keeping a "mode" wrapped
  // around it meant the ribbon's Analysis tab silently opened the Equity
  // Compliance drawer, which is why that panel kept coming back for a rider
  // who never asked for it.
  //
  // Equity Compliance is still reachable, deliberately, from the Tools
  // drawer's own "Open Equity Compliance" button — one named control, in the
  // drawer about tools, that says what it opens.
  //
  // What is left is the only distinction this app ever actually had: riding,
  // or not.
  //
  // `resetIconography` and `setSelect` lose their last caller here and are
  // kept anyway. Deleting them cascades into the four setters they solely
  // write, and those setters are the ONLY writers of the iconography state —
  // so removing them makes the compiler treat whole drawer branches as
  // unreachable. That is a real pre-existing knot and untangling it is its
  // own change, not a footnote to this one.
  void resetIconography;
  void setSelect;

  /** Entering or leaving the find-a-ride flow. It no longer changes the MAP —
   *  only what owns the bottom of the screen. */
  const setRideSurface = (on: boolean): void => {
    // One surface owns the bottom of the screen at a time: entering a ride
    // flow folds the home bar back to its pill rather than leaving a
    // "Where are you going?" sheet open underneath the answer to it.
    if (on) homeBar?.collapse();
    rideActive = on;
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

  // The snapshot/restore dance is gone with the mode that made it necessary:
  // nothing wipes the rider's filters on the way in, so nothing has to put
  // them back on the way out. The summary string is still captured, because
  // the wizard shows it ("ranking within your current filters").
  let rideEntrySummary = "";

  const wizard = new RideWizard(need("ride-wizard"), locate, {
    // Consent no longer rearranges the map behind the rider.
    onConsentGranted: () => {},
    onExit: () => exitRide(),
    onLoginHint: () => {
      const tab = document.querySelector<HTMLButtonElement>(
        '.drawer-tab[data-drawer="account"]',
      );
      if (!tab || tab.classList.contains("is-active")) return;
      // The hint is asking them to sign in, and the sign-in doors are above the
      // tab strip now — visible whichever tab the drawer opens on. So there is
      // no tab to name: opening the drawer IS landing on the doors. (This used
      // to stamp `accountTab = "login"`, which after the restructure named a tab
      // that no longer exists and would have been read as "blocked".)
      tab.click();
    },
    filterSummary: () => rideEntrySummary,
    // Interview finished: the Recommended Devices drawer takes over as the
    // home of the ranked list (and keeps re-ranking with the filters).
    onInterviewDone: (priority, typeChoice, from, carryOverFilters) => {
      setWizardDocked(false);
      // KEPT, so the planner can read it. This is the one line whose absence
      // was the whole complaint: the answer used to go to `recommended` and
      // stop there, so the plan list — the thing "need wheels" actually opens —
      // was built as if the rider had never been asked.
      interviewAnswers = { priority, typeChoice };
      // The ranked scooters, which are the path a rider falls back to when they
      // dismiss the plans. Same answers, so the two agree.
      recommended?.setContext({ from, priority, typeChoice });
      setDrawer("recommended");
      // "Carry over my filters" is now the only behaviour there is: nothing
      // wiped them, so they are still applied and rankDevices() already ranks
      // over visibleFeatures(). The option survives in the interview as a
      // statement of intent; there is simply nothing left to restore.
      void carryOverFilters;
      // And the plans, above the scooters in that same drawer — but only when
      // there is a destination to plan TO. The wizard is also entered from the
      // onboarding card and the top bar, where the rider has asked for a map of
      // what is nearby and named nowhere to go; a plan list needs a
      // destination, so those entries correctly get the scooters alone.
      const trip = peekPendingTrip();
      if (trip?.dest) openPlanList(trip.dest);
    },
  });

  exitFindWheels = () => {
    if (rideActive) exitRide();
  };

  const exitRide = (): void => {
    if (!rideActive) return;
    closeAllPopups();
    if (wizard.isOpen()) wizard.close();
    setWizardDocked(false);
    setRideSurface(false);
    // Nothing to undo. Leaving the flow leaves the map exactly as the rider
    // had it — no applyNormal() wipe, no snapshot to restore, no refresh to
    // recover fields a lean payload had dropped.
    //
    // Recommendations are still scoped to one Find-a-ride session: drop them
    // so re-entering never shows a stale list from the prior answers. The
    // interview answer and the plan list go with them for the same reason —
    // letting last trip's "I want a Cosmo" steer the next trip's plans is the
    // bug this restructure fixed, pointed the other way.
    recommended?.clear();
    interviewAnswers = null;
    closePlanList();
    // ...and close the drawer they were in, if it is the one open. Picking a
    // scooter off the ranked list is the moment that list stops being useful,
    // and leaving it open parks a panel over the map right when the rider
    // wants to see where they are walking. Only `recommended` — a rider who
    // deliberately opened Filters or Areas keeps it.
    const openDrawer = document.querySelector<HTMLButtonElement>(
      ".drawer-tab.is-active",
    );
    if (openDrawer?.dataset.drawer === "recommended") setDrawer(null);
  };

  const enterRide = (): void => {
    closeAllPopups();
    // The summary is what the wizard shows the rider ("ranking within your
    // current filters"), so it is read at entry. There is no snapshot to take
    // any more: nothing is about to overwrite what it describes.
    if (!rideActive) rideEntrySummary = filterSummary();
    setDrawer(null);
    setRideSurface(true);
    wizard.start();
    setWizardDocked(true);
  };

  // WHERE THE RIDER LANDS WHEN THE HUD CLOSES. There used to be a
  // `hudReturnMode` here, captured by reading `is-active` off the hidden mode
  // buttons on the way in and written back to them on the way out — the DOM
  // used as storage for a selection that was never rendered. §6.2 asked for
  // that to become explicit state; it turned out to need no state at all.
  // Closing the HUD reveals the map the rider already had (ONE MAP: entering a
  // ride never rearranged it), so there is no mode to restore — only the top
  // bar to re-read, because this is the moment its ride button becomes the
  // only way back to a live ride (§6.3.2). BRB does not dispatch, so the
  // session subscription alone would not fire here.
  rideHud.setOnHidden(() => refreshRideButton());

  // Back into the live ride, from anywhere. The ribbon's 🧭 tap was the only
  // way in, which made every OTHER route to a live ride — a scooter popup, a
  // deep link, the top bar's ride button — a route to a wizard built over it.
  // Published so `beforeOpen` can answer those entries with the ride the
  // rider is actually on. See that hook for the failure this closes.
  resumeLiveRide = () => {
    closeAllPopups();
    rideHud.open();
  };

  // THE TWO BRANCHES THE MODE BAR USED TO CARRY, as the plan asked — except
  // only one of them still had a caller.
  //
  // `data-mode="ride"` is this, called directly by the onboarding card and the
  // home bar instead of through a synthetic click:
  enterFindWheels = () => {
    track("mode_switch", { mode: "ride" });
    enterRide();
  };
  //
  // `data-mode="riding"` had NO reachable caller left. Its button carried
  // `id="ride-open"` and nothing referenced it; the one helper that clicked
  // modes by name was only ever passed "ride". Its behaviour — resume a live
  // ride, else open the wizard — is not lost: that is precisely the
  // `isLiveRideEntry` decision, which the top bar's ride button reaches
  // through `beforeOpen` (§6.3.2), and `resumeLiveRide` above is the same
  // resume. Lifting it into a second named function with no caller would have
  // preserved the shape of the seam while deleting the bar, which is the one
  // outcome this section is against.
}

// ---------- Home bar ("Where are you going?") ----------

// The bottom of the map. Owns the two questions a rider can actually answer
// on arrival — where to, and whether they need wheels — and then hands the
// trip to the flow that fits the answer. Both flows already existed; this
// only changes which question gets asked first, and by whom.
let homeBar: HomeBarHandle | null = null;
/** Whose name goes on a dibs certificate. Filled from the signed-in profile
 *  when one loads; the anonymous form otherwise. Never fabricated — the whole
 *  artifact is an assertion about who did what. */
let dibsClaimant = "Someone with the app";

/** Who currently holds a claim on what, refreshed with the device feed.
 *
 *  One small request per refresh rather than one per popup: claims are rare
 *  across a fleet this size, and this way a popup opens already knowing
 *  whether somebody has called it rather than gaining the notice a beat
 *  later. Failure is silent and total — no claims visible is the same as no
 *  claims, and a dibs lookup must never be why the map stops updating. */
let myDibs: MyDibsHandle | null = null;

/** How often held claims are re-checked for an alert.
 *
 *  Ticks rather than timers, per `dibs-notify.ts`: a backgrounded tab that
 *  sleeps through its exact window fires on the next tick it gets instead of
 *  silently skipping the message. Fifteen seconds is well inside the
 *  resolution of anything here — the tightest alert is a five-minute
 *  countdown — and cheap enough to leave running for the life of the page. */
const DIBS_TICK_MS = 15_000;

let dibsNotifier: ReturnType<typeof createDibsNotifier> | null = null;

/** Wire the four dibs alerts to something that actually fires them.
 *
 *  `dibs-notify.ts` had every message, the vibration and the dedupe written
 *  and tested, and was connected to nothing — so the rule the certificate
 *  now prints ("Scooter.fyi will try to notify you if the device you have
 *  dibs on is no longer available") was a promise with no mechanism.
 *
 *  Three drivers, because the four alerts have two different sources:
 *
 *    tick   — the clock. Every held claim, every 15s. Covers the grace
 *             warning (which fires while the rider has NOT set off, so the
 *             walk flow cannot be its source) and both countdowns.
 *    taken  — the world. The scooter left the feed or went in use. Checked on
 *             every device refresh, which is the only moment that fact
 *             changes, and independently from the walk's own watcher so a
 *             rider who claimed but has not set off is still told.
 *    forget — a claim that ended. Released, expired, or ridden.
 */
function wireDibsAlerts(): void {
  dibsNotifier = createDibsNotifier({
    // ALWAYS shown, even when the OS notification also fires: a rider
    // looking at the screen should not be the one person who misses it.
    inApp: (alert, text) => showDibsAlertToast(alert, text),
    // Tapping "RUN!" lands on the walk, not on a cold map.
    onResume: (d) => {
      void beginWalkToVehicle({
        name: d.vehicleName,
        plate: d.plate ?? null,
        vehicleIdentifier: d.vehicleIdentifier,
        lat: d.lat,
        lng: d.lon,
      });
    },
  });

  const known = new Set<string>();

  const sweep = (): void => {
    const held = loadDibs();
    const live = new Set(held.map((d) => d.vehicleIdentifier));
    // A claim that has gone — released, expired, or ridden — must not keep
    // its fired-alert history, or re-claiming the same scooter would be
    // silent.
    for (const vid of known) {
      if (!live.has(vid)) {
        dibsNotifier?.forget(vid);
        known.delete(vid);
      }
    }
    for (const d of held) {
      known.add(d.vehicleIdentifier);
      dibsNotifier?.tick(d);
    }
  };

  sweep();
  window.setInterval(sweep, DIBS_TICK_MS);

  // "It's gone" is about the WORLD, not the clock, so it is checked where
  // the world changes: each device refresh. `is_reserved` means IN USE on
  // this operator rather than a held booking, so either flag going up means
  // somebody else has it.
  window.addEventListener("scooter:devices-refreshed", () => {
    for (const d of loadDibs()) {
      const f = devices
        .allFeatures()
        .find((x) => x.properties.vehicle_identifier === d.vehicleIdentifier);
      const props = f?.properties as unknown as Record<string, unknown> | undefined;
      const truthy = (v: unknown): boolean => v === true || v === "true" || v === 1;
      // Absent from the feed entirely counts too: a scooter that vanished
      // is at least as gone as one marked in use.
      const gone =
        f === undefined || truthy(props?.is_reserved) || truthy(props?.is_disabled);
      if (gone) dibsNotifier?.taken(d);
    }
  });

  // "Notify me if moved" is the same kind of question — about the world, not a
  // clock — so it is answered in the same place, on the same refresh. Nothing
  // here polls: the feed this reads is the one the map was going to fetch
  // anyway, which is also why a closed tab hears nothing and why the copy
  // promises only "while the app is open".
  window.addEventListener("scooter:devices-refreshed", () => {
    const watches = loadWatches();
    if (watches.length === 0) return;
    const byId = new Map<string, DeviceNow>();
    for (const f of devices.allFeatures()) {
      const p = f.properties as unknown as Record<string, unknown>;
      const id = typeof p.vehicle_identifier === "string" ? p.vehicle_identifier : "";
      if (!id) continue;
      const [lon, lat] = f.geometry.coordinates;
      const truthy = (v: unknown): boolean => v === true || v === "true" || v === 1;
      byId.set(id, {
        lat,
        lon,
        // `is_reserved` ONLY. It means IN USE on this operator (not a held
        // booking), and `in_use` is the one verdict whose wording is
        // "Someone's riding X right now" — which `is_disabled` would make a
        // lie, since that is the operator pulling a scooter that has not
        // moved and nobody is on. A parked scooter going unrentable is not
        // the thing the rider asked to be told about.
        inUse: truthy(p.is_reserved),
      });
    }
    deviceNotifier.check(watches, (id) => byId.get(id));
  });
}

/** How often live claims are re-fetched.
 *
 *  FASTER THAN THE DEVICE REFRESH (90s), because the two are different kinds
 *  of data. A device snapshot is a whole city of vehicles that move on an
 *  ingest cycle; the claims are a handful of rows that turn over in minutes
 *  and are the thing two riders can disagree about while standing next to
 *  each other. Riding the slow cadence meant somebody could call dibs and
 *  the next rider's map would keep offering them that scooter for up to a
 *  minute and a half.
 *
 *  Cheap enough to justify: `/api/v1/dibs/live` returns the live claims for
 *  the whole city, which is a handful of rows, not thousands. */
const DIBS_REFRESH_MS = 25_000;

// ---------- The ribbon QR tool's "Ride mode" dial position ----------

/** Resolve a scanned sticker to a vehicle in the live feed — see
 *  `resolveScannedPlate` (qr-ride-scan.ts) for the three ways across, none of
 *  which touch Veo's servers. */
function resolveScannedVehicle(plate: string): Promise<ScannedVehicle | null> {
  const index = sharedPlateIndex();
  return resolveScannedPlate(plate, devices.allFeatures(), {
    plateFor: (id) => index.cachedPlateFor(id),
    resolve: resolvePlate,
  });
}

/** Perform whatever the scan means, and return the sentence to show.
 *
 *  The DECISION is `qr-ride-scan.ts`'s, which is pure; this is only the doing.
 *  Every branch ends with the rider somewhere useful — a wizard, the HUD, or a
 *  sentence saying why not — because a camera they just pointed at a sticker is
 *  the least informative place in the app to be left standing. */
async function handleQrRideScan(rawValue: string): Promise<string> {
  const plate = plateFromQr(rawValue);
  const vehicle = plate ? await resolveScannedVehicle(plate) : null;
  const action = qrRideAction(rideSession.current(), vehicle, plate);
  track("qr_utility", { mode: "ride", action: action.kind });
  const message = qrRideMessage(action);

  switch (action.kind) {
    case "start":
      // The scan IS the proof of presence — a rider holding a phone at a
      // sticker has answered "which one?" more conclusively than any picker
      // could — so Screen 2 is skipped and the flow lands on the route choice.
      openRideModal({
        vehicleIdentifier: action.vehicle.vehicleIdentifier,
        plate: action.vehicle.plate,
        deviceConfirmed: true,
        fastForwardTo: "4",
        // §11.2: the scan is a real timestamped event, and it is the only
        // moment in this flow we actually observed. Screen 6 prefers it over
        // its own clock, which runs from after the unlock — see
        // `resolveStartedAtMs` for the direction and why long is the safe way
        // to be wrong.
        scannedAtMs: Date.now(),
      });
      break;

    case "resume": {
      // Put the scooter in the doc BEFORE reopening, so the screen the rider
      // lands on already knows about it. `resume` on the entry is what stops
      // `onOpen` dispatching a fresh `open` and resetting their answers.
      rideSession.dispatch({
        type: "associateDevice",
        device: {
          vehicleIdentifier: action.vehicle.vehicleIdentifier,
          plate: action.vehicle.plate,
          model: null,
          batteryConfirmed: null,
        },
      });
      openRideModal({
        resume: true,
        vehicleIdentifier: action.vehicle.vehicleIdentifier,
        plate: action.vehicle.plate,
        deviceConfirmed: true,
        fastForwardTo: isWizardScreen(action.screen) ? action.screen : undefined,
      });
      break;
    }

    case "associate": {
      // The gap this whole mode exists for: a ride recording with no vehicle on
      // it (the free-ride path — started the track, then got on a scooter).
      // Naming the scooter is what gives the post-ride survey and its
      // model-bonus question something to be about.
      //
      // It does NOT retro-price the ride. The cost readout is a picture of
      // Veo's billing clock running from an unlock we never saw, and inventing
      // a start time for it would be worse than leaving it off.
      const t = rideSession.dispatch({
        type: "associateDevice",
        device: {
          vehicleIdentifier: action.vehicle.vehicleIdentifier,
          plate: action.vehicle.plate,
          model: null,
          batteryConfirmed: null,
        },
      });
      if (t?.accepted !== true) {
        return "Couldn't attach that scooter to your ride — it may have just finished.";
      }
      resumeLiveRide();
      break;
    }

    case "already":
      // Nothing to change, but the rider is mid-ride and reached for the app,
      // so hand them the HUD rather than leaving them on a closed camera.
      resumeLiveRide();
      break;

    case "post_ride":
    case "unreadable":
    case "unknown_vehicle":
      // Nothing to do. The sentence is the whole response.
      break;
  }
  return message;
}

function refreshLiveDibs(): void {
  void liveDibs()
    .then(({ dibs }) => {
      devices.setVehicleDibs(dibs);
      // A claim made from a scooter popup has to show up in Tools without a
      // reload — this is the one place that runs on every dibs change.
      myDibs?.refresh();
    })
    .catch(() => {
      /* the map is the point; this is a garnish on it */
    });
}

function setDibsClaimantFromProfile(
  profile: { display_name?: string | null; public_username?: string | null } | null,
): void {
  dibsClaimant =
    profile?.display_name?.trim() ||
    profile?.public_username?.trim() ||
    "Someone with the app";
}

function wireHomeBar(): HomeBarHandle {
  const bar = createHomeBar(need("home-bar"), {
    locate,
    onPlacesChange: ({ dest, start }) => {
      tripPins.set({ dest, start });
      // Show it, not just draw it: a pin outside the current viewport is the
      // same as no pin. Ease rather than jump, and only when there is
      // somewhere to go — an ease to nowhere on every clear would fight the
      // rider for control of the map.
      const focus = dest ?? start;
      if (!focus) return;
      map.easeTo({ center: [focus.lon, focus.lat], zoom: Math.max(map.getZoom(), 14), duration: 600 });
    },
    // The same one-shot picker the profile's home/work and Screen 3 use.
    pickOnMap: (hint) => mapPick.pick({ hint }),
    onPlanTrip: ({ dest, wheels, start }) => {
      closeAllPopups();
      // "I've already started one" is the only answer that needs something
      // from the rider before it can be acted on, so it is the only one that
      // can come back refused. Handled first, and it is the ONLY branch that
      // defers `setPendingTrip` — a cancelled scan must not leave an intent
      // lying around to steer some later ride (`pending-trip.ts`'s whole
      // reason for being one-shot).
      if (wheels === "started") {
        return planStartedTrip({ dest, start });
      }
      setPendingTrip({ dest, wheels, start });
      // "Need wheels" ASKS BEFORE IT ANSWERS, which is the ordering the rider
      // asked for and the reason this is not one line.
      //
      // It used to call `openPlanList(dest)` directly, and that function called
      // `enterFindWheels()` — which starts the wizard. So a rider got the
      // interview ("what matters most?") and the plan list at the same moment,
      // two surfaces over one map, and the interview's answer was handed to
      // `recommend.ts` while the plans were built from the saved spec alone. The
      // answer was not weighed and rejected; it never arrived.
      //
      // Now the wizard runs first and `onInterviewDone` builds the plans from
      // what it heard. The wizard skips its own consent and location steps when
      // a fix already exists and remembers a saved answer, so for a returning
      // rider this is still one tap to a list — it is just a list that knows
      // what they want.
      if (wheels === "need") {
        enterFindWheels();
        return;
      }
      // "Got my own" has no vehicle to choose and nowhere to walk to. The
      // rider is standing on their own scooter with a destination in hand, so
      // there is nothing left to ask — go straight to route triage and the
      // 3D navigation that follows it, skipping the gates, the device picker
      // and the "Where to?" screen the home bar already answered.
      openRideModal({ fastForwardTo: "4" });
    },
  });
  return bar;
}

/** "I've already started one" — the home bar's third answer.
 *
 *  WHAT MAKES IT ITS OWN ANSWER rather than a flavour of "got my own": there is
 *  a rental running. Veo is billing by the minute right now, which makes this
 *  the ride where the cost readout matters MOST, and it makes the trip a
 *  tracked one against a specific vehicle rather than a private recording of
 *  nothing in particular. Both answers skip the picker and that is all they
 *  share; sending this rider down the own-device path priced their ride at zero
 *  and recorded it as having been on no scooter at all.
 *
 *  WHY THE SCAN IS NOT NEGOTIABLE. The whole answer is "this one, the one I am
 *  sitting on", and the thing that names it server-side is a salted hash no
 *  browser can compute. The sticker on the stem is the only thing in reach that
 *  carries it. A plate typed from memory would also be a claim about a vehicle
 *  the rider might not be on, which is the distinction `qr-ride-scan.ts` and
 *  master §13.8.1 both turn on — so it is the scan or nothing.
 *
 *  Returns false when the trip was NOT taken, which hands the rider back to the
 *  home bar with their destination intact: backing out of a camera is not
 *  changing your mind about where you are going. */
async function planStartedTrip(trip: {
  dest: TripPlace;
  start: TripPlace | null;
}): Promise<boolean> {
  const scanned = await scanForStartedVehicle();
  if (!scanned) return false;

  setPendingTrip({ dest: trip.dest, wheels: "started", start: trip.start });
  // Everything the wizard would otherwise ask is already answered: which
  // scooter (the scan), where to (the home bar), and whether it is unlocked
  // (that is what this answer MEANS). So Screen 2 skips on `deviceConfirmed`,
  // Screen 3 skips on the destination the trip carries, and Screen 6 takes its
  // `autoStart` branch — the same branch the device card's "I started the Veo
  // already" takes, because it is the same claim arriving through a different
  // door and must not produce a different session.
  //
  // Screen 4 still shows. The rider named a destination, and route choice is
  // what they named it FOR; the meter running is a reason to make that screen
  // quick, not a reason to skip the thing they asked for.
  //
  // One honest imprecision, worth knowing rather than hiding: the ride clock
  // starts when `POST /tracked-rides` does, and the unlock happened a minute or
  // two earlier. The HUD's ±15s/±1m nudges and its reset exist for exactly this
  // and are the right place to fix it — inventing an earlier start time here
  // would be guessing at the number the rider is actually being billed on.
  openRideModal({
    vehicleIdentifier: scanned.vehicleIdentifier,
    plate: scanned.plate,
    deviceConfirmed: true,
    autoStart: true,
    fastForwardTo: "4",
  });
  return true;
}

/** Open the camera and resolve what it reads to a vehicle in the live feed.
 *
 *  Resolves to null for every way this can come to nothing — cancelled,
 *  unreadable, or a plate no live vehicle carries — having already told the
 *  rider which. The caller only needs to know it did not work. */
function scanForStartedVehicle(): Promise<ScannedVehicle | null> {
  return new Promise((resolve) => {
    let handed = false;
    openQrScanner({
      prompt: "Scan the QR code on the scooter you're riding",
      onScan: (rawValue) => {
        handed = true;
        const plate = plateFromQr(rawValue);
        void (plate ? resolveScannedVehicle(plate) : Promise.resolve(null)).then(
          (vehicle) => {
            if (vehicle) {
              resolve(vehicle);
              return;
            }
            // The same two failures `qr-ride-scan.ts` separates, in the same
            // words, because they are different problems with different next
            // steps: aim the camera again, versus this scooter is not in the
            // fleet right now.
            showMovedToast(
              qrRideMessage(
                plate === null
                  ? { kind: "unreadable" }
                  : { kind: "unknown_vehicle", plate },
              ),
            );
            resolve(null);
          },
        );
      },
      // CANCEL IS DECIDED A TICK LATE, ON PURPOSE.
      //
      // `qr-scan.ts` closes itself and THEN delivers the payload — `close()`
      // (which fires this) and `options.onScan(raw)` are adjacent synchronous
      // statements, in that order. So at the moment this runs, `handed` is
      // still false even for a scan that is about to succeed, and resolving
      // null here settles the promise before the payload arrives: the home
      // bar refuses the trip and "I've already started one" can never start a
      // ride. (This comment used to assert the opposite ordering, which is how
      // the bug got written.)
      //
      // A microtask is enough and is guaranteed: `onScan` runs in the same
      // task, immediately after, so by the time this fires `handed` is true
      // for a real scan and still false for a real cancel.
      onClose: () => {
        queueMicrotask(() => {
          if (!handed) resolve(null);
        });
      },
    });
  });
}

// ---------- Walk to the scooter, then ride ----------

// The flow that replaced a run of wizard screens for the case where the app
// already knows everything they asked about: the rider named a destination on
// the home bar and then tapped a specific scooter. All that is left is getting
// them to it and getting them moving.
let walkLeg: WalkLegHandle | null = null;
let arrivalPanel: ArrivalPanelHandle | null = null;
let deviceWatch: DeviceWatchHandle | null = null;

/** Close the find-a-scooter panel and its ranked list. Exported from the
 *  mode wiring via a module-level handle because `wireModes` owns the wizard
 *  and the drawer, and the walk flow is the only other thing that needs to
 *  put them away. */
let exitFindWheels: () => void = () => {};
/** Enter the find-a-ride flow. Named, and called directly (Phase 6 §6.2).
 *  Every caller used to synthesise a click on a `hidden` button in
 *  `#mode-switch` — right for the move that put the home bar in charge, wrong
 *  to leave, and two modules had already had to learn about the seam. Assigned
 *  by `wireModes`; a no-op before it runs. */
let enterFindWheels: () => void = () => {};
/** Shut whichever drawer is open. Published for the same reason
 *  `enterFindWheels` is: `setDrawer` is a closure inside `wireDrawers`, and
 *  module-level code (here, the plan list's 🔍) needs to get the panel out of
 *  the way of the map it is about to point at. Inert until that wiring runs,
 *  which is before any of this is reachable. */
let closeDrawer: () => void = () => {};

/** The plan list, while it is on screen. One at a time: two of these would be
 *  two surfaces arguing about one decision. */
let planListPanel: PlanListPanelHandle | null = null;
/** §11.9's reading surface. Built on the drawer's first open, never at boot. */
let tripPanel: TripPanelHandle | null = null;

/** Today's tracked rides, for §2.2's free-minute estimate.
 *
 *  `null` means WE HAVE NOT LOOKED, and `estimateFreeMinutes` reads that as the
 *  pessimistic figure — the hour is gone, price every minute. An empty array
 *  means we looked and the rider has taken none today, which is a much stronger
 *  statement and a different sentence on the control. Conflating them would tell
 *  a rider with a full hour that we cannot see their rides. */
let todaysRides: readonly RideSpan[] | null = null;

/** The wizard interview's answer, for as long as this trip lasts.
 *
 *  THE WHOLE POINT OF THE RESTRUCTURE. The interview used to hand its answer to
 *  `recommend.ts` and nowhere else, so the plan list — which is what "need
 *  wheels" actually opens — was built from the saved `RideSpec` alone and had
 *  never heard of it. A rider answered "I want a Cosmo" and got plans ranked as
 *  though they had said nothing. Held here so `planSearchDeps` can compose it
 *  over the spec, exactly as Two Passengers is composed.
 *
 *  Cleared on leaving the flow, with the recommendations: it is an answer about
 *  THIS trip, and letting it steer the next one would be the same bug pointed
 *  the other way. */
let interviewAnswers: InterviewAnswers | null = null;

/** Whether the rider's ideal scooter is applied to THIS search.
 *
 *  Standing state asked about per trip. The sheet binds every search once it is
 *  filled in, which is right for a preference and wrong for the trip where the
 *  rider is in a hurry and would take the scruffy scooter they normally
 *  decline. Defaults true — it is their sheet and they meant it — and resets
 *  with the rest of the flow, because standing it down is a decision about one
 *  journey. */
let useIdealSpec = true;

/** Whether the signed-in profile carries a PROVED phone number.
 *
 *  Null until the profile answers, and null again when there is no session —
 *  which the Navigation tab renders as "sign in and verify a phone", not as
 *  "you have no phone". Conflating the two tells a rider with a verified number
 *  to go and verify it. */
let phoneVerified: boolean | null = null;


/** Drop the plan list, leaving the rider on the ranked scooters below it.
 *
 *  NO RIBBON BORROW ANY MORE, and no close/teardown split either. Both existed
 *  because the list was a card floating over the map: at 412px it ran under the
 *  open ribbon, so opening it closed the strip and dismissing it handed the
 *  strip back — and because every re-solve re-opened the list, that round trip
 *  had to be split in two or the ribbon flapped once per search. The list is a
 *  section of the Recommended drawer now. The drawer was never under the
 *  ribbon, so there is nothing to borrow and nothing to give back.
 *
 *  DISMISSING IS NOT CLOSING THE DRAWER. The scooter list is right below this
 *  section and is the path the rider was always on; emptying the section leaves
 *  them on it, in place. Closing the whole drawer would take away the thing
 *  they fell back to. */
function closePlanList(): void {
  planListPanel?.destroy();
  planListPanel = null;
}

/** "Clear my trip" — throw away everywhere the trip is written down.
 *
 *  THE WHOLE POINT IS THAT IT IS ONE BUTTON. The destination lives on the ride
 *  session doc, the pending trip lives in its own store, the hand-offs live in
 *  the trip ledger, and the pins and the route line live on the map. A rider
 *  who says "I'm not going anywhere" means all five, and before this they had
 *  no way to say it at all: the only exits were arriving and starting a
 *  different trip.
 *
 *  Called only when `clearBlockedReason` says it may be (no live ride) — the
 *  guard lives beside the button, which is where the rider is told about it.
 *  `rideSession.replace(null)` is the pre-ride doc, the one the wizard built
 *  to hold a destination; dropping it is what makes the home bar go back to
 *  asking "Where to?". */
function clearTrip(): void {
  clearPendingTrip();
  endTrip();
  rideSession.replace(null);
  tripPins.clear();
  rideRouteLine.clear();
  // The plan and the answers that shaped it. Keeping an interview answer past
  // the trip it was given for is the bug the plan-list restructure fixed —
  // last trip's "I want a Cosmo" has no business steering the next one.
  closePlanList();
  interviewAnswers = null;
  recommended?.clear();
  exitFindWheels();
  track("trip_cleared", {});
}

/** What `rankPlans` needs, gathered from the live app.
 *
 *  `plan-search.ts` owns the assembly and says why each of these is a decision
 *  rather than a lookup — in particular that the fleet is `allFeatures()` and
 *  never the filtered view, because a rider's leftover map filters are a view
 *  and the SPEC is what says what they will ride. */
/** The sheet this search should run on.
 *
 *  One function so the spec, the interview note and the ideal share cannot
 *  disagree about whether the rider's sheet is in force — three readings of the
 *  same question is how a list gets filtered by something its own explanation
 *  says is off. */
function activeSpecForSearch(): RideSpec {
  if (!useIdealSpec) return defaultSpec();
  return rideSpecPanel?.activeSpec() ?? defaultSpec();
}

function planSearchDeps(): PlanSearchDeps {
  return {
    fleet: () => devices.allFeatures(),
    origin: () => {
      const fix = locate.current();
      return fix ? { lat: fix.lat, lng: fix.lng } : null;
    },
    // TWO PASSENGERS BINDS THE PLANNER, which no other quick filter does —
    // map filters are a view and this is a fact about the trip. Composed over
    // the rider's own spec rather than replacing it: two passengers is a
    // constraint on top of what they like, not instead of it.
    // TWO LAYERS OVER THE RIDER'S OWN SHEET, in increasing order of how much
    // they were thinking about it. `applyInterview` is the question the wizard
    // asked on the way out of the door, so it only ever NARROWS and never adds
    // a hard requirement — the ladder can give all of it up. `applyTwoPassengers`
    // is outermost because it is the one hard physical fact in the stack: a
    // one-seater cannot carry two people at any ranking.
    spec: () =>
      applyTwoPassengers(
        applyInterview(activeSpecForSearch(), interviewAnswers),
      ),
    // The same value WITHOUT the default, which is the only way to tell "no
    // preference" from "a preference that happens to accept everything". The
    // list uses it to decide whether a share is worth computing and whether to
    // offer to set one up.
    // Null when the rider stood the sheet down, which is what makes the ideal
    // SHARE stop being computed and the chip stop being shown: a share against
    // a sheet that is not in force is a number about nothing.
    activeSpec: () => (useIdealSpec ? rideSpecPanel?.activeSpec() ?? null : null),
    // Written against the spec BEFORE the interview narrowed it, which is the
    // only comparison that can tell whether the answer changed anything — and
    // the only honest basis for claiming it did.
    // `relaxed` comes from the search that just ran, so the sentence cannot
    // claim an answer was honoured when the ladder gave it up to find anything
    // at all — which it did, sitting directly under "we had to give up: Model".
    idealSpecSummary: () => {
      const sheet = rideSpecPanel?.activeSpec();
      return sheet ? specSummary(sheet, (key) => MODEL_NAMES[key]) : null;
    },
    idealSpecInUse: () => useIdealSpec,
    interviewNote: (relaxed) =>
      interviewNote(
        activeSpecForSearch(),
        interviewAnswers,
        (key) => MODEL_NAMES[key],
        relaxed,
      ),
    rate: () => planFor(effectiveRatePlan()),
    taxRate: () => currentTaxRate(),
    now: () => Date.now(),
    // NO `favorites`, and that is not an omission to be tidied up later.
    //
    // `along-the-way.ts`'s favourite bonus wants VEHICLE keys, and this app has
    // no favourite-vehicle store: `my-scooters.ts` was built, shipped and then
    // deleted as the wrong feature (see the plan's module map). `favorites.ts`
    // is saved PLACES — Home, Work, lat/lon and an emoji — so handing it over
    // would pass place ids as vehicle keys, match nothing, and silently never
    // apply the bonus. A dead ranking term that looks wired is worse than one
    // that is visibly absent. `device-notify.ts`'s watch list is not a
    // substitute either: "tell me when this moves" is not "I prefer this one",
    // and ranking on it would read a rider's curiosity as a preference.
    // §2.2, both halves. `todaysRides` is null until the fetch lands, which the
    // estimate reads as the pessimistic figure rather than as an empty day — so
    // a list opened before the response arrives prices nothing as free, and
    // re-prices upward when it does. The rider's own correction WINS over both,
    // without being averaged against them: they can see their Veo app and this
    // module cannot, and blending the two produces a number neither of us
    // believes.
    rides: () => todaysRides,
    riderSaysRemaining: () => savedCorrection(Date.now()),
    signedIn: () => isAuthenticated(),
  };
}

/** "Need wheels" — §2.4's plan list, which is what that answer has always
 *  meant and what the Phase 2 engine was built to answer.
 *
 *  FALLS BACK TO THE MAP RATHER THAN FAILING. Without a GPS fix there is no
 *  origin, and a plan list computed from a guessed one walks the rider to a
 *  scooter that is not near them. The map chooser needs no fix to be useful —
 *  the rider can see where they are — so that is where they go instead. Same on
 *  dismissal: closing the list should not leave them on a bare map with the
 *  question they just asked unanswered. */
/** §11.9's hand-off: leg one is over, offer the rest of the way.
 *
 *  THE ONE PLACE THAT CAN DO IT. A leg boundary is a ride boundary, and the
 *  ride does not finish on Screen 8 — it finishes after Screens 9 and 10, when
 *  the doc leaves the post-ride states. Screen 8 itself must not offer a next
 *  scooter: the first one is still rented to the rider at that point, and a
 *  flow that handed them a second would be charging them for two.
 *
 *  IT RE-SOLVES, IT DOES NOT REPLAY. The vehicle the original plan named is
 *  minutes old and the fleet has moved, so this asks `rankPlans` again from
 *  where the rider is standing now to where they were always going. That is
 *  also why the ledger stores a destination and not a route.
 *
 *  Watching for the TRANSITION rather than the state, because this subscription
 *  fires on every dispatch and an offer that re-opened itself on each one would
 *  be a plan list the rider cannot dismiss.
 *
 *  The trip is cleared on arrival, and also whenever the rider finishes a ride
 *  with no destination left to solve — a ledger with nothing to offer is a
 *  stale badge waiting to appear on an unrelated ride three days later. */
function wireNextLegHandoff(): void {
  let wasInFlight = false;
  rideSession.subscribe(() => {
    const doc = rideSession.current();
    const inFlight = doc !== null && (isRideLive(doc) || isPostRide(doc));
    const justFinished = wasInFlight && !inFlight;
    wasInFlight = inFlight;
    if (!justFinished) return;
    const trip = activeTrip();
    if (trip === null) return;
    if (tripComplete(trip) || trip.dest === null) {
      endTrip();
      return;
    }
    // The FINAL destination, deliberately, not the next hand-off: this is the
    // re-solve, and what it asks is "how do I get the rest of the way from
    // here" — the planner picks the vehicles, which is the whole point of
    // asking it again rather than replaying a stored route. The hand-offs the
    // new plan names replace the old ones when the rider takes it.
    openPlanList({ label: trip.dest.label, lat: trip.dest.lat, lon: trip.dest.lon });
  });
}

function openPlanList(dest: TripPlace): void {
  const deps = planSearchDeps();
  const first = searchPlans(deps, dest);
  if (first.kind !== "ok") {
    // `no_fix`: no GPS, so no origin, and a plan list computed from a guessed
    // one walks the rider to a scooter that is not near them.
    //
    // THIS USED TO CALL `enterFindWheels()`, which was right when the plan list
    // was the FIRST thing "need wheels" opened — falling back to the map
    // chooser was strictly better than a wrong list. It is wrong now: the
    // interview has already run by the time this is reached, and
    // `enterFindWheels` starts the wizard, so this would re-ask the rider the
    // question they just answered.
    //
    // The honest fallback is the one the rider is already on. They are standing
    // in the Recommended drawer with the ranked scooters below this section, so
    // leaving it empty puts them on exactly the path they would have dismissed
    // the plans to reach — with a line saying why, because a section that asked
    // for plans and silently shows none reads as a failure rather than a
    // missing fix.
    const why = document.createElement("p");
    why.className = "planlist__note planlist__note--quiet";
    why.textContent =
      "We need your location to work out the ways there. The scooters below " +
      "are ranked for what you asked for.";
    need("plan-list").replaceChildren(why);
    return;
  }
  closePlanList();
  // NO `enterFindWheels()` HERE, and removing it is the fix the rider asked
  // for. It was called so that dismissing the list revealed a map already in
  // find-wheels state — a reasonable thing to want, except `enterFindWheels`
  // also runs `wizard.start()`. So "need wheels" put an interview on screen AND
  // a list of plans over the top of it, two surfaces asking for the same tap,
  // with the interview's answer going nowhere near the plans.
  //
  // The interview comes FIRST now (see `onPlanTrip`), and its answer is what
  // these plans are built from. By the time this runs the rider has already
  // answered, so there is nothing left to start.
  const resolve = (): void => {
    const again = searchPlans(deps, dest);
    if (again.kind === "ok") planListPanel?.update(again.view);
  };
  planListPanel = createPlanListPanel(need("plan-list"), first.view, {
    onChoose: (row) => takePlanRow(row),
    // Empties this section and leaves the drawer open on the ranked scooters
    // below — the old path, continued in place.
    onCancel: () => closePlanList(),
    // "My ideal scooter" lives in the Filters drawer, which is where it has
    // always lived and where a rider who already knows about it will look for
    // it. Dismissing the list first because the drawer is the thing they are
    // being sent to — two stacked surfaces over a map is how somebody loses
    // track of which one they are pressing, which is the same argument §11.7
    // made about the HUD's two sheets.
    onConfigureSpec: () => {
      closePlanList();
      document
        .querySelector<HTMLButtonElement>('.drawer-tab[data-drawer="devices"]')
        ?.click();
      // The spec controls live inside a collapsed `<details>` accordion, so
      // opening the drawer alone lands the rider on a closed section with no
      // sign of what they came for. Open the section, then put the control in
      // view — in that order, because scrolling to something with zero height
      // scrolls to the wrong place.
      const edit = document.getElementById("spec-edit");
      edit?.closest("details")?.setAttribute("open", "");
      edit?.scrollIntoView({ block: "center", behavior: "smooth" });
      // Focus last, and only the control itself: a rider sent here by a button
      // should be able to carry straight on with the keyboard.
      try {
        edit?.focus({ preventScroll: true });
      } catch {
        /* detached, or an engine without the options bag */
      }
    },
    onRefresh: resolve,
    // Standing the sheet down, or putting it back. Re-solves rather than just
    // re-labelling: the sheet is a FILTER, so turning it off can change which
    // plans exist and in what order, not only what the row above them says.
    onToggleIdealSpec: (on) => {
      useIdealSpec = on;
      resolve();
    },
    // The same three answers the interview offers, changeable in place. Also a
    // re-solve, for the same reason, and it writes the same state the wizard
    // wrote — so a rider who changes their mind here and then re-enters the
    // flow finds their new answer, not the one they abandoned.
    priority: () => interviewAnswers?.priority ?? null,
    onSetPriority: (priority) => {
      interviewAnswers = {
        // The model only matters to the "type" answer, and the wizard already
        // asked it. Keeping the previous choice means switching to Condition
        // and back does not silently forget which model they wanted.
        typeChoice: interviewAnswers?.typeChoice ?? "cosmo",
        priority,
      };
      resolve();
    },
    // 🔍 — put the hand-off on the map and get out of the way.
    onShowSwitchover: (row) => showSwitchover(row),
    onCorrectFreeMinutes: (minutes) => {
      saveCorrection(Date.now(), minutes);
      // Re-price rather than just re-label. The free-minute balance is SEARCH
      // STATE — `searchOnce` makes a node `(location, free minutes consumed)`
      // precisely because pricing a whole plan under one regime is unsound — so
      // a corrected figure can change which plans exist and in what order, not
      // only what the control says above them.
      resolve();
    },
  });
  // §2.2's estimate, fetched AFTER the list is on screen and never before it.
  // A rider who asked for plans gets plans; the figure arrives and the list
  // re-prices upward. "A failure degrades to the client tier and never blocks
  // the list" is §2.3's rule for the routed tier and it applies here for the
  // same reason.
  void refreshTodaysRides().then((changed) => {
    if (changed) resolve();
  });
}

/** Put the scooter the rider SWAPS TO on the map, and minimise the drawer.
 *
 *  WHY THE DRAWER HAS TO GO. The point of the tap is to see a place, and on a
 *  phone the drawer is most of the screen — leaving it open would centre the
 *  map on a vehicle behind the panel the rider tapped. So the drawer closes and
 *  the plans stay built: re-opening the Recommended tab brings the list back
 *  exactly as it was, because `closePlanList` was not called.
 *
 *  `DeviceProperties` carries no coordinates, so the feature is looked up by
 *  `device_id` against `allFeatures()` — the unfiltered fleet, and deliberately
 *  so. The planner searches unfiltered, so a plan can legitimately hand off to
 *  a vehicle the rider's map filters are hiding; looking it up in the filtered
 *  view would make the button do nothing on exactly those plans.
 *
 *  `jumpToDevice` centres it either way and opens the popup only for a vehicle
 *  the display filters keep, which is the honest outcome: the rider is shown
 *  where the swap is even when the scooter itself is filtered off the map. */
function showSwitchover(row: PlanRow): void {
  const props = row.switchoverVehicle;
  if (!props) return;
  const feat = devices
    .allFeatures()
    .find((f) => f.properties.device_id === props.device_id);
  if (!feat) return;
  const [lng, lat] = feat.geometry.coordinates;
  closeDrawer();
  devices.jumpToDevice(props.device_id, lng, lat);
}

/** Today's tracked rides, for the free-minute estimate. Resolves to whether the
 *  figure changed, so a caller can avoid re-pricing for nothing.
 *
 *  ONLY FOR THE ACCESS TIER, and only signed in. The other four have no free
 *  hour — `searchOnce`'s budget is 0 for them regardless — so this would be a
 *  request whose answer is discarded. A rider who has already given their own
 *  figure does not need it either: their answer wins, so counting rides to
 *  produce an estimate that loses is work with no consequence. */
async function refreshTodaysRides(): Promise<boolean> {
  if (todaysRides !== null) return false;
  if (!isAuthenticated()) return false;
  if (effectiveRatePlan() !== "equity") return false;
  if (savedCorrection(Date.now()) !== null) return false;
  try {
    todaysRides = spansOf((await listTrackedRides({ limit: 40 })).rides);
    return true;
  } catch {
    // Left as null, which the estimate reads as the pessimistic figure. A failed
    // count must not become an empty day: that would hand the rider a full hour
    // on the strength of a network error.
    return false;
  }
}

/** Hand a chosen plan to the walk flow.
 *
 *  ONLY THE FIRST LEG IS ACTED ON, and the rest of the plan is deliberately not
 *  carried anywhere yet. Honouring a hand-off end to end needs the living plan
 *  (Phase 3) — the re-solve, the claim that moves, the loss detection — and a
 *  walk flow that silently forgot legs two and three would be worse than one
 *  that never claimed to have them. So this starts the rider on the first
 *  scooter, which is the whole of what every existing surface does, and the
 *  list it came from stays on screen state-free. */
function takePlanRow(row: PlanRow): void {
  const props = row.firstVehicle;
  if (!props) return;
  // §11.9: open a trip ledger IFF the plan the rider chose has a hand-off in
  // it. Before this, `takePlanRow` walked them to the first vehicle and threw
  // the plan away, so the ride flow below had no idea a second leg was coming
  // — the clock restarted, the cost restarted, and Screen 8 congratulated them
  // on arriving while they stood at a hand-off point with a mile to go.
  //
  // `startTrip` refuses a single-ride plan itself, so this is not a guard so
  // much as a declaration: a one-scooter plan is an ordinary ride, and a "leg 1
  // of 1" badge would be chrome telling the rider something they knew. Done
  // BEFORE the walk flow starts, so the arrival panel and everything after it
  // see the trip on their first render.
  const rideVehicles = row.plan.legs
    .filter((l) => l.mode === "ride")
    .map((l) => l.vehicle ?? null);
  const rideLegs = rideVehicles.length;
  if (rideLegs >= 2) {
    const pending = peekPendingTrip()?.dest ?? null;
    // WHERE EACH HAND-OFF HAPPENS: the pickup point of legs 2..N, which is
    // simply where the vehicle each of those legs starts on is standing right
    // now. Leg one's own pickup is the walk the rider is about to take, so it
    // is not a hand-off and is skipped.
    //
    // `TripLeg.vehicle` is `DeviceProperties`, which carries no coordinates —
    // the same feature lookup `takePlanRow` already does for the first vehicle
    // is how a position is had. A vehicle that cannot be located TRUNCATES the
    // list rather than leaving a gap, because these are positional and a gap
    // would route leg two to leg three's pickup.
    const handOffs: { label: string; lat: number; lon: number }[] = [];
    for (const v of rideVehicles.slice(1)) {
      if (!v) break;
      const feat = devices
        .allFeatures()
        .find((f) => f.properties.device_id === v.device_id);
      if (!feat) break;
      const [hLng, hLat] = feat.geometry.coordinates;
      handOffs.push({
        label: vehicleDisplayName(
          v.public_name,
          null,
          v.vehicle_model_name,
          v.plate_suffix,
        ),
        lat: hLat,
        lon: hLng,
      });
    }
    startTrip({
      plannedRides: rideLegs,
      dest:
        pending === null
          ? null
          : { label: pending.label, lat: pending.lat, lon: pending.lon },
      handOffs,
    });
  } else {
    // Choosing a one-scooter plan is also the rider saying this is the trip
    // now, so any ledger from an abandoned multi-leg plan goes with it.
    endTrip();
  }
  const feature = devices
    .allFeatures()
    .find((f) => f.properties.device_id === props.device_id);
  if (!feature) return;
  const [lng, lat] = feature.geometry.coordinates;
  closePlanList();
  void beginWalkToVehicle({
    name: vehicleDisplayName(
      props.public_name,
      null,
      props.vehicle_model_name,
      props.plate_suffix,
    ),
    // The raw plate is not on the public payload, and `beginWalkToVehicle`
    // treats a missing one as "Veo can only be opened cold" rather than as an
    // error. The ride flow downstream resolves it when it needs one.
    plate: null,
    vehicleIdentifier: props.vehicle_identifier ?? null,
    lat,
    lng,
  });
}

function endWalkFlow(): void {
  deviceWatch?.stop();
  deviceWatch = null;
  walkLeg?.stop();
  walkLeg = null;
  arrivalPanel?.destroy();
  arrivalPanel = null;
  walkLine.clear();
  document.body.classList.remove("arrival-open");
}

function beginWalkToVehicle(info: {
  name: string;
  plate: string | null;
  vehicleIdentifier: string | null;
  lat: number;
  lng: number;
}): boolean {
  // A destination is a bonus, not a prerequisite. Walking to a scooter is
  // worth doing IN THIS APP whether or not the rider has said where they are
  // going afterwards — the alternative was a link that opened Google Maps,
  // which is the app admitting it cannot do the one thing it just asked the
  // rider to do. Without a trip the arrival panel hands off to the ride flow,
  // which asks for the destination itself, correctly, because it genuinely
  // does not know it. The panel reads the trip on each render rather than
  // taking a copy here, so that "bonus" can also be added mid-walk.

  endWalkFlow();
  closeAllPopups();
  // The choice is made. Leaving the chooser open behind the walk is two
  // surfaces arguing about one decision, and the ranked list is stale the
  // moment a scooter is picked out of it.
  exitFindWheels();
  // THE PLAN LIST IS A CHOOSER TOO, and the sentence above is about it as much
  // as about find-wheels mode. `takePlanRow` closes it on its own way through,
  // but that is not the only way in: a rider can leave the list open and tap a
  // scooter on the map, or resume a dibs claim from a toast, and both land here.
  // Without this the list floats over the arrival panel offering four plans for
  // a trip the rider has already started walking.
  closePlanList();
  document.body.classList.add("arrival-open");

  // CLAIMING IS PART OF GOING, and this is where every route into a walk meets.
  //
  // The device popup's "I'll ride this one" has always called dibs — the
  // sentence that picks a scooter is the sentence that claims it. A scooter
  // picked off a PLAN said the same thing and claimed nothing, because that
  // route into the walk went through here instead. So it claims here too, which
  // also covers the two other ways in (a tap on the map, resuming a claim from
  // a toast) rather than leaving each to remember.
  //
  // `callDibs` is idempotent on the vehicle identifier, so the popup's own
  // claim a moment earlier is returned rather than duplicated — the two paths
  // can both run without fighting.
  //
  // Guarded on the rider's answer (`autoDibs`, default on) and on there BEING
  // an identifier: dibs is keyed on it, and a private scooter or a payload
  // without one has nothing to claim.
  if (info.vehicleIdentifier && autoDibs()) {
    const here = locate.current();
    const claim = callDibs({
      vehicleIdentifier: info.vehicleIdentifier,
      vehicleName: info.name,
      plate: info.plate,
      claimedBy: dibsClaimant,
      startMeters: here
        ? distanceMeters(here, { lat: info.lat, lng: info.lng })
        : 0,
      lat: info.lat,
      lon: info.lng,
    });
    // The watch rides along, exactly as it does from the popup: a rider being
    // told they have dibs is the same breath in which to say we will warn them
    // if it goes. Both are best-effort — `armDibsWatch` refuses past its own
    // slot limits and `requestDibsNotifications` can be denied — and neither
    // may stop the walk starting.
    armDibsWatch(claim);
    void requestDibsNotifications();
    // AND IT HAS TO REACH THE SERVER. `callDibs` writes the phone's copy;
    // the certificate's timestamp, every other rider's dimmed map and the
    // SMS watch all read the row. A claim made here and never registered
    // was a claim only this phone believed in.
    //
    // Guarded on `registration`: `callDibs` is idempotent on the vehicle
    // identifier, so a claim the device popup already registered a moment
    // ago comes back with its row attached and must not be inserted twice.
    if (claim.registration === null) {
      void registerDibs({
        vehicle_identifier: claim.vehicleIdentifier,
        vehicle_name: claim.vehicleName,
        plate: claim.plate,
        claimed_by: claim.claimedBy,
        lat: info.lat,
        lon: info.lng,
        notify_sms: dibsSmsAlerts(),
      })
        .then((reg) => {
          saveDibs({
            ...claim,
            registration: {
              id: reg.id,
              verifyUrl: reg.verify_url,
              qrUrl: reg.qr_url,
            },
          });
        })
        .catch(() => {
          /* the certificate falls back to this phone's own timestamp */
        });
    }
  }

  const panel = createArrivalPanel(need("arrival-panel"), {
    vehicle: { name: info.name, plate: info.plate ?? undefined },
    // Re-read, never captured: `onChangeDestination` below rewrites the
    // pending trip while this panel is on screen.
    destinationLabel: () => peekPendingTrip()?.dest.label ?? null,
    onChangeDestination: () => {
      // The one-question form. The wheels question is already answered —
      // they walked to a scooter — so the bar answers only "where to?" and
      // hands it straight back rather than dispatching a fresh trip that
      // would tear down the walk flow the rider is standing in the middle of.
      homeBar?.openForDestination((place) => {
        const existing = peekPendingTrip();
        setPendingTrip({
          dest: place,
          // Keep whatever the trip already said about the other two. A rider
          // correcting their destination has not changed their mind about
          // riding a scooter, or about where they set off from.
          wheels: existing?.wheels ?? "need",
          start: existing?.start ?? null,
        });
        panel.refreshDestination();
      });
    },
    onChooseRoute: () => {
      // "I'VE GOT IT." The one moment the rider declares they are taking
      // THIS scooter, and the only chance to stop the server texting them
      // about their own rental: its alert fires on "a rental started on this
      // vehicle", which is all the fleet feed says, and the commonest such
      // rental is the claimant's own. Fire-and-forget — a rider about to
      // unlock a scooter should not wait on us, and the worst case of it not
      // landing is one honest-but-unnecessary text.
      const held = info.vehicleIdentifier
        ? dibsOn(info.vehicleIdentifier)
        : null;
      if (held?.registration) void claimDibsAsMine(held.registration.id);
      endWalkFlow();
      // Straight to route triage. The wizard still owns starting a ride — it
      // is where the session doc, the track store and the Veo handoff live —
      // and Screen 6's unlock sits downstream of Screen 4's route choice,
      // which is exactly the order the meter demands.
      openRideModal({
        vehicleIdentifier: info.vehicleIdentifier ?? undefined,
        plate: info.plate ?? undefined,
        // They walked to it. There is nothing left to confirm.
        deviceConfirmed: true,
        fastForwardTo: "4",
      });
    },
    onCancel: () => {
      // BACKING OUT RELEASES THE CLAIM. A rider who closes this has stopped
      // walking towards the scooter, and dibs nobody is honouring is exactly
      // the hoarding the ten-minute rule exists to prevent — it would just
      // take ten minutes to expire instead of going immediately. Dropping it
      // here also means the next person sees the scooter free the moment it
      // is free.
      if (info.vehicleIdentifier) dropDibs(info.vehicleIdentifier);
      endWalkFlow();
    },
    // THE WALK'S WORST OUTCOME, RECORDED. They went out of their way to get
    // here and it will not ride. Telling us costs them one tap, and it is the
    // only signal strong enough to stop the next rider making the same walk —
    // see `ride-failed-start.ts` for what the fleet infers without it.
    //
    // The claim goes too, for the same reason `onCancel` drops it: they have
    // stopped walking towards this scooter, and holding a dead one is worse
    // than holding a live one.
    onNotRideable: async () => {
      const { message } = await reportFailedStart(
        {
          vehicleIdentifier: info.vehicleIdentifier,
          lat: locate.current()?.lat,
          lng: locate.current()?.lng,
        },
        submitDeviceReport,
      );
      if (info.vehicleIdentifier) dropDibs(info.vehicleIdentifier);
      return message;
    },
    // Re-read each update rather than closing over a copy: the claim gains
    // its "started walking" stamp as the rider moves, and a stale copy would
    // keep telling them to set off after they had.
    dibs: () => (info.vehicleIdentifier ? dibsOn(info.vehicleIdentifier) : null),
  });
  arrivalPanel = panel;

  walkLeg = startWalkLeg(
    { lat: info.lat, lng: info.lng, label: info.name },
    {
      locate,
      drawRoute: (coords) => {
        if (!coords || coords.length < 2) walkLine.clear();
        // Green, not the ride route's profile colour: this is the leg you do
        // on foot, and two lines in the same colour would read as one route.
        else walkLine.set(coords, { color: "#2f9e44", dest: [info.lng, info.lat] });
      },
      onChange: (state) => {
        // Rule 1 is satisfied by MOVEMENT, and this is the only place that
        // sees it: fold each fresh distance into the claim so "started
        // walking" gets stamped and the grace stops applying.
        const vid = info.vehicleIdentifier;
        if (vid && state.remainingMeters !== null) {
          const held = dibsOn(vid);
          if (held) {
            const next = recordProgress(held, state.remainingMeters);
            if (next !== held) saveDibs(next);
          }
        }
        panel.update(state);
      },
    },
  );
  panel.update(walkLeg.state());

  // WATCH IT WHILE THEY WALK. Somebody standing next to the scooter can
  // unlock it at any moment, and every second between that happening and the
  // rider knowing is a second spent walking the wrong way.
  if (info.vehicleIdentifier) {
    deviceWatch = watchDevice(info.vehicleIdentifier, {
      lookup: (id) => {
        const f = devices
          .allFeatures()
          .find((x) => x.properties.vehicle_identifier === id);
        if (!f) return undefined;
        const p = f.properties as unknown as Record<string, unknown>;
        const bool = (v: unknown): boolean => v === true || v === "true" || v === 1;
        return {
          vehicleIdentifier: id,
          // is_reserved means IN USE on this operator, not a held booking.
          inUse: bool(p.is_reserved),
          rentable: !bool(p.is_disabled),
          // Our own read, not Veo's — see device-watch.ts's two categories.
          looksRideable: !bool(p.is_disabled) && !bool(p.is_reserved),
        };
      },
      onRefresh: (cb) => {
        window.addEventListener("scooter:devices-refreshed", cb);
        return () => window.removeEventListener("scooter:devices-refreshed", cb);
      },
      onGone: (reason) => {
        track("device_gone", { reason });
        // Say it where the rider is already looking, and stop pointing them
        // at a scooter that is not there.
        walkLine.clear();
        arrivalPanel?.reportGone(goneMessage(info.name, reason));
      },
    });
  }
  return true;
}

// ---------- Equity areas ----------

// One switch, in Areas: draw the city's official Equity Area map. OFF by
// default — it is a compliance boundary covering a large share of the city,
// and someone opening this app to find a scooter did not ask for a purple
// wash over their neighborhood.
//
// Note what is NOT gated on this switch: the on-screen indicator. A rider
// who never turns the polygons on still gets told when they are looking at
// an equity area, because otherwise the discount stays discoverable only to
// people already looking for it — the exact asymmetry this app exists to
// correct.
/** The Areas drawer's city-rules section.
 *
 *  Three group switches and a muted switch, all reading their defaults from
 *  `index.html` the way the equity controls do — one attribute to change a
 *  default, rather than two files that have to agree.
 *
 *  ON by default for the rules group alone. This is the only overlay in the
 *  app that can stop somebody breaking a rule they did not know about, and it
 *  comes from the city rather than from us; school grounds and Glendale stay
 *  off because both are drawn from land, not from a stated restriction (see
 *  `micromobility-zones.ts`). */
/** The Areas drawer's Rover-area switch.
 *
 *  Separate from the city-rules block next door, and deliberately so: those
 *  polygons are Denver's law, this one is our approximation of one operator's
 *  commercial boundary. Mixing them would let a rider read the dashed outline
 *  as having the same standing as a no-ride zone, which it does not.
 *
 *  A failure to load unchecks the box rather than leaving a switch claiming a
 *  layer that is not there — the same posture as the rules block. The words-only
 *  warning (`ROVER_AREA_WARNING`) survives either way, because the RULE never
 *  depended on having the line. */
function wireRoverZone(map: maplibregl.Map): void {
  const box = need<HTMLInputElement>("rover-zone-toggle");

  const apply = async (on: boolean): Promise<void> => {
    await ensureRoverZoneLayers(map, FIRST_DEVICE_LAYER);
    setRoverZoneVisible(map, on);
  };

  box.addEventListener("change", () => {
    const was = box.checked;
    box.disabled = true;
    void apply(box.checked)
      .catch((e: unknown) => {
        console.error("rover zone toggle failed", e);
        box.checked = !was;
      })
      .finally(() => {
        box.disabled = false;
      });
  });

  void apply(box.checked).catch((e: unknown) => {
    console.error("rover zone load failed", e);
    box.checked = false;
  });
}

function wireMicromobilityZones(): void {
  const groups: [ZoneGroup, HTMLInputElement][] = [
    ["rules", need<HTMLInputElement>("zones-rules-toggle")],
    ["schools", need<HTMLInputElement>("zones-schools-toggle")],
    ["outside", need<HTMLInputElement>("zones-outside-toggle")],
  ];
  const muted = need<HTMLInputElement>("zones-muted-toggle");

  const guard = (box: HTMLInputElement, label: string, apply: () => Promise<void>) => {
    const was = box.checked;
    box.disabled = true;
    void apply()
      .catch((e: unknown) => {
        console.error(`${label} failed`, e);
        box.checked = !was;
      })
      .finally(() => {
        box.disabled = false;
      });
  };

  for (const [group, box] of groups) {
    box.addEventListener("change", () => {
      guard(box, `zones ${group}`, () => zones.setVisible(group, box.checked));
    });
  }
  muted.addEventListener("change", () => {
    guard(muted, "zones muting", () => zones.setMuted(muted.checked));
  });

  // Draw now, at whatever the markup says. Strength before presence, same as
  // the equity overlay: the other order paints a frame at full opacity and
  // then dims it.
  void zones
    .setMuted(muted.checked)
    .then(async () => {
      for (const [group, box] of groups) {
        await zones.setVisible(group, box.checked);
      }
    })
    .catch((e: unknown) => {
      // The app works without the rulebook; it simply cannot warn anybody.
      // Unchecking says so rather than leaving a switch claiming a layer that
      // is not there.
      console.error("micromobility zones failed to load", e);
      for (const [, box] of groups) box.checked = false;
    });
}

/** The Areas drawer's two equity controls: whether the boundary is drawn at
 *  all, and how loudly.
 *
 *  BOTH DEFAULT ON, which is a change of policy and not just of markup. The
 *  boundary is the thing this app exists to point at — a discount written into
 *  a contract, owed to anyone inside a line nobody can see — so it is now
 *  drawn for everybody, and drawn quietly. "Muted display" is what turns it
 *  back up to the full wash it used to be at when a rider switched it on.
 *
 *  The checkboxes are the source of truth for the initial state, not the
 *  module's field defaults: `index.html` ships them checked, and this reads
 *  them once at wire time, so changing a default means changing one attribute
 *  rather than two files that have to agree. */
function wireEquityAreas(): void {
  const toggle = need<HTMLInputElement>("equity-areas-toggle");
  const muted = need<HTMLInputElement>("equity-areas-muted-toggle");

  /** Both handlers are the same shape: disable while the geometry fetch is in
   *  flight (the first call awaits it), and on failure put the checkbox back
   *  where it was rather than leave it claiming something the map is not
   *  doing. */
  const guard = (
    box: HTMLInputElement,
    label: string,
    apply: () => Promise<void>,
  ) => {
    const was = box.checked;
    box.disabled = true;
    void apply()
      .catch((e: unknown) => {
        console.error(`${label} failed`, e);
        box.checked = !was;
      })
      .finally(() => {
        box.disabled = false;
      });
  };

  toggle.addEventListener("change", () => {
    guard(toggle, "equity areas overlay", () =>
      equityAreas.setOverlayVisible(toggle.checked),
    );
  });
  muted.addEventListener("change", () => {
    guard(muted, "equity areas muting", () =>
      equityAreas.setOverlayMuted(muted.checked),
    );
  });

  // Draw it now, at whatever strength the markup says. Deliberately not
  // awaited: the geometry is a fetch, and the rest of the map's wiring has no
  // business waiting on a boundary overlay.
  void equityAreas
    .setOverlayMuted(muted.checked)
    .then(() => equityAreas.setOverlayVisible(toggle.checked))
    .catch((e: unknown) => {
      // The app works without it — the indicator chip is a separate path and
      // does not depend on these layers at all.
      console.error("equity areas initial draw failed", e);
      toggle.checked = false;
    });
}

/** The Filters drawer's accordion sections: one open at a time. Native
 *  <details> keeps the keyboard behavior and open state for free (same
 *  pattern as the Leaderboard drawer); the only added rule is exclusivity —
 *  opening a section closes whichever other one was open, so the drawer's
 *  now-longer section list never becomes one giant scroll. */
function wireFilterAccordion(): void {
  const sections = Array.from(
    document.querySelectorAll<HTMLDetailsElement>(
      "#filters-accordion > details.accordion",
    ),
  );
  for (const section of sections) {
    section.addEventListener("toggle", () => {
      if (!section.open) return;
      for (const other of sections) {
        if (other !== section && other.open) other.open = false;
      }
    });
  }
}

/** Ride Mode from the top bar: one tap and you are recording.
 *
 *  No vehicle, no destination, no timer, and no wizard — the three questions
 *  the flow normally asks are all "so we can do more for you", and this is
 *  the mode for a rider who wants none of that and just wants the track.
 *
 *  It is a PRIVATE, LOCAL ride: `rideId: null`, signed with a client-random
 *  key, recorded on this device. That is not a limitation dressed up as a
 *  feature — a tracked server ride is a ride ON SOMETHING, keyed to a
 *  vehicle we can correlate against GBFS, and a free ride has no vehicle to
 *  key it to. Recording locally is the honest shape, and the rider can still
 *  review, export or (for a vehicle ride) donate from Local Data.
 *
 *  The device is marked "own" because that is what it is: whatever you are
 *  riding, we did not rent it to you.
 */
/** Re-read the top bar's ride button. Assigned by `wireFreeRide`; called by
 *  the HUD's hide hook, which is the one transition the session subscription
 *  does not cover (BRB tears the HUD down without dispatching). */
let refreshRideButton: () => void = () => {};

function wireFreeRide(): void {
  const btn = document.getElementById("free-ride");
  if (!(btn instanceof HTMLButtonElement)) return;

  // THE BUTTON SAYS WHICH ONE IT IS (Phase 6 §6.3.2). It always took a rider
  // back to a live ride — `beforeOpen` deflects a live doc to `RideHud.open()`
  // — but it read "start recording a free ride" while doing it, so a rider who
  // BRB'd out had no way to tell their ride was still running, let alone one
  // tap away. A control nobody can see is the same as no control.
  const render = (): void => {
    const intent = rideButtonIntent(rideSession.current());
    const copy = rideButtonCopy(intent);
    btn.title = copy.title;
    btn.setAttribute("aria-label", copy.ariaLabel);
    // The lit state is CSS only; the accessible name above is what carries
    // the same fact to a reader who gets no colour.
    btn.classList.toggle("topbar__btn--live", isLiveIntent(intent));
  };
  render();
  refreshRideButton = render;
  rideSession.subscribe(() => render());

  btn.addEventListener("click", () => {
    // THIS BUTTON NEVER DESTROYS AN ANSWER THE RIDER ALREADY GAVE.
    //
    // It is two things at once: "start a free ride" for a rider with nothing
    // in flight, and "take me back to my ride" for one who stepped away —
    // picked a scooter, chose a destination, went to buy a coffee. Both press
    // the same button, and the second must never get the first's behaviour,
    // because `open` seeds a FRESH doc and would drop their device,
    // destination and route on the floor.
    //
    // So anything in flight is REOPENED, never replaced. Live ride included:
    // the HUD owns ending, and a second control for one irreversible action
    // is how a rider ends a ride they meant to keep.
    const doc = rideSession.current();
    // One source of truth with `render` above: whatever the button SAYS it
    // will do is what it does. Reading the doc twice with two different sets
    // of conditions is how a control starts lying.
    const intent = rideButtonIntent(doc);
    if (doc && intent.kind !== "start_free") {
      // `resume` is what makes the "never destroys an answer" promise above
      // actually hold (see `onOpen`), and a live ride is deflected to the HUD
      // by `beforeOpen` before this entry is ever built.
      // `doc.screen` is a `RideScreenId` — it also spans the post-ride
      // screens ("8"/"9"/"10"), which the wizard has no page for. A
      // post-ride doc never reaches here (`beforeOpen` deflects it), but the
      // narrowing is what says so rather than leaving it to be true by luck.
      openRideModal({
        resume: true,
        fastForwardTo: isWizardScreen(doc.screen) ? doc.screen : undefined,
      });
      return;
    }
    track("ride_mode_free", {});
    // A fix is not required to START — the watch may still be answering, and
    // refusing to begin would lose the first seconds of the ride, which is
    // exactly the part a rider cannot go back for. Ask for one anyway.
    locate.trigger();
    // Through the wizard's own Screen 6, not four hand-written dispatches.
    //
    // The hand-written version set `state: "riding"` on the doc and stopped
    // there — and a doc that says "riding" is not a ride. Screen 6 is where
    // `rideStarted` legally happens AND where the private track key is
    // minted, the local recorder opened, the transition checked for
    // acceptance, and the HUD handed off. Reimplementing that got the state
    // change and none of the rest: no HUD, and — on a feature whose entire
    // point is "GPS track on" — no recording at all.
    //
    // Screen 6 auto-starts an own-device ride on mount, so this is still one
    // tap; the rider sees the HUD, not a wizard.
    openRideModal({ freeRide: true, deviceConfirmed: true, fastForwardTo: "6" });
  });
}

/** The story offer under the stats figures.
 *
 *  The third of `docs/RIDER_VOICE_PLAN.md`'s asking moments, and the only one
 *  where the rider came to read rather than to ride — so it is the only one
 *  that can ask without standing between somebody and their trip.
 *
 *  It carries no ride context: nobody here just had a scooter fail, and
 *  inventing a vehicle or a time for a general account would be the app
 *  putting facts into somebody's story that they did not give it.
 */
let statsStoryPanel: StoryPanel | null = null;
let statsNeighborhoods: readonly string[] | null = null;
let statsNeighborhoodsTried = false;

function mountStatsStory(host: HTMLElement): void {
  statsStoryPanel?.destroy();
  statsStoryPanel = mountStoryPanel(host, {
    origin: "stats",
    context: { happenedAt: new Date().toISOString() },
    neighborhoods: statsNeighborhoods,
    submit: (draftId, payload) => submitRiderStory(draftId, payload),
  });

  // Fetched once per page load, in the background. Without it the box still
  // works and the send is simply not offered — see `rider-story-sheet.ts`.
  if (!statsNeighborhoodsTried) {
    statsNeighborhoodsTried = true;
    void fetchSurveyOptions()
      .then((opts) => {
        statsNeighborhoods = opts.neighborhoods;
        // Re-mount in place so the lane appears without disturbing the
        // figures above it.
        if (statsStoryPanel) mountStatsStory(host);
      })
      .catch(() => {
        /* no send option this session; a story is still kept locally */
      });
  }
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
    // SCREEN SPACE. On a phone an open drawer covers the map and the ribbon
    // slides out on top of it, so the strip stands aside while a drawer is
    // up and comes back when it closes. This loop is also what makes the
    // profile drawer and the map drawers mutually exclusive — the top bar's
    // profile button carries `.drawer-tab`, so it is one of `tabs` and
    // `setActive` shuts every other drawer to open it, and vice versa.
    if (id) yieldRibbonToDrawer();
    else restoreRibbonAfterDrawer();
    // "(live)" has to mean it: re-fetch the tally every time the panel is
    // shown rather than once at boot, and drop the in-flight fetch when it
    // is hidden again.
    if (id === "leaderboard") leaderboardPanel?.open();
    else leaderboardPanel?.close();
    // ONE FILTER, TWO SURFACES (Phase 6 §6.3). The model toggles are a view
    // onto `devices`' single selection, which the ride HUD's "Show" pills
    // edit too — so re-read it when the Filters drawer is shown rather than
    // trusting the buttons' own memory. Lazily, on open, which is what §6.3
    // means by "visible in the other when the rider gets there": a live
    // listener would re-enter `setToggleGroup`, whose synthetic clicks drive
    // the very handler that would fire it.
    if (id === "devices") {
      setToggleGroup(
        "#model-filter",
        "model",
        modelsOf(devices.modelSelection_()),
      );
    }
    // Same for the watch list in Tools: a watch can be armed from a map popup
    // or fire and remove itself while the drawer is shut, so re-read on every
    // open. It reads `localStorage`, so this costs nothing.
    if (id === "tools") notifyPanel?.refresh();
    // Same, for the same reason and more so: every figure on the trip panel —
    // the destination, the route's own ETA, which leg is current, the planning
    // preference — can change while this drawer is shut, and a ride changes
    // all four. Built lazily on the first open so a rider who never asks
    // "where am I going" pays nothing for the answer.
    if (id === "trip") {
      tripPanel ??= buildTripPanel(need("trip-panel"), {
        state: () => {
          const doc = rideSession.current();
          const dest = doc?.dest ?? peekPendingTrip()?.dest ?? null;
          return {
            dest:
              dest === null
                ? null
                : { label: dest.label, lat: dest.lat, lon: dest.lon },
            // Only a CHOSEN route has an honest duration. Navigation is off by
            // default, so most rides have none — and an arrival time derived
            // from a straight line would be the one figure here a rider could
            // check against their watch and find wrong.
            routeSeconds: doc?.route?.durationS ?? null,
            routeMeters: doc?.route?.distanceM ?? null,
            nowMs: Date.now(),
          };
        },
        showOnMap: (target) => {
          map.easeTo({ center: [target.lon, target.lat], zoom: 16 });
        },
        // "I'm not going anywhere, just reset the map."
        //
        // A live ride is the one case this refuses. "Clear my trip" is a
        // tidy-up, and silently ending a ride in progress — with its clock,
        // its cost and, on a tracked ride, its recording — is not a tidy-up.
        // It says so rather than hiding the button, so the refusal reads as a
        // refusal.
        clearBlockedReason: () => {
          const doc = rideSession.current();
          if (doc !== null && isRideLive(doc)) {
            return "You're on a ride. End it first and this will clear everything that's left.";
          }
          return null;
        },
        onClear: clearTrip,
      });
      tripPanel.refresh();
    }
    // Rendered on open rather than at boot: the map does not need it, and a
    // rider who never opens the drawer should not pay for the fetch. Every
    // open re-fetches — the endpoint carries an ETag keyed to the counters,
    // so a repeat open is a 304 and the panel is never stale after a rental
    // is counted.
    if (id === "stats") {
      void renderFleetStats(need("fleet-stats"), "rider", {
        mountStory: mountStatsStory,
      }).catch((e) => {
        console.error("fleet stats render failed", e);
      });
    } else {
      statsStoryPanel?.destroy();
      statsStoryPanel = null;
    }
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const id = tab.dataset.drawer ?? null;
      if (id && active !== id) track("drawer_open", { drawer: id });
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
  // The home bar — named for what it is. It was called `modeSwitch` back when
  // `#mode-switch` was the thing lifted here, which was already the wrong
  // element before §6.2 deleted it outright.
  const homeBarEl = need("home-bar");
  const mq = window.matchMedia("(max-width: 640px)");
  let expanded = false;
  let idleTimer: number | undefined;

  const sync = (): void => {
    root.classList.toggle("freshness--collapsed", mq.matches && !expanded);
    // While the pill is tap-expanded, its three lines of text can reach
    // well past the home bar's own footprint — lift the bar clear rather
    // than let it sit on top of (and hide) that text. Read the freshness
    // pill's live rendered height instead of hardcoding one: the class
    // toggle above already applied, so this reflects the current expanded
    // or collapsed size exactly, including whatever the actual device
    // counts/timestamp text needs.
    const lifted = mq.matches && expanded;
    homeBarEl.style.setProperty(
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
/** The saved-places mirror's two seams: is there a session, and how to send.
 *
 *  Module-level rather than inside `wireAccount` because the hook it registers
 *  outlives any one render of the drawer — a rider editing a favourite from the
 *  "Where to?" sheet is not in the drawer at all. */
const savedPlacesDeps = {
  signedIn: () => isAuthenticated(),
  push: (places: SavedPlace[]) => updateProfile({ saved_places: places }),
};

// Registered once, signed in or not: the hook asks `signedIn()` on every write,
// so a session starting or ending re-wires nothing. Signed out this is inert
// and the favourites store behaves exactly as it always has.
startSavedPlacesSync(savedPlacesDeps);

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

  // LOGIN SITS ABOVE THE TABS, in its own host, and is the first thing in the
  // drawer in both states: the sign-in doors when signed out, the session line
  // and Sign out when signed in. It used to be the first of five tabs, which
  // put the one thing a rider always needs — am I signed in, and how do I get
  // out — behind a tab, while every other tab sat dimmed until they found it.
  //
  // Built BEFORE the strip so it lands above it in document order, and, like
  // the strip, never torn down: render() replaces its CONTENTS only, so a
  // half-typed email survives the auth-config rebuild exactly as the strip
  // survives a token change.
  const loginHost = document.createElement("div");
  loginHost.className = "account-login-host";
  body.append(loginHost);

  // AND SO DOES THE PROFILE, directly under it. Who you are signed in as and
  // the profile you are signed in WITH are one block; splitting them put half
  // above the strip and half behind a tab the rider had to go looking for. Like
  // `loginHost` it is built once and never torn down — `render()` replaces its
  // CONTENTS — and it is simply empty when signed out, because there is no
  // profile to display until there is a session.
  const profileHost = document.createElement("div");
  profileHost.className = "account-profile-host";
  body.append(profileHost);

  // DECLARED BEFORE THE STRIP, AND NOT AS A `const` BELOW IT. `createAccountTabs`
  // calls `onShow` for the initial tab synchronously, from inside its own
  // constructor — that is deliberate, so lazily-built panels get their first
  // build — and `onShow` below reads this. A `const` declared after that call
  // would be in its temporal dead zone at exactly that moment, and `inRide?.`
  // would NOT save it: optional chaining still evaluates the binding. The throw
  // lands inside `createAccountTabs`, aborts `wireAccount`, and the In-Ride panel
  // is never built at all — a tab that opens empty.
  let inRide: InRidePanelHandle | null = null;
  // Declared here for the same reason, and it is not hypothetical: `onShow`
  // below reads this one too, and the Navigation tab can be the initial tab
  // via `takeTabHint()`.
  let nav: NavPanelHandle | null = null;

  // The strip is built ONCE and never torn down: render() below replaces
  // panel CONTENTS, so the rider's chosen tab survives both the auth-config
  // rebuild and a token change, exactly as signedOutState survives them.
  const tabs = createAccountTabs(body, {
    initial: takeTabHint() ?? "inride",
    onShow: (id) => {
      gateHint.hidden = true;
      // The drawn route belongs to this tab; leaving it should take the line
      // off the map with it.
      if (id === "local") void localData?.refresh();
      else localData?.clearSelection();
      // The HUD's own wrench panel can change the rate plan mid-ride, so the
      // settings copy of it is re-read every time this tab is shown rather
      // than trusted to be current from when it was built.
      if (id === "inride") inRide?.refresh();
      // Same reasoning: a sign-in can have merged places in from the account,
      // and the ideal-scooter spec lives behind a panel in another drawer.
      if (id === "nav") nav?.refresh();
    },
    onBlocked: (id) => {
      const what = id === "local" ? "Local Data" : "Community";
      gateHint.textContent = `Sign in to use ${what}.`;
      gateHint.hidden = false;
    },
  });
  // Above the strip too: the hint explains a dimmed TAB, so it has to be
  // readable from whichever tab the rider is standing on, not hidden inside
  // the panel they were refused.
  body.insertBefore(gateHint, tabs.strip);

  // In-Ride Preferences. Built once, outside render(), and deliberately NOT
  // rebuilt on sign-in or sign-out: every control on it is a device preference
  // in localStorage, so none of them changes when a session does, and
  // rebuilding would throw away an open rename box for no reason.
  inRide = buildInRidePanel(tabs.panel("inride"));

  // Navigation preferences. Built once, outside render(), for exactly the same
  // reason In-Ride is: every control on it is a device preference, none of them
  // changes when a session does, and rebuilding would throw away an open rename
  // box for no reason.
  nav = buildNavPanel(tabs.panel("nav"), {
    pickLocation: (label) =>
      mapPick.pick({ hint: `Tap the map to set ${label}` }),
    // Whether an "ideal scooter" exists, so the split preference can say
    // plainly that it has nothing to prefer yet.
    hasIdealSpec: () => rideSpecPanel?.activeSpec() != null,
    phoneVerified: () => phoneVerified,
    // Redraw the map's home/work pins. The pins follow the SLOTS now, not the
    // profile's `home_lat`/`work_lat` columns — which is what makes them
    // appear for a signed-out rider, and what stops them disagreeing with the
    // only control that sets either.
    onFavoritesChanged: () => syncHomeWorkPins(),
  });

  const buildSignedOut = (): void => {
    loginPanel = buildLoginPanel(loginHost, {
      cfg: authCfg,
      state: signedOutState,
      // The session is persisted by the door itself; reload so every fetch
      // picks up the bearer token. No tab hint any more: the profile a new
      // account most needs to fill in is above the strip now, visible from
      // whichever tab the reload lands on, so naming one would only move the
      // rider away from wherever they were.
      onSignedIn: () => {
        location.reload();
      },
    });
    // Unconditional now. The Google button needs a laid-out container to size
    // itself (a hidden one renders 0px wide), which is why this used to wait
    // for the Login tab to be shown — the host is always visible, so there is
    // nothing left to wait for.
    loginPanel.renderGoogle();
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
      // Back to "we have not looked", not to "no phone": the next render must
      // not tell a signed-out rider their verified number is missing.
      phoneVerified = null;
      nav?.refresh();
      loginPanel?.dispose();
      loginPanel = null;
      localData?.dispose();
      localData = null;
      // Every panel EXCEPT In-Ride and Navigation: those two are built once and
      // own nothing session-shaped, so emptying them here would delete a live
      // panel and leave the tab blank.
      for (const id of ACCOUNT_TAB_IDS) {
        if (id !== "inride" && id !== "nav") tabs.panel(id).replaceChildren();
      }
      loginHost.replaceChildren();
      profileHost.replaceChildren();
      gateHint.hidden = true;

      const on = !!auth;
      // Navigation is NOT gated, where the Profile tab it replaced was: every
      // control on it is a localStorage preference, so a signed-out rider can
      // set all of it. The profile that needed the session moved above the
      // strip, where it is simply absent when there is nothing to show.
      tabs.setEnabled("community", on);
      tabs.setEnabled("local", on || !GATE_LOCAL_TAB_ON_AUTH);
      // In-Ride is never gated either — it is all device preferences — so it is
      // the safe place to land when a session ends underneath a tab that just
      // became unavailable.
      if (!tabs.isEnabled(tabs.selected())) tabs.select("inride", { force: true });

      if (auth) {
        signedIn = renderSignedInAccount(loginHost, auth, {
          setAdminSession: (on2) => {
            devices.setAdminSession(on2);
            // The Tools drawer's Admin tools section exists only for a
            // session the server has called an admin; the analytics
            // endpoints behind its buttons are require_admin regardless.
            need("tools-admin").hidden = !on2;
          },
          // A rejected token has already been cleared from storage;
          // re-running render() lands in the signed-out branch.
          onAuthLost: () => render(),
          // The saved places arrived with the profile. Merging them into the
          // device's own store is `saved-places-sync.ts`'s job; `undefined`
          // (an older deployment) is passed straight through, because only
          // that module should decide what silence means.
          // The SMS dibs alert needs a number we have proved. Pushed rather
          // than fetched by the Navigation tab, which has no API client and is
          // built once, outside render().
          onPhoneVerified: (verified) => {
            phoneVerified = verified;
            nav?.refresh();
          },
          onSavedPlaces: (places) => {
            syncSavedPlacesFromProfile(places, savedPlacesDeps);
            // The slot rows are rendered from the store, and a merge can have
            // changed them.
            nav?.refresh();
          },
          // Null until /auth/config resolves — the row treats unknown as
          // "don't offer yet" rather than flashing a button that may vanish.
          smsEnabled: () => authCfg?.smsEnabled ?? null,
          // The rate-plan control lives on the In-Ride tab, so the account's
          // half of it reports through the panel rather than rendering a
          // status line of its own.
          onRatePlanResolved: (key) => inRide?.setRatePlan(key),
          rateStatus: (message, isError) =>
            inRide?.setRateStatus(message, isError),
          panels: {
            login: loginHost,
            profile: profileHost,
            community: tabs.panel("community"),
          },
        });
      } else {
        buildSignedOut();
        // A signed-out map must not keep showing the previous session's
        // admin affordances — same reasoning as the home/work pin clear.
        devices.setAdminSession(false);
        need("tools-admin").hidden = true;
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
    const raw = accountBtn.dataset.accountTab;
    delete accountBtn.dataset.accountTab;
    // Validated, not cast. A stale or misspelled id used to reach `select()`,
    // which treats an unknown tab as a disabled one and answered with the gate
    // hint's fallback copy — "Sign in to use Community" — for a tab nobody
    // asked for. An id we do not recognise means "no preference".
    const want = ACCOUNT_TAB_IDS.find((id) => id === raw);
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
      // The watcher listens on this: a scooter can go at any tick.
      window.dispatchEvent(new Event("scooter:devices-refreshed"));
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

  setInterval(tick, REFRESH_MS);
  // Claims on their own, shorter clock — see DIBS_REFRESH_MS. Skipped while
  // hidden for the same reason the device tick is: a backgrounded tab
  // polling is a battery cost with nobody looking at the result.
  setInterval(() => {
    if (!document.hidden) refreshLiveDibs();
  }, DIBS_REFRESH_MS);
  // Refresh immediately when the tab becomes visible again after being hidden.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void tick();
    // Claims too, and not only on the 25s clock: coming back to the app is
    // exactly the moment a rider looks at whether their scooter is still
    // theirs, and waiting a quarter of a minute to find out is the lag this
    // whole cadence exists to remove.
    refreshLiveDibs();
  });
}
