// Phase 5's arithmetic (§5.3). The claims under test are all claims about
// MONEY A RIDER WILL OR WILL NOT RECEIVE, so each one is asserted against the
// contract figures rather than against whatever the code currently returns.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TripLeg, TripPlan } from "./along-the-way.ts";
import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import {
  __resetEquityAreasForTest,
  loadEquityAreas,
  type EquityAreaCollection,
} from "./equity-areas.ts";
import {
  MIN_SAVING_CENTS,
  equityBreakEvenMinutes,
  equityDisclosures,
  hasEquityLeg,
  startInAreaSaving,
  startsOrEndsInArea,
} from "./equity-savings.ts";

const rate = (key: RatePlanKey) => RATE_PLANS.find((p) => p.key === key)!;

/** Verified inside EQ_001; the same coordinate `equity-areas.test.ts` and
 *  `along-the-way.test.ts` use, so no two files disagree about the map. */
const INSIDE = { lat: 39.785137, lng: -104.826320 };
/** Washington Park — inside Denver, inside no equity area. The case that must
 *  answer false rather than "close enough". */
const OUTSIDE = { lat: 39.7, lng: -104.97 };

const MAP = JSON.parse(
  readFileSync("public/equity-areas.geojson", "utf8"),
) as EquityAreaCollection;

async function withPolygons(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => MAP }),
  );
  await loadEquityAreas();
}

