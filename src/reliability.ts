// Client-side reliability scoring: "will this scooter actually start after
// I walk to it?" Derived transparently from whatever signals the current
// fetch carried — quality flags and negative reports are public; failed
// starts and dwell time ride along on the authenticated endpoint today and
// join the public payload when the API promotes them. Fewer signals just
// means fewer devices leave the "ok" tier, never a wrong-side error.

export type ReliabilityTier = "ok" | "unknown" | "risk";

export interface ReliabilityInfo {
  tier: ReliabilityTier;
  /** Plain-language evidence, e.g. "idle 4d · 2 failed starts logged".
   *  Empty for a clean "ok". */
  reasons: string[];
}

/** Tier → dot color for the "Color dots by reliability" mode and popup
 *  badge. ok/risk reuse the app's pass/fail colors; unknown is the same
 *  amber as the mid battery bucket. */
export const RELIABILITY_COLOR: Record<ReliabilityTier, string> = {
  ok: "#238636",
  unknown: "#f5b400",
  risk: "#c62828",
};

export const RELIABILITY_LABEL: Record<ReliabilityTier, string> = {
  ok: "Likely rideable",
  unknown: "Unknown risk",
  risk: "High risk",
};

/** Subset of DeviceProperties the assessment reads. Values may arrive
 *  string-flattened when they ride through MapLibre feature properties. */
export interface ReliabilitySignals {
  is_disabled?: boolean | string | null;
  has_negative_report?: boolean | string | null;
  quality_designation?: string | null;
  number_failed_starts?: number | string | null;
  first_observed_at_location?: string | null;
  dwell_percentile_hood?: number | string | null;
  dwell_peer_median_hours?: number | string | null;
}

const TIER_RANK: Record<ReliabilityTier, number> = {
  ok: 0,
  unknown: 1,
  risk: 2,
};

/** The more pessimistic of two tiers. Used to merge the server's tier with
 *  the local assessment: the server can demote a device (it may see
 *  signals we can't) but never promote it past the public evidence. */
export function worstTier(a: ReliabilityTier, b: ReliabilityTier): ReliabilityTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** Clean dwell beyond this is the API's "ghost scooter" rule — recalibrated
 *  server-side from 96h to 72h (48h is already the citywide p90). Dwell and
 *  failed-start counters reset when a device moves, so every signal is
 *  scoped to its current parking spot. */
const GHOST_HOURS = 72;
/** One failed start is ambiguous alone (could be a rebalancer scan) but
 *  becomes damning combined with a day of nobody riding it. */
const CORROBORATION_HOURS = 24;
/** Peer-relative dwell outlier (API_REQUIREMENTS §1.4, now live): dwell
 *  percentile ≥90 among the H3-neighborhood peers AND ≥3× the peer median
 *  AND past the 24h floor. Combined with ≥48h dwell it demotes to risk. */
const OUTLIER_PERCENTILE = 90;
const OUTLIER_MEDIAN_RATIO = 3;
const OUTLIER_RISK_HOURS = 48;
/** Softer, earlier-warning version of the outlier check above: no
 *  percentile or absolute-hour floor, just the raw peer-median ratio —
 *  demotes to "unknown" rather than "risk". */
const UNKNOWN_DWELL_RATIO = 2;

/** Mirror of the API's recalibrated reliability formula (veo-audit
 *  src/quality.py, compute_reliability_tier) — first-match-wins:
 *
 *  high_risk: live negative report; ≥2 failed starts; 1 failed start
 *  combined with ≥24h dwell; ≥72h dwell with no failures (ghost); or a
 *  peer-relative dwell outlier (≥48h dwell, ≥p90 among H3 r9-kRing(1)
 *  neighbors, ≥3× the peer median).
 *  unknown: never state-tracked (no failed-start/dwell inputs); quality
 *  is undefined (disabled / reserved / no range data); exactly 1 failed
 *  start without enough dwell to corroborate it as risk; or dwell ≥2×
 *  the peer median (a softer, earlier-warning version of the risk-tier
 *  outlier check above — just the ratio, no percentile or floor).
 *  ok: everything else.
 *
 *  Reliability collapses only the FAILURE signals ("will it unlock?");
 *  battery lives in quality_designation and deliberately doesn't feed
 *  this. Used as the fallback when the server omits the tier and to
 *  build the human-readable reasons in every case. */
