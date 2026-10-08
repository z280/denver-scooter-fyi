// How many scooters a rider is willing to be sent to.
//
// WHY THIS IS A SETTING AND NOT A CLEVERNESS. `rankPlans` prices a hand-off
// honestly — the second unlock is in the total, the walk between is zero
// because a hand-off lands ON the next vehicle — so a two-scooter plan that
// comes out cheaper really is cheaper. What the arithmetic cannot price is
// whether the rider WANTS to park one scooter, find another and start a second
// rental mid-trip. For plenty of people the answer is no at any price: they are
// carrying something, they are in a hurry, they have been burned by a scooter
// that was gone when they got there.
//
// The engine had no opinion to offer here and the app offered no control, so
// the rider's only way to decline a hand-off was to notice it in the list and
// pick a different row — every single time.
//
// A CAP, NOT A TOGGLE. "Off" and "on" would collapse a real distinction: one
// hand-off is a different proposition from two, and a rider who will do one
// switch is not thereby volunteering for three. The cap is in HAND-OFFS rather
// than in vehicles because that is the unit of inconvenience — the number of
// times you have to get off and find another one.
//
// IT FILTERS, IT DOES NOT RE-RANK. The planner's order is its own and stays
// whatever it was; this removes rows the rider has said they do not want to be
// shown. If that leaves nothing, the surface says so rather than quietly
// restoring what was filtered — a search that overrides the rider's own setting
// to avoid an empty list is one they stop being able to trust, which is the
// same argument `ride-spec.ts`'s relaxation ladder makes about itself.

import type { TripPlan } from "./along-the-way.ts";

export const MAX_HAND_OFFS_KEY = "scooter-fyi-max-handoffs";

/** `null` means no cap. */
export type HandOffCap = 0 | 1 | null;

export const DEFAULT_HAND_OFF_CAP: HandOffCap = null;

export interface HandOffCapOption {
  value: HandOffCap;
  label: string;
  /** What choosing it actually does, in the rider's terms. */
  hint: string;
}

/** The three answers, in the order they are offered.
 *
 *  "Any" is the default and is listed LAST, against the usual instinct to put
 *  the default first: the list reads as a ladder of increasing willingness, and
 *  a rider scanning it should meet the most restrictive answer first because
 *  that is the one they are looking for when they come here at all. Nobody
 *  opens this setting to turn hand-offs on. */
export const HAND_OFF_CAP_OPTIONS: readonly HandOffCapOption[] = [
  {
    value: 0,
    label: "One scooter only",
    hint: "Never plan a trip that has you switching scooters, even if it would be cheaper or quicker.",
  },
  {
    value: 1,
    label: "At most one switch",
    hint: "One hand-off is fine; a plan with two or more is not offered.",
  },
  {
    value: null,
    label: "Any number of switches",
    hint: "Show every plan the planner finds. This is the default.",
  },
];

function parseCap(raw: string | null): HandOffCap | undefined {
  if (raw === "0") return 0;
  if (raw === "1") return 1;
  if (raw === "any") return null;
  return undefined;
}

/** The rider's cap. Falls back to the default for anything unrecognised,
 *  including a value written by a build that offered a different ladder. */
export function handOffCap(): HandOffCap {
  try {
    return parseCap(localStorage.getItem(MAX_HAND_OFFS_KEY)) ?? DEFAULT_HAND_OFF_CAP;
  } catch {
    return DEFAULT_HAND_OFF_CAP;
  }
}

/** Returns false when storage refused the write (private mode, or quota), so
 *  the surface can say the choice will not survive a reload rather than
 *  pretending it was kept. */
export function setHandOffCap(cap: HandOffCap): boolean {
  try {
    localStorage.setItem(MAX_HAND_OFFS_KEY, cap === null ? "any" : String(cap));
    return true;
  } catch {
    return false;
  }
}

/** Does this plan clear the cap? */
export function allowsPlan(plan: Pick<TripPlan, "handOffs">, cap: HandOffCap): boolean {
  return cap === null || plan.handOffs <= cap;
}

export interface CappedPlans<T> {
  kept: T[];
  /** How many the cap removed. Reported rather than inferred from the lengths,
   *  so a surface can say "two plans hidden" without doing arithmetic on a list
   *  it did not build. */
  hidden: number;
}

/** Apply the cap to a ranked list, keeping its order.
 *
 *  THE WALK-ONLY PLAN IS NEVER FILTERED, whatever the cap says. It has no
 *  hand-offs by construction, so this is not a special case so much as a
 *  consequence worth naming: a rider who will not switch scooters still gets
 *  told they could walk it. */
export function capPlans<T extends { plan: Pick<TripPlan, "handOffs"> }>(
  rows: readonly T[],
  cap: HandOffCap,
): CappedPlans<T> {
  if (cap === null) return { kept: [...rows], hidden: 0 };
  const kept = rows.filter((r) => allowsPlan(r.plan, cap));
  return { kept, hidden: rows.length - kept.length };
}

/** What to say above a list the cap has thinned, or null when it has not.
 *
 *  It names the setting in the rider's own words so the sentence is actionable
 *  — the complaint it answers is "why am I not being shown the cheap one", and
 *  "2 plans hidden" alone would not answer it. */
export function capNote(hidden: number, cap: HandOffCap): string | null {
  if (hidden <= 0 || cap === null) return null;
  const plans = hidden === 1 ? "1 plan" : `${hidden} plans`;
  const rule =
    cap === 0 ? "switching scooters" : "more than one scooter switch";
  return `${plans} hidden: you've asked us not to plan trips with ${rule}.`;
}
