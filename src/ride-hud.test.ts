// @vitest-environment happy-dom
//
// ride-hud.ts — F3's pure decision helpers only. The class itself
// (`RideHud`) is a thick DOM/MapLibre/geolocation object with no seam that
// doesn't ultimately touch `document`, a `maplibregl.Map`, or
// `navigator.geolocation.watchPosition` — none of which are practically
// unit-testable without either a real browser or a very large mock surface
// that would mostly be re-testing MapLibre and the DOM, not this module's
// logic. Per the F3 lane brief, the branches that actually decide behavior
// were extracted as pure, exported functions instead, and this file is their
// full coverage:
//
//   - the model-filter decision MOVED. Phase 6 §6.3 replaced
//     `rideModelFilterFor` with one shared, named three-state; it and its
//     cases live in `model-filter.test.ts` now. The ride-start reset that
//     function existed to serve is gone with it — a reset is a filter wipe
//     once there is only one filter, which §6.1's ONE MAP guarantee forbids.
//   - `brbStrategyFor`       — the BRB tracked-vs-private branch decision
//                              (item 5).
//   - `minimalEndReport`     — the interim end-report field set (item 6).
//   - `isLiveRideEntry`      — the entry-point flag-flip guard (item 8).
//
// NOT covered here (documented, not silently skipped): renderRiding()'s
// corner markup, the wrench panel's Stop-tracking confirm dialog wiring, the
// shared watchPosition callback's DOM/map side effects, and the BRB/end-
// report class methods' orchestration (`pauseRide`/`resumeRide`/`endRide`/
// `handOffTrackedRideEnd`) — each of those is a thin, direct consumer of one
// of the pure functions above (verified by reading, not by a DOM harness).
// The F4 tracked-ride hand-off (Screen 8 takeover, no legacy summary, no
// PATCH /end from this module) DOES get a real DOM harness, though — see
// ride-hud-integration.test.ts's "ending a TRACKED ride..." test.
import { describe, expect, it } from "vitest";

import {
  brbStrategyFor,
  isLiveRideEntry,
  minimalEndReport,
} from "./ride-hud.ts";
// ---------------------------------------------------------------------------
// brbStrategyFor — item 5, the BRB tracked-vs-private branch decision.
// ---------------------------------------------------------------------------

describe("brbStrategyFor", () => {
  it("a tracked ride (non-null rideId) keeps recording through BRB", () => {
    expect(brbStrategyFor("ride_abc123")).toBe("continue_tracking");
  });

  it("a private/guest/legacy ride (null rideId) keeps the original stop+freeze behavior", () => {
    expect(brbStrategyFor(null)).toBe("freeze_and_stop");
  });

  it("an empty-string rideId is still a truthy identity, not null — treated as tracked", () => {
    // Defensive: ride-session.ts never persists "" for rideId, but the
    // function's contract is exactly "non-null", not "truthy" — pin it.
    expect(brbStrategyFor("")).toBe("continue_tracking");
  });
});

// ---------------------------------------------------------------------------
// minimalEndReport — item 6, the interim End Ride report's field set.
// ---------------------------------------------------------------------------

describe("minimalEndReport", () => {
  const pos = { lng: -104.9903, lat: 39.7392 }; // downtown Denver

  it("carries exactly the three required fields — no §10 fields, no battery/cost (those are Screen 8's, in F4)", () => {
    const body = minimalEndReport(Date.parse("2026-07-29T18:00:00.000Z"), pos);
    expect(Object.keys(body).sort()).toEqual(["end_lat", "end_lon", "ended_at"]);
  });

  it("end_lat/end_lon map from lat/lng respectively (not swapped)", () => {
    const body = minimalEndReport(Date.now(), pos);
    expect(body.end_lat).toBe(pos.lat);
    expect(body.end_lon).toBe(pos.lng);
  });

  it("ended_at is an ISO 8601 string carrying a UTC offset (the API 400s without one)", () => {
    const ms = Date.parse("2026-07-29T18:00:00.000Z");
    const body = minimalEndReport(ms, pos);
    expect(body.ended_at).toBe("2026-07-29T18:00:00.000Z");
    expect(body.ended_at.endsWith("Z")).toBe(true);
  });

  it("round-trips an arbitrary timestamp exactly", () => {
    const ms = Date.parse("2026-12-31T23:59:59.500Z");
    const body = minimalEndReport(ms, pos);
    expect(Date.parse(body.ended_at)).toBe(ms);
  });
});

// ---------------------------------------------------------------------------
// isLiveRideEntry — item 8, the entry-point flag-flip guard.
// ---------------------------------------------------------------------------

describe("isLiveRideEntry", () => {
  it("HUD paused (BRB'd) is live regardless of the session doc", () => {
    expect(isLiveRideEntry(true, "idle")).toBe(true);
    expect(isLiveRideEntry(true, undefined)).toBe(true);
    expect(isLiveRideEntry(true, null)).toBe(true);
  });

  it("a session doc in 'riding' is live even when the HUD itself isn't paused (e.g. right after a reload)", () => {
    expect(isLiveRideEntry(false, "riding")).toBe(true);
  });

  it("a session doc in 'countdown' is live", () => {
    expect(isLiveRideEntry(false, "countdown")).toBe(true);
  });

  it("no doc, idle, wizard, or any post-ride state is NOT live — the button should open a fresh wizard", () => {
    expect(isLiveRideEntry(false, undefined)).toBe(false);
    expect(isLiveRideEntry(false, null)).toBe(false);
    expect(isLiveRideEntry(false, "idle")).toBe(false);
    expect(isLiveRideEntry(false, "wizard")).toBe(false);
    expect(isLiveRideEntry(false, "ending")).toBe(false);
    expect(isLiveRideEntry(false, "survey")).toBe(false);
    expect(isLiveRideEntry(false, "eligibility")).toBe(false);
    expect(isLiveRideEntry(false, "done")).toBe(false);
  });
});
