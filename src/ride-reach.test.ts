import { describe, expect, it } from "vitest";

import { DETOUR_FACTOR, RESERVE_FRACTION } from "./reach.ts";
import {
  MIN_WARNABLE_REMAINING_METERS,
  SHORTFALL_MARGIN_METERS,
  rangeLeftMeters,
  preRideReachSentence,
  reachSentence,
  remainingRideMeters,
  rideReach,
  shouldWarnReach,
  type RideReachInput,
} from "./ride-reach.ts";

/** Denver's Union Station, and a point due east of it. */
const HERE = { lat: 39.7526, lng: -105.0 };
const far = (metersEast: number) => ({
  lat: 39.7526,
  lon: -105.0 + metersEast / (111_320 * Math.cos((39.7526 * Math.PI) / 180)),
});

/** A destination whose ESTIMATED ROAD distance is about `meters` — i.e. the
 *  detour factor inverted, so a test can aim at the thresholds directly instead
 *  of back-solving them through the projection. */
const destAtRemaining = (meters: number) => far(meters / DETOUR_FACTOR);

const input = (over: Partial<RideReachInput> = {}): RideReachInput => ({
  startRangeMeters: 10_000,
  travelledMeters: 0,
  at: HERE,
  dest: far(1_000),
  ...over,
});

describe("range left", () => {
  it("spends the start figure down by what was ridden", () => {
    expect(rangeLeftMeters(10_000, 2_500)).toBe(7_500);
  });

  it("clamps at zero rather than going negative", () => {
    // A vehicle that outlived its own projection has an estimate that was low,
    // not negative range — and a negative would make the shortfall arithmetic
    // read as a bigger gap the further it is wrong.
    expect(rangeLeftMeters(1_000, 4_000)).toBe(0);
  });

  it("is null without an observation, for every shape of missing", () => {
    for (const bad of [null, undefined, NaN, Infinity, -1]) {
      expect(rangeLeftMeters(bad as number, 0)).toBeNull();
    }
  });

  it("ignores a broken odometer instead of inventing a shortfall", () => {
    // A NaN travelled distance is not evidence about the battery.
    expect(rangeLeftMeters(5_000, NaN)).toBe(5_000);
    expect(rangeLeftMeters(5_000, -10)).toBe(5_000);
  });
});

describe("remaining distance", () => {
  it("is the straight line times the detour factor", () => {
    const m = remainingRideMeters(HERE, far(1_000))!;
    // 1 km east, inflated for roads. Loose bound: the point is the factor is
    // applied, not the exact projection.
    expect(m).toBeGreaterThan(1_300);
    expect(m).toBeLessThan(1_400);
  });

  it("is null with no destination, no fix, or a non-finite coordinate", () => {
    expect(remainingRideMeters(HERE, null)).toBeNull();
    expect(remainingRideMeters(null, far(1_000))).toBeNull();
    expect(remainingRideMeters({ lat: NaN, lng: -105 }, far(1_000))).toBeNull();
    expect(remainingRideMeters(HERE, { lat: 39.75, lon: NaN })).toBeNull();
  });
});

