// Client-side plate resolution from Veo's PUBLIC GBFS feed.
//
// The vehicle plate (the number painted on the deck and encoded in the QR
// sticker) is not something we compute — Veo publishes it in
// free_bike_status, inside each entry's rental_uris deep link as
// `&number=<plate>`. Our own device_id is that feed's bike_id (see the
// backend ingest), so the browser can fetch the same public feed and recover
// the plate itself, keyed by data that is already public on both sides.
//
// Why this is privacy-neutral: our own API keeps emitting only the opaque
// HMAC identifier (a plate can't be reversed out of it). The plate here comes
// straight from Veo's feed, fetched by the client on demand — we are not the
// ones publishing it. Casual users of our API alone still see no plates.
//
// The plate is only ever needed at the scooter (unlock, parking report), and
// those already require a location fix, so the index is primed on the first
// GPS fix and read synchronously when a popup opens.

import { VEO_GBFS_FREE_BIKE_STATUS_URL } from "./config.ts";

/** How long a fetched index stays usable before prime() refetches. Matches
 *  the device-position refresh cadence — no point being fresher than the
 *  positions we join against. */
const TTL_MS = 90_000;

/** Minimum spacing between fetch ATTEMPTS. prime() is called on every GPS
 *  fix, so without this a down / CORS-closed feed (which never refreshes the
 *  index, so the TTL check can't throttle it) would be re-hit on every fix.
 *  On success the TTL takes over; this only paces the failure path. */
const ATTEMPT_COOLDOWN_MS = 30_000;

/** Pulls the plate out of a rental_uris deep link (`…?adj_t=…&number=1025543`).
 *  The `number` param is the only persistent per-vehicle id the GBFS spec
 *  permits for dockless fleets (bike_id itself may rotate per trip). */
const NUMBER_RE = /[?&]number=([^&]+)/;

interface GbfsBike {
  bike_id?: string | number;
  id?: string | number;
  rental_uris?: { android?: string; ios?: string; web?: string } | null;
}

export class GbfsPlates {
  /** bike_id → plate. bike_id is exactly our device_id, so lookups are a
   *  direct hit whenever Veo hasn't rotated the id since our last cycle
   *  (i.e. for every parked/available vehicle — the only ones a plate is
   *  ever wanted for). */
  private byBikeId = new Map<string, string>();
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private inflight: Promise<void> | null = null;

  private fresh(): boolean {
    return this.byBikeId.size > 0 && Date.now() - this.fetchedAt < TTL_MS;
  }

  /** Ensure a fresh index, fetching at most once concurrently. Safe to call
   *  often — a no-op while fresh. Never rejects: a failed/blocked fetch just
   *  leaves the previous index (or none), so callers degrade to "no plate". */
  prime(): Promise<void> {
    if (this.fresh()) return Promise.resolve();
    if (this.inflight) return this.inflight;
    // Throttle the failure path: a fetch that doesn't refresh the index
    // leaves fresh() false, so without this every subsequent GPS fix would
    // re-hit a down feed. (A success sets fetchedAt, so fresh() short-circuits
    // above long before this gate matters.)
    if (Date.now() - this.lastAttemptAt < ATTEMPT_COOLDOWN_MS) {
      return Promise.resolve();
    }
    this.lastAttemptAt = Date.now();
    this.inflight = this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    try {
      // No credentials — this is a public feed and we want it treated as a
      // simple cross-origin GET (no preflight, no cookies).
      const res = await fetch(VEO_GBFS_FREE_BIKE_STATUS_URL, {
        credentials: "omit",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { data?: { bikes?: GbfsBike[] } };
      const bikes = data?.data?.bikes ?? [];
      const idx = new Map<string, string>();
      for (const b of bikes) {
        const id = String(b.bike_id ?? b.id ?? "");
        const uri = b.rental_uris?.android || b.rental_uris?.ios || "";
        const m = NUMBER_RE.exec(uri);
        if (!id || !m) continue;
        let plate: string;
        try {
          plate = decodeURIComponent(m[1]);
        } catch {
          // One malformed %-sequence must not abort the whole index build —
          // skip just this vehicle (missing beats wrong).
          continue;
        }
        idx.set(id, plate);
      }
      if (idx.size > 0) {
        this.byBikeId = idx;
        this.fetchedAt = Date.now();
      }
    } catch {
      // Offline / CORS / parse error — keep whatever we had; the caller
      // simply won't get a plate this time.
    }
  }

  /** Synchronous plate lookup from the cached index, or null when unknown /
   *  not yet primed. Exact bike_id (== device_id) match ONLY — deliberately
   *  no position fallback: a nearest-neighbour guess could return the wrong
   *  scooter's plate for two racked side by side, and a wrong plate means
   *  unlocking or reporting the wrong vehicle. Missing beats wrong. Call
   *  prime() to populate the index. */
  cachedPlateFor(deviceId: string): string | null {
    return this.byBikeId.get(String(deviceId)) ?? null;
  }
}
