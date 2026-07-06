// H3 hexagon density map tool. Bins the live fleet by H3 cell and colors
// each cell by how many devices fall in it — a spatial "where are the
// scooters clustered" view at three cell sizes (H3 resolutions 8/9/10).
//
// Devices already carry h3_8/9/10 index (as exact decimal-integer strings),
// so binning is a group-and-count; h3-js turns each cell id into a hexagon
// boundary for rendering. Replaces the old per-device "rank vs H3 peers"
// popup rows, which nobody used.

import { cellToBoundary } from "h3-js";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import { FIRST_DEVICE_LAYER } from "./devices.ts";
import { commas, emptyFC, h3ToHex } from "./util.ts";

export type HexSize = "small" | "medium" | "large";

/** Larger cells = coarser H3 resolution. res 8 ≈ 0.7 km edge (large),
 *  res 9 ≈ 0.26 km (medium), res 10 ≈ 0.10 km (small). */
type H3Key = "h3_8_index" | "h3_9_index" | "h3_10_index";
const KEY_BY_SIZE: Record<HexSize, H3Key> = {
  large: "h3_8_index",
  medium: "h3_9_index",
  small: "h3_10_index",
};

const SRC = "hex-density";
const FILL = "hex-density-fill";
const LINE = "hex-density-line";
/** Sequential blue ramp (ColorBrewer Blues). Starts at a *visible* light
 *  blue rather than near-white so even single-device cells read against the
 *  basemap. */
const RAMP = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];

export class HexDensity {
  private size: HexSize | null = null;
  private features: DevicesResponse["features"] = [];
  /** cell id → GeoJSON ring, memoized (boundaries never change). */
  private ringCache = new Map<string, GeoJSON.Position[]>();

  constructor(
    private readonly map: MLMap,
    private readonly legendEl: HTMLElement,
  ) {}

  /** Off (null) or one of the three cell sizes. */
  setSize(size: HexSize | null): void {
    this.size = size;
    this.render();
  }

  isActive(): boolean {
    return this.size !== null;
  }

  /** Feed the current fleet; re-bins if a size is active. */
  update(features: DevicesResponse["features"]): void {
    this.features = features;
    if (this.size) this.render();
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
    const key = KEY_BY_SIZE[this.size];

    const counts = new Map<string, number>();
    for (const f of this.features) {
      const raw = (f.properties as DeviceProperties)[key];
      if (raw === null || raw === undefined || raw === "") continue;
      const id = String(raw);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

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

    const stops: (number | string)[] = [];
    RAMP.forEach((color, i) => {
      stops.push((max * i) / (RAMP.length - 1), color);
    });
    this.map.setPaintProperty(FILL, "fill-color", [
      "interpolate",
      ["linear"],
      ["get", "count"],
      ...stops,
    ]);

    this.renderLegend(max);
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
    for (const color of RAMP) {
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
    hi.textContent = `${commas(max)} / cell`;
    scale.append(lo, hi);
    this.legendEl.append(bar, scale);
    this.legendEl.hidden = false;
  }
}
