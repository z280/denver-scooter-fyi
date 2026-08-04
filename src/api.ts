// Typed client for the data.scooter.fyi public API.
// Contract: https://raw.githubusercontent.com/z280/scooter-fyi-api/main/API.md

import { clearStoredSessionIfToken } from "./auth-storage.ts";
import { getAuth, isAuthenticated } from "./map-auth.js";

// In production, the browser calls the API directly (CORS allows denver.scooter.fyi).
// In local dev, requests go through the Vite proxy (see vite.config.ts) because the
// API's CORS allowlist does not include localhost.
export const API_BASE = import.meta.env.DEV ? "" : "https://data.scooter.fyi";

export type FormFactor = "scooter" | "bicycle" | "unknown";

export type BoundaryLayer =
  | "v1"
  | "v2"
  | "neighborhood"
  | "council_district"
  | "community_network"
  // Equity-rank tiers er1..er6 from the city's ranked equity map. The city
  // hasn't said which ranks bind the SLA, so the UI lets users pick a set
  // to estimate against rather than hardcoding one.
  | "er1"
  | "er2"
  | "er3"
  | "er4"
  | "er5"
  | "er6";

export type PropulsionType = "electric" | "electric_assist" | "human";

export interface DeviceProperties {
  device_id: string;
  form_factor: FormFactor;
  spatial_status: string;
  // ----- Public per-device fields (always potentially present on
  // /api/v1/devices/current; values may still be null when upstream omits them).
  /** 16-hex stable per-scooter identifier; persistent across trips unlike device_id. */
  vehicle_identifier?: string | null;
  /** True when the scooter is out of service (low battery, fault, impound). */
  is_disabled?: boolean | null;
  /** True when a rider has the scooter on hold during the reservation window. */
  is_reserved?: boolean | null;
  /** Estimated remaining range in meters. Null for pedal-only bikes. */
  current_range_meters?: number | null;
  /** Drivetrain: throttle electric, pedal-assist electric, or pedal-only. */
  propulsion_type?: PropulsionType | null;
  /** Rider posture, corrected server-side against Veo's GBFS mislabels:
   *  "sitting" (seated e-bikes like the Apollo) vs "standing" (scooters).
   *  Key any seated-vs-standing UX off THIS, not `form_factor`. */
  vehicle_use_type?: string | null;
  /** Veo's model name (e.g. "Apollo", "Astro"), aligned to their app. */
  vehicle_model_name?: string | null;
  // ----- H3 spatial indexes at three resolutions (cell ID strings).
  h3_8_index?: string | null;
  h3_9_index?: string | null;
  h3_10_index?: string | null;
  // ----- Range rank / percentile fields, computed server-side against
  // various peer sets. Lower rank = more remaining range. Null when the
  // device has no current_range_meters.
  /** 0–100 percentile of this device's range among same-propulsion peers. */
  range_percentile_by_type?: number | null;
  range_rank_unique_by_type?: number | null;
  range_rank_all_by_type?: number | null;
  range_rank_all_devices?: number | null;
  range_rank_h3_8_peers?: number | null;
  range_rank_h3_9_peers?: number | null;
  range_rank_h3_10_peers?: number | null;
  // ----- Community quality signals.
  /** True when the device has at least one open negative quality report. */
  has_negative_report?: boolean | null;
  /** Server-assigned quality label (e.g. "low_quality", "ok"); free-form string. */
  quality_designation?: string | null;
  // ----- Reliability. The server now ships `reliability_tier` on the public
  // endpoint (values "ok" | "unknown" | "high_risk"); the raw inputs
  // `number_failed_starts`, `first_observed_at_location`, `quality_designation`
  // and `has_negative_report` are public too. annotateReliability() prefers
  // the server tier (normalizing "high_risk" → "risk") and falls back to a
  // local assessment, then attaches a human-readable `reliability_reasons`.
  reliability_tier?: "ok" | "unknown" | "risk" | "high_risk";
  reliability_reasons?: string;
  /** Recent failed unlock/start attempts. Public. */
  number_failed_starts?: number;
  /** When the device first appeared at its current spot (dwell start). Public. */
  first_observed_at_location?: string;
  /** Peer-relative dwell: this device's dwell percentile among its H3
   *  neighborhood peers (0–100; null when <5 peers), and the peers'
   *  median dwell — the comparison baseline the reliability formula uses. */
  dwell_percentile_hood?: number | null;
  dwell_peer_median_hours?: number | null;
  // ----- Client-derived (not on the wire): battery_percent (0–100) computed
  // against the observed-max range for the device's propulsion type, since
  // the public endpoint doesn't expose per-type `max_range_meters`.
  battery_percent?: number;
  // ----- Private fields — only via /api/v1/private/* (devices/lookup, trips)
  // when signed in. `vehicle_plate` is deliberately NOT on the public
  // endpoint (publishing live plates would let Veo reconcile our map against
  // their GBFS feed), so the "Unlock in Veo" deep link is authenticated-only.
  vehicle_plate?: string;
  first_ever_observed_at?: string;
  max_observed_range_meters?: number | null;
  max_observed_range_at?: string | null;
}

export interface DevicesResponse {
  type: "FeatureCollection";
  metadata: {
    cycle_id: string;
    snapshot_time: string;
    device_count: number;
    filters: Record<string, unknown>;
  };
  features: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[];
}

export interface BoundaryProperties {
  region_category: string;
  region_type: string;
  region_name: string;
}

export interface BoundaryResponse {
  type: "FeatureCollection";
  metadata: {
    region_category: string;
    region_type: string;
    feature_count: number;
    bbox: [number, number, number, number];
  };
  features: GeoJSON.Feature<
    GeoJSON.Polygon | GeoJSON.MultiPolygon,
    BoundaryProperties
  >[];
}

export interface SpatialSnapshotResponse {
  snapshot_time: string;
  layer: BoundaryLayer;
  regions: Record<string, { total: number; bikes: number; scooters: number }>;
}

export interface ComplianceResponse {
  sla_date: string;
  window_start_ts: string;
  window_end_ts: string;
  snapshot_count: number;
  avg_total_devices_denver: number;
  avg_percent_all_devices_v1: number;
  avg_percent_all_devices_v2: number;
  compliance_v1_pass: boolean;
  compliance_v2_pass: boolean;
  computed_at: string;
}

/** Live "right now" citywide metrics from the most recent 10-minute cycle.
 *  Companion to ComplianceResponse: the daily SLA value is the binding
 *  contractual metric, but this is the up-to-the-minute readout. */
export interface SnapshotMetadataResponse {
  cycle_id: string;
  snapshot_time: string;
  total_devices_denver: number;
  total_devices_v1: number;
  total_devices_v2: number;
  percent_all_devices_v1: number | null;
  percent_all_devices_v2: number | null;
}

