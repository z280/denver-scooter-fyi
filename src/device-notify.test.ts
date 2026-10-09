// @vitest-environment happy-dom
//
// "Notify me if moved" — the store, the verdict, and the one alert per scooter.
// See `device-notify.ts`'s header for what this replaced and why the question
// flipped from "remember this scooter" to "tell me when it goes".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_WATCHED_DEVICES,
  MISSING_TICKS_BEFORE_GONE,
  MOVED_METERS,
  NOTIFY_MOVED_KEY,
  WATCH_RULES,
  addWatch,
  createDeviceNotifier,
  dropAdminWatches,
  isAlertable,
  isWatched,
  loadWatches,
  movedMessage,
  movedVerdict,
  removeWatch,
  resetWatchSession,
  unwatchMoved,
  watchMoved,
  watchSlotsLeft,
  type DeviceNow,
  type WatchedDevice,
} from "./device-notify.ts";

const LAT = 39.74;
const LON = -104.99;

function watch(over: Partial<WatchedDevice> = {}): WatchedDevice {
  return {
    vehicleIdentifier: "0123456789abcdef",
    name: "Lunar 🐸 928",
    lat: LAT,
    lon: LON,
    since: 1_700_000_000_000,
    // A dibs-origin watch, far-future expiry: the default fixture is a LIVE
    // watch, so a case that cares about expiry or origin says so explicitly.
    origin: "dibs",
    expiresAt: 4_000_000_000_000,
    ...over,
  };
}

/** Roughly `m` metres due east of the watch point. At Denver's latitude a
 *  degree of longitude is about 85 km. */
function eastOf(m: number): DeviceNow {
  return { lat: LAT, lon: LON + m / (111_320 * Math.cos((LAT * Math.PI) / 180)), inUse: false };
}

beforeEach(() => {
  localStorage.clear();
  resetWatchSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  resetWatchSession();
  document.body.replaceChildren();
});

describe("the verdict", () => {
  it("says nothing about a scooter that has not moved", () => {
    const v = movedVerdict(watch(), eastOf(5), 0);
    expect(v).toEqual({ kind: "still" });
    expect(isAlertable(v)).toBe(false);
  });

  it("tolerates the drift a parked scooter's GPS produces", () => {
    // 50 m is measured, not chosen: the API's own ride_watch.py recorded 0.2%
    // of parked-fleet steps crossing it, against 68% of ridden ones. A false
    // positive here buzzes a phone about a scooter that never left, and the
    // second time that happens the alert stops being believed.
    for (const m of [0, 5, 12, 30, MOVED_METERS - 2]) {
      expect(movedVerdict(watch(), eastOf(m), 0).kind).toBe("still");
    }
  });

  it("draws the line at the number the texted tier puts in front of riders", () => {
    // The SMS says "no longer within 50m of where you scanned" in so many
    // words (ALONG_THE_WAY_PLAN §9.7). A rider who gets the text and then opens
    // the app is the common case, so this constant and that sentence cannot be
    // allowed to drift apart.
    expect(MOVED_METERS).toBe(50);
  });

  it("calls it moved past the threshold, and says how far", () => {
    const v = movedVerdict(watch(), eastOf(MOVED_METERS + 40), 0);
    expect(v.kind).toBe("moved");
    if (v.kind === "moved") expect(v.meters).toBeGreaterThan(MOVED_METERS);
    expect(isAlertable(v)).toBe(true);
  });

  it("prefers 'in use' over 'moved' — the more certain, more useful claim", () => {
    // Veo's feed admits the rental before the position changes, and "someone's
    // riding it" is what a rider can act on.
    const v = movedVerdict(
      watch(),
      { ...eastOf(MOVED_METERS + 100), inUse: true },
      0,
    );
    expect(v).toEqual({ kind: "in_use" });
  });

  it("does not call one absent response gone", () => {
    // GBFS feeds drop and re-add vehicles between polls for reasons that have
    // nothing to do with anybody riding them — the same rule, for the same
    // reason, as device-watch.ts's.
    for (let n = 0; n < MISSING_TICKS_BEFORE_GONE; n += 1) {
      expect(movedVerdict(watch(), undefined, n).kind).toBe("still");
    }
    expect(movedVerdict(watch(), undefined, MISSING_TICKS_BEFORE_GONE).kind).toBe(
      "gone",
    );
  });
});

