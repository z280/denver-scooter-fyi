/** Phase 6 §6.3.2 — the way back IN to a live ride.
 *
 *  WHAT WAS MISSING, in the plan's words: "the gap is not the leaving, it is
 *  the returning". BRB tears the HUD down without stopping anything — the
 *  clock stays anchored, the watcher and the track recording keep running —
 *  and then the map shows the rider *nothing* that says they are still on a
 *  ride. The top bar's Ride Mode button already takes them back (`main.ts`'s
 *  `beforeOpen` deflects a live doc to `RideHud.open()`), but it looks and
 *  reads exactly as it does with nothing in flight: "start recording a free
 *  ride". A rider who stepped away cannot tell their ride is one tap away,
 *  which is the same as not having the control.
 *
 *  So this module answers the one question that button has to ask before it
 *  renders or acts: GIVEN THE SESSION DOC, WHAT IS THIS BUTTON RIGHT NOW?
 *
 *  BRB IS UNCHANGED, deliberately (§6.3.2: "BRB STAYS AS IT IS"). The round
 *  trip is BRB out and this button in — and the top bar is `display:none`
 *  under `body.ride-active`, so a single control genuinely cannot do both
 *  halves. What the plan asks for, and what this gives, is that the pair is
 *  repeatable and that neither direction touches the clock, the watcher or
 *  the recording.
 *
 *  PURE. It takes a doc and returns an intent. No DOM, no session, no HUD.
 */

import {
  isPostRide,
  isRideLive,
  type RideSessionDoc,
} from "./ride-session.ts";

/** What the top bar's Ride Mode button means right now. */
export type RideButtonIntent =
  /** Nothing in flight. Start a free ride. */
  | { kind: "start_free" }
  /** A wizard with answers in it — a scooter, a destination, a route — that
   *  the rider left. Reopen it; never replace it. */
  | { kind: "resume_setup" }
  /** A ride is RUNNING and the HUD is not on screen. This is the state the
   *  seam exists for. */
  | { kind: "return_to_ride" }
  /** The ride is over but its post-ride screens are still owed answers.
   *  Starting something new over them would lose the summary. */
  | { kind: "finish_ride" };

/** Does this doc carry anything the rider told us?
 *
 *  Moved here from `main.ts` with its reasoning intact: a doc outlives the
 *  surface that made it (a reload, a closed wizard, a "back in a minute"), so
 *  `state` alone is not enough — `wizard` covers both "just opened, asked
 *  nothing" and "chose a scooter and a destination".
 *
 *  A FINISHED ride is not an unfinished one. `done` and `idle` docs keep their
 *  device and `startedAtMs` — that is the record of the ride that just
 *  happened — so answering this on the fields alone made every tap after the
 *  first reopen the last ride's wizard instead of starting a new one. */
export function hasAnswers(doc: RideSessionDoc): boolean {
  if (doc.state === "idle" || doc.state === "done") return false;
  return (
    doc.device !== null ||
    doc.dest !== null ||
    doc.route !== null ||
    doc.rideId !== null ||
    doc.startedAtMs !== null
  );
}

/** The button's meaning, given the session.
 *
 *  ORDER MATTERS and is not alphabetical. A live ride is checked before
 *  `hasAnswers` because a live doc satisfies both, and treating it as "resume
 *  the setup" would build a wizard over a running ride. Post-ride likewise:
 *  those docs have answers, and the screens they owe are already on top of
 *  everything. */
export function rideButtonIntent(
  doc: RideSessionDoc | null,
): RideButtonIntent {
  if (!doc) return { kind: "start_free" };
  if (isRideLive(doc)) return { kind: "return_to_ride" };
  if (isPostRide(doc)) return { kind: "finish_ride" };
  if (hasAnswers(doc)) return { kind: "resume_setup" };
  return { kind: "start_free" };
}

/** TRUE when a ride is in flight behind this button — the thing the old
 *  single-label button could not say. Drives the lit state in the top bar. */
export function isLiveIntent(intent: RideButtonIntent): boolean {
  return intent.kind === "return_to_ride" || intent.kind === "finish_ride";
}

export interface RideButtonCopy {
  /** The tooltip. Short enough to read on a phone. */
  title: string;
  /** The accessible name. Says what happens, because a screen-reader user
   *  gets no colour, no glyph and no map to infer it from — and "start
   *  recording a free ride" while a ride is running is simply false. */
  ariaLabel: string;
}

export function rideButtonCopy(intent: RideButtonIntent): RideButtonCopy {
  switch (intent.kind) {
    case "return_to_ride":
      return {
        title: "Back to your ride",
        ariaLabel: "Back to your ride — it is still running",
      };
    case "finish_ride":
      return {
        title: "Finish your ride",
        ariaLabel: "Finish your ride — a few questions are still open",
      };
    case "resume_setup":
      return {
        title: "Back to your ride setup",
        ariaLabel: "Back to your ride setup — pick up where you left off",
      };
    case "start_free":
      return {
        title: "Ride Mode",
        ariaLabel: "Ride Mode — start recording a free ride",
      };
  }
}
