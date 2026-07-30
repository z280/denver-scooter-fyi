// @vitest-environment happy-dom
//
// Screen 4 — route choice. Covers: the skip gate (navigation on/off), the
// missing-origin/destination degrade, tombstone loading rendering (light —
// presentational), profile-toggle selection state (auto-select-first,
// manual re-select), the 404-tolerant `POST /ride-routes` path (the flow
// proceeds, `rideRouteId` stays null, no error state), the total-failure
// graceful degrade (nav off, ride proceeds), and the pure map/format
// helpers in isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  type RideOptions,
  type RouteProperties,
  type RouteProfilesResponse,
  type RouteResponse,
} from "./api.ts";
import type { LngLat } from "./locate.ts";
import type { RideDestWithCoverage } from "./ride-screen-dest.ts";
import {
  currentRideScreen,
  openRideModal,
  resetRideModal,
  rideModalRoot,
} from "./ride-modal.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  PROFILE_COLORS,
  buildPointsFeatureCollection,
  buildRouteFeatureCollection,
  clearNavigationForRide,
  colorForProfile,
  computeBounds,
  formatMiles,
  formatMinutes,
  lineStringLengthMeters,
  resolveFlavor,
  resolveOrigin,
  wireRideScreenRoutes,
  type DevicesLike,
  type LocateLike,
  type RideScreenRoutesDeps,
  type RouteMapLike,
  type RouteState,
} from "./ride-screen-routes.ts";

// ---------------------------------------------------------------------------
// fixtures / helpers
// ---------------------------------------------------------------------------

const ORIGIN: LngLat = { lng: -104.9903, lat: 39.7392 };
const DEST: RideDestWithCoverage = {
  label: "Union Station",
  lat: 39.7534,
  lon: -105.0007,
  inCoverage: true,
};

const LABELS: Record<string, string> = {
  safe: "Safe & Protected",
  range: "The Range Maximizer",
  shade: "The Shaded Canopy",
  express: "Commuter Express",
};

function baseOptions(overrides: Partial<RideOptions> = {}): RideOptions {
  return {
    cost_hud: false,
    speedometer: "classic",
    theme: "auto",
    navigation: true,
    save_tracks: true,
    battery_modeling: false,
    nav_improvement: false,
    end_survey: false,
    own_device: false,
    ...overrides,
  };
}

/** A session doc already on Screen 4 with a destination picked — the state
 *  this screen is always built against in the real flow (Screen 3 sets
 *  `dest` before advancing here). */
function sessionOnScreen4(
  options: RideOptions,
  dest: RideDestWithCoverage | null = DEST,
): RideSessionStore {
  const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
  store.dispatch({ type: "open", options, screen: "4" });
  if (dest) store.dispatch({ type: "setDest", dest });
  return store;
}

function fakeLocate(fix: LngLat | null): LocateLike {
  return { current: () => fix };
}

function profilesResponse(keys: string[], defaultKey = keys[0] ?? "safe"): RouteProfilesResponse {
  return {
    default: defaultKey,
    graph_bbox: [-105.11, 39.61, -104.6, 39.91],
    profiles: keys.map((k) => ({ key: k, label: LABELS[k] ?? k, shade_ranked: k === "shade" })),
  };
}

function fakeRoute(
  profile: string,
  coords: [number, number][],
  overrides: Partial<RouteProperties> = {},
): RouteResponse {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      profile,
      label: LABELS[profile] ?? profile,
      distance_meters: 1200,
      duration_seconds: 360,
      elevation_gain_meters: 4,
      shade_score: null,
      battery_percent_estimate: null,
      battery_model: "unavailable",
      graph_bbox: [-105.11, 39.61, -104.6, 39.91],
      maneuvers: [],
      ...overrides,
    },
  };
}

const ROUTE_COORDS: [number, number][] = [
  [ORIGIN.lng, ORIGIN.lat],
  [-104.995, 39.745],
  [DEST.lon, DEST.lat],
];

/** A working fake map — captures every call this screen makes so tests can
 *  assert on source/layer wiring and `setData`/`fitBounds` traffic without
 *  a real WebGL context (unavailable under happy-dom). */
