// Rider stats: a handful of the best numbers about Denver's Veo fleet.
//
// WHAT IS ON THE PANEL. Up to seven cards, each one figure with its window and
// its sample on screen (`docs/ANALYTICS_PLAN.md`: every figure carries its
// window and sample; scooter.fyi reports, it does not argue):
//
//   now      vehicles on the map and how many are in use, plus the model mix
//            (`/devices/history/hourly`: the last feed cycle of this hour)
//   rides    rides yesterday and the busiest hour (`/analytics/rides`, hourly)
//   range    the median real-world range on the map right now, beside Veo's
//            own estimate (the map's already-loaded feed; drawer only)
//   gather   the neighbourhood with the most vehicles (`/analytics/devices-by-region`)
//   dwell    average time a parked vehicle waits for its next ride (`/analytics/dwell`)
//   equity   the Equity Area share in the contract's 6-9 AM window (`/compliance/daily/latest`)
//   outcomes "ended where they began" and "never left the spot" (`/fleet/outcomes`)
//
// Failed starts used to be the whole panel. They are one card now, last
// among the figures, because they are one fact about the fleet among several.
//
// EACH CARD STANDS ALONE. The fetches run in parallel and a failed one hides
// its own card, not the panel. A card also hides when what came back is not
// safe to show: a stale sample, or a window that reaches back across a
// counting change.
//
// COUNTING ERAS. Rides, dwell and failed starts were counted three different
// ways (changes at 2026-08-10 04:15Z and 2026-10-06 01:36Z; the API sends them
// as `counting_changes` and `comparable_since`). Every figure here is from the
// current era only: rides keep only buckets at or after `comparable_since`,
// dwell is requested over whole Denver days inside the era and dropped if the
// server's window starts earlier, and the outcome counters must have started
// after the fix. `KNOWN_COMPARABLE_SINCE` is a floor, not the answer: a newer
// `comparable_since` from the server always wins.
//
// THE VOICE. The same renderer serves `/embed/stats.html`, which
// weseeyouveo.com frames (`?voice=civic`). Same numbers, different verbs:
// `VOICES` selects words and nothing else. It must never select a different
// filter, window or threshold. The moment the two sites can disagree about a
// number, neither is worth quoting.

import {
  fetchCompliance,
  fetchDeviceHistoryHourly,
  fetchFleetOutcomes,
  type BoundaryLayer,
  type ComplianceResponse,
  type DeviceHistoryHour,
  type FleetOutcomesResponse,
} from "./api.ts";
import {
  fetchAnalyticsDevicesByRegion,
  fetchAnalyticsDwell,
  fetchAnalyticsRides,
  type AnalyticsCountingEras,
  type AnalyticsDevicesByRegionResponse,
  type AnalyticsDwellResponse,
  type AnalyticsRidesResponse,
} from "./analytics-api.ts";
import { formatKm, OBSERVED_METERS_PER_SOC_POINT } from "./range-facts.ts";
import { prettyRegion } from "./util.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const TZ = "America/Denver";

/** The latest counting change the frontend knows about (dc292b6). A floor:
 *  the server's own `comparable_since` overrides it when later. */
export const KNOWN_COMPARABLE_SINCE = "2026-10-06T01:36:00Z";

/** The last hourly fleet sample counts as "now" for this long. Past it the
 *  ingest has stalled and "right now" would be a lie. */
const NOW_MAX_AGE_MS = 90 * 60_000;

/** Neighbourhood averages are taken over this many days. Vehicle counts are
 *  snapshots, which no counting change touched. */
const GATHER_DAYS = 7;

/** Which site is rendering. The parameter behind `/embed/stats?voice=`.
 *
 *  `rider` is scooter.fyi: practical, second person where it helps.
 *  `civic` is weseeyouveo.com: the same figures in the third person.
 *  Neither changes what is counted. */
export type StatsVoice = "rider" | "civic";

