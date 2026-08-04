// Draws one locally-recorded ride track on the main map.
//
// Same shape as locate.ts's walk line: source and layer created once, then
// only setData; clearing writes an empty collection rather than removing the
// layer, because the map outlives every panel that draws into it.

import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";

import { emptyFC } from "./util.ts";

const SRC = "local-track-line";
const LINE_LAYER = "local-track-line-draw";
const ENDS_LAYER = "local-track-ends";

export interface TrackRouteHandle {
  /** Draw a path and (unless told otherwise) frame it. */
  show(coords: readonly [number, number][], opts?: { fit?: boolean }): void;
  clear(): void;
}

/** Bounds padding that keeps the drawn route out from under the open drawer:
 *  it sits on the right at desktop widths and covers most of a phone. */
function framePadding(): { top: number; bottom: number; left: number; right: number } {
  const narrow =
    typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches;
  return narrow
    ? { top: 80, bottom: 320, left: 24, right: 24 }
    : { top: 80, bottom: 60, left: 40, right: 340 };
}

export function createTrackRoute(map: MLMap): TrackRouteHandle {
  const ensureLayers = (): void => {
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data: emptyFC() });
    // Above the device pins: this is the thing the rider asked to look at.
    map.addLayer({
      id: LINE_LAYER,
      type: "line",
      source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#0072b2",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 16, 5],
        "line-opacity": 0.9,
      },
    });
    map.addLayer({
      id: ENDS_LAYER,
      type: "circle",
      source: SRC,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5,
        "circle-color": ["match", ["get", "end"], "start", "#238636", "#c62828"],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
  };

  const write = (data: GeoJSON.FeatureCollection): void => {
    ensureLayers();
    (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(data);
  };

  return {
    show(coords, opts = {}) {
      if (coords.length === 0) {
        write(emptyFC());
        return;
      }
      const features: GeoJSON.Feature[] = [];
      // A LineString needs two or more positions (RFC 7946 §3.1.4), so a
      // ride with a single fix has no line to draw — emitting a one-position
      // one would be invalid source data, which MapLibre may reject outright
      // and take the start marker down with it. The point is the whole story
      // in that case: this is where the ride was, and it never moved.
      if (coords.length > 1) {
        features.push({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: coords as [number, number][],
          },
          properties: {},
        });
      }
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: coords[0] },
        properties: { end: "start" },
      });
      // …and with no line there is no distinct finish to mark either.
      if (coords.length > 1) {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords[coords.length - 1] },
          properties: { end: "finish" },
        });
      }
      write({ type: "FeatureCollection", features });

      if (opts.fit === false) return;
      let minLng = coords[0][0];
      let maxLng = coords[0][0];
      let minLat = coords[0][1];
      let maxLat = coords[0][1];
      for (const [lng, lat] of coords) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      try {
        map.fitBounds(
          [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
          { padding: framePadding(), maxZoom: 16.5, duration: 500 },
        );
      } catch {
        /* a degenerate extent isn't worth failing the draw over */
      }
    },
    clear() {
      write(emptyFC());
    },
  };
}
