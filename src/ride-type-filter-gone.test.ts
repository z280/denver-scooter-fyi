// The sitting/standing FILTER is gone; the sitting/standing FACT is not.
//
// Posture was never an independent signal. The API's `ingest.py` maps one Veo
// vehicle-type id to both the model name and the sitting/standing value
// (`_KNOWN_VEHICLE_TYPES`), so for a recognized model the two cannot disagree —
// "seated only" was "Cosmo or Apollo or Rover" with extra steps. Worse, the
// redundancy was load-bearing: `syncModelsToRideTypes` existed because the two
// controls could combine into a filter showing nothing, and it had to be subtle
// about which model picks survived a ride-type tap.
//
// What must NOT follow is deleting the concept. `vehicle_use_type` is a
// SplitDimension in the API's equity-compliance metrics, where it is described
// as the accessibility-relevant split — whether seated vehicles are distributed
// equitably is a real question, since a rider who cannot stand needs one. And
// the device icon still has to choose a sprite. So this file asserts both
// halves: the control is gone, and the mapping and the derivation are not.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_MODELS,
  ALL_RIDE_TYPES,
  MODELS_BY_RIDE_TYPE,
  RIDE_TYPE_BY_MODEL,
  rideTypeOf,
} from "./model-catalog.ts";

const ROOT = join(import.meta.dirname, "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const srcDir = join(ROOT, "src");
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, text: readFileSync(join(srcDir, f), "utf8") }));

describe("the ride-type filter control", () => {
  it("is absent from index.html", () => {
    expect(html).not.toMatch(/id="ride-type-filter"/);
    expect(html).not.toMatch(/data-ride=/);
  });

  it("is not queried by any module", () => {
    // Prose mentions are fine — several comments record why it went. A
    // selector is the control coming back.
    const offenders = sources.filter(({ text }) =>
      /(?:querySelector|querySelectorAll|getElementById)\s*(?:<[^>]*>)?\s*\(\s*[`'"][^`'"]*ride-type-filter/.test(
        text,
      ),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("took the sync and the device-layer filter with it", () => {
    const main = sources.find((s) => s.file === "main.ts")!.text;
    const devices = sources.find((s) => s.file === "devices.ts")!.text;
    expect(main).not.toMatch(/function syncModelsToRideTypes/);
    expect(main).not.toMatch(/\bclearRideTypeFilter\b/);
    expect(devices).not.toMatch(/setRideTypes/);
    // `setToggleGroup`'s key union no longer offers a group that does not exist.
    expect(main).not.toMatch(/key: "ride" \| "model"/);
  });
});

describe("what deliberately survived", () => {
  it("still knows which models you sit on", () => {
    // The Quick Filters' "No Standing" preset and the ride spec's
    // model-widening rung both read this. It is the same mapping the deleted
    // sync read, so the preset selects exactly what it always did.
    expect([...MODELS_BY_RIDE_TYPE.sitting].sort()).toEqual([
      "apollo",
      "cosmo",
      "trike",
    ]);
    expect([...MODELS_BY_RIDE_TYPE.standing]).toEqual(["astro"]);
  });

  it("keeps one direction of the relationship derived from the other", () => {
    // Two hand-maintained directions is how they drift — and this pair is
    // already a copy of the API's posture column, so a third copy here would
    // be the second drift risk on one fact.
    for (const m of ALL_MODELS) {
      expect(MODELS_BY_RIDE_TYPE[RIDE_TYPE_BY_MODEL[m]]).toContain(m);
    }
    const covered = ALL_RIDE_TYPES.flatMap((t) => [...MODELS_BY_RIDE_TYPE[t]]);
    expect([...covered].sort()).toEqual([...ALL_MODELS].sort());
  });

  it("still derives a posture for the device icon's sprite", () => {
    // `devices.ts` renders `use-${rideTypeOf(p)}`, so this must answer for
    // every device — including hardware with no recognized model, which is
    // exactly the case a model-only rule could not have covered.
    expect(rideTypeOf({ vehicle_model_name: "Astro" })).toBe("standing");
    expect(rideTypeOf({ vehicle_model_name: "Apollo" })).toBe("sitting");
    expect(rideTypeOf({ vehicle_model_name: "Rover" })).toBe("sitting");
    expect(rideTypeOf({ vehicle_model_name: "Quadricycle" })).toBe("standing");
    expect(rideTypeOf({})).toBe("standing");
    // The server's value wins when it says sitting — the only signal there is
    // for hardware the catalog cannot name.
    expect(
      rideTypeOf({ vehicle_use_type: "sitting", vehicle_model_name: "Quadricycle" }),
    ).toBe("sitting");
  });
});
