// @vitest-environment happy-dom
//
// Shaded regions answer a triple tap themselves, and a triple tap toggles
// the region filter once, not on-off-on.
import { describe, expect, it, vi } from "vitest";

import { Overlays, regionInspectHtml } from "./overlays.ts";

function fakeMap(regionName = "NB_FivePoints") {
  const clicks: ((e: unknown) => void)[] = [];
  return {
    clicks,
    on: vi.fn((type: string, fn: (e: unknown) => void) => {
      if (type === "click") clicks.push(fn);
    }),
    getLayer: () => undefined,
    getLayoutProperty: () => "visible",
    queryRenderedFeatures: (_p: unknown, o?: { layers?: string[] }) =>
      o?.layers?.includes("bnd-neighborhood-fill")
        ? [{ layer: { id: "bnd-neighborhood-fill" }, properties: { region_name: regionName } }]
        : [],
  };
}

function overlaysWithNeighborhoods(map: ReturnType<typeof fakeMap>) {
  const o = new Overlays(map as never, document.createElement("div"));
  (o as unknown as { loaded: Set<string> }).loaded.add("neighborhood");
  return o;
}

describe("region overlays and the triple tap", () => {
  it("a triple tap toggles a region's filter once; a later tap toggles back", () => {
    const map = fakeMap();
    const o = overlaysWithNeighborhoods(map);
    const handler = vi.fn();
    let t = 1000;
    o.enableRegionClicks(handler, [], () => t);
    const click = () => map.clicks.forEach((fn) => fn({ point: { x: 5, y: 5 } }));
    click(); t += 150; click(); t += 150; click();
    expect(handler).toHaveBeenCalledTimes(1);
    t += 2000;
    click();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("answers the inspector with the region's name instead of 'nothing marked'", () => {
    const map = fakeMap();
    const o = overlaysWithNeighborhoods(map);
    const open = vi.fn();
    const hit = o.inspectSource(open).hitAt({ x: 5, y: 5 }, { lng: 0, lat: 0 });
    expect(hit?.key).toBe("region:neighborhood:NB_FivePoints");
    hit!.open();
    expect(open).toHaveBeenCalledWith("Five Points", expect.stringContaining("Neighborhoods"));
  });

  it("escapes the region name", () => {
    expect(regionInspectHtml("<x>", "Neighborhoods")).toContain("&lt;x&gt;");
  });
});
