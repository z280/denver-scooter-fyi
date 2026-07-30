// @vitest-environment happy-dom
//
// The resume-or-end prompt (`showResumeOrEnd`) — shared by reload recovery's
// `prompt_resume_or_end` outcome and Screen 6's `POST /tracked-rides` 409,
// both funneled through `ride-session.ts`'s `recoveryForServerConflict`.
// Covers: rendering; [Resume ride] adopting the server ride via the
// reducer's own `adoptServerRide` action and reattaching (or gracefully
// failing to reattach) a local recorder, plus a rejected adopt (already on a
// different live ride) surfacing an error without crashing; [End it]
// sending the ride's single `PATCH /end` (tolerating a 409 as success, same
// discipline as `ride-post-s8.ts`'s Rush Quit) then dispatching `abandon`,
// including the GPS-fix fallback (`locate.trigger()` + a bounded wait for
// `onFix`, with a graceful timeout).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type RideOptions, type TrackedRide } from "./api.ts";
import type { LngLat } from "./locate.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideRecoveryOutcome,
  type RideSessionSelectedDevice,
} from "./ride-session.ts";
import type { TrackRecorder, TrackStore } from "./track-store.ts";
import { showResumeOrEnd } from "./ride-resume-prompt.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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

const FIX: LngLat = { lng: -104.99, lat: 39.74, accuracy: 5 };

function fakeRide(overrides: Partial<TrackedRide> = {}): TrackedRide {
  return {
    id: "server-ride-1",
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

function outcomeFor(
  ride: TrackedRide | null,
  resume: RideRecoveryOutcome["resume"] = null,
): RideRecoveryOutcome {
  return {
    action: "prompt_resume_or_end",
    reason: "active_conflict",
    doc: null,
    resume,
    ride,
    reconciled: true,
    note: null,
  };
}

interface FakeLocate {
  current: () => LngLat | null;
  trigger: () => void;
  onFix: (cb: (pos: LngLat) => void) => () => void;
  emitFix(pos: LngLat): void;
  triggerCalls: number;
}
function fakeLocate(initial: LngLat | null): FakeLocate {
  let current = initial;
  const listeners = new Set<(pos: LngLat) => void>();
  const handle: FakeLocate = {
    current: () => current,
    trigger: () => {
      handle.triggerCalls += 1;
    },
    onFix: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emitFix(pos) {
      current = pos;
      for (const cb of [...listeners]) cb(pos);
    },
    triggerCalls: 0,
  };
  return handle;
}

function fakeTrackStore(
  recorder: TrackRecorder | null,
): TrackStore & { resumeRide: ReturnType<typeof vi.fn> } {
  const resumeRide = vi.fn(async () => ({
    recorder,
    continued: true,
    freshChain: false,
    keySource: "server" as const,
    recovered: true,
    tip: null,
  }));
  return { resumeRide } as unknown as TrackStore & {
    resumeRide: ReturnType<typeof vi.fn>;
  };
}

function root(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".ride-resume-prompt");
  if (!el) throw new Error("resume-or-end prompt root not found");
  return el;
}

function queryRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ride-resume-prompt");
}

function buttonWithText(text: string): HTMLButtonElement {
  const btn = [...root().querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`button ${JSON.stringify(text)} not found`);
  return btn;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A session with a pre-existing local doc mid-Screen-6 (`countdown`, no
 *  `rideId` yet) — the realistic shape for BOTH triggers of this prompt: a
 *  reload finding a MISMATCHED local doc, and Screen 6's own 409 (the wizard
 *  is open at the time). Distinct from the "no local doc at all" case
 *  (`createRideSessionStore` fresh, covered separately below), where
 *  `abandon` has nothing local to correct. */