/** Returned when an endpoint has no data yet (503 cold-start). */
export class NoDataError extends Error {
  readonly status: number;
  /** `detail.error` when the body carried a structured error key — e.g.
   *  `geocoder_unavailable` (Photon sidecar down) or `router_unavailable`
   *  (Valhalla down), which callers degrade differently. */
  readonly errorKey?: string;
  constructor(message: string, status: number, errorKey?: string) {
    super(message);
    this.name = "NoDataError";
    this.status = status;
    this.errorKey = errorKey;
  }
}

/** Public GET. Non-2xx becomes NoDataError (503/404) or ApiError (everything
 *  else, including 429 with its parsed `retryAfter`) — see `apiErrorFrom`. */
export async function getJSON<T>(
  path: string,
  signal?: AbortSignal,
  parseText?: (text: string) => T,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (res.status === 503 || res.status === 404) {
    const { detail, errorKey } = await readErrorBody(res);
    throw new NoDataError(
      errorMessage(detail, errorKey, `No data (${res.status})`),
      res.status,
      errorKey,
    );
  }
  if (!res.ok) {
    throw await apiErrorFrom(res, `Request to ${path} failed: ${res.status}`);
  }
  if (parseText) return parseText(await res.text());
  return (await res.json()) as T;
}

/** Parse a devices payload while preserving the H3 cell indexes. Upstream
 *  serializes `h3_8_index` / `h3_9_index` / `h3_10_index` as JSON integers
 *  larger than Number.MAX_SAFE_INTEGER, so a plain JSON.parse silently rounds
 *  them (…919 → …900) and corrupts the cell id. Quote them in the raw text
 *  first so the exact digits survive as strings (matching their declared
 *  `string` type). The regex only touches an unquoted integer immediately
 *  after one of those keys, so null values and already-quoted values are left
 *  alone. */
function parseDevicesResponse(text: string): DevicesResponse {
  const fixed = text.replace(
    /("h3_(?:8|9|10)_index":)\s*(\d+)/g,
    '$1"$2"',
  );
  return JSON.parse(fixed) as DevicesResponse;
}

/** Optional payload extras (the API's lean-by-default diet): "h3" restores
 *  the three h3_*_index fields, "ranks" the range rank/percentile fields. */
export type DeviceInclude = "h3" | "ranks";

function includeQuery(include?: readonly DeviceInclude[]): string {
  return include && include.length ? `?include=${include.join(",")}` : "";
}

/** Every Denver device's current position via the public endpoint. */
export function fetchDevices(
  signal?: AbortSignal,
  include?: readonly DeviceInclude[],
): Promise<DevicesResponse> {
  return getJSON<DevicesResponse>(
    `/api/v1/devices/current${includeQuery(include)}`,
    signal,
    parseDevicesResponse,
  );
}

/** Failure from an authenticated endpoint. `code`/`status` intentionally
 *  match the ad-hoc `Error & { code, status }` shape the bearer helpers threw
 *  before this class existed, so fetchDevicesAuto's fallback checks keep
 *  working unchanged. `retryAfter`/`detail`/`errorKey` are only populated on
 *  the JSON path, where the error body has been read. */
export class ApiError extends Error {
  readonly code: "NO_AUTH" | "TOKEN_REJECTED" | "HTTP_ERROR";
  readonly status?: number;
  /** Seconds from the Retry-After header; set on 429 responses. */
  readonly retryAfter?: number;
  /** Parsed `detail` from the error body — a string, or an object for
   *  endpoints that return a structured `{ error: "..." }` code. */
  readonly detail?: unknown;
  /** `detail.error` when detail is an object with a stable error key. */
  readonly errorKey?: string;
  constructor(
    message: string,
    code: ApiError["code"],
    extra?: {
      status?: number;
      retryAfter?: number;
      detail?: unknown;
      errorKey?: string;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = extra?.status;
    this.retryAfter = extra?.retryAfter;
    this.detail = extra?.detail;
    this.errorKey = extra?.errorKey;
  }
}

// ---------------------------------------------------------------------------
// Shared non-2xx handling. Both clients — the public getJSON above and the
// authenticated authedFetchJSON below — funnel every error response through
// these three helpers, so `Retry-After` is parsed on 429 no matter which path
// hit the limit. That matters because the newest rate limits are on *public*
// endpoints (geocode 20/min and route 30/min are per-IP), which authedFetchJSON
// never sees. No automatic retry or cooldown is attempted: callers own their
// backoff and read `ApiError.retryAfter` (seconds) to size it.
// ---------------------------------------------------------------------------

/** Reads a FastAPI `{ detail }` error body. `detail` is a plain string on most
 *  endpoints and an object carrying a stable `error` key on the structured
 *  ones (route, geocode, donation). Never throws — a non-JSON body just
 *  leaves both fields unset. */
async function readErrorBody(
  res: Response,
): Promise<{ detail?: unknown; errorKey?: string }> {
  let detail: unknown;
  try {
    const parsed = JSON.parse(await res.text()) as { detail?: unknown };
    detail = parsed?.detail;
  } catch {
    /* non-JSON error body — leave detail unset */
  }
  const errorKey =
    typeof detail === "object" && detail !== null && "error" in detail
      ? String((detail as { error: unknown }).error)
      : undefined;
  return { detail, errorKey };
}

function errorMessage(
  detail: unknown,
  errorKey: string | undefined,
  fallback: string,
): string {
  if (typeof detail === "string" && detail) return detail;
  return errorKey ?? fallback;
}

/** Seconds from `Retry-After` on a 429, or undefined. The API sends an integer
 *  count of seconds on every rate-limit bucket; anything else (an HTTP-date,
 *  a missing header) is treated as "unknown, back off on your own schedule". */
function parseRetryAfter(res: Response): number | undefined {
  if (res.status !== 429) return undefined;
  const raw = res.headers.get("Retry-After")?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** The shared 429/error handler: builds the ApiError both clients throw. */
async function apiErrorFrom(
  res: Response,
  fallbackMessage: string,
): Promise<ApiError> {
  const { detail, errorKey } = await readErrorBody(res);
  return new ApiError(
    errorMessage(detail, errorKey, fallbackMessage),
    "HTTP_ERROR",
    {
      status: res.status,
      retryAfter: parseRetryAfter(res),
      detail,
      errorKey,
    },
  );
}

// PATCH is here for `PATCH /tracked-rides/{id}/end` — the ride end report.
type HttpMethod = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

interface AuthedInit {
  method?: HttpMethod;
  /** JSON-serialized into the request body with Content-Type set. */
  body?: unknown;
  signal?: AbortSignal;
}

/** Core bearer fetch: attaches Authorization, throws NO_AUTH when signed
 *  out and TOKEN_REJECTED on 401 (clearing the stale stored blob so the UI
 *  reflects the signed-out state — but only when the rejected token is still
 *  the stored one; see below). Any other response — including non-2xx — is
 *  returned for the caller to interpret. */
async function authedFetch(path: string, init: AuthedInit): Promise<Response> {
  const auth = getAuth();
  if (!auth) {
    throw new ApiError("not authenticated", "NO_AUTH");
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.token}`,
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    signal: init.signal,
    headers,
    body,
  });
  if (res.status === 401) {
    // Re-read storage before clearing. `POST /auth/refresh` rotates and
    // REVOKES the presented token in one transaction, so a second tab that
    // refreshes moments later presents a token storage no longer holds — and
    // clearing on that 401 would sign out the tab holding the VALID rotated
    // session. clearStoredSessionIfToken() clears only when the rejected
    // token is still the stored one (or nothing is stored at all); a
    // different session is left exactly where it is.
    clearStoredSessionIfToken(auth.token);
    throw new ApiError("token rejected", "TOKEN_REJECTED");
  }
  return res;
}

/** Authenticated GET returning the raw response text, so the caller can parse
 *  the JSON itself and preserve the large-integer H3 fields that JSON.parse
 *  would round. Error contract — NO_AUTH, TOKEN_REJECTED (clearing the stale
 *  token), HTTP_ERROR with `status` — is what fetchDevicesAuto's fallback
 *  keys off. This lives here rather than as a raw-text variant in map-auth.js
 *  to keep that module to just the session store (getAuth/isAuthenticated/
 *  signOut) the sign-in doors write to. */
async function authedGetText(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await authedFetch(path, { signal });
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status}`, "HTTP_ERROR", {
      status: res.status,
    });
  }
  return res.text();
}