export function assessReliability(
  p: ReliabilitySignals,
  now: number = Date.now(),
): ReliabilityInfo {
  const failed = num(p.number_failed_starts);
  const idleHours = hoursSince(p.first_observed_at_location, now);

  // ---- high-risk checks run first, so a disabled scooter with failures
  // still surfaces as risk rather than hiding behind "unknown".
  if (truthy(p.has_negative_report)) {
    return { tier: "risk", reasons: ["negative report in the last 24h"] };
  }
  if (failed !== null && failed >= 2) {
    return { tier: "risk", reasons: [`${failed} failed starts logged`] };
  }
  if (
    failed === 1 &&
    idleHours !== null &&
    idleHours >= CORROBORATION_HOURS
  ) {
    return {
      tier: "risk",
      reasons: [`1 failed start + idle ${formatIdle(idleHours)}`],
    };
  }
  if (idleHours !== null && idleHours >= GHOST_HOURS) {
    return {
      tier: "risk",
      reasons: [`ghost scooter — idle ${formatIdle(idleHours)}`],
    };
  }

  // ---- peer-relative dwell outlier with ≥48h dwell → risk. Uses the
  // now-public dwell_percentile_hood / dwell_peer_median_hours fields so
  // the verdict can cite the neighborhood baseline.
  const pctile = num(p.dwell_percentile_hood);
  const peerMedian = num(p.dwell_peer_median_hours);
  if (
    idleHours !== null &&
    idleHours >= OUTLIER_RISK_HOURS &&
    pctile !== null &&
    pctile >= OUTLIER_PERCENTILE &&
    peerMedian !== null &&
    idleHours >= Math.max(CORROBORATION_HOURS, OUTLIER_MEDIAN_RATIO * peerMedian)
  ) {
    const ratio = peerMedian > 0 ? Math.round(idleHours / peerMedian) : null;
    return {
      tier: "risk",
      reasons: [
        `idle ${formatIdle(idleHours)}` +
          (ratio ? ` — ${ratio}× its block's typical ${formatIdle(peerMedian)}` : " — a neighborhood outlier"),
      ],
    };
  }

  // ---- unknown: no state tracking, quality undefined, a single
  // uncorroborated failed start, or a milder peer-relative dwell outlier.
  if (failed === null && idleHours === null) {
    return { tier: "unknown", reasons: ["not state-tracked yet"] };
  }
  if (truthy(p.is_disabled)) {
    return { tier: "unknown", reasons: ["marked out of service"] };
  }
  if (p.quality_designation === "N/A" || p.quality_designation === "n/a") {
    return { tier: "unknown", reasons: ["no quality data"] };
  }
  if (failed === 1) {
    return {
      tier: "unknown",
      reasons: ["1 failed start (unconfirmed — could be a rebalancer scan)"],
    };
  }
  if (
    idleHours !== null &&
    peerMedian !== null &&
    peerMedian > 0 &&
    idleHours >= UNKNOWN_DWELL_RATIO * peerMedian
  ) {
    const ratio = Math.round(idleHours / peerMedian);
    return {
      tier: "unknown",
      reasons: [
        `idle ${formatIdle(idleHours)} — ${ratio}× its block's typical ${formatIdle(peerMedian)}`,
      ],
    };
  }

  // ---- ok: everything else.
  const reasons: string[] =
    idleHours !== null && idleHours >= CORROBORATION_HOURS
      ? [`idle ${formatIdle(idleHours)}`]
      : [];
  return { tier: "ok", reasons };
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function hoursSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 3_600_000);
}

function formatIdle(hours: number): string {
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${minutes}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}
