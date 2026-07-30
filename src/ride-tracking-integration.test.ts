// F3 acceptance, end to end: "live track-store integration end-to-end + the
// 409/reload resume UX + real-device network verification design" (frontend
// plan, Phase F3, lane ③).
//
// SCOPE — this file proves the SEAM between three already-built F1 pieces —
// `api.ts` (the real typed client, not a hand-rolled fake of its shapes),
// `ride-session.ts` (the reducer + the reload-recovery decision table) and
// `track-store.ts` (the local hash-chained recorder) — actually connects, the
// way `ride-screen-start.ts`'s `onRideStarted` hook and `ride-hud.ts`'s
// `attachTrackRecorder`/`beginHandoff` seams say it should. Nothing here
// re-implements the reducer or the chain math (both already have their own
// exhaustive unit suites in `ride-session.test.ts` and `track-store.test.ts`,
// and `ride-reload.test.ts` already proves the session+track SEAM in
// isolation with hand-injected fake `getActiveRide`/`getTrackedRide`
// closures). What's new here:
//
//   1. Every server round trip goes through the REAL `api.ts` functions
//      (`startTrackedRide`, `getActiveRide`, `getTrackedRide`,
//      `endTrackedRide`, `donateTrack`) against a routed `fetch` stub, not a
//      hand-rolled closure matching `RideRecoveryDeps`'s shape by hand. A
//      fake closure can silently drift from the real contract (e.g. if
//      `ApiError` ever stopped carrying `.status`, a fake `notFound()` helper
//      would never notice) — routing real `fetch` responses through the real
//      client is what actually verifies the wire contract this lane owns.
//   2. The FULL local-recording lifecycle: wizard → real `startTrackedRide()`
//      → `track_signing` → `track-store`'s recorder → many recorded fixes →
//      explicit end/donate, with a HARD, mechanically-enforced assertion that
//      nothing calls the network in between (`FetchRig.forbid()` — see
//      below — makes an unexpected call throw instead of just being counted).
//   3. Every branch of the reload/409 resume-or-end decision table the phase
//      spec calls out by name, re-verified against the ACTUAL
//      `recoverRideSession` implementation (not trusted from a prior
//      self-report) — including a genuine gap this lane found and fixed: see
//      the "ride-session.ts fix" note below.
//   4. A real, wall-clock-measured bound on "reload → restored & recording"
//      (~3 s), and a real, wall-clock elapsed-time floor proving the bound
//      isn't trivially satisfied by an all-synchronous mock.
//
// ride-session.ts FIX (deviation, described fully in the lane report): the
// `seal_and_end` recovery outcome (doc says riding/countdown, the server's
// `getTrackedRide` says the ride is expired-but-unreported) used to return
// `resume: null`. But that branch's own comment promises "seal the final
// batch", and after a real reload there is no in-memory recorder left to
// seal — the caller needs a `TrackResumePlan` to reconstitute one from IDB
// (or re-import the key from `track_signing` if IDB was evicted) before it
// can call `finish()`. Every sibling branch that expects the caller to touch
// track-store already returns one; this was the one gap. Fixed additively
// (same `resumePlanFor` helper the other branches use), verified end-to-end
// below in "(d) … expired-but-unreported".
//
// STORAGE — matches what F1's own tests rely on (checked before writing
// this): `MemoryTrackStorage` (track-store.ts) and `memoryRideSessionStorage`
// (ride-session.ts), not a real browser IndexedDB and not the
// `fake-indexeddb` package (absent from package.json). A MemoryTrackStorage
// INSTANCE carried across a "reload" boundary stands in for IndexedDB
// surviving it; a fresh instance stands in for eviction — the same technique
// `ride-reload.test.ts` uses.
import { describe, expect, it, vi } from "vitest";

import {
  ApiError,
  donateTrack,
  endTrackedRide,
  getActiveRide,
  getTrackedRide,
  startTrackedRide,
  type RideOptions,
  type StartTrackedRideIn,
  type StartedTrackedRide,
  type TrackSigning,
  type TrackedRide,
} from "./api.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  parseRideSession,
  phaseOf,
  recoverRideSession,
  recoveryForServerConflict,
  type RideSessionDoc,
  type RideSessionStorage,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  MemoryTrackStorage,
  base64UrlEncode,
  bytesToHex,
  decodeTrackBatch,
  openTrackStore,
  recomputeChainRoot,
  type TrackFix,
  type TrackRecorder,
} from "./track-store.ts";

// ---------------------------------------------------------------------------
// Fetch rig: a routed fetch stub that RECORDS every call and can be told to
// FORBID calls outright — an unexpected call throws immediately, rather than
// merely being counted after the fact. That's what makes "zero mid-ride
// network calls" a hard assertion instead of an inspection.
// ---------------------------------------------------------------------------

interface FetchCall {
  method: string;
  url: string;
  init?: RequestInit;
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return String((input as { url?: string })?.url ?? input);
}

type RouteHandler = (call: FetchCall) => Response | Promise<Response>;

class FetchRig {
  readonly calls: FetchCall[] = [];
  private routes: { method: string; pattern: RegExp; handler: RouteHandler }[] = [];
  private forbidden = false;
  private forbidReason = "";