export interface VoiceCopy {
  title: string;
  standfirst: string;
  now: { kicker: string; label: string; inUse: (n: string) => string; window: string };
  rides: {
    kicker: string;
    label: string;
    busiest: (hour: string, n: string, since: string) => string;
  };
  range: {
    kicker: string;
    label: string;
    veo: (km: string) => string;
    method: string;
    stale: (pct: string) => string;
    window: string;
  };
  gather: { kicker: string; label: string; line: (avg: string, now: string) => string };
  dwell: { kicker: string; label: string; method: string };
  equity: {
    kicker: string;
    label: (window: string) => string;
    verdict: (threshold: string, pass: boolean | null) => string;
  };
  outcomes: {
    kicker: string;
    label: (radius: string) => string;
    roundTrips: string;
    underFloor: (n: string) => string;
    stayedLabel: (radius: string) => string;
  };
  /** Shown when no card could be built. */
  unavailable: string;
  crossPromo: { lead: string; label: string; href: string };
}

// The outcome copy is the same in both voices on purpose: it is a definition,
// and a definition has one wording. "Ended where they began" is END
// displacement, so a round trip back to the rack counts; "never left the
// spot" is the maximum-distance counter and only ever labels that figure.
const OUTCOMES_COPY: VoiceCopy["outcomes"] = {
  kicker: "Back where it started",
  label: (r) => `of rentals ended within ${r} of where they began`,
  roundTrips: "That includes riders who rode off and came back to the same spot. The count does not say why.",
  underFloor: (n) => `rentals ended where they began, of ${n}. Too few for a rate yet.`,
  stayedLabel: (r) => `never left the spot: the vehicle never got more than ${r} from where it was unlocked.`,
};

export const VOICES: Record<StatsVoice, VoiceCopy> = {
  rider: {
    title: "Denver's Veo fleet, by the numbers",
    standfirst:
      "A few figures from Veo's public feed. Each says when it was counted and how many it was counted over.",
    now: {
      kicker: "Right now",
      label: "vehicles on the map",
      inUse: (n) => `${n} of them are out on a ride.`,
      window: "Latest feed update",
    },
    rides: {
      kicker: "Yesterday",
      label: "rides started in Denver",
      busiest: (h, n, since) => `Busiest hour since ${since}: ${h}, with ${n} rides.`,
    },
    range: {
      kicker: "Real-world range",
      label: "is how far a typical vehicle on the map will take you on its current charge",
      veo: (km) => `Veo's own estimate for the same vehicles: ${km}.`,
      method: `Ours is battery % × ${OBSERVED_METERS_PER_SOC_POINT} m, measured by following Denver vehicles from full to empty.`,
      stale: (p) => `${p} of these readings are from vehicles parked an hour or more, so the charge may be out of date.`,
      window: "Latest feed update",
    },
    gather: {
      kicker: "Where they gather",
      label: "has more vehicles on the map than any other neighbourhood",
      line: (avg, now) => `${avg} on average, ${now} right now.`,
    },
    dwell: {
      kicker: "Between rides",
      label: "is how long a parked vehicle waits for its next rider, on average",
      method: "Timed from arrival to departure at each stop. Stops still open, or longer than 30 days, are left out.",
    },
    equity: {
      kicker: "Equity Areas",
      label: (w) => `of the fleet was in Denver's Equity Areas, ${w}`,
      verdict: (t, pass) =>
        pass === null
          ? `The contract asks for at least ${t}.`
          : `The contract asks for at least ${t}; ${pass ? "this window met it" : "this window fell short"}.`,
    },
    outcomes: OUTCOMES_COPY,
    unavailable: "Stats are unavailable right now. The map is unaffected.",
    crossPromo: {
      lead: "Following Denver's scooter contract?",
      label: "We See You Veo",
      href: "https://weseeyouveo.com",
    },
  },
  civic: {
    title: "Denver's Veo fleet, measured",
    standfirst:
      "Counted by Scooter.fyi from Veo's public feed. Each figure gives the window and the sample it was counted over.",
    now: {
      kicker: "Right now",
      label: "vehicles in Veo's Denver feed",
      inUse: (n) => `${n} of them are on a ride.`,
      window: "Latest feed update",
    },
    rides: {
      kicker: "Yesterday",
      label: "rides started in Denver",
      busiest: (h, n, since) => `Busiest hour since ${since}: ${h}, with ${n} rides.`,
    },
    range: {
      kicker: "Real-world range",
      label: "is the median range of the fleet on its current charge",
      veo: (km) => `Veo's own estimate for the same vehicles: ${km}.`,
      method: `Scooter.fyi's figure is battery % × ${OBSERVED_METERS_PER_SOC_POINT} m, measured by following Denver vehicles from full to empty.`,
      stale: (p) => `${p} of these readings are from vehicles parked an hour or more, so the charge may be out of date.`,
      window: "Latest feed update",
    },
    gather: {
      kicker: "Where they gather",
      label: "has more vehicles in the feed than any other neighbourhood",
      line: (avg, now) => `${avg} on average, ${now} at the latest update.`,
    },
    dwell: {
      kicker: "Between rides",
      label: "is the average time a parked vehicle waits for its next rental",
      method: "Timed from arrival to departure at each stop. Stops still open, or longer than 30 days, are left out.",
    },
    equity: {
      kicker: "Equity Areas",
      label: (w) => `of the fleet was in Denver's official Equity Areas, ${w}`,
      verdict: (t, pass) =>
        pass === null
          ? `Exhibit B of the contract sets ${t}.`
          : `Exhibit B of the contract sets ${t}. ${pass ? "Met" : "Not met"} in this window.`,
    },
    outcomes: OUTCOMES_COPY,
    unavailable: "Stats are unavailable right now.",
    crossPromo: {
      lead: "Riding today?",
      label: "Scooter.fyi",
      href: "https://denver.scooter.fyi",
    },
  },
};

