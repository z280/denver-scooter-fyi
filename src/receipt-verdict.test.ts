// Phase 8 §8.4/§8.7. Every assertion here is about whether this app will tell a
// rider to go and argue with Veo, so each one is pinned to the contract figure
// or to the reason the plan gives, not to whatever the code happens to return.
import { describe, expect, it } from "vitest";

import {
  EQUITY_AREA_RATE,
  EQUITY_DISCOUNT_CITATION,
  RATE_PLANS,
  VEO_SUPPORT_EMAIL,
  complaintReady,
  type RatePlanKey,
} from "./config.ts";
import { equityAreaEstimateWithTax } from "./ride-cost.ts";
import {
  MARGIN_CENTS,
  SHORTEST_PROVABLE_CENTS,
  confirmRead,
  mayComplain,
  receiptVerdict,
  type VerdictContext,
} from "./receipt-verdict.ts";

const rate = (key: RatePlanKey) => RATE_PLANS.find((p) => p.key === key)!;
const TAX = 0;

function ctx(over: Partial<VerdictContext> = {}): VerdictContext {
  return { startedOrEndedInArea: true, rate: rate("resident"), taxRate: TAX, ...over };
}

/** What a 15-minute equity trip should cost: $1 + 15 × 13¢ = $2.95. */
const MINUTES = 15;
const EXPECTED = equityAreaEstimateWithTax(MINUTES * 60_000, TAX).total;

function verdictFor(totalCents: number, over: Partial<VerdictContext> = {}) {
  return receiptVerdict(confirmRead({ minutes: MINUTES, totalCents }), ctx(over));
}

describe("the expected charge is the contract's own figure", () => {
  it("is $1 + 13¢/min, from Exhibit C, with no tier mixed in", () => {
    expect(EQUITY_AREA_RATE.unlockCents).toBe(100);
    expect(EQUITY_AREA_RATE.perMinCents).toBe(13);
    expect(EXPECTED).toBe(100 + 15 * 13); // $2.95
  });

  it("is the same figure whatever tier the rider is on", () => {
    // The Equity Area rate is geographic and automatic, not a tier. A Visitor
    // and a Resident are owed the same discounted fare for the same trip.
    for (const key of ["resident", "visitor", "equity"] as const) {
      const r = verdictFor(EXPECTED, { rate: rate(key) });
      expect(r.expected!.total, key).toBe(EXPECTED);
    }
  });
});

describe("the bar: all three conditions or no claim", () => {
  it("calls a charge well over the expected figure an overcharge", () => {
    // $4.75 is the Resident base fare for the same 15 minutes — the discount
    // plainly not applied.
    const r = verdictFor(100 + 15 * 25);
    expect(r.verdict).toBe("overcharged");
    expect(r.reason).toBe("exceeds_bar");
    expect(r.differenceCents).toBe(180);
    expect(mayComplain(r)).toBe(true);
  });

  it("refuses to claim anything without geography, which is the common case", () => {
    // Many receipts show time and money and no geography at all. The question is
    // geographic, so this is where most receipts land.
    for (const geo of [null, false] as const) {
      const r = verdictFor(100 + 15 * 25, { startedOrEndedInArea: geo });
      expect(r.verdict, String(geo)).toBe("cannot_tell");
      expect(r.reason, String(geo)).toBe("no_geography");
      // And no figures, because there was nothing to compute them against.
      expect(r.expected).toBeNull();
      expect(r.differenceCents).toBeNull();
      expect(mayComplain(r)).toBe(false);
    }
  });

  it("refuses to claim anything without knowing the tier", () => {
    const r = verdictFor(100 + 15 * 25, { rate: null });
    expect(r.verdict).toBe("cannot_tell");
    expect(r.reason).toBe("tier_unresolved");
    expect(mayComplain(r)).toBe(false);
  });

  it("checks geography BEFORE the arithmetic", () => {
    // Order is load-bearing: an arithmetic comparison against a figure we could
    // not compute is how a tool like this produces a confident wrong answer.
    const r = verdictFor(100 + 15 * 25, { startedOrEndedInArea: null, rate: null });
    expect(r.reason).toBe("no_geography");
  });
});

