// Battery / range percentile helpers.
//
// Per UX spec: percentiles are computed from the set of UNIQUE range values
// (not the raw distribution). The motivation is that scooters tend to cluster
// on identical "full / depleted" range values broadcast by the vendor; using
// uniques lets the four buckets remain meaningful even when half the fleet
// reports the same headline number.

export type BatteryBucket = 0 | 1 | 2 | 3;

export interface BatteryThresholds {
  /** Quartile cut points derived from the sorted, unique range values. A
   *  device's bucket is the largest index whose threshold it meets or
   *  exceeds (with `p0` as the floor). */
  p0: number;
  p25: number;
  p50: number;
  p75: number;
  /** How many unique non-null range values informed the thresholds. */
  uniqueCount: number;
}

/** Bottom→top emoji labels, one per bucket. */
export const BATTERY_LABEL: Record<BatteryBucket, string> = {
  0: ":-(",
  1: ":-|",
  2: ":-)",
  3: ":D",
};

/** Bottom→top fill colors for the segmented filter UI and the Range
 *  colorize-by-mode on the map. Spec: red, yellow, lime green, dark green. */
export const BATTERY_COLOR: Record<BatteryBucket, string> = {
  0: "#c62828", // red
  1: "#f5b400", // yellow
  2: "#7ec850", // lime green
  3: "#1b8a3f", // dark green (matches --pass)
};

/** Color used on the Range colorize-by map for devices missing range data. */
export const BATTERY_MISSING_COLOR = "#9aa4ad";

/**
 * Compute quartile thresholds over the unique non-null, finite range values.
 * Returns null when there aren't enough unique values to make four
 * non-degenerate buckets (need at least 4 distinct numbers).
 */
export function computeBatteryThresholds(
  ranges: Iterable<number | null | undefined>,
): BatteryThresholds | null {
  const unique = new Set<number>();
  for (const r of ranges) {
    if (typeof r === "number" && Number.isFinite(r) && r >= 0) unique.add(r);
  }
  if (unique.size < 4) return null;
  const sorted = [...unique].sort((a, b) => a - b);
  const at = (frac: number): number => {
    // Lower-quartile convention: index = floor(frac * N). Anchors p25/p50/p75
    // to actual observed values so the buckets line up with discrete vendor
    // tiers (e.g. 25/50/75/100% battery).
    const i = Math.min(sorted.length - 1, Math.floor(frac * sorted.length));
    return sorted[i];
  };
  return {
    p0: sorted[0],
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    uniqueCount: sorted.length,
  };
}

/** Assign a device's range to one of the four buckets. Null/missing input
 *  returns null — caller decides how to render those (we paint them gray
 *  on the map and exclude them from the battery filter). */
export function bucketFor(
  meters: number | null | undefined,
  t: BatteryThresholds,
): BatteryBucket | null {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return null;
  if (meters < t.p25) return 0;
  if (meters < t.p50) return 1;
  if (meters < t.p75) return 2;
  return 3;
}
