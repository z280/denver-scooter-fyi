// §2.4's list, as text. Every claim here is one the rider acts on — which
// scooter to walk to, how long it takes, what it costs — so the assertions are
// against the wording and the arithmetic, not against "it rendered".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type {
  RankPlansResult,
  TripLeg,
  TripPlan,
} from "./along-the-way.ts";
import type { DeviceProperties } from "./api.ts";
import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import {
  ESTIMATE_NOTE,
  RELAXED_FIELD_LABEL,
  RISK_WARNING,
  planHeadline,
  planLegLines,
  planListView,
  savingBaseline,
} from "./plan-list.ts";
import { SPEC_FIELDS } from "./ride-spec.ts";

const rate = (key: RatePlanKey) => RATE_PLANS.find((p) => p.key === key)!;

function vehicle(over: Partial<DeviceProperties> = {}): DeviceProperties {
  return {
    device_id: "d1",
    public_name: "Lunar 🐸",
    plate_suffix: "928",
    vehicle_model_name: "Cosmo",
    vehicle_identifier: "v1",
    ...over,
  } as DeviceProperties;
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

function ride(over: Partial<TripLeg> = {}): TripLeg {
  return {
    mode: "ride",
    seconds: 600,
    meters: 3000,
    vehicle: vehicle(),
    unlockCents: 100,
    minuteCents: 250,
    taxCents: 0,
    freeMinutesUsed: 0,
    equityArea: false,
    ...over,
  };
}

function plan(legs: TripLeg[]): TripPlan {
  let totalSeconds = 0;
  let estimatedCents = 0;
  let rides = 0;
  for (const l of legs) {
    totalSeconds += l.seconds;
    estimatedCents += l.unlockCents + l.minuteCents + l.taxCents;
    if (l.mode === "ride") rides += 1;
  }
  return {
    legs,
    totalSeconds,
    estimatedCents,
    handOffs: Math.max(0, rides - 1),
    generalisedCost: totalSeconds,
    isEstimate: true,
  };
}

const walkOnly = plan([walk(3600)]);

function result(over: Partial<RankPlansResult> = {}): RankPlansResult {
  return {
    plans: [],
    backups: [],
    relaxed: [],
    riskTierOffered: false,
    walkOnly,
    capRelaxed: false,
    ...over,
  };
}

describe("planHeadline", () => {
  it("counts scooters and hand-offs, and names the walk for what it is", () => {
    expect(planHeadline(walkOnly)).toBe("Walk the whole way");
    expect(planHeadline(plan([walk(240), ride()]))).toBe("One scooter");
    expect(planHeadline(plan([walk(240), ride(), ride()]))).toBe(
      "Two scooters, one hand-off",
    );
    expect(planHeadline(plan([walk(240), ride(), ride(), ride()]))).toBe(
      "3 scooters, 2 hand-offs",
    );
  });
});

describe("planLegLines", () => {
  it("walks the rider to the first vehicle by name, then rides to the door", () => {
    const lines = planLegLines(plan([walk(240), ride()]), "Union Station");
    expect(lines.map((l) => l.text)).toEqual([
      "Walk 4 min to Lunar 🐸 928",
      "Ride Lunar 🐸 928 10 min to Union Station",
    ]);
  });

  it("names the hand-off target on the leg that ends at it", () => {
    // The structural fact the wording rests on: a hand-off lands ON the next
    // vehicle, with no walk leg between. So the FIRST ride ends at the second
    // scooter, not at a parking spot.
    const second = vehicle({
      device_id: "d2",
      public_name: "Comet 🦊",
      plate_suffix: "104",
      vehicle_identifier: "v2",
    });
    const lines = planLegLines(
      plan([walk(240), ride(), ride({ vehicle: second })]),
      "Union Station",
    );
    expect(lines.map((l) => l.text)).toEqual([
      "Walk 4 min to Lunar 🐸 928",
      "Ride Lunar 🐸 928 10 min to Comet 🦊 104",
      "Ride Comet 🦊 104 10 min to Union Station",
    ]);
  });

  it("sends the walk-only plan to the destination, not to a vehicle", () => {
    expect(planLegLines(walkOnly, "Union Station")[0].text).toBe(
      "Walk 60 min to Union Station",
    );
  });

  it("falls back to a phrase, never to an empty name, with no destination", () => {
    expect(planLegLines(walkOnly, null)[0].text).toBe(
      "Walk 60 min to your destination",
    );
    expect(planLegLines(walkOnly, "")[0].text).toBe(
      "Walk 60 min to your destination",
    );
  });

  it("rounds a sub-minute leg up to 1, never down to 0", () => {
    expect(planLegLines(plan([walk(20)]), "there")[0].text).toBe("Walk 1 min to there");
  });

  it("still describes a ride whose vehicle payload is missing", () => {
    // `TripLeg.vehicle` is optional, and a line reading "Ride undefined" is
    // worse than one that simply does not name the scooter.
    const lines = planLegLines(plan([ride({ vehicle: undefined })]), "there");
    expect(lines[0].text).toBe("Ride 10 min to there");
    expect(lines[0].vehicleName).toBeUndefined();
  });

  it("starts on a ride for a mid-ride re-solve, with no phantom walk", () => {
    const lines = planLegLines(plan([ride({ unlockCents: 0 })]), "there");
    expect(lines).toHaveLength(1);
    expect(lines[0].mode).toBe("ride");
  });
});

describe("savingBaseline", () => {
  const ordinary = plan([walk(120), ride()]);
  const equity = plan([
    walk(240),
    ride({ equityArea: true, unlockCents: 100, minuteCents: 130 }),
  ]);

  it("is the best-ranked plan that rides something and is not itself discounted", () => {
    expect(savingBaseline(result({ plans: [equity, ordinary] }))).toBe(ordinary);
  });

  it("is never the walk-only plan, which would make every discount a loss", () => {
    // $0 is not the ordinary price of riding; it is the price of not riding.
    expect(savingBaseline(result({ plans: [walkOnly, equity] }))).toBeNull();
  });

  it("reaches into backups, because the ordinary price does not change at rank five", () => {
    expect(savingBaseline(result({ plans: [equity], backups: [ordinary] }))).toBe(
      ordinary,
    );
  });

  it("is null when every way to ride this trip is discounted", () => {
    expect(savingBaseline(result({ plans: [equity] }))).toBeNull();
  });
});

describe("planListView", () => {
  it("identifies the walk row by its SHAPE, not by object identity", () => {
    // `plan === result.walkOnly` happens to hold today and is the wrong thing to
    // depend on: anything that copies or re-wraps a plan on the way out turns it
    // false, and the symptom is not a missing label — the panel then renders a
    // "Take this one" button on a row with no vehicle to walk to.
    const copy = { ...walkOnly, legs: [...walkOnly.legs] };
    const v = planListView({
      result: result({ plans: [copy], walkOnly }),
      rate: rate("resident"),
    });
    expect(v.rows[0].plan).not.toBe(walkOnly);
    expect(v.rows[0].isWalkOnly).toBe(true);
    expect(v.rows[0].firstVehicle).toBeNull();
  });

  it("returns exactly as many rows as there are plans — one is the floor", () => {
    // MAX_PLANS is a cap, never a quota. A list padded to two either
    // fabricates the second or implies one exists.
    const only = planListView({ result: result({ plans: [walkOnly] }), rate: rate("resident") });
    expect(only.rows).toHaveLength(1);
    expect(only.rows[0].isWalkOnly).toBe(true);
    expect(only.rows[0].firstVehicle).toBeNull();

    expect(planListView({ result: result(), rate: rate("resident") }).rows).toEqual([]);
  });

  it("shows the cost with every unlock in it", () => {
    // Two scooters, two unlocks. A list that showed one would under-quote
    // exactly the plan this phase exists to offer.
    const twoUnlocks = plan([walk(120), ride(), ride({ vehicle: vehicle({ device_id: "d2" }) })]);
    const v = planListView({ result: result({ plans: [twoUnlocks] }), rate: rate("resident") });
    expect(v.rows[0].costLabel).toBe("$7.00");
    expect(v.rows[0].minutesLabel).toBe("22 min");
  });

  it("hands the first vehicle out, which is what the walk flow needs", () => {
    const p = plan([walk(120), ride()]);
    const v = planListView({ result: result({ plans: [p] }), rate: rate("resident") });
    expect(v.rows[0].firstVehicle?.vehicle_identifier).toBe("v1");
  });

  it("chips the equity saving against the undiscounted plan, and discloses", () => {
    const ordinary = plan([walk(120), ride()]);
    const equity = plan([
      walk(240),
      ride({ equityArea: true, unlockCents: 100, minuteCents: 130 }),
    ]);
    const v = planListView({
      result: result({ plans: [equity, ordinary] }),
      rate: rate("resident"),
    });
    const chip = v.rows[0].chips.find((c) => c.kind === "equity_saving")!;
    expect(chip.text).toBe("Starts in an Equity Area · saves $1.20 · 2 min more walking");
    // §5.2: the disclosures travel with the plan, not on a card of their own.
    expect(v.rows[0].disclosures.map((d) => d.kind)).toContain("screenshot");
    expect(v.rows[0].disclosures.map((d) => d.kind)).toContain("second_unlock");
    // The undiscounted row carries neither.
    expect(v.rows[1].chips.some((c) => c.kind === "equity_saving")).toBe(false);
    expect(v.rows[1].disclosures).toEqual([]);
  });

  it("leaves the walking clause off a saving that costs no extra walking", () => {
    const ordinary = plan([walk(240), ride()]);
    const equity = plan([
      walk(240),
      ride({ equityArea: true, unlockCents: 100, minuteCents: 130 }),
    ]);
    const v = planListView({
      result: result({ plans: [equity, ordinary] }),
      rate: rate("resident"),
    });
    expect(v.rows[0].chips[0].text).toBe("Starts in an Equity Area · saves $1.20");
  });

  it("flags a plan that starts on a flagged scooter, per plan", () => {
    const risky = plan([walk(120), ride({ vehicle: vehicle({ reliability_tier: "risk" }) })]);
    const fine = plan([walk(120), ride()]);
    const v = planListView({
      result: result({ plans: [risky, fine], riskTierOffered: true }),
      rate: rate("resident"),
    });
    expect(v.rows[0].chips.some((c) => c.kind === "risk")).toBe(true);
    expect(v.rows[1].chips.some((c) => c.kind === "risk")).toBe(false);
    // high_risk is worse than risk, not better — it must flag too.
    const worse = plan([walk(120), ride({ vehicle: vehicle({ reliability_tier: "high_risk" }) })]);
    const v2 = planListView({ result: result({ plans: [worse] }), rate: rate("resident") });
    expect(v2.rows[0].chips.some((c) => c.kind === "risk")).toBe(true);
  });

  it("warns at the list level only when the fallback actually fired", () => {
    // `riskTierOffered` is a property of the SEARCH having had to fall back,
    // not of a tier appearing — so it is read, never re-derived off the legs.
    expect(
      planListView({ result: result({ plans: [walkOnly] }), rate: rate("resident") })
        .riskWarning,
    ).toBeNull();
    expect(
      planListView({
        result: result({ plans: [walkOnly], riskTierOffered: true }),
        rate: rate("resident"),
      }).riskWarning,
    ).toBe(RISK_WARNING);
  });

  it("says which free minutes a plan spends, for the one tier that has any", () => {
    const freeRide = plan([
      walk(120),
      ride({ unlockCents: 0, minuteCents: 0, freeMinutesUsed: 10 }),
    ]);
    const v = planListView({ result: result({ plans: [freeRide] }), rate: rate("equity") });
    expect(v.rows[0].chips.find((c) => c.kind === "free_minutes")!.text).toBe(
      "Uses 10 of today's free minutes",
    );
  });

  it("discloses relaxations in the ladder's order, and the cap separately", () => {
    const v = planListView({
      result: result({
        plans: [plan([walk(120), ride()])],
        relaxed: ["features", "min_battery"],
        capRelaxed: true,
      }),
      rate: rate("resident"),
    });
    expect(v.relaxedLabels).toEqual(["Equipment", "Battery"]);
    expect(v.capRelaxed).toBe(true);
  });

  it("states the estimate once, above the list, not on every row", () => {
    const v = planListView({
      result: result({ plans: [plan([walk(120), ride()]), plan([walk(130), ride()])] }),
      rate: rate("resident"),
    });
    expect(v.estimateNote).toBe(ESTIMATE_NOTE);
    // No ROW carries the note. Asserted on the note's own prose rather than on
    // the word "estimate", which `estimatedCents` and `isEstimate` both contain
    // — the first version of this test failed on its own fixture's field names.
    expect(JSON.stringify(v.rows)).not.toContain("estimates");
    for (const row of v.rows) {
      expect(row.chips.some((c) => c.text === ESTIMATE_NOTE)).toBe(false);
      expect(row.disclosures.some((d) => d.text === ESTIMATE_NOTE)).toBe(false);
    }
  });
});

describe("the relaxation labels stay in step with the spec sheet's", () => {
  it("covers every SpecField", () => {
    // A field added to the ladder without a label here renders as "undefined"
    // in a disclosure about what the rider gave up.
    for (const f of SPEC_FIELDS) {
      expect(RELAXED_FIELD_LABEL[f]).toBeTruthy();
    }
    expect(Object.keys(RELAXED_FIELD_LABEL).sort()).toEqual([...SPEC_FIELDS].sort());
  });

  it("uses the same words ride-spec-panel.ts shows the rider", () => {
    // The two copies exist because that one is module-private in a DOM file.
    // This reads its source so they cannot drift into saying different things
    // about the same field on two screens.
    const src = readFileSync("src/ride-spec-panel.ts", "utf8");
    const block = src.slice(src.indexOf("const FIELD_LABEL"));
    for (const [field, label] of Object.entries(RELAXED_FIELD_LABEL)) {
      expect(block).toContain(`${field}: "${label}"`);
    }
  });
});

describe("the rider's hand-off cap", () => {
  const oneScooter = plan([walk(300), ride()]);
  const twoScooters = plan([walk(300), ride(), ride()]);
  const threeScooters = plan([walk(300), ride(), ride(), ride()]);
  const allThree = () =>
    result({ plans: [twoScooters, oneScooter, threeScooters], walkOnly });

  it("shows everything when there is no cap, which is the default", () => {
    const v = planListView({ result: allThree(), rate: rate("resident") });
    expect(v.rows).toHaveLength(3);
    expect(v.capNote).toBeNull();
  });

  it("'one scooter only' leaves the hand-off plans out and says so", () => {
    const v = planListView({
      result: allThree(),
      rate: rate("resident"),
      handOffCap: 0,
    });
    expect(v.rows.map((r) => r.plan.handOffs)).toEqual([0]);
    expect(v.capNote).toContain("2 plans hidden");
    expect(v.capNote).toContain("switching scooters");
  });

  it("'at most one switch' keeps the planner's order among what survives", () => {
    const v = planListView({
      result: allThree(),
      rate: rate("resident"),
      handOffCap: 1,
    });
    // The two-scooter plan was ranked first and stays first.
    expect(v.rows.map((r) => r.plan.handOffs)).toEqual([1, 0]);
    expect(v.capNote).toContain("1 plan hidden");
  });

  it("does not touch what the SEARCH gave up", () => {
    // The cap is a preference about which plans to show, not a thing the
    // search could not find — so it must not leak into `relaxedLabels` or
    // `capRelaxed`, which exist to explain what the search itself conceded.
    const v = planListView({
      result: result({ plans: [threeScooters], walkOnly, capRelaxed: false }),
      rate: rate("resident"),
      handOffCap: 0,
    });
    expect(v.rows).toHaveLength(0);
    expect(v.relaxedLabels).toEqual([]);
    expect(v.capRelaxed).toBe(false);
    expect(v.capNote).toContain("1 plan hidden");
  });
});
