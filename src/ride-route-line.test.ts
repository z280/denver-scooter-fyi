// @vitest-environment happy-dom
//
// The planned pathway on the map: turn-by-turn navigation used to be
// words-only — ride-nav-hud.ts showed the maneuver card and directions list,
// but nothing ever drew the route those instructions describe on the map
// underneath. `ride-route-line.ts` is that picture; these tests cover it at
// the same two levels `ride-trail.test.ts` uses, for the same reasons:
//
//   1. `ride-route-line.ts` alone — source/layer/setData/visibility behavior
//      against a fake map that records what it was handed.
//   2. The WIRING, through the real `RideHud` class: `mountNavHud` draws the
//      session doc's route when the nav overlay mounts, an off-route
//      re-route's `onRouteUpdate` redraws it, a press-and-hold dismiss wipes
//      it, and End Ride wipes it. Driven only through public entry points
//      (`beginHandoff` + real DOM events), never private methods.
//
// The maplibre mock and geolocation stub follow
// `ride-hud-integration.test.ts`'s approach: real marker wiring needs a live
// WebGL canvas happy-dom cannot provide.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => {
  class FakeMarker {
    constructor(readonly opts: { element: HTMLElement }) {}
    setLngLat(): this {
      return this;
    }
    addTo(): this {
      return this;
    }
    remove(): this {
      return this;
    }
  }
  return { default: { Marker: FakeMarker } };
});

import { createRideRouteLine } from "./ride-route-line.ts";
import { RIDE_TRAIL_CASING_LAYER } from "./ride-trail.ts";
import { RideHud, type RideDeviceControl } from "./ride-hud.ts";
import { NAV_DISMISS_HOLD_MS, decodePolyline } from "./ride-nav-hud.ts";
import { PROFILE_COLORS } from "./ride-screen-routes.ts";
import { encodePolyline } from "./polyline-encode.ts";
import type { RideOptions, RouteManeuver } from "./api.ts";
import type { RideSessionDoc, RideSessionRoute } from "./ride-session.ts";

// ---------------------------------------------------------------------------
// Fixtures — the same straight-line eastbound route the integration test
// uses, so "on route" fixes are trivially constructible.
// ---------------------------------------------------------------------------

const LAT = 39.7392;
const LNG0 = -104.9903;
const STEP = 0.0001;
const POINTS = 6;

function routeCoords(): [number, number][] {
  return Array.from({ length: POINTS }, (_, i) => [LNG0 + i * STEP, LAT]);
}

const MANEUVER: RouteManeuver = {
  instruction: "Head east on Main St",
  type: 1,
  street_names: ["Main St"],
  length_meters: 42,
  time_seconds: 12,
  begin_shape_index: 0,
  end_shape_index: POINTS - 1,
};

function buildRoute(): RideSessionRoute {
  return {
    profile: "shade",
    rideRouteId: null,
    distanceM: 42,
    durationS: 12,
    polyline: encodePolyline(routeCoords()),
    maneuvers: [MANEUVER],
  };
}

const OPTIONS: RideOptions = {
  cost_hud: true,
  speedometer: "digital",
  theme: "auto",
  navigation: true,
  save_tracks: true,
  battery_modeling: true,
  nav_improvement: false,
  end_survey: true,
  own_device: false,
};

function buildDoc(rideId: string, startedAtMs: number): RideSessionDoc {
  const [lng, lat] = routeCoords()[POINTS - 1];
  return {
    v: 1,
    state: "riding",
    screen: null,
    rideId,
    private: false,
    device: null,
    options: OPTIONS,
    dest: { label: "Union Station", lat, lon: lng },
    route: buildRoute(),
    startedAtMs,
    trackKeyId: rideId,
  };
}

// ---------------------------------------------------------------------------
// Fake map — a real (tiny) source/layer registry, like ride-trail.test.ts's:
// this module's whole job is "what did you hand MapLibre".
// ---------------------------------------------------------------------------

interface FakeSource {
  data: GeoJSON.FeatureCollection;
}

