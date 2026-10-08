// @vitest-environment happy-dom
//
// Screen 6 — "Open in Veo". Covers: the skip predicate's device+cost_hud
// matrix, that the Android/Apple buttons carry the literal SAME Adjust link,
// that the default countdown can never silently drift from ride-hud.ts's own
// default, the countdown → POST /tracked-rides → `rideStarted` → handoff
// happy path (both the timed and the "I already started" skip), Cancel, and
// graceful degradation (no GPS fix, no plate, a 409/404/generic start
// failure).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type RideOptions, type StartedTrackedRide } from "./api.ts";
import { veoDeepLink } from "./config.ts";
import type { LngLat } from "./locate.ts";
import {
  currentRideScreen,
  nextFlowScreen,
  openRideModal,
  resetRideModal,
  rideModalRoot,
  wireRideModal,
} from "./ride-modal.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideSessionDevice,
  type RideSessionSelectedDevice,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  START_COUNTDOWN_S,
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
 *  `syncSessionDevice` now does this for real; see this file's "guest /
 *  private ride" tests below). */
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
    // The failure face fetches the survey instrument's neighbourhood list in
    // the background. Stubbed by default so no test reaches the network — an
    // un-stubbed default made a real request from every test that reported a
    // failed start, and happy-dom aborted it at teardown.
    fetchSurveyOptions: async () => {
      throw new Error("survey options stubbed out");
    },
    submitRiderStory: async () => {
      throw new Error("story submission stubbed out");
    },
    ...overrides,
  });
}

function root(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".ride-screen-start");
  if (!el) throw new Error("Screen 6 root not found");
  return el;
}

function anchors(): HTMLAnchorElement[] {
  return [...root().querySelectorAll<HTMLAnchorElement>("a.login-btn")];
}

