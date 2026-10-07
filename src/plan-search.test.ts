// The assembly step, which is where a plan list goes quietly wrong: every
// field of RankPlansContext is a decision with a documented wrong answer, and
// none of them changes anything visible when it is wrong — the list still
// renders four plausible plans.
import { describe, expect, it, vi } from "vitest";

import type { DeviceProperties } from "./api.ts";
import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import type { RideSpan } from "./free-minutes.ts";
import type { TripPlace } from "./pending-trip.ts";
import {
  buildContext,
  planningFreeMinutes,
  searchPlans,
  type FleetFeature,
  type PlanSearchDeps,
} from "./plan-search.ts";
import { defaultSpec } from "./ride-spec.ts";

const rate = (key: RatePlanKey) => RATE_PLANS.find((p) => p.key === key)!;

const ORIGIN = { lat: 39.7392, lng: -104.9903 };
const DEST: TripPlace = { label: "Union Station", lat: 39.7526, lon: -105.0 };
const NOW = Date.parse("2026-10-07T18:00:00Z");

function feature(eastMeters: number, over: Partial<DeviceProperties> = {}): FleetFeature {
  const lng = ORIGIN.lng + eastMeters / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, ORIGIN.lat] },
    properties: {
      device_id: `d${eastMeters}`,
      vehicle_identifier: `v${eastMeters}`,
      public_name: "Lunar 🐸",
      plate_suffix: "928",
      vehicle_model_name: "Cosmo",
      current_range_meters: 20_000,
      battery_pct: 90,
      reliability_tier: "ok",
      ...over,
    } as DeviceProperties,
  };
}

function deps(over: Partial<PlanSearchDeps> = {}): PlanSearchDeps {
  return {
    fleet: () => [feature(200)],
    origin: () => ORIGIN,
    spec: () => defaultSpec(),
    rate: () => rate("resident"),
    taxRate: () => 0.0915,
    now: () => NOW,
    ...over,
  };
}

describe("planningFreeMinutes", () => {
  it("is zero for every tier without a free hour, without counting anything", () => {
    // Four of the five tiers. `searchOnce`'s freeBudget is 0 for them anyway,
    // so counting rides to justify a zero is work with no consequence — and
    // this asserts the rides are not even asked for.
    const rides = vi.fn(() => [] as readonly RideSpan[]);
    for (const key of ["resident", "resident_plus", "visitor", "visitor_plus"] as const) {
      expect(planningFreeMinutes(deps({ rides }), rate(key))).toBe(0);
    }
    expect(rides).not.toHaveBeenCalled();
  });

  it("is pessimistic for a signed-out Access rider, which prices nothing as free", () => {
    // The honest answer when there is nothing to count and nobody to ask. It
    // errs toward quoting too much rather than promising free minutes that may
    // not exist.
    expect(planningFreeMinutes(deps({ signedIn: () => false }), rate("equity"))).toBe(0);
  });

  it("counts today's tracked rides for a signed-in Access rider", () => {
    // 15 minutes, ended. Veo bills the started minute, so 15 spent, 45 left.
    const rides: RideSpan[] = [
      { startedAtMs: NOW - 20 * 60_000, endedAtMs: NOW - 5 * 60_000 },
    ];
    const got = planningFreeMinutes(
      deps({ rides: () => rides, signedIn: () => true }),
      rate("equity"),
    );
    expect(got).toBe(45);
  });

  it("lets the rider's own correction win, because our figure is the weaker one", () => {
    const got = planningFreeMinutes(
      deps({
        rides: () => [],
        signedIn: () => true,
        riderSaysRemaining: () => 12,
      }),
      rate("equity"),
    );
    expect(got).toBe(12);
  });
});

describe("buildContext", () => {
  it("passes the injected tax rate and clock through, never a default", () => {
    const ctx = buildContext(deps({ taxRate: () => 0.05 }), ORIGIN, DEST);
    expect(ctx.taxRate).toBe(0.05);
    expect(ctx.now).toBe(NOW);
    expect(ctx.to).toEqual({ lat: DEST.lat, lon: DEST.lon });
  });

  it("omits favorites rather than passing an empty set when none is wired", () => {
    expect("favorites" in buildContext(deps(), ORIGIN, DEST)).toBe(false);
    const withFavs = buildContext(deps({ favorites: () => new Set(["v200"]) }), ORIGIN, DEST);
    expect(withFavs.favorites).toEqual(new Set(["v200"]));
  });
});

describe("searchPlans", () => {
  it("refuses to search without a fix rather than guessing an origin", () => {
    // A plan list computed from a wrong origin is four wrong answers, and
    // walking a rider to a scooter that is not near them is the one failure
    // this surface can cause on its own.
    expect(searchPlans(deps({ origin: () => null }), DEST)).toEqual({ kind: "no_fix" });
  });

  it("produces rows with the destination named in the final leg", () => {
    const out = searchPlans(deps(), DEST);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.view.rows.length).toBeGreaterThan(0);
    const texts = out.view.rows.flatMap((r) => r.legLines.map((l) => l.text));
    expect(texts.some((t) => t.includes("Union Station"))).toBe(true);
  });

  it("searches the WHOLE fleet it is handed, filters being a view and not a choice", () => {
    // `rankPlans`'s own rule. Asserted by handing it a fleet and checking the
    // call shape, because the alternative — passing the filtered view — still
    // returns plausible plans and so cannot be caught by eye.
    const fleet = vi.fn(() => [feature(200), feature(600)]);
    const out = searchPlans(deps({ fleet }), DEST);
    expect(fleet).toHaveBeenCalledTimes(1);
    if (out.kind !== "ok") return;
    const ridden = out.view.rows.flatMap((r) =>
      r.plan.legs.filter((l) => l.mode === "ride").map((l) => l.vehicle?.vehicle_identifier),
    );
    expect(ridden.length).toBeGreaterThan(0);
  });

  it("carries the free-minute figure it priced with, onto the view (§2.2)", () => {
    // THIS TEST EXISTS BECAUSE THE WIRING WAS SILENTLY REVERTED ONCE and nothing
    // failed. `PlanListInput.freeMinutes` is optional and `planListView` defaults
    // it to null, so a `searchPlans` that stops passing it still typechecks, still
    // returns four plans, and merely hides §2.2's control forever. The control is
    // the only thing that tells an Access rider their trip is free, so losing it
    // reinstates the exact pessimism §2.2 exists to correct.
    const equity = searchPlans(
      deps({
        rate: () => rate("equity"),
        signedIn: () => true,
        rides: () => [{ startedAtMs: NOW - 20 * 60_000, endedAtMs: NOW - 5 * 60_000 }],
      }),
      DEST,
    );
    expect(equity.kind).toBe("ok");
    if (equity.kind !== "ok") return;
    expect(equity.freeMinutes?.remainingMinutes).toBe(45);
    // And the same figure reaches the view, which is what the rider reads.
    expect(equity.view.freeMinutes).not.toBeNull();
    expect(equity.view.freeMinutes!.headline).toContain("45");
  });

  it("shows no control to a tier that has no free hour", () => {
    const out = searchPlans(deps({ rate: () => rate("resident") }), DEST);
    if (out.kind !== "ok") return;
    expect(out.freeMinutes).toBeNull();
    expect(out.view.freeMinutes).toBeNull();
  });

  it("hands out a first vehicle the walk flow can be pointed at", () => {
    const out = searchPlans(deps(), DEST);
    if (out.kind !== "ok") return;
    const row = out.view.rows.find((r) => !r.isWalkOnly);
    expect(row?.firstVehicle?.vehicle_identifier).toBeTruthy();
  });
});
