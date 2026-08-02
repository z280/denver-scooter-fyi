// @vitest-environment happy-dom
//
// Screen 10 — contribution eligibility copy, donation upload, points display,
// "See recent trips". Covers: the eligibility copy-table function against
// every reason (7) x the enumerated statuses, including the chain_invalid
// clause and the pending vs pending_feed distinction; the donation flow
// (batches read from track-store, posted, points + verification displayed);
// a declined-donation path leaves zero `donateTrack` calls; already-donated
// and chain_invalid error handling; "See recent trips"; and Return to Main
// App dispatching `eligibilityDone` + unmounting.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  type DonateTrackResponse,
  type RideOptions,
  type RideValidation,
  type TrackedRide,
  type TrackSigning,
} from "./api.ts";
import { base64UrlEncode, openTrackStore } from "./track-store.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideSessionRoute,
  type RideSessionSelectedDevice,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  buildEligibilityCopy,
  describeDonateError,
  describeRecentTripsError,
  DONATION_DISCLOSURE_TEXT,
  estimateDonationPoints,
  formatKm,
  isAlreadyDonatedError,
  joinReasonClauses,
  listTrackedRides,
  pointsActionLabel,
  reasonClause,
  shouldShowRidePostS10,
  tripDateLabel,
  tripStatusLabel,
  wireRidePostS10,
  type RidePostS10Deps,
} from "./ride-post-s10.ts";
import {
  FALLBACK_RIDE_MODE_POINTS,
  type ResolvedRideModePoints,
} from "./ride-settings.ts";

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

const STARTED_AT_MS = Date.parse("2026-07-29T12:00:00Z");
const RIDE_ID = "ride-1";

/** A session doc landed on `eligibility(10)` via the real reducer, mirroring
 *  `ride-post-s8.test.ts`'s `sessionAtEnding` one step further: `endReported`
 *  with `hasWaypoints: true` and no survey pane gated on lands directly on
 *  Screen 10. */
function sessionAtEligibility(
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
  store.dispatch({ type: "endRide" });
  const t = store.dispatch({
    type: "endReported",
    facts: { hasWaypoints: true },
  });
  if (!t?.accepted || t.to !== "eligibility(10)") {
    throw new Error(`fixture failed to reach eligibility(10): landed on ${t?.to}`);
  }
  return store;
}

const ROUTE: RideSessionRoute = {
  profile: "safe",
  rideRouteId: "route-1",
  distanceM: 4300,
  durationS: 900,
  polyline: "abc",
  maneuvers: [],
};

/** Same shape as `sessionAtEligibility`, but with a Screen 4 route chosen
 *  before the ride starts — `setRoute` only accepts `wizard`/`riding`, so it
 *  must land between `open` and `startCountdown`. Needed for the nav-distance
 *  points-tease bucket, which is gated on `doc.route !== null` in addition to
 *  `options.nav_improvement`. */
function sessionAtEligibilityWithRoute(
  options: Partial<RideOptions> = {},
  rideId: string = RIDE_ID,
): RideSessionStore {
  const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
  store.dispatch({ type: "open", options: baseOptions(options), screen: "6" });
  store.dispatch({ type: "setDevice", device: DEVICE });
  store.dispatch({ type: "setRoute", route: ROUTE });
  store.dispatch({ type: "startCountdown" });
  store.dispatch({
    type: "rideStarted",
    rideId,
    startedAtMs: STARTED_AT_MS,
    trackKeyId: rideId,
    private: false,
  });
  store.dispatch({ type: "endRide" });
  // A chosen route always gates Screen 9's navigation pane open
  // (`surveyPanes`'s `navigation: tracked && doc.route !== null` — it doesn't
  // check `nav_improvement`), so `endReported` lands on survey(9) first here;
  // clear it with `surveyDone` to reach eligibility(10), same as a real rider
  // finishing Screen 9.
  const afterEnd = store.dispatch({
    type: "endReported",
    facts: { hasWaypoints: true },
  });
  const t =
    afterEnd?.accepted && afterEnd.to === "survey(9)"
      ? store.dispatch({ type: "surveyDone", facts: { hasWaypoints: true } })
      : afterEnd;
  if (!t?.accepted || t.to !== "eligibility(10)") {
    throw new Error(`fixture failed to reach eligibility(10): landed on ${t?.to}`);
  }
  return store;
}

function fakeTrackedRide(overrides: Partial<TrackedRide> = {}): TrackedRide {
  return {
    id: RIDE_ID,
    status: "watching",
    started_at: "2026-07-29T12:00:00Z",
    start_lat: 39.74,
    start_lon: -104.99,
    watch_expires_at: null,
    gbfs_left_feed_at: null,
    gbfs_reappeared_at: null,
    gbfs_end_lat: null,
    gbfs_end_lon: null,
    gbfs_end_battery_percent: null,
    user_reported_ended_at: "2026-07-29T12:30:00Z",
    end_lat: 39.75,
    end_lon: -104.98,
    reported_battery_percent: 55,
    total_cost_cents: 415,
    metadata: {},
    vehicle_identifier: DEVICE.vehicleIdentifier,
    created_at: "2026-07-29T12:00:00Z",
    updated_at: "2026-07-29T12:30:00Z",
    distance_meters: 4312.5,
    distance_source: "waypoints",
    ...overrides,
  };
}

