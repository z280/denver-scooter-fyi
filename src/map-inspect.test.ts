// @vitest-environment happy-dom
//
// Triple-tap anywhere: the most relevant thing under the finger answers, in
// stacking order; taps on scooters are not area questions; three taps must
// be three taps in the same place.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BAND_ANCHOR } from "./map-bands.ts";
import {
  type InspectHit,
  type InspectSource,
  MapInspector,
  SPOT_INSPECT_TITLE,
  TAP_SLOP_PX,
  ZOOM_DEFER_MS,
  buildSpotHtml,
} from "./map-inspect.ts";

const LL = { lng: -104.99, lat: 39.74 };

function fakeMap(opts: { above?: boolean; halo?: boolean } = {}) {
  const dcz = {
    enabled: true,
    isEnabled: () => dcz.enabled,
    enable: vi.fn(() => (dcz.enabled = true)),
    disable: vi.fn(() => (dcz.enabled = false)),
  };
  const layers = [
    { id: "basemap" },
    { id: BAND_ANCHOR.zones },
    { id: "device-range-fill" },
    { id: "device-points" },
  ];
  return {
    doubleClickZoom: dcz,
    getLayersOrder: () => layers.map((l) => l.id),
    queryRenderedFeatures: () =>
      opts.above
        ? [{ layer: { id: "device-points", type: "symbol" } }]
        : opts.halo
          ? [{ layer: { id: "device-range-fill", type: "fill" } }, { layer: { id: "basemap", type: "fill" } }]
          : [{ layer: { id: "basemap", type: "fill" } }],
    on: vi.fn(),
  };
}

function source(key: string | null): InspectSource & { opened: number } {
  const s = {
    opened: 0,
    hitAt: (): InspectHit | null => (key ? { key, open: () => s.opened++ } : null),
  };
  return s;
}

