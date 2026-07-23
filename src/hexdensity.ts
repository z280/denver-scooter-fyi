// H3 hexagon shading tool. Grids the map into hexagons at one of three H3
// resolutions and colors each cell by one of six per-cell metrics from the
// H3 aggregates endpoint — device density plus five usage/health metrics
// (trip activity, battery, risk, dwell) that used to require opening every
// popup by hand.
//
// One fetch per resolution carries all six metrics together (they're all
// fields on the same per-cell object), so switching "shade by" is a local
// re-render — no extra network round trip. Only a resolution change
// re-fetches.

import { cellToBoundary } from "h3-js";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import {
  fetchH3Aggregates,
  type H3AggregatesResponse,
  type H3Resolution,
} from "./api.ts";
import { FIRST_DEVICE_LAYER, formatDwellHours } from "./devices.ts";
import { commas, emptyFC, h3ToHex } from "./util.ts";

export type HexSize = "small" | "medium" | "large";
/** Which H3CellMetrics field the cell color encodes. */
export type HexMetric =
  | "device_count"
  | "trips_started_24h"
  | "starts_per_hour_peak"
  | "avg_battery_percent"
  | "risk_share"
  | "avg_dwell_hours";

/** Larger cells = coarser H3 resolution. res 8 ≈ 0.7 km edge (large),
 *  res 9 ≈ 0.26 km (medium), res 10 ≈ 0.10 km (small). */
const RES_BY_SIZE: Record<HexSize, H3Resolution> = {
  large: 8,
  medium: 9,
  small: 10,
};

const SRC = "hex-density";
const FILL = "hex-density-fill";
const LINE = "hex-density-line";

/** One sequential ColorBrewer ramp per metric so switching "shade by" is
 *  visually unmistakable even without reading the legend. */
const RAMP_BLUES = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];
const RAMP_PURPLES = ["#dadaeb", "#bcbddc", "#9e9ac8", "#756bb1", "#54278f"];
const RAMP_ORANGES = ["#fdd0a2", "#fdae6b", "#fd8d3c", "#e6550d", "#a63603"];
const RAMP_GREENS = ["#c7e9c0", "#a1d99b", "#74c476", "#31a354", "#006d2c"];
const RAMP_REDS = ["#fcbba1", "#fc9272", "#fb6a4a", "#de2d26", "#a50f15"];
const RAMP_GREYS = ["#d9d9d9", "#bdbdbd", "#969696", "#636363", "#252525"];

interface MetricConfig {
  ramp: string[];
  /** Legend's high-end label for a given max cell value (the low end is
   *  always "0", the ramp's other fixed point). */
  legendHigh: (max: number) => string;
}

const METRIC: Record<HexMetric, MetricConfig> = {
  device_count: {
    ramp: RAMP_BLUES,
    legendHigh: (max) => `${commas(max)} / cell`,
  },
  trips_started_24h: {
    ramp: RAMP_PURPLES,
    legendHigh: (max) => `${commas(max)} trips / 24h`,
  },
  starts_per_hour_peak: {
    ramp: RAMP_ORANGES,
    legendHigh: (max) => `${commas(max)} starts/hr (peak)`,
  },
  avg_battery_percent: {
    ramp: RAMP_GREENS,
    legendHigh: (max) => `${commas(max)}% avg battery`,
  },
  risk_share: {
    ramp: RAMP_REDS,
    legendHigh: (max) => `${commas(max * 100)}% high-risk`,
  },
  avg_dwell_hours: {
    ramp: RAMP_GREYS,
    legendHigh: (max) => `${formatDwellHours(max)} avg dwell`,
  },
};

export class HexDensity {
  private size: HexSize | null = null;
  private metric: HexMetric = "device_count";
  /** Latest H3 aggregates fetch for the active size — every metric reads
   *  from this same object, since one fetch carries all six fields. */
  private aggregates: H3AggregatesResponse | null = null;
  private aggController: AbortController | null = null;
  /** cell id → GeoJSON ring, memoized (boundaries never change). */
  private ringCache = new Map<string, GeoJSON.Position[]>();

  constructor(
    private readonly map: MLMap,
    private readonly legendEl: HTMLElement,
  ) {}

  /** Off (null) or one of the three cell sizes. */
  async setSize(size: HexSize | null): Promise<void> {
    this.size = size;
    await this.syncAggregates();
    if (this.size === size) this.render();
  }

  /** Switch what the cell color encodes. Free — every metric lives on the
   *  aggregates response already loaded for the active size. */
  setMetric(metric: HexMetric): void {
    if (this.metric === metric) return;
    this.metric = metric;
    this.render();
  }