// ---------- Formatting ----------

/** A rate as a percentage with one decimal, or null straight through. */
export function formatRate(rate: number | null | undefined): string | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null;
  return `${(rate * 100).toFixed(1)}%`;
}

/** "about 1 in 20": shown beside the percentage, never instead of it. */
export function formatOdds(rate: number | null): string | null {
  if (rate === null || rate <= 0 || rate > 1) return null;
  return `about 1 in ${Math.round(1 / rate)}`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function formatMeters(m: number): string {
  return `${Math.round(m)} m`;
}

/** The popup's km rule (range-facts.ts), so the two never disagree. */
export { formatKm };

/** "5 h 42 min", or "48 min" under an hour. */
export function formatMinutes(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "October 6": an instant as a Denver calendar date. */
export function denverDay(d: Date, withWeekday = false): string {
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "long",
    day: "numeric",
    ...(withWeekday ? { weekday: "long" } : {}),
  });
}

/** "2026-10-07": the Denver calendar date of an instant. */
export function denverDateKey(d: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

function denverHour(d: Date): number {
  return Number(
    d.toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }),
  );
}

/** The instant of Denver midnight starting a YYYY-MM-DD date. */
export function denverMidnight(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  for (const offset of [6, 7, 5, 8]) {
    const t = new Date(Date.UTC(y, m - 1, d, offset));
    if (denverHour(t) === 0 && denverDateKey(t) === dateKey) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, 7));
}

function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days, 12));
  return t.toISOString().slice(0, 10);
}

/** "4–5 PM, October 6": one hour bucket in Denver time. */
export function hourRangeText(start: Date): string {
  return windowRangeText(start, new Date(start.getTime() + 3_600_000));
}