function buttonWithText(text: string): HTMLButtonElement {
  const btn = [...root().querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`button ${JSON.stringify(text)} not found`);
  return btn;
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
// skip() — the device + cost_hud matrix
// ---------------------------------------------------------------------------

describe("startScreenSkip — device + cost_hud matrix", () => {
  it("no session doc at all -> skip", () => {
    expect(startScreenSkip(null)).toBe(true);
  });

  // Review fix: Screen 6 is universal for ANY selected device (own or real) —
  // it no longer gates on `cost_hud` at all. Skip only when nothing was
  // selected. Before this fix, "own device" and "real device, cost_hud off"
  // both skipped — and since `rideStarted` has no other legal dispatch site,
  // neither flavor of ride could ever reach `riding` (see the tests below).
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
    // 4's [Next] fires. Screen 6 shows for every device configuration now —
    // own device and cost_hud off included (review fix).
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
// Countdown default — must not drift from ride-hud.ts's own default.
// ---------------------------------------------------------------------------

describe("START_COUNTDOWN_S", () => {
  /** Reads ride-hud.ts's SOURCE for its `#hud-delay` picker's default
   *  `<option selected>` — deliberately not a second hardcoded literal `10`,
   *  since ride-hud.ts is out of this lane's edit scope: if a sibling F3 lane
   *  ever changes that default, this test fails instead of the two silently
   *  drifting apart. */
  function hudDefaultCountdownSeconds(): number {
    // `process.cwd()` rather than `new URL(..., import.meta.url)`: under the
    // happy-dom test environment the global `URL` this file's docblock opts
    // into is happy-dom's own implementation, not Node's — passing an
    // instance of it to `node:url`'s `fileURLToPath` throws ("The URL must
    // be of scheme file") even though it prints as a well-formed file: URL.
    // Vitest always runs from the repo root, so a plain path join is both
    // simpler and sidesteps that mismatch entirely.
    const path = join(process.cwd(), "src", "ride-hud.ts");
    const src = readFileSync(path, "utf8");
    const m = src.match(/<option selected>(\d+)<\/option>/);
    if (!m) {
      throw new Error(
        "couldn't find ride-hud.ts's default countdown <option selected> — did its markup change?",
      );
    }
    return Number(m[1]);
  }

  it("matches ride-hud.ts's own #hud-delay default, read from its source", () => {
    expect(START_COUNTDOWN_S).toBe(hudDefaultCountdownSeconds());
  });
});

// ---------------------------------------------------------------------------
// The Adjust link — literal equality, both buttons.
// ---------------------------------------------------------------------------

describe("Open in Veo buttons", () => {
  it("Android and Apple resolve to the literal SAME Adjust link", () => {
    const session = sessionAt(DEVICE, true);
    wire(session);
    openRideModal({ fastForwardTo: "6" });
    const [a, b] = anchors();
    expect(a.href).toBe(veoDeepLink(DEVICE.plate!));
    expect(b.href).toBe(veoDeepLink(DEVICE.plate!));
    // Guard against a future "fix" that quietly forks Android vs Apple.
    expect(a.href).toBe(b.href);
  });

  it("shows a device summary with the model and plate", () => {
    const session = sessionAt(DEVICE, true);
    wire(session);
    openRideModal({ fastForwardTo: "6" });
    expect(root().textContent).toContain("Cosmo");
    expect(root().textContent).toContain("1234567");
  });

  it("no plate yet: links have no href, but the flow is never blocked", () => {
    const noPlate: RideSessionSelectedDevice = { ...DEVICE, plate: null };
    const session = sessionAt(noPlate, true);
    wire(session);
    openRideModal({ fastForwardTo: "6" });
    for (const a of anchors()) expect(a.hasAttribute("href")).toBe(false);
    expect(root().textContent).toContain("We don't have this scooter's plate yet");
  });
});

// ---------------------------------------------------------------------------
// GPS gating
// ---------------------------------------------------------------------------

describe("GPS gating", () => {
  it("disables every start action until a fix arrives, then enables them", () => {
    const session = sessionAt(DEVICE, true);
    const locate = fakeLocate(null);
    wire(session, { locate });
    openRideModal({ fastForwardTo: "6" });
    for (const a of anchors()) expect(a.hasAttribute("disabled")).toBe(true);
    expect(buttonWithText("I already started").disabled).toBe(true);
    expect(root().textContent).toContain("Waiting for your location");

    locate.emitFix(FIX);
    for (const a of anchors()) expect(a.hasAttribute("disabled")).toBe(false);
    expect(buttonWithText("I already started").disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// "I already started" — the beginCountdown(0) equivalent: straight to riding.
// ---------------------------------------------------------------------------

describe('"I already started"', () => {
  it("starts the ride immediately, no countdown, and hands off", async () => {
    const session = sessionAt(DEVICE, true);
    const started = fakeStartedRide({ started_at: "2026-07-29T18:30:00Z" });
    const startTrackedRide = vi.fn().mockResolvedValue(started);
    const onRideStarted = vi.fn();
    wire(session, { startTrackedRide, onRideStarted });
    openRideModal({ fastForwardTo: "6" });

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

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

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

    const [body] = startTrackedRide.mock.calls[0] as [Record<string, unknown>];
    expect("reported_start_battery_percent" in body).toBe(false);
  });

  it("does nothing while no GPS fix is available", () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi.fn();
    wire(session, { locate: fakeLocate(null), startTrackedRide });
    openRideModal({ fastForwardTo: "6" });
    buttonWithText("I already started").click();
    expect(startTrackedRide).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// "Open in Veo" — the timed countdown path.
// ---------------------------------------------------------------------------

describe("Open in Veo — timed countdown", () => {
  it("ticks down from START_COUNTDOWN_S, then starts the ride and hands off", async () => {
    vi.useFakeTimers();
    const session = sessionAt(DEVICE, true);
    const started = fakeStartedRide();
    const startTrackedRide = vi.fn().mockResolvedValue(started);
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });

    anchors()[0].click();
    // Screen 6's own transition, dispatched the moment the countdown begins.
    expect(session.current()?.state).toBe("countdown");
    expect(root().textContent).toContain(String(START_COUNTDOWN_S));
    expect(startTrackedRide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync((START_COUNTDOWN_S - 1) * 1000);
    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(session.current()?.state).toBe("countdown");

    await vi.advanceTimersByTimeAsync(1000);
    expect(startTrackedRide).toHaveBeenCalledTimes(1);
    expect(session.current()?.state).toBe("riding");
    expect(rideModalRoot()).toBeNull();
  });

  it("Cancel during the countdown returns to Screen 6 without starting", async () => {
    vi.useFakeTimers();
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi.fn();
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });

    anchors()[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    buttonWithText("Cancel").click();

    expect(session.current()?.state).toBe("wizard");
    expect(session.current()?.screen).toBe("6");
    await vi.advanceTimersByTimeAsync((START_COUNTDOWN_S + 5) * 1000);
    expect(startTrackedRide).not.toHaveBeenCalled();
    // Back to the idle buttons.
    expect(anchors().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Start failures degrade gracefully.
// ---------------------------------------------------------------------------

describe("start failures", () => {
  it("409 (already an active ride): shows a specific message and returns to Screen 6", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("conflict", "HTTP_ERROR", { status: 409 }));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(root().textContent).toContain("already have an active ride");
    expect(session.current()?.state).toBe("wizard");
    expect(session.current()?.screen).toBe("6");
    expect(rideModalRoot()).not.toBeNull();
    expect(buttonWithText("I already started").disabled).toBe(false);
  });

  it("404 (vehicle left the feed): shows a specific message", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("gone", "HTTP_ERROR", { status: 404 }));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(root().textContent).toContain("isn't in the live feed anymore");
  });

  it("a generic/network failure shows a retry-able message and never crashes", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi.fn().mockRejectedValue(new Error("offline"));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(root().textContent).toContain("Couldn't start the ride");
    expect(session.current()?.state).toBe("wizard");
  });

  it("a countdown-triggered failure also reverts to Screen 6, retryable", async () => {
    vi.useFakeTimers();
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("conflict", "HTTP_ERROR", { status: 409 }));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });

    anchors()[0].click();
    await vi.advanceTimersByTimeAsync(START_COUNTDOWN_S * 1000);

    expect(session.current()?.state).toBe("wizard");
    expect(session.current()?.screen).toBe("6");
    expect(root().textContent).toContain("already have an active ride");
    expect(rideModalRoot()).not.toBeNull();
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

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onServerConflict).toHaveBeenCalledTimes(1);
    expect(root().textContent).not.toContain("already have an active ride");
    expect(session.current()?.state).toBe("wizard");
    expect(session.current()?.screen).toBe("6");
  });
});

// ---------------------------------------------------------------------------
// Guest / private rides — regression: must never call the authed-only
// `POST /tracked-rides` (see this module's FIX note). A private ride's
// real-device pick reaches this screen just like a signed-in rider's (the
// skip predicate only gates on device + cost_hud, not auth), and `cost_hud`
// defaults ON, so this is the common guest path, not an edge case.
// ---------------------------------------------------------------------------

describe("guest / private rides — never call the authed start endpoint", () => {
  it('"I already started": starts locally, no network call, and hands off', async () => {
    const session = privateSessionAt(DEVICE, true);
    const startTrackedRide = vi.fn();
    const onRideStarted = vi.fn();
    wire(session, { startTrackedRide, onRideStarted, now: () => 1_700_000_000_000 });
    openRideModal({ fastForwardTo: "6" });

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(onRideStarted).not.toHaveBeenCalled();

    const doc = session.current();
    expect(doc?.state).toBe("riding");
    expect(doc?.rideId).toBeNull();
    expect(doc?.private).toBe(true);
    expect(doc?.trackKeyId).toMatch(/^private-[0-9a-f]{12}$/);
    expect(doc?.startedAtMs).toBe(1_700_000_000_000);

    // Screen 6 is the last flow step: same handoff as the server-ride path.
    expect(rideModalRoot()).toBeNull();
    expect(currentRideScreen()).toBeNull();
  });

  it("the timed countdown also starts locally with no network call", async () => {
    vi.useFakeTimers();
    const session = privateSessionAt(DEVICE, true);
    const startTrackedRide = vi.fn();
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6" });

    anchors()[0].click();
    expect(session.current()?.state).toBe("countdown");
    await vi.advanceTimersByTimeAsync(START_COUNTDOWN_S * 1000);

    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(session.current()?.state).toBe("riding");
    expect(session.current()?.rideId).toBeNull();
    expect(session.current()?.private).toBe(true);
  });

  it("generates a fresh trackKeyId from the injected randomBytes source", async () => {
    const session = privateSessionAt(DEVICE, true);
    const randomBytes = vi.fn((n: number) => new Uint8Array(n).fill(0xab));
    wire(session, { startTrackedRide: vi.fn(), randomBytes });
    openRideModal({ fastForwardTo: "6" });

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.current()?.trackKeyId).toBe("private-abababababab");
  });
});

// ---------------------------------------------------------------------------
// Review fix regression: own-device and cost_hud-off rides used to skip
// Screen 6 entirely, and since `rideStarted` has no other legal dispatch
// site, neither could ever reach `riding`. Both configurations must now
// reach `riding` and hand off, exactly like a normal Veo-device ride.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Integration regression — the 2026-08 field failure. main.ts persists each
// screen onto the session doc via `onScreenChange` AFTER the screen factory
// has already run, so at auto-start time the doc still reads the PREVIOUS
// screen. Pre-fix, the synchronous own-device auto-start dispatched
// `rideStarted` from `wizard:2`, the reducer rejected it, and the flow ran
// off the end anyway: wizard closed, no ride, no HUD. These tests wire the
// same onScreenChange main.ts does instead of pre-seeding the doc at "6".
// ---------------------------------------------------------------------------

describe("shell persists the screen only after the factory runs", () => {
  function mainLikeWiring(store: RideSessionStore): void {
    wireRideModal({
      onScreenChange: (id) => {
        store.dispatch({ type: "goto", screen: id });
      },
    });
  }

  it("own-device auto-start still reaches riding from a doc reading wizard:2", async () => {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    store.dispatch({ type: "open", options: baseOptions(true), screen: "2" });
    store.dispatch({ type: "setDevice", device: OWN_DEVICE });
    mainLikeWiring(store);
    const onPrivateRideStarted = vi.fn();
    wire(store, { onPrivateRideStarted });
    openRideModal({ fastForwardTo: "6" });

    await vi.waitFor(() => expect(store.current()?.state).toBe("riding"));
    expect(store.current()?.rideId).toBeNull();
    expect(store.current()?.private).toBe(true);
    expect(onPrivateRideStarted).toHaveBeenCalledTimes(1);
    expect(rideModalRoot()).toBeNull();
  });

  it("entry.autoStart on a private guest ride reaches riding from wizard:2 too", async () => {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    store.dispatch({ type: "open", options: baseOptions(true), screen: "2" });
    store.dispatch({ type: "setDevice", device: DEVICE, private: true });
    mainLikeWiring(store);
    const startTrackedRide = vi.fn();
    wire(store, { startTrackedRide });
    openRideModal({ fastForwardTo: "6", autoStart: true });

    await vi.waitFor(() => expect(store.current()?.state).toBe("riding"));
    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(store.current()?.private).toBe(true);
  });

  it("never closes the wizard on a rejected rideStarted — shows an error instead", async () => {
    // Force a rejection the self-heal cannot fix: a doc pinned in countdown
    // with a rideId (goto is illegal there, and rideStarted from countdown
    // IS legal — so instead pin the doc by replacing dispatch with one that
    // rejects rideStarted). Simplest honest probe: a store whose doc is at
    // wizard:2 with a dispatch wrapper that drops goto, so the self-heal
    // silently fails and rideStarted stays illegal.
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    store.dispatch({ type: "open", options: baseOptions(true), screen: "2" });
    store.dispatch({ type: "setDevice", device: OWN_DEVICE });
    const gotoLess: typeof store = {
      ...store,
      dispatch: (a) => (a.type === "goto" ? null : store.dispatch(a)),
    };
    wire(gotoLess as never);
    openRideModal({ fastForwardTo: "6" });

    await vi.waitFor(() =>
      expect(root().textContent).toContain("Couldn't start the ride"),
    );
    expect(store.current()?.state).toBe("wizard");
    expect(rideModalRoot()).not.toBeNull();
  });
});

describe('own device ("My Scooter/Bike") — auto-starts, no Veo page', () => {
  function ownDeviceSession(): RideSessionStore {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    store.dispatch({ type: "open", options: baseOptions(true), screen: "6" });
    store.dispatch({ type: "setDevice", device: OWN_DEVICE });
    return store;
  }

  it("reaches riding on mount (private, no server call) and hands off, untouched", async () => {
    const session = ownDeviceSession();
    const startTrackedRide = vi.fn();
    const onRideStarted = vi.fn();
    const onPrivateRideStarted = vi.fn();
    wire(session, {
      startTrackedRide,
      onRideStarted,
      onPrivateRideStarted,
      now: () => 1_700_000_000_000,
    });
    openRideModal({ fastForwardTo: "6" });
    await Promise.resolve();
    await Promise.resolve();

    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(onRideStarted).not.toHaveBeenCalled();

    const doc = session.current();
    expect(doc?.state).toBe("riding");
    expect(doc?.rideId).toBeNull();
    expect(doc?.private).toBe(true);
    expect(doc?.startedAtMs).toBe(1_700_000_000_000);

    // `onPrivateRideStarted` must fire with the SAME trackKeyId the doc
    // already carries, so the caller can attach a local recorder under that
    // exact id.
    expect(onPrivateRideStarted).toHaveBeenCalledTimes(1);
    expect(onPrivateRideStarted).toHaveBeenCalledWith(doc?.trackKeyId);
    expect(doc?.trackKeyId).toMatch(/^private-[0-9a-f]{12}$/);

    expect(rideModalRoot()).toBeNull();
    expect(currentRideScreen()).toBeNull();
  });

  it("waits for a GPS fix rather than failing on the spot, then starts", async () => {
    const session = ownDeviceSession();
    const locate = fakeLocate(null);
    wire(session, { locate });
    openRideModal({ fastForwardTo: "6" });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.current()?.state).toBe("wizard");
    expect(root().textContent).toContain("Waiting for your location");
    // No Veo anything while it waits — this is the non-Veo path.
    expect(anchors().length).toBe(0);
    expect(root().textContent).not.toContain("Open in Veo");

    locate.emitFix(FIX);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.current()?.state).toBe("riding");
  });

  it('a failed attempt falls back to the interactive "My Scooter/Bike" face, never a dead spinner', async () => {
    // A private start has no network to fail on, but it CAN lose its fix
    // between the auto-attempt arming and the dispatch: a locate whose
    // onFix fires but whose current() reads null models exactly that.
    const session = ownDeviceSession();
    const listeners = new Set<(pos: LngLat) => void>();
    const flakyLocate: LocateLike = {
      current: () => null,
      onFix: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    wire(session, { locate: flakyLocate });
    openRideModal({ fastForwardTo: "6" });
    for (const cb of [...listeners]) cb(FIX);
    await Promise.resolve();
    await Promise.resolve();

    expect(session.current()?.state).toBe("wizard");
    expect(root().textContent).toContain("My Scooter/Bike");
    expect(root().textContent).toContain("We lost your location");
    expect(() => buttonWithText("Start ride mode")).not.toThrow();
    // Still no Veo anything, even on the fallback face.
    expect(anchors().length).toBe(0);
  });
});

describe("a specific Veo device with cost_hud OFF — Screen 6 is now universal", () => {
  it('"I already started" reaches riding via the normal server-ride path', async () => {
    const session = sessionAt(DEVICE, false);
    const started = fakeStartedRide({ started_at: "2026-07-29T18:30:00Z" });
    const startTrackedRide = vi.fn().mockResolvedValue(started);
    const onRideStarted = vi.fn();
    wire(session, { startTrackedRide, onRideStarted });
    openRideModal({ fastForwardTo: "6" });

    buttonWithText("I already started").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(startTrackedRide).toHaveBeenCalledTimes(1);
    const doc = session.current();
    expect(doc?.state).toBe("riding");
    expect(doc?.rideId).toBe("ride-1");
    expect(doc?.private).toBe(false);
    expect(onRideStarted).toHaveBeenCalledWith(started);
    expect(rideModalRoot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auto-start — the device-card "Use in Ride Mode" survey path.
//
// `ride-preflight.ts` sets `entry.autoStart` when its survey established that
// there is nothing left to ask about Veo: the rider said they had already
// unlocked the scooter, or they turned the cost HUD off (which per spec
// removes the consideration of starting Veo altogether).
//
// Screen 6 still RUNS — it is the reducer's only legal seat for `rideStarted`
// — it just doesn't ask anything. These tests pin that it takes exactly the
// "I already started" branch (no second start path to keep in sync), that it
// waits for a fix like the buttons do, and above all that a failure hands the
// rider back a fully interactive screen instead of stranding them on a
// spinner with no control on it.
// ---------------------------------------------------------------------------

describe("auto-start (entry.autoStart)", () => {
  it("starts the ride on mount without the rider touching anything", async () => {
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi.fn().mockResolvedValue(fakeStartedRide());
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6", autoStart: true });

    await vi.waitFor(() => expect(startTrackedRide).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.current()?.state).toBe("riding"));
  });

  it("shows no Veo links, countdown or 'I already started' button", () => {
    // Every one of those re-asks something the device card already settled.
    const session = sessionAt(DEVICE, true);
    wire(session, {
      locate: fakeLocate(null), // hold it on screen by withholding the fix
      startTrackedRide: vi.fn().mockResolvedValue(fakeStartedRide()),
    });
    openRideModal({ fastForwardTo: "6", autoStart: true });

    expect(anchors()).toHaveLength(0);
    // The ONLY button is the failed-start exit, which re-asks nothing — it is
    // the answer to "this scooter doesn't work", a thing the device card's
    // survey could not have settled in advance. Asserted by name rather than
    // by a count of zero, so a future button that DOES re-ask still trips it.
    expect(
      [...root().querySelectorAll("button")].map((b) => b.textContent),
    ).toEqual(["🚫 It won't start"]);
    expect(root().textContent).toContain("Starting ride mode…");
  });

  it("waits for a late first fix rather than failing on the spot", async () => {
    // The common case: Screen 1 primed the permission, but the reading lands
    // after this screen has already mounted.
    const session = sessionAt(DEVICE, true);
    const locate = fakeLocate(null);
    const startTrackedRide = vi.fn().mockResolvedValue(fakeStartedRide());
    wire(session, { locate, startTrackedRide });
    openRideModal({ fastForwardTo: "6", autoStart: true });

    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(root().textContent).toContain("Waiting for your location");

    locate.emitFix(FIX);
    await vi.waitFor(() => expect(startTrackedRide).toHaveBeenCalledTimes(1));
  });

  it("starts exactly once even if several fixes arrive", async () => {
    const session = sessionAt(DEVICE, true);
    const locate = fakeLocate(null);
    const startTrackedRide = vi.fn().mockResolvedValue(fakeStartedRide());
    wire(session, { locate, startTrackedRide });
    openRideModal({ fastForwardTo: "6", autoStart: true });

    locate.emitFix(FIX);
    locate.emitFix(FIX);
    locate.emitFix(FIX);
    await vi.waitFor(() => expect(startTrackedRide).toHaveBeenCalledTimes(1));
  });

  it("hands the rider back an interactive screen when the start fails", async () => {
    // The important one: an auto-start that dead-ends on "Starting ride
    // mode…" with no control on screen would be a trap, and the rider never
    // asked for a screen with no way forward.
    const session = sessionAt(DEVICE, true);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("nope", "HTTP_ERROR", { status: 500 }));
    wire(session, { startTrackedRide });
    openRideModal({ fastForwardTo: "6", autoStart: true });

    await vi.waitFor(() => {
      expect(root().textContent).toContain("Couldn't start the ride");
    });
    // The full manual affordance is back: both Veo links and the skip button.
    expect(anchors()).toHaveLength(2);
    expect(buttonWithText("I already started").disabled).toBe(false);
  });

  it("does not retry itself after a failure", async () => {
    const session = sessionAt(DEVICE, true);
    const locate = fakeLocate(FIX);
    const startTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("nope", "HTTP_ERROR", { status: 500 }));
    wire(session, { locate, startTrackedRide });
    openRideModal({ fastForwardTo: "6", autoStart: true });

    await vi.waitFor(() => expect(startTrackedRide).toHaveBeenCalledTimes(1));
    locate.emitFix(FIX);
    locate.emitFix(FIX);
    await new Promise((r) => setTimeout(r, 0));
    expect(startTrackedRide).toHaveBeenCalledTimes(1);
  });

  it("renders the normal screen when the entry does not ask for auto-start", () => {
    const session = sessionAt(DEVICE, true);
    wire(session);
    openRideModal({ fastForwardTo: "6" });

    expect(anchors()).toHaveLength(2);
    expect(buttonWithText("I already started")).toBeTruthy();
  });

  it("auto-starts a private ride locally, same as the manual skip button", async () => {
    const session = privateSessionAt(DEVICE, true);
    const startTrackedRide = vi.fn();
    const onPrivateRideStarted = vi.fn();
    wire(session, { startTrackedRide, onPrivateRideStarted });
    openRideModal({ fastForwardTo: "6", autoStart: true });

    await vi.waitFor(() => expect(session.current()?.state).toBe("riding"));
    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(onPrivateRideStarted).toHaveBeenCalledTimes(1);
    expect(session.current()?.rideId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "It won't start" — the failed-start report.
//
// The hole this closes is described at length in ride-failed-start.ts: the
// fleet's `number_failed_starts` is inferred from a GBFS bike_id rotation, it
// needs two of them to downgrade a device, and the rider's own report — the one
// signal that overrides the tier outright — had no button anywhere in the flow
// that starts a ride. These tests pin the button's existence at both moments it
// matters and the two things it must never do: start a ride anyway, or leave
// the rider looking at "try again" on a scooter they just said is dead.
// ---------------------------------------------------------------------------

describe("failed start", () => {
  const FAILED_START_LABEL = "🚫 It won't start";

  it("offers the exit on the idle screen", () => {
    wire(sessionAt(DEVICE, true));
    openRideModal({ fastForwardTo: "6" });
    expect(buttonWithText(FAILED_START_LABEL)).toBeTruthy();
  });

  it("offers it during the countdown, where the failure actually happens", () => {
    wire(sessionAt(DEVICE, true));
    openRideModal({ fastForwardTo: "6" });
    anchors()[0].click();
    expect(root().textContent).toContain(String(START_COUNTDOWN_S));
    expect(buttonWithText(FAILED_START_LABEL)).toBeTruthy();
  });

  it("sends not_rideable for the selected vehicle, with the rider's position", async () => {
    const submitDeviceReport = vi.fn().mockResolvedValue({ deduped: false });
    wire(sessionAt(DEVICE, true), { submitDeviceReport });
    openRideModal({ fastForwardTo: "6" });
    buttonWithText(FAILED_START_LABEL).click();

    await vi.waitFor(() => expect(submitDeviceReport).toHaveBeenCalledTimes(1));
    expect(submitDeviceReport).toHaveBeenCalledWith({
      vehicle_identifier: DEVICE.vehicleIdentifier,
      report_type: "not_rideable",
      lat: FIX.lat,
      lng: FIX.lng,
    });
    await vi.waitFor(() =>
      expect(root().textContent).toContain("next rider"),
    );
  });

  it("stops the countdown dead — a reported scooter never starts a ride", async () => {
    vi.useFakeTimers();
    const startTrackedRide = vi.fn().mockResolvedValue(fakeStartedRide());
    const submitDeviceReport = vi.fn().mockResolvedValue({ deduped: false });
    const session = sessionAt(DEVICE, true);
    wire(session, { startTrackedRide, submitDeviceReport });
    openRideModal({ fastForwardTo: "6" });

    anchors()[0].click();
    expect(session.current()?.state).toBe("countdown");
    buttonWithText(FAILED_START_LABEL).click();

    // Well past when the countdown would have fired.
    await vi.advanceTimersByTimeAsync((START_COUNTDOWN_S + 5) * 1000);
    expect(startTrackedRide).not.toHaveBeenCalled();
    expect(session.current()?.state).not.toBe("riding");
    // Walked back off the countdown by the one legal route, so the screen is
    // navigable again rather than stuck mid-count.
    expect(session.current()?.state).toBe("wizard");
  });

  it("sends the rider to the picker, and offers no second attempt", async () => {
    const submitDeviceReport = vi.fn().mockResolvedValue({ deduped: false });
    const session = sessionAt(DEVICE, true);
    wire(session, { submitDeviceReport });
    // Screen 2 has to exist for `ctx.go("2")` to land anywhere.
    wireRideModal({});
    openRideModal({ fastForwardTo: "6" });
    buttonWithText(FAILED_START_LABEL).click();

    await vi.waitFor(() => expect(root().textContent).toContain("next rider"));
    // The Veo links and "I already started" are gone: the report we just sent
    // says this scooter does not ride.
    expect(anchors()).toHaveLength(0);
    const labels = [...root().querySelectorAll("button")].map((b) => b.textContent);
    // The story panel's own two buttons sit above this one; what must not
    // exist is any way to start THIS scooter again. Asserted as the absence
    // of a retry rather than as an exact button list, so adding an offer
    // below the report cannot silently satisfy the test the way an exact
    // match would have forced us to loosen it.
    expect(labels).toContain("Pick another scooter");
    for (const label of labels) {
      expect(label).not.toMatch(/try|again|anyway|start/i);
    }
  });

  it("offers the story only after the report has landed", async () => {
    // The report is the useful artefact and it must never be held hostage to
    // a sentence. Before the report resolves there is no box; after it, there
    // is — and the report's own message is still on screen.
    let resolveReport: (v: { deduped: boolean }) => void = () => {};
    const submitDeviceReport = vi.fn(
      () => new Promise<{ deduped: boolean }>((r) => { resolveReport = r; }),
    );
    wire(sessionAt(DEVICE, true), { submitDeviceReport });
    wireRideModal({});
    openRideModal({ fastForwardTo: "6" });
    buttonWithText(FAILED_START_LABEL).click();

    await vi.waitFor(() => expect(root().textContent).toContain("Telling the fleet"));
    expect(root().querySelector(".story-panel__text")).toBeNull();

    resolveReport({ deduped: false });
    await vi.waitFor(() => expect(root().textContent).toContain("next rider"));
    expect(root().querySelector(".story-panel__text")).not.toBeNull();
    expect(root().textContent).toContain("What happened?");
  });

  it("asks even when we had nothing to report", async () => {
    // A rider whose report could not be sent has MORE to say about their
    // morning, not less.
    wire(sessionAt(OWN_DEVICE, true));
    wireRideModal({});
    openRideModal({ fastForwardTo: "6" });
    buttonWithText(FAILED_START_LABEL).click();
    await vi.waitFor(() =>
      expect(root().querySelector(".story-panel__text")).not.toBeNull(),
    );
  });

  it("does not offer to send it onward when the instrument is unreachable", async () => {
    // The default stub rejects. We could not file it correctly, so the
    // third-party lane is simply not offered — the box still is.
    const submitDeviceReport = vi.fn().mockResolvedValue({ deduped: false });
    wire(sessionAt(DEVICE, true), { submitDeviceReport });
    wireRideModal({});
    openRideModal({ fastForwardTo: "6" });
    buttonWithText(FAILED_START_LABEL).click();
    await vi.waitFor(() => expect(root().textContent).toContain("next rider"));
    expect(root().querySelector(".story-panel__text")).not.toBeNull();
    expect(root().textContent).not.toContain("We See You Veo");
  });

  it("offers the third-party lane once the instrument's list arrives", async () => {
    const submitDeviceReport = vi.fn().mockResolvedValue({ deduped: false });
    wire(sessionAt(DEVICE, true), {
      submitDeviceReport,
      fetchSurveyOptions: async () => ({
        ok: true,
        version: "1",
        neighborhoods: ["Baker", "Five Points"],
      }),
    });
    wireRideModal({});
    openRideModal({ fastForwardTo: "6" });
    buttonWithText(FAILED_START_LABEL).click();
    await vi.waitFor(() => expect(root().textContent).toContain("We See You Veo"));
    // Off by default, every time.
    const tick = root().querySelector<HTMLInputElement>(".story-panel__switch input");
    expect(tick?.checked).toBe(false);
  });

  it("carries on when the report is refused — the scooter is still broken", async () => {
    const submitDeviceReport = vi.fn().mockRejectedValue(new Error("offline"));
    wire(sessionAt(DEVICE, true), { submitDeviceReport });
    openRideModal({ fastForwardTo: "6" });
    buttonWithText(FAILED_START_LABEL).click();

    await vi.waitFor(() =>
      expect(root().textContent).toContain("pick another"),
    );
    expect(buttonWithText("Pick another scooter")).toBeTruthy();
  });

  it("says so plainly when there is no vehicle to report against", async () => {
    const submitDeviceReport = vi.fn();
    // A manual-plate pick whose plate never reverse-resolved: the rider has a
    // scooter in front of them and we have no identifier for it. The report
    // needs the server-side hash, which the browser cannot compute, so there is
    // nothing to send and nothing to pad it with.
    const unidentified: RideSessionSelectedDevice = {
      ...DEVICE,
      vehicleIdentifier: "",
    };
    wire(sessionAt(unidentified, true), { submitDeviceReport });
    openRideModal({ fastForwardTo: "6" });
    buttonWithText(FAILED_START_LABEL).click();
    await vi.waitFor(() =>
      expect(root().textContent).toContain("couldn't tell which scooter"),
    );
    expect(submitDeviceReport).not.toHaveBeenCalled();
  });

  it("does not auto-start behind the report", async () => {
    const startTrackedRide = vi.fn().mockResolvedValue(fakeStartedRide());
    const submitDeviceReport = vi.fn().mockResolvedValue({ deduped: false });
    const session = sessionAt(DEVICE, true);
    const locate = fakeLocate(null);
    wire(session, { startTrackedRide, submitDeviceReport, locate });
    // No fix yet, so auto-start is still waiting on one.
    openRideModal({ fastForwardTo: "6", autoStart: true });
    buttonWithText(FAILED_START_LABEL).click();
    await vi.waitFor(() => expect(submitDeviceReport).toHaveBeenCalled());

    // The fix the auto-start was waiting for finally lands.
    locate.emitFix(FIX);
    await new Promise((r) => setTimeout(r, 0));
    expect(startTrackedRide).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §11.5's "Before" half — refuse quietly rather than cheerfully
// ---------------------------------------------------------------------------

describe("pre-ride battery reach", () => {
  /** A destination roughly 5 km north-east of `FIX`, which no small range
   *  covers once the detour factor and the arrival reserve are applied. */
  const FAR = { label: "Home", lat: 39.785, lon: -104.955 };
  /** ~380 m of road distance from `FIX` — deliberately in the narrow band
   *  that only `MIN_WARNABLE_REMAINING_METERS` closes. Below ~333 m the
   *  absolute shortfall margin already makes "short" unreachable (the module
   *  states that arithmetic), so a dest any closer would pass this test for
   *  the wrong reason. */
  const NEAR = { label: "The corner", lat: 39.74253, lon: -104.99 };

  function sessionWithDest(
    dest: { label: string; lat: number; lon: number },
    device: RideSessionDevice = DEVICE,
  ): RideSessionStore {
    const store = sessionAt(device, true);
    store.dispatch({ type: "setDest", dest });
    return store;
  }

  it("names the shortfall when the feed's range will not cover the trip", () => {
    wire(sessionWithDest(FAR), { rangeMetersFor: () => 1200 });
    openRideModal({ fastForwardTo: "6" });
    const text = root().textContent ?? "";
    expect(text).toContain("may not reach Home");
    // The figures, and no instruction: we do not know whether the answer is a
    // different scooter, a shorter trip, or walking the last block.
    expect(text).toMatch(/miles of range/);
    expect(text).not.toMatch(/you should|try a|pick another/i);
  });

  it("says NOTHING when the feed gave no range — the confidence floor", () => {
    // §11.5: "the item most likely to produce a wrong claim". No observation
    // means no warning, not a hedged one.
    wire(sessionWithDest(FAR), { rangeMetersFor: () => null });
    openRideModal({ fastForwardTo: "6" });
    expect(root().textContent ?? "").not.toMatch(/may not reach/);
  });

  it("says nothing when no range lookup was supplied at all", () => {
    wire(sessionWithDest(FAR));
    openRideModal({ fastForwardTo: "6" });
    expect(root().textContent ?? "").not.toMatch(/may not reach/);
  });

  it("says nothing when the range comfortably covers the trip", () => {
    wire(sessionWithDest(FAR), { rangeMetersFor: () => 40_000 });
    openRideModal({ fastForwardTo: "6" });
    expect(root().textContent ?? "").not.toMatch(/may not reach/);
  });

  it("says nothing about a destination four hundred metres away", () => {
    // A rider who has to walk the last two minutes does not need telling, and
    // this is where the straight-line estimate is least reliable relative to
    // the distance it is estimating. The verdict here IS "short" — only the
    // warnability floor silences it.
    wire(sessionWithDest(NEAR), { rangeMetersFor: () => 50 });
    openRideModal({ fastForwardTo: "6" });
    expect(root().textContent ?? "").not.toMatch(/may not reach/);
  });

  it("says nothing when the rider named no destination", () => {
    // No "where", so no "will it reach".
    wire(sessionAt(DEVICE, true), { rangeMetersFor: () => 10 });
    openRideModal({ fastForwardTo: "6" });
    expect(root().textContent ?? "").not.toMatch(/may not reach/);
  });

  it("never blocks the start", () => {
    // It refuses QUIETLY. The rider is standing at the scooter looking at its
    // own gauge; both figures here are estimates, and a wizard that refused to
    // proceed on this evidence would be wrong often enough to be worth
    // defeating.
    wire(sessionWithDest(FAR), { rangeMetersFor: () => 1200 });
    openRideModal({ fastForwardTo: "6" });
    expect(buttonWithText("I already started").disabled).toBe(false);
    for (const a of anchors()) expect(a.hasAttribute("disabled")).toBe(false);
  });

  it("falls back to 'your destination' for a place with no name", () => {
    wire(sessionWithDest({ ...FAR, label: "" }), { rangeMetersFor: () => 1200 });
    openRideModal({ fastForwardTo: "6" });
    expect(root().textContent ?? "").toContain("may not reach your destination");
  });
});
