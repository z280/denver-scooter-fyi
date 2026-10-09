// Typed client for the data.scooter.fyi public API.
// Contract: https://github.com/z280/scooter-fyi-api/blob/main/docs/reference/API.md

import { clearStoredSessionIfToken } from "./auth-storage.ts";
import { getAuth, isAuthenticated } from "./map-auth.js";
import { WSYV_BASE } from "./config.ts";
import { trackApiError } from "./telemetry.ts";

// In production, the browser calls the API directly (CORS allows denver.scooter.fyi).
// In local dev, requests go through the Vite proxy (see vite.config.ts) because the
// API's CORS allowlist does not include localhost.
export const API_BASE = import.meta.env.DEV ? "" : "https://data.scooter.fyi";

export type FormFactor = "scooter" | "bicycle" | "unknown";

export type BoundaryLayer =
  // The city's official Equity Area map — the one the Veo contract binds,
  // as clarified in August 2026. The app draws this from a bundled copy
  // (see equity-areas.ts) rather than this endpoint, so that a rider is
  // never told the discount boundary is unavailable; the endpoint is the
  // same geometry and stays here for parity and for other consumers.
  | "equity"
  | "neighborhood"
  | "council_district"
  | "community_network"
  // ----- Retired equity maps. The API still computes, stores and serves
  // every one of these, and the compliance history runs back through them,
  // so they stay nameable. Nothing in the shipping UI draws them — see
  // config.ts's RETIRED_OVERLAYS.
  | "v1"
  | "v2"
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
  /** "Lunar 🐸" — a label a rider can say out loud, derived from the
   *  identifier and never stored (sql/073). */
  public_name?: string | null;
  /** "928" — the last three characters of the plate, as printed on the deck.
   *  This is what tells two Lunar 🐸s apart when you are standing between
   *  them, so it is on the public payload. The RAW plate is not on this payload
   *  (signed-in riders get it per nearby vehicle from `/vehicles/plates`,
   *  plates.ts); the suffix is public because Veo publishes the whole plate
   *  themselves in free_bike_status, keyed by the same id we emit as
   *  `device_id`.
   *  Null for a device whose plate we have never resolved. */
  plate_suffix?: string | null;
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
  /** Failed unlock/start attempts since the vehicle last proved it works
   *  (a relocation of ≥ 500 m clears it). Public. */
  number_failed_starts?: number;
  /** Failed starts among the last 3 completed rentals, 0–3; ≥ 2 is
   *  high risk on its own. Public (API sql/087). */
  recent_rentals_no_go?: number | null;
  /** Lifetime-since-reset rentals and how many ended within 25 m of the
   *  start (the "ended where they began" counter). */
  rentals_observed?: number | null;
  rentals_no_go?: number | null;
  /** Rentals since the stayed counter started (scooter-fyi-api#142) and how
   *  many of them never left 50 m of the unlock point. The Smart Ride grade
   *  is computed from these, so round trips do not count against a vehicle. */
  rentals_stayed?: number | null;
  rentals_observed_stayed_era?: number | null;
  /** Server grade; null until the vehicle has 5 rentals in the stayed era
   *  (so null for every vehicle on the first day after the deploy). Not
   *  rendered by this app yet; any UI that shows it must render null as
   *  "Not enough rides yet", never as a blank or a zero. */
  smart_ride_grade?: string | number | null;
  /** When the device first appeared at its current spot (dwell start). Public. */
  first_observed_at_location?: string;
  /** Peer-relative dwell: this device's dwell percentile among its H3
   *  neighborhood peers (0–100; null when <5 peers), and the peers'
   *  median dwell — the comparison baseline the reliability formula uses. */
  dwell_percentile_hood?: number | null;
  dwell_peer_median_hours?: number | null;
  // ----- Crowdsourced equipment (sql/055). `feature_status` is always on
  // the wire; `device_features` is null until somebody confirms the vehicle
  // (and a JSON string when it rides through MapLibre's property
  // flattening — `readDeviceFeatures` in device-features.ts handles both).
  feature_status?: string | null;
  device_features?: unknown;
  // ----- Client-derived (not on the wire): battery_percent (0–100) computed
  // against the observed-max range for the device's propulsion type, since
  // the public endpoint doesn't expose per-type `max_range_meters`.
  battery_percent?: number;
  // ----- Private fields — only via /api/v1/private/* (devices/lookup, trips)
  // when signed in. `vehicle_plate` is deliberately NOT on the public
  // endpoint (publishing live plates would let Veo reconcile our map against
  // their GBFS feed), so the "Unlock in Veo" deep link is authenticated-only;
  // ordinary signed-in riders get plates from `/vehicles/plates` (plates.ts).
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
  /** The contractual figure: the 6-9 AM window average against the city's
   *  official Equity Area map. Optional and nullable because a day that
   *  PREDATES the map has no value here until the server's reprocessing
   *  job reaches it — which the card renders as pending, not as a failure
   *  (see compliance.ts). */
  avg_percent_all_devices_equity?: number | null;
  compliance_equity_pass?: boolean | null;
  /** Set when the server's reprocessing job concluded this day CANNOT be
   *  measured against the official map (every 6-9 AM snapshot failed its
   *  reconstruction check) — `"low_fidelity"` or `"no_history"` today. The
   *  two fields above are then null for good: unmeasured, not failed.
   *  Optional because an API older than the field omits it. */
  equity_unmeasurable_reason?: string | null;
  /** Retired maps, still returned by the API and still the record for the
   *  period before the city named the official one. Not rendered. */
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
  /** Right-now share of the fleet inside the city's official Equity Area
   *  map. Optional: an API deployed before the map shipped omits it, which
   *  the card renders as pending rather than as 0%. */
  total_devices_equity?: number | null;
  percent_all_devices_equity?: number | null;
  /** Retired maps — see ComplianceResponse. */
  total_devices_v1: number;
  total_devices_v2: number;
  percent_all_devices_v1: number | null;
  percent_all_devices_v2: number | null;
}