function docSession() {
  const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
  session.dispatch({ type: "open", options: baseOptions(), screen: "6" });
  session.dispatch({ type: "setDevice", device: DEVICE });
  session.dispatch({ type: "startCountdown" });
  return session;
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("showResumeOrEnd — rendering", () => {
  it("renders the prompt with Resume ride and End it buttons", () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    const dispose = showResumeOrEnd(outcomeFor(fakeRide()), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => fakeTrackStore(null),
      onResumed: vi.fn(),
    });
    expect(root().textContent).toContain("already have a ride in progress");
    expect(() => buttonWithText("Resume ride")).not.toThrow();
    expect(() => buttonWithText("End it")).not.toThrow();
    dispose();
    expect(queryRoot()).toBeNull();
  });

  it("a null outcome.ride logs an error and never mounts", () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    showResumeOrEnd(outcomeFor(null), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => fakeTrackStore(null),
      onResumed: vi.fn(),
    });
    expect(queryRoot()).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// [Resume ride]
// ---------------------------------------------------------------------------

describe("[Resume ride]", () => {
  it("adopts the server ride, reattaches the local recorder, and calls onResumed", async () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    const ride = fakeRide({ started_at: "2026-07-29T18:30:00Z" });
    const fakeRecorder = { addFix: vi.fn(), finish: vi.fn() } as unknown as TrackRecorder;
    const store = fakeTrackStore(fakeRecorder);
    const onResumed = vi.fn();
    const resume = {
      trackId: ride.id,
      keySource: "server" as const,
      freshChain: true,
      signing: {
        alg: "HS256" as const,
        key_id: ride.id,
        key: "abc",
        nonce: "n",
        issued_at: "2026-07-29T18:30:00Z",
      },
      tip: null,
    };
    showResumeOrEnd(outcomeFor(ride, resume), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => store,
      onResumed,
    });

    buttonWithText("Resume ride").click();
    await flush();

    expect(store.resumeRide).toHaveBeenCalledWith(ride.id, { signing: resume.signing });
    expect(onResumed).toHaveBeenCalledTimes(1);
    const [passedRide, startedAtMs, recorder] = onResumed.mock.calls[0];
    expect(passedRide).toBe(ride);
    expect(startedAtMs).toBe(Date.parse("2026-07-29T18:30:00Z"));
    expect(recorder).toBe(fakeRecorder);

    const doc = session.current();
    expect(doc?.state).toBe("riding");
    expect(doc?.rideId).toBe(ride.id);
    expect(doc?.private).toBe(false);
    expect(queryRoot()).toBeNull();
  });

  it("adopts even with no resume plan at all — recorder passed through as null", async () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    const ride = fakeRide();
    const onResumed = vi.fn();
    const getTrackStore = vi.fn(async () => fakeTrackStore(null));
    showResumeOrEnd(outcomeFor(ride, null), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore,
      onResumed,
    });

    buttonWithText("Resume ride").click();
    await flush();

    // No resume plan -> track-store is never even opened.
    expect(getTrackStore).not.toHaveBeenCalled();
    expect(onResumed).toHaveBeenCalledWith(ride, expect.any(Number), null);
    expect(session.current()?.state).toBe("riding");
  });

  it("a rejected adopt (already on a different live ride in this tab) shows an error and stays open", async () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    session.dispatch({ type: "open", options: baseOptions(), screen: "6" });
    session.dispatch({ type: "setDevice", device: DEVICE });
    session.dispatch({ type: "startCountdown" });
    session.dispatch({
      type: "rideStarted",
      rideId: "already-riding",
      startedAtMs: Date.now(),
      trackKeyId: "already-riding",
      private: false,
    });
    expect(session.current()?.state).toBe("riding");

    const ride = fakeRide({ id: "other-ride" });
    const onResumed = vi.fn();
    showResumeOrEnd(outcomeFor(ride, null), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => fakeTrackStore(null),
      onResumed,
    });

    buttonWithText("Resume ride").click();
    await flush();

    expect(onResumed).not.toHaveBeenCalled();
    expect(root().textContent).toMatch(/already on a different ride/);
    expect(session.current()?.rideId).toBe("already-riding");
    expect(queryRoot()).not.toBeNull();
  });

  it("gracefully continues (recorder null) if reattaching the local recorder throws", async () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    const ride = fakeRide();
    const onResumed = vi.fn();
    const resume = {
      trackId: ride.id,
      keySource: "none" as const,
      freshChain: true,
      signing: null,
      tip: null,
    };
    const store = {
      resumeRide: vi.fn().mockRejectedValue(new Error("offline")),
    } as unknown as TrackStore;
    showResumeOrEnd(outcomeFor(ride, resume), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => store,
      onResumed,
    });

    buttonWithText("Resume ride").click();
    await flush();

    expect(onResumed).toHaveBeenCalledWith(ride, expect.any(Number), null);
    expect(session.current()?.state).toBe("riding");
  });
});

// ---------------------------------------------------------------------------
// [End it]
// ---------------------------------------------------------------------------

