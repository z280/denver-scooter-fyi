// @vitest-environment happy-dom
//
// src/ride-post.ts — the integration barrel wiring Screens 8/9/10 from one
// `wireRidePost()` call. Screens 8 and 10 already have their own full test
// suites (ride-post-s8.test.ts / ride-post-s10.test.ts) covering their own
// mount/unmount lifecycle and behavior; this file's job is narrower: prove
// the barrel (a) wires all three, (b) supplies the Screen 9 host that
// ride-post-s9.ts itself does not provide (mount on `survey(9)`, unmount on
// leaving it, correct `getGateFacts`/`points` plumbing), and (c) a single
// `wireRidePost()` teardown tears down all three cleanly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RideOptions } from "./api.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideGateFacts,
  type RideSessionSelectedDevice,
  type RideSessionStore,
} from "./ride-session.ts";
import type { LocateLike } from "./ride-post-s8.ts";
import type { ResolvedRideModePoints } from "./ride-settings.ts";
import { wireRidePost } from "./ride-post.ts";

function baseOptions(overrides: Partial<RideOptions> = {}): RideOptions {
  return {
    cost_hud: true,
    speedometer: "classic",
    theme: "auto",
    navigation: false,
    save_tracks: true,
    battery_modeling: false,
    nav_improvement: false,
    end_survey: false,
    own_device: false,
    ...overrides,
  };
}

const DEVICE: RideSessionSelectedDevice = {
  vehicleIdentifier: "a1b2c3d4e5f60701",
  plate: "1234567",
  model: "cosmo",
  batteryConfirmed: 42,
};

const STARTED_AT_MS = Date.parse("2026-07-29T12:00:00Z");
const RIDE_ID = "ride-1";

/** A session doc landed on `survey(9)` — the scooter-feedback pane gated on
 *  (`end_survey: true`), no route selected (nav pane gated off). Walks the
 *  real reducer end to end: open → device → countdown → rideStarted →
 *  endRide → endReported. */
function sessionAtSurvey(
  options: Partial<RideOptions> = {},
): RideSessionStore {
  const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
  store.dispatch({
    type: "open",
    options: baseOptions({ end_survey: true, ...options }),
    screen: "6",
  });
  store.dispatch({ type: "setDevice", device: DEVICE });
  store.dispatch({ type: "startCountdown" });
  store.dispatch({
    type: "rideStarted",
    rideId: RIDE_ID,
    startedAtMs: STARTED_AT_MS,
    trackKeyId: RIDE_ID,
    private: false,
  });
  const toEnding = store.dispatch({ type: "endRide" });
  if (!toEnding?.accepted || toEnding.to !== "ending(8)") {
    throw new Error(`fixture failed to reach ending(8): landed on ${toEnding?.to}`);
  }
  const facts: RideGateFacts = { hasWaypoints: false };
  const toSurvey = store.dispatch({ type: "endReported", facts });
  if (!toSurvey?.accepted || toSurvey.to !== "survey(9)") {
    throw new Error(`fixture failed to reach survey(9): landed on ${toSurvey?.to}`);
  }
  return store;
}

function fakeLocate(): LocateLike {
  return { current: () => null, onFix: () => () => {} };
}

