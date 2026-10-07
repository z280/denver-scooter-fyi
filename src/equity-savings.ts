// Phase 5 — Equity Area savings (frontend plan §5, master plan §9).
//
// Pure. Owns no money rule and no geometry: money comes from `ride-cost.ts`
// and `config.ts`, polygons from `equity-areas.ts`. What it owns is the
// RIDER-FACING ARITHMETIC — "is there a saving here, how big, and what does
// it cost you" — plus the disclosures that must travel with the answer.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE DELIBERATELY DOES NOT CONTAIN: `equityLegRate`.
//
// §5.1 asks for a third entry point, `equityLegRate(leg, {from, to, rate})`,
// answering "does this leg bill at the Equity Area rate". That function
// already exists and already shipped: `along-the-way.ts`'s `legRate(rate,
// from, to)`, which is what Phase 2's `priceRide` calls on every ride edge.
// It has the same inputs §5.1 arrived at (the leg's own endpoints and the
// rider's `RatePlan`), takes the same worse-reading view of the $1 unlock,
// and treats a null polygon answer as outside.
//
// Writing a second copy here would be the Phase 6 seam-2 mistake in the money
// layer: two mechanisms that agree by coincidence until one is edited. Worse,
// this copy would be the one the DISCLOSURE reads while the planner kept
// using its own — which is precisely the "planner and disclosure disagree
// about the same leg" failure §5.1 spends three paragraphs forbidding.
//
// So the rate rule has one home, and it is the planner's. What this module
// adds is the half `legRate` cannot answer, because a rate is not a saving: a
// saving needs something to be saved AGAINST.
// ---------------------------------------------------------------------------

import { EQUITY_AREA_RATE, type RatePlan } from "./config.ts";
import { isInEquityArea } from "./equity-areas.ts";
import { formatCents } from "./ride-cost.ts";
import type { LngLat, TripPlan } from "./along-the-way.ts";

/** A plan whose only advantage is a saving smaller than this is not offered
 *  at all (§5.2). Advice costs the rider attention and a behaviour change;
 *  under fifty cents it is not worth either, and offering it trains riders to
 *  ignore the chip that will one day say $1.80. */
export const MIN_SAVING_CENTS = 50;

/** Is either end of this trip already inside an Equity Area?
 *
 *  `true` — the trip is discounted however it is ridden, so there is nothing
 *  to advise and the optimizer stays quiet (master §9.1: "a trip whose
 *  destination is already inside an Equity Area is discounted however it
 *  starts. The optimizer must recognize that and stay quiet").
 *
 *  `null` — the polygons have not loaded. Propagated rather than flattened to
 *  `false`, because `equity-areas.ts` requires callers to distinguish them:
 *  answering `false` here would advertise a saving for walking into an area
 *  the rider may already be standing in. Callers stay quiet on `null` too;
 *  the two reasons for silence differ but the silence is the same. */
