// ride-session: the reducer's legal and non-linear transitions, the end-report
// invariant, persistence, and the full reload-recovery decision table. Every
// server and IndexedDB read is a plain injected fake — nothing here touches the
// network, the DOM or real storage.
import { describe, expect, it, vi } from "vitest";

import type { RideOptions, TrackedRide } from "./api.ts";
import type { TrackTip } from "./track-store.ts";
import {
  RIDE_SESSION_KEY,
  RIDE_SESSION_VERSION,
  blankRideSession,
  createRideSessionStore,
  endReportOwner,
  isRideLive,
  localRideSessionStorage,
  memoryRideSessionStorage,
  parseRideSession,
  phaseOf,
  recoverRideSession,
  recoveryForServerConflict,
  reduceRideSession,
  serializeRideSession,
  shouldShowEligibility,
  shouldShowSurvey,
  surveyPanes,
  type RideAction,
  type RideEffect,
  type RideRecoveryDeps,
  type RideScreenId,
  type RideSessionDoc,
  type RideState,
} from "./ride-session.ts";

const RIDE_ID = "7f3d1c2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const VEHICLE = "a1b2c3d4e5f60718";

const OPTIONS: RideOptions = {
  cost_hud: true,
  speedometer: "digital",
  theme: "auto",
  navigation: true,
  save_tracks: true,
  battery_modeling: true,
  nav_improvement: true,
  end_survey: true,
  own_device: false,
};

function docAt(
  state: RideState,
  screen: RideScreenId | null,
  over: Partial<RideSessionDoc> = {},
): RideSessionDoc {
  return { ...blankRideSession(OPTIONS), state, screen, ...over };
}

const ROUTE = {
  profile: "safe",
  rideRouteId: "route-1",
  distanceM: 4312,
  durationS: 900,
  polyline: "_p~iF~ps|U",
  maneuvers: [],
};

const DEST = { label: "1701 Champa St, Denver", lat: 39.747, lon: -104.992 };

/** A doc mid-ride on a tracked Veo ride, the state most of the table is about. */
function ridingDoc(over: Partial<RideSessionDoc> = {}): RideSessionDoc {
  return docAt("riding", null, {
    rideId: RIDE_ID,
    trackKeyId: RIDE_ID,
    startedAtMs: 1_784_134_800_000,
    device: {
      vehicleIdentifier: VEHICLE,
      plate: "123456",
      model: "Cosmo",
      batteryConfirmed: 82,
    },
    dest: DEST,
    route: ROUTE,
    ...over,
  });
}

function trackedRide(over: Partial<TrackedRide> = {}): TrackedRide {
  return {
    id: RIDE_ID,
    status: "watching",
    started_at: "2026-07-15T16:59:55.000Z",
    start_lat: 39.74,
    start_lon: -104.99,
    watch_expires_at: "2026-07-15T19:59:55.000Z",
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
    vehicle_identifier: VEHICLE,
    created_at: "2026-07-15T16:59:55.000Z",
    updated_at: "2026-07-15T16:59:55.000Z",
    distance_meters: null,
    distance_source: null,
    ...over,
  };
}

function tip(over: Partial<TrackTip> = {}): TrackTip {
  return {
    trackId: RIDE_ID,
    nextSeq: 5,
    prevJwsHash: "a".repeat(64),
    chainHash: "b".repeat(64),
    batchCount: 5,
    waypointCount: 102,
    pendingCount: 0,
    lastPointMs: 1_784_135_075_000,
    ...over,
  };
}

function notFound(): Error {
  return Object.assign(new Error("No data (404)"), { status: 404 });
}

function fakeDeps(over: Partial<RideRecoveryDeps> = {}): RideRecoveryDeps {
  return {
    doc: null,
    getActiveRide: async () => null,
    getTrackedRide: async () => {
      throw notFound();
    },
    readTrackTip: async () => null,
    ...over,
  };
}

function effectKinds(effects: RideEffect[]): string[] {
  return effects.map((e) => e.kind);
}

describe("phase naming", () => {
  it("uses the spec's own composite names", () => {
    expect(phaseOf(docAt("idle", null))).toBe("idle");
    expect(phaseOf(docAt("wizard", "2.5"))).toBe("wizard:2.5");
    expect(phaseOf(docAt("countdown", "6"))).toBe("countdown");
    expect(phaseOf(docAt("ending", "8"))).toBe("ending(8)");
    expect(phaseOf(docAt("survey", "9"))).toBe("survey(9)");
    expect(phaseOf(docAt("eligibility", "10"))).toBe("eligibility(10)");
    expect(phaseOf(docAt("done", null))).toBe("done");
  });

  it("counts the New Destination loop's wizard screens as a live ride", () => {
    expect(isRideLive(ridingDoc())).toBe(true);
    expect(isRideLive(docAt("countdown", "6", { rideId: RIDE_ID }))).toBe(true);
    expect(isRideLive(docAt("wizard", "3", { rideId: RIDE_ID }))).toBe(true);
    expect(isRideLive(docAt("wizard", "4", { rideId: RIDE_ID }))).toBe(true);
    // The same screens WITHOUT a rideId are just the ordinary wizard.
    expect(isRideLive(docAt("wizard", "3"))).toBe(false);
    expect(isRideLive(docAt("wizard", "1"))).toBe(false);
  });
});