/** "6–9 AM, October 8": a window inside one Denver day. */
function windowRangeText(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: true });
  const [a, ap] = fmt(start).split(/\s+/u);
  const [b, bp] = fmt(end).split(/\s+/u);
  const range = ap === bp ? `${a}–${b} ${bp}` : `${a} ${ap}–${b} ${bp}`;
  return `${range}, ${denverDay(start)}`;
}

// ---------- Counting eras ----------

/** Where the current counting method begins for a response: its own
 *  `comparable_since`, or the known floor, whichever is later. */
export function eraStart(resp?: AnalyticsCountingEras | null): Date {
  const floor = new Date(KNOWN_COMPARABLE_SINCE);
  const own = parseDate(resp?.comparable_since ?? null);
  return own && own > floor ? own : floor;
}

/** How many whole Denver days, ending today, begin at or after `era`: the
 *  `days` to ask a day-aligned endpoint (dwell) for so its window does not
 *  reach back across the change. 0 when not even today qualifies. */
export function eraDays(era: Date, now: Date): number {
  let key = denverDateKey(now);
  let n = 0;
  while (denverMidnight(key) >= era && n < 366) {
    n += 1;
    key = shiftDateKey(key, -1);
  }
  return n;
}

// ---------- The data ----------

/** The fields of a live-feed vehicle the range card reads. Loose on purpose:
 *  the map's feature type may or may not declare `estimated_range_meters`. */
export interface RangeDevice {
  properties: {
    estimated_range_meters?: unknown;
    current_range_meters?: unknown;
    battery_reading?: unknown;
  };
}

/** Everything the cards are built from. Every source is nullable: null is
 *  "that fetch failed or was not made", and hides only its own card. */
export interface StatsData {
  now: Date;
  outcomes: FleetOutcomesResponse | null;
  fleet: DeviceHistoryHour | null;
  rides: AnalyticsRidesResponse | null;
  gather: AnalyticsDevicesByRegionResponse | null;
  dwell: AnalyticsDwellResponse | null;
  equity: ComplianceResponse | null;
  devices: readonly RangeDevice[] | null;
}

/** One card, before it becomes DOM. `meta` is the window and sample of each
 *  figure on the card; every card has at least one. */
interface CardModel {
  key: string;
  kicker: string;
  value: string;
  label: string;
  odds?: string | null;
  lines: { text: string; className?: string }[];
  meta: { window: string; sample: string }[];
  /** A second figure on the same card, with its own meta. */
  second?: { value: string | null; label: string; meta: { window: string; sample: string }; thin?: boolean };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------- Cards ----------

export function nowCard(data: StatsData, copy: VoiceCopy): CardModel | null {
  const f = data.fleet;
  const at = parseDate(f?.hour);
  if (!f || !at || f.total <= 0) return null;
  // The bucket is the hour; the sample is the last cycle in it. An hour
  // older than this means the ingest stalled.
  if (data.now.getTime() - at.getTime() > NOW_MAX_AGE_MS) return null;
  const lines: CardModel["lines"] = [];
  if (typeof f.reserved === "number") {
    lines.push({ text: copy.now.inUse(formatCount(f.reserved)) });
  }
  if (f.models) {
    const mix = Object.entries(f.models)
      .map(([model, c]) => [model, c.available + c.reserved + c.out_of_service] as const)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([model, n]) => `${model} ${formatCount(n)}`);
    if (mix.length > 0) lines.push({ text: mix.join(" · "), className: "stat-card__mix" });
  }
  return {
    key: "now",
    kicker: copy.now.kicker,
    value: formatCount(f.total),
    label: copy.now.label,
    lines,
    meta: [{ window: copy.now.window, sample: `all ${formatCount(f.total)} vehicles in the feed` }],
  };
}

