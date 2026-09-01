// My Scooters' presentation rules.
//
// The one that matters is the withholding: a kept vehicle's position is
// absent while somebody is riding it, and the row has to SAY so rather than
// leave a blank a reader (or a later contributor) fills in. So these tests
// come at it from several directions, including the "helpful" optimization
// that would defeat it — caching the last known dot across a transition.
import { describe, it, expect } from "vitest";
import {
  STATE_LABEL,
  WITHHELD_SENTENCE,
  favoriteTitle,
  keepErrorMessage,
  locationOf,
} from "./my-scooters.ts";
import { ApiError, type FavoriteDevice } from "./api.ts";

function fav(over: Partial<FavoriteDevice> = {}): FavoriteDevice {
  return {
    vehicle_identifier: "8c4a1f0d2e9b7a35",
    nickname: null,
    state: "available",
    position_withheld: false,
    notify_on_available: false,
    verified_at: "2026-08-29T12:00:00Z",
    created_at: "2026-08-20T09:14:00Z",
    last_seen_at: "2026-08-29T11:58:00Z",
    vehicle_model_name: "Cosmo",
    vehicle_use_type: "sitting",
    lat: 39.7392,
    lon: -104.9903,
    battery_percent: 71,
    current_range_meters: 12000,
    ...over,
  };
}

describe("locationOf", () => {
  it("gives a position for a parked favourite", () => {
    const loc = locationOf(fav());
    expect(loc).toEqual({ kind: "here", lat: 39.7392, lon: -104.9903, battery: 71 });
  });

  it("withholds, with a sentence, while somebody is riding it", () => {
    const loc = locationOf(
      fav({ state: "in_use", position_withheld: true, lat: undefined, lon: undefined }),
    );
    expect(loc.kind).toBe("withheld");
    expect(loc).toMatchObject({ sentence: WITHHELD_SENTENCE.in_use });
  });

  it("says something different about one that has gone missing", () => {
    const loc = locationOf(
      fav({ state: "gone", position_withheld: true, lat: undefined, lon: undefined }),
    );
    expect(loc).toMatchObject({ sentence: WITHHELD_SENTENCE.gone });
  });

  it("KEYS OFF THE FLAG, so a server bug still withholds", () => {
    // A response that carried both the flag and a position would be a server
    // mistake. Trusting the flag makes that mistake fall the safe way — the
    // position stays hidden — where trusting the absence would publish it.
    const loc = locationOf(fav({ state: "in_use", position_withheld: true }));
    expect(loc.kind).toBe("withheld");
  });

  it("does not invent a position when there is neither a flag nor coordinates", () => {
    const loc = locationOf(fav({ position_withheld: false, lat: null, lon: null }));
    expect(loc.kind).toBe("withheld");
    expect(loc).toMatchObject({ sentence: expect.stringContaining("don't have a position") });
  });

  it("carries no state between calls, so a transition cannot leak the old dot", () => {
    // THE OPTIMIZATION THAT DEFEATS THE RULE: remembering the last position
    // so an in-use row can keep showing where it "was". `locationOf` is a
    // pure function of one row precisely so there is nowhere for that to
    // live — this test fails the moment somebody adds a module-level cache.
    const parked = fav();
    expect(locationOf(parked).kind).toBe("here");

    const riding = fav({
      state: "in_use",
      position_withheld: true,
      lat: undefined,
      lon: undefined,
      battery_percent: undefined,
    });
    const after = locationOf(riding);
    expect(after.kind).toBe("withheld");
    expect(JSON.stringify(after)).not.toContain("39.7392");

    // ...and re-reading the parked row afterwards is unaffected either way.
    expect(locationOf(parked).kind).toBe("here");
  });

  it("reports a null battery on a parked vehicle without a reading", () => {
    expect(locationOf(fav({ battery_percent: null }))).toMatchObject({
      kind: "here",
      battery: null,
    });
  });
});

describe("favoriteTitle", () => {
  it("prefers the rider's own name", () => {
    expect(favoriteTitle(fav({ nickname: "My Rover" }))).toBe("My Rover");
  });

  it("ignores a blank nickname", () => {
    expect(favoriteTitle(fav({ nickname: "   " }))).toBe("My Cosmo");
  });

  it("never prints the identifier at a rider", () => {
    // A 16-hex database key on screen is how an app tells somebody it does
    // not really know what it is showing them.
    const title = favoriteTitle(fav({ nickname: null, vehicle_model_name: null }));
    expect(title).toBe("My scooter");
    expect(title).not.toContain("8c4a");
  });
});

describe("keepErrorMessage", () => {
  const apiError = (status: number, detail: unknown) =>
    new ApiError("x", "HTTP_ERROR", {
      status,
      detail,
      errorKey: (detail as { error?: string })?.error,
    });

  it("explains the distance refusal, which is the one an honest rider hits", () => {
    const msg = keepErrorMessage(
      apiError(403, { error: "too_far_from_device", meters_away: 212 }),
    );
    expect(msg).toContain("standing at this one");
    expect(msg).toContain("212");
  });

  it("copes when the distance is absent", () => {
    const msg = keepErrorMessage(apiError(403, { error: "too_far_from_device" }));
    expect(msg).toContain("standing at this one");
    expect(msg).not.toContain("undefined");
  });

  it("names the cap from the server rather than a hardcoded number", () => {
    expect(
      keepErrorMessage(apiError(409, { error: "favorite_limit_reached", max_favorites: 3 })),
    ).toContain("3 scooters");
  });

  it("sends a signed-out rider to sign in", () => {
    expect(keepErrorMessage(apiError(401, undefined))).toContain("Sign in");
  });

  it("degrades a non-API failure to something a rider can act on", () => {
    expect(keepErrorMessage(new TypeError("offline"))).toContain("try again");
  });

  it("never leaks a status code or an error key into the sentence", () => {
    for (const err of [
      apiError(403, { error: "too_far_from_device", meters_away: 212 }),
      apiError(400, { error: "qr_mismatch" }),
      apiError(400, { error: "unknown_device" }),
      apiError(409, { error: "favorite_limit_reached", max_favorites: 10 }),
      apiError(500, undefined),
    ]) {
      const msg = keepErrorMessage(err);
      expect(msg).not.toMatch(/[a-z]+_[a-z]+/);
      expect(msg).not.toMatch(/\b[45]\d\d\b/);
    }
  });
});

describe("STATE_LABEL", () => {
  it("covers every state the API can send", () => {
    expect(Object.keys(STATE_LABEL).sort()).toEqual([
      "available",
      "gone",
      "in_use",
      "unavailable",
    ]);
  });
});