describe("the message", () => {
  it("carries no location, ever", () => {
    // ALONG_THE_WAY_PLAN §4.4: a lock-screen notification carrying coordinates
    // is one carrying somebody's whereabouts, on a screen anybody nearby can
    // read. The rider opens the app to see where, which they were going to do.
    const verdicts = [
      { kind: "moved" as const, meters: 412 },
      { kind: "in_use" as const },
      { kind: "gone" as const },
    ];
    for (const v of verdicts) {
      const text = movedMessage("Lunar 🐸 928", v);
      expect(text).toContain("Lunar 🐸 928");
      expect(text).not.toMatch(/\d+\s*m\b/);
      expect(text).not.toContain(String(LAT));
      expect(text).not.toContain("412");
    }
  });

  it("says something different for each reason", () => {
    const texts = [
      movedMessage("x", { kind: "moved", meters: 100 }),
      movedMessage("x", { kind: "in_use" }),
      movedMessage("x", { kind: "gone" }),
    ];
    expect(new Set(texts).size).toBe(3);
  });
});

describe("the list rules", () => {
  it("puts the newest first", () => {
    const a = watch({ vehicleIdentifier: "a".repeat(16), name: "A" });
    const b = watch({ vehicleIdentifier: "b".repeat(16), name: "B" });
    expect(addWatch(addWatch([], a), b).map((w) => w.name)).toEqual(["B", "A"]);
  });

  it("re-arming the same vehicle replaces rather than duplicating", () => {
    const first = watch({ lat: LAT, lon: LON });
    const again = watch({ lat: LAT + 0.01, lon: LON + 0.01 });
    const list = addWatch(addWatch([], first), again);
    expect(list).toHaveLength(1);
    // The new position is the one the next comparison runs against — that is
    // what re-tapping the bell on a moved scooter is FOR.
    expect(list[0].lat).toBe(again.lat);
  });

  it("caps each origin separately, dropping that origin's oldest", () => {
    // PER ORIGIN, not overall. The two are different capabilities with
    // different justifications (`device-notify.ts`'s header), and a shared cap
    // would let a third claimed scooter evict the watch on the one the rider
    // just rode.
    let list: WatchedDevice[] = [];
    for (let i = 0; i < WATCH_RULES.dibs.max + 2; i += 1) {
      list = addWatch(list, watch({
        vehicleIdentifier: String(i).padStart(16, "0"),
        name: `claim${i}`,
        origin: "dibs",
      }));
    }
    expect(list).toHaveLength(WATCH_RULES.dibs.max);
    // Newest kept, oldest gone — the claim they set off for first.
    expect(list[0].name).toBe(`claim${WATCH_RULES.dibs.max + 1}`);
    expect(list.some((w) => w.name === "claim0")).toBe(false);

    // The ride-end slot is untouched by any of that, and has its own ceiling.
    list = addWatch(list, watch({
      vehicleIdentifier: "e".repeat(16),
      name: "ridden",
      origin: "ride_end",
    }));
    expect(list).toHaveLength(WATCH_RULES.dibs.max + 1);
    expect(list.filter((w) => w.origin === "dibs")).toHaveLength(
      WATCH_RULES.dibs.max,
    );
    list = addWatch(list, watch({
      vehicleIdentifier: "f".repeat(16),
      name: "ridden-again",
      origin: "ride_end",
    }));
    const rideEnd = list.filter((w) => w.origin === "ride_end");
    expect(rideEnd).toHaveLength(WATCH_RULES.ride_end.max);
    expect(rideEnd[0].name).toBe("ridden-again");
  });

  it("reports the slots left, per origin, ignoring the expired", () => {
    const now = 1_000_000;
    const live = watch({ origin: "dibs", expiresAt: now + 1000 });
    const dead = watch({
      vehicleIdentifier: "b".repeat(16),
      origin: "dibs",
      expiresAt: now - 1,
    });
    expect(watchSlotsLeft([], "dibs", now)).toBe(WATCH_RULES.dibs.max);
    // An expired watch is not occupying anything.
    expect(watchSlotsLeft([live, dead], "dibs", now)).toBe(
      WATCH_RULES.dibs.max - 1,
    );
    expect(watchSlotsLeft([live, dead], "ride_end", now)).toBe(
      WATCH_RULES.ride_end.max,
    );
  });

  // -------------------------------------------------------------------------
  // Expiry. This is the half of the design that makes the feature not a
  // surveillance subscription — see the module header. A watch that outlives
  // the rider's connection to the vehicle is the thing being prevented.
  // -------------------------------------------------------------------------

  it("drops expired watches on read", () => {
    const now = 2_000_000;
    localStorage.setItem(
      NOTIFY_MOVED_KEY,
      JSON.stringify({
        v: 1,
        watches: [
          watch({ vehicleIdentifier: "a".repeat(16), expiresAt: now + 1 }),
          watch({ vehicleIdentifier: "b".repeat(16), expiresAt: now }),
          watch({ vehicleIdentifier: "c".repeat(16), expiresAt: now - 60_000 }),
        ],
      }),
    );
    const live = loadWatches(now);
    expect(live.map((w) => w.vehicleIdentifier)).toEqual(["a".repeat(16)]);
  });

  it("treats a watch with no origin or no expiry as corrupt", () => {
    // Rows written by the version of this feature that had neither. They
    // described an unbounded watch armable from anywhere, so they are dropped
    // rather than migrated — there is no expiry to infer that would be honest.
    localStorage.setItem(
      NOTIFY_MOVED_KEY,
      JSON.stringify({
        v: 1,
        watches: [
          {
            vehicleIdentifier: "a".repeat(16),
            name: "legacy",
            lat: LAT,
            lon: LON,
            since: 1,
          },
          { ...watch({ vehicleIdentifier: "b".repeat(16) }), origin: "map" },
        ],
      }),
    );
    expect(loadWatches()).toEqual([]);
  });

  it("removes by identifier and leaves the rest alone", () => {
    const a = watch({ vehicleIdentifier: "a".repeat(16), name: "A" });
    const b = watch({ vehicleIdentifier: "b".repeat(16), name: "B" });
    const list = addWatch(addWatch([], a), b);
    expect(removeWatch(list, a.vehicleIdentifier).map((w) => w.name)).toEqual(["B"]);
    expect(removeWatch(list, "nope".repeat(4))).toHaveLength(2);
  });
});

