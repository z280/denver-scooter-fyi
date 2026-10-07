import { describe, it, expect } from "vitest";
import { ALL_MODELS, type ModelKey } from "./model-catalog.ts";
import {
  ALL_SELECTED,
  NONE_SELECTED,
  admits,
  admitsEverything,
  isNarrowed,
  modelsOf,
  sameSelection,
  selectionOf,
  toggleModel,
  type ModelSelection,
} from "./model-filter.ts";

/** Every model key, plus the unrecognized case the two old filters disagreed
 *  about. `null` is what `modelKeyOf` returns for hardware the catalog has
 *  never seen. */
const KEYS: readonly (ModelKey | null)[] = [...ALL_MODELS, null];

function shown(selection: ModelSelection): (ModelKey | null)[] {
  return KEYS.filter((k) => admits(selection, k));
}

describe("selectionOf — normalisation", () => {
  it("collapses a full set to `all` and an empty one to `none`", () => {
    // The whole bug in one assertion. A set cannot say which of these it
    // means; these two cases are where the drawer and the HUD diverged.
    expect(selectionOf(ALL_MODELS)).toEqual({ kind: "all" });
    expect(selectionOf([])).toEqual({ kind: "none" });
  });

  it("keeps a genuine partial choice as `only`", () => {
    const sel = selectionOf(["apollo", "cosmo"]);
    expect(sel.kind).toBe("only");
    expect(modelsOf(sel)).toEqual(new Set(["apollo", "cosmo"]));
  });

  it("never produces an `only` that is empty or complete", () => {
    // So a reader of the `only` case can trust it is a real partial choice
    // and never has to re-check the two sizes that used to mean other things.
    for (const input of [[], [...ALL_MODELS], ["astro"], ALL_MODELS.slice(1)]) {
      const sel = selectionOf(input as ModelKey[]);
      if (sel.kind === "only") {
        expect(sel.models.size).toBeGreaterThan(0);
        expect(sel.models.size).toBeLessThan(ALL_MODELS.length);
      }
    }
  });

  it("drops keys the catalog does not know", () => {
    // A stale saved preset naming a retired model would otherwise keep the
    // selection looking partial forever, filtering out models nobody excluded.
    const sel = selectionOf([...ALL_MODELS, "hoverboard" as ModelKey]);
    expect(sel).toEqual({ kind: "all" });
  });

  it("ignores duplicates", () => {
    expect(selectionOf([...ALL_MODELS, ...ALL_MODELS])).toEqual({ kind: "all" });
  });
});

describe("admits — what each state shows", () => {
  it("`all` shows every model and unrecognized hardware", () => {
    expect(shown(ALL_SELECTED)).toEqual(KEYS);
    expect(admitsEverything(ALL_SELECTED)).toBe(true);
  });

  it("`only` shows the chosen models AND unrecognized hardware", () => {
    // Deselecting Apollos is not a request to hide a scooter nobody has
    // identified — and hiding it would starve the model-report flow that
    // exists to turn these into recognized models.
    const sel = selectionOf(["apollo"]);
    expect(shown(sel)).toEqual(["apollo", null]);
    expect(admitsEverything(sel)).toBe(false);
  });

  it("`none` shows NOTHING — including unrecognized hardware", () => {
    // THE DRAWER'S BUG, pinned. `models.size < ALL_MODELS.length` admitted an
    // empty set into the filter branch, where `key === null` still passed —
    // so unticking every box left a map of mystery scooters. No rider has
    // ever meant that by turning everything off.
    expect(shown(NONE_SELECTED)).toEqual([]);
    expect(admits(NONE_SELECTED, null)).toBe(false);
    expect(admitsEverything(NONE_SELECTED)).toBe(false);
  });

  it("gives one answer where the two old filters gave two", () => {
    // The old drawer kept unrecognized hardware on an all-off selection; the
    // old HUD kept nothing. There is now one value and one answer, so the
    // surface a rider happens to be looking at cannot change what off means.
    const offEverywhere = selectionOf([]);
    expect(shown(offEverywhere)).toEqual([]);
    // ...and it is reachable by either route: a drawer that unticks boxes one
    // at a time ends in the same state as a HUD that starts with none.
    let viaToggles: ModelSelection = ALL_SELECTED;
    for (const m of ALL_MODELS) viaToggles = toggleModel(viaToggles, m);
    expect(sameSelection(viaToggles, offEverywhere)).toBe(true);
  });
});

