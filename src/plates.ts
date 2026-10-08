// Vehicle plates, from OUR API — never from Veo's feed in the rider's browser.
//
// The plate (the number painted on the deck and encoded in the QR sticker) is
// what the "Open in Veo" deep link, the parking/device-report prefill and the
// ride wizard need. It used to be recovered here by having the BROWSER fetch
// Veo's public GBFS feed, which handed Veo every rider's IP address on every
// first GPS fix. Owner decision 2026-10-08: no direct-to-Veo background pulls
// from riders' browsers. (User-initiated navigation — the Open-in-Veo deep
// link, the Adjust bounce, the Zendesk form — is unchanged: the rider chose to
// go there.)
//
// Two endpoints replace it (scooter-fyi-api #134):
//
//  * `GET /api/v1/vehicles/plates?device_ids=a,b,c` — FORWARD (device → plate).
//    Signed-in riders only (bearer). 1–50 ids per call; unknown or plateless
//    ids are simply omitted. Limited to 60 req/min per account, 120/min per IP.
//    `PlateIndex` below is the only caller: it asks for ONE BATCH OF NEARBY
//    VEHICLES at a time (the ~50 nearest the rider's fix, the popup's own
//    device, the ride wizard's candidates), caches the answers for the ingest
//    cadence, and never asks while signed out. A guest never sees a plate the
//    API served; the flows that want one degrade to "type the plate on the
//    deck", exactly as they did when the feed was down.
//
//  * `GET /api/v1/vehicles/resolve?plate=<plate>` — REVERSE (plate → device).
//    Public, 30 req/min per IP. Public because it reveals no plate: the caller
//    already holds the plate (it is reading it off a sticker, a link, or the
//    deck), and gets back only the ids our public feed already publishes.
//    `resolvePlate` below is the only caller — the QR scan, `?ride=plate:`
//    links and the ride wizard's typed-plate check.
//
// Both answers are `Cache-Control: private, no-store`; the caching here is
// in-memory for this page only, and sign-out drops every forward answer.

import {
  ApiError,
  NoDataError,
  fetchVehiclePlates,
  resolveVehiclePlate,
} from "./api.ts";
import { getAuth } from "./map-auth.js";
import { distanceMeters, type LngLat } from "./locate.ts";

// ---------------------------------------------------------------------------
// Shared plate normalization
// ---------------------------------------------------------------------------

/** Plate comparison form: trimmed, uppercased, inner whitespace and hyphens
 *  dropped — the same normalization the API applies server-side to
 *  `/vehicles/resolve`. Veo plates are all-digit today; this keeps a
 *  hand-typed `10-255 43` matching `1025543`. (Re-exported by ride-deeplink.ts,
 *  where it used to live.) */
export function normalizePlate(raw: string): string {
  return (raw || "").trim().toUpperCase().replace(/[\s-]+/g, "");
}

// ---------------------------------------------------------------------------
// Forward: device_id → plate (signed-in only)
// ---------------------------------------------------------------------------

/** The API's per-request cap on `device_ids`. */
export const MAX_PLATE_BATCH = 50;
/** The API rejects longer ids (422); never send one. */
export const MAX_DEVICE_ID_LEN = 64;
/** How long an answer (plate OR "no plate") counts as fresh. Matches the
 *  backend ingest cadence — asking more often cannot get a newer answer. */
export const PLATE_TTL_MS = 120_000;
/** A cached plate is still SHOWN for this long after it stops being fresh
 *  (a refetch is merely due). Plates don't change under a device id in
 *  practice; this only bounds how stale a shown plate can get if refetches
 *  keep failing. */
export const PLATE_MAX_AGE_MS = 15 * 60_000;
/** Minimum spacing between request STARTS. Every caller funnels through one
 *  shared index, so this is a hard ceiling of 12 req/min per tab — a fifth
 *  of the 60/min per-account limit — however often fixes arrive. A request
 *  wanted inside the window is deferred (and coalesced), not dropped. */
export const MIN_REQUEST_SPACING_MS = 5_000;
/** After a failed request (network, 5xx, 4xx) nothing is sent for this
 *  long; wanted ids are dropped, not queued, so a down API isn't hammered on
 *  every fix. A 429 uses its Retry-After instead (falling back to this). */
