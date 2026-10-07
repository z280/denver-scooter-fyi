// Fleet analytics: the pure half. API rows in, chart arrays and copy out.
//
// Everything the /analytics page SAYS is a function here, so it can be
// asserted without a DOM: the window line, the bucket labels, the sample
// sentences, the gap handling. The house rule (docs/ANALYTICS_PLAN.md, and the
// API's docs/PLAN_FLEET_ANALYTICS.md) is "never a figure without its window
// and its sample", and the cheapest way to keep it is to make the window and
// the sample come out of the same function call as the figure.
//
// TIME. Day, week (Monday) and month buckets are Denver calendar buckets, and
// each API `bucket` is a Denver-local ISO string with its offset. The page
// lays buckets out on an ORDINAL axis generated here from the window, so a
// bucket the API omitted (no rows) still has a slot — drawn as a gap on a
// line, an empty slot on a bar chart — instead of the neighbours closing up
// around it and hiding that anything is missing.

import type { BoundaryLayer } from "./api.ts";
import {
  ANALYTICS_MAX_DAYS,
  type AnalyticsGranularity,
  type AnalyticsModelBucket,
  type AnalyticsRegionType,
} from "./analytics-api.ts";
import { prettyRegion } from "./util.ts";

export const DENVER_TZ = "America/Denver";
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Denver calendar arithmetic
// ---------------------------------------------------------------------------

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DENVER_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  weekday: "short",
});

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  /** 0 = Monday … 6 = Sunday (ISO, as Postgres date_trunc('week') uses). */
  isoWeekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function denverParts(ms: number): LocalParts {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(ms)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    isoWeekday: WEEKDAYS[p.weekday] ?? 0,
  };
}

/** The UTC instant of a Denver wall-clock time. Denver is UTC-7 or UTC-6, so
 *  try both offsets and keep the one that round-trips; at a spring-forward
 *  gap neither does and the later offset wins (the hour does not exist). */
export function denverLocalToUtc(year: number, month: number, day: number, hour = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  for (const off of [7, 6]) {
    const ms = wall + off * HOUR_MS;
    const p = denverParts(ms);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour) return ms;
  }
  return wall + 6 * HOUR_MS;
}

/** Start of the Denver-local bucket that contains `ms`. */
export function truncateToBucket(ms: number, g: AnalyticsGranularity): number {
  if (g === "hour") return Math.floor(ms / HOUR_MS) * HOUR_MS;
  const p = denverParts(ms);
  if (g === "day") return denverLocalToUtc(p.year, p.month, p.day);
  if (g === "month") return denverLocalToUtc(p.year, p.month, 1);
  // week: back to Monday, through calendar days (Date.UTC normalises overflow)
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - p.isoWeekday));
  return denverLocalToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Start of the bucket after the one starting at `ms`. */