describe("the verdict", () => {
  it("is ok with range to spare", () => {
    const r = rideReach(input({ startRangeMeters: 10_000, dest: far(1_000) }));
    expect(r.verdict).toBe("ok");
    expect(r.rangeLeftMeters).toBe(10_000);
  });

  it("is short when the route outruns the usable range", () => {
    const r = rideReach(input({ startRangeMeters: 1_000, dest: far(5_000) }));
    expect(r.verdict).toBe("short");
  });

  it("is the RESERVE alone that makes a marginal ride short", () => {
    // Found by mutation: the test below passed with `1 - RESERVE_FRACTION`
    // removed entirely, because both of its cases land the same side of the
    // line either way. This one cannot: the range covers the remaining
    // distance outright (so with no reserve it would read "ok"), and is short
    // only once the arrival reserve is held back.
    //
    //   remaining - left           =     0  ≤ margin  -> "ok"  without reserve
    //   remaining - left * 0.9     = 1000  > margin   -> "short" with it
    const reach = input({
      startRangeMeters: 10_000,
      dest: destAtRemaining(10_000),
      travelledMeters: 0,
    });
    const r = rideReach(reach);
    expect(r.remainingMeters).toBeGreaterThan(9_900);
    expect(r.remainingMeters).toBeLessThan(10_100);
    expect(r.verdict).toBe("short");
  });

  it("honours the same arrival reserve the map chip and the backend use", () => {
    // Two tiers of one question must not disagree about what "made it" means.
    // A route that fits the raw range but NOT the range minus the reserve is
    // short — and that is the whole reason the reserve is imported rather than
    // re-chosen here.
    const remaining = remainingRideMeters(HERE, far(1_000))!;
    const usableExactly = remaining / (1 - RESERVE_FRACTION);
    // Just under what the reserve needs, by more than the noise margin.
    const tight = usableExactly - SHORTFALL_MARGIN_METERS * 2;
    expect(tight).toBeLessThan(usableExactly);
    expect(rideReach(input({ startRangeMeters: tight, dest: far(1_000) })).verdict)
      .toBe("short");
    expect(
      rideReach(input({ startRangeMeters: usableExactly + 1, dest: far(1_000) })).verdict,
    ).toBe("ok");
  });

  it("does not call a rounding difference a shortfall", () => {
    // Both figures are estimates — a straight line for a road, an operator's
    // projection for a model. The gap has to beat their noise to mean anything.
    const remaining = remainingRideMeters(HERE, far(1_000))!;
    const barely = (remaining - SHORTFALL_MARGIN_METERS / 2) / (1 - RESERVE_FRACTION);
    expect(rideReach(input({ startRangeMeters: barely, dest: far(1_000) })).verdict)
      .toBe("ok");
  });

  it("is unknown — never ok — when anything is missing", () => {
    // THE CONFIDENCE FLOOR. §11.5 calls this the item most likely to produce a
    // wrong claim; an absent input must not resolve to reassurance either.
    for (const over of [
      { startRangeMeters: null },
      { startRangeMeters: undefined },
      { dest: null },
      { at: null },
    ] as Partial<RideReachInput>[]) {
      expect(rideReach(input(over)).verdict).toBe("unknown");
      expect(rideReach(input(over)).rangeLeftMeters).toBeNull();
    }
  });
});

describe("whether to interrupt the rider", () => {
  const short = () => input({ startRangeMeters: 1_000, dest: far(5_000) });

  it("warns once a short ride is genuinely short", () => {
    expect(shouldWarnReach({ ...short(), alreadyWarned: false })).toBe(true);
  });

  it("never warns twice", () => {
    // The condition is sticky — range only falls, distance only grows — so
    // without the flag this would fire on every fix for the rest of the ride.
    expect(shouldWarnReach({ ...short(), alreadyWarned: true })).toBe(false);
  });

  it("stays quiet when the rider is nearly there, even though it IS short", () => {
    // A rider who walks the last block does not need telling, and this is where
    // the straight-line estimate is least reliable relative to what it measures.
    //
    // Aimed just under the warn floor and comfortably over the margin floor, so
    // the verdict really is "short" and it is the proximity gate — not the
    // margin — doing the silencing. Below about 333 m nothing can be short at
    // all (see the note on SHORTFALL_MARGIN_METERS), which would have made this
    // test pass for the wrong reason.
    const nearly = input({
      startRangeMeters: 10,
      dest: destAtRemaining(MIN_WARNABLE_REMAINING_METERS - 20),
    });
    expect(rideReach(nearly).verdict).toBe("short");
    expect(shouldWarnReach({ ...nearly, alreadyWarned: false })).toBe(false);
  });

  it("cannot call a very short trip short, whatever the battery", () => {
    // The documented consequence of an absolute margin. Stated as a test so it
    // is a known property rather than a surprise to the next reader.
    const tiny = input({ startRangeMeters: 1, dest: destAtRemaining(200) });
    expect(rideReach(tiny).verdict).toBe("ok");
  });

  it("stays quiet for every reason the question cannot be answered", () => {
    for (const over of [
      { startRangeMeters: null },
      { dest: null },
      { at: null },
    ] as Partial<RideReachInput>[]) {
      expect(shouldWarnReach({ ...short(), ...over, alreadyWarned: false })).toBe(false);
    }
  });

  it("starts warning as the ride eats the range", () => {
    // Same vehicle, same destination; only the odometer moves.
    const base = { startRangeMeters: 4_000, dest: far(2_000), at: HERE };
    expect(shouldWarnReach({ ...input(base), travelledMeters: 0, alreadyWarned: false }))
      .toBe(false);
    expect(
      shouldWarnReach({ ...input(base), travelledMeters: 3_000, alreadyWarned: false }),
    ).toBe(true);
  });
});

