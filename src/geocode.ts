// Reverse geocoding for the parking-report Location field: turn a vehicle's
// lat/lng into a human street address.
//
// Uses OpenStreetMap's Nominatim (no API key, CORS-open). Volume is low — one
// lookup when a rider is standing at a scooter to file a parking report — and
// results are cached per ~1m-rounded coordinate, so this stays well within
// Nominatim's usage policy. The browser's Referer identifies the app, as the
// policy asks. Fails soft: returns null on any error, and callers fall back
// to raw coordinates.

const cache = new Map<string, string | null>();

function key(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`; // ~1 m
}

/** Best-effort street address for a point, or null. Cached. Never throws. */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  const k = key(lat, lng);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;

  let result: string | null = null;
  try {
    const url =
      "https://nominatim.openstreetmap.org/reverse?format=jsonv2" +
      `&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const d = (await res.json()) as {
        display_name?: string;
        address?: Record<string, string>;
      };
      const a = d.address ?? {};
      const line1 = [a.house_number, a.road].filter(Boolean).join(" ");
      const parts = [
        line1 || null,
        a.suburb || a.neighbourhood || a.city_district || null,
        a.city || a.town || a.village || null,
      ].filter((x): x is string => !!x);
      result = parts.length ? parts.join(", ") : (d.display_name ?? null);
    }
  } catch {
    result = null;
  }
  cache.set(k, result);
  return result;
}