function fakeRouteMap(): { map: RouteMapLike; calls: FakeMapCalls } {
  const calls: FakeMapCalls = {
    addSourceIds: [],
    addLayerIds: [],
    setDataCalls: [],
    fitBoundsCalls: [],
    resizeCalls: 0,
    removeCalls: 0,
  };
  const sources = new Set<string>();
  const map = {
    addSource: (id: string) => {
      calls.addSourceIds.push(id);
      sources.add(id);
    },
    getSource: (id: string) => {
      if (!sources.has(id)) return undefined;
      return {
        setData: (data: GeoJSON.FeatureCollection) => {
          calls.setDataCalls.push({ source: id, data });
        },
      };
    },
    addLayer: (layer: { id: string }) => {
      calls.addLayerIds.push(layer.id);
    },
    fitBounds: (bounds: unknown) => {
      calls.fitBoundsCalls.push(bounds);
    },
    resize: () => {
      calls.resizeCalls += 1;
    },
    remove: () => {
      calls.removeCalls += 1;
    },
  } as unknown as RouteMapLike;
  return { map, calls };
}

interface FakeMapCalls {
  addSourceIds: string[];
  addLayerIds: string[];
  setDataCalls: { source: string; data: GeoJSON.FeatureCollection }[];
  fitBoundsCalls: unknown[];
  resizeCalls: number;
  removeCalls: number;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(times = 6): Promise<void> {
  return (async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  })();
}

