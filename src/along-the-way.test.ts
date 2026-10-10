import { readFileSync } from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  DEFAULT_BOUNDS,
  FAVORITE_BONUS_SECONDS,
  RIDE_METERS_PER_SEC,
  SECONDS_PER_CENT,
  freeMinutesUsedNow,
  legRate,
  rankPlans,
  type RankPlansContext,
  type TripPlan,
} from "./along-the-way.ts";
import type { DeviceProperties } from "./api.ts";
import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import {
  __resetEquityAreasForTest,
  loadEquityAreas,
  type EquityAreaCollection,
} from "./equity-areas.ts";
import { defaultSpec, type RideSpec } from "./ride-spec.ts";

// ---------------------------------------------------------------------------
// Fixtures. Positions are given in METRES from the origin so a test can say
// "14 minutes' walk away but on the route" and have that be legible, rather
// than burying the claim in decimal degrees.
// ---------------------------------------------------------------------------

const ORIGIN = { lat: 39.7392, lng: -104.9903 };
const METERS_PER_DEG_LAT = 111_320;
const METERS_PER_DEG_LNG = METERS_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** Handy coincidence worth stating, because the fixtures below lean on it: a
 *  straight-line metre is 1.006 walk-seconds (1.35 detour ÷ 80.5 m/min × 60),
 *  so "300 m away" and "a five-minute walk" are the same fixture. Riding is
 *  0.27 s/m, about 3.7× faster. */
function at(eastMeters: number, northMeters = 0): { lat: number; lng: number } {
  return {
    lat: ORIGIN.lat + northMeters / METERS_PER_DEG_LAT,
    lng: ORIGIN.lng + eastMeters / METERS_PER_DEG_LNG,
  };
}

function feature(
  pos: { lat: number; lng: number },
  over: Partial<DeviceProperties> = {},
): GeoJSON.Feature<GeoJSON.Point, DeviceProperties> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [pos.lng, pos.lat] },
    properties: {
      device_id: over.device_id ?? "d",
      vehicle_identifier: over.vehicle_identifier ?? over.device_id ?? "d",
      vehicle_model_name: "Cosmo",
      reliability_tier: "ok",
      battery_percent: 90,
      current_range_meters: 20_000,
      ...over,
    } as DeviceProperties,
  };
}

/** A vehicle with a confirmed basket — what a `features: ["basket"]` spec is
 *  asking for. */
function withBasket(over: Partial<DeviceProperties> = {}): Partial<DeviceProperties> {
  return {
    ...over,
    device_features: {
      bell: true,
      basket: true,
      cup_holder: false,
      phone_holder: false,
      poor_condition: [],
    },
  } as Partial<DeviceProperties>;
}

function rate(key: RatePlanKey) {
  const found = RATE_PLANS.find((p) => p.key === key);
  if (!found) throw new Error(`no rate plan ${key}`);
  return found;
}

/** A point verified inside EQ_001 in the city's bundled map — the same
 *  coordinate `equity-areas.test.ts` asserts against, so the two files cannot
 *  disagree about where an Equity Area is. */
const INSIDE_EQUITY_AREA = { lat: 39.785137, lng: -104.826320 };

const EQUITY_MAP = JSON.parse(
  readFileSync("public/equity-areas.geojson", "utf8"),
) as EquityAreaCollection;

/** Load the REAL polygons, not a stand-in rectangle.
 *
 *  `legRate` reads module state in `equity-areas.ts`, which is empty until
 *  something loads it — and its documented behaviour on empty state is "treat
 *  as outside". So any test of the area rate that does not do this tests the
 *  outside path while appearing to test the inside one. */
async function withEquityAreas(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => EQUITY_MAP }),
  );
  await loadEquityAreas();
}

afterEach(() => {
  // Module-level and process-lifetime by design, so it has to be undone or it
  // leaks into every later test in this file — repricing legs that the tests
  // around it expect at the rider's own tier.
  __resetEquityAreasForTest();
  vi.unstubAllGlobals();
});

function ctx(over: Partial<RankPlansContext> = {}): RankPlansContext {
  return {
    from: ORIGIN,
    to: { lat: at(4000).lat, lon: at(4000).lng },
    spec: defaultSpec(),
    rate: rate("resident"),
    freeMinutesLeft: 0,
    bounds: DEFAULT_BOUNDS,
    taxRate: 0,
    now: Date.parse("2026-10-02T12:00:00Z"),
    ...over,
  };
}

function spec(over: Partial<RideSpec> = {}): RideSpec {
  return { ...defaultSpec(), ...over };
}

const rideLegs = (p: TripPlan) => p.legs.filter((l) => l.mode === "ride");
const readFeatures = (leg: { vehicle?: DeviceProperties } | undefined) =>
  leg?.vehicle?.device_features as { basket?: boolean } | undefined;
const vehicleSeq = (p: TripPlan) =>
  rideLegs(p).map((l) => l.vehicle?.vehicle_identifier ?? "?");

// ---------------------------------------------------------------------------

