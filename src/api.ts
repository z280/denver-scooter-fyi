// Typed client for the data.scooter.fyi public API.
// Contract: https://raw.githubusercontent.com/z280/veo-audit/main/API.md

import { apiFetch, isAuthenticated } from "./map-auth.js";

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
  | "community_network";

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
  // ----- Private fields (only populated via /api/v1/private/devices/current
  // when the user is signed in via map-auth). Undefined on public fetches.
  vehicle_plate?: string;
  first_observed_at_location?: string;
  number_failed_starts?: number;
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

/** Returned when an endpoint has no data yet (503 cold-start). */
export class NoDataError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "NoDataError";
    this.status = status;
  }
}

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
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
  return (await res.json()) as T;
}

/** Every Denver device's current position via the public endpoint. */
export function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
  return getJSON<DevicesResponse>("/api/v1/devices/current", signal);
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
): Promise<DevicesResponse> {
  if (!isAuthenticated()) return fetchDevices(signal);
  try {
    return await apiFetch<DevicesResponse>("/api/v1/private/devices/current", {
      signal,
      headers: { Accept: "application/json" },
    });
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
    return fetchDevices(signal);
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
