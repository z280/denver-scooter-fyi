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
  type RouteOption,
  type RouteOptionsResponse,
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
  FALLBACK_PROFILE_INFO,
  PROFILE_COLORS,
  buildPreviewFeatureCollection,
  clearNavigationForRide,
  colorForProfile,
  computeBounds,
  formatMiles,
  formatMinutes,
  lineStringLengthMeters,
  profileInfoText,
  resolveOrigin,
  wireRideScreenRoutes,
  type DevicesLike,
  type LocateLike,
  type RideScreenRoutesDeps,
  type RouteState,
} from "./ride-screen-routes.ts";
import type { RoutePreviewHandle } from "./route-preview.ts";

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

/** A recording fake for the main-map preview handle — captures every
 *  `set`/`clear` so tests can assert on what the screen draws without a
 *  real MapLibre instance (unavailable under happy-dom). */
function fakePreview(): { preview: RoutePreviewHandle; calls: PreviewCalls } {
  const calls: PreviewCalls = { sets: [], clears: 0 };
  return {
    preview: {
      set: (fc, bounds) => {
        calls.sets.push({ fc, bounds });
      },
      clear: () => {
        calls.clears += 1;
      },
    },
    calls,
  };
}

interface PreviewCalls {
  sets: { fc: GeoJSON.FeatureCollection; bounds: unknown }[];
  clears: number;
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

/** The single-call contract Screen 4 now speaks: one `/route/options` reply
 *  carrying already-deduped options, each with its own geometry. */
function optionsResponse(
  keys: string[],
  per: Partial<Record<string, Partial<RouteOption>>> = {},
): RouteOptionsResponse {
  return {
    graph_bbox: [-105.11, 39.61, -104.6, 39.91],
    beta_warning: "Navigation directions are in beta.",
    profiles_unavailable: [],
    options: keys.map((k, i) => ({
      key: k,
      label: LABELS[k] ?? k,
      also: [],
      distance_meters: 2400 + i * 50,
      duration_seconds: 600 + i * 30,
      elevation_gain_meters: 10,
      battery_percent_estimate: 8,
      battery_percent_low: 2,
      battery_percent_high: 14,
      battery_model: "regression",
      arrival_percent: null,
      arrival_percent_low: null,
      arrival_percent_high: null,
      will_make_it: null,
      reserve_percent: 10,
      geometry: {
        type: "LineString",
        coordinates: [
          [ORIGIN.lng, ORIGIN.lat],
          [ORIGIN.lng + 0.01 * (i + 1), ORIGIN.lat + 0.01],
          [DEST.lon, DEST.lat],
        ] as [number, number][],
      },
      ...(per[k] ?? {}),
    })),
  };
}

function fakeOptions(
  keys: string[],
  per: Partial<Record<string, Partial<RouteOption>>> = {},
) {
  return vi.fn(() => Promise.resolve(optionsResponse(keys, per)));
}

function baseDeps(
  session: RideSessionStore,
  overrides: Partial<RideScreenRoutesDeps> = {},
): RideScreenRoutesDeps {
  return {
    session,
    locate: fakeLocate(ORIGIN),
    routePreview: fakePreview().preview,
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
    const fetchRouteOptions = vi.fn(() => new Promise<RouteOptionsResponse>(() => {}));
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
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
    const fetchRouteOptions = vi.fn();
    wireRideScreenRoutes(
      baseDeps(session, { locate: fakeLocate(null), fetchRouteOptions }),
    );
    openRideModal({ fastForwardTo: "4" });

    expect(currentRideScreen()).toBe("4");
    const root = rideModalRoot();
    expect(root?.querySelector(".ride-route-degrade")).not.toBeNull();
    expect(fetchRouteOptions).not.toHaveBeenCalled();
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
    const fetchRouteOptions = vi.fn(() => new Promise<RouteOptionsResponse>(() => {}));
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
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

describe("Screen 4 — route selection", () => {
  it("selects the first option, and lets the rider pick another", async () => {
    // Arrival ORDER used to decide this, because the screen fired one request
    // per profile and took whichever landed first. It now makes one call and
    // gets a complete, already-deduped list, so "first" means first in the
    // server's ranking rather than whichever network round trip won a race.
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe", "express"]);
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    const root = rideModalRoot();
    expect(
      root?.querySelector<HTMLButtonElement>('[data-profile="safe"]')
        ?.classList.contains("is-selected"),
    ).toBe(true);
    const next = root?.querySelector<HTMLButtonElement>(".ride-route-next");
    expect(next?.disabled).toBe(false);

    // render() rebuilds the list on every state change (replaceChildren), so
    // re-query after the click rather than reuse the pre-click node.
    root?.querySelector<HTMLButtonElement>('[data-profile="express"]')?.click();
    expect(
      root?.querySelector<HTMLButtonElement>('[data-profile="express"]')
        ?.classList.contains("is-selected"),
    ).toBe(true);
    expect(
      root?.querySelector<HTMLButtonElement>('[data-profile="safe"]')
        ?.classList.contains("is-selected"),
    ).toBe(false);
  });

  it("asks for the routes ONCE, not once per profile", async () => {
    // The whole point of the rewrite: five requests for what turned out to be
    // two or three roads.
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe", "range", "shade", "night", "express"]);
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();
    expect(fetchRouteOptions).toHaveBeenCalledTimes(1);
  });

  it("names the other profiles that produce the same road", async () => {
    // Folded, not hidden — a rider looking for "the shaded one" can see that
    // it is this one, without being offered it twice.
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"], {
      safe: { also: [{ key: "shade", label: "The Shaded Canopy" }] },
    });
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();
    const also = rideModalRoot()?.querySelector(".ride-route-also")?.textContent ?? "";
    expect(also).toContain("The Shaded Canopy");
    // The labels are proper names; several already begin with "The", so the
    // sentence must not supply one of its own.
    expect(also).not.toMatch(/the The/i);
  });

  it("accounts for profiles the server could not route", async () => {
    // The High Injury Network exclusions mean `safe` can legitimately find
    // nothing where `express` does. Say so rather than quietly showing a
    // shorter list.
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = vi.fn(() =>
      Promise.resolve({
        ...optionsResponse(["express"]),
        profiles_unavailable: ["safe"],
      }),
    );
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();
    expect(rideModalRoot()?.querySelector(".ride-route-status")?.textContent)
      .toBe("1 of 2 route styles are available for this trip.");
  });
});

describe("Screen 4 — what is left in the battery", () => {
  it("says what will be left on arrival, not just what the ride spends", async () => {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"], {
      safe: { arrival_percent: 62, arrival_percent_low: 56, will_make_it: true },
    });
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();
    expect(rideModalRoot()?.querySelector(".ride-route-battery")?.textContent)
      .toContain("62% left on arrival");
  });