describe("the store", () => {
  it("round-trips a watch", () => {
    watchMoved(watch());
    resetWatchSession();
    const loaded = loadWatches();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(watch());
    expect(isWatched(loaded, watch().vehicleIdentifier)).toBe(true);
  });

  it("forgets one", () => {
    watchMoved(watch());
    expect(unwatchMoved(watch().vehicleIdentifier)).toHaveLength(0);
    resetWatchSession();
    expect(loadWatches()).toHaveLength(0);
  });

  it("degrades to watching nothing on a corrupt or skewed blob", () => {
    for (const raw of [
      "not json",
      "{}",
      '{"v":2,"watches":[]}',
      '{"v":1,"watches":"nope"}',
      // A row missing its position is not a comparison, so it is not a watch.
      '{"v":1,"watches":[{"vehicleIdentifier":"0123456789abcdef","name":"x","since":1}]}',
      // A short identifier cannot be the server's 16-hex hash.
      '{"v":1,"watches":[{"vehicleIdentifier":"abc","name":"x","lat":1,"lon":2,"since":1}]}',
    ]) {
      localStorage.setItem(NOTIFY_MOVED_KEY, raw);
      resetWatchSession();
      expect(loadWatches()).toEqual([]);
    }
  });

  it("keeps the session coherent when storage refuses writes", () => {
    // Without the mirror the second add re-reads an empty store and the rider
    // watches the scooter they just added vanish from the list.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("private mode");
      },
      removeItem: () => {},
      clear: () => {},
    });
    resetWatchSession();
    watchMoved(watch({ vehicleIdentifier: "a".repeat(16), name: "A" }));
    watchMoved(watch({ vehicleIdentifier: "b".repeat(16), name: "B" }));
    expect(loadWatches().map((w) => w.name)).toEqual(["B", "A"]);
  });

  it("survives storage that throws on read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    resetWatchSession();
    expect(loadWatches()).toEqual([]);
  });
});

