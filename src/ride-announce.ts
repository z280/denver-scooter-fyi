// Phase 11 §11.1 + §11.3 — what to say while riding, and when.
//
// PURE. No `speechSynthesis`, no `navigator.vibrate`, no DOM. It takes the
// ride's state and returns the utterances that are due, and `ride-voice.ts` is
// what speaks them. The split is not ceremony: "did it say the right thing at
// the right moment" is the whole question here, and it is unanswerable in a test
// that has to stub a speech engine.
//
// ---------------------------------------------------------------------------
// WHY THIS IS THE HIGHEST-VALUE THING IN THE PHASE (§11.1).
//
// `ride-nav-hud.ts` draws an instruction card, a directional arrow and a step
// list. To use any of it the rider LOOKS DOWN — while moving, in traffic, on a
// vehicle with 8-inch wheels. The honest summary of turn-by-turn today is that it
// works while stopped. A signal nobody can receive is not a signal, so every other
// in-ride signal in this phase is blocked behind this one.
// ---------------------------------------------------------------------------

import { FREE_MINUTES_PER_DAY } from "./free-minutes.ts";
import { EQUITY_AREA_RATE } from "./config.ts";

/** How many seconds of travel before a turn to speak it.
 *
 *  A DISTANCE SCALED BY SPEED, not a fixed one: §11.1's "a fixed 100 m is too
 *  late at 15 mph and absurd at walking pace". Eight seconds is about one
 *  sentence plus the time to act on it. */
export const TURN_LEAD_SECONDS = 8;

/** Floor and ceiling on that distance.
 *
 *  The floor keeps a stopped rider from being told about a turn they are sitting
 *  on; the ceiling keeps a fast one from hearing it so early that two turns are
 *  announced as one. */
export const TURN_LEAD_MIN_METERS = 25;
export const TURN_LEAD_MAX_METERS = 150;

/** Free-minute warnings, in minutes remaining. Descending, and each fires once.
 *
 *  "Two minutes of your free time left" is worth more than every other number on
 *  the screen combined (§11.3) — and it is worth saying EARLY as well, because
 *  two minutes is not enough time to decide to park. */
export const FREE_MINUTE_WARNINGS: readonly number[] = [10, 5, 2];

export type AnnouncementKind =
  | "turn"
  | "equity_entered"
  | "equity_left"
  | "free_minutes"
  | "free_minutes_gone";

export interface Announcement {
  kind: AnnouncementKind;
  /** What to speak. Plain prose: it is read aloud, so no glyphs and no
   *  abbreviations a synthesiser will mangle. */
  text: string;
  /** Buzz first. The rider feels the phone in a pocket and knows to listen,
   *  which is what makes audio work without headphones (§11.1).
   *
   *  NOT ON EVERY UTTERANCE. A cue that fires constantly stops being a cue, so it
   *  is reserved for the things a rider would want to act on. */
  haptic: boolean;
}

export interface AnnounceState {
  /** Maneuver indices already spoken. Dedup is BY INDEX, so a re-route or a GPS
   *  wobble that re-reports the same turn cannot repeat it (§11.1). */
  spokenManeuvers: ReadonlySet<number>;
  /** Whether the rider was inside an Equity Area at the last sample. `null`
   *  before the first — so the first sample establishes a baseline and does NOT
   *  announce an entry the rider did not make. */
  insideEquityArea: boolean | null;
  /** Free-minute thresholds already announced. */
  spokenFreeWarnings: ReadonlySet<number>;
  /** Whether the "free minutes are gone" line has been said. */
  spokenFreeGone: boolean;
}

export const INITIAL_ANNOUNCE_STATE: AnnounceState = {
  spokenManeuvers: new Set(),
  insideEquityArea: null,
  spokenFreeWarnings: new Set(),
  spokenFreeGone: false,
};

export interface AnnounceInput {
  /** Only `"riding"` speaks. A HUD open at the kerb, or a ride being set up, has
   *  nothing to say and a rider who has not set off is not listening for it. */
  status: string;
  /** Metres per second, from the fix. */
  speedMps: number;
  /** The upcoming maneuver, when there is a route. */
  maneuver?: {
    index: number;
    instruction: string;
    /** Metres to where the instruction is executed. */
    metersAway: number;
  } | null;
  /** Is the rider inside an Equity Area? `null` means the polygons have not
   *  loaded — which must NOT be read as "outside", or leaving an area the app has
   *  not looked at yet gets announced as leaving one. */
  insideEquityArea: boolean | null;
  /** Access tier only. `null` for every other tier, which have no allowance and
   *  no cliff to warn about. */
  freeMinutesLeft: number | null;
  /** A popup or modal is open. Never speak over one — the same rule the
   *  follow-cam already follows via `hasOpenPopup()`. */
  blocked: boolean;
  /** The rider silenced it. Some have headphones in and some have a passenger,
   *  and a HUD that cannot be silenced gets closed (§11.1). */
  muted: boolean;
}

/** How far before a turn to speak it, at this speed. */
export function turnLeadMeters(speedMps: number): number {
  const speed = Number.isFinite(speedMps) && speedMps > 0 ? speedMps : 0;
  const raw = speed * TURN_LEAD_SECONDS;
  return Math.min(TURN_LEAD_MAX_METERS, Math.max(TURN_LEAD_MIN_METERS, raw));
}

