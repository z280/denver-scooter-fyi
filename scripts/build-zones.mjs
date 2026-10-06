// Build `public/micromobility-zones.geojson` from the DOTI CORA export.
//
// PROVENANCE. Denver Department of Transportation & Infrastructure, released
// in response to a Colorado Open Records Act request, received 2026-10-06 as
// twelve separate GeoJSON files. Each one is a single bare `Feature` (not a
// FeatureCollection) with an EMPTY `properties` object — the semantics live
// entirely in the filename. That is the whole reason this script exists: the
// classification below is a judgement made once, here, in the open, rather
// than re-derived from a filename at runtime.
//
// WHY A BUILD STEP AND NOT A RUNTIME MERGE. Twelve fetches for data that never
// changes between deploys would be twelve chances to half-load a rulebook. One
// file, built once, and the app either has the zones or it does not.
//
// RE-RUN: node scripts/build-zones.mjs <dir-of-exports>
//
// The source files are NOT committed — they are a 828 KB export whose useful
// content is this 12-feature file. Keep them with the CORA response.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Coordinate precision, in decimal places.
 *
 *  6 dp is ~11 cm at this latitude, which is finer than the zones themselves
 *  are surveyed and far finer than a phone's GPS. The export ships 15 dp
 *  (`-104.99772999999999`), which is float noise, not precision — dropping it
 *  is most of why the built file is a fraction of the input. */
const DP = 6;

/** filename fragment → what the zone actually is.
 *
 *  MATCHED IN ORDER, AND THE ORDER MATTERS. `non-public_school_land_area`
 *  CONTAINS `public_school_land_area`, so a substring match on the latter
 *  claims both files and the private-school set silently inherits the public
 *  label. (It did, on the first build.) The specific entry therefore precedes
 *  the general one, and `assertDistinct` below fails the build if a future
 *  export reintroduces an ambiguity rather than letting it ride.
 *
 *  `kind` is the rule. `label` is what a rider is told. `note` is what we do
 *  NOT know, and it is not optional: two of these classes carry a rule we are
 *  inferring from a filename, and the UI has to be able to say so.
 */
const CLASSES = [
  {
    match: "new_noride_alltime",
    kind: "no_ride",
    label: "No riding",
    note: "Riding is not permitted here at any time.",
  },
  {
    match: "new_npz_both_alltime",
    kind: "no_parking",
    label: "No parking",
    note: "You may ride through, but not end a ride here.",
  },
  {
    // Both rules at once, and the only zone in the pack that is. Kept as its
    // own kind rather than duplicated into two layers, so a rider is told both
    // things in one place instead of two overlapping polygons saying half each.
    match: "new_slow-npz_16thstreetmall",
    kind: "slow_no_parking",
    label: "Slow zone, no parking",
    venue: "16th Street Mall",
    note: "Speed is limited here and you may not end a ride.",
  },
  { match: "new_slow_ball", kind: "slow", label: "Slow zone", venue: "Ball Arena" },
  { match: "new_slow_coors", kind: "slow", label: "Slow zone", venue: "Coors Field" },
  { match: "new_slow_empower", kind: "slow", label: "Slow zone", venue: "Empower Field" },
  { match: "new_slow_mission", kind: "slow", label: "Slow zone", venue: "Mission Ballroom" },
  { match: "slow_millenniumbridge", kind: "slow", label: "Slow zone", venue: "Millennium Bridge" },
  {
    match: "larimer_square",
    kind: "slow",
    label: "Slow zone",
    venue: "Larimer Square",
  },
  {
    // A separate municipality entirely, enclosed by Denver. Veo's Denver
    // permit does not run here, which is a different fact from "the city drew
    // a line" — hence its own kind rather than being filed under no_ride.
    match: "mun_glendale",
    kind: "outside_denver",
    label: "Outside Denver",
    venue: "Glendale",
    note: "A separate city. Denver's rules — and this app's numbers — stop at this line.",
  },
  {
    // BEFORE the public entry — see the ordering note above.
    match: "non-public_school_land_area",
    kind: "school",
    label: "School land",
    venue: "Private schools",
    note: "School grounds. Restrictions here are likely but the hours are not in the city's export — treat as ride-with-care.",
  },
  {
    match: "public_school_land_area",
    kind: "school",
    label: "School land",
    venue: "Public schools",
    // THE HONEST NOTE. The export is "school land area 2025–2026": a parcel
    // set, not a rule. Denver restricts micromobility around schools, but the
    // hours and the restriction are not in this file, and inventing them
    // would be exactly the confident wrong claim the plan refuses elsewhere.
    note: "School grounds. Restrictions here are likely but the hours are not in the city's export — treat as ride-with-care.",
  },
];