describe("the sentence", () => {
  it("names both figures in miles, to one decimal", () => {
    const r = rideReach(input({ startRangeMeters: 1_000, dest: far(5_000) }));
    const s = reachSentence(r)!;
    expect(s).toMatch(/0\.6 miles of range left/);
    expect(s).toMatch(/roughly 4\.2 to go/);
  });

  it("says nothing it cannot support", () => {
    // No gauge, no instruction: we know the battery is probably short, we do
    // not know whether the answer is to swap, park early, or walk a block.
    const s = reachSentence(rideReach(input({ startRangeMeters: 1_000, dest: far(5_000) })))!;
    expect(s).not.toMatch(/\d+ ?%/);
    expect(s).not.toMatch(/should|must|swap|park now/i);
    // Hedged, because it will sometimes be wrong.
    expect(s).toMatch(/may not|about|roughly/i);
  });

  it("has nothing to say when the verdict is not short", () => {
    expect(reachSentence(rideReach(input()))).toBeNull();
    expect(reachSentence(rideReach(input({ startRangeMeters: null })))).toBeNull();
  });
});

describe("the before-the-ride sentence", () => {
  const short = () =>
    rideReach(input({ startRangeMeters: 500, dest: far(5_000) }));

  it("names the place the rider named, with both figures", () => {
    const s = preRideReachSentence(short(), "Home");
    expect(s).toContain("may not reach Home");
    expect(s).toMatch(/miles of range/);
    expect(s).toMatch(/to go/);
  });

  it("never tells the rider what to do about it", () => {
    // We know the battery is probably short; we do not know whether the right
    // answer is a different scooter, a shorter trip, or walking a block. The
    // honest shape is the one that survives being wrong, which this will be.
    const s = preRideReachSentence(short(), "Home") ?? "";
    expect(s).not.toMatch(/should|instead|try |pick |choose /i);
  });

  it("falls back for an unnamed place rather than rendering a gap", () => {
    // A destination saved from a map tap can have no name at all.
    for (const label of [null, undefined, "", "   "]) {
      expect(preRideReachSentence(short(), label)).toContain("your destination");
    }
  });

  it("says nothing unless the verdict is short", () => {
    expect(preRideReachSentence(rideReach(input()), "Home")).toBeNull();
    expect(
      preRideReachSentence(rideReach(input({ startRangeMeters: null })), "Home"),
    ).toBeNull();
    expect(
      preRideReachSentence(rideReach(input({ dest: null })), "Home"),
    ).toBeNull();
  });

  it("agrees with the during-ride verdict on the same numbers", () => {
    // Two tiers of one question, twelve seconds apart. A rider told nothing on
    // Screen 6 and then warned eight metres into the ride would rightly
    // conclude the warning is noise — so the before case IS the during case
    // with nothing travelled, not a second rule.
    const i = { startRangeMeters: 500, travelledMeters: 0, at: HERE, dest: far(5_000) };
    expect(preRideReachSentence(rideReach(i), "Home")).not.toBeNull();
    expect(shouldWarnReach({ ...i, alreadyWarned: false })).toBe(true);
  });
});