export function ridesCard(data: StatsData, copy: VoiceCopy): CardModel | null {
  const r = data.rides;
  if (!r || !Array.isArray(r.series)) return null;
  const era = eraStart(r);
  const buckets = r.series
    .map((b) => ({ ...b, at: parseDate(b.bucket) }))
    .filter((b): b is typeof b & { at: Date } => b.at !== null && b.at >= era);
  const yesterday = shiftDateKey(denverDateKey(data.now), -1);
  // Yesterday counts only if all of it is in the current era and complete.
  if (denverMidnight(yesterday) < era) return null;
  const day = buckets.filter((b) => denverDateKey(b.at) === yesterday);
  if (day.length < 23 || day.some((b) => b.partial)) return null;
  const total = day.reduce((s, b) => s + b.total, 0);

  const lines: CardModel["lines"] = [];
  // The busiest hour is picked from whole Denver days inside the era, so
  // "since <date>" names a day the era fully covers.
  const firstDay = denverDateKey(era);
  const fromDay = denverMidnight(firstDay) >= era ? denverMidnight(firstDay) : denverMidnight(shiftDateKey(firstDay, 1));
  const complete = buckets.filter((b) => !b.partial && b.at >= fromDay);
  let busiestSample = "";
  if (complete.length > 0) {
    const top = complete.reduce((a, b) => (b.total > a.total ? b : a));
    const since = denverDay(complete[0].at);
    lines.push({ text: copy.rides.busiest(hourRangeText(top.at), formatCount(top.total), since) });
    busiestSample = `; busiest of ${formatCount(complete.length)} complete hours`;
  }
  return {
    key: "rides",
    kicker: copy.rides.kicker,
    value: formatCount(total),
    label: copy.rides.label,
    lines,
    meta: [{
      window: denverDay(denverMidnight(yesterday), true),
      sample: `${formatCount(total)} rides counted${busiestSample}`,
    }],
  };
}

export function rangeCard(data: StatsData, copy: VoiceCopy): CardModel | null {
  const devs = data.devices;
  if (!devs || devs.length === 0) return null;
  const ours: number[] = [];
  const veo: number[] = [];
  let stale = 0;
  for (const d of devs) {
    const e = num(d.properties.estimated_range_meters);
    if (e === null) continue;
    ours.push(e);
    const v = num(d.properties.current_range_meters);
    if (v !== null) veo.push(v);
    if (d.properties.battery_reading === "stale") stale += 1;
  }
  const m = median(ours);
  if (m === null) return null;
  const lines: CardModel["lines"] = [];
  const mv = median(veo);
  if (mv !== null) lines.push({ text: copy.range.veo(formatKm(mv)) });
  lines.push({ text: copy.range.method, className: "stat-card__method" });
  if (stale / ours.length >= 0.5) {
    lines.push({
      text: copy.range.stale(`${Math.round((stale / ours.length) * 100)}%`),
      className: "stat-card__method",
    });
  }
  return {
    key: "range",
    kicker: copy.range.kicker,
    value: formatKm(m),
    label: copy.range.label,
    lines,
    meta: [{ window: copy.range.window, sample: `median of ${formatCount(ours.length)} vehicles` }],
  };
}

export function gatherCard(data: StatsData, copy: VoiceCopy): CardModel | null {
  const g = data.gather;
  if (!g || !Array.isArray(g.regions)) return null;
  const ranked = g.regions.filter((r) => typeof r.average === "number" && r.cycles > 0);
  if (ranked.length === 0) return null;
  const top = ranked.reduce((a, b) => ((b.average ?? 0) > (a.average ?? 0) ? b : a));
  const start = parseDate(g.window_start);
  return {
    key: "gather",
    kicker: copy.gather.kicker,
    value: prettyRegion(top.region, g.region_type as BoundaryLayer),
    label: copy.gather.label,
    lines: [{
      text: copy.gather.line(
        formatCount(top.average ?? 0),
        top.now === null ? "none" : formatCount(top.now),
      ),
    }],
    meta: [{
      window: start ? `Since ${denverDay(start)}` : `Last ${GATHER_DAYS} days`,
      sample: `${formatCount(top.cycles)} feed cycles, ${formatCount(ranked.length)} neighbourhoods`,
    }],
  };
}