describe("[End it]", () => {
  it("with a live fix: sends the minimal PATCH /end, then dispatches abandon", async () => {
    const session = docSession();
    const ride = fakeRide();
    const endTrackedRide = vi.fn().mockResolvedValue(fakeRide());
    const nowMs = Date.parse("2026-07-30T12:00:00Z");
    showResumeOrEnd(outcomeFor(ride), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => fakeTrackStore(null),
      onResumed: vi.fn(),
      endTrackedRide,
      now: () => nowMs,
    });

    buttonWithText("End it").click();
    await flush();

    expect(endTrackedRide).toHaveBeenCalledTimes(1);
    const [rideId, body] = endTrackedRide.mock.calls[0];
    expect(rideId).toBe(ride.id);
    expect(body).toEqual({
      ended_at: new Date(nowMs).toISOString(),
      end_lat: FIX.lat,
      end_lon: FIX.lng,
    });

    expect(session.current()?.state).toBe("done");
    expect(queryRoot()).toBeNull();
  });

  it("a 409 (already reported) is treated as success", async () => {
    const session = docSession();
    const endTrackedRide = vi
      .fn()
      .mockRejectedValue(new ApiError("already ended", "HTTP_ERROR", { status: 409 }));
    showResumeOrEnd(outcomeFor(fakeRide()), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => fakeTrackStore(null),
      onResumed: vi.fn(),
      endTrackedRide,
    });

    buttonWithText("End it").click();
    await flush();

    expect(session.current()?.state).toBe("done");
  });

  it("a non-409 failure shows a retryable error and stays open", async () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    const endTrackedRide = vi.fn().mockRejectedValue(new Error("offline"));
    showResumeOrEnd(outcomeFor(fakeRide()), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => fakeTrackStore(null),
      onResumed: vi.fn(),
      endTrackedRide,
    });

    buttonWithText("End it").click();
    await flush();

    expect(root().textContent).toMatch(/Couldn't end that ride/);
    expect(session.current()?.state).not.toBe("done");
    expect(queryRoot()).not.toBeNull();
  });

  it("with no live fix: triggers Locate and waits for onFix before ending", async () => {
    const session = docSession();
    const locate = fakeLocate(null);
    const endTrackedRide = vi.fn().mockResolvedValue(fakeRide());
    showResumeOrEnd(outcomeFor(fakeRide()), {
      session,
      locate,
      getTrackStore: async () => fakeTrackStore(null),
      onResumed: vi.fn(),
      endTrackedRide,
    });

    buttonWithText("End it").click();
    await flush();
    expect(locate.triggerCalls).toBe(1);
    expect(endTrackedRide).not.toHaveBeenCalled();

    locate.emitFix(FIX);
    await flush();

    expect(endTrackedRide).toHaveBeenCalledTimes(1);
    expect(session.current()?.state).toBe("done");
  });

  it("with no fix ever arriving, times out and shows an error rather than hanging forever", async () => {
    vi.useFakeTimers();
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    const locate = fakeLocate(null);
    const endTrackedRide = vi.fn();
    showResumeOrEnd(outcomeFor(fakeRide()), {
      session,
      locate,
      getTrackStore: async () => fakeTrackStore(null),
      onResumed: vi.fn(),
      endTrackedRide,
    });

    buttonWithText("End it").click();
    await vi.advanceTimersByTimeAsync(8_000);

    expect(endTrackedRide).not.toHaveBeenCalled();
    expect(root().textContent).toMatch(/GPS fix/);
  });

  // The "missing local doc" trigger (reload, `probeWhenNoDoc`): there is
  // nothing local to correct (a null doc already isn't a live ride as far as
  // `isRideLive` is concerned), but the server ride must still get ended.
  it("with no local doc at all, still ends the server ride and closes — nothing local to correct", async () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    expect(session.current()).toBeNull();
    const ride = fakeRide();
    const endTrackedRide = vi.fn().mockResolvedValue(fakeRide());
    showResumeOrEnd(outcomeFor(ride), {
      session,
      locate: fakeLocate(FIX),
      getTrackStore: async () => fakeTrackStore(null),
      onResumed: vi.fn(),
      endTrackedRide,
    });

    buttonWithText("End it").click();
    await flush();

    expect(endTrackedRide).toHaveBeenCalledWith(
      ride.id,
      expect.objectContaining({ end_lat: FIX.lat, end_lon: FIX.lng }),
    );
    expect(queryRoot()).toBeNull();
  });
});
