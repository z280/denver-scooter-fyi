// Home and work pins on the main map, so a rider can see where they just
// dropped a point rather than trusting a pair of decimals in a drawer.
//
// Same shape as locate.ts's walk line: create the source and layer once,
// then only ever setData. Layers are never removed — the map outlives every
// panel that draws into it.

import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";

import { FIRST_DEVICE_LAYER } from "./devices.ts";
import { emptyFC } from "./util.ts";

const SRC = "home-work-pts";
const RING_LAYER = "home-work-pts-ring";
const DOT_LAYER = "home-work-pts-dot";
const LABEL_LAYER = "home-work-pts-label";

export interface HomeWorkPoints {
  home: { lat: number; lng: number } | null;
  work: { lat: number; lng: number } | null;
}

export interface HomeWorkPinsHandle {
  set(points: HomeWorkPoints): void;
  clear(): void;
}

function toFeatureCollection(points: HomeWorkPoints): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const push = (
    kind: "home" | "work",
    label: string,
    at: { lat: number; lng: number } | null,
  ): void => {
    if (!at) return;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [at.lng, at.lat] },
      properties: { kind, label },
    });
  };
  push("home", "Home", points.home);
  push("work", "Work", points.work);
  return { type: "FeatureCollection", features };
}

export function createHomeWorkPins(map: MLMap): HomeWorkPinsHandle {
  const ensureLayers = (): void => {
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data: emptyFC() });
    // Under the device pins: these are context, not the thing being chosen.
    const before = map.getLayer(FIRST_DEVICE_LAYER)
      ? FIRST_DEVICE_LAYER
      : undefined;
    map.addLayer(
      {
        id: RING_LAYER,
        type: "circle",
        source: SRC,
        paint: {
          "circle-radius": 9,
          "circle-color": "#ffffff",
          "circle-opacity": 0.9,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0066ff",
        },
      },
      before,
    );
    map.addLayer(
      {
        id: DOT_LAYER,
        type: "circle",
        source: SRC,
        paint: { "circle-radius": 3.5, "circle-color": "#0066ff" },
      },
      before,
    );
    map.addLayer(
      {
        id: LABEL_LAYER,
        type: "symbol",
        source: SRC,
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#0066ff",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      },
      before,
    );
  };

  const write = (data: GeoJSON.FeatureCollection): void => {
    ensureLayers();
    (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(data);
  };

  return {
    set(points) {
      write(toFeatureCollection(points));
    },
    clear() {
      write(emptyFC());
    },
  };
}