export function dwellCard(data: StatsData, copy: VoiceCopy): CardModel | null {
  const d = data.dwell;
  if (!d || !Array.isArray(d.regions)) return null;
  const start = parseDate(d.window_start);
  // A window that opens before the current counting method averages two
  // methods together. Not shown, rather than shown with a footnote.
  if (!start || start < eraStart(d)) return null;
  let weighted = 0;
  let n = 0;
  for (const region of d.regions) {
    for (const cell of Object.values(region.by_model)) {
      if (cell.average_minutes === null || cell.dwells <= 0) continue;
      weighted += cell.average_minutes * cell.dwells;
      n += cell.dwells;
    }
  }
  if (n === 0) return null;
  return {
    key: "dwell",
    kicker: copy.dwell.kicker,
    value: formatMinutes(weighted / n),
    label: copy.dwell.label,
    lines: [{ text: copy.dwell.method, className: "stat-card__method" }],
    meta: [{ window: `Since ${denverDay(start)}`, sample: `${formatCount(n)} stops` }],
  };
}

export function equityCard(data: StatsData, copy: VoiceCopy, threshold = 30): CardModel | null {
  const e = data.equity;
  const pct = num(e?.avg_percent_all_devices_equity ?? null);
  const start = parseDate(e?.window_start_ts);
  const end = parseDate(e?.window_end_ts);
  if (!e || pct === null || !start || !end) return null;
  const span = windowRangeText(start, end);
  return {
    key: "equity",
    kicker: copy.equity.kicker,
    value: `${pct.toFixed(1)}%`,
    label: copy.equity.label(span.split(",")[0]),
    // Only the server's boolean decides met / not met, never a rounding here.
    lines: [{ text: copy.equity.verdict(`${threshold}%`, e.compliance_equity_pass ?? null) }],
    meta: [{ window: span, sample: `${formatCount(e.snapshot_count)} feed cycles` }],
  };
}

/** "Since October 6": the outcome counters' window, from the server's record
 *  of when they were reset, as a Denver date. */
export function windowText(data: FleetOutcomesResponse): string {
  if (data.window === "since_reset") {
    const at = parseDate(data.counted_since_at);
    return at ? `Since ${denverDay(at)}` : "Since the counters were last reset";
  }
  if (data.window === "lifetime") return "All rentals we have seen";
  return data.window;
}

export function hasStayed(data: FleetOutcomesResponse): boolean {
  return typeof data.stayed_rentals === "number" && typeof data.stayed === "number";
}

export function outcomesCard(data: StatsData, copy: VoiceCopy): CardModel | null {
  const o = data.outcomes;
  if (!o || o.rentals <= 0) return null;
  // Failed starts were under-counted until the 2026-10-06 fix. A counter
  // window that opened before it (or an API too old to say) is not shown.
  const since = parseDate(o.counted_since_at);
  if (o.window !== "since_reset" || !since || since < new Date(KNOWN_COMPARABLE_SINCE)) {
    return null;
  }
  const c = copy.outcomes;
  const radius = formatMeters(o.radius_meters);
  const rate = formatRate(o.no_go_rate);
  const card: CardModel = {
    key: "outcomes",
    kicker: c.kicker,
    value: rate ?? formatCount(o.no_gos),
    label: rate ? c.label(radius) : c.underFloor(formatCount(o.rentals)),
    odds: rate ? formatOdds(o.no_go_rate) : null,
    lines: [{ text: c.roundTrips }],
    meta: [{
      window: windowText(o),
      sample: `${formatCount(o.no_gos)} of ${formatCount(o.rentals)} rentals`,
    }],
  };
  if (hasStayed(o)) {
    const sRate = formatRate(o.stayed_rate ?? null);
    const sSince = parseDate(o.stayed_counted_since);
    const n = formatCount(o.stayed_rentals ?? 0);
    card.second = {
      value: sRate,
      label: c.stayedLabel(formatMeters(o.stayed_radius_meters ?? 50)),
      thin: sRate === null,
      meta: {
        window: sSince ? `Since ${denverDay(sSince)}` : "Since the counter started",
        sample: sRate === null
          ? `${n} rentals; a rate needs ${formatCount(o.min_rentals_for_rate)}`
          : `${formatCount(o.stayed ?? 0)} of ${n} rentals`,
      },
    };
  }
  return card;
}

