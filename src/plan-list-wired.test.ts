// §2.4 — the Phase 2 engine is REACHED. Source-level, in the same spirit as
// `mode-bar-gone.test.ts` and for the same reason: the fact being asserted is
// itself a source-level fact.
//
// Phase 2 shipped engine-first. `rankPlans` was tested, priced, bounded and
// wholly unreachable — nothing in the app called it, and no behavioural test
// could tell you that, because every test it had passed. The trap this closes
// is a future change that quietly severs the one call site again, leaving a
// large, well-tested, unreachable search exactly as before.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  functionBody,
  readSource,
  withoutComments,
} from "../tests/helpers/source-text.ts";

const ROOT = join(import.meta.dirname, "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const srcDir = join(ROOT, "src");
const main = readSource("src/main.ts");
// COMMENTS STRIPPED. These assertions are about what the code DOES, and this
// repo's comments name the very identifiers under test — `plan-search.ts`'s own
// header explains the `allFeatures()` / `visibleFeatures()` rule in prose, so a
// naive scan would find "rankPlans(" in a comment and call the module a caller.
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({
    file: f,
    text: withoutComments(readFileSync(join(srcDir, f), "utf8")),
  }));

describe("the plan list is wired to something", () => {
  it("has a mount point in index.html", () => {
    expect(html).toMatch(/id="plan-list"/);
  });

  it("is opened by the home bar's 'need wheels' answer", () => {
    // The whole point of the branch. Asserted on the call rather than on
    // `openPlanList` merely existing, since an unreferenced function is the
    // state this test exists to rule out.
    const code = withoutComments(main);
    const branch = code.slice(code.indexOf('if (wheels === "need")'));
    expect(branch.slice(0, 200)).toContain("openPlanList(dest)");
  });

  it("reaches rankPlans through exactly one assembly point", () => {
    // Every field of RankPlansContext is a decision with a documented wrong
    // answer. Two assembly points means two sets of those decisions, and the
    // second one gets reviewed by nobody.
    const callers = sources.filter(
      (s) => s.file !== "along-the-way.ts" && /\brankPlans\(/.test(s.text),
    );
    expect(callers.map((s) => s.file)).toEqual(["plan-search.ts"]);
  });

  it("searches the unfiltered fleet, which is rankPlans's own stated rule", () => {
    // "Feed it the UNFILTERED fleet (devices.allFeatures(), never
    // visibleFeatures())." Passing the view instead returns plausible plans,
    // so nothing downstream can catch it.
    const body = functionBody(main, "function planSearchDeps()");
    expect(body).toContain("devices.allFeatures()");
    expect(body).not.toContain("visibleFeatures()");
  });

  it("closes the list whenever a walk begins, by any route", () => {
    // `beginWalkToVehicle` is the single funnel for every way of starting a walk
    // — the plan list, a tap on the map, resuming a dibs claim from a toast — and
    // its own comment is already about this: "leaving the chooser open behind the
    // walk is two surfaces arguing about one decision, and the ranked list is
    // stale the moment a scooter is picked out of it." Without the call there,
    // the list floats over the arrival panel offering four plans for a trip the
    // rider has already started walking.
    const fn = withoutComments(main.slice(main.indexOf("function beginWalkToVehicle(")));
    const body = fn.slice(0, fn.indexOf("const panel = createArrivalPanel"));
    expect(body).toContain("closePlanList()");
    expect(body).toContain("exitFindWheels()");
  });

  it("never hands the planner saved PLACES as favourite vehicles", () => {
    // favorites.ts stores Home and Work, keyed by a place id. The planner's
    // favourite bonus wants vehicle keys. Passing one as the other matches
    // nothing and silently disables the term — a dead ranking input that looks
    // wired. There is no favourite-vehicle store at all: my-scooters.ts was
    // built and then deleted.
    expect(functionBody(main, "function planSearchDeps()")).not.toContain("loadFavorites");
  });
});
