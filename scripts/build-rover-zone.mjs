// Build `public/rover-zone.geojson` — the area a Rover trip may start or end in.
//
// READ THIS BEFORE CHANGING THE GEOMETRY. THIS IS NOT VEO'S GEOFENCE.
//
// Veo restricts the Rover (the three-wheeled seated trike) to a downtown
// service area: a Rover trip can only begin or end inside it. That restriction
// is a fact — it is drawn in Veo's own app, and `devices.ts`'s
// ROVER_AREA_WARNING has stated it in words since before this file existed.
//
// What we do NOT have is the line. Veo publishes no `geofencing_zones` feed
// (re-checked 2026-10-06: `system_information` 200, `geofencing_zones` 404,
// `system_regions` 404), and every non-GBFS path on their API answers "No
// Token specified" — the polygon lives behind a rider's account and is not
// ours to take. A Colorado Open Records Act request to DOTI is the route that
// produced `micromobility-zones.geojson`, and it is the route that would
// produce this one properly.
//
// So this file draws DENVER'S OWN DOWNTOWN instead, and says so everywhere a
// rider can see it. The geometry is the union of two official city
// neighbourhood polygons — Central Business District and Union Station — taken
// from the same `NB.geojson` the API serves its neighbourhood boundaries from.
// Those two were chosen because their edges ARE the edges in Veo's app: the
// CBD polygon's east side is Broadway and its south side is Colfax, which is
// exactly where the operator's zone stops, and Union Station covers the LoDo
// side.
//
// IT IS A STAND-IN, AND THE APP NEVER PRETENDS OTHERWISE. `rover-zone.ts`
// labels it approximate, warns on a margin either side of the line rather than
// at the line, and never tells a rider they may or may not end a trip
// somewhere — it tells them to check the Veo app when they are anywhere near
// the edge. `micromobility-zones.ts`'s header states the standing rule this
// obeys: "a boundary we cannot source is exactly the confident wrong claim
// this codebase refuses elsewhere." The boundary here IS sourced — to the
// city's downtown, which is a different thing from Veo's zone, and the
// difference is published rather than hidden.
//
// WHEN THE REAL POLYGON ARRIVES, replace this script's INPUT and delete the
// approximation copy. Nothing else has to change: the app reads one file.
//
// RE-RUN: node scripts/build-rover-zone.mjs <path-to-NB.geojson>

import { readFileSync, writeFileSync } from "node:fs";

import polygonClipping from "polygon-clipping";

/** 6 dp is ~11 cm here — far finer than an approximation deserves, but it is
 *  the city's own geometry and rounding it would be inventing a second
 *  inaccuracy on top of the one we have already declared. */
const PRECISION = 6;

/** The two official neighbourhoods whose union stands in for the zone.
 *
 *  Named rather than computed: which neighbourhoods approximate an operator's
 *  service area is a judgement, and it belongs in the open where somebody can
 *  disagree with it. */
const NEIGHBORHOODS = ["CBD", "Union Station"];

function round(coords) {
  if (typeof coords[0] === "number") {
    return coords.map((n) => Number(n.toFixed(PRECISION)));
  }
  return coords.map(round);
}

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/build-rover-zone.mjs <path-to-NB.geojson>");
  process.exit(1);
}

const nb = JSON.parse(readFileSync(src, "utf8"));
const rings = [];
for (const name of NEIGHBORHOODS) {
  const found = nb.features.filter((f) => f.properties?.NBHD_NAME === name);
  // A rename upstream must fail the build rather than silently shrink the
  // zone. A zone that quietly loses half its area would tell riders their
  // trip cannot end somewhere it can.
  if (found.length !== 1) {
    console.error(
      `expected exactly one "${name}" in ${src}, found ${found.length}`,
    );
    process.exit(1);
  }
  const f = found[0];
  if (f.geometry.type !== "Polygon") {
    console.error(`"${name}" is a ${f.geometry.type}; expected Polygon`);
    process.exit(1);
  }
  rings.push(f.geometry.coordinates);
}

// DISSOLVE THE SHARED BORDER. The two neighbourhoods meet along Market/Larimer,
// and drawing them as separate polygons put a dashed line straight through the
// middle of the zone — which reads as two areas with a boundary between them,
// when the whole point is that it is one area a Rover may move around inside.
// Caught by looking at the rendered map; no unit test would have noticed,
// because both polygons were individually correct.
const unioned = polygonClipping.union(...rings.map((r) => [r]));
const features = unioned.map((poly) => ({
  type: "Feature",
  properties: {
    zone: "rover_service_area",
    approximate: true,
    source: "denver_neighborhoods",
    neighborhoods: NEIGHBORHOODS.join(" + "),
  },
  geometry: { type: "Polygon", coordinates: round(poly) },
}));

// One piece. Two would mean the neighbourhoods do not actually touch, which
// would make the whole stand-in the wrong shape and must not ship quietly.
if (features.length !== 1) {
  console.error(
    `expected the union to be one polygon, got ${features.length} — ` +
      `do ${NEIGHBORHOODS.join(" and ")} still share a border?`,
  );
  process.exit(1);
}

const out = {
  type: "FeatureCollection",
  // Carried in the file itself so anybody who opens it standalone — a
  // reviewer, a future contributor, somebody who found it in a browser's
  // network tab — reads the caveat before they read the coordinates.
  note:
    "APPROXIMATE. Denver's official CBD + Union Station neighbourhood polygons, " +
    "used as a stand-in for Veo's Rover service area, which Veo does not publish. " +
    "Not Veo's geofence. See scripts/build-rover-zone.mjs.",
  features,
};

writeFileSync("public/rover-zone.geojson", JSON.stringify(out));
const pts = features.reduce(
  (n, f) => n + f.geometry.coordinates.reduce((m, r) => m + r.length, 0),
  0,
);
console.log(`wrote public/rover-zone.geojson — ${features.length} polygons, ${pts} points`);
