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
  legDestination,
  legTarget,
  legEndsAtHandOff,
  onFinalLeg,
  planLedger,
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

describe("where THIS leg actually goes", () => {
  const A = { label: "Liftoff 🍉 167", lat: 39.73, lon: -105.0 };
  const B = { label: "Perseus 🎯 619", lat: 39.75, lon: -104.97 };

  it("routes leg one to the first hand-off, not to the destination", () => {
    // The bug this exists for: a rider on leg one of a two-scooter plan was
    // navigated straight past the scooter they were meant to switch to,
    // because the wizard seeded every leg with the final destination.
    startTrip({ plannedRides: 2, dest: HOME, handOffs: [A] });
    const trip = activeTrip()!;
    expect(legDestination(trip)).toEqual(A);
    expect(legEndsAtHandOff(trip)).toBe(true);
  });

  it("advances to the next hand-off as legs land", () => {
    startTrip({ plannedRides: 3, dest: HOME, handOffs: [A, B] });
    recordLeg(leg({ rideId: "one" }));
    expect(legDestination(activeTrip()!)).toEqual(B);
    recordLeg(leg({ rideId: "two" }));
    // Out of hand-offs: the last leg goes to the destination itself.
    expect(legDestination(activeTrip()!)).toEqual(HOME);
    expect(legEndsAtHandOff(activeTrip()!)).toBe(false);
  });

  it("falls through to the destination for a trip with no hand-offs stored", () => {
    // A trip taken before the field existed, or one whose vehicles could not
    // be found on the map.
    startTrip({ plannedRides: 2, dest: HOME });
    expect(legDestination(activeTrip()!)).toEqual(HOME);
    expect(legEndsAtHandOff(activeTrip()!)).toBe(false);
  });

  it("sends an extra, re-solved hop to the destination rather than reusing a hand-off", () => {
    // Indexed by legs COMPLETED and not by the clamped `currentLeg`: a rider
    // who took three hops instead of two has already passed every hand-off the
    // original plan knew about.
    startTrip({ plannedRides: 2, dest: HOME, handOffs: [A] });
    recordLeg(leg({ rideId: "one" }));
    recordLeg(leg({ rideId: "two" }));
    expect(currentLeg(activeTrip()!)).toBe(2);
    expect(legDestination(activeTrip()!)).toEqual(HOME);
  });

  it("TRUNCATES a stored hand-off list at the first unparseable entry", () => {
    // These are positional. Skipping a bad middle entry would route leg two to
    // leg three's pickup, which is wrong in a way nobody can see; truncating
    // falls through to the destination, which is wrong in a way they can.
    localStorage.setItem(
      ACTIVE_TRIP_KEY,
      '{"v":1,"trip":{"plannedRides":3,"startedAtMs":1,"dest":' +
        '{"label":"Home","lat":39.72,"lon":-105.03},"handOffs":[' +
        '{"label":"A","lat":39.73,"lon":-105.0},{"label":"B"},' +
        '{"label":"C","lat":39.75,"lon":-104.97}]}}',
    );
    const trip = activeTrip()!;
    expect(trip.handOffs).toHaveLength(1);
    expect(legDestination(trip)).toEqual({ label: "A", lat: 39.73, lon: -105.0 });
  });
});

describe("legTarget — where the wizard is seeded", () => {
  // THE BUG THIS EXISTS FOR. The rule used to be an expression inlined at the
  // wizard's open hook, reading "if there is a PENDING trip and an active trip
  // and this leg ends at a hand-off, use the hand-off, else use the pending
  // trip's destination". It routed leg two to nowhere and leg one correctly
  // only by luck of the pending trip still being there.
  const HOME = { label: "Home", lat: 39.7285, lon: -105.0345 };
  const A = { label: "Liftoff 🍉 167", lat: 39.73, lon: -105.0 };
  const B = { label: "Perseus 🎯 619", lat: 39.75, lon: -104.97 };

  it("sends leg one to the hand-off, not the far end", () => {
    const trip = startTrip({ plannedRides: 2, dest: HOME, handOffs: [A] })!;
    expect(legTarget(trip, HOME)).toEqual(A);
  });

  it("sends the LAST leg to the destination", () => {
    startTrip({ plannedRides: 2, dest: HOME, handOffs: [A] });
    recordLeg({ rideId: "r1", costCents: 1, meters: 1, seconds: 1, endedAtMs: 1 });
    expect(legTarget(activeTrip(), HOME)).toEqual(HOME);
  });

  it("still answers on leg two when the pending trip is long gone", () => {
    // `takePendingTrip` is a one-shot, consumed opening the wizard for leg
    // one. The old expression skipped its whole branch here and dispatched no
    // destination at all — the leg ran with whatever the doc carried.
    startTrip({ plannedRides: 2, dest: HOME, handOffs: [A] });
    recordLeg({ rideId: "r1", costCents: 1, meters: 1, seconds: 1, endedAtMs: 1 });
    expect(legTarget(activeTrip(), null)).toEqual(HOME);
  });

  it("walks a three-scooter plan hand-off by hand-off", () => {
    startTrip({ plannedRides: 3, dest: HOME, handOffs: [A, B] });
    expect(legTarget(activeTrip(), null)).toEqual(A);
    recordLeg({ rideId: "r1", costCents: 1, meters: 1, seconds: 1, endedAtMs: 1 });
    expect(legTarget(activeTrip(), null)).toEqual(B);
    recordLeg({ rideId: "r2", costCents: 1, meters: 1, seconds: 1, endedAtMs: 1 });
    expect(legTarget(activeTrip(), null)).toEqual(HOME);
  });

  it("prefers the trip's own destination over the fallback", () => {
    // The ledger is the store that knows. The pending trip is a seed for the
    // case where no ledger exists, not a second opinion.
    startTrip({ plannedRides: 2, dest: HOME, handOffs: [A] });
    recordLeg({ rideId: "r1", costCents: 1, meters: 1, seconds: 1, endedAtMs: 1 });
    expect(legTarget(activeTrip(), { label: "Wrong", lat: 1, lon: 2 })).toEqual(HOME);
  });

  it("uses the fallback for an ordinary one-scooter ride", () => {
    expect(legTarget(null, HOME)).toEqual(HOME);
  });

  it("is null when nothing anywhere knows — a free ride", () => {
    expect(legTarget(null, null)).toBeNull();
  });

  it("falls back when a trip was recorded with no destination at all", () => {
    const trip = startTrip({ plannedRides: 2, dest: null, handOffs: [] })!;
    expect(legTarget(trip, HOME)).toEqual(HOME);
  });
});

