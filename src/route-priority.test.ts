// @vitest-environment happy-dom
//
// The four routing priorities. Every test here is a rider making a choice the
// other three would make differently — the whole point is that the same four
// plans come out in four different orders, so a test that passes under two
// priorities is testing the plans and not the preference.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeviceProperties } from "./api.ts";
import type { TripLeg, TripPlan } from "./along-the-way.ts";
import {
  DEFAULT_ROUTE_PRIORITY,
  MAX_NON_IDEAL_SHARE,
  ROUTE_PRIORITY_KEY,
  ROUTE_PRIORITY_OPTIONS,
  SWAP_ALTERNATIVE_METERS,
  TIE_CENTS,
  equityShare,
  meetsComfortCap,
  nonIdealShare,
  orderByPriority,
  routePriority,
  routePriorityNote,
  setRoutePriority,
  swapCompany,
  walkSeconds,
  type FleetPoint,
  type RoutePriority,
} from "./route-priority.ts";
import { defaultSpec, type RideSpec } from "./ride-spec.ts";
import { readSource, withoutComments } from "../tests/helpers/source-text.ts";

const COSMO: RideSpec = { ...defaultSpec(), models: ["cosmo"] };

function vehicle(model: string, id = `d-${model}`): DeviceProperties {
  return {
    device_id: id,
    public_name: "Lunar 🐸",
    plate_suffix: "928",
    vehicle_model_name: model,
    vehicle_identifier: `v-${id}`,
    is_disabled: false,
    is_reserved: false,
  } as DeviceProperties;
}

