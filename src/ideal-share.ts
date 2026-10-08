// How much of the trip is spent on the scooter the rider actually wanted.
//
// THE GAP. A rider can save an "ideal scooter" — `ride-spec.ts`'s spec, named
// "My ideal scooter" in the Filters drawer — and the search already uses it to
// decide which vehicles QUALIFY at all. What it had no opinion about is how a
// multi-scooter plan DIVIDES the trip between them. Two plans can cost the same
// to the cent and put nineteen minutes on the rider's ideal Cosmo and two on
// something they merely tolerate, or the other way round, and nothing ranked
// one above the other or even mentioned the difference.
//
// SO THE PREFERENCE IS ABOUT THE SPLIT, not about which vehicles are allowed.
// The spec's `must` fields already handle "I will not ride that". This is the
// softer, commoner case: I will ride either, and given the choice I would
// rather spend the long leg on the good one.
//
// COST STILL WINS WHEN IT IS A REAL DIFFERENCE. The owner's framing — "default
// to more of the ideal device, unless there's a cost reason to divide the route
// differently" — is a tolerance, not an override, and `TIE_CENTS` is where that
// judgement is written down. Inside it, plans are near enough the same price
// that the split is the only thing left to choose on. Outside it, the money is
// the answer and reordering would be this app quietly spending a rider's money
// on its own idea of comfort.
//
// IT REORDERS, IT NEVER FILTERS. Every plan the search found stays on the list;
// what changes is which one is read first. Nothing is hidden on the strength of
// a preference about comfort.
//
// WITH NO SPEC CONFIGURED THIS DOES NOTHING AT ALL, and does not pretend
// otherwise — see `ideal-share-ui.ts`'s prompt. A share computed against
// `defaultSpec()` would be 100% for every vehicle in the city, which is not an
// opinion, it is an empty one dressed up as agreement.

import type { TripLeg, TripPlan } from "./along-the-way.ts";
import { matches, type MatchContext, type RideSpec } from "./ride-spec.ts";

export const IDEAL_SPLIT_KEY = "scooter-fyi-ideal-split";

/** How close two plans' prices have to be before the split decides between
 *  them.
 *
 *  50¢ IS HALF AN EQUITY-AREA UNLOCK, which is the smallest charge in the app
 *  that a rider would notice on a receipt, and it is the bound worth keeping if
 *  this figure is ever revisited. Above a dollar the tolerance would start
 *  swallowing a whole unlock — a real, nameable difference — and a rider who
 *  was shown the pricier plan first would be right to feel the app had an
 *  agenda. Below a quarter it would stop firing on exactly the ties it exists
 *  for, since two plans over the same minutes routinely differ by a few cents
 *  of tax rounding alone. */
export const TIE_CENTS = 50;

export type IdealSplit = "prefer_ideal" | "cheapest";

/** More of the ideal device, which is the owner's stated default. */
export const DEFAULT_IDEAL_SPLIT: IdealSplit = "prefer_ideal";

export interface IdealSplitOption {
  value: IdealSplit;
  label: string;
  hint: string;
}

export const IDEAL_SPLIT_OPTIONS: readonly IdealSplitOption[] = [
  {
    value: "prefer_ideal",
    label: "More of my ideal scooter",
    hint: `When two plans cost about the same, show the one that spends longer on the scooter you asked for. A plan more than ${(TIE_CENTS / 100).toFixed(2).replace(/^0/, "$")} cheaper still comes first.`,
  },
  {
    value: "cheapest",
    label: "Cheapest first, always",
    hint: "Order by price alone, however the trip is split between scooters.",
  },
];

export function idealSplit(): IdealSplit {
  try {
    const raw = localStorage.getItem(IDEAL_SPLIT_KEY);
    return raw === "cheapest" || raw === "prefer_ideal" ? raw : DEFAULT_IDEAL_SPLIT;
  } catch {
    return DEFAULT_IDEAL_SPLIT;
  }
}

/** Returns false when storage refused the write, so the surface can say the
 *  choice will not survive a reload rather than pretending it was kept. */
export function setIdealSplit(value: IdealSplit): boolean {
  try {
    localStorage.setItem(IDEAL_SPLIT_KEY, value);
    return true;
  } catch {
    return false;
  }
}

function rideLegs(plan: TripPlan): TripLeg[] {
  return plan.legs.filter((l) => l.mode === "ride");
}

/** The fraction of RIDDEN seconds spent on vehicles that fully meet the spec,
 *  0..1. Null when the question does not apply.
 *
 *  SECONDS AND NOT LEGS, because legs are not comparable units: a plan that
 *  puts the rider's ideal scooter on a two-minute hop and something else on a
 *  nineteen-minute one has spent most of the trip on the wrong vehicle, and
 *  counting legs would score it 50%. Seconds is the thing the rider
 *  experiences.
 *
 *  RIDDEN seconds, not total: the walk to the first vehicle is the same walk
 *  whichever scooter is at the end of it, so including it would dilute every
 *  plan by a constant and make a short trip look more compromised than a long
 *  one.
 *
 *  `ideal` AND NOT `qualifies` is the whole point. `qualifies` means "no hard
 *  requirement broken", which is already true of everything the search
 *  returned — scoring on it would give every plan 100%. `ideal` means nothing
 *  unmet at all, hard or soft, which is what "the scooter I asked for"
 *  actually means. */
