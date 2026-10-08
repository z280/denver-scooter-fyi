// @vitest-environment happy-dom
//
// Dibs. What is pinned here is mostly the TIMESTAMP, because the timestamp is
// the entire feature: two people at one scooter settle it by whose claim is
// older, and everything that could quietly move that number is a bug.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIBS_KEY,
  DIBS_MAX_TOTAL_MS,
  DIBS_MAX_WALK_MINUTES,
  DIBS_PROGRESS_METERS,
  DIBS_START_GRACE_MS,
  callDibs,
  dibsExpiresAt,
  dibsMsLeft,
  isClaimable,
  recordProgress,
  saveDibs,
  denverStamp,
  dibsAge,
  dibsOn,
  dropDibs,
  loadDibs,
  registerClaim,
  setDibsReleaseHook,
  _resetDibsRegistrationsForTests,
} from "./dibs.ts";

const CLAIM = {
  vehicleIdentifier: "abc123",
  vehicleName: "Lunar 🐸 928",
  plate: "1020922",
  claimedBy: "Resourceful 🌈",
  startMeters: 600,
  lat: 39.7392,
  lon: -104.9903,
};

const T0 = Date.UTC(2026, 7, 12, 20, 34, 56); // a fixed instant

beforeEach(() => localStorage.clear());

describe("calling dibs", () => {
  it("records who, what and when", () => {
    const d = callDibs(CLAIM, T0);
    expect(d).toMatchObject({ ...CLAIM, claimedAt: T0 });
  });

  it("KEEPS the original timestamp when the same scooter is claimed again", () => {
    // The earlier claim is the whole asset. A second tap quietly resetting it
    // to now would throw away the only thing dibs is good for — and a rider
    // re-opening the popup taps it again constantly.
    callDibs(CLAIM, T0);
    const again = callDibs(CLAIM, T0 + 5 * 60_000);
    expect(again.claimedAt).toBe(T0);
  });

  it("lets a rider hold dibs on more than one scooter", () => {
    // Walking past three of them and hedging is exactly what people do.
    callDibs(CLAIM, T0);
    callDibs({ ...CLAIM, vehicleIdentifier: "def456", vehicleName: "Solar 🦊 114" }, T0 + 1000);
    expect(loadDibs(T0 + 2000)).toHaveLength(2);
  });

  it("can be dropped", () => {
    callDibs(CLAIM, T0);
    expect(dropDibs("abc123", T0)).toEqual([]);
    expect(dibsOn("abc123", T0)).toBeNull();
  });
});

describe("rule 1 — ten minutes to set off", () => {
  it("dies if the rider never starts walking", () => {
    // Not ten minutes to ARRIVE. Ten minutes to set off. Standing still is
    // the only thing this punishes.
    callDibs(CLAIM, T0);
    expect(dibsOn("abc123", T0 + DIBS_START_GRACE_MS - 1000)).not.toBeNull();
    expect(dibsOn("abc123", T0 + DIBS_START_GRACE_MS + 1000)).toBeNull();
  });

  it("survives past the grace once they are actually moving", () => {
    const d = callDibs(CLAIM, T0);
    saveDibs(recordProgress(d, 600 - DIBS_PROGRESS_METERS, T0 + 60_000), T0 + 60_000);
    expect(dibsOn("abc123", T0 + DIBS_START_GRACE_MS + 60_000)).not.toBeNull();
  });

  it("does not count GPS wander as setting off", () => {
    // A phone on a table drifts tens of metres. Passing rule 1 by standing
    // still would make the rule decorative.
    const d = callDibs(CLAIM, T0);
    const nudged = recordProgress(d, 600 - (DIBS_PROGRESS_METERS - 5), T0 + 60_000);
    expect(nudged.startedWalkingAt).toBeNull();
  });

  it("does not un-start somebody who wandered back out", () => {
    // GPS wanders and the rule is about intent, not about walking a straight
    // line.
    const d = callDibs(CLAIM, T0);
    const moving = recordProgress(d, 500, T0 + 60_000);
    const back = recordProgress(moving, 560, T0 + 90_000);
    expect(back.startedWalkingAt).toBe(moving.startedWalkingAt);
    expect(back.bestMeters).toBe(500);
  });
});

