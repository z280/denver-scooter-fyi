// Phase 11 §11.8 — the sentence at the end of a ride that brings somebody back.
//
// Pure. It takes the rider's own completed rides and returns a sentence, or
// nothing. No DOM, no network, no storage.
//
// ---------------------------------------------------------------------------
// §11.8 HAS THE COMPARATOR'S SIGN BACKWARDS, and this module does not follow it
// there.
//
// It asks for "you've saved $47 against the comparator". The comparator is
// `COMPARATOR` in `config.ts` — "if Veo had competition", a pass ladder at
// $2.99 for 30 minutes — and it is CHEAPER than Veo for essentially every ride.
// A rider does not save against it; they pay a premium to a monopoly. Every other
// surface in this app already says so in those terms: the ride summary's own line
// is "You paid ≈ $X more because Denver has one operator", computed as
// `veoCents - passQuote.cents`.
//
// So a lifetime "you've saved $47" would be the one place in the app that
// inverts the comparison, and it would invert it in Veo's favour. The honest
// sentence is the accumulated premium — which is also the more on-mission one,
// since documenting what the single-operator market costs riders is what this
// app is for.
//
// ---------------------------------------------------------------------------
// WHAT IS ACTUALLY MISSING, which is not a feature so much as a use.
//
// Screen 10 awards points. The track lands in IndexedDB and is visible in the
// Account drawer's Local Data tab, which is not a place anybody goes. Every input
// to this sentence already exists — `comparatorPassQuote` for the comparator,
// `/tracked-rides` for the history — and the ride flow does not use any of it.
//
// ---------------------------------------------------------------------------
// IT SAYS NOTHING RATHER THAN SOMETHING THIN, and that is the whole of the
// design judgement here.
//
// "That was your 1st ride, 0.6 miles, and you've saved $0.40" is worse than
// silence: it is the app congratulating a rider on nothing, at the moment they
// are trying to put their phone away, and it makes the figure look like the
// point rather than the trend. So each clause earns its place independently and
// the sentence is assembled from the ones that qualify — which also means a
// rider with distances but no costs gets the honest half rather than a saving
// of $0.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NOT WIRED YET, AND THE REASON IS AN API ONE — stated here rather than left to
// be discovered, because an unused module that LOOKS ready is how Phase 2 came
// to ship an engine nothing called.
//
// "That was your 12th ride" needs a LIFETIME ride count, and nothing serves one.
// `GET /api/v1/tracked-rides` returns `{ count, rides }` where `count` is
// `len(rides)` — the page size, not the total (`api_tracked_rides.py`). So the
// figure can only be had by paging all of a rider's history at the moment they
// are trying to put their phone away, which is the one thing this sentence must
// not cost.
//
// The three alternatives and why each is wrong:
//
//   * page everything — a network cost proportional to how much somebody has
//     used the app, charged at the worst moment;
//   * count the local track store (`listTrackIds`) — a PER-DEVICE count, so a
//     rider on a second phone is told a confidently wrong ordinal;
//   * drop the count — it is the clause that makes the sentence personal, and
//     distance alone is a statistic rather than a reason to come back.
//
// The ask is small and the query already exists: `badges.py`'s `_ride_badges`
// runs the exact UNION of `tracked_rides` and off-feed `rides` this needs, for
// lifetime distance, to award the 10- and 100-mile badges. It wants an endpoint
// that returns the totals rather than only the thresholds crossed. THAT IS A
// THIRD API DEPENDENCY FOR PHASE 11, which the plan's sequencing table lists as
// needing "almost nothing" with two named exceptions — corrected there.
//
// Everything below is finished and tested against the contract figures, so
// wiring it is a one-line map from whatever that endpoint returns.
// ---------------------------------------------------------------------------

import { comparatorPassQuote, formatCents } from "./ride-cost.ts";

/** Below this, there is no trend to report and the count is the only true thing
 *  in the sentence. Two rides is the first point at which "your 2nd ride" says
 *  something a rider did not already know they were doing. */
export const MIN_RIDES_FOR_SENTENCE = 2;

/** A premium under this is not worth a clause. Same reasoning as §5.2's
 *  `MIN_SAVING_CENTS`, and the same figure: under fifty cents the number makes
 *  the claim look smaller than it is. */
export const MIN_PREMIUM_CENTS = 50;

/** Below this, "0.3 miles" reads as a rounding error rather than a distance. */
export const MIN_DISTANCE_METERS = 1609; // one mile

/** One completed ride, normalised. The caller maps from `TrackedRide`; this
 *  module takes no API type so it can be fed from a local store just as well. */
export interface AccumulatedRide {
  /** Null when the server never measured one. NOT zero: a ride with no
   *  measurement and a ride that went nowhere are different facts, and summing
   *  the second into a lifetime total is fine while summing the first is a lie. */
  distanceMeters: number | null;
  /** What the rider was actually charged, cents. Null when unknown — which is
   *  most rides, since `total_cost_cents` is only set when something reported it. */
  costCents: number | null;
  /** Billed minutes, for the comparator quote. Null when unknown. */
  minutes: number | null;
}