describe("the linear path", () => {
  it("walks idle → wizard → countdown → riding → 8 → 9 → 10 → done", () => {
    const store = createRideSessionStore({
      storage: memoryRideSessionStorage(),
    });
    const phases: string[] = [];
    const push = (action: RideAction) => {
      const t = store.dispatch(action);
      expect(t?.accepted).toBe(true);
      phases.push(t?.to ?? "?");
    };

    push({ type: "open", options: OPTIONS });
    push({ type: "goto", screen: "2" });
    push({ type: "goto", screen: "2.5" });
    push({ type: "goto", screen: "2" });
    push({
      type: "setDevice",
      device: {
        vehicleIdentifier: VEHICLE,
        plate: "123456",
        model: "Cosmo",
        batteryConfirmed: 82,
      },
    });
    push({ type: "goto", screen: "3" });
    push({ type: "setDest", dest: DEST });
    push({ type: "goto", screen: "4" });
    push({ type: "setRoute", route: ROUTE });
    push({ type: "goto", screen: "6" });
    push({ type: "startCountdown" });
    push({
      type: "rideStarted",
      rideId: RIDE_ID,
      startedAtMs: 1_784_134_800_000,
      trackKeyId: RIDE_ID,
    });
    push({ type: "endRide" });
    push({ type: "endReported", facts: { hasWaypoints: true } });
    push({ type: "surveyDone", facts: { hasWaypoints: true } });
    push({ type: "eligibilityDone" });

    expect(phases).toEqual([
      "wizard:1",
      "wizard:2",
      "wizard:2.5",
      "wizard:2",
      "wizard:2",
      "wizard:3",
      "wizard:3",
      "wizard:4",
      "wizard:4",
      "wizard:6",
      "countdown",
      "riding",
      "ending(8)",
      "survey(9)",
      "eligibility(10)",
      "done",
    ]);
    expect(store.current()).toMatchObject({
      state: "done",
      rideId: RIDE_ID,
      trackKeyId: RIDE_ID,
      dest: DEST,
      route: ROUTE,
    });
  });

  it("fast-forwards to Screen 2 for a device deep link", () => {
    const t = reduceRideSession(blankRideSession(OPTIONS), {
      type: "open",
      options: OPTIONS,
      screen: "2",
      device: {
        vehicleIdentifier: VEHICLE,
        plate: null,
        model: null,
        batteryConfirmed: null,
      },
    });
    expect(t.to).toBe("wizard:2");
    expect(t.doc.device).toMatchObject({ vehicleIdentifier: VEHICLE });
    expect(t.doc.private).toBe(false);
  });
});

