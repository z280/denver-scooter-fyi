import maplibregl, {
  type Map,
  type GeoJSONSource,
  type ExpressionSpecification,
} from "maplibre-gl";
import { isAuthenticated } from "./map-auth.js";
import type {
  DeviceProperties,
  DevicesResponse,
  FormFactor,
  PropulsionType,
} from "./api.ts";
import {
  DEVICE_COLORS,
  veoDeepLink,
  veoParkingReportUrl,
  type ParkingReportInput,
} from "./config.ts";
import { GbfsPlates } from "./gbfs.ts";
import { reverseGeocode } from "./geocode.ts";
import { emptyFC } from "./util.ts";
import { pointInAny, type IndexedFeature } from "./geo.ts";
import {
  computeBatteryThresholds,
  bucketFor,
  BATTERY_COLOR,
  BATTERY_MISSING_COLOR,
  BATTERY_TEXT_COLOR,
  type BatteryBucket,
  type BatteryThresholds,
} from "./battery.ts";
import {
  assessReliability,
  worstTier,
  RELIABILITY_COLOR,
  RELIABILITY_LABEL,
  type ReliabilityTier,
} from "./reliability.ts";
import {
  distanceMeters,
  formatWalk,
  walkMinutes,
  walkingDirectionsUrl,
  type Locate,
  type LngLat,
} from "./locate.ts";
import {
  submitModelReport,
  submitDeviceReport,
  ReportHttpError,
  type DeviceReportType,
} from "./reports.ts";
import {
  FEATURE_STATUS_LABEL,
  asFeatureStatus,
  openConfirmFeatures,
  readDeviceFeatures,
  summarizeFeatures,
} from "./device-features.ts";
import { openRidePreflight } from "./ride-preflight.ts";
import {
  MAX_PHOTOS_PER_DEVICE,
  type DevicePhotoList,
  fetchDevicePhotos,
  photoErrorText,
  supportsPhotos,
  uploadDevicePhoto,
} from "./device-photos.ts";
import { track } from "./telemetry.ts";

export type AreaFilter = IndexedFeature[] | null;
/** Ride posture, the primary "what am I sitting on" split. Derived from the
 *  server-corrected `vehicle_use_type` with model names as tiebreaker. */
export type RideType = "sitting" | "standing";
/** Veo's recognized model line-up (unrecognized models are never filtered). */
export type ModelKey = "astro" | "cosmo" | "apollo" | "trike";
export type QualityFilter = "any" | "no-risk" | "ok-only";
/** What the marker's inner badge depicts. */
export type IconStyle = "use" | "model" | "data";
/** How the "Model" icon style draws each badge: illustrated comic art, or a
 *  single model-tinted letter (As / Co / Ap / Tr). */
export type ModelIcon = "comic" | "letter";
/** Which signal colors the gauge ring (and the "data" badge). */
export type DataSource = "battery" | "reliability";

export const ALL_RIDE_TYPES: readonly RideType[] = ["sitting", "standing"];
export const ALL_MODELS: readonly ModelKey[] = [
  "astro",
  "cosmo",
  "apollo",
  "trike",
];

// ----- Gauge design options ("📐 Design Options" in the Iconography drawer).
export type GaugeDisplay = "always" | "hover";
export type GaugeThickness = "thin" | "standard" | "large" | "xlarge";
export type GaugePlacement = "surrounding" | "gap" | "biggap";

/** One-character encodings baked into icon keys so each design variant
 *  gets its own atlas image. */
const THICKNESS_CHAR: Record<GaugeThickness, string> = {
  thin: "T",
  standard: "S",
  large: "L",
  xlarge: "X",
};
const PLACEMENT_CHAR: Record<GaugePlacement, string> = {
  surrounding: "S",
  gap: "G",
  biggap: "B",
};

/** How close (metres) the user must be for the "Unlock in Veo" button to
 *  appear. Generous enough to tolerate consumer-GPS scatter (~20–40 m),
 *  tight enough that the button means "you're at this scooter." */
const UNLOCK_PROXIMITY_M = 75;

/** Both device-photo endpoints require a bearer session — uploading AND
 *  listing — so a signed-out rider gets the same hint from either button. */
const PHOTO_SIGNIN_HINT = "Sign in (Account tab) to add or view photos.";

/** Active-ride device taps: hold this long to open the full popup; a shorter
 *  tap only flashes the essentials tooltip (auto-hidden after that). */
const RIDE_LONGPRESS_MS = 450;
const RIDE_TOOLTIP_MS = 2200;

/** How close (metres) the user must be to report a scooter's parking. A
 *  parking complaint is only credible from someone who can actually see the
 *  vehicle, so we gate on a live GPS fix AND sight distance. Looser than the
 *  unlock radius (you can see a badly-parked scooter from across the street)
 *  but still local — you can't report parking for a scooter across town. */
const PARKING_REPORT_PROXIMITY_M = 100;

const RANGE_SRC = "device-range";
const RANGE_FILL_LAYER = "device-range-fill";
const RANGE_LINE_LAYER = "device-range-line";

const SRC = "devices";
/** Base clustering radius (px) at the default ✨ Icon size; setIconScale
 *  scales it with the badges so bigger icons cluster sooner instead of
 *  piling into overlap, and smaller icons spread out more individuals.
 *  Retuned 50 → 40 with the badge art: the full-color badges are worth
 *  seeing individually, so default clustering merges less eagerly. */
const CLUSTER_RADIUS = 40;
/** Devices de-cluster above this zoom. Passed explicitly on every
 *  setClusterOptions call so no MapLibre version can reset it to the
 *  supercluster default (16) when only the radius changes. */
const CLUSTER_MAX_ZOOM = 13;
const CLUSTER_LAYER = "device-clusters";
/** Overlays insert before this id so device markers stay on top. */
export const FIRST_DEVICE_LAYER = CLUSTER_LAYER;
const COUNT_LAYER = "device-cluster-count";
const POINT_LAYER = "device-points";
/** Overlay that draws the gauge-ringed icon for just the hovered device
 *  when the gauge display mode is "On Hover". */
const HOVER_LAYER = "device-points-hover";
const FLAG_LAYER = "device-negative-flag";
/** Filter that matches nothing — the hover layer's idle state. */
const HOVER_NONE: maplibregl.FilterSpecification = [
  "==",
  ["get", "device_id"],
  "__none__",
];
/** Layers with their own click behavior — a click that hits one of these
 *  should not also trigger the map-click region filter beneath it. */
export const DEVICE_INTERACTIVE_LAYERS = [CLUSTER_LAYER, POINT_LAYER];

/** Veo's model line-up, keyed by lowercased `vehicle_model_name`. The popup
 *  header shows the friendly name + a plain description; an unrecognized or
 *  missing model falls through to a "Tell us!" report prompt. */
const VEO_MODELS: Record<string, { name: string; desc: string }> = {
  astro: { name: "Veo Astro", desc: "Standing scooter" },
  cosmo: { name: "Veo Cosmo", desc: "One passenger glider (no pedals)" },
  apollo: { name: "Veo Apollo", desc: "Two passenger e-bike w/ pedals" },
  trike: { name: "Veo Rover", desc: "Three-wheel seated trike w/ cargo basket" },
};

function veoModel(
  modelName: string | null | undefined,
): { name: string; desc: string } | null {
  if (!modelName) return null;
  return VEO_MODELS[modelName.trim().toLowerCase()] ?? null;
}

const PROPULSION_LABEL: Record<PropulsionType, string> = {
  electric: "Throttle electric",
  electric_assist: "Pedal-assist electric",
  human: "Pedal-only",
};

export class Devices {
  private all: DevicesResponse | null = null;
  private areaFilter: AreaFilter = null;
  private hideUnavailable = false;
  /** Ride-type and model toggles: everything enabled by default, users
   *  click to *disable*. Unrecognized models are never filtered out. */
  private rideTypes = new Set<RideType>(ALL_RIDE_TYPES);
  private models = new Set<ModelKey>(ALL_MODELS);
  /** Minimum battery percentage (0 = off). When > 0, devices without a
   *  usable battery_percent are hidden too — an unknown charge can't
   *  satisfy a minimum. */
  private minBattery = 0;
  private quality: QualityFilter = "any";
  // Iconography: inner badge style + gauge ring (default on). The badge
  // ("icon data") and the ring ("gauge data") have independent signals so
  // riders can see reliability in the icon while the ring tracks battery.
  private iconStyle: IconStyle = "data"; // default per Zeke (PR #37): Data, not Ride type
  private modelIcon: ModelIcon = "comic";
  private iconData: DataSource = "reliability";
  private gaugeData: DataSource = "battery";
  private gauge = true;
  // Design options: on-hover display swaps the ring onto a hover overlay
  // layer; thickness/placement are baked into every icon key.
  private gaugeDisplay: GaugeDisplay = "always";
  private gaugeThickness: GaugeThickness = "standard";
  private gaugePlacement: GaugePlacement = "gap";
  private hoverDeviceId: string | null = null;
  /** ✨ Essentials-on-hover tooltip, default on. */
  private tooltipOn = true;
  // ----- Active-ride (follow-cam HUD) interaction state.
  /** While riding, a short tap only shows the essentials tooltip; a long
   *  press opens the full popup — so device taps don't clutter the ride. */
  private rideActive = false;
  /** True while the rider is choosing a point on the map for their profile;
   *  a tap then means "here", not "tell me about this scooter". */
  private pickActive = false;
  /** Ride-scoped device visibility (HUD "Show" pills). null = no ride filter
   *  (everything, incl. unrecognized hardware); a set restricts to those
   *  models; an empty set shows none. */
  private rideModelFilter: ReadonlySet<ModelKey> | null = null;
  /** In-flight long-press on a device during a ride (null between presses). */
  private ridePress:
    | { props: PopupProps; coords: [number, number]; longFired: boolean }
    | null = null;
  private ridePressTimer: number | undefined;
  private tooltipHideTimer: number | undefined;
  /** Timestamp of the last touch event — lets the mousedown handler ignore
   *  the synthetic mouse events a tap emits, so a press isn't double-started. */
  private lastTouchTs = 0;
  private thresholds: BatteryThresholds | null = null;
  private popup: maplibregl.Popup | null = null;
  /** device_id of the scooter whose range circle is currently drawn, or
   *  null if no circle is showing. Used so popups can render a toggleable
   *  Show/Hide-on-map link. */
  private rangeCircleDeviceId: string | null = null;
  /** Observers notified after every apply() — used by the battery filter
   *  UI to enable/disable buttons when thresholds become (un)available. */
  private listeners = new Set<(t: BatteryThresholds | null) => void>();
  /** Observers notified after every apply() with the current
   *  visible-feature count and the unfiltered fleet total. */
  private countListeners = new Set<(visible: number, total: number) => void>();
  /** ✨ Icon size preference — multiplies the zoom→size ramps for the
   *  device badges and their text overlays (1 = default). */
  private iconScale = 1;
  /** Plate resolver backed by Veo's public GBFS feed — lets the popup fill
   *  the "Unlock in Veo" link and the parking-report prefill with the real
   *  vehicle number without our own API ever exposing plates. */
  private readonly plates = new GbfsPlates();
  /** Session status, pushed in by wireAccount() once /auth/session
   *  resolves. admin lifts the proximity gate on ▶️ Start (issue #18) and on
   *  🧭 Use in Ride Mode. */
  private adminSession = false;
  /** What the open popup was built from, so a later admin flip can rebuild
   *  it. Cleared on close alongside `this.popup`. */
  private openPopupFor: { props: PopupProps; coords: [number, number] } | null =
    null;

  /** Update the popup-affecting session status (admin proximity bypass).
   *  Safe to call any time.
   *
   *  Rebuilds an OPEN popup when the value actually changes. `/auth/session`
   *  resolves asynchronously after load, so a popup opened in that window
   *  captured `adminSession = false` and would sit there wrongly telling an
   *  admin they're too far away, with nothing to correct it — the flag is
   *  pushed once per token, so there is no second chance. */
  setAdminSession(admin: boolean): void {
    if (this.adminSession === admin) return;
    this.adminSession = admin;
    const open = this.openPopupFor;
    if (open) this.openDevicePopup(open.props, open.coords);
  }

  constructor(
    private readonly map: Map,
    private readonly locate: Locate,
  ) {
    // A plate is only ever needed at the scooter (unlock / parking report),
    // which already requires a location fix — so prime the GBFS index on the
    // first fix. By the time the user opens a nearby popup it's warm, and
    // cachedPlateFor() stays a synchronous lookup.
    this.locate.onFix(() => {
      void this.plates.prime();
    });
  }

