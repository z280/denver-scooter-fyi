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
import { DEVICE_COLORS, veoDeepLink } from "./config.ts";
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
  type DeviceReportType,
} from "./reports.ts";

export type AreaFilter = IndexedFeature[] | null;
/** Ride posture, the primary "what am I sitting on" split. Derived from the
 *  server-corrected `vehicle_use_type` with model names as tiebreaker. */
export type RideType = "sitting" | "standing";
/** Veo's recognized model line-up (unrecognized models are never filtered). */
export type ModelKey = "astro" | "cosmo" | "apollo";
export type QualityFilter = "any" | "no-risk" | "ok-only";
/** What the marker's inner badge depicts. */
export type IconStyle = "use" | "model" | "data";
/** Which signal colors the gauge ring (and the "data" badge). */
export type DataSource = "battery" | "reliability";

export const ALL_RIDE_TYPES: readonly RideType[] = ["sitting", "standing"];
export const ALL_MODELS: readonly ModelKey[] = ["astro", "cosmo", "apollo"];

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

const RANGE_SRC = "device-range";
const RANGE_FILL_LAYER = "device-range-fill";
const RANGE_LINE_LAYER = "device-range-line";

const SRC = "devices";
/** Base clustering radius (px) at the default ✨ Icon size; setIconScale
 *  scales it with the badges so bigger icons cluster sooner instead of
 *  piling into overlap, and smaller icons spread out more individuals. */