describe("non-linear transitions the buttons imply", () => {
  it("wizard:6 → riding when the rider already started", () => {
    // "I already started" skips the countdown entirely — the reducer must
    // accept `riding` straight off Screen 6, not only out of `countdown`.
    const store = createRideSessionStore({
      storage: memoryRideSessionStorage(),
      initial: docAt("wizard", "6"),
    });
    const t = store.dispatch({
      type: "rideStarted",
      rideId: RIDE_ID,
      startedAtMs: 1_000,
      trackKeyId: RIDE_ID,
    });
    expect(t?.accepted).toBe(true);
    expect(t?.from).toBe("wizard:6");
    expect(t?.to).toBe("riding");
    expect(store.current()).toMatchObject({
      state: "riding",
      rideId: RIDE_ID,
      startedAtMs: 1_000,
    });
  });

  it("runs the S8 New Destination loop on the SAME ride and chain", () => {
    const store = createRideSessionStore({
      storage: memoryRideSessionStorage(),
      initial: ridingDoc(),
    });
    const seen: RideEffect[] = [];
    const step = (action: RideAction) => {
      const t = store.dispatch(action);
      expect(t?.accepted).toBe(true);
      seen.push(...(t?.effects ?? []));
      return t;
    };

    expect(step({ type: "endRide" })?.to).toBe("ending(8)");
    expect(step({ type: "newDestination" })?.to).toBe("wizard:3");
    // A new destination is a NEW choice: the old dest/route are cleared so
    // Screen 4 re-posts /ride-routes with tracked_ride_id set.
    expect(store.current()).toMatchObject({ dest: null, route: null });
    step({ type: "setDest", dest: { label: "Union Station", lat: 39.75, lon: -105.0 } });
    expect(step({ type: "goto", screen: "4" })?.to).toBe("wizard:4");
    step({ type: "setRoute", route: { ...ROUTE, profile: "express" } });
    const back = step({ type: "resumeRiding" });

    expect(back?.to).toBe("riding");
    // Same ride, same chain, no new countdown …
    expect(store.current()).toMatchObject({
      rideId: RIDE_ID,
      trackKeyId: RIDE_ID,
      startedAtMs: 1_784_134_800_000,
    });
    expect(back?.effects).toEqual([{ kind: "resume_recording" }]);
    // … and — the whole reason the loop is legal — no end was ever reported.
    expect(effectKinds(seen)).not.toContain("end_reported");
  });

  it("lets a rider cancel out of the loop's Screen 3 back into the ride", () => {
    const t = reduceRideSession(
      ridingDoc({ state: "wizard", screen: "3", dest: null, route: null }),
      { type: "resumeRiding" },
    );
    expect(t.accepted).toBe(true);
    expect(t.to).toBe("riding");
  });

  it("Rush Quit ends at done, skipping S9 and S10 entirely", () => {
    const t = reduceRideSession(ridingDoc({ state: "ending", screen: "8" }), {
      type: "rushQuit",
    });
    expect(t.to).toBe("done");
    expect(t.effects).toEqual([{ kind: "end_reported", fields: "minimal" }]);
  });

  it("sends a private ride riding → done with no end report", () => {
    const doc = ridingDoc({
      private: true,
      rideId: null,
      trackKeyId: "private-ababababababab",
      device: { own: true },
    });
    const t = reduceRideSession(doc, { type: "endRide" });
    expect(t.to).toBe("done");
    // The final partial batch still seals — a track-store duty, not an
    // ending(8) one.
    expect(t.effects).toEqual([{ kind: "seal_final_batch" }]);
  });

  it("skips a gated-off survey and a waypoint-free eligibility screen", () => {
    // Both S9 panes off (end_survey off, no route) and no waypoints → straight
    // to done.
    const bare = ridingDoc({
      state: "ending",
      screen: "8",
      route: null,
      options: { ...OPTIONS, end_survey: false },
    });
    expect(shouldShowSurvey(bare)).toBe(false);
    expect(
      reduceRideSession(bare, {
        type: "endReported",
        facts: { hasWaypoints: false },
      }).to,
    ).toBe("done");
    // Waypoints but no survey panes → S10 only.
    expect(
      reduceRideSession(bare, {
        type: "endReported",
        facts: { hasWaypoints: true },
      }).to,
    ).toBe("eligibility(10)");
    // Survey shown, then skipped with no waypoints → done.
    expect(
      reduceRideSession(ridingDoc({ state: "survey", screen: "9" }), {
        type: "surveyDone",
        facts: { hasWaypoints: false },
      }).to,
    ).toBe("done");
  });

  it("gates the two S9 panes independently", () => {
    const base = ridingDoc({ state: "ending", screen: "8" });
    expect(surveyPanes(base)).toEqual({ scooter: true, navigation: true });
    expect(surveyPanes({ ...base, route: null })).toEqual({
      scooter: true,
      navigation: false,
    });
    expect(
      surveyPanes({ ...base, options: { ...OPTIONS, end_survey: false } }),
    ).toEqual({ scooter: false, navigation: true });
    // Own device has no GBFS ground truth to survey against.
    expect(
      surveyPanes({ ...base, options: { ...OPTIONS, own_device: true } }),
    ).toMatchObject({ scooter: false });
    // A private ride has no tracked_rides row at all.
    expect(surveyPanes({ ...base, private: true, rideId: null })).toEqual({
      scooter: false,
      navigation: false,
    });
    expect(
      shouldShowEligibility({ ...base, private: true }, { hasWaypoints: true }),
    ).toBe(false);
  });
});

