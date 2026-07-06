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
  ok: "#1b8a3f",
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
}

/** Server quality labels that carry no negative signal. The API's
 *  machine-trained scale runs poor < acceptable < good < great, with "N/A"
 *  meaning unassessed — only "poor" (or anything unrecognized) counts
 *  against a device. */
const CLEAN_QUALITY: ReadonlySet<string> = new Set([
  "ok",
  "acceptable",
  "good",
  "great",
  "N/A",
  "n/a",
]);

const TIER_RANK: Record<ReliabilityTier, number> = {
  ok: 0,
  unknown: 1,
  risk: 2,
};

/** The more pessimistic of two tiers. Used to merge the server's tier with
 *  the local evidence-based assessment: the server can demote a device but
 *  never promote it past what the public signals support. */
export function worstTier(a: ReliabilityTier, b: ReliabilityTier): ReliabilityTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function assessReliability(
  p: ReliabilitySignals,
  now: number = Date.now(),
): ReliabilityInfo {
  const reasons: string[] = [];
  let score = 0;

  if (truthy(p.is_disabled)) {
    score += 2;
    reasons.push("marked out of service");
  }
  if (truthy(p.has_negative_report)) {
    score += 1;
    reasons.push("open negative report");
  }
  // quality_designation is a free-form server label; the live API emits
  // "good" for healthy devices. Only clean designations pass — anything
  // unrecognized is treated as a caution, not silently ignored.
  const quality = p.quality_designation;
  if (quality && !CLEAN_QUALITY.has(quality)) {
    score += 1;
    reasons.push(`flagged ${quality.replace(/_/g, " ")}`);
  }
  const failed = num(p.number_failed_starts);
  if (failed !== null && failed > 0) {
    score += failed >= 3 ? 2 : 1;
    reasons.push(`${failed} failed start${failed === 1 ? "" : "s"} logged`);
  }
  const idleHours = hoursSince(p.first_observed_at_location, now);
  if (idleHours !== null && idleHours >= 48) {
    score += idleHours >= 7 * 24 ? 2 : 1;
    reasons.push(`idle ${formatIdle(idleHours)}`);
  }

  const tier: ReliabilityTier =
    score >= 3 ? "risk" : score >= 1 ? "unknown" : "ok";
  return { tier, reasons };
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
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}