function fakeDonateResponse(
  overrides: Partial<DonateTrackResponse> = {},
): DonateTrackResponse {
  return {
    donation_id: "donation-1",
    verification: {
      chain: "ok",
      monotonic: "ok",
      speed: "ok",
      gbfs_start: "ok",
      gbfs_end: "ok",
      volume: "ok",
    },
    validation: { status: "eligible", reasons: [] },
    distance_meters: 4312.5,
    waypoint_count: 512,
    points: [{ action: "battery_contribution", points: 14 }],
    ...overrides,
  };
}

function wire(
  session: RideSessionStore,
  overrides: Partial<Omit<RidePostS10Deps, "session">> = {},
): {
  unwire: () => void;
  getTrackedRide: ReturnType<typeof vi.fn>;
  donateTrack: ReturnType<typeof vi.fn>;
  readDonationBody: ReturnType<typeof vi.fn>;
  listTrackedRides: ReturnType<typeof vi.fn>;
} {
  const defaultGetTrackedRide = vi.fn(
    (_rideId: string, _signal?: AbortSignal): Promise<TrackedRide> =>
      Promise.resolve(fakeTrackedRide()),
  );
  const defaultDonateTrack = vi.fn(
    (
      _rideId: string,
      _body: unknown,
      _signal?: AbortSignal,
    ): Promise<DonateTrackResponse> => Promise.resolve(fakeDonateResponse()),
  );
  const defaultReadDonationBody = vi.fn((_trackId: string) =>
    Promise.resolve({ batches: ["jws-0", "jws-1"], chain_root_hash: "abc123" }),
  );
  const defaultListTrackedRides = vi.fn((_opts: unknown, _signal?: AbortSignal) =>
    Promise.resolve({ count: 0, rides: [] }),
  );

  const getTrackedRide =
    (overrides.getTrackedRide as ReturnType<typeof vi.fn> | undefined) ??
    defaultGetTrackedRide;
  const donateTrack =
    (overrides.donateTrack as ReturnType<typeof vi.fn> | undefined) ??
    defaultDonateTrack;
  const readDonationBody =
    (overrides.readDonationBody as ReturnType<typeof vi.fn> | undefined) ??
    defaultReadDonationBody;
  const listTrackedRidesFn =
    (overrides.listTrackedRides as ReturnType<typeof vi.fn> | undefined) ??
    defaultListTrackedRides;

  const container = document.createElement("div");
  document.body.append(container);
  const unwire = wireRidePostS10({
    session,
    getTrackedRide: defaultGetTrackedRide,
    donateTrack: defaultDonateTrack,
    readDonationBody: defaultReadDonationBody,
    listTrackedRides: defaultListTrackedRides,
    mountRoot: container,
    ...overrides,
  });
  return {
    unwire,
    getTrackedRide,
    donateTrack,
    readDonationBody,
    listTrackedRides: listTrackedRidesFn,
  };
}

function root(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".ride-post-s10");
  if (!found) throw new Error("Screen 10 root not found — is it mounted?");
  return found;
}

function queryRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ride-post-s10");
}

function buttonWithText(text: string): HTMLButtonElement {
  const btn = [...root().querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`button ${JSON.stringify(text)} not found`);
  return btn;
}