  it("warns, in words and not only colour, when it may not make it", async () => {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"], {
      safe: { arrival_percent: 12, arrival_percent_low: 6, will_make_it: false },
    });
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();
    const line = rideModalRoot()?.querySelector(".ride-route-battery");
    expect(line?.classList.contains("is-warning")).toBe(true);
    expect(line?.textContent).toMatch(/may not make it/i);
    expect(line?.textContent).toContain("6%");
  });

  it("says nothing about arrival when no starting charge is known", async () => {
    // An own-device ride carries no confirmed charge. Inventing a cheerful
    // number would be the dishonest degrade.
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"]);
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();
    expect(rideModalRoot()?.querySelector(".ride-route-battery")).toBeNull();
  });
});

describe("Screen 4 — NEXT: POST /ride-routes", () => {
  it("advances immediately and tolerates a 404 (A3 not deployed yet) without setting rideRouteId", async () => {
    const session = sessionOnScreen4(baseOptions({ nav_improvement: true, save_tracks: true }));
    const fetchRouteOptions = fakeOptions(["safe"]);
    const postDeferred = deferred<{ ride_route_id: string }>();
    const postRideRoute = vi.fn(() => postDeferred.promise);
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteOptions, postRideRoute }),
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
    const fetchRouteOptions = fakeOptions(["safe"]);
    const postRideRoute = vi.fn(() => Promise.resolve({ ride_route_id: "rr_123" }));
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteOptions, postRideRoute }),
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
    const fetchRouteOptions = fakeOptions(["safe"]);
    const postRideRoute = vi.fn(() => Promise.resolve({ ride_route_id: "rr_999" }));
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteOptions, postRideRoute }),
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
    const fetchRouteOptions = vi.fn(() =>
      Promise.resolve({ ...optionsResponse([]), profiles_unavailable: ["safe", "range"] }),
    );
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
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

  it("degrades rather than spinning forever when the call itself fails", async () => {
    // The regression this pins: with the old one-request-per-profile screen
    // an empty results map could only mean "not started", so the render read
    // it as "loading". One call that FAILS also leaves it empty — which left
    // the rider on a spinner instead of on the documented degrade.
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = vi.fn(() => Promise.reject(new Error("sidecar down")));
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    const root = rideModalRoot();
    expect(root?.querySelector(".ride-route-status")?.textContent)
      .toContain("continue without navigation");
    expect(root?.querySelectorAll(".ride-route-tombstone").length).toBe(0);
    const next = root?.querySelector<HTMLButtonElement>(".ride-route-next");
    expect(next?.disabled).toBe(false);
    expect(next?.textContent).toBe("Continue without navigation");
  });
});