describe("the comparison is ONE-SIDED — exceeds, never merely differs", () => {
  it("does not complain about a charge BELOW the expected figure", () => {
    // A promotional rate, a credit or a free Access trip all differ from
    // $1 + 13¢/min while leaving the rider better off. A tool that writes to
    // support about those is worse than useless to the people it is for.
    const r = verdictFor(50);
    expect(r.verdict).toBe("correct");
    expect(r.reason).toBe("matches_expected");
    expect(r.differenceCents).toBe(50 - EXPECTED);
    expect(mayComplain(r)).toBe(false);
  });

  it("does not complain about a charge that is free", () => {
    expect(verdictFor(0).verdict).toBe("correct");
  });

  it("calls an exact match correct", () => {
    const r = verdictFor(EXPECTED);
    expect(r.verdict).toBe("correct");
    expect(r.reason).toBe("matches_expected");
    expect(r.differenceCents).toBe(0);
  });
});

describe("the margin, and its ceiling", () => {
  it("is below one minute of the discount, or the shortest trips are unprovable", () => {
    // THE CEILING IS THE PART TO KEEP if the figure is ever revisited. One minute
    // of the Equity Area discount is 12¢ — 25¢ base against 13¢ — so a margin at
    // or above that swallows a one-minute overcharge, which is the opposite of
    // this phase's purpose.
    expect(SHORTEST_PROVABLE_CENTS).toBe(12);
    expect(MARGIN_CENTS).toBeLessThan(SHORTEST_PROVABLE_CENTS);
  });

  it("is still large enough for the rounding it exists to absorb", () => {
    // `estimateWithTax` rounds tax to the nearest cent and `billableMinutes` is
    // ceil-with-a-floor-of-1, so a correct charge can sit a cent or two off.
    expect(MARGIN_CENTS).toBeGreaterThanOrEqual(2);
  });

  it("will not call an overage inside the margin an overcharge", () => {
    const r = verdictFor(EXPECTED + MARGIN_CENTS);
    expect(r.verdict).toBe("cannot_tell");
    expect(r.reason).toBe("inside_margin");
    expect(mayComplain(r)).toBe(false);
  });

  it("does call one cent past the margin an overcharge", () => {
    // §8.7's boundary. The margin is exclusive on the overcharge side.
    const r = verdictFor(EXPECTED + MARGIN_CENTS + 1);
    expect(r.verdict).toBe("overcharged");
    expect(r.reason).toBe("exceeds_bar");
  });

  it("keeps a one-minute overcharge provable, which is what the ceiling buys", () => {
    // A single minute billed at the base rate instead of the area rate: 12¢ over.
    const r = verdictFor(EXPECTED + SHORTEST_PROVABLE_CENTS);
    expect(r.verdict).toBe("overcharged");
  });
});

describe("VeoPlus stays unmodelled", () => {
  it("will not tell a Pass rider their receipt is correct", () => {
    // `expected` includes the area's $1 because the contract does not say a Pass
    // waives it. A Pass rider whose charge matches that may have paid a dollar
    // they did not owe — which we will not claim, because we cannot prove it, and
    // must not bless, because "correct" tells them to stop looking.
    for (const key of ["resident_plus", "visitor_plus"] as const) {
      const r = verdictFor(EXPECTED, { rate: rate(key) });
      expect(r.verdict, key).toBe("cannot_tell");
      expect(r.reason, key).toBe("veoplus_unmodelled");
      expect(mayComplain(r), key).toBe(false);
    }
  });

  it("still calls a plain overcharge an overcharge for a Pass rider", () => {
    // The ambiguity is worth one dollar, not an exemption from the bar.
    const r = verdictFor(100 + 15 * 25, { rate: rate("resident_plus") });
    expect(r.verdict).toBe("overcharged");
    expect(r.reason).toBe("exceeds_bar");
  });

  it("calls a Pass rider a full unlock light CORRECT, not ambiguous", () => {
    // Being charged $1 less than the worse reading is the BETTER reading having
    // been applied. There is nothing unresolved about it.
    const r = verdictFor(EXPECTED - EQUITY_AREA_RATE.unlockCents, {
      rate: rate("resident_plus"),
    });
    expect(r.verdict).toBe("correct");
    expect(r.reason).toBe("matches_expected");
  });

  it("does not apply the Pass caveat to a tier without one", () => {
    expect(verdictFor(EXPECTED, { rate: rate("resident") }).reason).toBe("matches_expected");
    // The Access tier has no Pass variant — its unlock is already free, so a
    // Pass changes nothing and there is no dollar in question.
    expect(verdictFor(EXPECTED, { rate: rate("equity") }).reason).toBe("matches_expected");
  });
});