// ---------- Compliance calendar ----------

/** How a single day reads on the compliance calendar. `no_data`,
 *  `pending` and `unmeasurable` are deliberately distinct from `fail`:
 *  the daily job never computed the day; the day predates the official map
 *  and the server's reprocessing job has not reached it; or the job reached
 *  it and found its data could not be reconstructed reliably enough to judge.
 *  None of them is Veo missing the target, and colouring any red would say
 *  it did. */
export type ComplianceDayStatus =
  | "pass"
  | "fail"
  | "no_data"
  | "pending"
  | "unmeasurable";

export interface ComplianceCalendarDay {
  /** YYYY-MM-DD, Denver-local. */
  date: string;
  /** Typed OPEN on purpose: the server documents `status` as a set that can
   *  grow (API.md → Stability commitments), and a value this build has never
   *  heard of must still render — neutrally, never as a failure. See
   *  compliance-calendar.ts's `renderedStatus`. */
  status: ComplianceDayStatus | (string & {});
  /** Window average for the day, or null when there isn't one. */
  percent: number | null;
  snapshot_count: number;
  /** Server-computed against Denver's clock — the visitor's may not be. */
  in_future: boolean;
}

export interface ComplianceCalendarMonth {
  /** YYYY-MM. */
  month: string;
  first_date: string;
  last_date: string;
  days: ComplianceCalendarDay[];
  pass_days: number;
  fail_days: number;
}

