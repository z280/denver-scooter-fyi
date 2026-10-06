/** Phase 2 §2.2 — the Access tier's free-minute budget.
 *
 *  WHY THIS EXISTS, in `config.ts`'s own words: the cost ticker "can't know
 *  how much of today's free hour is left, so it prices minutes beyond 60".
 *  That pessimism is right for a live ticker and wrong for planning — it
 *  prices a free trip as a paid one and argues the rider out of the hand-off
 *  they should take.
 *
 *  PURE. Given the rider's own tracked rides and an instant, it answers how
 *  much of today's hour is gone. It does not fetch the rides (`api.ts` owns
 *  `/tracked-rides`) and it does not render the control (that lives with the
 *  plan list). The estimate is a number with a direction and a reason, so the
 *  surface can say which way it is wrong without re-deriving it.
 */

import { billableMinutes } from "./ride-cost";

/** The Access Program's daily allowance: 60 free minutes, then 15¢/min with
 *  no unlock (`config.ts`'s `equity` tier). */
export const FREE_MINUTES_PER_DAY = 60;

/** The allowance is Veo's, and Veo's day is Denver's. Counting in UTC would
 *  roll the hour over at 6pm local — the rider would be told they had a fresh
 *  hour in the middle of their evening, and billed as though they did not. */
export const BILLING_TIME_ZONE = "America/Denver";

/** One ride as this module needs it: when it started, and when it ended if it
 *  has. `/tracked-rides` serves `started_at` and `user_reported_ended_at`. */
export interface RideSpan {
  startedAtMs: number;
  /** Null while the ride is still running. */
  endedAtMs: number | null;
}

/** Why the figure is what it is — so the control can say it in words rather
 *  than inventing its own explanation. */
export type FreeMinuteBasis =
  /** Counted from the rider's own tracked rides. */
  | "tracked_rides"
  /** The rider told us, and their answer wins (§2.2). */
  | "rider_corrected"
  /** Nobody is signed in, so there are no rides to count and no way to ask. */
  | "signed_out";

export interface FreeMinuteEstimate {
  /** Minutes of today's hour already spent. */
  usedMinutes: number;
  /** What is left of the hour. Never negative. */
  remainingMinutes: number;
  basis: FreeMinuteBasis;
  /** How many of the rider's rides went into `usedMinutes`. 0 for a corrected
   *  or signed-out figure. */
  ridesCounted: number;
  /** TRUE whenever the figure is derived rather than stated: rides taken
   *  outside this app are invisible to it, so `usedMinutes` is a FLOOR on what
   *  the rider has spent and `remainingMinutes` is a CEILING on what they have
   *  left. Never authoritative, and the control must say so — a rider who
   *  plans a free trip and gets billed for it will not use the feature twice.
   *
   *  False only for `rider_corrected`, where the rider has told us directly,
   *  and for the signed-out floor of zero, which cannot be optimistic. */
  isCeiling: boolean;
}

/** The Denver calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 *  Via `Intl` rather than arithmetic on an offset, because Denver observes DST
 *  and the day the allowance resets on is a WALL-CLOCK day, not a fixed number
 *  of hours after the last one. On the two days a year that are 23 or 25 hours
 *  long, offset arithmetic puts rides on the wrong side of the reset. */
export function billingDayOf(instantMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BILLING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/** The rides that count against today's allowance.
 *
 *  A ride counts against the day it STARTED. A ride spanning midnight is
 *  therefore billed whole to the earlier day, which is a simplification: the
 *  contract says 60 free minutes a day and does not say how a ride straddling
 *  the reset is split, and inventing a split would be inventing a rule Veo has
 *  not published. The error is bounded by one ride and is disclosed by
 *  `isCeiling` like every other part of the estimate. */
export function ridesOnDay(
  rides: readonly RideSpan[],
  instantMs: number,
): RideSpan[] {
  const day = billingDayOf(instantMs);
  return rides.filter((r) => billingDayOf(r.startedAtMs) === day);
}

/** Minutes a single ride spends of the allowance, as Veo would bill it.
 *
 *  Through `billableMinutes` — `max(1, ceil(ms / 60_000))` — because Veo bills
 *  the STARTED minute. A rider 61 seconds into a ride has spent 2 of the hour,
 *  not 1, and rounding down would hand them a minute they do not have. Same
 *  rule, same function, as the planner's own pricing.
 *
 *  A ride still running is counted up to `nowMs`, because a rider planning
 *  their next leg mid-trip is spending the hour while they read the screen. */
export function minutesSpentBy(ride: RideSpan, nowMs: number): number {
  const end = ride.endedAtMs ?? nowMs;
  const elapsed = end - ride.startedAtMs;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return billableMinutes(elapsed);
}

function clampRemaining(used: number): number {
  return Math.max(0, FREE_MINUTES_PER_DAY - used);
}

/**
 * How much of today's free hour is left.
 *
 * `riderSaysRemaining` is §2.2's correction — *"I've got about N free minutes
 * left"* — and it WINS when given, without being averaged against the
 * estimate or sanity-checked against it. The rider can see their own Veo app;
 * this module cannot. Blending the two would produce a number neither of us
 * believes, and the whole point of offering the control is that our figure is
 * the weaker one.
 */
export function estimateFreeMinutes(options: {
  rides: readonly RideSpan[] | null;
  nowMs: number;
  /** §2.2's control. Null when the rider has not corrected it. */
  riderSaysRemaining?: number | null;
  /** False when nobody is signed in: there are no rides to count. */
  signedIn?: boolean;
}): FreeMinuteEstimate {
  const { rides, nowMs, riderSaysRemaining = null, signedIn = true } = options;

  if (riderSaysRemaining !== null && Number.isFinite(riderSaysRemaining)) {
    const remaining = Math.max(0, Math.min(FREE_MINUTES_PER_DAY, riderSaysRemaining));
    return {
      usedMinutes: FREE_MINUTES_PER_DAY - remaining,
      remainingMinutes: remaining,
      basis: "rider_corrected",
      ridesCounted: 0,
      isCeiling: false,
    };
  }

  if (!signedIn || rides === null) {
    // THE PESSIMISTIC FIGURE, and the control says why (§2.2). Assuming the
    // hour is gone prices a free trip as a paid one, which is the error this
    // section exists to correct — but it is the only honest answer when there
    // is nothing to count and nobody to ask, and it errs toward quoting too
    // much rather than promising free minutes that may not exist.
    return {
      usedMinutes: FREE_MINUTES_PER_DAY,
      remainingMinutes: 0,
      basis: "signed_out",
      ridesCounted: 0,
      isCeiling: false,
    };
  }

  const today = ridesOnDay(rides, nowMs);
  const used = today.reduce((n, r) => n + minutesSpentBy(r, nowMs), 0);
  return {
    usedMinutes: used,
    remainingMinutes: clampRemaining(used),
    basis: "tracked_rides",
    ridesCounted: today.length,
    isCeiling: true,
  };
}

/** What the planner takes: a plain number of minutes, resolved by the caller.
 *
 *  `rankPlans` has no tracked-ride input and could not estimate a null even in
 *  principle, so the resolution happens HERE and the search receives one
 *  number with one meaning (§2.1). */
export function freeMinutesForPlanning(estimate: FreeMinuteEstimate): number {
  return estimate.remainingMinutes;
}
