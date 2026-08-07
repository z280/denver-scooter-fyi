// @vitest-environment happy-dom
//
// Screen 7 nav overlay. Split into three layers, per the frontend plan's
// named test targets:
//   1. Pure geometry/matching functions (no DOM, no timers) — monotonic
//      shape-index advance, the forward-window boundary, and the off-route
//      sustain+cooldown reducer.
//   2. `createNavHud` DOM integration — press-and-hold timing (800ms, NOT
//      devices.ts's 450ms `RIDE_LONGPRESS_MS`), the left/right panel toggle
//      state machine, and dispose/dismiss teardown.
//   3. The re-route rate cap through the real `feedFix` entry point, with an
//      injected `now()` so "two off-route events within 60s" is expressed in
//      simulated time rather than real waiting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteManeuver, RouteResponse } from "./api.ts";
import { encodePolyline, type LngLatCoord } from "./polyline-encode.ts";
import type { RideSessionRoute } from "./ride-session.ts";
import {
  INITIAL_OFF_ROUTE_STATE,
  NAV_DISMISS_HOLD_MS,
  advanceMonotonic,
  createNavHud,
  currentManeuverIndex,
  decodePolyline,
  distanceToLineString,
  nearestShapeIndex,
  noteOffRouteSample,
  type NavHudOptions,
} from "./ride-nav-hud.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function maneuver(
  begin: number,
  end: number,
  instruction = "Continue",
  type = 8,
): RouteManeuver {
  return {
    instruction,
    type,
    street_names: [],
    length_meters: 10,
    time_seconds: 5,
    begin_shape_index: begin,
    end_shape_index: end,
  };
}

/** Out-and-back route: 0..10 outbound (lat increasing), 11..20 the return
 *  leg retracing the SAME positions in reverse (coords[11] === coords[9],
 *  ..., coords[20] === coords[0]). This is the exact shape that fools an
 *  unconstrained nearest-point match: a fix physically at the outbound
 *  index-8 location is EQUALLY close to the return leg's mirror point,
 *  index 12. */
function buildOutAndBack(): LngLatCoord[] {
  const coords: LngLatCoord[] = [];
  for (let i = 0; i <= 10; i++) coords.push([-104.99, 39.7 + i * 0.0002]);
  for (let i = 9; i >= 0; i--) coords.push([-104.99, 39.7 + i * 0.0002]);
  return coords;
}

const BASE_COORDS: LngLatCoord[] = [
  [-104.99, 39.7],
  [-104.99, 39.7002],
  [-104.99, 39.7004],
  [-104.99, 39.7006],
  [-104.99, 39.7008],
];

function makeRoute(overrides: Partial<RideSessionRoute> = {}): RideSessionRoute {
  return {
    profile: "safe",
    rideRouteId: "route-1",
    distanceM: 400,
    durationS: 120,
    polyline: encodePolyline(BASE_COORDS),
    maneuvers: [],
    ...overrides,
  };
}

function fakeRouteResponse(
  coords: LngLatCoord[],
  maneuvers: RouteManeuver[] = [],
  propertyOverrides: Partial<RouteResponse["properties"]> = {},
): RouteResponse {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: coords.map(([lng, lat]) => [lng, lat]),
    },
    properties: {
      profile: "safe",
      label: "Safe & Protected",
      distance_meters: 1000,
      duration_seconds: 300,
      elevation_gain_meters: 0,
      shade_score: null,
      battery_percent_estimate: null,
      battery_model: "unavailable",
      graph_bbox: [-105, 39, -104, 40],
      maneuvers,
      ...propertyOverrides,
    },
  };
}

/** A fetchRoute stub that never resolves — for tests that only care about
 *  CALL COUNT (the rate-cap tests), never about the resolved geometry. */
function pendingFetchRoute() {
  return vi.fn().mockReturnValue(new Promise<RouteResponse>(() => {}));
}

function setup(overrides: Partial<NavHudOptions> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const onDismiss = vi.fn();
  const onCompress = vi.fn();
  const fetchRoute = pendingFetchRoute();
  const hud = createNavHud(container, {
    route: makeRoute(),
    dest: { lat: 39.8, lon: -104.99 },
    onDismiss,
    onCompress,
    fetchRoute,
    now: () => 0,
    ...overrides,
  });
  return { container, hud, onDismiss, onCompress, fetchRoute };
}