  addLayers(): void {
    // Kick off the model-badge decode; when it lands, re-annotate so
    // Model-style markers upgrade from letter tags to the real badge art.
    void loadModelIcons().then(() => this.apply());

    this.map.addSource(SRC, {
      type: "geojson",
      data: emptyFC(),
      cluster: true,
      clusterRadius: CLUSTER_RADIUS,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
    });

    this.map.addLayer({
      id: CLUSTER_LAYER,
      type: "circle",
      source: SRC,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": DEVICE_COLORS.cluster,
        "circle-opacity": 0.85,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-radius": [
          "step",
          ["get", "point_count"],
          14,
          25,
          18,
          100,
          24,
          500,
          32,
        ],
      },
    });

    this.map.addLayer({
      id: COUNT_LAYER,
      type: "symbol",
      source: SRC,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Medium"],
        "text-size": 12,
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#ffffff" },
    });

    // Red halo behind any device with an open negative report. Filter
    // accepts both real booleans and tile-encoded "true" strings since
    // MapLibre may flatten the property on its way through clustering.
    this.map.addLayer({
      id: FLAG_LAYER,
      type: "circle",
      source: SRC,
      filter: [
        "all",
        ["!", ["has", "point_count"]],
        [
          "any",
          ["==", ["get", "has_negative_report"], true],
          ["==", ["get", "has_negative_report"], "true"],
        ],
      ],
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#c62828",
        "circle-stroke-width": 2.5,
        "circle-stroke-opacity": 0.9,
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          11,
          14,
          16,
          17,
          21,
        ],
      },
    });

    this.map.addLayer({
      id: POINT_LAYER,
      type: "symbol",
      source: SRC,
      filter: ["!", ["has", "point_count"]],
      layout: {
        // Composite badge (inner style + optional gauge ring) generated on
        // a canvas per unique key; apply() annotates every feature with its
        // icon_key and registers any missing images before setData.
        "icon-image": ["get", "icon_key"],
        "icon-size": this.iconSizeExpr(),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        // Text overlay is empty in "Device type" mode; applyPaint() swaps
        // these in/out when the user toggles to "Range" mode so the
        // percentage renders inside the colored badge.
        "text-field": "",
        "text-font": ["Noto Sans Medium"],
        "text-size": this.textSizeExpr(),
        "text-anchor": "center",
        "text-offset": [0, 0],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-padding": 0,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.25)",
        "text-halo-width": 0.6,
        // Ghost pins: high-failure-risk devices render semi-transparent in
        // every color mode, training riders to walk past dead hardware.
        "icon-opacity": [
          "match",
          ["get", "reliability_tier"],
          "risk",
          0.45,
          1,
        ],
      },
    });

    // "On Hover" gauge display: this overlay draws the ringed variant of
    // exactly one device (the hovered one) above the base points. The base
    // icons reserve the ring's space (ring spec "hoff"), so hovering adds
    // the ring without the badge popping in size.
    this.map.addLayer({
      id: HOVER_LAYER,
      type: "symbol",
      source: SRC,
      filter: HOVER_NONE,
      layout: {
        "icon-image": ["get", "icon_key_hover"],
        "icon-size": this.iconSizeExpr(),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "text-field": "",
        "text-font": ["Noto Sans Medium"],
        "text-size": this.textSizeExpr(),
        "text-anchor": "center",
        "text-offset": [0, 0],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-padding": 0,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.25)",
        "text-halo-width": 0.6,
        "icon-opacity": [
          "match",
          ["get", "reliability_tier"],
          "risk",
          0.45,
          1,
        ],
      },
    });

    this.map.on("mousemove", POINT_LAYER, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as PopupProps;
      // On-hover gauge ring.
      if (this.gauge && this.gaugeDisplay === "hover") {
        const id = String(props.device_id ?? "");
        if (id && id !== this.hoverDeviceId) {
          this.hoverDeviceId = id;
          this.map.setFilter(HOVER_LAYER, [
            "all",
            ["!", ["has", "point_count"]],
            ["==", ["get", "device_id"], id],
          ]);
        }
      }
      // ✨ Essentials tooltip: model + battery + quality.
      if (this.tooltipOn) showMapTooltip(e.originalEvent, props);
    });
    this.map.on("mouseleave", POINT_LAYER, () => {
      this.clearHover();
      hideMapTooltip();
    });
    // The click popup takes over — don't double-annotate the device.
    this.map.on("click", () => hideMapTooltip());

    // Range-circle source/layers: a single device's reachable-distance halo,
    // toggled from the popup's "Show on map" affordance. Beneath the device
    // points so the dot stays visible at the center.
    this.map.addSource(RANGE_SRC, { type: "geojson", data: emptyFC() });
    this.map.addLayer(
      {
        id: RANGE_FILL_LAYER,
        type: "fill",
        source: RANGE_SRC,
        paint: {
          "fill-color": "#0072B2",
          "fill-opacity": 0.12,
        },
      },
      POINT_LAYER,
    );
    this.map.addLayer(
      {
        id: RANGE_LINE_LAYER,
        type: "line",
        source: RANGE_SRC,
        paint: {
          "line-color": "#0072B2",
          "line-width": 2,
          "line-opacity": 0.7,
          "line-dasharray": [3, 3],
        },
      },
      POINT_LAYER,
    );

    this.wireInteractions();
  }

  /** Subscribe to threshold updates. The callback is invoked synchronously
   *  with the current value and again whenever `setData()` recomputes it. */
  onThresholdsChange(
    cb: (t: BatteryThresholds | null) => void,
  ): () => void {
    this.listeners.add(cb);
    cb(this.thresholds);
    return () => this.listeners.delete(cb);
  }

  /** Subscribe to visible/total count updates. Fires synchronously with
   *  the current counts and again after every filter change or fresh fetch. */
  onCountsChange(
    cb: (visible: number, total: number) => void,
  ): () => void {
    this.countListeners.add(cb);
    cb(this.filtered().length, this.all?.features.length ?? 0);
    return () => this.countListeners.delete(cb);
  }

  private wireInteractions(): void {
    const { map } = this;

    map.on("click", CLUSTER_LAYER, async (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const clusterId = feature.properties?.cluster_id as number;
      const src = map.getSource(SRC) as GeoJSONSource;
      try {
        const zoom = await src.getClusterExpansionZoom(clusterId);
        const geom = feature.geometry as GeoJSON.Point;
        map.easeTo({ center: geom.coordinates as [number, number], zoom });
      } catch {
        /* ignore */
      }
    });

    map.on("click", POINT_LAYER, (e) => {
      // During a ride the popup opens on long-press instead (a plain tap
      // just flashes the essentials tooltip), so it never interrupts. While
      // picking a location, a tap on a scooter is still just a map tap.
      if (this.rideActive || this.pickActive) return;
      const feature = e.features?.[0];
      if (!feature) return;
      const geom = feature.geometry as GeoJSON.Point;
      this.openDevicePopup(
        feature.properties as PopupProps,
        geom.coordinates as [number, number],
      );
    });

    // Ride-mode long-press: press starts a timer + flashes the tooltip; the
    // timer opens the popup on a hold; release before it cancels (short tap).
    // Bound for both touch and mouse so it works on a phone or in testing. A
    // tap emits synthetic mouse events after the touch ones, so the mousedown
    // handler ignores anything within a short window of a real touch to avoid
    // starting the press twice.
    const TOUCH_MOUSE_GUARD_MS = 700;
    map.on("touchstart", POINT_LAYER, (e) => {
      this.lastTouchTs = performance.now();
      this.beginRidePress(e);
    });
    map.on("mousedown", POINT_LAYER, (e) => {
      if (performance.now() - this.lastTouchTs < TOUCH_MOUSE_GUARD_MS) return;
      this.beginRidePress(e);
    });
    map.on("touchend", () => {
      this.lastTouchTs = performance.now();
      this.endRidePress();
    });
    map.on("mouseup", () => this.endRidePress());
    map.on("touchcancel", () => {
      this.lastTouchTs = performance.now();
      this.cancelRidePress();
    });
    // A deliberate pan cancels the hold (follow-cam easeTo isn't a drag, so
    // it won't); otherwise the timer would fire mid-pan.
    map.on("dragstart", () => this.cancelRidePress());

    for (const layer of [CLUSTER_LAYER, POINT_LAYER]) {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
      });
    }
  }

  private beginRidePress(
    e: maplibregl.MapLayerMouseEvent | maplibregl.MapLayerTouchEvent,
  ): void {
    if (!this.rideActive) return;
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as PopupProps;
    const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    this.cancelRidePress(); // clears any prior timer + stray tooltip
    // The "hover prompt": flash the lightweight essentials tooltip on tap.
    if (this.tooltipOn) showMapTooltip(clientPointOf(e.originalEvent), props);
    this.ridePress = { props, coords, longFired: false };
    this.ridePressTimer = window.setTimeout(() => {
      if (!this.ridePress) return;
      this.ridePress.longFired = true;
      hideMapTooltip();
      this.openDevicePopup(props, coords);
    }, RIDE_LONGPRESS_MS);
  }

  private endRidePress(): void {
    if (!this.ridePress) return;
    const { longFired } = this.ridePress;
    window.clearTimeout(this.ridePressTimer);
    this.ridePress = null;
    // Short tap (released before the hold fired): leave the essentials
    // tooltip up briefly, then auto-hide (touch has no mouseleave).
    if (!longFired) {
      window.clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = window.setTimeout(
        () => hideMapTooltip(),
        RIDE_TOOLTIP_MS,
      );
    }
  }

  private cancelRidePress(): void {
    window.clearTimeout(this.ridePressTimer);
    window.clearTimeout(this.tooltipHideTimer);
    this.ridePress = null;
    // An aborted press (pan / touchcancel / re-press) must not strand the
    // essentials tooltip on screen — its auto-hide timer was just cleared.
    hideMapTooltip();
  }

  /** Whether a device details popup is currently open. The ride follow-cam
   *  reads this to hold the camera still while the popup is up. */
  hasOpenPopup(): boolean {
    return this.popup !== null;
  }

  /** Close the device details popup if one is open (mode switches sweep
   *  every floating surface). The popup's own close event nulls the field. */
  closePopup(): void {
    this.popup?.remove();
  }

  /** Build and show the details popup for one device. Called from the map
   *  click handler (flattened feature properties) and from the
   *  worth-the-walk "Show me" jump (raw GeoJSON properties) — the readers
   *  are defensive about both. */
  private openDevicePopup(
    props: PopupProps,
    coords: [number, number],
    retry = false,
  ): void {
    const { map } = this;
    {
      const here: LngLat = { lng: coords[0], lat: coords[1] };

      // Turquoise (Veo-brand) header identifying the model. A recognized
      // model shows its friendly name + description; an unknown one invites
      // the rider to report what it is (description + optional photo).
      const model = veoModel(props.vehicle_model_name);
      const headerName = model ? model.name : "Veo Unknown";
      const headerDesc = model ? model.desc : "Tell us!";
      const reportUi = model
        ? ""
        : `<button type="button" class="device-popup__report-btn" data-action="report-model">📸 Tell us what this is</button>
           <form class="device-popup__report" hidden>
             <textarea class="device-popup__report-desc" rows="2"
               placeholder="What is it? Model, seats, pedals, anything you can tell…"
               aria-label="Describe this vehicle"></textarea>
             ${
               // The API accepts an anonymous text report but rejects an
               // anonymous photo (401) — we don't take uploads from
               // unauthenticated callers. Don't offer a control that's
               // guaranteed to fail; say why instead.
               isAuthenticated()
                 ? `<label class="device-popup__report-photo">
               <input type="file" accept="image/*" capture="environment" />
               <span class="device-popup__report-photo-label">📷 Add a photo</span>
             </label>`
                 : `<p class="device-popup__report-signin">Sign in to add a photo — your description sends either way.</p>`
             }
             <div class="device-popup__report-actions">
               <button type="button" class="device-popup__report-cancel" data-action="report-cancel">Cancel</button>
               <button type="submit" class="device-popup__report-send" data-action="report-submit">Send</button>
             </div>
             <p class="device-popup__report-status" role="status" aria-live="polite"></p>
           </form>`;
      const headerBlock = `
        <div class="device-popup__header${model ? "" : " device-popup__header--unknown"}">
          <div class="device-popup__model">${escapeHtml(headerName)}</div>
          <div class="device-popup__model-sub">${escapeHtml(headerDesc)}</div>
          ${reportUi}
        </div>`;

      // Rating verdict — the headline answer to "worth the walk?".
      // setData() pre-annotated tier + reasons; fall back to a fresh
      // assessment for props that didn't ride through it. normalizeTier
      // guards against a raw server "high_risk" reaching the color lookup.
      const relTier =
        normalizeTier(props.reliability_tier) ?? assessReliability(props).tier;
      const relReasons =
        props.reliability_reasons ??
        assessReliability(props).reasons.join(" · ");

      // Quality reconciliation: the API's quality_designation grades
      // battery-range comfort minus idle/failure demerits, while the rating
      // grades only "will it start?" — so they can legitimately disagree.
      // Instead of showing two clashing grades (the old Quality row), fold
      // quality's story into the rating's explanation ONLY when the two
      // point in different directions; when they agree it adds nothing.
      const quality = props.quality_designation
        ? String(props.quality_designation).trim().toLowerCase()
        : null;
      let qualityNote = "";
      if (quality && quality !== "n/a") {
        if (relTier === "ok" && (quality === "poor" || quality === "acceptable")) {
          qualityNote = `quality "${quality}" — a battery/idle-time knock, not a start risk`;
        } else if (
          relTier !== "ok" &&
          (quality === "good" || quality === "great")
        ) {
          qualityNote = `battery is healthy (quality "${quality}") — the doubt is whether it starts`;
        }
      }
      const ratingNotes = [relReasons, qualityNote]
        .filter(Boolean)
        .join(" · ");

      // Crowdsourced equipment (API sql/055). Read up here because BOTH the
      // Features stat row and the action row below need it, and the stat
      // rows are built first.
      const featureStatus = asFeatureStatus(props.feature_status);
      const knownFeatures = readDeviceFeatures(props.device_features);

      const user = this.locate.current();

      // Effective plate: the admin-only field when present, else resolved
      // client-side from Veo's public GBFS feed (keyed by device_id == the
      // feed's bike_id). Only resolved when the user has a fix — a plate is
      // only actionable at the scooter, and this avoids scanning the index
      // for far-away or no-location views. Powers the unlock link and the
      // parking-report prefill without our API exposing plates.
      const effectivePlate: string | null =
        (props.vehicle_plate ? String(props.vehicle_plate) : null) ??
        (user || this.adminSession
          ? this.plates.cachedPlateFor(props.device_id)
          : null);

      // ▶️ Start (issue #18) — subsumes the old "Unlock in Veo" link. Same
      // deep link as the QR sticker on the scooter's deck, same gates: it
      // needs a plate (`effectivePlate` — the admin field, or one resolved
      // client-side from Veo's own public GBFS feed), a signed-in session,
      // and physical proximity (UNLOCK_PROXIMITY_M) — except admins, who
      // skip the proximity requirement entirely. The button is ALWAYS
      // visible; when disabled, tapping it explains why in the hint line.
      const signedIn = isAuthenticated();
      const nearEnough =
        user !== null && distanceMeters(user, here) <= UNLOCK_PROXIMITY_M;
      const startAllowed = signedIn && (this.adminSession || nearEnough);
      // Vehicle-status gates come first: no proximity or session fixes a
      // scooter that Veo itself won't rent out. (The old unlock link never
      // checked these; promoted to the primary CTA, it has to.)
      const outOfService = asBool(props.is_disabled);
      const reserved = asBool(props.is_reserved);
      let startHint = "";
      if (outOfService) {
        startHint = "This scooter is marked out of service.";
      } else if (reserved) {
        startHint = "Reserved by another rider right now.";
      } else if (!signedIn) {
        startHint = "Sign in (Account tab) to start rides here.";
      } else if (!startAllowed) {
        startHint = user
          ? "You're too far away, sorry!"
          : "Turn on your location to start at the scooter.";
      } else if (!effectivePlate) {
        startHint = "Looking up this scooter's plate — try again in a moment.";
      }
      // Resolve the deep link inline so the plate's non-null narrowing is
      // explicit rather than riding on TS aliased-condition narrowing.
      const startHref =
        startAllowed && effectivePlate && !outOfService && !reserved
          ? veoDeepLink(effectivePlate)
          : null;
      const startBtn = startHref
        ? `<a class="device-popup__actbtn device-popup__actbtn--start" href="${escapeHtml(startHref)}">▶️ Start in Veo</a>`
        : `<button type="button" class="device-popup__actbtn device-popup__actbtn--start is-blocked" data-action="start-blocked" aria-disabled="true" title="${escapeHtml(startHint)}">▶️ Start in Veo</button>`;

      // 🧭 Use in Ride Mode carries the same geographic gate as ▶️ Start:
      // both rows commit the rider to THIS scooter, and neither means
      // anything from across town — ride mode's whole premise is that the
      // rider is standing at the vehicle (it is what lets the preflight skip
      // the wizard's "which scooter?" screens). Admins bypass proximity, as
      // they do for Start, so the flows stay testable from a desk. Sign-in
      // is deliberately NOT required here: ride mode runs client-side, and
      // Start still enforces its own session gate downstream.
      const rideAllowed = this.adminSession || nearEnough;
      let rideHint = "";
      if (outOfService) {
        rideHint = "This scooter is marked out of service.";
      } else if (reserved) {
        rideHint = "Reserved by another rider right now.";
      } else if (!rideAllowed) {
        rideHint = user
          ? "You're too far away, sorry!"
          : "Turn on your location to use ride mode with this scooter.";
      }
      const rideOk = rideAllowed && !outOfService && !reserved;

      // Walk economics — needs a location fix (opt-in via the geolocate
      // button). For risky devices, point at the nearest likely-rideable
      // alternative so the rider can decide before burning the walk.
      let walkBlock = "";
      if (user) {
        const meters = distanceMeters(user, here);
        walkBlock = `
          <div class="device-popup__walk">
            🚶 ${escapeHtml(formatWalk(meters))}
            <a class="device-popup__action" href="${escapeHtml(walkingDirectionsUrl(here))}" target="_blank" rel="noopener">Directions</a>
          </div>`;
        if (relTier !== "ok") {
          const alt = this.nearestReliable(
            user,
            props.device_id,
            props.form_factor,
          );
          if (alt) {
            walkBlock += `
              <div class="device-popup__alt">
                ⚠️ A likely-rideable one is ~${walkMinutes(alt.meters)} min away
                <button type="button" class="device-popup__action" data-action="jump-device"
                  data-device="${escapeHtml(alt.id)}" data-lng="${alt.lng}" data-lat="${alt.lat}">Show me</button>
              </div>`;
          }
        }
      }

      // Status badges (out-of-service / reserved) — only when the upstream
      // payload explicitly flagged them. Null/undefined → omit.
      const statusBadges: string[] = [];
      if (asBool(props.is_disabled)) {
        statusBadges.push(
          `<span class="device-popup__status device-popup__status--disabled">Out of service</span>`,
        );
      }
      if (asBool(props.is_reserved)) {
        statusBadges.push(
          `<span class="device-popup__status device-popup__status--reserved">Reserved</span>`,
        );
      }

      // ---- The five compact stats the popup shows (issue #18: 3-5 key
      // stats): Rating, Battery, Type, Vehicle ID, Parked for. Everything
      // else moves to the "Full details" modal so the popup stays short.
      const batteryPct = asNumber(props.battery_percent);
      const statRows: string[] = [];
      statRows.push(
        `<dt>Rating</dt>
         <dd>
           <span class="device-popup__rel-dot" style="background:${RELIABILITY_COLOR[relTier]}" aria-hidden="true"></span>
           <strong>${escapeHtml(RELIABILITY_LABEL[relTier])}</strong>
           ${ratingNotes ? `<div class="device-popup__rel-reasons">${escapeHtml(ratingNotes)}</div>` : ""}
         </dd>`,
      );
      if (batteryPct !== null) {
        statRows.push(
          `<dt>Battery</dt><dd>${batteryPct < 25 ? "🪫" : "🔋"} ${batteryPct}%</dd>`,
        );
      }
      {
        // Vehicle type: the friendly model + description when recognized,
        // otherwise whatever the feed called it, with rider posture.
        const use = props.vehicle_use_type
          ? ` <span class="device-popup__hint">${escapeHtml(usePosture(props.vehicle_use_type))}</span>`
          : "";
        const typeDd = model
          ? `${escapeHtml(model.name)} <span class="device-popup__hint">${escapeHtml(model.desc)}</span>`
          : props.vehicle_model_name
            ? `${escapeHtml(String(props.vehicle_model_name))}${use}`
            : `${escapeHtml(props.form_factor === "bicycle" ? "E-bike" : "Scooter")}${use}`;
        statRows.push(`<dt>Type</dt><dd>${typeDd}</dd>`);
      }
      {
        // Equipment. Shows what we know when we know it, and the status
        // label when we don't — "Needs features confirmed" IS the useful
        // answer for an unreported scooter, because it is also the pitch
        // for the button below it.
        const summary = knownFeatures
          ? summarizeFeatures(knownFeatures)
          : FEATURE_STATUS_LABEL[featureStatus];
        const statusHint =
          knownFeatures && featureStatus !== "up_to_date"
            ? ` <span class="device-popup__hint">${escapeHtml(FEATURE_STATUS_LABEL[featureStatus])}</span>`
            : "";
        statRows.push(
          `<dt>Features</dt><dd>${escapeHtml(summary)}${statusHint}</dd>`,
        );
      }
      if (props.vehicle_identifier) {
        statRows.push(
          `<dt>Vehicle ID</dt><dd><code class="device-popup__vid">${escapeHtml(String(props.vehicle_identifier))}</code></dd>`,
        );
      }
      if (props.first_observed_at_location) {
        // Peer context (public since the §1.4 recalibration): how this
        // dwell compares to scooters in the same H3 neighborhood.
        const peerMedian = asNumber(props.dwell_peer_median_hours);
        const peerHint =
          peerMedian !== null && peerMedian > 0
            ? ` <span class="device-popup__hint">block median ${escapeHtml(formatDwellHours(peerMedian))}</span>`
            : "";
        statRows.push(
          `<dt>Parked for</dt><dd>${escapeHtml(formatDwell(props.first_observed_at_location))}${peerHint}</dd>`,
        );
      }

      // ---- Everything else: rows for the "Full details" modal, in rough
      // priority order. Range-rank rows only exist when the fetch carried
      // ?include=ranks; the admin extras only on ADMIN_EMAILS sessions.
      const detailRows: string[] = [];
      detailRows.push(
        `<dt>Device ID</dt><dd><code>${escapeHtml(props.device_id)}</code></dd>`,
      );
      const rangeMeters = asNumber(props.current_range_meters);
      if (rangeMeters !== null) {
        const showing = this.rangeCircleDeviceId === props.device_id;
        detailRows.push(
          `<dt>Range</dt>
           <dd>
             ${escapeHtml(formatRange(rangeMeters))}
             <button
               type="button"
               class="device-popup__action"
               data-action="toggle-range"
               data-device="${escapeHtml(props.device_id)}"
               data-lng="${coords[0]}"
               data-lat="${coords[1]}"
               data-radius="${rangeMeters}"
             >${showing ? "Hide on map" : "Show on map"}</button>
           </dd>`,
        );
      }
      if (props.propulsion_type) {
        const prop = String(props.propulsion_type) as PropulsionType;
        const lbl = PROPULSION_LABEL[prop] ?? prop;
        detailRows.push(`<dt>Drivetrain</dt><dd>${escapeHtml(lbl)}</dd>`);
      }
      if (props.quality_designation) {
        detailRows.push(
          `<dt>Quality</dt><dd><code>${escapeHtml(String(props.quality_designation))}</code> <span class="device-popup__hint">battery-range grade minus idle/failure demerits</span></dd>`,
        );
      }
      if (asBool(props.has_negative_report)) {
        detailRows.push(
          `<dt>Reports</dt><dd><span class="device-popup__status device-popup__status--flagged">Negative report on file</span></dd>`,
        );
      }
      const failedStarts = asNumber(props.number_failed_starts);
      if (failedStarts !== null) {
        detailRows.push(
          `<dt>Failed starts</dt><dd>${failedStarts.toLocaleString()}</dd>`,
        );
      }
      const percentile = asNumber(props.range_percentile_by_type);
      if (percentile !== null) {
        detailRows.push(
          `<dt>Range percentile</dt><dd>${formatPercentile(percentile)} <span class="device-popup__hint">vs same drivetrain</span></dd>`,
        );
      }
      const rankAllDevices = formatRank(props.range_rank_all_devices);
      if (rankAllDevices !== null) {
        detailRows.push(`<dt>Rank (citywide)</dt><dd>${rankAllDevices}</dd>`);
      }
      const rankByType = formatRank(props.range_rank_all_by_type);
      if (rankByType !== null) {
        detailRows.push(`<dt>Rank (by drivetrain)</dt><dd>${rankByType}</dd>`);
      }
      if (props.vehicle_plate) {
        detailRows.push(
          `<dt>Plate</dt><dd><code>${escapeHtml(props.vehicle_plate)}</code></dd>`,
        );
      }
      if (props.first_ever_observed_at) {
        detailRows.push(
          `<dt>First seen ever</dt><dd>${escapeHtml(formatDate(props.first_ever_observed_at))}</dd>`,
        );
      }
      const maxRange = asNumber(props.max_observed_range_meters);
      if (maxRange !== null && maxRange > 0) {
        const maxRangeAt = props.max_observed_range_at
          ? ` <span class="device-popup__hint">${escapeHtml(formatDate(props.max_observed_range_at))}</span>`
          : "";
        detailRows.push(
          `<dt>Max observed range</dt><dd>${escapeHtml(formatRange(maxRange))}${maxRangeAt}</dd>`,
        );
      }

      const statusBlock = statusBadges.length
        ? `<div class="device-popup__statuses">${statusBadges.join("")}</div>`
        : "";

      // One-tap device-failure report (POST /api/v1/reports/device). Needs
      // the stable vehicle_identifier (the API requires ≥16 chars), so it
      // only shows when that's present. Feeds the reliability signal.
      const vid = props.vehicle_identifier
        ? String(props.vehicle_identifier)
        : "";
      const reportProblemBlock =
        vid.length >= 16
          ? `<div class="device-popup__report-device" data-vid="${escapeHtml(vid)}">
               <span class="device-popup__report-device-label">Report a problem</span>
               <div class="device-popup__report-chips">
                 <button type="button" class="device-popup__report-chip" data-action="report-device" data-type="not_rideable">🚫 Not rideable</button>
                 <button type="button" class="device-popup__report-chip" data-action="report-device" data-type="dead_battery">🪫 Dead battery</button>
                 <button type="button" class="device-popup__report-chip" data-action="report-device" data-type="damaged">🛴 Damaged</button>
               </div>
               <p class="device-popup__report-device-status" role="status" aria-live="polite"></p>
             </div>`
          : "";

      // "Report bad parking to Veo" — routes the complaint to the operator
      // responsible for repositioning it (Veo's public Zendesk form, deep-
      // linked with this vehicle + location pre-filled) AND records it as an
      // improperly_parked report on our own API (the compliance signal).
      //
      // Gated: a parking complaint is only credible from someone who can see
      // the vehicle, so it needs (1) a live GPS fix and (2) sight distance.
      // When those aren't met we say why instead of offering the action —
      // same pattern as the unlock block above.
      const parkNearEnough =
        user !== null && distanceMeters(user, here) <= PARKING_REPORT_PROXIMITY_M;
      // Hoisted so the async reverse-geocode below can rebuild the URL with a
      // street address once it resolves.
      let parkingInput: ParkingReportInput | null = null;
      let veoParkReportBlock: string;
      if (user && parkNearEnough) {
        parkingInput = {
          lat: coords[1],
          lng: coords[0],
          plate: effectivePlate,
          modelName: props.vehicle_model_name
            ? String(props.vehicle_model_name)
            : model
              ? model.name
              : null,
          vehicleId: props.vehicle_identifier
            ? String(props.vehicle_identifier)
            : null,
          dwellText: props.first_observed_at_location
            ? formatDwell(props.first_observed_at_location)
            : null,
          address: null, // upgraded async after render (reverseGeocode)
        };
        const parkingReportUrl = veoParkingReportUrl(parkingInput);
        veoParkReportBlock = `
          <div class="device-popup__veo-report">
            <a class="device-popup__veo-report-link" data-action="report-parking" href="${escapeHtml(parkingReportUrl)}" target="_blank" rel="noopener">🚧 Report bad parking to Veo</a>
            <span class="device-popup__veo-report-hint">Opens Veo's form with this vehicle &amp; location pre-filled — you review &amp; send.</span>
          </div>`;
      } else {
        const why = user
          ? "Walk within sight of this scooter to report its parking."
          : "Turn on your location to report bad parking.";
        veoParkReportBlock = `
          <div class="device-popup__veo-report">
            <span class="device-popup__veo-report-gate">🔒 ${escapeHtml(why)}</span>
          </div>`;
      }

      // Compact layout (issue #18): a 4-button action row, then the five
      // key stats. The report tools hide behind ⚠️ Report; everything else
      // lives in the ℹ️ Details modal — the popup itself stays short. The
      // admin two-column variant is gone; admin extras ride in the modal.
      // Two more actions. "Use in Ride Mode" spans the row as the primary
      // CTA — it is the one the rider standing at the scooter most likely
      // wants, and it is the reason the wizard's "which scooter?" screens
      // can be skipped at all (they already answered that by opening this
      // popup) — which is also why it is proximity-gated above, ALWAYS
      // visible but blocked with a hint when the rider isn't at the scooter
      // (admins excepted). "Confirm Features" needs a stable
      // vehicle_identifier: the
      // API keys the report on it, and there is nothing useful to send
      // without one.
      const rideBtn = rideOk
        ? `<button type="button" class="device-popup__actbtn device-popup__actbtn--ride" data-action="use-in-ride-mode" aria-haspopup="dialog">🧭 Use in Ride Mode</button>`
        : `<button type="button" class="device-popup__actbtn device-popup__actbtn--ride is-blocked" data-action="ride-blocked" aria-disabled="true" title="${escapeHtml(rideHint)}">🧭 Use in Ride Mode</button>`;
      const featuresBtn =
        vid.length >= 16
          ? `<button type="button" class="device-popup__actbtn device-popup__actbtn--features" data-action="confirm-features" data-status="${escapeHtml(featureStatus)}" aria-haspopup="dialog">☑️ Confirm Features</button>`
          : "";
      // Final row: rider-contributed photos of THIS scooter (API.md § Device
      // photos). Both endpoints need a bearer session — listing included, even
      // though the photos themselves are public objects — so signed out, both
      // buttons render blocked with the usual hint rather than disappearing:
      // "sign in and you get this" is the useful message. Hidden entirely when
      // the vehicle_identifier isn't the API's exact 16-hex shape, since no
      // request could ever succeed. No proximity gate: an older photo of a
      // scooter is worth looking at from anywhere, and that is much of the
      // point of having them.
      const photosOk = supportsPhotos(vid);
      const photoRow = !photosOk
        ? ""
        : signedIn
          ? `<button type="button" class="device-popup__actbtn" data-action="take-photo" aria-haspopup="dialog">📷 Take Photo</button>
             <button type="button" class="device-popup__actbtn" data-action="show-photos" aria-haspopup="dialog">🖼️ Show Photos</button>`
          : `<button type="button" class="device-popup__actbtn is-blocked" data-action="photos-blocked" aria-disabled="true" title="${escapeHtml(PHOTO_SIGNIN_HINT)}">📷 Take Photo</button>
             <button type="button" class="device-popup__actbtn is-blocked" data-action="photos-blocked" aria-disabled="true" title="${escapeHtml(PHOTO_SIGNIN_HINT)}">🖼️ Show Photos</button>`;
      const actionRow = `
        <div class="device-popup__actionrow">
          ${rideBtn}
          ${startBtn}
          <button type="button" class="device-popup__actbtn" data-action="open-report" aria-haspopup="dialog">⚠️ Report</button>
          <button type="button" class="device-popup__actbtn" data-action="full-details" aria-haspopup="dialog">ℹ️ Details</button>
          ${featuresBtn}
          ${photoRow}
        </div>
        <p class="device-popup__actionhint" role="status" aria-live="polite" hidden></p>`;

      this.popup?.remove();
      const popup = new maplibregl.Popup({
        closeButton: true,
        offset: 10,
        maxWidth: "300px",
      })
        .setLngLat(coords)
        .setHTML(
          `<div class="device-popup">
             ${headerBlock}
             <div class="device-popup__body">
               <div class="device-popup__col">
                 ${actionRow}
                 ${statusBlock}
                 <dl class="device-popup__meta device-popup__stats">${statRows.join("")}</dl>
                 ${walkBlock}
               </div>
             </div>
           </div>`,
        )
        .addTo(map);
      this.popup = popup;
      // Remembered so setAdminSession can rebuild this popup if the admin
      // flag lands while it is open — its gates captured the old value.
      this.openPopupFor = { props, coords };
      // Track open/closed so the ride follow-cam can hold still while it's up
      // (hasOpenPopup). Guard against a stale handler from a replaced popup.
      popup.on("close", () => {
        if (this.popup === popup) {
          this.popup = null;
          this.openPopupFor = null;
        }
      });

      // Progressive plate hydration: the plate powers the unlock link and the
      // parking-report prefill, but the GBFS index may not be warm on the very
      // first popup after a fix. If we rendered without a plate but the user
      // has a fix (so proximity features apply), prime the index and re-render
      // once when a plate lands. Guarded so it runs at most one extra time and
      // only while THIS popup is still the open one.
      if (!retry && (user || this.adminSession) && !effectivePlate) {
        void this.plates.prime().then(() => {
          if (this.popup !== popup) return; // closed or replaced
          if (this.plates.cachedPlateFor(props.device_id)) {
            this.openDevicePopup(props, coords, true);
          }
        });
      }

      // Dashed orientation line user → device while the popup is open.
      if (user) {
        this.locate.showLineTo(here);
        popup.on("close", () => this.locate.clearLine());
      }

      const popupEl = this.popup.getElement();

      // Telemetry: one open event per fresh popup (the plate-hydration
      // re-render passes retry=true and is the same popup to the rider),
      // and a delegated action listener so each button/link below stays
      // untouched. Only recognized actions map to a bounded vocabulary.
      if (!retry) {
        track("popup_open");
        // Progressive discovery hook (main.ts listens): the one-time "what
        // does High risk mean" tip needs to know a risk-tier popup opened,
        // without this module knowing anything about tips.
        window.dispatchEvent(
          new CustomEvent("scooter:popup-open", { detail: { tier: relTier } }),
        );
      }
      const ACTION_TRACK: Record<string, string> = {
        "use-in-ride-mode": "preflight",
        "confirm-features": "confirm_features",
        "take-photo": "photos",
        "show-photos": "photos",
        "report-model": "model_report",
        "open-report": "parking_report",
      };
      popupEl?.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null;
        const actEl = target?.closest<HTMLElement>("[data-action], a[href]");
        if (!actEl) return;
        const da = actEl.dataset.action;
        if (da && ACTION_TRACK[da]) {
          track("popup_action", { action: ACTION_TRACK[da] });
        } else if (actEl.matches(".device-popup__actbtn--start[href]")) {
          track("popup_action", { action: "unlock" });
        } else if (actEl.matches(".device-popup__action[href]")) {
          track("popup_action", { action: "walk_handoff" });
        }
      });

      // ---- Action-row wiring. A blocked Start or Ride Mode explains itself
      // in the hint line (mobile has no hover for the title tooltip). Both
      // are proximity-gated, so this is the common case. Report and Details
      // each open their own floating modal — the popup itself never grows
      // or morphs.
      const hintLine = popupEl?.querySelector<HTMLElement>(
        ".device-popup__actionhint",
      );
      const showHint = (text: string): void => {
        if (!hintLine) return;
        hintLine.textContent = text;
        hintLine.hidden = false;
      };
      popupEl
        ?.querySelector<HTMLButtonElement>('[data-action="start-blocked"]')
        ?.addEventListener("click", () => showHint(startHint));
      popupEl
        ?.querySelector<HTMLButtonElement>('[data-action="ride-blocked"]')
        ?.addEventListener("click", () => showHint(rideHint));
      popupEl
        ?.querySelector<HTMLButtonElement>('[data-action="open-report"]')
        ?.addEventListener("click", () => {
          openFloatingModal(
            `⚠️ Report — ${headerName}`,
            `${reportProblemBlock}${veoParkReportBlock}`,
            (root) => this.wireReportTools(root, vid, coords, parkingInput),
          );
        });
      popupEl
        ?.querySelector<HTMLButtonElement>('[data-action="full-details"]')
        ?.addEventListener("click", () => {
          openFloatingModal(
            `${headerName} — full details`,
            `<dl class="device-popup__meta">${detailRows.join("")}</dl>`,
            (root) => this.wireRangeToggles(root),
          );
        });
      // 🧭 Use in Ride Mode — the device card's shortcut into ride mode.
      // The rider has already answered "which scooter?" by opening this
      // popup, so the survey asks the three things the wizard would have,
      // then jumps past every screen the answers make unnecessary
      // (`ride-preflight.ts`). Passing the plate matters: it is what lets
      // Screen 6 build a working Start-in-Veo deep link without a second
      // GBFS round trip.
      popupEl
        ?.querySelector<HTMLButtonElement>('[data-action="use-in-ride-mode"]')
        ?.addEventListener("click", () => {
          openRidePreflight({
            deviceLabel: effectivePlate
              ? `${headerName} — plate ${effectivePlate}`
              : headerName,
            vehicleIdentifier: props.vehicle_identifier
              ? String(props.vehicle_identifier)
              : null,
            plate: effectivePlate,
            // The wizard installs its own focus trap and takes over the
            // screen; leaving a map popup open behind it is the same
            // clutter every mode switch sweeps.
            onEntered: () => this.closePopup(),
          });
        });
      // ☑️ Confirm Features — crowdsourced equipment (API sql/055).
      popupEl
        ?.querySelector<HTMLButtonElement>('[data-action="confirm-features"]')
        ?.addEventListener("click", () => {
          openConfirmFeatures({
            deviceId: props.device_id,
            vehicleIdentifier: vid,
            modelName: model ? model.name : props.vehicle_model_name
              ? String(props.vehicle_model_name)
              : null,
            status: featureStatus,
            lat: coords[1],
            lng: coords[0],
            // The map's own copy of this device won't reflect the report
            // until the next poll AND the server's ten-minute grading job,
            // so nothing is refreshed here on purpose — showing an
            // optimistic "Up to date" that the next poll then reverts would
            // be worse than the honest lag. The modal's own closing line
            // tells the rider it takes a few minutes.
          });
        });
      // 📷 / 🖼️ — device photos. Both open the same gallery modal; Take Photo
      // just arrives there with the file picker already firing, so the upload
      // lands in a view that shows what the scooter already has (and the
      // 3-photo cap) rather than a bare success line.
      popupEl
        ?.querySelector<HTMLButtonElement>('[data-action="take-photo"]')
        ?.addEventListener("click", () => {
          this.openDevicePhotos(vid, headerName, true, here);
        });
      popupEl
        ?.querySelector<HTMLButtonElement>('[data-action="show-photos"]')
        ?.addEventListener("click", () => {
          this.openDevicePhotos(vid, headerName, false, here);
        });
      popupEl
        ?.querySelectorAll<HTMLButtonElement>('[data-action="photos-blocked"]')
        .forEach((btn) =>
          btn.addEventListener("click", () => showHint(PHOTO_SIGNIN_HINT)),
        );
      // "Tell us what this is" — reveal the model-report form, then handle
      // photo selection and submission for an unrecognized ("Veo Unknown")
      // vehicle.
      const reportOpen = popupEl?.querySelector<HTMLButtonElement>(
        '[data-action="report-model"]',
      );
      const reportForm = popupEl?.querySelector<HTMLFormElement>(
        ".device-popup__report",
      );
      if (reportOpen && reportForm) {
        reportOpen.addEventListener("click", () => {
          reportOpen.hidden = true;
          reportForm.hidden = false;
          reportForm.querySelector("textarea")?.focus();
        });
        const photoInput = reportForm.querySelector<HTMLInputElement>(
          'input[type="file"]',
        );
        const photoLabel = reportForm.querySelector<HTMLElement>(
          ".device-popup__report-photo-label",
        );
        photoInput?.addEventListener("change", () => {
          if (photoLabel) {
            photoLabel.textContent = photoInput.files?.length
              ? "📷 Photo attached ✓"
              : "📷 Add a photo";
          }
        });
        reportForm
          .querySelector('[data-action="report-cancel"]')
          ?.addEventListener("click", () => {
            reportForm.hidden = true;
            reportOpen.hidden = false;
          });
        reportForm.addEventListener("submit", (e) => {
          e.preventDefault();
          const desc =
            reportForm.querySelector<HTMLTextAreaElement>("textarea")?.value ??
            "";
          const status = reportForm.querySelector<HTMLElement>(
            ".device-popup__report-status",
          );
          const sendBtn = reportForm.querySelector<HTMLButtonElement>(
            '[data-action="report-submit"]',
          );
          // The API requires `description` and treats `photo` as the
          // optional half — a photo-only report is a hard 422 there. Enforce
          // the same rule here (and only mention the photo when the picker
          // is actually on screen: signed-out riders don't get one).
          if (!desc.trim()) {
            if (status) {
              status.textContent = photoInput
                ? "Add a description first — the photo is optional."
                : "Add a description first.";
            }
            return;
          }
          if (sendBtn) sendBtn.disabled = true;
          if (status) status.textContent = "Sending…";
          const photo = photoInput?.files?.[0] ?? null;
          const post = (withPhoto: File | null): Promise<void> =>
            submitModelReport({
              device_id: props.device_id,
              vehicle_identifier: props.vehicle_identifier ?? null,
              description: desc,
              photo: withPhoto,
              lng: coords[0],
              lat: coords[1],
            });
          // The photo picker was rendered from isAuthenticated() at popup-
          // build time; the session can expire while the rider types. The
          // photo needs a bearer token, the description never did — so a 401
          // drops the photo and retries text-only rather than throwing away
          // what they wrote. That's the promise the sign-in note makes:
          // "your description sends either way."
          let photoDropped = false;
          post(photo)
            .catch((err: unknown) => {
              if (
                photo &&
                err instanceof ReportHttpError &&
                err.status === 401
              ) {
                photoDropped = true;
                if (status) {
                  status.textContent =
                    "Session expired — sending your description without the photo…";
                }
                return post(null);
              }
              throw err;
            })
            .then(() => {
              reportForm.innerHTML = photoDropped
                ? `<p class="device-popup__report-status">🎉 Thanks! Your description was sent. Your session had expired, so the photo wasn't uploaded — sign in and you can send it again.</p>`
                : `<p class="device-popup__report-status">🎉 Thanks! Your report helps us name the fleet.</p>`;
            })
            .catch((err: unknown) => {
              // Never clear the textarea on failure — the retry is one tap
              // away and re-typing is not.
              if (sendBtn) sendBtn.disabled = false;
              if (status) {
                status.textContent =
                  err instanceof ReportHttpError && err.status === 401
                    ? "Your session expired — sign in again, then press Send. Your description is still here."
                    : "Couldn't send right now — please try again later.";
              }
            });
        });
      }

      // Worth-the-walk "Show me": fly to the reliable alternative and open
      // its popup so the rider can compare before walking.
      const jumpBtn = this.popup
        .getElement()
        ?.querySelector<HTMLButtonElement>('[data-action="jump-device"]');
      jumpBtn?.addEventListener("click", () => {
        this.jumpToDevice(
          jumpBtn.dataset.device || "",
          Number(jumpBtn.dataset.lng),
          Number(jumpBtn.dataset.lat),
        );
      });

    }
  }

  /** Wire the ⚠️ Report modal's contents inside `root`: the one-tap
   *  device-failure chips (POST /api/v1/reports/device) and the
   *  "Report bad parking to Veo" anchor. The parking anchor opens Veo's
   *  Zendesk form (default nav, new tab) and ALSO fires an
   *  improperly_parked report to our own API, fire-and-forget — never
   *  preventDefault (the Zendesk hand-off must not depend on our POST),
   *  and only with a valid 16-hex vehicle_identifier the API accepts. */
  private wireReportTools(
    root: HTMLElement | null,
    vid: string,
    coords: [number, number],
    parkingInput: ParkingReportInput | null,
  ): void {
    const reportChips = root?.querySelectorAll<HTMLButtonElement>(
      '[data-action="report-device"]',
    );
    if (reportChips?.length) {
      const dStatus = root?.querySelector<HTMLElement>(
        ".device-popup__report-device-status",
      );
      const setDeviceStatus = (text: string, state?: "ok" | "error"): void => {
        if (!dStatus) return;
        dStatus.textContent = text;
        dStatus.classList.toggle(
          "device-popup__report-device-status--ok",
          state === "ok",
        );
        dStatus.classList.toggle(
          "device-popup__report-device-status--error",
          state === "error",
        );
      };
      reportChips.forEach((chip) => {
        chip.addEventListener("click", () => {
          reportChips.forEach((c) => (c.disabled = true));
          setDeviceStatus("Sending…");
          submitDeviceReport({
            vehicle_identifier: vid,
            report_type: chip.dataset.type as DeviceReportType,
            lat: coords[1],
            lng: coords[0],
          })
            .then((res) => {
              setDeviceStatus(
                res.deduped
                  ? "✓ Already flagged recently — thanks."
                  : "✓ Reported. Thanks for the heads-up!",
                "ok",
              );
            })
            .catch(() => {
              reportChips.forEach((c) => (c.disabled = false));
              setDeviceStatus("Couldn't send — please try again.", "error");
            });
        });
      });
    }

    const parkLink = root?.querySelector<HTMLAnchorElement>(
      '[data-action="report-parking"]',
    );
    if (parkLink) {
      // Fire the improperly_parked report to our own API on click (only with a
      // valid 16-hex vehicle_identifier the API accepts).
      if (/^[0-9a-f]{16}$/.test(vid)) {
        parkLink.addEventListener("click", () => {
          submitDeviceReport({
            vehicle_identifier: vid,
            report_type: "improperly_parked",
            lat: coords[1],
            lng: coords[0],
          }).catch(() => {
            /* best-effort; the rider's Veo report is what matters here */
          });
        });
      }
      // Upgrade the Location from raw coords to a reverse-geocoded street
      // address once it resolves, so Veo's form (and the report body) reads
      // "1234 Larimer St, …" instead of a lat/lng. Best-effort: on failure the
      // URL keeps its coordinate fallback; guarded on the anchor still being
      // in the DOM (the Report modal may have closed).
      if (parkingInput) {
        const input = parkingInput;
        void reverseGeocode(coords[1], coords[0]).then((addr) => {
          if (!addr || !parkLink.isConnected) return;
          parkLink.href = veoParkingReportUrl({ ...input, address: addr });
        });
      }
    }
  }

  /** Wire any "Show/Hide on map" range-circle toggles inside `root`. Used
   *  by the full-details modal (the compact popup no longer renders one).
   *  Turning a circle ON also closes the modal — the whole point is to see
   *  the halo, and the backdrop would otherwise cover it. */
  private wireRangeToggles(root: HTMLElement | null): void {
    root
      ?.querySelectorAll<HTMLButtonElement>('[data-action="toggle-range"]')
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const deviceId = btn.dataset.device || "";
          const lng = Number(btn.dataset.lng);
          const lat = Number(btn.dataset.lat);
          const radius = Number(btn.dataset.radius);
          if (this.rangeCircleDeviceId === deviceId) {
            this.clearRangeCircle();
            btn.textContent = "Show on map";
          } else {
            this.showRangeCircle(deviceId, lng, lat, radius);
            btn.textContent = "Hide on map";
            // Close via the ✕ so the modal's Escape listener detaches too.
            document
              .querySelector<HTMLButtonElement>(".ranks-modal__close")
              ?.click();
          }
        });
      });
  }

  /** 📷 / 🖼️ — the device-photos modal: the scooter's existing photos plus
   *  the control that adds one. `startCapture` fires the file picker on open,
   *  which is what makes 📷 Take Photo a one-tap action; it must stay
   *  synchronous inside the button's click handler, or the browser drops the
   *  picker as un-gestured. */
  private openDevicePhotos(
    vid: string,
    headerName: string,
    startCapture: boolean,
    /** The device's own position — sent with the upload so the points row
     *  (sql/056) has a location to be filed against. */
    at: LngLat,
  ): void {
    openFloatingModal(
      `📷 Photos — ${headerName}`,
      `<div class="device-photos">
         <div class="device-photos__grid" aria-live="polite">
           <p class="device-photos__note">Loading photos…</p>
         </div>
         <label class="device-photos__add">
           <input type="file" accept="image/*" capture="environment" />
           <span class="device-photos__add-label">📷 Take Photo</span>
         </label>
         <p class="device-photos__status" role="status" aria-live="polite"></p>
         <p class="device-photos__fine">Up to ${MAX_PHOTOS_PER_DEVICE} photos per scooter. Photos are public and credited to your username unless you've hidden it in Account. Each one is re-encoded on upload, so the location data your camera embeds is destroyed.</p>
       </div>`,
      (root) =>
        this.wireDevicePhotos(root, vid, headerName, startCapture, at),
    );
  }

  /** Loads the gallery, then owns the upload round-trip. Every DOM touch is
   *  guarded on `root.isConnected`: both paths are async, and the rider can
   *  close the modal (✕, backdrop, Escape) while one is still in flight. */
  private wireDevicePhotos(
    root: HTMLElement | null,
    vid: string,
    headerName: string,
    startCapture: boolean,
    at: LngLat,
  ): void {
    const grid = root?.querySelector<HTMLElement>(".device-photos__grid");
    const input = root?.querySelector<HTMLInputElement>(
      ".device-photos__add input",
    );
    const addWrap = root?.querySelector<HTMLElement>(".device-photos__add");
    const status = root?.querySelector<HTMLElement>(".device-photos__status");
    if (!root || !grid || !input || !addWrap || !status) return;

    const setStatus = (text: string): void => {
      if (root.isConnected) status.textContent = text;
    };
    const render = (list: DevicePhotoList, keepStatus = false): void => {
      if (!root.isConnected) return;
      // The URLs are built server-side from R2 keys, but they still reach an
      // href/src — only ever emit one we can see is http(s), never a scheme
      // the browser would execute. Filtered BEFORE the empty check, so a
      // listing whose every URL is rejected still says something rather than
      // rendering an empty box.
      const shown = list.photos.filter((p) => /^https?:\/\//i.test(p.photo_url));
      // Three states, not two: nothing uploaded, something uploaded we won't
      // render, and photos. Collapsing the middle one into "no photos yet"
      // would tell a rider their own upload vanished, and invite them to
      // re-take a photo that is already there.
      const withheld = list.photos.length > 0 && shown.length === 0;
      grid.innerHTML = shown.length
        ? shown
            .map((p) => {
              const who = p.uploaded_by ? p.uploaded_by : "a rider";
              return `<figure class="device-photos__item">
                  <a href="${escapeHtml(p.photo_url)}" target="_blank" rel="noopener">
                    <img src="${escapeHtml(p.photo_url)}" alt="Rider photo of ${escapeHtml(headerName)}" loading="lazy" />
                  </a>
                  <figcaption>${escapeHtml(who)} · ${escapeHtml(formatDate(p.created_at))}</figcaption>
                </figure>`;
            })
            .join("")
        : withheld
          ? `<p class="device-photos__note">${list.photos.length === 1 ? "A photo of this one couldn't" : "Photos of this one couldn't"} be displayed safely, so ${list.photos.length === 1 ? "it's" : "they're"} hidden.</p>`
          : `<p class="device-photos__note">No photos of this one yet — yours would be the first.</p>`;
      // At the cap the control goes away rather than uploading into a 409.
      // The cap is counted from what the server holds, not from what rendered.
      const full = list.photos.length >= MAX_PHOTOS_PER_DEVICE;
      addWrap.hidden = full;
      // `keepStatus` is the re-list after an upload: the rider whose photo
      // was the one that filled the device would otherwise have their "it
      // worked" replaced by the cap notice and never learn it landed.
      if (full && !keepStatus) {
        setStatus(
          `This scooter has all ${MAX_PHOTOS_PER_DEVICE} photos it can hold.`,
        );
      }
    };
    const load = (keepStatus = false): Promise<void> =>
      fetchDevicePhotos(vid)
        .then((list) => render(list, keepStatus))
        .catch((err: unknown) => {
          if (!root.isConnected) return;
          grid.innerHTML = `<p class="device-photos__note">${escapeHtml(photoErrorText(err, "list"))}</p>`;
        });

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      addWrap.hidden = true;
      setStatus("Uploading…");
      uploadDevicePhoto(vid, file, at)
        .then((saved) => {
          // The awarded value comes from the response, never from a local
          // copy of the schedule: the server returns 0 when it could not
          // resolve a location to file the credit against, and a promise of
          // points nobody received is worse than saying nothing.
          setStatus(
            saved.points_awarded > 0
              ? `🎉 Thanks! Your photo is up. +${saved.points_awarded} pts`
              : "🎉 Thanks! Your photo is up.",
          );
          // Re-list rather than appending the upload response: the listing is
          // what carries attribution, and it settles the cap honestly if
          // someone else uploaded while this rider was aiming. The status
          // line is left alone so the confirmation survives the re-render.
          return load(true);
        })
        .catch((err: unknown) => {
          setStatus(photoErrorText(err, "upload"));
          if (root.isConnected) addWrap.hidden = false;
        })
        .finally(() => {
          // Clear the picker so re-choosing the same file still fires change.
          input.value = "";
        });
    });

    void load();
    if (startCapture) input.click();
  }

  /** Center the map on a device and open its popup — used by the
   *  worth-the-walk suggestion, and by the ride wizard's `?ride=` deep-link
   *  entry (hence public: `ride-deeplink.ts` lands the rider on the scanned
   *  device). Note the popup only opens for a device the map's display filters
   *  currently keep — a filtered-out device still gets centered. */
  jumpToDevice(deviceId: string, lng: number, lat: number): void {
    this.map.easeTo({
      center: [lng, lat],
      zoom: Math.max(this.map.getZoom(), 15.5),
    });
    const feat = this.filtered().find(
      (f) => f.properties.device_id === deviceId,
    );
    if (feat) this.openDevicePopup(feat.properties as PopupProps, [lng, lat]);
  }

  /** Nearest visible same-type device with an "ok" reliability tier. */
  private nearestReliable(
    from: LngLat,
    excludeId: string,
    formFactor?: string,
  ): { id: string; lng: number; lat: number; meters: number } | null {
    let best: { id: string; lng: number; lat: number; meters: number } | null =
      null;
    for (const f of this.filtered()) {
      const p = f.properties as DeviceProperties;
      if (p.device_id === excludeId) continue;
      if (p.reliability_tier !== "ok") continue;
      if (formFactor && p.form_factor !== formFactor) continue;
      const [lng, lat] = f.geometry.coordinates;
      const meters = distanceMeters(from, { lng, lat });
      if (!best || meters < best.meters) {
        best = { id: p.device_id, lng, lat, meters };
      }
    }
    return best;
  }

  setData(resp: DevicesResponse): void {
    // The upstream API doesn't yet expose `max_range_meters`, so we derive
    // the maximum *observed* range per propulsion type from the fleet
    // itself and treat that as the type's effective full-charge baseline.
    // Each feature gains a `battery_percent` (0–100) property used by both
    // the marker text and the quartile thresholds, so colors and numbers
    // tell the same story. When the API ships max_range_meters this can
    // collapse to a one-line lookup.
    annotateBatteryPercent(resp.features);
    annotateReliability(resp.features);

    this.all = resp;
    // Recompute battery thresholds from the freshly-arrived fleet so the
    // quartile buckets track real-time vendor data. This happens before
    // apply() so paint expressions in colorBy=range use the new thresholds.
    this.thresholds = computeBatteryThresholds(
      resp.features.map((f) => asNumber(f.properties.battery_percent)),
    );
    for (const cb of this.listeners) cb(this.thresholds);
    this.apply();
  }

  /** Ride-type toggles (default: both). Empty set hides everything. */
  setRideTypes(types: ReadonlySet<RideType>): void {
    this.rideTypes = new Set(types);
    this.apply();
  }

  /** Model toggles (default: all). Unrecognized models are unaffected. */
  setModels(models: ReadonlySet<ModelKey>): void {
    this.models = new Set(models);
    this.apply();
  }

  /** Minimum battery percentage (0 disables the filter). */
  setMinBattery(pct: number): void {
    this.minBattery = Math.max(0, Math.min(100, Math.round(pct)));
    this.apply();
  }

  setQuality(q: QualityFilter): void {
    this.quality = q;
    this.apply();
  }

  /** Restrict to devices inside any of these indexed polygons (null = no area filter). */
  setAreaFilter(areas: AreaFilter): void {
    this.areaFilter = areas;
    this.apply();
  }

  /** Toggle exclusion of disabled / reserved devices from the displayed set. */
  setHideUnavailable(hide: boolean): void {
    this.hideUnavailable = hide;
    this.apply();
  }

  setIconStyle(style: IconStyle): void {
    this.iconStyle = style;
    this.apply(); // icon keys are data-driven — re-annotate + re-set data
  }

  /** "Model" badge art: illustrated comic badges vs model-tinted letters. */
  setModelIcon(v: ModelIcon): void {
    this.modelIcon = v;
    this.apply();
  }

  /** Signal shown by the "Data" badge style. */
  setIconData(source: DataSource): void {
    this.iconData = source;
    this.apply();
  }

  /** Signal the gauge ring is colored/sized by. */
  setGaugeData(source: DataSource): void {
    this.gaugeData = source;
    this.apply();
  }

  setGauge(on: boolean): void {
    this.gauge = on;
    if (!on) this.clearHover();
    this.apply();
  }

  /** ✨ Essentials-on-hover tooltip (model · battery · quality). */
  setHoverTooltip(on: boolean): void {
    this.tooltipOn = on;
    if (!on) hideMapTooltip();
  }

  /** Enter/leave the active-ride follow-cam. While active, device taps use
   *  long-press-to-open so the popup doesn't interrupt the ride. */
  setRideActive(on: boolean): void {
    this.rideActive = on;
    if (!on) {
      this.cancelRidePress();
      window.clearTimeout(this.tooltipHideTimer);
      hideMapTooltip();
    }
  }

  /** Enter/leave profile location picking. While active a device tap must
   *  not open a popup over the point the rider is trying to choose. */
  setPickActive(on: boolean): void {
    this.pickActive = on;
    if (on) hideMapTooltip();
  }

  /** Ride-scoped model visibility, driven by the HUD "Show" pills. Pass null
   *  to clear the ride filter (show everything, including unrecognized
   *  hardware); an empty set shows none. */
  setRideModelFilter(models: ReadonlySet<ModelKey> | null): void {
    this.rideModelFilter = models ? new Set(models) : null;
    this.apply();
  }

  /** "Always" bakes the ring into every icon; "On Hover" reserves the ring's
   *  space and only draws it (via the hover overlay) under the pointer. */
  setGaugeDisplay(mode: GaugeDisplay): void {
    this.gaugeDisplay = mode;
    if (mode === "always") this.clearHover();
    this.apply();
  }

  setGaugeThickness(t: GaugeThickness): void {
    this.gaugeThickness = t;
    this.apply();
  }

  setGaugePlacement(p: GaugePlacement): void {
    this.gaugePlacement = p;
    this.apply();
  }

  /** ✨ Icon size: rescale the on-map device badges. `factor` multiplies
   *  the zoom→size ramp (1 = default); the % text overlays scale with the
   *  badge so they stay inside it. The clustering radius scales in step,
   *  so enlarged icons merge into clusters instead of overlapping and
   *  shrunken icons resolve into more individuals. */
  setIconScale(factor: number): void {
    this.iconScale = factor;
    for (const layer of [POINT_LAYER, HOVER_LAYER]) {
      if (!this.map.getLayer(layer)) continue;
      this.map.setLayoutProperty(layer, "icon-size", this.iconSizeExpr());
      this.map.setLayoutProperty(layer, "text-size", this.textSizeExpr());
    }
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    src?.setClusterOptions({
      cluster: true,
      clusterRadius: Math.round(CLUSTER_RADIUS * factor),
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
    });
  }

  private iconSizeExpr(): ExpressionSpecification {
    const s = this.iconScale;
    // prettier-ignore
    return [
      "interpolate", ["linear"], ["zoom"],
      10, 0.55 * s,
      14, 0.85 * s,
      17, 1.1 * s,
    ];
  }

  private textSizeExpr(): ExpressionSpecification {
    const s = this.iconScale;
    // prettier-ignore
    return [
      "interpolate", ["linear"], ["zoom"],
      10, 7 * s,
      14, 10.5 * s,
      17, 13 * s,
    ];
  }

  private clearHover(): void {
    this.hoverDeviceId = null;
    try {
      this.map.setFilter(HOVER_LAYER, HOVER_NONE);
    } catch {
      // Layer not added yet — nothing to clear.
    }
  }

  /** Get the currently-shown feature subset (for downstream tools like the cluster finder). */
  visibleFeatures(): DevicesResponse["features"] {
    if (!this.all) return [];
    return this.filtered();
  }

  /** Every feature in the last response, ignoring every display filter.
   *  Read-only view for the ride wizard's Screen 2 disambiguation list and the
   *  `?ride=plate:` reverse lookup: those answer "which device am I standing
   *  next to", so a leftover model / battery / quality / area filter must not
   *  be able to hide the very scooter the rider is holding. Everything that
   *  paints the map keeps using visibleFeatures(). */
  allFeatures(): DevicesResponse["features"] {
    return this.all ? this.all.features.slice() : [];
  }

  private filtered(): DevicesResponse["features"] {
    if (!this.all) return [];
    let feats = this.all.features;
    if (this.rideTypes.size < ALL_RIDE_TYPES.length) {
      feats = feats.filter((f) => this.rideTypes.has(rideTypeOf(f.properties)));
    }
    if (this.models.size < ALL_MODELS.length) {
      // Only *recognized* models can be toggled off; mystery hardware
      // always stays visible (it's what the model-report flow feeds on).
      feats = feats.filter((f) => {
        const key = modelKeyOf(f.properties);
        return key === null || this.models.has(key);
      });
    }
    if (this.hideUnavailable) {
      feats = feats.filter(
        (f) =>
          !asBool(f.properties.is_disabled) &&
          !asBool(f.properties.is_reserved),
      );
    }
    if (this.minBattery > 0) {
      const min = this.minBattery;
      feats = feats.filter((f) => {
        const pct = asNumber(f.properties.battery_percent);
        return pct !== null && pct >= min;
      });
    }
    if (this.quality !== "any") {
      const wantOk = this.quality === "ok-only";
      feats = feats.filter((f) => {
        const tier = f.properties.reliability_tier;
        return wantOk ? tier === "ok" : tier !== "risk";
      });
    }
    if (this.areaFilter && this.areaFilter.length > 0) {
      const polys = this.areaFilter;
      feats = feats.filter((f) => {
        const [lng, lat] = f.geometry.coordinates;
        return pointInAny(lng, lat, polys);
      });
    }
    if (this.rideModelFilter) {
      // Ride HUD visibility. An empty set is the explicit "show none." A
      // partial set keeps the chosen models AND unrecognized hardware —
      // deselecting one model shouldn't silently hide mystery scooters the
      // rider never toggled. (All-selected is passed as null upstream, so we
      // only reach here for a genuine "none" or "some" choice.)
      const allow = this.rideModelFilter;
      feats =
        allow.size === 0
          ? []
          : feats.filter((f) => {
              const key = modelKeyOf(f.properties);
              return key === null || allow.has(key);
            });
    }
    return feats;
  }

  private apply(): void {
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    if (!src || !this.all) return;
    const feats = this.filtered();
    this.annotateIconKeys(feats);
    src.setData({ type: "FeatureCollection", features: feats });
    this.applyPaint();
    const total = this.all.features.length;
    for (const cb of this.countListeners) cb(feats.length, total);
  }

  /** Stamp every displayed feature with its composite icon key (plus the
   *  ringed hover variant in On-Hover display) and make sure the map's
   *  image atlas has an image for each unique key. */
  private annotateIconKeys(feats: DevicesResponse["features"]): void {
    const hoverMode = this.gauge && this.gaugeDisplay === "hover";
    const needed = new Set<string>();
    for (const f of feats) {
      const props = f.properties as DeviceProperties & {
        icon_key?: string;
        icon_key_hover?: string;
      };
      const { base, ringed } = this.iconKeysFor(f.properties);
      props.icon_key = base;
      needed.add(base);
      if (hoverMode) {
        props.icon_key_hover = ringed;
        needed.add(ringed);
      } else {
        delete props.icon_key_hover;
      }
    }
    for (const key of needed) {
      if (this.map.hasImage(key)) continue;
      this.map.addImage(key, makeCompositeIcon(key), { pixelRatio: 2 });
    }
  }

  private iconKeysFor(p: DeviceProperties): { base: string; ringed: string } {
    const pct = asNumber(p.battery_percent);
    const tier = normalizeTier(p.reliability_tier) ?? "unknown";

    let inner: string;
    if (this.iconStyle === "use") {
      inner = `use-${rideTypeOf(p)}`;
    } else if (this.iconStyle === "model") {
      const mk = modelKeyOf(p);
      if (this.modelIcon === "letter") {
        // Model-tinted letter badge (As / Co / Ap / Tr); unknown → gray "?".
        inner = `ml-${mk ?? "unk"}`;
      } else {
        // Badge art once its image has decoded; letter tag until then
        // (distinct keys, so the atlas upgrades cleanly when apply() reruns).
        inner = mk && modelIconImages[mk] ? `msvg-${mk}` : `model-${mk ?? "unk"}`;
      }
    } else if (this.iconData === "reliability") {
      inner = `dr-${tier}`;
    } else {
      const b = this.thresholds ? bucketFor(pct, this.thresholds) : null;
      inner = `db-${b ?? "x"}`;
    }

    let ring: string;
    if (this.gaugeData === "reliability") {
      ring = `r-${tier}`;
    } else {
      // Quantize to 5% steps so the atlas stays small (≤21 ring variants).
      ring = pct === null ? "b-x" : `b-${Math.round(pct / 5) * 5}`;
    }

    const design =
      THICKNESS_CHAR[this.gaugeThickness] + PLACEMENT_CHAR[this.gaugePlacement];
    const ringed = `ik|${inner}|${ring}|${design}`;
    // Base icon: full ring when always-on; ring space reserved but empty in
    // hover mode (so the hover overlay adds the ring without a size pop);
    // full-size badge when the gauge is off entirely.
    const base = !this.gauge
      ? `ik|${inner}|off|${design}`
      : this.gaugeDisplay === "hover"
        ? `ik|${inner}|hoff|${design}`
        : ringed;
    return { base, ringed };
  }

  /** The percentage text overlay only makes sense on the "data" badge with
   *  the battery source; everything else renders icon-only. */
  private applyPaint(): void {
    const battText =
      this.iconStyle === "data" &&
      this.iconData === "battery" &&
      this.thresholds;
    const textExpr: maplibregl.ExpressionSpecification | string = battText
      ? textByPercent()
      : "";
    const textColorExpr: maplibregl.ExpressionSpecification | string = battText
      ? textColorByBucket(this.thresholds!)
      : "#ffffff";
    try {
      // The hover overlay mirrors the base layer's text so the percentage
      // stays visible while its ringed icon covers the base badge.
      for (const layer of [POINT_LAYER, HOVER_LAYER]) {
        this.map.setLayoutProperty(layer, "text-field", textExpr);
        this.map.setPaintProperty(layer, "text-color", textColorExpr);
      }
    } catch {
      // Layer might not be added yet (early calls) — addLayers installs
      // the defaults.
    }
  }

  // ---------- Range circle ----------

  /** Show the reachable-distance halo around a single device. Replaces any
   *  prior halo. The popup's toggle button uses this. */
  showRangeCircle(
    deviceId: string,
    lng: number,
    lat: number,
    radiusMeters: number,
  ): void {
    const src = this.map.getSource(RANGE_SRC) as GeoJSONSource | undefined;
    if (!src) return;
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return;
    src.setData({
      type: "FeatureCollection",
      features: [makeCirclePolygon(lng, lat, radiusMeters)],
    });
    this.rangeCircleDeviceId = deviceId;
  }

  /** Hide any visible range halo. */
  clearRangeCircle(): void {
    const src = this.map.getSource(RANGE_SRC) as GeoJSONSource | undefined;
    if (src) src.setData(emptyFC());
    this.rangeCircleDeviceId = null;
  }

}