describe("rule 2 — reach and ceiling", () => {
  it("refuses a claim on something too far to walk to", () => {
    expect(isClaimable(DIBS_MAX_WALK_MINUTES)).toBe(true);
    expect(isClaimable(DIBS_MAX_WALK_MINUTES + 1)).toBe(false);
  });

  it("never lets a claim outlive the hard ceiling, however well they walk", () => {
    const d = callDibs(CLAIM, T0);
    const moving = recordProgress(d, 100, T0 + 60_000);
    expect(dibsExpiresAt(moving)).toBe(T0 + DIBS_MAX_TOTAL_MS);
    expect(dibsMsLeft(moving, T0 + DIBS_MAX_TOTAL_MS + 1)).toBe(0);
  });

  it("the ceiling is the grace plus the longest allowed walk", () => {
    // 10 + 15. The number is not arbitrary and should not drift apart.
    expect(DIBS_MAX_TOTAL_MS).toBe(
      DIBS_START_GRACE_MS + DIBS_MAX_WALK_MINUTES * 60_000,
    );
  });
});

describe("the timestamp a person reads out loud", () => {
  it("is Denver time regardless of the phone's zone", () => {
    // A traveller's phone set to New York would print an hour ahead of every
    // other certificate at that intersection — and which claim came first is
    // the one thing this artifact has to get right.
    const stamp = denverStamp(T0);
    expect(stamp).toMatch(/MDT|MST/);
    expect(stamp).toContain("2:34");   // 20:34 UTC is 14:34 in Denver (MDT)
  });

  it("shows seconds, because two claims land in the same minute easily", () => {
    expect(denverStamp(T0)).toContain(":56");
  });
});

describe("storage discipline", () => {
  it("degrades to no dibs on a corrupt blob", () => {
    localStorage.setItem(DIBS_KEY, "{not json");
    expect(loadDibs(T0)).toEqual([]);
  });

  it("degrades on a version it does not know", () => {
    localStorage.setItem(DIBS_KEY, JSON.stringify({ v: 9, dibs: [] }));
    expect(loadDibs(T0)).toEqual([]);
  });

  it("drops entries with no timestamp rather than trusting them", () => {
    // A claim with no time is not a claim; it is a certificate that would win
    // every argument.
    localStorage.setItem(
      DIBS_KEY,
      JSON.stringify({
        v: 1,
        dibs: [
          { ...CLAIM, bestMeters: 600, startedWalkingAt: null },
          { ...CLAIM, vehicleIdentifier: "ok", claimedAt: T0,
            bestMeters: 600, startedWalkingAt: null },
        ],
      }),
    );
    expect(loadDibs(T0).map((d) => d.vehicleIdentifier)).toEqual(["ok"]);
  });
});

describe("age", () => {
  it("reads naturally", () => {
    const d = callDibs(CLAIM, T0);
    expect(dibsAge(d, T0 + 5_000)).toBe("just now");
    expect(dibsAge(d, T0 + 7 * 60_000)).toBe("7 min ago");
  });
});