/** The cards in the order they appear. The lead is what the fleet is doing
 *  now; failed starts sit last among the figures. */
const CARD_BUILDERS = [nowCard, ridesCard, rangeCard, gatherCard, dwellCard, equityCard, outcomesCard];

export function buildCards(data: StatsData, voice: StatsVoice = "rider"): CardModel[] {
  const copy = VOICES[voice];
  const out: CardModel[] = [];
  for (const build of CARD_BUILDERS) {
    try {
      const card = build(data, copy);
      if (card) out.push(card);
    } catch (err) {
      // One malformed payload costs its own card, never the panel.
      console.error("stats card failed", err);
    }
  }
  return out;
}

function metaLine(meta: { window: string; sample: string }): HTMLElement {
  const p = el("p", "stat-card__meta");
  p.append(el("span", "stat-card__window", meta.window));
  p.append(document.createTextNode(" · "));
  p.append(el("span", "stat-card__sample", meta.sample));
  return p;
}

function renderCard(card: CardModel): HTMLElement {
  const section = el("section", "stat-card");
  section.dataset.card = card.key;
  section.append(el("h4", "stat-card__kicker", card.kicker));
  const fig = el("p", "stat-card__figure");
  fig.append(el("strong", "stat-card__value", card.value));
  fig.append(document.createTextNode(" "));
  fig.append(el("span", "stat-card__label", card.label));
  section.append(fig);
  if (card.odds) section.append(el("p", "stat-card__odds", card.odds));
  for (const line of card.lines) {
    section.append(el("p", line.className ? `stat-card__line ${line.className}` : "stat-card__line", line.text));
  }
  for (const m of card.meta) section.append(metaLine(m));
  if (card.second) {
    const s = card.second;
    const fig2 = el("p", s.thin ? "stat-card__figure stat-card__figure--second is-thin" : "stat-card__figure stat-card__figure--second");
    if (s.value) {
      fig2.append(el("strong", "stat-card__value stat-card__value--second", s.value));
      fig2.append(document.createTextNode(" "));
    }
    fig2.append(el("span", "stat-card__label", s.value ? s.label : capitalise(s.label)));
    section.append(fig2);
    section.append(metaLine(s.meta));
  }
  return section;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Build the panel from whatever loaded. Pure DOM, no fetching: the embed
 *  and the drawer share it, and the tests assert it without a network. */
export function buildFleetStats(
  data: StatsData,
  voice: StatsVoice = "rider",
): DocumentFragment {
  const copy = VOICES[voice];
  const frag = document.createDocumentFragment();
  frag.append(el("h3", "stats-title", copy.title));

  const cards = buildCards(data, voice);
  if (cards.length === 0) {
    frag.append(el("p", "stats-empty", copy.unavailable));
    return frag;
  }
  frag.append(el("p", "stats-standfirst", copy.standfirst));
  const grid = el("div", "stat-cards");
  for (const card of cards) grid.append(renderCard(card));
  frag.append(grid);

  // The story offer: between the figures and the cross-promotion, where a
  // reader has come to READ rather than to ride (docs/RIDER_VOICE_PLAN.md
  // §3.3). Mounted by the host, so this module stays a pure renderer.
  const storyHost = el("div", "stats-story");
  storyHost.dataset.role = "story-host";
  frag.append(storyHost);

  const promo = el("p", "stats-promo");
  promo.append(document.createTextNode(`${copy.crossPromo.lead} `));
  const link = el("a", undefined, copy.crossPromo.label);
  link.href = copy.crossPromo.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  promo.append(link);
  frag.append(promo);
  return frag;
}

// ---------- Loading ----------

/** A hung feed must become a missing card rather than leaving the drawer on
 *  its loading placeholder. The same number as `compliance.ts`. */
const STATS_FETCH_TIMEOUT_MS = 12_000;

export interface FleetStatsHooks {
  /** Fill the story slot once the figures are on screen. The embed does not
   *  mount one: a panel that posts a rider's words to a third party has no
   *  business inside somebody else's page frame. */
  mountStory?(host: HTMLElement): void;
  /** The map's already-loaded live feed, for the range card. Absent in the
   *  embed, which then shows no range card rather than pulling the whole
   *  feed (several MB) into somebody else's page for one median. */
  devices?(): readonly RangeDevice[] | null;
  /** Injectable clock, for tests. */
  now?(): Date;
}

async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** Dwell over whole Denver days inside the current era. If the server says
 *  the era began later than the floor, ask once more with that. */
async function loadDwell(now: Date, signal: AbortSignal): Promise<AnalyticsDwellResponse | null> {
  let era = eraStart(null);
  for (let attempt = 0; attempt < 2; attempt++) {
    const days = eraDays(era, now);
    if (days < 1) return null;
    const res = await fetchAnalyticsDwell("city", days, signal);
    const serverEra = eraStart(res);
    const start = parseDate(res.window_start);
    if (start && start >= serverEra) return res;
    if (serverEra.getTime() === era.getTime()) return null;
    era = serverEra;
  }
  return null;
}

/** Hourly rides from the start of the current era (capped at the API's 31
 *  days); the card drops any bucket before `comparable_since` itself. */
function loadRides(now: Date, signal: AbortSignal): Promise<AnalyticsRidesResponse> {
  const days = Math.min(31, Math.max(2, eraDays(eraStart(null), now) + 1));
  return fetchAnalyticsRides({ days, granularity: "hour" }, signal);
}

/** Fetch everything the cards need, in parallel, and render once. Every
 *  throw lands in a catch: a drawer stuck on "Loading…" is the failure mode
 *  this guards, because the placeholder is static markup. */
export async function renderFleetStats(
  root: HTMLElement,
  voice: StatsVoice = "rider",
  hooks: FleetStatsHooks = {},
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATS_FETCH_TIMEOUT_MS);
  const signal = controller.signal;
  try {
    const now = hooks.now?.() ?? new Date();
    const [outcomes, history, rides, gather, dwell, equity] = await Promise.all([
      settle(fetchFleetOutcomes(signal)),
      settle(fetchDeviceHistoryHourly(1, signal)),
      settle(loadRides(now, signal)),
      settle(fetchAnalyticsDevicesByRegion("neighborhood", GATHER_DAYS, signal)),
      settle(loadDwell(now, signal)),
      settle(fetchCompliance(signal)),
    ]);
    let devices: readonly RangeDevice[] | null = null;
    try {
      devices = hooks.devices?.() ?? null;
    } catch {
      devices = null;
    }
    const hours = history?.hours ?? [];
    const data: StatsData = {
      now,
      outcomes,
      fleet: hours.length > 0 ? hours[hours.length - 1] : null,
      rides,
      gather,
      dwell,
      equity,
      devices,
    };
    root.replaceChildren(buildFleetStats(data, voice));
    const storyHost = root.querySelector<HTMLElement>('[data-role="story-host"]');
    if (storyHost) hooks.mountStory?.(storyHost);
  } catch (err) {
    console.error("fleet stats failed", err);
    const copy = VOICES[voice];
    const frag = document.createDocumentFragment();
    frag.append(el("h3", "stats-title", copy.title));
    frag.append(el("p", "stats-empty", copy.unavailable));
    root.replaceChildren(frag);
  } finally {
    clearTimeout(timer);
  }
}
