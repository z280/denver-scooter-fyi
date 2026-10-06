// @vitest-environment happy-dom
//
// ONE FILTER, asserted on real features (Phase 6 §6.3).
//
// `model-filter.test.ts` covers the three-state itself. This file covers the
// thing that was actually broken: the device layer used to run TWO model
// filters — the Filters drawer's `models` set and the ride HUD's
// `rideModelFilter` — which agreed on "some" and disagreed on "none". Here
// the assertions run through `Devices` against a real feature collection, so
// a future change that reintroduces a second filter, or re-derives the
// unrecognized-hardware rule inline, fails here rather than in a unit test of
// a helper nobody calls any more.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Devices } from "./devices.ts";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import type { Map as MLMap } from "maplibre-gl";
import type { Locate } from "./locate.ts";
import { ALL_SELECTED, NONE_SELECTED, selectionOf } from "./model-filter.ts";

function fakeMap() {
  const setData = vi.fn();
  return {
    getSource: () => ({ setData }),
    hasImage: () => true,
    addImage: () => {},
    easeTo: () => {},
    getZoom: () => 16,
  };
}

const fakeLocate = {
  onFix: () => () => {},
  current: () => null,
  showLineTo: () => {},
  clearLine: () => {},
} as unknown as Locate;

/** One device per model, plus the case the two old filters disagreed about:
 *  hardware whose model name the catalog does not recognize. */
function fleet(): DevicesResponse {
  const names: (string | null)[] = [
    "Astro",
    "Cosmo",
    "Apollo",
    "Rover", // the trike key's rider-facing name
    "Quadricycle", // unrecognized — modelKeyOf returns null
  ];
  return {
    type: "FeatureCollection",
    metadata: {
      cycle_id: "c1",
      snapshot_time: "2026-10-06T00:00:00Z",
      device_count: names.length,
      filters: {},
    },
    features: names.map((name, i) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-105 + i / 100, 39.7] },
      properties: {
        device_id: `d${i}`,
        form_factor: "scooter",
        spatial_status: "available",
        vehicle_plate: `1000${i}`,
        vehicle_model_name: name,
      } as DeviceProperties,
    })),
  };
}

let devices: Devices;

beforeEach(() => {
  devices = new Devices(fakeMap() as unknown as MLMap, fakeLocate);
  devices.setData(fleet());
});

const visibleNames = (): (string | null | undefined)[] =>
  devices.visibleFeatures().map((f) => f.properties.vehicle_model_name);

describe("the one model filter, through the device layer", () => {
  it("`all` shows every model and the unrecognized one", () => {
    devices.setModelSelection(ALL_SELECTED);
    expect(visibleNames()).toEqual([
      "Astro",
      "Cosmo",
      "Apollo",
      "Rover",
      "Quadricycle",
    ]);
  });

  it("`only` keeps the chosen models AND the unrecognized one", () => {
    // Deselecting Apollos is not a request to hide a scooter nobody has
    // identified — and the model-report flow feeds on exactly those.
    devices.setModelSelection(selectionOf(["cosmo"]));
    expect(visibleNames()).toEqual(["Cosmo", "Quadricycle"]);
  });

  it("`none` empties the map, unrecognized hardware included", () => {
    // THE DRAWER'S BUG. `models.size < ALL_MODELS.length` let an empty set
    // into the filter branch, where `key === null` still passed — so
    // unticking every box left a map of nothing but mystery scooters.
    devices.setModelSelection(NONE_SELECTED);
    expect(visibleNames()).toEqual([]);
  });

  it("gives the same answer whichever surface set it", () => {
    // The drawer reports ticked boxes; the HUD sets a selection directly.
    // Both land on one value, so "off" cannot mean two things any more.
    devices.setModels(new Set()); // drawer: every box unticked
    const viaDrawer = visibleNames();
    devices.setModelSelection(NONE_SELECTED); // HUD: "none"
    expect(visibleNames()).toEqual(viaDrawer);
    expect(viaDrawer).toEqual([]);
  });

  it("is readable back, so the other surface can render from it", () => {
    // No copy step: this is the single value both surfaces render.
    devices.setModels(new Set(["apollo", "astro"]));
    expect(devices.modelSelection_()).toEqual({
      kind: "only",
      models: new Set(["apollo", "astro"]),
    });
    // ...and the drawer's "every box ticked" normalises to `all`, not to an
    // `only` that happens to list everything.
    devices.setModels(new Set(["apollo", "astro", "cosmo", "trike"]));
    expect(devices.modelSelection_()).toEqual({ kind: "all" });
  });

  it("tells the filter-change listeners, whichever surface wrote it", () => {
    // THE SEAM §6.4 DEPENDS ON. `main.ts` hangs the ride-spec detach off
    // `onCountsChange` — "the one signal that fires for all of them" — so a
    // HUD pill tap has to reach it exactly as a drawer tick does. Otherwise an
    // attached spec goes on claiming to show "only my ideal scooters" over a
    // map the pills have changed underneath it.
    const seen: number[] = [];
    devices.onCountsChange((visible) => seen.push(visible));
    expect(seen).toEqual([5]); // fires once on subscribe, with the current count
    devices.setModelSelection(selectionOf(["cosmo"])); // as the HUD's pills do
    expect(seen).toEqual([5, 2]);
    devices.setModels(new Set(["apollo"])); // as the drawer does
    expect(seen).toEqual([5, 2, 2]);
    devices.setModelSelection(NONE_SELECTED);
    expect(seen).toEqual([5, 2, 2, 0]);
  });

  it("defaults to showing everything", () => {
    expect(devices.modelSelection_()).toEqual({ kind: "all" });
    expect(visibleNames()).toHaveLength(5);
  });
});
