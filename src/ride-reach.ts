// §11.5, the during-ride half: will this scooter get me the rest of the way?
//
// `reach.ts` answers the same question on the pavement, before a ride, for the
// whole visible fleet. This answers it once a rider is moving, and it is a
// different problem in three ways.
//
// ONE: THE RANGE FIGURE GOES STALE THE MOMENT THEY SET OFF, and we cannot
// re-read it. `current_range_meters` is Veo's own projection from the charge the
// vehicle had when the feed last saw it — but a vehicle being ridden is rented,
// and a rented vehicle drops out of the public feed. So the range is sampled
// ONCE, at the start, and spent down by the distance the HUD has actually
// measured. That is not a worse estimate than re-reading would be; it is the
// only one available, and it has the virtue of being monotonic.
//
// TWO: THERE MAY BE NO ROUTE. Navigation is off by default
// (`defaultRideOptions`), so a warning that needed turn-by-turn would be absent
// from most rides — which is the opposite of the point. The remaining distance
// is therefore the same straight-line-times-detour estimate `reach.ts` already
// uses, measured from where the rider is now to where they said they were
// going. A ride with no destination gets no warning, because there is no
// question: "will it reach" needs a "where".
//
// THREE: THE CONFIDENCE FLOOR IS THE WHOLE DESIGN. §11.5 calls this "the item
// most likely to produce a wrong claim", and it is right. A vehicle the feed
// gave no range for produces NO warning — not a cheerful one, not a hedged one.
// "You might not make it", said wrongly, teaches a rider to ignore the one
// warning that matters, and there is no recovering that. Every gate below fails
// to silence.
//
// It reuses `reach.ts`'s `DETOUR_FACTOR` and `RESERVE_FRACTION` rather than
// picking its own, for the reason that module already states about the backend:
// two tiers of one question must not disagree about what "made it" means.

import {
  DETOUR_FACTOR,
  RESERVE_FRACTION,
  straightLineMeters,
} from "./reach.ts";

export { DETOUR_FACTOR, RESERVE_FRACTION };

/** Below this, the warning is noise. A rider 200 m from their destination with
 *  a flat battery is a rider who walks the last block, and a phone that speaks
 *  up about it is a phone they mute. */
export const MIN_WARNABLE_REMAINING_METERS = 400;

/** How short the range has to be before it is worth saying.
 *
 *  A warning that fires when the rider is 20 m short of the reserve is a
 *  warning about rounding: both figures here are estimates — a straight line
 *  standing in for a road, an operator's projection standing in for a model —
 *  and the gap has to exceed their noise before it means anything. 300 m is
 *  about a Denver block and a half. */
export const SHORTFALL_MARGIN_METERS = 300;

// THE TWO CONSTANTS ABOVE INTERACT, and the arithmetic is worth stating because
// it is not obvious from either one. The margin is ABSOLUTE, so a trip whose
// remaining distance is below `SHORTFALL_MARGIN_METERS / (1 - RESERVE_FRACTION)`
// — about 333 m — can never be "short" however flat the battery is: the gap
// cannot exceed the noise floor. That is the right behaviour and not a gap in
// the rule, because `MIN_WARNABLE_REMAINING_METERS` (400 m) already declines to
// interrupt anybody that close to their destination. Absolute rather than
// proportional on purpose: the error between a straight line and a road is a
// block or two of detour, which does not grow with the length of the trip the
// way a percentage would.

export interface RideReachInput {
  /** `current_range_meters` as the feed reported it when the ride began.
   *  Null/absent/non-finite is the confidence floor: no observation, no
   *  warning. */
  startRangeMeters: number | null | undefined;
  /** What the HUD has measured since the ride started, in metres. */
  travelledMeters: number;
  /** Where the rider is now. */
  at: { lat: number; lng: number } | null;
  /** Where they said they were going. Null when they said nothing, which is
   *  most rides — and which means there is nothing to answer. */
  dest: { lat: number; lon: number } | null;
}

export type RideReachVerdict = "ok" | "short" | "unknown";

export interface RideReach {
  verdict: RideReachVerdict;
  /** Estimated metres of range left. Null whenever the verdict is "unknown". */
  rangeLeftMeters: number | null;
  /** Estimated road metres still to cover. Null when there is no destination
   *  or no fix. */
  remainingMeters: number | null;
}

/** Range left after what has been ridden, or null if we never had a figure.
 *
 *  Clamped at zero: a vehicle that has gone further than its projection said it
 *  could has not got negative range, it has an estimate that was low. Letting
 *  that go negative would make the shortfall arithmetic below read as a bigger
 *  gap the further it is wrong, which is confidence in the wrong direction. */
export function rangeLeftMeters(
  startRangeMeters: number | null | undefined,
  travelledMeters: number,
): number | null {
  if (
    startRangeMeters === null ||
    startRangeMeters === undefined ||
    !Number.isFinite(startRangeMeters) ||
    startRangeMeters < 0
  ) {
    return null;
  }
  if (!Number.isFinite(travelledMeters) || travelledMeters < 0) {
    // A broken odometer is not evidence about the battery. Treat the ride as
    // having covered nothing rather than inventing a shortfall from a NaN.
    return startRangeMeters;
  }
  return Math.max(0, startRangeMeters - travelledMeters);
}

