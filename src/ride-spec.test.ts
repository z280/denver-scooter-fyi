import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_WALK_MINUTES,
  FEATURE_RELAX_ORDER,
  defaultSpec,
  fromFilterSnapshot,
  matches,
  readSpec,
  relax,
  relaxationLadder,
  toFilterSnapshot,
  widenModelsToPosture,
  writeSpec,
  type RideSpec,
} from "./ride-spec.ts";
import type { DeviceProperties } from "./api.ts";
import type { FilterSnapshot } from "./filter-presets.ts";
import { ALL_MODELS } from "./model-catalog.ts";

// A device the way the wire actually delivers one: `device_features` may be a
// JSON STRING (MapLibre flattens properties), and an unconfirmed feature is
// null rather than false.
function device(over: Partial<DeviceProperties> = {}): DeviceProperties {
  return {
    device_id: "d1",
    vehicle_model_name: "Cosmo",
    reliability_tier: "ok",
    battery_percent: 80,
    current_range_meters: 20_000,
    ...over,
  } as DeviceProperties;
}

function spec(over: Partial<RideSpec> = {}): RideSpec {
  return { ...defaultSpec(), ...over };
}

const HERE = { lat: 39.7392, lng: -104.9903 };
const THERE = { lat: 39.7508, lon: -104.9966 };

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------
describe("availability", () => {
  it("is not a spec field and cannot be relaxed away", () => {
    const m = matches(device({ is_reserved: true }), spec());
    expect(m.available).toBe(false);
    expect(m.qualifies).toBe(false);
    expect(m.unmet).toEqual([]); // it failed nothing the rider asked for
    expect(relaxationLadder(spec()).length).toBe(0);
  });

  it("treats a disabled vehicle the same as one in use", () => {
    expect(matches(device({ is_disabled: true }), spec()).qualifies).toBe(false);
  });

  it("reads the string flags MapLibre property flattening produces", () => {
    // Flattened properties arrive as strings; a truthiness test that only
    // knew about booleans would offer a rider a scooter somebody is on.
    const m = matches(device({ is_reserved: "true" as unknown as boolean }), spec());
    expect(m.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown never satisfies a requirement
// ---------------------------------------------------------------------------
describe("unknown never satisfies a requirement", () => {
  it("rejects an unconfirmed feature exactly as it rejects a confirmed absence", () => {
    const required = spec({ features: ["basket"] });
    const unconfirmed = matches(device({ device_features: null }), required);
    const confirmedNo = matches(
      device({ device_features: { bell: true, basket: false } }),
      required,
    );
    expect(unconfirmed.unmet).toEqual(["features"]);
    expect(confirmedNo.unmet).toEqual(["features"]);
  });

  it("accepts a confirmed present feature", () => {
    const m = matches(
      device({ device_features: { basket: true } }),
      spec({ features: ["basket"] }),
    );
    expect(m.ideal).toBe(true);
  });

  it("rejects mystery hardware against a model requirement", () => {
    // The one place this module reads a device differently from the map,
    // which keeps unrecognized models visible when one is toggled off.
    const m = matches(
      device({ vehicle_model_name: "hoverboard" }),
      spec({ models: ["cosmo"] }),
    );
    expect(m.unmet).toEqual(["models"]);
  });

  it("rejects a missing battery reading against a floor", () => {
    const m = matches(
      device({ battery_percent: undefined }),
      spec({ minBattery: 40 }),
    );
    expect(m.unmet).toEqual(["min_battery"]);
  });

  it("does not apply a battery floor of zero", () => {
    expect(
      matches(device({ battery_percent: undefined }), spec()).unmet,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Quality — the map's predicate, exactly
// ---------------------------------------------------------------------------
describe("minQuality", () => {
  it("ok-only wants exactly ok", () => {
    const s = spec({ minQuality: "ok-only" });
    expect(matches(device({ reliability_tier: "ok" }), s).unmet).toEqual([]);
    expect(matches(device({ reliability_tier: "unknown" }), s).unmet).toEqual([
      "min_quality",
    ]);
    expect(matches(device({ reliability_tier: undefined }), s).unmet).toEqual([
      "min_quality",
    ]);
  });

  it("no-risk excludes only risk, so an absent tier survives it", () => {
    const s = spec({ minQuality: "no-risk" });
    expect(matches(device({ reliability_tier: "unknown" }), s).unmet).toEqual([]);
    expect(matches(device({ reliability_tier: undefined }), s).unmet).toEqual([]);
    expect(matches(device({ reliability_tier: "risk" }), s).unmet).toEqual([
      "min_quality",
    ]);
  });
});

// ---------------------------------------------------------------------------
// mustReach — a negative screen, not a positive claim
// ---------------------------------------------------------------------------
describe("mustReach", () => {
  const s = spec({ mustReach: true });

  it("passes a vehicle whose range the feed never reported", () => {
    // Deliberately unlike the equipment requirements: the question is
    // whether we KNOW it cannot make it, and silence is not that knowledge.
    const m = matches(
      device({ current_range_meters: undefined }),
      s,
      { at: HERE, dest: THERE },
    );
    expect(m.unmet).toEqual([]);
  });

  it("fails a vehicle that plainly cannot make it", () => {
    const m = matches(device({ current_range_meters: 50 }), s, {
      at: HERE,
      dest: THERE,
    });
    expect(m.unmet).toEqual(["must_reach"]);
  });

  it("does nothing without a destination", () => {
    expect(matches(device({ current_range_meters: 50 }), s).unmet).toEqual([]);
  });

  it("is hard even when the rider never listed it in must", () => {
    const m = matches(device({ current_range_meters: 50 }), s, {
      at: HERE,
      dest: THERE,
    });
    expect(m.unmetMust).toEqual(["must_reach"]);
    expect(m.qualifies).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// must vs prefer
// ---------------------------------------------------------------------------
describe("must vs prefer", () => {
  const bare = device({ device_features: null, battery_percent: 10 });

  it("a preference is reported but does not disqualify", () => {
    const m = matches(bare, spec({ features: ["basket"], minBattery: 50 }));
    expect(m.unmet.sort()).toEqual(["features", "min_battery"]);
    expect(m.unmetMust).toEqual([]);
    expect(m.qualifies).toBe(true);
    expect(m.ideal).toBe(false);
  });

  it("a must disqualifies", () => {
    const m = matches(
      bare,
      spec({ features: ["basket"], minBattery: 50, must: ["features"] }),
    );
    expect(m.unmetMust).toEqual(["features"]);
    expect(m.qualifies).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------
describe("relaxationLadder", () => {
  it("never offers to relax a must", () => {
    const s = spec({
      minBattery: 50,
      features: ["basket", "bell"],
      models: ["cosmo"],
      minQuality: "ok-only",
      must: ["min_battery", "features", "models", "min_quality"],
    });
    expect(relaxationLadder(s)).toEqual([]);
  });

  it("never offers to relax mustReach, hard or not", () => {
    const s = spec({ mustReach: true });
    expect(relaxationLadder(s).some((r) => r.field === "must_reach")).toBe(false);
  });

  it("never drops quality below no-risk", () => {
    const s = spec({ minQuality: "ok-only" });
    const fully = relax(s, 99);
    expect(fully.minQuality).toBe("no-risk");
    // And there is no further rung to climb from there.
    expect(relaxationLadder(fully)).toEqual([]);
  });

  it("gives up equipment one at a time, cheapest first", () => {
    const s = spec({ features: ["basket", "bell", "cup_holder"] });
    const steps = relaxationLadder(s).filter((r) => r.field === "features");
    expect(steps.map((r) => r.feature)).toEqual(["cup_holder", "bell", "basket"]);
    expect(relax(s, 1).features).toEqual(["basket", "bell"]);
    expect(relax(s, 2).features).toEqual(["basket"]);
    expect(relax(s, 3).features).toEqual([]);
  });

  it("puts the battery floor before equipment, and quality last", () => {
    const s = spec({
      minBattery: 60,
      features: ["basket"],
      minQuality: "ok-only",
    });
    expect(relaxationLadder(s).map((r) => r.field)).toEqual([
      "min_battery",
      "features",
      "min_quality",
    ]);
  });

  it("widens a model requirement to the same posture and no further", () => {
    const s = spec({ models: ["cosmo"] });
    const widened = relax(s, 99).models;
    expect(widened).toEqual(["cosmo", "apollo", "trike"]);
    expect(widened).not.toContain("astro");
  });

  it("offers no model rung when the choice already spans its posture", () => {
    const s = spec({ models: ["cosmo", "apollo", "trike"] });
    expect(relaxationLadder(s).some((r) => r.field === "models")).toBe(false);
  });

  it("offers no model rung for a spec that takes anything", () => {
    expect(relaxationLadder(spec()).length).toBe(0);
  });
});

describe("relax is monotonic", () => {
  // The property a search depends on when it climbs until it has enough
  // candidates: rung n+1 must admit every vehicle rung n admits. A ladder
  // that could narrow would make a search skip a vehicle it had already
  // accepted, or loop.
  const fleet: DeviceProperties[] = [
    device({ vehicle_model_name: "Astro", battery_percent: 90, device_features: { basket: true } }),
    device({ vehicle_model_name: "Cosmo", battery_percent: 20, device_features: null }),
    device({ vehicle_model_name: "Apollo", battery_percent: 55, reliability_tier: "unknown" }),
    device({ vehicle_model_name: "Rover", battery_percent: 70, device_features: { bell: true } }),
    device({ vehicle_model_name: "hoverboard", battery_percent: 99 }),
  ];

  it("admits a growing set at every rung", () => {
    const s = spec({
      models: ["cosmo"],
      features: ["basket", "cup_holder"],
      minBattery: 60,
      minQuality: "ok-only",
      must: [],
    });
    const ladder = relaxationLadder(s);
    let previous = new Set<string>();
    for (let rung = 0; rung <= ladder.length; rung += 1) {
      const admitted = new Set(
        fleet
          .filter((d) => matches(d, relax(s, rung)).ideal)
          .map((d) => d.vehicle_model_name ?? "?"),
      );
      for (const was of previous) {
        expect(admitted.has(was), `rung ${rung} dropped ${was}`).toBe(true);
      }
      previous = admitted;
    }
  });

  it("bottoms out rather than running off the end", () => {
    const s = spec({ minBattery: 60, features: ["bell"] });
    expect(relax(s, 99)).toEqual(relax(s, relaxationLadder(s).length));
  });

  it("relax(spec, 0) is the spec as written", () => {
    const s = spec({ minBattery: 60, features: ["bell"], models: ["astro"] });
    expect(relax(s, 0)).toEqual(s);
  });
});

// ---------------------------------------------------------------------------
// The map bridge
// ---------------------------------------------------------------------------
const CURRENT: FilterSnapshot = {
  rideTypes: ["sitting", "standing"],
  models: ["astro"],
  knownModels: ["astro"],
  features: [],
  hideUnavailable: false,
  minBattery: 0,
  quality: "any",
  area: { layer: "neighborhood", subset: ["Baker"] },
};

describe("toFilterSnapshot", () => {
  const s = spec({
    models: ["cosmo"],
    features: ["basket"],
    minBattery: 40,
    minQuality: "no-risk",
  });

  it("projects every field the map can express", () => {
    const snap = toFilterSnapshot(s, CURRENT);
    expect(snap.models).toEqual(["cosmo"]);
    expect(snap.features).toEqual(["basket"]);
    expect(snap.minBattery).toBe(40);
    expect(snap.quality).toBe("no-risk");
  });

  it("carries map-only state through untouched", () => {
    const snap = toFilterSnapshot(s, CURRENT);
    expect(snap.area).toEqual(CURRENT.area);
    expect(snap.rideTypes).toEqual(CURRENT.rideTypes);
  });

  it("forces hideUnavailable on", () => {
    // Availability is the one requirement a spec never relaxes, so a view
    // labelled "your ideal scooters" that included one somebody is riding
    // would be a false label.
    expect(toFilterSnapshot(s, CURRENT).hideUnavailable).toBe(true);
  });

  it("turns 'any model' into every model rather than none", () => {
    const snap = toFilterSnapshot(spec(), CURRENT);
    expect([...snap.models].sort()).toEqual([...ALL_MODELS].sort());
  });

  it("stamps the current line-up as knownModels", () => {
    // A snapshot claiming to know only some of today's models would have
    // every later model default back ON when applied (`effectiveModels`) —
    // right for a preset saved last year, wrong for one generated a moment
    // ago from a spec that deliberately excludes them.
    expect([...toFilterSnapshot(s, CURRENT).knownModels!].sort()).toEqual(
      [...ALL_MODELS].sort(),
    );
  });

  it("does not mutate the spec or the current snapshot", () => {
    const before = JSON.stringify([s, CURRENT]);
    toFilterSnapshot(s, CURRENT);
    expect(JSON.stringify([s, CURRENT])).toBe(before);
  });
});

describe("fromFilterSnapshot", () => {
  it("brings everything back as a preference, never a must", () => {
    const seeded = fromFilterSnapshot({
      ...CURRENT,
      models: ["cosmo"],
      features: ["bell"],
      minBattery: 30,
      quality: "ok-only",
    });
    expect(seeded.must).toEqual([]);
    expect(seeded.features).toEqual(["bell"]);
    expect(seeded.minBattery).toBe(30);
    expect(seeded.minQuality).toBe("ok-only");
  });

  it("reads an all-models selection as 'any', not as an exhaustive list", () => {
    // The difference matters the day a model joins the fleet: `null` includes
    // it, a list of today's four does not.
    const seeded = fromFilterSnapshot({ ...CURRENT, models: [...ALL_MODELS] });
    expect(seeded.models).toBeNull();
  });

  it("defaults the three fields the map cannot express", () => {
    const seeded = fromFilterSnapshot(CURRENT);
    expect(seeded.mustReach).toBe(false);
    expect(seeded.maxWalkMinutes).toBe(DEFAULT_MAX_WALK_MINUTES);
    expect(seeded.must).toEqual([]);
  });

  it("round-trips the map-representable half of a spec", () => {
    const s = spec({
      models: ["cosmo", "apollo"],
      features: ["basket", "bell"],
      minBattery: 45,
      minQuality: "no-risk",
      mustReach: true,
      must: ["features"],
    });
    const back = fromFilterSnapshot(toFilterSnapshot(s, CURRENT));
    expect(back.models).toEqual(s.models);
    expect(back.features).toEqual(s.features);
    expect(back.minBattery).toBe(s.minBattery);
    expect(back.minQuality).toBe(s.minQuality);
    // ...and loses the half it cannot carry, which is why this is not the
    // inverse of toFilterSnapshot and must never be used as one.
    expect(back.mustReach).toBe(false);
    expect(back.must).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
describe("readSpec", () => {
  it("round-trips a written spec", () => {
    const s = spec({
      models: ["cosmo"],
      features: ["basket"],
      minBattery: 40,
      minQuality: "no-risk",
      mustReach: true,
      maxWalkMinutes: 9,
      must: ["features", "must_reach"],
    });
    expect(readSpec(writeSpec(s))).toEqual(s);
  });

  it("degrades a corrupt blob to a usable spec rather than throwing", () => {
    // The server stores this verbatim and never looks inside, so the client
    // is the only thing between a hand-edited blob and a search that
    // silently accepts nothing.
    expect(readSpec({ models: "cosmo", features: 7, min_battery: "lots" })).toEqual(
      { ...defaultSpec(), models: null },
    );
    expect(readSpec(null)).toBeNull();
    expect(readSpec("nope")).toBeNull();
    expect(readSpec([])).toEqual({ ...defaultSpec(), models: null });
  });

  it("drops vocabulary it does not recognize instead of keeping it", () => {
    const read = readSpec({
      models: ["cosmo", "hoverboard"],
      features: ["basket", "ejector_seat"],
      must: ["features", "vibes"],
      min_quality: "extremely-good",
    });
    expect(read!.models).toEqual(["cosmo"]);
    expect(read!.features).toEqual(["basket"]);
    expect(read!.must).toEqual(["features"]);
    expect(read!.minQuality).toBe("any");
  });

  it("clamps a battery floor into range", () => {
    expect(readSpec({ min_battery: 900 })!.minBattery).toBe(100);
    expect(readSpec({ min_battery: -5 })!.minBattery).toBe(0);
  });

  it("writes snake_case only, with no local fields riding along", () => {
    const written = writeSpec(spec());
    expect(Object.keys(written).sort()).toEqual([
      "features",
      "max_walk_minutes",
      "min_battery",
      "min_quality",
      "models",
      "must",
      "must_reach",
    ]);
  });
});

describe("widenModelsToPosture", () => {
  it("returns null when there is nothing to widen to", () => {
    expect(widenModelsToPosture(["astro"])).toBeNull();
    expect(widenModelsToPosture([])).toBeNull();
  });

  it("covers both postures when the choice already spans them", () => {
    expect(widenModelsToPosture(["astro", "cosmo"])?.sort()).toEqual(
      [...ALL_MODELS].sort(),
    );
  });
});

describe("FEATURE_RELAX_ORDER", () => {
  it("covers every filterable feature, so no requirement is unrelaxable by omission", () => {
    const s = spec({ features: [...FEATURE_RELAX_ORDER] });
    expect(relax(s, 99).features).toEqual([]);
  });
});