// ---------------------------------------------------------------------------
// 1. Pure functions
// ---------------------------------------------------------------------------

describe("decodePolyline", () => {
  it("round-trips through encodePolyline (precision 5)", () => {
    const decoded = decodePolyline(encodePolyline(BASE_COORDS));
    expect(decoded.length).toBe(BASE_COORDS.length);
    decoded.forEach(([lng, lat], i) => {
      expect(lng).toBeCloseTo(BASE_COORDS[i][0], 4);
      expect(lat).toBeCloseTo(BASE_COORDS[i][1], 4);
    });
  });

  it("decodes an empty string to an empty array", () => {
    expect(decodePolyline("")).toEqual([]);
  });
});

describe("advanceMonotonic — out-and-back route (the case monotonic matching exists for)", () => {
  const coords = buildOutAndBack();

  it("the UNCONSTRAINED nearest-point search regresses to the earlier, physically-identical point", () => {
    // coords[12] (on the return leg) sits at the exact same lat/lng as
    // coords[8] (on the outbound leg). Scanning the whole shape finds
    // index 8 first and never beats its exact-zero distance — demonstrating
    // the failure mode the monotonic window exists to avoid.
    const fix = { lat: 39.7 + 8 * 0.0002, lng: -104.99 };
    const unconstrained = nearestShapeIndex(coords, fix, 0, coords.length - 1);
    expect(unconstrained.index).toBe(8);
  });

  it("advanceMonotonic never regresses given the same fix, once already at index 12", () => {
    const fix = { lat: 39.7 + 8 * 0.0002, lng: -104.99 };
    const windowed = advanceMonotonic(coords, fix, 12);
    expect(windowed.index).toBe(12);
    expect(windowed.distanceM).toBeLessThan(1);
  });

  it("advances monotonically across a full outbound+return traversal", () => {
    let lastIndex = 0;
    for (let i = 0; i < coords.length; i++) {
      const [lng, lat] = coords[i];
      const match = advanceMonotonic(coords, { lat, lng }, lastIndex);
      expect(match.index).toBeGreaterThanOrEqual(lastIndex);
      lastIndex = match.index;
    }
    expect(lastIndex).toBe(coords.length - 1);
  });

  it("a GPS jump landing near an earlier switchback point still cannot pull the index backward", () => {
    // Simulate noise: rider is really at index 14, but a noisy fix reads as
    // physically closer to the outbound leg's index-6 point (same trick as
    // above, one step further back).
    let lastIndex = 14;
    const noisyFixAtOutboundSix = { lat: 39.7 + 6 * 0.0002, lng: -104.99 };
    const match = advanceMonotonic(coords, noisyFixAtOutboundSix, lastIndex);
    expect(match.index).toBeGreaterThanOrEqual(lastIndex);
  });
});

// ---------------------------------------------------------------------------
// Review fix: the off-route sample must measure distance to the route LINE,
// not to the nearest VERTEX. A sparse ~160m straight segment — the review
// comment's own example — makes the two disagree by ~80m at the midpoint.
// ---------------------------------------------------------------------------

