// @vitest-environment happy-dom
//
// The split preference. Two things are load-bearing and both are about
// restraint: it never filters, and it never outranks a price difference a
// rider would notice.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeviceProperties } from "./api.ts";
import type { TripLeg, TripPlan } from "./along-the-way.ts";
import {
  DEFAULT_IDEAL_SPLIT,
  IDEAL_SPLIT_KEY,
  IDEAL_SPLIT_OPTIONS,
  TIE_CENTS,
  idealShare,
  idealShareChip,
  idealSplit,
  idealSplitNote,
  reorderForIdealShare,
  setIdealSplit,
} from "./ideal-share.ts";
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

describe("the preference", () => {
  it("defaults to more of the ideal device", () => {
    expect(idealSplit()).toBe(DEFAULT_IDEAL_SPLIT);
    expect(DEFAULT_IDEAL_SPLIT).toBe("prefer_ideal");
  });

  it("round-trips both answers and ignores anything else", () => {
    for (const option of IDEAL_SPLIT_OPTIONS) {
      expect(setIdealSplit(option.value)).toBe(true);
      expect(idealSplit()).toBe(option.value);
    }
    localStorage.setItem(IDEAL_SPLIT_KEY, "whatever");
    expect(idealSplit()).toBe(DEFAULT_IDEAL_SPLIT);
  });
});

describe("the reordering", () => {
  const row = (cents: number, share: number | null, id: string) => ({
    id,
    plan: plan([ride(600, "Cosmo")], cents),
    idealShare: share,
  });

  it("does nothing at all under 'cheapest first'", () => {
    const rows = [row(500, 0.1, "a"), row(500, 0.9, "b")];
    const out = reorderForIdealShare(rows, "cheapest");
    expect(out.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out.moved).toBe(false);
  });

  it("promotes the ideal-heavy plan when the prices are near enough the same", () => {
    const out = reorderForIdealShare(
      [row(500, 0.1, "cheap-but-wrong"), row(500 + TIE_CENTS, 0.9, "ideal")],
      "prefer_ideal",
    );
    expect(out.rows.map((r) => r.id)).toEqual(["ideal", "cheap-but-wrong"]);
    expect(out.moved).toBe(true);
  });

  it("LETS COST WIN once the difference is one a rider would notice", () => {
    // The tolerance is a tie-breaker, not an override. Beyond it, reordering
    // would be the app quietly spending somebody's money on its own idea of
    // comfort.
    const out = reorderForIdealShare(
      [row(500, 0.1, "cheap"), row(500 + TIE_CENTS + 1, 1, "ideal-but-dearer")],
      "prefer_ideal",
    );
    expect(out.rows.map((r) => r.id)).toEqual(["cheap", "ideal-but-dearer"]);
    expect(out.moved).toBe(false);
  });

  it("anchors the tolerance on the CHEAPEST plan, not on the first row", () => {
    // Comparing each plan only with its neighbour would let a chain of 49¢
    // steps carry a plan a long way up the list for a difference the rider
    // would certainly notice. The fixture deliberately puts the cheapest plan
    // SECOND: anchoring on `rows[0]` passes an already-sorted list by
    // accident, which is how this rule got written without a test that could
    // fail.
    const out = reorderForIdealShare(
      [
        row(500 + TIE_CENTS, 0.2, "near"),
        row(500, 0.1, "cheapest"),
        row(500 + TIE_CENTS * 2, 1, "far-but-ideal"),
      ],
      "prefer_ideal",
    );
    // `far-but-ideal` is 100¢ over the cheapest, outside the tolerance, so it
    // sorts on price and lands LAST however ideal it is. Anchored on the first
    // row instead it would have been only 50¢ over, tied, and promoted to the
    // top on its perfect share — which is the bug this fixture exists to
    // catch.
    expect(out.rows[2].id).toBe("far-but-ideal");
    // And the two that ARE tied order by share, which is the preference doing
    // exactly its job: 550¢/0.2 ahead of 500¢/0.1, because fifty cents is
    // inside the tolerance and the split is the only thing left to choose on.
    expect(out.rows.map((r) => r.id)).toEqual(["near", "cheapest", "far-but-ideal"]);
  });

  it("never drops a plan", () => {
    const rows = [row(500, 0.1, "a"), row(900, 1, "b"), row(505, null, "c")];
    const out = reorderForIdealShare(rows, "prefer_ideal");
    expect(out.rows).toHaveLength(3);
    expect(new Set(out.rows.map((r) => r.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("keeps the planner's order where it has no opinion", () => {
    const rows = [row(500, 0.5, "first"), row(500, 0.5, "second")];
    const out = reorderForIdealShare(rows, "prefer_ideal");
    expect(out.rows.map((r) => r.id)).toEqual(["first", "second"]);
    expect(out.moved).toBe(false);
  });

  it("never promotes a shareless plan over one with a share", () => {
    // The walk-only plan has no ride legs and so no share. It must not rise on
    // a preference about scooters.
    const out = reorderForIdealShare(
      [row(500, null, "walk"), row(500, 0.9, "ideal")],
      "prefer_ideal",
    );
    expect(out.rows[0].id).toBe("ideal");
  });
});

describe("the note", () => {
  it("is said only when the order actually changed", () => {
    // A standing explanation of a preference that changed nothing is a line
    // riders learn to skip, and then miss on the day it matters.
    expect(idealSplitNote(false, true)).toBeNull();
    expect(idealSplitNote(true, false)).toBeNull();
    expect(idealSplitNote(true, true)).toContain("ideal scooter");
  });
});
