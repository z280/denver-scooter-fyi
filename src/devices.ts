import maplibregl, { type Map, type GeoJSONSource } from "maplibre-gl";
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

export type DeviceFilter = "all" | "scooter" | "bicycle";
export type AreaFilter = IndexedFeature[] | null;
export type ColorMode = "type" | "range" | "reliability";

/** How close (metres) the user must be for the "Unlock in Veo" button to
 *  appear. Generous enough to tolerate consumer-GPS scatter (~20–40 m),
 *  tight enough that the button means "you're at this scooter." */
const UNLOCK_PROXIMITY_M = 75;

const RANGE_SRC = "device-range";
const RANGE_FILL_LAYER = "device-range-fill";
const RANGE_LINE_LAYER = "device-range-line";

const SRC = "devices";
const CLUSTER_LAYER = "device-clusters";
/** Overlays insert before this id so device markers stay on top. */
export const FIRST_DEVICE_LAYER = CLUSTER_LAYER;
const COUNT_LAYER = "device-cluster-count";
const POINT_LAYER = "device-points";
const FLAG_LAYER = "device-negative-flag";
/** Layers with their own click behavior — a click that hits one of these
 *  should not also trigger the map-click region filter beneath it. */
export const DEVICE_INTERACTIVE_LAYERS = [CLUSTER_LAYER, POINT_LAYER];

const FORM_LABEL: Record<FormFactor, string> = {
  scooter: "Scooter",
  bicycle: "E-bike",
  unknown: "Unknown",
};

const PROPULSION_LABEL: Record<PropulsionType, string> = {
  electric: "Throttle electric",
  electric_assist: "Pedal-assist electric",
  human: "Pedal-only",
};

export class Devices {
  private all: DevicesResponse | null = null;
  private filter: DeviceFilter = "all";
  private areaFilter: AreaFilter = null;
  private hideUnavailable = false;
  /** Null = no battery filter. Empty set = filter is "on" but excludes
   *  everything. Set of bucket indices = restrict to those buckets. */
  private batteryBuckets: Set<BatteryBucket> | null = null;
  // Default to battery-range coloring rather than device type (per product
  // direction). Falls back to type icons automatically until enough range
  // data arrives to compute quartile thresholds.
  private colorMode: ColorMode = "range";
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

  constructor(
    private readonly map: Map,
    private readonly locate: Locate,
  ) {}

