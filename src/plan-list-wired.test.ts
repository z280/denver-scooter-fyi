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

  it("is reached from 'need wheels' THROUGH the interview, not beside it", () => {
    // The chain is two steps now, and that is the fix rather than an
    // indirection to tidy away. "Need wheels" used to call `openPlanList`
    // directly, and `openPlanList` called `enterFindWheels()` — which starts
    // the wizard. So the rider got an interview and a list of plans at the same
    // moment, and the interview's answer never reached the plans.
    //
    // Still asserted on the CALLS and not on the functions existing, because an
    // unreferenced search is the state this file exists to rule out. Both links
    // are checked: severing either one puts the engine back out of reach.
    const code = withoutComments(main);
    const branch = code.slice(code.indexOf('if (wheels === "need")'));
    expect(branch.slice(0, 200)).toContain("enterFindWheels()");
    expect(branch.slice(0, 200)).not.toContain("openPlanList");

    const done = code.slice(code.indexOf("onInterviewDone:"));
    expect(done.slice(0, 1600)).toContain("openPlanList(trip.dest)");
  });

  it("does not start the wizard from inside openPlanList", () => {
    // The exact line that produced two surfaces over one map. It was there so
    // that dismissing the list revealed a map already in find-wheels state;
    // `enterFindWheels` also runs `wizard.start()`, so it put the interview
    // back on screen underneath the plans.
    const body = functionBody(main, "function openPlanList(");
    expect(body).not.toContain("enterFindWheels");
  });

  it("feeds the interview answer into the search", () => {
    // The other half of the complaint: the answer was not weighed and
    // discarded, it was never passed. Composed over the rider's saved sheet in
    // `planSearchDeps`, the same way Two Passengers is.
    const body = functionBody(main, "function planSearchDeps()");
    expect(body).toContain("applyInterview");
    expect(body).toContain("interviewAnswers");
  });

  it("lives in the Recommended drawer, above the scooters", () => {
    // "The proper menu", and the reason dismissing the plans leaves the rider
    // somewhere: the ranked scooters are the next section down, so emptying
    // this one continues the old path in place instead of changing surface.
    const drawer = html.slice(html.indexOf('id="drawer-recommended"'));
    const body = drawer.slice(0, drawer.indexOf("</aside>"));
    expect(body).toMatch(/id="plan-list"/);
    expect(body.indexOf('id="plan-list"')).toBeLessThan(
      body.indexOf('id="recommended-body"'),
    );
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
