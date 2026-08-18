// The one-shot handoff from the home bar to whichever flow the rider chose.
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPendingTrip,
  peekPendingTrip,
  setPendingTrip,
  takePendingTrip,
} from "./pending-trip.ts";

const trip = {
  dest: { label: "1500 Champa St", lat: 39.745, lon: -104.994 },
  wheels: "own" as const,
  start: null,
};

beforeEach(() => clearPendingTrip());

describe("pending trip", () => {
  it("carries the trip to the flow that picks it up", () => {
    setPendingTrip(trip);
    expect(takePendingTrip()).toEqual(trip);
  });

  it("is consumed once, so a leftover intent cannot steer a later ride", () => {
    // The failure this prevents: the rider plans a trip, backs out, and opens
    // ride mode from a device popup an hour later — to find yesterday's
    // destination already filled in.
    setPendingTrip(trip);
    expect(takePendingTrip()).toEqual(trip);
    expect(takePendingTrip()).toBeNull();
  });

  it("can be read without being consumed", () => {
    setPendingTrip(trip);
    expect(peekPendingTrip()).toEqual(trip);
    expect(peekPendingTrip()).toEqual(trip);
  });

  it("is empty until a trip is planned", () => {
    expect(takePendingTrip()).toBeNull();
  });
});