  constructor() {
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const call: FetchCall = {
        method: (init?.method ?? "GET").toUpperCase(),
        url: urlOf(input),
        init,
      };
      this.calls.push(call);
      if (this.forbidden) {
        throw new Error(
          `network call forbidden (${this.forbidReason}): ${call.method} ${call.url}`,
        );
      }
      const route = this.routes.find(
        (r) => r.method === call.method && r.pattern.test(call.url),
      );
      if (!route) {
        throw new Error(`no stub registered for ${call.method} ${call.url}`);
      }
      return route.handler(call);
    });
  }

  /** Most-recently-registered route wins, so a test can override an earlier
   *  "happy path" stub (e.g. a retry that should 409 this time). */
  on(method: string, pattern: RegExp, handler: RouteHandler): this {
    this.routes.unshift({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  forbid(reason: string): void {
    this.forbidden = true;
    this.forbidReason = reason;
  }

  allow(): void {
    this.forbidden = false;
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Same shape api.test.ts's stubAuth uses — proven against the real
 *  auth-storage.ts contract (`AUTH_STORAGE_KEY`), not re-derived here. */
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VEHICLE = "a1b2c3d4e5f60718";

const OPTIONS: RideOptions = {
  cost_hud: true,
  speedometer: "digital",
  theme: "auto",
  navigation: false,
  save_tracks: true,
  battery_modeling: true,
  nav_improvement: false,
  end_survey: true,
  own_device: false,
};

function buildRide(over: Partial<TrackedRide> = {}): TrackedRide {
  return {
    id: "ride-int-1",
    status: "watching",
    started_at: "2026-07-29T18:00:00.000Z",
    start_lat: 39.7392,
    start_lon: -104.9903,
    watch_expires_at: "2026-07-29T21:00:00.000Z",
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
    created_at: "2026-07-29T18:00:00.000Z",
    updated_at: "2026-07-29T18:00:00.000Z",
    distance_meters: null,
    distance_source: null,
    ride_options: OPTIONS,
    ...over,
  };
}

/** A valid `TrackSigning` — random key/nonce, real byte shapes (32-byte
 *  base64url key, 16-byte hex nonce), matching what `POST /tracked-rides`
 *  actually returns per master Part 2. */
async function genSigning(rideId: string, issuedAt: string): Promise<TrackSigning> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    alg: "HS256",
    key_id: rideId,
    key: base64UrlEncode(keyBytes),
    nonce: bytesToHex(nonceBytes),
    issued_at: issuedAt,
  };
}

function startedRideFrom(
  body: StartTrackedRideIn,
  signing: TrackSigning,
  rideId: string,
  startedAt: string,
): StartedTrackedRide {
  return {
    ...buildRide({
      id: rideId,
      started_at: startedAt,
      created_at: startedAt,
      updated_at: startedAt,
      start_lat: body.start_lat,
      start_lon: body.start_lon,
      vehicle_identifier: body.vehicle_identifier,
      reported_start_battery_percent: body.reported_start_battery_percent ?? null,
      ride_options: body.ride_options ?? null,
      track_signing: signing,
    }),
    plate_display_code: "654321",
  };
}

/** Monotonic synthetic fixes, 1 s apart by default — well under the 60 s
 *  batch-span rule, so batch boundaries land purely on the 25-waypoint count
 *  rule and every test's math is exact and easy to check by hand. */
function genFixes(count: number, opts: { startMs?: number; stepMs?: number } = {}): TrackFix[] {
  const startMs = opts.startMs ?? Date.parse("2026-07-29T18:00:01.000Z");
  const stepMs = opts.stepMs ?? 1000;
  const fixes: TrackFix[] = [];
  for (let i = 0; i < count; i += 1) {
    fixes.push({
      tMs: startMs + i * stepMs,
      lat: 39.7392 + i * 0.00003,
      lon: -104.9903 + i * 0.00002,
      accM: 8,
    });
  }
  return fixes;
}

async function assertContiguousChain(
  jwsList: string[],
  nonceHex: string,
  expectedRootHash: string | null,
): Promise<void> {
  const payloads = jwsList.map((jws) => decodeTrackBatch(jws));
  expect(payloads.map((p) => p.seq)).toEqual(payloads.map((_, i) => i));
  expect(payloads[0]?.prev).toBe("");
  expect(new Set(payloads.map((p) => p.non))).toEqual(new Set([nonceHex]));
  const stamps = payloads.flatMap((p) => p.pts.map(([dt]) => p.t0 + dt));
  for (let i = 1; i < stamps.length; i += 1) {
    expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
  }
  if (expectedRootHash !== null) {
    expect(await recomputeChainRoot(nonceHex, jwsList)).toBe(expectedRootHash);
  }
}

// ---------------------------------------------------------------------------
// The end-to-end "start" helper: wizard dispatch → REAL startTrackedRide()
// (routed through the fetch rig) → REAL track-store recorder seeded from the
// response's `track_signing`. Mirrors what `ride-screen-start.ts`'s
// `onRideStarted` hook + this lane's glue are contracted to do.
// ---------------------------------------------------------------------------

interface StartedRide {
  rig: FetchRig;
  sessionStorage: RideSessionStorage;
  tracks: MemoryTrackStorage;
  session: RideSessionStore;
  recorder: TrackRecorder;
  rideId: string;
  signing: TrackSigning;
  startedAtMs: number;
}

async function startServerRideEndToEnd(opts: {
  rig: FetchRig;
  rideId?: string;
}): Promise<StartedRide> {
  const rideId = opts.rideId ?? "ride-int-1";
  const startedAt = "2026-07-29T18:00:00.000Z";
  const signing = await genSigning(rideId, startedAt);

  opts.rig.on("POST", /\/api\/v1\/tracked-rides$/, async (call) => {
    const body = JSON.parse(String(call.init?.body)) as StartTrackedRideIn;
    return jsonResponse(startedRideFrom(body, signing, rideId, startedAt));
  });

  stubAuth();
  const sessionStorage = memoryRideSessionStorage();
  const session = createRideSessionStore({ storage: sessionStorage });
  session.dispatch({ type: "open", options: OPTIONS, screen: "2" });
  session.dispatch({
    type: "setDevice",
    device: {
      vehicleIdentifier: VEHICLE,
      plate: "654321",
      model: "Cosmo",
      batteryConfirmed: 91,
    },
  });
  session.dispatch({ type: "goto", screen: "6" });
  session.dispatch({ type: "startCountdown" });

  // The real client — a 404/409/whatever from the rig would surface as a real
  // ApiError here, exactly as it would in the browser.
  const started = await startTrackedRide({
    vehicle_identifier: VEHICLE,
    start_lat: 39.7392,
    start_lon: -104.9903,
    reported_start_battery_percent: 91,
    ride_options: OPTIONS,
  });
  if (!started.track_signing) {
    throw new Error("test fixture bug: the started ride has no track_signing");
  }

  // The tracking-integration lane's own seam: `track_signing` flows straight
  // from the server response into `startServerRide`, verbatim.
  const tracks = new MemoryTrackStorage();
  const trackStore = await openTrackStore({ storage: tracks });
  const recorder = await trackStore.startServerRide(started.track_signing);

  const startedAtMs = Date.parse(started.started_at);
  session.dispatch({
    type: "rideStarted",
    rideId: started.id,
    startedAtMs,
    trackKeyId: recorder.trackId,
  });

  return {
    rig: opts.rig,
    sessionStorage,
    tracks,
    session,
    recorder,
    rideId: started.id,
    signing: started.track_signing,
    startedAtMs,
  };
}

// ===========================================================================
// 1. Ride start seeds track-store from the server's signing material, and
//    recording alone never touches the network.
// ===========================================================================

describe("1. ride start seeds track-store from the server response (zero mid-ride I/O)", () => {
  it("a tracked ride's key/nonce/kid come from POST /tracked-rides's track_signing verbatim, and recording never calls the network", async () => {
    const rig = new FetchRig();
    const ride = await startServerRideEndToEnd({ rig });

    // Exactly one network call so far: the start.
    expect(rig.calls).toHaveLength(1);
    expect(rig.calls[0]).toMatchObject({ method: "POST", url: "/api/v1/tracked-rides" });

    // The recorder's identity is the SERVER's, carried through verbatim — not
    // re-derived or defaulted locally.
    expect(ride.recorder.trackId).toBe(ride.rideId);
    expect(ride.recorder.rideId).toBe(ride.rideId);
    expect(ride.recorder.isPrivate).toBe(false);
    expect(ride.recorder.nonce).toBe(ride.signing.nonce);
    expect(parseRideSession(ride.sessionStorage.read())).toMatchObject({
      state: "riding",
      rideId: ride.rideId,
      trackKeyId: ride.recorder.trackId,
    });

    // From here on, ride mode's whole point: no network call is allowed until
    // an explicit end/donate action.
    rig.forbid("recording is in progress");
    for (const fix of genFixes(40, { startMs: ride.startedAtMs + 1000 })) {
      const result = await ride.recorder.addFix(fix);
      expect(result.accepted).toBe(true);
    }
    expect(rig.calls).toHaveLength(1); // unchanged — recording touched nothing

    const info = ride.recorder.info();
    expect(info.waypointCount + info.pendingCount).toBe(40);
    rig.allow();
  });

  it("a private/guest ride never calls the network to start, identify, or record itself", async () => {
    const rig = new FetchRig();
    rig.forbid("private/guest rides never touch the network at all");

    const tracks = new MemoryTrackStorage();
    const trackStore = await openTrackStore({ storage: tracks });
    const recorder = await trackStore.startPrivateRide();
    expect(recorder.rideId).toBeNull();
    expect(recorder.isPrivate).toBe(true);

    for (const fix of genFixes(30)) {
      await recorder.addFix(fix);
    }
    const finished = await recorder.finish();
    expect(finished.waypointCount).toBe(30);
    expect(rig.calls).toHaveLength(0);
  });
});

// ===========================================================================
// 2. The 409 / reload resume UX, end to end.
// ===========================================================================

describe("2. the 409 / reload resume UX, end to end", () => {
  it("(a) a countdown crash with no rideId recovers to wizard:6 and never reconciles with the server", async () => {
    const rig = new FetchRig();
    // The recovery table's own comment: a null-rideId countdown crash must
    // NOT reconcile — a re-press's 409 is what catches a start that had, in
    // fact, committed server-side. Any call at all here is a bug.
    rig.forbid("a pre-start crash must not reconcile with the server");

    const sessionStorage = memoryRideSessionStorage();
    const session = createRideSessionStore({ storage: sessionStorage });
    session.dispatch({ type: "open", options: OPTIONS, screen: "2" });
    session.dispatch({
      type: "setDevice",
      device: { vehicleIdentifier: VEHICLE, plate: "654321", model: "Cosmo", batteryConfirmed: 91 },
    });
    session.dispatch({ type: "goto", screen: "6" });
    session.dispatch({ type: "startCountdown" });

    // ---- crash: nothing but the serialized doc survives ----
    const doc = parseRideSession(sessionStorage.read());
    expect(doc?.state).toBe("countdown");
    expect(doc?.rideId).toBeNull();

    const tracks = new MemoryTrackStorage();
    const trackStore = await openTrackStore({ storage: tracks });
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: () => getActiveRide(),
      getTrackedRide: (rideId) => getTrackedRide(rideId),
      readTrackTip: (trackId) => trackStore.readTip(trackId),
    });

    expect(outcome).toMatchObject({
      action: "reopen_wizard",
      reason: "pre_start_crash",
      reconciled: false,
      resume: null,
    });
    expect(phaseOf(outcome.doc as RideSessionDoc)).toBe("wizard:6");
    expect(rig.calls).toHaveLength(0);
  });

  it("(b) riding-state reload: IndexedDB survives — resumes the exact chain from its tip", async () => {
    const rig = new FetchRig();
    const ride = await startServerRideEndToEnd({ rig });
    for (const fix of genFixes(58, { startMs: ride.startedAtMs + 1000 })) {
      await ride.recorder.addFix(fix);
    }
    const infoBeforeReload = ride.recorder.info();
    expect(infoBeforeReload.batchCount).toBe(2); // 25 + 25, count-sealed
    expect(infoBeforeReload.pendingCount).toBe(8);

    // ---- the reload: only the session doc (localStorage) and the IDB
    // (`ride.tracks`) survive; everything else here is a NEW object graph ----
    const doc = parseRideSession(ride.sessionStorage.read());
    expect(doc?.state).toBe("riding");
    expect(doc?.rideId).toBe(ride.rideId);

    rig.on("GET", /\/api\/v1\/tracked-rides\/active$/, async () =>
      jsonResponse({
        active: buildRide({
          id: ride.rideId,
          track_signing: ride.signing,
          started_at: new Date(ride.startedAtMs).toISOString(),
        }),
      }),
    );

    const trackStore2 = await openTrackStore({ storage: ride.tracks }); // same IDB
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: () => getActiveRide(),
      getTrackedRide: (rideId) => getTrackedRide(rideId),
      readTrackTip: (trackId) => trackStore2.readTip(trackId),
    });

    expect(outcome).toMatchObject({
      action: "restore_riding",
      reason: "active_match",
      reconciled: true,
      note: null,
    });
    const plan = outcome.resume;
    if (!plan) throw new Error("expected a resume plan");
    expect(plan).toMatchObject({ trackId: ride.rideId, keySource: "idb", freshChain: false });

    // ---- act on the plan exactly as the HUD-handoff glue must: the SAME
    // chain continues, not a new one, and the crash-mid-batch pending points
    // come back as a rec:true batch in their original place ----
    const resumed = await trackStore2.resumeRide(plan.trackId, { signing: plan.signing });
    expect(resumed).toMatchObject({ continued: true, freshChain: false });
    expect(resumed.recovered).toMatchObject({ seq: 2, count: 8, rec: true });

    for (const fix of genFixes(20, { startMs: ride.startedAtMs + 59_000 })) {
      await resumed.recorder.addFix(fix);
    }
    const finished = await resumed.recorder.finish();
    const jwsList = (await resumed.recorder.batches()).map((b) => b.jws);
    await assertContiguousChain(jwsList, ride.signing.nonce, finished.chainRootHash);
    expect(jwsList).toHaveLength(4); // 25, 25, 8(rec), 20 — one unbroken chain

    // Exactly one network call across the whole reload+resume+ride-on: the
    // reconcile. Recording itself, before and after the "reload", is silent.
    expect(rig.calls.filter((c) => c.url.includes("/active"))).toHaveLength(1);
  });

  it("(b) riding-state reload: IndexedDB evicted — the key re-imports from active.track_signing and the chain restarts honestly at seq 0", async () => {
    const rig = new FetchRig();
    const ride = await startServerRideEndToEnd({ rig });
    for (const fix of genFixes(30, { startMs: ride.startedAtMs + 1000 })) {
      await ride.recorder.addFix(fix);
    }

    const doc = parseRideSession(ride.sessionStorage.read());
    rig.on("GET", /\/api\/v1\/tracked-rides\/active$/, async () =>
      jsonResponse({
        active: buildRide({
          id: ride.rideId,
          track_signing: ride.signing,
          started_at: new Date(ride.startedAtMs).toISOString(),
        }),
      }),
    );

    // A FRESH store: the 7-day PWA eviction / Safari-private-mode case —
    // nothing local survives the reload, only the server-issued key does.
    const evictedTracks = new MemoryTrackStorage();
    const trackStore2 = await openTrackStore({ storage: evictedTracks });
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: () => getActiveRide(),
      getTrackedRide: (rideId) => getTrackedRide(rideId),
      readTrackTip: (trackId) => trackStore2.readTip(trackId),
    });

    expect(outcome.action).toBe("restore_riding");
    const plan = outcome.resume;
    if (!plan) throw new Error("expected a resume plan");
    expect(plan).toMatchObject({ keySource: "server", freshChain: true, tip: null });
    // Never pretend the pre-eviction track is intact.
    expect(outcome.note).toBe("chain_restarted");

    const resumed = await trackStore2.resumeRide(plan.trackId, { signing: plan.signing });
    expect(resumed).toMatchObject({
      continued: false,
      freshChain: true,
      keySource: "server",
      recovered: null,
    });

    for (const fix of genFixes(10, { startMs: ride.startedAtMs + 31_000 })) {
      await resumed.recorder.addFix(fix);
    }
    const finished = await resumed.recorder.finish();
    const jwsList = (await resumed.recorder.batches()).map((b) => b.jws);
    // A fresh, self-consistent chain over only what survives — seq 0, prev
    // "" — never continuing the pre-eviction seq count. Server validation
    // adjudicates the rest (typically start_mismatch), not this client.
    expect(jwsList).toHaveLength(1);
    expect(decodeTrackBatch(jwsList[0]).seq).toBe(0);
    expect(decodeTrackBatch(jwsList[0]).prev).toBe("");
    await assertContiguousChain(jwsList, ride.signing.nonce, finished.chainRootHash);
  });

  it("(c) a startTrackedRide 409 drives the identical resume-or-end prompt as a reload", async () => {
    const rig = new FetchRig();
    const ride = await startServerRideEndToEnd({ rig, rideId: "ride-already-active" });
    // Ride long enough to seal at least one batch first, so THIS device
    // already knows part of the chain — the re-press must rehydrate that
    // non-empty tip, not restart it (30 fixes = one 25-point sealed batch +
    // 5 pending; `freshChain: false` below is only a meaningful assertion
    // once something has actually sealed).
    for (const fix of genFixes(30, { startMs: ride.startedAtMs + 1000 })) {
      await ride.recorder.addFix(fix);
    }

    // A second "Start in Veo" tap (e.g. after a stalled first attempt): the
    // server already has this account on a ride and 409s.
    rig.on("POST", /\/api\/v1\/tracked-rides$/, async () =>
      jsonResponse({ detail: { error: "active_ride_exists" } }, 409),
    );
    const retryError = await startTrackedRide({
      vehicle_identifier: VEHICLE,
      start_lat: 39.7392,
      start_lon: -104.9903,
    }).catch((e: unknown) => e);
    expect(retryError).toBeInstanceOf(ApiError);
    expect((retryError as ApiError).status).toBe(409);

    // The resume-or-end prompt reads the conflicting ride off /active — the
    // SAME call `recoverRideSession` makes on a plain reload, per the master
    // frontend plan ("startTrackedRide returning 409 → the same
    // resume-or-end prompt").
    rig.on("GET", /\/api\/v1\/tracked-rides\/active$/, async () =>
      jsonResponse({
        active: buildRide({
          id: ride.rideId,
          track_signing: ride.signing,
          started_at: new Date(ride.startedAtMs).toISOString(),
        }),
      }),
    );
    const conflicting = await getActiveRide();
    expect(conflicting?.id).toBe(ride.rideId);
    if (!conflicting) throw new Error("expected the conflicting ride");

    const trackStore2 = await openTrackStore({ storage: ride.tracks });
    const outcome = await recoveryForServerConflict(
      {
        doc: null,
        getActiveRide: () => getActiveRide(),
        getTrackedRide: (rideId) => getTrackedRide(rideId),
        readTrackTip: (trackId) => trackStore2.readTip(trackId),
      },
      conflicting,
      null,
    );

    expect(outcome).toMatchObject({
      action: "prompt_resume_or_end",
      reason: "active_conflict",
      reconciled: true,
    });
    const plan = outcome.resume;
    if (!plan) throw new Error("expected a resume plan");
    expect(plan).toMatchObject({ trackId: ride.rideId, keySource: "idb", freshChain: false });

    // [Resume] actually works end to end: the same chain continues.
    const resumed = await trackStore2.resumeRide(plan.trackId, { signing: plan.signing });
    expect(resumed.continued).toBe(true);
    expect(resumed.freshChain).toBe(false);
  });

  it("(d) doc says riding, server has no active ride — end already reported by another tab skips Screen 8 entirely", async () => {
    const rig = new FetchRig();
    const ride = await startServerRideEndToEnd({ rig });
    for (const fix of genFixes(20, { startMs: ride.startedAtMs + 1000 })) {
      await ride.recorder.addFix(fix);
    }
    const doc = parseRideSession(ride.sessionStorage.read());

    rig.on("GET", /\/api\/v1\/tracked-rides\/active$/, async () => jsonResponse({ active: null }));
    rig.on("GET", new RegExp(`/api/v1/tracked-rides/${ride.rideId}$`), async () =>
      jsonResponse(
        buildRide({
          id: ride.rideId,
          status: "completed",
          user_reported_ended_at: "2026-07-29T18:20:00.000Z",
          track_signing: ride.signing,
        }),
      ),
    );

    const trackStore2 = await openTrackStore({ storage: ride.tracks });
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: () => getActiveRide(),
      getTrackedRide: (rideId) => getTrackedRide(rideId),
      readTrackTip: (trackId) => trackStore2.readTip(trackId),
    });

    expect(outcome).toMatchObject({
      action: "restore_screen",
      reason: "end_already_reported",
      reconciled: true,
    });
    // OPTIONS has end_survey on and no route selected: the scooter-feedback
    // pane gates on, the nav pane doesn't — S9 as a whole still shows.
    expect(phaseOf(outcome.doc as RideSessionDoc)).toBe("survey(9)");
  });

  it("(d) doc says riding, server has no active ride — expired-but-unreported seals the final batch via the (now-fixed) resume plan", async () => {
    const rig = new FetchRig();
    const ride = await startServerRideEndToEnd({ rig });
    for (const fix of genFixes(23, { startMs: ride.startedAtMs + 1000 })) {
      await ride.recorder.addFix(fix);
    }
    // 23 < 25 and well under 60 s: nothing has sealed yet, all 23 sit `pending`.
    const before = ride.recorder.info();
    expect(before.batchCount).toBe(0);
    expect(before.pendingCount).toBe(23);

    const doc = parseRideSession(ride.sessionStorage.read());
    rig.on("GET", /\/api\/v1\/tracked-rides\/active$/, async () => jsonResponse({ active: null }));
    rig.on("GET", new RegExp(`/api/v1/tracked-rides/${ride.rideId}$`), async () =>
      jsonResponse(
        buildRide({
          id: ride.rideId,
          status: "expired",
          user_reported_ended_at: null,
          track_signing: ride.signing,
        }),
      ),
    );

    const trackStore2 = await openTrackStore({ storage: ride.tracks });
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: () => getActiveRide(),
      getTrackedRide: (rideId) => getTrackedRide(rideId),
      readTrackTip: (trackId) => trackStore2.readTip(trackId),
    });

    expect(outcome).toMatchObject({
      action: "seal_and_end",
      reason: "ride_expired",
      note: "ride_expired",
      reconciled: true,
    });
    expect(phaseOf(outcome.doc as RideSessionDoc)).toBe("ending(8)");

    // THE FIX under test: without a resume plan there would be no way to
    // reconstitute the recorder after a cold reload, and "seal the final
    // batch" — this branch's own promise — would be undoable. Before this
    // lane's fix, `outcome.resume` was unconditionally null here.
    //
    // `freshChain: true` is still correct and expected: nothing had sealed
    // yet (23 < 25, all still `pending`), so the chain legitimately starts at
    // seq 0 either way — `resumePlanFor`'s own comment calls this "the record
    // survived but nothing is sealed yet". `keySource: "idb"` is the load-
    // bearing part of this assertion: the local record (and its pending
    // points) really did survive, which is what makes the seal below
    // meaningful instead of silently sealing zero points.
    const plan = outcome.resume;
    expect(plan).not.toBeNull();
    if (!plan) throw new Error("expected a resume plan");
    expect(plan).toMatchObject({ trackId: ride.rideId, keySource: "idb", freshChain: true });

    // The reload IS the "crash" from track-store's point of view: the 23
    // points that were sitting `pending` under the abandoned in-memory
    // recorder are sealed immediately, as part of resuming — not lazily on a
    // later `finish()` — and honestly marked `rec: true` (master Part 2:
    // "rec:true marks a batch sealed from crash-recovered unsealed points").
    const resumed = await trackStore2.resumeRide(plan.trackId, { signing: plan.signing });
    expect(resumed.recovered).toMatchObject({ count: 23, rec: true });
    const sealedBatches = await resumed.recorder.batches();
    expect(sealedBatches).toHaveLength(1);
    expect(resumed.recorder.info().waypointCount).toBe(23);

    // A subsequent finish() is idempotent — nothing is left open to seal
    // twice, but it must not error or double-count.
    const finished = await resumed.recorder.finish();
    expect(finished.sealed).toBeNull();
    expect(finished.waypointCount).toBe(23);

    // PATCH /end still works after expiry — its sole precondition is an
    // unreported end, and donation requires it.
    rig.on("PATCH", new RegExp(`/api/v1/tracked-rides/${ride.rideId}/end$`), async () =>
      jsonResponse(buildRide({ id: ride.rideId, user_reported_ended_at: "2026-07-29T21:05:00.000Z" })),
    );
    const before2 = rig.calls.length;
    await endTrackedRide(ride.rideId, {
      ended_at: "2026-07-29T21:05:00.000Z",
      end_lat: 39.75,
      end_lon: -104.98,
    });
    expect(rig.calls.length).toBe(before2 + 1);
  });

  it("(d) doc says riding, server has no active ride — a true 404 ends locally with nothing to report", async () => {
    const rig = new FetchRig();
    const ride = await startServerRideEndToEnd({ rig });
    const doc = parseRideSession(ride.sessionStorage.read());

    rig.on("GET", /\/api\/v1\/tracked-rides\/active$/, async () => jsonResponse({ active: null }));
    rig.on("GET", new RegExp(`/api/v1/tracked-rides/${ride.rideId}$`), async () =>
      jsonResponse({ detail: "not found" }, 404),
    );

    const trackStore2 = await openTrackStore({ storage: ride.tracks });
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: () => getActiveRide(),
      getTrackedRide: (rideId) => getTrackedRide(rideId),
      readTrackTip: (trackId) => trackStore2.readTip(trackId),
    });

    // The 404 must arrive as a real ApiError carrying `.status === 404`
    // (`getTrackedRide` is `authedFetchJSON`-backed, not the public
    // `getJSON`'s NoDataError path) — this is the exact contract
    // `recoverRideSession`'s `errorStatus()` helper reads, verified here
    // against the real error class rather than a hand-rolled `{status:404}`.
    expect(outcome).toMatchObject({
      action: "local_end",
      reason: "ride_deleted",
      reconciled: true,
      resume: null,
    });
    expect(phaseOf(outcome.doc as RideSessionDoc)).toBe("done");
  });
});