describe("rankPlans — the hand-off", () => {
  it("rides a starter to the spec-matching scooter instead of walking to it", () => {
    // THE HEADLINE CASE, and the one revision 2 could not express at all: the
    // Cosmo with the basket is a 14-minute walk away, but it is ON THE ROUTE,
    // so the plan is a 90-second walk to whatever is nearest and a ride.
    const feats = [
      feature(at(120), { device_id: "astro", vehicle_identifier: "astro" }),
      // 835 m ≈ a fourteen-minute walk, and on the route.
      feature(at(835), withBasket({ device_id: "cosmo", vehicle_identifier: "cosmo" })),
    ];
    const res = rankPlans(feats, ctx({ spec: spec({ features: ["basket"], must: ["features"] }) }));

    const best = res.plans[0];
    expect(vehicleSeq(best)).toEqual(["astro", "cosmo"]);
    expect(best.handOffs).toBe(1);

    // The rider walks for about two minutes, not fourteen. THIS is the
    // comparison the feature exists to win: revision 2's answer to the same
    // fleet was "walk 14 minutes to the Cosmo".
    const walkToCosmoSeconds = 835 * 1.0062;
    expect(best.legs[0].mode).toBe("walk");
    expect(best.legs[0].seconds).toBeLessThan(walkToCosmoSeconds / 5);

    // And walking to the Cosmo is not even offered, because the rider said
    // they would walk at most 12 minutes and that walk is 14 — which is what
    // makes the hand-off the only way to get the scooter they asked for.
    //
    // NOT ASSERTED: that the hand-off out-ranks the 67-minute direct walk to
    // the destination. It does not, for a resident, at SECONDS_PER_CENT = 8 —
    // see that constant's note. The walk cap is what keeps that comparison
    // from ever being put to the rider, and the cap is the honest mechanism:
    // they told us how far they would walk.
    const offeredFirstWalks = res.plans.map((p) => p.legs[0].seconds);
    expect(Math.min(...offeredFirstWalks)).toBeLessThan(12 * 60);
  });

  it("offers a starter that can reach the hand-off but not the destination", () => {
    // The per-leg `mustReach` regression. A scruffy Astro with 1.5 km of range
    // is a fine STARTER when its hand-off is 1.2 km away, and useless only as
    // a vehicle for the whole trip. Evaluating reach against the final
    // destination for every candidate deletes exactly these.
    const feats = [
      feature(at(120), {
        device_id: "astro",
        vehicle_identifier: "astro",
        current_range_meters: 1_500,
      }),
      feature(at(835), withBasket({ device_id: "cosmo", vehicle_identifier: "cosmo" })),
    ];
    const res = rankPlans(
      feats,
      ctx({ spec: spec({ features: ["basket"], must: ["features", "must_reach"], mustReach: true }) }),
    );
    expect(vehicleSeq(res.plans[0])).toEqual(["astro", "cosmo"]);
  });

  it("ranks the walk-only plan when there is nothing to ride", () => {
    // `limit` is a CAP, never a quota: a valid result can hold only the
    // walk-only plan. A UI promising two options would fabricate the second.
    const res = rankPlans([], ctx());
    expect(res.plans).toHaveLength(1);
    expect(rideLegs(res.plans[0])).toHaveLength(0);
    expect(res.plans[0].legs[0].mode).toBe("walk");
    // Offered despite being far outside the walk cap, because an empty list is
    // not an answer.
    expect(res.plans[0]).toBe(res.walkOnly);
  });

  it("chains three hand-offs deep with no hop counter anywhere", () => {
    // Master rule 3: chaining is unbounded and limited by the money term, not
    // by a counter. A cap-shaped bug passes every other test here, so this one
    // is a count larger than any plausible cap.
    //
    // WHAT FORCES A CHAIN IS RANGE, NOT TIME. Worth writing down, because an
    // earlier draft of this test assumed otherwise and passed on a tie: with
    // straight-line geometry and one riding speed, `ride(a→b) + ride(b→D)` is
    // never less than `ride(a→D)`, so a hand-off never saves distance. It pays
    // only for a reason OF ITS OWN — the vehicle you end on meeting the spec,
    // an Equity Area rate, or, here, range.
    const shortRange = 1_600; // enough for one ~1 km hop, not for 3.9 km
    const feats = [
      feature(at(100), { device_id: "a", vehicle_identifier: "a", current_range_meters: shortRange }),
      feature(at(1100), { device_id: "b", vehicle_identifier: "b", current_range_meters: shortRange }),
      feature(at(2100), { device_id: "c", vehicle_identifier: "c", current_range_meters: shortRange }),
      feature(at(3100), { device_id: "d", vehicle_identifier: "d", current_range_meters: shortRange }),
    ];
    const res = rankPlans(
      feats,
      ctx({
        rate: rate("resident_plus"),
        spec: spec({ mustReach: true, must: ["must_reach"] }),
      }),
    );
    expect(vehicleSeq(res.plans[0])).toEqual(["a", "b", "c", "d"]);
    expect(res.plans[0].handOffs).toBe(3);
  });
});

describe("rankPlans — which scooter must match the spec", () => {
  // THE RULE: the second scooter is the one that must match the spec if the
  // first cannot. So only the FIRST ride leg's vehicle may fail it, and a plan
  // can never hand off FROM a matching scooter TO a non-matching one.
  //
  // Three separate checks enforce this and none is sufficient alone (the
  // pickup pool, the final-leg check, and the continuation edge), so it is
  // tested as the invariant rather than per check.
  const hasBasket = (p: TripPlan, i: number): boolean => {
    const f = readFeatures(rideLegs(p)[i]);
    return f?.basket === true;
  };

  // The basket is a PREFERENCE here, not a `must`, and that is the whole
  // point of the fixture. An earlier draft made it a `must` — and then the
  // musts alone excluded the non-matching vehicle, so the test passed with the
  // pickup pool screened on `qualifies` instead of `ideal`. It was asserting
  // the invariant and proving the musts. A preference separates them: it
  // leaves `qualifies` true for a basket-less scooter and `ideal` false.
  const basketPreferred = () => spec({ features: ["basket"] });

  it("lets only the FIRST vehicle fail the spec, never a later one", () => {
    const feats = [
      // Nearest, no basket: a legitimate starter.
      feature(at(120), { device_id: "astro", vehicle_identifier: "astro" }),
      // Further along the route, no basket — the tempting wrong answer. As a
      // MIDDLE vehicle it would shorten nothing and give the rider a leg on a
      // scooter they did not ask for.
      feature(at(1000), { device_id: "tempting", vehicle_identifier: "tempting" }),
      // The one the rider asked for, too far to walk to, and nearest the door.
      feature(at(2000), withBasket({ device_id: "cosmo", vehicle_identifier: "cosmo" })),
    ];
    const res = rankPlans(feats, ctx({ spec: basketPreferred() }));

    const ridden = res.plans.concat(res.backups).filter((p) => rideLegs(p).length > 0);
    expect(ridden.length).toBeGreaterThan(0);
    for (const plan of ridden) {
      const rides = rideLegs(plan);
      // Every vehicle except possibly the first matches.
      for (let i = 1; i < rides.length; i += 1) {
        expect(hasBasket(plan, i)).toBe(true);
      }
      // And the last one always does — it is the one they keep.
      expect(hasBasket(plan, rides.length - 1)).toBe(true);
    }
    // The starter is still used, so this is not passing by refusing to plan.
    expect(ridden.some((p) => vehicleSeq(p)[0] === "astro")).toBe(true);
  });

  it("will not answer a re-solve with 'keep riding the starter to the door'", () => {
    // The continuation edge is a ride leg like any other. A rider mid-trip on
    // a basket-less starter whose pickup vanished does not stop wanting a
    // basket, so carrying on to the DOOR has to satisfy the spec — while
    // carrying on to a PICKUP is still fine, because that is a starter leg.
    const starterUnderRider = feature(at(0), {
      device_id: "starter",
      vehicle_identifier: "starter",
      current_range_meters: 20_000,
    });
    const feats = [
      starterUnderRider,
      feature(at(900), withBasket({ device_id: "cosmo", vehicle_identifier: "cosmo" })),
    ];
    const res = rankPlans(
      feats,
      ctx({
        spec: basketPreferred(),
        inRide: {
          vehicleIdentifier: "starter",
          rangeMeters: 20_000,
          unlockPaid: true,
          freeMinutesUsedBeforeRide: 0,
          rideStartedAt: "2026-10-02T11:55:00Z",
        },
      }),
    );

    const plansEndingOnStarter = res.plans
      .concat(res.backups)
      .filter((p) => {
        const rides = rideLegs(p);
        return rides.length > 0 && rides[rides.length - 1].vehicle?.vehicle_identifier === "starter";
      });
    expect(plansEndingOnStarter).toHaveLength(0);

    // Carrying on TO THE PICKUP is still offered, and still costs no second
    // unlock on that leg.
    const continuing = res.plans
      .concat(res.backups)
      .find((p) => vehicleSeq(p)[0] === "starter");
    expect(continuing).toBeDefined();
    expect(vehicleSeq(continuing!)).toEqual(["starter", "cosmo"]);
    expect(continuing!.legs[0].unlockCents).toBe(0);
  });
});

