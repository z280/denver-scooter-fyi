import { describe, it, expect } from "vitest";
import {
  BILLING_TIME_ZONE,
  FREE_MINUTES_PER_DAY,
  billingDayOf,
  estimateFreeMinutes,
  freeMinutesForPlanning,
  minutesSpentBy,
  ridesOnDay,
  type RideSpan,
} from "./free-minutes.ts";

const MIN = 60_000;

/** 2026-10-06 14:00 in Denver (MDT, UTC−6). */
const NOW = Date.parse("2026-10-06T20:00:00Z");

function ride(startISO: string, minutes: number | null): RideSpan {
  const startedAtMs = Date.parse(startISO);
  return {
    startedAtMs,
    endedAtMs: minutes === null ? null : startedAtMs + minutes * MIN,
  };
}

describe("billingDayOf", () => {
  it("uses Denver's day, not UTC's", () => {
    // 2026-10-07T01:00Z is 7pm on the 6th in Denver. Counting in UTC would
    // hand the rider a fresh hour in the middle of their evening.
    expect(billingDayOf(Date.parse("2026-10-07T01:00:00Z"))).toBe("2026-10-06");
    expect(billingDayOf(Date.parse("2026-10-07T06:30:00Z"))).toBe("2026-10-07");
    expect(BILLING_TIME_ZONE).toBe("America/Denver");
  });

  it("gets the reset right across a DST change", () => {
    // Denver leaves MDT at 02:00 on 2026-11-01, so that local day is 25 hours
    // long. Offset arithmetic puts rides on the wrong side of the reset;
    // `Intl` does not. 2026-11-01T07:30Z is 01:30 MDT — still the 1st.
    expect(billingDayOf(Date.parse("2026-11-01T07:30:00Z"))).toBe("2026-11-01");
    // ...and 08:30Z is 01:30 MST, after the clocks went back, still the 1st.
    expect(billingDayOf(Date.parse("2026-11-01T08:30:00Z"))).toBe("2026-11-01");
    // The day before is genuinely the day before.
    expect(billingDayOf(Date.parse("2026-11-01T05:30:00Z"))).toBe("2026-10-31");
  });
});

describe("minutesSpentBy", () => {
  it("bills the started minute, like Veo and like the planner", () => {
    // 61 seconds is 2 minutes of the hour, not 1. Rounding down would hand the
    // rider a minute they do not have.
    expect(minutesSpentBy({ startedAtMs: 0, endedAtMs: 61_000 }, NOW)).toBe(2);
    expect(minutesSpentBy({ startedAtMs: 0, endedAtMs: 60_000 }, NOW)).toBe(1);
    // Even a few seconds is a started minute.
    expect(minutesSpentBy({ startedAtMs: 0, endedAtMs: 3_000 }, NOW)).toBe(1);
  });

  it("counts a ride that is still running, up to now", () => {
    // A rider planning their next leg mid-trip is spending the hour while they
    // read the screen.
    const running: RideSpan = { startedAtMs: NOW - 7 * MIN, endedAtMs: null };
    expect(minutesSpentBy(running, NOW)).toBe(7);
  });

  it("ignores a span that makes no sense", () => {
    expect(minutesSpentBy({ startedAtMs: NOW, endedAtMs: NOW - MIN }, NOW)).toBe(0);
    expect(minutesSpentBy({ startedAtMs: NOW, endedAtMs: NOW }, NOW)).toBe(0);
  });
});

describe("ridesOnDay", () => {
  it("counts today's rides and leaves yesterday's alone", () => {
    const rides = [
      ride("2026-10-05T20:00:00Z", 10), // yesterday in Denver
      ride("2026-10-06T16:00:00Z", 10), // this morning
      ride("2026-10-06T19:00:00Z", 5), // an hour ago
    ];
    expect(ridesOnDay(rides, NOW)).toHaveLength(2);
  });

  it("bills a midnight-straddling ride to the day it started", () => {
    // A simplification, and a disclosed one: the contract says 60 free minutes
    // a day and does not say how a ride across the reset is split. Inventing a
    // split would be inventing a rule Veo has not published.
    const acrossMidnight = ride("2026-10-07T05:50:00Z", 30); // 23:50 MDT on the 6th
    expect(billingDayOf(acrossMidnight.startedAtMs)).toBe("2026-10-06");
    expect(ridesOnDay([acrossMidnight], NOW)).toHaveLength(1);
    // And it does NOT also count against the 7th.
    const nextDay = Date.parse("2026-10-07T18:00:00Z");
    expect(ridesOnDay([acrossMidnight], nextDay)).toHaveLength(0);
  });
});

