import maplibregl, {
  type Map as MLMap,
  type FilterSpecification,
} from "maplibre-gl";
import {
  fetchBoundary,
  fetchSpatialSnapshot,
  type BoundaryLayer,
  type BoundaryProperties,
  type BoundaryResponse,
} from "./api.ts";
import { OVERLAY_BY_LAYER } from "./config.ts";
import { FIRST_DEVICE_LAYER } from "./devices.ts";
import { commas } from "./util.ts";

const CHOROPLETH_FILL = "choropleth-fill";

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
  private regionClickHandler:
    | ((layer: BoundaryLayer, regionName: string) => void)
    | null = null;

  constructor(
    private readonly map: MLMap,
    private readonly legendEl: HTMLElement,
  ) {}

  /**
   * Direct-manipulation filtering: clicking a visible region polygon reports
   * (layer, region_name) so main.ts can toggle it in the area filter. A
   * single map-wide handler (rather than per-layer ones) so a click that
   * lands on stacked polygons resolves to just the topmost region, and so
   * clicks that hit a device dot or cluster are left to the device popup —
   * `blockedBy` lists those layer ids.
   */
  enableRegionClicks(
    handler: (layer: BoundaryLayer, regionName: string) => void,
    blockedBy: string[],
  ): void {
    this.regionClickHandler = handler;
    this.map.on("click", (e) => {
      if (!this.regionClickHandler) return;
      const blockers = blockedBy.filter((id) => this.map.getLayer(id));
      if (
        blockers.length &&
        this.map.queryRenderedFeatures(e.point, { layers: blockers }).length
      ) {
        return;
      }
      const candidates: string[] = [];
      if (this.choroplethLayer) candidates.push(CHOROPLETH_FILL);
      for (const layer of this.loaded) {
        if (
          this.map.getLayoutProperty(fillId(layer), "visibility") === "visible"
        ) {
          candidates.push(fillId(layer));
        }
      }
      if (!candidates.length) return;
      const top = this.map.queryRenderedFeatures(e.point, {
        layers: candidates,
      })[0];
      if (!top) return;
      const layer =
        top.layer.id === CHOROPLETH_FILL
          ? this.choroplethLayer
          : (top.layer.id.replace(/^bnd-/, "").replace(/-fill$/, "") as BoundaryLayer);
      const regionName = (top.properties as BoundaryProperties).region_name;
      if (!layer || !regionName) return;
      this.regionClickHandler(layer, regionName);
    });
  }

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
   * Emphasize a specific set of region_names in the overlay. Pass null to
   * clear (every region back to normal). Selected regions get the outline
   * and full-strength fill; the rest are dimmed rather than removed so they
   * stay clickable for the map-click add/remove interaction — hiding them
   * would make it impossible to click a second region into the filter.
   */
  async setSubset(
    layer: BoundaryLayer,
    regionNames: string[] | null,
  ): Promise<void> {
    await this.ensureLayer(layer);
    const lineFilter: FilterSpecification | null =
      regionNames === null
        ? null
        : ["in", ["get", "region_name"], ["literal", regionNames]];
    this.map.setFilter(lineId(layer), lineFilter);
    this.map.setFilter(fillId(layer), null);
    const fillOpacity: maplibregl.ExpressionSpecification | number =
      regionNames === null
        ? 0.12
        : [
            "case",
            ["in", ["get", "region_name"], ["literal", regionNames]],
            0.18,
            0.04,
          ];
    this.map.setPaintProperty(fillId(layer), "fill-opacity", fillOpacity);
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

}
