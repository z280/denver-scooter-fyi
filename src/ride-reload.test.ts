// Phase F1's headline acceptance criterion, end to end:
//
//   "simulated reload mid-ride restores the session doc and resumes the chain"
//
// Both halves are unit-tested in isolation (`ride-session.test.ts` drives the
// recovery decision table with injected fakes; `track-store.test.ts` drives the
// recorder against the golden vectors), but nothing exercised the SEAM between
// them — and the seam is where a mistake would actually bite: `recoverRideSession`
// hands back a `TrackResumePlan`, and `trackStore.resumeRide()` has to be able to
// act on it and produce a chain the API can still verify.
//
// So: record a real ride, throw away every piece of in-memory state, rebuild both
// modules from the two things a reload really keeps (the localStorage doc and the
// IndexedDB stores), reconcile, resume, and assert the finished chain is a single
// unbroken chain — contiguous `seq`, `prev` linking, one rolling root — with every
// accepted waypoint present exactly once.
import { describe, expect, it } from "vitest";

import type { RideOptions, TrackSigning, TrackedRide } from "./api.ts";
import {
  memoryRideSessionStorage,
  parseRideSession,
  createRideSessionStore,
  recoverRideSession,
  serializeRideSession,
  type RideSessionStorage,
} from "./ride-session.ts";
import {
  MemoryTrackStorage,
  decodeTrackBatch,
  openTrackStore,
  recomputeChainRoot,
  type TrackFix,
} from "./track-store.ts";
import rawVectors from "../tests/fixtures/track-chain-vectors.json";

type FixTuple = [number, number, number, number];

const vectors = rawVectors as unknown as {
  rides: {
    primary: {
      ride_id: string;
      vehicle_identifier: string;
      nonce: string;
      key_b64url: string;
      started_at: string;
      fixes: FixTuple[];
    };
  };
};

const ride = vectors.rides.primary;

const SIGNING: TrackSigning = {
  alg: "HS256",
  key_id: ride.ride_id,
  key: ride.key_b64url,
  nonce: ride.nonce,
  issued_at: ride.started_at,
};

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

const asFix = ([tMs, lat, lon, accM]: FixTuple): TrackFix => ({
  tMs,
  lat,
  lon,
  accM,
});

function serverRide(over: Partial<TrackedRide> = {}): TrackedRide {
  return {
    id: ride.ride_id,
    status: "watching",
    started_at: ride.started_at,
    start_lat: ride.fixes[0][1],
    start_lon: ride.fixes[0][2],
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
    vehicle_identifier: ride.vehicle_identifier,
    created_at: ride.started_at,
    updated_at: ride.started_at,
    distance_meters: null,
    distance_source: null,
    track_signing: SIGNING,
    ...over,
  };
}

/** Everything a reload keeps: the serialized session doc and the track stores. */
interface SurvivingState {
  session: RideSessionStorage;
  tracks: MemoryTrackStorage;
}

/** Ride from the wizard to `riding`, recording `fixCount` fixes. Returns only
 *  what survives a reload — every recorder and store built here is dropped. */
async function rideUntilReload(
  state: SurvivingState,
  fixCount: number,
): Promise<void> {
  const store = createRideSessionStore({ storage: state.session });
  store.dispatch({ type: "open", options: OPTIONS, screen: "2" });
  store.dispatch({
    type: "setDevice",
    device: {
      vehicleIdentifier: ride.vehicle_identifier,
      plate: "1025543",
      model: "Cosmo",
      batteryConfirmed: 82,
    },
  });
  store.dispatch({ type: "goto", screen: "6" });
  store.dispatch({ type: "startCountdown" });

  const trackStore = await openTrackStore({ storage: state.tracks });
  const recorder = await trackStore.startServerRide(SIGNING);
  store.dispatch({
    type: "rideStarted",
    rideId: ride.ride_id,
    startedAtMs: ride.fixes[0][0],
    trackKeyId: recorder.trackId,
  });
  for (const fix of ride.fixes.slice(0, fixCount)) {
    await recorder.addFix(asFix(fix));
  }
}