export function startsOrEndsInArea(from: LngLat, to: LngLat): boolean | null {
  const a = isInEquityArea(from.lng, from.lat);
  const b = isInEquityArea(to.lng, to.lat);
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

/** Riding minutes past which the Equity Area rate pays for one extra $1
 *  unlock, at zero detour — master §9.1's break-even, which is why that
 *  section quotes ~8.3 minutes for a Resident (12¢/min saved) and ~3.9 for a
 *  Visitor (26¢/min saved).
 *
 *  WHEN THE EXTRA DOLLAR EXISTS, because this threshold is meaningless
 *  without it. A plain 5a trip on a non-Pass tier pays one unlock either way
 *  — $1 ordinary or $1 area — so it saves from the first minute and has no
 *  break-even at all. The dollar appears in exactly two places: the SECOND
 *  unlock of a hand-off (master §9.1's formula names it), and a Pass rider's
 *  equity leg, whose $1 is charged under the worse reading while their
 *  ordinary unlock is waived. Both are one extra dollar, so both break even
 *  here.
 *
 *  `null` for the Access tier, and for any tier the area rate does not
 *  actually undercut: a hypothetical tier at or below 13¢/min never breaks
 *  even, and `Infinity` is not an answer to show a rider.
 *
 *  UNROUNDED on purpose. It is a threshold to compare minutes against, not a
 *  label; rounding it to 8 would offer a plan that loses money for 20
 *  seconds of every minute between 8 and 8.34. */
export function equityBreakEvenMinutes(rate: RatePlan): number | null {
  if (rate.key === "equity") return null;
  const savedPerMin = rate.perMinCents - EQUITY_AREA_RATE.perMinCents;
  if (savedPerMin <= 0) return null;
  return EQUITY_AREA_RATE.unlockCents / savedPerMin;
}

/** The Phase 5a chip's figures — "starts in an Equity Area · saves $1.80 ·
 *  2 min more walking". */
export interface StartInAreaSaving {
  /** Cents the rider keeps by taking `plan` over `baseline`. Always > 0 and
   *  at least `MIN_SAVING_CENTS`, or there is no saving and this is `null`. */
  savingCents: number;
  /** Extra walking `plan` costs over `baseline`, in whole minutes, rounded up
   *  — the figure the rider is being asked to spend. Never negative: a plan
   *  that saves money AND walks less is not a trade-off and says nothing
   *  about walking. */
  extraWalkMinutes: number;
  /** `savingCents` as "$1.80", for the chip. */
  savingLabel: string;
}

/** Total walk seconds in a plan. */
function walkSeconds(plan: TripPlan): number {
  let s = 0;
  for (const leg of plan.legs) if (leg.mode === "walk") s += leg.seconds;
  return s;
}

/** Does any ride leg of this plan bill at the Equity Area rate? */
export function hasEquityLeg(plan: TripPlan): boolean {
  return plan.legs.some((l) => l.equityArea === true);
}

/** Phase 5a: what `plan` saves over `baseline`, and what it costs in walking.
 *
 *  THE SIGNATURE §5.1 SKETCHED WAS `(candidate, spec, plan)`, AND IT CANNOT
 *  WORK. "Saves $1.80" and "2 min more walking" are both comparatives, and
 *  that signature carries nothing to compare against: a candidate plus a spec
 *  cannot say what the rider would otherwise have paid or walked, and a spec
 *  does not bear on money at all. The sketch predates revision 3b, which made
 *  the PLAN the unit the rider chooses between (§2.4's list) — and once two
 *  plans are in hand, the comparison is plan-to-plan and needs nothing else.
 *
 *  `baseline` is the best plan WITHOUT an equity leg. The caller picks it,
 *  because the caller is the one holding the ranked list; passing a baseline
 *  that is itself discounted would report the difference between two
 *  discounted plans as the discount.
 *
 *  `null` when there is nothing honest to say:
 *   - the Access tier, whose interaction with the area rate is unstated in
 *     the contract (§5.1, and `config.ts` declines to infer it);
 *   - `plan` has no equity leg, so the chip would name a discount it does not
 *     get;
 *   - the saving is under `MIN_SAVING_CENTS`, including the case where it is
 *     NEGATIVE. That case is real and is not an edge case: a VeoPlus rider
 *     pays no ordinary unlock, so an equity leg's own $1 — charged, per the
 *     worse reading — can cost more than the per-minute discount returns on a
 *     short ride. Over the break-even it is a saving again. */
export function startInAreaSaving(
  plan: TripPlan,
  baseline: TripPlan,
  rate: RatePlan,
): StartInAreaSaving | null {
  if (rate.key === "equity") return null;
  if (!hasEquityLeg(plan)) return null;
  const savingCents = baseline.estimatedCents - plan.estimatedCents;
  if (savingCents < MIN_SAVING_CENTS) return null;
  const extra = walkSeconds(plan) - walkSeconds(baseline);
  return {
    savingCents,
    extraWalkMinutes: Math.max(0, Math.ceil(extra / 60)),
    savingLabel: formatCents(savingCents),
  };
}

/** One line of §5.2's disclosure set. `kind` is enumerated so a surface can
 *  style or order them without matching on prose. */
export interface EquityDisclosure {
  kind: "saving" | "second_unlock" | "re_rent" | "screenshot";
  text: string;
}

/** The four things an equity plan must say, travelling WITH the plan (§5.2).
 *
 *  Not a card, and not conditioned on the saving being large: they are what
 *  makes an equity plan honest, so every plan carrying an equity leg carries
 *  them. Revision 3b deleted the stopover card they used to live on; these go
 *  in the plan's own details, where a rider opens any plan they are
 *  considering.
 *
 *  Empty for a plan with no equity leg, and for the Access tier — a rider who
 *  is never offered the advice does not need its caveats.
 *
 *  The re-rent line is in WORDS and carries no "another vehicle is standing
 *  there" check, because under the merged model it needs none: a hand-off
 *  plan is built out of a pickup that EXISTS, so master §9.2's mitigation is
 *  satisfied by the plan existing at all. What remains, and what this says,
 *  is the part no plan can mitigate — that between the two legs somebody can
 *  take it, and dibs does not prevent that. */
export function equityDisclosures(
  plan: TripPlan,
  rate: RatePlan,
  saving: StartInAreaSaving | null,
): EquityDisclosure[] {
  if (rate.key === "equity") return [];
  if (!hasEquityLeg(plan)) return [];
  const out: EquityDisclosure[] = [];

  if (saving) {
    // The tier is named because the saving is computed for it and for no
    // other: a rider who reads an unattributed figure and is on a different
    // tier has been told a number that is not theirs.
    out.push({
      kind: "saving",
      text: `Saves about ${saving.savingLabel} on the ${rate.label.split(" — ")[0]} rate.`,
    });
  }

  // Priced at the WORSE VeoPlus reading, which is not a choice made here:
  // `legRate` charges `EQUITY_AREA_RATE.unlockCents` whatever the tier, so
  // this reads the figure the plan was actually priced with rather than
  // asserting one beside it.
  const charged = plan.legs.filter((l) => l.equityArea === true && l.unlockCents > 0);
  const equityUnlocks = charged.reduce((n, l) => n + l.unlockCents, 0);
  if (equityUnlocks > 0) {
    // PLURALISED, because a plan can have more than one equity leg: a hand-off
    // whose BOTH legs start or end inside a polygon is two discounted legs and
    // two area unlocks, and "a $2.00 unlock for the Equity Area leg" reads as one
    // leg being charged double rather than as two legs being charged once.
    const legs = charged.length === 1 ? "the Equity Area leg" : `${charged.length} Equity Area legs`;
    out.push({
      kind: "second_unlock",
      text:
        `Includes ${formatCents(equityUnlocks)} of unlocks for ${legs}. ` +
        `The contract does not say whether a VeoPlus Pass waives them, so this ` +
        `assumes you are charged.`,
    });
  }

  if (plan.handOffs > 0) {
    out.push({
      kind: "re_rent",
      text:
        `You end one ride and start another. Between the two, somebody else ` +
        `can take that scooter — dibs does not stop that, and nothing does.`,
    });
  }

  out.push({
    kind: "screenshot",
    text:
      `This should cost about ${formatCents(plan.estimatedCents)}. If Veo bills ` +
      `you the base rate instead, screenshot the receipt.`,
  });

  return out;
}