export function idealShare(
  plan: TripPlan,
  spec: RideSpec | null,
  ctx: MatchContext = {},
): number | null {
  if (spec === null) return null;
  const legs = rideLegs(plan);
  if (legs.length === 0) return null;
  let total = 0;
  let ideal = 0;
  for (const leg of legs) {
    const seconds = Number.isFinite(leg.seconds) && leg.seconds > 0 ? leg.seconds : 0;
    total += seconds;
    if (leg.vehicle && matches(leg.vehicle, spec, ctx).ideal) ideal += seconds;
  }
  // Every ride leg reported a zero or broken duration. No denominator, no
  // share — zero would read as "none of it is ideal", which is a claim.
  if (total <= 0) return null;
  return ideal / total;
}

/** "19 of 21 min on your ideal scooter", or null when there is nothing to say.
 *
 *  MINUTES, NOT A PERCENTAGE. "90%" is a figure about our arithmetic; the
 *  rider's question is how long they are on the good one, and the answer is in
 *  the same unit as every other duration on the row.
 *
 *  Silent at zero and silent at one. All of it is what a rider on a
 *  single-scooter plan already assumes, and none of it is better said by the
 *  absence of a chip than by a chip announcing a disappointment. The chip
 *  exists for the case it was built for: a split, where the division is the
 *  thing being chosen.
 *
 *  THAT RULE IS ENFORCED ON THE MINUTES, not on the fraction, and the single
 *  check is deliberate rather than an omission. An early `share <= 0 || share
 *  >= 1` return would be redundant — it catches a strict subset of what the
 *  minute comparison below already catches — and a redundant branch is one no
 *  test can distinguish from its absence, which is how dead conditions
 *  accumulate. The minutes are also the stricter test: a ten-second ideal leg
 *  in a twenty-one-minute trip has a share above zero and rounds to "0 of 21",
 *  which the fraction would have let through. */
export function idealShareChip(
  plan: TripPlan,
  spec: RideSpec | null,
  ctx: MatchContext = {},
): string | null {
  const share = idealShare(plan, spec, ctx);
  if (share === null) return null;
  const legs = rideLegs(plan);
  const totalSeconds = legs.reduce(
    (sum, l) => sum + (Number.isFinite(l.seconds) && l.seconds > 0 ? l.seconds : 0),
    0,
  );
  const idealMin = Math.round((share * totalSeconds) / 60);
  const totalMin = Math.round(totalSeconds / 60);
  // Rounding can collapse a real split into "21 of 21", which would be a lie
  // told by arithmetic. Say nothing rather than overstate.
  if (idealMin <= 0 || idealMin >= totalMin) return null;
  return `${idealMin} of ${totalMin} min on your ideal scooter`;
}

export interface ReorderResult<T> {
  rows: T[];
  /** The preference actually moved something. Lets a surface say so without
   *  comparing two arrays it did not build. */
  moved: boolean;
}

/** Order by price, then — among plans within `TIE_CENTS` of the best price
 *  seen so far — by how much of the trip is on the ideal scooter.
 *
 *  THE BASELINE IS THE CHEAPEST PLAN, not the one above. Comparing each plan
 *  only with its neighbour would let a chain of 49¢ steps carry a plan a long
 *  way up the list for a difference the rider would certainly notice — the
 *  tolerance has to be anchored, or it is not a tolerance.
 *
 *  STABLE WITHIN A TIE, so the planner's own order survives wherever this has
 *  no opinion: two plans at the same price with the same share come out in the
 *  order `rankPlans` put them.
 *
 *  The walk-only plan has no ride legs and so no share; it sorts on price like
 *  anything else and is never promoted by a preference about scooters. */
export function reorderForIdealShare<
  T extends { plan: TripPlan; idealShare?: number | null },
>(rows: readonly T[], split: IdealSplit): ReorderResult<T> {
  if (split !== "prefer_ideal" || rows.length < 2) {
    return { rows: [...rows], moved: false };
  }
  const cheapest = Math.min(...rows.map((r) => r.plan.estimatedCents));
  const indexed = rows.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => {
    const aTied = a.row.plan.estimatedCents - cheapest <= TIE_CENTS;
    const bTied = b.row.plan.estimatedCents - cheapest <= TIE_CENTS;
    // Outside the tolerance the money is the answer, and a tied plan always
    // outranks an untied one because it is the cheaper of the two.
    if (aTied !== bTied) return aTied ? -1 : 1;
    if (!aTied) return a.row.plan.estimatedCents - b.row.plan.estimatedCents;
    const aShare = a.row.idealShare ?? -1;
    const bShare = b.row.idealShare ?? -1;
    if (aShare !== bShare) return bShare - aShare;
    // Same share: the cheaper of two near-equal prices, then the planner's own
    // order.
    if (a.row.plan.estimatedCents !== b.row.plan.estimatedCents) {
      return a.row.plan.estimatedCents - b.row.plan.estimatedCents;
    }
    return a.i - b.i;
  });
  const sorted = indexed.map((x) => x.row);
  const moved = indexed.some((x, position) => x.i !== position);
  return { rows: sorted, moved };
}

/** What to say above a list this preference reordered, or null.
 *
 *  Said only when it MOVED something. A standing explanation of a preference
 *  that happened to change nothing is a line riders learn to skip, and then
 *  miss on the day it matters. */
export function idealSplitNote(moved: boolean, hasSpec: boolean): string | null {
  if (!moved || !hasSpec) return null;
  return "Sorted to put more of the trip on your ideal scooter — prices here are within a few cents of each other.";
}
