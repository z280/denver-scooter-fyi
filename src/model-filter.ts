/** Phase 6 §6.3 — ONE model filter, named.
 *
 *  WHY THIS EXISTS. The app had two model filters that agreed by coincidence
 *  and disagreed on the one gesture a rider is most likely to make by
 *  accident: turning every toggle off. The Filters drawer kept a
 *  `Set<ModelKey>` and entered its filter branch on
 *  `models.size < ALL_MODELS.length`, so an EMPTY set did not skip the filter
 *  — it entered it and admitted `key === null`, leaving **unrecognized
 *  hardware alone** on the map. The ride HUD kept its own set where empty
 *  meant **nothing at all**. Same gesture, two surfaces, opposite results,
 *  and neither is what a rider means by unticking everything.
 *
 *  The bug is not that the two sets drifted. It is that a SET CANNOT SAY
 *  WHICH IT MEANS. `new Set()` is both "I turned everything off" and "I have
 *  not chosen yet", and `new Set(ALL_MODELS)` is both "I want all four" and
 *  "no filter" — distinctions each caller then re-invented, differently.
 *
 *  So the selection becomes a NAMED THREE-STATE. `all`, `only(models)` and
 *  `none` are three things a rider can mean, written down, and `admits()` is
 *  the single place that decides what each one shows. Both surfaces read and
 *  write this one value; neither owns a copy, so there is nothing to push
 *  back when a ride ends.
 *
 *  PURE. No DOM, no map, no device feed — it takes a model key and answers.
 */

import { ALL_MODELS, type ModelKey } from "./model-catalog.ts";

/** What a rider has said about which models they want to see.
 *
 *  Three cases rather than a set, because the two degenerate sets are exactly
 *  the ones whose meaning the old code disagreed about. */
export type ModelSelection =
  /** Every model, and unrecognized hardware too. The default. */
  | { readonly kind: "all" }
  /** Only these, plus unrecognized hardware. Never empty and never complete —
   *  `selectionOf` collapses both of those into `none` and `all`, so a reader
   *  of this case can rely on it being a genuine partial choice. */
  | { readonly kind: "only"; readonly models: ReadonlySet<ModelKey> }
  /** None. Not "no filter", not "everything unrecognized" — none. */
  | { readonly kind: "none" };

export const ALL_SELECTED: ModelSelection = { kind: "all" };
export const NONE_SELECTED: ModelSelection = { kind: "none" };

/** Build a selection from the toggles a rider actually ticked.
 *
 *  THE NORMALISATION IS THE POINT, and it is why callers hand their set here
 *  rather than constructing a variant themselves. A full set is `all` however
 *  it was arrived at, and an empty one is `none` — so two surfaces that reach
 *  the same state by different gestures hold the same value, and `only` never
 *  has to be interrogated for the two sizes that used to mean something else.
 *
 *  Unknown keys are dropped rather than carried: a stale preset naming a model
 *  the catalog has since dropped would otherwise make `only` look partial
 *  forever and quietly filter out a model it was never asked about. */
export function selectionOf(models: Iterable<ModelKey>): ModelSelection {
  const chosen = new Set<ModelKey>();
  for (const m of models) if (ALL_MODELS.includes(m)) chosen.add(m);
  if (chosen.size === 0) return NONE_SELECTED;
  if (chosen.size === ALL_MODELS.length) return ALL_SELECTED;
  return { kind: "only", models: chosen };
}

/** The ticked toggles, for rendering a control. The inverse of `selectionOf`
 *  up to normalisation: feeding this back in returns an equal selection. */
export function modelsOf(selection: ModelSelection): ReadonlySet<ModelKey> {
  switch (selection.kind) {
    case "all":
      return new Set(ALL_MODELS);
    case "none":
      return new Set();
    case "only":
      return new Set(selection.models);
  }
}

/** Does this selection show that device?
 *
 *  `key` is `modelKeyOf(properties)` — NULL for hardware the catalog does not
 *  recognize, which is the case the two old filters disagreed about:
 *
 *  - `all` shows it, because the rider has excluded nothing.
 *  - `only` shows it, because a rider deselecting Apollos did not ask to hide
 *    a scooter nobody has identified. Hiding it would also starve the
 *    model-report flow, which exists to turn these into recognized models.
 *  - `none` HIDES it, because none means none. This is the half the drawer
 *    got wrong: unticking every box left a map of mystery scooters, which no
 *    rider has ever meant by it. */
export function admits(
  selection: ModelSelection,
  key: ModelKey | null,
): boolean {
  switch (selection.kind) {
    case "all":
      return true;
    case "none":
      return false;
    case "only":
      return key === null || selection.models.has(key);
  }
}

/** TRUE when the selection excludes nothing, so a caller can skip the filter
 *  pass entirely. Named rather than open-coded as `kind === "all"` because
 *  that comparison appearing in a filter loop is how the old
 *  `size < ALL_MODELS.length` branch got written. */
export function admitsEverything(selection: ModelSelection): boolean {
  return selection.kind === "all";
}

/** Flip one model, renormalising. Ticking the fourth box gives `all`;
 *  unticking the last gives `none` — the two transitions the set-based code
 *  could not represent. */
export function toggleModel(
  selection: ModelSelection,
  key: ModelKey,
): ModelSelection {
  const next = new Set(modelsOf(selection));
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return selectionOf(next);
}

/** Value equality, so a surface can skip a re-render without comparing sets by
 *  hand — and so a test can assert "nothing changed" about a selection that
 *  may have been rebuilt on the way through. */
export function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "only" || b.kind !== "only") return true;
  if (a.models.size !== b.models.size) return false;
  for (const m of a.models) if (!b.models.has(m)) return false;
  return true;
}