function fakeMap() {
  const sources = new Map<string, FakeSource>();
  const layers = new Map<
    string,
    { visibility: string; paint: Record<string, unknown>; before?: string }
  >();
  const layerOrder: string[] = [];
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 600 });
  const map = {
    addSource(id: string, spec: { data: GeoJSON.FeatureCollection }) {
      sources.set(id, { data: spec.data });
    },
    getSource(id: string) {
      const src = sources.get(id);
      if (!src) return undefined;
      return {
        setData(data: GeoJSON.FeatureCollection) {
          src.data = data;
        },
      };
    },
    addLayer(
      spec: { id: string; paint?: Record<string, unknown> },
      before?: string,
    ) {
      layers.set(spec.id, {
        visibility: "visible",
        paint: { ...(spec.paint ?? {}) },
        before,
      });
      const at = before ? layerOrder.indexOf(before) : -1;
      if (at >= 0) layerOrder.splice(at, 0, spec.id);
      else layerOrder.push(spec.id);
    },
    getLayer(id: string) {
      return layers.has(id) ? { id } : undefined;
    },
    removeLayer(id: string) {
      layers.delete(id);
      const at = layerOrder.indexOf(id);
      if (at >= 0) layerOrder.splice(at, 1);
    },
    setLayoutProperty(id: string, _prop: string, value: string) {
      const layer = layers.get(id);
      if (layer) layer.visibility = value;
    },
    setPaintProperty(id: string, prop: string, value: unknown) {
      const layer = layers.get(id);
      if (layer) layer.paint[prop] = value;
    },
    // Everything below is what RideHud (not the route line) calls.
    getCenter: () => ({ lng: LNG0, lat: LAT }),
    getZoom: () => 14,
    getPitch: () => 0,
    getBearing: () => 0,
    easeTo: () => {},
    getStyle: () => ({ layers: [] }),
    getContainer: () => container,
  };
  const data = (): GeoJSON.FeatureCollection | null =>
    sources.get("ride-route-active")?.data ?? null;
  return {
    map,
    layers,
    layerOrder,
    data,
    /** The drawn LineString's coordinates, or [] when there is none. */
    line: (): [number, number][] => {
      const feat = data()?.features.find(
        (f) => f.geometry.type === "LineString",
      );
      return feat
        ? ((feat.geometry as GeoJSON.LineString).coordinates as [
            number,
            number,
          ][])
        : [];
    },
    /** The drawn destination Point, or null. */
    dest: (): [number, number] | null => {
      const feat = data()?.features.find((f) => f.geometry.type === "Point");
      return feat
        ? ((feat.geometry as GeoJSON.Point).coordinates as [number, number])
        : null;
    },
  };
}

type AnyMap = ReturnType<typeof fakeMap>["map"];

function asMLMap(map: AnyMap) {
  return map as unknown as Parameters<typeof createRideRouteLine>[0];
}

function fakeDeviceCtl(): RideDeviceControl {
  return {
    setRideActive: () => {},
    setRideModelFilter: () => {},
    hasOpenPopup: () => false,
  };
}

