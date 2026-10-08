// @vitest-environment happy-dom
//
// Two Passengers. The assertion that matters most is the one about the FIRST
// leg: the planner deliberately exempts the starter vehicle from the spec, and
// that exemption — right for every preference it was built for — would put two
// people on a one-seater.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TWO_PASSENGER_FIELDS,
  TWO_PASSENGER_KEY,
  TWO_PASSENGER_MIN_BATTERY,
  TWO_PASSENGER_MODELS,
  applyTwoPassengers,
  conflictsWithSpec,
  setTwoPassengers,
  twoPassengerNote,
  twoPassengers,
} from "./passenger-mode.ts";
import { defaultSpec, everyLegFields, hardenEveryLeg, type RideSpec } from "./ride-spec.ts";

const spec = (over: Partial<RideSpec> = {}): RideSpec => ({ ...defaultSpec(), ...over });

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("the stored flag", () => {
  it("is off until it is turned on, and off again after", () => {
    expect(twoPassengers()).toBe(false);
    expect(setTwoPassengers(true)).toBe(true);
    expect(twoPassengers()).toBe(true);
    setTwoPassengers(false);
    expect(twoPassengers()).toBe(false);
  });

  it("treats anything it did not write as off", () => {
    for (const raw of ["", "0", "true", "yes"]) {
      localStorage.setItem(TWO_PASSENGER_KEY, raw);
      expect(twoPassengers()).toBe(false);
    }
  });
});

describe("folding it into a spec", () => {
  it("does nothing at all when off", () => {
    const base = spec({ minBattery: 5 });
    expect(applyTwoPassengers(base, false)).toBe(base);
  });

  it("demands the one model the catalogue says carries two", () => {
    const out = applyTwoPassengers(spec(), true);
    expect(out.models).toEqual([...TWO_PASSENGER_MODELS]);
    expect(out.minBattery).toBe(TWO_PASSENGER_MIN_BATTERY);
    expect(out.minQuality).toBe("no-risk");
  });

  it("makes all three HARD and binding on every leg", () => {
    // Hard alone is not enough: `must` stops the relaxation ladder giving a
    // requirement away, but the planner's starter spec drops the whole sheet
    // regardless. `everyLeg` is what survives that.
    const out = applyTwoPassengers(spec(), true);
    for (const field of TWO_PASSENGER_FIELDS) {
      expect(out.must, field).toContain(field);
      expect(everyLegFields(out), field).toContain(field);
    }
  });

  it("INTERSECTS the rider's models rather than replacing them", () => {
    // Somebody who said "Apollos and Cosmos" and then "two of us" gets
    // Apollos. Replacing would ignore what they just asked for; an empty list
    // would be a different bug.
    const out = applyTwoPassengers(spec({ models: ["apollo", "cosmo"] }), true);
    expect(out.models).toEqual(["apollo"]);
  });

  it("is a floor under the rider's preferences, never a ceiling", () => {
    // A rider who wanted 60% and two seats wanted 60%.
    const strict = applyTwoPassengers(
      spec({ minBattery: 60, minQuality: "ok-only" }),
      true,
    );
    expect(strict.minBattery).toBe(60);
    expect(strict.minQuality).toBe("ok-only");
  });

  it("keeps an impossible intersection rather than quietly dropping one side", () => {
    // A rider whose spec excludes the Apollo and who asks for two passengers
    // has asked for something nothing satisfies. Dropping either requirement
    // would hand them a vehicle that fails one they stated, and whichever we
    // dropped would be the wrong one.
    const out = applyTwoPassengers(spec({ models: ["cosmo", "astro"] }), true);
    expect(out.models).toEqual([]);
  });

  it("leaves everything it does not mention alone", () => {
    const out = applyTwoPassengers(spec({ features: ["bell"], maxWalkMinutes: 5 }), true);
    expect(out.features).toEqual(["bell"]);
    expect(out.maxWalkMinutes).toBe(5);
  });
});

describe("the conflict", () => {
  it("is only a conflict when the rider named models and left the Apollo out", () => {
    expect(conflictsWithSpec(spec({ models: ["cosmo"] }), true)).toBe(true);
    expect(conflictsWithSpec(spec({ models: ["cosmo", "apollo"] }), true)).toBe(false);
    // `null` means any model — nothing to contradict.
    expect(conflictsWithSpec(spec(), true)).toBe(false);
    expect(conflictsWithSpec(spec({ models: ["cosmo"] }), false)).toBe(false);
  });

  it("says so, instead of leaving them to read an empty list", () => {
    // "No scooter nearby matches" is the message for a fleet that happens to
    // be unhelpful today. This is two requirements that cannot both hold, and
    // no amount of waiting or walking fixes it.
    setTwoPassengers(true);
    const note = twoPassengerNote(spec({ models: ["cosmo"] }))!;
    expect(note).toMatch(/nothing can match both/i);
    expect(note).toMatch(/change one of the two/i);
  });
});

describe("what the rider is told while it is on", () => {
  it("names all three requirements, and that they bind the first leg", () => {
    // The battery floor and the quality tier are a judgement rather than a
    // fact about the vehicle, so they should be visible enough to argue with.
    setTwoPassengers(true);
    const note = twoPassengerNote(spec())!;
    expect(note).toContain("Apollos only");
    expect(note).toContain(`${TWO_PASSENGER_MIN_BATTERY}%`);
    expect(note).toMatch(/high-risk/);
    expect(note).toMatch(/including the first/i);
  });

  it("says nothing when it is off", () => {
    expect(twoPassengerNote(spec(), false)).toBeNull();
  });
});

describe("everyLegFields, the contract underneath", () => {
  it("refuses a field that binds every leg but is not hard", () => {
    // A requirement that binds the starter yet can be relaxed away is a
    // contradiction. A stored blob carrying one must not produce it.
    const incoherent: RideSpec = { ...defaultSpec(), everyLeg: ["models"], must: [] };
    expect(everyLegFields(incoherent)).toEqual([]);
  });

  it("reads a spec written before the field existed as having none", () => {
    const old: RideSpec = { ...defaultSpec(), must: ["models"] };
    expect(everyLegFields(old)).toEqual([]);
  });

  it("merges rather than replacing, and sets both lists together", () => {
    const out = hardenEveryLeg(spec({ must: ["features"] }), ["models"]);
    expect(new Set(out.must)).toEqual(new Set(["features", "models"]));
    expect(everyLegFields(out)).toEqual(["models"]);
  });
});
