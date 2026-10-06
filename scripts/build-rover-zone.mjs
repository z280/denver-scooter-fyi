// Build `public/rover-zone.geojson` — the area a Rover trip may start or end in.
//
// WHERE THE BOUNDARY COMES FROM. Veo publishes no `geofencing_zones` feed
// (re-checked 2026-10-06: `system_information` 200, `geofencing_zones` 404,
// `system_regions` 404) and every non-GBFS path on their API answers "No Token
// specified", so the polygon is not available to read. It was instead SPECIFIED
// as a sequence of street intersections, read off Veo's own in-app map:
//
//     Broadway & Blake  ->  Broadway & Colfax  ->  Colfax & 14th
//     ->  14th & Wynkoop  ->  Wynkoop & 19th  ->  19th & Blake  ->  close
//
// So the zone is six streets: Broadway on the east, Colfax across the south,
// 14th up the south-west, Wynkoop along the north-west, a short hop down 19th,
// and Blake all the way north-east back to Broadway. That last pair is what
// puts Coors Field OUTSIDE — the field sits north-west of Blake, in the notch
// 19th cuts out — and it is the detail that most distinguishes this from
// "downtown" as a human would draw it.
//
// HOW THE COORDINATES WERE DERIVED, because "Broadway & Blake" is not a number.
// Each street was fitted as a line through intersection POIs returned by the
// app's own geocoder (Photon, via /api/v1/geocode/search), and the corners are
// where those lines cross:
//
//   Blake      4 points: & 14th, & 19th, & 22nd, & Park Ave West
//   14th       2 points: & Blake, & Court Place
//   Broadway   2 points: & Colfax, 1670 Broadway (& 17th Ave)
//   Wynkoop    1 point:  & 15th, held parallel to Blake
//   19th       1 point:  & Blake, held parallel to 14th
//   Colfax     due east-west through Broadway & Colfax
//
// The two fitted bearings come out 89.4 degrees apart, which is the check that
// matters: downtown Denver's grid is square, so a fit that was not would mean a
// bad anchor. One anchor WAS bad and is not used — the geocoder's "Larimer
// Street & 14th Street" POI sits ~20 degrees off the line through the other
// two, so it was discarded rather than averaged in.
//
// WHAT IS LEFT UNCERTAIN: which side of each street the operator's line runs,
// and the ~20-30 m width of the streets themselves. `src/rover-zone.ts` carries
// that as a margin and stops short of ruling on a trip either way.
//
// RE-RUN: node scripts/build-rover-zone.mjs

import { writeFileSync } from "node:fs";

/** The six corners, in order, each the crossing of two named streets.
 *
 *  Kept as a labelled list rather than a bare ring so the file reads as the
 *  specification it is: anybody checking this is checking street names, not
 *  decimals. */
const CORNERS = [
  { at: "Broadway & Blake",  lon: -104.986392, lat: 39.759874 },
  { at: "Broadway & Colfax", lon: -104.986770, lat: 39.739946 },
  { at: "Colfax & 14th",     lon: -104.989670, lat: 39.739946 },
  { at: "14th & Wynkoop",    lon: -105.003129, lat: 39.750510 },
  { at: "Wynkoop & 19th",    lon: -104.997414, lat: 39.754699 },
  { at: "19th & Blake",      lon: -104.995500, lat: 39.753197 },
];

const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 85300;

const ring = [...CORNERS.map((c) => [c.lon, c.lat]), [CORNERS[0].lon, CORNERS[0].lat]];

/** Shoelace, in local metres. */
function areaKm2(r) {
  let s = 0;
  for (let i = 0; i < r.length - 1; i += 1) {
    s += r[i][0] * M_PER_DEG_LNG * (r[i + 1][1] * M_PER_DEG_LAT)
       - r[i + 1][0] * M_PER_DEG_LNG * (r[i][1] * M_PER_DEG_LAT);
  }
  return Math.abs(s) / 2 / 1e6;
}

/** Do any two non-adjacent edges cross?
 *
 *  The ring doubles back on itself at 19th — Wynkoop north-east, 19th
 *  south-east, then Blake north-east again — which is a legitimate notch and
 *  also exactly the shape a transcription slip turns into a bow-tie. A
 *  self-intersecting ring renders as nonsense and makes point-in-polygon
 *  answer at random, so it fails the build rather than shipping. */
function selfIntersects(r) {
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const orient = (p, q, s) =>
    sign((q[1] - p[1]) * (s[0] - q[0]) - (q[0] - p[0]) * (s[1] - q[1]));
  const n = r.length - 1;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing point
      const [a, b, c, d] = [r[i], r[i + 1], r[j], r[j + 1]];
      if (orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b)) {
        return [i, j];
      }
    }
  }
  return null;
}

const bad = selfIntersects(ring);
if (bad) {
  console.error(`ring self-intersects between edges ${bad[0]} and ${bad[1]} — check CORNERS order`);
  process.exit(1);
}

const area = areaKm2(ring);
// A sanity band, not a measurement. The specified zone is ~1.7 km2; an order of
// magnitude either way means a sign flip or a transposed lon/lat, which is the
// kind of mistake that still draws a plausible-looking polygon somewhere else.
if (area < 0.5 || area > 6) {
  console.error(`area ${area.toFixed(2)} km2 is outside the sane band — check CORNERS`);
  process.exit(1);
}

writeFileSync(
  "public/rover-zone.geojson",
  JSON.stringify({
    type: "FeatureCollection",
    // Carried in the file so anybody who opens it standalone reads where the
    // boundary came from before they read the coordinates.
    note:
      "Veo Rover service area. Specified as street intersections read off Veo's " +
      "in-app map: Broadway & Blake, Broadway & Colfax, Colfax & 14th, 14th & " +
      "Wynkoop, Wynkoop & 19th, 19th & Blake. Corners solved from geocoded " +
      "intersections; see scripts/build-rover-zone.mjs.",
    features: [
      {
        type: "Feature",
        properties: {
          zone: "rover_service_area",
          source: "veo_app_map",
          corners: CORNERS.map((c) => c.at).join(" -> "),
        },
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  }),
);
console.log(`wrote public/rover-zone.geojson — ${CORNERS.length} corners, ${area.toFixed(2)} km2`);
for (const c of CORNERS) console.log(`  ${c.at.padEnd(20)} ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`);