describe("rankPlans — rule 1, the risk tier", () => {
  it("excludes risky vehicles while a non-risky one is within five minutes", () => {
    const feats = [
      feature(at(80), {
        device_id: "risky",
        vehicle_identifier: "risky",
        reliability_tier: "risk",
      }),
      // 250 m ≈ a four-minute walk, so INSIDE the fixed five minutes. (900 m
      // would be a fifteen-minute walk and the fallback would correctly fire —
      // which is how an earlier draft of this test passed for the wrong
      // reason.)
      feature(at(250), { device_id: "ok", vehicle_identifier: "ok" }),
    ];
    const res = rankPlans(feats, ctx());
    const all = res.plans.concat(res.backups);
    expect(all.flatMap(vehicleSeq)).not.toContain("risky");
    expect(res.riskTierOffered).toBe(false);
  });

  it("admits a risky vehicle only as a FIRST HOP, never as a pickup", () => {
    // Asserted on the leg's ROLE and the fallback condition, not on a count:
    // the bounded first-hop set may legitimately hold several, so "exactly one
    // appears" would both over-constrain the planner and pass while a risky
    // PICKUP slipped through — the half of the rule with no exception.
    const feats = [
      feature(at(80), {
        device_id: "risky-near",
        vehicle_identifier: "risky-near",
        reliability_tier: "risk",
      }),
      feature(at(2000), {
        device_id: "risky-far",
        vehicle_identifier: "risky-far",
        reliability_tier: "high_risk",
      }),
    ];
    const res = rankPlans(feats, ctx());
    const all = res.plans.concat(res.backups);
    expect(res.riskTierOffered).toBe(true);

    for (const plan of all) {
      const seq = vehicleSeq(plan);
      // Any risky vehicle may only be the one walked to — never handed off to.
      for (const [i, id] of seq.entries()) {
        if (id.startsWith("risky")) expect(i).toBe(0);
      }
    }
  });

  it("relaxes the walk cap rather than rule 1", () => {
    // A 3-minute cap with a non-risky vehicle 4 minutes away is NOT "no
    // non-risky vehicle nearby". The cap is a rider preference and gives way;
    // rule 1 is a platform rule and does not.
    const nonRiskyFourMinutesAway = at(240);
    const feats = [
      feature(at(60), {
        device_id: "risky",
        vehicle_identifier: "risky",
        reliability_tier: "risk",
      }),
      feature(nonRiskyFourMinutesAway, { device_id: "ok", vehicle_identifier: "ok" }),
    ];
    const res = rankPlans(feats, ctx({ spec: spec({ maxWalkMinutes: 3 }) }));
    const all = res.plans.concat(res.backups);
    expect(all.flatMap(vehicleSeq)).toContain("ok");
    expect(all.flatMap(vehicleSeq)).not.toContain("risky");
    expect(res.capRelaxed).toBe(true);
    expect(res.riskTierOffered).toBe(false);
  });
});

