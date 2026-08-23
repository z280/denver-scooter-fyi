// ride-cost.ts — the tax-aware breakdown (`estimateWithTax`), the
// `rideCostCents` regression (it must not change now that both functions
// share `costComponents` internally), and the tax-rate cache/refresh
// plumbing. `savedRatePlan`/`saveRatePlan`/etc. already had no test file and
// stay out of scope here — this lane only touches the cost math.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EQUITY_AREA_RATE,
  RATE_PLANS,
  type RatePlan,
  type RatePlanKey,
} from "./config.ts";
import {
  DEFAULT_TAX_RATE,
  billableMinutes,
  comparatorPassQuote,
  currentTaxRate,
  equityAreaCostCents,
  equityAreaEstimateWithTax,
  estimateWithTax,
  refreshTaxRate,
  resetTaxRateForTests,
  rideCostCents,
} from "./ride-cost.ts";

function plan(key: RatePlanKey): RatePlan {
  const p = RATE_PLANS.find((r) => r.key === key);
  if (!p) throw new Error(`no rate plan ${key}`);
  return p;
}

const MIN = 60_000;

afterEach(() => {
  resetTaxRateForTests();
});

// ---------------------------------------------------------------------------
// rideCostCents — regression: unchanged behavior after the costComponents
// refactor. Known-good values, hand-computed against the ORIGINAL
// (pre-refactor) formula, across every rate plan.
// ---------------------------------------------------------------------------

describe("rideCostCents — unchanged after the tax-breakdown refactor", () => {
  it("resident: $1 unlock + 25¢/min, 5 min", () => {
    expect(rideCostCents(plan("resident"), 5 * MIN)).toBe(100 + 5 * 25);
  });

  it("resident_plus: free unlock + 25¢/min, 5 min", () => {
    expect(rideCostCents(plan("resident_plus"), 5 * MIN)).toBe(5 * 25);
  });

  it("visitor: $1 unlock + 39¢/min, 12 min", () => {
    expect(rideCostCents(plan("visitor"), 12 * MIN)).toBe(100 + 12 * 39);
  });

  it("visitor_plus: free unlock + 39¢/min, 12 min", () => {
    expect(rideCostCents(plan("visitor_plus"), 12 * MIN)).toBe(12 * 39);
  });

  // The `equity` KEY is the Access Program tier (income-qualified, 60 free
  // min/day) — the server's rate_plan enum value. NOT the geographic Equity
  // Area discount, which is priced separately below.
  it("access tier: within the 60 free minutes/day costs nothing", () => {
    expect(rideCostCents(plan("equity"), 30 * MIN)).toBe(0);
    expect(rideCostCents(plan("equity"), 60 * MIN)).toBe(0);
  });

  it("access tier: exactly one minute over the free window bills one minute at 15¢", () => {
    expect(rideCostCents(plan("equity"), 61 * MIN)).toBe(15);
  });

  it("access tier: 70 min bills the 10 min overflow at 15¢/min, no unlock fee", () => {
    expect(rideCostCents(plan("equity"), 70 * MIN)).toBe(10 * 15);
  });

  it("the Access tier is not offered under a name that reads as the area discount", () => {
    // Two different Exhibit C rows. A rider who reads the tier's label as
    // the geographic discount concludes they are already receiving it and
    // never checks a receipt.
    const label = plan("equity").label;
    expect(label).toContain("Access Program");
    expect(label).not.toMatch(/Equity Area/i);
  });

  it("billable minutes round up (Veo bills per started minute)", () => {
    // 1 minute 1 second → 2 billable minutes.
    expect(billableMinutes(61_000)).toBe(2);
    expect(rideCostCents(plan("resident"), 61_000)).toBe(100 + 2 * 25);
  });

  it("a zero-length ride still bills at least one minute", () => {
    expect(billableMinutes(0)).toBe(1);
    expect(rideCostCents(plan("resident"), 0)).toBe(100 + 25);
  });
});

// ---------------------------------------------------------------------------
// estimateWithTax — breakdown math, additive-true, across every plan.
// ---------------------------------------------------------------------------