describe("distanceToLineString — point-to-segment, not point-to-vertex", () => {
  // A north-south segment ~160m long (1 degree latitude ~= 111,320m), sparse
  // enough (two vertices, nothing in between) that vertex-only matching and
  // true line distance diverge sharply at the midpoint.
  const SEGMENT_LENGTH_DEG = 160 / 111_320;
  const A: LngLatCoord = [-104.99, 39.7];
  const B: LngLatCoord = [-104.99, 39.7 + SEGMENT_LENGTH_DEG];
  const coords = [A, B];
  const midLat = 39.7 + SEGMENT_LENGTH_DEG / 2;

  it("a rider at the segment's midpoint reads ~0m from the line despite being ~80m from either vertex", () => {
    const fix = { lat: midLat, lng: -104.99 };
    // Sanity check: this is exactly the failure mode being fixed — the OLD
    // vertex-only distance reads ~80m here, which is > the 50m threshold.
    const vertexDistance = nearestShapeIndex(coords, fix, 0, coords.length - 1).distanceM;
    expect(vertexDistance).toBeGreaterThan(50);

    expect(distanceToLineString(coords, fix)).toBeLessThan(1);
  });

  it("a point >50m perpendicular to the segment correctly reads as off-route", () => {
    // ~68m east of the midpoint at this latitude (111,320 * cos(39.7deg) per
    // degree of longitude).
    const fix = { lat: midLat, lng: -104.99 + 0.0008 };
    const d = distanceToLineString(coords, fix);
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(100);
  });

  it("an empty shape returns Infinity; a single point falls back to point distance", () => {
    expect(distanceToLineString([], { lat: 39.7, lng: -104.99 })).toBe(Infinity);
    const single = distanceToLineString([A], { lat: A[1], lng: A[0] });
    expect(single).toBeLessThan(1);
  });
});

describe("advanceMonotonic — forward window boundary", () => {
  const coords: LngLatCoord[] = [];
  for (let i = 0; i <= 10; i++) coords.push([-104.99, 39.7 + i * 0.001]);

  it("never matches past lastIndex + window, even when a farther point is objectively closer", () => {
    const fix = { lat: 39.7 + 10 * 0.001, lng: -104.99 }; // exactly coords[10]
    const match = advanceMonotonic(coords, fix, 0, 3);
    expect(match.index).toBeLessThanOrEqual(3);
    expect(match.index).toBe(3); // clamped to the window's far edge
  });

  it("matches freely once the true nearest point falls inside the window", () => {
    const fix = { lat: 39.7 + 5 * 0.001, lng: -104.99 }; // exactly coords[5]
    const match = advanceMonotonic(coords, fix, 0, 6);
    expect(match.index).toBe(5);
  });

  it("never returns an index below lastIndex even at the window's lower edge", () => {
    const fix = { lat: 0, lng: 0 }; // nowhere near any point — window floor wins
    const match = advanceMonotonic(coords, fix, 4, 2);
    expect(match.index).toBeGreaterThanOrEqual(4);
  });
});

describe("currentManeuverIndex", () => {
  const maneuvers: RouteManeuver[] = [maneuver(0, 5), maneuver(5, 10), maneuver(10, 15)];

  it("advances forward exactly as the matched shape index passes each maneuver's end", () => {
    expect(currentManeuverIndex(maneuvers, 0)).toBe(0);
    expect(currentManeuverIndex(maneuvers, 4)).toBe(0);
    expect(currentManeuverIndex(maneuvers, 5)).toBe(1);
    expect(currentManeuverIndex(maneuvers, 12)).toBe(2);
  });

  it("never regresses when fed back its own previous result, even given a lower shape index later", () => {
    const idx = currentManeuverIndex(maneuvers, 12, 0);
    expect(idx).toBe(2);
    const next = currentManeuverIndex(maneuvers, 6, idx);
    expect(next).toBe(2);
  });

  it("skips a zero-length leg without getting stuck", () => {
    const withZero: RouteManeuver[] = [maneuver(0, 5), maneuver(5, 5), maneuver(5, 10)];
    expect(currentManeuverIndex(withZero, 5)).toBe(2);
  });
});

