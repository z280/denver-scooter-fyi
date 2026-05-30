import maplibregl, { type Map, type GeoJSONSource } from "maplibre-gl";
import type { DevicesResponse, FormFactor } from "./api.ts";
import { DEVICE_COLORS } from "./config.ts";
import { emptyFC } from "./util.ts";
import { pointInAny, type IndexedFeature } from "./geo.ts";

export type DeviceFilter = "all" | "scooter" | "bicycle";
export type AreaFilter = IndexedFeature[] | null;

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

export class Devices {
  private all: DevicesResponse | null = null;
  private filter: DeviceFilter = "all";
  private areaFilter: AreaFilter = null;
  private popup: maplibregl.Popup | null = null;

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
        "circle-color": [
          "match",
          ["get", "form_factor"],
          "scooter",
          DEVICE_COLORS.scooter,
          "bicycle",
          DEVICE_COLORS.bicycle,
          DEVICE_COLORS.unknown,
        ],
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

    this.wireInteractions();
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
      const props = feature.properties as {
        device_id: string;
        form_factor: FormFactor;
      };
      const geom = feature.geometry as GeoJSON.Point;
      const label = FORM_LABEL[props.form_factor] ?? props.form_factor;
      const color =
        DEVICE_COLORS[props.form_factor as keyof typeof DEVICE_COLORS] ??
        DEVICE_COLORS.unknown;

      this.popup?.remove();
      this.popup = new maplibregl.Popup({ closeButton: true, offset: 10 })
        .setLngLat(geom.coordinates as [number, number])
        .setHTML(
          `<div class="device-popup">
             <span class="device-popup__badge" style="background:${color}">${label}</span>
             <dl class="device-popup__meta">
               <dt>Device ID</dt>
               <dd><code>${escapeHtml(props.device_id)}</code></dd>
             </dl>
           </div>`,
        )
        .addTo(map);
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
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