/** Estimated road metres from here to the destination. */
export function remainingRideMeters(
  at: { lat: number; lng: number } | null,
  dest: { lat: number; lon: number } | null,
): number | null {
  if (!at || !dest) return null;
  if (!Number.isFinite(at.lat) || !Number.isFinite(at.lng)) return null;
  if (!Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) return null;
  return straightLineMeters(at, dest) * DETOUR_FACTOR;
}

/** The verdict, with both figures it was derived from.
 *
 *  "unknown" is returned for every missing input, and the caller must treat it
 *  exactly as "ok" treats it: say nothing. The two are separate so a surface
 *  that wants to show a figure can tell "we looked and it is fine" from "we
 *  have nothing to look at", which the ride card does and the voice does not. */
export function rideReach(input: RideReachInput): RideReach {
  const left = rangeLeftMeters(input.startRangeMeters, input.travelledMeters);
  const remaining = remainingRideMeters(input.at, input.dest);
  if (left === null || remaining === null) {
    return { verdict: "unknown", rangeLeftMeters: null, remainingMeters: remaining };
  }
  // The same reserve the map chip and the backend's route check use, so a
  // rider cannot be told "probably reaches" by one and "won't" by another for
  // the same pair of numbers.
  const usable = left * (1 - RESERVE_FRACTION);
  const short = remaining - usable > SHORTFALL_MARGIN_METERS;
  return {
    verdict: short ? "short" : "ok",
    rangeLeftMeters: left,
    remainingMeters: remaining,
  };
}

/** Should this ride be warned, right now?
 *
 *  Separate from `rideReach` because "is it short" and "is this worth
 *  interrupting someone over" are different questions, and only the second one
 *  knows about having already said it. */
export function shouldWarnReach(
  input: RideReachInput & { alreadyWarned: boolean },
): boolean {
  if (input.alreadyWarned) return false;
  const reach = rideReach(input);
  if (reach.verdict !== "short") return false;
  // Nearly there: a rider who has to walk the last two minutes does not need
  // telling, and this is the case where the straight-line estimate is at its
  // least reliable relative to the distance it is estimating.
  if ((reach.remainingMeters ?? 0) < MIN_WARNABLE_REMAINING_METERS) return false;
  return true;
}

/** What to say. One sentence, no gauge (§11.5), and no instruction.
 *
 *  IT DOES NOT TELL THEM WHAT TO DO. We know the battery is probably short; we
 *  do not know whether the right answer is to swap, to park early, or to carry
 *  on and walk a block, because that depends on where they are going and what
 *  they are carrying. Naming the fact and leaving the decision is the honest
 *  shape — and it is the shape that survives being wrong, which this will
 *  sometimes be.
 *
 *  Miles, because the HUD's other distances are miles and a rider doing a
 *  mental comparison should not have to convert. Rounded to one decimal: the
 *  inputs do not support more, and a figure like "1.37 miles" asserts a
 *  precision that would be a lie. */
export function reachSentence(reach: RideReach): string | null {
  if (reach.verdict !== "short") return null;
  if (reach.rangeLeftMeters === null || reach.remainingMeters === null) return null;
  const leftMi = reach.rangeLeftMeters / 1609.344;
  const togoMi = reach.remainingMeters / 1609.344;
  return (
    `Battery may not reach your destination. About ${leftMi.toFixed(1)} miles of ` +
    `range left, and roughly ${togoMi.toFixed(1)} to go.`
  );
}

// ---------------------------------------------------------------------------
// §11.5's BEFORE half
// ---------------------------------------------------------------------------
//
// "Screen 2/6 should refuse quietly rather than cheerfully. A 14% Astro and a
// 6 km destination is a walk home, and we can see it coming."
//
// It is the same arithmetic as the during-ride question with `travelledMeters:
// 0`, which is why there is no second verdict function here — two tiers of one
// question must not disagree about what "made it" means, and that rule applies
// hardest to the two tiers of the SAME question twelve seconds apart. A rider
// told nothing on Screen 6 and then warned eight metres into the ride would
// rightly conclude the warning is noise.
//
// WHAT IS DIFFERENT IS THE SENTENCE, and only because "range left" is the
// wrong words for a ride that has not started. The shape is the same: name the
// fact, name the destination so it is clear which trip is being talked about,
// and give no instruction — we do not know whether the right answer is a
// different scooter, a shorter trip, or riding it and walking the last block.
//
// REFUSE QUIETLY, NOT LOUDLY. This is a line of copy, never a block on
// starting: the rider is standing at the scooter and can see their own battery
// gauge, the figures are two estimates deep, and a wizard that refused to
// proceed on this evidence would be wrong often enough to be worth defeating.

/** The before-the-ride sentence, or null when there is nothing honest to say.
 *
 *  `destLabel` is what the rider called the place. Omitted or empty falls back
 *  to "your destination" rather than rendering a bare dash — a destination
 *  saved from a map tap can have no name at all. */
export function preRideReachSentence(
  reach: RideReach,
  destLabel?: string | null,
): string | null {
  if (reach.verdict !== "short") return null;
  if (reach.rangeLeftMeters === null || reach.remainingMeters === null) return null;
  const where = destLabel && destLabel.trim() !== "" ? destLabel.trim() : "your destination";
  const rangeMi = reach.rangeLeftMeters / 1609.344;
  const togoMi = reach.remainingMeters / 1609.344;
  return (
    `This battery may not reach ${where} — about ${rangeMi.toFixed(1)} miles of ` +
    `range, and roughly ${togoMi.toFixed(1)} to go.`
  );
}
