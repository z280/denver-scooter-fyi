// @vitest-environment happy-dom
//
// The equity-area overlay and the on-screen indicator.
//
// The indicator is the part worth testing hard. It is the only thing in
// this app that tells a rider, unprompted, that they are owed money — so
// the cases that matter are the ones where it should stay QUIET: zoomed out
// too far to be making a claim about a place, outside every area, and
// (easy to get wrong) before the map has loaded, where "not in an area" and
// "haven't looked" are different facts.
//
// A fake MapLibre map stands in for the real one, same as hexdensity.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  EQUITY_DISCOUNT_NOTICE,
  EQUITY_INDICATOR_MIN_ZOOM,
  __resetEquityAreasForTest,
  loadEquityAreas,
  type EquityAreaCollection,
} from "./equity-areas.ts";
import { EquityAreaMap, explainerHtml, indicatorState } from "./equity-map.ts";

const MAP = JSON.parse(
  readFileSync("public/equity-areas.geojson", "utf8"),
) as EquityAreaCollection;

const INSIDE: [number, number] = [-104.826320, 39.785137];
const OUTSIDE: [number, number] = [-104.97, 39.7];
const ZOOMED_IN = EQUITY_INDICATOR_MIN_ZOOM + 1;

function fakeMap(center = { lng: INSIDE[0], lat: INSIDE[1] }, zoom = ZOOMED_IN) {
  const handlers = new globalThis.Map<string, (() => void)[]>();
  const layers: Record<string, unknown>[] = [];
  const layout = new globalThis.Map<string, string>();
  return {
    addSource: vi.fn(),
    addLayer: vi.fn((spec: Record<string, unknown>) => {
      layers.push(spec);
    }),
    setLayoutProperty: vi.fn((id: string, prop: string, v: string) => {
      layout.set(`${id}.${prop}`, v);
    }),
    getCenter: () => center,
    getZoom: () => zoom,
    on: vi.fn((evt: string, fn: () => void) => {
      handlers.set(evt, [...(handlers.get(evt) ?? []), fn]);
    }),
    // test helpers
    _fire: (evt: string) => (handlers.get(evt) ?? []).forEach((f) => f()),
    _layers: layers,
    _layout: layout,
    _move: (lng: number, lat: number, z = zoom) => {
      center = { lng, lat };
      zoom = z;
    },
  };
}

function serveMap() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => MAP }),
  );
}

beforeEach(() => {
  __resetEquityAreasForTest();
  serveMap();
});

describe("indicatorState", () => {
  it("stays silent until the map has loaded", () => {
    // Not a false negative — an ABSENT answer. Showing "not in an equity
    // area" here would be a wrong claim about the rider's money.
    expect(indicatorState(ZOOMED_IN, ...INSIDE)).toBeNull();
  });

  it("reports the area once loaded and zoomed in", async () => {
    await loadEquityAreas();
    const state = indicatorState(ZOOMED_IN, ...INSIDE);
    expect(state?.areaName).toMatch(/^EQ_\d{3}$/);
  });

  it("stays silent outside every area", async () => {
    await loadEquityAreas();
    expect(indicatorState(ZOOMED_IN, ...OUTSIDE)).toBeNull();
  });

  it("stays silent when zoomed out past the floor", async () => {
    await loadEquityAreas();
    expect(indicatorState(EQUITY_INDICATOR_MIN_ZOOM - 0.1, ...INSIDE)).toBeNull();
    // And speaks up exactly at the floor, not one notch past it.
    expect(indicatorState(EQUITY_INDICATOR_MIN_ZOOM, ...INSIDE)).not.toBeNull();
  });
});

describe("the tap explainer", () => {
  it("quotes the contract verbatim", () => {
    expect(explainerHtml("EQ_014")).toContain(EQUITY_DISCOUNT_NOTICE);
  });

  it("names the area when it knows it, and copes when it doesn't", () => {
    expect(explainerHtml("EQ_014")).toContain("Equity Area 014");
    const anonymous = explainerHtml(null);
    expect(anonymous).toContain(EQUITY_DISCOUNT_NOTICE);
    expect(anonymous).not.toContain("Equity Area <");
  });

  it("says the discount covers rides that start OR end in the area", () => {
    // The most common misreading of the contract term, and the one that
    // costs a rider the refund: they assume the whole ride has to be inside.
    expect(explainerHtml(null)).toContain("<strong>starts or ends</strong>");
  });
});