const CLUSTER_RADIUS = 50;
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
  private iconStyle: IconStyle = "use";
  private iconData: DataSource = "reliability";
  private gaugeData: DataSource = "battery";
  private gauge = true;
  // Design options: on-hover display swaps the ring onto a hover overlay
  // layer; thickness/placement are baked into every icon key.
  private gaugeDisplay: GaugeDisplay = "always";
  private gaugeThickness: GaugeThickness = "standard";
  private gaugePlacement: GaugePlacement = "surrounding";
  private hoverDeviceId: string | null = null;
  /** ✨ Essentials-on-hover tooltip, default on. */
  private tooltipOn = true;
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

  constructor(
    private readonly map: Map,
    private readonly locate: Locate,
  ) {}

  addLayers(): void {
    // Kick off the model-silhouette decode; when it lands, re-annotate so
    // Model-style markers upgrade from letter tags to the real silhouettes.
    void loadModelIcons().then(() => this.apply());

    this.map.addSource(SRC, {
      type: "geojson",
      data: emptyFC(),
      cluster: true,
      clusterRadius: CLUSTER_RADIUS,
      clusterMaxZoom: 13,
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
      // ✨ Essentials tooltip (premium): model + battery + quality.
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
      const feature = e.features?.[0];
      if (!feature) return;
      const geom = feature.geometry as GeoJSON.Point;
      this.openDevicePopup(
        feature.properties as PopupProps,
        geom.coordinates as [number, number],
      );
    });

    for (const layer of [CLUSTER_LAYER, POINT_LAYER]) {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
      });
    }
  }

  /** Build and show the details popup for one device. Called from the map
   *  click handler (flattened feature properties) and from the
   *  worth-the-walk "Show me" jump (raw GeoJSON properties) — the readers
   *  are defensive about both. */
  private openDevicePopup(props: PopupProps, coords: [number, number]): void {
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
             <label class="device-popup__report-photo">
               <input type="file" accept="image/*" capture="environment" />
               <span class="device-popup__report-photo-label">📷 Add a photo</span>
             </label>
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

      // Reliability verdict — the headline answer to "worth the walk?".
      // setData() pre-annotated tier + reasons; fall back to a fresh
      // assessment for props that didn't ride through it. normalizeTier
      // guards against a raw server "high_risk" reaching the color lookup.
      const relTier =
        normalizeTier(props.reliability_tier) ?? assessReliability(props).tier;
      const relReasons =
        props.reliability_reasons ??
        assessReliability(props).reasons.join(" · ");
      const relBlock = `
        <div class="device-popup__reliability">
          <span class="device-popup__rel-dot" style="background:${RELIABILITY_COLOR[relTier]}" aria-hidden="true"></span>
          <span class="device-popup__rel-label">${escapeHtml(RELIABILITY_LABEL[relTier])}</span>
          ${relReasons ? `<div class="device-popup__rel-reasons">${escapeHtml(relReasons)}</div>` : ""}
        </div>`;

      const user = this.locate.current();

      // Unlock deep link — same URL as the QR sticker on the scooter's deck.
      // Deliberately gated three ways: it needs the plate (authenticated
      // fetch only — we never expose plates to anonymous users, so Veo can't
      // scrape our map back into their GBFS feed), an active location fix,
      // AND physical proximity. Unlocking is a standing-at-the-scooter
      // action; a link that works from your couch is a plate leak with extra
      // steps. When authed but not in range, we say why instead of hiding it.
      let unlockBlock = "";
      if (props.vehicle_plate && isAuthenticated()) {
        const nearEnough =
          user !== null && distanceMeters(user, here) <= UNLOCK_PROXIMITY_M;
        if (nearEnough) {
          const link = veoDeepLink(String(props.vehicle_plate));
          unlockBlock = `
            <div class="device-popup__unlock-row">
              <a class="device-popup__unlock" href="${escapeHtml(link)}">Unlock in Veo →</a>
            </div>`;
        } else {
          const why = user
            ? "Walk up to this scooter to unlock it here."
            : "Turn on your location to unlock at the scooter.";
          unlockBlock = `<div class="device-popup__unlock-hint">🔒 ${escapeHtml(why)}</div>`;
        }
      }

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

      // Public detail rows.
      const publicRows: string[] = [];
      if (props.vehicle_model_name) {
        // Model name (aligned to Veo's app), with the corrected rider posture
        // when known — key posture off vehicle_use_type, not form_factor.
        const use = props.vehicle_use_type
          ? ` <span class="device-popup__hint">${escapeHtml(usePosture(props.vehicle_use_type))}</span>`
          : "";
        publicRows.push(
          `<dt>Model</dt><dd>${escapeHtml(String(props.vehicle_model_name))}${use}</dd>`,
        );
      }
      const rangeMeters = asNumber(props.current_range_meters);
      if (rangeMeters !== null) {
        const showing = this.rangeCircleDeviceId === props.device_id;
        const linkText = showing ? "Hide on map" : "Show on map";
        publicRows.push(
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
             >${linkText}</button>
           </dd>`,
        );
      }
      if (props.propulsion_type) {
        const prop = String(props.propulsion_type) as PropulsionType;
        const lbl = PROPULSION_LABEL[prop] ?? prop;
        publicRows.push(`<dt>Drivetrain</dt><dd>${escapeHtml(lbl)}</dd>`);
      }
      if (props.vehicle_identifier) {
        publicRows.push(
          `<dt>Vehicle ID</dt><dd><code>${escapeHtml(String(props.vehicle_identifier))}</code></dd>`,
        );
      }

      // Range-rank rows are API-computed but too wonky for the popup
      // proper — they live in a modal behind a "Show Battery Rankings"
      // link, and the link itself is analysis-mode-only (hidden via CSS in
      // ride mode).
      const rankRows: string[] = [];
      const percentile = asNumber(props.range_percentile_by_type);
      if (percentile !== null) {
        rankRows.push(
          `<dt>Range percentile</dt><dd>${formatPercentile(percentile)} <span class="device-popup__hint">vs same drivetrain</span></dd>`,
        );
      }
      const rankAllDevices = formatRank(props.range_rank_all_devices);
      if (rankAllDevices !== null) {
        rankRows.push(`<dt>Rank (citywide)</dt><dd>${rankAllDevices}</dd>`);
      }
      const rankByType = formatRank(props.range_rank_all_by_type);
      if (rankByType !== null) {
        rankRows.push(`<dt>Rank (by drivetrain)</dt><dd>${rankByType}</dd>`);
      }
      const ranksLink = rankRows.length
        ? `<button type="button" class="device-popup__ranks-link text-btn" data-action="show-ranks">Show Battery Rankings</button>`
        : "";

      // Quality + reliability rows — all now public. quality_designation,
      // negative-report flag, dwell time, and failed starts ship on the
      // public endpoint, so they belong here (not behind the auth tag).
      const qualityRows: string[] = [];
      if (props.quality_designation) {
        qualityRows.push(
          `<dt>Quality</dt><dd><code>${escapeHtml(String(props.quality_designation))}</code></dd>`,
        );
      }
      if (asBool(props.has_negative_report)) {
        qualityRows.push(
          `<dt>Reports</dt><dd><span class="device-popup__status device-popup__status--flagged">Negative report on file</span></dd>`,
        );
      }
      if (props.first_observed_at_location) {
        qualityRows.push(
          `<dt>Parked for</dt><dd>${escapeHtml(formatDwell(props.first_observed_at_location))}</dd>`,
        );
      }
      const failedStarts = asNumber(props.number_failed_starts);
      if (failedStarts !== null) {
        qualityRows.push(
          `<dt>Failed starts</dt><dd>${failedStarts.toLocaleString()}</dd>`,
        );
      }

      // Private detail rows — only present when the authenticated fetch ran.
      // Post-revert this is just the plate (never public) and the all-time
      // first-seen stamp (private lookup only).
      const privateRows: string[] = [];
      if (props.vehicle_plate) {
        privateRows.push(
          `<dt>Plate</dt><dd><code>${escapeHtml(props.vehicle_plate)}</code></dd>`,
        );
      }
      if (props.first_ever_observed_at) {
        privateRows.push(
          `<dt>First seen ever</dt><dd>${escapeHtml(formatDate(props.first_ever_observed_at))}</dd>`,
        );
      }

      const statusBlock = statusBadges.length
        ? `<div class="device-popup__statuses">${statusBadges.join("")}</div>`
        : "";

      const qualityBlock = qualityRows.length
        ? `<dl class="device-popup__meta">${qualityRows.join("")}</dl>`
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
                 <button type="button" class="device-popup__report-chip" data-action="report-device" data-type="failed_unlock">🚫 Won't unlock</button>
                 <button type="button" class="device-popup__report-chip" data-action="report-device" data-type="dead_battery">🪫 Dead battery</button>
                 <button type="button" class="device-popup__report-chip" data-action="report-device" data-type="damaged">🛴 Damaged</button>
               </div>
               <p class="device-popup__report-device-status" role="status" aria-live="polite"></p>
             </div>`
          : "";

      // Primary (always-present) column. The authenticated data, when
      // available, rides in a SECOND column beside this one so the popup
      // grows sideways instead of getting even taller.
      const primaryColumn = `
        <div class="device-popup__col">
          ${statusBlock}
          ${relBlock}
          ${unlockBlock}
          ${walkBlock}
          <dl class="device-popup__meta">
            <dt>Device ID</dt>
            <dd><code>${escapeHtml(props.device_id)}</code></dd>
            ${publicRows.join("")}
          </dl>
          ${qualityBlock}
          ${ranksLink}
          ${reportProblemBlock}
        </div>`;
      const authColumn = privateRows.length
        ? `<div class="device-popup__col device-popup__col--auth">
             <span class="device-popup__authed-tag">Authenticated</span>
             <dl class="device-popup__meta">${privateRows.join("")}</dl>
           </div>`
        : "";
      const twoCol = privateRows.length ? " device-popup__body--two-col" : "";

      this.popup?.remove();
      this.popup = new maplibregl.Popup({
        closeButton: true,
        offset: 10,
        maxWidth: privateRows.length ? "460px" : "270px",
      })
        .setLngLat(coords)
        .setHTML(
          `<div class="device-popup">
             ${headerBlock}
             <div class="device-popup__body${twoCol}">${primaryColumn}${authColumn}</div>
           </div>`,
        )
        .addTo(map);

      // Dashed orientation line user → device while the popup is open.
      if (user) {
        this.locate.showLineTo(here);
        this.popup.on("close", () => this.locate.clearLine());
      }

      // "Show Battery Rankings" → the nerd-stats modal (analysis mode only;
      // the link is display:none'd in ride mode).
      const ranksBtn = this.popup
        .getElement()
        ?.querySelector<HTMLButtonElement>('[data-action="show-ranks"]');
      ranksBtn?.addEventListener("click", () => {
        openRanksModal(rankRows);
      });

      // Wire the "Show/Hide on map" range-circle toggle, if rendered.
      const toggleBtn = this.popup
        .getElement()
        ?.querySelector<HTMLButtonElement>(
          '[data-action="toggle-range"]',
        );
      toggleBtn?.addEventListener("click", () => {
        const deviceId = toggleBtn.dataset.device || "";
        const lng = Number(toggleBtn.dataset.lng);
        const lat = Number(toggleBtn.dataset.lat);
        const radius = Number(toggleBtn.dataset.radius);
        if (this.rangeCircleDeviceId === deviceId) {
          this.clearRangeCircle();
          toggleBtn.textContent = "Show on map";
        } else {
          this.showRangeCircle(deviceId, lng, lat, radius);
          toggleBtn.textContent = "Hide on map";
        }
      });

      const popupEl = this.popup.getElement();

      // One-tap device-failure report chips → POST /api/v1/reports/device.
      const reportChips = popupEl?.querySelectorAll<HTMLButtonElement>(
        '[data-action="report-device"]',
      );
      if (reportChips?.length) {
        const dStatus = popupEl?.querySelector<HTMLElement>(
          ".device-popup__report-device-status",
        );
        const setDeviceStatus = (
          text: string,
          state?: "ok" | "error",
        ): void => {
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
          if (!desc.trim() && !photoInput?.files?.length) {
            if (status) status.textContent = "Add a description or a photo first.";
            return;
          }
          if (sendBtn) sendBtn.disabled = true;
          if (status) status.textContent = "Sending…";
          submitModelReport({
            device_id: props.device_id,
            vehicle_identifier: props.vehicle_identifier ?? null,
            description: desc,
            photo: photoInput?.files?.[0] ?? null,
            lng: coords[0],
            lat: coords[1],
          })
            .then(() => {
              reportForm.innerHTML =
                `<p class="device-popup__report-status">🎉 Thanks! Your report helps us name the fleet.</p>`;
            })
            .catch(() => {
              if (sendBtn) sendBtn.disabled = false;
              if (status) {
                status.textContent =
                  "Couldn't send right now — please try again later.";
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

  /** Center the map on a device and open its popup — used by the
   *  worth-the-walk suggestion. */
  private jumpToDevice(deviceId: string, lng: number, lat: number): void {
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
      // Silhouette badge once its SVG has decoded; letter tag until then
      // (distinct keys, so the atlas upgrades cleanly when apply() reruns).
      inner = mk && modelIconImages[mk] ? `msvg-${mk}` : `model-${mk ?? "unk"}`;
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
  // client-derived (annotated in setData)
  battery_percent?: number | string | null;
  reliability_tier?: string | null;
  reliability_reasons?: string | null;
  // private (authed only)
  vehicle_plate?: string;
  first_observed_at_location?: string;
  number_failed_starts?: number | string;
  first_ever_observed_at?: string;
}

/** Attach a canonical `reliability_tier` + human-readable
 *  `reliability_reasons` to every feature so paint expressions and popups
 *  tell the same story.
 *
 *  The local assessment mirrors the API's own reliability formula (see
 *  assessReliability), so server and client agree except for the one
 *  deliberate client-side addition: the pre-ghost caution band (clean
 *  dwell 48–96h shows "unknown" where the server still says "ok"). The
 *  merge takes the WORST of the two tiers, which applies that band and
 *  otherwise defers to whichever side has more evidence. Reasons are
 *  always computed locally. Mutates the input — call once per fresh
 *  DevicesResponse. */
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
 *  (Cosmo, Apollo) as the tiebreaker when it's absent. */
export function rideTypeOf(p: {
  vehicle_use_type?: string | null;
  vehicle_model_name?: string | null;
}): RideType {
  const model = (p.vehicle_model_name ?? "").trim().toLowerCase();
  if (p.vehicle_use_type === "sitting" || model === "cosmo" || model === "apollo") {
    return "sitting";
  }
  return "standing";
}

/** Recognized Veo model, or null for mystery hardware. */
export function modelKeyOf(p: {
  vehicle_model_name?: string | null;
}): ModelKey | null {
  const model = (p.vehicle_model_name ?? "").trim().toLowerCase();
  return model === "astro" || model === "cosmo" || model === "apollo"
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

/** Resolves when the model silhouettes have decoded (or failed) — callers
 *  re-render model previews after this so the SVGs replace letter tags. */
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
 *  `msvg-*` (model silhouette), `model-*` (two-letter tag fallback),
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
  unk: "?",
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
    // The SVG is pre-clipped to a circle, so it IS the badge face — white
    // disc behind it for contrast, clip to be safe, silhouette on top.
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
function showMapTooltip(ev: MouseEvent, p: PopupProps): void {
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

function hideMapTooltip(): void {
  tooltipEl?.remove();
  tooltipEl = null;
}

/** Lightweight modal for the battery-ranking nerd stats. One at a time;
 *  closes on ✕, backdrop click, or Escape. */
function openRanksModal(rankRows: string[]): void {
  document.querySelector(".ranks-modal")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "ranks-modal";
  backdrop.innerHTML = `
    <div class="ranks-modal__card" role="dialog" aria-modal="true" aria-labelledby="ranks-modal-title">
      <div class="ranks-modal__head">
        <h3 id="ranks-modal-title">Battery Rankings</h3>
        <button type="button" class="ranks-modal__close" aria-label="Close">×</button>
      </div>
      <p class="ranks-modal__hint">How this device's remaining range compares to the rest of the fleet right now.</p>
      <dl class="device-popup__meta">${rankRows.join("")}</dl>
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
