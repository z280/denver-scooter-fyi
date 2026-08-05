// The live breadcrumb: the track being recorded RIGHT NOW, drawn on the map
// under the rider as they ride.
//
// This is the display half of Save Ride Tracks. The master plan's own copy for
// that option promises two things — "trace where you've been on the map
// display, AND also save waypoints of your location to your local device"
// (docs/RIDE_MODE_OVERHAUL_PLAN.md) — and only the second half existed:
// track-store.ts sealed every fix into IndexedDB, but nothing ever drew it, so
// the rider's own track was invisible until they opened the account drawer's
// Local Data tab after the ride.
//
// Deliberately NOT track-route.ts, which draws a FINISHED track from the Local
// Data tab: that handle owns its own source/layers, fits the camera to the
// whole path on every draw, and marks both ends. All three are wrong here —
// the ride-mode camera is the follow-cam (ride-hud.ts drives it fix by fix,
// and a fitBounds fighting it would yank the map around every second), there
// is no finish yet, and a shared source would mean the account panel and a
// live ride could overwrite each other's line. Same shape as track-route.ts
// and locate.ts's walk line otherwise: source and layers created once on first
// draw, then only setData — the map outlives every ride.

import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";

import { emptyFC } from "./util.ts";
import { decodeTrackBatch, type StoredTrackBatch } from "./track-store.ts";

const SRC = "ride-trail";
const CASING_LAYER = "ride-trail-casing";
const LINE_LAYER = "ride-trail-line";
const START_LAYER = "ride-trail-start";

/** GeoJSON order, matching everything else that draws on this map. */
export type TrailCoord = [number, number];

export interface RideTrailHandle {
  /** Begin (or restart) a trail, optionally seeded with coordinates already
   *  recorded — a resumed ride's sealed batches. */
  reset(coords?: readonly TrailCoord[]): void;
  /** Insert already-recorded coordinates BEFORE everything drawn so far. The
   *  seed for a resumed ride arrives asynchronously (reading it means reading
   *  IndexedDB), by which time a live fix or two may already have landed —
   *  and those are strictly newer than anything sealed, because the recorder
   *  rejects a non-advancing timestamp outright. */
  prepend(coords: readonly TrailCoord[]): void;
  /** Extend the trail by one just-recorded waypoint. */
  push(coord: TrailCoord): void;
  /** Show or hide the drawn trail WITHOUT forgetting it — BRB backgrounds the
   *  ride and hands the map back to Analysis / Find wheels, but the ride (and
   *  for a tracked ride, the recording) is still going. */
  setVisible(visible: boolean): void;
  /** Forget the trail and wipe it off the map: the ride is over. */
  clear(): void;
  /** What is currently drawn — for tests and for callers that need to know
   *  whether anything was recorded at all. */
  coords(): readonly TrailCoord[];
}

/** Flatten sealed batches to coordinates, in chain order.
 *
 *  A leaner cousin of account-local-data.ts's `flattenTrackBatches`, which
 *  also rebuilds per-point timestamps and a distance total for the Local Data
 *  tab's summary and GPX export. A live trail needs neither, and this way the
 *  ride-mode path doesn't drag the account panel (and its API client) in
 *  behind it. Same tolerance for a bad batch, and for the same reason: one
 *  undecodable batch should cost the rider that segment of line, not the
 *  whole trail. */
export function trailCoordsFromBatches(
  batches: readonly StoredTrackBatch[],
): TrailCoord[] {
  const coords: TrailCoord[] = [];
  for (const batch of [...batches].sort((a, b) => a.seq - b.seq)) {
    let payload;
    try {
      payload = decodeTrackBatch(batch.jws);
    } catch {
      continue;
    }
    for (const [, lat, lon] of payload.pts) {
      if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lon, lat]);
    }
  }
  return coords;
}

function trailFeatures(coords: readonly TrailCoord[]): GeoJSON.FeatureCollection {
  if (coords.length === 0) return emptyFC();
  const features: GeoJSON.Feature[] = [];
  // A LineString needs two or more positions (RFC 7946 §3.1.4) — the first
  // fix of a ride has no line yet, only a start. Same rule track-route.ts
  // spells out: emitting a one-position LineString is invalid source data
  // MapLibre may reject outright, taking the start marker down with it.
  if (coords.length > 1) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords as TrailCoord[] },
      properties: {},
    });
  }
  // Where the ride started, and nothing else. The live end of the trail is
  // already marked — by the rider's own follow-cam dot sitting on it.
  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: coords[0] },
    properties: {},
  });
  return { type: "FeatureCollection", features };
}

export function createRideTrail(map: MLMap): RideTrailHandle {
  let coords: TrailCoord[] = [];
  let visible = true;

  const ensureLayers = (): void => {
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data: emptyFC() });
    // White casing under the line: the ride basemap is whatever flavor the
    // theme resolves to (and the HUD's ☀/☾ can flip it mid-ride), it is
    // pitched, and 3D building extrusions are raised over it — a bare line
    // in any single color loses against one of those. The casing is what
    // makes it read on all of them, in bright Colorado sun.
    map.addLayer({
      id: CASING_LAYER,
      type: "line",
      source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 18, 11],
        "line-opacity": 0.85,
      },
    });
    // Same blue as the rider's own dot (.ride-user-dot): the trail is
    // literally where that dot has been.
    map.addLayer({
      id: LINE_LAYER,
      type: "line",
      source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#0072b2",
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 18, 6],
        "line-opacity": 0.95,
      },
    });
    map.addLayer({
      id: START_LAYER,
      type: "circle",
      source: SRC,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#238636",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
  };

  const applyVisibility = (): void => {
    for (const id of [CASING_LAYER, LINE_LAYER, START_LAYER]) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    }
  };

  const draw = (): void => {
    ensureLayers();
    applyVisibility();
    (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(
      trailFeatures(coords),
    );
  };

  return {
    reset(seed = []) {
      coords = [...seed];
      draw();
    },
    prepend(head) {
      if (head.length === 0) return;
      coords = [...head, ...coords];
      draw();
    },
    push(coord) {
      coords.push(coord);
      draw();
    },
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      // Only touch layers that exist: a ride that never recorded a fix never
      // created them, and hiding nothing is not worth building a map layer
      // for.
      applyVisibility();
    },
    clear() {
      coords = [];
      draw();
    },
    coords() {
      return coords;
    },
  };
}