// ===========================================================================
// 3. Reload-to-restored-and-recording completes within ~3 s — a real,
//    wall-clock-measured bound, not an inspection.
// ===========================================================================

describe("3. reload-to-restored-and-recording completes within ~3s", () => {
  it("bounds real wall-clock time from a cold reload through a resumed, fix-accepting recorder, even with realistic network latency", async () => {
    const NETWORK_LATENCY_MS = 400; // a real-ish mobile round trip, not instant mock time
    const rig = new FetchRig();
    const ride = await startServerRideEndToEnd({ rig });
    for (const fix of genFixes(40, { startMs: ride.startedAtMs + 1000 })) {
      await ride.recorder.addFix(fix);
    }
    const doc = parseRideSession(ride.sessionStorage.read());

    rig.on("GET", /\/api\/v1\/tracked-rides\/active$/, async () => {
      await delay(NETWORK_LATENCY_MS);
      return jsonResponse({
        active: buildRide({
          id: ride.rideId,
          track_signing: ride.signing,
          started_at: new Date(ride.startedAtMs).toISOString(),
        }),
      });
    });

    const trackStore2 = await openTrackStore({ storage: ride.tracks });

    const t0 = Date.now();
    const outcome = await recoverRideSession({
      doc,
      getActiveRide: () => getActiveRide(),
      getTrackedRide: (rideId) => getTrackedRide(rideId),
      readTrackTip: (trackId) => trackStore2.readTip(trackId),
    });
    expect(outcome.action).toBe("restore_riding");
    const plan = outcome.resume;
    if (!plan) throw new Error("expected a resume plan");
    const resumed = await trackStore2.resumeRide(plan.trackId, { signing: plan.signing });
    // "Restored AND recording" means the recorder must accept a fix right
    // now — not merely that a decision was reached.
    const result = await resumed.recorder.addFix({
      tMs: ride.startedAtMs + 100_000,
      lat: 39.75,
      lon: -104.98,
      accM: 6,
    });
    const elapsedMs = Date.now() - t0;

    expect(result.accepted).toBe(true);
    expect(elapsedMs).toBeLessThan(3000);
    // The bound isn't trivially satisfied by an all-synchronous mock: this
    // floor proves the simulated network round trip really was incurred.
    expect(elapsedMs).toBeGreaterThanOrEqual(NETWORK_LATENCY_MS);
  });
});

