// The wizard is seeded with THIS LEG's destination. Source-level, like
// `plan-list-wired.test.ts`, because the fact is a source-level one: the rule
// lives in `legTarget`, and the only thing that can go wrong now is the call
// site drifting away from it again.
//
// It drifted once already. The seed was an expression inlined here, guarded on
// a pending trip that `takePendingTrip` had already consumed — so on leg two
// the guard was false, no destination was dispatched, and the leg ran on
// whatever the doc happened to carry. A unit test of `legTarget` cannot see
// that; only a test of the wiring can.
import { describe, it, expect } from "vitest";

import { readSource, withoutComments } from "../tests/helpers/source-text.ts";

const main = withoutComments(readSource("src/main.ts"));

describe("the wizard's destination comes from the trip ledger", () => {
  it("seeds from legTarget", () => {
    expect(main).toContain("legTarget(");
    const call = main.slice(main.indexOf("legTarget("));
    expect(call.slice(0, 200)).toContain("activeTrip()");
  });

  it("does not gate the seed on the pending trip", () => {
    // THE REGRESSION. `takePendingTrip` is a one-shot; gating on it starves
    // every leg after the first. The dispatch must sit outside that branch.
    const seed = main.indexOf("legTarget(");
    const dispatch = main.indexOf('type: "setDest"', seed);
    const guard = main.indexOf("if (trip) {", seed);
    expect(dispatch).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    // The dispatch comes BEFORE the `if (trip)` block, not inside it...
    expect(dispatch).toBeLessThan(guard);
    // ...and its OWN condition does not mention the pending trip either.
    // Position alone misses that: re-adding the guard as `&& trip` on this
    // `if` starves leg two exactly as before while keeping the dispatch
    // textually outside the block. Found by mutation.
    const condition = main.slice(seed, dispatch);
    const lastIf = condition.lastIndexOf("if (");
    expect(lastIf).toBeGreaterThan(-1);
    expect(condition.slice(lastIf, condition.indexOf(")", lastIf) + 1)).not.toContain(
      "trip",
    );
  });

  it("never seeds the final destination directly past a hand-off", () => {
    // `trip.dest` reaching `setDest` without going through `legTarget` is the
    // original bug, spelled exactly as it was spelled before.
    const seed = main.slice(main.indexOf("legTarget("), main.indexOf("legTarget(") + 400);
    expect(seed).not.toContain("legEndsAtHandOff");
  });

  it("decides single / stale / trip through planLedger, not inline", () => {
    // The rule is `planLedger`'s, where it can be tested. `main.ts` keeps only
    // the map lookup, which it alone can do.
    const body = main.slice(main.indexOf("function takePlanRow("));
    const upToWalk = body.slice(0, body.indexOf("beginWalkToVehicle"));
    expect(upToWalk).toContain("planLedger(");
    expect(upToWalk).toContain("startTrip({");
  });

  it("does not start walking on a plan whose hand-off has gone", () => {
    // THE REVIEWER'S FINDING, and the sharpest form of the original bug. The
    // first draft of this branch called `endTrip()` and fell through: pins,
    // close the list, walk to the first scooter — with no ledger, so
    // `legTarget` handed back the pending FINAL destination and the rider who
    // chose two scooters rode one to the far end, badgeless and silent.
    //
    // Position is the whole assertion: the `return` must come before anything
    // that commits the rider. Asserting only that the branch exists would pass
    // on exactly the code that shipped the bug.
    const body = main.slice(main.indexOf("function takePlanRow("));
    const stale = body.indexOf('ledger.kind === "stale"');
    expect(stale).toBeGreaterThan(-1);
    const refusal = body.slice(stale, body.indexOf("\n  }", stale));
    expect(refusal).toContain("return;");
    // ...and the refusal itself commits nothing.
    expect(refusal).not.toContain("beginWalkToVehicle");
    expect(refusal).not.toContain("closePlanList()");
    expect(refusal).not.toContain("chosenPins.set(");
    // The walk is downstream of the return, not inside the branch.
    expect(body.indexOf("beginWalkToVehicle")).toBeGreaterThan(
      stale + refusal.length,
    );
  });

  it("tells the rider why, and puts a current list in front of them", () => {
    // A refusal that only says "no" leaves them tapping the same dead row.
    const body = main.slice(main.indexOf("function takePlanRow("));
    const stale = body.indexOf('ledger.kind === "stale"');
    const refusal = body.slice(stale, body.indexOf("\n  }", stale));
    expect(refusal).toContain("notice(STALE_HANDOFF_NOTICE)");
    expect(refusal).toContain("replanPlanList?.()");
    // And it drops the marks from the plan it just refused.
    expect(refusal).toContain("chosenPins.clear()");
  });
});

describe("the chosen scooters are marked on the map", () => {
  it("marks the first scooter and every hand-off when a plan is taken", () => {
    // A plan names two scooters and the map drew them exactly like the two
    // hundred it did not pick.
    const body = main.slice(main.indexOf("function takePlanRow("));
    const upToWalk = body.slice(0, body.indexOf("beginWalkToVehicle"));
    expect(upToWalk).toContain("chosenPins.set(");
    expect(upToWalk).toContain('kind: "first"');
    expect(upToWalk).toContain("handOffs.map(");
  });

  it("marks from the same hand-off list the ledger is built from", () => {
    // Two lists would let the map and the plan disagree about where the swap
    // is, which is the one thing the mark exists to settle.
    const body = main.slice(main.indexOf("function takePlanRow("));
    const upToWalk = body.slice(0, body.indexOf("beginWalkToVehicle"));
    // ONE declaration, two consumers: the ledger and the map.
    expect(upToWalk.match(/const handOffs/g) ?? []).toHaveLength(1);
    expect(upToWalk).toContain("handOffs,");
    expect(upToWalk).toContain("handOffs.map(");
  });

  it("zooms the hand-off preview in past the neighbourhood default", () => {
    const body = main.slice(main.indexOf("function showSwitchover("));
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toContain("zoom: SWITCHOVER_ZOOM");
    // And it marks what it flew to, so the scooter survives a pan.
    expect(fn).toContain("chosenPins.set(");
  });

  it("clears the marks when the trip does", () => {
    // A ⭐ outliving the plan is the map insisting on a trip the rider
    // cancelled, or already finished.
    expect(main.slice(main.indexOf("function clearTrip("), main.indexOf("function clearTrip(") + 900))
      .toContain("chosenPins.clear()");
  });
});