describe("modelsOf — round-tripping to a control and back", () => {
  it("round-trips all three states", () => {
    for (const sel of [
      ALL_SELECTED,
      NONE_SELECTED,
      selectionOf(["cosmo", "trike"]),
    ]) {
      expect(sameSelection(selectionOf(modelsOf(sel)), sel)).toBe(true);
    }
  });

  it("hands back a copy, so a control cannot mutate the filter", () => {
    const sel = selectionOf(["apollo", "astro"]);
    const ticked = modelsOf(sel) as Set<ModelKey>;
    ticked.delete("apollo");
    // The selection is unchanged: the control edited its own render state.
    expect(admits(sel, "apollo")).toBe(true);
  });
});

describe("toggleModel", () => {
  it("ticking the last box gives `all`, not a full `only`", () => {
    const threeOfFour = selectionOf(ALL_MODELS.slice(1));
    expect(toggleModel(threeOfFour, ALL_MODELS[0])).toEqual({ kind: "all" });
  });

  it("unticking the last box gives `none`, not an empty `only`", () => {
    // The transition the set-based code could not represent, and the reason
    // "none" was two different things depending on who asked.
    expect(toggleModel(selectionOf(["astro"]), "astro")).toEqual({
      kind: "none",
    });
  });

  it("is its own inverse", () => {
    for (const start of [ALL_SELECTED, NONE_SELECTED, selectionOf(["cosmo"])]) {
      for (const m of ALL_MODELS) {
        const there = toggleModel(start, m);
        expect(sameSelection(toggleModel(there, m), start)).toBe(true);
      }
    }
  });

  it("turns one model off from `all`", () => {
    const sel = toggleModel(ALL_SELECTED, "trike");
    expect(admits(sel, "trike")).toBe(false);
    expect(admits(sel, "apollo")).toBe(true);
    expect(admits(sel, null)).toBe(true);
  });
});

describe("isNarrowed", () => {
  it("is false only for `all`", () => {
    // For a surface whose rule is "say this only when the rider deliberately
    // picked something" — NOT the same question as `admits`, which is true
    // under `all` for every model.
    expect(isNarrowed(ALL_SELECTED)).toBe(false);
    expect(isNarrowed(NONE_SELECTED)).toBe(true);
    expect(isNarrowed(selectionOf(["trike"]))).toBe(true);
  });

  it("is what separates the Rover caveat from a blanket warning", () => {
    // The drawer's rule is `has("trike") && size < ALL_MODELS.length`. Pairing
    // `admits` with this reproduces it; `admits` alone showed a service-area
    // warning to every rider on the default selection.
    const rule = (sel: ModelSelection) => isNarrowed(sel) && admits(sel, "trike");
    expect(rule(ALL_SELECTED)).toBe(false);
    expect(rule(selectionOf(["trike"]))).toBe(true);
    expect(rule(selectionOf(["astro"]))).toBe(false);
    expect(rule(NONE_SELECTED)).toBe(false);
  });
});

describe("sameSelection", () => {
  it("compares by value, not identity", () => {
    expect(sameSelection(selectionOf(["apollo"]), selectionOf(["apollo"]))).toBe(true);
    expect(sameSelection(ALL_SELECTED, { kind: "all" })).toBe(true);
  });

  it("separates the three kinds and differing sets", () => {
    expect(sameSelection(ALL_SELECTED, NONE_SELECTED)).toBe(false);
    expect(sameSelection(selectionOf(["apollo"]), selectionOf(["cosmo"]))).toBe(false);
    expect(
      sameSelection(selectionOf(["apollo"]), selectionOf(["apollo", "cosmo"])),
    ).toBe(false);
  });
});
