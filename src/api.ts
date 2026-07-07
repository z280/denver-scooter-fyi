// Typed client for the data.scooter.fyi public API.
// Contract: https://raw.githubusercontent.com/z280/veo-audit/main/API.md

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
  constructor(message: string, status: number) {
    super(message);
    this.name = "NoDataError";
    this.status = status;
  }
}

async function getJSON<T>(
  path: string,
  signal?: AbortSignal,
  parseText?: (text: string) => T,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (res.status === 503 || res.status === 404) {
    let detail = `No data (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body?.detail) detail = body.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new NoDataError(detail, res.status);
  }
  if (!res.ok) {
    throw new Error(`Request to ${path} failed: ${res.status}`);
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

// Mirrors the sessionStorage key map-auth.js keeps the auth blob under (a
// private const there). We only need it to eagerly drop a server-rejected
// token so the UI reflects the signed-out state, exactly as apiFetch does.
const AUTH_STORAGE_KEY = "scooter_fyi.map_auth";

/** Authenticated GET returning the raw response text, so the caller can parse
 *  the JSON itself and preserve the large-integer H3 fields that JSON.parse
 *  would round. Reimplements map-auth's apiFetch error contract — NO_AUTH,
 *  TOKEN_REJECTED (and clears the stale token), HTTP_ERROR with `status` —
 *  which fetchDevicesAuto's fallback keys off. This lives here rather than as
 *  a raw-text variant in map-auth.js because that file is a verbatim upstream
 *  copy that must not be modified. */
async function authedGetText(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const auth = getAuth();
  if (!auth) {
    const err: Error & { code?: string } = new Error("not authenticated");
    err.code = "NO_AUTH";
    throw err;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.token}`,
    },
  });
  if (res.status === 401) {
    try {
      sessionStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      /* sessionStorage unavailable — nothing to clear */
    }
    const err: Error & { code?: string } = new Error("token rejected");
    err.code = "TOKEN_REJECTED";
    throw err;
  }
  if (!res.ok) {
    const err: Error & { code?: string; status?: number } = new Error(
      `HTTP ${res.status}`,
    );
    err.code = "HTTP_ERROR";
    err.status = res.status;
    throw err;
  }
  return res.text();
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
 * On TOKEN_REJECTED, the helper has already cleared sessionStorage; the
 * caller should observe `isAuthenticated()` going false and re-render the
 * Account UI / prompt to sign back in.
 */
export async function fetchDevicesAuto(
  signal?: AbortSignal,
  include?: readonly DeviceInclude[],
): Promise<DevicesResponse> {
  if (!isAuthenticated()) return fetchDevices(signal, include);
  try {
    const text = await authedGetText(
      `/api/v1/private/devices/current${includeQuery(include)}`,
      signal,
    );
    return parseDevicesResponse(text);
  } catch (e) {
    const err = e as { code?: string; name?: string; status?: number };
    if (err?.name === "AbortError") throw e;
    // Fall back to public when the failure is "auth not usable" or "server
    // having a moment". Everything else (403 / 404 / other 4xx, network or
    // CORS errors which surface as TypeError with no `code`, malformed
    // responses) gets rethrown so it doesn't silently degrade behind a
    // working-looking public fetch.
    const fallbackable =
      err?.code === "NO_AUTH" ||
      err?.code === "TOKEN_REJECTED" ||
      (err?.code === "HTTP_ERROR" &&
        typeof err.status === "number" &&
        err.status >= 500 &&
        err.status < 600);
    if (!fallbackable) throw e;
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