  isActive(): boolean {
    return this.size !== null;
  }

  /** Re-fetch the active size's aggregates on the device-refresh tick (if
   *  hex shading is on) — mirrors Overlays.refreshChoropleth. The endpoint
   *  is CDN-cached ~10 min so this is cheap even on the faster poll cadence. */
  async refresh(): Promise<void> {
    if (!this.size) return;
    const size = this.size;
    await this.syncAggregates();
    if (this.size === size) this.render();
  }

  /** Fetch aggregates for the active size, canceling any stale in-flight
   *  fetch from a prior size so a slow response can't clobber a newer one.
   *  No-op when hex shading is off. */
  private async syncAggregates(): Promise<void> {
    this.aggController?.abort();
    this.aggController = null;
    if (!this.size) return;
    const controller = new AbortController();
    this.aggController = controller;
    try {
      this.aggregates = await fetchH3Aggregates(
        RES_BY_SIZE[this.size],
        controller.signal,
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error("h3 aggregates fetch failed", e);
      this.aggregates = null;
    }
  }

  private ensureLayers(): void {
    if (this.map.getSource(SRC)) return;
    this.map.addSource(SRC, { type: "geojson", data: emptyFC() });
    const before = this.map.getLayer(FIRST_DEVICE_LAYER)
      ? FIRST_DEVICE_LAYER
      : undefined;
    this.map.addLayer(
      {
        id: FILL,
        type: "fill",
        source: SRC,
        paint: { "fill-opacity": 0.55, "fill-color": "#6baed6" },
      },
      before,
    );
    this.map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        paint: {
          "line-color": "#2171b5",
          "line-width": 0.8,
          "line-opacity": 0.45,
        },
      },
      before,
    );
  }

  private render(): void {
    if (!this.size) {
      this.clear();
      return;
    }
    this.ensureLayers();
    const values = this.metricValues(this.metric);

    let max = 0;
    const feats: GeoJSON.Feature<GeoJSON.Polygon, { value: number }>[] = [];
    for (const [id, value] of values) {
      const ring = this.ring(id);
      if (!ring) continue;
      if (value > max) max = value;
      feats.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { value },
      });
    }
    max = Math.max(1, max);

    const src = this.map.getSource(SRC) as GeoJSONSource;
    src.setData({ type: "FeatureCollection", features: feats });

    const ramp = METRIC[this.metric].ramp;
    const stops: (number | string)[] = [];
    ramp.forEach((color, i) => {
      stops.push((max * i) / (ramp.length - 1), color);
    });
    this.map.setPaintProperty(FILL, "fill-color", [
      "interpolate",
      ["linear"],
      ["get", "value"],
      ...stops,
    ]);

    this.renderLegend(max);
  }

  /** Read one metric field per cell from the last aggregates fetch,
   *  skipping cells where it's null (e.g. avg_battery_percent for a cell
   *  with no parked devices). */
  private metricValues(metric: HexMetric): Map<string, number> {
    const values = new Map<string, number>();
    if (!this.aggregates) return values;
    for (const [id, cell] of Object.entries(this.aggregates.cells)) {
      const v = cell[metric];
      if (v === null || v === undefined) continue;
      values.set(id, v);
    }
    return values;
  }

  private ring(id: string): GeoJSON.Position[] | null {
    const cached = this.ringCache.get(id);
    if (cached) return cached;
    try {
      // h3-js returns [lat, lng]; flip to GeoJSON [lng, lat] and close the ring.
      const boundary = cellToBoundary(h3ToHex(id));
      const ring = boundary.map(([lat, lng]) => [lng, lat] as GeoJSON.Position);
      if (ring.length > 0) ring.push(ring[0]);
      if (ring.length < 4) return null;
      this.ringCache.set(id, ring);
      return ring;
    } catch {
      return null;
    }
  }

  private clear(): void {
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    src?.setData(emptyFC());
    this.legendEl.hidden = true;
  }

  private renderLegend(max: number): void {
    this.legendEl.replaceChildren();
    const bar = document.createElement("div");
    bar.className = "legend__bar";
    for (const color of METRIC[this.metric].ramp) {
      const sw = document.createElement("span");
      sw.className = "legend__swatch";
      sw.style.background = color;
      bar.appendChild(sw);
    }
    const scale = document.createElement("div");
    scale.className = "legend__scale";
    const lo = document.createElement("span");
    lo.textContent = "0";
    const hi = document.createElement("span");
    hi.textContent = METRIC[this.metric].legendHigh(max);
    scale.append(lo, hi);
    this.legendEl.append(bar, scale);
    this.legendEl.hidden = false;
  }
}