export interface ComplianceCalendarResponse {
  /** Which equity map the calendar was computed against. */
  group: string;
  /** The percentage the pass/fail colouring is drawn against. */
  threshold: number;
  /** Denver's today, so the client doesn't need its own clock. */
  today: string;
  /** Oldest month first. */
  months: ComplianceCalendarMonth[];
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
    trackApiError(path, res.status, errorKey);
    throw new NoDataError(
      errorMessage(detail, errorKey, `No data (${res.status})`),
      res.status,
      errorKey,
    );
  }
  if (!res.ok) {
    const err = await apiErrorFrom(res, `Request to ${path} failed: ${res.status}`);
    trackApiError(path, res.status, err.errorKey);
    throw err;
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
  /** JSON-serialized into the request body with Content-Type set — except a
   *  FormData, which is sent as-is with NO Content-Type, so the browser can
   *  write the multipart boundary (a fixed Content-Type loses it). */
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
  let body: string | FormData | undefined;
  if (init.body instanceof FormData) {
    body = init.body;
  } else if (init.body !== undefined) {
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
    const err = await apiErrorFrom(res, `HTTP ${res.status}`);
    trackApiError(path, res.status, err.errorKey);
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Vehicle plates (scooter-fyi-api #134). The caching, batching and budget
// rules live in plates.ts — the only caller of these two.
// ---------------------------------------------------------------------------

export interface VehiclePlatesResponse {
  /** device_id → plate; unknown / plateless ids are omitted. */
  plates: Record<string, string>;
  as_of: string;
}

/** `GET /api/v1/vehicles/plates` — signed-in only, 1–50 ids. */
export function fetchVehiclePlates(
  deviceIds: readonly string[],
): Promise<VehiclePlatesResponse> {
  const qs = deviceIds.map(encodeURIComponent).join(",");
  return authedFetchJSON<VehiclePlatesResponse>(
    `/api/v1/vehicles/plates?device_ids=${qs}`,
  );
}

export interface VehicleResolveResponse {
  device_id: string;
  vehicle_identifier: string;
}

/** `GET /api/v1/vehicles/resolve` — public; 404 (NoDataError) = no match or
 *  ambiguous. */
export function resolveVehiclePlate(plate: string): Promise<VehicleResolveResponse> {
  return getJSON<VehicleResolveResponse>(
    `/api/v1/vehicles/resolve?plate=${encodeURIComponent(plate)}`,
  );
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

/** One saved place as the account stores it. Deliberately the same five fields
 *  as `favorites.ts`'s `Favorite`, and the slot ids (`slot:home`, `slot:work`,
 *  `slot:custom1`, `slot:custom2`) travel as ordinary ids — the server has no
 *  notion of a slot and should not grow one. */
export interface SavedPlace {
  id: string;
  label: string;
  emoji: string;
  lat: number;
  lon: number;
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
  /** Server-computed adjective+emoji-noun pair, already presented as
   *  "Brave 🦉" — the capital and the space are the server's, so render
   *  it as received rather than re-composing it from the lexicon values
   *  (which stay lowercase). Change via the username endpoints, never
   *  via PUT /profile (it is ignored there). */
  public_username: string | null;
  show_public_username: boolean;
  show_in_leaderboards: boolean;
  rate_plan: ApiRatePlan | null;
  /** DEAD — kept typed because the server still sends it, and a field absent
   *  from this interface is one the next reader has to rediscover on the wire.
   *
   *  The app's theme is a DEVICE preference and always has been — `theme.ts`
   *  owns it in `scooter-fyi-theme` / `scooter-fyi-theme-sun`, with sun-sync
   *  resolved locally. Nothing reads this column. (Not to be confused with the
   *  per-ride `RideOptions.theme`, which §6.5 deleted for being inert: that one
   *  was meant to be Screen 4's route-preview basemap flavour and no screen
   *  ever read it either.)
   *
   *  Removing it is a cross-repo migration, not a client edit; until then
   *  `docs/USER_CONFIGURATION_AUDIT.md` is the record. */
  theme: string | null;
  /** SUPERSEDED BY `saved_places`, and the server migrates it on read.
   *
   *  It was the original plaintext JSONB column for saved places, which the
   *  frontend never learned to write — so on most accounts it is empty, and on
   *  the rest it holds rows from a build that predates `favorites.ts`. The
   *  server folds whatever is in here into `saved_places` the next time the
   *  profile is read, so this client neither reads nor writes it. Typed only
   *  so the field on the wire has a name.
   *
   *  Do not send it. A write here would land in a column that is on its way
   *  out and is not encrypted. */
  favorites: unknown[];
  /** Saved places, round-tripped through the account so they survive a new
   *  phone — the server half of `favorites.ts`.
   *
   *  ENCRYPTED AT REST server-side (API `src/place_crypto.py`): the column
   *  holds a Fernet token, not these objects, because "Home" next to a
   *  coordinate, an email and a phone number in one row is a dossier and a
   *  database dump should not contain it. The server can still decrypt — it
   *  has to, to serve them back — so this is encryption at rest, not
   *  end-to-end, and the privacy policy says exactly that.
   *
   *  Optional because an older deployment does not send it, and "the field was
   *  absent" must not read as "the rider has no saved places" — that
   *  difference is what stops a sync wiping the server copy. See
   *  `saved-places-sync.ts`. */
  saved_places?: SavedPlace[];
  /** DRAINING, like `favorites` above, and for the same reason: a rider's Home
   *  and Work are two of the four favourite SLOTS now, and the slots reach the
   *  account through `saved_places`. Nothing in this client writes these four
   *  any more — the map pins, the "Where to?" pinned pair and Screen 3's saved
   *  rows all read the slots, which works signed out and cannot disagree with
   *  the control that sets them.
   *
   *  Still READ in one place: `isProfileComplete`, which mirrors the server's
   *  own criteria for the ten-point completion award. That award is the last
   *  thing holding these columns up, and moving it is an API change. */
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
  badges: ProfileBadge[];
  /** Lifetime ride count and distance, server-computed like `badges`.
   *
   *  Optional because a client may be talking to an older deployment, and the
   *  §11.8 sentence it feeds must simply not appear rather than render
   *  "undefined". */
  ride_totals?: ProfileRideTotals;
}

/** §11.8's figures. `distanceFromRides` is the DENOMINATOR and travels with the
 *  distance on purpose: a NULL distance is summed as unknown rather than as
 *  zero, so a client showing "38 miles" drawn from 9 of 12 rides can say so. */
export interface ProfileRideTotals {
  rides: number;
  distance_meters: number;
  distance_from_rides: number;
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
    | "saved_places"
    | "royalty_title"
    | "ruling_color"
    | "ruling_border_color"
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

// ---------------------------------------------------------------------------
// Rider stories → We See You Veo
// ---------------------------------------------------------------------------
//
// The only calls in this file that leave our own infrastructure. They go to a
// second property, and they go there because a rider ticked a box naming it —
// see `rider-story.ts` for the consent rules these two functions serve.

/** The instrument's own value sets, fetched rather than copied.
 *
 *  The neighbourhood list is 80 entries and the survey REQUIRES a value from
 *  it exactly; a second hand-maintained copy in this repo would eventually
 *  offer a renamed neighbourhood and lose a real story at submit, after
 *  telling the rider it sent. So the list comes from the validator that
 *  enforces it.
 *
 *  A failure here is not fatal to the feature: the caller keeps the story
 *  locally and hides the send option, which is honest — we cannot file it
 *  correctly, so we do not pretend we can. */
export interface SurveyOptionsResponse {
  ok: boolean;
  version: string;
  neighborhoods: string[];
}

export async function fetchSurveyOptions(
  signal?: AbortSignal,
): Promise<SurveyOptionsResponse> {
  const res = await fetch(`${WSYV_BASE}/api/survey-options`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await apiErrorFrom(res, `survey options unavailable (${res.status})`);
  const body = (await res.json()) as SurveyOptionsResponse;
  if (!Array.isArray(body?.neighborhoods) || body.neighborhoods.length === 0) {
    throw new ApiError("survey options came back empty", "HTTP_ERROR", { status: res.status });
  }
  return body;
}

/** Send one story.
 *
 *  `PUT` with the draft's own id, which is what the receiving store is keyed
 *  on: a retry after a flaky network updates the same row rather than filing
 *  the rider's words twice.
 *
 *  Deliberately NOT `authedFetchJSON`. A story carries whatever identity the
 *  rider chose inside its payload — an anonymous one carries none — and
 *  attaching this app's credentials to a third-party disclosure would
 *  undo that choice without telling them. No cookies either: the receiving
 *  route's CORS never allows credentials. */
export async function submitRiderStory(
  draftId: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `${WSYV_BASE}/api/survey-responses/${encodeURIComponent(draftId)}`,
    {
      method: "PUT",
      signal,
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw await apiErrorFrom(res, `Story submission failed (${res.status})`);
}

export interface FleetOutcomeModel {
  model: string;
  rentals: number;
  no_gos: number;
  vehicles: number;
  /** Null under `min_rentals_for_rate` — the counts are still there, and the
   *  copy for that case is "not enough rides yet", not a hidden row. */
  no_go_rate: number | null;
  // ----- "Never left the spot" (scooter-fyi-api#142, sql/099). Optional
  // because an API older than that deploy does not send them.
  /** Rentals counted by the stayed counter (its own, younger window). */
  stayed_rentals?: number;
  /** Of those, how many never got more than `stayed_radius_meters` away. */
  stayed?: number;
  /** Null under `min_rentals_for_rate` stayed rentals. */
  stayed_rate?: number | null;
}

export interface FleetOutcomesResponse {
  /** "since_reset" (the API before sql/089 said "lifetime"). Rendered, never
   *  assumed: this is not today's rate, and an unlabelled percentage gets
   *  read as "now". */
  window: string;
  /** The migration that opened the window (sql/089, the counter reset). */
  counted_since: string;
  /** When that reset ran in production, ISO 8601; null if unknown. */
  counted_since_at?: string | null;
  /** The circle a no-go was counted against. The app holds three different
   *  ideas of how far is "moved" (see docs/ANALYTICS_PLAN.md §0.2), so the
   *  figure travels with the one it was measured at. */
  radius_meters: number;
  rentals: number;
  no_gos: number;
  no_go_rate: number | null;
  min_rentals_for_rate: number;
  vehicles: number;
  by_model: FleetOutcomeModel[];
  // ----- "Never left the spot" (scooter-fyi-api#142, sql/099). A different
  // question from `no_go_rate`: that one is END displacement inside
  // `radius_meters` (a round trip back to the rack counts); this one is the
  // MAXIMUM distance — the vehicle never got more than `stayed_radius_meters`
  // from where it was unlocked. It has its own, younger window. All optional:
  // an API older than that deploy sends none of them.
  /** "since_stayed_counter". */
  stayed_window?: string;
  /** When the stayed counter started, ISO 8601. */
  stayed_counted_since?: string | null;
  /** The migration that started it ("sql/099"). */
  stayed_counted_since_migration?: string | null;
  stayed_radius_meters?: number;
  /** Rentals the stayed counter has seen (the sample). */
  stayed_rentals?: number;
  stayed?: number;
  /** Null under `min_rentals_for_rate` stayed rentals. */
  stayed_rate?: number | null;
  /** The server's one-line definition, for tooltips/provenance. */
  stayed_definition?: string | null;
}

/** Share of rentals that ended where they began, fleet-wide and by model.
 *
 *  Degrades rather than throws on the server side: a database failure comes
 *  back as zeros, which the caller tells apart from a real zero by `rentals`.
 */
export function fetchFleetOutcomes(
  signal?: AbortSignal,
): Promise<FleetOutcomesResponse> {
  return getJSON<FleetOutcomesResponse>("/api/v1/fleet/outcomes", signal);
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

/** Per-day compliance pass/fail for whole calendar months.
 *
 *  `months` counts BACKWARDS from the current Denver month, so the default
 *  of 2 is "this month and last" — exactly what the calendar renders. The
 *  server returns every day of every month, including empty and future
 *  ones, so the grid never has to invent a cell. */
export function fetchComplianceCalendar(
  months = 2,
  signal?: AbortSignal,
): Promise<ComplianceCalendarResponse> {
  return getJSON<ComplianceCalendarResponse>(
    `/api/v1/compliance/calendar?count=${months}`,
    signal,
  );
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
/** Screen 2's Ride Mode Options, stored on the ride row as `ride_options`
 *  JSONB. Client-owned: the server echoes it back and reads only the booleans
 *  it gates awards on (`save_tracks`, `battery_modeling`, `nav_improvement`,
 *  `end_survey`, `own_device`). 4 KB cap, enforced server-side. */
export interface RideOptions {
  cost_hud: boolean;
  speedometer: SpeedometerStyle;
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

export interface ListTrackedRidesOptions {
  limit?: number;
  /** ISO timestamp; must carry a UTC offset per the API contract. */
  before?: string;
  status?: TrackedRideStatus;
}

export interface TrackedRideListResponse {
  count: number;
  /** List rows never carry `track_signing` (API.md, verbatim) — the type is the
   *  full `TrackedRide` shape only because that field, and the other owner-only
   *  extras, are already optional there. */
  rides: TrackedRide[];
}

/** The rider's recent tracked rides, newest first (API.md: owner-only).
 *
 *  THE ONE CLIENT FOR THIS ENDPOINT, and it was two for a while. `ride-post-s10.ts`
 *  built its own as a documented deviation — "added HERE rather than touching the
 *  shared api.ts ... flagged for the integrator to fold into api.ts properly
 *  whenever that file next gets touched" — and this module's first version of it
 *  arrived for §2.2's free-minute estimate without noticing, which made two
 *  clients for one endpoint with different signatures and different return shapes.
 *  Exactly the "two mechanisms that agree by coincidence" this program keeps
 *  deleting. Folded, as that note asked. */
export function listTrackedRides(
  opts: ListTrackedRidesOptions = {},
  signal?: AbortSignal,
): Promise<TrackedRideListResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before) params.set("before", opts.before);
  if (opts.status) params.set("status", opts.status);
  const qs = params.toString();
  return authedFetchJSON<TrackedRideListResponse>(
    `/api/v1/tracked-rides${qs ? `?${qs}` : ""}`,
    { signal },
  );
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

// --- Route feedback without a tracked ride (private rides) -----------------

/** The survey's navigation vocabulary with the route described inline —
 *  a private ("My own Device" / guest) ride has no tracked_rides row for
 *  `postSurvey` to key on and no ride_routes row to link, so the profile
 *  and the client's own distance/duration figures ride along instead. */
export interface RouteFeedbackIn {
  route_profile: string;
  distance_m?: number | null;
  duration_s?: number | null;
  nav_route_rating?: number | null;
  nav_deviated?: boolean | null;
  nav_deviated_needs_improvement?: boolean | null;
  nav_nps?: number | null;
  nav_qualitative?: string | null;
}

/** Submit navigation feedback for a ride the survey can't reach. Anonymous
 *  is allowed — guests are signed out, so there may be no auth token to
 *  send at all (auth here, not the ride-session doc: that is a different
 *  "session" this function never touches); a bearer token rides along when
 *  signed in, for attribution only — nothing is awarded either way,
 *  because private rides are never points-eligible. */
export async function postRouteFeedback(
  body: RouteFeedbackIn,
  signal?: AbortSignal,
): Promise<{ id: number; created_at: string }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const auth = getAuth();
  if (auth) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(`${API_BASE}/api/v1/route-feedback`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await apiErrorFrom(res, `HTTP ${res.status}`);
    trackApiError("/api/v1/route-feedback", res.status, err.errorKey);
    throw err;
  }
  return (await res.json()) as { id: number; created_at: string };
}

// --- Equity Area receipts (missed-discount reports) ------------------------
// The capture half of the equity-receipt plan (scooter-fyi-api
// docs/PLAN_EQUITY_RECEIPTS.md, "Phase 1: capture"). The rider sends what is
// printed on a Veo receipt plus two screenshots; matching it to a ride we saw
// in the feed is the server's job, later, so the response only says it landed.

/** The plan the rider says they were on. The RATE_PLANS keys (VeoPlus
 *  variants included — unlike `ApiRatePlan`, which the profile strips to its
 *  base, a receipt is judged against the exact plan) plus "not sure". */
export type DeclaredRatePlan =
  | "resident"
  | "resident_plus"
  | "visitor"
  | "visitor_plus"
  | "equity"
  | "unknown";

export interface DiscountReportIn {
  /** The scooter code as printed on the receipt, spaces already stripped. */
  vehicle_plate: string;
  trip_minutes: number;
  /** At least one of the two costs is required; both are integer cents. */
  subtotal_cents?: number;
  total_cents?: number;
  /** As printed: YYYY-MM-DD. */
  charge_date: string;
  /** ISO 8601 with an offset. Only breaks ties between same-length rides. */
  approx_started_at?: string;
  declared_rate_plan?: DeclaredRatePlan;
  pin_start?: { lat: number; lng: number };
  pin_end?: { lat: number; lng: number };
  receipt: Blob;
}

export interface DiscountReportResult {
  id: number;
  created_at: string;
  status: "received";
  receipt_stored: boolean;
}

/** The multipart body, field for field. Separate from the POST so a test can
 *  check exactly what goes over the wire. Optional fields are OMITTED rather
 *  than sent empty: the API reads an absent field as "not given", and an
 *  empty string as a malformed one. */
export function discountReportFormData(r: DiscountReportIn): FormData {
  const form = new FormData();
  form.set("vehicle_plate", r.vehicle_plate);
  form.set("trip_minutes", String(r.trip_minutes));
  if (r.subtotal_cents !== undefined) form.set("subtotal_cents", String(r.subtotal_cents));
  if (r.total_cents !== undefined) form.set("total_cents", String(r.total_cents));
  form.set("charge_date", r.charge_date);
  if (r.approx_started_at) form.set("approx_started_at", r.approx_started_at);
  if (r.declared_rate_plan) form.set("declared_rate_plan", r.declared_rate_plan);
  // Five decimals is about a metre: more than a hand-dropped pin means, and
  // the server rounds further anywhere public.
  if (r.pin_start) {
    form.set("pin_start_lat", r.pin_start.lat.toFixed(5));
    form.set("pin_start_lng", r.pin_start.lng.toFixed(5));
  }
  if (r.pin_end) {
    form.set("pin_end_lat", r.pin_end.lat.toFixed(5));
    form.set("pin_end_lng", r.pin_end.lng.toFixed(5));
  }
  form.set("receipt", r.receipt);
  // NO `plan_evidence`. The API stopped asking for a screenshot of the rider's
  // plan (owner, 2026-10-07; API sql/095) — `declared_rate_plan` above is taken
  // on trust. It ignores the part rather than rejecting it, so sending one would
  // have cost a rider an upload for bytes nobody reads.
  return form;
}

/** Send a receipt. Signed-in only (the endpoint is `require_session`, so the
 *  evidence has provenance): throws NO_AUTH / TOKEN_REJECTED like every other
 *  authed call, and an HTTP_ERROR ApiError carrying `status` and `errorKey`
 *  for the 422 / 413 / 429 cases the form explains to the rider. */
export function submitDiscountReport(
  r: DiscountReportIn,
  signal?: AbortSignal,
): Promise<DiscountReportResult> {
  return authedFetchJSON<DiscountReportResult>("/api/v1/reports/discount", {
    method: "POST",
    body: discountReportFormData(r),
    signal,
  });
}

// --- Admin analytics (telemetry_daily rollups) -----------------------------
// Both endpoints are require_admin server-side; the client only offers the
// Admin Tools buttons to a session the server has already called an admin
// (isAdminSession), but the endpoints enforce it regardless.

/** One `GET /private/analytics/daily` row — all-events per-day totals.
 *  `max_event_visitors` is a LOWER bound (per-event-name distinct counts
 *  can't be summed across names); page_load's count is the practical
 *  daily-active figure, which is what MAX picks up in practice. */
export interface AnalyticsDailyRow {
  day: string;
  events: number;
  max_event_visitors: number;
  max_event_sessions: number;
}

export function fetchAnalyticsDaily(
  days: number,
  signal?: AbortSignal,
): Promise<{ days: number; daily: AnalyticsDailyRow[] }> {
  return authedFetchJSON(`/api/v1/private/analytics/daily?days=${days}`, {
    signal,
  });
}

/** One `GET /private/analytics/events` row. May be several rows per day
 *  (the rollup is per city_id) — sum per day before charting. */
export interface AnalyticsEventDailyRow {
  day: string;
  city_id: number | null;
  events: number;
  visitors: number;
  sessions: number;
  prop_summary: unknown;
}

export function fetchAnalyticsEventDaily(
  name: string,
  days: number,
  signal?: AbortSignal,
): Promise<{ name: string; days: number; daily: AnalyticsEventDailyRow[] }> {
  return authedFetchJSON(
    `/api/v1/private/analytics/events?name=${encodeURIComponent(name)}&days=${days}`,
    { signal },
  );
}

// --- Fleet history (Tools → Devices over time) -----------------------------

/** Per-model slice of one hourly sample — the same three status counts the
 *  fleet-level fields carry, so every metric breaks down by model. A
 *  model's total is the three summed. */
export interface DeviceModelCounts {
  available: number;
  reserved: number;
  out_of_service: number;
}

/** One hourly fleet sample from `GET /devices/history/hourly` — the LAST
 *  observation cycle in that hour, Denver-core scope. The status/model
 *  breakdowns are null for hours predating the snapshot table (or an
 *  ingest outage): the total still comes from the core metrics, and null
 *  means "unknown", never zero. */
export interface DeviceHistoryHour {
  /** ISO timestamp truncated to the hour, e.g. "2026-08-10T14:00:00+00:00". */
  hour: string;
  total: number;
  available: number | null;
  reserved: number | null;
  out_of_service: number | null;
  /** Keyed by the feed's own model display names ("Astro", "Rover", …). */
  models: Record<string, DeviceModelCounts> | null;
}

/** Public — the same aggregate fleet count the map footer already shows,
 *  just over time. `days` is clamped server-side to 1..14. */
export function fetchDeviceHistoryHourly(
  days: number,
  signal?: AbortSignal,
): Promise<{ days: number; hours: DeviceHistoryHour[] }> {
  return getJSON(`/api/v1/devices/history/hourly?days=${days}`, signal);
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
  /** Present on every response while navigation is in beta: rider-facing
   *  text the API requires clients to show wherever directions are
   *  rendered. Server-controlled on purpose — the field disappears when
   *  directions leave beta, so never hardcode the copy; render it iff
   *  present. */
  beta_warning?: string | null;
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

/** The walk to the scooter — Valhalla pedestrian costing on the same tiles the
 *  ride profiles use (`GET /api/v1/route/walk`).
 *
 *  Deliberately not one of the ride profiles: those exclude the High Injury
 *  Network, which is a sensible thing to avoid riding along and a nonsense
 *  thing to avoid walking along. */
export interface WalkRoute {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: {
    mode: "walk";
    distance_meters: number;
    duration_seconds: number;
    maneuvers?: { instruction: string; begin_shape_index: number }[];
  };
}

export function fetchWalkRoute(
  from: [number, number],
  to: [number, number],
  opts: { maneuvers?: boolean } = {},
  signal?: AbortSignal,
): Promise<WalkRoute> {
  return getJSON<WalkRoute>(
    `/api/v1/route/walk${query({
      from: `${from[0]},${from[1]}`,
      to: `${to[0]},${to[1]}`,
      maneuvers: opts.maneuvers ? "true" : undefined,
    })}`,
    signal,
  );
}

/** One genuinely different road to the destination (`GET /route/options`).
 *
 *  The server routes every profile and groups by the shape that comes back, so
 *  this list has one entry per ROAD rather than one per profile name. `also`
 *  names the other profiles that produce this same road — folded, not hidden,
 *  so a rider looking for "the shaded one" can see that it is this one. */
/** A dibs claim, as the server records it.
 *
 *  The claim lives on the phone; this registers it so the CERTIFICATE can be
 *  verified by somebody who has no reason to trust the phone. `claimed_at` is
 *  the server's, which is the whole point — a timestamp the holder can edit
 *  settles no argument. */
export interface DibsRegistration {
  id: string;
  claimed_at: string;
  expires_at: string;
  verify_url: string;
  qr_url: string;
  /** Whether the server is actually watching this claim — NOT an echo of
   *  `notify_sms`. A claim with no account behind it has nobody to text, and
   *  an older server omits the field entirely, which is why this is
   *  optional: absent means "this build cannot tell you", and the app must
   *  not read that as yes. */
  watching?: boolean;
}

export function registerDibs(
  claim: {
    vehicle_identifier: string;
    vehicle_name: string;
    plate: string | null;
    claimed_by: string;
    provider?: string;
    device_type?: string;
    lat?: number | null;
    lon?: number | null;
    /** "Text me if this one goes out while my claim is live."
     *
     *  Sent per CLAIM rather than stored as an account preference, which is
     *  the server's rule too (sql/097): a claim made while the switch was on
     *  is honoured even if the rider turns it off an hour later, and one made
     *  while it was off never starts texting because they turned it on. */
    notify_sms?: boolean;
  },
  signal?: AbortSignal,
): Promise<DibsRegistration> {
  // SESSION-AUTHED, and the UI gates on it (see `canCallDibs` in devices.ts).
  //
  // It was not always: this used to be described as "unauthenticated on
  // purpose" so a signed-out rider could claim and appear on the certificate
  // as the anonymous form — but the call itself has always been
  // `authedFetchJSON`, which throws NO_AUTH before the request leaves the
  // browser. So a signed-out claim failed instantly, the caller's `.catch`
  // swallowed it, and the certificate reported "couldn't reach the server"
  // about a server it never called.
  //
  // Resolved by making the product match the code rather than the reverse:
  // dibs needs an account. A certificate that names nobody is weak evidence
  // in the argument it exists to settle, and an anonymous claim is free to
  // make in unlimited numbers.
  return authedFetchJSON<DibsRegistration>("/api/v1/dibs", {
    method: "POST",
    body: claim,
    signal,
  });
}

/** Somebody's live claim on a vehicle, as anyone can see it.
 *
 *  Public and unauthenticated: the second person in a dibs argument is
 *  exactly who needs this, and they may not have an account. Carries only the
 *  public handle the claimant chose — a name to argue with, not a way to find
 *  somebody. */
export interface VehicleDibs {
  id: string;
  claimed_by: string;
  claimed_at: string;
  expires_at: string;
  denver_time: string;
  certificate_url: string;
}

/** Every live claim in the city, keyed by vehicle identifier.
 *
 *  One small response per device refresh rather than a request per popup:
 *  dibs are rare, and this way the popup already knows the answer when it
 *  opens. */
export function liveDibs(
  signal?: AbortSignal,
): Promise<{ dibs: Record<string, VehicleDibs> }> {
  return getJSON<{ dibs: Record<string, VehicleDibs> }>("/api/v1/dibs/live", signal);
}

/** Give a claim back before it expires.
 *
 *  Fire-and-forget from the caller's point of view but NOT optional: the
 *  server row is what every other rider's map reads, and dropping only the
 *  local copy leaves that scooter dimmed for everyone else — and reading as a
 *  STRANGER's claim to the person who just released it, since "is this mine?"
 *  is answered by the local record they have already deleted.
 *
 *  Unauthenticated by design: possession of the claim id is the credential,
 *  exactly as it is for the certificate URL it appears in. */
/** "I've got it" — the claimant is riding the scooter they claimed.
 *
 *  THIS PREVENTS ONE WRONG TEXT. The server's alert fires on "a rental
 *  started on this vehicle", because that is the whole of what the fleet
 *  feed says; it cannot see whose rental it is. The commonest rental on a
 *  claimed scooter is the claimant's own, so without this the most ordinary
 *  path in the app would text the rider to say somebody had taken their
 *  scooter.
 *
 *  It does NOT release the claim — that is `releaseDibs`. The claim is still
 *  what the certificate rests on and still dims the scooter for everyone
 *  else until it expires.
 *
 *  Unauthenticated and fire-and-forget, like `releaseDibs`: possession of
 *  the unguessable claim id is the credential, and a rider who is about to
 *  unlock a scooter should not wait on us. */
export async function claimDibsAsMine(dibsId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/dibs/${encodeURIComponent(dibsId)}/mine`, {
    method: "POST",
    keepalive: true,
  });
}

export async function releaseDibs(dibsId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/dibs/${encodeURIComponent(dibsId)}/release`, {
    method: "POST",
    keepalive: true,
  });
}

export interface RouteOption {
  key: string;
  label: string;
  also: { key: string; label: string }[];
  distance_meters: number | null;
  duration_seconds: number;
  elevation_gain_meters: number | null;
  battery_percent_estimate: number | null;
  battery_percent_low: number | null;
  battery_percent_high: number | null;
  battery_model: string;
  /** What is left in the battery on arrival, given the charge that was passed
   *  in. Named by what the rider HAS on arrival, so `_low` is the bad case. */
  arrival_percent: number | null;
  arrival_percent_low: number | null;
  arrival_percent_high: number | null;
  /** Null when no starting charge was supplied — there is no honest answer
   *  without it, and a cheerful default would be the dishonest one. */
  will_make_it: boolean | null;
  reserve_percent: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

export interface RouteOptionsResponse {
  graph_bbox: [number, number, number, number];
  beta_warning?: string;
  /** Does the trip start / end outside the City and County of Denver?
   *  null when the API could not read the city boundary. */
  outside_city?: { from: boolean | null; to: boolean | null };
  /** Rider-facing text, present only when either end is outside the city:
   *  the route styles are shaped by City of Denver data that stops at the
   *  city line. Server-controlled like beta_warning: render it iff present. */
  outside_city_warning?: string | null;
  /** Profiles that could not be routed at all — the High Injury Network
   *  exclusions mean `safe` can legitimately find nothing where `express`
   *  does. Reported rather than silently dropped. */
  profiles_unavailable: string[];
  options: RouteOption[];
}

export function fetchRouteOptions(
  q: {
    from: [number, number];
    to: [number, number];
    vehicle_model?: string;
    battery_percent?: number | null;
  },
  signal?: AbortSignal,
): Promise<RouteOptionsResponse> {
  return getJSON<RouteOptionsResponse>(
    `/api/v1/route/options${query({
      from: `${q.from[0]},${q.from[1]}`,
      to: `${q.to[0]},${q.to[1]}`,
      vehicle_model: q.vehicle_model,
      battery_percent:
        q.battery_percent === null || q.battery_percent === undefined
          ? undefined
          : String(q.battery_percent),
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

/** `GET /api/v1/geocode/reverse` — our own reverse geocoder (scooter-fyi-api),
 *  which replaced the browser calling OpenStreetMap's Nominatim directly.
 *  Every field is null when the geocoder had nothing for it. */
export interface ReverseGeocodeResponse {
  /** Short display label, built server-side. */
  address: string | null;
  name: string | null;
  housenumber: string | null;
  street: string | null;
  locality: string | null;
  city: string | null;
  postcode: string | null;
}

/** Reverse-geocode one point. Public and IP-rate-limited (60/min). Throws
 *  like every getJSON client: NoDataError for 404 (nothing found) and 503
 *  (upstream down), ApiError for 400 (out of range) and 429 (with
 *  `retryAfter`). `geocode.ts` is the caller that caches and fails soft. */
export function fetchReverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<ReverseGeocodeResponse> {
  return getJSON<ReverseGeocodeResponse>(
    `/api/v1/geocode/reverse${query({ lat, lng })}`,
    signal,
  );
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
  /** Tiered entries (2026-10-06). Written route feedback: `points`, or
   *  `upper_points` once it reaches `upper_min_chars`. */
  upper_points?: number;
  upper_min_chars?: number;
  /** Dibs stand-down: `points` for an existing rider, this for a new one. */
  new_rider_points?: number;
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
   *  default — neutral fills are the frontend's decision. */
  ruling_color: string | null;
  ruling_border_color: string | null;
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
 *  **Live**: the API aggregates the points ledger per request rather than
 *  serving a nightly snapshot, so a hexagon changes hands within the minute
 *  someone takes it — which is what makes `hexdensity.ts`'s 90-second
 *  refresh tick worth having.
 *
 *  Plain GET on every call by design: the endpoint's ETag +
 *  `Cache-Control: public, max-age=30` collapse a burst of opens into one
 *  aggregate and revalidate transparently after, so there is deliberately no
 *  conditional-request code here. Never 503s — there is no scheduled run
 *  behind it that could be missing. */
export function fetchLeaderboardMap(
  signal?: AbortSignal,
): Promise<LeaderboardMapResponse> {
  return getJSON<LeaderboardMapResponse>("/api/v1/leaderboard/map", signal);
}

/** One row of the whole-region ranking. `rank` is display position among
 *  eligible entries (opted-out riders are dropped, not left as gaps), so it
 *  is always contiguous from 1. */
export interface LeaderboardRegionalEntry extends LeaderboardEntry {
  rank: number;
}

export interface LeaderboardRegionalResponse {
  computed_at: string;
  window_start: string;
  window_end: string;
  /** At most 25, and often fewer — the API caps eligible entries, not raw
   *  ones. Empty when nobody has earned points in the window. */
  leaders: LeaderboardRegionalEntry[];
}

/** `GET /leaderboard/regional` — the ledger aggregated at request time, which
 *  is what the panel's "(live)" label promises: points earned today are in
 *  this payload. It briefly lived at `/regional/live` while a stored nightly
 *  version still occupied `/regional`; nothing is stored any more, so the
 *  live one took the plain URL back. Same `max-age=30` and same
 *  never-503 guarantee as the map. */
export function fetchLeaderboardRegionalLive(
  signal?: AbortSignal,
): Promise<LeaderboardRegionalResponse> {
  return getJSON<LeaderboardRegionalResponse>(
    "/api/v1/leaderboard/regional",
    signal,
  );
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

// ---------------------------------------------------------------------------
// Ride specs — a rider's saved "ideal scooter" (sql/080). Same store and the
// same four handlers as the Usuals above, with a different kind and a cap of
// five; the API stores the blob verbatim and never reads inside it.
//
// `settings` is deliberately typed as an opaque record here rather than as
// `RideSpec`: the shape belongs to ride-spec.ts, which validates it on read
// (`readSpec`) precisely because nothing between here and the database will.
// Typing it strictly at the boundary would be a claim this layer cannot
// make good on — the server will hand back whatever an older or newer client
// stored.
// ---------------------------------------------------------------------------

export interface RideSpecRecord {
  name: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface RideSpecsResponse {
  ride_specs: RideSpecRecord[];
}

/** Saved specs, most recently updated first. Unwraps the envelope. */
export async function listRideSpecs(
  signal?: AbortSignal,
): Promise<RideSpecRecord[]> {
  const res = await authedFetchJSON<RideSpecsResponse>(
    "/api/v1/profile/ride-specs",
    { signal },
  );
  return res?.ride_specs ?? [];
}

/** Create or replace a spec (wholesale — the API never merges blobs).
 *  409 at the 5-spec cap (overwriting an existing name still works),
 *  413 over 16 KB, 422 on a name longer than 64 characters. */
export function putRideSpec(
  name: string,
  settings: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RideSpecRecord> {
  return authedFetchJSON<RideSpecRecord>(
    `/api/v1/profile/ride-specs/${encodeURIComponent(name)}`,
    { method: "PUT", body: { settings }, signal },
  );
}

/** Delete a spec. 404 when absent. */
export async function deleteRideSpec(
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  await authedFetchJSON<unknown>(
    `/api/v1/profile/ride-specs/${encodeURIComponent(name)}`,
    { method: "DELETE", signal },
  );
}

// ---------------------------------------------------------------------------
// Admin allowlist (GET/POST/DELETE /api/v1/private/admins). Admin-only —
// require_admin on every route, so a non-admin gets ApiError 403 and the UI
// that calls these is only ever rendered for admins anyway.
// ---------------------------------------------------------------------------

export interface AdminEntry {
  email: string;
  /** Who added them: an acting admin's email, a GitHub login from the
   *  portal, or "cli". Null for rows predating attribution. */
  added_by: string | null;
  added_at: string | null;
  /** Server-computed against the allowlist's own normalization, so the
   *  client never reimplements it to decide which row removes YOU. */
  is_you: boolean;
}

export interface AdminList {
  count: number;
  admins: AdminEntry[];
}

/** Both writes return the refreshed list alongside their result, so the UI
 *  redraws from the response instead of chasing it with a GET. */
export interface AdminWriteResult extends AdminList {
  email: string;
  added?: boolean;
  removed?: boolean;
}

export async function fetchAdmins(signal?: AbortSignal): Promise<AdminList> {
  return authedFetchJSON<AdminList>("/api/v1/private/admins", { signal });
}

/** Idempotent: re-adding an existing admin resolves with `added: false`
 *  rather than throwing. Throws ApiError 400 for a non-email. */
export async function addAdmin(email: string): Promise<AdminWriteResult> {
  return authedFetchJSON<AdminWriteResult>("/api/v1/private/admins", {
    method: "POST",
    body: { email },
  });
}

/** Throws ApiError 409 when the target is the last admin — the API refuses
 *  to leave the allowlist empty, because that locks every account out of
 *  the admin surface including this one. */
export async function removeAdmin(email: string): Promise<AdminWriteResult> {
  return authedFetchJSON<AdminWriteResult>(
    `/api/v1/private/admins?email=${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// Favorite Scooters (sql/081) — REMOVED from the client.
//
// `listFavoriteDevices`, `keepFavoriteDevice`, `updateFavoriteDevice` and
// `forgetFavoriteDevice` are gone, along with the `FavoriteDevice` type and the
// two server rules this comment used to spell out (the QR + 75 m gate, and the
// position withholding for a vehicle in use). Nothing in the app calls them any
// more: "Keep this one" has been replaced by "Notify me if moved", which is
// local, needs no account and no scan, and answers the question that feature
// was reaching for — see `device-notify.ts`'s header for the full argument.
//
// The ENDPOINTS still exist and still work; this is a client deletion, not a
// deprecation. Anything that wants them back can take them out of git history
// rather than out of a shim nobody calls.
// ---------------------------------------------------------------------------