function sentenceText(): string {
  const p = root().querySelector<HTMLElement>(".ride-post-s10__sentence");
  if (!p) throw new Error("eligibility sentence not found");
  return p.textContent ?? "";
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A promise plus externally-callable settlers, for racing two async calls
 *  against each other deterministically. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Adversarial-review fix: this file had no DOM cleanup between tests, unlike
// its siblings (ride-post-s8.test.ts, ride-screen-select.ts). Every test here
// mounts into a detached container it appends to `document.body` (see
// `wire()` above) and is expected to call its own `unwire()` before finishing
// — but a test whose assertion throws BEFORE reaching `unwire()` would leave
// a stale `.ride-post-s10` mount attached, which `root()`/`queryRoot()`
// (plain `document.querySelector`) would then silently pick up as the
// FIRST match in every subsequent test, corrupting their assertions instead
// of failing cleanly. This doesn't fix the underlying "always call unwire()"
// discipline, but it stops one bad test from cascading into every test after
// it in the file.
afterEach(() => {
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// buildEligibilityCopy — every reason (7) x the enumerated statuses
// ---------------------------------------------------------------------------

describe("buildEligibilityCopy", () => {
  it.each([
    [
      "start_mismatch",
      "Your ride is ineligible for community contribution points because the start location did not align with the veo feed record.",
    ],
    [
      "end_mismatch",
      "Your ride is ineligible for community contribution points because the end location did not align with the veo feed record.",
    ],
    [
      "tracking_not_opted",
      "Your ride is ineligible for community contribution points because you did not opt to track your route.",
    ],
    [
      "too_few_waypoints",
      "Your ride is ineligible for community contribution points because your device did not collect the requisite number of waypoints successfully.",
    ],
    [
      "trip_too_short",
      "Your ride is ineligible for community contribution points because your trip was too short.",
    ],
    [
      "chain_invalid",
      "Your ride is ineligible for community contribution points because your saved track failed integrity verification.",
    ],
    [
      "internal_error",
      "Your ride is ineligible for community contribution points because there was an internal error.",
    ],
  ] as const)("ineligible + %s renders the exact owner clause", (reason, expected) => {
    expect(
      buildEligibilityCopy({ status: "ineligible", reasons: [reason] }),
    ).toBe(expected);
  });

  it("ineligible with no reasons ends the sentence without a because-clause", () => {
    expect(buildEligibilityCopy({ status: "ineligible", reasons: [] })).toBe(
      "Your ride is ineligible for community contribution points.",
    );
  });

  it("ineligible with two reasons joins with 'and'", () => {
    expect(
      buildEligibilityCopy({
        status: "ineligible",
        reasons: ["start_mismatch", "trip_too_short"],
      }),
    ).toBe(
      "Your ride is ineligible for community contribution points because the start location did not align with the veo feed record and your trip was too short.",
    );
  });

  it("ineligible with three reasons uses an Oxford comma", () => {
    expect(
      buildEligibilityCopy({
        status: "ineligible",
        reasons: ["start_mismatch", "end_mismatch", "trip_too_short"],
      }),
    ).toBe(
      "Your ride is ineligible for community contribution points because the start location did not align with the veo feed record, the end location did not align with the veo feed record, and your trip was too short.",
    );
  });

  it("pending_feed cites the live feed and the donation requirement, joined by 'and'", () => {
    expect(buildEligibilityCopy({ status: "pending_feed", reasons: [] })).toBe(
      "Your ride may be eligible for community contribution points, but we're waiting on validation from the live feed, and you'll need to donate your trip data to earn these points.",
    );
  });

  it("plain pending omits the live-feed clause but keeps the donation prompt", () => {
    expect(buildEligibilityCopy({ status: "pending", reasons: [] })).toBe(
      "Your ride may be eligible for community contribution points, but you'll need to donate your trip data to earn these points.",
    );
  });

  it("eligible renders bare, with neither optional clause", () => {
    expect(buildEligibilityCopy({ status: "eligible", reasons: [] })).toBe(
      "Your ride is eligible for community contribution points.",
    );
    // Defensive: stray reasons on an eligible verdict are ignored, not
    // appended — "eligible" is not in the "because" branch of the skeleton.
    expect(
      buildEligibilityCopy({ status: "eligible", reasons: ["chain_invalid"] }),
    ).toBe("Your ride is eligible for community contribution points.");
  });

  it("error status renders a distinct, clearly-labeled fallback rather than crashing", () => {
    expect(buildEligibilityCopy({ status: "error", reasons: [] })).toBe(
      "Your ride's eligibility for community contribution points couldn't be determined because there was an internal error.",
    );
  });

  it("an unrecognized future status falls back gracefully rather than throwing", () => {
    const validation = { status: "something_new", reasons: [] } as unknown as RideValidation;
    expect(() => buildEligibilityCopy(validation)).not.toThrow();
  });
});

describe("reasonClause / joinReasonClauses", () => {
  it("maps an unrecognized reason token to the internal_error clause", () => {
    expect(reasonClause("some_future_reason")).toBe("there was an internal error");
  });

  it("returns null for an empty or missing reasons list", () => {
    expect(joinReasonClauses([])).toBeNull();
    expect(joinReasonClauses(undefined)).toBeNull();
    expect(joinReasonClauses(null)).toBeNull();
  });

  it("de-duplicates repeated reasons", () => {
    expect(joinReasonClauses(["trip_too_short", "trip_too_short"])).toBe(
      "your trip was too short",
    );
  });
});

// ---------------------------------------------------------------------------
// estimateDonationPoints — the pre-donation "up to N pts" tease, pure and
// directly unit-testable against FALLBACK_RIDE_MODE_POINTS (batteryBase: 8,
// batteryPerStep: 2, batteryStepKm: 2, navDistancePerStep: 2,
// navDistanceStepKm: 3).
// ---------------------------------------------------------------------------

describe("estimateDonationPoints", () => {
  const POINTS = FALLBACK_RIDE_MODE_POINTS;

  it("null distance yields null", () => {
    expect(
      estimateDonationPoints(null, POINTS, { battery: true, navDistance: true }),
    ).toBeNull();
  });

  it("zero or negative distance yields null", () => {
    expect(
      estimateDonationPoints(0, POINTS, { battery: true, navDistance: true }),
    ).toBeNull();
    expect(
      estimateDonationPoints(-100, POINTS, { battery: true, navDistance: true }),
    ).toBeNull();
  });

  it("neither eligibility bucket yields null", () => {
    expect(
      estimateDonationPoints(5000, POINTS, { battery: false, navDistance: false }),
    ).toBeNull();
  });

  it("battery-only: base + per-step * ceil(km / stepKm)", () => {
    // 4.3 km / 2 km-per-step -> ceil(2.15) = 3 steps.
    expect(
      estimateDonationPoints(4300, POINTS, { battery: true, navDistance: false }),
    ).toBe(POINTS.batteryBase + POINTS.batteryPerStep * 3);
  });

  it("navDistance-only: per-step * ceil(km / stepKm)", () => {
    // 4.3 km / 3 km-per-step -> ceil(1.43) = 2 steps.
    expect(
      estimateDonationPoints(4300, POINTS, { battery: false, navDistance: true }),
    ).toBe(POINTS.navDistancePerStep * 2);
  });

  it("both buckets combine additively", () => {
    expect(
      estimateDonationPoints(4300, POINTS, { battery: true, navDistance: true }),
    ).toBe(
      POINTS.batteryBase + POINTS.batteryPerStep * 3 + POINTS.navDistancePerStep * 2,
    );
  });

  it("an exact step boundary rounds up to that step, not the next one", () => {
    // Exactly 2.00 km against a 2 km step is 1 step, not 2.
    expect(
      estimateDonationPoints(2000, POINTS, { battery: true, navDistance: false }),
    ).toBe(POINTS.batteryBase + POINTS.batteryPerStep * 1);
  });

  it("a non-positive stepKm degrades to the flat base rather than Infinity/NaN", () => {
    const zeroStep: ResolvedRideModePoints = { ...POINTS, batteryStepKm: 0 };
    expect(
      estimateDonationPoints(4300, zeroStep, { battery: true, navDistance: false }),
    ).toBe(zeroStep.batteryBase);

    const negativeStep: ResolvedRideModePoints = { ...POINTS, navDistanceStepKm: -1 };
    expect(
      estimateDonationPoints(4300, negativeStep, { battery: false, navDistance: true }),
    ).toBeNull();
  });

  it("a zeroed-out award (base and per-step both 0) yields null, never a hollow 'up to 0 pts'", () => {
    const zeroedAward: ResolvedRideModePoints = {
      ...POINTS,
      batteryBase: 0,
      batteryPerStep: 0,
    };
    expect(
      estimateDonationPoints(4300, zeroedAward, { battery: true, navDistance: false }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------

describe("pointsActionLabel", () => {
  it("labels every known ride-mode points action", () => {
    expect(pointsActionLabel("battery_contribution")).toBe("Battery contribution");
    expect(pointsActionLabel("nav_route_feedback")).toBe("Navigation route feedback");
    expect(pointsActionLabel("nav_qualitative_feedback")).toBe(
      "Navigation qualitative feedback",
    );
    expect(pointsActionLabel("nav_distance_bonus")).toBe("Navigation distance bonus");
    expect(pointsActionLabel("ride_survey")).toBe("End-ride survey");
  });

  it("title-cases an unrecognized future action rather than hiding it", () => {
    expect(pointsActionLabel("brand_new_award")).toBe("Brand New Award");
  });
});

describe("formatKm / tripStatusLabel / tripDateLabel", () => {
  it("formatKm renders two decimal places", () => {
    expect(formatKm(4312.5)).toBe("4.31 km");
    expect(formatKm(0)).toBe("0.00 km");
  });

  it("tripStatusLabel covers every TrackedRideStatus", () => {
    expect(tripStatusLabel("watching")).toBe("In progress");
    expect(tripStatusLabel("left_feed")).toBe("Left the feed");
    expect(tripStatusLabel("completed")).toBe("Completed");
    expect(tripStatusLabel("expired")).toBe("Expired");
  });

  it("tripDateLabel degrades to an em dash for an unparseable timestamp", () => {
    expect(tripDateLabel("not-a-date")).toBe("—");
  });

  it("tripDateLabel formats a real ISO timestamp without throwing", () => {
    expect(tripDateLabel("2026-07-29T18:30:00Z")).toMatch(/Jul/);
  });
});

// ---------------------------------------------------------------------------
// isAlreadyDonatedError / describeDonateError / describeRecentTripsError
// ---------------------------------------------------------------------------

describe("isAlreadyDonatedError", () => {
  it("only the specific already_donated 409 counts", () => {
    expect(
      isAlreadyDonatedError(
        new ApiError("x", "HTTP_ERROR", { status: 409, errorKey: "already_donated" }),
      ),
    ).toBe(true);
    expect(
      isAlreadyDonatedError(
        new ApiError("x", "HTTP_ERROR", { status: 409, errorKey: "ride_not_ended" }),
      ),
    ).toBe(false);
    expect(isAlreadyDonatedError(new Error("network down"))).toBe(false);
  });
});

describe("describeDonateError", () => {
  it.each([
    ["already_donated", /already donated/i],
    ["ride_not_ended", /finish Screen 8/i],
    ["tracking_not_opted", /nothing to donate/i],
    ["chain_invalid", /integrity verification/i],
  ] as const)("errorKey %s produces a friendly message", (errorKey, pattern) => {
    expect(
      describeDonateError(
        new ApiError("x", "HTTP_ERROR", { status: 422, errorKey }),
      ),
    ).toMatch(pattern);
  });

  it("falls back to status-based copy for 413/404/429", () => {
    expect(describeDonateError(new ApiError("x", "HTTP_ERROR", { status: 413 }))).toMatch(
      /too large/,
    );
    expect(describeDonateError(new ApiError("x", "HTTP_ERROR", { status: 404 }))).toMatch(
      /no longer on the server/,
    );
    expect(describeDonateError(new ApiError("x", "HTTP_ERROR", { status: 429 }))).toMatch(
      /Too many donation attempts/,
    );
  });

  it("generic fallback for a plain network failure", () => {
    expect(describeDonateError(new Error("boom"))).toMatch(/check your connection/);
  });
});

describe("describeRecentTripsError", () => {
  it("distinguishes a 404 from a generic failure", () => {
    expect(
      describeRecentTripsError(new ApiError("x", "HTTP_ERROR", { status: 404 })),
    ).toMatch(/No trip history/);
    expect(describeRecentTripsError(new Error("boom"))).toMatch(/Couldn't load/);
  });
});

// ---------------------------------------------------------------------------
// shouldShowRidePostS10
// ---------------------------------------------------------------------------

describe("shouldShowRidePostS10", () => {
  it("null doc never shows", () => {
    expect(shouldShowRidePostS10(null, { hasWaypoints: true })).toBe(false);
  });

  it("mirrors ride-session.ts's shouldShowEligibility exactly", () => {
    const session = sessionAtEligibility();
    const doc = session.current();
    expect(doc).not.toBeNull();
    expect(shouldShowRidePostS10(doc, { hasWaypoints: true })).toBe(true);
    expect(shouldShowRidePostS10(doc, { hasWaypoints: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wireRidePostS10 — mount/unmount lifecycle
// ---------------------------------------------------------------------------

describe("wireRidePostS10 — mount/unmount off phaseOf(doc)", () => {
  it("mounts immediately when the doc is already in eligibility(10) at wire time", () => {
    const session = sessionAtEligibility();
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

  it("mounts on a live transition into eligibility(10)", () => {
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
    session.dispatch({ type: "endRide" });
    const { unwire } = wire(session);
    expect(queryRoot()).toBeNull();
    session.dispatch({ type: "endReported", facts: { hasWaypoints: true } });
    expect(queryRoot()).not.toBeNull();
    unwire();
  });

  it("wireRidePostS10's own teardown removes a live mount", () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session);
    expect(queryRoot()).not.toBeNull();
    unwire();
    expect(queryRoot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Initial validation load (GET /tracked-rides/{id})
// ---------------------------------------------------------------------------

describe("initial validation load", () => {
  it("renders the sentence from the fetched ride's validation", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(
          fakeTrackedRide({
            validation: { status: "ineligible", reasons: ["trip_too_short"] },
          }),
        ),
      ),
    });
    await flush();
    expect(sentenceText()).toBe(
      buildEligibilityCopy({ status: "ineligible", reasons: ["trip_too_short"] }),
    );
    unwire();
  });

  it("defaults to pending when the ride carries no validation field", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ validation: undefined })),
      ),
    });
    await flush();
    expect(sentenceText()).toBe(buildEligibilityCopy({ status: "pending", reasons: [] }));
    unwire();
  });

  it("a failed fetch keeps the pending default and shows a note, without blocking Donate", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() => Promise.reject(new Error("offline"))),
    });
    await flush();
    expect(sentenceText()).toBe(buildEligibilityCopy({ status: "pending", reasons: [] }));
    expect(root().textContent).toMatch(/Couldn't check your ride/);
    expect(buttonWithText("Donate This Trip's Data").disabled).toBe(false);
    unwire();
  });

  // Adversarial-review fix: a slow initial fetch resolving AFTER a fast
  // donation used to unconditionally overwrite `validation`, regressing the
  // eligibility sentence back to the stale pre-donation status right after a
  // successful donation had already set the authoritative one.
  it("a late-resolving initial fetch does not regress the sentence after a faster donation already settled it", async () => {
    const session = sessionAtEligibility();
    const initial = deferred<TrackedRide>();
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() => initial.promise),
      donateTrack: vi.fn(() =>
        Promise.resolve(
          fakeDonateResponse({ validation: { status: "eligible", reasons: [] } }),
        ),
      ),
    });

    // The initial GET is still in flight when the rider donates.
    buttonWithText("Donate This Trip's Data").click();
    await flush();
    expect(sentenceText()).toBe(buildEligibilityCopy({ status: "eligible", reasons: [] }));

    // The slow initial fetch finally resolves with a stale, pre-donation
    // verdict — it must NOT clobber the donation's own authoritative one.
    initial.resolve(fakeTrackedRide({ validation: { status: "pending", reasons: [] } }));
    await flush();

    expect(sentenceText()).toBe(buildEligibilityCopy({ status: "eligible", reasons: [] }));
    unwire();
  });
});

// ---------------------------------------------------------------------------
// Privacy/completeness review fix: the master plan resolves "no route ever
// leaves its owner" against donation via explicit, per-ride, per-donation
// consent WITH disclosed de-identification — the disclosure must render
// immediately before the affirmative [Donate This Trip's Data] action
// whenever that action is still available, in every validation state.
// ---------------------------------------------------------------------------

describe("donation consent disclosure", () => {
  it("mentions the required ≤28h de-identification / irrevocability language", () => {
    expect(DONATION_DISCLOSURE_TEXT).toMatch(/28 hours/);
    expect(DONATION_DISCLOSURE_TEXT).toMatch(/anonymous and irrevocable/);
  });

  it("is present before validation has loaded", () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session);
    expect(root().textContent).toContain(DONATION_DISCLOSURE_TEXT);
    unwire();
  });

  it("is present once validation settles (pending)", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ validation: { status: "pending", reasons: [] } })),
      ),
    });
    await flush();
    expect(root().textContent).toContain(DONATION_DISCLOSURE_TEXT);
    unwire();
  });

  it("is present when the validation fetch fails", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() => Promise.reject(new Error("offline"))),
    });
    await flush();
    expect(root().textContent).toContain(DONATION_DISCLOSURE_TEXT);
    unwire();
  });

  it("is present for a decided ineligible verdict too", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(
          fakeTrackedRide({
            validation: { status: "ineligible", reasons: ["trip_too_short"] },
          }),
        ),
      ),
    });
    await flush();
    expect(root().textContent).toContain(DONATION_DISCLOSURE_TEXT);
    unwire();
  });

  it("disappears once the ride has already been donated", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session);
    await flush();
    buttonWithText("Donate This Trip's Data").click();
    await flush();
    expect(root().textContent).not.toContain(DONATION_DISCLOSURE_TEXT);
    unwire();
  });
});

