// The planned pathway, superimposed on the main map: the route the rider
// chose on Screen 4 (and is being guided along by ride-nav-hud.ts), drawn
// under the follow-cam for the whole ride.
//
// Before this module, turn-by-turn navigation was words-only: the Screen 7
// overlay showed the current maneuver and the directions list, but the map
// underneath never showed the line those instructions describe — the rider
// had to hold the whole shape in their head. This is the missing picture.
//
// Deliberately NOT ride-trail.ts, though it is built in its image: the trail
// is where the rider HAS BEEN (solid, extended fix by fix), this is where
// they SHOULD GO (the full planned shape, drawn once and replaced only by an
// off-route re-route). Different data, different lifetime, and a shared
// source would let one overwrite the other. Same construction rules as the
// trail and locate.ts's walk line otherwise: source and layers created once
// on first draw, then only setData — the map outlives every ride.
//
// The line renders in the chosen profile's Screen 4 color (colorForProfile),
// so the pathway the rider picked looks the same on the ride as it did on
// the chooser — but DASHED, over the same white casing the trail uses, so
// the planned path never reads as already-traveled even when the "safe"
// profile's blue matches the trail's. The destination gets a dot in Screen
// 4's dest-marker orange; there is no origin dot, because the rider's own
// follow-cam marker is already sitting on the live end of the route.
//
// Layer order: inserted BENEATH the trail's layers when they exist (the
// breadcrumb — and the rider dot riding its tip — draws over the plan, so
// the traveled portion visibly covers the planned one), which in practice
// they always do by the time this draws: enterRiding resets the trail
// (creating its layers) before renderRiding ever mounts the nav overlay.

import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";

import type { LngLatCoord } from "./polyline-encode.ts";
import { RIDE_TRAIL_CASING_LAYER } from "./ride-trail.ts";
import { emptyFC } from "./util.ts";

const SRC = "ride-route-active";
const CASING_LAYER = "ride-route-active-casing";
const LINE_LAYER = "ride-route-active-line";
const DEST_LAYER = "ride-route-active-dest";

/** Screen 4's dest-marker orange (ride-screen-routes.ts's POINTS_LAYER). */
const DEST_COLOR = "#D55E00";

export interface RideRouteLineHandle {
  /** Draw (or wholesale replace — an off-route re-route) the planned route.
   *  `color` is the chosen profile's Screen 4 color; `dest`, when given, is
   *  the destination `[lng, lat]` to mark with a dot. Fewer than two
   *  coordinates draws no line (RFC 7946 §3.1.4 — same rule the trail and
   *  track-route.ts spell out), though a dest dot still draws alone. */
  set(
    coords: readonly LngLatCoord[],
    opts: { color: string; dest?: readonly [number, number] | null },
  ): void;
  /** Show or hide WITHOUT forgetting — BRB hands the map back to Analysis /
   *  Find wheels with the ride (and its guidance) still running. */
  setVisible(visible: boolean): void;
  /** Wipe it off the map: guidance dismissed, or the ride is over. */
  clear(): void;
}

function routeFeatures(
  coords: readonly LngLatCoord[],
  dest: readonly [number, number] | null | undefined,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (coords.length > 1) {
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: coords.map((c) => [c[0], c[1]]),
      },
      properties: {},
    });
  }
  if (dest) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [dest[0], dest[1]] },
      properties: {},
    });
  }
  return { type: "FeatureCollection", features };
}

export function createRideRouteLine(map: MLMap): RideRouteLineHandle {
  let visible = true;

  const ensureLayers = (): void => {
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data: emptyFC() });
    // Under the trail when it exists (see the module header); appended on
    // top of everything else otherwise.
    const before = map.getLayer(RIDE_TRAIL_CASING_LAYER)
      ? RIDE_TRAIL_CASING_LAYER
      : undefined;
    // Same white casing rationale as the trail: the ride basemap is
    // whichever flavor the theme resolves to, pitched, with 3D extrusions
    // over it — a bare colored line loses against one of those.
    map.addLayer(
      {
        id: CASING_LAYER,
        type: "line",
        source: SRC,
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 18, 11],
          "line-opacity": 0.75,
        },
      },
      before,
    );
    map.addLayer(
      {
        id: LINE_LAYER,
        type: "line",
        source: SRC,
        filter: ["==", ["geometry-type"], "LineString"],
        // Round-capped dashes read as guidance dots — visibly NOT the solid
        // traveled breadcrumb, even when both are the same blue.
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": DEST_COLOR, // placeholder — set() applies the real one
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 18, 6],
          "line-opacity": 0.95,
          "line-dasharray": [0, 2],
        },
      },
      before,
    );
    map.addLayer(
      {
        id: DEST_LAYER,
        type: "circle",
        source: SRC,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 6,
          "circle-color": DEST_COLOR,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      },
      before,
    );
  };

  const applyVisibility = (): void => {
    for (const id of [CASING_LAYER, LINE_LAYER, DEST_LAYER]) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    }
  };

  const write = (data: GeoJSON.FeatureCollection): void => {
    ensureLayers();
    applyVisibility();
    (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(data);
  };

  return {
    set(coords, opts) {
      write(routeFeatures(coords, opts.dest));
      map.setPaintProperty(LINE_LAYER, "line-color", opts.color);
    },
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      // Only touch layers that exist — a ride that never had a route never
      // created them (same rule as the trail's setVisible).
      applyVisibility();
    },
    clear() {
      // No layer creation just to draw nothing: a route-less ride's clear()
      // calls (enterRiding, endRide) stay no-ops on the map.
      if (!map.getSource(SRC)) return;
      write(emptyFC());
    },
  };
}