/** Let a screen's internal promise chain (getGateFacts → dispatch) settle
 *  after a simulated click — same pattern as ride-post-s9.test.ts's own
 *  `flush()` (mirroring ride-deeplink.test.ts's). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("wireRidePost", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
  });

  afterEach(() => {
    root.remove();
  });

  it("mounts Screen 9 immediately when the store already sits on survey(9) at wire time", () => {
    const session = sessionAtSurvey();
    const unwire = wireRidePost({
      session,
      locate: fakeLocate(),
      mountRoot: root,
    });
    expect(root.querySelector(".ride-post-modal .ride-post-s9")).not.toBeNull();
    unwire();
  });

  it("mounts Screen 9 reactively on a live endRide → endReported transition", () => {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    const unwire = wireRidePost({
      session: store,
      locate: fakeLocate(),
      mountRoot: root,
    });
    expect(root.children.length).toBe(0);

    store.dispatch({
      type: "open",
      options: baseOptions({ end_survey: true }),
      screen: "6",
    });
    store.dispatch({ type: "setDevice", device: DEVICE });
    store.dispatch({ type: "startCountdown" });
    store.dispatch({
      type: "rideStarted",
      rideId: RIDE_ID,
      startedAtMs: STARTED_AT_MS,
      trackKeyId: RIDE_ID,
      private: false,
    });
    store.dispatch({ type: "endRide" });
    expect(root.querySelector(".ride-post-s8")).not.toBeNull();
    expect(root.querySelector(".ride-post-s9")).toBeNull();

    store.dispatch({ type: "endReported", facts: { hasWaypoints: false } });
    expect(root.querySelector(".ride-post-s8")).toBeNull();
    expect(root.querySelector(".ride-post-s9")).not.toBeNull();

    unwire();
  });

  it("unmounts Screen 9 once Skip drives the phase past survey(9)", async () => {
    const session = sessionAtSurvey();
    const unwire = wireRidePost({
      session,
      locate: fakeLocate(),
      mountRoot: root,
    });
    const skipBtn = root.querySelector<HTMLButtonElement>(".ride-post-s9__skip");
    expect(skipBtn).not.toBeNull();
    skipBtn!.click();
    // handleSkip awaits `getGateFacts()` before dispatching `surveyDone`, so
    // the reactive unmount lands only after that chain settles.
    await flush();
    expect(root.querySelector(".ride-post-s9")).toBeNull();
    unwire();
  });

  it("passes getGateFacts the ride's trackId, not just any string", async () => {
    const session = sessionAtSurvey();
    const getGateFacts = vi.fn(
      async (_trackId: string | null): Promise<RideGateFacts> => ({
        hasWaypoints: true,
      }),
    );
    const unwire = wireRidePost({
      session,
      locate: fakeLocate(),
      mountRoot: root,
      getGateFacts,
    });
    const skipBtn = root.querySelector<HTMLButtonElement>(".ride-post-s9__skip");
    skipBtn!.click();
    await flush();
    expect(getGateFacts).toHaveBeenCalledWith(RIDE_ID);
    unwire();
  });

  it("renders Screen 9's pane header using the injected points() getter", () => {
    const session = sessionAtSurvey();
    const points: ResolvedRideModePoints = {
      batteryBase: 8,
      batteryPerStep: 2,
      batteryStepKm: 2,
      navRouteFeedback: 4,
      navQualitativeFeedback: 6,
      navDistancePerStep: 2,
      navDistanceStepKm: 3,
      surveyPoints: 77,
    };
    const unwire = wireRidePost({
      session,
      locate: fakeLocate(),
      mountRoot: root,
      points: () => points,
    });
    expect(root.textContent).toContain("+77 pts");
    unwire();
  });

  it("wireRidePost's own teardown unmounts a live Screen 9 mount", () => {
    const session = sessionAtSurvey();
    const unwire = wireRidePost({
      session,
      locate: fakeLocate(),
      mountRoot: root,
    });
    expect(root.children.length).toBeGreaterThan(0);
    unwire();
    expect(root.children.length).toBe(0);
  });

  it("recoveryNote reaches Screen 8's ride_expired copy when passed at wire time", () => {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    store.dispatch({ type: "open", options: baseOptions(), screen: "6" });
    store.dispatch({ type: "setDevice", device: DEVICE });
    store.dispatch({ type: "startCountdown" });
    store.dispatch({
      type: "rideStarted",
      rideId: RIDE_ID,
      startedAtMs: STARTED_AT_MS,
      trackKeyId: RIDE_ID,
      private: false,
    });
    store.dispatch({ type: "endRide" });

    const unwire = wireRidePost({
      session: store,
      locate: fakeLocate(),
      mountRoot: root,
      recoveryNote: "ride_expired",
    });
    expect(root.textContent).toMatch(/expired/i);
    unwire();
  });
});
