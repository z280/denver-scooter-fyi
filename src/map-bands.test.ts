// The area stacking order is a decision (map-bands.ts), not an accident of
// which layer was created first. These drive a fake map that keeps a real
// ordered layer list and honours `before`.
import { describe, expect, it } from "vitest";

import { FIRST_DEVICE_LAYER } from "./devices.ts";
import { BAND_ANCHOR, bandBefore, ensureBands, topAnchorIndex } from "./map-bands.ts";

function orderedMap(initial: string[] = []) {
  const layers: { id: string }[] = initial.map((id) => ({ id }));
  return {
    layers,
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addLayer: (spec: { id: string }, before?: string) => {
      const i = before ? layers.findIndex((l) => l.id === before) : -1;
      if (i < 0) layers.push({ id: spec.id });
      else layers.splice(i, 0, { id: spec.id });
    },
    getStyle: () => ({ layers }),
    ids: () => layers.map((l) => l.id),
  };
}

describe("map bands", () => {
  it("opens shading < equity < zones directly under the scooters", () => {
    const map = orderedMap(["basemap-water", FIRST_DEVICE_LAYER, "device-points"]);
    ensureBands(map as never);
    expect(map.ids()).toEqual([
      "basemap-water",
      BAND_ANCHOR.shading,
      BAND_ANCHOR.equity,
      BAND_ANCHOR.zones,
      FIRST_DEVICE_LAYER,
      "device-points",
    ]);
  });

  it("stacks zones over equity over territory however late each is created", () => {
    const map = orderedMap([FIRST_DEVICE_LAYER]);
    // Startup order: zones first, then equity; territory switched on last —
    // the case that used to put hexes on top of everything.
    map.addLayer({ id: "zones-fill" }, bandBefore(map as never, "zones"));
    map.addLayer({ id: "equity-fill" }, bandBefore(map as never, "equity"));
    map.addLayer({ id: "hex-fill" }, bandBefore(map as never, "shading"));
    const ids = map.ids();
    expect(ids.indexOf("hex-fill")).toBeLessThan(ids.indexOf("equity-fill"));
    expect(ids.indexOf("equity-fill")).toBeLessThan(ids.indexOf("zones-fill"));
    expect(ids.indexOf("zones-fill")).toBeLessThan(ids.indexOf(FIRST_DEVICE_LAYER));
    expect(topAnchorIndex(map as never)).toBe(ids.indexOf(BAND_ANCHOR.zones));
  });

  it("is idempotent", () => {
    const map = orderedMap([FIRST_DEVICE_LAYER]);
    ensureBands(map as never);
    ensureBands(map as never);
    expect(map.ids().filter((id) => id.startsWith("band-anchor-"))).toHaveLength(3);
  });

  it("falls back to the old anchor on a map without getLayer", () => {
    expect(bandBefore({} as never, "zones")).toBe(FIRST_DEVICE_LAYER);
  });
});
