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
// MEASURING ONLY. What to DO about the split — which of four priorities
// orders the list, and where along the route the swap should fall — moved to
// `route-priority.ts` when two options became four. This module answers one
// question and hands the number over: how much of the riding is on the
// scooter the rider wanted. It is the same split the old preference ranked
// on, now one input among several rather than the whole opinion.
//
// WITH NO SPEC CONFIGURED THIS DOES NOTHING AT ALL, and does not pretend
// otherwise — see `ideal-share-ui.ts`'s prompt. A share computed against
// `defaultSpec()` would be 100% for every vehicle in the city, which is not an
// opinion, it is an empty one dressed up as agreement.

import type { TripLeg, TripPlan } from "./along-the-way.ts";
import { matches, type MatchContext, type RideSpec } from "./ride-spec.ts";

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