describe("tax is on top of the fare, not on the discount", () => {
  it("expects tax on unlock + minutes, and absorbs its rounding", () => {
    const taxed = equityAreaEstimateWithTax(MINUTES * 60_000, 0.0915);
    expect(taxed.tax).toBe(Math.round((taxed.unlock + taxed.perMin) * 0.0915));
    const r = receiptVerdict(confirmRead({ minutes: MINUTES, totalCents: taxed.total }), {
      startedOrEndedInArea: true,
      rate: rate("resident"),
      taxRate: 0.0915,
    });
    expect(r.verdict).toBe("correct");
  });
});

describe("confirmation is the third condition, and it is a type", () => {
  it("is the only way to build the input this takes", () => {
    // §8.4 requires that the rider has confirmed the figures and §8.3 makes the
    // step un-skippable. Enforced by construction rather than by a boolean nobody
    // checks — which is also why the reason enum has no code for "unconfirmed":
    // such a receipt never reaches the verdict.
    const confirmed = confirmRead({ minutes: 15, totalCents: 295 });
    expect(confirmed.__confirmed).toBe(true);
    expect(confirmed.minutes).toBe(15);
    expect(confirmed.totalCents).toBe(295);
  });

  it("uses the receipt's own billed minutes, never re-derived ones", () => {
    // The receipt is the document the complaint is about. Veo bills the started
    // minute, so its printed figure is already whole, and arguing with it would
    // put our arithmetic in the complaint instead of theirs.
    const r = receiptVerdict(confirmRead({ minutes: 1, totalCents: 113 }), ctx());
    expect(r.expected!.perMin).toBe(13);
    expect(r.expected!.total).toBe(113);
    expect(r.verdict).toBe("correct");
  });
});

describe("the support address is not guessed", () => {
  it("is blank until somebody fills it from Veo's own published contact", () => {
    // Every other Veo endpoint in config.ts was verified against something Veo
    // publishes. A plausible-looking address is worse than none: the complaint
    // path's whole value is that it reaches somebody, and a wrong recipient
    // produces a rider who believes they filed a billing query and did not.
    expect(complaintReady()).toBe(false);
    expect(VEO_SUPPORT_EMAIL).toBe("");
  });

  it("gates the complaint path on a real address, not on a truthy string", () => {
    // A mailto: with an empty `to` opens a blank draft, which looks like the
    // feature working.
    expect(complaintReady()).toBe(VEO_SUPPORT_EMAIL.includes("@"));
  });

  it("cites the contract row verbatim, with no adjectives", () => {
    // At the single-receipt level an overcharge is indistinguishable from a bug,
    // and it should read like the billing query it is.
    expect(EQUITY_DISCOUNT_CITATION).toContain("Exhibit A §5.2");
    expect(EQUITY_DISCOUNT_CITATION).toContain("$0.13/minute");
    for (const word of ["illegal", "owe", "refund", "violation", "overcharge"]) {
      expect(EQUITY_DISCOUNT_CITATION.toLowerCase()).not.toContain(word);
    }
  });
});
