// Where a Rover trip is allowed to begin and end.
//
// Veo restricts the Rover — the three-wheeled seated trike — to a downtown
// service area, and a Rover trip can only start or end inside it. A rider who
// walks to a Rover intending to ride it to Park Hill is going to have a bad
// afternoon, and until this existed nothing in the app showed them where the
// area was.
//
// THE BOUNDARY. Veo publishes no `geofencing_zones` feed (re-checked
// 2026-10-06: `system_information` 200, `geofencing_zones` 404,
// `system_regions` 404) and every non-GBFS path on their API answers "No Token
// specified", so their polygon cannot be read. It was instead specified as six
// street intersections off Veo's own in-app map — Broadway & Blake, Broadway &
// Colfax, Colfax & 14th, 14th & Wynkoop, Wynkoop & 19th, 19th & Blake — and
// `scripts/build-rover-zone.mjs` records how those names became coordinates.
//
// So the zone is six streets: Broadway east, Colfax south, 14th up the
// south-west, Wynkoop north-west, a short hop down 19th, and Blake north-east
// back to Broadway. The 19th/Blake pair cuts a notch that puts Coors Field
// outside, which is the bit a human drawing "downtown" freehand gets wrong.
//
// WHAT IS STILL UNCERTAIN, AND WHY THERE IS A MARGIN AT ALL. The streets are
// named; which side of each one the operator's line runs is not, and a street
// is 20-30 m wide. `UNCERTAIN_MARGIN_M` is that doubt, and near the line this
// module still points at the Veo app rather than ruling — because the app that
// charges somebody is not this one, and the cost of being wrong is a rider
// stranded on a vehicle they cannot end a trip on.
//
// So it never says "you can end your trip here" or "you cannot". It says where
// the area is, that Rovers are downtown-only, and — close to the edge — that
// Veo decides.

import type { Map as MLMap } from "maplibre-gl";

const SRC = "rover-zone";
const FILL = "rover-zone-fill";
const LINE = "rover-zone-line";

/** TEAL, AND NOT THE PURPLE IT USED TO BE.
 *
 *  It was `#7e57c2`, a lighter shade of the Equity Area's `#6a1b9a`. Two
 *  purple washes over the same downtown blocks were already hard to tell
 *  apart, and the Equity Area now draws at FULL strength by default, so the
 *  one the rider is most likely to be looking at is the one that lost the
 *  argument. Teal collides with nothing else on this map: the city's rule
 *  zones are red, orange, yellow and grey, and the Equity Area is purple.
 *
 *  It also says something true. The rule zones are warnings, which is what
 *  their red-to-yellow ramp means; the Rover area is not a warning at all,
 *  it is where a thing is ALLOWED. A colour outside that ramp keeps it from
 *  being read as one more restriction. */
export const ROVER_ZONE_COLOR = "#00897b";

/** The two strengths, matching `micromobility-zones.ts` and `equity-map.ts`.
 *
 *  MUTED IS WHAT SHIPS, and it is the counterweight to the other two coming
 *  off mute. The Rover area is a fact about one vehicle in a fleet of
 *  thousands — three-wheeled, seated, a small minority of what is on the map
 *  — and it covers the whole of downtown. Drawn as loudly as the city's rules
 *  it would be the biggest thing on screen for the riders it least concerns.
 *
 *  `full` is not wired to a control yet; it exists so that adding the "Muted
 *  display" switch this section does not have — the other two do — is a
 *  matter of passing a boolean, not of inventing a second look under
 *  deadline. */
const PAINT = {
  muted: { fill: 0.06, line: 0.45, width: 1.4 },
  full: { fill: 0.14, line: 0.9, width: 2 },
} as const;

/** How far either side of the line the answer is "ask Veo".
 *
 *  About half a block — enough to cover the one thing the specification does
 *  not pin down: a street has two sides and is 20-30 m wide, so a point within
 *  spitting distance of Blake could be either side of wherever Veo actually
 *  drew it.
 *
 *  SIZED AGAINST THE ZONE, NOT PICKED. It was 150 m while the boundary was a
 *  guess at downtown; against this zone that would leave only 52% of it
 *  reading as a confident "inside", and a caution that fires over half of
 *  downtown is one riders learn to swipe past. At 40 m it is 86%, so the
 *  warning belongs to the kerb where the doubt actually lives. Measured, not
 *  estimated — see the test. */
export const UNCERTAIN_MARGIN_M = 40;

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
        ? "Rovers are downtown-only — this destination is outside the area, so you probably can't end a Rover trip here. Check the Veo app before you ride."
        : "Rovers are downtown-only, and this one is parked outside the area. Veo's app is what decides.";
    case "near_edge":
      return where === "destination"
        ? "This is right on the edge of the downtown Rover area — within a few metres of the boundary. Check the Veo app before you ride one here."
        : "This is right on the edge of the downtown Rover area. Check the Veo app.";
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
        paint: {
          "fill-color": ROVER_ZONE_COLOR,
          "fill-opacity": PAINT.muted.fill,
        },
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
          "line-color": ROVER_ZONE_COLOR,
          "line-width": PAINT.muted.width,
          // Solid now. It was dashed while the outline was our own guess at
          // downtown; the boundary is specified from Veo's map these days, so
          // drawing it tentatively would understate what we know. The residual
          // doubt — which side of each street — lives in the margin and the
          // copy, which is where a 20 m question belongs.
          //
          // Muted carries the LINE and lets the fill go: the outline is where
          // the useful information is, and the wash only says which side you
          // are on.
          "line-opacity": PAINT.muted.line,
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
