// @vitest-environment happy-dom
//
// §11.9's ledger. Most of what is asserted here is about NOT lying: a badge
// that never reads "leg 4 of 3", a total that admits when it is a floor, and a
// leg that cannot be counted twice because Screen 8 rendered twice.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_TRIP_KEY,
  activeTrip,
  currentLeg,
  endTrip,
  legBadge,
  onFinalLeg,
  recordLeg,
  startTrip,
  tripComplete,
  tripTotals,
  type TripLegRecord,
} from "./trip-legs.ts";

const HOME = { label: "Home", lat: 39.7285, lon: -105.0345 };
const WORK = { label: "Work", lat: 39.7392, lon: -104.9903 };

function leg(over: Partial<TripLegRecord> = {}): TripLegRecord {
  return {
    rideId: "ride-1",
    costCents: 420,
    meters: 1_600,
    seconds: 600,
    endedAtMs: 1_000,
    ...over,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("starting a trip", () => {
  it("starts one for a plan with a hand-off", () => {
    const trip = startTrip({ plannedRides: 2, dest: HOME });
    expect(trip?.plannedRides).toBe(2);
    expect(activeTrip()?.dest).toEqual(HOME);
  });

  it("refuses a single-ride plan — 'leg 1 of 1' is chrome", () => {
    expect(startTrip({ plannedRides: 1 })).toBeNull();
    expect(activeTrip()).toBeNull();
  });

  it("refuses a nonsense count rather than storing one", () => {
    for (const plannedRides of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(startTrip({ plannedRides })).toBeNull();
      expect(activeTrip()).toBeNull();
    }
  });

  it("replaces a trip already in progress", () => {
    startTrip({ plannedRides: 2, dest: HOME });
    recordLeg(leg());
    startTrip({ plannedRides: 3, dest: WORK });
    const trip = activeTrip()!;
    expect(trip.plannedRides).toBe(3);
    expect(trip.dest).toEqual(WORK);
    // And the old trip's leg is gone with it, not inherited.
    expect(trip.completed).toEqual([]);
  });
});

describe("recording legs", () => {
  it("does nothing at all when there is no trip — most rides are one ride", () => {
    expect(recordLeg(leg())).toBeNull();
    expect(activeTrip()).toBeNull();
  });

  it("counts a leg once however often Screen 8 renders", () => {
    startTrip({ plannedRides: 3 });
    recordLeg(leg({ rideId: "ride-A" }));
    recordLeg(leg({ rideId: "ride-A" }));
    recordLeg(leg({ rideId: "ride-A", costCents: 999 }));
    expect(activeTrip()?.completed).toHaveLength(1);
    expect(tripTotals(activeTrip()!).costCents).toBe(420);
  });

  it("appends an id-less private leg, which has nothing to double-count against", () => {
    startTrip({ plannedRides: 2 });
    recordLeg(leg({ rideId: null }));
    recordLeg(leg({ rideId: null }));
    expect(activeTrip()?.completed).toHaveLength(2);
  });
});

describe("totals", () => {
  it("sums the legs that are done and not the one in progress", () => {
    startTrip({ plannedRides: 3 });
    recordLeg(leg({ rideId: "a", costCents: 300, meters: 1_000, seconds: 300 }));
    recordLeg(leg({ rideId: "b", costCents: 450, meters: 2_000, seconds: 500 }));
    const t = tripTotals(activeTrip()!);
    expect(t).toMatchObject({
      legsDone: 2,
      plannedRides: 3,
      costCents: 750,
      meters: 3_000,
      seconds: 800,
      partial: false,
    });
  });

  it("flags a total built over a leg with a figure missing", () => {
    // An own-device leg has no cost; a leg whose GPS never resolved has no
    // distance. The total is then a floor, and saying so is the difference
    // between a figure that is trusted and one that is noticed once.
    startTrip({ plannedRides: 2 });
    recordLeg(leg({ rideId: "a", costCents: null }));
    const t = tripTotals(activeTrip()!);
    expect(t.partial).toBe(true);
    // Null reads as "unknown", never as zero added confidently to a sum.
    expect(t.costCents).toBe(0);
    expect(t.meters).toBe(1_600);
  });
});

describe("which leg is this", () => {
  it("counts from one and advances as legs land", () => {
    startTrip({ plannedRides: 3 });
    expect(legBadge(activeTrip()!)).toBe("Leg 1 of 3");
    recordLeg(leg({ rideId: "a" }));
    expect(legBadge(activeTrip()!)).toBe("Leg 2 of 3");
    recordLeg(leg({ rideId: "b" }));
    expect(legBadge(activeTrip()!)).toBe("Leg 3 of 3");
  });

  it("NEVER reads past the plan when the rider re-solved mid-trip", () => {
    // The fleet moves. A rider whose second vehicle was gone may take two
    // shorter hops instead of one, and "leg 4 of 3" is the badge announcing
    // our arithmetic rather than their trip.
    startTrip({ plannedRides: 2 });
    recordLeg(leg({ rideId: "a" }));
    recordLeg(leg({ rideId: "b" }));
    recordLeg(leg({ rideId: "c" }));
    expect(currentLeg(activeTrip()!)).toBe(2);
    expect(legBadge(activeTrip()!)).toBe("Leg 2 of 2");
  });

  it("knows the last leg, and when every leg is done", () => {
    startTrip({ plannedRides: 2 });
    expect(onFinalLeg(activeTrip()!)).toBe(false);
    expect(tripComplete(activeTrip()!)).toBe(false);
    recordLeg(leg({ rideId: "a" }));
    expect(onFinalLeg(activeTrip()!)).toBe(true);
    expect(tripComplete(activeTrip()!)).toBe(false);
    recordLeg(leg({ rideId: "b" }));
    expect(tripComplete(activeTrip()!)).toBe(true);
  });
});

describe("a stored blob is never trusted", () => {
  const put = (raw: string): void => localStorage.setItem(ACTIVE_TRIP_KEY, raw);

  it("reads garbage, a wrong version and a wrong shape all as no trip", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"v":99,"trip":{"plannedRides":2,"startedAtMs":1}}',
      '{"v":1,"trip":{"plannedRides":"two","startedAtMs":1}}',
      '{"v":1,"trip":{"plannedRides":2}}',
      // The invariant `startTrip` enforces, enforced again on the way in: a
      // hand-edited blob must not reach a state the writer refuses to create.
      '{"v":1,"trip":{"plannedRides":1,"startedAtMs":1}}',
    ]) {
      put(raw);
      expect(activeTrip()).toBeNull();
    }
  });

  it("drops a malformed leg rather than the whole trip", () => {
    put(
      '{"v":1,"trip":{"id":"t","plannedRides":3,"startedAtMs":1,"completed":' +
        '[{"endedAtMs":5,"costCents":100},{"costCents":200},"nope",null]}}',
    );
    const trip = activeTrip()!;
    expect(trip.completed).toHaveLength(1);
    // The surviving leg keeps what it had and nulls what it did not.
    expect(trip.completed[0]).toMatchObject({ costCents: 100, meters: null });
  });

  it("forgets the trip on request", () => {
    startTrip({ plannedRides: 2 });
    endTrip();
    expect(activeTrip()).toBeNull();
  });
});

describe("the destination the rest of the way is solved against", () => {
  it("keeps coordinates, not just a name", () => {
    startTrip({ plannedRides: 2, dest: HOME });
    expect(activeTrip()?.dest).toEqual(HOME);
  });

  it("drops a stored destination that has no coordinates to solve against", () => {
    localStorage.setItem(
      ACTIVE_TRIP_KEY,
      '{"v":1,"trip":{"plannedRides":2,"startedAtMs":1,"dest":{"label":"Home"}}}',
    );
    const trip = activeTrip()!;
    expect(trip.plannedRides).toBe(2);
    expect(trip.dest).toBeNull();
  });

  it("tolerates a destination with no name", () => {
    localStorage.setItem(
      ACTIVE_TRIP_KEY,
      '{"v":1,"trip":{"plannedRides":2,"startedAtMs":1,"dest":{"lat":39.7,"lon":-104.9}}}',
    );
    expect(activeTrip()?.dest).toEqual({ label: "", lat: 39.7, lon: -104.9 });
  });
});