/** Flattened feature properties the popup builder reads. Public fields are
 *  always potentially present; private fields only ride along when the
 *  signed-in user fetched via the private endpoint. MapLibre flattens
 *  bool/number JSON values into the layer's `properties` map, but the wire
 *  type can become a string when the value rides through a tile encoding,
 *  so every reader is defensive. */
interface PopupProps {
  device_id: string;
  form_factor: FormFactor;
  // public
  vehicle_identifier?: string | null;
  is_disabled?: boolean | string | null;
  is_reserved?: boolean | string | null;
  current_range_meters?: number | string | null;
  propulsion_type?: PropulsionType | string | null;
  vehicle_use_type?: string | null;
  vehicle_model_name?: string | null;
  // h3 indexes (strings) — flattened intact through GeoJSON
  h3_8_index?: string | null;
  h3_9_index?: string | null;
  h3_10_index?: string | null;
  // range percentile / rank fields
  range_percentile_by_type?: number | string | null;
  range_rank_unique_by_type?: number | string | null;
  range_rank_all_by_type?: number | string | null;
  range_rank_all_devices?: number | string | null;
  range_rank_h3_8_peers?: number | string | null;
  range_rank_h3_9_peers?: number | string | null;
  range_rank_h3_10_peers?: number | string | null;
  // quality flags
  has_negative_report?: boolean | string | null;
  quality_designation?: string | null;
  // crowdsourced equipment (API sql/055). `feature_status` is always on the
  // wire; `device_features` is null until somebody confirms the vehicle.
  // MapLibre flattens feature properties, so the nested object arrives as a
  // JSON STRING through the map click path and as a real object through the
  // raw-GeoJSON path — `readDeviceFeatures` below is defensive about both,
  // exactly like the rest of this interface's readers.
  feature_status?: string | null;
  device_features?: unknown;
  // dwell-vs-peers context (public since the §1.4 recalibration)
  dwell_percentile_hood?: number | string | null;
  dwell_peer_median_hours?: number | string | null;
  // client-derived (annotated in setData)
  battery_percent?: number | string | null;
  reliability_tier?: string | null;
  reliability_reasons?: string | null;
  // admin-only extras (ride along on /user/devices/current for
  // ADMIN_EMAILS sessions)
  vehicle_plate?: string;
  first_observed_at_location?: string;
  number_failed_starts?: number | string;
  first_ever_observed_at?: string;
  max_observed_range_meters?: number | string | null;
  max_observed_range_at?: string | null;
}