/** Assert a finished chain is one unbroken chain the API could verify. */
async function expectOneUnbrokenChain(
  jwsList: string[],
  expectedWaypoints: number,
  expectedRoot: string | null,
): Promise<void> {
  const payloads = jwsList.map((jws) => decodeTrackBatch(jws));
  // seq contiguous from 0, `prev` linking, one nonce, one ride identity.
  expect(payloads.map((p) => p.seq)).toEqual(payloads.map((_, i) => i));
  expect(payloads[0].prev).toBe("");
  expect(new Set(payloads.map((p) => p.non))).toEqual(new Set([ride.nonce]));
  expect(new Set(payloads.map((p) => p.rid))).toEqual(new Set([ride.ride_id]));
  // Every accepted fix present exactly once, still strictly increasing across
  // the flattened track (the API's check 3).
  const stamps = payloads.flatMap((p) => p.pts.map(([dt]) => p.t0 + dt));
  expect(stamps).toHaveLength(expectedWaypoints);
  for (let i = 1; i < stamps.length; i += 1) {
    expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
  }
  expect(await recomputeChainRoot(ride.nonce, jwsList)).toBe(expectedRoot);
}

describe("F1 acceptance: a reload mid-ride restores the doc and resumes the chain", () => {
  it("continues one chain across the reload, sealing the crash's open batch", async () => {
    const state: SurvivingState = {
      session: memoryRideSessionStorage(),
      tracks: new MemoryTrackStorage(),
    };
    // 60 fixes of the primary ride = seq 0 and 1 count-sealed at 25, seq 2
    // time-sealed at 5 by the fixture's deliberate 75 s background-throttle gap,
    // then 5 unsealed points left in the `pending` store — the crash-mid-batch
    // shape, on top of both seal rules.
    await rideUntilReload(state, 60);

    // ---- the reload: nothing but `state` crosses this line ----
    const doc = parseRideSession(state.session.read());
    expect(doc?.state).toBe("riding");
    expect(doc?.rideId).toBe(ride.ride_id);

    const trackStore = await openTrackStore({ storage: state.tracks });
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: async () => serverRide(),
      getTrackedRide: async () => serverRide(),
      readTrackTip: (trackId) => trackStore.readTip(trackId),
    });

    expect(outcome).toMatchObject({
      action: "restore_riding",
      reason: "active_match",
      reconciled: true,
      // The local record survived, so there is nothing to warn about.
      note: null,
    });
    expect(outcome.resume).toMatchObject({
      trackId: ride.ride_id,
      keySource: "idb",
      freshChain: false,
    });
    // The Screen 10 gate sees the unsealed points too — they become a rec:true
    // batch the moment the resume below runs.
    expect(outcome.resume?.tip).toMatchObject({
      nextSeq: 3,
      batchCount: 3,
      waypointCount: 55,
      pendingCount: 5,
    });

    // ---- act on the plan, exactly as F3's wireRideModal will ----
    const plan = outcome.resume;
    if (!plan) throw new Error("expected a resume plan");
    const resumed = await trackStore.resumeRide(plan.trackId, {
      signing: plan.signing,
      isPrivate: doc?.private,
    });
    expect(resumed).toMatchObject({ continued: true, freshChain: false });
    // Crash mid-batch: the pending points come back as a rec:true batch, in
    // their original place in the chain.
    expect(resumed.recovered).toMatchObject({ seq: 3, count: 5, rec: true });

    // The restored doc drives the UI, and the ride can still be ended normally.
    const store = createRideSessionStore({
      storage: state.session,
      initial: outcome.doc,
    });
    store.replace(outcome.doc);
    expect(parseRideSession(state.session.read())?.state).toBe("riding");

    // ---- ride on, then end ----
    for (const fix of ride.fixes.slice(60)) {
      await resumed.recorder.addFix(asFix(fix));
    }
    const finished = await resumed.recorder.finish();
    expect(store.dispatch({ type: "endRide" })?.to).toBe("ending(8)");

    const jwsList = (await resumed.recorder.batches()).map((b) => b.jws);
    await expectOneUnbrokenChain(
      jwsList,
      ride.fixes.length,
      finished.chainRootHash,
    );
    // Exactly one recovered batch — the reload's, not a duplicate of it.
    expect(
      jwsList.map((jws) => decodeTrackBatch(jws).rec).filter(Boolean),
    ).toHaveLength(1);
    // …and the donation body reports that same root.
    const donation = await resumed.recorder.buildDonation();
    expect(donation.batches).toEqual(jwsList);
    expect(donation.chain_root_hash).toBe(finished.chainRootHash);
  });

  it("restarts honestly from seq 0 when the reload finds IndexedDB evicted", async () => {
    const state: SurvivingState = {
      session: memoryRideSessionStorage(),
      tracks: new MemoryTrackStorage(),
    };
    await rideUntilReload(state, 60);

    // The doc survived (localStorage), the tracks did not (7-day PWA eviction /
    // Safari private mode). The key is re-imported from `active.track_signing`.
    const doc = parseRideSession(state.session.read());
    const trackStore = await openTrackStore({ storage: new MemoryTrackStorage() });
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: async () => serverRide(),
      getTrackedRide: async () => serverRide(),
      readTrackTip: (trackId) => trackStore.readTip(trackId),
    });

    expect(outcome.action).toBe("restore_riding");
    expect(outcome.resume).toMatchObject({
      keySource: "server",
      freshChain: true,
      tip: null,
    });
    // Never pretend the pre-eviction track is intact.
    expect(outcome.note).toBe("chain_restarted");

    const plan = outcome.resume;
    if (!plan) throw new Error("expected a resume plan");
    const resumed = await trackStore.resumeRide(plan.trackId, {
      signing: plan.signing,
    });
    expect(resumed).toMatchObject({
      continued: false,
      freshChain: true,
      keySource: "server",
      recovered: null,
    });

    for (const fix of ride.fixes.slice(60)) {
      await resumed.recorder.addFix(asFix(fix));
    }
    const finished = await resumed.recorder.finish();
    const jwsList = (await resumed.recorder.batches()).map((b) => b.jws);
    // A fresh, self-consistent chain over only what survives — seq 0, prev "",
    // and the post-eviction waypoints only. Server validation adjudicates the
    // rest (typically `start_mismatch`).
    await expectOneUnbrokenChain(
      jwsList,
      ride.fixes.length - 60,
      finished.chainRootHash,
    );
  });

  it("keeps the ride when the reload cannot reach the server at all", async () => {
    const state: SurvivingState = {
      session: memoryRideSessionStorage(),
      tracks: new MemoryTrackStorage(),
    };
    await rideUntilReload(state, 30);

    const doc = parseRideSession(state.session.read());
    const trackStore = await openTrackStore({ storage: state.tracks });
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: async () => {
        throw new Error("offline");
      },
      getTrackedRide: async () => {
        throw new Error("offline");
      },
      readTrackTip: (trackId) => trackStore.readTip(trackId),
    });

    // Airplane-mode reload is an F3 acceptance case: keep the ride, keep
    // recording, flag that nothing was verified — never declare the ride over.
    expect(outcome).toMatchObject({
      action: "restore_riding",
      reason: "offline",
      reconciled: false,
      note: "offline",
    });
    const plan = outcome.resume;
    if (!plan) throw new Error("expected a resume plan");
    expect(plan.freshChain).toBe(false);
    const resumed = await trackStore.resumeRide(plan.trackId, {
      signing: plan.signing,
    });
    expect(resumed.continued).toBe(true);
    expect(resumed.recovered).toMatchObject({ seq: 1, count: 5, rec: true });

    for (const fix of ride.fixes.slice(30)) {
      await resumed.recorder.addFix(asFix(fix));
    }
    const finished = await resumed.recorder.finish();
    await expectOneUnbrokenChain(
      (await resumed.recorder.batches()).map((b) => b.jws),
      ride.fixes.length,
      finished.chainRootHash,
    );
  });

  it("survives a localStorage that rejects every write, in memory only", async () => {
    // Private mode: the doc never persists, so a reload legitimately finds
    // nothing — the ride simply cannot be restored, and the store says so
    // instead of pretending it saved.
    const rejecting: RideSessionStorage = {
      read: () => null,
      write: () => false,
      remove: () => {},
    };
    const store = createRideSessionStore({ storage: rejecting });
    store.dispatch({ type: "open", options: OPTIONS, screen: "2" });
    expect(store.persisted).toBe(false);
    expect(store.current()?.state).toBe("wizard");
    expect(parseRideSession(rejecting.read())).toBeNull();
    // The doc is still a real doc — it just lives for this page load.
    expect(
      parseRideSession(serializeRideSession(store.current()!)),
    ).toMatchObject({ state: "wizard", screen: "2" });
  });
});