/** Authenticated JSON round-trip for the profile/points/username endpoints.
 *  On non-2xx, reads the `{ detail }` error body — `detail` may be a plain
 *  string or an object carrying a stable `error` key — and the Retry-After
 *  header on 429, and throws an ApiError carrying all of it. */
export async function authedFetchJSON<T>(
  path: string,
  init: AuthedInit = {},
): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) {
    throw await apiErrorFrom(res, `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Profile, username, points — the authenticated account surface.
// ---------------------------------------------------------------------------

export type ApiRatePlan = "resident" | "visitor" | "equity";

export interface ProfileBadge {
  id: string;
  label: string;
  earned_at: string;
}

export interface Profile {
  email: string | null;
  phone_number: string | null;
  /** Whether anyone has PROVED they answer that number, by typing back a
   *  texted code. A number saved through PUT /profile starts unverified —
   *  it is a contact detail, and contact details are not proof — and only a
   *  verified number can be used to sign in. */
  phone_verified: boolean;
  /** They texted STOP. Consent is enforced by the SMS gateway and is global
   *  across every application sharing the sender, so this is a local echo
   *  for honest UI; only an UNSTOP text can clear it. */
  sms_opted_out: boolean;
  /** Server-computed adjective+emoji-noun pair; change via the username
   *  endpoints, never via PUT /profile (it is ignored there). */
  public_username: string | null;
  show_public_username: boolean;
  show_in_leaderboards: boolean;
  rate_plan: ApiRatePlan | null;
  theme: string | null;
  favorites: unknown[];
  home_lat: number | null;
  home_lng: number | null;
  work_lat: number | null;
  work_lng: number | null;
  royalty_title: string | null;
  /** Read-only generated column: royalty_title + " " + public_username. */
  display_name: string | null;
  /** Leaderboard-territory fill hex; the (fill, border) pair is globally
   *  unique and always set (or cleared) together. */
  ruling_color: string | null;
  ruling_border_color: string | null;
  /** 0.10–1.00, default 0.60; applies to the fill only. */
  ruling_alpha: number | null;
  badges: ProfileBadge[];
}

/** PUT /api/v1/profile is a partial merge: send any subset, omitted fields
 *  are untouched. home/work coordinates and the ruling colour pair must be
 *  sent together (both values, or both null to clear). */
export type ProfileUpdate = Partial<
  Pick<
    Profile,
    | "email"
    | "phone_number"
    | "show_public_username"
    | "show_in_leaderboards"
    | "rate_plan"
    | "theme"
    | "favorites"
    | "home_lat"
    | "home_lng"
    | "work_lat"
    | "work_lng"
    | "royalty_title"
    | "ruling_color"
    | "ruling_border_color"
    | "ruling_alpha"
  >
>;

export function fetchProfile(signal?: AbortSignal): Promise<Profile> {
  return authedFetchJSON<Profile>("/api/v1/profile", { signal });
}

export function updateProfile(patch: ProfileUpdate): Promise<Profile> {
  return authedFetchJSON<Profile>("/api/v1/profile", {
    method: "PUT",
    body: patch,
  });
}

/** Text a code to prove you answer the number on your profile (or the one
 *  passed). Draws on the SAME send budget as the SMS sign-in door — one
 *  handset — so 429 here can be caused by sign-in traffic. 409 means that
 *  number has blocked texts, and the `detail` names the keyword that
 *  unblocks it. */
export function requestPhoneCode(
  phoneNumber?: string,
): Promise<{ sent: boolean; phone_number: string }> {
  return authedFetchJSON<{ sent: boolean; phone_number: string }>(
    "/api/v1/profile/phone/code",
    { method: "POST", body: phoneNumber ? { phone_number: phoneNumber } : {} },
  );
}

/** Type the code back. On success the number is attached to THIS account as
 *  verified — which is what stops SMS sign-in from creating a second
 *  account for a rider who saved their number here first. */
export function verifyPhoneNumber(
  phoneNumber: string,
  code: string,
): Promise<{ phone_number: string; phone_verified: boolean }> {
  return authedFetchJSON<{ phone_number: string; phone_verified: boolean }>(
    "/api/v1/profile/phone/verify",
    { method: "POST", body: { phone_number: phoneNumber, code } },
  );
}

/** Re-roll to a new random adjective + emoji-noun pair. Shares one 10/hour
 *  rate-limit bucket with setUsername. */
export function regenerateUsername(): Promise<{ public_username: string }> {
  return authedFetchJSON<{ public_username: string }>(
    "/api/v1/profile/username/regenerate",
    { method: "POST" },
  );
}

/** Set either or both username halves from the curated lists. 400 when
 *  neither is sent or a value is off-list, 409 when the pair is taken.
 *  Shares the 10/hour bucket with regenerateUsername. */
export function setUsername(parts: {
  adjective?: string;
  emoji?: string;
}): Promise<{ public_username: string }> {
  return authedFetchJSON<{ public_username: string }>(
    "/api/v1/profile/username",
    { method: "PUT", body: parts },
  );
}

export interface EmojiNoun {
  emoji: string;
  word: string;
}

export function fetchAdjectives(
  signal?: AbortSignal,
): Promise<{ adjectives: string[] }> {
  return authedFetchJSON<{ adjectives: string[] }>("/api/v1/adjectives", {
    signal,
  });
}

export function fetchEmojiNouns(
  signal?: AbortSignal,
): Promise<{ emoji_nouns: EmojiNoun[] }> {
  return authedFetchJSON<{ emoji_nouns: EmojiNoun[] }>("/api/v1/emoji-nouns", {
    signal,
  });
}

/** Royalty titles come back in picker order (related titles adjacent), not
 *  alphabetical — render as served, never sort. */
export function fetchRoyaltyTitles(
  signal?: AbortSignal,
): Promise<{ royalty_titles: string[] }> {
  return authedFetchJSON<{ royalty_titles: string[] }>(
    "/api/v1/royalty-titles",
    { signal },
  );
}

export interface RulingColor {
  hex: string;
  name: string;
  hue_family: string;
}

export interface RulingColorsResponse {
  ruling_colors: RulingColor[];
  /** Claimed (fill, border) combinations — grey these out in the picker
   *  instead of discovering them by 409. Pairs only; never who holds one. */
  taken_pairs: { fill: string; border: string }[];
}

export function fetchRulingColors(
  signal?: AbortSignal,
): Promise<RulingColorsResponse> {
  return authedFetchJSON<RulingColorsResponse>("/api/v1/ruling-colors", {
    signal,
  });
}

export interface PointsEntry {
  id: number;
  created_at: string;
  action: string;
  points: number;
  vehicle_identifier: string | null;
  status: string;
}

export interface PointsResponse {
  /** Sum of confirmed entries across the whole ledger, not just this page. */
  total_points: number;
  entries: PointsEntry[];
}

/** Owner-only points ledger, newest first. `before` is a cursor: pass a
 *  previous entry's `created_at` back verbatim — server timestamps carry
 *  their timezone offset, which the API requires (400 without one). */
export function fetchPoints(
  opts: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<PointsResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before !== undefined) params.set("before", opts.before);
  const qs = params.toString();
  return authedFetchJSON<PointsResponse>(
    `/api/v1/points${qs ? `?${qs}` : ""}`,
    { signal },
  );
}

/**
 * Same shape as fetchDevices but goes through the private endpoint when the
 * user is signed in via map-auth. Falls back to the public endpoint **only**
 * for failure modes that map cleanly to "auth not usable right now":
 * NO_AUTH, TOKEN_REJECTED, and 5xx server errors. Any other error
 * (4xx other than 401, malformed responses, etc.) is rethrown so a
 * misconfiguration is visible to the caller and not silently masked by
 * degraded public data. The caller can inspect
 * `features[i].properties.vehicle_plate` etc. to tell whether private
 * fields came back.
 *
 * On TOKEN_REJECTED, the helper has already dropped the stored session —
 * unless another tab had rotated the token in the meantime, in which case that
 * newer session survives and `isAuthenticated()` stays true. Either way the
 * caller re-renders off `isAuthenticated()` rather than assuming a sign-out.
 */
export async function fetchDevicesAuto(
  signal?: AbortSignal,
  include?: readonly DeviceInclude[],
): Promise<DevicesResponse> {
  if (!isAuthenticated()) return fetchDevices(signal, include);
  try {
    const text = await authedGetText(
      // The signed-in map feed (scooter-fyi-api PR #19): any rider session gets
      // the public field set; ADMIN_EMAILS sessions (either sign-in door)
      // additionally get plates + first-ever/max-range. Same query params
      // as the public endpoint. Until it deploys, the 404 falls through to
      // the public fetch below.
      `/api/v1/user/devices/current${includeQuery(include)}`,
      signal,
    );
    return parseDevicesResponse(text);
  } catch (e) {
    const err = e as { code?: string; name?: string; status?: number };
    if (err?.name === "AbortError") throw e;
    // Fall back to public for ANY auth/HTTP failure from the private
    // endpoint. This used to rethrow non-5xx statuses so misconfiguration
    // stayed visible — but the private endpoint is admin-gated, so every
    // rider-scope session (magic link!) got a 403 and an empty map. The
    // public fleet is always the right degraded answer; the warn keeps
    // misconfigurations visible in devtools. Only genuine network/CORS
    // errors (TypeError, no `code`) still rethrow, since the public fetch
    // would hit the same wall.
    const fallbackable =
      err?.code === "NO_AUTH" ||
      err?.code === "TOKEN_REJECTED" ||
      err?.code === "HTTP_ERROR";
    if (!fallbackable) throw e;
    if (err?.code === "HTTP_ERROR") {
      console.warn(
        `private devices fetch failed (HTTP ${err.status}); showing public data`,
      );
    }
    return fetchDevices(signal, include);
  }
}

/** Full GeoJSON polygons for one boundary layer (CDN-cached 24h; fetch once). */
export function fetchBoundary(
  layer: BoundaryLayer,
  signal?: AbortSignal,
): Promise<BoundaryResponse> {
  return getJSON<BoundaryResponse>(`/api/v1/boundaries/${layer}`, signal);
}

/** Live per-region device counts for choropleth coloring. */
export function fetchSpatialSnapshot(
  layer: BoundaryLayer,
  signal?: AbortSignal,
): Promise<SpatialSnapshotResponse> {
  return getJSON<SpatialSnapshotResponse>(
    `/api/v1/spatial-snapshot?layer=${encodeURIComponent(layer)}`,
    signal,
  );
}

export type H3Resolution = 8 | 9 | 10;

/** Per-cell metrics from the H3 aggregates endpoint, computed once per
 *  10-minute cycle and CDN-cached (~10 min). */
export interface H3CellMetrics {
  /** Devices (denver_core) currently parked in the cell. */
  device_count: number;
  /** Trailing-24h count of trip_events whose FROM-position falls in the
   *  cell (window ends at snapshot_time). A "start" is the state tracker
   *  observing a device leave its spot (the same MOVED transition that
   *  resets dwell); failed starts are tracked separately. */
  trips_started_24h: number;
  /** Max trips started in any single UTC clock hour within that window
   *  (usage heat). */
  starts_per_hour_peak: number;
  /** Mean battery_percent of devices in the cell that have one; null when none do. */
  avg_battery_percent: number | null;
  /** Fraction of the cell's devices with reliability_tier == "high_risk"
   *  (same formula as /api/v1/devices/current, dwell outliers included);
   *  null for trip-only cells with no parked devices. */
  risk_share: number | null;
  /** Mean dwell of the cell's state-tracked devices; null when none are tracked. */
  avg_dwell_hours: number | null;
}

export interface H3AggregatesResponse {
  res: H3Resolution;
  cycle_id: string;
  snapshot_time: string;
  /** Keyed by H3 cell id, as a decimal-integer string (same convention as
   *  DeviceProperties.h3_8_index etc.). Occupied cells only. */
  cells: Record<string, H3CellMetrics>;
}

/** Citywide per-cell metrics (device count, trip starts, battery, risk,
 *  dwell) at one H3 resolution — the hex tool's "shade by" data source
 *  beyond raw device density. */
export function fetchH3Aggregates(
  res: H3Resolution,
  signal?: AbortSignal,
): Promise<H3AggregatesResponse> {
  return getJSON<H3AggregatesResponse>(`/api/v1/h3/aggregates?res=${res}`, signal);
}

/** Yesterday's 6–9am Denver SLA window. Throws NoDataError when pending. */
export function fetchCompliance(
  signal?: AbortSignal,
): Promise<ComplianceResponse> {
  return getJSON<ComplianceResponse>("/api/v1/compliance/daily/latest", signal);
}

/** Most-recent 10-minute cycle's citywide metrics ("right now" view). */
export function fetchLatestSnapshot(
  signal?: AbortSignal,
): Promise<SnapshotMetadataResponse> {
  return getJSON<SnapshotMetadataResponse>("/api/v1/snapshots/latest", signal);
}

// ===========================================================================
// Ride mode — tracked-ride sessions, local-track donation, surveys, routing,
// geocoding, pricing, the points schedule, ride Usuals and the leaderboard
// payload. Contracts: RIDE_MODE_OVERHAUL_PLAN.md §1.5 (both repos) and the
// API repo's PLAN_RIDE_MODE_API.md phases A1–A4. Types here are the wire
// shapes only — defaults, cross-option rules and copy live in ride-settings.ts.
// ===========================================================================

/** Query-string builder that drops undefined/null params. */
function query(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

// --- Ride options (the client-owned wire blob) -----------------------------

export type SpeedometerStyle = "classic" | "digital" | "none";
/** Ride-scoped theme pick. `auto` follows sunrise/sunset for the ride and must
 *  NOT touch the rider's durable preference (see ride-hud's toggle-night). */
export type RideThemeChoice = "light" | "dark" | "auto";

/** Screen 2's Ride Mode Options, stored on the ride row as `ride_options`
 *  JSONB. Client-owned: the server echoes it back and reads only the booleans
 *  it gates awards on (`save_tracks`, `battery_modeling`, `nav_improvement`,
 *  `end_survey`, `own_device`). 4 KB cap, enforced server-side. */
export interface RideOptions {
  cost_hud: boolean;
  speedometer: SpeedometerStyle;
  theme: RideThemeChoice;
  navigation: boolean;
  save_tracks: boolean;
  /** 🏆 Requires a specific Veo device + donated tracks. */
  battery_modeling: boolean;
  /** 🏆 Requires save_tracks; gates `POST /ride-routes` and the nav awards. */
  nav_improvement: boolean;
  /** 🏆 Gates Screen 9's scooter-feedback pane and the `ride_survey` award. */
  end_survey: boolean;
  /** "My own Device" — disables battery modeling + end survey. */
  own_device: boolean;
}

// --- Tracked rides ---------------------------------------------------------

export type TrackedRideStatus =
  | "watching"
  | "left_feed"
  | "completed"
  | "expired";

export type TrackedRideDistanceSource =
  | "waypoints"
  | "waypoints_partial"
  | "straight_line";

/** Server-side verdict on a ride's contribution eligibility. `pending_feed`
 *  is Screen 10's "waiting on validation from the live feed" branch. */
export type ValidationStatus =
  | "pending"
  | "pending_feed"
  | "eligible"
  | "ineligible"
  | "error";

/** The complete reason vocabulary Screen 10's generated copy renders. Treat
 *  an unrecognized value as `internal_error` rather than crashing — the list
 *  is the API's to extend. */
export type ValidationReason =
  | "start_mismatch"
  | "end_mismatch"
  | "tracking_not_opted"
  | "too_few_waypoints"
  | "trip_too_short"
  | "chain_invalid"
  | "internal_error";

export interface RideValidation {
  status: ValidationStatus;
  reasons: ValidationReason[];
}

/** Per-ride HMAC material for the local track chain, issued at ride start and
 *  re-served on `GET /tracked-rides/active` + `/{id}` (owner-only, never in
 *  list responses) so a reloaded client can resume signing. `key` is base64url
 *  32 bytes — import it, never keep the raw bytes around; `nonce` is 16 bytes
 *  hex and hash-decodes to raw bytes for `H_-1 = sha256(nonce)`. */
export interface TrackSigning {
  alg: "HS256";
  /** The ride id, which is also the JWS protected header's `kid`. */
  key_id: string;
  key: string;
  nonce: string;
  issued_at: string;
}

export interface TrackedRide {
  id: string;
  status: TrackedRideStatus;
  started_at: string;
  start_lat: number | null;
  start_lon: number | null;
  watch_expires_at: string | null;
  // Every gbfs_* field reads null until you report your own end (the API's
  // deliberate redaction rule — do not design a summary that assumes them).
  gbfs_left_feed_at: string | null;
  gbfs_reappeared_at: string | null;
  gbfs_end_lat: number | null;
  gbfs_end_lon: number | null;
  gbfs_end_battery_percent: number | null;
  user_reported_ended_at: string | null;
  end_lat: number | null;
  end_lon: number | null;
  reported_battery_percent: number | null;
  total_cost_cents: number | null;
  metadata: Record<string, unknown>;
  vehicle_identifier: string;
  created_at: string;
  updated_at: string;
  distance_meters: number | null;
  distance_source: TrackedRideDistanceSource | null;
  /** What was measured before the 80 km ride cap clamped it, else null. */
  distance_clamped_from_m?: number | null;
  /** Rebuilt from legacy per-waypoint uploads; ride mode never posts those,
   *  so these stay null on a ride-mode ride. List responses omit both. */
  path_polyline?: string | null;
  path_geojson?: GeoJSON.LineString | null;
  // ----- Added by API phase A1 (§10 + ride sessions).
  reported_start_battery_percent?: number | null;
  /** §10: what the Veo app reported, deliberately never reconciled. */
  reported_minutes?: number | null;
  reported_plan?: ApiRatePlan | null;
  /** Optional until A1 deploys; `{}` on rides started before it. */
  ride_options?: RideOptions | null;
  /** Optional until A1 deploys — read it as `pending` when absent. */
  validation?: RideValidation;
  /** Owner-only, and only on start / active / detail responses. */
  track_signing?: TrackSigning | null;
  // ----- Added by API phase A3.
  survey_submitted?: boolean;
}

/** `POST /tracked-rides` additionally returns the cosmetic plate display code
 *  so the rider can confirm on-screen which scooter is being tracked. It is a
 *  display aid, not the plate and not a privacy control. */
export interface StartedTrackedRide extends TrackedRide {
  plate_display_code?: string | null;
}

export interface StartTrackedRideIn {
  /** Exactly 16 lowercase hex chars. */
  vehicle_identifier: string;
  start_lat: number;
  start_lon: number;
  /** Screen 2's Battery% confirm field (0–100). */
  reported_start_battery_percent?: number;
  ride_options?: RideOptions;
}

/** Declare a ride start against a specific feed vehicle. 20/hour per account.
 *  Throws ApiError with `status: 404` for an unknown vehicle and `status: 409`
 *  when an active ride already exists — the resume-or-end prompt's trigger. */
export function startTrackedRide(
  body: StartTrackedRideIn,
  signal?: AbortSignal,
): Promise<StartedTrackedRide> {
  return authedFetchJSON<StartedTrackedRide>("/api/v1/tracked-rides", {
    method: "POST",
    body,
    signal,
  });
}

/** The wire shape: the ride is always wrapped, `{ active: null }` when none. */
export interface ActiveRideResponse {
  active: TrackedRide | null;
}

/** The rider's live ride, or null. Unwraps the `{ active }` envelope. */
export async function getActiveRide(
  signal?: AbortSignal,
): Promise<TrackedRide | null> {
  const res = await authedFetchJSON<ActiveRideResponse>(
    "/api/v1/tracked-rides/active",
    { signal },
  );
  return res?.active ?? null;
}

/** One ride's full detail. Screen 10 reads `validation` from here, and reload
 *  recovery uses the 404 to tell "ride deleted" from "ride ended". */
export function getTrackedRide(
  rideId: string,
  signal?: AbortSignal,
): Promise<TrackedRide> {
  return authedFetchJSON<TrackedRide>(
    `/api/v1/tracked-rides/${encodeURIComponent(rideId)}`,
    { signal },
  );
}

export interface EndRideIn {
  /** ISO 8601 and it MUST carry a UTC offset (400 otherwise). */
  ended_at: string;
  end_lat: number;
  end_lon: number;
  /** Rider-entered on Screen 8; A2's battery ingestion reads it as
   *  `soc_end_percent`. Omitted by [Rush Quit]. */
  reported_battery_percent?: number;
  total_cost_cents?: number;
  /** §10: integer minutes, ≤1440. Prefilled from the ride clock, editable. */
  reported_minutes?: number;
  /** §10: pass a local plan key through `toApiRatePlan` first — a raw `_plus`
   *  key 422s. */
  reported_plan?: ApiRatePlan;
  metadata?: Record<string, unknown>;
}

/** Report your own end. **Single-shot** — a second call is a 409, with no
 *  un-end and no edit, so confirm before sending. Donation requires it, and
 *  it still works after the 3 h watch window expires. */
export function endTrackedRide(
  rideId: string,
  body: EndRideIn,
  signal?: AbortSignal,
): Promise<TrackedRide> {
  return authedFetchJSON<TrackedRide>(
    `/api/v1/tracked-rides/${encodeURIComponent(rideId)}/end`,
    { method: "PATCH", body, signal },
  );
}

// --- Track donation (Screen 10) -------------------------------------------

/** Per-check results, `"ok"` or a failure token. Keys are stable but the API
 *  owns the value vocabulary, so render unknown values verbatim. */
export interface TrackVerification {
  chain?: string;
  monotonic?: string;
  speed?: string;
  gbfs_start?: string;
  gbfs_end?: string;
  volume?: string;
}

/** One ledger row's worth of award, itemized per action. */
export interface PointsAward {
  action: string;
  points: number;
}

export interface DonateTrackIn {
  /** Every sealed batch as a compact JWS, in `seq` order, `seq 0` first.
   *  This is the whole body: the server recomputes the chain root from these
   *  and stores it as its own audit anchor. A client-supplied root was never
   *  read (it is unverifiable — the client holds the signing key), so it is
   *  not sent. */
  batches: string[];
}

export interface DonateTrackResponse {
  donation_id: string;
  verification: TrackVerification;
  validation: RideValidation;
  distance_meters: number | null;
  waypoint_count: number;
  points: PointsAward[];
}

/** One request carrying the whole sealed chain — the sole track upload path.
 *  No chunking: the longest points-eligible ride (the 3 h watch window) is
 *  ≤~432 batches ≈ 650 KB, inside the API's 2 MB / 600-batch caps. 6/hour.
 *  Errors: 409 `already_donated`, 422 `tracking_not_opted`, 422 `chain_invalid`
 *  (with the failing check + batch seq in `detail`), 413, 404, 429. */
export function donateTrack(
  rideId: string,
  body: DonateTrackIn,
  signal?: AbortSignal,
): Promise<DonateTrackResponse> {
  return authedFetchJSON<DonateTrackResponse>(
    `/api/v1/tracked-rides/${encodeURIComponent(rideId)}/track`,
    { method: "POST", body, signal },
  );
}

// --- End-ride survey (Screen 9) -------------------------------------------

/** The fixed 16-item issue vocabulary; anything else 422s. */
export type SurveyIssue =
  | "app_veo"
  | "acceleration"
  | "basket"
  | "battery"
  | "bell"
  | "brakes"
  | "connectivity"
  | "customer_service"
  | "dirty"
  | "kickstand"
  | "pedals"
  | "phone_holder"
  | "price"
  | "speedometer"
  | "scooterfyi_issue"
  | "vandalized";

/** Model-keyed bonus questions. Send only the key matching the ride's
 *  server-stamped `vehicle_model` — a mismatched or NULL-model key 422s. */
export interface SurveyModelBonus {
  /** COSMO: does it have a front basket? */
  cosmo_front_basket?: boolean;
  /** APOLLO: top speed, 0–40. */
  apollo_top_speed_mph?: number;
  /** ASTRO: is there a landscape phone holder that works? */
  astro_landscape_holder?: boolean;
}

export interface RideSurveyIn {
  would_ride_again?: boolean | null;
  was_perfect?: boolean | null;
  issues?: SurveyIssue[];
  model_bonus?: SurveyModelBonus;
  /** 1–10. */
  nav_route_rating?: number | null;
  nav_deviated?: boolean | null;
  nav_deviated_needs_improvement?: boolean | null;
  /** 0–10 recommendation score. */
  nav_nps?: number | null;
  /** Free text, ≤2000 chars; ≥20 chars after trimming earns the qualitative
   *  award. */
  nav_qualitative?: string | null;
  /** The route row Screen 4 stored. Submitting links it to this ride, which is
   *  what the nav distance bonus reads. A row already linked to another ride —
   *  or de-identified by the 28 h sweep — 422s; retry without it, forfeiting
   *  only the nav awards. */
  ride_route_id?: string | null;
}

export interface RideSurvey extends RideSurveyIn {
  id: string;
  tracked_ride_id: string;
  /** Stamped server-side from the device's model; NULL when unconfirmed. */
  vehicle_model: string | null;
  created_at: string;
}

/** The response echoes the stored row plus the awarded points. The row fields
 *  are typed optional (and a nested `survey` tolerated) because only `points`
 *  is load-bearing for Screen 9 — the echo is display sugar. */
export type RideSurveyResponse = Partial<RideSurvey> & {
  points: PointsAward[];
  survey?: RideSurvey;
};

/** Submit Screen 9. Owner-only, ride must be ended (409 `ride_not_ended`),
 *  single-shot (a second POST 409s). */
export function postSurvey(
  rideId: string,
  body: RideSurveyIn,
  signal?: AbortSignal,
): Promise<RideSurveyResponse> {
  return authedFetchJSON<RideSurveyResponse>(
    `/api/v1/tracked-rides/${encodeURIComponent(rideId)}/survey`,
    { method: "POST", body, signal },
  );
}

// --- Chosen route persistence (Screen 4) ----------------------------------

/** `[lat, lon]` — the order `POST /ride-routes` expects, and the reverse of
 *  GeoJSON coordinate order. */
export type LatLonPair = [number, number];

export interface PostRideRouteIn {
  /** Null in the normal wizard flow (Screen 4 precedes ride start); set only
   *  on the Screen 8 New-Destination loop, and then it must be a ride you own
   *  (404 otherwise). */
  tracked_ride_id?: string | null;
  /** A live `/route/profiles` key — `unknown_profile` 400s. */
  profile: string;
  origin: LatLonPair;
  destination: LatLonPair;
  /** Precision-5 encoded polyline of the chosen route's shape. */
  route_polyline: string;
  /** 0–80 000. */
  distance_meters: number;
  /** 0–10 800 (the 3 h watch window). */
  duration_seconds: number;
  /** 0–100, or null when the battery model is unavailable. */
  battery_percent_estimate?: number | null;
}

export interface PostRideRouteResponse {
  ride_route_id: string;
}

/** Persist the rider's Screen 4 choice — **only** when `nav_improvement` is
 *  on; that consent is what makes storing a route acceptable. Ships in API
 *  phase A3, so call it non-blocking and tolerate a 404 until then: only nav
 *  points are forfeited. Note the 404 arrives as an **ApiError with
 *  `status: 404`**, not a `NoDataError` — the 404-to-NoDataError mapping is the
 *  public `getJSON` path's, and this is an authed POST. Automatic off-route
 *  re-routes must never POST — the S4 choice stays the survey's subject.
 *  30/hour. */
export function postRideRoute(
  body: PostRideRouteIn,
  signal?: AbortSignal,
): Promise<PostRideRouteResponse> {
  return authedFetchJSON<PostRideRouteResponse>("/api/v1/ride-routes", {
    method: "POST",
    body,
    signal,
  });
}

// --- Routing --------------------------------------------------------------

/** One turn cue. Shape indices address the returned LineString's coordinate
 *  array (the API re-offsets Valhalla's leg-local indices). */
export interface RouteManeuver {
  instruction: string;
  /** Valhalla maneuver type code. */
  type: number;
  street_names: string[];
  length_meters: number;
  time_seconds: number;
  begin_shape_index: number;
  end_shape_index: number;
}

export interface RouteProperties {
  profile: string;
  label: string;
  distance_meters: number | null;
  duration_seconds: number;
  elevation_gain_meters: number;
  /** Only computed for `profile=shade` (or any profile with `explain`). */
  shade_score: number | null;
  /** Null whenever `battery_model` is "unavailable" — which is every request
   *  until enough observations accumulate. Render the route without it. */
  battery_percent_estimate: number | null;
  battery_model: "regression" | "unavailable";
  /** `[w, s, e, n]`, echoed on every response so clients can pre-filter. */
  graph_bbox: [number, number, number, number];
  /** Present only with `maneuvers: true`. */
  maneuvers?: RouteManeuver[];
  diagnostics?: Record<string, unknown>;
}

export type RouteResponse = GeoJSON.Feature<
  GeoJSON.LineString,
  RouteProperties
>;

export interface RouteQuery {
  from: LatLonPair;
  to: LatLonPair;
  /** Defaults to `safe` server-side. */
  profile?: string;
  /** `Astro` | `Cosmo` | `Apollo` — selects a model battery curve. */
  vehicle_model?: string;
  /** Adds `properties.maneuvers` for the nav HUD. */
  maneuvers?: boolean;
  explain?: boolean;
}

/** One route, as a GeoJSON Feature ready for a map source. Public and
 *  IP-rate-limited at 30/min — the budget that covers Screen 4's four
 *  parallel profile fetches plus the ≤1/min off-route re-route, so a 429
 *  here means back off for `ApiError.retryAfter` seconds.
 *
 *  Errors worth branching on: ApiError 400 `out_of_coverage` (an endpoint
 *  outside the routing graph → degrade, nav off, ride proceeds), 422
 *  `no_route_from_location` / `no_route`, and NoDataError 503
 *  `router_unavailable`. */
export function fetchRoute(
  q: RouteQuery,
  signal?: AbortSignal,
): Promise<RouteResponse> {
  return getJSON<RouteResponse>(
    `/api/v1/route${query({
      from: `${q.from[0]},${q.from[1]}`,
      to: `${q.to[0]},${q.to[1]}`,
      profile: q.profile,
      vehicle_model: q.vehicle_model,
      maneuvers: q.maneuvers ? "true" : undefined,
      explain: q.explain ? "true" : undefined,
    })}`,
    signal,
  );
}

export interface RouteProfile {
  key: string;
  label: string;
  shade_ranked: boolean;
}

export interface RouteProfilesResponse {
  default: string;
  graph_bbox: [number, number, number, number];
  profiles: RouteProfile[];
}

/** The live profile list (config-driven server-side — never hardcode it).
 *  IP-rate-limited at 60/min. */
export function fetchRouteProfiles(
  signal?: AbortSignal,
): Promise<RouteProfilesResponse> {
  return getJSON<RouteProfilesResponse>("/api/v1/route/profiles", signal);
}

// --- Geocoding (Screen 3) -------------------------------------------------

export type GeocodeKind = "house" | "street" | "poi" | "locality";

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
  kind: GeocodeKind;
  /** False when the point sits outside the routing graph — grey it out rather
   *  than failing at Screen 4. */
  in_coverage: boolean;
}

export interface GeocodeSearchResponse {
  results: GeocodeResult[];
}

export interface GeocodeSearchOptions {
  /** Proximity bias — pass the resolved GPS fix. */
  lat?: number;
  lon?: number;
  /** ≤8; the API defaults to 6. */
  limit?: number;
}

/** Denver-bboxed autocomplete over the self-hosted Photon sidecar. Public and
 *  IP-rate-limited at 20/min, so debounce (300 ms) and pass an AbortSignal.
 *  A NoDataError with `errorKey: "geocoder_unavailable"` means the sidecar is
 *  down — degrade to "type an address, no suggestions". */
export async function geocodeSearch(
  q: string,
  opts: GeocodeSearchOptions = {},
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const res = await getJSON<GeocodeSearchResponse>(
    `/api/v1/geocode/search${query({
      q,
      lat: opts.lat,
      lon: opts.lon,
      limit: opts.limit,
    })}`,
    signal,
  );
  return res?.results ?? [];
}

// --- Pricing + points schedule -------------------------------------------

export interface PricingResponse {
  /** Fractional sales-tax rate (e.g. 0.0881), config-driven server-side. */
  tax_rate: number;
  currency: string;
  as_of: string;
}

/** Tax rate for the Screen 8 cost breakdown. The client bakes an offline
 *  default in config.ts; this refreshes it. */
export function fetchPricing(signal?: AbortSignal): Promise<PricingResponse> {
  return getJSON<PricingResponse>("/api/v1/meta/pricing", signal);
}

/** One action's award rule. Flat awards carry `points`; formula-driven ones
 *  carry `base` + `per_step` + `step_km` (e.g. battery contribution is
 *  `base 8` + `per_step 2` every `step_km 2`, per started step). */
export interface PointsScheduleEntry {
  points?: number;
  base?: number;
  per_step?: number;
  step_km?: number;
}

/** The five ride-mode actions whose values are interpolated into the Screen 2
 *  ℹ copy and the Screen 9 header, so copy can never drift from the ledger. */
export type RideModePointsAction =
  | "battery_contribution"
  | "nav_route_feedback"
  | "nav_qualitative_feedback"
  | "nav_distance_bonus"
  | "ride_survey";

/** `GET /points/schedule` — the action → award map itself (the whole schedule,
 *  existing actions included). A flat award may serialize as a bare number
 *  instead of an entry object; read entries through `pointsScheduleEntry`. */
export type PointsScheduleResponse = Record<
  string,
  PointsScheduleEntry | number | undefined
>;

/** Normalizes either encoding to an entry, or null when the action is absent
 *  (offline, or an API older than the action). Callers fall back to the
 *  master plan's baked-in values on null. Never throws. */
export function pointsScheduleEntry(
  schedule: PointsScheduleResponse | null | undefined,
  action: string,
): PointsScheduleEntry | null {
  const raw = schedule?.[action];
  if (typeof raw === "number") return { points: raw };
  if (raw && typeof raw === "object") return raw;
  return null;
}

/** The authoritative action → points map for UI copy. Public; A1 ships the
 *  complete schedule including every ride-mode action, ahead of the award
 *  machinery. */
export function fetchPointsSchedule(
  signal?: AbortSignal,
): Promise<PointsScheduleResponse> {
  return getJSON<PointsScheduleResponse>("/api/v1/points/schedule", signal);
}

// --- Leaderboard (🏆 view) ------------------------------------------------

export interface LeaderboardEntry {
  /** Already composed server-side as `royalty_title + username` — render it
   *  as received; there is no separate title field. */
  display_name: string;
  points: number;
  /** Null when the account hasn't claimed colors. The API never invents a
   *  default — neutral fills are the frontend's decision — and `ruling_alpha`
   *  is nulled alongside the pair. */
  ruling_color: string | null;
  ruling_border_color: string | null;
  ruling_alpha: number | null;
}

export interface LeaderboardCell {
  total_points: number;
  distinct_earners: number;
  /** Null on an unclaimed cell (the launch-normal case). */
  leader: LeaderboardEntry | null;
  /** The remaining eligible stored ranks, in order; `leader` + these ≤ 3. */
  runners_up: LeaderboardEntry[];
}

export interface LeaderboardMapResponse {
  computed_at: string;
  window_start: string;
  window_end: string;
  /** Keyed by canonical H3 r8 cell **string** (not a decimal id — no
   *  hexdensity.ts-style shim needed). ~720 cells. */
  cells: Record<string, LeaderboardCell>;
}

/** The whole choropleth plus every cell's click-through detail in one fetch.
 *  Plain GET on every open by design: the endpoint's ETag +
 *  `Cache-Control: public, max-age=600` make a reopen within 10 minutes free
 *  and revalidate transparently after, so there is deliberately no
 *  conditional-request code here. */
export function fetchLeaderboardMap(
  signal?: AbortSignal,
): Promise<LeaderboardMapResponse> {
  return getJSON<LeaderboardMapResponse>("/api/v1/leaderboard/map", signal);
}

// --- Ride Usuals (Screen 2.5) --------------------------------------------

/** Cap per account, enforced server-side with a 409 at the cap. */
export const MAX_RIDE_USUALS = 10;

/** A Usual's blob: the ride options plus the rider's label for them. Opaque
 *  to the API (16 KB cap, no shape validation), so this type is the frontend's
 *  own contract with itself. */
export interface RideUsualSettings extends RideOptions {
  label: string;
}

export interface RideUsual {
  /** 1–64 chars, scoped to the account. */
  name: string;
  settings: RideUsualSettings;
  created_at: string;
  updated_at: string;
}

export interface RideUsualsResponse {
  ride_usuals: RideUsual[];
}

/** Saved presets, most recently updated first. Unwraps the envelope. */
export async function listRideUsuals(
  signal?: AbortSignal,
): Promise<RideUsual[]> {
  const res = await authedFetchJSON<RideUsualsResponse>(
    "/api/v1/profile/ride-usuals",
    { signal },
  );
  return res?.ride_usuals ?? [];
}

/** One preset. 404 when that name isn't yours. */
export function getRideUsual(
  name: string,
  signal?: AbortSignal,
): Promise<RideUsual> {
  return authedFetchJSON<RideUsual>(
    `/api/v1/profile/ride-usuals/${encodeURIComponent(name)}`,
    { signal },
  );
}

/** Create or replace a preset (wholesale — the API never merges blobs).
 *  409 at the 10-preset cap (overwriting an existing name still works),
 *  413 over 16 KB. */
export function putRideUsual(
  name: string,
  settings: RideUsualSettings,
  signal?: AbortSignal,
): Promise<RideUsual> {
  return authedFetchJSON<RideUsual>(
    `/api/v1/profile/ride-usuals/${encodeURIComponent(name)}`,
    { method: "PUT", body: { settings }, signal },
  );
}

/** Delete a preset. 404 when absent. */
export async function deleteRideUsual(
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  await authedFetchJSON<unknown>(
    `/api/v1/profile/ride-usuals/${encodeURIComponent(name)}`,
    { method: "DELETE", signal },
  );
}
