// The bridge between what the rider SAID and what the planner SEARCHES.
//
// THE PROBLEM THIS EXISTS TO FIX. There were two preference systems in this
// app and they never met. The "find wheels" wizard asks one interview question
// — what matters most, and which model if the answer is "the exact type" — and
// handed the answer to `recommend.ts`, which ranks individual scooters for the
// Recommended drawer. `plan-search.ts`, which builds the one- and two-leg
// plans, read the rider's saved `RideSpec` and nothing else. So a rider set a
// destination, answered "I want a Cosmo", and got a list of plans that had
// never heard of it. The answer was not weighed and discarded; it was never
// passed.
//
// COMPOSED OVER THE SAVED SPEC, NEVER INSTEAD OF IT, and this follows
// `passenger-mode.ts`'s `applyTwoPassengers` exactly — same shape, same
// argument. The interview is one question asked in a hurry on the way out of
// the door; "My ideal scooter" is a sheet the rider sat down and filled in.
// Treating the hurried answer as a replacement would throw away the considered
// one, so it narrows and never widens: a rider who set a 40% battery floor and
// then asks for the nearest scooter still gets 40%.
//
// WHY THE ANSWERS ARE PREFERENCES AND NOT `must`. The interview has no way to
// say "or else show me nothing" — it is a ranking question, asked of a rider
// who wants to be riding. So nothing here lands in `must`, and the relaxation
// ladder can give all of it up before the app reports an empty list. The one
// thing that may not be relaxed is whatever the rider marked `must`
// themselves, which is already in the spec and is copied through untouched.

import type { ModelKey } from "./model-catalog.ts";
import type { RidePriority, RideTypeChoice } from "./recommend.ts";
import type { RideSpec, SpecField } from "./ride-spec.ts";

/** What the wizard's one question produced. The same three values
 *  `onInterviewDone` carries, named here so this module needs nothing from the
 *  wizard but its answer. */
export interface InterviewAnswers {
  priority: RidePriority;
  typeChoice: RideTypeChoice;
}

/** How far a rider who said "whatever is closest" will walk.
 *
 *  Six minutes rather than the spec default of twelve. The figure is the point
 *  of the answer — "nearest" has to mean something narrower than the standing
 *  setting or choosing it changed nothing — and it is a PREFERENCE, so a trip
 *  with nothing inside six minutes still finds the twelve-minute scooter once
 *  the ladder relaxes this. Half the default, chosen because it is obviously
 *  half rather than tuned: a rider who wants a specific number has
 *  "My ideal scooter" for that. */
export const NEAREST_WALK_MINUTES = 6;

/** The quality floor "a scooter in good shape" asks for.
 *
 *  `no-risk` and not `ok-only`: the rider asked for good condition, not for a
 *  guarantee nothing is unknown. `ok-only` also excludes every vehicle the
 *  fleet has no condition report for, which on this fleet is most of them —
 *  answering "good shape" and getting four results would read as the app being
 *  broken rather than as the fleet being unknown. */
export const GOOD_SHAPE_QUALITY = "no-risk" as const;

/** Narrow `spec` by the interview answer. Returns `spec` unchanged when there
 *  is nothing to add, so a caller can apply it unconditionally.
 *
 *  Each branch is one answer, and each narrows exactly one field:
 *
 *    "type"     → the chosen model, INTERSECTED with the saved model list.
 *    "quality"  → the stricter of the saved floor and `no-risk`.
 *    "distance" → the shorter of the saved walk cap and six minutes.
 *
 *  An IMPOSSIBLE INTERSECTION IS KEPT, for `passenger-mode.ts`'s reason: a
 *  rider whose saved spec excludes the Cosmo and who then asks for a Cosmo has
 *  asked for two things at once, and dropping either side hands them a vehicle
 *  failing a requirement they stated. Unlike two passengers this one is soft,
 *  so the ladder will relax the model preference and the rider still gets
 *  plans — they simply are not Cosmos, which is the honest outcome. */