describe("estimateWithTax", () => {
  it("resident, 5 min @ 10% tax: unlock/perMin match rideCostCents' inputs, tax on the subtotal, total is additive", () => {
    const p = plan("resident");
    const elapsed = 5 * MIN;
    const b = estimateWithTax(p, elapsed, 0.1);
    expect(b.unlock).toBe(100);
    expect(b.perMin).toBe(5 * 25);
    const subtotal = b.unlock + b.perMin; // 225
    expect(b.tax).toBe(Math.round(subtotal * 0.1)); // 23 (round-half-up of 22.5)
    expect(b.total).toBe(b.unlock + b.perMin + b.tax);
    // Same base cost as the untouched rideCostCents — the regression the
    // lane brief specifically asks for.
    expect(b.unlock + b.perMin).toBe(rideCostCents(p, elapsed));
  });

  it("resident_plus (VeoPlus): $0.00 unlock renders honestly, not folded away", () => {
    const p = plan("resident_plus");
    const b = estimateWithTax(p, 5 * MIN, 0.1);
    expect(b.unlock).toBe(0);
    expect(b.perMin).toBe(5 * 25);
    expect(b.unlock + b.perMin).toBe(rideCostCents(p, 5 * MIN));
  });

  it("equity within the free window: unlock AND perMin are both $0.00, tax is $0.00, total is $0.00", () => {
    const p = plan("equity");
    const b = estimateWithTax(p, 45 * MIN, 0.0915);
    expect(b.unlock).toBe(0);
    expect(b.perMin).toBe(0);
    expect(b.tax).toBe(0);
    expect(b.total).toBe(0);
    expect(b.unlock + b.perMin).toBe(rideCostCents(p, 45 * MIN));
  });

  it("equity past the free window: tax applies only to the billed overflow minutes", () => {
    const p = plan("equity");
    const elapsed = 90 * MIN; // 30 min over the 60 free
    const b = estimateWithTax(p, elapsed, 0.1);
    expect(b.unlock).toBe(0);
    expect(b.perMin).toBe(30 * 15); // 450
    expect(b.tax).toBe(Math.round(450 * 0.1)); // 45
    expect(b.total).toBe(450 + 45);
    expect(b.unlock + b.perMin).toBe(rideCostCents(p, elapsed));
  });

  it("visitor, a tax rate that rounds down", () => {
    const p = plan("visitor");
    const elapsed = 3 * MIN; // 100 + 117 = 217
    const b = estimateWithTax(p, elapsed, 0.021); // 217 * 0.021 = 4.557 -> 5
    expect(b.unlock + b.perMin).toBe(217);
    expect(b.tax).toBe(5);
    expect(b.total).toBe(222);
  });

  it("zero tax rate: total equals the untaxed subtotal", () => {
    const p = plan("resident");
    const b = estimateWithTax(p, 10 * MIN, 0);
    expect(b.tax).toBe(0);
    expect(b.total).toBe(b.unlock + b.perMin);
  });

  it("defaults taxRate to currentTaxRate() when omitted", () => {
    resetTaxRateForTests(0.2);
    const p = plan("resident");
    const withDefault = estimateWithTax(p, 5 * MIN);
    const explicit = estimateWithTax(p, 5 * MIN, 0.2);
    expect(withDefault).toEqual(explicit);
  });

  it("every rate plan: the breakdown's base cost always matches rideCostCents, whatever the tax rate", () => {
    for (const key of RATE_PLANS.map((p) => p.key)) {
      for (const minutes of [0, 1, 30, 59, 60, 61, 90, 180]) {
        const p = plan(key);
        const elapsed = minutes * MIN;
        const b = estimateWithTax(p, elapsed, 0.0881);
        expect(b.unlock + b.perMin).toBe(rideCostCents(p, elapsed));
        expect(b.total).toBe(b.unlock + b.perMin + b.tax);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tax-rate cache / refresh
// ---------------------------------------------------------------------------

describe("currentTaxRate / refreshTaxRate", () => {
  beforeEach(() => resetTaxRateForTests());

  it("starts at DEFAULT_TAX_RATE", () => {
    expect(currentTaxRate()).toBe(DEFAULT_TAX_RATE);
  });

  it("adopts a successfully fetched rate", async () => {
    const fetcher = vi.fn().mockResolvedValue({ tax_rate: 0.0881 });
    const rate = await refreshTaxRate(fetcher);
    expect(rate).toBe(0.0881);
    expect(currentTaxRate()).toBe(0.0881);
  });

  it("keeps the last known rate when the fetch rejects (offline / pre-A1)", async () => {
    resetTaxRateForTests(0.0881);
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const rate = await refreshTaxRate(fetcher);
    expect(rate).toBe(0.0881);
    expect(currentTaxRate()).toBe(0.0881);
  });

  it("ignores a negative or non-finite rate rather than adopting garbage", async () => {
    resetTaxRateForTests(0.05);
    await refreshTaxRate(vi.fn().mockResolvedValue({ tax_rate: -1 }));
    expect(currentTaxRate()).toBe(0.05);
    await refreshTaxRate(vi.fn().mockResolvedValue({ tax_rate: Number.NaN }));
    expect(currentTaxRate()).toBe(0.05);
  });

  it("a later estimateWithTax call picks up the refreshed rate by default", async () => {
    await refreshTaxRate(vi.fn().mockResolvedValue({ tax_rate: 0.15 }));
    const p = plan("resident");
    const b = estimateWithTax(p, 5 * MIN);
    expect(b.tax).toBe(Math.round((b.unlock + b.perMin) * 0.15));
  });
});

// ---------------------------------------------------------------------------
// comparatorPassQuote — the pass ladder ($2.99/30, $4.99/60, $12.99/120,
// unlocks included) mapped from ride duration. Smallest covering pass, NOT a
// min-cost cover — see the function's own doc comment for why a 90-minute
// ride quotes the $12.99 pass rather than a clever 60+30 stack.
// ---------------------------------------------------------------------------

describe("comparatorPassQuote", () => {
  it("a short ride fits the 30-minute pass", () => {
    expect(comparatorPassQuote(10 * MIN)).toEqual({
      cents: 299,
      minutes: 30,
      passCount: 1,
    });
    // Exactly 30 minutes still fits — the pass covers 30, not 29.
    expect(comparatorPassQuote(30 * MIN).cents).toBe(299);
  });

  it("minute 31 tips into the 60-minute pass", () => {
    expect(comparatorPassQuote(31 * MIN)).toEqual({
      cents: 499,
      minutes: 60,
      passCount: 1,
    });
    expect(comparatorPassQuote(60 * MIN).cents).toBe(499);
  });

  it("61-120 minutes quotes the single 120-minute pass — the ladder as published, not a 60+30 stack", () => {
    expect(comparatorPassQuote(90 * MIN)).toEqual({
      cents: 1299,
      minutes: 120,
      passCount: 1,
    });
    expect(comparatorPassQuote(120 * MIN).cents).toBe(1299);
  });

  it("beyond the largest pass, stacks additional 120s until the remainder fits", () => {
    // 121 min: one 120 pass + the 30 covering the last minute.
    expect(comparatorPassQuote(121 * MIN)).toEqual({
      cents: 1299 + 299,
      minutes: 150,
      passCount: 2,
    });
  });

  it("bills per started minute, same as the metered comparator (30:01 needs the 60 pass)", () => {
    expect(comparatorPassQuote(30 * MIN + 1000).cents).toBe(499);
  });
});

// ---------------------------------------------------------------------------
// Equity Area pricing — Exhibit A §5.2 (the obligation) and Exhibit C (the
// rate). This is the number a rider holds up against their receipt, so the
// arithmetic gets pinned to the figures the contract itself states.
// ---------------------------------------------------------------------------
describe("equity area pricing", () => {
  it("is $1 unlock + 13¢/min, exactly as Exhibit C states it", () => {
    expect(EQUITY_AREA_RATE.unlockCents).toBe(100);
    expect(EQUITY_AREA_RATE.perMinCents).toBe(13);
  });

  it("prices the contract's own worked example: $2.30 for 10 minutes", () => {
    // Exhibit C spells this out — 10 min / 1 mi is $2.30 against a $4.90
    // base fare. If this assertion ever fails, the app and the contract
    // disagree about the discount, which is the one thing it cannot do.
    expect(equityAreaCostCents(10 * MIN)).toBe(230);
  });

  it("charges the unlock once, not per minute", () => {
    expect(equityAreaCostCents(1 * MIN)).toBe(100 + 13);
    expect(equityAreaCostCents(20 * MIN)).toBe(100 + 20 * 13);
  });

  it("bills per started minute, like every other Veo rate", () => {
    expect(equityAreaCostCents(61_000)).toBe(100 + 2 * 13);
  });

  it("gives no free-minute credit — that belongs to the Access tier", () => {
    // The two were conflated before; a 30-minute area ride is NOT free.
    expect(equityAreaCostCents(30 * MIN)).toBe(100 + 30 * 13);
    expect(equityAreaCostCents(30 * MIN)).not.toBe(
      rideCostCents(plan("equity"), 30 * MIN),
    );
  });

  it("is cheaper than every standard tier for a typical ride", () => {
    // The whole claim the indicator makes. If this stopped holding, the
    // app would be telling riders to chase a discount that costs them more.
    const ride = 10 * MIN;
    const area = equityAreaCostCents(ride);
    for (const key of ["resident", "resident_plus", "visitor", "visitor_plus"] as const) {
      expect(area).toBeLessThan(rideCostCents(plan(key), ride));
    }
  });

  it("breaks the fare out for the summary, taxed like any other", () => {
    resetTaxRateForTests(0.1);
    const b = equityAreaEstimateWithTax(10 * MIN);
    expect(b.unlock).toBe(100);
    expect(b.perMin).toBe(130);
    expect(b.tax).toBe(23);          // 10% of $2.30
    expect(b.total).toBe(253);
    // Additive-true, same contract as estimateWithTax.
    expect(b.unlock + b.perMin + b.tax).toBe(b.total);
    resetTaxRateForTests();
  });
});