describe("noteOffRouteSample", () => {
  it("never triggers under the distance threshold, no matter how long sustained", () => {
    let state = INITIAL_OFF_ROUTE_STATE;
    for (let t = 0; t <= 30_000; t += 5_000) {
      const d = noteOffRouteSample(state, 40, t);
      state = d.state;
      expect(d.shouldReroute).toBe(false);
    }
  });

  it("does not trigger before the sustain window elapses", () => {
    let state = INITIAL_OFF_ROUTE_STATE;
    let d = noteOffRouteSample(state, 80, 0);
    state = d.state;
    expect(d.shouldReroute).toBe(false);
    d = noteOffRouteSample(state, 80, 9_999);
    expect(d.shouldReroute).toBe(false);
  });

  it("triggers once sustained for exactly the sustain window", () => {
    let state = INITIAL_OFF_ROUTE_STATE;
    let d = noteOffRouteSample(state, 80, 0);
    state = d.state;
    d = noteOffRouteSample(state, 80, 10_000);
    expect(d.shouldReroute).toBe(true);
  });

  it("resets the sustain timer the instant a sample comes back on-route", () => {
    let state = INITIAL_OFF_ROUTE_STATE;
    let d = noteOffRouteSample(state, 80, 0);
    state = d.state;
    d = noteOffRouteSample(state, 20, 5_000); // back within threshold
    state = d.state;
    expect(state.sinceMs).toBeNull();
    d = noteOffRouteSample(state, 80, 14_000); // off again, only 9s into THIS excursion
    expect(d.shouldReroute).toBe(false);
  });

  it("caps re-routes to <=1/min: a second sustained excursion within 60s does not fire again", () => {
    let state = INITIAL_OFF_ROUTE_STATE;
    let d = noteOffRouteSample(state, 80, 0);
    state = d.state;
    d = noteOffRouteSample(state, 80, 10_000); // first trigger
    expect(d.shouldReroute).toBe(true);
    state = d.state;

    d = noteOffRouteSample(state, 20, 15_000); // briefly on-route
    state = d.state;
    d = noteOffRouteSample(state, 80, 20_000); // off again
    state = d.state;
    d = noteOffRouteSample(state, 80, 30_000); // sustained 10s again, but 20s since the last reroute
    expect(d.shouldReroute).toBe(false);
    state = d.state;

    d = noteOffRouteSample(state, 80, 71_000); // past the 60s cooldown
    expect(d.shouldReroute).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. createNavHud DOM integration
// ---------------------------------------------------------------------------

describe("press-and-hold dismiss (800ms — NOT devices.ts's 450ms RIDE_LONGPRESS_MS)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not dismiss on a short press", () => {
    const { container, onDismiss } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    left.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(300);
    left.dispatchEvent(new Event("pointerup"));
    left.dispatchEvent(new Event("click"));
    vi.advanceTimersByTime(NAV_DISMISS_HOLD_MS);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("has not fired at devices.ts's RIDE_LONGPRESS_MS (450ms) — the two constants are deliberately distinct", () => {
    const { container, onDismiss } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    left.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(450);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("fires exactly at NAV_DISMISS_HOLD_MS (800ms) held", () => {
    expect(NAV_DISMISS_HOLD_MS).toBe(800);
    const { container, onDismiss } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    left.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(450);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(NAV_DISMISS_HOLD_MS - 450);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("releasing before the hold fires cancels it — no dismiss even after the full duration elapses", () => {
    const { container, onDismiss } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    left.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(500);
    left.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(2_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("works identically from the right arrow", () => {
    const { container, onDismiss } = setup();
    const right = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--right")!;
    right.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(NAV_DISMISS_HOLD_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a long press dismisses without also toggling a panel, and tears the DOM down", () => {
    const { container, onDismiss, onCompress } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    left.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(NAV_DISMISS_HOLD_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // The only onCompress call from this whole gesture is the dismiss's own
    // "close everything" (null) — never "left" from a toggle side effect.
    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(onCompress).toHaveBeenCalledWith(null);
    expect(container.querySelector(".nav-hud__panel")).toBeNull();
    expect(container.querySelector(".nav-hud__bar")).toBeNull();
    expect(container.classList.contains("nav-hud")).toBe(false);
  });

  it("dispose() after a dismiss is a harmless no-op (idempotent, no second onDismiss)", () => {
    const { hud, onDismiss, container } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    left.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(NAV_DISMISS_HOLD_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(() => hud.dispose()).not.toThrow();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("left/right directions-panel toggle state machine", () => {
  function press(btn: HTMLButtonElement): void {
    btn.dispatchEvent(new Event("pointerdown"));
    btn.dispatchEvent(new Event("pointerup"));
    btn.dispatchEvent(new Event("click"));
  }

  it("null -> left -> null on repeated left presses", () => {
    const { container, onCompress } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    const panel = container.querySelector<HTMLElement>(".nav-hud__panel")!;
    expect(panel.hidden).toBe(true);

    press(left);
    expect(onCompress).toHaveBeenLastCalledWith("left");
    expect(panel.hidden).toBe(false);
    expect(panel.classList.contains("nav-hud__panel--left")).toBe(true);
    expect(left.getAttribute("aria-pressed")).toBe("true");

    press(left);
    expect(onCompress).toHaveBeenLastCalledWith(null);
    expect(panel.hidden).toBe(true);
    expect(left.getAttribute("aria-pressed")).toBe("false");
  });

  it("null -> right -> null on repeated right presses", () => {
    const { container, onCompress } = setup();
    const right = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--right")!;
    const panel = container.querySelector<HTMLElement>(".nav-hud__panel")!;

    press(right);
    expect(onCompress).toHaveBeenLastCalledWith("right");
    expect(panel.classList.contains("nav-hud__panel--right")).toBe(true);

    press(right);
    expect(onCompress).toHaveBeenLastCalledWith(null);
    expect(panel.hidden).toBe(true);
  });

  it("pressing the opposite arrow switches sides directly, without an intermediate null", () => {
    const { container, onCompress } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    const right = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--right")!;
    const panel = container.querySelector<HTMLElement>(".nav-hud__panel")!;

    press(left);
    onCompress.mockClear();
    press(right);
    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(onCompress).toHaveBeenCalledWith("right");
    expect(panel.classList.contains("nav-hud__panel--right")).toBe(true);
    expect(panel.classList.contains("nav-hud__panel--left")).toBe(false);
    expect(left.getAttribute("aria-pressed")).toBe("false");
    expect(right.getAttribute("aria-pressed")).toBe("true");
  });

  it("the panel's own close button also returns to null", () => {
    const { container, onCompress } = setup();
    const left = container.querySelector<HTMLButtonElement>(".nav-hud__arrow--left")!;
    const close = container.querySelector<HTMLButtonElement>(".nav-hud__panel-close")!;
    press(left);
    close.click();
    expect(onCompress).toHaveBeenLastCalledWith(null);
    expect(container.querySelector<HTMLElement>(".nav-hud__panel")!.hidden).toBe(true);
  });
});

describe("createNavHud — center card + directions list content", () => {
  it("renders the current maneuver's instruction and highlights it in the panel, advancing as fixes come in", () => {
    const maneuvers: RouteManeuver[] = [
      maneuver(0, 2, "Head north on Blake St"),
      maneuver(2, 4, "Turn right onto 20th St"),
    ];
    const { container, hud } = setup({
      route: makeRoute({ maneuvers, polyline: encodePolyline(BASE_COORDS) }),
    });
    const instruction = container.querySelector(".nav-hud__instruction")!;
    expect(instruction.textContent).toBe("Head north on Blake St");

    const [lng, lat] = BASE_COORDS[3];
    hud.feedFix(lat, lng);
    expect(instruction.textContent).toBe("Turn right onto 20th St");
    const steps = container.querySelectorAll(".nav-hud__step");
    expect(steps.length).toBe(2);
    expect(steps[1].classList.contains("is-current")).toBe(true);
    expect(steps[0].classList.contains("is-done")).toBe(true);
  });

  it("falls back to a generic message when there are no maneuvers", () => {
    const { container } = setup({ route: makeRoute({ maneuvers: [] }) });
    expect(container.querySelector(".nav-hud__instruction")!.textContent).toBe(
      "Follow the route",
    );
  });
});

// ---------------------------------------------------------------------------
// The API's rider-facing beta disclaimer (`beta_warning`) — the contract:
// render it wherever directions are shown (here: the center-card strip AND
// the step-by-step panel), never hardcode it, treat absence as "out of beta".
// ---------------------------------------------------------------------------

describe("beta warning (route.betaWarning → .nav-hud__beta / .nav-hud__panel-beta)", () => {
  const WARNING =
    "Navigation directions are in beta and may be inaccurate or unsafe.";

  it("renders the session route's warning in both the card strip and the panel", () => {
    const { container } = setup({
      route: makeRoute({ betaWarning: WARNING }),
    });
    const strip = container.querySelector<HTMLElement>(".nav-hud__beta")!;
    const panelNote = container.querySelector<HTMLElement>(".nav-hud__panel-beta")!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toBe(WARNING);
    expect(panelNote.hidden).toBe(false);
    expect(panelNote.textContent).toBe(WARNING);
  });

  it("stays hidden when the session route carries no warning (out of beta)", () => {
    const { container } = setup({ route: makeRoute() });
    expect(container.querySelector<HTMLElement>(".nav-hud__beta")!.hidden).toBe(true);
    expect(
      container.querySelector<HTMLElement>(".nav-hud__panel-beta")!.hidden,
    ).toBe(true);
  });

  it("a re-route re-decides it from the fresh response: present → shown, absent → dropped", async () => {
    const REWORDED = "Directions are still in beta — ride carefully.";
    let t = 0;
    let nextResponse = fakeRouteResponse(BASE_COORDS, [], {
      beta_warning: REWORDED,
    });
    const fetchRoute = vi.fn(() => Promise.resolve(nextResponse));
    const container = document.createElement("div");
    const hud = createNavHud(container, {
      route: makeRoute({ betaWarning: WARNING }),
      dest: { lat: 39.8, lon: -104.99 },
      onDismiss: vi.fn(),
      onCompress: vi.fn(),
      fetchRoute,
      now: () => t,
    });
    const strip = container.querySelector<HTMLElement>(".nav-hud__beta")!;
    const FAR = { lat: 41.0, lng: -103.0 };

    // Re-route #1: the fresh response still carries (re-worded) text.
    t = 0;
    hud.feedFix(FAR.lat, FAR.lng);
    t = 10_000;
    hud.feedFix(FAR.lat, FAR.lng);
    await vi.waitFor(() => expect(strip.textContent).toBe(REWORDED));
    expect(strip.hidden).toBe(false);

    // Re-route #2 (past the 60s cooldown): the field is gone — beta ended
    // mid-ride, and the warning must not outlive it.
    nextResponse = fakeRouteResponse(BASE_COORDS);
    t = 70_000;
    hud.feedFix(FAR.lat, FAR.lng);
    t = 80_000;
    hud.feedFix(FAR.lat, FAR.lng);
    expect(fetchRoute).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(strip.hidden).toBe(true));
    expect(
      container.querySelector<HTMLElement>(".nav-hud__panel-beta")!.hidden,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Off-route re-route through feedFix (real orchestration, simulated time)
// ---------------------------------------------------------------------------

describe("off-route re-route via feedFix", () => {
  it("caps re-routes to <=1/min: two off-route events within 60s produce only one fetchRoute call", () => {
    let t = 0;
    const { hud, fetchRoute } = setup({
      route: makeRoute(),
      now: () => t,
    });
    const FAR = { lat: 41.0, lng: -103.0 }; // nowhere near BASE_COORDS

    t = 0;
    hud.feedFix(FAR.lat, FAR.lng);
    t = 10_000;
    hud.feedFix(FAR.lat, FAR.lng); // sustained 10s off-route -> trigger #1
    expect(fetchRoute).toHaveBeenCalledTimes(1);

    const [onLng, onLat] = BASE_COORDS[0];
    t = 15_000;
    hud.feedFix(onLat, onLng); // briefly back on the route

    t = 20_000;
    hud.feedFix(FAR.lat, FAR.lng); // off-route again
    t = 30_000;
    hud.feedFix(FAR.lat, FAR.lng); // sustained 10s again, but only 20s after trigger #1
    expect(fetchRoute).toHaveBeenCalledTimes(1);
  });

  it("does not re-route for a fix within 50m of the line even if fed for a long time", () => {
    let t = 0;
    const [lng, lat] = BASE_COORDS[2];
    const { hud, fetchRoute } = setup({ route: makeRoute(), now: () => t });
    for (let i = 0; i < 6; i++) {
      t += 5_000;
      hud.feedFix(lat, lng);
    }
    expect(fetchRoute).not.toHaveBeenCalled();
  });

  // Review fix regression: a sparse ~160m two-point segment (nothing between
  // its vertices) is exactly the shape the vertex-only bug misjudged.
  describe("a sparse long segment (point-to-line, not point-to-vertex)", () => {
    const SEGMENT_LENGTH_DEG = 160 / 111_320;
    const sparseCoords: LngLatCoord[] = [
      [-104.99, 39.7],
      [-104.99, 39.7 + SEGMENT_LENGTH_DEG],
    ];
    const midLat = 39.7 + SEGMENT_LENGTH_DEG / 2;

    it("the midpoint (on the line, ~80m from either vertex) never triggers a reroute", () => {
      let t = 0;
      const { hud, fetchRoute } = setup({
        route: makeRoute({ polyline: encodePolyline(sparseCoords) }),
        now: () => t,
      });
      for (let i = 0; i < 6; i++) {
        t += 5_000;
        hud.feedFix(midLat, -104.99);
      }
      expect(fetchRoute).not.toHaveBeenCalled();
    });

    it("a point >50m perpendicular to it reroutes only after the sustained interval", () => {
      let t = 0;
      const { hud, fetchRoute } = setup({
        route: makeRoute({ polyline: encodePolyline(sparseCoords) }),
        now: () => t,
      });
      const offLng = -104.99 + 0.0008; // ~68m east at this latitude
      hud.feedFix(midLat, offLng);
      t = 5_000;
      hud.feedFix(midLat, offLng); // only 5s sustained so far
      expect(fetchRoute).not.toHaveBeenCalled();
      t = 10_000;
      hud.feedFix(midLat, offLng); // 10s sustained -> triggers
      expect(fetchRoute).toHaveBeenCalledTimes(1);
    });
  });

  it("calls fetchRoute with only the route's own profile, from the current fix to the session dest", () => {
    let t = 0;
    const { hud, fetchRoute } = setup({
      route: makeRoute({ profile: "shade" }),
      dest: { lat: 39.9, lon: -105.01 },
      vehicleModel: "Cosmo",
      now: () => t,
    });
    const FAR = { lat: 41.0, lng: -103.0 };
    t = 0;
    hud.feedFix(FAR.lat, FAR.lng);
    t = 10_000;
    hud.feedFix(FAR.lat, FAR.lng);
    expect(fetchRoute).toHaveBeenCalledTimes(1);
    const [query, signal] = fetchRoute.mock.calls[0];
    expect(query).toEqual({
      from: [FAR.lat, FAR.lng],
      to: [39.9, -105.01],
      profile: "shade",
      vehicle_model: "Cosmo",
      maneuvers: true,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("never calls postRideRoute-shaped logic — it only ever calls the injected fetchRoute, and updates geometry via onRouteUpdate on success", async () => {
    let t = 0;
    const onRouteUpdate = vi.fn();
    const newCoords: LngLatCoord[] = [
      [-103.0, 41.0],
      [-103.0, 41.001],
    ];
    const newManeuvers: RouteManeuver[] = [maneuver(0, 1, "Continue north")];
    const fetchRoute = vi.fn().mockResolvedValue(fakeRouteResponse(newCoords, newManeuvers));
    const container = document.createElement("div");
    const hud = createNavHud(container, {
      route: makeRoute(),
      dest: { lat: 39.8, lon: -104.99 },
      onDismiss: vi.fn(),
      onCompress: vi.fn(),
      onRouteUpdate,
      fetchRoute,
      now: () => t,
    });
    const FAR = { lat: 41.0, lng: -103.0 };
    t = 0;
    hud.feedFix(FAR.lat, FAR.lng);
    t = 10_000;
    hud.feedFix(FAR.lat, FAR.lng);
    expect(fetchRoute).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(onRouteUpdate).toHaveBeenCalledTimes(1);
    });
    expect(onRouteUpdate).toHaveBeenCalledWith({
      coordinates: newCoords,
      maneuvers: newManeuvers,
    });
    expect(container.querySelector(".nav-hud__instruction")!.textContent).toBe(
      "Continue north",
    );
  });

  it("feedFix after dispose() is inert — no crash, no fetchRoute call", () => {
    let t = 0;
    const { hud, fetchRoute } = setup({ now: () => t });
    hud.dispose();
    t = 50_000;
    expect(() => hud.feedFix(41.0, -103.0)).not.toThrow();
    expect(fetchRoute).not.toHaveBeenCalled();
  });
});
