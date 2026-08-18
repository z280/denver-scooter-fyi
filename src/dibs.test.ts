// @vitest-environment happy-dom
//
// Dibs. What is pinned here is mostly the TIMESTAMP, because the timestamp is
// the entire feature: two people at one scooter settle it by whose claim is
// older, and everything that could quietly move that number is a bug.
import { beforeEach, describe, expect, it } from "vitest";

import {
  DIBS_KEY,
  DIBS_MAX_TOTAL_MS,
  DIBS_MAX_WALK_MINUTES,
  DIBS_PROGRESS_METERS,
  DIBS_START_GRACE_MS,
  callDibs,
  dibsExpiresAt,
  dibsMsLeft,
  isClaimable,
  recordProgress,
  saveDibs,
  denverStamp,
  dibsAge,
  dibsOn,
  dropDibs,
  loadDibs,
} from "./dibs.ts";

const CLAIM = {
  vehicleIdentifier: "abc123",
  vehicleName: "Lunar 🐸 928",
  plate: "1020922",
  claimedBy: "Resourceful 🌈",
  startMeters: 600,
  lat: 39.7392,
  lon: -104.9903,
};

const T0 = Date.UTC(2026, 7, 12, 20, 34, 56); // a fixed instant

beforeEach(() => localStorage.clear());

describe("calling dibs", () => {
  it("records who, what and when", () => {
    const d = callDibs(CLAIM, T0);
    expect(d).toMatchObject({ ...CLAIM, claimedAt: T0 });
  });

  it("KEEPS the original timestamp when the same scooter is claimed again", () => {
    // The earlier claim is the whole asset. A second tap quietly resetting it
    // to now would throw away the only thing dibs is good for — and a rider
    // re-opening the popup taps it again constantly.
    callDibs(CLAIM, T0);
    const again = callDibs(CLAIM, T0 + 5 * 60_000);
    expect(again.claimedAt).toBe(T0);
  });

  it("lets a rider hold dibs on more than one scooter", () => {
    // Walking past three of them and hedging is exactly what people do.
    callDibs(CLAIM, T0);
    callDibs({ ...CLAIM, vehicleIdentifier: "def456", vehicleName: "Solar 🦊 114" }, T0 + 1000);
    expect(loadDibs(T0 + 2000)).toHaveLength(2);
  });

  it("can be dropped", () => {
    callDibs(CLAIM, T0);
    expect(dropDibs("abc123", T0)).toEqual([]);
    expect(dibsOn("abc123", T0)).toBeNull();
  });
});

describe("rule 1 — ten minutes to set off", () => {
  it("dies if the rider never starts walking", () => {
    // Not ten minutes to ARRIVE. Ten minutes to set off. Standing still is
    // the only thing this punishes.
    callDibs(CLAIM, T0);
    expect(dibsOn("abc123", T0 + DIBS_START_GRACE_MS - 1000)).not.toBeNull();
    expect(dibsOn("abc123", T0 + DIBS_START_GRACE_MS + 1000)).toBeNull();
  });

  it("survives past the grace once they are actually moving", () => {
    const d = callDibs(CLAIM, T0);
    saveDibs(recordProgress(d, 600 - DIBS_PROGRESS_METERS, T0 + 60_000), T0 + 60_000);
    expect(dibsOn("abc123", T0 + DIBS_START_GRACE_MS + 60_000)).not.toBeNull();
  });

  it("does not count GPS wander as setting off", () => {
    // A phone on a table drifts tens of metres. Passing rule 1 by standing
    // still would make the rule decorative.
    const d = callDibs(CLAIM, T0);
    const nudged = recordProgress(d, 600 - (DIBS_PROGRESS_METERS - 5), T0 + 60_000);
    expect(nudged.startedWalkingAt).toBeNull();
  });

  it("does not un-start somebody who wandered back out", () => {
    // GPS wanders and the rule is about intent, not about walking a straight
    // line.
    const d = callDibs(CLAIM, T0);
    const moving = recordProgress(d, 500, T0 + 60_000);
    const back = recordProgress(moving, 560, T0 + 90_000);
    expect(back.startedWalkingAt).toBe(moving.startedWalkingAt);
    expect(back.bestMeters).toBe(500);
  });
});

describe("rule 2 — reach and ceiling", () => {
  it("refuses a claim on something too far to walk to", () => {
    expect(isClaimable(DIBS_MAX_WALK_MINUTES)).toBe(true);
    expect(isClaimable(DIBS_MAX_WALK_MINUTES + 1)).toBe(false);
  });

  it("never lets a claim outlive the hard ceiling, however well they walk", () => {
    const d = callDibs(CLAIM, T0);
    const moving = recordProgress(d, 100, T0 + 60_000);
    expect(dibsExpiresAt(moving)).toBe(T0 + DIBS_MAX_TOTAL_MS);
    expect(dibsMsLeft(moving, T0 + DIBS_MAX_TOTAL_MS + 1)).toBe(0);
  });

  it("the ceiling is the grace plus the longest allowed walk", () => {
    // 10 + 15. The number is not arbitrary and should not drift apart.
    expect(DIBS_MAX_TOTAL_MS).toBe(
      DIBS_START_GRACE_MS + DIBS_MAX_WALK_MINUTES * 60_000,
    );
  });
});

describe("the timestamp a person reads out loud", () => {
  it("is Denver time regardless of the phone's zone", () => {
    // A traveller's phone set to New York would print an hour ahead of every
    // other certificate at that intersection — and which claim came first is
    // the one thing this artifact has to get right.
    const stamp = denverStamp(T0);
    expect(stamp).toMatch(/MDT|MST/);
    expect(stamp).toContain("2:34");   // 20:34 UTC is 14:34 in Denver (MDT)
  });

  it("shows seconds, because two claims land in the same minute easily", () => {
    expect(denverStamp(T0)).toContain(":56");
  });
});

describe("storage discipline", () => {
  it("degrades to no dibs on a corrupt blob", () => {
    localStorage.setItem(DIBS_KEY, "{not json");
    expect(loadDibs(T0)).toEqual([]);
  });

  it("degrades on a version it does not know", () => {
    localStorage.setItem(DIBS_KEY, JSON.stringify({ v: 9, dibs: [] }));
    expect(loadDibs(T0)).toEqual([]);
  });

  it("drops entries with no timestamp rather than trusting them", () => {
    // A claim with no time is not a claim; it is a certificate that would win
    // every argument.
    localStorage.setItem(
      DIBS_KEY,
      JSON.stringify({
        v: 1,
        dibs: [
          { ...CLAIM, bestMeters: 600, startedWalkingAt: null },
          { ...CLAIM, vehicleIdentifier: "ok", claimedAt: T0,
            bestMeters: 600, startedWalkingAt: null },
        ],
      }),
    );
    expect(loadDibs(T0).map((d) => d.vehicleIdentifier)).toEqual(["ok"]);
  });
});

describe("age", () => {
  it("reads naturally", () => {
    const d = callDibs(CLAIM, T0);
    expect(dibsAge(d, T0 + 5_000)).toBe("just now");
    expect(dibsAge(d, T0 + 7 * 60_000)).toBe("7 min ago");
  });
});
