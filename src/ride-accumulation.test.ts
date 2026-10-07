// Phase 11 §11.8. The sentence is the deliverable, and most of these assertions
// are about when NOT to say it: this fires at the moment a rider is trying to put
// their phone away, so a thin or unverifiable figure costs more than it earns.
import { describe, expect, it } from "vitest";

import { comparatorPassQuote } from "./ride-cost.ts";
import {
  MIN_DISTANCE_METERS,
  MIN_RIDES_FOR_SENTENCE,
  MIN_PREMIUM_CENTS,
  accumulate,
  accumulationSentence,
  isPartial,
  ordinal,
  type AccumulatedRide,
} from "./ride-accumulation.ts";

const MILE = 1609.344;

function ride(over: Partial<AccumulatedRide> = {}): AccumulatedRide {
  return { distanceMeters: 3 * MILE, costCents: 400, minutes: 15, ...over };
}

const sentence = (rides: AccumulatedRide[]) => accumulationSentence(accumulate(rides));

describe("accumulate", () => {
  it("sums what is known and counts what it was known from", () => {
    const totals = accumulate([ride(), ride(), ride({ distanceMeters: null })]);
    expect(totals.rideCount).toBe(3);
    expect(totals.distanceFromRides).toBe(2);
    expect(totals.distanceMeters).toBeCloseTo(6 * MILE, 1);
    expect(totals.premiumFromRides).toBe(3);
  });

  it("treats a missing distance as unknown, never as zero", () => {
    // A ride with no measurement and a ride that went nowhere are different
    // facts. Summing the second into a lifetime total is fine; summing the first
    // is a lie, and it drags the average down invisibly.
    const totals = accumulate([ride({ distanceMeters: null }), ride({ distanceMeters: 0 })]);
    expect(totals.distanceFromRides).toBe(1);
    expect(totals.distanceMeters).toBe(0);
  });

  it("needs BOTH a charge and minutes before it quotes a comparator", () => {
    // With a charge and no minutes there is nothing to quote against; with minutes
    // and no charge there is no actual spend to subtract. Either alone would have
    // to be guessed, and a guessed saving is the one number here nobody can check.
    expect(accumulate([ride({ minutes: null })]).premiumFromRides).toBe(0);
    expect(accumulate([ride({ costCents: null })]).premiumFromRides).toBe(0);
    expect(accumulate([ride({ minutes: 0 })]).premiumFromRides).toBe(0);
  });

  it("measures the premium in the same direction the ride summary does", () => {
    // `charged − comparator`. §11.8 asks for the inverse ("you've saved $47"), and
    // the comparator is CHEAPER than Veo for essentially every ride — so a
    // "saved" figure would be the one place in this app that inverts the
    // comparison, and it would invert it in Veo's favour.
    const quote = comparatorPassQuote(15 * 60_000).cents;
    expect(accumulate([ride({ costCents: 400, minutes: 15 })]).premiumCents).toBe(400 - quote);
    expect(400 - quote).toBeGreaterThan(0);
  });

  it("keeps a negative premium rather than flooring it at zero", () => {
    // A rider who genuinely came out ahead on some ride should not have that
    // erased in the arithmetic — the sentence declines to MENTION a negative
    // total, which is a different decision made in a different place.
    const quote = comparatorPassQuote(15 * 60_000).cents;
    expect(accumulate([ride({ costCents: quote - 500, minutes: 15 })]).premiumCents).toBe(-500);
  });

  it("ignores a garbage figure instead of poisoning the total", () => {
    for (const bad of [NaN, Infinity, -5]) {
      expect(accumulate([ride({ distanceMeters: bad })]).distanceFromRides, String(bad)).toBe(0);
    }
    expect(accumulate([ride({ costCents: NaN })]).premiumFromRides).toBe(0);
  });
});