// ---------------------------------------------------------------------------
// Points tease — the "up to N pts" estimate shown before donating (renderBody
// wires estimateDonationPoints, tested in isolation above, to the fetched
// ride's distance and the doc's own donation-eligibility options).
// ---------------------------------------------------------------------------

describe("points tease (renderBody)", () => {
  function teaseText(): string | null {
    return (
      root().querySelector<HTMLElement>(".ride-post-s10__points-tease")
        ?.textContent ?? null
    );
  }

  it("shows an estimate before donating when battery_modeling is eligible", async () => {
    const session = sessionAtEligibility({
      battery_modeling: true,
      nav_improvement: false,
    });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
      points: () => FALLBACK_RIDE_MODE_POINTS,
    });
    await flush();
    expect(teaseText()).toBe("Donating could earn you up to 14 pts (pending validation).");
    unwire();
  });

  it("adds the nav distance bonus only when a route was chosen AND nav_improvement is on", async () => {
    const session = sessionAtEligibilityWithRoute({
      battery_modeling: true,
      nav_improvement: true,
    });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
      points: () => FALLBACK_RIDE_MODE_POINTS,
    });
    await flush();
    // battery: 8 + 2*3 = 14; nav distance: 2*2 = 4; total 18.
    expect(teaseText()).toBe("Donating could earn you up to 18 pts (pending validation).");
    unwire();
  });

  it("nav_improvement without a chosen route contributes nothing", async () => {
    const session = sessionAtEligibility({
      battery_modeling: false,
      nav_improvement: true,
    });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
      points: () => FALLBACK_RIDE_MODE_POINTS,
    });
    await flush();
    expect(teaseText()).toBeNull();
    unwire();
  });

  it("is absent when neither donation-eligible option is on", async () => {
    const session = sessionAtEligibility({
      battery_modeling: false,
      nav_improvement: false,
    });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
    });
    await flush();
    expect(teaseText()).toBeNull();
    unwire();
  });

  it("is absent before validation has loaded (distance not known yet)", () => {
    const session = sessionAtEligibility({ battery_modeling: true });
    const { unwire } = wire(session);
    expect(teaseText()).toBeNull();
    unwire();
  });

  it("is absent once the ride is a decided ineligible verdict", async () => {
    const session = sessionAtEligibility({ battery_modeling: true });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(
          fakeTrackedRide({
            distance_meters: 4300,
            validation: { status: "ineligible", reasons: ["trip_too_short"] },
          }),
        ),
      ),
    });
    await flush();
    expect(teaseText()).toBeNull();
    unwire();
  });

  it("disappears once a donation succeeds, replaced by the real award list", async () => {
    const session = sessionAtEligibility({ battery_modeling: true });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
    });
    await flush();
    expect(teaseText()).not.toBeNull();
    buttonWithText("Donate This Trip's Data").click();
    await flush();
    expect(teaseText()).toBeNull();
    unwire();
  });

  it("falls back to FALLBACK_RIDE_MODE_POINTS when no points getter is injected", async () => {
    const session = sessionAtEligibility({ battery_modeling: true });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
    });
    await flush();
    expect(teaseText()).toBe("Donating could earn you up to 14 pts (pending validation).");
    unwire();
  });

  it("re-reads the points getter fresh on every render rather than caching it at wire time", async () => {
    let live: ResolvedRideModePoints = FALLBACK_RIDE_MODE_POINTS;
    const session = sessionAtEligibility({ battery_modeling: true });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
      points: () => live,
    });
    await flush();
    expect(teaseText()).toBe("Donating could earn you up to 14 pts (pending validation).");

    // Simulate loadRideModePoints() resolving AFTER this screen already
    // mounted — the getter must be re-read on the next render, not the value
    // frozen from whatever resolved (usually still the fallback) at wire
    // time. A stale capture here is exactly the bug this getter shape exists
    // to prevent (see ride-post-s10.ts's own doc comment on `points`).
    live = { ...FALLBACK_RIDE_MODE_POINTS, batteryBase: 100 };
    buttonWithText("See recent trips").click();
    await flush();
    expect(teaseText()).toBe("Donating could earn you up to 106 pts (pending validation).");
    unwire();
  });

  it("is marked as a polite live region, like the adjacent sentence and error paragraphs", async () => {
    const session = sessionAtEligibility({ battery_modeling: true });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
    });
    await flush();
    const tease = root().querySelector(".ride-post-s10__points-tease");
    expect(tease?.getAttribute("role")).toBe("status");
    expect(tease?.getAttribute("aria-live")).toBe("polite");
    unwire();
  });

  it("a zeroed-out points schedule (base and per-step both 0) shows no tease at all", async () => {
    const session = sessionAtEligibility({ battery_modeling: true });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
      points: () => ({ ...FALLBACK_RIDE_MODE_POINTS, batteryBase: 0, batteryPerStep: 0 }),
    });
    await flush();
    expect(teaseText()).toBeNull();
    unwire();
  });

  it("disappears once a donation attempt FAILS, so it never contradicts the error message beside it", async () => {
    const session = sessionAtEligibility({ battery_modeling: true });
    const { unwire } = wire(session, {
      getTrackedRide: vi.fn(() =>
        Promise.resolve(fakeTrackedRide({ distance_meters: 4300 })),
      ),
      donateTrack: vi.fn(() =>
        Promise.reject(
          new ApiError("x", "HTTP_ERROR", { status: 422, errorKey: "chain_invalid" }),
        ),
      ),
    });
    await flush();
    expect(teaseText()).not.toBeNull();

    buttonWithText("Donate This Trip's Data").click();
    await flush();

    expect(root().textContent).toMatch(/integrity verification/);
    expect(teaseText()).toBeNull();
    unwire();
  });
});

