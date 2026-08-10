// Screen 4's route choices, drawn on the MAIN map — the picture behind the
// route-selection bottom sheet.
//
// Built in ride-route-line.ts's image (source + layers created once, then
// only setData — the map outlives every wizard), but deliberately its own
// source: the route line (where the ride WILL go, drawn for the whole ride)
// and this preview (the candidate being weighed, alive only while Screen 4
// is up) have different lifetimes, and sharing a source would let one
// wipe the other. The preview draws SOLID in the profile's Screen 4 color —
// unlike ride-route-line.ts's dashes, there is no trail on screen yet for a
// solid line to be confused with.
//
// `set` also frames the shape: the sheet covers the bottom half of the
// viewport, so fitBounds pads the bottom by a bit more than half the map's
// height — the route lands in the visible strip above the drawer instead of
// underneath it.

import type {
  GeoJSONSource,
  LngLatBoundsLike,
  Map as MLMap,
} from "maplibre-gl";

import { emptyFC } from "./util.ts";

const SRC = "ride-route-preview";
const CASING_LAYER = "ride-route-preview-casing";
const LINE_LAYER = "ride-route-preview-line";
const POINT_LAYER = "ride-route-preview-points";

/** Fraction of the map's height the bottom sheet covers, plus breathing
 *  room — what fitBounds pads the bottom by. Matches `.ride-modal--sheet
 *  .ride-modal__card`'s 50vh height. */
const SHEET_BOTTOM_FRACTION = 0.55;

export interface RoutePreviewHandle {
  /** Replace the drawn preview. Line features carry their paint color in
   *  `properties.color` (the profile's Screen 4 color); point features
   *  (origin/dest) carry theirs the same way. A non-null `bounds` also
   *  re-frames the view into the strip above the sheet. */
  set(fc: GeoJSON.FeatureCollection, bounds: LngLatBoundsLike | null): void;
  /** Wipe the preview — the wizard moved on (or closed). */
  clear(): void;
}

export function createRoutePreview(map: MLMap): RoutePreviewHandle {
  const ensureLayers = (): void => {
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: CASING_LAYER,
      type: "line",
      source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 18, 11],
        "line-opacity": 0.9,
      },
    });
    map.addLayer({
      id: LINE_LAYER,
      type: "line",
      source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["coalesce", ["get", "color"], "#8a8f98"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 18, 7],
        "line-opacity": 0.95,
      },
    });
    map.addLayer({
      id: POINT_LAYER,
      type: "circle",
      source: SRC,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 6,
        "circle-color": ["coalesce", ["get", "color"], "#8a8f98"],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
  };

  return {
    set(fc, bounds) {
      ensureLayers();
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(fc);
      if (!bounds) return;
      try {
        map.fitBounds(bounds, {
          padding: {
            top: 64,
            left: 40,
            right: 40,
            bottom: Math.round(
              map.getContainer().clientHeight * SHEET_BOTTOM_FRACTION,
            ),
          },
          maxZoom: 16,
          duration: 350,
        });
      } catch (e) {
        // A degenerate (zero-area) bounds can throw in some MapLibre
        // builds — cosmetic, never fatal: the line is drawn either way.
        console.error("route preview fitBounds failed", e);
      }
    },
    clear() {
      if (!map.getSource(SRC)) return;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(emptyFC());
    },
  };
}
