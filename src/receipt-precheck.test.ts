// The pre-check. Nearly every assertion here is about SENDING: the default on
// any uncertainty is to file the report, because a report we did not need
// costs an upload and a report we talked the rider out of costs them the claim.
import { describe, expect, it } from "vitest";

import { RATE_PLANS } from "./config.ts";
import { equityAreaEstimateWithTax } from "./ride-cost.ts";
import { nothingToClaimSentence, precheckReceipt } from "./receipt-precheck.ts";

const TAX = 0.0881;
const resident = RATE_PLANS.find((p) => p.key === "resident")!;
const pass = RATE_PLANS.find((p) => p.veoPlus === true)!;

/** What a correct 12-minute Equity Area trip costs, to the cent. */
const correct12 = equityAreaEstimateWithTax(12 * 60_000, TAX).total;

const input = (over: Partial<Parameters<typeof precheckReceipt>[0]> = {}) => ({
  minutes: 12,
  totalCents: correct12,
  startedOrEndedInArea: true as boolean | null,
  rate: resident,
  taxRate: TAX,
  ...over,
});

describe("a receipt with nothing to claim", () => {
  it("is held back, with both figures named", () => {
    const out = precheckReceipt(input());
    expect(out.kind).toBe("nothing_to_claim");
    if (out.kind !== "nothing_to_claim") return;
    expect(out.chargeCents).toBe(correct12);
    expect(out.expectedCents).toBe(correct12);
    expect(out.verdict.verdict).toBe("correct");
  });

  it("is held back when the rider was charged LESS than the discounted rate", () => {
    // A promo or a credit. They are better off and there is nothing to send.
    const out = precheckReceipt(input({ totalCents: correct12 - 150 }));
    expect(out.kind).toBe("nothing_to_claim");
  });

  it("says what it compared and gives no instruction", () => {
    const s = nothingToClaimSentence({ expectedCents: 256, chargeCents: 256 });
    expect(s).toContain("$2.56 charged against $2.56 expected");
    expect(s).toContain("haven't uploaded");
    // No congratulation, and no telling the rider what to do next.
    expect(s).not.toMatch(/good news|congratulat|you should|try /i);
  });
});

describe("everything uncertain sends", () => {
  it("sends when the figures suggest an overcharge", () => {
    const out = precheckReceipt(input({ totalCents: correct12 + 300 }));
    expect(out.kind).toBe("send");
    expect(out.verdict?.verdict).toBe("overcharged");
  });

  it("sends when we never established the geography", () => {
    // "We did not look" is not "we looked and it was outside", and the whole
    // point of the report is that the server CAN look.
    const out = precheckReceipt(input({ startedOrEndedInArea: null }));
    expect(out.kind).toBe("send");
    expect(out.verdict?.reason).toBe("no_geography");
  });

  it("sends when the trip looks outside every area", () => {
    // Our polygons and our matching are both fallible, and the rider came here
    // because they believe they were overcharged.
    const out = precheckReceipt(input({ startedOrEndedInArea: false }));
    expect(out.kind).toBe("send");
  });

  it("sends when we do not know the rider's tier", () => {
    const out = precheckReceipt(input({ rate: null }));
    expect(out.kind).toBe("send");
    expect(out.verdict?.reason).toBe("tier_unresolved");
  });

  it("sends for a Pass rider whose charge matches, because that dollar is unproven", () => {
    // §8.4 refuses to bless a Pass rider's matching charge: the area's $1 may
    // be one they did not owe. A pre-check that held the report back would be
    // telling them to stop looking.
    const out = precheckReceipt(input({ rate: pass }));
    expect(out.kind).toBe("send");
    expect(out.verdict?.reason).toBe("veoplus_unmodelled");
  });

  it("sends a subtotal-only report, which it cannot price", () => {
    const out = precheckReceipt(input({ totalCents: null }));
    expect(out.kind).toBe("send");
    expect(out.verdict).toBeNull();
  });

  it("sends rather than swallowing a report whose fields need fixing", () => {
    // `confirmRead` refuses figures that cannot be on a receipt. That refusal
    // is the form's business; the one thing a pre-check must not do is eat a
    // report because a field is wrong.
    for (const bad of [{ minutes: 0 }, { minutes: -4 }, { totalCents: -1 }]) {
      const out = precheckReceipt(input(bad));
      expect(out.kind).toBe("send");
      expect(out.verdict).toBeNull();
    }
  });
});