// ---------------------------------------------------------------------------
// Review fix regression: with IndexedDB unavailable, `openTrackStore()`
// degrades to a fresh, empty in-memory adapter on EVERY independent call.
// The donation reader's default (`defaultReadDonationBody`) must read
// through the SAME injected `getTrackStore` `ride-post.ts` shares with the
// rest of the post-ride flow, not one it opens for itself.
// ---------------------------------------------------------------------------

describe("shared TrackStore — donation reader", () => {
  it("readDonationBody's default reads the exact batches recorded through the injected getTrackStore", async () => {
    const signing: TrackSigning = {
      alg: "HS256",
      key_id: RIDE_ID,
      key: base64UrlEncode(new Uint8Array(32).fill(7)),
      nonce: "00112233445566778899aabbccddeeff",
      issued_at: new Date(STARTED_AT_MS).toISOString(),
    };
    const sharedStore = await openTrackStore({ indexedDBFactory: null });
    const recorder = await sharedStore.startServerRide(signing);
    await recorder.addFix({ tMs: 0, lat: 39.7, lon: -105 });
    await recorder.addFix({ tMs: 1000, lat: 39.701, lon: -105 });
    const sealed = await recorder.sealOpenBatch();
    if (!sealed) throw new Error("fixture failed to seal a batch");

    const session = sessionAtEligibility();
    const donateTrack = vi.fn(
      (_rideId: string, _body: unknown, _signal?: AbortSignal) =>
        Promise.resolve(fakeDonateResponse()),
    );
    const container = document.createElement("div");
    document.body.append(container);
    // NOTE: calling `wireRidePostS10` directly (not through this file's own
    // `wire()` helper) so `readDonationBody` is left UNSET — exercising the
    // module's real default, which is what actually reads through
    // `getTrackStore`. `wire()`'s own mock would otherwise mask this.
    const unwire = wireRidePostS10({
      session,
      getTrackedRide: vi.fn(() => Promise.resolve(fakeTrackedRide())),
      donateTrack,
      getTrackStore: async () => sharedStore,
      mountRoot: container,
    });
    await flush();

    buttonWithText("Donate This Trip's Data").click();
    await flush();

    expect(donateTrack).toHaveBeenCalledTimes(1);
    const [, body] = donateTrack.mock.calls[0];
    expect(body).toMatchObject({ batches: [sealed.jws] });

    unwire();
  });
});

