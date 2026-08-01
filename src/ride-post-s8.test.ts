// @vitest-environment happy-dom
//
// Screen 8 — post-ride cost summary + New Destination / "I ended my ride in
// Veo". Covers: the cost breakdown renders exactly what `estimateWithTax`
// returns (every rate plan, including equity's free-minutes credit) rather
// than re-deriving the math; "I ended my ride in Veo" sends the minimal
// `PATCH /end` (no rider-entered battery/cost/minutes — see ride-post-s8.ts's
// FRICTION-REDUCTION REWRITE note) and ALWAYS checks gate facts afterward,
// transitioning to survey/eligibility/done via the same gates `nextAfterEnd`
// always used (plus its 409-is-success and GPS-required branches); New
// Destination sends NO `PATCH /end` and transitions to `wizard:3` with the
// same rideId.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type RideOptions, type TrackedRide } from "./api.ts";
import { RATE_PLANS } from "./config.ts";
import { estimateWithTax, planFor } from "./ride-cost.ts";
import type { LngLat } from "./locate.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideGateFacts,
  type RideSessionSelectedDevice,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  buildMinimalEndBody,
  describeEndReportError,
  formatFrozenClock,
  frozenElapsedMs,
  isAlreadyReportedError,
  screen8CostBreakdown,
  wireRideScreen8,
  type LocateLike,
  type RideScreen8Deps,
} from "./ride-post-s8.ts";

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
  batteryConfirmed: null,
};

const FIX: LngLat = { lng: -104.99, lat: 39.74, accuracy: 5 };

const STARTED_AT_MS = Date.parse("2026-07-29T12:00:00Z");
const RIDE_ID = "ride-1";

/** A session doc landed on `ending(8)` with a real (non-private) tracked
 *  ride — the reducer's ONLY door into that phase (`endRide` from `riding`,
 *  with no `legacyEndRide` — the F4 default). */
function sessionAtEnding(
  options: Partial<RideOptions> = {},
  rideId: string = RIDE_ID,
): RideSessionStore {
  const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
  store.dispatch({ type: "open", options: baseOptions(options), screen: "6" });
  store.dispatch({ type: "setDevice", device: DEVICE });
  store.dispatch({ type: "startCountdown" });
  store.dispatch({
    type: "rideStarted",
    rideId,
    startedAtMs: STARTED_AT_MS,
    trackKeyId: rideId,
    private: false,
  });
  const t = store.dispatch({ type: "endRide" });
  if (!t?.accepted || t.to !== "ending(8)") {
    throw new Error(`fixture failed to reach ending(8): landed on ${t?.to}`);
  }
  return store;
}

interface FakeLocate extends LocateLike {
  emitFix(pos: LngLat | null): void;
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
      if (pos) for (const cb of [...listeners]) cb(pos);
    },
  };
}

function fakeTrackedRide(overrides: Partial<TrackedRide> = {}): TrackedRide {
  return {
    id: RIDE_ID,
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
  overrides: Partial<Omit<RideScreen8Deps, "session">> = {},
): {
  unwire: () => void;
  endTrackedRide: ReturnType<typeof vi.fn>;
  getGateFacts: ReturnType<typeof vi.fn>;
} {
  const defaultEndTrackedRide = vi.fn(
    (
      _rideId: string,
      _body: unknown,
      _signal?: AbortSignal,
    ): Promise<TrackedRide> => Promise.resolve(fakeTrackedRide()),
  );
  const defaultGetGateFacts = vi.fn(
    async (): Promise<RideGateFacts> => ({ hasWaypoints: false }),
  );
  // Whichever function actually reaches `wireRideScreen8` below (the
  // override when the caller passes one, the local default otherwise) is
  // what tests must assert against — returning the unused default when an
  // override wins would silently observe the wrong mock.
  const endTrackedRide =
    (overrides.endTrackedRide as ReturnType<typeof vi.fn> | undefined) ??
    defaultEndTrackedRide;
  const getGateFacts =
    (overrides.getGateFacts as ReturnType<typeof vi.fn> | undefined) ??
    defaultGetGateFacts;
  const container = document.createElement("div");
  document.body.append(container);
  const unwire = wireRideScreen8({
    session,
    locate: fakeLocate(FIX),
    endTrackedRide: defaultEndTrackedRide,
    openRideModal: vi.fn(),
    getGateFacts: defaultGetGateFacts,
    now: () => STARTED_AT_MS + 125_000, // 2:05 elapsed
    taxRate: () => 0.08,
    ratePlan: () => "resident",
    mountRoot: container,
    ...overrides,
  });
  return { unwire, endTrackedRide, getGateFacts };
}

function root(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".ride-post-s8");
  if (!found) throw new Error("Screen 8 root not found — is it mounted?");
  return found;
}

function queryRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ride-post-s8");
}

function buttonWithText(text: string): HTMLButtonElement {
  const btn = [...root().querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`button ${JSON.stringify(text)} not found`);
  return btn;
}

function costRowText(label: string): string {
  const dt = [...root().querySelectorAll("dt")].find(
    (n) => n.textContent === label,
  );
  const dd = dt?.nextElementSibling;
  if (!dd) throw new Error(`cost row ${JSON.stringify(label)} not found`);
  return dd.textContent ?? "";
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A promise plus externally-callable settlers, for pinning an async call
 *  mid-flight so a test can tear down the screen before it resolves. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("frozenElapsedMs", () => {
  it("floors at 0 and never goes negative", () => {
    expect(frozenElapsedMs(1_000, 500)).toBe(0);
  });
  it("null startedAtMs reads as just-started", () => {
    expect(frozenElapsedMs(null, 999_999)).toBe(0);
  });
  it("the ordinary case", () => {
    expect(frozenElapsedMs(1_000, 126_000)).toBe(125_000);
  });
});

describe("formatFrozenClock", () => {
  it.each([
    [0, "0:00"],
    [59_000, "0:59"],
    [60_000, "1:00"],
    [125_000, "2:05"],
    [3_661_000, "61:01"],
  ])("%i ms -> %s", (ms, expected) => {
    expect(formatFrozenClock(ms)).toBe(expected);
  });
});

describe("screen8CostBreakdown — reuses estimateWithTax, never re-derives it", () => {
  it.each(RATE_PLANS.map((p) => p.key))("matches estimateWithTax for plan %s", (key) => {
    const elapsedMs = 125_000; // 2:05 -> 3 billable minutes
    const expected = estimateWithTax(planFor(key), elapsedMs, 0.08);
    expect(screen8CostBreakdown(elapsedMs, key, 0.08)).toEqual(expected);
  });

  it("equity plan's free-minutes credit: under 60 min is $0 unlock+perMin+tax", () => {
    const elapsedMs = 45 * 60_000; // 45 minutes, all inside the free window
    const b = screen8CostBreakdown(elapsedMs, "equity", 0.08);
    expect(b).toEqual({ unlock: 0, perMin: 0, tax: 0, total: 0 });
  });

  it("equity plan past the free window only prices the overflow", () => {
    const elapsedMs = 65 * 60_000; // 5 minutes over the 60 free
    const b = screen8CostBreakdown(elapsedMs, "equity", 0.08);
    expect(b.unlock).toBe(0);
    expect(b.perMin).toBe(5 * 15); // 15c/min
    expect(b.total).toBe(b.unlock + b.perMin + b.tax);
  });

  it("null plan key falls back to resident", () => {
    expect(screen8CostBreakdown(60_000, null, 0.08)).toEqual(
      estimateWithTax(planFor("resident"), 60_000, 0.08),
    );
  });
});

describe("buildMinimalEndBody: required fields only", () => {
  it("carries no rider-entered battery/cost/minutes fields", () => {
    const body = buildMinimalEndBody(Date.parse("2026-07-29T12:30:00Z"), FIX);
    expect(body).toEqual({
      ended_at: "2026-07-29T12:30:00.000Z",
      end_lat: FIX.lat,
      end_lon: FIX.lng,
    });
    expect(body.reported_battery_percent).toBeUndefined();
    expect(body.total_cost_cents).toBeUndefined();
    expect(body.reported_minutes).toBeUndefined();
    expect(body.reported_plan).toBeUndefined();
  });
});

describe("isAlreadyReportedError / describeEndReportError", () => {
  it("only a 409 ApiError counts as already-reported", () => {
    expect(isAlreadyReportedError(new ApiError("x", "HTTP_ERROR", { status: 409 }))).toBe(true);
    expect(isAlreadyReportedError(new ApiError("x", "HTTP_ERROR", { status: 500 }))).toBe(false);
    expect(isAlreadyReportedError(new Error("network down"))).toBe(false);
  });

  it("describes a 404 distinctly from a generic failure", () => {
    expect(describeEndReportError(new ApiError("x", "HTTP_ERROR", { status: 404 }))).toMatch(
      /no longer on the server/,
    );
    expect(describeEndReportError(new Error("boom"))).toMatch(/check your connection/);
  });
});

// ---------------------------------------------------------------------------
// wireRideScreen8 — mount/unmount lifecycle
// ---------------------------------------------------------------------------

describe("wireRideScreen8 — mount/unmount off phaseOf(doc)", () => {
  it("mounts immediately when the doc is already in ending(8) at wire time (reload recovery)", () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session);
    expect(queryRoot()).not.toBeNull();
    unwire();
  });

  it("does not mount for any other phase", () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    session.dispatch({ type: "open", options: baseOptions(), screen: "1" });
    const { unwire } = wire(session);
    expect(queryRoot()).toBeNull();
    unwire();
  });

  it("mounts on a live transition into ending(8)", () => {
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    session.dispatch({ type: "open", options: baseOptions(), screen: "6" });
    session.dispatch({ type: "setDevice", device: DEVICE });
    session.dispatch({ type: "startCountdown" });
    session.dispatch({
      type: "rideStarted",
      rideId: RIDE_ID,
      startedAtMs: STARTED_AT_MS,
      trackKeyId: RIDE_ID,
      private: false,
    });
    const { unwire } = wire(session);
    expect(queryRoot()).toBeNull();
    session.dispatch({ type: "endRide" });
    expect(queryRoot()).not.toBeNull();
    unwire();
  });

  it("unmounts once the phase leaves ending(8)", async () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session);
    expect(queryRoot()).not.toBeNull();
    buttonWithText("I ended my ride in Veo").click();
    await flush();
    expect(session.current()?.state).toBe("done");
    expect(queryRoot()).toBeNull();
    unwire();
  });

  it("wireRideScreen8's own teardown removes a live mount", () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session);
    expect(queryRoot()).not.toBeNull();
    unwire();
    expect(queryRoot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cost breakdown rendering
// ---------------------------------------------------------------------------

describe("Screen 8 renders the frozen clock + cost breakdown", () => {
  it("renders Ride time (stop) and the four cost rows for each plan", () => {
    for (const plan of RATE_PLANS) {
      document.body.replaceChildren();
      const session = sessionAtEnding();
      const { unwire } = wire(session, { ratePlan: () => plan.key });
      const expected = estimateWithTax(planFor(plan.key), 125_000, 0.08);

      expect(root().textContent).toContain("Ride time: 2:05 (stop)");
      expect(costRowText("Unlock")).toBe(`$${(expected.unlock / 100).toFixed(2)}`);
      expect(costRowText("Per Min")).toBe(`$${(expected.perMin / 100).toFixed(2)}`);
      expect(costRowText("Tax")).toBe(`$${(expected.tax / 100).toFixed(2)}`);
      expect(costRowText("Total")).toBe(`$${(expected.total / 100).toFixed(2)}`);
      expect(root().textContent).toContain("The Veo app is your bill");
      unwire();
    }
  });

  it("never asks for a plate, battery %, or actual cost — the friction-reduction rewrite dropped rider data entry", () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session);
    expect(root().querySelectorAll("input").length).toBe(0);
    expect(root().textContent).not.toMatch(/battery/i);
    expect(root().textContent).not.toMatch(/Actual cost/);
    unwire();
  });
});