// ---------------------------------------------------------------------------
// planLedger — single, stale, or a trip
// ---------------------------------------------------------------------------
describe("planLedger", () => {
  interface V {
    id: string;
  }
  /** Everything is findable except the ids named here. */
  const placer =
    (missing: string[] = []) =>
    (v: V) =>
      missing.includes(v.id)
        ? null
        : { label: v.id, lat: 39.7 + Number(v.id.slice(1)) / 1000, lon: -105 };

  it("calls a one-ride plan single, with no hand-offs to find", () => {
    expect(planLedger([{ id: "v1" }], placer())).toEqual({ kind: "single" });
  });

  it("calls a walk-only plan single rather than stale", () => {
    // No rides at all is not a plan that lost anything.
    expect(planLedger([], placer())).toEqual({ kind: "single" });
  });

  it("records a trip for every hand-off it can place", () => {
    const l = planLedger([{ id: "v1" }, { id: "v2" }, { id: "v3" }], placer());
    expect(l.kind).toBe("trip");
    // Leg one's pickup is the walk, so it is NOT a hand-off: two rides after
    // the first, two hand-offs.
    expect(l.kind === "trip" && l.handOffs.map((h) => h.label)).toEqual([
      "v2",
      "v3",
    ]);
  });

  // THE REGRESSION. A two-scooter plan whose second scooter has gone is not a
  // one-scooter ride: the rider chose the split for a reason. Calling it
  // `single` walked them to the first vehicle with no ledger behind them, and
  // `legTarget` then handed back the final destination.
  it("calls a two-ride plan stale when its hand-off cannot be placed", () => {
    expect(planLedger([{ id: "v1" }, { id: "v2" }], placer(["v2"]))).toEqual({
      kind: "stale",
    });
  });

  it("is never single for a multi-ride plan, however much it lost", () => {
    // The distinction the bug collapsed: "you only need one scooter" and "the
    // second scooter you were promised is gone" are different sentences.
    for (const missing of [["v2"], ["v2", "v3"]]) {
      const l = planLedger([{ id: "v1" }, { id: "v2" }, { id: "v3" }], placer(missing));
      expect(l.kind).not.toBe("single");
    }
  });

  it("stops at the first hand-off it cannot place, and keeps the ones before", () => {
    // Hand-offs are POSITIONAL — hand-off i is where leg i+1 begins — so
    // closing the gap would route leg two to leg three's pickup. Truncating
    // leaves a shorter trip that is true as far as it goes; the next leg
    // re-solves from wherever the rider actually is.
    const l = planLedger(
      [{ id: "v1" }, { id: "v2" }, { id: "v3" }, { id: "v4" }],
      placer(["v3"]),
    );
    expect(l.kind === "trip" && l.handOffs.map((h) => h.label)).toEqual(["v2"]);
  });

  it("treats a leg with no vehicle at all as the same kind of gap", () => {
    expect(planLedger([{ id: "v1" }, null], placer())).toEqual({ kind: "stale" });
  });

  it("never asks where the first vehicle is", () => {
    // That one the rider walks to; `takePlanRow` looks it up separately. A
    // `place` call for it would be a second lookup and a chance to disagree.
    const asked: string[] = [];
    planLedger([{ id: "v1" }, { id: "v2" }], (v: V) => {
      asked.push(v.id);
      return { label: v.id, lat: 39.7, lon: -105 };
    });
    expect(asked).toEqual(["v2"]);
  });
});