// ---------------------------------------------------------------------------
// Donation flow
// ---------------------------------------------------------------------------

describe("[Donate This Trip's Data]", () => {
  it("reads sealed batches from track-store and posts them, then displays points + verification", async () => {
    const session = sessionAtEligibility();
    const { unwire, readDonationBody, donateTrack } = wire(session, {
      readDonationBody: vi.fn(() =>
        Promise.resolve({ batches: ["jws-0", "jws-1", "jws-2"], chain_root_hash: "deadbeef" }),
      ),
      donateTrack: vi.fn(() =>
        Promise.resolve(
          fakeDonateResponse({
            validation: { status: "eligible", reasons: [] },
            points: [
              { action: "battery_contribution", points: 14 },
              { action: "ride_survey", points: 4 },
            ],
          }),
        ),
      ),
    });
    await flush();

    buttonWithText("Donate This Trip's Data").click();
    await flush();

    expect(readDonationBody).toHaveBeenCalledWith(RIDE_ID);
    expect(donateTrack).toHaveBeenCalledTimes(1);
    const [rideId, body] = donateTrack.mock.calls[0];
    expect(rideId).toBe(RIDE_ID);
    expect(body).toEqual({
      batches: ["jws-0", "jws-1", "jws-2"],
      chain_root_hash: "deadbeef",
    });

    expect(sentenceText()).toBe(buildEligibilityCopy({ status: "eligible", reasons: [] }));
    expect(root().textContent).toContain("Battery contribution: +14 pts");
    expect(root().textContent).toContain("End-ride survey: +4 pts");
    expect(root().textContent).toContain("Chain integrity: ok");
    expect(root().textContent).toContain("Waypoints uploaded: 512");
    expect(root().textContent).toContain("4.31 km");

    // Single donation per ride: the button disables once donated.
    expect(buttonWithText("Donate This Trip's Data").disabled).toBe(true);
    unwire();
  });

  it("an empty points array (pending_feed) shows the held-points hint, not a blank list", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      donateTrack: vi.fn(() =>
        Promise.resolve(
          fakeDonateResponse({
            validation: { status: "pending_feed", reasons: [] },
            points: [],
          }),
        ),
      ),
    });
    await flush();
    buttonWithText("Donate This Trip's Data").click();
    await flush();
    expect(root().textContent).toMatch(/No points awarded yet/);
    unwire();
  });

  it("already_donated leaves the button disabled and shows the friendly message", async () => {
    const session = sessionAtEligibility();
    const { unwire, donateTrack } = wire(session, {
      donateTrack: vi.fn(() =>
        Promise.reject(
          new ApiError("x", "HTTP_ERROR", { status: 409, errorKey: "already_donated" }),
        ),
      ),
    });
    await flush();
    buttonWithText("Donate This Trip's Data").click();
    await flush();

    expect(donateTrack).toHaveBeenCalledTimes(1);
    expect(root().textContent).toMatch(/already donated/i);
    expect(buttonWithText("Donate This Trip's Data").disabled).toBe(true);
    unwire();
  });

  it("chain_invalid is rejected and the donation slot is NOT consumed — Donate stays retryable", async () => {
    const session = sessionAtEligibility();
    const donateTrack = vi.fn(
      (): Promise<DonateTrackResponse> =>
        Promise.reject(
          new ApiError("x", "HTTP_ERROR", { status: 422, errorKey: "chain_invalid" }),
        ),
    );
    const { unwire } = wire(session, { donateTrack });
    await flush();
    buttonWithText("Donate This Trip's Data").click();
    await flush();

    expect(root().textContent).toMatch(/integrity verification/);
    expect(buttonWithText("Donate This Trip's Data").disabled).toBe(false);

    donateTrack.mockResolvedValueOnce(fakeDonateResponse());
    buttonWithText("Donate This Trip's Data").click();
    await flush();
    expect(donateTrack).toHaveBeenCalledTimes(2);
    expect(buttonWithText("Donate This Trip's Data").disabled).toBe(true);
    unwire();
  });

  it("a declined donation (never clicked) leaves zero donateTrack calls", async () => {
    const session = sessionAtEligibility();
    const { unwire, donateTrack, readDonationBody } = wire(session);
    await flush();

    // Interact with everything EXCEPT Donate.
    buttonWithText("See recent trips").click();
    await flush();
    buttonWithText("See recent trips").click();

    expect(donateTrack).not.toHaveBeenCalled();
    expect(readDonationBody).not.toHaveBeenCalled();
    unwire();
  });
});

