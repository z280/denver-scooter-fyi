// §2.2 — the free-minutes control. The one new piece of UI Phase 2 owes, and it
// exists because of an honest admission already in `config.ts`: the cost ticker
// "can't know how much of today's free hour is left, so it prices minutes beyond
// 60". Pessimism is right for a live ticker and wrong for planning — it prices a
// free trip as a paid one and argues the rider out of the hand-off they should
// take.
//
// This module is the copy and the correction store. The arithmetic is
// `free-minutes.ts`'s and stays there; the fetch is `api.ts`'s.
//
// ---------------------------------------------------------------------------
// WHICH WAY THE ERROR RUNS, SAID OUT LOUD, is the whole reason this has words
// at all and not just a number. Rides taken outside this app are invisible to
// it, so `usedMinutes` is a FLOOR on what the rider has spent and
// `remainingMinutes` is a CEILING on what they have left. A rider who plans a
// free trip on our figure and gets billed for it will not use the feature a
// second time, so the figure travels with the direction of its own error.
// ---------------------------------------------------------------------------

import { FREE_MINUTES_PER_DAY, billingDayOf, type FreeMinuteEstimate } from "./free-minutes.ts";
import type { RideSpan } from "./free-minutes.ts";
import type { TrackedRide } from "./api.ts";

const CORRECTION_KEY = "scooter_fyi.free_minutes_said";

/** Tracked rides as the spans the estimate counts.
 *
 *  `user_reported_ended_at` is the end, and NULL IS CORRECT FOR A RUNNING RIDE
 *  rather than a reason to skip it: `minutesSpentBy` counts an open span up to
 *  `now`, because a rider planning their next leg mid-trip is spending the hour
 *  while they read the screen.
 *
 *  The API's other end-ish fields are deliberately not consulted. Every `gbfs_*`
 *  field reads null until the rider reports their own end (the API's redaction
 *  rule), so reaching for `gbfs_left_feed_at` would substitute a null for a real
 *  figure on exactly the rides that have one. */
export function spansOf(rides: readonly TrackedRide[]): RideSpan[] {
  const out: RideSpan[] = [];
  for (const r of rides) {
    const startedAtMs = Date.parse(r.started_at);
    if (!Number.isFinite(startedAtMs)) continue;
    const endRaw = r.user_reported_ended_at;
    const endedAtMs = endRaw === null ? null : Date.parse(endRaw);
    out.push({
      startedAtMs,
      endedAtMs: endedAtMs !== null && Number.isFinite(endedAtMs) ? endedAtMs : null,
    });
  }
  return out;
}

/** The rider's own answer to "how many free minutes have you got left?", for
 *  today's Denver billing day only.
 *
 *  SCOPED TO THE DAY, because the allowance resets and a correction does not.
 *  A figure the rider gave yesterday is worse than no figure at all: it is
 *  stated with confidence, it wins over the estimate by design (§2.2), and it is
 *  certainly wrong. Stored with the day it was given and read back only on a
 *  match.
 *
 *  `null` for "they have not told us", which is distinct from a stated 0 — a
 *  rider who says the hour is gone has told us something, and the estimate must
 *  not quietly replace that with its own guess. */
export function savedCorrection(nowMs: number): number | null {
  try {
    const raw = localStorage.getItem(CORRECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { day?: unknown; minutes?: unknown };
    if (typeof parsed.day !== "string" || parsed.day !== billingDayOf(nowMs)) return null;
    const m = parsed.minutes;
    if (typeof m !== "number" || !Number.isFinite(m)) return null;
    return clampMinutes(m);
  } catch {
    // Private mode, or a value some other version wrote. An unreadable
    // correction is the same as none: the estimate takes over, which is the
    // weaker figure and the safe one.
    return null;
  }
}

/** Store the rider's answer, or clear it with `null`. Returns whether it stuck
 *  — a caller that wants to say "we could not remember that" can. */
export function saveCorrection(nowMs: number, minutes: number | null): boolean {
  try {
    if (minutes === null) {
      localStorage.removeItem(CORRECTION_KEY);
      return true;
    }
    localStorage.setItem(
      CORRECTION_KEY,
      JSON.stringify({ day: billingDayOf(nowMs), minutes: clampMinutes(minutes) }),
    );
    return true;
  } catch {
    return false;
  }
}

function clampMinutes(m: number): number {
  return Math.max(0, Math.min(FREE_MINUTES_PER_DAY, Math.round(m)));
}

export interface FreeMinutesCopy {
  /** "About 45 free minutes left today" */
  headline: string;
  /** Where the figure came from and which way it is wrong. */
  basisNote: string;
  /** The label on the correction input. */
  correctionLabel: string;
  /** Whether a correction is on record, so the control can offer to drop it. */
  corrected: boolean;
}

/** The control's words, from the estimate it is showing.
 *
 *  `ridesCounted === 0` with a `tracked_rides` basis is its own case and not a
 *  footnote: it means we looked and found nothing today, which is a much
 *  stronger statement than the signed-out zero and must not borrow its wording.
 *  A rider who has taken no rides today and is told "we cannot see your rides"
 *  will correct a figure that was already right. */
export function freeMinutesCopy(estimate: FreeMinuteEstimate): FreeMinutesCopy {
  const left = estimate.remainingMinutes;
  const headline =
    estimate.basis === "rider_corrected"
      ? `${left} free minutes left today — your figure`
      : left === 0
        ? "No free minutes left today"
        : `About ${left} free minutes left today`;

  let basisNote: string;
  switch (estimate.basis) {
    case "rider_corrected":
      basisNote = "Using what you told us, not our estimate.";
      break;
    case "signed_out":
      basisNote =
        "Signed out, so we cannot count your rides — we assume today's hour is " +
        "gone and price every minute. Sign in, or tell us below.";
      break;
    case "tracked_rides":
      basisNote =
        estimate.ridesCounted === 0
          ? "No rides recorded here today. Any you took in the Veo app are " +
            "invisible to us, so this is the most we can promise, not the least."
          : `Counted from ${estimate.ridesCounted} ride${estimate.ridesCounted === 1 ? "" : "s"} ` +
            `recorded here today (${estimate.usedMinutes} min). Rides you took in the Veo ` +
            "app are invisible to us, so this is the most you have left, not the least.";
      break;
  }

  return {
    headline,
    basisNote,
    correctionLabel: "I've got about this many left:",
    corrected: estimate.basis === "rider_corrected",
  };
}

/** Parse what the rider typed. `null` for "they cleared it".
 *
 *  REFUSES NONSENSE RATHER THAN CLAMPING IT SILENTLY on the way in — except
 *  that it does clamp, and the distinction matters: "90" becomes 60 because the
 *  allowance IS 60 and a rider who types 90 means "loads", while "abc" becomes
 *  null because it means nothing. Clamping the first is generous; inventing a
 *  number for the second would be the control fabricating the one figure it
 *  exists to take from the rider. */
export function parseCorrection(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return clampMinutes(n);
}