export function applyInterview(
  spec: RideSpec,
  answers: InterviewAnswers | null,
): RideSpec {
  if (answers === null) return spec;
  switch (answers.priority) {
    case "type":
      return { ...spec, models: intersectModel(spec.models, answers.typeChoice) };
    case "quality":
      return { ...spec, minQuality: stricterQuality(spec.minQuality) };
    case "distance":
      return {
        ...spec,
        maxWalkMinutes: Math.min(spec.maxWalkMinutes, NEAREST_WALK_MINUTES),
      };
  }
}

/** The saved list narrowed to one model, or just that model when the rider had
 *  no list. An empty result is kept — see `applyInterview`'s header. */
function intersectModel(
  saved: ModelKey[] | null,
  wanted: ModelKey,
): ModelKey[] {
  // `null` is "any", which is not the same as "all four": it admits a model
  // that joins the fleet later. Intersecting with it is therefore the wanted
  // model alone, not a filter over a list that does not exist.
  if (saved === null) return [wanted];
  return saved.filter((m) => m === wanted);
}

/** The stricter of what the rider saved and what "good shape" asks for.
 *
 *  Ordered rather than overwritten: a rider who already set `ok-only` asked
 *  for MORE than this, and an interview answer must not talk them down to
 *  `no-risk`. Same "floor under their preferences, never a ceiling" rule
 *  `applyTwoPassengers` uses for its battery figure. */
function stricterQuality(saved: RideSpec["minQuality"]): RideSpec["minQuality"] {
  return saved === "ok-only" ? "ok-only" : GOOD_SHAPE_QUALITY;
}

/** One line naming what the answer did to the search, for the plan list to
 *  show above its rows. `null` when the answer changed nothing — either
 *  because there was no answer, or because the saved spec was already at least
 *  this strict, in which case saying so would claim credit for a narrowing
 *  that did not happen.
 *
 *  SAID OUT LOUD because this is the fix: the whole complaint was that the
 *  answer vanished. A rider who is told "ranked for a Cosmo, which you asked
 *  for" can see their input arrived, and a rider who sees nothing can tell
 *  that it did not. */
export function interviewNote(
  spec: RideSpec,
  answers: InterviewAnswers | null,
  modelLabel: (key: ModelKey) => string,
  relaxed: readonly SpecField[] = [],
): string | null {
  if (answers === null) return null;
  const applied = applyInterview(spec, answers);
  switch (answers.priority) {
    case "type": {
      if (sameModels(spec.models, applied.models)) return null;
      const name = modelLabel(answers.typeChoice);
      // THE SEARCH GAVE IT UP, so say that and not the opposite. These answers
      // are preferences, which means the relaxation ladder can drop them to
      // find anything at all — and when it does, a note reading "showing
      // Cosmos first" sits directly under "we had to give up: Model" and
      // contradicts it. A rider reading both learns the app is not keeping
      // track, which is worse than either line alone.
      if (relaxed.includes("models")) {
        return `No ${name} was close enough, so these are the next best — not the ${name} you asked for.`;
      }
      // `intersectModel` always returns a list, but the field is nullable for
      // every other caller — narrowed rather than asserted so a future change
      // to that branch is a compile error here.
      return (applied.models?.length ?? 0) === 0
        ? `You asked for ${name}, which your ideal scooter rules out — showing what else is there.`
        : `Showing ${name} first, which is what you asked for.`;
    }
    case "quality":
      if (applied.minQuality === spec.minQuality) return null;
      return relaxed.includes("min_quality")
        ? "Nothing in good enough shape was close enough, so these are the next best."
        : "Ranked for condition, which is what you asked for.";
    case "distance":
      // `maxWalkMinutes` is not a `SpecField` and so is never in `relaxed` —
      // `capRelaxed` on the view is how a widened walk is reported, and the
      // panel already renders that as its own line. Nothing to reconcile here.
      return applied.maxWalkMinutes === spec.maxWalkMinutes
        ? null
        : `Ranked for a short walk — about ${NEAREST_WALK_MINUTES} minutes.`;
  }
}

function sameModels(a: ModelKey[] | null, b: ModelKey[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((m, i) => m === b[i]);
}