afterEach(() => {
  __resetEquityAreasForTest();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Plan fixtures. Built by hand rather than by running `rankPlans`, because
// these functions take plans as data and a search would make every assertion
// also a claim about the planner's ranking.
// ---------------------------------------------------------------------------

function walk(seconds: number): TripLeg {
  return {
    mode: "walk",
    seconds,
    meters: seconds * 1.33,
    unlockCents: 0,
    minuteCents: 0,
    taxCents: 0,
    freeMinutesUsed: 0,
    equityArea: false,
  };
}

function ride(over: Partial<TripLeg> = {}): TripLeg {
  return {
    mode: "ride",
    seconds: 600,
    meters: 3000,
    unlockCents: 100,
    minuteCents: 250,
    taxCents: 0,
    freeMinutesUsed: 0,
    equityArea: false,
    ...over,
  };
}

function plan(legs: TripLeg[]): TripPlan {
  let totalSeconds = 0;
  let estimatedCents = 0;
  let rides = 0;
  for (const l of legs) {
    totalSeconds += l.seconds;
    estimatedCents += l.unlockCents + l.minuteCents + l.taxCents;
    if (l.mode === "ride") rides += 1;
  }
  return {
    legs,
    totalSeconds,
    estimatedCents,
    handOffs: Math.max(0, rides - 1),
    generalisedCost: totalSeconds,
    isEstimate: true,
  };
}

/** A 10-minute ride at the Resident tier: $1 + 10 × 25¢ = $3.50. */
const baselinePlan = plan([walk(120), ride()]);
/** The same ride billed at the Equity Area rate: $1 + 10 × 13¢ = $2.30, for
 *  two more minutes of walking. $1.20 saved. */
const equityPlan = plan([
  walk(240),
  ride({ equityArea: true, unlockCents: 100, minuteCents: 130 }),
]);

describe("startsOrEndsInArea", () => {
  it("stays quiet when either end is already inside — there is nothing to advise", async () => {
    await withPolygons();
    // Master §9.1: "a trip whose destination is already inside an Equity Area
    // is discounted however it starts. The optimizer must recognize that and
    // stay quiet." Both orders, because the contract says start OR end.
    expect(startsOrEndsInArea(OUTSIDE, INSIDE)).toBe(true);
    expect(startsOrEndsInArea(INSIDE, OUTSIDE)).toBe(true);
    expect(startsOrEndsInArea(INSIDE, INSIDE)).toBe(true);
  });

  it("answers false only when it has actually looked", async () => {
    await withPolygons();
    expect(startsOrEndsInArea(OUTSIDE, OUTSIDE)).toBe(false);
  });

  it("answers null — not false — before the polygons load", () => {
    // `equity-areas.ts` requires callers to distinguish these. Flattened to
    // false, this would advertise "walk into an area" to a rider who may
    // already be standing in one.
    expect(startsOrEndsInArea(INSIDE, OUTSIDE)).toBeNull();
    expect(startsOrEndsInArea(OUTSIDE, OUTSIDE)).toBeNull();
  });
});

describe("the break-even, against master §9.1's own figures", () => {
  it("sits near 8.3 riding minutes for a Resident and 3.9 for a Visitor", () => {
    // (25¢ − 13¢) × t = $1.00  →  t = 8.33
    expect(equityBreakEvenMinutes(rate("resident"))!).toBeCloseTo(8.33, 2);
    // (39¢ − 13¢) × t = $1.00  →  t = 3.85
    expect(equityBreakEvenMinutes(rate("visitor"))!).toBeCloseTo(3.85, 2);
  });

  it("is the SAME for a Pass rider, because the area's $1 is charged either way", () => {
    // This is §5.2's "worse VeoPlus reading" expressed as a number. If the
    // Pass were assumed to waive the area unlock, a Plus rider would break
    // even immediately and the threshold would collapse to zero.
    expect(equityBreakEvenMinutes(rate("resident_plus"))!).toBeCloseTo(8.33, 2);
    expect(equityBreakEvenMinutes(rate("visitor_plus"))!).toBeCloseTo(3.85, 2);
  });

  it("is null for the Access tier", () => {
    expect(equityBreakEvenMinutes(rate("equity"))).toBeNull();
  });

  it("is null for a tier the area rate does not undercut", () => {
    // Not reachable from RATE_PLANS today, and the guard is still load-bearing:
    // without it a 13¢ tier returns Infinity and a 10¢ tier returns a negative
    // number of minutes, both of which a surface would happily render.
    expect(
      equityBreakEvenMinutes({ key: "resident", label: "x", unlockCents: 100, perMinCents: 13 }),
    ).toBeNull();
    expect(
      equityBreakEvenMinutes({ key: "resident", label: "x", unlockCents: 100, perMinCents: 10 }),
    ).toBeNull();
  });
});

describe("startInAreaSaving", () => {
  it("reports the saving and what it costs in walking", () => {
    const s = startInAreaSaving(equityPlan, baselinePlan, rate("resident"));
    expect(s).not.toBeNull();
    expect(s!.savingCents).toBe(120);
    expect(s!.savingLabel).toBe("$1.20");
    expect(s!.extraWalkMinutes).toBe(2);
  });

  it("never reports negative walking for a plan that also walks less", () => {
    const shorterWalk = plan([
      walk(60),
      ride({ equityArea: true, unlockCents: 100, minuteCents: 130 }),
    ]);
    const s = startInAreaSaving(shorterWalk, baselinePlan, rate("resident"));
    expect(s!.extraWalkMinutes).toBe(0);
  });

  it("is null for the Access tier, whose interaction with the area rate is unstated", () => {
    expect(startInAreaSaving(equityPlan, baselinePlan, rate("equity"))).toBeNull();
  });

  it("is null when the plan has no equity leg at all", () => {
    // Otherwise the chip names a discount this plan does not receive.
    const cheaper = plan([walk(120), ride({ minuteCents: 100 })]);
    expect(hasEquityLeg(cheaper)).toBe(false);
    expect(startInAreaSaving(cheaper, baselinePlan, rate("resident"))).toBeNull();
  });

  it("suppresses a saving under fifty cents", () => {
    // $3.50 baseline vs $3.05 — 45¢, under the floor.
    const thin = plan([walk(120), ride({ equityArea: true, unlockCents: 100, minuteCents: 205 })]);
    expect(baselinePlan.estimatedCents - thin.estimatedCents).toBe(45);
    expect(45).toBeLessThan(MIN_SAVING_CENTS);
    expect(startInAreaSaving(thin, baselinePlan, rate("resident"))).toBeNull();
  });

  it("suppresses the NEGATIVE case a Pass rider on a short ride actually hits", () => {
    // Resident w/ VeoPlus, 4-minute ride. Their own tier: $0 + 4 × 25¢ = $1.00.
    // The equity leg: $1 charged (worse reading) + 4 × 13¢ = $1.52. The
    // "discount" costs 52¢, and the break-even above says why — 4 minutes is
    // under 8.33. A floor that only screened small POSITIVE savings would
    // have offered this one.
    const plusBaseline = plan([walk(120), ride({ seconds: 240, unlockCents: 0, minuteCents: 100 })]);
    const plusEquity = plan([
      walk(240),
      ride({ seconds: 240, equityArea: true, unlockCents: 100, minuteCents: 52 }),
    ]);
    expect(plusEquity.estimatedCents).toBeGreaterThan(plusBaseline.estimatedCents);
    expect(startInAreaSaving(plusEquity, plusBaseline, rate("resident_plus"))).toBeNull();
  });

  it("offers the same Pass rider the plan once they are past the break-even", () => {
    // 20 minutes: their tier $0 + $5.00; the equity leg $1 + $2.60 = $3.60.
    // $1.40 saved, and 20 > 8.33.
    const plusBaseline = plan([walk(120), ride({ seconds: 1200, unlockCents: 0, minuteCents: 500 })]);
    const plusEquity = plan([
      walk(240),
      ride({ seconds: 1200, equityArea: true, unlockCents: 100, minuteCents: 260 }),
    ]);
    const s = startInAreaSaving(plusEquity, plusBaseline, rate("resident_plus"));
    expect(s!.savingCents).toBe(140);
  });
});

describe("the disclosures that travel with an equity plan (§5.2)", () => {
  it("names the tier the saving is computed for", () => {
    const saving = startInAreaSaving(equityPlan, baselinePlan, rate("resident"));
    const d = equityDisclosures(equityPlan, rate("resident"), saving);
    const line = d.find((x) => x.kind === "saving")!;
    expect(line.text).toContain("$1.20");
    expect(line.text).toContain("Resident");
  });

  it("prices the unlock at the charged reading and says that is an assumption", () => {
    const d = equityDisclosures(equityPlan, rate("resident_plus"), null);
    const line = d.find((x) => x.kind === "second_unlock")!;
    expect(line.text).toContain("$1.00");
    expect(line.text).toContain("VeoPlus");
    // The point of the line is that the better reading is NOT being assumed.
    expect(line.text).toMatch(/charged/i);
  });

  it("warns about re-rent only when the plan actually hands off", () => {
    const single = equityDisclosures(equityPlan, rate("resident"), null);
    expect(single.some((x) => x.kind === "re_rent")).toBe(false);

    const handOff = plan([
      walk(120),
      ride({ equityArea: true, unlockCents: 100, minuteCents: 130 }),
      walk(60),
      ride({ unlockCents: 100, minuteCents: 125 }),
    ]);
    const d = equityDisclosures(handOff, rate("resident"), null);
    const line = d.find((x) => x.kind === "re_rent")!;
    expect(line.text).toMatch(/dibs does not stop that/i);
  });

  it("always carries the screenshot caveat, with the figure it is about", () => {
    // We cannot promise the discount (master §9.2.1). The caveat is not an
    // extra shown when the saving is large; it is what makes the advice
    // honest, so it travels with every equity plan.
    for (const saving of [null, startInAreaSaving(equityPlan, baselinePlan, rate("resident"))]) {
      const d = equityDisclosures(equityPlan, rate("resident"), saving);
      const line = d.find((x) => x.kind === "screenshot")!;
      expect(line.text).toContain("$2.30");
      expect(line.text).toMatch(/screenshot/i);
    }
  });

  it("says nothing at all for the Access tier or a plan with no equity leg", () => {
    expect(equityDisclosures(equityPlan, rate("equity"), null)).toEqual([]);
    expect(equityDisclosures(baselinePlan, rate("resident"), null)).toEqual([]);
  });
});
