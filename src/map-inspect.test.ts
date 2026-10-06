// @vitest-environment happy-dom
//
// Triple-tap anywhere: the most relevant thing under the finger answers, in
// stacking order; taps on scooters are not area questions; three taps must
// be three taps in the same place.
import { describe, expect, it, vi } from "vitest";

import { BAND_ANCHOR } from "./map-bands.ts";
import {
  type InspectHit,
  type InspectSource,
  MapInspector,
  SPOT_INSPECT_TITLE,
  TAP_SLOP_PX,
  buildSpotHtml,
} from "./map-inspect.ts";

const LL = { lng: -104.99, lat: 39.74 };

function fakeMap(opts: { above?: boolean } = {}) {
  const dcz = {
    enabled: true,
    isEnabled: () => dcz.enabled,
    enable: vi.fn(() => (dcz.enabled = true)),
    disable: vi.fn(() => (dcz.enabled = false)),
  };
  const layers = [{ id: "basemap" }, { id: BAND_ANCHOR.zones }, { id: "device-points" }];
  return {
    doubleClickZoom: dcz,
    getStyle: () => ({ layers }),
    queryRenderedFeatures: () =>
      opts.above ? [{ layer: { id: "device-points" } }] : [{ layer: { id: "basemap" } }],
    on: vi.fn(),
  };
}

function source(key: string | null, holds = false): InspectSource & { opened: number } {
  const s = {
    opened: 0,
    hitAt: (): InspectHit | null =>
      key ? { key, holdsDoubleClickZoom: holds, open: () => s.opened++ } : null,
  };
  return s;
}

function setup(sources: InspectSource[], mapOpts = {}) {
  const map = fakeMap(mapOpts);
  const fallback = { opened: 0 };
  const onTriple = vi.fn();
  const insp = new MapInspector(map as never, {
    sources,
    fallback: () => ({ key: "spot", open: () => fallback.opened++ }),
    onTriple,
  });
  const tap = (n: number, x = 50, y = 50) => {
    for (let i = 0; i < n; i++) insp.handleTap({ x, y }, LL);
  };
  return { map, insp, tap, fallback, onTriple };
}

describe("MapInspector", () => {
  it("the topmost source with something here answers; the ones below don't", () => {
    const zone = source("zone:a");
    const equity = source("equity:EQ_001");
    const hex = source("hex:large:territory_control:abc");
    const { tap, onTriple } = setup([zone, equity, hex]);
    tap(3);
    expect([zone.opened, equity.opened, hex.opened]).toEqual([1, 0, 0]);
    expect(onTriple).toHaveBeenCalledTimes(1);
  });

  it("falls through empty sources to the next one down", () => {
    const zone = source(null);
    const equity = source(null);
    const hex = source("hex:x");
    const { tap } = setup([zone, equity, hex]);
    tap(3);
    expect(hex.opened).toBe(1);
  });

  it("answers ANYWHERE: with nothing claimed, the plain-spot card opens", () => {
    const { tap, fallback } = setup([source(null), source(null)]);
    tap(3);
    expect(fallback.opened).toBe(1);
  });

  it("one or two taps open nothing", () => {
    const zone = source("zone:a");
    const { tap } = setup([zone]);
    tap(2);
    expect(zone.opened).toBe(0);
  });

  it("taps on a scooter (drawn above the areas) are not area questions", () => {
    const zone = source("zone:a");
    const { tap, fallback } = setup([zone], { above: true });
    tap(3);
    expect(zone.opened).toBe(0);
    expect(fallback.opened).toBe(0);
  });

  it("three taps must land in the same place", () => {
    const equity = source("equity:EQ_001");
    const { insp } = setup([equity]);
    insp.handleTap({ x: 50, y: 50 }, LL);
    insp.handleTap({ x: 50 + TAP_SLOP_PX + 30, y: 50 }, LL);
    insp.handleTap({ x: 50 + TAP_SLOP_PX + 30, y: 50 }, LL);
    expect(equity.opened).toBe(0);
    insp.handleTap({ x: 50 + TAP_SLOP_PX + 30 + 5, y: 52 }, LL);
    expect(equity.opened).toBe(1);
  });

  it("holds double-tap zoom only for targets that ask (zones, hexes), and gives it back", () => {
    vi.useFakeTimers();
    try {
      const { tap, map } = setup([source("zone:a", true)]);
      tap(1);
      expect(map.doubleClickZoom.enabled).toBe(false);
      tap(2);
      expect(map.doubleClickZoom.enabled).toBe(true);

      const big = setup([source("equity:EQ_001", false)]);
      big.tap(2);
      expect(big.map.doubleClickZoom.disable).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an abandoned run hands double-tap zoom back on its own", () => {
    vi.useFakeTimers();
    try {
      const { tap, map } = setup([source("hex:x", true)]);
      tap(1);
      expect(map.doubleClickZoom.enabled).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(map.doubleClickZoom.enabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves double-tap zoom alone if the map already had it off", () => {
    const { tap, map } = setup([source("hex:x", true)]);
    map.doubleClickZoom.enabled = false;
    tap(3);
    expect(map.doubleClickZoom.enable).not.toHaveBeenCalled();
  });
});

describe("buildSpotHtml", () => {
  it("says no zone covers the spot only when zones are drawn", () => {
    expect(buildSpotHtml({ zonesShown: true, inEquityArea: false })).toContain(
      "No city slow, no-riding or no-parking zone covers this spot.",
    );
    const hidden = buildSpotHtml({ zonesShown: false, inEquityArea: false });
    expect(hidden).toContain("switched off in Areas");
    expect(hidden).not.toContain("No city slow");
  });

  it("says no Equity Area discount applies outside them, and nothing before they load", () => {
    const out = buildSpotHtml({ zonesShown: true, inEquityArea: false });
    expect(out).toContain("no Equity Area discount applies here");
    // Outside Denver Veo may not even operate; the card claims only what the
    // boundaries support.
    expect(out).not.toContain("standard Veo rate");
    expect(buildSpotHtml({ zonesShown: true, inEquityArea: null })).not.toContain("Equity Areas,");
  });

  it("teaches the gesture", () => {
    expect(buildSpotHtml({ zonesShown: true, inEquityArea: null })).toContain("Triple-tap");
    expect(SPOT_INSPECT_TITLE).toBe("Nothing marked here");
  });
});