/** Attach a canonical `reliability_tier` + human-readable
 *  `reliability_reasons` to every feature so paint expressions and popups
 *  tell the same story.
 *
 *  The local assessment mirrors the API's own recalibrated reliability
 *  formula (see assessReliability) — 72h ghost rule plus the peer-relative
 *  dwell-outlier demotion — so server and client should agree. The merge
 *  still takes the WORST of the two tiers, deferring to whichever side has
 *  more evidence (the server may see signals we can't; a lean payload may
 *  hide inputs from us). Reasons are always computed locally. Mutates the
 *  input — call once per fresh DevicesResponse. */
function annotateReliability(features: DevicesResponse["features"]): void {
  const now = Date.now();
  for (const f of features) {
    const props = f.properties;
    const info = assessReliability(props, now);
    const serverTier = normalizeTier(props.reliability_tier);
    props.reliability_tier = serverTier
      ? worstTier(serverTier, info.tier)
      : info.tier;
    props.reliability_reasons = info.reasons.join(" · ");
  }
}

/** Coerce a server/raw tier value to our canonical set, or null if absent
 *  or unrecognized (caller then computes one locally). */
function normalizeTier(v: unknown): ReliabilityTier | null {
  if (v === "ok" || v === "unknown" || v === "risk") return v;
  if (v === "high_risk" || v === "high-risk") return "risk";
  return null;
}