describe("giving a claim up tells the server", () => {
  // THE WATCH HAS TO BE DISARMED. Before this hook, four of the five release
  // buttons in the app dropped the phone's copy and told the server nothing,
  // so the row stayed live for up to twenty-five minutes: still dimming that
  // scooter on everybody else's map, and — once the SMS watch shipped — still
  // able to text the rider about a scooter they had deliberately given up. An
  // alert about an abandoned claim is the worst thing that channel can say.
  afterEach(() => setDibsReleaseHook(null));

  const registered = (vid: string) => {
    const d = callDibs({ ...CLAIM, vehicleIdentifier: vid }, T0);
    saveDibs(
      { ...d, registration: { id: `reg-${vid}`, verifyUrl: "u", qrUrl: "q" } },
      T0,
    );
  };

  it("fires with the claim that was dropped", () => {
    registered("abc123");
    const released = vi.fn();
    setDibsReleaseHook(released);

    dropDibs("abc123", T0);

    expect(released).toHaveBeenCalledTimes(1);
    expect(released.mock.calls[0][0].registration.id).toBe("reg-abc123");
  });

  it("fires only for the claim dropped, when several are held", () => {
    // "I'm switching scooters" releases what is held and claims the new one.
    // Releasing the wrong row would disarm a watch the rider still wants and
    // leave armed the one they just abandoned.
    registered("keep-me");
    registered("drop-me");
    const released = vi.fn();
    setDibsReleaseHook(released);

    dropDibs("drop-me", T0);

    expect(released).toHaveBeenCalledTimes(1);
    expect(released.mock.calls[0][0].vehicleIdentifier).toBe("drop-me");
    expect(loadDibs(T0).map((d) => d.vehicleIdentifier)).toEqual(["keep-me"]);
  });

  it("does not fire for a vehicle no claim was held on", () => {
    registered("abc123");
    const released = vi.fn();
    setDibsReleaseHook(released);

    dropDibs("never-claimed", T0);

    expect(released).not.toHaveBeenCalled();
  });

  it("does not fire on expiry", () => {
    // The server holds its own `expires_at` and reaches the same conclusion
    // on its own clock, so there is nothing to tell it — and a release call
    // per expired claim per read would be a lot of nothing.
    callDibs(CLAIM, T0);
    const released = vi.fn();
    setDibsReleaseHook(released);

    expect(loadDibs(T0 + DIBS_MAX_TOTAL_MS + 1)).toEqual([]);
    expect(released).not.toHaveBeenCalled();
  });

  it("still drops the local copy when the hook throws", () => {
    // The local drop is what the rider just watched happen. A network layer
    // having a bad day must not put the claim back on their screen.
    registered("abc123");
    setDibsReleaseHook(() => {
      throw new Error("offline");
    });

    expect(() => dropDibs("abc123", T0)).not.toThrow();
    expect(loadDibs(T0)).toEqual([]);
  });

  it("is a no-op when nothing is listening", () => {
    registered("abc123");
    setDibsReleaseHook(null);
    expect(() => dropDibs("abc123", T0)).not.toThrow();
    expect(loadDibs(T0)).toEqual([]);
  });
});