describe("the end-report invariant", () => {
  it("never reports the end on merely entering ending(8)", () => {
    const t = reduceRideSession(ridingDoc(), { type: "endRide" });
    expect(t.to).toBe("ending(8)");
    expect(t.effects).toEqual([{ kind: "seal_final_batch" }]);
    expect(effectKinds(t.effects)).not.toContain("end_reported");
    expect(endReportOwner(ridingDoc(), { type: "endRide" })).toBeNull();
  });

  it("assigns the single PATCH /end to exactly the S8 buttons", () => {
    const ending = ridingDoc({ state: "ending", screen: "8" });
    const owners: Array<[RideAction, "minimal" | "full" | null]> = [
      [{ type: "rushQuit" }, "minimal"],
      [{ type: "endReported", facts: { hasWaypoints: true } }, "full"],
      [{ type: "abandon" }, "minimal"],
      [{ type: "endRide" }, null],
      [{ type: "newDestination" }, null],
      [{ type: "resumeRiding" }, null],
      [{ type: "surveyDone", facts: { hasWaypoints: true } }, null],
      [{ type: "eligibilityDone" }, null],
      [{ type: "goto", screen: "3" }, null],
      [{ type: "reset" }, null],
    ];
    for (const [action, expected] of owners) {
      expect(endReportOwner(ending, action)).toBe(expected);
    }
  });

  it("honours the F3 interim exception and nothing more", () => {
    const doc = ridingDoc();
    // With no Screen 8 in existence, the legacy End Ride owns the minimal call
    // and lands on `done` — otherwise `GET active` keeps answering "still on a
    // ride" and the rider's next start 409s.
    const legacy = reduceRideSession(doc, { type: "endRide" }, {
      legacyEndRide: true,
    });
    expect(legacy.to).toBe("done");
    expect(legacy.effects).toEqual([
      { kind: "seal_final_batch" },
      { kind: "end_reported", fields: "minimal" },
    ]);
    // Private rides are unaffected: there is no ride row to report against.
    const priv = reduceRideSession(
      ridingDoc({ private: true, rideId: null }),
      { type: "endRide" },
      { legacyEndRide: true },
    );
    expect(priv.effects).toEqual([{ kind: "seal_final_batch" }]);
  });
});

describe("illegal transitions", () => {
  it("refuses to open a fresh wizard over a live or post-ride session", () => {
    for (const doc of [
      ridingDoc(),
      ridingDoc({ state: "ending", screen: "8" }),
      docAt("wizard", "4", { rideId: RIDE_ID }),
    ]) {
      const t = reduceRideSession(doc, { type: "open", options: OPTIONS });
      expect(t.accepted).toBe(false);
      expect(t.doc).toBe(doc);
    }
    // From idle or done it is fine.
    expect(
      reduceRideSession(docAt("done", null), { type: "open", options: OPTIONS })
        .accepted,
    ).toBe(true);
  });

  it("rejects out-of-phase actions without mutating the doc", () => {
    const cases: Array<[RideSessionDoc, RideAction]> = [
      [ridingDoc(), { type: "startCountdown" }],
      [ridingDoc(), { type: "newDestination" }],
      [ridingDoc(), { type: "rushQuit" }],
      [ridingDoc(), { type: "endReported", facts: { hasWaypoints: true } }],
      [docAt("wizard", "2"), { type: "rideStarted", rideId: RIDE_ID, startedAtMs: 1, trackKeyId: null }],
      [docAt("wizard", "2"), { type: "endRide" }],
      [ridingDoc(), { type: "goto", screen: "2" }],
      [docAt("countdown", "6", { rideId: RIDE_ID }), { type: "goto", screen: "6" }],
      [ridingDoc({ state: "survey", screen: "9" }), { type: "eligibilityDone" }],
      [docAt("idle", null), { type: "setOptions", options: OPTIONS }],
    ];
    for (const [doc, action] of cases) {
      const t = reduceRideSession(doc, action);
      expect(t.accepted, `${action.type} from ${phaseOf(doc)}`).toBe(false);
      expect(t.rejected).toBeTruthy();
      expect(t.doc).toBe(doc);
      expect(t.from).toBe(t.to);
    }
  });

  it("lets an un-started countdown be cancelled back to Screen 6", () => {
    const t = reduceRideSession(docAt("countdown", "6"), {
      type: "goto",
      screen: "6",
    });
    expect(t.accepted).toBe(true);
    expect(t.to).toBe("wizard:6");
  });

  it("will not adopt a server ride while already on one", () => {
    const t = reduceRideSession(ridingDoc(), {
      type: "adoptServerRide",
      rideId: "other",
      startedAtMs: 1,
      trackKeyId: "other",
    });
    expect(t.accepted).toBe(false);
  });
});

describe("device selection and privacy", () => {
  it("makes My-own-Device a private ride and lets Screen 2 undo it", () => {
    const at2 = docAt("wizard", "2");
    const own = reduceRideSession(at2, {
      type: "setDevice",
      device: { own: true },
    });
    expect(own.doc.private).toBe(true);

    // Switching back to a feed device is only points-eligible if the caller
    // (which knows whether the rider is a guest) says so.
    const veo = {
      vehicleIdentifier: VEHICLE,
      plate: "123456",
      model: "Cosmo",
      batteryConfirmed: 80,
    };
    expect(
      reduceRideSession(own.doc, { type: "setDevice", device: veo }).doc.private,
    ).toBe(true);
    expect(
      reduceRideSession(own.doc, {
        type: "setDevice",
        device: veo,
        private: false,
      }).doc.private,
    ).toBe(false);
  });

  it("keeps a guest ride private through device selection", () => {
    const guest = reduceRideSession(blankRideSession(OPTIONS), {
      type: "open",
      options: OPTIONS,
      private: true,
    });
    expect(guest.doc.private).toBe(true);
    const withDevice = reduceRideSession(guest.doc, {
      type: "setDevice",
      device: {
        vehicleIdentifier: VEHICLE,
        plate: null,
        model: null,
        batteryConfirmed: null,
      },
    });
    expect(withDevice.doc.private).toBe(true);
  });
});