describe("rankPlans — the money term", () => {
  it("orders the same fleet differently for a $1-unlock tier and a free one", () => {
    // The money term is real, not decorative. The two riders face the same
    // choice — walk 20 minutes to the Cosmo, or ride something to it and pay a
    // second unlock — and the $1 decides it differently.
    const feats = [
      feature(at(120), { device_id: "astro", vehicle_identifier: "astro" }),
      feature(at(1200), withBasket({ device_id: "cosmo", vehicle_identifier: "cosmo" })),
    ];
    const withBasketSpec = spec({
      features: ["basket"],
      must: ["features"],
      maxWalkMinutes: 25, // long enough that walking to the Cosmo is on offer
    });
    const resident = rankPlans(feats, ctx({ rate: rate("resident"), spec: withBasketSpec }));
    const access = rankPlans(
      feats,
      ctx({ rate: rate("equity"), freeMinutesLeft: 60, spec: withBasketSpec }),
    );
    // A resident walks the 20 minutes to the Cosmo rather than pay a second
    // unlock and 25¢/min; an Access rider with free minutes rides to it,
    // because for them the starter leg is free.
    expect(resident.plans[0].handOffs).toBe(0);
    expect(access.plans[0].handOffs).toBe(1);
    expect(access.plans[0].estimatedCents).toBe(0);
  });

  it("puts every unlock in estimatedCents, derived from the legs", () => {
    const feats = [
      feature(at(100), { device_id: "a", vehicle_identifier: "a" }),
      feature(at(2000), { device_id: "b", vehicle_identifier: "b" }),
    ];
    const res = rankPlans(feats, ctx({ rate: rate("resident_plus") }));
    for (const plan of res.plans.concat(res.backups)) {
      const summed = plan.legs.reduce(
        (n, l) => n + l.unlockCents + l.minuteCents + l.taxCents,
        0,
      );
      expect(plan.estimatedCents).toBe(summed);
      const seconds = plan.legs.reduce((n, l) => n + l.seconds, 0);
      expect(plan.totalSeconds).toBeCloseTo(seconds, 6);
    }
  });

  it("gives tax its own per-leg component", () => {
    // Fold tax into the unlock or the minutes and the rider can no longer see
    // WHICH leg costs the extra unlock, and the two tiers can no longer be
    // reconciled component by component.
    const feats = [feature(at(100), { device_id: "a", vehicle_identifier: "a" })];
    const res = rankPlans(feats, ctx({ taxRate: 0.0915 }));
    const ride = rideLegs(res.plans.concat(res.backups).find((p) => rideLegs(p).length > 0)!)[0];
    expect(ride.unlockCents).toBe(100);
    expect(ride.taxCents).toBe(Math.round((ride.unlockCents + ride.minuteCents) * 0.0915));
    expect(ride.taxCents).toBeGreaterThan(0);
  });

  it("prices an equity-area leg at the area rate, not the rider's tier", async () => {
    // $1 + 13¢/min is a RATE. A tier whose ordinary unlock is $0 does not get
    // an equity leg for free: whether a Pass waives THAT dollar is exactly
    // what the contract does not say, and §5.2 takes the worse reading.
    //
    // THIS TEST USED TO PROVE NOTHING, in two independent ways, and both are
    // worth naming because either alone was enough to hollow it out. It
    // guarded its assertions behind `if (r.equityArea)`, and it never loaded
    // the polygons — so `isInEquityArea` answered `null`, `legRate` took its
    // "unknown counts as outside" path, and the guard never opened. Its
    // coordinate (39.77, -104.97) is also outside every area in the city's
    // map, so loading them alone would not have saved it. Verified by
    // mutation: with the area rate replaced by 999¢/min the old test still
    // passed. The fix is to load the real map, use a point verified inside
    // EQ_001, and assert unconditionally.
    await withEquityAreas();
    const r = legRate(rate("resident_plus"), INSIDE_EQUITY_AREA, INSIDE_EQUITY_AREA);
    expect(r.equityArea).toBe(true);
    expect(r.unlockCents).toBe(100);
    expect(r.perMinCents).toBe(13);

    // Start-OR-end: one endpoint inside is the whole rule (Exhibit A §5.2).
    const oneEnd = legRate(rate("resident"), INSIDE_EQUITY_AREA, ORIGIN);
    expect(oneEnd.equityArea).toBe(true);
    expect(oneEnd.perMinCents).toBe(13);

    // An Access rider is never offered the area rate — whether the free hour
    // interacts with it is unstated, and advice we cannot price is advice we
    // do not give.
    const access = legRate(rate("equity"), INSIDE_EQUITY_AREA, INSIDE_EQUITY_AREA);
    expect(access.equityArea).toBe(false);
    expect(access.perMinCents).toBe(15);
  });

  it("carries the equity flag onto the leg, so a plan can name its own discount", async () => {
    // §5.2's disclosures must say WHICH leg earns the discount and what unlock
    // it carries. `priceRide` had `legRate`'s answer in hand and dropped it,
    // leaving the UI to re-test the polygons — a second copy of the rule, and
    // the copy the rider would read.
    await withEquityAreas();
    const feats = [feature(INSIDE_EQUITY_AREA, { device_id: "eq", vehicle_identifier: "eq" })];
    const res = rankPlans(
      feats,
      ctx({ from: INSIDE_EQUITY_AREA, to: { lat: INSIDE_EQUITY_AREA.lat, lon: INSIDE_EQUITY_AREA.lng + 0.01 } }),
    );
    const ride = res.plans
      .concat(res.backups)
      .flatMap((p) => p.legs)
      .find((l) => l.mode === "ride");
    expect(ride).toBeDefined();
    expect(ride!.equityArea).toBe(true);
    expect(ride!.unlockCents).toBe(100);
    // Walk legs never carry it.
    for (const leg of res.walkOnly.legs) expect(leg.equityArea).toBe(false);
  });

  it("values a $1 unlock at 13 min 20 s, and tests the crossover", () => {
    // The exchange rate is the single number that most changes the plan list,
    // so it is asserted at its boundary rather than implied. A scalar with no
    // pinned rate passes whatever test you write for it.
    expect(SECONDS_PER_CENT).toBe(8);
    expect(100 * SECONDS_PER_CENT).toBe(800);
  });
});

describe("rankPlans — the Access cliff", () => {
  const twoVehicles = [
    feature(at(100), { device_id: "a", vehicle_identifier: "a" }),
    feature(at(2000), { device_id: "b", vehicle_identifier: "b" }),
  ];

  it("orders differently with 5 free minutes left and with 55", () => {
    // The cliff is priced, not smoothed.
    const scarce = rankPlans(twoVehicles, ctx({ rate: rate("equity"), freeMinutesLeft: 5 }));
    const plenty = rankPlans(twoVehicles, ctx({ rate: rate("equity"), freeMinutesLeft: 55 }));
    const cost = (r: { plans: TripPlan[] }) => r.plans[0].estimatedCents;
    expect(cost(scarce)).toBeGreaterThan(cost(plenty));
  });

  it("spends free minutes before paid ones, and records them per leg", () => {
    const res = rankPlans(twoVehicles, ctx({ rate: rate("equity"), freeMinutesLeft: 60 }));
    const best = res.plans[0];
    const free = best.legs.reduce((n, l) => n + l.freeMinutesUsed, 0);
    expect(free).toBeGreaterThan(0);
    expect(best.estimatedCents).toBe(0);
  });

  it("charges the Access tier once the free balance is spent", () => {
    const res = rankPlans(twoVehicles, ctx({ rate: rate("equity"), freeMinutesLeft: 0 }));
    const ridden = res.plans.concat(res.backups).find((p) => rideLegs(p).length > 0)!;
    expect(ridden.estimatedCents).toBeGreaterThan(0);
    expect(ridden.legs.every((l) => l.freeMinutesUsed === 0)).toBe(true);
  });
});

describe("rankPlans — the continuation edge", () => {
  const current = feature(at(0), {
    device_id: "current",
    vehicle_identifier: "current",
    current_range_meters: 20_000,
  });

  it("can choose to keep riding what the rider is already on", () => {
    // Without the continuation edge a re-solve has no "keep riding" option at
    // all, so it would systematically prefer handing off — carrying on would
    // not be in the graph to lose.
    const feats = [current, feature(at(500), { device_id: "other", vehicle_identifier: "other" })];
    const res = rankPlans(
      feats,
      ctx({
        inRide: {
          vehicleIdentifier: "current",
          rangeMeters: 20_000,
          unlockPaid: true,
          freeMinutesUsedBeforeRide: 0,
          rideStartedAt: "2026-10-02T11:55:00Z",
        },
      }),
    );
    const continuing = res.plans
      .concat(res.backups)
      .find((p) => vehicleSeq(p)[0] === "current");
    expect(continuing).toBeDefined();
    // Already paid: continuing must never charge a second unlock.
    expect(continuing!.legs[0].unlockCents).toBe(0);
  });

  it("will not continue beyond the current vehicle's remaining range", () => {
    const feats = [current];
    const res = rankPlans(
      feats,
      ctx({
        inRide: {
          vehicleIdentifier: "current",
          rangeMeters: 200, // the destination is 4 km away
          unlockPaid: true,
          freeMinutesUsedBeforeRide: 0,
          rideStartedAt: "2026-10-02T11:55:00Z",
        },
      }),
    );
    expect(res.plans.every((p) => vehicleSeq(p).length === 0)).toBe(true);
  });
});