describe("the notifier", () => {
  function rig() {
    const inApp = vi.fn();
    const onOpen = vi.fn();
    const onFired = vi.fn();
    return {
      inApp,
      onOpen,
      onFired,
      notifier: createDeviceNotifier({ inApp, onOpen, onFired }),
    };
  }

  const lookupOf = (now: Record<string, DeviceNow | undefined>) =>
    (id: string) => now[id];

  it("says nothing about a scooter sitting where it was left", () => {
    const { notifier, inApp, onFired } = rig();
    const w = watch();
    notifier.check([w], lookupOf({ [w.vehicleIdentifier]: eastOf(3) }));
    // "We checked and it is fine" is not reassurance, it is attrition.
    expect(inApp).not.toHaveBeenCalled();
    expect(onFired).not.toHaveBeenCalled();
  });

  it("alerts once when it moves, and reports the verdict", () => {
    const { notifier, inApp, onFired } = rig();
    const w = watch();
    const lookup = lookupOf({ [w.vehicleIdentifier]: eastOf(300) });
    notifier.check([w], lookup);
    expect(inApp).toHaveBeenCalledTimes(1);
    expect(inApp.mock.calls[0][0]).toContain("has moved");
    expect(inApp.mock.calls[0][1]).toBe(w);
    expect(onFired.mock.calls[0][1].kind).toBe("moved");
  });

  it("never buzzes twice about the same scooter", () => {
    const { notifier, inApp } = rig();
    const w = watch();
    const lookup = lookupOf({ [w.vehicleIdentifier]: eastOf(300) });
    notifier.check([w], lookup);
    notifier.check([w], lookup);
    notifier.check([w], lookup);
    expect(inApp).toHaveBeenCalledTimes(1);
  });

  it("needs two absent responses before calling one gone", () => {
    const { notifier, inApp } = rig();
    const w = watch();
    const absent = lookupOf({});
    notifier.check([w], absent);
    expect(inApp).not.toHaveBeenCalled();
    notifier.check([w], absent);
    expect(inApp).toHaveBeenCalledTimes(1);
    expect(inApp.mock.calls[0][0]).toContain("dropped off the map");
  });

  it("a vehicle that comes back resets its miss count", () => {
    const { notifier, inApp } = rig();
    const w = watch();
    notifier.check([w], lookupOf({}));
    notifier.check([w], lookupOf({ [w.vehicleIdentifier]: eastOf(2) }));
    notifier.check([w], lookupOf({}));
    // One miss, then a sighting, then one miss — never two in a row.
    expect(inApp).not.toHaveBeenCalled();
  });

  it("forgets a vehicle's history, so a re-armed watch starts clean", () => {
    const { notifier, inApp } = rig();
    const w = watch();
    notifier.check([w], lookupOf({}));
    notifier.forget(w.vehicleIdentifier);
    notifier.check([w], lookupOf({}));
    // Without forget() the re-armed watch would inherit the miss count and
    // alert on its first absent tick.
    expect(inApp).not.toHaveBeenCalled();
  });

  it("drops the miss count for a vehicle nobody is watching any more", () => {
    const { notifier, inApp } = rig();
    const w = watch();
    notifier.check([w], lookupOf({}));
    // Stopped watching...
    notifier.check([], lookupOf({}));
    // ...and started again. The count must not have survived.
    notifier.check([w], lookupOf({}));
    expect(inApp).not.toHaveBeenCalled();
  });

  it("alerts about each watched scooter independently", () => {
    const { notifier, inApp } = rig();
    const a = watch({ vehicleIdentifier: "a".repeat(16), name: "A" });
    const b = watch({ vehicleIdentifier: "b".repeat(16), name: "B" });
    notifier.check(
      [a, b],
      lookupOf({
        [a.vehicleIdentifier]: eastOf(400),
        [b.vehicleIdentifier]: eastOf(1),
      }),
    );
    expect(inApp).toHaveBeenCalledTimes(1);
    expect(inApp.mock.calls[0][0]).toContain("A");
  });

  it("delivers in-app even with no Notification support at all", () => {
    vi.stubGlobal("Notification", undefined);
    const { notifier, inApp } = rig();
    const w = watch();
    notifier.check([w], lookupOf({ [w.vehicleIdentifier]: eastOf(300) }));
    // A rider who denied (or was never asked for) permission is the common
    // case, and must not be the one person who misses the message.
    expect(inApp).toHaveBeenCalledTimes(1);
  });

  it("still delivers in-app when constructing the notification throws", () => {
    class Boom {
      static permission = "granted";
      constructor() {
        throw new Error("no");
      }
    }
    vi.stubGlobal("Notification", Boom);
    const { notifier, inApp, onFired } = rig();
    const w = watch();
    notifier.check([w], lookupOf({ [w.vehicleIdentifier]: eastOf(300) }));
    expect(inApp).toHaveBeenCalledTimes(1);
    expect(onFired).toHaveBeenCalledTimes(1);
  });
});

