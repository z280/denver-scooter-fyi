import { describe, it, expect } from "vitest";
import type { RideSessionDoc } from "./ride-session.ts";
import {
  hasAnswers,
  isLiveIntent,
  rideButtonCopy,
  rideButtonIntent,
} from "./ride-reentry.ts";

/** A session doc with only the fields this decision reads. The module takes a
 *  whole `RideSessionDoc`, so the cast is the fixture's shortcut, not a
 *  loosening of the function under test. */
function doc(over: Partial<RideSessionDoc>): RideSessionDoc {
  return {
    state: "idle",
    screen: "1",
    device: null,
    dest: null,
    route: null,
    rideId: null,
    startedAtMs: null,
    ...over,
  } as RideSessionDoc;
}

describe("rideButtonIntent", () => {
  it("starts a free ride when nothing is in flight", () => {
    expect(rideButtonIntent(null)).toEqual({ kind: "start_free" });
    expect(rideButtonIntent(doc({}))).toEqual({ kind: "start_free" });
  });

  it("offers the way back into a RUNNING ride", () => {
    // The seam. BRB left the clock anchored and the recording going; this is
    // the only thing on the map that can say so.
    expect(rideButtonIntent(doc({ state: "riding", rideId: "r1" }))).toEqual({
      kind: "return_to_ride",
    });
    expect(rideButtonIntent(doc({ state: "countdown" }))).toEqual({
      kind: "return_to_ride",
    });
  });

  it("treats the S8 New Destination loop as a live ride, not a setup", () => {
    // `newDestination` lands on wizard:3 KEEPING the ride id, which is live by
    // `isRideLive`. Reading it as "resume the setup" would build a wizard over
    // a running ride — the bug `beforeOpen` carries a paragraph about.
    const loop = doc({ state: "wizard", screen: "3", rideId: "r1" });
    expect(rideButtonIntent(loop)).toEqual({ kind: "return_to_ride" });
  });

  it("sends a rider back to post-ride screens they still owe", () => {
    for (const state of ["ending", "survey", "eligibility"] as const) {
      expect(rideButtonIntent(doc({ state, startedAtMs: 1 }))).toEqual({
        kind: "finish_ride",
      });
    }
  });

  it("reopens a setup that has answers in it", () => {
    expect(
      rideButtonIntent(doc({ state: "wizard", screen: "2", dest: {} as never })),
    ).toEqual({ kind: "resume_setup" });
  });

  it("does NOT reopen a finished ride's wizard", () => {
    // `done` and `idle` keep their device and `startedAtMs` as the record of
    // the ride that just happened. Answering on the fields alone made every
    // tap after the first reopen the LAST ride's wizard.
    for (const state of ["done", "idle"] as const) {
      const finished = doc({ state, rideId: "r1", startedAtMs: 1 });
      expect(rideButtonIntent(finished)).toEqual({ kind: "start_free" });
    }
  });

  it("checks live before answers, because a live doc satisfies both", () => {
    // Order is the whole correctness argument of this function.
    const live = doc({ state: "riding", rideId: "r1", startedAtMs: 1, dest: {} as never });
    expect(hasAnswers(live)).toBe(true); // it would also match the later branch
    expect(rideButtonIntent(live).kind).toBe("return_to_ride");
  });
});

describe("what the button says", () => {
  it("never claims to start a free ride while one is running", () => {
    // The actual bug: the control took you back to your ride and read
    // "start recording a free ride" the whole time.
    const live = rideButtonIntent(doc({ state: "riding", rideId: "r1" }));
    const copy = rideButtonCopy(live);
    expect(copy.title).not.toMatch(/free/i);
    expect(copy.ariaLabel).not.toMatch(/free/i);
    expect(copy.ariaLabel).toMatch(/still running/i);
  });

  it("gives every intent its own words", () => {
    // Two intents sharing a label is the old bug in a smaller form.
    const intents = [
      { kind: "start_free" },
      { kind: "resume_setup" },
      { kind: "return_to_ride" },
      { kind: "finish_ride" },
    ] as const;
    const titles = intents.map((i) => rideButtonCopy(i).title);
    expect(new Set(titles).size).toBe(intents.length);
    const labels = intents.map((i) => rideButtonCopy(i).ariaLabel);
    expect(new Set(labels).size).toBe(intents.length);
  });

  it("carries the fact in the ACCESSIBLE NAME, not only the lit state", () => {
    // A screen-reader user gets no colour, no glyph and no map to infer from.
    for (const i of [{ kind: "return_to_ride" }, { kind: "finish_ride" }] as const) {
      expect(rideButtonCopy(i).ariaLabel.length).toBeGreaterThan(
        rideButtonCopy(i).title.length,
      );
    }
  });

  it("lights up for exactly the two in-flight-ride intents", () => {
    expect(isLiveIntent({ kind: "return_to_ride" })).toBe(true);
    expect(isLiveIntent({ kind: "finish_ride" })).toBe(true);
    // A setup with answers is not a ride in progress — no clock, no watcher,
    // no recording — so it does not get the live dot.
    expect(isLiveIntent({ kind: "resume_setup" })).toBe(false);
    expect(isLiveIntent({ kind: "start_free" })).toBe(false);
  });
});
