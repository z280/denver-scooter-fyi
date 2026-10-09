// @vitest-environment happy-dom
//
// The measurement. What to DO about an uneven split is `route-priority.ts`'s
// question now; this file covers only the number it hands over, where the
// load-bearing parts are that it counts SECONDS and that it refuses to answer
// at all without a spec.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeviceProperties } from "./api.ts";
import type { TripLeg, TripPlan } from "./along-the-way.ts";
import { idealShare, idealShareChip } from "./ideal-share.ts";
import { defaultSpec, type RideSpec } from "./ride-spec.ts";

/** A spec that wants a Cosmo and nothing else. */
const COSMO_SPEC: RideSpec = { ...defaultSpec(), models: ["cosmo"] };

function vehicle(model: string, over: Partial<DeviceProperties> = {}): DeviceProperties {
  return {
    device_id: `d-${model}`,
    public_name: "Lunar 🐸",
    plate_suffix: "928",
    vehicle_model_name: model,
    vehicle_identifier: `v-${model}`,
    is_disabled: false,
    is_reserved: false,
    ...over,
  } as DeviceProperties;
}

function ride(seconds: number, model: string): TripLeg {
  return {
    mode: "ride",
    seconds,
    meters: seconds * 4,
    vehicle: vehicle(model),
    unlockCents: 100,
    minuteCents: 0,
    taxCents: 0,
    freeMinutesUsed: 0,
    equityArea: false,
  };
}

function walk(seconds: number): TripLeg {
  return {
    mode: "walk",
    seconds,
    meters: seconds * 1.33,
    unlockCents: 0,
    minuteCents: 0,
    taxCents: 0,
    freeMinutesUsed: 0,
    equityArea: false,
  };
}

function plan(legs: TripLeg[], cents: number): TripPlan {
  return {
    legs,
    totalSeconds: legs.reduce((s, l) => s + l.seconds, 0),
    estimatedCents: cents,
    handOffs: Math.max(0, legs.filter((l) => l.mode === "ride").length - 1),
    generalisedCost: cents,
    isEstimate: true,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("the share", () => {
  it("is null without a spec — an empty opinion is not agreement", () => {
    // A share against a sheet that requires nothing is 100% for every vehicle
    // in the city, which would tell a rider their preference was being
    // honoured when they have not expressed one.
    expect(idealShare(plan([walk(240), ride(600, "Cosmo")], 300), null)).toBeNull();
  });

  it("counts SECONDS, not legs", () => {
    // A plan with the ideal scooter on a two-minute hop and something else on
    // a nineteen-minute one has spent most of the trip on the wrong vehicle.
    // Counting legs would score that 50%.
    const p = plan([walk(240), ride(120, "Cosmo"), ride(1140, "Astro")], 500);
    const share = idealShare(p, COSMO_SPEC)!;
    expect(share).toBeCloseTo(120 / 1260, 5);
    expect(share).toBeLessThan(0.5);
  });

  it("ignores the walk, which is the same walk either way", () => {
    // Including it would dilute every plan by a constant and make a short trip
    // look more compromised than a long one.
    const withWalk = plan([walk(600), ride(600, "Cosmo")], 300);
    const without = plan([ride(600, "Cosmo")], 300);
    expect(idealShare(withWalk, COSMO_SPEC)).toBe(idealShare(without, COSMO_SPEC));
    expect(idealShare(withWalk, COSMO_SPEC)).toBe(1);
  });

  it("is null for a plan with no ride legs at all", () => {
    expect(idealShare(plan([walk(1800)], 0), COSMO_SPEC)).toBeNull();
  });

  it("is null rather than zero when no leg reported a duration", () => {
    // Zero would read as "none of it is ideal", which is a claim.
    const p = plan([ride(0, "Cosmo"), ride(0, "Astro")], 300);
    expect(idealShare(p, COSMO_SPEC)).toBeNull();
  });
});

describe("the chip", () => {
  it("says minutes, not a percentage", () => {
    // "90%" is a figure about our arithmetic; the rider's question is how long
    // they are on the good one.
    const p = plan([walk(240), ride(1140, "Cosmo"), ride(120, "Astro")], 500);
    expect(idealShareChip(p, COSMO_SPEC)).toBe("19 of 21 min on your ideal scooter");
  });

  it("says nothing when all of it or none of it is ideal", () => {
    // All of it is what a rider on a one-scooter plan already assumes, and
    // none of it is not better said by a chip announcing a disappointment.
    expect(idealShareChip(plan([ride(600, "Cosmo")], 300), COSMO_SPEC)).toBeNull();
    expect(idealShareChip(plan([ride(600, "Astro")], 300), COSMO_SPEC)).toBeNull();
    expect(idealShareChip(plan([ride(600, "Cosmo")], 300), null)).toBeNull();
  });

  it("says nothing rather than letting rounding tell a lie", () => {
    // A ten-second ideal leg in a twenty-one-minute trip rounds to "0 of 21",
    // and a split that rounds to "21 of 21" is a lie told by arithmetic.
    const p = plan([ride(10, "Cosmo"), ride(1250, "Astro")], 500);
    expect(idealShareChip(p, COSMO_SPEC)).toBeNull();
  });
});
