// Rider reports, in rider words — the one place the report vocabulary turns
// into copy (docs/FLEET_REPORTS_PLAN.md §2.10, §4.6; owner 2026-10-09).
//
// THE RULE THIS MODULE SERVES: a report LABELS a scooter, it never hides one.
// Every negative report — not rideable (with a reason), damaged, dead battery,
// inaccessible, not found — makes the vehicle "High risk" until it is cleared;
// an anonymous one fades to "Unknown risk" after 24 h (never back to "Likely
// rideable"). The API folds that into `reliability_tier` and tells us WHY in
// `negative_report_*`. This module only turns those fields into sentences.
// Nothing here — and nothing that imports it — decides whether a vehicle is
// shown. `no-hiding-on-reports.test.ts` holds the rest of the app to that.
//
// `improperly_parked` is deliberately absent from the vocabulary below: it is
// a report to Veo and changes no label.
//
// Pure, DOM-free and dependency-free, so `reliability.ts` (also pure) can
// build its reasons from it.

/** The negative report types the API can name as a label's reason. */
export type NegativeReportType =
  | "not_rideable"
  | "damaged"
  | "dead_battery"
  | "inaccessible"
  | "not_found";

/** Why a scooter won't ride (`reason` on a `not_rideable` report, sql/100). */
export type NotRideableReason =
  | "acceleration"
  | "flat_tire"
  | "wheel"
  | "lighting"
  | "seat"
  | "handlebar";

/** The two decoys the "Why not?" picker also offers. They are not reasons but
 *  different reports; the SERVER re-files them (cannot_find → not_found,
 *  dead_battery → dead_battery), so every client gets the remap right. */
export type NotRideableDecoy = "cannot_find" | "dead_battery";

/** The "Why not?" picker, in the owner's order. `phrase` is how the reason
 *  reads inside a label: "High risk: reported not rideable (flat tire)". */
export const NOT_RIDEABLE_REASONS: readonly {
  reason: NotRideableReason;
  label: string;
  phrase: string;
}[] = [
  { reason: "acceleration", label: "Acceleration issue", phrase: "acceleration" },
  { reason: "flat_tire", label: "Flat tire(s)", phrase: "flat tire" },
  { reason: "wheel", label: "Wheel problem", phrase: "wheel" },
  { reason: "lighting", label: "Lighting problem", phrase: "lights" },
  { reason: "seat", label: "Seat problem", phrase: "seat" },
  { reason: "handlebar", label: "Handlebar problem", phrase: "handlebar" },
];

export const NOT_RIDEABLE_DECOYS: readonly {
  reason: NotRideableDecoy;
  label: string;
}[] = [
  { reason: "cannot_find", label: "Can't find it" },
  { reason: "dead_battery", label: "Dead battery" },
];

/** Short names, as a report is listed ("Last report: Inaccessible · Oct 8"). */
export const REPORT_TYPE_LABEL: Record<NegativeReportType, string> = {
  not_rideable: "Not rideable",
  damaged: "Damaged",
  dead_battery: "Dead battery",
  inaccessible: "Inaccessible",
  not_found: "Can't find it",
};

/** How a type reads after "reported" in a label. */
const REPORTED_PHRASE: Record<NegativeReportType, string> = {
  not_rideable: "not rideable",
  damaged: "damaged",
  dead_battery: "dead battery",
  inaccessible: "inaccessible",
  not_found: "not where the map says",
};

function isNegativeType(v: unknown): v is NegativeReportType {
  return typeof v === "string" && v in REPORT_TYPE_LABEL;
}

export function reasonPhrase(reason: unknown): string | null {
  return NOT_RIDEABLE_REASONS.find((r) => r.reason === reason)?.phrase ?? null;
}

export function reasonLabel(reason: unknown): string | null {
  return NOT_RIDEABLE_REASONS.find((r) => r.reason === reason)?.label ?? null;
}

/** "reported not rideable (flat tire)" / "reported inaccessible". A type we
 *  don't know (a newer API) still says something true. */
export function reportedPhrase(type: unknown, reason?: unknown): string {
  if (!isNegativeType(type)) return "reported by a rider";
  const why = type === "not_rideable" ? reasonPhrase(reason) : null;
  return `reported ${REPORTED_PHRASE[type]}${why ? ` (${why})` : ""}`;
}

/** "Not rideable (flat tire)" — the listed form. */
export function reportTypeLabel(type: unknown, reason?: unknown): string {
  if (!isNegativeType(type)) return "Problem reported";
  const why = type === "not_rideable" ? reasonPhrase(reason) : null;
  return `${REPORT_TYPE_LABEL[type]}${why ? ` (${why})` : ""}`;
}

/** The label a report puts on a scooter, from the `/devices/current` fields.
 *
 *  - `has_negative_report` → High risk (a signed-in report, or an anonymous
 *    one under 24 h).
 *  - `negative_report_risk: "unknown"` → Unknown risk (only faded anonymous
 *    reports stand).
 *  - neither → null: no report is shaping the label. Also null when the
 *    server's detail query failed and sent nulls — EXCEPT that a true
 *    `has_negative_report` still reads High risk, with a generic reason,
 *    because that flag comes from the payload's own query.
 *
 *  Values may arrive string-flattened through MapLibre, hence the loose
 *  boolean read. */
