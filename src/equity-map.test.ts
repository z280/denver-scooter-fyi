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
  EQUITY_INDICATOR_MIN_ZOOM,
  __resetEquityAreasForTest,
  loadEquityAreas,
  type EquityAreaCollection,
} from "./equity-areas.ts";
import { EquityAreaMap, explainerHtml, indicatorState } from "./equity-map.ts";
import { setRideLive } from "./ios-shake-undo.ts";

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
  const paint = new globalThis.Map<string, unknown>();
  return {
    addSource: vi.fn(),
    addLayer: vi.fn((spec: Record<string, unknown>) => {
      layers.push(spec);
    }),
    setLayoutProperty: vi.fn((id: string, prop: string, v: string) => {
      layout.set(`${id}.${prop}`, v);
    }),
    setPaintProperty: vi.fn((id: string, prop: string, v: unknown) => {
      paint.set(`${id}.${prop}`, v);
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
    _paint: paint,
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
    expect(explainerHtml("EQ_014")).toContain("13¢/min");
  });

  it("names the area when it knows it, and copes when it doesn't", () => {
    expect(explainerHtml("EQ_014")).toContain("Equity Area 014");
    const anonymous = explainerHtml(null);
    expect(anonymous).toContain("13¢/min");
    expect(anonymous).not.toContain("Equity Area <");
  });

  it("states the unlock fee alongside the per-minute rate", () => {
    expect(explainerHtml(null)).toContain("$1 unlock");
  });

  it("escapes what it interpolates", () => {
    // openFloatingModal escapes the TITLE only and takes bodyHtml raw, so
    // escaping the body's values is this function's job. Nothing reaching it
    // today is untrusted; the escape is here so that stays true by
    // construction rather than by where the caller happens to source names.
    const html = explainerHtml('EQ_<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("says the discount is automatic, not something to enroll in", () => {
    // Exhibit A §5.2 says Veo "shall" apply it to any qualifying trip. A
    // rider who thinks it is an opt-in program never asks why they did not
    // get it.
    expect(explainerHtml(null)).toContain("automatically");
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

  it("is on and at full strength before anything touches it", () => {
    // A boundary nobody can see explains nothing, and the discount inside it
    // is the reason this app exists — so it has been always-on for a while.
    // The owner's follow-up: always-on and muted is still half-invisible, so
    // it now draws at full strength and muting is the option.
    //
    // This field agrees with `index.html`, which `wireEquityAreas` reads at
    // wire time and which is the real product default. A field saying "muted"
    // under markup saying "not" is a second, quieter answer to one question.
    const { eq } = setup();
    expect(eq.isOverlayVisible()).toBe(true);
    expect(eq.isOverlayMuted()).toBe(false);
  });

  it("builds the layers at the visibility it was asked for, not the default", async () => {
    // `ensureLayers` waits on a geometry fetch, so the call that asked can
    // easily finish last. A spec built from the old setting flashes the wrong
    // look on arrival and then corrects itself.
    const { eq, map } = setup();
    await eq.setOverlayVisible(false);
    for (const layer of map._layers) {
      expect((layer.layout as Record<string, string>).visibility).toBe("none");
    }
  });

  it("builds the layers at the strength it was asked for", async () => {
    const { eq, map } = setup();
    await eq.setOverlayMuted(false);
    const fill = map._layers.find((l) => l.id === "equity-areas-fill")!;
    const line = map._layers.find((l) => l.id === "equity-areas-line")!;
    expect((fill.paint as Record<string, number>)["fill-opacity"]).toBe(0.1);
    expect((line.paint as Record<string, number>)["line-opacity"]).toBe(0.9);
    expect((line.paint as Record<string, number>)["line-width"]).toBe(1.8);
  });

  it("hides both layers together when switched off", async () => {
    const { eq, map } = setup();
    await eq.setOverlayVisible(false);
    expect(eq.isOverlayVisible()).toBe(false);
    expect(map._layout.get("equity-areas-fill.visibility")).toBe("none");
    expect(map._layout.get("equity-areas-line.visibility")).toBe("none");
  });

  it("muting favours the outline over the fill", async () => {
    // The point of the muted look: the LINE says where the boundary is, and
    // the fill only says which side of it you are on. A fill strong enough
    // to hide the basemap is the thing the old off-by-default was avoiding.
    const { eq, map } = setup();
    await eq.setOverlayMuted(true);
    const fill = map._paint.get("equity-areas-fill.fill-opacity") as number;
    const line = map._paint.get("equity-areas-line.line-opacity") as number;
    expect(fill).toBeLessThan(0.06);
    expect(line).toBeGreaterThan(fill * 5);
  });

  it("turns all the way up, and back down, without touching visibility", async () => {
    const { eq, map } = setup();
    await eq.setOverlayVisible(true);
    map.setLayoutProperty.mockClear();
    await eq.setOverlayMuted(false);
    expect(map._paint.get("equity-areas-fill.fill-opacity")).toBe(0.1);
    expect(map._paint.get("equity-areas-line.line-opacity")).toBe(0.9);
    expect(map._paint.get("equity-areas-line.line-width")).toBe(1.8);
    await eq.setOverlayMuted(true);
    expect(map._paint.get("equity-areas-fill.fill-opacity")).toBe(0.04);
    // Two questions, two switches: how loud is not whether.
    expect(map.setLayoutProperty).not.toHaveBeenCalled();
    expect(eq.isOverlayVisible()).toBe(true);
  });

  it("remembers the strength across an off-and-on", async () => {
    // A rider who turned it up and then hid it should find it turned up when
    // they bring it back, not reset to the default.
    const { eq, map } = setup();
    await eq.setOverlayMuted(false);
    await eq.setOverlayVisible(false);
    await eq.setOverlayVisible(true);
    expect(eq.isOverlayMuted()).toBe(false);
    expect(map._paint.get("equity-areas-fill.fill-opacity")).toBe(0.1);
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
    // Both halves of Exhibit C's Equity Area row, so the chip itself is not
    // what misleads a rider about the $1 line on their receipt.
    expect(chip.textContent).toContain("13¢/min");
    expect(chip.textContent).toContain("$1");
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
    // Asserted with the overlay explicitly OFF, which is the direction that
    // can actually break: the two are separate paths, and only one of them
    // is now on by default.
    const { eq, chip } = setup();
    await eq.setOverlayVisible(false);
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
    expect(openModal.mock.calls[0][1]).toContain("13¢/min");
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

describe("triple-tap inspect sources", () => {
  const P = { x: 0, y: 0 };
  const at = (ll: [number, number]) => ({ lng: ll[0], lat: ll[1] });

  async function loaded(overlayOn: boolean) {
    await loadEquityAreas();
    const openModal = vi.fn();
    const eq = new EquityAreaMap(fakeMap() as never, document.createElement("button"), openModal);
    await eq.setOverlayVisible(overlayOn);
    return { eq, openModal };
  }

  it("answers inside an area while the overlay is drawn, and opens the explainer", async () => {
    const { eq, openModal } = await loaded(true);
    const hit = eq.hitAt(P, at(INSIDE));
    expect(hit?.key).toMatch(/^equity:EQ_\d{3}$/);
    hit!.open();
    expect(openModal).toHaveBeenCalledWith(
      "This is an Equity Area",
      expect.stringContaining("13¢/min"),
    );
    expect(eq.hiddenAreaSource().hitAt(P, at(INSIDE))).toBeNull();
  });

  it("with the overlay off, steps aside for what IS drawn and answers from the hidden source", async () => {
    const { eq } = await loaded(false);
    expect(eq.hitAt(P, at(INSIDE))).toBeNull();
    expect(eq.hiddenAreaSource().hitAt(P, at(INSIDE))?.key).toMatch(/^equity:/);
  });

  it("says nothing outside every area", async () => {
    const { eq } = await loaded(true);
    expect(eq.hitAt(P, at(OUTSIDE))).toBeNull();
  });
});

describe("the receipt button", () => {
  // "Didn't get the discount?" is drawn only when there is a form behind it,
  // and both ways in (chip, triple-tap) get a working one.
  function modalHost() {
    return vi.fn((_t: string, body: string, onOpen?: (root: HTMLElement | null) => void) => {
      const root = document.createElement("div");
      root.innerHTML = body;
      onOpen?.(root);
      return root;
    });
  }

  it("is not drawn without a form to open", () => {
    expect(explainerHtml(null)).not.toContain("data-equity-receipt");
    expect(explainerHtml(null, { receiptButton: true })).toContain("Didn't get the discount?");
  });

  it("opens the form from the triple-tap explainer", async () => {
    await loadEquityAreas();
    const openModal = modalHost();
    const openForm = vi.fn();
    const eq = new EquityAreaMap(fakeMap() as never, document.createElement("button"), openModal, openForm);
    await eq.setOverlayVisible(true);
    eq.hitAt({ x: 0, y: 0 }, { lng: INSIDE[0], lat: INSIDE[1] })!.open();
    const root = openModal.mock.results[0].value as HTMLElement;
    root.querySelector<HTMLButtonElement>("[data-equity-receipt]")!.click();
    expect(openForm).toHaveBeenCalledTimes(1);
  });

  it("does not offer the form while a ride is live", () => {
    // The chip stays tappable through the riding view, and the form's date
    // and time pickers are edits WebKit makes itself — undo entries the
    // undo-free guard cannot keep out, offered back as "Undo Typing" on every
    // bump (ios-shake-undo.ts). The explainer still opens; the door waits.
    setRideLive(true);
    try {
      const openModal = modalHost();
      const openForm = vi.fn();
      const eq = new EquityAreaMap(fakeMap() as never, document.createElement("button"), openModal, openForm);
      eq.explain();
      expect(openModal).toHaveBeenCalledTimes(1);
      const root = openModal.mock.results[0].value as HTMLElement;
      expect(root.querySelector("[data-equity-receipt]")).toBeNull();
    } finally {
      setRideLive(false);
    }
  });

  it("opens the form from the chip's explainer", () => {
    const openModal = modalHost();
    const openForm = vi.fn();
    const eq = new EquityAreaMap(fakeMap() as never, document.createElement("button"), openModal, openForm);
    eq.explain();
    const root = openModal.mock.results[0].value as HTMLElement;
    root.querySelector<HTMLButtonElement>("[data-equity-receipt]")!.click();
    expect(openForm).toHaveBeenCalledTimes(1);
  });
});