/** Ride posture for the "Device use" icon style and the ride-type filter:
 *  the server-corrected `vehicle_use_type` decides, with the seated models
 *  (Cosmo, Apollo, Rover) as the tiebreaker when it's absent. */
export function rideTypeOf(p: {
  vehicle_use_type?: string | null;
  vehicle_model_name?: string | null;
}): RideType {
  const model = (p.vehicle_model_name ?? "").trim().toLowerCase();
  if (
    p.vehicle_use_type === "sitting" ||
    model === "cosmo" ||
    model === "apollo" ||
    model === "trike" ||
    model === "rover"
  ) {
    return "sitting";
  }
  return "standing";
}

/** Recognized Veo model, or null for mystery hardware. Veo's marketing name
 *  for the three-wheeler is "Rover" — accept it alongside the feed's
 *  historical "trike" spelling, but keep the INTERNAL key "trike": it is
 *  baked into saved filter presets, sprite ids, and the `vehicle_model`
 *  field the routing API receives, so the key is wire format, not copy. */
export function modelKeyOf(p: {
  vehicle_model_name?: string | null;
}): ModelKey | null {
  const model = (p.vehicle_model_name ?? "").trim().toLowerCase();
  if (model === "rover") return "trike";
  return model === "astro" ||
    model === "cosmo" ||
    model === "apollo" ||
    model === "trike"
    ? (model as ModelKey)
    : null;
}