// ---------------------------------------------------------------------------
// See recent trips
// ---------------------------------------------------------------------------

describe("[See recent trips]", () => {
  it("fetches once on first open, renders rows, and does not refetch on re-toggle", async () => {
    const session = sessionAtEligibility();
    const listTrackedRidesFn = vi.fn(() =>
      Promise.resolve({
        count: 2,
        rides: [
          fakeTrackedRide({ id: "r-1", status: "completed", distance_meters: 2000 }),
          fakeTrackedRide({ id: "r-2", status: "watching", distance_meters: null }),
        ],
      }),
    );
    const { unwire } = wire(session, { listTrackedRides: listTrackedRidesFn });
    await flush();

    buttonWithText("See recent trips").click();
    await flush();

    expect(listTrackedRidesFn).toHaveBeenCalledTimes(1);
    expect(root().textContent).toContain("Recent trips");
    expect(root().textContent).toContain("Completed");
    expect(root().textContent).toContain("In progress");
    expect(root().textContent).toContain("2.00 km");

    // Toggle closed, then open again: no second fetch.
    buttonWithText("See recent trips").click();
    expect(root().textContent).not.toContain("Recent trips");
    buttonWithText("See recent trips").click();
    await flush();
    expect(listTrackedRidesFn).toHaveBeenCalledTimes(1);
    expect(root().textContent).toContain("Recent trips");
    unwire();
  });

  it("shows an empty-state message for zero trips", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      listTrackedRides: vi.fn(() => Promise.resolve({ count: 0, rides: [] })),
    });
    await flush();
    buttonWithText("See recent trips").click();
    await flush();
    expect(root().textContent).toMatch(/No recent trips yet/);
    unwire();
  });

  it("shows a friendly error on failure", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session, {
      listTrackedRides: vi.fn(() => Promise.reject(new Error("offline"))),
    });
    await flush();
    buttonWithText("See recent trips").click();
    await flush();
    expect(root().textContent).toMatch(/Couldn't load recent trips/);
    unwire();
  });
});