// ---------------------------------------------------------------------------
// Review fix regression: the clock/cost breakdown used to freeze the instant
// this modal mounted. The frontend plan is explicit that the clock keeps
// running while the rider finishes in Veo, and `(stop)` is a real control.
// ---------------------------------------------------------------------------

describe("Screen 8's clock stays live until (stop) is pressed", () => {
  it("keeps ticking (time + cost) until Stop, then freezes both", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT_MS + 125_000); // mount at 2:05 elapsed
    const session = sessionAtEnding();
    const { unwire } = wire(session, {
      now: () => Date.now(),
      taxRate: () => 0.08,
      ratePlan: () => "resident",
    });

    expect(root().textContent).toContain("Ride time: 2:05");
    expect(costRowText("Total")).toBe(
      `$${(estimateWithTax(planFor("resident"), 125_000, 0.08).total / 100).toFixed(2)}`,
    );

    // Two more minutes pass while the modal just sits there — both the clock
    // and the cost breakdown must keep moving.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(root().textContent).toContain("Ride time: 4:05");
    expect(costRowText("Total")).toBe(
      `$${(estimateWithTax(planFor("resident"), 245_000, 0.08).total / 100).toFixed(2)}`,
    );

    buttonWithText("(stop)").click();
    expect(root().textContent).toContain("Ride time: 4:05");
    expect(root().textContent).toContain("(stopped)");
    expect(() => buttonWithText("(stop)")).toThrow();
    const frozenTime = "4:05";
    const frozenTotal = costRowText("Total");

    // Time keeps moving in the world; the frozen display must not.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(root().textContent).toContain(`Ride time: ${frozenTime}`);
    expect(costRowText("Total")).toBe(frozenTotal);

    unwire();
  });

  it("tapping \"I ended my ride in Veo\" implicitly stops the clock if the rider never pressed Stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT_MS + 125_000);
    const session = sessionAtEnding();
    const { unwire } = wire(session, { now: () => Date.now() });

    await vi.advanceTimersByTimeAsync(60_000); // 3:05 elapsed by the time they tap
    buttonWithText("I ended my ride in Veo").click();
    expect(root().textContent).toContain("Working…");

    unwire();
  });
});