describe("the admin watch rule (add by plate, admins only)", () => {
  const vid = (n: number) => n.toString(16).padStart(16, "0");

  it("is ten at once, for a day", () => {
    // A follow-up is a today job, and a list longer than ten is no longer read.
    expect(WATCH_RULES.admin).toEqual({ max: 10, ttlMs: 24 * 60 * 60_000 });
  });

  it("does not loosen the rider rules beside it", () => {
    expect(WATCH_RULES.dibs.max).toBe(2);
    expect(WATCH_RULES.ride_end).toEqual({ max: 1, ttlMs: 2 * 60 * 60_000 });
    expect(MAX_WATCHED_DEVICES).toBe(13);
  });

  it("caps admin watches at ten, dropping the oldest admin one and nothing else", () => {
    let list: WatchedDevice[] = [
      watch({ vehicleIdentifier: "d".repeat(16), origin: "dibs" }),
      watch({ vehicleIdentifier: "e".repeat(16), origin: "ride_end" }),
    ];
    for (let i = 1; i <= 11; i++) {
      list = addWatch(list, watch({ vehicleIdentifier: vid(i), origin: "admin", since: i }));
    }
    const admin = list.filter((w) => w.origin === "admin");
    expect(admin).toHaveLength(10);
    expect(admin.some((w) => w.vehicleIdentifier === vid(1))).toBe(false);
    expect(list.some((w) => w.origin === "dibs")).toBe(true);
    expect(list.some((w) => w.origin === "ride_end")).toBe(true);
    expect(watchSlotsLeft(list, "admin")).toBe(0);
    // ...and the rider's own slots are untouched by an admin's list.
    expect(watchSlotsLeft(list, "dibs")).toBe(1);
  });

  it("survives a storage round trip, and expires on its own clock", () => {
    const now = 1_800_000_000_000;
    watchMoved(watch({ origin: "admin", since: now, expiresAt: now + WATCH_RULES.admin.ttlMs }));
    expect(loadWatches(now + 60_000).map((w) => w.origin)).toEqual(["admin"]);
    expect(loadWatches(now + WATCH_RULES.admin.ttlMs + 1)).toEqual([]);
  });

  it("is dropped, alone, when the session stops being an admin's", () => {
    watchMoved(watch({ vehicleIdentifier: "a".repeat(16), origin: "dibs" }));
    watchMoved(watch({ vehicleIdentifier: "b".repeat(16), origin: "admin" }));
    const next = dropAdminWatches();
    expect(next.map((w) => w.origin)).toEqual(["dibs"]);
    expect(loadWatches().map((w) => w.origin)).toEqual(["dibs"]);
  });
});