  addLayers(): void {
    registerDeviceIcons(this.map);

    this.map.addSource(SRC, {
      type: "geojson",
      data: emptyFC(),
      cluster: true,
      clusterRadius: 50,
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
        "icon-image": iconByType(),
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          0.55,
          14,
          0.85,
          17,
          1.1,
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        // Text overlay is empty in "Device type" mode; applyPaint() swaps
        // these in/out when the user toggles to "Range" mode so the
        // percentage renders inside the colored badge.
        "text-field": "",
        "text-font": ["Noto Sans Medium"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          7,
          14,
          10.5,
          17,
          13,
        ],
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
      const label = FORM_LABEL[props.form_factor] ?? props.form_factor;
      const color =
        DEVICE_COLORS[props.form_factor as keyof typeof DEVICE_COLORS] ??
        DEVICE_COLORS.unknown;
      const here: LngLat = { lng: coords[0], lat: coords[1] };

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

      // Range-rank rows. (Per-H3-cell ranks were removed — see the
      // hexagon-density map tool in the Areas panel for spatial views.)
      const percentile = asNumber(props.range_percentile_by_type);
      if (percentile !== null) {
        publicRows.push(
          `<dt>Range percentile</dt><dd>${formatPercentile(percentile)} <span class="device-popup__hint">vs same drivetrain</span></dd>`,
        );
      }
      const rankAllDevices = formatRank(props.range_rank_all_devices);
      if (rankAllDevices !== null) {
        publicRows.push(
          `<dt>Rank (citywide)</dt><dd>${rankAllDevices}</dd>`,
        );
      }
      const rankByType = formatRank(props.range_rank_all_by_type);
      if (rankByType !== null) {
        publicRows.push(
          `<dt>Rank (by drivetrain)</dt><dd>${rankByType}</dd>`,
        );
      }

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

      // Primary (always-present) column. The authenticated data, when
      // available, rides in a SECOND column beside this one so the popup
      // grows sideways instead of getting even taller.
      const primaryColumn = `
        <div class="device-popup__col">
          <span class="device-popup__badge" style="background:${color}">${label}</span>
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
        </div>`;
      const authColumn = privateRows.length
        ? `<div class="device-popup__col device-popup__col--auth">
             <span class="device-popup__authed-tag">Authenticated</span>
             <dl class="device-popup__meta">${privateRows.join("")}</dl>
           </div>`
        : "";
      const twoCol = privateRows.length ? " device-popup--two-col" : "";

      this.popup?.remove();
      this.popup = new maplibregl.Popup({
        closeButton: true,
        offset: 10,
        maxWidth: privateRows.length ? "460px" : "260px",
      })
        .setLngLat(coords)
        .setHTML(
          `<div class="device-popup${twoCol}">${primaryColumn}${authColumn}</div>`,
        )
        .addTo(map);

      // Dashed orientation line user → device while the popup is open.
      if (user) {
        this.locate.showLineTo(here);
        this.popup.on("close", () => this.locate.clearLine());
      }

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

  setFilter(filter: DeviceFilter): void {
    this.filter = filter;
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

  /** Restrict to devices in the given battery quartile bucket(s). Pass null
   *  to clear the filter; pass an empty set to hide all batteried devices. */
  setBatteryFilter(buckets: Set<BatteryBucket> | null): void {
    this.batteryBuckets = buckets;
    this.apply();
  }

  setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
    this.applyPaint();
  }

  /** Get the currently-shown feature subset (for downstream tools like the cluster finder). */
  visibleFeatures(): DevicesResponse["features"] {
    if (!this.all) return [];
    return this.filtered();
  }

  private filtered(): DevicesResponse["features"] {
    if (!this.all) return [];
    let feats = this.all.features;
    if (this.filter !== "all") {
      feats = feats.filter((f) => f.properties.form_factor === this.filter);
    }
    if (this.hideUnavailable) {
      feats = feats.filter(
        (f) =>
          !asBool(f.properties.is_disabled) &&
          !asBool(f.properties.is_reserved),
      );
    }
    if (this.batteryBuckets) {
      const allowed = this.batteryBuckets;
      const t = this.thresholds;
      // No thresholds yet → no device can satisfy a bucket-filter, hide all.
      if (!t) {
        feats = [];
      } else {
        feats = feats.filter((f) => {
          const pct = asNumber(f.properties.battery_percent);
          const b = bucketFor(pct, t);
          return b !== null && allowed.has(b);
        });
      }
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
    src.setData({ type: "FeatureCollection", features: feats });
    this.applyPaint();
    const total = this.all.features.length;
    for (const cb of this.countListeners) cb(feats.length, total);
  }

  /** Push the current display mode into the point-layer's icon + text
   *  expressions. In "Range" mode each marker is a colored bucket disc
   *  with the percentage rendered inside; in "Device type" mode it's the
   *  emoji badge with no text. Cheap to call repeatedly. */
  private applyPaint(): void {
    const rangeMode = this.colorMode === "range" && this.thresholds;
    const iconExpr =
      this.colorMode === "reliability"
        ? iconByReliability()
        : rangeMode
          ? iconByRange(this.thresholds!)
          : iconByType();
    const textExpr: maplibregl.ExpressionSpecification | string = rangeMode
      ? textByPercent()
      : "";
    const textColorExpr: maplibregl.ExpressionSpecification | string = rangeMode
      ? textColorByBucket(this.thresholds!)
      : "#ffffff";
    try {
      this.map.setLayoutProperty(POINT_LAYER, "icon-image", iconExpr);
      this.map.setLayoutProperty(POINT_LAYER, "text-field", textExpr);
      this.map.setPaintProperty(POINT_LAYER, "text-color", textColorExpr);
    } catch {
      // Layer might not be added yet (early calls); addLayers will install
      // the default iconByType() expression.
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
 *  tell the same story. Prefers the server's tier (normalizing its
 *  "high_risk" to our "risk") and falls back to a local assessment when the
 *  server omits it. Reasons are always computed locally from the now-public
 *  quality/dwell/failed-start signals. Mutates the input — call once per
 *  fresh DevicesResponse. */
function annotateReliability(features: DevicesResponse["features"]): void {
  const now = Date.now();
  for (const f of features) {
    const props = f.properties;
    const info = assessReliability(props, now);
    props.reliability_tier = normalizeTier(props.reliability_tier) ?? info.tier;
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

/** Per-form-factor icon expression — the default "Device type" display. */
function iconByType(): maplibregl.ExpressionSpecification {
  return [
    "match",
    ["get", "form_factor"],
    "scooter",
    "dev-scooter",
    "bicycle",
    "dev-bicycle",
    "dev-unknown",
  ];
}

/** Tier-based icon expression for the "Reliability" display. */
function iconByReliability(): maplibregl.ExpressionSpecification {
  return [
    "match",
    ["get", "reliability_tier"],
    "ok",
    "dev-rel-ok",
    "risk",
    "dev-rel-risk",
    "dev-rel-unknown",
  ];
}

/** Quartile-based icon expression for the "Range" display. Reads the
 *  pre-annotated battery_percent (see annotateBatteryPercent). Devices
 *  without a percentage fall through to the neutral missing icon. */
function iconByRange(
  t: BatteryThresholds,
): maplibregl.ExpressionSpecification {
  // coalesce(null) → -1 so step's "below first stop" branch catches it.
  return [
    "step",
    ["to-number", ["coalesce", ["get", "battery_percent"], -1]],
    "dev-batt-missing",
    0,
    "dev-batt-0",
    t.p25,
    "dev-batt-1",
    t.p50,
    "dev-batt-2",
    t.p75,
    "dev-batt-3",
  ];
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

/** Register the eight device-marker icons on the map's image atlas. Each
 *  is a small circular badge: type-mode icons hold a 🛴/🚲/❓ emoji on a
 *  white field; range-mode icons hold a battery bar glyph on the bucket's
 *  signature color. Idempotent (safe to call after style reloads). */
function registerDeviceIcons(map: Map): void {
  const typeIcons: Array<[string, string]> = [
    ["dev-scooter", "🛴"],
    ["dev-bicycle", "🚲"],
    ["dev-unknown", "❓"],
  ];
  for (const [id, emoji] of typeIcons) {
    if (map.hasImage(id)) continue;
    map.addImage(id, makeEmojiBadge(emoji), { pixelRatio: 2 });
  }
  // The four bucket badges are blank colored discs — the percentage text
  // is rendered on top via the symbol layer's text-field. Missing keeps
  // its inscribed "?" since there's no percentage to overlay.
  const bucketBgs: Array<[string, string]> = [
    ["dev-batt-0", BATTERY_COLOR[0]],
    ["dev-batt-1", BATTERY_COLOR[1]],
    ["dev-batt-2", BATTERY_COLOR[2]],
    ["dev-batt-3", BATTERY_COLOR[3]],
  ];
  for (const [id, bg] of bucketBgs) {
    if (map.hasImage(id)) continue;
    map.addImage(id, makeBlankBadge(bg), { pixelRatio: 2 });
  }
  if (!map.hasImage("dev-batt-missing")) {
    map.addImage(
      "dev-batt-missing",
      makeGlyphBadge("?", BATTERY_MISSING_COLOR, "#ffffff"),
      { pixelRatio: 2 },
    );
  }
  // Reliability-tier badges: ✓ / ? / ! on the tier's signature color.
  const relIcons: Array<[string, string, string, string]> = [
    ["dev-rel-ok", "✓", RELIABILITY_COLOR.ok, "#ffffff"],
    ["dev-rel-unknown", "?", RELIABILITY_COLOR.unknown, "#3a2a00"],
    ["dev-rel-risk", "!", RELIABILITY_COLOR.risk, "#ffffff"],
  ];
  for (const [id, glyph, bg, fg] of relIcons) {
    if (map.hasImage(id)) continue;
    map.addImage(id, makeGlyphBadge(glyph, bg, fg), { pixelRatio: 2 });
  }
}

/** White circular badge holding a centered emoji, used in "Device type"
 *  display mode. Drawn at 2× pixel density so it stays crisp on retina. */
function makeEmojiBadge(emoji: string): ImageData {
  const px = 64; // 32 logical px at pixelRatio 2
  const ctx = newCanvasCtx(px);
  drawCircleBg(ctx, px, "#ffffff", "#374151", 2.5);
  ctx.fillStyle = "#000";
  ctx.font = `${Math.round(px * 0.55)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, px / 2, px / 2 + px * 0.03);
  return ctx.getImageData(0, 0, px, px);
}

/** Blank colored circle used as the background for the four "Range"
 *  buckets; the percentage text rides on top via the symbol layer's
 *  text-field. */
function makeBlankBadge(bg: string): ImageData {
  const px = 64;
  const ctx = newCanvasCtx(px);
  drawCircleBg(ctx, px, bg, "#ffffff", 2.5);
  return ctx.getImageData(0, 0, px, px);
}

/** Colored circular badge holding a centered text glyph. Used for the
 *  "?" missing-range badge (and previously for the bucket glyphs before
 *  the text-overlay redesign). */
function makeGlyphBadge(glyph: string, bg: string, fg: string): ImageData {
  const px = 64;
  const ctx = newCanvasCtx(px);
  drawCircleBg(ctx, px, bg, "#ffffff", 2.5);
  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.round(px * 0.7)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, px / 2, px / 2 + px * 0.04);
  return ctx.getImageData(0, 0, px, px);
}

function newCanvasCtx(px: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable for marker icon");
  return ctx;
}

function drawCircleBg(
  ctx: CanvasRenderingContext2D,
  px: number,
  fill: string,
  stroke: string,
  strokeWidth: number,
): void {
  const cx = px / 2;
  const r = px / 2 - strokeWidth;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = strokeWidth;
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
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