// ---------------------------------------------------------------------------
// "I ended my ride in Veo" — the single end-of-ride action
// ---------------------------------------------------------------------------

describe('["I ended my ride in Veo"]', () => {
  it("sends the minimal PATCH /end and checks gate facts, transitioning to done when there's nothing to survey/donate", async () => {
    const session = sessionAtEnding();
    const { unwire, endTrackedRide, getGateFacts } = wire(session);

    buttonWithText("I ended my ride in Veo").click();
    await flush();

    expect(endTrackedRide).toHaveBeenCalledTimes(1);
    const [rideId, body] = endTrackedRide.mock.calls[0];
    expect(rideId).toBe(RIDE_ID);
    expect(body).toEqual({
      ended_at: new Date(STARTED_AT_MS + 125_000).toISOString(),
      end_lat: FIX.lat,
      end_lon: FIX.lng,
    });
    expect(getGateFacts).toHaveBeenCalledWith(RIDE_ID);

    const doc = session.current();
    expect(doc?.state).toBe("done");
    expect(doc?.screen).toBeNull();
    expect(queryRoot()).toBeNull();
    unwire();
  });

  it("transitions to eligibility(10) when the gate facts report waypoints", async () => {
    const session = sessionAtEnding(); // end_survey off, no route -> S9 skipped
    const { unwire } = wire(session, {
      getGateFacts: vi.fn(async () => ({ hasWaypoints: true })),
    });

    buttonWithText("I ended my ride in Veo").click();
    await flush();

    const doc = session.current();
    expect(doc?.state).toBe("eligibility");
    expect(doc?.screen).toBe("10");
    unwire();
  });

  it("transitions to survey(9) when the scooter-feedback pane gates on", async () => {
    const session = sessionAtEnding({ end_survey: true });
    const { unwire } = wire(session, {
      getGateFacts: vi.fn(async () => ({ hasWaypoints: false })),
    });

    buttonWithText("I ended my ride in Veo").click();
    await flush();

    const doc = session.current();
    expect(doc?.state).toBe("survey");
    expect(doc?.screen).toBe("9");
    unwire();
  });

  it("without a GPS fix, shows an error and never calls endTrackedRide", async () => {
    const session = sessionAtEnding();
    const { unwire, endTrackedRide } = wire(session, { locate: fakeLocate(null) });

    buttonWithText("I ended my ride in Veo").click();
    await flush();

    expect(endTrackedRide).not.toHaveBeenCalled();
    expect(root().textContent).toMatch(/GPS fix/);
    expect(session.current()?.state).toBe("ending");
    unwire();
  });

  // Review fix regression: `Locate.current()` expires after 5 minutes and may
  // never have been started at all on the GPS-permission-skip path, whereas
  // the ride's own last fix (surfaced via `getLastFix`, backed by
  // `RideHud.getLastFix()` in production) is known good for as long as the
  // ride was tracked. It must win over a stale/null `locate.current()`, and
  // never trigger a new watcher (`locate.trigger` isn't even part of this
  // module's `LocateLike` contract).
  it("prefers getLastFix() over a null locate.current(), with no new watcher", async () => {
    const session = sessionAtEnding();
    const hudFix: LngLat = { lng: -104.5, lat: 39.5, accuracy: 8 };
    const getLastFix = vi.fn(() => hudFix);
    const { unwire, endTrackedRide } = wire(session, {
      locate: fakeLocate(null),
      getLastFix,
    });

    buttonWithText("I ended my ride in Veo").click();
    await flush();

    expect(getLastFix).toHaveBeenCalled();
    expect(endTrackedRide).toHaveBeenCalledTimes(1);
    const [, body] = endTrackedRide.mock.calls[0];
    expect(body).toMatchObject({ end_lat: hudFix.lat, end_lon: hudFix.lng });
    expect(session.current()?.state).toBe("done");
    unwire();
  });

  it("a 409 (already reported by another tab) is treated as success", async () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session, {
      endTrackedRide: vi.fn(() =>
        Promise.reject(new ApiError("already ended", "HTTP_ERROR", { status: 409 })),
      ),
    });

    buttonWithText("I ended my ride in Veo").click();
    await flush();

    expect(session.current()?.state).toBe("done");
    unwire();
  });

  it("a genuine failure keeps the rider on Screen 8 with an error, ready to retry", async () => {
    const session = sessionAtEnding();
    const { unwire, endTrackedRide } = wire(session, {
      endTrackedRide: vi.fn(() =>
        Promise.reject(new ApiError("boom", "HTTP_ERROR", { status: 500 })),
      ),
    });

    buttonWithText("I ended my ride in Veo").click();
    await flush();

    expect(session.current()?.state).toBe("ending");
    expect(root().textContent).toMatch(/check your connection/);
    expect(queryRoot()).not.toBeNull();

    // Retry works once the transient failure clears.
    endTrackedRide.mockResolvedValueOnce(fakeTrackedRide());
    buttonWithText("I ended my ride in Veo").click();
    await flush();
    expect(session.current()?.state).toBe("done");
    unwire();
  });

  // Adversarial-review fix: onEndRide's three `if (destroyed) return;` guards
  // (ride-post-s8.ts:563, 574, 576) had no test tearing the screen down
  // mid-request, so a broken/inverted guard would ship silently — the code
  // would go on to render() a detached node and/or dispatch `endReported`
  // into a session that has since moved elsewhere. One test per guard.
  it("tearing down while the PATCH /end is in flight (success arrives after) never calls getGateFacts or dispatches endReported", async () => {
    const session = sessionAtEnding();
    const end = deferred<TrackedRide>();
    const { unwire, endTrackedRide, getGateFacts } = wire(session, {
      endTrackedRide: vi.fn(() => end.promise),
    });

    buttonWithText("I ended my ride in Veo").click();
    expect(endTrackedRide).toHaveBeenCalledTimes(1);

    // ride-post-s8.ts:574 — the guard right after the try/catch, before
    // getGateFacts is ever called.
    unwire();
    expect(queryRoot()).toBeNull();

    end.resolve(fakeTrackedRide());
    await flush();

    expect(getGateFacts).not.toHaveBeenCalled();
    expect(session.current()?.state).toBe("ending");
    expect(queryRoot()).toBeNull();
  });

  it("tearing down while the PATCH /end is in flight (failure arrives after) swallows the error instead of setting state on a removed screen", async () => {
    const session = sessionAtEnding();
    const end = deferred<TrackedRide>();
    const { unwire } = wire(session, {
      endTrackedRide: vi.fn(() => end.promise),
    });

    buttonWithText("I ended my ride in Veo").click();

    // ride-post-s8.ts:563 — the guard inside the catch block, before the
    // already-reported check even runs.
    unwire();
    expect(queryRoot()).toBeNull();

    end.reject(new Error("aborted"));
    await flush();

    expect(session.current()?.state).toBe("ending");
    expect(queryRoot()).toBeNull();
  });

  it("tearing down while getGateFacts is in flight never dispatches endReported into a session that's moved on", async () => {
    const session = sessionAtEnding();
    const gate = deferred<RideGateFacts>();
    const { unwire } = wire(session, {
      getGateFacts: vi.fn(() => gate.promise),
    });

    buttonWithText("I ended my ride in Veo").click();
    await flush(); // let the (immediately-resolving) PATCH /end settle first

    // ride-post-s8.ts:576 — the guard right after getGateFacts resolves,
    // before the endReported dispatch.
    unwire();
    expect(queryRoot()).toBeNull();

    gate.resolve({ hasWaypoints: true });
    await flush();

    expect(session.current()?.state).toBe("ending");
  });
});

