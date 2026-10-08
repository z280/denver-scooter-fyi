// "I have somebody with me."
//
// WHY THIS IS NOT JUST ANOTHER QUICK FILTER. The three quick filters above it
// are shortcuts into the map's own controls — `wireQuickFilters`'s comment is
// explicit that "a quick filter is a shortcut, not a separate filter state",
// and the trip planner deliberately ignores map filters entirely
// (`plan-search.ts`: the fleet is `allFeatures()` and never the filtered view,
// because "a rider's leftover map filters are a view and the SPEC is what says
// what they will ride").
//
// That is the right rule for "show me charged ones". It is the wrong rule here,
// because carrying a passenger is not a view onto the map — it is a fact about
// the trip, and a plan that routes a rider with a passenger onto a vehicle that
// seats one is not a slightly worse plan, it is an unusable one. So this filter
// does two things the others do not: it sets the map controls AND it binds the
// planner.
//
// IT BINDS EVERY LEG, which needed a new idea in `ride-spec.ts`. `must` already
// means "unrelaxable", but `along-the-way.ts` exempts the STARTER vehicle from
// the spec altogether — a scruffy Astro is a fine thing to ride 1.2 km to the
// scooter you actually want, and that exemption is most of what makes hand-offs
// worth having. Right for a preference, wrong for a passenger: you cannot carry
// one on the first leg either. `everyLeg` is the field that says so, and this is
// its first and so far only caller.
//
// IT COMPOSES, IT DOES NOT REPLACE. A rider's saved "ideal scooter" survives
// turning this on: two passengers is a constraint ON TOP of what they like, not
// instead of it. Clobbering their spec would also be a destructive edit made by
// a button that does not look like one.
//
// THE THREE REQUIREMENTS ARE THE OWNER'S, and worth attributing rather than
// presenting as derived. Only the first is a fact about the fleet — the model
// catalogue describes the Apollo as a "Two passenger e-bike w/ pedals", and it
// is the only model so described. The 20% floor and the no-high-risk tier are a
// judgement: a second rider is weight, and a vehicle that strands two people is
// worse than one that strands one.

import type { ModelKey } from "./model-catalog.ts";
import { hardenEveryLeg, type RideSpec, type SpecField } from "./ride-spec.ts";

export const TWO_PASSENGER_KEY = "scooter-fyi-two-passengers";

/** The only model the catalogue describes as carrying two. */
export const TWO_PASSENGER_MODELS: readonly ModelKey[] = ["apollo"];

/** Percent. A second rider is weight; a vehicle that strands two people is
 *  worse than one that strands one. */
export const TWO_PASSENGER_MIN_BATTERY = 20;

/** The fields this mode makes binding. Named so the spec it builds and the
 *  sentence it shows cannot drift apart. */
export const TWO_PASSENGER_FIELDS: readonly SpecField[] = [
  "models",
  "min_battery",
  "min_quality",
];

export function twoPassengers(): boolean {
  try {
    return localStorage.getItem(TWO_PASSENGER_KEY) === "1";
  } catch {
    return false;
  }
}

/** Returns false when storage refused the write.
 *
 *  A FAILED WRITE MATTERS MORE HERE than for the other preferences, and a
 *  surface that calls this must say so rather than swallowing it: a rider who
 *  believes this is on, and whose next reload turns it off, gets offered a
 *  one-seater for a trip they are taking with somebody. */
export function setTwoPassengers(on: boolean): boolean {
  try {
    if (on) localStorage.setItem(TWO_PASSENGER_KEY, "1");
    else localStorage.removeItem(TWO_PASSENGER_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Fold the passenger requirements into a spec, or hand it back untouched.
 *
 *  INTERSECTS the model list rather than replacing it, so a rider who has
 *  already said "only Apollos and Cosmos" and then says "two of us" gets
 *  Apollos — not Apollos and Cosmos, which would ignore what they just asked
 *  for, and not an empty list, which would be a different bug. `null` on the
 *  spec means "any model", so there is nothing to intersect and the passenger
 *  list stands alone.
 *
 *  TAKES THE STRICTER BATTERY FLOOR AND QUALITY TIER for the same reason: this
 *  mode is a floor under the rider's preferences, never a ceiling on them. A
 *  rider who wanted 60% and two seats wanted 60%.
 *
 *  AN EMPTY INTERSECTION IS KEPT, deliberately, and is the one case worth
 *  staring at. A rider whose saved spec excludes the Apollo and who then asks
 *  for two passengers has asked for something no vehicle satisfies, and the
 *  honest answer is the empty plan list the search will produce, with the
 *  relaxation ladder refusing to help because both requirements are hard.
 *  Quietly dropping one of the two to find a plan would hand them a vehicle
 *  that fails a requirement they stated — and whichever one we dropped would
 *  be the wrong one. */
export function applyTwoPassengers(spec: RideSpec, on: boolean = twoPassengers()): RideSpec {
  if (!on) return spec;
  const models =
    spec.models === null
      ? [...TWO_PASSENGER_MODELS]
      : spec.models.filter((m) => TWO_PASSENGER_MODELS.includes(m));
  return hardenEveryLeg(
    {
      ...spec,
      models,
      minBattery: Math.max(spec.minBattery, TWO_PASSENGER_MIN_BATTERY),
      minQuality: spec.minQuality === "ok-only" ? "ok-only" : "no-risk",
    },
    [...TWO_PASSENGER_FIELDS],
  );
}

/** True when the rider's own spec and this mode cannot both be satisfied.
 *
 *  Worth saying out loud rather than leaving them to read an empty list: "no
 *  scooter nearby matches" is the message for a fleet that happens to be
 *  unhelpful today, and this is a different thing — a contradiction between two
 *  requirements they set, which no amount of waiting or walking will fix. */
export function conflictsWithSpec(spec: RideSpec, on: boolean = twoPassengers()): boolean {
  if (!on || spec.models === null) return false;
  return !spec.models.some((m) => TWO_PASSENGER_MODELS.includes(m));
}

/** The sentence shown while the mode is on, or the conflict warning.
 *
 *  It names all three requirements, because a mode that silently changes what a
 *  rider is offered owes them the list — and because the battery floor and the
 *  quality tier are a judgement rather than a fact about the vehicle, so they
 *  should be visible enough to argue with. */
export function twoPassengerNote(spec: RideSpec, on: boolean = twoPassengers()): string | null {
  if (!on) return null;
  if (conflictsWithSpec(spec)) {
    return "Two passengers needs an Apollo, and your ideal scooter rules them out — nothing can match both. Change one of the two.";
  }
  return `Two passengers: Apollos only, ${TWO_PASSENGER_MIN_BATTERY}% battery or more, nothing flagged high-risk — on every leg, including the first.`;
}