/** Strip what a synthesiser should not read.
 *
 *  Valhalla's instructions are already prose, but they arrive with the odd
 *  non-breaking space and the occasional unit abbreviation. Kept minimal: the
 *  instruction is the one string here written by somebody else, and rewriting it
 *  is how a turn ends up described wrongly. */
function speakable(instruction: string): string {
  return instruction.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** What to say now, and the state to carry to the next sample.
 *
 *  RETURNS THE NEXT STATE RATHER THAN MUTATING, so a caller can decide what to do
 *  with the announcements before committing to having made them — which is what
 *  lets the speech layer drop one it cannot deliver without the dedup marking it
 *  spoken.
 */
export function announce(
  input: AnnounceInput,
  state: AnnounceState = INITIAL_ANNOUNCE_STATE,
): { announcements: Announcement[]; state: AnnounceState } {
  // THE BASELINE IS STILL UPDATED WHEN SILENT, which is the whole reason this is
  // not an early `return`. A rider who is muted, or stopped at a light with a
  // popup open, crosses boundaries like anybody else — and if the baseline froze,
  // the crossing would be announced later at some arbitrary moment, out of place
  // and wrong. Silence means "say nothing", never "stop watching".
  const next: AnnounceState = {
    spokenManeuvers: state.spokenManeuvers,
    insideEquityArea:
      input.insideEquityArea === null ? state.insideEquityArea : input.insideEquityArea,
    spokenFreeWarnings: state.spokenFreeWarnings,
    spokenFreeGone: state.spokenFreeGone,
  };

  const silent = input.muted || input.blocked || input.status !== "riding";
  if (silent) {
    // Nothing is marked spoken, so a turn missed while a popup was open is
    // announced the moment it closes — if it is still ahead.
    return { announcements: [], state: next };
  }

  const announcements: Announcement[] = [];

  // ---- Money first, turns second, and the order matters. A rider hears one
  // thing at a time; the equity rate and the free-minute cliff are the two
  // moments money changes, and a turn cue will come round again on the next
  // sample while a boundary crossing will not.

  if (
    input.insideEquityArea !== null &&
    state.insideEquityArea !== null &&
    input.insideEquityArea !== state.insideEquityArea
  ) {
    announcements.push(
      input.insideEquityArea
        ? {
            kind: "equity_entered",
            // The rate, not the saving: a saving needs a baseline and the rider's
            // tier is not this module's business. The number they will be billed
            // at is a fact.
            text: `You're in an equity area now. ${EQUITY_AREA_RATE.perMinCents} cents a minute.`,
            haptic: true,
          }
        : {
            kind: "equity_left",
            text: "You've left the equity area.",
            haptic: true,
          },
    );
  }

  if (input.freeMinutesLeft !== null) {
    const left = Math.max(0, Math.floor(input.freeMinutesLeft));
    if (left <= 0 && !state.spokenFreeGone) {
      announcements.push({
        kind: "free_minutes_gone",
        text: "Your free minutes are used up. You're paying by the minute now.",
        haptic: true,
      });
      next.spokenFreeGone = true;
    } else if (left > 0) {
      // The LOWEST threshold at or above the remaining time, so a sample that
      // skips past two of them announces the urgent one rather than the stale one.
      const due = FREE_MINUTE_WARNINGS.filter(
        (t) => left <= t && !state.spokenFreeWarnings.has(t),
      );
      if (due.length > 0) {
        // THE ACTUAL MINUTES REMAINING, not the threshold that fired. A sample
        // that skips from 20 to 2 — a backgrounded tab, a long gap between fixes
        // — crosses three thresholds at once, and "10 minutes of your free time
        // left" said to a rider with 2 is worse than saying nothing.
        //
        // An earlier version also computed `Math.min(...due)` and folded it into
        // the set below. It was dead: `...due` already contains it, and the text
        // never used it. Mutation testing found it — flipping that `min` to `max`
        // changed nothing, which is the signal that a line reading as
        // load-bearing is not.
        announcements.push({
          kind: "free_minutes",
          text: `${left} ${left === 1 ? "minute" : "minutes"} of your free time left.`,
          haptic: true,
        });
        // EVERY skipped threshold is marked, not just the one announced, or the
        // next sample works through the ones this one jumped over.
        next.spokenFreeWarnings = new Set([...state.spokenFreeWarnings, ...due]);
      }
    }
  }

  const m = input.maneuver;
  if (m && !state.spokenManeuvers.has(m.index)) {
    if (m.metersAway <= turnLeadMeters(input.speedMps)) {
      announcements.push({
        kind: "turn",
        text: speakable(m.instruction),
        haptic: true,
      });
      next.spokenManeuvers = new Set([...state.spokenManeuvers, m.index]);
    }
  }

  return { announcements, state: next };
}

/** Hold a remaining-minutes figure inside the allowance it is about.
 *
 *  Here rather than in the HUD so the bound lives beside the thresholds that read
 *  it. A negative balance is "gone" rather than a number to read out, and one
 *  above the hour is a bad estimate rather than a bonus — §2.2's control already
 *  clamps what the rider types, and this covers the arithmetic downstream of it. */
export function clampFreeMinutes(remainingMinutes: number): number {
  if (!Number.isFinite(remainingMinutes)) return 0;
  return Math.max(0, Math.min(FREE_MINUTES_PER_DAY, Math.floor(remainingMinutes)));
}
