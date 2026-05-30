import maplibregl, {
  type Map as MLMap,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type FilterSpecification,
} from "maplibre-gl";
import {
  fetchBoundary,
  fetchSpatialSnapshot,
  type BoundaryLayer,
  type BoundaryResponse,
} from "./api.ts";
import { OVERLAY_BY_LAYER } from "./config.ts";
import { FIRST_DEVICE_LAYER } from "./devices.ts";
import { commas, prettyRegion } from "./util.ts";

const CHOROPLETH_FILL = "choropleth-fill";
const HIGHLIGHT_LINE = "nbhd-highlight";
const HIGHLIGHT_SRC = "nbhd-highlight-src";

/** Sequential blue ramp for choropleth fills. */
const RAMP = ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"];

function srcId(layer: BoundaryLayer) {
  return `bnd-${layer}`;
}
function fillId(layer: BoundaryLayer) {
  return `bnd-${layer}-fill`;
}
function lineId(layer: BoundaryLayer) {
  return `bnd-${layer}-line`;
}

export class Overlays {
  private cache = new Map<BoundaryLayer, BoundaryResponse>();
  private loaded = new Set<BoundaryLayer>();
  private choroplethLayer: BoundaryLayer | null = null;

  constructor(
    private readonly map: MLMap,
    private readonly legendEl: HTMLElement,
  ) {}

  /** Fetch (and cache) a boundary layer's data without touching the map. */
  async loadBoundary(layer: BoundaryLayer): Promise<BoundaryResponse> {
    let data = this.cache.get(layer);
    if (!data) {
      data = await fetchBoundary(layer);
      this.cache.set(layer, data);
    }
    return data;
  }

  /** Lazy-load a boundary layer's geometry and add its (hidden) fill + line layers. */
  private async ensureLayer(layer: BoundaryLayer): Promise<BoundaryResponse> {
    const data = await this.loadBoundary(layer);
    if (!this.loaded.has(layer)) {
      const def = OVERLAY_BY_LAYER[layer];
      // promoteId is required for setFeatureState to bind: MapLibre ignores
      // string top-level `id` on GeoJSON features (only numeric ids are kept),
      // so without this the choropleth state never reaches the renderer.
      this.map.addSource(srcId(layer), {
        type: "geojson",
        data,
        promoteId: "region_name",
      });
      this.map.addLayer(
        {
          id: fillId(layer),
          type: "fill",
          source: srcId(layer),
          layout: { visibility: "none" },
          paint: { "fill-color": def.color, "fill-opacity": 0.12 },
        },
        FIRST_DEVICE_LAYER,
      );
      this.map.addLayer(
        {
          id: lineId(layer),
          type: "line",
          source: srcId(layer),
          layout: { visibility: "none", "line-join": "round" },
          paint: { "line-color": def.color, "line-width": 1.6, "line-opacity": 0.9 },
        },
        FIRST_DEVICE_LAYER,
      );
      this.loaded.add(layer);
    }
    return data;
  }

  async toggle(layer: BoundaryLayer, on: boolean): Promise<void> {
    await this.ensureLayer(layer);
    const vis = on ? "visible" : "none";
    this.map.setLayoutProperty(fillId(layer), "visibility", vis);
    this.map.setLayoutProperty(lineId(layer), "visibility", vis);
  }

  /**
   * Restrict the overlay's polygons to a specific set of region_names.
   * Pass null to clear the filter (show every region of the layer).
   */
  async setSubset(
    layer: BoundaryLayer,
    regionNames: string[] | null,
  ): Promise<void> {
    await this.ensureLayer(layer);
    const filter: FilterSpecification | null =
      regionNames === null
        ? null
        : ["in", ["get", "region_name"], ["literal", regionNames]];
    this.map.setFilter(fillId(layer), filter);
    this.map.setFilter(lineId(layer), filter);
  }

