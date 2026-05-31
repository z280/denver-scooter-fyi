import maplibregl, { type Map, type GeoJSONSource } from "maplibre-gl";
import type { DevicesResponse, FormFactor, PropulsionType } from "./api.ts";
import { DEVICE_COLORS } from "./config.ts";
import { emptyFC } from "./util.ts";
import { pointInAny, type IndexedFeature } from "./geo.ts";
import {
  computeBatteryThresholds,
  bucketFor,
  BATTERY_COLOR,
  BATTERY_MISSING_COLOR,
  type BatteryBucket,
  type BatteryThresholds,
} from "./battery.ts";

export type DeviceFilter = "all" | "scooter" | "bicycle";
export type AreaFilter = IndexedFeature[] | null;
export type ColorMode = "type" | "range";

const RANGE_SRC = "device-range";
const RANGE_FILL_LAYER = "device-range-fill";
const RANGE_LINE_LAYER = "device-range-line";

const SRC = "devices";
const CLUSTER_LAYER = "device-clusters";
/** Overlays insert before this id so device markers stay on top. */
export const FIRST_DEVICE_LAYER = CLUSTER_LAYER;
const COUNT_LAYER = "device-cluster-count";
const POINT_LAYER = "device-points";

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
  private colorMode: ColorMode = "type";
  private thresholds: BatteryThresholds | null = null;
  private popup: maplibregl.Popup | null = null;
  /** device_id of the scooter whose range circle is currently drawn, or
   *  null if no circle is showing. Used so popups can render a toggleable
   *  Show/Hide-on-map link. */
  private rangeCircleDeviceId: string | null = null;
  /** Observers notified after every apply() — used by the battery filter
   *  UI to enable/disable buttons when thresholds become (un)available. */
  private listeners = new Set<(t: BatteryThresholds | null) => void>();

  constructor(private readonly map: Map) {}

  addLayers(): void {
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

    this.map.addLayer({
      id: POINT_LAYER,
      type: "circle",
      source: SRC,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": colorByType(),
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          3,
          14,
          5,
          17,
          7,
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
        "circle-opacity": 0.95,
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
      // Public fields are always potentially present; private fields only
      // ride along when the signed-in user fetched via the private endpoint.
      // MapLibre flattens bool/number JSON values into the layer's
      // `properties` map, but the wire type can become a string when the
      // value rides through a tile encoding. Be defensive in the readers.
      const props = feature.properties as {
        device_id: string;
        form_factor: FormFactor;
        // public
        vehicle_identifier?: string | null;
        is_disabled?: boolean | string | null;
        is_reserved?: boolean | string | null;
        current_range_meters?: number | string | null;
        propulsion_type?: PropulsionType | string | null;
        // private (authed only)
        vehicle_plate?: string;
        first_observed_at_location?: string;
        number_failed_starts?: number | string;
        first_ever_observed_at?: string;
      };
      const geom = feature.geometry as GeoJSON.Point;
      const label = FORM_LABEL[props.form_factor] ?? props.form_factor;
      const color =
        DEVICE_COLORS[props.form_factor as keyof typeof DEVICE_COLORS] ??
        DEVICE_COLORS.unknown;

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
               data-lng="${(geom.coordinates as [number, number])[0]}"
               data-lat="${(geom.coordinates as [number, number])[1]}"
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

      // Private detail rows — present only when the authenticated fetch ran.
      const privateRows: string[] = [];
      if (props.vehicle_plate) {
        privateRows.push(
          `<dt>Plate</dt><dd><code>${escapeHtml(props.vehicle_plate)}</code></dd>`,
        );
      }
      if (props.first_observed_at_location) {
        privateRows.push(
          `<dt>Parked for</dt><dd>${escapeHtml(formatDwell(props.first_observed_at_location))}</dd>`,
        );
      }
      const failedStarts = asNumber(props.number_failed_starts);
      if (failedStarts !== null) {
        privateRows.push(
          `<dt>Failed starts</dt><dd>${failedStarts.toLocaleString()}</dd>`,
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

      const privateBlock = privateRows.length
        ? `<div class="device-popup__authed">
             <span class="device-popup__authed-tag">Authenticated</span>
             <dl class="device-popup__meta">${privateRows.join("")}</dl>
           </div>`
        : "";

      this.popup?.remove();
      this.popup = new maplibregl.Popup({ closeButton: true, offset: 10 })
        .setLngLat(geom.coordinates as [number, number])
        .setHTML(
          `<div class="device-popup">
             <span class="device-popup__badge" style="background:${color}">${label}</span>
             ${statusBlock}
             <dl class="device-popup__meta">
               <dt>Device ID</dt>
               <dd><code>${escapeHtml(props.device_id)}</code></dd>
               ${publicRows.join("")}
             </dl>
             ${privateBlock}
           </div>`,
        )
        .addTo(map);

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

  setData(resp: DevicesResponse): void {
    this.all = resp;
    // Recompute battery thresholds from the freshly-arrived fleet so the
    // quartile buckets track real-time vendor data. This happens before
    // apply() so paint expressions in colorBy=range use the new thresholds.
    this.thresholds = computeBatteryThresholds(
      resp.features.map((f) => asNumber(f.properties.current_range_meters)),
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
          const meters = asNumber(f.properties.current_range_meters);
          const b = bucketFor(meters, t);
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
    src.setData({ type: "FeatureCollection", features: this.filtered() });
    this.applyPaint();
  }

  /** Push the current color-by mode into the point-layer paint property.
   *  Cheap to call repeatedly; the map only redraws if the expression
   *  actually changed. */
  private applyPaint(): void {
    const expr =
      this.colorMode === "range" && this.thresholds
        ? colorByRange(this.thresholds)
        : colorByType();
    try {
      this.map.setPaintProperty(POINT_LAYER, "circle-color", expr);
    } catch {
      // Layer might not be added yet (early calls); next addLayers will
      // pick up the right paint via colorByType() default.
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

/** Per-form-factor color expression — the original default look. */
function colorByType(): maplibregl.ExpressionSpecification {
  return [
    "match",
    ["get", "form_factor"],
    "scooter",
    DEVICE_COLORS.scooter,
    "bicycle",
    DEVICE_COLORS.bicycle,
    DEVICE_COLORS.unknown,
  ];
}

/** Quartile-based color expression for the "Color by Range" mode. Devices
 *  without a numeric range are painted in the neutral missing color. */
function colorByRange(
  t: BatteryThresholds,
): maplibregl.ExpressionSpecification {
  // coalesce(null) → -1 so step's "below first stop" branch catches it.
  return [
    "step",
    ["to-number", ["coalesce", ["get", "current_range_meters"], -1]],
    BATTERY_MISSING_COLOR,
    0,
    BATTERY_COLOR[0],
    t.p25,
    BATTERY_COLOR[1],
    t.p50,
    BATTERY_COLOR[2],
    t.p75,
    BATTERY_COLOR[3],
  ];
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

function escapeHtml(s: string): string {
  return s.replace(
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
