// Precision-5 Google Encoded Polyline Algorithm Format — the format
// `POST /api/v1/ride-routes` stores (`route_polyline`) and the API's own
// `src/polyline.py` `decode()` (scooter-fyi-api repo) expects. `GET /route`
// returns GeoJSON `[lng, lat]` coordinate pairs (RFC 7946 order); this format
// encodes LATITUDE FIRST per Google's spec, so the swap happens here, once,
// rather than at every call site.
//
// Pure and dependency-free — byte-for-byte the standard algorithm used by
// Google Maps, Valhalla, OSRM, and every other implementation that speaks
// this format (https://developers.google.com/maps/documentation/utilities/polylinealgorithm).
// `src/` had no encoder before this (frontend plan, `ride-screen-routes.ts`
// row); this is deliberately the smallest module that could satisfy that:
// one pure function, no decoder (the server owns decoding — the test file
// implements a small mirror decoder purely to check round-trips, since a
// decoder has no product use here).

/** `[lng, lat]` — GeoJSON coordinate order, matching `RouteResponse`'s
 *  `geometry.coordinates` (a `GeoJSON.Position[]`, sliced to the pair this
 *  format needs). */
export type LngLatCoord = readonly [number, number];

/** The format's own default, and what the API stores — see the module doc. */
export const DEFAULT_POLYLINE_PRECISION = 5;

/** Zigzag-encode a signed delta into the format's base-64-ish unsigned
 *  varint alphabet: shift left one bit (inverting negatives) so the
 *  low-order bit carries the sign, then chunk 5 bits at a time, continuation
 *  bit set on every chunk but the last, +63 offset into printable ASCII. */
function encodeSignedNumber(num: number): string {
  let zigzag = num << 1;
  if (num < 0) zigzag = ~zigzag;
  return encodeUnsignedNumber(zigzag);
}

function encodeUnsignedNumber(num: number): string {
  let out = "";
  while (num >= 0x20) {
    out += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
    num >>= 5;
  }
  out += String.fromCharCode(num + 63);
  return out;
}

/** Encode a line as a precision-`precision` Google polyline (default 5 — the
 *  API's stored format; `src/polyline.py`'s decoder is precision-5 only, so
 *  callers posting to `/ride-routes` must not pass anything else). `coords`
 *  are `[lng, lat]` pairs (GeoJSON order, e.g. `RouteResponse.geometry.
 *  coordinates`); each is rounded to `precision` decimal digits and
 *  delta-encoded against the previous point, LATITUDE FIRST per the spec.
 *
 *  Throws on a non-finite coordinate rather than silently emitting a corrupt
 *  string — this output gets POSTed and stored server-side, so a stray
 *  `NaN`/`Infinity` (a botched geocode, an empty route) must fail loudly
 *  here, not travel as a plausible-looking string. */
export function encodePolyline(
  coords: readonly LngLatCoord[],
  precision: number = DEFAULT_POLYLINE_PRECISION,
): string {
  const factor = Math.pow(10, precision);
  let out = "";
  let prevLat = 0;
  let prevLng = 0;
  for (const [lng, lat] of coords) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new RangeError(
        `encodePolyline: non-finite coordinate [${lng}, ${lat}]`,
      );
    }
    const lat5 = Math.round(lat * factor);
    const lng5 = Math.round(lng * factor);
    out += encodeSignedNumber(lat5 - prevLat);
    out += encodeSignedNumber(lng5 - prevLng);
    prevLat = lat5;
    prevLng = lng5;
  }
  return out;
}
