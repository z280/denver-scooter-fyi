// Phase 11 §11.4 case 2 — "did your ride end at 4:12pm?"
//
// Pure. It decides whether that offer can honestly be made and what it says;
// `ride-resume-prompt.ts` renders it and sends the PATCH.
//
// ---------------------------------------------------------------------------
// THE PROBLEM, WHICH IS A DATA PROBLEM AND NOT A UI ONE.
//
// A rider who walks away without finishing Screen 8 leaves the ride open.
// Recovery exists, but its only two offers are [Resume] and [End it] — and
// [End it] stamps `ended_at` with `now()`. So a ride abandoned at 4:12pm and
// recovered at 9pm is reported as a FIVE-HOUR RIDE. §11.4: "a ride ended hours
// late is worse data than no ride", and today the rider has to reconstruct it
// themselves, which nobody does.
//
// The local track store already knows: `TrackTip.lastPointMs` is when this
// device last recorded a position for that ride. That is the honest answer to
// "when did it end", to within the recording interval.
//
// WHAT IT IS NOT AN ANSWER TO IS *WHERE*. `EndRideIn` requires `end_lat`/
// `end_lon`, so something has to go in them, and the only position available at
// recovery time is where the rider is standing NOW. That is not where the ride
// ended, and the offer must not pretend otherwise: the copy says so, and the
// metadata marks the field so a consumer of the data can tell it apart from a
// witnessed one. Quietly sending a current position under a recovered timestamp
// would trade one wrong field for another and call it a fix.
// ---------------------------------------------------------------------------

/** Below this, the recovered time and "now" are the same answer, and a second
 *  button offering it is noise on a prompt that already has two.
 *
 *  Two minutes rather than seconds: the recording interval and a rider's walk
 *  back to the phone both live inside a minute or so, and the case this exists
 *  for is measured in hours. */
export const MIN_RECOVERABLE_GAP_MS = 2 * 60_000;

export interface EndRecoveryInput {
  /** `TrackTip.lastPointMs` — when this device last recorded a position for the
   *  ride. Null when the device knows nothing about it, which is the common case
   *  for the OTHER trigger of this prompt (a ride started on another device). */
  lastPointMs: number | null;
  /** The ride's own start, from the server record. A recovered end before it is
   *  not a recovery, it is a clock problem. */
  startedAtMs: number;
  now: number;
}

export interface EndRecoveryOffer {
  /** What to stamp `ended_at` with. */
  endedAtMs: number;
  /** "4:12 PM" — in the device's local time, which is what the rider reads off
   *  their own clock. */
  timeLabel: string;
  /** "about 5 hours ago". */
  agoLabel: string;
  /** What to put in `metadata` so the recovered figures are distinguishable
   *  from witnessed ones. */
  metadata: Record<string, unknown>;
}

function formatTime(instantMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(instantMs));
  } catch {
    // `Intl.DateTimeFormat` throws a RangeError on a non-finite instant, and the
    // guard above should make that unreachable — but a prompt that throws while
    // rendering is a rider stuck with no way to end their ride, so it degrades to
    // nothing rather than to an exception.
    return "";
  }
}

/** "about 5 hours ago", "about 20 minutes ago".
 *
 *  DELIBERATELY VAGUE where the exact time is already on screen beside it. The
 *  precise figure is `timeLabel`; this is the one that tells the rider whether the
 *  offer is worth taking, and "4 hours 51 minutes ago" is harder to judge at a
 *  glance than "about 5 hours". */
function formatAgo(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);
  if (minutes < 60) return `about ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `about ${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Can we honestly offer a recovered end time, and what does it say?
 *
 *  `null` means the prompt shows its existing two buttons and nothing more. Every
 *  rejection below is a case where the offer would be a guess dressed as a
 *  recollection. */
export function endRecoveryOffer(input: EndRecoveryInput): EndRecoveryOffer | null {
  const { lastPointMs, startedAtMs, now } = input;
  // Nothing recorded here. The prompt's other trigger is a ride started on a
  // different device, where this device has no track at all and no business
  // guessing when it ended.
  if (lastPointMs === null) return null;
  if (!Number.isFinite(lastPointMs) || !Number.isFinite(startedAtMs) || !Number.isFinite(now)) {
    return null;
  }
  // A last point before the ride began, or in the future, is a clock problem
  // rather than a recovery — and a wrong `ended_at` offered confidently is worse
  // than the `now()` it replaces.
  if (lastPointMs <= startedAtMs) return null;
  if (lastPointMs > now) return null;
  const gap = now - lastPointMs;
  if (gap < MIN_RECOVERABLE_GAP_MS) return null;

  return {
    endedAtMs: lastPointMs,
    timeLabel: formatTime(lastPointMs),
    agoLabel: formatAgo(gap),
    metadata: {
      // Flat and enumerated, so a consumer can filter on it without parsing
      // prose. `ended_at_source` says which field to trust and which not to.
      ended_at_source: "last_recorded_fix",
      end_position_source: "reporting_device_now",
      recovered_gap_seconds: Math.round(gap / 1000),
    },
  };
}

/** The sentence the prompt shows above the button.
 *
 *  SAYS WHAT IS RECOVERED AND WHAT IS NOT, in that order, because the second half
 *  is the part a rider would otherwise assume. */
export function endRecoveryCopy(offer: EndRecoveryOffer): string {
  return (
    `This device last recorded your ride at ${offer.timeLabel} — ${offer.agoLabel}. ` +
    `Ending it at that time keeps your ride length right. We can only recover ` +
    `the time, not the place, so the end location will be where you are now.`
  );
}
