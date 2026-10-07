// Phase 8 §8.4 — the three-part bar. Pure: it never touches the DOM, never
// sends anything, and never phrases an accusation. It answers one question
// about one receipt, and its most important answer is "cannot tell".
//
// ---------------------------------------------------------------------------
// "DIFFERS" IS THE WRONG TEST, and this is the whole design.
//
// A promotional rate, an account credit and a free Access trip all differ from
// $1 + 13¢/min while leaving the rider BETTER OFF. A tool that writes to support
// about those is worse than useless to the people it is for: it spends their
// credibility on a complaint that is wrong, and it spends it first on the riders
// who get the most promos. So the comparison is ONE-SIDED — the charge must
// demonstrably EXCEED the expected charge — and the margin below absorbs the ways
// a correct charge legitimately fails to equal the arithmetic.
//
// Everything that is not a provable overcharge is `cannot_tell` or `correct`.
// There is no path from this function to "overcharged" that does not clear all
// three conditions.
// ---------------------------------------------------------------------------

import { EQUITY_AREA_RATE, type RatePlan } from "./config.ts";
import {
  equityAreaEstimateWithTax,
  planFor,
  type RideCostBreakdown,
} from "./ride-cost.ts";

/** How much a charge may exceed the expected figure before we will call it an
 *  overcharge. Cents.
 *
 *  10¢ HAS A REAL CEILING RATHER THAN BEING A MATTER OF TASTE, and the ceiling
 *  is the part to keep if the figure is ever revisited: one minute of the Equity
 *  Area discount is 12¢ (25¢ base against 13¢), so a margin at or above 12¢
 *  makes the SHORTEST TRIPS UNPROVABLE — a one-minute overcharge would fall
 *  inside it. That is the opposite of this phase's purpose.
 *
 *  Below that ceiling, the only thing left to absorb is rounding: `estimateWithTax`
 *  rounds tax to the nearest cent, and `billableMinutes` is `ceil` with a floor of
 *  1, so a correct charge can sit a cent or two off the arithmetic. */
export const MARGIN_CENTS = 10;

/** One minute of the discount, which is what bounds `MARGIN_CENTS`. Exported so
 *  the bound is assertable rather than described.
 *
 *  DERIVED, NOT WRITTEN DOWN. The plan states it as "25¢ base against 13¢", and
 *  hardcoding the 25 would let a change to the Resident rate leave this constant
 *  — and the paragraph above it — quietly wrong about the one thing it exists to
 *  bound.
 *
 *  THE RESIDENT TIER IS THE RIGHT ONE and not just the one the plan happened to
 *  name. A Visitor's discount is larger (39¢ − 13¢ = 26¢), so it is not the
 *  binding case. The Access tier's per-minute gap is smaller (15¢ − 13¢ = 2¢) and
 *  is still not the binding case, because the comparison is against the AREA rate
 *  including its $1: an Access rider has no unlock, so a one-minute trip billed at
 *  their own tier comes to 15¢ against an expected $1.13 — nearly a dollar BELOW,
 *  which this verdict calls `correct` and never complains about. For short trips
 *  the area rate is worse for an Access rider, so there is no overcharge to make
 *  provable. */
export const SHORTEST_PROVABLE_CENTS =
  planFor("resident").perMinCents - EQUITY_AREA_RATE.perMinCents;

export type ReceiptVerdict = "overcharged" | "correct" | "cannot_tell";

export type ReceiptVerdictReason =
  /** The charge demonstrably exceeds the expected charge. The only route to
   *  `overcharged`. */
  | "exceeds_bar"
  /** The charge is the expected one, or lower. Nothing to complain about. */
  | "matches_expected"
  /** We cannot establish that the trip started or ended inside an Equity Area,
   *  so the geographic half of the entitlement is unanswered. */
  | "no_geography"
  /** It is more, but by less than `MARGIN_CENTS` — inside rounding. */
  | "inside_margin"
  /** The rider holds a VeoPlus Pass and the charge matches the worse reading of
   *  a dollar the contract does not settle. */
  | "veoplus_unmodelled"
  /** We do not know which tier the rider is on, so there is no expected charge
   *  to compare against. */
  | "tier_unresolved";

/** What the rider CONFIRMED, field by field, over their own screenshot.
 *
 *  THE TYPE IS THE THIRD CONDITION. §8.4 requires that "the rider has confirmed
 *  the figures", and §8.3 makes the confirm step un-skippable. That is enforced
 *  here by construction rather than by a `confirmed: boolean` nobody checks —
 *  only `confirmRead()` produces one of these, and nothing else can. It is also
 *  why the reason enum has no code for "unconfirmed": an unconfirmed receipt
 *  never reaches this function, so there is no verdict to explain. */
export interface ConfirmedReceipt {
  readonly __confirmed: true;
  /** Veo's own billed minutes, as printed. Not re-derived from timestamps: the
   *  receipt is the document the complaint is about. */
  minutes: number;
  /** Total charged, cents, including tax — the figure on the receipt. */
  totalCents: number;
}

/** The only way to make a `ConfirmedReceipt`. Called by §8.3's confirm step,
 *  after the rider has looked at each field over their own screenshot. */
export function confirmRead(fields: {
  minutes: number;
  totalCents: number;
}): ConfirmedReceipt {
  return { __confirmed: true, minutes: fields.minutes, totalCents: fields.totalCents };
}