describe("the sentence says nothing rather than something thin", () => {
  it("says nothing on a first ride", () => {
    // "That was your 1st ride, 0.6 miles, and you've saved $0.40" is the app
    // congratulating a rider on nothing, at the moment they are trying to put
    // their phone away — and it makes the figure look like the point.
    expect(sentence([ride()])).toBeNull();
    expect(MIN_RIDES_FOR_SENTENCE).toBe(2);
  });

  it("says nothing with no rides at all", () => {
    expect(sentence([])).toBeNull();
  });

  it("drops the distance clause under a mile", () => {
    // "0.3 miles" reads as a rounding error rather than a distance.
    const short = sentence([
      ride({ distanceMeters: 100, costCents: null, minutes: null }),
      ride({ distanceMeters: 100, costCents: null, minutes: null }),
    ])!;
    expect(short).toBe("That was your 2nd ride.");
    expect(MIN_DISTANCE_METERS).toBeLessThanOrEqual(1609.344);
  });

  it("drops the premium clause under fifty cents", () => {
    const quote = comparatorPassQuote(15 * 60_000).cents;
    const thin = sentence([
      ride({ costCents: quote + 20, distanceMeters: 3 * MILE }),
      ride({ costCents: quote, distanceMeters: 3 * MILE }),
    ])!;
    expect(thin).not.toContain("competitive market");
    expect(thin).toContain("6 miles");
    expect(MIN_PREMIUM_CENTS).toBe(50);
  });

  it("says nothing about the comparator when the rider came out ahead", () => {
    // The comparison exists to show what a single-operator market costs. A "you
    // did well" line on the rides where it did not would make the whole figure
    // read as a scoreboard.
    const quote = comparatorPassQuote(15 * 60_000).cents;
    const out = sentence([
      ride({ costCents: Math.max(0, quote - 200) }),
      ride({ costCents: Math.max(0, quote - 200) }),
    ])!;
    expect(out).not.toContain("competitive market");
    expect(out).not.toContain("-$");
  });
});

describe("the sentence, when it earns itself", () => {
  it("reads as §11.8's shape, with the comparison the right way round", () => {
    // 15-minute rides at the Resident rate: $1 + 15 × 25¢ = $4.75 each, against a
    // $2.99 thirty-minute comparator pass.
    const rides = Array.from({ length: 12 }, () =>
      ride({ distanceMeters: (38 / 12) * MILE, costCents: 475, minutes: 15 }),
    );
    const out = sentence(rides)!;
    expect(out).toBe(
      `That was your 12th ride — 38 miles, and ${formatPremium(12, 15, 475)} more than a competitive market would charge.`,
    );
  });

  it("gives one decimal under ten miles and a whole number above", () => {
    const two = (m: number) => [ride({ distanceMeters: m, costCents: null, minutes: null }), ride({ distanceMeters: 0, costCents: null, minutes: null })];
    expect(sentence(two(5.25 * MILE))).toContain("5.3 miles");
    expect(sentence(two(38.4 * MILE))).toContain("38 miles");
  });

  it("carries the count alone when nothing else qualifies", () => {
    expect(
      sentence([
        ride({ distanceMeters: null, costCents: null, minutes: null }),
        ride({ distanceMeters: null, costCents: null, minutes: null }),
      ]),
    ).toBe("That was your 2nd ride.");
  });
});

function formatPremium(count: number, minutes: number, cost: number): string {
  const per = cost - comparatorPassQuote(minutes * 60_000).cents;
  return `$${((per * count) / 100).toFixed(2)}`;
}

describe("ordinal", () => {
  it("handles the teens, which is where every naive version breaks", () => {
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
    expect(ordinal(111)).toBe("111th");
    expect(ordinal(112)).toBe("112th");
  });

  it("handles the ones that are not teens", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(23)).toBe("23rd");
    expect(ordinal(101)).toBe("101st");
  });
});

describe("isPartial", () => {
  it("is true when a total does not cover every ride", () => {
    // "38 miles" that is really "38 of the miles we measured" is the kind of
    // number that gets noticed once and then never trusted again.
    expect(isPartial(accumulate([ride(), ride({ distanceMeters: null })]))).toBe(true);
    expect(isPartial(accumulate([ride(), ride({ costCents: null })]))).toBe(true);
  });

  it("is false when every ride contributed to both", () => {
    expect(isPartial(accumulate([ride(), ride()]))).toBe(false);
  });

  it("is false with no rides, rather than vacuously true", () => {
    expect(isPartial(accumulate([]))).toBe(false);
  });
});
