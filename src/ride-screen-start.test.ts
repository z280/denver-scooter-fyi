// @vitest-environment happy-dom
//
// Screen 6 — automatic ride start. The old "Start in Veo" page (Android/Apple
// deep links + a 10 s countdown + "I already started") is gone: this screen
// starts ride mode by itself the moment it mounts with a location fix.
// Covers: the skip predicate's device matrix, the auto-start →
// POST /tracked-rides → `rideStarted` → handoff happy path, waiting on a late
// first fix (and starting exactly once), the guest/private local-only start,
// and graceful degradation (a 409/404/generic start failure hands the rider
// a visible Try again instead of an invisible retry loop).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type RideOptions, type StartedTrackedRide } from "./api.ts";
import type { LngLat } from "./locate.ts";
import {
  currentRideScreen,
  nextFlowScreen,
  openRideModal,
  resetRideModal,
  rideModalRoot,
} from "./ride-modal.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideSessionDevice,
  type RideSessionSelectedDevice,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  startScreenSkip,
  wireRideScreenStart,
  type LocateLike,
  type RideScreenStartDeps,
} from "./ride-screen-start.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function baseOptions(costHud: boolean): RideOptions {
  return {
    cost_hud: costHud,
    speedometer: "classic",
    theme: "auto",
    navigation: false,
    save_tracks: true,
    battery_modeling: false,
    nav_improvement: false,
    end_survey: false,
    own_device: false,
  };
}

const DEVICE: RideSessionSelectedDevice = {
  vehicleIdentifier: "a1b2c3d4e5f60701",
  plate: "1234567",
  model: "cosmo",
  batteryConfirmed: 42,
};

const OWN_DEVICE: RideSessionDevice = { own: true };

const FIX: LngLat = { lng: -104.99, lat: 39.74, accuracy: 5 };

/** A session doc landed on Screen 6 (`wizard:6`), with `device`/`cost_hud`
 *  set as given — the exact phase `startScreenSkip`/`rideStarted` care about. */
function sessionAt(
  device: RideSessionDevice | null,
  costHud = true,
): RideSessionStore {
  const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
  store.dispatch({ type: "open", options: baseOptions(costHud), screen: "6" });
  if (device) store.dispatch({ type: "setDevice", device });
  return store;
}

/** Same as `sessionAt`, but the device selection is explicitly marked
 *  private — a guest's real-device pick (`ride-screen-select.ts`'s
 *  `syncSessionDevice` does this for real; see the "guest / private ride"
 *  tests below). */
function privateSessionAt(
  device: RideSessionDevice,
  costHud = true,
): RideSessionStore {
  const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
  store.dispatch({ type: "open", options: baseOptions(costHud), screen: "6" });
  store.dispatch({ type: "setDevice", device, private: true });
  return store;
}

interface FakeLocate extends LocateLike {
  emitFix(pos: LngLat): void;
}
function fakeLocate(initial: LngLat | null): FakeLocate {
  let current = initial;
  const listeners = new Set<(pos: LngLat) => void>();
  return {
    current: () => current,
    onFix: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emitFix(pos) {
      current = pos;
      for (const cb of [...listeners]) cb(pos);
    },
  };
}

function fakeStartedRide(overrides: Partial<StartedTrackedRide> = {}): StartedTrackedRide {
  return {
    id: "ride-1",
    status: "watching",
    started_at: "2026-07-29T12:00:00Z",
    start_lat: FIX.lat,
    start_lon: FIX.lng,
    watch_expires_at: null,
    gbfs_left_feed_at: null,
    gbfs_reappeared_at: null,
    gbfs_end_lat: null,
    gbfs_end_lon: null,
    gbfs_end_battery_percent: null,
    user_reported_ended_at: null,
    end_lat: null,
    end_lon: null,
    reported_battery_percent: null,
    total_cost_cents: null,
    metadata: {},
    vehicle_identifier: DEVICE.vehicleIdentifier,
    created_at: "2026-07-29T12:00:00Z",
    updated_at: "2026-07-29T12:00:00Z",
    distance_meters: null,
    distance_source: null,
    ...overrides,
  };
}

