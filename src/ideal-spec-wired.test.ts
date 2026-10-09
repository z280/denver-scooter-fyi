// The planner reads the rider's SAVED sheet, not the map attachment.
//
// Source-level, like `leg-dest-wired.test.ts`, because the fact is a
// source-level one: `savedSpec()` and `activeSpec()` have the same type and
// the same shape, and a unit test of either cannot see which one the search is
// wired to. Only a test of the wiring can.
//
// THE BUG IT PINS. `planSearchDeps` read the sheet from `activeSpec()`, which
// is the spec currently projected onto the MAP FILTERS — non-null only while
// "Show only my ideal scooters" is lit, and out again on the first filter the
// rider nudges. So a rider who had saved a sheet and named it got searches
// that ignored it, under a prompt saying "No ideal scooter set up yet" and a
// button offering to set up the thing they had already set up.
import { describe, expect, it } from "vitest";

import { readSource, withoutComments } from "../tests/helpers/source-text.ts";

const main = withoutComments(readSource("src/main.ts"));

/** The `planSearchDeps` object literal, where every accessor the list and the
 *  search read lives. Bounded at the next top-level `function` so a later
 *  helper mentioning `activeSpec` cannot make these assertions pass. */
function planSearchDepsBody(): string {
  const start = main.indexOf("function planSearchDeps(");
  expect(start).toBeGreaterThan(-1);
  const end = main.indexOf("\nfunction ", start + 1);
  return main.slice(start, end === -1 ? undefined : end);
}

describe("the plan search is wired to the saved spec", () => {
  it("seeds the search sheet from savedSpec", () => {
    const start = main.indexOf("function activeSpecForSearch(");
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf("\nfunction ", start + 1));
    expect(body).toContain("savedSpec()");
    // The attachment is a fact about the map, and the map is a view.
    expect(body).not.toContain("activeSpec()");
  });

  it("scores shares against the saved spec, not the attached one", () => {
    const deps = planSearchDepsBody();
    const line = deps.slice(deps.indexOf("activeSpec:"));
    expect(line.slice(0, 120)).toContain("savedSpec()");
  });

  it("asks a separate question for whether the rider HAS one", () => {
    // `activeSpec` goes null when the rider stands the sheet down for one
    // trip. Deriving "they have none" from that null is what told a rider
    // with a saved sheet to go and make one.
    const deps = planSearchDepsBody();
    expect(deps).toContain("hasSavedSpec:");
    const line = deps.slice(deps.indexOf("hasSavedSpec:"));
    expect(line.slice(0, 120)).toContain("savedSpec()");
  });

  it("does not gate hasSavedSpec on the sheet being in force", () => {
    // THE MUTATION THIS CATCHES: `hasSavedSpec: () => useIdealSpec && ...`
    // restores the original bug through the new door — stand the sheet down
    // and the app forgets you ever made one.
    const deps = planSearchDepsBody();
    const line = deps.slice(deps.indexOf("hasSavedSpec:"));
    expect(line.slice(0, line.indexOf("\n", 1))).not.toContain("useIdealSpec");
  });

  it("names the saved sheet in the row that offers to stand it down", () => {
    // The summary must survive the stand-down too: it is the label on the
    // switch that puts the sheet back.
    const deps = planSearchDepsBody();
    const line = deps.slice(deps.indexOf("idealSpecSummary:"));
    expect(line.slice(0, 200)).toContain("savedSpec()");
  });
});