function round(coords) {
  if (typeof coords[0] === "number") {
    return [Number(coords[0].toFixed(DP)), Number(coords[1].toFixed(DP))];
  }
  return coords.map(round);
}

/** Rings must close, and a ring needs 4 points to bound anything. The export
 *  passed both checks on 2026-10-06; this fails the build rather than shipping
 *  a rulebook with a hole in it if a later export does not. */
function assertSane(name, geometry) {
  const polys =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];
  for (const poly of polys) {
    for (const ring of poly) {
      if (ring.length < 4) throw new Error(`${name}: ring with ${ring.length} points`);
      const [ax, ay] = ring[0];
      const [bx, by] = ring[ring.length - 1];
      if (ax !== bx || ay !== by) throw new Error(`${name}: unclosed ring`);
    }
  }
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/build-zones.mjs <dir-of-exports>");
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".geojson"));
const features = [];
const unmatched = [];

for (const file of files.sort()) {
  const hits = CLASSES.filter((c) => file.includes(c.match));
  const spec = hits[0];
  if (!spec) {
    unmatched.push(file);
    continue;
  }
  // An ambiguous filename is only safe while the ordering above resolves it
  // deliberately. The one known case is non-public vs public schools, which
  // resolve to the SAME kind — so a future ambiguity that crosses kinds is a
  // misclassification waiting to happen, and fails the build instead.
  if (hits.length > 1 && new Set(hits.map((h) => h.kind)).size > 1) {
    throw new Error(
      `${file} matches ${hits.length} classes of different kinds: ` +
        hits.map((h) => `${h.match}→${h.kind}`).join(", "),
    );
  }
  const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const geometry = raw.type === "Feature" ? raw.geometry : raw;
  assertSane(file, geometry);
  features.push({
    type: "Feature",
    properties: {
      zone_kind: spec.kind,
      zone_label: spec.label,
      ...(spec.venue ? { zone_venue: spec.venue } : {}),
      ...(spec.note ? { zone_note: spec.note } : {}),
      source_file: file,
    },
    geometry: { type: geometry.type, coordinates: round(geometry.coordinates) },
  });
}

// An unclassified file is a new rule nobody has decided what to do with, and
// silently dropping it would put a zone on no map at all.
if (unmatched.length) {
  throw new Error(`unclassified export files: ${unmatched.join(", ")}`);
}

const out = {
  type: "FeatureCollection",
  name: "denver_micromobility_zones",
  // Carried in the data so the attribution cannot drift from the file it
  // describes, and so a stale build is visible rather than inferred.
  source: {
    agency: "Denver Department of Transportation & Infrastructure",
    obtained_via: "Colorado Open Records Act request",
    received: "2026-10-06",
  },
  features,
};

writeFileSync(
  "public/micromobility-zones.geojson",
  JSON.stringify(out) + "\n",
);
const counts = {};
for (const f of features) {
  counts[f.properties.zone_kind] = (counts[f.properties.zone_kind] ?? 0) + 1;
}
console.log(`wrote ${features.length} features from ${files.length} files`, counts);