/** Text-field expression for the "Range" display: e.g. "73%". Empty
 *  string when the device has no usable battery_percent so the gray
 *  missing badge shows alone. */
function textByPercent(): maplibregl.ExpressionSpecification {
  return [
    "case",
    ["has", "battery_percent"],
    ["concat", ["to-string", ["get", "battery_percent"]], "%"],
    "",
  ];
}

/** Per-bucket text color so the percentage stays legible on each
 *  background. Mirrors BATTERY_TEXT_COLOR. */
function textColorByBucket(
  t: BatteryThresholds,
): maplibregl.ExpressionSpecification {
  return [
    "step",
    ["to-number", ["coalesce", ["get", "battery_percent"], -1]],
    "#ffffff", // missing → white (gray badge)
    0,
    BATTERY_TEXT_COLOR[0],
    t.p25,
    BATTERY_TEXT_COLOR[1],
    t.p50,
    BATTERY_TEXT_COLOR[2],
    t.p75,
    BATTERY_TEXT_COLOR[3],
  ];
}

/** Walk the fleet, derive a per-propulsion-type max range from the
 *  observed values, and attach a `battery_percent` (0–100 int) to each
 *  feature that has both a numeric current range and a propulsion type.
 *  Mutates the input — call once on each fresh DevicesResponse. */
