// @vitest-environment happy-dom
//
// The scooters the rider chose, marked out from the fleet. What is pinned
// here is mostly that the two kinds stay DISTINGUISHABLE — ⭐ "go to this
// one" and 📍 "swap here" answer different questions, and a plan whose two
// scooters look alike is a plan the rider cannot follow.
import { describe, it, expect, vi } from "vitest";

import { createChosenPins, toFeatureCollection } from "./chosen-pins.ts";

const FIRST = { lat: 39.73, lon: -105.0, label: "Liftoff 🍉 167", kind: "first" as const };
const SWAP = { lat: 39.75, lon: -104.97, label: "Perseus 🎯 619", kind: "handoff" as const };

describe("what gets drawn", () => {
  it("gives the two kinds different glyphs", () => {
    const fc = toFeatureCollection([FIRST, SWAP]);
    expect(fc.features[0].properties?.glyph).toBe("⭐");
    expect(fc.features[1].properties?.glyph).toBe("📍");
  });

  it("carries the vehicle's name, because an unlabelled dot confirms nothing", () => {
    const fc = toFeatureCollection([FIRST]);
    expect(fc.features[0].properties?.label).toBe("Liftoff 🍉 167");
  });

  it("writes GeoJSON lon/lat order", () => {
    // Swapped, the marker lands in the Indian Ocean and the bug looks like
    // "the pin does not show".
    const fc = toFeatureCollection([FIRST]);
    expect((fc.features[0].geometry as GeoJSON.Point).coordinates).toEqual([-105.0, 39.73]);
  });

  it("draws nothing for an empty plan", () => {
    expect(toFeatureCollection([]).features).toEqual([]);
  });
});

function fakeMap(styleLoaded = true) {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const layers: string[] = [];
  return {
    layers,
    sources,
    isStyleLoaded: () => styleLoaded,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
    addLayer: (l: { id: string }) => layers.push(l.id),
  };
}

describe("the layer", () => {
  it("creates its source and layers once, however often it is written", () => {
    // The map outlives every panel that draws into it; re-adding a source is
    // a MapLibre error, not a no-op.
    const map = fakeMap();
    const pins = createChosenPins(map as never);
    pins.set([FIRST]);
    pins.set([FIRST, SWAP]);
    pins.clear();
    expect(map.layers).toEqual(["chosen-pts-halo", "chosen-pts-pin"]);
    expect(map.sources.size).toBe(1);
  });

  it("does not touch a style that is still loading", () => {
    // `addSource` throws "Style is not done loading" during boot, and this is
    // called from a panel that can render before the style settles — the
    // exact shape that took main.ts down once already this branch.
    const map = fakeMap(false);
    const pins = createChosenPins(map as never);
    expect(() => pins.set([FIRST])).not.toThrow();
    expect(map.layers).toEqual([]);
  });

  it("keeps writing once the layer exists, even mid-restyle", () => {
    const map = fakeMap(true);
    const pins = createChosenPins(map as never);
    pins.set([FIRST]);
    map.isStyleLoaded = () => false;
    pins.set([SWAP]);
    expect(map.sources.get("chosen-pts")!.setData).toHaveBeenCalledTimes(2);
  });

  it("clear writes an empty collection rather than leaving the last plan up", () => {
    const map = fakeMap();
    const pins = createChosenPins(map as never);
    pins.set([FIRST, SWAP]);
    pins.clear();
    const last = map.sources.get("chosen-pts")!.setData.mock.calls.at(-1)![0];
    expect(last.features).toEqual([]);
  });
});
