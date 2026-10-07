// @vitest-environment happy-dom
//
// §2.2. The thing under test is mostly WORDS, which is right: a number alone
// here is the bug. A rider who plans a free trip on our figure and gets billed
// for it will not use the feature twice, so every path has to say which way the
// figure is wrong.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TrackedRide } from "./api.ts";
import { estimateFreeMinutes, type FreeMinuteEstimate } from "./free-minutes.ts";
import {
  freeMinutesCopy,
  parseCorrection,
  saveCorrection,
  savedCorrection,
  spansOf,
} from "./free-minutes-control.ts";

const NOW = Date.parse("2026-10-07T18:00:00Z"); // noon in Denver
const YESTERDAY = Date.parse("2026-10-06T18:00:00Z");

function ride(over: Partial<TrackedRide> = {}): TrackedRide {
  return {
    id: "r1",
    status: "ended",
    started_at: new Date(NOW - 30 * 60_000).toISOString(),
    user_reported_ended_at: new Date(NOW - 20 * 60_000).toISOString(),
    ...over,
  } as TrackedRide;
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("spansOf", () => {
  it("reads started_at and the rider's own reported end", () => {
    const [span] = spansOf([ride()]);
    expect(span.startedAtMs).toBe(NOW - 30 * 60_000);
    expect(span.endedAtMs).toBe(NOW - 20 * 60_000);
  });

  it("keeps a running ride as an OPEN span rather than dropping it", () => {
    // `minutesSpentBy` counts an open span up to `now`, because a rider planning
    // their next leg mid-trip is spending the hour while they read the screen.
    // Dropping it would hand them minutes they are in the middle of using.
    const [span] = spansOf([ride({ user_reported_ended_at: null })]);
    expect(span.endedAtMs).toBeNull();
  });

  it("does not reach for the gbfs_* end fields", () => {
    // Every gbfs_* field reads null until the rider reports their own end (the
    // API's redaction rule), so preferring one would substitute a null for a
    // real figure on exactly the rides that have one.
    const [span] = spansOf([
      ride({
        user_reported_ended_at: new Date(NOW - 20 * 60_000).toISOString(),
        gbfs_left_feed_at: new Date(NOW - 25 * 60_000).toISOString(),
      }),
    ]);
    expect(span.endedAtMs).toBe(NOW - 20 * 60_000);
  });

  it("skips a ride with an unparseable start rather than emitting NaN", () => {
    // A NaN span poisons the sum and the estimate reads zero minutes used,
    // which is the optimistic direction §2.2 never takes.
    expect(spansOf([ride({ started_at: "not a date" })])).toEqual([]);
  });

  it("treats an unparseable end as still running, not as instant", () => {
    const [span] = spansOf([ride({ user_reported_ended_at: "nope" })]);
    expect(span.endedAtMs).toBeNull();
  });
});

describe("the rider's correction", () => {
  it("round-trips within the day", () => {
    expect(saveCorrection(NOW, 12)).toBe(true);
    expect(savedCorrection(NOW)).toBe(12);
  });

  it("is forgotten on the next billing day, because the allowance resets", () => {
    // A figure from yesterday is worse than none: it is stated with confidence,
    // it WINS over the estimate by design, and it is certainly wrong.
    saveCorrection(YESTERDAY, 12);
    expect(savedCorrection(NOW)).toBeNull();
  });

  it("keeps a stated zero, which is not the same as having said nothing", () => {
    saveCorrection(NOW, 0);
    expect(savedCorrection(NOW)).toBe(0);
    // And that zero reaches the estimate as the rider's answer, not as a gap
    // the estimate gets to fill with its own guess.
    const est = estimateFreeMinutes({
      rides: [],
      nowMs: NOW,
      riderSaysRemaining: savedCorrection(NOW),
      signedIn: true,
    });
    expect(est.basis).toBe("rider_corrected");
    expect(est.remainingMinutes).toBe(0);
  });

  it("clears on null", () => {
    saveCorrection(NOW, 30);
    saveCorrection(NOW, null);
    expect(savedCorrection(NOW)).toBeNull();
  });

  it("clamps to the allowance it is about", () => {
    saveCorrection(NOW, 999);
    expect(savedCorrection(NOW)).toBe(60);
    saveCorrection(NOW, -5);
    expect(savedCorrection(NOW)).toBe(0);
  });

  it("treats an unreadable stored value as none", () => {
    localStorage.setItem("scooter_fyi.free_minutes_said", "{not json");
    expect(savedCorrection(NOW)).toBeNull();
    localStorage.setItem("scooter_fyi.free_minutes_said", '{"day":"2026-10-07"}');
    expect(savedCorrection(NOW)).toBeNull();
  });
});

describe("parseCorrection", () => {
  it("clamps a number that means 'loads' and refuses one that means nothing", () => {
    expect(parseCorrection("90")).toBe(60);
    expect(parseCorrection("12")).toBe(12);
    expect(parseCorrection("12.6")).toBe(13);
    // Nothing typed, or nothing numeric: the control must not fabricate the one
    // figure it exists to take FROM the rider.
    expect(parseCorrection("")).toBeNull();
    expect(parseCorrection("   ")).toBeNull();
    expect(parseCorrection("abc")).toBeNull();
  });
});

describe("the copy", () => {
  const est = (over: Partial<FreeMinuteEstimate>): FreeMinuteEstimate => ({
    usedMinutes: 15,
    remainingMinutes: 45,
    basis: "tracked_rides",
    ridesCounted: 1,
    isCeiling: true,
    ...over,
  });

  it("says which way the error runs whenever the figure is derived", () => {
    // The whole reason this has words. "This is the most you have left, not the
    // least" is the sentence that stops a rider planning a free trip they will
    // be billed for.
    const copy = freeMinutesCopy(est({}));
    expect(copy.headline).toBe("About 45 free minutes left today");
    expect(copy.basisNote).toContain("most you have left, not the least");
    expect(copy.basisNote).toContain("1 ride");
  });

  it("pluralises the ride count", () => {
    expect(freeMinutesCopy(est({ ridesCounted: 3 })).basisNote).toContain("3 rides");
  });

  it("distinguishes 'we looked and found nothing' from 'we cannot look'", () => {
    // A rider who took no rides today and is told "we cannot see your rides"
    // will correct a figure that was already right.
    const none = freeMinutesCopy(est({ ridesCounted: 0, usedMinutes: 0, remainingMinutes: 60 }));
    expect(none.basisNote).toContain("No rides recorded here today");
    expect(none.basisNote).not.toContain("Signed out");

    const out = freeMinutesCopy(
      est({ basis: "signed_out", ridesCounted: 0, usedMinutes: 60, remainingMinutes: 0, isCeiling: false }),
    );
    expect(out.basisNote).toContain("Signed out");
    // And it says what the pessimism costs, which is the point of admitting it.
    expect(out.basisNote).toContain("price every minute");
  });

  it("stops hedging once the rider has told us, because their answer wins", () => {
    const copy = freeMinutesCopy(
      est({ basis: "rider_corrected", remainingMinutes: 12, isCeiling: false, ridesCounted: 0 }),
    );
    expect(copy.headline).toBe("12 free minutes left today — your figure");
    expect(copy.basisNote).toBe("Using what you told us, not our estimate.");
    expect(copy.corrected).toBe(true);
    // No "about": blending our estimate into their answer would produce a
    // number neither of us believes.
    expect(copy.headline).not.toContain("About");
  });

  it("says 'no free minutes' rather than 'about 0'", () => {
    expect(freeMinutesCopy(est({ remainingMinutes: 0 })).headline).toBe(
      "No free minutes left today",
    );
  });
});