// ---------------------------------------------------------------------------
// New Destination
// ---------------------------------------------------------------------------

describe("[New Destination]", () => {
  it("sends NO PATCH /end and loops to wizard:3 with the same rideId + chain", async () => {
    const session = sessionAtEnding();
    const openRideModal = vi.fn();
    const { unwire, endTrackedRide } = wire(session, { openRideModal });

    buttonWithText("New Destination").click();
    await flush();

    expect(endTrackedRide).not.toHaveBeenCalled();
    const doc = session.current();
    expect(doc?.state).toBe("wizard");
    expect(doc?.screen).toBe("3");
    expect(doc?.rideId).toBe(RIDE_ID);
    expect(doc?.trackKeyId).toBe(RIDE_ID);
    expect(openRideModal).toHaveBeenCalledWith({ fastForwardTo: "3" });
    expect(queryRoot()).toBeNull();
    unwire();
  });

  it("clears the old dest/route (a new choice, not a resumed one)", () => {
    const session = sessionAtEnding();
    session.patch({
      dest: { label: "Union Station", lat: 39.75, lon: -105.0 },
    });
    const { unwire } = wire(session);
    buttonWithText("New Destination").click();
    expect(session.current()?.dest).toBeNull();
    unwire();
  });
});

// ---------------------------------------------------------------------------
// Recovery note
// ---------------------------------------------------------------------------

describe("recoveryNote", () => {
  it('surfaces "ride_expired" when the mount is a reload landing straight on ending(8)', () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session, { recoveryNote: "ride_expired" });
    expect(root().textContent).toMatch(/expired/);
    unwire();
  });

  it("shows nothing extra when there is no recovery note", () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session);
    expect(root().textContent).not.toMatch(/expired/);
    unwire();
  });
});
