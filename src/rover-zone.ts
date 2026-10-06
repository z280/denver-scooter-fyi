// Where a Rover trip is allowed to begin and end.
//
// THE RULE IS CERTAIN. THE LINE IS NOT. Keep those apart, because the whole
// design of this module turns on the difference.
//
// Veo restricts the Rover — the three-wheeled seated trike — to a downtown
// service area, and a Rover trip can only start or end inside it. That is a
// fact: it is drawn in Veo's own app, and `devices.ts`'s ROVER_AREA_WARNING
// has said so in words since before this file existed. A rider who walks to a
// Rover intending to ride it to Park Hill is going to have a bad afternoon,
// and nothing in the app was showing them that.
//
// What we do not have is Veo's polygon. They publish no `geofencing_zones`
// feed (re-checked 2026-10-06: `system_information` 200, `geofencing_zones`
// 404, `system_regions` 404), and every non-GBFS path on their API answers
// "No Token specified" — their geofence sits behind a rider's own account and
// is not ours to take. `scripts/build-rover-zone.mjs` draws Denver's official
// downtown (CBD + Union Station) as a stand-in and documents that choice.
//
// SO THIS MODULE IS BUILT AROUND NOT KNOWING, and that is not hedging — it is
// the only honest shape for the feature:
//
//   * It never says "you can end your trip here" or "you cannot". It says
//     where downtown is, that Rovers are downtown-only, and — when the answer
//     could plausibly go either way — that the Veo app is the thing that
//     decides.
//   * It warns on a MARGIN either side of the line rather than at the line.
//     Our stand-in and Veo's real edge can differ by a block or two, so a
//     verdict within that distance is reported as uncertain rather than
//     guessed. `UNCERTAIN_MARGIN_M` is where that is written down.
//   * The map layer is labelled approximate wherever it is drawn.
//
// The alternative — drawing a traced line and routing off it as though it were
// the operator's — is the confident wrong claim `micromobility-zones.ts`'s
// header refuses. The cost of being wrong here is somebody stranded with a
// vehicle they cannot end a trip on.

import type { Map as MLMap } from "maplibre-gl";

const SRC = "rover-zone";
const FILL = "rover-zone-fill";
const LINE = "rover-zone-line";

/** How far either side of our drawn line the answer is "ask Veo".
 *
 *  About one Denver downtown block. It is not a measurement — nothing could
 *  measure the gap between a line we have and a line we have never seen — it
 *  is a deliberate hedge, and the instinct is to make it generous, because a
 *  rider wrongly told to double-check loses ten seconds while a rider wrongly
 *  told they are fine loses their ride home.
 *
 *  BUT IT IS SIZED AGAINST THE ZONE, NOT PICKED. The zone is small, so a
 *  generous margin eats it: measured against the shipped polygon, 250 m
 *  leaves only 39% of downtown reading as a confident "inside", and 300 m
 *  leaves 29%. A caution that fires over most of downtown is one riders learn
 *  to swipe past, and then it is not protecting anybody — which is a worse
 *  failure than the one the wide margin was guarding against. At 150 m, 61%
 *  of the zone is a clean yes and the warning belongs to the edge, where the
 *  doubt actually is. */
export const UNCERTAIN_MARGIN_M = 150;

/** What we are willing to say about a point.
 *
 *  Four values, because "we don't know" splits into two genuinely different
 *  situations a rider needs told differently: close to the edge (ask Veo) and
 *  no zone data at all (we can't help). */
export type RoverVerdict =
  /** Comfortably inside our downtown stand-in. */
  | "inside"
  /** Comfortably outside it. */
  | "outside"
  /** Within `UNCERTAIN_MARGIN_M` of the line, either side. */
  | "near_edge"
  /** The zone file never loaded. */
  | "unknown";

export interface LngLatLike {
  lng: number;
  lat: number;
}

type Ring = number[][];
type Poly = Ring[];

let polygons: Poly[] | null = null;
let loadFailed = false;

/** Metres per degree at Denver's latitude. Equirectangular is wrong at
 *  continental scale and irrelevantly wrong across a few downtown blocks,
 *  which is the only distance this module ever measures. */
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 85_300; // cos(39.74°) × 111_320

/** Ray casting against one ring. Standard crossing count; the `(yi > y) !==
 *  (yj > y)` form handles a vertex exactly on the ray without double-counting
 *  it. */