// ===========================================================================
// 4. Zero mid-ride network traffic — a hard assertion, fetch AND XHR.
// ===========================================================================

describe("4. zero mid-ride network traffic — a hard assertion", () => {
  it("never touches fetch or XMLHttpRequest while riding across many sealed batches, and fires exactly the expected calls at explicit end + donate", async () => {
    const rig = new FetchRig();
    // api.ts's sole network primitive is `fetch` (verified by inspection —
    // there is no XMLHttpRequest use anywhere in src/), but this stub makes
    // that an enforced invariant rather than an assumption: any construction
    // at all throws immediately.
    const xhrGuard = vi.fn(() => {
      throw new Error("XMLHttpRequest must never be used — api.ts's sole network primitive is fetch");
    });
    vi.stubGlobal("XMLHttpRequest", xhrGuard);

    const ride = await startServerRideEndToEnd({ rig });
    rig.forbid("riding — no network call is allowed until an explicit end/donate action");

    // 130 fixes = five 25-point batches sealed on the count rule + 5 pending
    // — several full batch-boundary crossings, still well under the 60 s
    // time-seal rule (each batch spans 24 s of synthetic 1 s-apart fixes).
    for (const fix of genFixes(130, { startMs: ride.startedAtMs + 1000 })) {
      await ride.recorder.addFix(fix);
    }
    expect(xhrGuard).not.toHaveBeenCalled();
    expect(rig.calls).toHaveLength(1); // only the original POST /tracked-rides start call

    const info = ride.recorder.info();
    expect(info.batchCount).toBe(5);
    expect(info.waypointCount).toBe(125);
    expect(info.pendingCount).toBe(5);

    // Explicit end + donate: the FIRST actions allowed to touch the network.
    rig.allow();
    rig.on("PATCH", new RegExp(`/api/v1/tracked-rides/${ride.rideId}/end$`), async () =>
      jsonResponse(buildRide({ id: ride.rideId, user_reported_ended_at: "2026-07-29T18:10:00.000Z" })),
    );
    rig.on("POST", new RegExp(`/api/v1/tracked-rides/${ride.rideId}/track$`), async () =>
      jsonResponse({
        donation_id: "don-1",
        verification: {},
        validation: { status: "pending", reasons: [] },
        distance_meters: 400,
        waypoint_count: 130,
        points: [],
      }),
    );

    const finished = await ride.recorder.finish();
    expect(finished.sealed).toMatchObject({ count: 5, rec: false });

    await endTrackedRide(ride.rideId, {
      ended_at: "2026-07-29T18:10:00.000Z",
      end_lat: 39.75,
      end_lon: -104.98,
    });
    const donation = await ride.recorder.buildDonation();
    expect(donation.batches).toHaveLength(6); // 5 sealed + the final partial
    await donateTrack(ride.rideId, donation);

    expect(rig.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
      "POST /api/v1/tracked-rides",
      "PATCH /api/v1/tracked-rides/ride-int-1/end",
      "POST /api/v1/tracked-rides/ride-int-1/track",
    ]);
  });
});