describe("persistence", () => {
  it("writes the doc on every accepted transition and nothing on a rejected one", () => {
    const storage = memoryRideSessionStorage();
    const store = createRideSessionStore({ storage });
    store.dispatch({ type: "open", options: OPTIONS });
    expect(parseRideSession(storage.read())).toMatchObject({
      state: "wizard",
      screen: "1",
    });

    store.dispatch({ type: "goto", screen: "2" });
    expect(parseRideSession(storage.read())?.screen).toBe("2");

    const before = storage.read();
    expect(store.dispatch({ type: "rushQuit" })?.accepted).toBe(false);
    expect(storage.read()).toBe(before);
  });

  it("clears storage on reset", () => {
    const storage = memoryRideSessionStorage();
    const store = createRideSessionStore({ storage });
    store.dispatch({ type: "open", options: OPTIONS });
    const t = store.dispatch({ type: "reset" });
    expect(t?.effects).toEqual([{ kind: "clear_session" }]);
    expect(storage.read()).toBeNull();
    expect(store.current()).toBeNull();
  });

  it("keeps running when storage rejects the write (private mode)", () => {
    const storage = {
      read: () => null,
      write: () => false,
      remove: () => {},
    };
    const store = createRideSessionStore({ storage });
    expect(store.dispatch({ type: "open", options: OPTIONS })?.accepted).toBe(
      true,
    );
    expect(store.current()?.state).toBe("wizard");
    expect(store.persisted).toBe(false);
  });

  it("survives a localStorage that throws on read and write", () => {
    const hostile = {
      getItem: () => {
        throw new DOMException("denied");
      },
      setItem: () => {
        throw new DOMException("denied");
      },
      removeItem: () => {
        throw new DOMException("denied");
      },
    };
    vi.stubGlobal("localStorage", hostile);
    const storage = localRideSessionStorage();
    expect(storage.read()).toBeNull();
    expect(storage.write("{}")).toBe(false);
    expect(() => storage.remove()).not.toThrow();
    // The key itself is part of the contract with the rest of the app.
    expect(RIDE_SESSION_KEY).toBe("scooter_fyi.ride_session");
  });

  // The adapter the app actually ships with (createRideSessionStore falls back
  // to it when no storage is injected). Every other test here injects a memory
  // storage, so without this the real read/write path was only ever exercised
  // against a localStorage that throws — a read/write key disagreement, which
  // silently costs the rider their session on every reload and would stop the
  // whole recovery table from ever firing, passed the entire suite.
  it("reads back what it wrote, under the shared key", () => {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });

    const storage = localRideSessionStorage();
    expect(storage.read()).toBeNull();
    expect(storage.write('{"v":1}')).toBe(true);
    // Same key the rest of the app agrees on, and nothing else touched.
    expect([...backing.keys()]).toEqual([RIDE_SESSION_KEY]);
    expect(storage.read()).toBe('{"v":1}');

    storage.remove();
    expect(storage.read()).toBeNull();
    expect(backing.size).toBe(0);
  });

  it("honours an explicit key override end to end", () => {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });

    const storage = localRideSessionStorage("scooter_fyi.ride_session_test");
    expect(storage.write("x")).toBe(true);
    expect([...backing.keys()]).toEqual(["scooter_fyi.ride_session_test"]);
    expect(storage.read()).toBe("x");
    // The default key must be untouched by an overridden instance.
    expect(localRideSessionStorage().read()).toBeNull();
  });

  it("persists through the store's own default storage", () => {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });

    const store = createRideSessionStore();
    expect(store.dispatch({ type: "open", options: OPTIONS })?.accepted).toBe(
      true,
    );
    expect(store.persisted).toBe(true);
    // A fresh store over the same storage recovers the doc a reload would see.
    expect(parseRideSession(backing.get(RIDE_SESSION_KEY) ?? null)).toMatchObject(
      { state: "wizard", screen: "1" },
    );
  });

  it("round-trips a full doc", () => {
    const doc = ridingDoc();
    expect(parseRideSession(serializeRideSession(doc))).toEqual(doc);
  });

  it("discards a doc it cannot trust", () => {
    expect(parseRideSession(null)).toBeNull();
    expect(parseRideSession("not json")).toBeNull();
    expect(parseRideSession("[]")).toBeNull();
    expect(parseRideSession(JSON.stringify({ v: 2, state: "riding" }))).toBeNull();
    expect(
      parseRideSession(JSON.stringify({ v: 1, state: "flying", options: OPTIONS })),
    ).toBeNull();
    // A missing options blob is unusable: this module must not invent defaults
    // that belong to ride-settings.ts.
    expect(parseRideSession(JSON.stringify({ v: 1, state: "riding" }))).toBeNull();
  });

  it("re-derives `screen` so a doc cannot claim one its state lacks", () => {
    const tampered = parseRideSession(
      JSON.stringify({
        ...ridingDoc(),
        v: RIDE_SESSION_VERSION,
        state: "riding",
        screen: "9",
      }),
    );
    expect(tampered?.screen).toBeNull();
    const badWizard = parseRideSession(
      JSON.stringify({ ...docAt("wizard", "2"), screen: "5" }),
    );
    expect(badWizard?.screen).toBe("1");
  });

  it("notifies subscribers and stops on unsubscribe", () => {
    const store = createRideSessionStore({
      storage: memoryRideSessionStorage(),
    });
    const seen: string[] = [];
    const off = store.subscribe((doc) => seen.push(doc?.state ?? "null"));
    store.dispatch({ type: "open", options: OPTIONS });
    off();
    store.dispatch({ type: "goto", screen: "2" });
    expect(seen).toEqual(["wizard"]);
  });

  it("patches fields without a phase change", () => {
    const store = createRideSessionStore({
      storage: memoryRideSessionStorage(),
      initial: ridingDoc({ route: { ...ROUTE, rideRouteId: null } }),
    });
    store.patch({ route: { ...ROUTE, rideRouteId: "late-row" } });
    expect(store.current()?.route?.rideRouteId).toBe("late-row");
    expect(store.current()?.state).toBe("riding");
  });
});