describe("freeMinutesUsedNow", () => {
  const started = "2026-10-02T12:00:00Z";
  const base = Date.parse(started);

  it("ages a NONZERO baseline without double-counting it", () => {
    // The baseline is minutes spent BEFORE this rental began, so ageing it is
    // exactly right. The predecessor field was minutes spent DURING the ride,
    // and ageing that counted them twice — 6 minutes measured six minutes in
    // became 12. The zero case passes under either arithmetic, which is how
    // the bug survived, so this one is written with a nonzero baseline.
    const used = freeMinutesUsedNow(
      {
        vehicleIdentifier: "v",
        rangeMeters: 1,
        unlockPaid: true,
        freeMinutesUsedBeforeRide: 6,
        rideStartedAt: started,
      },
      base + 6 * 60_000,
    );
    expect(used).toBe(12); // 6 before + 6 ridden, not 6 + 6 + 6
  });

  it("counts 61 seconds into a ride as 2 free minutes, not 1", () => {
    // Veo bills the STARTED minute. Rounding down would rank the rider with
    // free minutes they do not have and price a paid minute as free, which is
    // the one direction §2.2 forbids — its whole promise is a FLOOR on
    // minutes used.
    const used = freeMinutesUsedNow(
      {
        vehicleIdentifier: "v",
        rangeMeters: 1,
        unlockPaid: true,
        freeMinutesUsedBeforeRide: 0,
        rideStartedAt: started,
      },
      base + 61_000,
    );
    expect(used).toBe(2);
  });
});

describe("rankPlans — preferences", () => {
  it("breaks a tie for a favourite without beating a better trip", () => {
    // Both halves, because a bonus tested only on the first half can drift
    // upward into a filter — and §2.1 says a favourite is a bonus, never a
    // filter.
    expect(FAVORITE_BONUS_SECONDS).toBe(90);

    const tie = [
      feature(at(300, 40), { device_id: "plain", vehicle_identifier: "plain" }),
      feature(at(300, -40), { device_id: "fav", vehicle_identifier: "fav" }),
    ];
    const withFav = rankPlans(tie, ctx({ favorites: new Set(["fav"]) }));
    expect(vehicleSeq(withFav.plans[0])[0]).toBe("fav");
    // Sanity: a plan WITH a ride leg is what won, not the walk.
    expect(rideLegs(withFav.plans[0]).length).toBeGreaterThan(0);

    // Now put the favourite far enough away that it loses by more than the
    // bonus is worth: the plain vehicle is nearer by well over 90 seconds.
    const clear = [
      feature(at(200), { device_id: "plain", vehicle_identifier: "plain" }),
      feature(at(200 + 120 * 2 * RIDE_METERS_PER_SEC, -3000), {
        device_id: "fav",
        vehicle_identifier: "fav",
      }),
    ];
    const stillPlain = rankPlans(clear, ctx({ favorites: new Set(["fav"]) }));
    expect(vehicleSeq(stillPlain.plans[0])[0]).toBe("plain");
  });

  it("never offers an excluded vehicle", () => {
    const feats = [
      feature(at(100), { device_id: "gone", vehicle_identifier: "gone" }),
      feature(at(900), { device_id: "ok", vehicle_identifier: "ok" }),
    ];
    const res = rankPlans(feats, ctx({ exclude: new Set(["gone"]) }));
    expect(res.plans.concat(res.backups).flatMap(vehicleSeq)).not.toContain("gone");
  });

  it("skips vehicles the feed says are disabled or on hold", () => {
    const feats = [
      feature(at(100), { device_id: "dead", vehicle_identifier: "dead", is_disabled: true }),
      feature(at(150), { device_id: "held", vehicle_identifier: "held", is_reserved: true }),
      feature(at(900), { device_id: "ok", vehicle_identifier: "ok" }),
    ];
    const res = rankPlans(feats, ctx());
    const seen = res.plans.concat(res.backups).flatMap(vehicleSeq);
    expect(seen).not.toContain("dead");
    expect(seen).not.toContain("held");
  });

  it("relaxes monotonically over PLANS, and says what it relaxed", () => {
    // The walk-only plan always exists, so "nothing found" has to mean
    // "nothing to ride" or the ladder would never climb at all.
    const feats = [
      feature(at(300), {
        device_id: "plain",
        vehicle_identifier: "plain",
        battery_percent: 60,
      }),
    ];
    const res = rankPlans(
      feats,
      ctx({ spec: spec({ features: ["basket"], minBattery: 95 }) }),
    );
    expect(rideLegs(res.plans[0]).length).toBeGreaterThan(0);
    expect(res.relaxed.length).toBeGreaterThan(0);
  });

  it("never relaxes a hard must to find a ride", () => {
    const feats = [feature(at(300), { device_id: "plain", vehicle_identifier: "plain" })];
    const res = rankPlans(
      feats,
      ctx({ spec: spec({ features: ["basket"], must: ["features"] }) }),
    );
    // No basket anywhere, and the requirement is hard: walking is the honest
    // answer, not a scooter that fails what the rider insisted on.
    expect(res.plans.every((p) => rideLegs(p).length === 0)).toBe(true);
    expect(res.relaxed).not.toContain("features");
  });
});

