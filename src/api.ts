// Typed client for the data.scooter.fyi public API.
// Contract: https://raw.githubusercontent.com/z280/veo-audit/main/API.md

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

export interface DeviceProperties {
  device_id: string;
  form_factor: FormFactor;
  spatial_status: string;
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

/** Every Denver device's current position (no form_factor filter — filtered client-side). */
export function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
  return getJSON<DevicesResponse>("/api/v1/devices/current", signal);
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
