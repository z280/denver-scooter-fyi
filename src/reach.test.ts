import { describe, expect, it } from "vitest";

import {
  DETOUR_FACTOR,
  estimatedArrivalPercent,
  RESERVE_FRACTION,
  canReach,
  estimatedRideMeters,
  straightLineMeters,
} from "./reach.ts";

// Home, and a destination almost exactly 2 km north of it.
const SCOOTER = { lat: 39.7285, lng: -105.0345 };
const DEST_2KM = { lat: 39.7285 + 2000 / 111_320, lon: -105.0345 };

describe("estimating the ride", () => {
  it("measures the straight line first", () => {
    expect(straightLineMeters(SCOOTER, DEST_2KM)).toBeCloseTo(2000, -1);
  });

  it("then assumes the road is longer than the line", () => {
    // Roads always are, and under-estimating strands somebody.
    expect(estimatedRideMeters({
      rangeMeters: 9999, scooter: SCOOTER, dest: DEST_2KM,
    })).toBeCloseTo(2000 * DETOUR_FACTOR, -1);
  });
});

describe("can it get me there", () => {
  const at = (rangeMeters: number | null | undefined) =>
    canReach({ rangeMeters, scooter: SCOOTER, dest: DEST_2KM });

  it("says yes with range to spare", () => {
    expect(at(10_000)).toBe("yes");
  });

  it("says no when the charge would not cover the road", () => {
    // 2 km line -> 2.7 km of road. A scooter with 2.5 km left cannot do it,
    // even though its range comfortably exceeds the straight line — which is
    // exactly the mistake a rider makes by eye.
    expect(at(2_500)).toBe("no");
  });

  it("KEEPS A RESERVE, so arriving on empty is not 'made it'", () => {
    const needed = 2000 * DETOUR_FACTOR;
    // Precisely enough range to arrive at zero.
    expect(at(needed)).toBe("no");
    // And enough to arrive with the reserve intact.
    expect(at(needed / (1 - RESERVE_FRACTION) + 1)).toBe("yes");
  });

  it("mirrors the backend's 10% reserve rather than inventing its own", () => {
    // Two tiers of one question must not disagree about what "made it"
    // means. A map chip saying yes where the route screen says no is worse
    // than no chip at all.
    expect(RESERVE_FRACTION).toBeCloseTo(0.10);
  });

  it("says UNKNOWN rather than no when the feed gave no range", () => {
    // A vehicle with no range figure is not a vehicle that cannot make it.
    // Filtering those out would hide working scooters on a missing field.
    expect(at(null)).toBe("unknown");
    expect(at(undefined)).toBe("unknown");
    expect(at(Number.NaN)).toBe("unknown");
  });

  it("is generous about the destination being right where you stand", () => {
    expect(canReach({
      rangeMeters: 100, scooter: SCOOTER, dest: { lat: SCOOTER.lat, lon: SCOOTER.lng },
    })).toBe("yes");
  });
});


describe("what you would arrive with", () => {
  const arrive = (rangeMeters: number | null, batteryPercent: number | null) =>
    estimatedArrivalPercent({
      rangeMeters, batteryPercent, scooter: SCOOTER, dest: DEST_2KM,
    });

  it("spends charge in proportion to range consumed", () => {
    // 2 km line -> 2.7 km of road. Against 5.4 km of range that is half the
    // vehicle's remaining reach, so about half its remaining charge.
    expect(arrive(2000 * DETOUR_FACTOR * 2, 80)).toBe(40);
  });

  it("rounds to 5 so it cannot pretend to be precise", () => {
    // A proportional estimate off an operator's own projection has no
    // business reporting single percentage points.
    const got = arrive(9_000, 73);
    expect(got).not.toBeNull();
    expect(got! % 5).toBe(0);
  });

  it("floors at zero rather than going negative", () => {
    expect(arrive(500, 20)).toBe(0);
  });

  it("declines to guess without both numbers", () => {
    expect(arrive(null, 80)).toBeNull();
    expect(arrive(5000, null)).toBeNull();
    expect(arrive(0, 80)).toBeNull();
  });
});
