// @vitest-environment happy-dom
//
// Saved filter presets (filter-presets.ts) — specifically the rule that
// keeps an old preset from hiding a model that didn't exist when it was
// saved. Presets shipped 2026-07-28; the Rover ("trike" key) joined the
// lineup 2026-07-30. A preset from that gap stores
// models: ["astro","cosmo","apollo"], and reading the trike's absence as
// "deselected" made applying any such preset silently hide every Rover on
// the map. `effectiveModels` is the fix: absence only counts as a choice
// for a model the saver could actually have toggled.
import { beforeEach, describe, expect, it } from "vitest";

import { effectiveModels, loadPresets } from "./filter-presets.ts";
import type { FilterPreset } from "./filter-presets.ts";

describe("effectiveModels", () => {
  it("turns a model the preset never knew about back on", () => {
    // A pre-Rover preset: no knownModels member at all.
    expect(effectiveModels({ models: ["astro", "cosmo", "apollo"] })).toEqual(
      new Set(["astro", "cosmo", "apollo", "trike"]),
    );
  });

  it("still honors the deselections the saver actually made", () => {
    // Same legacy preset, but the saver had turned the Astro off — that
    // choice was about a model they could see, and it sticks.
    expect(effectiveModels({ models: ["cosmo", "apollo"] })).toEqual(
      new Set(["cosmo", "apollo", "trike"]),
    );
  });

  it("respects a deliberate trike deselection once the preset records its lineup", () => {
    expect(
      effectiveModels({
        models: ["astro", "cosmo", "apollo"],
        knownModels: ["astro", "cosmo", "apollo", "trike"],
      }),
    ).toEqual(new Set(["astro", "cosmo", "apollo"]));
  });

  it("passes a current full-lineup preset through unchanged", () => {
    const all = ["astro", "cosmo", "apollo", "trike"] as const;
    expect(
      effectiveModels({ models: [...all], knownModels: [...all] }),
    ).toEqual(new Set(all));
  });
});

describe("loadPresets validation of knownModels", () => {
  const base: FilterPreset = {
    name: "test",
    rideTypes: ["sitting", "standing"],
    models: ["astro", "cosmo", "apollo"],
    hideUnavailable: false,
    minBattery: 0,
    quality: "any",
    area: null,
  };

  const store = (presets: unknown[]): void => {
    localStorage.setItem(
      "scooter-fyi-filter-presets",
      JSON.stringify({ v: 1, presets }),
    );
  };

  beforeEach(() => localStorage.clear());

  it("accepts a preset without the member (the pre-Rover shape)", () => {
    store([base]);
    expect(loadPresets()).toHaveLength(1);
  });

  it("accepts a preset that records its lineup", () => {
    store([{ ...base, knownModels: ["astro", "cosmo", "apollo", "trike"] }]);
    expect(loadPresets()).toHaveLength(1);
  });

  it("drops a preset whose knownModels carries junk, like every other member", () => {
    store([{ ...base, knownModels: ["astro", "segway"] }]);
    expect(loadPresets()).toHaveLength(0);
  });
});