function inRing(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the outer ring and outside every hole. These polygons are city
 *  neighbourhoods and may well carry one. */
function inPolygon(poly: Poly, lng: number, lat: number): boolean {
  if (poly.length === 0 || !inRing(poly[0], lng, lat)) return false;
  for (let h = 1; h < poly.length; h += 1) {
    if (inRing(poly[h], lng, lat)) return false;
  }
  return true;
}

/** Metres from a point to a segment, in local flat coordinates. */
function distToSegment(
  lng: number,
  lat: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const px = (lng - ax) * M_PER_DEG_LNG;
  const py = (lat - ay) * M_PER_DEG_LAT;
  const vx = (bx - ax) * M_PER_DEG_LNG;
  const vy = (by - ay) * M_PER_DEG_LAT;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(px, py);
  // Clamped projection: the nearest point on a SEGMENT, not on its infinite
  // line — without the clamp a point beyond an endpoint reads as nearer than
  // it is, which near a corner is exactly the case this has to get right.
  const t = Math.max(0, Math.min(1, (px * vx + py * vy) / len2));
  return Math.hypot(px - t * vx, py - t * vy);
}

/** Metres to the nearest boundary of any loaded polygon, whichever side the
 *  point is on. Infinity when there is no zone data. */
export function metersToZoneEdge(point: LngLatLike): number {
  if (!polygons || polygons.length === 0) return Infinity;
  let best = Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = distToSegment(
          point.lng,
          point.lat,
          ring[j][0],
          ring[j][1],
          ring[i][0],
          ring[i][1],
        );
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** The verdict. Pure once the data is loaded, so the margin rule is testable
 *  without a map. */
export function roverVerdict(point: LngLatLike | null): RoverVerdict {
  if (!polygons || polygons.length === 0) return "unknown";
  if (!point || !Number.isFinite(point.lng) || !Number.isFinite(point.lat)) {
    return "unknown";
  }
  if (metersToZoneEdge(point) <= UNCERTAIN_MARGIN_M) return "near_edge";
  return polygons.some((p) => inPolygon(p, point.lng, point.lat))
    ? "inside"
    : "outside";
}

/** What to tell a rider about a Rover and this place.
 *
 *  Every string here is about OUR drawing and Veo's rule as two separate
 *  things. None of them promises an outcome, because none of them can: the
 *  app that charges somebody is not this one.
 *
 *  `where` changes only the grammar — a destination is somewhere they are
 *  going, a vehicle is somewhere they are standing. */
export function roverZoneMessage(
  verdict: RoverVerdict,
  where: "destination" | "vehicle",
): string | null {
  switch (verdict) {
    case "inside":
      // Nothing to say. A correct, quiet answer is the one case where this
      // feature should be invisible.
      return null;
    case "outside":
      return where === "destination"
        ? "Rovers are downtown-only — this destination looks outside the area, so you probably can't end a Rover trip here. Check the Veo app before you ride."
        : "Rovers are downtown-only, and this one looks outside the area we have drawn. Veo's app is what decides.";
    case "near_edge":
      return where === "destination"
        ? "This is right on the edge of the downtown Rover area. Our outline is approximate — check the Veo app before you ride one here."
        : "This is right on the edge of the downtown Rover area, and our outline is approximate. Check the Veo app.";
    case "unknown":
      return where === "destination"
        ? "Rovers can only start and end downtown. We couldn't load the area outline — check the Veo app."
        : "Rovers can only start and end downtown. Check the Veo app for the exact area.";
  }
}

/** Load the zone once. Resolves either way: a missing file degrades the
 *  feature to the words-only warning the app already carried, which is a
 *  smaller loss than a map that will not finish loading. */
export async function loadRoverZone(
  base: string = import.meta.env.BASE_URL,
): Promise<boolean> {
  if (polygons !== null) return true;
  if (loadFailed) return false;
  try {
    const res = await fetch(`${base}rover-zone.geojson`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gj = (await res.json()) as {
      features?: { geometry?: { type?: string; coordinates?: Poly } }[];
    };
    const polys: Poly[] = [];
    for (const f of gj.features ?? []) {
      if (f.geometry?.type === "Polygon" && Array.isArray(f.geometry.coordinates)) {
        polys.push(f.geometry.coordinates);
      }
    }
    if (polys.length === 0) throw new Error("no polygons");
    polygons = polys;
    return true;
  } catch {
    loadFailed = true;
    return false;
  }
}

/** Tests only: the module caches the zone for the page's lifetime. */
export function __setRoverZoneForTests(polys: Poly[] | null): void {
  polygons = polys;
  loadFailed = false;
}

/** Draw it. Muted by default and under the devices, like every other area
 *  layer here — this is context a rider reads around the scooters, not
 *  instead of them. */
export async function ensureRoverZoneLayers(
  map: MLMap,
  /** Insert beneath this layer, so the zone sits under the scooters. Passed in
   *  rather than imported from `devices.ts`: the popup there now asks THIS
   *  module where a Rover stands, and importing back the other way would make
   *  a cycle whose symptoms (an undefined constant at module-init time, only
   *  under some bundler orders) are far worse than one argument. */
  beforeLayerId?: string,
): Promise<void> {
  if (!(await loadRoverZone())) return;
  if (!map.getSource(SRC)) {
    map.addSource(SRC, { type: "geojson", data: `${import.meta.env.BASE_URL}rover-zone.geojson` });
  }
  const before =
    beforeLayerId && map.getLayer(beforeLayerId) ? beforeLayerId : undefined;
  if (!map.getLayer(FILL)) {
    map.addLayer(
      {
        id: FILL,
        type: "fill",
        source: SRC,
        paint: { "fill-color": "#7e57c2", "fill-opacity": 0.1 },
      },
      before,
    );
  }
  if (!map.getLayer(LINE)) {
    map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        paint: {
          "line-color": "#7e57c2",
          "line-width": 2,
          // Dashed, deliberately. A solid boundary reads as authoritative, and
          // this one is our approximation of somebody else's line — the
          // dashes are the one piece of this that says so without copy.
          "line-dasharray": [2, 2],
          "line-opacity": 0.75,
        },
      },
      before,
    );
  }
}

export function setRoverZoneVisible(map: MLMap, visible: boolean): void {
  for (const id of [FILL, LINE]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}
