// Typed client for the fleet analytics endpoints (`/api/v1/analytics/*`).
//
// A module of its own rather than more of api.ts: api.ts is a chunk the map
// loads, and Rollup ships a module whole to every page that shares it, so
// these fetchers would ride along on the map for nothing. They use api.ts's
// public `getJSON` (same base URL, same NoDataError/ApiError handling).
// Contract: the API repo's docs/reference/API.md "Fleet analytics" and src/api_analytics.py.

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

/** Every bucketed row: its start, and whether it is incomplete. */
export interface AnalyticsBucket {
  /** Bucket start, ISO 8601 WITH its Denver offset. Hour buckets are true
   *  UTC hours, so the fall-back night has two "01:00" buckets told apart by
   *  their offsets (-06:00, then -07:00). */
  bucket: string;
  /** True when the bucket runs past what the data covers (the current day,
   *  week or month; failed starts past data_through): a count so far, not a
   *  total. Absent on complete buckets. */
  partial?: boolean;
}

export interface AnalyticsModelBucket extends AnalyticsBucket {
  by_model: Record<string, number>;
  total: number;
}

/** A change in HOW rides, stops or failed starts were counted (API
 *  api_analytics.COUNTING_CHANGES). Figures either side of `at` measure
 *  different things; a chart must not present the step as a change in Denver. */
export interface CountingChange {
  /** UTC ISO instant the new method took effect. */
  at: string;
  commit?: string;
  /** Which series it touched: "rides", "dwell", "failed_starts". */
  affects?: string[];
  summary: string;
}

/** Counting-era fields (API #122). All optional: an older API omits them. */
export interface AnalyticsCountingEras {
  /** The changes that affect THIS series, oldest first. */
  counting_changes?: CountingChange[];
  /** Where the current method begins: compare figures only after this. */
  comparable_since?: string | null;
}

export interface AnalyticsRidesResponse extends AnalyticsWindow, AnalyticsCountingEras {
  granularity: AnalyticsGranularity;
  region: { type: AnalyticsRegionType; name: string };
  models: string[];
  series: AnalyticsModelBucket[];
  rides: number;
  /** Exclusive end of what the rollup has processed; null when empty. */
  data_through: string | null;
  definition: string;
  caveat?: string;
}

export interface AnalyticsFailedStartsResponse extends AnalyticsWindow, AnalyticsCountingEras {
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
  /** UTC ISO end of the undercount (the counting fix). Absent from older
   *  responses, where the undercount was still open-ended. */
  undercount_until?: string;
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
  series?: (AnalyticsBucket & { average: number; cycles: number })[] | null;
}

export interface AnalyticsEquityResponse extends AnalyticsWindow {
  granularity: AnalyticsGranularity;
  threshold_percent: number;
  series: (AnalyticsBucket & { percent: number; cycles: number; meets_threshold: boolean })[];
  buckets: number;
  buckets_meeting_threshold: number;
  definition: string;
}

export interface AnalyticsDwellCell {
  dwells: number;
  /** Null when the cell has fewer than `min_dwells_for_average` stops. */
  average_minutes: number | null;
}

export interface AnalyticsDwellResponse extends AnalyticsWindow, AnalyticsCountingEras {
  region_type: AnalyticsRegionType;
  models: string[];
  regions: { region: string; by_model: Record<string, AnalyticsDwellCell> }[];
  min_dwells_for_average: number;
  data_through: string | null;
  definition: string;
  caveat?: string;
}

export interface AnalyticsFleetStatusBucket extends AnalyticsBucket {
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
  /** How many days the source keeps (device_status_snapshots is pruned at
   *  30). The endpoint refuses a longer `days` with a 400. */
  retention_days?: number;
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

/** fleet-status's own cap, for every granularity (API
 *  FLEET_STATUS_RETENTION_DAYS). The response's `retention_days` overrides it. */
export const FLEET_STATUS_RETENTION_DAYS = 30;

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