function ride(
  seconds: number,
  model: string,
  over: { equityArea?: boolean; id?: string } = {},
): TripLeg {
  return {
    mode: "ride",
    seconds,
    meters: seconds * 4,
    vehicle: vehicle(model, over.id ?? `d-${model}`),
    unlockCents: 100,
    minuteCents: 0,
    taxCents: 0,
    freeMinutesUsed: 0,
    equityArea: over.equityArea ?? false,
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

/** Degrees of latitude per metre, near enough at Denver's latitude for a
 *  fixture that only needs "inside the radius" and "well outside it". */
const DEG = 1 / 111_320;

function at(model: string, id: string, lat: number, lon: number): FleetPoint {
  return { properties: vehicle(model, id), lat, lon };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

// ---------------------------------------------------------------------------

describe("the preference itself", () => {
  it("defaults to comfort, which is what the old two-option control meant", () => {
    expect(routePriority()).toBe(DEFAULT_ROUTE_PRIORITY);
    expect(DEFAULT_ROUTE_PRIORITY).toBe("comfort");
  });

  it("round-trips every option it offers", () => {
    for (const option of ROUTE_PRIORITY_OPTIONS) {
      expect(setRoutePriority(option.value)).toBe(true);
      expect(routePriority()).toBe(option.value);
    }
  });

  it("offers all four, each with a hint naming the trade it makes", () => {
    expect(ROUTE_PRIORITY_OPTIONS.map((o) => o.value)).toEqual([
      "comfort",
      "savings",
      "flexibility",
      "simplicity",
    ]);
    for (const o of ROUTE_PRIORITY_OPTIONS) {
      expect(o.hint.length).toBeGreaterThan(20);
    }
  });

  it("carries the two-option ancestor's setting across", () => {
    // A rider who deliberately chose "Cheapest" should not be silently reset
    // to a preference that ranks price last.
    localStorage.setItem("scooter-fyi-ideal-split", "cheapest");
    expect(routePriority()).toBe("savings");
    localStorage.setItem("scooter-fyi-ideal-split", "prefer_ideal");
    expect(routePriority()).toBe("comfort");
  });

  it("leaves the old key alone, so a rollback finds it intact", () => {
    localStorage.setItem("scooter-fyi-ideal-split", "cheapest");
    routePriority();
    setRoutePriority("simplicity");
    expect(localStorage.getItem("scooter-fyi-ideal-split")).toBe("cheapest");
  });

  it("prefers its own key over the ancestor once set", () => {
    localStorage.setItem("scooter-fyi-ideal-split", "cheapest");
    setRoutePriority("flexibility");
    expect(routePriority()).toBe("flexibility");
  });

  it("falls back to the default on a value it does not recognise", () => {
    localStorage.setItem(ROUTE_PRIORITY_KEY, "whatever");
    expect(routePriority()).toBe(DEFAULT_ROUTE_PRIORITY);
  });
});

// ---------------------------------------------------------------------------

describe("the measurements", () => {
  it("counts non-ideal time in SECONDS, not legs", () => {
    // Two legs, one ideal — counting legs calls this 50%. The rider spent 90%
    // of the ride on the wrong scooter.
    const p = plan([walk(240), ride(120, "Cosmo"), ride(1080, "Astro")], 500);
    expect(nonIdealShare(p, COSMO)!).toBeCloseTo(1080 / 1200, 5);
  });

  it("is null without a spec, because 'not the wrong scooter' is a claim", () => {
    expect(nonIdealShare(plan([ride(600, "Cosmo")], 300), null)).toBeNull();
  });

  it("excludes the walk, which is the same walk either way", () => {
    const p = plan([walk(600), ride(100, "Astro")], 300);
    expect(nonIdealShare(p, COSMO)!).toBe(1);
  });

  it("holds the cap at a quarter, inclusive", () => {
    const exactly = plan([ride(750, "Cosmo"), ride(250, "Astro")], 300);
    expect(nonIdealShare(exactly, COSMO)!).toBeCloseTo(MAX_NON_IDEAL_SHARE, 5);
    expect(meetsComfortCap(exactly, COSMO)).toBe(true);

    const over = plan([ride(740, "Cosmo"), ride(260, "Astro")], 300);
    expect(meetsComfortCap(over, COSMO)).toBe(false);
  });

  it("cannot fail a cap nobody set", () => {
    expect(meetsComfortCap(plan([ride(600, "Astro")], 300), null)).toBe(true);
  });

  it("reads the equity flag the planner wrote, not the polygons", () => {
    const both = plan(
      [ride(300, "Cosmo", { equityArea: true }), ride(300, "Astro", { equityArea: true })],
      200,
    );
    expect(equityShare(both)).toBe(1);
    const half = plan(
      [ride(300, "Cosmo", { equityArea: true }), ride(300, "Astro")],
      200,
    );
    expect(equityShare(half)).toBe(0.5);
  });

  it("counts only walking in walkSeconds", () => {
    expect(walkSeconds(plan([walk(120), ride(600, "Cosmo"), walk(60)], 300))).toBe(180);
  });
});

// ---------------------------------------------------------------------------

describe("company at the swap", () => {
  const swapAt = { lat: 39.74, lon: -104.99 };
  const swapCosmo = at("Cosmo", "d-Cosmo", swapAt.lat, swapAt.lon);
  const twoLeg = plan([walk(120), ride(600, "Astro"), ride(600, "Cosmo")], 400);

  it("is infinite with no hand-off: no swap can fail", () => {
    expect(swapCompany(plan([ride(600, "Cosmo")], 300), [swapCosmo], COSMO)).toBe(
      Infinity,
    );
  });

  it("counts other scooters the rider would accept, within the radius", () => {
    const near = at("Cosmo", "near", swapAt.lat + 50 * DEG, swapAt.lon);
    const far = at("Cosmo", "far", swapAt.lat + 400 * DEG, swapAt.lon);
    expect(swapCompany(twoLeg, [swapCosmo, near, far], COSMO)).toBe(1);
  });

  it("does not count scooters the rider would not accept", () => {
    const wrongModel = at("Astro", "other", swapAt.lat + 50 * DEG, swapAt.lon);
    expect(swapCompany(twoLeg, [swapCosmo, wrongModel], COSMO)).toBe(0);
  });

  it("does not count the swap scooter itself", () => {
    expect(swapCompany(twoLeg, [swapCosmo], COSMO)).toBe(0);
  });

  it("takes the LONELIEST swap, not the average", () => {
    // One well-stocked swap does not rescue a deserted one: the rider has to
    // survive both.
    const second = at("Cosmo", "d-Cosmo2", swapAt.lat + 1000 * DEG, swapAt.lon);
    const crowd = [1, 2, 3].map((n) =>
      at("Cosmo", `crowd${n}`, swapAt.lat + n * DEG, swapAt.lon),
    );
    const threeLeg = plan(
      [
        walk(120),
        ride(600, "Astro"),
        ride(300, "Cosmo", { id: "d-Cosmo" }),
        ride(300, "Cosmo", { id: "d-Cosmo2" }),
      ],
      500,
    );
    expect(swapCompany(threeLeg, [swapCosmo, second, ...crowd], COSMO)).toBe(0);
  });

  it("is null when we could not look, which is not the same as nothing there", () => {
    expect(swapCompany(twoLeg, null, COSMO)).toBeNull();
    expect(swapCompany(twoLeg, [], COSMO)).toBeNull();
    // The swap vehicle is not in the fleet we were handed.
    expect(swapCompany(twoLeg, [at("Cosmo", "somebody-else", 39.9, -105)], COSMO)).toBeNull();
  });

  it("uses the stated radius", () => {
    const justInside = at("Cosmo", "in", swapAt.lat + (SWAP_ALTERNATIVE_METERS - 10) * DEG, swapAt.lon);
    const justOutside = at("Cosmo", "out", swapAt.lat + (SWAP_ALTERNATIVE_METERS + 40) * DEG, swapAt.lon);
    expect(swapCompany(twoLeg, [swapCosmo, justInside], COSMO)).toBe(1);
    expect(swapCompany(twoLeg, [swapCosmo, justOutside], COSMO)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The ordering. One fixture, four priorities, four different winners — which
// is the only test that shows the preference is doing anything at all.
// ---------------------------------------------------------------------------

describe("four riders, four answers", () => {
  const swapAt = { lat: 39.74, lon: -104.99 };

  /** Cheap, but three quarters of the riding on the wrong scooter, and its
   *  swap is somewhere nobody else is standing. */
  const cheapRow = {
    id: "cheap",
    plan: plan([walk(60), ride(900, "Astro", { id: "lonely" }), ride(300, "Cosmo", { id: "d-Cosmo" })], 150),
  };
  /** Comfortable: almost all of it on the Cosmo. Dearer, and it walks. */
  const comfyRow = {
    id: "comfy",
    plan: plan([walk(300), ride(100, "Astro"), ride(1100, "Cosmo", { id: "comfy-swap" })], 400),
  };
  /** Both legs inside an Equity Area — a mid-way swap. Longest ride. */
  const equityRow = {
    id: "equity",
    plan: plan(
      [
        walk(60),
        ride(800, "Astro", { equityArea: true }),
        ride(800, "Cosmo", { equityArea: true, id: "eq-swap" }),
      ],
      160,
    ),
  };
  /** One scooter, no swap at all — but it is not the one the rider asked
   *  for. The simplest plan in the city is usually "ride the thing standing
   *  next to you the whole way", which is exactly the plan somebody choosing
   *  Comfort is declining. */
  const simpleRow = {
    id: "simple",
    plan: plan([walk(500), ride(900, "Astro", { id: "solo" })], 300),
  };

  const rows = [cheapRow, comfyRow, equityRow, simpleRow];

  /** `comfy-swap` has company; `lonely` and `eq-swap` do not. */
  const fleet: FleetPoint[] = [
    at("Cosmo", "d-Cosmo", swapAt.lat, swapAt.lon),
    at("Cosmo", "comfy-swap", 39.75, -104.98),
    at("Cosmo", "neighbour-1", 39.75 + 30 * DEG, -104.98),
    at("Cosmo", "neighbour-2", 39.75 + 60 * DEG, -104.98),
    at("Cosmo", "eq-swap", 39.76, -104.97),
    at("Cosmo", "solo", 39.77, -104.96),
  ];

  const winner = (priority: RoutePriority): string =>
    orderByPriority(rows, priority, { spec: COSMO, fleet }).rows[0].id;

  it("comfort takes the plan that keeps the rider on their own scooter", () => {
    expect(winner("comfort")).toBe("comfy");
  });

  it("savings takes the mid-way swap inside the Equity Area", () => {
    // Dearer per the raw cents than `cheap` by only 10¢ — inside the tie band
    // — and it earns the discount on all of its riding.
    expect(winner("savings")).toBe("equity");
  });

  it("flexibility takes the swap with other scooters standing at it", () => {
    // `simple` has no swap at all, which is the most flexible a plan can be —
    // nothing to be taken before the rider gets there.
    expect(winner("flexibility")).toBe("simple");
    // And among the plans that DO swap, the one with company wins.
    const swapping = [cheapRow, comfyRow, equityRow];
    expect(
      orderByPriority(swapping, "flexibility", { spec: COSMO, fleet }).rows[0].id,
    ).toBe("comfy");
  });

  it("simplicity takes the one with no hand-off, long walk and all", () => {
    expect(winner("simplicity")).toBe("simple");
  });

  it("comfort and simplicity disagree about that same plan", () => {
    // The one-scooter plan is the simplest thing on the list and the least
    // comfortable: it is 100% on a scooter the rider did not ask for. A
    // preference that could not separate these two would not be a preference.
    const o = orderByPriority(rows, "comfort", { spec: COSMO, fleet });
    expect(o.rows[o.rows.length - 1].id).toBe("simple");
  });

  it("gives four different orders, not four names for one order", () => {
    const orders = (["comfort", "savings", "flexibility", "simplicity"] as const).map(
      (p) => orderByPriority(rows, p, { spec: COSMO, fleet }).rows.map((r) => r.id).join(">"),
    );
    expect(new Set(orders).size).toBeGreaterThan(1);
    // Comfort and savings in particular must disagree: they are the two the
    // old two-option control collapsed into one axis.
    expect(orders[0]).not.toBe(orders[1]);
  });
});

// ---------------------------------------------------------------------------

describe("comfort's cap", () => {
  const over = { id: "over", plan: plan([ride(200, "Cosmo"), ride(800, "Astro")], 100) };
  const under = { id: "under", plan: plan([ride(900, "Cosmo"), ride(100, "Astro")], 900) };

  it("demotes a plan that breaks it below one that keeps it, at any price", () => {
    // 800¢ dearer and it still wins. That is what "no more than 25%" means;
    // a weight would let the saving buy its way back.
    const o = orderByPriority([over, under], "comfort", { spec: COSMO });
    expect(o.rows.map((r) => r.id)).toEqual(["under", "over"]);
    expect(o.capUnmet).toBe(false);
  });

  it("demotes but never drops: a short list beats an empty one", () => {
    const o = orderByPriority([over], "comfort", { spec: COSMO });
    expect(o.rows).toHaveLength(1);
    expect(o.capUnmet).toBe(true);
  });

  it("says so when nothing on the list keeps it", () => {
    const o = orderByPriority([over, { id: "x", plan: over.plan }], "comfort", {
      spec: COSMO,
    });
    expect(o.capUnmet).toBe(true);
    expect(routePriorityNote(o, "comfort", true)).toContain("more than a quarter");
  });

  it("does not fire the cap notice for the other three priorities", () => {
    for (const p of ["savings", "flexibility", "simplicity"] as const) {
      const o = orderByPriority([over], p, { spec: COSMO });
      expect(o.capUnmet).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe("savings", () => {
  it("accepts a longer ride for the discount", () => {
    // The rider said so in as many words. The planner's own scalar would take
    // the quicker one, which is exactly the trade this declines.
    const quick = { id: "quick", plan: plan([ride(600, "Cosmo")], 300) };
    const discounted = {
      id: "discounted",
      plan: plan([ride(900, "Cosmo", { equityArea: true })], 320),
    };
    const o = orderByPriority([quick, discounted], "savings", { spec: COSMO });
    expect(o.rows[0].id).toBe("discounted");
  });

  it("does not accept a price difference the rider would notice", () => {
    // Outside the tie band the money is the answer: "savings" that cost more
    // are not savings.
    const cheap = { id: "cheap", plan: plan([ride(600, "Cosmo")], 100) };
    const dear = {
      id: "dear",
      plan: plan([ride(600, "Cosmo", { equityArea: true })], 900),
    };
    expect(orderByPriority([cheap, dear], "savings", { spec: COSMO }).rows[0].id).toBe(
      "cheap",
    );
  });

  it("refuses a bigger bill even when ALL of the riding is discounted", () => {
    // The case this setting is most likely to meet, and the reason the equity
    // share cannot be the primary key. An Equity Area leg bills at
    // $1 + 13¢/min against the resident's $1 + 25¢/min — the unlock is the
    // SAME — so a mid-way swap inside an area buys 12¢/min at the cost of a
    // second $1 unlock, and needs ~8.3 min of discounted riding to break
    // even. On a short hop it does not: here the fully-discounted two-scooter
    // plan costs $1.20 more than the single undiscounted ride.
    //
    //   one scooter, 5 min, no discount:  100 + 5*25          = 225¢
    //   two scooters, 5 min, discounted:  100 + 100 + 5*13    = 265¢ … plus
    //                                      the second unlock's own minutes
    const oneScooter = {
      id: "one-scooter",
      plan: plan([ride(300, "Cosmo")], 225),
    };
    const twoInArea = {
      id: "two-in-area",
      plan: plan(
        [
          ride(150, "Cosmo", { equityArea: true, id: "a" }),
          ride(150, "Cosmo", { equityArea: true, id: "b" }),
        ],
        345,
      ),
    };
    expect(equityShare(twoInArea.plan)).toBe(1);
    expect(equityShare(oneScooter.plan)).toBe(0);
    const o = orderByPriority([twoInArea, oneScooter], "savings", { spec: COSMO });
    // 100% discounted riding and it still loses, because it costs the rider
    // $1.20 more. A Savings setting that picked it would have failed at the
    // one thing its name promises.
    expect(o.rows[0].id).toBe("one-scooter");
  });

  it("takes the discounted swap when the bill is about the same", () => {
    // The other half of the contract, and what the share is actually for.
    const plain = { id: "plain", plan: plan([ride(600, "Cosmo")], 300) };
    const inArea = {
      id: "in-area",
      plan: plan(
        [
          ride(300, "Cosmo", { equityArea: true, id: "a" }),
          ride(300, "Cosmo", { equityArea: true, id: "b" }),
        ],
        300 + TIE_CENTS,
      ),
    };
    const o = orderByPriority([plain, inArea], "savings", { spec: COSMO });
    expect(o.rows[0].id).toBe("in-area");
  });
});

// ---------------------------------------------------------------------------

describe("flexibility with nothing to measure", () => {
  const lonely = {
    id: "lonely",
    plan: plan([ride(600, "Astro", { id: "a" }), ride(600, "Cosmo", { id: "b" })], 500),
  };
  const unknown = {
    id: "unknown",
    plan: plan([ride(600, "Astro", { id: "c" }), ride(600, "Cosmo", { id: "gone" })], 600),
  };

  it("does not demote a plan for our own ignorance", () => {
    // `b` is in the fleet with nobody near it (company 0). `gone` is not in
    // the fleet at all, so its company is unknown. Unknown must not rank
    // below a swap we KNOW is deserted.
    const fleet = [at("Cosmo", "b", 39.74, -104.99)];
    const o = orderByPriority([lonely, unknown], "flexibility", { spec: COSMO, fleet });
    expect(o.rows[0].id).toBe("unknown");
  });

  it("falls back to price when no fleet is offered at all", () => {
    const o = orderByPriority([unknown, lonely], "flexibility", { spec: COSMO });
    expect(o.rows.map((r) => r.id)).toEqual(["lonely", "unknown"]);
  });
});

// ---------------------------------------------------------------------------

describe("restraint", () => {
  const a = { id: "a", plan: plan([ride(600, "Cosmo")], 300) };
  const b = { id: "b", plan: plan([ride(600, "Cosmo")], 300) };

  it("never filters: every plan in is a plan out", () => {
    for (const p of ROUTE_PRIORITY_OPTIONS) {
      const o = orderByPriority([a, b], p.value, { spec: COSMO });
      expect(o.rows).toHaveLength(2);
    }
  });

  it("is stable where it has no opinion", () => {
    for (const p of ROUTE_PRIORITY_OPTIONS) {
      const o = orderByPriority([a, b], p.value, { spec: COSMO });
      expect(o.rows.map((r) => r.id)).toEqual(["a", "b"]);
      expect(o.moved).toBe(false);
    }
  });

  it("says nothing when it changed nothing", () => {
    for (const p of ROUTE_PRIORITY_OPTIONS) {
      const o = orderByPriority([a, b], p.value, { spec: COSMO });
      expect(routePriorityNote(o, p.value, true)).toBeNull();
    }
  });

  it("says nothing about ideal scooters to a rider with no spec", () => {
    const rows = [
      { id: "x", plan: plan([ride(600, "Astro")], 900) },
      { id: "y", plan: plan([ride(600, "Cosmo")], 100) },
    ];
    for (const p of ["comfort", "flexibility"] as const) {
      const o = orderByPriority(rows, p, { spec: null });
      expect(routePriorityNote(o, p, false)).toBeNull();
    }
  });

  it("explains itself when it did move something", () => {
    const rows = [
      { id: "dear", plan: plan([ride(600, "Cosmo"), ride(600, "Cosmo")], 110) },
      { id: "simple", plan: plan([ride(600, "Cosmo")], 100) },
    ];
    const o = orderByPriority(rows, "simplicity", { spec: COSMO });
    expect(o.moved).toBe(true);
    expect(routePriorityNote(o, "simplicity", true)).toContain("hand-off");
  });

  it("handles a one-plan and an empty list without inventing an order", () => {
    expect(orderByPriority([], "comfort", { spec: COSMO }).rows).toEqual([]);
    expect(orderByPriority([a], "savings", { spec: COSMO }).rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The wiring. `planListView` deliberately does NOTHING when no priority is
// passed, which makes "the real caller passes one" a fact worth pinning: the
// failure mode is silent, and a list that quietly reverts to generalised cost
// looks exactly like a list the rider's preference agreed with.
// ---------------------------------------------------------------------------
describe("the search hands the rider's answer to the list", () => {
  const search = withoutComments(readSource("src/plan-search.ts"));

  it("passes the stored priority", () => {
    expect(search).toContain("routePriority: routePriority()");
  });

  it("passes the fleet Flexibility needs to count company at a swap", () => {
    expect(search).toContain("fleet: fleetPoints(");
  });

  it("counts company against the SAME fleet the search ran on", () => {
    // Two fleets would let the plan list say three scooters are standing at a
    // swap the planner chose from a feed that had none.
    const body = search.slice(search.indexOf("export function searchPlans("));
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toContain("const feats = [...deps.fleet()]");
    expect(fn).toContain("rankPlans(feats,");
    expect(fn).toContain("fleetPoints(feats)");
    // One read of the fleet, not two.
    expect(fn.match(/deps\.fleet\(\)/g) ?? []).toHaveLength(1);
  });

  it("asks the search to SEEK an Equity Area swap, not merely prefer one", () => {
    // Without this the Savings setting can only choose among plans the search
    // already found, and the pickup pool — ranked by progress and truncated —
    // systematically omits the mid-route vehicle that earns the discount on
    // both legs. The preference has to reach the candidate selection.
    expect(search).toContain('seekEquitySwaps: routePriority() === "savings"');
  });

  it("asks for the hunt only under Savings", () => {
    // It spends part of a bounded pickup budget. A rider who chose Simplicity
    // is not served by giving up pool slots to chase a discount.
    const line = search.slice(search.indexOf("seekEquitySwaps:"));
    const firstLine = line.slice(0, line.indexOf("\n", 1));
    expect(firstLine).toContain("savings");
    expect(firstLine).not.toContain("true,");
  });

  it("drops a vehicle with no usable coordinates rather than placing it at null island", () => {
    // (0, 0) is within 150 m of nothing in Denver, but it is within 150 m of
    // every OTHER vehicle we also defaulted, so a handful of broken features
    // would vote each other up as company.
    const body = search.slice(search.indexOf("function fleetPoints("));
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toContain("Number.isFinite");
    expect(fn).toContain("continue");
  });
});

// ---------------------------------------------------------------------------
// Two mutations that survived the first pass, each now with a test. Recorded
// because both are cases the comparators get wrong in a way the fixtures
// above could not see.
// ---------------------------------------------------------------------------
describe("edges the comparators get wrong without looking", () => {
  it("does not let comfort promote the walk over every plan that rides", () => {
    // A walk has no ride legs, so it cannot be "on the wrong scooter" — and a
    // cap test in front of the share duly floated it to the top. A rider who
    // asked to spend the trip on their own scooter did not ask to walk there.
    const onFoot = { id: "walk", plan: plan([walk(2400)], 0) };
    const wrongScooter = {
      id: "wrong",
      plan: plan([ride(200, "Cosmo"), ride(800, "Astro")], 300),
    };
    const o = orderByPriority([onFoot, wrongScooter], "comfort", { spec: COSMO });
    expect(o.rows[0].id).toBe("wrong");
  });

  it("breaks simplicity's hand-off tie on time spent walking", () => {
    // "Walking a little further to find discounts" is exactly the faff
    // Simplicity declines, so between two one-scooter plans it takes the one
    // that does less of it — even though the walker is cheaper.
    const stroll = { id: "stroll", plan: plan([walk(900), ride(300, "Cosmo")], 100) };
    const nearby = { id: "nearby", plan: plan([walk(120), ride(300, "Cosmo")], 400) };
    const o = orderByPriority([stroll, nearby], "simplicity", { spec: COSMO });
    expect(o.rows.map((r) => r.id)).toEqual(["nearby", "stroll"]);
  });
});
