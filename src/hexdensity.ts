// H3 hexagon density map tool. Bins the live fleet by H3 cell and colors
// each cell by how many devices fall in it — a spatial "where are the
// scooters clustered" view at three cell sizes (H3 resolutions 8/9/10).
// Can also shade by the server's rolling starts/hour peak instead of raw
// device count, pulled from the H3 aggregates endpoint.
//
// Devices already carry h3_8/9/10 index (as exact decimal-integer strings),
// so density binning is a group-and-count; h3-js turns each cell id into a
// hexagon boundary for rendering. Replaces the old per-device "rank vs H3
// peers" popup rows, which nobody used.

import { cellToBoundary } from "h3-js";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import {
  fetchH3Aggregates,
  type DeviceProperties,
  type DevicesResponse,
  type H3AggregatesResponse,
  type H3Resolution,
} from "./api.ts";
import { FIRST_DEVICE_LAYER } from "./devices.ts";
import { commas, emptyFC, h3ToHex } from "./util.ts";

export type HexSize = "small" | "medium" | "large";
/** What the cell color encodes: live device count (client-side, from the
 *  current fleet fetch) or the server's rolling starts/hour peak. */
export type HexMetric = "density" | "starts_per_hour";

/** Larger cells = coarser H3 resolution. res 8 ≈ 0.7 km edge (large),
 *  res 9 ≈ 0.26 km (medium), res 10 ≈ 0.10 km (small). */
type H3Key = "h3_8_index" | "h3_9_index" | "h3_10_index";
const KEY_BY_SIZE: Record<HexSize, H3Key> = {
  large: "h3_8_index",
  medium: "h3_9_index",
  small: "h3_10_index",
};
const RES_BY_SIZE: Record<HexSize, H3Resolution> = {
  large: 8,
  medium: 9,
  small: 10,
};

const SRC = "hex-density";
const FILL = "hex-density-fill";
const LINE = "hex-density-line";
/** Sequential blue ramp (ColorBrewer Blues). Starts at a *visible* light
 *  blue rather than near-white so even single-device cells read against the
 *  basemap. */
const RAMP_DENSITY = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];
/** Sequential orange ramp (ColorBrewer Oranges) for starts/hour, so it never
 *  reads as the same layer as device density at a glance. */
const RAMP_STARTS = ["#fdd0a2", "#fdae6b", "#fd8d3c", "#e6550d", "#a63603"];
const RAMP_BY_METRIC: Record<HexMetric, string[]> = {
  density: RAMP_DENSITY,
  starts_per_hour: RAMP_STARTS,
};
const LEGEND_SUFFIX: Record<HexMetric, string> = {
  density: "/ cell",
  starts_per_hour: "starts/hr (peak)",
};

export class HexDensity {
  private size: HexSize | null = null;
  private metric: HexMetric = "density";
  private features: DevicesResponse["features"] = [];
  /** Latest H3 aggregates fetch for the active size, kept only while metric
   *  is "starts_per_hour". Null until it loads (or if it fails). */
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

  /** Switch what the cell color encodes. */
  async setMetric(metric: HexMetric): Promise<void> {
    if (this.metric === metric) return;
    this.metric = metric;
    await this.syncAggregates();
    if (this.metric === metric) this.render();
  }

  isActive(): boolean {
    return this.size !== null;
  }

  /** Feed the current fleet; re-bins if a size is active and density is showing. */
  update(features: DevicesResponse["features"]): void {
    this.features = features;
    if (this.size && this.metric === "density") this.render();
  }

  /** Re-fetch starts/hour on the device-refresh tick (if active) — mirrors
   *  Overlays.refreshChoropleth. The endpoint is CDN-cached ~10 min so this
   *  is cheap even on the faster device-poll cadence. */
  async refresh(): Promise<void> {
    if (!this.size || this.metric !== "starts_per_hour") return;
    const size = this.size;
    const metric = this.metric;
    await this.syncAggregates();
    if (this.size === size && this.metric === metric) this.render();
  }

  /** Fetch aggregates for the active size when starts/hour needs them. A
   *  no-op otherwise, after canceling any stale in-flight fetch so a slow
   *  response from a prior size/metric can't clobber a newer selection. */
  private async syncAggregates(): Promise<void> {
    this.aggController?.abort();
    this.aggController = null;
    if (!this.size || this.metric !== "starts_per_hour") return;
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
    const size = this.size;
    this.ensureLayers();

    const counts =
      this.metric === "density" ? this.densityCounts(size) : this.startsCounts();

    let max = 0;
    const feats: GeoJSON.Feature<GeoJSON.Polygon, { count: number }>[] = [];
    for (const [id, count] of counts) {
      const ring = this.ring(id);
      if (!ring) continue;
      if (count > max) max = count;
      feats.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { count },
      });
    }
    max = Math.max(1, max);

    const src = this.map.getSource(SRC) as GeoJSONSource;
    src.setData({ type: "FeatureCollection", features: feats });

    const ramp = RAMP_BY_METRIC[this.metric];
    const stops: (number | string)[] = [];
    ramp.forEach((color, i) => {
      stops.push((max * i) / (ramp.length - 1), color);
    });
    this.map.setPaintProperty(FILL, "fill-color", [
      "interpolate",
      ["linear"],
      ["get", "count"],
      ...stops,
    ]);

    this.renderLegend(max);
  }

  /** Bin the live fleet by its precomputed H3 index at the active size. */
  private densityCounts(size: HexSize): Map<string, number> {
    const key = KEY_BY_SIZE[size];
    const counts = new Map<string, number>();
    for (const f of this.features) {
      const raw = (f.properties as DeviceProperties)[key];
      if (raw === null || raw === undefined || raw === "") continue;
      const id = String(raw);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  /** Read starts/hour peak per cell from the last aggregates fetch. */
  private startsCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    if (!this.aggregates) return counts;
    for (const [id, cell] of Object.entries(this.aggregates.cells)) {
      counts.set(id, cell.starts_per_hour_peak);
    }
    return counts;
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
    for (const color of RAMP_BY_METRIC[this.metric]) {
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
    hi.textContent = `${commas(max)} ${LEGEND_SUFFIX[this.metric]}`;
    scale.append(lo, hi);
    this.legendEl.append(bar, scale);
    this.legendEl.hidden = false;
  }
}