describe("recovery decision table", () => {
  it("does nothing without a doc", async () => {
    expect(await recoverRideSession(fakeDeps())).toMatchObject({
      action: "none",
      reason: "no_doc",
      doc: null,
    });
    expect(
      await recoverRideSession(fakeDeps({ doc: docAt("idle", null) })),
    ).toMatchObject({ action: "none", reason: "doc_idle" });
    expect(
      await recoverRideSession(fakeDeps({ doc: docAt("done", null) })),
    ).toMatchObject({ action: "none", reason: "doc_done" });
  });

  it("reopens the wizard at Screen 6 after a pre-start crash", async () => {
    // countdown with rideId null: no server ride is KNOWN, so no reconcile —
    // the re-press's 409 catches a start that had in fact committed.
    const getActiveRide = vi.fn(async () => null);
    const out = await recoverRideSession(
      fakeDeps({ doc: docAt("countdown", "6"), getActiveRide }),
    );
    expect(out).toMatchObject({
      action: "reopen_wizard",
      reason: "pre_start_crash",
      reconciled: false,
    });
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("wizard:6");
    expect(getActiveRide).not.toHaveBeenCalled();
  });

  it("reopens a plain wizard doc where the rider left off", async () => {
    const out = await recoverRideSession(
      fakeDeps({ doc: docAt("wizard", "2.5") }),
    );
    expect(out).toMatchObject({
      action: "reopen_wizard",
      reason: "wizard_in_progress",
    });
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("wizard:2.5");
  });

  it("restores post-ride docs straight to their screen, no reconcile", async () => {
    const getActiveRide = vi.fn(async () => null);
    for (const [state, screen] of [
      ["ending", "8"],
      ["survey", "9"],
      ["eligibility", "10"],
    ] as Array<[RideState, RideScreenId]>) {
      const out = await recoverRideSession(
        fakeDeps({ doc: ridingDoc({ state, screen }), getActiveRide }),
      );
      expect(out).toMatchObject({
        action: "restore_screen",
        reason: "post_ride_doc",
      });
      expect(out.doc?.state).toBe(state);
      expect(out.doc?.screen).toBe(screen);
    }
    expect(getActiveRide).not.toHaveBeenCalled();
  });

  it("restores the HUD and resumes the chain when the server agrees", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => trackedRide(),
        readTrackTip: async () => tip(),
      }),
    );
    expect(out).toMatchObject({
      action: "restore_riding",
      reason: "active_match",
      reconciled: true,
      note: null,
    });
    expect(out.resume).toMatchObject({
      trackId: RIDE_ID,
      keySource: "idb",
      freshChain: false,
    });
    expect(out.resume?.tip?.nextSeq).toBe(5);
  });

  it("re-imports the key and restarts the chain honestly after eviction", async () => {
    const signing = {
      alg: "HS256" as const,
      key_id: RIDE_ID,
      key: "AAAA",
      nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      issued_at: "2026-07-15T16:59:55.000Z",
    };
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => trackedRide({ track_signing: signing }),
        readTrackTip: async () => null,
      }),
    );
    expect(out.action).toBe("restore_riding");
    expect(out.resume).toMatchObject({
      keySource: "server",
      freshChain: true,
      signing,
      tip: null,
    });
    // An evicted IDB lost the SEALED BATCHES too — say so, never pretend the
    // pre-eviction track is intact.
    expect(out.note).toBe("chain_restarted");
  });

  it("restores a New-Destination-loop doc to its wizard screen", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc({ state: "wizard", screen: "4" }),
        getActiveRide: async () => trackedRide(),
        readTrackTip: async () => tip(),
      }),
    );
    expect(out).toMatchObject({
      action: "restore_wizard",
      reason: "active_match_wizard",
    });
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("wizard:4");
    // Tracking resumed either way.
    expect(out.resume?.freshChain).toBe(false);
  });

  it("prompts resume-or-end when the server has a ride the doc does not", async () => {
    const server = trackedRide({ id: "server-side-ride" });
    const out = await recoverRideSession(
      fakeDeps({
        doc: null,
        probeWhenNoDoc: true,
        getActiveRide: async () => server,
        readTrackTip: async (id) =>
          id === "server-side-ride" ? tip({ trackId: id, nextSeq: 3, batchCount: 3 }) : null,
      }),
    );
    expect(out).toMatchObject({
      action: "prompt_resume_or_end",
      reason: "active_conflict",
      reconciled: true,
    });
    expect(out.ride?.id).toBe("server-side-ride");
    // On resume the tip must be rehydrated BEFORE anything new is sealed — a
    // restarted seq would break chain verification.
    expect(out.resume).toMatchObject({
      trackId: "server-side-ride",
      keySource: "idb",
      freshChain: false,
    });
    expect(out.resume?.tip?.nextSeq).toBe(3);
  });

  it("prompts resume-or-end when the doc names a different ride", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => trackedRide({ id: "another-ride" }),
      }),
    );
    expect(out).toMatchObject({
      action: "prompt_resume_or_end",
      reason: "active_conflict",
    });
    expect(out.ride?.id).toBe("another-ride");
    // An empty batches store falls back to the fresh-chain path.
    expect(out.resume).toMatchObject({ freshChain: true, keySource: "none" });
  });

  it("produces the same prompt for a 409 on start", async () => {
    const server = trackedRide({ id: "conflicting" });
    const deps = fakeDeps({ readTrackTip: async () => null });
    const out = await recoveryForServerConflict(deps, server, null);
    expect(out).toMatchObject({
      action: "prompt_resume_or_end",
      reason: "active_conflict",
      reconciled: true,
    });
    expect(out.resume?.trackId).toBe("conflicting");
  });

  it("skips S8's end buttons when another tab already reported the end", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => null,
        getTrackedRide: async () =>
          trackedRide({
            status: "completed",
            user_reported_ended_at: "2026-07-15T17:10:00.000Z",
          }),
        readTrackTip: async () => tip(),
      }),
    );
    expect(out).toMatchObject({
      action: "restore_screen",
      reason: "end_already_reported",
      reconciled: true,
    });
    // Both S9 gates pass on this doc, so it lands there — never on Screen 8,
    // whose buttons would 409 on the single-shot /end.
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("survey(9)");
  });

  it("routes an already-ended waypoint-only ride straight to S10", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc({ route: null, options: { ...OPTIONS, end_survey: false } }),
        getActiveRide: async () => null,
        getTrackedRide: async () =>
          trackedRide({ user_reported_ended_at: "2026-07-15T17:10:00.000Z" }),
        readTrackTip: async () => tip(),
      }),
    );
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("eligibility(10)");
  });

  it("routes an already-ended ride with nothing to manage to done", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc({ route: null, options: { ...OPTIONS, end_survey: false } }),
        getActiveRide: async () => null,
        getTrackedRide: async () =>
          trackedRide({ user_reported_ended_at: "2026-07-15T17:10:00.000Z" }),
        readTrackTip: async () =>
          tip({ batchCount: 0, waypointCount: 0, pendingCount: 0 }),
      }),
    );
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("done");
  });

  it("seals and jumps to Screen 8 when the watch expired", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => null,
        getTrackedRide: async () => trackedRide({ status: "expired" }),
        readTrackTip: async () => tip(),
      }),
    );
    expect(out).toMatchObject({
      action: "seal_and_end",
      reason: "ride_expired",
      note: "ride_expired",
      reconciled: true,
    });
    // NOT a local-only end: PATCH /end still works after expiry, and donation
    // requires it.
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("ending(8)");
  });

  it("ends locally when the ride row is gone", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => null,
        getTrackedRide: async () => {
          throw notFound();
        },
      }),
    );
    expect(out).toMatchObject({
      action: "local_end",
      reason: "ride_deleted",
      reconciled: true,
    });
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("done");
  });

  it("reconciles a private ride against IndexedDB only", async () => {
    const getActiveRide = vi.fn(async () => null);
    const getTrackedRide = vi.fn(async () => trackedRide());
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc({
          private: true,
          rideId: null,
          trackKeyId: "private-ababababababab",
          device: { own: true },
        }),
        getActiveRide,
        getTrackedRide,
        readTrackTip: async () =>
          tip({ trackId: "private-ababababababab", batchCount: 2 }),
      }),
    );
    expect(out).toMatchObject({
      action: "restore_riding",
      reason: "private_ride",
      reconciled: false,
    });
    expect(out.resume).toMatchObject({
      trackId: "private-ababababababab",
      keySource: "idb",
      freshChain: false,
    });
    expect(getActiveRide).not.toHaveBeenCalled();
    expect(getTrackedRide).not.toHaveBeenCalled();
  });

  it("reports a private ride's lost track as lost — there is no server copy", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc({ private: true, rideId: null, trackKeyId: "private-x" }),
        readTrackTip: async () => null,
      }),
    );
    expect(out.resume).toMatchObject({ keySource: "none", freshChain: true });
    expect(out.note).toBe("track_lost");
  });

  it("degrades to an unverified restore when the reconcile call fails", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => {
          throw new TypeError("Failed to fetch");
        },
        readTrackTip: async () => tip(),
      }),
    );
    expect(out).toMatchObject({
      action: "restore_riding",
      reason: "offline",
      note: "offline",
      reconciled: false,
    });
    expect(out.resume?.freshChain).toBe(false);
  });

  it("degrades when the detail call fails for a non-404 reason", async () => {
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => null,
        getTrackedRide: async () => {
          throw Object.assign(new Error("HTTP 500"), { status: 500 });
        },
        readTrackTip: async () => tip(),
      }),
    );
    expect(out).toMatchObject({ action: "restore_riding", reason: "offline" });
  });

  it("does not reconcile for a signed-out rider", async () => {
    const getActiveRide = vi.fn(async () => null);
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        isAuthenticated: () => false,
        getActiveRide,
        readTrackTip: async () => tip(),
      }),
    );
    expect(out).toMatchObject({
      action: "restore_riding",
      reason: "unauthenticated",
      note: "offline",
    });
    expect(getActiveRide).not.toHaveBeenCalled();
  });

  it("counts unsealed pending points toward the Screen 10 gate", async () => {
    // A crash mid-batch leaves points in the `pending` store; they become a
    // rec:true batch the moment anything resumes, so there IS a donatable
    // track even with zero sealed batches.
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc({ route: null, options: { ...OPTIONS, end_survey: false } }),
        getActiveRide: async () => null,
        getTrackedRide: async () =>
          trackedRide({ user_reported_ended_at: "2026-07-15T17:10:00.000Z" }),
        readTrackTip: async () =>
          tip({ batchCount: 0, waypointCount: 0, pendingCount: 7 }),
      }),
    );
    expect(phaseOf(out.doc as RideSessionDoc)).toBe("eligibility(10)");
  });

  it("adopts a server ride into an empty store using the ride's own options", () => {
    // The 409 UX reached with no local doc: [Resume] has to create a session
    // from nothing, and the server ride's `ride_options` is the honest seed.
    const storage = memoryRideSessionStorage();
    const store = createRideSessionStore({ storage });
    expect(store.current()).toBeNull();
    // Without an options blob there is nothing to build a doc from.
    expect(
      store.dispatch({
        type: "adoptServerRide",
        rideId: RIDE_ID,
        startedAtMs: 1_784_134_800_000,
        trackKeyId: RIDE_ID,
      }),
    ).toBeNull();

    const t = store.dispatch({
      type: "adoptServerRide",
      rideId: RIDE_ID,
      startedAtMs: 1_784_134_800_000,
      trackKeyId: RIDE_ID,
      options: OPTIONS,
    });
    expect(t?.to).toBe("riding");
    expect(store.current()).toMatchObject({
      state: "riding",
      rideId: RIDE_ID,
      trackKeyId: RIDE_ID,
      private: false,
    });
    expect(parseRideSession(storage.read())?.rideId).toBe(RIDE_ID);
  });

  it("feeds its restored doc straight into a store", async () => {
    const storage = memoryRideSessionStorage();
    const out = await recoverRideSession(
      fakeDeps({
        doc: ridingDoc(),
        getActiveRide: async () => trackedRide(),
        readTrackTip: async () => tip(),
      }),
    );
    const store = createRideSessionStore({ storage, initial: out.doc });
    store.replace(out.doc);
    expect(parseRideSession(storage.read())).toMatchObject({
      state: "riding",
      rideId: RIDE_ID,
    });
    // And the restored session can still be ended normally.
    expect(store.dispatch({ type: "endRide" })?.to).toBe("ending(8)");
  });
});