describe("EquityAreaMap", () => {
  function setup(map = fakeMap()) {
    const chip = document.createElement("button");
    chip.hidden = true;
    const openModal = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eq = new EquityAreaMap(map as any, chip, openModal);
    return { eq, chip, map, openModal };
  }

  it("draws the polygons hidden, so the overlay is off by default", async () => {
    const { eq, map } = setup();
    await eq.setOverlayVisible(false);
    expect(eq.isOverlayVisible()).toBe(false);
    for (const layer of map._layers) {
      expect((layer.layout as Record<string, string>).visibility).toBe("none");
    }
  });

  it("shows and hides both the fill and the outline together", async () => {
    const { eq, map } = setup();
    await eq.setOverlayVisible(true);
    expect(map._layout.get("equity-areas-fill.visibility")).toBe("visible");
    expect(map._layout.get("equity-areas-line.visibility")).toBe("visible");
    await eq.setOverlayVisible(false);
    expect(map._layout.get("equity-areas-fill.visibility")).toBe("none");
    expect(map._layout.get("equity-areas-line.visibility")).toBe("none");
  });

  it("adds its source once even when toggled repeatedly", async () => {
    const { eq, map } = setup();
    await eq.setOverlayVisible(true);
    await eq.setOverlayVisible(false);
    await eq.setOverlayVisible(true);
    expect(map.addSource).toHaveBeenCalledTimes(1);
  });

  it("adds its source once under concurrent toggles", async () => {
    // Both callers can clear the `layersAdded` guard before either finishes
    // its await, and addSource throws on a duplicate id.
    const { eq, map } = setup();
    await Promise.all([eq.setOverlayVisible(true), eq.setOverlayVisible(true)]);
    expect(map.addSource).toHaveBeenCalledTimes(1);
  });

  it("reveals the chip once the geometry lands, without a map move", async () => {
    const { eq, chip } = setup();
    eq.wire();
    await vi.waitFor(() => expect(chip.hidden).toBe(false));
    expect(chip.textContent).toContain("$0.13/min");
  });

  it("hides the chip when the map leaves the area", async () => {
    const map = fakeMap();
    const { eq, chip } = setup(map);
    eq.wire();
    await vi.waitFor(() => expect(chip.hidden).toBe(false));

    map._move(...OUTSIDE);
    map._fire("move");
    expect(chip.hidden).toBe(true);
  });

  it("hides the chip when the rider zooms out past the floor", async () => {
    const map = fakeMap();
    const { eq, chip } = setup(map);
    eq.wire();
    await vi.waitFor(() => expect(chip.hidden).toBe(false));

    map._move(INSIDE[0], INSIDE[1], EQUITY_INDICATOR_MIN_ZOOM - 1);
    map._fire("zoomend");
    expect(chip.hidden).toBe(true);
  });

  it("shows the chip whether or not the overlay is on", async () => {
    // The discount notice must not be gated on a rider having found the
    // Areas drawer — that is the exact asymmetry this app exists to fix.
    const { eq, chip } = setup();
    eq.wire();
    await vi.waitFor(() => expect(chip.hidden).toBe(false));
    expect(eq.isOverlayVisible()).toBe(false);
  });

  it("announces itself to assistive tech as something to act on", async () => {
    const { eq, chip } = setup();
    eq.wire();
    await vi.waitFor(() => expect(chip.hidden).toBe(false));
    const label = chip.getAttribute("aria-label") ?? "";
    expect(label).toContain("13 cents a minute");
    expect(label).toContain("Tap for details");
  });

  it("opens the explainer when tapped", async () => {
    const { eq, chip, openModal } = setup();
    eq.wire();
    await vi.waitFor(() => expect(chip.hidden).toBe(false));
    chip.click();
    expect(openModal).toHaveBeenCalledTimes(1);
    expect(openModal.mock.calls[0][1]).toContain(EQUITY_DISCOUNT_NOTICE);
  });

  it("survives the geometry failing to load", async () => {
    // A rider who cannot fetch the map still gets a working app; the chip
    // simply never appears.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { eq, chip } = setup();
    expect(() => eq.wire()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(chip.hidden).toBe(true);
  });
});