// ---------------------------------------------------------------------------
// Return to Main App
// ---------------------------------------------------------------------------

describe("[Return to Main App]", () => {
  it("dispatches eligibilityDone, transitions to done, and unmounts", async () => {
    const session = sessionAtEligibility();
    const { unwire, donateTrack } = wire(session);
    await flush();

    buttonWithText("Return to Main App").click();
    await flush();

    expect(session.current()?.state).toBe("done");
    expect(session.current()?.screen).toBeNull();
    expect(queryRoot()).toBeNull();
    expect(donateTrack).not.toHaveBeenCalled();
    unwire();
  });

  it("works with no donation attempted at all (declining donation is a valid path)", async () => {
    const session = sessionAtEligibility();
    const { unwire } = wire(session);
    await flush();
    buttonWithText("Return to Main App").click();
    expect(session.current()?.state).toBe("done");
    unwire();
  });
});

// ---------------------------------------------------------------------------
// listTrackedRides — the default GET wrapper (api.ts has none yet)
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(respond: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string })?.url ?? input);
    const call: FetchCall = { url, init };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubAuth(token = "test-token"): void {
  const store = new Map<string, string>([
    [
      "scooter_fyi.map_auth",
      JSON.stringify({
        token,
        expires: new Date(Date.now() + 3_600_000).toISOString(),
        issued_at: new Date().toISOString(),
      }),
    ],
  ]);
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("sessionStorage", fake);
  vi.stubGlobal("localStorage", fake);
}

describe("listTrackedRides — default GET wrapper", () => {
  it("builds the full query string and unwraps the envelope", async () => {
    stubAuth("tok-42");
    const calls = stubFetch(() =>
      jsonResponse({ count: 1, rides: [fakeTrackedRide()] }),
    );

    const res = await listTrackedRides({
      limit: 3,
      status: "completed",
      before: "2026-07-29T00:00:00+00:00",
    });

    expect(calls).toHaveLength(1);
    const expectedParams = new URLSearchParams();
    expectedParams.set("limit", "3");
    expectedParams.set("before", "2026-07-29T00:00:00+00:00");
    expectedParams.set("status", "completed");
    expect(calls[0].url).toBe(`/api/v1/tracked-rides?${expectedParams.toString()}`);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-42");
    expect(res.count).toBe(1);
    expect(res.rides).toHaveLength(1);
  });

  it("omits absent params entirely", async () => {
    stubAuth();
    const calls = stubFetch(() => jsonResponse({ count: 0, rides: [] }));
    await listTrackedRides();
    expect(calls[0].url).toBe("/api/v1/tracked-rides");
  });

  it("surfaces a structured error the same way every other authed call does", async () => {
    stubAuth();
    stubFetch(() => jsonResponse({ detail: "nope" }, 500));
    await expect(listTrackedRides()).rejects.toBeInstanceOf(ApiError);
  });
});
