// The destination (and start point) a rider chose on the home bar, drawn on
// the map.
//
// WHY THIS EXISTS. Picking a point did nothing visible. You could tap the map
// to drop a pin, the app would take the coordinate and move on, and the map
// would look exactly as it did before — so the one interaction that has no
// address to confirm it was also the one with no confirmation at all. Same
// for a searched address: the bar said "1226 E 10th Ave" and the map said
// nothing, leaving "is that the right 1226?" unanswerable.
//
// Same shape as home-work-pins.ts's layer: create the source and layers once,
// then only ever setData. Layers are never removed — the map outlives every
// panel that draws into it.

import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";

import { emptyFC } from "./util.ts";

const SRC = "trip-pts";
const HALO_LAYER = "trip-pts-halo";
const PIN_LAYER = "trip-pts-pin";
const LABEL_LAYER = "trip-pts-label";

export interface TripPoint {
  label: string;
  lat: number;
  lon: number;
}

export interface TripPoints {
  dest: TripPoint | null;
  start: TripPoint | null;
}

export interface TripPinsHandle {
  set(points: TripPoints): void;
  clear(): void;
}

function toFeatureCollection(points: TripPoints): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const push = (kind: "dest" | "start", at: TripPoint | null): void => {
    if (!at) return;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [at.lon, at.lat] },
      // The label is the rider's own words for the place where they gave it
      // one ("Home", "The gazebo") and the address otherwise — the same
      // string the bar shows, so the map and the panel never disagree.
      properties: { kind, label: at.label },
    });
  };
  push("start", points.start);
  push("dest", points.dest);
  return { type: "FeatureCollection", features };
}

export function createTripPins(map: MLMap): TripPinsHandle {
  const ensureLayers = (): void => {
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data: emptyFC() });
    // Added with no `before`, so these land ON TOP of the device pins —
    // deliberately unlike home-work-pins.ts, which tucks itself underneath.
    // Home and work are context you happen to have saved; the destination is
    // the thing being chosen, and a scooter icon covering it would hide the
    // answer to the question the rider just asked.
    map.addLayer({
      id: HALO_LAYER,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": 16,
        "circle-color": ["case", ["==", ["get", "kind"], "dest"], "#e5484d", "#0066ff"],
        "circle-opacity": 0.16,
      },
    });

    map.addLayer({
      id: PIN_LAYER,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": 7,
        "circle-color": ["case", ["==", ["get", "kind"], "dest"], "#e5484d", "#0066ff"],
        "circle-stroke-width": 3,
        "circle-stroke-color": "#ffffff",
      },
    });

    map.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SRC,
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-offset": [0, 1.5],
        "text-anchor": "top",
        // Unlike the home/work labels, this one must never be dropped for
        // collision: it names the place the rider is going, and an unlabelled
        // red dot in a field of scooters is not a confirmation of anything.
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": ["case", ["==", ["get", "kind"], "dest"], "#c2282d", "#0066ff"],
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.8,
      },
    });
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
