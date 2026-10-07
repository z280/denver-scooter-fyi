// Typed client for the fleet analytics endpoints (`/api/v1/analytics/*`).
//
// A module of its own rather than more of api.ts: api.ts is a chunk the map
// loads, and Rollup ships a module whole to every page that shares it, so
// these fetchers would ride along on the map for nothing. They use api.ts's
// public `getJSON` (same base URL, same NoDataError/ApiError handling).
// Contract: the API repo's API.md "Fleet analytics" and src/api_analytics.py.

import { getJSON } from "./api.ts";

/** Query-string builder that drops undefined/null params. */
function query(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}


export type AnalyticsGranularity = "hour" | "day" | "week" | "month";
/** The region layers the rollups are keyed by. `city` is all of Denver. */
export type AnalyticsRegionType =
  | "city"
  | "neighborhood"
  | "council_district"
  | "community_network";
export type AnalyticsRegionLayer = Exclude<AnalyticsRegionType, "city">;

/** Hourly buckets are capped server-side (api_analytics.MAX_DAYS). */
export const ANALYTICS_MAX_DAYS: Record<AnalyticsGranularity, number> = {
  hour: 31,
  day: 366,
  week: 366,
  month: 366,
};

interface AnalyticsWindow {
  /** UTC ISO; the window is [start, end). */
  window_start: string;
  window_end: string;
  timezone: string;
}

export interface AnalyticsModelBucket {
  /** Bucket start, Denver local, ISO 8601 WITH its offset. */
  bucket: string;
  by_model: Record<string, number>;
  total: number;
}

export interface AnalyticsRidesResponse extends AnalyticsWindow {
  granularity: AnalyticsGranularity;
  region: { type: AnalyticsRegionType; name: string };
  models: string[];
  series: AnalyticsModelBucket[];
  rides: number;
  /** Exclusive end of what the rollup has processed; null when empty. */
  data_through: string | null;
  definition: string;
}

export interface AnalyticsFailedStartsResponse extends AnalyticsWindow {
  granularity: AnalyticsGranularity;
  region: { type: AnalyticsRegionType; name: string };
  models: string[];
  series: (AnalyticsModelBucket & { stops_with_failures: number })[];
  failed_starts: number;
  stops_with_failures: number;
  data_through: string | null;
  definition: string;
  caveat: string;
  /** "2026-08-10" — a Denver calendar date. */
  undercount_since: string;
}

export interface AnalyticsRegionDevices {
  region: string;
  now: number | null;
  average: number | null;
  cycles: number;
}

export interface AnalyticsDevicesByRegionResponse extends AnalyticsWindow {
  granularity?: AnalyticsGranularity;
  region_type: AnalyticsRegionLayer;
  as_of: string | null;
  regions: AnalyticsRegionDevices[];
  definition: string;
  region_name?: string;
  series?: { bucket: string; average: number; cycles: number }[] | null;
}

export interface AnalyticsEquityResponse extends AnalyticsWindow {
  granularity: AnalyticsGranularity;
  threshold_percent: number;
  series: { bucket: string; percent: number; cycles: number; meets_threshold: boolean }[];
  buckets: number;
  buckets_meeting_threshold: number;
  definition: string;
}

export interface AnalyticsDwellCell {
  dwells: number;
  /** Null when the cell has fewer than `min_dwells_for_average` stops. */
  average_minutes: number | null;
}

export interface AnalyticsDwellResponse extends AnalyticsWindow {
  region_type: AnalyticsRegionType;
  models: string[];
  regions: { region: string; by_model: Record<string, AnalyticsDwellCell> }[];
  min_dwells_for_average: number;
  data_through: string | null;
  definition: string;
}

export interface AnalyticsFleetStatusBucket {
  bucket: string;
  available: number | null;
  in_use: number | null;
  out_of_service: number | null;
  /** Null before off-map was recorded (2026-10-07) — not zero. */
  off_map: number | null;
  cycles: number;
}

export interface AnalyticsFleetStatusResponse extends AnalyticsWindow {
  granularity: AnalyticsGranularity;
  model: string | null;
  series: AnalyticsFleetStatusBucket[];
  definition: string;
}

export interface AnalyticsFleetCountsResponse {
  as_of: string | null;
  visible_now: number | null;
  visible_now_by_model: Record<string, number>;
  ever_seen_total: number;
  ever_seen_by_model: Record<string, number>;
  ever_seen_since: string | null;
  definition: string;
}

/** Shared window/region parameters of the bucketed endpoints. */
export interface AnalyticsQuery {
  days: number;
  granularity: AnalyticsGranularity;
  regionType?: AnalyticsRegionType;
  /** Required by the API unless regionType is `city`. */
  regionName?: string | null;
}

function regionParams(q: AnalyticsQuery) {
  const rt = q.regionType ?? "city";
  return { region_type: rt, region_name: rt === "city" ? null : q.regionName };
}

export function fetchAnalyticsRides(q: AnalyticsQuery, signal?: AbortSignal) {
  return getJSON<AnalyticsRidesResponse>(
    `/api/v1/analytics/rides${query({ days: q.days, granularity: q.granularity, ...regionParams(q) })}`,
    signal,
  );
}

export function fetchAnalyticsFailedStarts(q: AnalyticsQuery, signal?: AbortSignal) {
  return getJSON<AnalyticsFailedStartsResponse>(
    `/api/v1/analytics/failed-starts${query({ days: q.days, granularity: q.granularity, ...regionParams(q) })}`,
    signal,
  );
}

export function fetchAnalyticsDevicesByRegion(
  regionType: AnalyticsRegionLayer,
  days: number,
  signal?: AbortSignal,
) {
  return getJSON<AnalyticsDevicesByRegionResponse>(
    `/api/v1/analytics/devices-by-region${query({ region_type: regionType, days })}`,
    signal,
  );
}

export function fetchAnalyticsEquity(
  days: number,
  granularity: AnalyticsGranularity,
  signal?: AbortSignal,
) {
  return getJSON<AnalyticsEquityResponse>(
    `/api/v1/analytics/equity-compliance${query({ days, granularity })}`,
    signal,
  );
}

export function fetchAnalyticsDwell(
  regionType: AnalyticsRegionType,
  days: number,
  signal?: AbortSignal,
) {
  return getJSON<AnalyticsDwellResponse>(
    `/api/v1/analytics/dwell${query({ region_type: regionType, days })}`,
    signal,
  );
}

export function fetchAnalyticsFleetStatus(
  days: number,
  granularity: AnalyticsGranularity,
  signal?: AbortSignal,
) {
  return getJSON<AnalyticsFleetStatusResponse>(
    `/api/v1/analytics/fleet-status${query({ days, granularity })}`,
    signal,
  );
}

export function fetchAnalyticsFleetCounts(signal?: AbortSignal) {
  return getJSON<AnalyticsFleetCountsResponse>("/api/v1/analytics/fleet-counts", signal);
}