// ---------------------------------------------------------------------------
// map wiring (light — presentational, but the source/layer contract matters)
// ---------------------------------------------------------------------------

describe("Screen 4 — the bottom drawer over the main map", () => {
  it("renders as a sheet: the wizard root carries the sheet class on Screen 4", async () => {
    const { preview } = fakePreview();
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"]);
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteOptions, routePreview: preview }),
    );
    openRideModal({ fastForwardTo: "4" });
    expect(rideModalRoot()?.classList.contains("ride-modal--sheet")).toBe(true);
  });

  it("draws origin/dest immediately and the SELECTED route as a colored line when it arrives", async () => {
    const { preview, calls } = fakePreview();
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"]);
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteOptions, routePreview: preview }),
    );
    openRideModal({ fastForwardTo: "4" });
    // The very first render already frames origin + destination…
    expect(calls.sets.length).toBeGreaterThan(0);
    expect(
      calls.sets[0].fc.features.map((f) => f.properties?.kind).filter(Boolean).sort(),
    ).toEqual(["dest", "origin"]);
    await flush();
    // …and once "safe" arrives (and auto-selects), its line joins them,
    // solid in the profile color.
    const last = calls.sets.at(-1)!;
    const line = last.fc.features.find((f) => f.geometry.type === "LineString");
    expect(line?.properties?.profile).toBe("safe");
    expect(line?.properties?.color).toBe(PROFILE_COLORS.safe);
    expect(last.bounds).toBeTruthy();
  });

  it("switching cards swaps which route's line is drawn", async () => {
    const { preview, calls } = fakePreview();
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe", "express"]);
    wireRideScreenRoutes(
      baseDeps(session, { fetchRouteOptions, routePreview: preview }),
    );
    openRideModal({ fastForwardTo: "4" });
    await flush();
    const expressCard = document.querySelector<HTMLButtonElement>(
      '[data-profile="express"]',
    );
    expressCard!.click();
    const last = calls.sets.at(-1)!;
    const lines = last.fc.features.filter((f) => f.geometry.type === "LineString");
    expect(lines.length).toBe(1);
    expect(lines[0].properties?.profile).toBe("express");
    expect(lines[0].properties?.color).toBe(PROFILE_COLORS.express);
  });

  it("clears the preview on screen teardown", async () => {
    const { preview, calls } = fakePreview();
    const session = sessionOnScreen4(baseOptions());
    wireRideScreenRoutes(
      baseDeps(session, {
        fetchRouteOptions: () => new Promise(() => {}),
        routePreview: preview,
      }),
    );
    openRideModal({ fastForwardTo: "4" });
    await flush();
    resetRideModal();
    expect(calls.clears).toBe(1);
  });
});

