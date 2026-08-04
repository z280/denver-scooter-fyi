// Node environment (no DOM needed) — see vitest.config.ts.
//
// Locks the client-side mirror of the API's compute_reliability_tier
// (scooter-fyi-api src/quality.py) against drift. The focus is the
// peer-median dwell rule and its patience floor — min(36h, 16 × the block's
// median dwell) — which is the piece most recently recalibrated and the one
// most easily broken by touching only one of the two repos. Every case below
// is a fixture whose expected tier is worked out from the documented rule,
// not recorded from a previous run.
import { describe, expect, it } from "vitest";

import { assessReliability, type ReliabilitySignals } from "./reliability.ts";

const NOW = Date.parse("2026-06-01T18:00:00Z");

/** A healthy, state-tracked scooter parked `idleHours` ago on a block whose
 *  median dwell is `peerMedian`. */
function scooter(
  idleHours: number,
  peerMedian: number | null,
  extra: ReliabilitySignals = {},
): ReliabilitySignals {
  return {
    is_disabled: false,
    has_negative_report: false,
    quality_designation: "good",
    number_failed_starts: 0,
    first_observed_at_location: new Date(NOW - idleHours * 3_600_000).toISOString(),
    dwell_peer_median_hours: peerMedian,
    ...extra,
  };
}

const tierOf = (s: ReliabilitySignals) => assessReliability(s, NOW).tier;

describe("peer-median dwell → unknown", () => {
  it("stays ok when the dwell ratio is under 2×", () => {
    // 34h on a 20h-median block: 1.7× — under the ratio and under the 36h floor.
    expect(tierOf(scooter(34, 20))).toBe("ok");
  });

  it("is unknown once both the 2× ratio and the floor are cleared", () => {
    // 37h on a 5h-median block: 7.4×, and past the 36h floor.
    expect(tierOf(scooter(37, 5))).toBe("unknown");
  });

  it("no longer fires on the 2× ratio alone", () => {
    // 10h on a 5h-median block used to read unknown; the floor (36h here)
    // now keeps it ok.
    expect(tierOf(scooter(10, 5))).toBe("ok");
  });
});

describe("the patience floor: min(36h, 16 × peer median)", () => {
  it("is 16× the median on a high-turnover block", () => {
    expect(tierOf(scooter(15.9, 1))).toBe("ok");
    expect(tierOf(scooter(16, 1))).toBe("unknown");
  });

  it("caps at a flat 36h once 16× would overshoot it", () => {
    // 8h median → 16× is 128h, so the cap governs.
    expect(tierOf(scooter(35.9, 8))).toBe("ok");
    expect(tierOf(scooter(36, 8))).toBe("unknown");
  });

  it("only ever delays — a sleepy block still waits for its own ratio", () => {
    // 20h median: 37h is past the 36h floor but under 2× the median.
    expect(tierOf(scooter(37, 20))).toBe("ok");
    expect(tierOf(scooter(40, 20))).toBe("unknown");
  });

  it("never gates a failed start or a negative report", () => {
    expect(tierOf(scooter(1, 5, { number_failed_starts: 1 }))).toBe("unknown");
    expect(tierOf(scooter(1, 5, { has_negative_report: true }))).toBe("risk");
  });

  it("leaves the high-risk rules alone", () => {
    // 72h ghost rule, and the 3×/p90/48h outlier — both above the floor's reach.
    expect(tierOf(scooter(72, 20))).toBe("risk");
    expect(
      tierOf(scooter(48, 6, { dwell_percentile_hood: 96 })),
    ).toBe("risk");
  });
});

describe("non-dwell paths are untouched", () => {
  it("reports a device with no state tracking as unknown", () => {
    expect(
      assessReliability(
        { quality_designation: "good", first_observed_at_location: null },
        NOW,
      ).tier,
    ).toBe("unknown");
  });

  it("keeps a clean, freshly-parked scooter ok with no reasons", () => {
    const out = assessReliability(scooter(1, 5), NOW);
    expect(out.tier).toBe("ok");
    expect(out.reasons).toEqual([]);
  });
});