describe("rankPlans — purity and labelling", () => {
  it("is pure: identical inputs give an identical ranking", () => {
    const feats = [
      feature(at(100), { device_id: "a", vehicle_identifier: "a" }),
      feature(at(2000), { device_id: "b", vehicle_identifier: "b" }),
    ];
    const a = rankPlans(feats, ctx());
    const b = rankPlans(feats, ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("labels every plan an estimate", () => {
    // §2.3's rule 3 replaces these figures with the routed ones at the moment
    // a decision is made. Until then `reach.ts`'s own words apply: it is an
    // estimate and must be labelled one. NOT a `client <= routed` inequality —
    // the omitted final walk pushes down while the rounded-up detour factor
    // pushes up, and nothing makes them cancel in a known direction.
    const res = rankPlans([feature(at(100), { device_id: "a" })], ctx());
    expect(res.plans.every((p) => p.isEstimate)).toBe(true);
  });

  it("returns at most four plans and keeps the rest as backups", () => {
    const feats = Array.from({ length: 9 }, (_, i) =>
      feature(at(200 + i * 300, (i % 3) * 120), {
        device_id: `v${i}`,
        vehicle_identifier: `v${i}`,
      }),
    );
    const res = rankPlans(feats, ctx({ rate: rate("resident_plus") }));
    expect(res.plans.length).toBeGreaterThan(0);
    expect(res.plans.length).toBeLessThanOrEqual(4);
    // Ranked by generalised cost, best first, across plans and backups.
    const all = res.plans.concat(res.backups).map((p) => p.generalisedCost);
    expect([...all].sort((x, y) => x - y)).toEqual(all);
  });
});

// ---------------------------------------------------------------------------
// The free balance is NET, and must not be debited twice
// ---------------------------------------------------------------------------

describe("freeMinutesLeft against a ride already running", () => {
  const twoVehicles = [
    feature(at(100), { device_id: "cur", vehicle_identifier: "cur" }),
    feature(at(2000), { device_id: "b", vehicle_identifier: "b" }),
  ];

  /** 10 minutes into a ride, 20 free minutes spent before it. §2.2's estimate
   *  counts the live ride up to `now`, so the rider arrives here with 30 left —
   *  `60 - (20 + 10)` — already net. */
  const midRide = {
    inRide: {
      vehicleIdentifier: "cur",
      rangeMeters: 20_000,
      unlockPaid: true as const,
      freeMinutesUsedBeforeRide: 20,
      rideStartedAt: "2026-10-02T11:50:00Z",
    },
    freeMinutesLeft: 30,
  };

  it("still has free minutes to spend mid-ride", () => {
    // THE REGRESSION. `freeBudget` used to subtract `freeMinutesUsedNow` from
    // `freeMinutesLeft`, which double-counts: 30 net minus 30 used is 0, so an
    // equity rider was quoted a paid trip while half their hour remained —
    // the exact error §2.2 exists to correct, one layer down. Nothing caught it
    // because no test combined the equity tier with a live ride.
    const res = rankPlans(twoVehicles, ctx({ rate: rate("equity"), ...midRide }));
    const free = res.plans
      .concat(res.backups)
      .flatMap((p) => p.legs)
      .reduce((n, l) => n + l.freeMinutesUsed, 0);
    expect(free).toBeGreaterThan(0);
  });

  it("prices a mid-ride plan the same as a standing-still rider with the same balance", () => {
    // The balance is the balance. Being mid-ride is not a second debit — it is
    // already inside the figure the caller resolved.
    const riding = rankPlans(twoVehicles, ctx({ rate: rate("equity"), ...midRide }));
    const standing = rankPlans(
      twoVehicles,
      ctx({ rate: rate("equity"), freeMinutesLeft: 30 }),
    );
    const freeOf = (r: { plans: TripPlan[]; backups: TripPlan[] }) =>
      r.plans.concat(r.backups).flatMap((p) => p.legs)
        .reduce((n, l) => n + l.freeMinutesUsed, 0);
    expect(freeOf(riding)).toBeGreaterThan(0);
    expect(freeOf(standing)).toBeGreaterThan(0);
  });

  it("still charges when the balance really is spent", () => {
    // The fix must not become "free minutes forever": a rider whose caller
    // resolved 0 gets no free budget, mid-ride or not.
    const res = rankPlans(
      twoVehicles,
      ctx({ rate: rate("equity"), ...midRide, freeMinutesLeft: 0 }),
    );
    const ridden = res.plans.concat(res.backups).find((p) => rideLegs(p).length > 0)!;
    expect(ridden.legs.every((l) => l.freeMinutesUsed === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rider's own rental is available TO THEM
// ---------------------------------------------------------------------------

describe("a current ride on a vehicle the feed marks reserved", () => {
  /** Veo leaves a rented vehicle in the feed with `is_reserved` set. For every
   *  other vehicle that means "somebody has this one"; for the one under the
   *  rider it means "you do". */
  const current = feature(at(100), {
    device_id: "cur",
    vehicle_identifier: "cur",
    is_reserved: true,
  });
  const other = feature(at(1500), { device_id: "b", vehicle_identifier: "b" });
  const inRide = {
    vehicleIdentifier: "cur",
    rangeMeters: 20_000,
    unlockPaid: true as const,
    freeMinutesUsedBeforeRide: 0,
    rideStartedAt: "2026-10-02T11:55:00Z",
  };

  it("still offers carrying on", () => {
    // THE BUG. `matches()` sets `available = false` for a reserved vehicle, and
    // both `qualifies` and `ideal` gate on it — so the continuation edge was
    // rejected on every mid-ride re-solve. That is precisely the bias its own
    // comment warns about: "without it a re-solve would systematically prefer
    // handing off, because carrying on would not be in the graph to lose".
    const res = rankPlans([current, other], ctx({ inRide }));
    const continuing = res.plans
      .concat(res.backups)
      .find((p) => vehicleSeq(p)[0] === "cur");
    expect(continuing).toBeDefined();
    expect(continuing!.legs[0].unlockCents).toBe(0);
  });

  it("does not make OTHER riders' reserved scooters available", () => {
    // The waiver is scoped to the one vehicle the rider holds. A reserved
    // scooter somebody else has is still not a candidate.
    const someoneElses = feature(at(200), {
      device_id: "theirs",
      vehicle_identifier: "theirs",
      is_reserved: true,
    });
    const res = rankPlans([current, someoneElses, other], ctx({ inRide }));
    const seq = res.plans.concat(res.backups).flatMap((p) => vehicleSeq(p));
    expect(seq).not.toContain("theirs");
  });

  it("still refuses a vehicle the feed calls DISABLED, even under the rider", () => {
    // `is_disabled` is not waived: a feed saying the hardware is broken is not
    // made untrue by the rider's possession of it, and planning a further leg
    // on it would route them onward on a scooter Veo has given up on.
    const broken = feature(at(100), {
      device_id: "cur",
      vehicle_identifier: "cur",
      is_reserved: true,
      is_disabled: true,
    });
    const res = rankPlans([broken, other], ctx({ inRide }));
    const continuing = res.plans
      .concat(res.backups)
      .find((p) => vehicleSeq(p)[0] === "cur");
    expect(continuing).toBeUndefined();
  });

  it("coerces a string flag the same way `matches` does", () => {
    // One fact, one coercion rule. `toCandidates` used `=== true` while
    // `matches` used `truthy`, so a string flag passed one screen and failed
    // the other.
    const stringy = feature(at(1500), {
      device_id: "s",
      vehicle_identifier: "s",
      // THE CAST IS THE POINT. `api.ts` declares this `boolean | null`, so a
      // string is not assignable — but MapLibre flattens booleans in tile
      // encoding and GBFS mirrors have shipped both, which is why `truthy`
      // exists at all. The declared type understates what arrives, and a
      // screen written to the type rather than the wire is the bug.
      is_reserved: "true" as unknown as boolean,
    });
    const res = rankPlans([stringy, other], ctx());
    const seq = res.plans.concat(res.backups).flatMap((p) => vehicleSeq(p));
    expect(seq).not.toContain("s");
  });
});

describe("the favourite bonus is a preference, not a discount", () => {
  it("never drives a leg's cost below zero", () => {
    // MUTATION-VERIFIED HOLE (hermes, PR #94): removing the `Math.max(0, …)`
    // clamp in `priceRide` failed no test in the suite. Dijkstra's correctness
    // depends on non-negative edges, so an unclamped bonus on a very cheap leg
    // is not a mispriced plan — it is a search that can revisit a state at a
    // lower cost forever.
    //
    // The fixture has to make the UNCLAMPED cost negative: a favourite one
    // metre away, free to ride (equity tier inside its free budget, no unlock
    // to pay), so seconds + money ≈ 0 while the bonus is 90s.
    const nearFavorite = feature(at(1), {
      device_id: "fav",
      vehicle_identifier: "fav",
    });
    const res = rankPlans(
      [nearFavorite],
      ctx({
        rate: rate("equity"),
        freeMinutesLeft: 60,
        to: { lat: at(2).lat, lon: at(2).lng },
        // On the CONTEXT, keyed by `vehicleKey` (vehicle_identifier ?? device_id)
        // — not on the spec. An earlier version of this test put it on the spec,
        // where the field does not exist, so nothing was a favourite and the
        // test passed with the clamp removed. It was theatre until tsc said so.
        favorites: new Set(["fav"]),
      }),
    );
    const legs = res.plans.concat(res.backups).flatMap((p) => p.legs);
    expect(legs.length).toBeGreaterThan(0);
    for (const l of legs) {
      expect(l.seconds).toBeGreaterThanOrEqual(0);
    }
    for (const p of res.plans.concat(res.backups)) {
      expect(p.generalisedCost).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("a requirement that binds EVERY leg, starter included", () => {
  // The exact shape of the headline case above, with the roles reversed: the
  // near vehicle is the wrong one and the far vehicle is the right one. That
  // test wants the planner to ride the near Astro as a starter. This one wants
  // it to refuse — because two passengers cannot ride a one-seater, not even
  // for ninety seconds.
  const twoUpSpec = () =>
    spec({
      models: ["apollo"],
      must: ["models"],
      everyLeg: ["models"],
    });

  const fleet = () => [
    feature(at(120), {
      device_id: "cosmo-near",
      vehicle_identifier: "cosmo-near",
      vehicle_model_name: "Cosmo",
    }),
    feature(at(835), {
      device_id: "apollo-far",
      vehicle_identifier: "apollo-far",
      vehicle_model_name: "Apollo",
    }),
  ];

  it("NEVER puts the rider on a non-matching starter", () => {
    const res = rankPlans(fleet(), ctx({ spec: twoUpSpec() }));
    for (const plan of res.plans) {
      for (const leg of rideLegs(plan)) {
        expect(leg.vehicle?.vehicle_model_name, vehicleSeq(plan).join(" → ")).toBe(
          "Apollo",
        );
      }
    }
  });

  it("walks rather than riding the wrong vehicle, even when that leaves nothing to ride", () => {
    // A CONSEQUENCE WORTH STATING, because it is the price of the requirement
    // and not a bug in it. The Apollo here is 835 m away — a fourteen-minute
    // walk, past the twelve-minute cap — so the only way the planner could
    // have reached it was the starter hop this mode forbids. With that gone
    // there is nothing rideable, and the honest answer is the walk.
    //
    // The headline test at the top of this file is the same fleet with the
    // same geometry and gets a two-vehicle plan. The difference is entirely
    // `everyLeg`.
    const res = rankPlans(fleet(), ctx({ spec: twoUpSpec() }));
    for (const plan of res.plans) {
      expect(vehicleSeq(plan)).not.toContain("cosmo-near");
    }
    expect(res.plans.every((p) => rideLegs(p).length === 0)).toBe(true);
  });

  it("rides the matching vehicle when it is close enough to walk to", () => {
    // The other half of the pair: the requirement costs nothing when a
    // matching vehicle is in reach on foot.
    const res = rankPlans(
      [
        feature(at(120), {
          device_id: "cosmo-near",
          vehicle_identifier: "cosmo-near",
          vehicle_model_name: "Cosmo",
        }),
        feature(at(200), {
          device_id: "apollo-near",
          vehicle_identifier: "apollo-near",
          vehicle_model_name: "Apollo",
        }),
      ],
      ctx({ spec: twoUpSpec() }),
    );
    const best = res.plans.find((p) => rideLegs(p).length > 0);
    expect(best).toBeDefined();
    expect(vehicleSeq(best!)).toEqual(["apollo-near"]);
  });

  it("STILL allows a non-matching starter when the field is merely hard", () => {
    // The control. Without `everyLeg` the planner behaves exactly as before —
    // which is the right behaviour for a preference, and the reason the new
    // field had to be opt-in rather than a change to what `must` means.
    const res = rankPlans(
      fleet(),
      ctx({ spec: spec({ models: ["apollo"], must: ["models"] }) }),
    );
    const best = res.plans[0];
    expect(vehicleSeq(best)).toEqual(["cosmo-near", "apollo-far"]);
  });

  it("offers nothing to ride when no vehicle meets the requirement", () => {
    // And the walk-only plan survives, because walking two people somewhere is
    // always possible.
    const res = rankPlans(
      [feature(at(120), { device_id: "cosmo", vehicle_identifier: "cosmo" })],
      ctx({ spec: twoUpSpec() }),
    );
    for (const plan of res.plans) expect(rideLegs(plan)).toHaveLength(0);
    expect(res.walkOnly).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Seeking out an Equity Area swap
//
// THE BUG THIS CLOSES. `route-priority.ts`'s Savings setting can prefer a
// mid-way Equity Area swap among the plans this search returns, but it could
// never conjure one, because the pickup pool is ranked by PROGRESS toward the
// destination and truncated to `bounds.pickups`. The survivors cluster at the
// far end of the trip, so the scooter standing in an area halfway along was
// not ranked low — it was not in the graph. Reserving slots is the only lever
// that changes what the search can see.
// ---------------------------------------------------------------------------
describe("rankPlans — the Equity Area hunt", () => {
  const EQ = INSIDE_EQUITY_AREA;
  const EQ_LNG_M = METERS_PER_DEG_LAT * Math.cos((EQ.lat * Math.PI) / 180);

  /** Metres east/north of the verified in-area point, so the fixture's
   *  geometry is anchored to a real polygon rather than to a rectangle we
   *  invented — the same reason `withEquityAreas` loads the city's own file. */
  const nearEq = (eastMeters: number, northMeters = 0) => ({
    lat: EQ.lat + northMeters / METERS_PER_DEG_LAT,
    lng: EQ.lng + eastMeters / EQ_LNG_M,
  });

  const FROM = nearEq(-2000);
  const TO = nearEq(2000);

  /** A starter by the rider, two vehicles bunched near the destination, and
   *  one standing IN the area at the midpoint. With `pickups: 2` the two
   *  near-destination vehicles win the pool on progress and the area vehicle
   *  is squeezed out — which is the production case in miniature. */
  const fleet = () => [
    feature(nearEq(-1950), { device_id: "starter", vehicle_identifier: "starter" }),
    feature(EQ, { device_id: "in-area", vehicle_identifier: "in-area" }),
    feature(nearEq(1800), { device_id: "near-dest-1", vehicle_identifier: "near-dest-1" }),
    feature(nearEq(1850), { device_id: "near-dest-2", vehicle_identifier: "near-dest-2" }),
  ];

  const eqCtx = (over: Partial<RankPlansContext> = {}) =>
    ctx({
      from: FROM,
      to: { lat: TO.lat, lon: TO.lng },
      bounds: { firstHops: 8, pickups: 2 },
      ...over,
    });

  const everyVehicle = (res: { plans: TripPlan[]; backups: TripPlan[] }) =>
    [...res.plans, ...res.backups].flatMap(vehicleSeq);

  it("leaves the area vehicle out of the graph when nobody asked", async () => {
    await withEquityAreas();
    const res = rankPlans(fleet(), eqCtx());
    expect(res.equityPickups).toBe(0);
    // Not merely unchosen — unreachable. No plan, not even a backup, can ride
    // a vehicle the selection never put in the pool.
    expect(everyVehicle(res)).not.toContain("in-area");
  });

  it("reserves it a slot when the rider asked for Savings", async () => {
    await withEquityAreas();
    const res = rankPlans(fleet(), eqCtx({ seekEquitySwaps: true }));
    expect(res.equityPickups).toBe(1);
    expect(everyVehicle(res)).toContain("in-area");
  });

  it("earns the discount on BOTH legs of the swap it found", async () => {
    // The whole point of a MID-WAY swap, and why it is worth spending a
    // pickup slot on: `legRate` discounts a leg when EITHER endpoint is in an
    // area, so a swap inside one pays off twice. A plan that merely ends in
    // an area collects once.
    await withEquityAreas();
    const res = rankPlans(fleet(), eqCtx({ seekEquitySwaps: true }));
    const through = [...res.plans, ...res.backups].find((p) =>
      vehicleSeq(p).includes("in-area"),
    )!;
    expect(through).toBeTruthy();
    const ridden = rideLegs(through);
    expect(ridden.length).toBeGreaterThanOrEqual(2);
    expect(ridden.every((l) => l.equityArea)).toBe(true);
  });

  it("spends the budget it was given, never more", async () => {
    // `bounds.pickups` is a performance envelope the candidates response may
    // narrow. Growing the pool to fit the hunt would be this module quietly
    // overruling the server that set it.
    await withEquityAreas();
    const res = rankPlans(fleet(), eqCtx({ seekEquitySwaps: true }));
    const pickedUp = new Set(everyVehicle(res));
    pickedUp.delete("starter");
    expect(pickedUp.size).toBeLessThanOrEqual(2);
  });

  it("does not hunt for a tier that gets no area discount", async () => {
    // `legRate` hands the Access tier its own rate and never the area one, so
    // there is no discount here to find and the slot would be spent on
    // nothing.
    await withEquityAreas();
    const res = rankPlans(
      fleet(),
      eqCtx({ seekEquitySwaps: true, rate: rate("equity"), freeMinutesLeft: 0 }),
    );
    expect(res.equityPickups).toBe(0);
  });

  it("reports no hunt when the polygons are not loaded", () => {
    // `isInEquityArea` is THREE-VALUED: null until the map loads. This file
    // already carries a scar from reading that as "outside" — a test asserted
    // the area rate while exercising the outside path. Null means WE COULD
    // NOT LOOK, so nothing is reserved and nothing is claimed.
    const res = rankPlans(fleet(), eqCtx({ seekEquitySwaps: true }));
    expect(res.equityPickups).toBe(0);
  });

  it("never spends more pickups than the budget, however many areas there are", async () => {
    // REVIEWER'S FINDING, and it bites harder than a count: `reserve` was
    // capped at EQUITY_PICKUP_QUOTA (4) but not at the budget, so with
    // `pickups: 2` and four eligible area vehicles the slice became
    // `byProgress.slice(0, 2 - 4)` — and a NEGATIVE end index is read from
    // the end in JS, so it silently returned []. The pool came back with
    // four entries against a budget of two, and every progress-ranked pickup
    // was evicted: no vehicle near the destination survived at all.
    await withEquityAreas();
    const crowded = [
      feature(nearEq(-1950), { device_id: "starter", vehicle_identifier: "starter" }),
      feature(nearEq(-100), { device_id: "area-1", vehicle_identifier: "area-1" }),
      feature(EQ, { device_id: "area-2", vehicle_identifier: "area-2" }),
      feature(nearEq(100), { device_id: "area-3", vehicle_identifier: "area-3" }),
      feature(nearEq(200), { device_id: "area-4", vehicle_identifier: "area-4" }),
      feature(nearEq(1800), { device_id: "near-dest-1", vehicle_identifier: "near-dest-1" }),
      feature(nearEq(1850), { device_id: "near-dest-2", vehicle_identifier: "near-dest-2" }),
    ];
    const res = rankPlans(crowded, eqCtx({ seekEquitySwaps: true }));

    expect(res.equityPickups).toBeLessThanOrEqual(2);
    const ridden = new Set(everyVehicle(res));
    ridden.delete("starter");
    expect(ridden.size).toBeLessThanOrEqual(2);
    // And the hunt never takes the pool over entirely: a plan still has to be
    // able to REACH the destination, which is what the progress ranking is
    // for. One survivor is the floor.
    expect([...ridden].some((v) => v.startsWith("near-dest"))).toBe(true);
  });

  it("does not displace the pool when there is nothing in an area", async () => {
    await withEquityAreas();
    const noArea = [
      feature(nearEq(-1950), { device_id: "starter", vehicle_identifier: "starter" }),
      feature(nearEq(1800), { device_id: "near-dest-1", vehicle_identifier: "near-dest-1" }),
      feature(nearEq(1850), { device_id: "near-dest-2", vehicle_identifier: "near-dest-2" }),
    ];
    const hunted = rankPlans(noArea, eqCtx({ seekEquitySwaps: true }));
    const plain = rankPlans(noArea, eqCtx());
    expect(hunted.equityPickups).toBe(0);
    expect(everyVehicle(hunted)).toEqual(everyVehicle(plain));
  });
});