describe("Screen 4 — the per-profile \u2139 explainer", () => {
  async function openWithSafe(): Promise<void> {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"]);
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();
  }

  it("every route card carries an \u2139 that opens the profile's purpose copy", async () => {
    await openWithSafe();
    const info = document.querySelector<HTMLButtonElement>(
      '[data-profile-info="safe"]',
    );
    expect(info).not.toBeNull();
    info!.click();
    const modal = document.querySelector(".ranks-modal");
    expect(modal?.textContent).toContain("High Injury Network");
    expect(modal?.textContent).toContain(LABELS.safe);
  });

  it("\u00d7 closes it; teardown closes a still-open one", async () => {
    await openWithSafe();
    document.querySelector<HTMLButtonElement>('[data-profile-info="safe"]')!.click();
    document
      .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")!
      .click();
    expect(document.querySelector(".ranks-modal")).toBeNull();

    document.querySelector<HTMLButtonElement>('[data-profile-info="safe"]')!.click();
    expect(document.querySelector(".ranks-modal")).not.toBeNull();
    resetRideModal();
    expect(document.querySelector(".ranks-modal")).toBeNull();
  });

  it("profileInfoText falls back honestly for an unknown profile", () => {
    expect(profileInfoText("hoverboard")).toBe(FALLBACK_PROFILE_INFO);
    expect(profileInfoText("safe")).toContain("High Injury Network");
  });

  it("Night Owl explains dark-hours street preference, in its own color", () => {
    // The live deployment's fifth profile (config.json key "night") — the
    // generic fallback line here was a field-reported bug.
    expect(profileInfoText("night")).toContain("after dark");
    expect(profileInfoText("night")).toContain("streets");
    expect(colorForProfile("night")).toBe(PROFILE_COLORS.night);
    expect(PROFILE_COLORS.night).not.toBe(colorForProfile("hoverboard"));
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

describe("buildPreviewFeatureCollection / computeBounds", () => {
  function readyState(key: string, coords: [number, number][]): RouteState {
    return { key, label: LABELS[key] ?? key, status: "ready", response: fakeRoute(key, coords) };
  }

  it("draws ONLY the selected route, solid in its profile color, plus the two dots", () => {
    const results = new Map<string, RouteState>([
      ["safe", readyState("safe", ROUTE_COORDS)],
      ["express", readyState("express", ROUTE_COORDS)],
    ]);
    const fc = buildPreviewFeatureCollection(ORIGIN, DEST, results, "safe");
    const lines = fc.features.filter((f) => f.geometry.type === "LineString");
    expect(lines.length).toBe(1);
    expect(lines[0].properties?.profile).toBe("safe");
    expect(lines[0].properties?.color).toBe(PROFILE_COLORS.safe);
    expect(
      fc.features.map((f) => f.properties?.kind).filter(Boolean).sort(),
    ).toEqual(["dest", "origin"]);
  });

  it("nothing selected (or selected not ready) draws just origin + dest", () => {
    const loading = new Map<string, RouteState>([
      ["safe", { key: "safe", label: "Safe", status: "loading" }],
    ]);
    expect(
      buildPreviewFeatureCollection(ORIGIN, DEST, loading, "safe").features.length,
    ).toBe(2);
    expect(
      buildPreviewFeatureCollection(ORIGIN, DEST, new Map(), null).features.length,
    ).toBe(2);
  });

  it("computeBounds always covers at least origin and destination", () => {
    const bounds = computeBounds(ORIGIN, DEST, new Map());
    const [[minLng, minLat], [maxLng, maxLat]] = bounds as [[number, number], [number, number]];
    expect(minLng).toBeLessThanOrEqual(Math.min(ORIGIN.lng, DEST.lon));
    expect(maxLng).toBeGreaterThanOrEqual(Math.max(ORIGIN.lng, DEST.lon));
    expect(minLat).toBeLessThanOrEqual(Math.min(ORIGIN.lat, DEST.lat));
    expect(maxLat).toBeGreaterThanOrEqual(Math.max(ORIGIN.lat, DEST.lat));
  });

  it("computeBounds with a selection ignores unselected routes' shapes", () => {
    const wide: [number, number][] = [
      [ORIGIN.lng, ORIGIN.lat],
      [-105.2, 39.9], // far outside the selected route's box
      [DEST.lon, DEST.lat],
    ];
    const results = new Map<string, RouteState>([
      ["safe", readyState("safe", ROUTE_COORDS)],
      ["express", readyState("express", wide)],
    ]);
    const bounds = computeBounds(ORIGIN, DEST, results, "safe");
    const [[minLng]] = bounds as [[number, number], [number, number]];
    expect(minLng).toBeGreaterThan(-105.2);
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

// ---------------------------------------------------------------------------
// Directions-are-beta warning (the /route contract: beta_warning must be
// shown wherever directions are rendered)
// ---------------------------------------------------------------------------

describe("Screen 4 — directions beta warning", () => {
  it("shows the API's beta_warning above the route list", async () => {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"]);
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    const beta = rideModalRoot()?.querySelector<HTMLElement>(".ride-route-beta");
    expect(beta?.hidden).toBe(false);
    expect(beta?.textContent).toContain("Navigation directions are in beta.");
  });

  it("stays hidden when the API sends none — the beta is over, the copy is not ours", async () => {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = vi.fn(() => {
      const r = optionsResponse(["safe"]);
      delete (r as { beta_warning?: string }).beta_warning;
      return Promise.resolve(r);
    });
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    expect(
      rideModalRoot()?.querySelector<HTMLElement>(".ride-route-beta")?.hidden,
    ).toBe(true);
  });

  it("carries the warning into the session route so the nav HUD can keep showing it", async () => {
    const session = sessionOnScreen4(baseOptions());
    const fetchRouteOptions = fakeOptions(["safe"]);
    wireRideScreenRoutes(baseDeps(session, { fetchRouteOptions }));
    openRideModal({ fastForwardTo: "4" });
    await flush();

    rideModalRoot()?.querySelector<HTMLButtonElement>(".ride-route-next")?.click();
    expect(session.current()?.route?.betaWarning).toBe(
      "Navigation directions are in beta.",
    );
  });
});