function stubGeolocation(): void {
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    geolocation: {
      watchPosition: () => 1,
      clearWatch: () => {},
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. The handle alone
// ---------------------------------------------------------------------------

describe("createRideRouteLine", () => {
  it("draws the route line, in the given color, with the destination dot", () => {
    const rig = fakeMap();
    const handle = createRideRouteLine(asMLMap(rig.map));
    handle.set(routeCoords(), { color: "#CC79A7", dest: [LNG0, LAT] });
    expect(rig.line()).toEqual(routeCoords());
    expect(rig.dest()).toEqual([LNG0, LAT]);
    expect(rig.layers.get("ride-route-active-line")?.paint["line-color"]).toBe(
      "#CC79A7",
    );
  });

  it("draws no LineString for fewer than two coordinates (RFC 7946), but still marks the dest", () => {
    const rig = fakeMap();
    const handle = createRideRouteLine(asMLMap(rig.map));
    handle.set([[LNG0, LAT]], { color: "#CC79A7", dest: [LNG0, LAT] });
    expect(rig.line()).toEqual([]);
    expect(rig.dest()).toEqual([LNG0, LAT]);
  });

  it("replaces the whole drawn shape on a second set() — a re-route, not an append", () => {
    const rig = fakeMap();
    const handle = createRideRouteLine(asMLMap(rig.map));
    handle.set(routeCoords(), { color: "#CC79A7", dest: [LNG0, LAT] });
    const rerouted: [number, number][] = [
      [LNG0, LAT + STEP],
      [LNG0 + STEP, LAT + STEP],
    ];
    handle.set(rerouted, { color: "#CC79A7", dest: [LNG0, LAT] });
    expect(rig.line()).toEqual(rerouted);
  });

  it("hides and re-shows without forgetting (BRB), and clear() wipes the data", () => {
    const rig = fakeMap();
    const handle = createRideRouteLine(asMLMap(rig.map));
    handle.set(routeCoords(), { color: "#CC79A7" });
    handle.setVisible(false);
    for (const id of [
      "ride-route-active-casing",
      "ride-route-active-line",
      "ride-route-active-dest",
    ]) {
      expect(rig.layers.get(id)?.visibility).toBe("none");
    }
    expect(rig.line()).toEqual(routeCoords()); // hidden, not forgotten
    handle.setVisible(true);
    expect(rig.layers.get("ride-route-active-line")?.visibility).toBe(
      "visible",
    );
    handle.clear();
    expect(rig.data()?.features).toEqual([]);
  });

  it("clear() before any set() never creates layers just to draw nothing", () => {
    const rig = fakeMap();
    const handle = createRideRouteLine(asMLMap(rig.map));
    handle.clear();
    expect(rig.layers.size).toBe(0);
    expect(rig.data()).toBeNull();
  });

  it("inserts beneath the trail's casing when the trail already drew", () => {
    const rig = fakeMap();
    // The trail's layers exist first — exactly the real enterRiding order
    // (trail.reset() runs before renderRiding ever mounts the nav overlay).
    rig.map.addLayer({ id: RIDE_TRAIL_CASING_LAYER });
    const handle = createRideRouteLine(asMLMap(rig.map));
    handle.set(routeCoords(), { color: "#CC79A7" });
    const trailAt = rig.layerOrder.indexOf(RIDE_TRAIL_CASING_LAYER);
    for (const id of [
      "ride-route-active-casing",
      "ride-route-active-line",
      "ride-route-active-dest",
    ]) {
      expect(rig.layerOrder.indexOf(id)).toBeLessThan(trailAt);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The wiring, through the real RideHud
// ---------------------------------------------------------------------------

describe("RideHud + ride-route-line: the pathway is superimposed with the nav overlay", () => {
  function mountRiding(doc: RideSessionDoc) {
    stubGeolocation();
    const rig = fakeMap();
    const routeLine = createRideRouteLine(asMLMap(rig.map));
    const dispatch = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const hud = new RideHud(
      container,
      async () => [],
      rig.map as unknown as ConstructorParameters<typeof RideHud>[2],
      fakeDeviceCtl(),
      { session: { current: () => doc, dispatch }, routeLine },
    );
    return { hud, container, rig, dispatch };
  }

  it("mounting the nav overlay draws the session doc's route in the chosen profile's Screen 4 color, dest marked", () => {
    const doc = buildDoc("ride-line-1", Date.now());
    const { hud, container, rig } = mountRiding(doc);
    hud.beginHandoff({
      rideId: doc.rideId,
      startedAtMs: doc.startedAtMs as number,
      recorder: null,
    });
    // The overlay mounted…
    expect(container.querySelector(".nav-hud")).not.toBeNull();
    // …and the pathway it narrates is on the map: the decoded polyline (the
    // very shape ride-nav-hud matches fixes against), the dest dot, and the
    // profile's own color — this doc chose "shade".
    expect(rig.line()).toEqual(
      decodePolyline(buildRoute().polyline).map((c) => [c[0], c[1]]),
    );
    expect(rig.dest()).toEqual([doc.dest!.lon, doc.dest!.lat]);
    expect(rig.layers.get("ride-route-active-line")?.paint["line-color"]).toBe(
      PROFILE_COLORS.shade,
    );
  });

  it("a ride with no route (nav off / out of coverage) draws nothing", () => {
    const doc: RideSessionDoc = {
      ...buildDoc("ride-line-2", Date.now()),
      dest: null,
      route: null,
    };
    const { hud, rig, container } = mountRiding(doc);
    hud.beginHandoff({
      rideId: doc.rideId,
      startedAtMs: doc.startedAtMs as number,
      recorder: null,
    });
    expect(container.querySelector(".nav-hud")).toBeNull();
    expect(rig.data()).toBeNull();
  });

  it("a press-and-hold dismiss of the nav overlay takes the pathway off the map too", () => {
    vi.useFakeTimers();
    try {
      const doc = buildDoc("ride-line-3", Date.now());
      const { hud, container, rig } = mountRiding(doc);
      hud.beginHandoff({
        rideId: doc.rideId,
        startedAtMs: doc.startedAtMs as number,
        recorder: null,
      });
      expect(rig.line().length).toBeGreaterThan(0);
      const arrow = container.querySelector<HTMLButtonElement>(
        ".nav-hud__arrow--left",
      );
      expect(arrow).not.toBeNull();
      arrow!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      vi.advanceTimersByTime(NAV_DISMISS_HOLD_MS);
      // Guidance is gone — instructions and pathway alike.
      expect(container.querySelector(".nav-hud")).toBeNull();
      expect(rig.data()?.features).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("End Ride wipes the pathway along with the rest of the ride decorations", async () => {
    const doc = buildDoc("ride-line-4", Date.now() - 5000);
    const { hud, container, rig, dispatch } = mountRiding(doc);
    hud.beginHandoff({
      rideId: doc.rideId,
      startedAtMs: doc.startedAtMs as number,
      recorder: null,
    });
    expect(rig.line().length).toBeGreaterThan(0);
    container.querySelector<HTMLButtonElement>('[data-hud="end"]')?.click();
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ type: "endRide" });
    });
    expect(rig.data()?.features).toEqual([]);
  });
});