export interface VerdictContext {
  /** Did the trip demonstrably start or end inside an Equity Area?
   *
   *  THREE-VALUED, and `null` is the common case rather than an edge one. Many
   *  receipts show time and money and no geography at all, so this is answered
   *  by matching the receipt to the rider's OWN tracked ride and reading its
   *  endpoints. When there is no match, we have not looked — which is not the
   *  same as having looked and found the trip outside, and only one of those is
   *  the rider's fault to live with. Both end in `cannot_tell`; the distinction
   *  is kept because the panel's sentence differs. */
  startedOrEndedInArea: boolean | null;
  /** The rider's tier. `null` when unknown — they have not told us and are not
   *  signed in — in which case there is no expected charge. */
  rate: RatePlan | null;
  /** The tax rate the expected charge is computed with. Injected for the same
   *  reason the planner injects it: `ride-cost.ts` holds it as mutable module
   *  state. */
  taxRate: number;
}

export interface VerdictResult {
  verdict: ReceiptVerdict;
  reason: ReceiptVerdictReason;
  /** What the trip should have cost under the Equity Area rate, when that could
   *  be computed. Null whenever the reason is `no_geography` or
   *  `tier_unresolved` — there is nothing to show beside the charge.
   *
   *  Carried so the panel and §8.5's complaint body quote the SAME figure this
   *  verdict was reached with. A second derivation in the UI is a second answer,
   *  and the one in the email is the one that gets argued about. */
  expected: RideCostBreakdown | null;
  /** `charge − expected`, cents. Null alongside `expected`. Positive means the
   *  rider paid more. */
  differenceCents: number | null;
}

/** Is this tier a VeoPlus Pass variant? */
function hasPass(rate: RatePlan): boolean {
  return rate.veoPlus === true;
}

/**
 * The bar. All three conditions, or no claim is made.
 *
 * ORDER IS LOAD-BEARING. Geography and the tier are checked before any
 * arithmetic, because without either there is no expected charge — and an
 * arithmetic comparison against a figure we could not compute is how a tool
 * like this produces a confident wrong answer.
 */
export function receiptVerdict(
  receipt: ConfirmedReceipt,
  ctx: VerdictContext,
): VerdictResult {
  const unresolved = (reason: ReceiptVerdictReason): VerdictResult => ({
    verdict: "cannot_tell",
    reason,
    expected: null,
    differenceCents: null,
  });

  // 1. The geographic half of the entitlement. Exhibit A §5.2 discounts a trip
  //    that STARTS OR ENDS inside a polygon; a trip that merely passed through
  //    one earns nothing, so "we could not establish it" and "it is outside"
  //    both mean there is no claim here.
  if (ctx.startedOrEndedInArea !== true) return unresolved("no_geography");

  // 2. Whose tier. Without it there is no "applicable expected charge" at all.
  if (ctx.rate === null) return unresolved("tier_unresolved");

  // The expected charge. `equityAreaEstimateWithTax` takes elapsed MILLISECONDS
  // and runs them through `billableMinutes`, so the receipt's own billed minutes
  // go in as whole minutes and come out unchanged — the receipt is the document
  // the complaint is about, and re-deriving its minutes from timestamps would
  // argue with it.
  //
  // IT TAKES NO `RatePlan`, and that is right: the Equity Area rate is not a
  // tier. Exhibit C prices it at $1 + 13¢/min for any trip that starts or ends
  // inside a polygon, whatever tier the rider is on, and the $1 is charged under
  // the worse reading because the contract does not say a Pass waives it.
  const expected = equityAreaEstimateWithTax(receipt.minutes * 60_000, ctx.taxRate);
  const differenceCents = receipt.totalCents - expected.total;
  const resolved = (
    verdict: ReceiptVerdict,
    reason: ReceiptVerdictReason,
  ): VerdictResult => ({ verdict, reason, expected, differenceCents });

  // 3. One-sided, and clear of the margin.
  if (differenceCents > MARGIN_CENTS) return resolved("overcharged", "exceeds_bar");

  // Within the margin either way: the charge matches the worse reading.
  if (differenceCents >= -MARGIN_CENTS) {
    // A PASS RIDER CANNOT BE TOLD THIS IS CORRECT, and this is an
    // interpretation of §8.4's "VeoPlus stays unmodelled" rather than a
    // restatement of it, so it is worth being explicit.
    //
    // `expected` includes the area's $1 because the contract does not say a Pass
    // waives it and this phase takes the worse reading. A Pass rider whose charge
    // matches that figure may therefore have paid a dollar they did not owe —
    // which we will not claim, because we cannot prove it, and must not bless,
    // because "correct" would tell them to stop looking.
    //
    // The alternative reading is to answer `correct` here and treat the dollar as
    // settled. That would make this verdict say the opposite of what §9.2.3 says
    // about the same dollar, for the sake of a tidier answer.
    if (hasPass(ctx.rate)) return resolved("cannot_tell", "veoplus_unmodelled");
    // More, but inside rounding. Never `overcharged`.
    if (differenceCents > 0) return resolved("cannot_tell", "inside_margin");
    return resolved("correct", "matches_expected");
  }

  // Well below the expected charge: a promo, a credit, or a Pass that does waive
  // the dollar. The rider is better off and there is nothing to complain about —
  // including for a Pass rider, where being a full unlock light is the BETTER
  // reading having been applied rather than an ambiguity.
  return resolved("correct", "matches_expected");
}

/** Whether this verdict may open §8.5's complaint path.
 *
 *  ONLY `overcharged`. A complaint built on `cannot_tell` is the rider spending
 *  their credibility on our uncertainty, and `correct` has nothing to send. */
export function mayComplain(result: VerdictResult): boolean {
  return result.verdict === "overcharged";
}