function wire(
  session: RideSessionStore,
  overrides: Partial<Omit<RideScreenStartDeps, "session">> = {},
): () => void {
  return wireRideScreenStart({
    session,
    locate: fakeLocate(FIX),
    ...overrides,
  });
}

function root(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".ride-screen-start");
  if (!el) throw new Error("Screen 6 root not found");
  return el;
}

function buttonWithText(text: string): HTMLButtonElement {
  const btn = [...root().querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`button ${JSON.stringify(text)} not found`);
  return btn;
}

/** Let the auto-start's async `finishStart` settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  resetRideModal();
  document.body.replaceChildren();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// skip() — the device matrix
// ---------------------------------------------------------------------------

describe("startScreenSkip — device matrix", () => {
  it("no session doc at all -> skip", () => {
    expect(startScreenSkip(null)).toBe(true);
  });

  it.each([
    ["no device", null, true, true],
    ["no device", null, false, true],
    ["own device", OWN_DEVICE, true, false],
    ["own device", OWN_DEVICE, false, false],
    ["a specific Veo device, cost_hud ON -> shown", DEVICE, true, false],
    ["a specific Veo device, cost_hud OFF -> shown", DEVICE, false, false],
  ] as const)("%s, cost_hud=%s -> skip=%s", (_label, device, costHud, expected) => {
    const store = sessionAt(device, costHud);
    expect(startScreenSkip(store.current())).toBe(expected);
  });

  it("wires end-to-end via nextFlowScreen: reachable regardless of device/cost_hud", () => {
    // `nextFlowScreen("4", …)` is what the wizard ACTUALLY calls when Screen
    // 4's [Next] fires. Screen 6 shows for every device configuration.
    for (const [device, costHud] of [
      [DEVICE, true],
      [DEVICE, false],
      [OWN_DEVICE, true],
      [OWN_DEVICE, false],
    ] as const) {
      const store = sessionAt(device, costHud);
      const unreg = wire(store);
      expect(nextFlowScreen("4", {}, {})).toBe("6");
      unreg();
    }
  });
});

// ---------------------------------------------------------------------------
// The Start-in-Veo page is gone
// ---------------------------------------------------------------------------

describe("no Start-in-Veo page", () => {
  it("renders no deep links, no countdown and no 'I already started' button", async () => {
    // The start is in flight while the mocked call hangs — the screen the
    // rider sees during that window is a plain "starting" beat, nothing to
    // tap and nothing about Veo.
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi.fn().mockReturnValue(new Promise(() => {}));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(root().querySelectorAll("a").length).toBe(0);
    expect(root().querySelectorAll("button").length).toBe(0);
    expect(root().textContent).not.toContain("Start in Veo");
    expect(root().textContent).not.toContain("I already started");
    expect(root().textContent).toContain("Starting your ride");
  });
});

// ---------------------------------------------------------------------------
// Auto-start — the happy path
// ---------------------------------------------------------------------------

describe("automatic start on mount", () => {
  it("starts the ride without the rider touching anything, then hands off", async () => {
    const session = sessionAt(DEVICE, true);
    const started = fakeStartedRide({ started_at: "2026-07-29T18:30:00Z" });
    const startTrackedRide = vi.fn().mockResolvedValue(started);
    const onRideStarted = vi.fn();
    wire(session, { startTrackedRide, onRideStarted });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(startTrackedRide).toHaveBeenCalledTimes(1);
    const [body] = startTrackedRide.mock.calls[0] as [Record<string, unknown>];
    expect(body).toMatchObject({
      vehicle_identifier: DEVICE.vehicleIdentifier,
      start_lat: FIX.lat,
      start_lon: FIX.lng,
      reported_start_battery_percent: 42,
    });
    expect(body.ride_options).toEqual(baseOptions(true));

    const doc = session.current();
    expect(doc?.state).toBe("riding");
    expect(doc?.rideId).toBe("ride-1");
    expect(doc?.trackKeyId).toBe("ride-1");
    expect(doc?.private).toBe(false);
    expect(doc?.startedAtMs).toBe(Date.parse("2026-07-29T18:30:00Z"));

    expect(onRideStarted).toHaveBeenCalledWith(started);
    // Screen 6 is the last flow step: `ctx.next()` runs off the end and hands
    // off, closing the modal.
    expect(rideModalRoot()).toBeNull();
    expect(currentRideScreen()).toBeNull();
  });

  it("omits reported_start_battery_percent when it was never confirmed", async () => {
    const noBattery: RideSessionSelectedDevice = { ...DEVICE, batteryConfirmed: null };
    const session = sessionAt(noBattery, true);
    const startTrackedRide = vi.fn().mockResolvedValue(fakeStartedRide());
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    const [body] = startTrackedRide.mock.calls[0] as [Record<string, unknown>];
    expect("reported_start_battery_percent" in body).toBe(false);
  });

  it("waits for a late first fix rather than failing on the spot", async () => {
    const session = sessionAt(DEVICE, true);
    const locate = fakeLocate(null);
    const startTrackedRide = vi.fn().mockResolvedValue(fakeStartedRide());
    wire(session, { locate, startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(root().textContent).toContain("Waiting for your location");

    locate.emitFix(FIX);
    await settle();
    expect(startTrackedRide).toHaveBeenCalledTimes(1);
    expect(session.current()?.state).toBe("riding");
  });

  it("starts exactly once even if several fixes arrive", async () => {
    const session = sessionAt(DEVICE, true);
    const locate = fakeLocate(null);
    // A start that never settles, so every later fix lands mid-flight.
    const startTrackedRide = vi.fn().mockReturnValue(new Promise(() => {}));
    wire(session, { locate, startTrackedRide });
    openRideModal({ fastForwardTo: "6" });

    locate.emitFix(FIX);
    locate.emitFix({ ...FIX, accuracy: 3 });
    locate.emitFix({ ...FIX, accuracy: 2 });
    await settle();

    expect(startTrackedRide).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guest / private rides — regression: must never call the authed-only
// `POST /tracked-rides` (see the module's FIX note). A guest's real-device
// pick reaches this screen just like a signed-in rider's, so this is the
// common guest path, not an edge case.
// ---------------------------------------------------------------------------

describe("guest / private rides — never call the authed start endpoint", () => {
  it("starts locally with no network call and hands off", async () => {
    const session = privateSessionAt(DEVICE);
    const startTrackedRide = vi.fn();
    const onPrivateRideStarted = vi.fn();
    wire(session, {
      startTrackedRide,
      onPrivateRideStarted,
      now: () => 1_753_800_000_000,
      randomBytes: (n) => new Uint8Array(n).fill(0xab),
    });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(startTrackedRide).not.toHaveBeenCalled();
    const doc = session.current();
    expect(doc?.state).toBe("riding");
    expect(doc?.rideId).toBeNull();
    expect(doc?.private).toBe(true);
    expect(doc?.trackKeyId).toBe("private-abababababab");
    expect(doc?.startedAtMs).toBe(1_753_800_000_000);
    expect(onPrivateRideStarted).toHaveBeenCalledWith("private-abababababab");
    expect(rideModalRoot()).toBeNull();
  });

  it("generates a fresh trackKeyId from the injected randomBytes source", async () => {
    const session = privateSessionAt(DEVICE);
    const randomBytes = vi.fn((n: number) =>
      Uint8Array.from({ length: n }, (_, i) => i + 1),
    );
    wire(session, { randomBytes });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(randomBytes).toHaveBeenCalledWith(6);
    expect(session.current()?.trackKeyId).toBe("private-010203040506");
  });
});

// ---------------------------------------------------------------------------
// Own device ("My Scooter/Bike") — always a private, local-only start
// ---------------------------------------------------------------------------

describe("own device — auto-starts privately", () => {
  it("reaches riding with no server call and hands off", async () => {
    const session = privateSessionAt(OWN_DEVICE);
    const startTrackedRide = vi.fn();
    const onPrivateRideStarted = vi.fn();
    wire(session, { startTrackedRide, onPrivateRideStarted });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(startTrackedRide).not.toHaveBeenCalled();
    const doc = session.current();
    expect(doc?.state).toBe("riding");
    expect(doc?.private).toBe(true);
    expect(doc?.rideId).toBeNull();
    expect(onPrivateRideStarted).toHaveBeenCalledTimes(1);
    expect(rideModalRoot()).toBeNull();
  });

  it("still waits for a GPS fix before starting", async () => {
    const session = privateSessionAt(OWN_DEVICE);
    const locate = fakeLocate(null);
    wire(session, { locate });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(session.current()?.state).toBe("wizard");
    expect(root().textContent).toContain("Waiting for your location");

    locate.emitFix(FIX);
    await settle();
    expect(session.current()?.state).toBe("riding");
  });
});

// ---------------------------------------------------------------------------
// Start failures — a visible Try again, never an invisible retry loop
// ---------------------------------------------------------------------------

describe("start failures", () => {
  it("409 (already an active ride): shows a specific message and a Try again", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("conflict", "HTTP_ERROR", { status: 409 }));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(root().textContent).toContain("already have an active ride");
    expect(session.current()?.state).toBe("wizard");
    expect(session.current()?.screen).toBe("6");
    expect(rideModalRoot()).not.toBeNull();
    expect(buttonWithText("Try again").disabled).toBe(false);
  });

  it("404 (vehicle left the feed): shows a specific message", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("gone", "HTTP_ERROR", { status: 404 }));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(root().textContent).toContain("isn't in the live feed anymore");
  });

  it("a generic/network failure shows a retry-able message and never crashes", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi.fn().mockRejectedValue(new Error("offline"));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(root().textContent).toContain("Couldn't start the ride");
    expect(session.current()?.state).toBe("wizard");
  });

  it("does not retry by itself after a failure", async () => {
    const startTrackedRide = vi.fn().mockRejectedValue(new Error("offline"));
    const session = sessionAt(DEVICE, true);
    const locate = fakeLocate(FIX);
    wire(session, { locate, startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();
    expect(startTrackedRide).toHaveBeenCalledTimes(1);

    // Later fixes must not re-trigger the failed attempt invisibly.
    locate.emitFix({ ...FIX, accuracy: 3 });
    await settle();
    expect(startTrackedRide).toHaveBeenCalledTimes(1);
  });

  it("Try again re-attempts the start and can succeed", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(fakeStartedRide());
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();
    expect(root().textContent).toContain("Couldn't start the ride");

    buttonWithText("Try again").click();
    await settle();

    expect(startTrackedRide).toHaveBeenCalledTimes(2);
    expect(session.current()?.state).toBe("riding");
    expect(rideModalRoot()).toBeNull();
  });

  // Review fix regression: a 409 used to always render a dead-end static
  // message. When the caller wires `onServerConflict` (main.ts does, to show
  // the shared resume-or-end prompt), that hook fires instead and the static
  // copy is suppressed.
  it("409 with onServerConflict wired: calls the hook instead of the static message", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("conflict", "HTTP_ERROR", { status: 409 }));
    const onServerConflict = vi.fn();
    wire(session, { startTrackedRide, onServerConflict });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(onServerConflict).toHaveBeenCalledTimes(1);
    expect(root().textContent).not.toContain("already have an active ride");
    expect(session.current()?.state).toBe("wizard");
    expect(session.current()?.screen).toBe("6");
  });
});

// ---------------------------------------------------------------------------
// Defensive render — a stray ctx.go("6") with nothing selected
// ---------------------------------------------------------------------------

describe("nothing selected", () => {
  it("renders an honest 'go back' message instead of crashing or starting", async () => {
    // With no device the skip predicate says to step past Screen 6, but a
    // fast-forward target is a floor — `resolveStartScreen` still lands
    // there when nothing else will take the rider. The factory's own guard
    // has to hold: no crash, no start attempt, an honest message.
    const session = sessionAt(null);
    const startTrackedRide = vi.fn();
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    await settle();

    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(session.current()?.state).toBe("wizard");
    expect(root().textContent).toContain("No ride selected");
    expect(root().textContent).toContain("Go back");
  });
});