function setup(
  sources: InspectSource[],
  mapOpts: { above?: boolean; halo?: boolean } = {},
  suspended?: () => boolean,
) {
  const map = fakeMap(mapOpts);
  const fallback = { opened: 0 };
  const onTriple = vi.fn();
  const insp = new MapInspector(map as never, {
    sources,
    fallback: () => ({ key: "spot", open: () => fallback.opened++ }),
    onTriple,
    suspended,
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

  it("a big translucent fill drawn above the areas (a range halo) does not block", () => {
    const zone = source("zone:a");
    const { tap } = setup([zone], { halo: true });
    tap(3);
    expect(zone.opened).toBe(1);
  });

  it("taps while picking a spot on the map neither count nor open anything", () => {
    let picking = true;
    const zone = source("zone:a");
    const { tap } = setup([zone], {}, () => picking);
    tap(3);
    expect(zone.opened).toBe(0);
    picking = false;
    tap(3);
    expect(zone.opened).toBe(1);
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
});

// ---------------------------------------------------------------------------
// Input: touch taps from touch events, and the inspector's own double-tap zoom
// ---------------------------------------------------------------------------

function liveMap(above = false) {
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const dcz = {
    enabled: true,
    isEnabled: () => dcz.enabled,
    enable: vi.fn(() => (dcz.enabled = true)),
    disable: vi.fn(() => (dcz.enabled = false)),
  };
  const map = {
    doubleClickZoom: dcz,
    zoom: 14,
    getZoom: () => map.zoom,
    getMaxZoom: () => 22,
    easeTo: vi.fn((o: { zoom: number }) => (map.zoom = o.zoom)),
    on: (type: string, fn: (e: unknown) => void) =>
      handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    fire: (type: string, e: unknown) => (handlers.get(type) ?? []).forEach((f) => f(e)),
    getLayersOrder: () => ["basemap", BAND_ANCHOR.zones, "device-points"],
    queryRenderedFeatures: () =>
      above ? [{ layer: { id: "device-points", type: "symbol" } }] : [],
  };
  return map;
}

function harness(key = "equity:EQ_001", above = false) {
  let t = 1_000;
  const map = liveMap(above);
  const target = source(key);
  const insp = new MapInspector(map as never, {
    sources: [target],
    fallback: () => ({ key: "spot", open: () => {} }),
    now: () => t,
  });
  insp.attach();
  const at = { x: 100, y: 100 };
  const ll = { lng: -104.9, lat: 39.7 };
  const touchTap = (move = 0, hold = 60) => {
    map.fire("touchstart", { points: [at], point: at, lngLat: ll });
    t += hold;
    const end = { x: at.x + move, y: at.y };
    map.fire("touchend", { points: [end], point: end, lngLat: ll, originalEvent: { touches: [] } });
  };
  const click = () => map.fire("click", { point: at, lngLat: ll });
  const wait = (ms: number) => {
    t += ms;
    vi.advanceTimersByTime(ms);
  };
  return { map, target, touchTap, click, wait };
}

describe("MapInspector input", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("takes over the map's double-tap zoom", () => {
    const { map } = harness();
    expect(map.doubleClickZoom.disable).toHaveBeenCalled();
  });

  it("a touch triple-tap opens the card and NEVER zooms (the Android bug)", () => {
    const { map, target, touchTap, wait, click } = harness();
    touchTap(); wait(120); touchTap(); wait(150); touchTap();
    // The browser's late clicks for those taps are echoes, not more taps.
    wait(200); click(); click(); click();
    wait(2000);
    expect(target.opened).toBe(1);
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("a slightly wobbly fingertip still counts as a tap", () => {
    const { target, touchTap, wait } = harness();
    touchTap(8); wait(120); touchTap(6); wait(120); touchTap(9);
    expect(target.opened).toBe(1);
  });

  it("a drag or a long press is not a tap", () => {
    const { target, touchTap, wait } = harness();
    touchTap(40); wait(100); touchTap(40); wait(100); touchTap(40);
    expect(target.opened).toBe(0);
    touchTap(0, 900); wait(100); touchTap(0, 900); wait(100); touchTap(0, 900);
    expect(target.opened).toBe(0);
  });

  it("a double-tap still zooms in, one beat later", () => {
    const { map, target, touchTap, wait } = harness();
    touchTap(); wait(150); touchTap();
    expect(map.easeTo).not.toHaveBeenCalled();
    wait(ZOOM_DEFER_MS + 10);
    expect(map.easeTo).toHaveBeenCalledTimes(1);
    expect(map.zoom).toBe(15);
    expect(target.opened).toBe(0);
  });

  it("a double-click with a mouse zooms too; a triple-click opens the card", () => {
    const h = harness();
    h.click(); h.wait(150); h.click(); h.wait(ZOOM_DEFER_MS + 10);
    expect(h.map.easeTo).toHaveBeenCalledTimes(1);
    const g = harness();
    g.click(); g.wait(150); g.click(); g.wait(150); g.click(); g.wait(1000);
    expect(g.target.opened).toBe(1);
    expect(g.map.easeTo).not.toHaveBeenCalled();
  });

  it("on a scooter: a double-tap still zooms, a triple opens no area card", () => {
    const { map, target, touchTap, wait } = harness("zone:a", true);
    touchTap(); wait(150); touchTap(); wait(ZOOM_DEFER_MS + 10);
    expect(map.easeTo).toHaveBeenCalledTimes(1);
    wait(2000);
    touchTap(); wait(120); touchTap(); wait(120); touchTap();
    expect(target.opened).toBe(0);
  });
});

describe("buildSpotHtml", () => {
  it("can't rule a zone out before the zones have loaded", () => {
    const html = buildSpotHtml({ zones: "not_loaded", inEquityArea: false });
    expect(html).toContain("haven't loaded");
    expect(html).not.toContain("No city slow");
  });

  it("says no zone covers the spot only when zones are drawn", () => {
    expect(buildSpotHtml({ zones: "shown", inEquityArea: false })).toContain(
      "No city slow, no-riding or no-parking zone covers this spot.",
    );
    const hidden = buildSpotHtml({ zones: "off", inEquityArea: false });
    expect(hidden).toContain("switched off in Areas");
    expect(hidden).not.toContain("No city slow");
  });

  it("says no Equity Area discount applies outside them, and nothing before they load", () => {
    const out = buildSpotHtml({ zones: "shown", inEquityArea: false });
    expect(out).toContain("no Equity Area discount applies here");
    // Outside Denver Veo may not even operate; the card claims only what the
    // boundaries support.
    expect(out).not.toContain("standard Veo rate");
    expect(buildSpotHtml({ zones: "shown", inEquityArea: null })).not.toContain("Equity Areas,");
  });

  it("teaches the gesture", () => {
    expect(buildSpotHtml({ zones: "shown", inEquityArea: null })).toContain("Triple-tap");
    expect(SPOT_INSPECT_TITLE).toBe("Nothing marked here");
  });
});
