// @vitest-environment happy-dom
//
// Screen 8 — post-ride cost summary + Rush Quit / New Destination / "I ended
// my ride in Veo". Covers: the cost breakdown renders exactly what
// `estimateWithTax` returns (every rate plan, including equity's free-minutes
// credit) rather than re-deriving the math; Rush Quit sends the minimal
// `PATCH /end` and transitions straight to `done` with no further screens
// (plus its 409-is-success and GPS-required branches); New Destination sends
// NO `PATCH /end` and transitions to `wizard:3` with the same rideId; the
// Veo-ended form's validation (battery 0–100, reported_minutes prefill+edit,
// reported_plan conversion) and its transition to survey/eligibility/done
// via `nextAfterEnd`'s own gates.

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
  buildFullEndBody,
  buildMinimalEndBody,
  describeEndReportError,
  formatFrozenClock,
  frozenElapsedMs,
  isAlreadyReportedError,
  isValidBatteryPercent,
  isValidReportedMinutes,
  parseDollarsToCents,
  planDisplayLabel,
  prefillReportedMinutes,
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
  batteryConfirmed: 42,
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
): { unwire: () => void; endTrackedRide: ReturnType<typeof vi.fn> } {
  const defaultEndTrackedRide = vi.fn(
    (
      _rideId: string,
      _body: unknown,
      _signal?: AbortSignal,
    ): Promise<TrackedRide> => Promise.resolve(fakeTrackedRide()),
  );
  // Whichever function actually reaches `wireRideScreen8` below (the
  // override when the caller passes one, the local default otherwise) is
  // what tests must assert against — returning the unused default when an
  // override wins would silently observe the wrong mock.
  const endTrackedRide =
    (overrides.endTrackedRide as ReturnType<typeof vi.fn> | undefined) ??
    defaultEndTrackedRide;
  const container = document.createElement("div");
  document.body.append(container);
  const unwire = wireRideScreen8({
    session,
    locate: fakeLocate(FIX),
    endTrackedRide: defaultEndTrackedRide,
    openRideModal: vi.fn(),
    getGateFacts: async () => ({ hasWaypoints: false }) as RideGateFacts,
    now: () => STARTED_AT_MS + 125_000, // 2:05 elapsed
    taxRate: () => 0.08,
    ratePlan: () => "resident",
    mountRoot: container,
    ...overrides,
  });
  return { unwire, endTrackedRide };
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

describe("prefillReportedMinutes", () => {
  it("delegates to billableMinutes (per-started-minute ceil)", () => {
    expect(prefillReportedMinutes(125_000)).toBe(3);
    expect(prefillReportedMinutes(1_000)).toBe(1);
  });
  it("clamps to the field's 1440 ceiling", () => {
    expect(prefillReportedMinutes(2_000 * 60_000)).toBe(1440);
  });
});

describe("validation", () => {
  it.each([
    [0, true],
    [100, true],
    [42, true],
    [-1, false],
    [101, false],
    [50.5, false],
  ])("isValidBatteryPercent(%s) -> %s", (n, expected) => {
    expect(isValidBatteryPercent(n)).toBe(expected);
  });

  it.each([
    [1, true],
    [1440, true],
    [3, true],
    [0, false],
    [1441, false],
    [-5, false],
    [3.5, false],
  ])("isValidReportedMinutes(%s) -> %s", (n, expected) => {
    expect(isValidReportedMinutes(n)).toBe(expected);
  });

  it.each([
    ["4", 400],
    ["4.5", 450],
    ["4.50", 450],
    ["0", 0],
    ["0.00", 0],
    ["  4.25  ", 425],
  ])("parseDollarsToCents(%s) -> %d", (raw, expectedCents) => {
    expect(parseDollarsToCents(raw)).toBe(expectedCents);
  });

  it.each(["", "abc", "-4", "4.999", "4.5.5", "1e5"])(
    "parseDollarsToCents rejects %s",
    (raw) => {
      expect(parseDollarsToCents(raw)).toBeNull();
    },
  );
});

describe("planDisplayLabel", () => {
  it("trims the rate-detail suffix", () => {
    expect(planDisplayLabel("resident")).toBe("Resident");
    expect(planDisplayLabel("resident_plus")).toBe(
      "Resident w/ VeoPlus Pass",
    );
    expect(planDisplayLabel("equity")).toBe("Equity program");
  });
});

describe("request body builders", () => {
  it("buildMinimalEndBody: required fields only", () => {
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

  it("buildFullEndBody: minimal fields plus the rider-entered + §10 fields, plan converted", () => {
    const body = buildFullEndBody(Date.parse("2026-07-29T12:30:00Z"), FIX, {
      batteryPercent: 55,
      costCents: 725,
      reportedMinutes: 22,
      planKey: "resident_plus",
    });
    expect(body).toEqual({
      ended_at: "2026-07-29T12:30:00.000Z",
      end_lat: FIX.lat,
      end_lon: FIX.lng,
      reported_battery_percent: 55,
      total_cost_cents: 725,
      reported_minutes: 22,
      reported_plan: "resident", // _plus stripped — the API has no _plus variant
    });
  });

  it("buildFullEndBody converts equity straight through", () => {
    const body = buildFullEndBody(0, FIX, {
      batteryPercent: 10,
      costCents: 0,
      reportedMinutes: 5,
      planKey: "equity",
    });
    expect(body.reported_plan).toBe("equity");
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
    buttonWithText("Rush Quit").click();
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
});

// ---------------------------------------------------------------------------
// Rush Quit
// ---------------------------------------------------------------------------

describe("[Rush Quit]", () => {
  it("sends the minimal PATCH /end and transitions straight to done, no S9/S10", async () => {
    const session = sessionAtEnding();
    const { unwire, endTrackedRide } = wire(session);

    buttonWithText("Rush Quit").click();
    await flush();

    expect(endTrackedRide).toHaveBeenCalledTimes(1);
    const [rideId, body] = endTrackedRide.mock.calls[0];
    expect(rideId).toBe(RIDE_ID);
    expect(body).toEqual({
      ended_at: new Date(STARTED_AT_MS + 125_000).toISOString(),
      end_lat: FIX.lat,
      end_lon: FIX.lng,
    });

    const doc = session.current();
    expect(doc?.state).toBe("done");
    expect(doc?.screen).toBeNull();
    expect(queryRoot()).toBeNull();
    unwire();
  });

  it("without a GPS fix, shows an error and never calls endTrackedRide", async () => {
    const session = sessionAtEnding();
    const { unwire, endTrackedRide } = wire(session, { locate: fakeLocate(null) });

    buttonWithText("Rush Quit").click();
    await flush();

    expect(endTrackedRide).not.toHaveBeenCalled();
    expect(root().textContent).toMatch(/GPS fix/);
    expect(session.current()?.state).toBe("ending");
    unwire();
  });

  it("a 409 (already reported by another tab) is treated as success", async () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session, {
      endTrackedRide: vi.fn(() =>
        Promise.reject(new ApiError("already ended", "HTTP_ERROR", { status: 409 })),
      ),
    });

    buttonWithText("Rush Quit").click();
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

    buttonWithText("Rush Quit").click();
    await flush();

    expect(session.current()?.state).toBe("ending");
    expect(root().textContent).toMatch(/check your connection/);
    expect(queryRoot()).not.toBeNull();

    // Retry works once the transient failure clears.
    endTrackedRide.mockResolvedValueOnce(fakeTrackedRide());
    buttonWithText("Rush Quit").click();
    await flush();
    expect(session.current()?.state).toBe("done");
    unwire();
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
// "I ended my ride in Veo"
// ---------------------------------------------------------------------------

describe('["I ended my ride in Veo"]', () => {
  function openForm(): void {
    buttonWithText("I ended my ride in Veo").click();
  }

  function fillField(label: string, value: string): void {
    const input = [...root().querySelectorAll<HTMLInputElement>("input")].find(
      (i) => i.getAttribute("aria-label") === label,
    );
    if (!input) throw new Error(`field ${JSON.stringify(label)} not found`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("prefills reported minutes from the frozen clock via billableMinutes", () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session);
    openForm();
    const minutesInput = [...root().querySelectorAll<HTMLInputElement>("input")].find(
      (i) => i.getAttribute("aria-label") === "Ride time reported (minutes)",
    );
    expect(minutesInput?.value).toBe("3"); // 2:05 elapsed -> billableMinutes = 3
    unwire();
  });

  it("Submit stays disabled until battery, cost, and minutes are all valid", () => {
    const session = sessionAtEnding();
    const { unwire } = wire(session);
    openForm();
    // The form fully rebuilds on every keystroke (`render()` replaces the
    // card's children), so a cached button reference goes stale the moment
    // ANY field changes — re-query fresh after each edit.
    // Minutes is prefilled+valid already; battery/cost start empty.
    expect(buttonWithText("Submit").disabled).toBe(true);

    fillField("End battery %", "55");
    expect(buttonWithText("Submit").disabled).toBe(true); // cost still empty

    fillField("Actual cost", "4.25");
    expect(buttonWithText("Submit").disabled).toBe(false);

    fillField("End battery %", "150"); // out of 0-100 range
    expect(buttonWithText("Submit").disabled).toBe(true);

    fillField("End battery %", "55");
    expect(buttonWithText("Submit").disabled).toBe(false);

    fillField("Ride time reported (minutes)", "0"); // below the 1-minute floor
    expect(buttonWithText("Submit").disabled).toBe(true);

    fillField("Ride time reported (minutes)", "17");
    expect(buttonWithText("Submit").disabled).toBe(false);
    unwire();
  });

  it("rider-editable: changing the prefilled minutes changes what gets submitted", async () => {
    const session = sessionAtEnding();
    const { unwire, endTrackedRide } = wire(session);
    openForm();
    fillField("End battery %", "60");
    fillField("Actual cost", "3.50");
    fillField("Ride time reported (minutes)", "9");

    buttonWithText("Submit").click();
    await flush();

    const [, body] = endTrackedRide.mock.calls[0];
    expect(body).toMatchObject({
      reported_battery_percent: 60,
      total_cost_cents: 350,
      reported_minutes: 9,
    });
    unwire();
  });

  it("converts the current rate plan via toApiRatePlan (no _plus vocabulary reaches the wire)", async () => {
    const session = sessionAtEnding();
    const { unwire, endTrackedRide } = wire(session, { ratePlan: () => "visitor_plus" });
    openForm();
    fillField("End battery %", "40");
    fillField("Actual cost", "9.00");
    buttonWithText("Submit").click();
    await flush();

    const [, body] = endTrackedRide.mock.calls[0];
    expect(body).toMatchObject({ reported_plan: "visitor" });
    unwire();
  });

  it("on submit: calls endTrackedRide with all fields, then transitions to eligibility(10) when waypoints exist", async () => {
    const session = sessionAtEnding({ end_survey: false }); // scooter pane off, no route -> S9 skipped
    const { unwire, endTrackedRide } = wire(session, {
      getGateFacts: async () => ({ hasWaypoints: true }),
    });
    openForm();
    fillField("End battery %", "72");
    fillField("Actual cost", "5.00");
    buttonWithText("Submit").click();
    await flush();

    expect(endTrackedRide).toHaveBeenCalledTimes(1);
    const doc = session.current();
    expect(doc?.state).toBe("eligibility");
    expect(doc?.screen).toBe("10");
    unwire();
  });

  it("transitions straight to done when no survey pane gates on and no waypoints exist", async () => {
    const session = sessionAtEnding({ end_survey: false });
    const { unwire } = wire(session, {
      getGateFacts: async () => ({ hasWaypoints: false }),
    });
    openForm();
    fillField("End battery %", "72");
    fillField("Actual cost", "5.00");
    buttonWithText("Submit").click();
    await flush();

    expect(session.current()?.state).toBe("done");
    unwire();
  });

  it("transitions to survey(9) when the scooter-feedback pane gates on", async () => {
    const session = sessionAtEnding({ end_survey: true });
    const { unwire } = wire(session, {
      getGateFacts: async () => ({ hasWaypoints: false }),
    });
    openForm();
    fillField("End battery %", "72");
    fillField("Actual cost", "5.00");
    buttonWithText("Submit").click();
    await flush();

    const doc = session.current();
    expect(doc?.state).toBe("survey");
    expect(doc?.screen).toBe("9");
    unwire();
  });

  it("Back returns to the summary view without submitting anything", () => {
    const session = sessionAtEnding();
    const { unwire, endTrackedRide } = wire(session);
    openForm();
    fillField("End battery %", "10");
    buttonWithText("Back").click();
    expect(endTrackedRide).not.toHaveBeenCalled();
    expect(root().textContent).toContain("End your ride in the Veo app");
    unwire();
  });

  it("a 409 on submit is treated as already-reported and still advances the phase", async () => {
    const session = sessionAtEnding({ end_survey: false });
    const { unwire } = wire(session, {
      getGateFacts: async () => ({ hasWaypoints: false }),
      endTrackedRide: vi.fn(() =>
        Promise.reject(new ApiError("already ended", "HTTP_ERROR", { status: 409 })),
      ),
    });
    openForm();
    fillField("End battery %", "72");
    fillField("Actual cost", "5.00");
    buttonWithText("Submit").click();
    await flush();

    expect(session.current()?.state).toBe("done");
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
