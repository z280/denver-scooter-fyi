// Phase 11 §11.4 case 2. Every assertion here guards against the SAME failure in
// a different direction: a confidently-stated end time that is wrong. The thing
// being replaced — stamping `now()` on a ride abandoned hours ago — is already
// wrong, so a replacement that is wrong differently is no improvement.
import { describe, expect, it } from "vitest";

import {
  MIN_RECOVERABLE_GAP_MS,
  endRecoveryCopy,
  endRecoveryOffer,
  type EndRecoveryInput,
} from "./ride-end-recovery.ts";

const NOW = Date.parse("2026-10-07T21:00:00Z");
const STARTED = NOW - 6 * 60 * 60_000;

function input(over: Partial<EndRecoveryInput> = {}): EndRecoveryInput {
  return { lastPointMs: NOW - 5 * 60 * 60_000, startedAtMs: STARTED, now: NOW, ...over };
}

describe("when the offer can be made", () => {
  it("recovers the last recorded fix's time", () => {
    // The whole point: a ride abandoned at 4:12pm and recovered at 9pm is
    // otherwise reported as a FIVE-HOUR ride.
    const offer = endRecoveryOffer(input())!;
    expect(offer.endedAtMs).toBe(NOW - 5 * 60 * 60_000);
    expect(offer.agoLabel).toBe("about 5 hours ago");
    expect(offer.timeLabel).toMatch(/\d/);
  });

  it("scales the 'ago' wording from minutes to days", () => {
    expect(endRecoveryOffer(input({ lastPointMs: NOW - 20 * 60_000 }))!.agoLabel).toBe(
      "about 20 minutes ago",
    );
    expect(endRecoveryOffer(input({ lastPointMs: NOW - 60 * 60_000 }))!.agoLabel).toBe(
      "about 1 hour ago",
    );
    expect(
      endRecoveryOffer(input({ lastPointMs: NOW - 48 * 60 * 60_000, startedAtMs: NOW - 50 * 60 * 60_000 }))!
        .agoLabel,
    ).toBe("about 2 days ago");
  });
});

describe("when it must NOT be made", () => {
  it("stays silent when this device recorded nothing", () => {
    // The prompt's other trigger is a ride started on a DIFFERENT device, where
    // this one has no track at all and no business guessing when it ended.
    expect(endRecoveryOffer(input({ lastPointMs: null }))).toBeNull();
  });

  it("stays silent when the gap is too small to be worth a second button", () => {
    // Below the floor, the recovered time and "now" are the same answer.
    expect(endRecoveryOffer(input({ lastPointMs: NOW - 30_000 }))).toBeNull();
    expect(endRecoveryOffer(input({ lastPointMs: NOW - MIN_RECOVERABLE_GAP_MS + 1 }))).toBeNull();
    expect(endRecoveryOffer(input({ lastPointMs: NOW - MIN_RECOVERABLE_GAP_MS }))).not.toBeNull();
  });

  it("stays silent on a last point before the ride began", () => {
    // That is a clock problem, not a recovery — and a wrong `ended_at` offered
    // confidently is worse than the `now()` it replaces.
    expect(endRecoveryOffer(input({ lastPointMs: STARTED - 1000 }))).toBeNull();
    expect(endRecoveryOffer(input({ lastPointMs: STARTED }))).toBeNull();
  });

  it("stays silent on a last point in the future", () => {
    expect(endRecoveryOffer(input({ lastPointMs: NOW + 60_000 }))).toBeNull();
  });

  it("stays silent on a non-finite figure rather than throwing while rendering", () => {
    // `Intl.DateTimeFormat` throws a RangeError on a bad instant, and a prompt
    // that throws while rendering leaves the rider with no way to end their ride
    // at all — the one outcome worse than a late timestamp.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(endRecoveryOffer(input({ lastPointMs: bad })), String(bad)).toBeNull();
      expect(endRecoveryOffer(input({ startedAtMs: bad })), String(bad)).toBeNull();
      expect(endRecoveryOffer(input({ now: bad })), String(bad)).toBeNull();
    }
  });
});

describe("the metadata marks what was recovered and what was not", () => {
  it("names the source of each field, flat and enumerated", () => {
    // So a consumer can filter on it without parsing prose, and can tell a
    // recovered timestamp from a witnessed one.
    const offer = endRecoveryOffer(input())!;
    expect(offer.metadata).toEqual({
      ended_at_source: "last_recorded_fix",
      end_position_source: "reporting_device_now",
      recovered_gap_seconds: 5 * 60 * 60,
    });
  });
});

describe("the copy says what it cannot recover", () => {
  it("names the time, and then that the place is NOT recovered", () => {
    // `EndRideIn` requires end_lat/end_lon, so something goes in them, and the
    // only position available is where the rider is standing now. Quietly sending
    // that under a recovered timestamp would trade one wrong field for another
    // and call it a fix.
    const text = endRecoveryCopy(endRecoveryOffer(input())!);
    expect(text).toContain("about 5 hours ago");
    expect(text).toContain("not the place");
    expect(text).toContain("where you are now");
    // And it puts the recovery first: the caveat is the part a rider would
    // otherwise assume, so it reads after the offer rather than instead of it.
    expect(text.indexOf("ride length")).toBeLessThan(text.indexOf("not the place"));
  });
});