export const FAILURE_COOLDOWN_MS = 30_000;

interface PlatesResponse {
  plates?: Record<string, string> | null;
  as_of?: string;
}

interface Entry {
  /** null = the API answered and had no plate for this id. */
  plate: string | null;
  at: number;
}

export type PlateLookupState = "known" | "none" | "unknown";

export interface PlateIndexDeps {
  /** Defaults to `GET /api/v1/vehicles/plates` via the bearer helper. */
  fetchPlates?(deviceIds: readonly string[]): Promise<PlatesResponse>;
  /** The current session token, or null when signed out. Defaults to the
   *  stored session (`map-auth.js`'s `getAuth`). */
  currentToken?(): string | null;
}

function defaultFetchPlates(ids: readonly string[]): Promise<PlatesResponse> {
  return fetchVehiclePlates(ids);
}

function defaultToken(): string | null {
  try {
    return getAuth()?.token ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * device_id → plate, filled from `/vehicles/plates` one nearby batch at a time.
 *
 * The interface is the one the old Veo-feed index had: `prime(...)` (now told
 * WHICH ids are wanted) and a synchronous `cachedPlateFor(deviceId)`. Exact
 * device_id match only — no position fallback: a nearest-neighbour guess
 * could return the wrong scooter's plate for two racked side by side, and a
 * wrong plate means unlocking or reporting the wrong vehicle. Missing beats
 * wrong.
 *
 * Budget rules, all enforced here so no caller can break them:
 *  - signed out → never requests, and reads return null;
 *  - ids already answered within PLATE_TTL_MS are never re-asked;
 *  - at most MAX_PLATE_BATCH ids per request, at most one request in flight,
 *    and request starts spaced MIN_REQUEST_SPACING_MS apart (later wants are
 *    coalesced into the next batch, newest first);
 *  - a failure stops requests for FAILURE_COOLDOWN_MS, a 429 for Retry-After.
 *
 * Every answer is bound to the session token it was fetched under: on
 * sign-out (or a different account signing in) the cache is dropped on the
 * next read, so a signed-out page never shows a plate a signed-in rider was
 * served.
 */
export class PlateIndex {
  private entries = new Map<string, Entry>();
  /** The token the entries were fetched under. */
  private ownerToken: string | null = null;
  /** Ids waiting for the next request, highest priority first. */
  private queued: string[] = [];
  /** The promise for the NEXT send (waiting on spacing / the in-flight one). */
  private pending: Promise<void> | null = null;
  private inflight: Promise<void> | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private readonly fetchPlates: (ids: readonly string[]) => Promise<PlatesResponse>;
  private readonly currentToken: () => string | null;

  constructor(deps: PlateIndexDeps = {}) {
    this.fetchPlates = deps.fetchPlates ?? defaultFetchPlates;
    this.currentToken = deps.currentToken ?? defaultToken;
  }

  /** Drop every cached answer and anything queued. Called on sign-out (and
   *  automatically whenever the session token changes). */
  clear(): void {
    this.entries.clear();
    this.queued = [];
    this.ownerToken = null;
  }

  /** Reconcile the cache with the current session. Returns the token, or
   *  null when signed out (in which case the cache is now empty). */
  private syncSession(): string | null {
    const token = this.currentToken();
    if (token !== this.ownerToken) {
      this.clear();
      this.ownerToken = token;
    }
    return token;
  }

  private isFresh(id: string, now: number): boolean {
    const e = this.entries.get(id);
    return e !== undefined && now - e.at < PLATE_TTL_MS;
  }

  /**
   * Ask for plates for these device ids, in priority order (nearest first).
   * Only ids not already answered fresh are sent, at most MAX_PLATE_BATCH of
   * them. Safe to call on every fix: a no-op when everything is fresh, when
   * signed out, or during a cooldown. Never rejects; resolves once the batch
   * carrying these ids has been answered (or dropped).
   */
  prime(deviceIds: Iterable<string>): Promise<void> {
    if (this.syncSession() === null) return Promise.resolve();
    const now = Date.now();
    if (now < this.blockedUntil) return Promise.resolve();
    const wanted: string[] = [];
    const seen = new Set<string>();
    for (const raw of deviceIds) {
      const id = String(raw ?? "");
      if (id === "" || id.length > MAX_DEVICE_ID_LEN || seen.has(id)) continue;
      seen.add(id);
      if (this.isFresh(id, now)) continue;
      wanted.push(id);
      if (wanted.length >= MAX_PLATE_BATCH) break;
    }
    if (wanted.length === 0) return Promise.resolve();
    // Newest want first: the latest fix's nearest vehicles beat an older
    // fix's, and the batch cap trims from the back.
    const merged = [...wanted];
    for (const id of this.queued) {
      if (merged.length >= MAX_PLATE_BATCH) break;
      if (!seen.has(id)) merged.push(id);
    }
    this.queued = merged;
    return this.pump();
  }

  private pump(): Promise<void> {
    if (this.pending) return this.pending;
    const run = async (): Promise<void> => {
      // Yield first so `this.pending` below is assigned before run() can
      // clear it (an async body runs synchronously up to its first await).
      await Promise.resolve();
      if (this.inflight) await this.inflight;
      const wait = this.lastSentAt + MIN_REQUEST_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.pending = null;
      const token = this.syncSession();
      const now = Date.now();
      if (token === null || now < this.blockedUntil) {
        this.queued = [];
        return;
      }
      const batch = this.queued
        .filter((id) => !this.isFresh(id, now))
        .slice(0, MAX_PLATE_BATCH);
      this.queued = [];
      if (batch.length === 0) return;
      this.lastSentAt = now;
      const sent = this.send(batch, token).finally(() => {
        this.inflight = null;
      });
      this.inflight = sent;
      await sent;
    };
    this.pending = run();
    return this.pending;
  }

  private async send(batch: string[], token: string): Promise<void> {
    try {
      const res = await this.fetchPlates(batch);
      // Signed out (or switched account) while the request was in flight:
      // the answer belongs to a session that is gone.
      if (this.currentToken() !== token || this.ownerToken !== token) return;
      const plates = res?.plates ?? {};
      const at = Date.now();
      for (const id of batch) {
        const p = plates[id];
        this.entries.set(id, {
          plate: typeof p === "string" && p !== "" ? p : null,
          at,
        });
      }
    } catch (e) {
      const retryAfter = e instanceof ApiError ? e.retryAfter : undefined;
      const is429 = e instanceof ApiError && e.status === 429;
      this.blockedUntil =
        Date.now() +
        (is429 && retryAfter !== undefined ? retryAfter * 1000 : FAILURE_COOLDOWN_MS);
      if (e instanceof ApiError && (e.code === "TOKEN_REJECTED" || e.code === "NO_AUTH")) {
        this.clear();
      }
    }
  }

  /** Synchronous plate lookup, or null when unknown / not yet answered /
   *  signed out. Call `prime([...])` to populate. */
  cachedPlateFor(deviceId: string): string | null {
    if (this.syncSession() === null) return null;
    const e = this.entries.get(String(deviceId));
    if (!e || Date.now() - e.at >= PLATE_MAX_AGE_MS) return null;
    return e.plate;
  }

  /** "known" — a plate is cached; "none" — the API answered recently and had
   *  no plate for this id (asking again won't help yet); "unknown" — not
   *  asked, still in flight, or signed out. Lets the popup tell "looking it
   *  up" from "we don't have it". */
  lookupState(deviceId: string): PlateLookupState {
    if (this.syncSession() === null) return "unknown";
    const e = this.entries.get(String(deviceId));
    if (!e) return "unknown";
    if (e.plate !== null && Date.now() - e.at < PLATE_MAX_AGE_MS) return "known";
    return e.plate === null && Date.now() - e.at < PLATE_TTL_MS ? "none" : "unknown";
  }
}

let shared: PlateIndex | null = null;

/** The ONE index the app uses (popup, wizard, QR scan). Sharing it is what
 *  makes the spacing / cooldown a per-tab ceiling rather than per-caller. */
export function sharedPlateIndex(): PlateIndex {
  shared ??= new PlateIndex();
  return shared;
}

/** Tests / HMR only. */
export function resetSharedPlateIndex(): void {
  shared = null;
}

/** The `limit` device ids nearest `fix`, nearest first — which ids a caller
 *  hands `prime()`. */
export function nearestDeviceIds(
  features: ReadonlyArray<GeoJSON.Feature<GeoJSON.Point, { device_id: string }>>,
  fix: LngLat,
  limit: number = MAX_PLATE_BATCH,
): string[] {
  const scored: { id: string; d: number }[] = [];
  for (const f of features) {
    const c = f.geometry?.coordinates;
    const id = f.properties?.device_id;
    if (!id || !c || typeof c[0] !== "number" || typeof c[1] !== "number") continue;
    scored.push({ id: String(id), d: distanceMeters(fix, { lng: c[0], lat: c[1] }) });
  }
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, limit).map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Reverse: plate → device (public)
// ---------------------------------------------------------------------------

/** The API rejects longer plates (422). */
export const MAX_PLATE_LEN = 32;
/** Cache a resolve answer (hit or miss) this long, so re-scanning or
 *  re-typing the same plate doesn't spend the 30/min per-IP budget. */
export const RESOLVE_TTL_MS = 120_000;

export type ResolveResult =
  | { kind: "hit"; deviceId: string; vehicleIdentifier: string }
  | { kind: "miss" }
  /** Network / 5xx / rate-limited: we couldn't ask, not "no such plate". */
  | { kind: "error" };

interface ResolveResponse {
  device_id?: string;
  vehicle_identifier?: string;
}

const resolveCache = new Map<string, { result: ResolveResult; at: number }>();
const resolveInflight = new Map<string, Promise<ResolveResult>>();
let resolveBlockedUntil = 0;

/** Tests / HMR only. */
export function resetResolveCache(): void {
  resolveCache.clear();
  resolveInflight.clear();
  resolveBlockedUntil = 0;
}

/**
 * Plate → `{deviceId, vehicleIdentifier}` via the public
 * `GET /api/v1/vehicles/resolve`. Works signed out. Never rejects. Identical
 * concurrent asks share one request; answers are cached RESOLVE_TTL_MS; a 429
 * pauses every resolve for its Retry-After.
 */
export function resolvePlate(rawPlate: string): Promise<ResolveResult> {
  const plate = normalizePlate(rawPlate);
  if (plate === "" || plate.length > MAX_PLATE_LEN) {
    return Promise.resolve({ kind: "miss" });
  }
  const now = Date.now();
  const cached = resolveCache.get(plate);
  if (cached && now - cached.at < RESOLVE_TTL_MS) return Promise.resolve(cached.result);
  const pending = resolveInflight.get(plate);
  if (pending) return pending;
  if (now < resolveBlockedUntil) return Promise.resolve({ kind: "error" });

  const p = (async (): Promise<ResolveResult> => {
    try {
      const res: ResolveResponse = await resolveVehiclePlate(plate);
      const deviceId = String(res?.device_id ?? "");
      const vid = String(res?.vehicle_identifier ?? "").toLowerCase();
      const result: ResolveResult =
        deviceId && /^[0-9a-f]{16}$/.test(vid)
          ? { kind: "hit", deviceId, vehicleIdentifier: vid }
          : { kind: "miss" };
      resolveCache.set(plate, { result, at: Date.now() });
      return result;
    } catch (e) {
      if (e instanceof NoDataError && e.status === 404) {
        // No match, or ambiguous — both are "not a vehicle we can name".
        const result: ResolveResult = { kind: "miss" };
        resolveCache.set(plate, { result, at: Date.now() });
        return result;
      }
      if (e instanceof ApiError && (e.status === 400 || e.status === 422)) {
        return { kind: "miss" };
      }
      if (e instanceof ApiError && e.status === 429) {
        resolveBlockedUntil = Date.now() + (e.retryAfter ?? 60) * 1000;
      }
      return { kind: "error" };
    } finally {
      resolveInflight.delete(plate);
    }
  })();
  resolveInflight.set(plate, p);
  return p;
}
