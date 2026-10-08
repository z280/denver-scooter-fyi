// The dibs SMS watch is REACHED. Source-level, in the same spirit as
// `plan-list-wired.test.ts` and for the same reason: the facts asserted are
// themselves source-level facts, and each of them was once false.
//
// Three links, each of which silently disables the feature on its own:
//
//   1. the claim has to reach the SERVER. `callDibs` writes the phone's copy;
//      the watch reads the row. Auto-dibs shipped without the registration
//      call, so every claim made by starting a walk was one only that phone
//      believed in — no certificate timestamp, no dimmed map for anybody
//      else, and nothing to watch.
//   2. the opt-in has to travel WITH the claim, because that is what the
//      server stores (sql/097). A claim registered without it is never
//      watched, whatever the switch says.
//   3. "I've got it" has to be sent, or the first thing the feature does for
//      a rider is text them about their own rental.
import { describe, it, expect } from "vitest";

import { readSource, withoutComments } from "../tests/helpers/source-text.ts";

const main = readSource("src/main.ts");
const devices = readSource("src/devices.ts");

/** `beginWalkToVehicle`'s body.
 *
 *  NOT `functionBody`, which cannot reach it: that helper closes on the first
 *  brace at the declaration's own indentation, and this function's parameter
 *  is a multi-line object type whose closing `}` sits in column zero. It
 *  therefore returns the signature and nothing else — 141 characters, in
 *  which a `toContain` fails and, worse, a `not.toContain` passes while
 *  asserting nothing at all. Found by writing both and noticing the second
 *  could not fail.
 *
 *  So: from the declaration to the next top-level declaration. */
function walkFunnel(): string {
  const from = main.indexOf("\nfunction beginWalkToVehicle(info: {");
  expect(from).toBeGreaterThan(-1);
  const rest = main.slice(from + 1);
  const next = rest.indexOf("\nfunction ", 1);
  const body = withoutComments(next === -1 ? rest : rest.slice(0, next));
  // The slice has to be the real thing, or every assertion below is decided
  // by the helper rather than by the code.
  expect(body).toContain("createArrivalPanel");
  expect(body).toContain("onCancel:");
  return body;
}

describe("a claim reaches the server", () => {
  it("registers the claim the walk makes, not just the popup's", () => {
    const body = walkFunnel();
    expect(body).toContain("registerDibs(");
    // Guarded, because `callDibs` is idempotent on the vehicle identifier:
    // the popup may have registered this very claim a moment ago, and a
    // second insert would be a second certificate for one claim.
    expect(body).toContain("claim.registration === null");
  });

  it("carries the rider's SMS answer on every registration", () => {
    for (const [name, src] of [
      ["main.ts", withoutComments(main)],
      ["devices.ts", withoutComments(devices)],
    ] as const) {
      const call = src.slice(src.indexOf("registerDibs({"));
      expect(call.slice(0, 700), name).toContain("notify_sms: dibsSmsAlerts()");
    }
  });
});

describe("the claimant's own rental is not reported as a theft", () => {
  it("says 'mine' when the rider commits to the scooter they walked to", () => {
    // The server's alert fires on "a rental started on this vehicle" — all
    // the fleet feed says. Without this call the commonest path in the app
    // texts the rider to say somebody took their scooter.
    const body = walkFunnel();
    const route = body.slice(body.indexOf("onChooseRoute:"));
    expect(route.slice(0, 900)).toContain("claimDibsAsMine(");
  });

  it("does not release the claim to do it", () => {
    // The claim is still what the certificate rests on, and still dims the
    // scooter for everybody else until it expires. Reusing `releaseDibs`
    // here would trade one wrong text for a claim the rider silently lost.
    const body = walkFunnel();
    const route = body.slice(body.indexOf("onChooseRoute:"));
    const upToNext = route.slice(0, route.indexOf("onCancel:"));
    expect(upToNext).not.toContain("releaseDibs");
    expect(upToNext).not.toContain("dropDibs");
  });
});