function annotateBatteryPercent(
  features: DevicesResponse["features"],
): void {
  const maxByType: Record<string, number> = {};
  for (const f of features) {
    const r = asNumber(f.properties.current_range_meters);
    const pt = f.properties.propulsion_type;
    if (r === null || !pt) continue;
    if (!(pt in maxByType) || r > maxByType[pt]) maxByType[pt] = r;
  }
  for (const f of features) {
    const props = f.properties as DeviceProperties & {
      battery_percent?: number;
    };
    // The API now ships a server-computed battery_percent (per-type max
    // range it actually knows). Trust it when present; the derive-from-
    // observed-max path below is the fallback for older payloads.
    const server = asNumber(props.battery_percent);
    if (server !== null) {
      props.battery_percent = Math.max(0, Math.min(100, Math.round(server)));
      continue;
    }
    // Clear stale values from a prior fetch so missing devices don't
    // carry over a phantom percentage.
    delete props.battery_percent;
    const r = asNumber(props.current_range_meters);
    const pt = props.propulsion_type;
    if (r === null || !pt) continue;
    const max = maxByType[pt];
    if (!max || max <= 0) continue;
    const pct = Math.round((r / max) * 100);
    if (!Number.isFinite(pct)) continue;
    props.battery_percent = Math.max(0, Math.min(100, pct));
  }
}

// ---------- Composite marker icons (inner badge + gauge ring) ----------

/** The vehicle badges for the "Model" icon style — full-color circular
 *  badge art in /public, square PNGs pre-clipped to a circle (transparent
 *  corners), so each one IS the inner badge face. Decoded once at startup;
 *  until they're ready (or if one fails), the two-letter tags render
 *  instead. */
const MODEL_ICON_URL: Record<ModelKey, string> = {
  astro: "/astro.png",
  cosmo: "/cosmo.png",
  apollo: "/apollo.png",
  trike: "/trike.png",
};
const modelIconImages: Partial<Record<ModelKey, HTMLImageElement>> = {};
let modelIconsLoading: Promise<void> | null = null;

function loadModelIcons(): Promise<void> {
  modelIconsLoading ??= Promise.all(
    (Object.keys(MODEL_ICON_URL) as ModelKey[]).map(async (key) => {
      const img = new Image();
      img.src = MODEL_ICON_URL[key];
      try {
        await img.decode();
        modelIconImages[key] = img;
      } catch {
        // Missing/broken asset — the letter tag stays as the fallback.
      }
    }),
  ).then(() => undefined);
  return modelIconsLoading;
}

/** Gauge colors by fixed thirds — matches the "green / amber / red" read
 *  the design asks for (55% shows amber, 100% full green). */
export function gaugeColor(pct: number): string {
  if (pct >= 67) return "#238636";
  if (pct >= 34) return "#f5b400";
  return "#c62828";
}

/** Render one composite icon key to a data URL — powers the Iconography
 *  drawer's example rows and the on-map legend, so what they show is the
 *  exact renderer output. Optional overlay text mimics the symbol layer's
 *  percentage overlay on "Data · battery" badges. */
export interface IconPreview {
  url: string;
  /** Logical (CSS) pixel size of the icon — canvases vary by design now
   *  that rings grow outward, so previews scale to match the map. */
  logicalPx: number;
}