  /** Color one layer's regions by live device density (or clear when null). */
  async setChoropleth(layer: BoundaryLayer | null): Promise<void> {
    if (this.choroplethLayer && this.choroplethLayer !== layer) {
      this.clearChoropleth();
    }
    if (!layer) {
      this.clearChoropleth();
      this.legendEl.hidden = true;
      return;
    }

    await this.ensureLayer(layer);
    const snapshot = await fetchSpatialSnapshot(layer);
    const source = srcId(layer);

    let max = 0;
    for (const r of Object.values(snapshot.regions)) max = Math.max(max, r.total);
    max = Math.max(max, 1);

    const features = this.cache.get(layer)!.features;
    for (const f of features) {
      const name = f.properties.region_name;
      const total = snapshot.regions[name]?.total ?? 0;
      this.map.setFeatureState({ source, id: name as string }, { density: total });
    }

    const stops: (number | string)[] = [];
    RAMP.forEach((color, i) => {
      stops.push((max * i) / (RAMP.length - 1), color);
    });
    const fillColor = [
      "interpolate",
      ["linear"],
      ["coalesce", ["feature-state", "density"], 0],
      ...stops,
    ] as maplibregl.ExpressionSpecification;

    // Re-create the choropleth fill so it binds to the current layer's source.
    if (this.map.getLayer(CHOROPLETH_FILL)) this.map.removeLayer(CHOROPLETH_FILL);
    this.map.addLayer(
      {
        id: CHOROPLETH_FILL,
        type: "fill",
        source,
        paint: { "fill-opacity": 0.72, "fill-color": fillColor },
      },
      FIRST_DEVICE_LAYER,
    );

    this.choroplethLayer = layer;
    this.renderLegend(max);
  }

  private clearChoropleth(): void {
    if (this.map.getLayer(CHOROPLETH_FILL)) this.map.removeLayer(CHOROPLETH_FILL);
    if (this.choroplethLayer) {
      const source = srcId(this.choroplethLayer);
      const features = this.cache.get(this.choroplethLayer)?.features ?? [];
      for (const f of features) {
        this.map.removeFeatureState({ source, id: f.properties.region_name as string });
      }
    }
    this.choroplethLayer = null;
  }

  /** Refresh choropleth counts on the device-refresh tick (if active). */
  async refreshChoropleth(): Promise<void> {
    if (this.choroplethLayer) await this.setChoropleth(this.choroplethLayer);
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
    hi.textContent = `${commas(max)} devices`;
    scale.append(lo, hi);

    this.legendEl.append(bar, scale);
    this.legendEl.hidden = false;
  }

  // ----- Neighborhood search + highlight -----

  async neighborhoodList(): Promise<{ value: string; label: string }[]> {
    const data = await this.ensureLayer("neighborhood");
    return data.features
      .map((f) => ({
        value: f.properties.region_name,
        label: prettyRegion(f.properties.region_name, "neighborhood"),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async highlightNeighborhood(regionName: string | null): Promise<void> {
    if (!this.map.getSource(HIGHLIGHT_SRC)) {
      this.map.addSource(HIGHLIGHT_SRC, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      this.map.addLayer(
        {
          id: HIGHLIGHT_LINE,
          type: "line",
          source: HIGHLIGHT_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#111827", "line-width": 3, "line-opacity": 0.95 },
        },
        FIRST_DEVICE_LAYER,
      );
    }
    const hSrc = this.map.getSource(HIGHLIGHT_SRC) as GeoJSONSource;

    if (!regionName) {
      hSrc.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const data = await this.ensureLayer("neighborhood");
    const feature = data.features.find((f) => f.properties.region_name === regionName);
    if (!feature) return;

    hSrc.setData({ type: "FeatureCollection", features: [feature] });
    const b = bounds(feature.geometry);
    if (b) this.map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 800 });
  }
}

/** Compute a [[w,s],[e,n]] bounds box from a polygon/multipolygon. */
function bounds(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): LngLatBoundsLike | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  for (const ring of rings) {
    for (const [x, y] of ring as [number, number][]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}