export function nextBucket(ms: number, g: AnalyticsGranularity): number {
  if (g === "hour") return ms + HOUR_MS;
  const p = denverParts(ms);
  const step = { day: [0, 1], week: [0, 7], month: [1, 0] }[g];
  const d = new Date(Date.UTC(p.year, p.month - 1 + step[0], p.day + step[1]));
  return denverLocalToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Every bucket start in [start, end), the first truncated to its bucket.
 *  Capped so a malformed window can never spin the page. */
export function bucketSlots(startIso: string, endIso: string, g: AnalyticsGranularity): number[] {
  const end = Date.parse(endIso);
  let t = truncateToBucket(Date.parse(startIso), g);
  const out: number[] = [];
  while (t < end && out.length < 9000) {
    out.push(t);
    t = nextBucket(t, g);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const fmt = (o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: DENVER_TZ, ...o });
const F_MONTH_DAY = fmt({ month: "short", day: "numeric" });
const F_MONTH_DAY_YEAR = fmt({ month: "short", day: "numeric", year: "numeric" });
const F_HOUR = fmt({ hour: "numeric" });
const F_MONTH_YEAR = fmt({ month: "short", year: "numeric" });
const F_MONTH = fmt({ month: "short" });
const F_DATETIME = fmt({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Full label for one bucket — tooltips and the data table. */
export function bucketLabel(ms: number, g: AnalyticsGranularity): string {
  switch (g) {
    case "hour":
      return `${F_MONTH_DAY.format(ms)}, ${F_HOUR.format(ms)}`;
    case "day":
      return F_MONTH_DAY.format(ms);
    case "week":
      return `Week of ${F_MONTH_DAY.format(ms)}`;
    case "month":
      return F_MONTH_YEAR.format(ms);
  }
}

/** Short label for an axis tick. */
export function tickLabel(ms: number, g: AnalyticsGranularity): string {
  if (g === "month") return F_MONTH.format(ms);
  return F_MONTH_DAY.format(ms);
}

/** Which slots get an axis tick: at most `maxTicks`, evenly spaced, and for
 *  hourly data only at Denver midnights (a "3 PM" tick says nothing about
 *  which day it is). */
export function pickTicks(slots: number[], g: AnalyticsGranularity, maxTicks: number): number[] {
  let candidates = slots.map((_, i) => i);
  if (g === "hour") {
    const midnights = candidates.filter((i) => denverParts(slots[i]).hour === 0);
    if (midnights.length) candidates = midnights;
  }
  const n = Math.max(1, Math.floor(maxTicks));
  if (candidates.length <= n) return candidates;
  const every = Math.ceil(candidates.length / n);
  return candidates.filter((_, k) => k % every === 0);
}

/** "Sep 7 – Oct 7, Denver time". The API window is [start, end) on the hour;
 *  a short window shows hours too, because "Oct 6 – Oct 7" for 24 hours
 *  reads as two days. Years only when the window crosses one. */
export function windowLabel(startIso: string, endIso: string): string {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return "Window unknown";
  if (e - s <= 3 * 24 * HOUR_MS) {
    return `${F_DATETIME.format(s)} – ${F_DATETIME.format(e)}, Denver time`;
  }
  const crossYear = denverParts(s).year !== denverParts(e).year;
  const f = crossYear ? F_MONTH_DAY_YEAR : F_MONTH_DAY;
  return `${f.format(s)} – ${f.format(e)}, Denver time`;
}

/** "Oct 7, 4:30 PM" in Denver, for as-of stamps. */
export function asOfLabel(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${F_DATETIME.format(ms)} Denver time` : "unknown";
}

/** "Aug 10, 2026" for a bare Denver date like "2026-08-10". */
export function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return F_MONTH_DAY_YEAR.format(denverLocalToUtc(y, m, d, 12));
}

export const commas = (n: number): string => n.toLocaleString("en-US");

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${commas(n)} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export const REGION_TYPE_LABELS: Record<AnalyticsRegionType, string> = {
  city: "All of Denver",
  neighborhood: "Neighborhood",
  council_district: "Council district",
  community_network: "Community network",
};

/** "NB_FivePoints" → "Five Points", "CD_9" → "Council District 9". */
export function regionLabel(name: string, type: AnalyticsRegionType): string {
  if (type === "city") return "Denver";
  return prettyRegion(name, type as BoundaryLayer);
}

/** Region names sorted the way a person scans a list: by label, numerically
 *  ("Council District 2" before "Council District 10"). */
export function sortRegionNames(names: string[], type: AnalyticsRegionType): string[] {
  return [...names].sort((a, b) =>
    regionLabel(a, type).localeCompare(regionLabel(b, type), "en", { numeric: true }),
  );
}

// ---------------------------------------------------------------------------
// Models: names and colors follow the entity, never its rank
// ---------------------------------------------------------------------------

/** The display order the cards and stacks use. The wire key for the
 *  three-wheeler has been both "Trike" and "Rover"; riders know it as Rover
 *  (model-catalog.ts MODEL_NAMES). */
const MODEL_ORDER = ["Cosmo", "Astro", "Apollo", "Rover"];

export function modelLabel(raw: string): string {
  const t = raw.trim();
  if (!t) return "Unknown";
  if (t.toLowerCase() === "trike") return "Rover";
  return t;
}

/** Known models first in a fixed order, then any others alphabetically,
 *  Unknown last. Deduplicates after relabelling. */
export function orderModels(raw: Iterable<string>): string[] {
  const labels = [...new Set([...raw].map(modelLabel))];
  const rank = (m: string) => {
    const i = MODEL_ORDER.indexOf(m);
    if (i >= 0) return i;
    return m === "Unknown" ? 1000 : 100;
  };
  return labels.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Categorical slots (css var names) — a model keeps its color whichever
 *  models a filter leaves on screen. */
export function modelColor(label: string): string {
  const i = MODEL_ORDER.indexOf(label);
  if (i >= 0) return `var(--viz-${i + 1})`;
  if (label === "Unknown") return "var(--viz-unknown)";
  // Unlisted models: stable by name, from the remaining slots.
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--viz-${5 + (h % 2)})`;
}

// ---------------------------------------------------------------------------
// Series → chart arrays
// ---------------------------------------------------------------------------

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
  /** One value per slot; null = no data (a gap), never coerced to 0. */
  values: (number | null)[];
  dashed?: boolean;
}

export interface SlotChart {
  slots: number[];
  granularity: AnalyticsGranularity;
  series: ChartSeries[];
}

/** Index API rows by their bucket instant. Rows whose bucket is not on the
 *  generated axis (a DST fold, a malformed string) are reported, not lost. */
function indexBuckets<T extends { bucket: string }>(rows: T[], slots: number[]) {
  const pos = new Map<number, number>();
  slots.forEach((t, i) => pos.set(t, i));
  const at = new Map<number, T>();
  const unplaced: T[] = [];
  for (const r of rows) {
    const i = pos.get(Date.parse(r.bucket));
    if (i === undefined) unplaced.push(r);
    else at.set(i, r);
  }
  return { at, unplaced };
}

/** Rides / failed starts: one stacked series per model.
 *
 *  A bucket the rollup has processed but has no row for is a real zero (no
 *  rides). A bucket at or after `data_through` has not been processed and is
 *  null. With no data_through (an empty rollup) everything is null. */
export function modelStacks(
  res: { window_start: string; window_end: string; granularity: AnalyticsGranularity; models: string[]; series: AnalyticsModelBucket[]; data_through: string | null },
): SlotChart & { unplaced: number } {
  const slots = bucketSlots(res.window_start, res.window_end, res.granularity);
  const through = res.data_through ? Date.parse(res.data_through) : -Infinity;
  const { at, unplaced } = indexBuckets(res.series, slots);
  const rawByLabel = new Map<string, string[]>();
  for (const raw of [...res.models, ...res.series.flatMap((r) => Object.keys(r.by_model))]) {
    const l = modelLabel(raw);
    const list = rawByLabel.get(l) ?? [];
    if (!list.includes(raw)) list.push(raw);
    rawByLabel.set(l, list);
  }
  const series = orderModels(rawByLabel.keys()).map((label) => ({
    key: label,
    name: label,
    color: modelColor(label),
    values: slots.map((t, i) => {
      const row = at.get(i);
      if (row) return (rawByLabel.get(label) ?? []).reduce((s, raw) => s + (row.by_model[raw] ?? 0), 0);
      // the slot's END must be processed for a missing row to mean zero
      const end = i + 1 < slots.length ? slots[i + 1] : nextBucket(t, res.granularity);
      return end <= through ? 0 : null;
    }),
  }));
  return { slots, granularity: res.granularity, series, unplaced: unplaced.length };
}

/** Line series from one numeric field each. Missing buckets and null values
 *  both stay null — the renderer breaks the line there. */
export function lineSeries<T extends { bucket: string }>(
  windowStart: string,
  windowEnd: string,
  granularity: AnalyticsGranularity,
  rows: T[],
  fields: { key: keyof T & string; name: string; color: string; dashed?: boolean }[],
): SlotChart {
  const slots = bucketSlots(windowStart, windowEnd, granularity);
  const { at } = indexBuckets(rows, slots);
  return {
    slots,
    granularity,
    series: fields.map((f) => ({
      key: f.key,
      name: f.name,
      color: f.color,
      dashed: f.dashed,
      values: slots.map((_, i) => {
        const v = at.get(i)?.[f.key];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      }),
    })),
  };
}

/** Split one value array into runs of consecutive non-null points — the
 *  polyline segments. A lone point between gaps is a one-point run (drawn as
 *  a dot by the renderer so it does not vanish). */
export function contiguousRuns(values: (number | null)[]): { start: number; values: number[] }[] {
  const runs: { start: number; values: number[] }[] = [];
  let cur: { start: number; values: number[] } | null = null;
  values.forEach((v, i) => {
    if (v === null) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { start: i, values: [] };
      runs.push(cur);
    }
    cur.values.push(v);
  });
  return runs;
}

/** Index of the slot that contains the instant `ms` (first slot at or after
 *  it when it falls before the axis); -1 when it is past the axis. */
export function slotIndexOf(slots: number[], ms: number): number {
  for (let i = 0; i < slots.length; i++) {
    const end = i + 1 < slots.length ? slots[i + 1] : Infinity;
    if (ms < end) return i;
  }
  return -1;
}

/** A "nice" axis maximum and step for 0..max with about `ticks` ticks. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

/** Largest stacked total across slots. */
export function stackMax(series: ChartSeries[]): number {
  if (!series.length) return 0;
  let m = 0;
  for (let i = 0; i < series[0].values.length; i++) {
    m = Math.max(m, series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  }
  return m;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface ControlsState {
  days: number;
  granularity: AnalyticsGranularity;
  regionType: AnalyticsRegionType;
  /** Null for the city, or while a layer's names are still loading. */
  regionName: string | null;
  /** Dwell's own layer (council district by default). */
  dwellLayer: AnalyticsRegionType;
}

export const WINDOW_OPTIONS = [1, 7, 14, 30, 90, 180, 365] as const;
export const GRANULARITIES: AnalyticsGranularity[] = ["hour", "day", "week", "month"];
export const REGION_TYPES: AnalyticsRegionType[] = [
  "city",
  "neighborhood",
  "council_district",
  "community_network",
];

export const DEFAULT_CONTROLS: ControlsState = {
  days: 7,
  granularity: "hour",
  regionType: "city",
  regionName: null,
  dwellLayer: "council_district",
};

/** Keep days inside the API's limit for the granularity (hour ≤ 31). */
export function clampDays(days: number, g: AnalyticsGranularity): number {
  const d = Math.round(days);
  if (!Number.isFinite(d) || d < 1) return 1;
  return Math.min(d, ANALYTICS_MAX_DAYS[g]);
}

/** Whether a window option can be offered at a granularity. */
export function windowAllowed(days: number, g: AnalyticsGranularity): boolean {
  return days <= ANALYTICS_MAX_DAYS[g];
}

/** Apply a change and restore the invariants: days within the cap, no
 *  region name for the city, a stale region name dropped on a layer change. */
export function updateControls(s: ControlsState, patch: Partial<ControlsState>): ControlsState {
  const next = { ...s, ...patch };
  if (patch.regionType !== undefined && patch.regionType !== s.regionType && patch.regionName === undefined) {
    next.regionName = null;
  }
  if (next.regionType === "city") next.regionName = null;
  next.days = clampDays(next.days, next.granularity);
  return next;
}

const isOneOf = <T extends string>(list: readonly T[], v: string | null): v is T =>
  v !== null && (list as readonly string[]).includes(v);

/** Read the controls from `?days=&g=&layer=&region=&dwell=`; anything bad
 *  falls back to the default rather than costing the page. */
export function controlsFromSearch(search: string): ControlsState {
  const q = new URLSearchParams(search);
  const g = q.get("g");
  const layer = q.get("layer");
  const dwell = q.get("dwell");
  const region = q.get("region");
  const days = Number(q.get("days"));
  return updateControls(DEFAULT_CONTROLS, {
    granularity: isOneOf(GRANULARITIES, g) ? g : DEFAULT_CONTROLS.granularity,
    days: q.has("days") && Number.isFinite(days) && days >= 1 ? days : DEFAULT_CONTROLS.days,
    regionType: isOneOf(REGION_TYPES, layer) ? layer : "city",
    regionName: region && /^[A-Za-z0-9_\-. ]{1,80}$/.test(region) ? region : null,
    dwellLayer: isOneOf(REGION_TYPES, dwell) ? dwell : DEFAULT_CONTROLS.dwellLayer,
  });
}

export function controlsToSearch(s: ControlsState): string {
  const q = new URLSearchParams();
  q.set("days", String(s.days));
  q.set("g", s.granularity);
  if (s.regionType !== "city") {
    q.set("layer", s.regionType);
    if (s.regionName) q.set("region", s.regionName);
  }
  if (s.dwellLayer !== DEFAULT_CONTROLS.dwellLayer) q.set("dwell", s.dwellLayer);
  return `?${q.toString()}`;
}

export const GRANULARITY_LABELS: Record<AnalyticsGranularity, string> = {
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
};

export function windowOptionLabel(days: number): string {
  if (days === 1) return "24 hours";
  if (days === 365) return "1 year";
  return `${days} days`;
}