export function iconPreviewURL(
  key: string,
  overlay?: { text: string; color: string },
): IconPreview {
  const data = makeCompositeIcon(key);
  const c = document.createElement("canvas");
  c.width = data.width;
  c.height = data.height;
  const ctx = c.getContext("2d");
  if (!ctx) return { url: "", logicalPx: 32 };
  ctx.putImageData(data, 0, 0);
  if (overlay) {
    ctx.fillStyle = overlay.color;
    // Size the overlay against the fixed badge, not the (variable) canvas.
    ctx.font = `bold ${Math.round(RINGED_BADGE_R * 0.9)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(overlay.text, data.width / 2, data.height / 2 + 1);
  }
  return { url: c.toDataURL(), logicalPx: data.width / 2 };
}

/** Resolves when the model badges have decoded (or failed) — callers
 *  re-render model previews after this so the badge art replaces letter
 *  tags. */
export function whenModelIconsReady(): Promise<void> {
  return loadModelIcons();
}

/** Ring stroke widths per Design Options thickness (at the 64px canvas):
 *  arc = the battery progress arc, outline = the thin full-circumference
 *  battery outline, solid = the uniform reliability ring. */
const RING_THICKNESS: Record<
  string,
  { arc: number; outline: number; solid: number }
> = {
  T: { arc: 4.5, outline: 1.8, solid: 4 },
  S: { arc: 7, outline: 2.5, solid: 6 },
  L: { arc: 9.5, outline: 3, solid: 8 },
  X: { arc: 12, outline: 3.5, solid: 10 },
};
/** Extra pixels between the badge edge and the ring per placement. */
const RING_GAP: Record<string, number> = { S: 0, G: 3.5, B: 7 };

/** The badge radius used whenever a gauge ring is in play. FIXED across
 *  every thickness/placement combination — the ring grows OUTWARD (the
 *  canvas gets bigger), the icon never shrinks. Chosen so the default
 *  Standard/Surrounding gauge icon renders exactly as before. */
// Bumped from 20.5 for the full-color badge art — the illustrated faces
// need a touch more width than the old silhouettes to stay readable.
const RINGED_BADGE_R = 23;

/** Ring center-line radius and total canvas size for a design. Exported
 *  shape so previews can scale correctly. */
function ringGeometry(
  th: { arc: number; outline: number; solid: number },
  gap: number,
): { ringR: number; px: number } {
  const maxStroke = Math.max(th.arc, th.solid);
  const ringR = RINGED_BADGE_R + 2.5 + gap + maxStroke / 2;
  let px = Math.ceil((ringR + maxStroke / 2 + 1.5) * 2);
  if (px % 2) px += 1; // even size keeps the center crisp
  return { ringR, px };
}

/** Build one composite marker image from its
 *  `ik|<inner>|<ring>|<design>` key.
 *
 *  Ring encodings: `off` (no gauge — inner badge drawn full size),
 *  `hoff` (On-Hover display: ring geometry reserved but nothing drawn, so
 *  the hover overlay adds the ring without the badge moving),
 *  `b-<pct>` (battery: thin full ring + thick arc clockwise from 12
 *  o'clock covering pct% of the circumference, both in the gauge color),
 *  `b-x` (no battery data: thin neutral ring), `r-<tier>` (reliability:
 *  solid thick ring in the tier color).
 *
 *  Design encodings (two chars): thickness T/S/L/X (thin/standard/large/
 *  xlarge) then placement S/G/B (surrounding/gap/big gap). Placement and
 *  thickness push the ring outward from the fixed-size badge.
 *
 *  Inner encodings: `use-standing|use-sitting` (🛴/🚲 on white),
 *  `msvg-*` (model badge art; key prefix is historical), `model-*`
 *  (two-letter tag fallback),
 *  `db-<bucket|x>` (battery disc, % text overlays via the symbol layer),
 *  `dr-<tier>` (reliability disc with ✓/?/! glyph). */
function makeCompositeIcon(key: string): ImageData {
  const [, inner = "", ring = "off", design = "SS"] = key.split("|");
  const th = RING_THICKNESS[design[0]] ?? RING_THICKNESS.S;
  const gap = RING_GAP[design[1]] ?? 0;

  let px = 64; // 32 logical px at pixelRatio 2
  let innerRadius = px / 2 - 2.5; // gauge off → full-size badge
  let ringR = 0;
  if (ring !== "off") {
    const geo = ringGeometry(th, gap);
    px = geo.px;
    ringR = geo.ringR;
    innerRadius = RINGED_BADGE_R;
  }
  const ctx = newCanvasCtx(px);
  const cx = px / 2;

  if (ring !== "off" && ring !== "hoff") {
    if (ring.startsWith("b-")) {
      const raw = ring.slice(2);
      if (raw === "x") {
        // No battery data: a thin neutral ring, no arc.
        strokeRing(ctx, cx, ringR, BATTERY_MISSING_COLOR, th.outline);
      } else {
        const pct = Math.max(0, Math.min(100, Number(raw)));
        const color = gaugeColor(pct);
        // Thin full-circumference outline…
        strokeRing(ctx, cx, ringR, color, th.outline);
        // …plus the thick arc, clockwise from 12 o'clock, sized to pct.
        if (pct > 0) {
          ctx.beginPath();
          ctx.arc(
            cx,
            cx,
            ringR,
            -Math.PI / 2,
            -Math.PI / 2 + (Math.PI * 2 * pct) / 100,
          );
          ctx.strokeStyle = color;
          ctx.lineWidth = th.arc;
          ctx.lineCap = pct >= 100 ? "butt" : "round";
          ctx.stroke();
        }
      }
    } else if (ring.startsWith("r-")) {
      const tier = ring.slice(2) as ReliabilityTier;
      strokeRing(
        ctx,
        cx,
        ringR,
        RELIABILITY_COLOR[tier] ?? RELIABILITY_COLOR.unknown,
        th.solid,
      );
    }
  }

  drawInnerBadge(ctx, cx, innerRadius, inner);
  return ctx.getImageData(0, 0, px, px);
}

function strokeRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  r: number,
  color: string,
  width: number,
): void {
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

const MODEL_TAG: Record<string, string> = {
  astro: "As",
  cosmo: "Co",
  apollo: "Ap",
  trike: "Ro",
  unk: "?",
};

/** The "letter" Model icon style: a single model-tinted disc. Colors echo
 *  each comic badge's dominant background — Astro's day sky (light blue),
 *  Cosmo's terracotta courtyard (orange), Apollo's night city (purple),
 *  the Rover's seaside sunset (pink). */
const MODEL_COLOR: Record<ModelKey, string> = {
  astro: "#5bb8e6",
  cosmo: "#ee8836",
  apollo: "#8368c4",
  trike: "#f58aac",
};

/** Relative luminance (WCAG) of a #rrggbb color, 0 (black) – 1 (white). */
function relLuminance(hex: string): number {
  const m = hex.replace("#", "");
  const chan = (i: number): number => {
    const c = parseInt(m.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

/** Pick a legible glyph color for a tinted badge: a dark ink on light tints
 *  (Astro/Cosmo/Trike), white on dark ones (Apollo), so the letter clears WCAG
 *  large-text contrast on every model color rather than washing out. */
function glyphColorFor(bg: string): { fill: string; halo: string } {
  return relLuminance(bg) >= 0.3
    ? { fill: "#10233a", halo: "rgba(255,255,255,0.55)" }
    : { fill: "#ffffff", halo: "rgba(0,0,0,0.45)" };
}
const MODEL_LETTER: Record<ModelKey, string> = {
  astro: "As",
  cosmo: "Co",
  apollo: "Ap",
  trike: "Ro",
};

function drawInnerBadge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  r: number,
  inner: string,
): void {
  const d = r * 2;
  if (inner.startsWith("use-")) {
    fillCircle(ctx, cx, r, "#ffffff", "#374151", 2);
    const emoji = inner === "use-sitting" ? "🚲" : "🛴";
    ctx.fillStyle = "#000";
    ctx.font = `${Math.round(d * 0.62)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji, cx, cx + d * 0.03);
  } else if (inner.startsWith("msvg-")) {
    // The badge PNG is pre-clipped to a circle, so it IS the badge face —
    // white disc behind it for contrast, clip to be safe, art on top.
    fillCircle(ctx, cx, r, "#ffffff", "#374151", 2);
    const img = modelIconImages[inner.slice(5) as ModelKey];
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cx, r - 1, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx - r, cx - r, d, d);
      ctx.restore();
    }
  } else if (inner.startsWith("model-")) {
    fillCircle(ctx, cx, r, "#ffffff", "#374151", 2);
    ctx.fillStyle = "#1a2230";
    ctx.font = `bold ${Math.round(d * 0.46)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(MODEL_TAG[inner.slice(6)] ?? "?", cx, cx + d * 0.04);
  } else if (inner.startsWith("ml-")) {
    // Model-tinted letter badge: colored disc + a glyph whose color is chosen
    // by the tint's luminance (dark ink on light Astro/Cosmo/Trike, white on
    // dark Apollo) so the letter clears contrast on every model color.
    const mk = inner.slice(3) as ModelKey;
    const bg = MODEL_COLOR[mk] ?? BATTERY_MISSING_COLOR;
    fillCircle(ctx, cx, r, bg, "#ffffff", 2);
    const letter = MODEL_LETTER[mk] ?? "?";
    const { fill, halo } = glyphColorFor(bg);
    // Two-letter tags (As/Co/Ap) need a smaller size than a lone glyph.
    const fontFrac = letter.length > 1 ? 0.42 : 0.58;
    ctx.font = `800 ${Math.round(d * fontFrac)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, d * 0.07);
    ctx.strokeStyle = halo;
    ctx.strokeText(letter, cx, cx + d * 0.04);
    ctx.fillStyle = fill;
    ctx.fillText(letter, cx, cx + d * 0.04);
  } else if (inner.startsWith("db-")) {
    const raw = inner.slice(3);
    if (raw === "x") {
      fillCircle(ctx, cx, r, BATTERY_MISSING_COLOR, "#ffffff", 2);
      glyph(ctx, cx, d, "?", "#ffffff");
    } else {
      const bucket = Number(raw) as BatteryBucket;
      fillCircle(ctx, cx, r, BATTERY_COLOR[bucket] ?? BATTERY_MISSING_COLOR, "#ffffff", 2);
      // Percentage text overlays via the symbol layer's text-field.
    }
  } else if (inner.startsWith("dr-")) {
    const tier = inner.slice(3) as ReliabilityTier;
    const bg = RELIABILITY_COLOR[tier] ?? RELIABILITY_COLOR.unknown;
    fillCircle(ctx, cx, r, bg, "#ffffff", 2);
    const mark = tier === "ok" ? "✓" : tier === "risk" ? "!" : "?";
    glyph(ctx, cx, d, mark, tier === "unknown" ? "#3a2a00" : "#ffffff");
  } else {
    fillCircle(ctx, cx, r, "#ffffff", "#374151", 2);
  }
}

function fillCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  r: number,
  fill: string,
  stroke: string,
  strokeWidth: number,
): void {
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = strokeWidth;
  ctx.fill();
  ctx.stroke();
}

function glyph(
  ctx: CanvasRenderingContext2D,
  cx: number,
  d: number,
  mark: string,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.font = `bold ${Math.round(d * 0.6)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(mark, cx, cx + d * 0.04);
}

function newCanvasCtx(px: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable for marker icon");
  return ctx;
}

/** Approximate a great-circle of `radiusMeters` around (lng, lat) as a
 *  64-sided polygon. Uses flat-earth lat/lng conversions; accurate enough
 *  for the few-km-to-tens-of-km halo we draw around a single scooter. */
function makeCirclePolygon(
  lng: number,
  lat: number,
  radiusMeters: number,
  steps = 64,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const ring: GeoJSON.Position[] = [];
  const latDegPerMeter = 1 / 111_320;
  const lngDegPerMeter = 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    const dx = radiusMeters * Math.cos(theta) * lngDegPerMeter;
    const dy = radiusMeters * Math.sin(theta) * latDegPerMeter;
    ring.push([lng + dx, lat + dy]);
  }
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {},
  };
}

/** HTML-escape a value for safe interpolation into popup markup. Accepts
 *  `unknown` and coerces to string first: several upstream fields (e.g. the
 *  H3 indexes) arrive as numbers despite their string wire types, and a raw
 *  number has no `.replace`, which previously threw mid-popup-build. */
function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** True iff the value is the boolean true OR the strings "true"/"1".
 *  MapLibre sometimes flattens booleans to strings when properties pass
 *  through tile encoding, so we coerce defensively. */
function asBool(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "string") return v === "true" || v === "1";
  return false;
}

/** Number-or-null helper: rejects NaN, undefined, null, and empty strings. */
function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- ✨ Essentials hover tooltip ----------

const QUALITY_EMOJI: Record<string, string> = {
  great: "🌟",
  good: "👍",
  acceptable: "🆗",
  poor: "👎",
  "N/A": "❓",
  "n/a": "❓",
};

let tooltipEl: HTMLDivElement | null = null;

/** Tiny cursor-following card with just the essentials:
 *    Veo Apollo
 *    🔋 62% · Quality: 👍
 */
function showMapTooltip(
  ev: { clientX: number; clientY: number },
  p: PopupProps,
): void {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "map-tooltip";
    document.body.appendChild(tooltipEl);
  }
  const model = veoModel(p.vehicle_model_name);
  const name = model
    ? model.name
    : p.vehicle_model_name
      ? `Veo ${p.vehicle_model_name}`
      : p.form_factor === "bicycle"
        ? "E-bike"
        : "Scooter";
  const pct = asNumber(p.battery_percent);
  const batt =
    pct === null ? "🔋 —" : `${pct < 25 ? "🪫" : "🔋"} ${Math.round(pct)}%`;
  const q = QUALITY_EMOJI[String(p.quality_designation ?? "")] ?? "❓";
  tooltipEl.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${batt} · Quality: ${q}</span>`;

  const pad = 14;
  let left = ev.clientX + pad;
  const width = 190;
  if (left + width > window.innerWidth - 8) left = ev.clientX - width - 4;
  tooltipEl.style.left = `${Math.max(4, left)}px`;
  tooltipEl.style.top = `${Math.max(4, ev.clientY - 14)}px`;
}

/** Exported for chrome.ts's closeAllPopups: the tooltip element is cached
 *  module-side, so outside code must retire it through here — a bare
 *  .remove() would leave the cache pointing at a detached node. */
export function hideMapTooltip(): void {
  tooltipEl?.remove();
  tooltipEl = null;
}

/** Client-space coordinates of a mouse or touch event, for tooltip placement. */
function clientPointOf(
  oe: MouseEvent | TouchEvent,
): { clientX: number; clientY: number } {
  if (typeof TouchEvent !== "undefined" && oe instanceof TouchEvent) {
    const t = oe.touches[0] ?? oe.changedTouches[0];
    return { clientX: t?.clientX ?? 0, clientY: t?.clientY ?? 0 };
  }
  const m = oe as MouseEvent;
  return { clientX: m.clientX, clientY: m.clientY };
}

/** Floating modal shell shared by the popup's ⚠️ Report / ℹ️ Details
 *  actions (and, historically, the Battery Rankings and Ride history).
 *  One at a time; closes on ✕, backdrop click, or Escape. `bodyHtml` must
 *  already be escaped by the caller; `onOpen` lets the caller wire
 *  interactive content (report chips, the range toggle) after insertion.
 *  Exported for `leaderboard.ts`'s cell-detail panel (ride-mode F4) — the
 *  only other caller of this shell; devices.ts is otherwise unchanged by
 *  that lane. */
export function openFloatingModal(
  title: string,
  bodyHtml: string,
  onOpen?: (root: HTMLElement | null) => void,
): void {
  // Close any open modal through its ✕ so its close() runs and detaches
  // the document-level Escape listener (a bare .remove() would orphan it —
  // reachable via keyboard, since focus stays on the launching button).
  document
    .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")
    ?.click();
  document.querySelector(".ranks-modal")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "ranks-modal";
  backdrop.innerHTML = `
    <div class="ranks-modal__card" role="dialog" aria-modal="true" aria-labelledby="ranks-modal-title">
      <div class="ranks-modal__head">
        <h3 id="ranks-modal-title">${escapeHtml(title)}</h3>
        <button type="button" class="ranks-modal__close" aria-label="Close">×</button>
      </div>
      ${bodyHtml}
    </div>`;
  const close = (): void => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop
    .querySelector(".ranks-modal__close")
    ?.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  onOpen?.(backdrop.querySelector<HTMLElement>(".ranks-modal__card"));
}

/** Format an upstream rank value into a friendly string, or null when absent
 *  or unparseable (so the caller can omit the row). The API sends these as
 *  "rank/total" strings like "646/8746" → "#646 of 8,746"; a bare number is
 *  also tolerated → "#646". Note asNumber() cannot be used here: it returns
 *  null for the slash-delimited form, which is why every rank row previously
 *  rendered "—". */
function formatRank(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) {
    return `#${Number(m[1]).toLocaleString()} of ${Number(m[2]).toLocaleString()}`;
  }
  const n = Number(s);
  return Number.isFinite(n) ? `#${n.toLocaleString()}` : null;
}

/** 0–100 percentile → "p87" with one decimal where helpful. */
function formatPercentile(p: number): string {
  const clamped = Math.max(0, Math.min(100, p));
  const rounded = clamped >= 10 ? Math.round(clamped) : Math.round(clamped * 10) / 10;
  return `p${rounded}`;
}

/** Meters → "3.4 mi (5.5 km)" for at-a-glance range readability. */
function formatRange(meters: number): string {
  const km = meters / 1000;
  const mi = meters / 1609.344;
  return `${mi.toFixed(1)} mi (${km.toFixed(1)} km)`;
}

/** "2025-03-04T18:22:00Z" → "3d 4h" (since now). Falls back to the raw value
 *  for unparseable input so users always see *something*. */
function formatDwell(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const minutes = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Hour count → the same "3d 4h" shape as formatDwell, for the peer-median
 *  hint so the two dwell figures in the popup read alike. */
export function formatDwellHours(hours: number): string {
  const minutes = Math.max(0, Math.round(hours * 60));
  if (minutes < 60) return `${minutes}m`;
  const wholeHours = Math.floor(minutes / 60);
  if (wholeHours < 24) {
    const m = minutes % 60;
    return m ? `${wholeHours}h ${m}m` : `${wholeHours}h`;
  }
  const days = Math.floor(wholeHours / 24);
  const h = wholeHours % 24;
  return h ? `${days}d ${h}h` : `${days}d`;
}

/** Map the server's rider-posture code to a friendly word. Unknown values
 *  pass through so a new posture never renders blank. */
function usePosture(useType: string): string {
  const t = useType.toLowerCase();
  if (t === "sitting") return "seated";
  if (t === "standing") return "standing";
  return useType;
}

/** Short, locale-friendly date for "first observed" stamps. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