// ===========================================================================
// Real-device network verification design (cannot run in Vitest — no real
// GPS, no real IndexedDB eviction, no real cellular latency or airplane
// mode). This is the manual/QA companion to the automated suite above,
// covering exactly the phase spec's own acceptance line: "a ~30-min real
// ride with airplane-mode and BRB interludes produces an unbroken chain …
// reload mid-ride restores HUD + tracking within ~3 s; the network inspector
// shows zero track requests mid-ride."
//
//   1. iOS Safari (≥12.2) AND Android Chrome, at least one physical device
//      each — `inputmode="none"` / IndexedDB eviction behavior differs
//      enough between them that one is not a substitute for the other.
//   2. Open the browser's network panel (Safari Web Inspector / Chrome
//      DevTools remote debugging — not a desktop-only proxy, since mobile
//      Safari's inspector is the only thing that sees its real request
//      timeline) filtered to the API host, START a ride, and confirm the
//      panel shows exactly one request (`POST /tracked-rides`) until an
//      explicit end/donate — zero `waypoints`/`track` traffic for the whole
//      ride, matching this file's §4 assertion on real hardware.
//   3. Toggle Airplane Mode for a few minutes mid-ride: recording must
//      continue uninterrupted (§1/§4 here prove the code path never depended
//      on connectivity); re-enable and confirm no backlog of queued requests
//      fires — there should be nothing queued, because nothing was ever
//      deferred.
//   4. Trigger BRB, then background the tab/app for several minutes (real
//      background-tab GPS throttling, which no fake timer reproduces) and
//      foreground it — the clock must read unshifted elapsed time and
//      recording must have kept accepting fixes (gaps are tolerated;
//      monotonicity is per-point, not fixed-rate, per master Risk 9).
//   5. Force-quit or reload mid-ride (kill the tab, don't use the app's own
//      exit): reopen, and with a stopwatch confirm the HUD is back up and
//      visibly recording (a moving distance/clock, or a debug readout of
//      `recorder.info().pendingCount` ticking) within ~3 s of the page
//      becoming interactive — the real-hardware counterpart of §3's
//      wall-clock bound above, on real radios instead of a 400 ms mock.
//   6. Evict IndexedDB deliberately (Safari Private Browsing, or Chrome
//      DevTools → Application → Clear site data → IndexedDB only, mid-ride)
//      and reload: confirm the UI does NOT claim the pre-eviction track
//      survived (§2(b)'s `chain_restarted` note must surface somewhere
//      rider-visible once Screen 8/10 exist) and that recording resumes
//      under the SAME server key (re-imported from `active.track_signing`,
//      not a new one — the ride stays donatable, just from a shorter chain).
//   7. End the ride and donate on the real device; confirm via the API's own
//      logs/response that the uploaded chain verifies (`chain: "ok"` in
//      `DonateTrackResponse.verification`) — the end-to-end proof that the
//      byte-for-byte chain math this file exercises with synthetic fixes
//      also holds for real GPS jitter, real clock drift, and a real backend.
// ===========================================================================