function baseDeps(
  session: RideSessionStore,
  overrides: Partial<RideScreenRoutesDeps> = {},
): RideScreenRoutesDeps {
  return {
    session,
    locate: fakeLocate(ORIGIN),
    createMap: async () => fakeRouteMap().map,
    ...overrides,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

afterEach(() => {
  resetRideModal();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// skip gate
// ---------------------------------------------------------------------------

describe("wireRideScreenRoutes — skip gate", () => {
  it("skips Screen 4 when navigation is off", () => {
    const session = sessionOnScreen4(baseOptions({ navigation: false }));
    wireRideScreenRoutes(baseDeps(session));
    openRideModal({ fastForwardTo: "4" });
    // Nothing registered past "4" in this test file, so the router lands on
    // the next flow step ("6") as an unwired placeholder — proof "4" itself
    // was stepped over, not rendered.
    expect(currentRideScreen()).toBe("6");
  });

  it("shows Screen 4 when navigation is on", async () => {
    const session = sessionOnScreen4(baseOptions({ navigation: true }));
    const fetchRouteProfiles = vi.fn(() => new Promise<RouteProfilesResponse>(() => {}));
    const fetchRoute = vi.fn(() => new Promise<RouteResponse>(() => {}));
    wireRideScreenRoutes(baseDeps(session, { fetchRouteProfiles, fetchRoute }));
    openRideModal({ fastForwardTo: "4" });
    expect(currentRideScreen()).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// missing origin/destination — immediate degrade
// ---------------------------------------------------------------------------

describe("Screen 4 — missing origin or destination", () => {
  it("degrades immediately (no network calls) when there is no GPS fix and no destination", () => {
    const session = sessionOnScreen4(baseOptions(), null);
    const fetchRouteProfiles = vi.fn();
    wireRideScreenRoutes(
      baseDeps(session, { locate: fakeLocate(null), fetchRouteProfiles }),
    );
    openRideModal({ fastForwardTo: "4" });

    expect(currentRideScreen()).toBe("4");
    const root = rideModalRoot();
    expect(root?.querySelector(".ride-route-degrade")).not.toBeNull();
    expect(fetchRouteProfiles).not.toHaveBeenCalled();
  });

  it("[Continue without navigation] clears nav options and advances", () => {
    const session = sessionOnScreen4(baseOptions({ navigation: true, nav_improvement: true }), null);
    wireRideScreenRoutes(baseDeps(session, { locate: fakeLocate(null) }));
    openRideModal({ fastForwardTo: "4" });

    const btn = rideModalRoot()?.querySelector<HTMLButtonElement>(".ride-route-degrade button");
    expect(btn).not.toBeNull();
    btn?.click();

    expect(currentRideScreen()).toBe("6");
    const doc = session.current();
    expect(doc?.options.navigation).toBe(false);
    expect(doc?.options.nav_improvement).toBe(false);
    expect(doc?.route).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loading state (tombstones) — light, presentational
// ---------------------------------------------------------------------------

describe("Screen 4 — loading state", () => {
  it("renders four tombstone cards while profiles/routes are in flight", () => {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteProfiles = vi.fn(() => new Promise<RouteProfilesResponse>(() => {}));
    const fetchRoute = vi.fn(() => new Promise<RouteResponse>(() => {}));
    wireRideScreenRoutes(baseDeps(session, { fetchRouteProfiles, fetchRoute }));
    openRideModal({ fastForwardTo: "4" });

    const tombstones = rideModalRoot()?.querySelectorAll(".ride-route-tombstone");
    expect(tombstones?.length).toBe(4);
    expect(rideModalRoot()?.querySelector(".ride-route-status")?.textContent).toBe(
      "Loading route options…",
    );
    const next = rideModalRoot()?.querySelector<HTMLButtonElement>(".ride-route-next");
    expect(next?.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// profile toggle selection
// ---------------------------------------------------------------------------

describe("Screen 4 — profile toggle selection", () => {
  it("auto-selects the first route to arrive, then lets the rider pick another", async () => {
    const session = sessionOnScreen4(baseOptions());
    const safeDeferred = deferred<RouteResponse>();
    const expressDeferred = deferred<RouteResponse>();
    const fetchRouteProfiles = vi.fn(() => Promise.resolve(profilesResponse(["safe", "express"])));
    const fetchRoute = vi.fn((q: { profile?: string }) => {
      if (q.profile === "safe") return safeDeferred.promise;
      return expressDeferred.promise;
    });
    wireRideScreenRoutes(baseDeps(session, { fetchRouteProfiles, fetchRoute }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    // Express arrives first this time — it should be auto-selected even
    // though it's not first in the profile list.
    expressDeferred.resolve(fakeRoute("express", ROUTE_COORDS));
    await flush();

    const root = rideModalRoot();
    const expressBtn = root?.querySelector<HTMLButtonElement>('[data-profile="express"]');
    expect(expressBtn?.classList.contains("is-selected")).toBe(true);
    expect(expressBtn?.getAttribute("aria-pressed")).toBe("true");
    const next = root?.querySelector<HTMLButtonElement>(".ride-route-next");
    expect(next?.disabled).toBe(false);
    expect(next?.textContent).toBe("NEXT >>");

    safeDeferred.resolve(fakeRoute("safe", ROUTE_COORDS));
    await flush();

    // Second arrival must NOT steal the selection away from the rider's
    // (or the auto-select's) existing pick.
    expect(root?.querySelector<HTMLButtonElement>('[data-profile="express"]')?.classList.contains("is-selected")).toBe(true);

    // render() rebuilds the list on every state change (replaceChildren), so
    // re-query after the click rather than reuse the pre-click node — the
    // one captured before is a detached element by the time this returns.
    root?.querySelector<HTMLButtonElement>('[data-profile="safe"]')?.click();
    expect(root?.querySelector<HTMLButtonElement>('[data-profile="safe"]')?.classList.contains("is-selected")).toBe(true);
    expect(root?.querySelector<HTMLButtonElement>('[data-profile="express"]')?.classList.contains("is-selected")).toBe(false);
  });

  it("shows only the profiles that resolved when some are out of coverage (partial degrade)", async () => {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteProfiles = vi.fn(() => Promise.resolve(profilesResponse(["safe", "range"])));
    const fetchRoute = vi.fn((q: { profile?: string }) => {
      if (q.profile === "safe") return Promise.resolve(fakeRoute("safe", ROUTE_COORDS));
      return Promise.reject(
        new ApiError("out of coverage", "HTTP_ERROR", { status: 400, errorKey: "out_of_coverage" }),
      );
    });
    wireRideScreenRoutes(baseDeps(session, { fetchRouteProfiles, fetchRoute }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    const root = rideModalRoot();
    expect(root?.querySelectorAll(".ride-route-option").length).toBe(1);
    expect(root?.querySelector('[data-profile="safe"]')).not.toBeNull();
    expect(root?.querySelector('[data-profile="range"]')).toBeNull();
    expect(root?.querySelector(".ride-route-status")?.textContent).toBe(
      "1 of 2 route styles are available for this trip.",
    );
    expect(root?.querySelector<HTMLButtonElement>(".ride-route-next")?.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEXT — the 404-tolerant POST /ride-routes path
// ---------------------------------------------------------------------------

describe("Screen 4 — NEXT: POST /ride-routes", () => {
  it("advances immediately and tolerates a 404 (A3 not deployed yet) without setting rideRouteId", async () => {
    const session = sessionOnScreen4(baseOptions({ nav_improvement: true, save_tracks: true }));
    const fetchRouteProfiles = vi.fn(() => Promise.resolve(profilesResponse(["safe"])));
    const fetchRoute = vi.fn(() => Promise.resolve(fakeRoute("safe", ROUTE_COORDS)));
    const postDeferred = deferred<{ ride_route_id: string }>();
    const postRideRoute = vi.fn(() => postDeferred.promise);
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteProfiles, fetchRoute, postRideRoute }),
    );
    openRideModal({ fastForwardTo: "4" });
    await flush();

    const next = rideModalRoot()?.querySelector<HTMLButtonElement>(".ride-route-next");
    expect(next?.disabled).toBe(false);
    next?.click();

    // Advance happens synchronously — before the POST has even been given a
    // chance to reject. Non-blocking means non-blocking.
    expect(currentRideScreen()).toBe("6");
    expect(session.current()?.route?.profile).toBe("safe");
    expect(session.current()?.route?.rideRouteId).toBeNull();
    expect(postRideRoute).toHaveBeenCalledTimes(1);

    postDeferred.reject(
      new ApiError("not found", "HTTP_ERROR", { status: 404, errorKey: "not_found" }),
    );
    await flush();

    // Still no error state, still null — the ride already proceeded.
    expect(session.current()?.route?.rideRouteId).toBeNull();
    expect(currentRideScreen()).toBe("6");
  });

  it("on success, patches rideRouteId onto the session doc's route", async () => {
    const session = sessionOnScreen4(baseOptions({ nav_improvement: true, save_tracks: true }));
    const fetchRouteProfiles = vi.fn(() => Promise.resolve(profilesResponse(["safe"])));
    const fetchRoute = vi.fn(() => Promise.resolve(fakeRoute("safe", ROUTE_COORDS)));
    const postRideRoute = vi.fn(() => Promise.resolve({ ride_route_id: "rr_123" }));
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteProfiles, fetchRoute, postRideRoute }),
    );
    openRideModal({ fastForwardTo: "4" });
    await flush();

    rideModalRoot()?.querySelector<HTMLButtonElement>(".ride-route-next")?.click();
    await flush();

    expect(session.current()?.route?.rideRouteId).toBe("rr_123");
    expect(postRideRoute).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "safe", route_polyline: expect.any(String) }),
    );
  });

  it("does NOT call POST /ride-routes when nav_improvement is off", async () => {
    const session = sessionOnScreen4(baseOptions({ nav_improvement: false }));
    const fetchRouteProfiles = vi.fn(() => Promise.resolve(profilesResponse(["safe"])));
    const fetchRoute = vi.fn(() => Promise.resolve(fakeRoute("safe", ROUTE_COORDS)));
    const postRideRoute = vi.fn(() => Promise.resolve({ ride_route_id: "rr_999" }));
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteProfiles, fetchRoute, postRideRoute }),
    );
    openRideModal({ fastForwardTo: "4" });
    await flush();

    rideModalRoot()?.querySelector<HTMLButtonElement>(".ride-route-next")?.click();
    await flush();

    expect(postRideRoute).not.toHaveBeenCalled();
    expect(session.current()?.route?.rideRouteId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// total failure — every profile out of coverage / erroring
// ---------------------------------------------------------------------------

describe("Screen 4 — total failure (graceful degrade)", () => {
  it("offers Continue without navigation, clears nav options, and proceeds", async () => {
    const session = sessionOnScreen4(baseOptions({ navigation: true, nav_improvement: true }));
    const fetchRouteProfiles = vi.fn(() => Promise.resolve(profilesResponse(["safe", "range"])));
    const fetchRoute = vi.fn(() =>
      Promise.reject(
        new ApiError("out of coverage", "HTTP_ERROR", { status: 400, errorKey: "out_of_coverage" }),
      ),
    );
    wireRideScreenRoutes(baseDeps(session, { fetchRouteProfiles, fetchRoute }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    const root = rideModalRoot();
    expect(root?.querySelectorAll(".ride-route-option").length).toBe(0);
    const next = root?.querySelector<HTMLButtonElement>(".ride-route-next");
    expect(next?.disabled).toBe(false);
    expect(next?.textContent).toBe("Continue without navigation");

    next?.click();
    expect(currentRideScreen()).toBe("6");
    expect(session.current()?.options.navigation).toBe(false);
    expect(session.current()?.options.nav_improvement).toBe(false);
    expect(session.current()?.route).toBeNull();
  });

  it("falls back to the known profile list when GET /route/profiles itself fails", async () => {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteProfiles = vi.fn(() => Promise.reject(new Error("sidecar down")));
    const fetchRoute = vi.fn(() => Promise.resolve(fakeRoute("safe", ROUTE_COORDS)));
    wireRideScreenRoutes(baseDeps(session, { fetchRouteProfiles, fetchRoute }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    // Every fallback profile got a real /route call — never hardcoded past
    // a working /route/profiles response, but never a dead end either.
    expect(fetchRoute).toHaveBeenCalledTimes(4);
    expect(rideModalRoot()?.querySelectorAll(".ride-route-option").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// map wiring (light — presentational, but the source/layer contract matters)
// ---------------------------------------------------------------------------

describe("Screen 4 — map preview wiring", () => {
  it("adds the route + point sources/layers and feeds them origin/dest immediately, routes as they arrive", async () => {
    const { map, calls } = fakeRouteMap();
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteProfiles = vi.fn(() => Promise.resolve(profilesResponse(["safe"])));
    const fetchRoute = vi.fn(() => Promise.resolve(fakeRoute("safe", ROUTE_COORDS)));
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteProfiles, fetchRoute, createMap: async () => map }),
    );
    openRideModal({ fastForwardTo: "4" });
    await flush();

    expect(calls.addSourceIds).toEqual(
      expect.arrayContaining(["ride-route-lines", "ride-route-points"]),
    );
    expect(calls.addLayerIds.length).toBe(2);
    const pointsCall = calls.setDataCalls.find((c) => c.source === "ride-route-points");
    expect(pointsCall?.data.features.length).toBe(2);
    const routesCall = calls.setDataCalls
      .filter((c) => c.source === "ride-route-lines")
      .at(-1);
    expect(routesCall?.data.features.length).toBe(1);
    expect(calls.fitBoundsCalls.length).toBeGreaterThan(0);
  });

  it("removes the map on screen teardown", async () => {
    const { map, calls } = fakeRouteMap();
    const session = sessionOnScreen4(baseOptions());
    wireRideScreenRoutes(
      baseDeps(session, {
        fetchRouteProfiles: () => new Promise(() => {}),
        fetchRoute: () => new Promise(() => {}),
        createMap: async () => map,
      }),
    );
    openRideModal({ fastForwardTo: "4" });
    await flush();
    resetRideModal();
    expect(calls.removeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("resolveOrigin", () => {
  it("prefers the live GPS fix over the device feed lookup", () => {
    const doc = sessionOnScreen4(baseOptions()).current()!;
    const devices: DevicesLike = {
      allFeatures: () => [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1, -1] },
          properties: { device_id: "d1", form_factor: "scooter", spatial_status: "available" },
        },
      ],
    };
    const origin = resolveOrigin(doc, { locate: fakeLocate(ORIGIN), devices });
    expect(origin).toEqual(ORIGIN);
  });

  it("falls back to the selected device's feed position when GPS is unavailable", () => {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    store.dispatch({ type: "open", options: baseOptions(), screen: "4" });
    store.dispatch({
      type: "setDevice",
      device: { vehicleIdentifier: "abc123", plate: null, model: "Astro", batteryConfirmed: null },
    });
    const doc = store.current()!;
    const devices: DevicesLike = {
      allFeatures: () => [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-104.98, 39.75] },
          properties: {
            device_id: "d1",
            form_factor: "scooter",
            spatial_status: "available",
            vehicle_identifier: "abc123",
          },
        },
      ],
    };
    const origin = resolveOrigin(doc, { locate: fakeLocate(null), devices });
    expect(origin).toEqual({ lng: -104.98, lat: 39.75 });
  });

  it("returns null when neither GPS nor a device lookup can resolve a position", () => {
    const doc = sessionOnScreen4(baseOptions()).current()!;
    const origin = resolveOrigin(doc, { locate: fakeLocate(null) });
    expect(origin).toBeNull();
  });
});

describe("resolveFlavor", () => {
  it("passes light/dark through unchanged", () => {
    expect(resolveFlavor("light")).toBe("light");
    expect(resolveFlavor("dark")).toBe("dark");
  });

  it("resolves auto against the OS preference without throwing", () => {
    expect(["light", "dark"]).toContain(resolveFlavor("auto"));
  });
});

describe("format helpers", () => {
  it("formatMiles", () => {
    expect(formatMiles(30)).toBe("<0.1 mi");
    expect(formatMiles(1609.344)).toBe("1.0 mi");
    expect(formatMiles(4023)).toBe("2.5 mi");
  });

  it("formatMinutes floors at 1 minute", () => {
    expect(formatMinutes(10)).toBe("1 min");
    expect(formatMinutes(600)).toBe("10 min");
  });

  it("lineStringLengthMeters sums haversine segments", () => {
    const meters = lineStringLengthMeters([
      [ORIGIN.lng, ORIGIN.lat],
      [ORIGIN.lng, ORIGIN.lat + 0.01],
    ]);
    expect(meters).toBeGreaterThan(1000);
    expect(meters).toBeLessThan(1200);
  });

  it("colorForProfile falls back to the neutral color for an unknown key", () => {
    expect(colorForProfile("safe")).toBe(PROFILE_COLORS.safe);
    expect(colorForProfile("some_future_profile")).toBe("#8a8f98");
  });
});

describe("buildRouteFeatureCollection / buildPointsFeatureCollection / computeBounds", () => {
  function readyState(key: string, coords: [number, number][]): RouteState {
    return { key, label: LABELS[key] ?? key, status: "ready", response: fakeRoute(key, coords) };
  }

  it("sorts the selected route last so it paints on top", () => {
    const results = new Map<string, RouteState>([
      ["safe", readyState("safe", ROUTE_COORDS)],
      ["express", readyState("express", ROUTE_COORDS)],
    ]);
    const fc = buildRouteFeatureCollection(results, "safe");
    expect(fc.features.at(-1)?.properties?.profile).toBe("safe");
    expect(fc.features.every((f) => "profile" in (f.properties ?? {}))).toBe(true);
  });

  it("omits loading/error entries entirely", () => {
    const results = new Map<string, RouteState>([
      ["safe", readyState("safe", ROUTE_COORDS)],
      ["range", { key: "range", label: "Range", status: "loading" }],
      ["shade", { key: "shade", label: "Shade", status: "error" }],
    ]);
    const fc = buildRouteFeatureCollection(results, "safe");
    expect(fc.features.length).toBe(1);
  });

  it("buildPointsFeatureCollection emits exactly origin + dest", () => {
    const fc = buildPointsFeatureCollection(ORIGIN, DEST);
    expect(fc.features.length).toBe(2);
    expect(fc.features.map((f) => f.properties?.kind).sort()).toEqual(["dest", "origin"]);
  });

  it("computeBounds always covers at least origin and destination", () => {
    const bounds = computeBounds(ORIGIN, DEST, new Map());
    const [[minLng, minLat], [maxLng, maxLat]] = bounds as [[number, number], [number, number]];
    expect(minLng).toBeLessThanOrEqual(Math.min(ORIGIN.lng, DEST.lon));
    expect(maxLng).toBeGreaterThanOrEqual(Math.max(ORIGIN.lng, DEST.lon));
    expect(minLat).toBeLessThanOrEqual(Math.min(ORIGIN.lat, DEST.lat));
    expect(maxLat).toBeGreaterThanOrEqual(Math.max(ORIGIN.lat, DEST.lat));
  });
});

describe("clearNavigationForRide", () => {
  it("clears navigation + nav_improvement and nulls a set route", () => {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    store.dispatch({
      type: "open",
      options: baseOptions({ navigation: true, nav_improvement: true }),
      screen: "4",
    });
    store.dispatch({
      type: "setRoute",
      route: {
        profile: "safe",
        rideRouteId: null,
        distanceM: 100,
        durationS: 60,
        polyline: "??",
        maneuvers: [],
      },
    });
    clearNavigationForRide({ session: store }, store.current()!);
    expect(store.current()?.options.navigation).toBe(false);
    expect(store.current()?.options.nav_improvement).toBe(false);
    expect(store.current()?.route).toBeNull();
  });

  it("is a no-op when navigation is already off and no route is set", () => {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    store.dispatch({ type: "open", options: baseOptions({ navigation: false }), screen: "4" });
    const before = store.current();
    clearNavigationForRide({ session: store }, before!);
    // Same object identity — commit() was never called, so nothing patched.
    expect(store.current()).toBe(before);
  });
});