export interface ReportRiskSignals {
  has_negative_report?: boolean | string | null;
  negative_report_risk?: string | null;
  negative_report_reason?: string | null;
  negative_report_reason_detail?: string | null;
}

export interface ReportRisk {
  risk: "high_risk" | "unknown";
  /** "reported not rideable (flat tire)" */
  phrase: string;
}

export function reportRisk(p: ReportRiskSignals): ReportRisk | null {
  const flagged =
    p.has_negative_report === true || p.has_negative_report === "true";
  const phrase = reportedPhrase(
    p.negative_report_reason,
    p.negative_report_reason_detail,
  );
  if (flagged || p.negative_report_risk === "high_risk") {
    return { risk: "high_risk", phrase };
  }
  if (p.negative_report_risk === "unknown") return { risk: "unknown", phrase };
  return null;
}

/** One line under the label that is specific to the report, when there is
 *  something worth saying. Inaccessible must DISCOURAGE retrieval (§2.1): a
 *  label that sends somebody over a fence to prove a point is worse than no
 *  label. */
export function reportRiskNote(p: ReportRiskSignals): string | null {
  const r = reportRisk(p);
  if (!r) return null;
  if (p.negative_report_reason === "inaccessible") {
    return "Fenced in, locked inside or on private property — don't go in.";
  }
  if (r.risk === "unknown") {
    return "Anonymous report over a day old — not confirmed.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The latest report — the details tile's "Last report: …" line (§4.6(8))
// ---------------------------------------------------------------------------

export interface LatestReport {
  report_type: string;
  reason: string | null;
  observed_at: string | null;
  reported_at: string | null;
  anonymous: boolean;
}

/** `latest_report` as it survives the map: a real object on the raw-GeoJSON
 *  path, a JSON string through MapLibre's property flattening, `null` or
 *  garbage when there is none. */
export function readLatestReport(raw: unknown): LatestReport | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    if (!v || v === "null") return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.report_type !== "string" || !o.report_type) return null;
  return {
    report_type: o.report_type,
    reason: typeof o.reason === "string" ? o.reason : null,
    observed_at: typeof o.observed_at === "string" ? o.observed_at : null,
    reported_at: typeof o.reported_at === "string" ? o.reported_at : null,
    anonymous: o.anonymous === true || o.anonymous === "true",
  };
}

const DENVER = "America/Denver";

/** "Oct 8" — the calendar date in Denver, which is the date the rider means. */
export function denverShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER,
    month: "short",
    day: "numeric",
  }).format(new Date(t));
}

/** "Last report: Inaccessible · Oct 8 (anonymous)". Null when there is none —
 *  the tile then shows nothing at all. */
export function latestReportLine(raw: unknown): string | null {
  const r = readLatestReport(raw);
  if (!r) return null;
  const date = denverShortDate(r.observed_at ?? r.reported_at);
  return (
    `Last report: ${reportTypeLabel(r.report_type, r.reason)}` +
    (date ? ` · ${date}` : "") +
    (r.anonymous ? " (anonymous)" : "")
  );
}

// ---------------------------------------------------------------------------
// "When did you notice?" — preset chips, never a date input
// ---------------------------------------------------------------------------
//
// The device popup is reachable mid-ride on a long press, and a native date
// input is edited by WebKit itself — it cannot be kept out of iOS's
// shake-to-undo queue (`ios-shake-undo.ts`; `undo-free-coverage.test.ts`
// fails on one). Four chips also beat a calendar for a question whose honest
// answers are this coarse.

export type ObservedPreset = "today" | "yesterday" | "few_days" | "week";

export const OBSERVED_PRESETS: readonly {
  preset: ObservedPreset;
  label: string;
  /** Days before today, in Denver. */
  daysAgo: number;
}[] = [
  { preset: "today", label: "Today", daysAgo: 0 },
  { preset: "yesterday", label: "Yesterday", daysAgo: 1 },
  { preset: "few_days", label: "2–3 days ago", daysAgo: 2 },
  { preset: "week", label: "About a week ago", daysAgo: 7 },
];

/** Denver's calendar date `daysAgo` before `now`, as `YYYY-MM-DD`. */
export function denverDateDaysAgo(daysAgo: number, now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DENVER,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Calendar arithmetic on the Denver date itself, at UTC noon, so no DST
  // edge can move it a day.
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 12));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** The `observed_at` to send for a preset, or undefined for "Today": the API
 *  defaults to the submission time, which is more precise than a date the
 *  server would read as Denver midnight. "2–3 days ago" sends two days back —
 *  the later of the two, so a report never claims to be older than it is. */
export function observedAtFor(
  preset: ObservedPreset,
  now: number = Date.now(),
): string | undefined {
  const spec = OBSERVED_PRESETS.find((p) => p.preset === preset);
  if (!spec || spec.daysAgo === 0) return undefined;
  return denverDateDaysAgo(spec.daysAgo, now);
}
