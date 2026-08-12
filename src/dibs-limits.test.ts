// @vitest-environment happy-dom
//
// How many scooters one person can hold, and when holding several is
// legitimate. Dibs costs nothing to call, which is exactly why it needs a
// ceiling: without one the cheapest strategy is to claim everything you can
// see and sort it out later.
import { beforeEach, describe, expect, it } from "vitest";

import {
  DIBS_GROUP_METERS,
  DIBS_MAX_CONCURRENT,
  callDibs,
  canCallDibs,
  metersBetween,
} from "./dibs.ts";

const AT = { lat: 39.7392, lon: -104.9903 };
/** ~90 m away — a rack, a plaza, the same block of parked scooters. */
const NEARBY = { lat: 39.7400, lon: -104.9903 };
/** ~1.1 km away — a different part of town. */
const ACROSS_TOWN = { lat: 39.7492, lon: -104.9903 };

function claim(id: string, at: { lat: number; lon: number }, now = Date.now()) {
  return callDibs(
    {
      vehicleIdentifier: id,
      vehicleName: `Scooter ${id}`,
      plate: null,
      claimedBy: "Resourceful 🌈",
      startMeters: 200,
      lat: at.lat,
      lon: at.lon,
    },
    now,
  );
}

beforeEach(() => localStorage.clear());

describe("the first claim", () => {
  it("is never in anybody's way", () => {
    expect(canCallDibs(AT).kind).toBe("ok");
  });
});

describe("a cluster is fine", () => {
  it("allows a second claim on a scooter beside the first", () => {
    // Three people walking to the same rack together is the one legitimate
    // reason to hold more than one.
    claim("a", AT);
    expect(metersBetween(AT, NEARBY)).toBeLessThan(DIBS_GROUP_METERS);
    expect(canCallDibs(NEARBY).kind).toBe("ok");
  });
});

describe("a spread is a question, not a refusal", () => {
  it("asks when the new one is nowhere near what they hold", () => {
    // Only the rider knows whether they are hedging across the city or
    // grabbing a few for a group.
    claim("a", AT);
    const v = canCallDibs(ACROSS_TOWN);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") {
      expect(v.held).toHaveLength(1);
      expect(v.nearest).toBeGreaterThan(DIBS_GROUP_METERS);
    }
  });

  it("names what they are already holding, so the question is answerable", () => {
    claim("a", AT);
    const v = canCallDibs(ACROSS_TOWN);
    if (v.kind === "ask") expect(v.held[0].vehicleName).toBe("Scooter a");
  });
});

describe("three is the ceiling, under any circumstances", () => {
  it("refuses a fourth even when they are all together", () => {
    // Not a question this time: the limit is absolute, so asking would imply
    // an answer that gets them past it.
    claim("a", AT);
    claim("b", { lat: AT.lat + 0.0002, lon: AT.lon });
    claim("c", { lat: AT.lat + 0.0004, lon: AT.lon });
    const v = canCallDibs({ lat: AT.lat + 0.0006, lon: AT.lon });
    expect(v.kind).toBe("at_limit");
    if (v.kind === "at_limit") expect(v.held).toHaveLength(DIBS_MAX_CONCURRENT);
  });

  it("is three", () => {
    expect(DIBS_MAX_CONCURRENT).toBe(3);
  });
});

describe("claiming the same one twice", () => {
  it("is recognised rather than treated as a second claim", () => {
    claim("a", AT);
    expect(canCallDibs(AT).kind).toBe("already");
  });
});

describe("distance", () => {
  it("measures in metres", () => {
    // ~89 m: one block.
    expect(Math.round(metersBetween(AT, NEARBY))).toBeGreaterThan(80);
    expect(Math.round(metersBetween(AT, NEARBY))).toBeLessThan(100);
  });
});