export interface RideAccumulation {
  rideCount: number;
  /** Metres, over the rides that HAVE a measurement. */
  distanceMeters: number;
  /** How many rides that distance is drawn from — so a caller can tell "38 miles
   *  over 12 rides" from "38 miles over the 3 we measured". */
  distanceFromRides: number;
  /** Cents paid ABOVE what the comparator's pass ladder would have cost, over the
   *  rides where both the charge and the minutes are known. Same direction as the
   *  ride summary's own `deltaCents`.
   *
   *  Negative is possible and kept rather than floored: a rider who genuinely did
   *  better than the comparator on some ride should not have that erased, and the
   *  sentence declines to MENTION a negative total — which is a different decision
   *  made in a different place. */
  premiumCents: number;
  premiumFromRides: number;
}

/** Sum what is known, and count what it was known from.
 *
 *  EVERY TOTAL CARRIES ITS OWN DENOMINATOR, because the alternative is a
 *  lifetime distance computed over the three rides that happened to be measured
 *  and presented as though it covered all twelve. */
export function accumulate(rides: readonly AccumulatedRide[]): RideAccumulation {
  let distanceMeters = 0;
  let distanceFromRides = 0;
  let premiumCents = 0;
  let premiumFromRides = 0;

  for (const ride of rides) {
    if (ride.distanceMeters !== null && Number.isFinite(ride.distanceMeters) && ride.distanceMeters >= 0) {
      distanceMeters += ride.distanceMeters;
      distanceFromRides += 1;
    }
    // THE COMPARATOR NEEDS BOTH. With a charge and no minutes there is nothing to
    // quote against; with minutes and no charge there is no actual spend to
    // subtract. Either alone would have to be guessed, and a guessed saving is the
    // one number in this sentence nobody can check.
    if (
      ride.costCents !== null &&
      ride.minutes !== null &&
      Number.isFinite(ride.costCents) &&
      Number.isFinite(ride.minutes) &&
      ride.minutes > 0
    ) {
      // `charged − comparator`, which is the ride summary's own direction.
      premiumCents += ride.costCents - comparatorPassQuote(ride.minutes * 60_000).cents;
      premiumFromRides += 1;
    }
  }

  return {
    rideCount: rides.length,
    distanceMeters,
    distanceFromRides,
    premiumCents,
    premiumFromRides,
  };
}

/** "12th", "3rd", "1st". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function miles(meters: number): string {
  const mi = meters / 1609.344;
  // One decimal under ten miles, a whole number above — and never a trailing
  // ".0", which reads as precision we are claiming rather than arithmetic.
  const text = mi < 10 ? mi.toFixed(1).replace(/\.0$/, "") : String(Math.round(mi));
  return `${text} miles`;
}

/** The sentence, or `null` when there is nothing worth saying.
 *
 *  ASSEMBLED FROM THE CLAUSES THAT QUALIFY. A rider with twelve rides and no
 *  cost data gets the count and the distance; one with no distance data gets the
 *  count alone — and below `MIN_RIDES_FOR_SENTENCE` gets nothing at all, because
 *  the app congratulating somebody on their first 0.6 miles at the moment they
 *  are trying to put their phone away makes the figure look like the point. */
export function accumulationSentence(totals: RideAccumulation): string | null {
  if (totals.rideCount < MIN_RIDES_FOR_SENTENCE) return null;

  const clauses: string[] = [`that was your ${ordinal(totals.rideCount)} ride`];

  if (totals.distanceFromRides > 0 && totals.distanceMeters >= MIN_DISTANCE_METERS) {
    clauses.push(miles(totals.distanceMeters));
  }

  // Only a premium, never its inverse. A rider who happened to come out ahead of
  // the comparator is not served by being congratulated on it at the end of a ride
  // — the comparison exists to show what the single-operator market costs, and a
  // "you did well" line on the rides where it did not would make the whole figure
  // read as a scoreboard.
  if (totals.premiumFromRides > 0 && totals.premiumCents >= MIN_PREMIUM_CENTS) {
    clauses.push(
      `and ${formatCents(totals.premiumCents)} more than a competitive market would charge`,
    );
  }

  // Oxford-free join: the saving clause already starts with "and", and a second
  // one reads as a stutter.
  if (clauses.length === 1) return `${capitalise(clauses[0])}.`;
  if (clauses.length === 2) return `${capitalise(clauses[0])} — ${clauses[1]}.`;
  return `${capitalise(clauses[0])} — ${clauses[1]}, ${clauses[2]}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether the figures are drawn from every ride, or only some.
 *
 *  Exported so the surface can say so rather than implying a total it does not
 *  have. A rider who rode twelve times and sees a distance covering three should
 *  be told which — "38 miles" that is really "38 of the miles we measured" is the
 *  kind of number that gets noticed once and then never trusted again. */
export function isPartial(totals: RideAccumulation): boolean {
  if (totals.rideCount === 0) return false;
  return (
    totals.distanceFromRides < totals.rideCount ||
    totals.premiumFromRides < totals.rideCount
  );
}