describe("estimateFreeMinutes", () => {
  it("sums today's rides and reports the direction of the error", () => {
    const rides = [
      ride("2026-10-06T16:00:00Z", 12),
      ride("2026-10-06T18:30:00Z", 8),
      ride("2026-10-05T18:30:00Z", 40), // yesterday: not counted
    ];
    const est = estimateFreeMinutes({ rides, nowMs: NOW });
    expect(est.usedMinutes).toBe(20);
    expect(est.remainingMinutes).toBe(40);
    expect(est.ridesCounted).toBe(2);
    expect(est.basis).toBe("tracked_rides");
    // Rides taken outside this app are invisible, so used is a FLOOR and
    // remaining is a CEILING. The control has to say so.
    expect(est.isCeiling).toBe(true);
  });

  it("never reports negative minutes left", () => {
    const rides = [ride("2026-10-06T16:00:00Z", 90)];
    const est = estimateFreeMinutes({ rides, nowMs: NOW });
    expect(est.usedMinutes).toBe(90);
    expect(est.remainingMinutes).toBe(0);
  });

  it("takes the rider's own answer over its own, without blending", () => {
    // The rider can see their Veo app; this module cannot. Averaging the two
    // would produce a number neither of us believes.
    const rides = [ride("2026-10-06T16:00:00Z", 12)]; // estimate would say 48
    const est = estimateFreeMinutes({ rides, nowMs: NOW, riderSaysRemaining: 20 });
    expect(est.remainingMinutes).toBe(20);
    expect(est.usedMinutes).toBe(40);
    expect(est.basis).toBe("rider_corrected");
    // A stated figure is not a ceiling — the rider told us.
    expect(est.isCeiling).toBe(false);
  });

  it("clamps a rider's correction to the size of the allowance", () => {
    expect(
      estimateFreeMinutes({ rides: [], nowMs: NOW, riderSaysRemaining: 999 })
        .remainingMinutes,
    ).toBe(FREE_MINUTES_PER_DAY);
    expect(
      estimateFreeMinutes({ rides: [], nowMs: NOW, riderSaysRemaining: -5 })
        .remainingMinutes,
    ).toBe(0);
  });

  it("gives a signed-out rider the pessimistic figure, flagged as such", () => {
    const est = estimateFreeMinutes({ rides: null, nowMs: NOW, signedIn: false });
    expect(est.remainingMinutes).toBe(0);
    expect(est.basis).toBe("signed_out");
    // Pessimism quotes too much rather than promising free minutes that may
    // not exist — the safe direction when there is nothing to count and
    // nobody to ask.
    expect(est.isCeiling).toBe(false);
  });

  it("gives a signed-in rider with no rides today the whole hour", () => {
    const est = estimateFreeMinutes({ rides: [], nowMs: NOW });
    expect(est.remainingMinutes).toBe(FREE_MINUTES_PER_DAY);
    expect(est.basis).toBe("tracked_rides");
    expect(est.isCeiling).toBe(true);
  });

  it("lets the rider correct even while signed out", () => {
    // Somebody who knows their balance can still plan with it. The correction
    // is checked before the signed-out floor for exactly this reason.
    const est = estimateFreeMinutes({
      rides: null,
      nowMs: NOW,
      signedIn: false,
      riderSaysRemaining: 35,
    });
    expect(est.remainingMinutes).toBe(35);
    expect(est.basis).toBe("rider_corrected");
  });
});

describe("freeMinutesForPlanning", () => {
  it("resolves to the one number the search takes", () => {
    // `rankPlans` has no tracked-ride input and could not resolve a null even
    // in principle, so the resolution happens here (§2.1).
    const est = estimateFreeMinutes({ rides: [ride("2026-10-06T16:00:00Z", 15)], nowMs: NOW });
    expect(freeMinutesForPlanning(est)).toBe(45);
    expect(typeof freeMinutesForPlanning(est)).toBe("number");
  });

  it("hands the planner zero for a signed-out rider", () => {
    const est = estimateFreeMinutes({ rides: null, nowMs: NOW, signedIn: false });
    expect(freeMinutesForPlanning(est)).toBe(0);
  });
});