describe("registration that lands after the rider has moved on", () => {
  // REGISTRATION IS A ROUND TRIP, and riders do not wait for it. Drop, switch
  // scooters, back out of the walk, "it won't ride" — any of them can happen
  // while the POST is in flight, and at that moment the local claim has no row
  // id, so `dropDibs`'s release hook has nothing to send. Whatever the
  // completion then does decides whether a live, watched, unreleasable row is
  // left behind.
  afterEach(() => {
    setDibsReleaseHook(null);
    _resetDibsRegistrationsForTests();
  });

  const REG = { id: "reg-1", verifyUrl: "https://v", qrUrl: "https://q" };

  /** A POST we resolve by hand, so the gap is a real one. */
  function deferred() {
    let settle: (r: typeof REG) => void = () => {};
    const promise = new Promise<typeof REG>((ok) => {
      settle = ok;
    });
    return { post: () => promise, settle };
  }

  it("attaches the row when the claim is still held", () => {
    const claim = callDibs(CLAIM, T0);
    const { post, settle } = deferred();
    registerClaim(claim, post, () => T0);

    settle(REG);
    return Promise.resolve().then(() => {
      expect(dibsOn(CLAIM.vehicleIdentifier, T0)?.registration).toEqual(REG);
    });
  });

  it("does not resurrect a claim dropped while the request was in flight", async () => {
    const claim = callDibs(CLAIM, T0);
    const { post, settle } = deferred();
    registerClaim(claim, post, () => T0);

    dropDibs(CLAIM.vehicleIdentifier, T0);
    expect(loadDibs(T0)).toEqual([]);

    settle(REG);
    await Promise.resolve();
    await Promise.resolve();

    // Still gone. The old shape wrote it straight back.
    expect(loadDibs(T0)).toEqual([]);
  });

  it("releases the row it just created, since nothing else can", async () => {
    // The drop could not release it — there was no id yet. This completion is
    // the only moment the id and the knowledge that it is unwanted coexist.
    const claim = callDibs(CLAIM, T0);
    const released = vi.fn();
    setDibsReleaseHook(released);
    const { post, settle } = deferred();
    registerClaim(claim, post, () => T0);

    dropDibs(CLAIM.vehicleIdentifier, T0);
    expect(released).not.toHaveBeenCalled(); // no id to send yet

    settle(REG);
    await Promise.resolve();
    await Promise.resolve();

    expect(released).toHaveBeenCalledTimes(1);
    expect(released.mock.calls[0][0].registration).toEqual(REG);
  });

  it("does not hand a re-claim the old claim's certificate", async () => {
    // Dropped and claimed again is a DIFFERENT claim with its own timestamp.
    // Matching on the vehicle alone would staple this row to it.
    const claim = callDibs(CLAIM, T0);
    const released = vi.fn();
    setDibsReleaseHook(released);
    const { post, settle } = deferred();
    registerClaim(claim, post, () => T0);

    dropDibs(CLAIM.vehicleIdentifier, T0);
    const fresh = callDibs(CLAIM, T0 + 1_000);

    settle(REG);
    await Promise.resolve();
    await Promise.resolve();

    expect(dibsOn(CLAIM.vehicleIdentifier, T0 + 1_000)?.registration).toBeNull();
    expect(dibsOn(CLAIM.vehicleIdentifier, T0 + 1_000)?.claimedAt).toBe(fresh.claimedAt);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("keeps progress recorded while the request was in flight", async () => {
    // The old shape wrote back the snapshot captured at claim time, throwing
    // away any `recordProgress` that landed during the round trip.
    const claim = callDibs(CLAIM, T0);
    const { post, settle } = deferred();
    registerClaim(claim, post, () => T0);

    saveDibs({ ...claim, bestMeters: 42, startedWalkingAt: T0 }, T0);

    settle(REG);
    await Promise.resolve();
    await Promise.resolve();

    const held = dibsOn(CLAIM.vehicleIdentifier, T0)!;
    expect(held.registration).toEqual(REG);
    expect(held.bestMeters).toBe(42);
    expect(held.startedWalkingAt).toBe(T0);
  });

  it("registers a scooter once, even when two paths both ask", async () => {
    // The popup claims and registers; the walk's auto-dibs then calls
    // `callDibs`, which is idempotent and hands back a claim whose
    // registration has not landed. Both used to POST, and the loser's row was
    // orphaned — live, watched, and releasable by nothing.
    const claim = callDibs(CLAIM, T0);
    const first = deferred();
    const second = vi.fn();
    registerClaim(claim, first.post, () => T0);
    registerClaim(claim, second, () => T0);

    expect(second).not.toHaveBeenCalled();

    first.settle(REG);
    await Promise.resolve();
    await Promise.resolve();
    expect(dibsOn(CLAIM.vehicleIdentifier, T0)?.registration).toEqual(REG);
  });

  it("lets a later attempt through once the first has settled", async () => {
    const claim = callDibs(CLAIM, T0);
    const first = deferred();
    registerClaim(claim, first.post, () => T0);
    first.settle(REG);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A claim with no registration (say the first POST had failed) must still
    // be registerable afterwards — the in-flight guard is not a permanent one.
    const bare = callDibs({ ...CLAIM, vehicleIdentifier: "other" }, T0);
    const again = vi.fn().mockResolvedValue(REG);
    registerClaim(bare, again, () => T0);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("never registers a claim that already has a row", () => {
    const claim = callDibs(CLAIM, T0);
    saveDibs({ ...claim, registration: REG }, T0);
    const post = vi.fn();
    registerClaim(dibsOn(CLAIM.vehicleIdentifier, T0)!, post, () => T0);
    expect(post).not.toHaveBeenCalled();
  });

  it("leaves the claim alone when the POST fails", async () => {
    const claim = callDibs(CLAIM, T0);
    const released = vi.fn();
    setDibsReleaseHook(released);
    registerClaim(claim, () => Promise.reject(new Error("offline")), () => T0);
    await Promise.resolve();
    await Promise.resolve();

    expect(dibsOn(CLAIM.vehicleIdentifier, T0)?.registration).toBeNull();
    expect(released).not.toHaveBeenCalled();
  });
});
