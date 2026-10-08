// Reverse geocoding: turn a lat/lng into a short street address. Used by the
// parking-report Location field (devices.ts) and the Navigation tab's saved
// place rows (account-nav.ts).
//
// Goes through OUR API — GET /api/v1/geocode/reverse, via api.ts — not a
// third-party geocoder (owner directive 2026-10-08: the browser used to call
// OpenStreetMap's Nominatim directly). The rider's coordinates go only to
// scooter.fyi's own server.
//
// Cached per ~1 m-rounded coordinate, and in-flight lookups are shared, so a
// row that re-renders (the saved-place rows rebuild on every change) asks
// once, not every render. Fails soft: resolves null on any error and callers
// fall back to raw coordinates. "Nothing here" (404) and "out of range" (400)
// are answers and are cached; a transient failure (429, 503, offline) is
// remembered only briefly — for its Retry-After when the server sends one —
// so a burst of renders can't hammer a struggling API, but a later look
// still gets the address.

import { ApiError, fetchReverseGeocode, NoDataError, type ReverseGeocodeResponse } from "./api.ts";

/** How long a transient failure suppresses retries for that point. */
const FAILURE_TTL_MS = 60_000;
/** Bound on the cache — a session touches a handful of points, not thousands. */
const MAX_ENTRIES = 500;

interface Entry {
  value: Promise<string | null>;
  /** Epoch ms after which the entry may be retried; Infinity = keep. */
  until: number;
}
const cache = new Map<string, Entry>();

function key(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`; // ~1 m
}

/** The same label shape the Nominatim version produced: "1234 Larimer St,
 *  Neighbourhood, City", falling back to the server's own short label. */
export function formatAddress(d: ReverseGeocodeResponse): string | null {
  const line1 = [d.housenumber, d.street].filter(Boolean).join(" ");
  const parts = [line1 || null, d.locality || null, d.city || null].filter(
    (x): x is string => !!x,
  );
  return parts.length ? parts.join(", ") : (d.address || d.name || null);
}

/** Milliseconds until a transient failure may be retried, or null if the error is
 *  a definitive answer that should be cached for the session. */
function retryAfterMs(e: unknown): number | null {
  if (e instanceof NoDataError) return e.status === 404 ? null : FAILURE_TTL_MS;
  if (e instanceof ApiError) {
    if (e.status === 400) return null;
    if (e.status === 429 && e.retryAfter && e.retryAfter > 0) {
      return e.retryAfter * 1000;
    }
  }
  return FAILURE_TTL_MS;
}

/** Best-effort street address for a point, or null. Cached. Never throws. */
export function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  const k = key(lat, lng);
  const hit = cache.get(k);
  if (hit && Date.now() < hit.until) return hit.value;

  const entry: Entry = { value: Promise.resolve(null), until: Infinity };
  entry.value = fetchReverseGeocode(lat, lng)
    .then((d) => formatAddress(d))
    .catch((e: unknown) => {
      const ttl = retryAfterMs(e);
      if (ttl !== null) entry.until = Date.now() + ttl;
      return null;
    });
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(k, entry);
  return entry.value;
}

/** Test hook: forget every cached lookup. */
export function clearReverseGeocodeCache(): void {
  cache.clear();
}
