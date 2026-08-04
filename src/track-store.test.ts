// track-store: the Part 2 chain format, the batch-boundary rules, crash
// recovery and the resume paths the ride-session recovery table depends on.
//
// The load-bearing assertions replay the golden fixture's fix streams through
// the real recorder and demand the compact JWS strings and chain root come
// out BYTE-IDENTICAL to `tests/fixtures/track-chain-vectors.json` — the file the
// API repo's tests/test_track_verify.py consumes as its own copy. The fixture is
// produced by scripts/gen-track-vectors.mjs, an independent implementation
// (node:crypto, no shared code with this module), so agreement is evidence
// about the format rather than about a helper both sides call.
import { beforeAll, describe, expect, it } from "vitest";

import type { TrackSigning } from "./api.ts";
import {
  MAX_BATCH_SPAN_MS,
  MAX_WAYPOINTS_PER_BATCH,
  MemoryTrackStorage,
  PRIVATE_RIDE_ID,
  TRACK_DB_NAME,
  TRACK_DB_VERSION,
  TRACK_JWS_TYP,
  TRACK_STORE_BATCHES,
  TRACK_STORE_PENDING,
  TRACK_STORE_RIDES,
  TrackStoreError,
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  decodeTrackBatch,
  hexToBytes,
  importTrackKey,
  initialChainHash,
  openTrackStore,
  recomputeChainRoot,
  type Bytes,
  type StoredTrackRide,
  type TrackFix,
  type TrackRecorder,
  type TrackStorage,
} from "./track-store.ts";
import rawVectors from "../tests/fixtures/track-chain-vectors.json";

// --- Fixture shape. JSON carries no types, so declare the contract once and
// cast at the boundary rather than sprinkling assertions through the tests.

type FixTuple = [number, number, number, number];

interface VectorRide {
  ride_id: string;
  nonce: string;
  key_b64url: string;
  started_at_ms: number;
  ended_at_ms: number;
  fixes: FixTuple[];
}

interface VectorScenario {
  name: string;
  ride: "primary" | "short";
  signing_key: "ride" | "foreign";
  rec_batches: number[];
  replay: { fixes: "ride" | FixTuple[] } | null;
  batch_count: number;
  waypoint_count: number;
  chain_root_hash: string;
  batches: string[];
  expected: {
    verdict: "valid" | "invalid";
    failing_check: string | null;
    verification_key: string | null;
    reasons: string[];
  };
}

interface VectorFile {
  schema_version: number;
  contract: { pipeline_order: string[] };
  limits: {
    max_waypoints_per_batch: number;
    max_batch_span_ms: number;
    jws_typ: string;
    payload_version: number;
    private_ride_id: string;
  };
  foreign_key_b64url: string;
  rides: Record<"primary" | "short", VectorRide>;
  scenarios: VectorScenario[];
}

const vectors = rawVectors as unknown as VectorFile;

function scenario(name: string): VectorScenario {
  const found = vectors.scenarios.find((s) => s.name === name);
  if (!found) throw new Error(`fixture scenario ${name} is missing`);
  return found;
}

function signingFor(ride: VectorRide): TrackSigning {
  return {
    alg: "HS256",
    key_id: ride.ride_id,
    key: ride.key_b64url,
    nonce: ride.nonce,
    issued_at: new Date(ride.started_at_ms).toISOString(),
  };
}

function replayFixes(sc: VectorScenario): FixTuple[] {
  if (!sc.replay) throw new Error(`${sc.name} is not replayable from fixes`);
  return sc.replay.fixes === "ride"
    ? vectors.rides[sc.ride].fixes
    : sc.replay.fixes;
}

const asFix = ([tMs, lat, lon, accM]: FixTuple): TrackFix => ({
  tMs,
  lat,
  lon,
  accM,
});

async function newStore(storage: TrackStorage = new MemoryTrackStorage()) {
  return { storage, store: await openTrackStore({ storage }) };
}

/** Storage that still holds the sealed `batches` but has lost the `rides`
 *  record — the partial-eviction shape the recovery table's "server-active but
 *  doc missing" path has to survive. A decorator rather than a subclass so it
 *  is obvious that only `getRide` is different. */
class RideRecordEvicted implements TrackStorage {
  readonly durable = true;
  constructor(private readonly inner: TrackStorage) {}
  async getRide(): Promise<StoredTrackRide | null> {
    return null;
  }
  putRide(ride: StoredTrackRide) {
    return this.inner.putRide(ride);
  }
  listRides() {
    return this.inner.listRides();
  }
  getBatches(trackId: string) {
    return this.inner.getBatches(trackId);
  }
  commitSeal(...args: Parameters<TrackStorage["commitSeal"]>) {
    return this.inner.commitSeal(...args);
  }
  putPending(...args: Parameters<TrackStorage["putPending"]>) {
    return this.inner.putPending(...args);
  }
  getPending(trackId: string) {
    return this.inner.getPending(trackId);
  }
  deletePending(trackId: string) {
    return this.inner.deletePending(trackId);
  }
  deleteRide(trackId: string) {
    return this.inner.deleteRide(trackId);
  }
}

/** Feed a whole fix stream and seal the final partial batch, exactly as a ride
 *  does: HUD fixes in, `finish()` at ride end. */
async function recordAll(
  recorder: TrackRecorder,
  fixes: readonly FixTuple[],
): Promise<string[]> {
  for (const fix of fixes) await recorder.addFix(asFix(fix));
  await recorder.finish();
  return (await recorder.batches()).map((b) => b.jws);
}

describe("byte plumbing", () => {
  it("round-trips hex and base64url", () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 254, 255]) as Bytes;
    expect(bytesToHex(bytes)).toBe("00010f107f80feff");
    expect([...hexToBytes("00010f107f80feff")]).toEqual([...bytes]);
    expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes]);
  });

  it("emits unpadded base64url for every input length", () => {
    // JWS forbids padding; the three residue classes are the whole risk.
    expect(base64UrlEncode(Uint8Array.from([255]) as Bytes)).toBe("_w");
    expect(base64UrlEncode(Uint8Array.from([255, 255]) as Bytes)).toBe("__8");
    expect(base64UrlEncode(Uint8Array.from([255, 255, 255]) as Bytes)).toBe(
      "____",
    );
    expect(base64UrlEncode(Uint8Array.from([251, 239, 190]) as Bytes)).toBe(
      "----",
    );
  });

  it("rejects malformed hex rather than hashing garbage", () => {
    expect(() => hexToBytes("abc")).toThrow(TrackStoreError);
    expect(() => hexToBytes("zz")).toThrow(TrackStoreError);
    // Regression: a per-byte Number.parseInt parses PREFIXES, so each of these
    // used to decode silently — "1z" as 0x01, "-1" as 0xff, " 1" as 0x01 —
    // producing an H_-1 the API cannot reproduce, with no local signal at all.
    for (const bad of ["1z", "-1", " 1", "0x", "1 ", "+1", "e+1", "  "]) {
      expect(() => hexToBytes(bad), `hexToBytes(${JSON.stringify(bad)})`).toThrow(
        TrackStoreError,
      );
    }
    // …while every real hex byte still decodes.
    expect(bytesToHex(hexToBytes("000f10FF"))).toBe("000f10ff");
    expect(hexToBytes("")).toHaveLength(0);
  });

  it("derives H_-1 from the nonce's RAW bytes, not its hex text", async () => {
    const nonce = vectors.rides.primary.nonce;
    const fromBytes = bytesToHex(await initialChainHash(nonce));
    const digestOfHexText = bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)),
      ),
    );
    expect(fromBytes).not.toBe(digestOfHexText);
    // sha256 of the 16 raw bytes 0f1e…e1f0 — the value the API must compute too.
    expect(await recomputeChainRoot(nonce, [])).toBe(fromBytes);
  });
});

describe("golden vectors — the cross-repo contract", () => {
  it("agrees with the fixture's declared limits", () => {
    expect(vectors.limits.max_waypoints_per_batch).toBe(
      MAX_WAYPOINTS_PER_BATCH,
    );
    expect(vectors.limits.max_batch_span_ms).toBe(MAX_BATCH_SPAN_MS);
    expect(vectors.limits.jws_typ).toBe(TRACK_JWS_TYP);
    expect(vectors.limits.private_ride_id).toBe(PRIVATE_RIDE_ID);
  });

  it("folds every scenario's chain to its declared chain_root_hash", async () => {
    // Holds for the deliberately broken chains too: the fixture's invariant is
    // that chain_root_hash is H_n over `batches` exactly as listed.
    for (const sc of vectors.scenarios) {
      const nonce = vectors.rides[sc.ride].nonce;
      expect(await recomputeChainRoot(nonce, sc.batches)).toBe(
        sc.chain_root_hash,
      );
    }
  });

  it("chains `prev` as sha256 of the predecessor's compact JWS", async () => {
    const sc = scenario("valid");
    let prev = "";
    for (const [i, jws] of sc.batches.entries()) {
      const payload = decodeTrackBatch(jws);
      expect(payload.seq).toBe(i);
      expect(payload.prev).toBe(prev);
      prev = bytesToHex(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jws)),
        ),
      );
    }
  });

  it("reproduces the `valid` chain byte-for-byte from its fix stream", async () => {
    const sc = scenario("valid");
    const ride = vectors.rides.primary;
    const { store } = await newStore();
    const recorder = await store.startServerRide(signingFor(ride));
    const produced = await recordAll(recorder, replayFixes(sc));

    expect(produced).toEqual(sc.batches);
    expect(recorder.chainRootHash).toBe(sc.chain_root_hash);
    expect(recorder.info().waypointCount).toBe(sc.waypoint_count);
    expect(recorder.info().batchCount).toBe(sc.batch_count);
  });

  it("reproduces the `teleport` and `out-of-bounds-timestamps` chains", async () => {
    // Same client behaviour on hostile input: the recorder signs what the GPS
    // reported and lets the server adjudicate. Timing matters here — the
    // out-of-bounds stream's shifted first batch must not change the seal
    // boundaries, and this is what proves it.
    for (const name of ["teleport", "out-of-bounds-timestamps"]) {
      const sc = scenario(name);
      const { store } = await newStore();
      const recorder = await store.startServerRide(
        signingFor(vectors.rides[sc.ride]),
      );
      expect(await recordAll(recorder, replayFixes(sc))).toEqual(sc.batches);
    }
  });

  it("reproduces the single-batch `volume-too-few-waypoints` chain", async () => {
    const sc = scenario("volume-too-few-waypoints");
    const { store } = await newStore();
    const recorder = await store.startServerRide(
      signingFor(vectors.rides.short),
    );
    expect(await recordAll(recorder, replayFixes(sc))).toEqual(sc.batches);
  });

  it("signs with the ride's own key — the foreign-key chain must differ", async () => {
    const sc = scenario("signed-with-foreign-key");
    const ride = vectors.rides.primary;
    const { store } = await newStore();
    const recorder = await store.startServerRide(signingFor(ride));
    const produced = await recordAll(recorder, replayFixes(sc));

    // seq 0's signing input is identical — same ride id, nonce and points, and
    // no predecessor hash yet — so the ONLY difference is the MAC. That is
    // exactly what check 1 catches, with no help from any later check.
    expect(produced[0].split(".").slice(0, 2)).toEqual(
      sc.batches[0].split(".").slice(0, 2),
    );
    expect(produced[0].split(".")[2]).not.toBe(sc.batches[0].split(".")[2]);
    // From seq 1 on, the wrong key has also poisoned every `prev`, so the whole
    // rest of the chain diverges.
    for (const [i, jws] of produced.entries()) {
      if (i > 0) expect(jws).not.toBe(sc.batches[i]);
    }
  });
});

describe("batch boundary rules", () => {
  const ride = vectors.rides.primary;

  async function recorderFor() {
    const { storage, store } = await newStore();
    return { storage, recorder: await store.startServerRide(signingFor(ride)) };
  }

  it("seals at 25 waypoints without waiting for the next fix", async () => {
    const { recorder } = await recorderFor();
    for (let i = 0; i < MAX_WAYPOINTS_PER_BATCH - 1; i += 1) {
      const res = await recorder.addFix({ tMs: 1000 + i, lat: 39.7, lon: -105 });
      expect(res.sealed).toBeNull();
    }
    const last = await recorder.addFix({ tMs: 2000, lat: 39.7, lon: -105 });
    expect(last.sealed?.count).toBe(MAX_WAYPOINTS_PER_BATCH);
    expect(last.openCount).toBe(0);
    // A ride that ends right here has nothing left to seal.
    expect((await recorder.finish()).sealed).toBeNull();
  });

  it("opens the next batch with the fix that reaches the 60 s bound", async () => {
    const { recorder } = await recorderFor();
    await recorder.addFix({ tMs: 0, lat: 39.7, lon: -105 });
    const inside = await recorder.addFix({
      tMs: MAX_BATCH_SPAN_MS - 1,
      lat: 39.7,
      lon: -105,
    });
    expect(inside.sealed).toBeNull();
    const boundary = await recorder.addFix({
      tMs: MAX_BATCH_SPAN_MS,
      lat: 39.7,
      lon: -105,
    });
    expect(boundary.sealed?.count).toBe(2);
    // The bound is exclusive on the sealed batch: span stays < 60 s, always.
    expect(boundary.sealed?.t1).toBe(MAX_BATCH_SPAN_MS - 1);
    expect(boundary.openCount).toBe(1);
  });

  it("seals a final partial batch at ride end and stops recording", async () => {
    const { recorder } = await recorderFor();
    await recorder.addFix({ tMs: 0, lat: 39.7, lon: -105 });
    await recorder.addFix({ tMs: 1000, lat: 39.7001, lon: -105 });
    const finished = await recorder.finish();
    expect(finished.sealed?.count).toBe(2);
    expect(finished.batchCount).toBe(1);
    expect(finished.chainRootHash).toBe(finished.sealed?.chainHash);
    expect(recorder.isRecording).toBe(false);
    const after = await recorder.addFix({ tMs: 2000, lat: 39.7, lon: -105 });
    expect(after).toMatchObject({ accepted: false, rejected: "not_recording" });
    // Idempotent: a second finish seals nothing and loses nothing.
    expect((await recorder.finish()).batchCount).toBe(1);
  });

  // Regression: the recorder used to advance `seq` / `prev` / `H_n` and drop the
  // open batch BEFORE awaiting commitSeal, so one transient IndexedDB failure
  // punched a permanent hole in the chain — the donated batches would be
  // non-contiguous and fail the API's check 2 as `chain_invalid`, silently, for
  // a write the rider never saw fail.
  it("does not advance the chain tip when the seal's write fails", async () => {
    const inner = new MemoryTrackStorage();
    let failNextSeal = true;
    const flaky: TrackStorage = {
      durable: true,
      putRide: (r) => inner.putRide(r),
      getRide: (id) => inner.getRide(id),
      listRides: () => inner.listRides(),
      getBatches: (id) => inner.getBatches(id),
      commitSeal: (batch, rideRow) => {
        if (failNextSeal) {
          failNextSeal = false;
          return Promise.reject(new Error("QuotaExceededError"));
        }
        return inner.commitSeal(batch, rideRow);
      },
      putPending: (p) => inner.putPending(p),
      getPending: (id) => inner.getPending(id),
      deletePending: (id) => inner.deletePending(id),
      deleteRide: (id) => inner.deleteRide(id),
    };
    const store = await openTrackStore({ storage: flaky });
    const recorder = await store.startServerRide(signingFor(ride));
    const before = recorder.info();

    await recorder.addFix({ tMs: 1000, lat: 39.7, lon: -105 });
    await expect(recorder.sealOpenBatch()).rejects.toThrow("QuotaExceededError");

    // Nothing moved, and the points are still open — so the retry below seals
    // seq 0, not seq 1.
    expect(recorder.info()).toMatchObject({
      nextSeq: before.nextSeq,
      prevJwsHash: before.prevJwsHash,
      chainHash: before.chainHash,
      batchCount: 0,
      openCount: 1,
    });

    await recorder.addFix({ tMs: 2000, lat: 39.7001, lon: -105 });
    const retry = await recorder.finish();
    expect(retry.sealed).toMatchObject({ seq: 0, count: 2 });
    const jwsList = (await recorder.batches()).map((b) => b.jws);
    expect(jwsList).toHaveLength(1);
    expect(decodeTrackBatch(jwsList[0])).toMatchObject({ seq: 0, prev: "" });
    expect(await recomputeChainRoot(ride.nonce, jwsList)).toBe(
      retry.chainRootHash,
    );
    // A failed final seal still ends recording — the ride IS over — and the
    // points survive in `pending` for a later resume either way.
    expect(recorder.isRecording).toBe(false);
  });

  it("drops non-advancing and nonsense fixes instead of breaking the chain", async () => {
    const { recorder } = await recorderFor();
    await recorder.addFix({ tMs: 5000, lat: 39.7, lon: -105 });
    expect(await recorder.addFix({ tMs: 5000, lat: 39.7, lon: -105 })).toMatchObject(
      { accepted: false, rejected: "non_monotonic" },
    );
    expect(await recorder.addFix({ tMs: 4000, lat: 39.7, lon: -105 })).toMatchObject(
      { accepted: false, rejected: "non_monotonic" },
    );
    expect(
      await recorder.addFix({ tMs: 6000, lat: Number.NaN, lon: -105 }),
    ).toMatchObject({ accepted: false, rejected: "invalid_fix" });
    expect(await recorder.addFix({ tMs: 7000, lat: 91, lon: -105 })).toMatchObject(
      { accepted: false, rejected: "invalid_fix" },
    );
    const sealed = await recorder.sealOpenBatch();
    expect(sealed?.count).toBe(1);
    // Monotonicity holds ACROSS the seal, not just inside a batch.
    expect(
      await recorder.addFix({ tMs: 5000, lat: 39.7, lon: -105 }),
    ).toMatchObject({ accepted: false, rejected: "non_monotonic" });
  });

  it("rounds coordinates to 6 decimals and accuracy to an integer", async () => {
    const { recorder } = await recorderFor();
    await recorder.addFix({
      tMs: 1_700_000_000_000,
      lat: 39.7401234567,
      lon: -104.9902345678,
      accM: 7.6,
    });
    // Unknown accuracy becomes 0, never a large number: the server SUBTRACTS
    // accuracy from segment distance before the speed check.
    await recorder.addFix({
      tMs: 1_700_000_001_000,
      lat: 39.74,
      lon: -104.99,
      accM: null,
    });
    const batch = await recorder.sealOpenBatch();
    const payload = decodeTrackBatch(batch?.jws ?? "");
    expect(payload.pts[0]).toEqual([0, 39.740123, -104.990235, 8]);
    expect(payload.pts[1]).toEqual([1000, 39.74, -104.99, 0]);
    expect(payload.t0).toBe(1_700_000_000_000);
    expect(payload.t1).toBe(1_700_000_001_000);
  });

  it("keeps `seq` contiguous under a burst of concurrent fixes", async () => {
    // The HUD's watchPosition can fire faster than an IDB write settles; a
    // recorder that let two seals interleave would skip a seq and break the
    // chain irrecoverably.
    const { recorder } = await recorderFor();
    const fixes = ride.fixes.slice(0, 60);
    await Promise.all(fixes.map((f) => recorder.addFix(asFix(f))));
    await recorder.finish();
    const batches = await recorder.batches();
    expect(batches.map((b) => b.seq)).toEqual(
      batches.map((_b, i) => i),
    );
    expect(batches.reduce((n, b) => n + b.count, 0)).toBe(fixes.length);
    expect(await recomputeChainRoot(ride.nonce, batches.map((b) => b.jws))).toBe(
      recorder.chainRootHash,
    );
  });
});

describe("crash recovery", () => {
  const ride = vectors.rides.primary;

  it("reproduces the `recovered-batch` vector by replaying the pending store", async () => {
    const sc = scenario("recovered-batch");
    const fixes = replayFixes(sc);
    const storage = new MemoryTrackStorage();

    // ---- Session 1: two full batches sealed, then five points recorded into
    // the `pending` store and the tab dies mid-batch.
    const first = await openTrackStore({ storage });
    const before = await first.startServerRide(signingFor(ride));
    for (const fix of fixes.slice(0, 55)) await before.addFix(asFix(fix));
    expect(before.info()).toMatchObject({ batchCount: 2, openCount: 5 });
    expect(await storage.getPending(ride.ride_id)).not.toBeNull();

    // ---- Session 2: resume seals those five as a rec:true batch at seq 2.
    const second = await openTrackStore({ storage });
    const resume = await second.resumeRide(ride.ride_id, {
      signing: signingFor(ride),
    });
    expect(resume).toMatchObject({
      continued: true,
      freshChain: false,
      keySource: "idb",
    });
    expect(resume.recovered?.seq).toBe(2);
    expect(resume.recovered?.rec).toBe(true);
    expect(decodeTrackBatch(resume.recovered?.jws ?? "").rec).toBe(true);
    expect(await storage.getPending(ride.ride_id)).toBeNull();

    const produced = await recordAll(resume.recorder, fixes.slice(55));
    expect(produced).toEqual(sc.batches);
    expect(resume.recorder.chainRootHash).toBe(sc.chain_root_hash);
    // The recovered chain differs from `valid` from seq 2 onward — `rec` is
    // signed content, so it cannot be a free relabel.
    expect(sc.chain_root_hash).not.toBe(scenario("valid").chain_root_hash);
    expect(produced.slice(0, 2)).toEqual(scenario("valid").batches.slice(0, 2));
  });

  it("discards pending points that predate the sealed tip", async () => {
    // A stale write from an older chain generation would break check 3's
    // strict monotonicity — it is not recoverable data.
    const storage = new MemoryTrackStorage();
    const first = await openTrackStore({ storage });
    const recorder = await first.startServerRide(signingFor(ride));
    await recorder.addFix({ tMs: 10_000, lat: 39.7, lon: -105 });
    await recorder.sealOpenBatch();
    await storage.putPending({
      trackId: ride.ride_id,
      t0: 5_000,
      points: [[0, 39.7, -105, 5]],
      lastPointMs: 5_000,
    });

    const second = await openTrackStore({ storage });
    const resume = await second.resumeRide(ride.ride_id);
    expect(resume.recovered).toBeNull();
    expect(resume.tip.nextSeq).toBe(1);
    expect(await storage.getPending(ride.ride_id)).toBeNull();
  });

  it("reports unsealed pending points through readTip", async () => {
    // ride-session's Screen 10 gate reads this: "no sealed batches" is not the
    // same as "no waypoints recorded".
    const storage = new MemoryTrackStorage();
    const store = await openTrackStore({ storage });
    const recorder = await store.startServerRide(signingFor(ride));
    for (const fix of ride.fixes.slice(0, 3)) await recorder.addFix(asFix(fix));
    const tip = await store.readTip(ride.ride_id);
    expect(tip).toMatchObject({
      batchCount: 0,
      waypointCount: 0,
      pendingCount: 3,
    });
    expect(recorder.info().pendingCount).toBe(3);
  });
});

describe("resume paths the recovery table depends on", () => {
  const ride = vectors.rides.primary;

  it("continues an existing chain from its tip", async () => {
    const storage = new MemoryTrackStorage();
    const first = await openTrackStore({ storage });
    const recorder = await first.startServerRide(signingFor(ride));
    for (const fix of ride.fixes.slice(0, 50)) await recorder.addFix(asFix(fix));
    const tipBefore = recorder.info();

    const second = await openTrackStore({ storage });
    const resume = await second.resumeRide(ride.ride_id);
    expect(resume.continued).toBe(true);
    expect(resume.freshChain).toBe(false);
    expect(resume.tip.nextSeq).toBe(tipBefore.nextSeq);
    expect(resume.tip.prevJwsHash).toBe(tipBefore.prevJwsHash);
    expect(resume.tip.chainHash).toBe(tipBefore.chainHash);
    expect(resume.tip.waypointCount).toBe(50);
  });

  it("rehydrates the tip from the batches store when the ride record is gone", async () => {
    // The recovery table's "server-active but doc missing" path: resume must
    // read the chain tip out of `batches` before sealing anything, or a
    // restarted seq breaks verification.
    const storage = new MemoryTrackStorage();
    const first = await openTrackStore({ storage });
    const recorder = await first.startServerRide(signingFor(ride));
    // Exactly one full batch, nothing pending — isolates tip rehydration from
    // the crash-recovery seal, which the recovery tests cover separately.
    for (const fix of ride.fixes.slice(0, 25)) await recorder.addFix(asFix(fix));
    const tipBefore = recorder.info();
    expect(tipBefore).toMatchObject({ nextSeq: 1, openCount: 0 });

    const second = await openTrackStore({
      storage: new RideRecordEvicted(storage),
    });
    const resume = await second.resumeRide(ride.ride_id, {
      signing: signingFor(ride),
    });
    expect(resume.keySource).toBe("server");
    expect(resume.continued).toBe(true);
    expect(resume.recovered).toBeNull();
    expect(resume.tip.nextSeq).toBe(tipBefore.nextSeq);
    expect(resume.tip.prevJwsHash).toBe(tipBefore.prevJwsHash);
    expect(resume.tip.chainHash).toBe(tipBefore.chainHash);

    // And the continued chain still folds to one root across the two sessions.
    await resume.recorder.addFix(asFix(ride.fixes[25]));
    await resume.recorder.finish();
    const all = (await resume.recorder.batches()).map((b) => b.jws);
    expect(await recomputeChainRoot(ride.nonce, all)).toBe(
      resume.recorder.chainRootHash,
    );
  });

  it("restarts honestly at seq 0 when IndexedDB was evicted entirely", async () => {
    const { store } = await newStore();
    const resume = await store.resumeRide(ride.ride_id, {
      signing: signingFor(ride),
    });
    expect(resume).toMatchObject({
      continued: false,
      freshChain: true,
      keySource: "server",
      recovered: null,
    });
    expect(resume.tip.nextSeq).toBe(0);
    expect(resume.tip.prevJwsHash).toBe("");
    expect(resume.tip.chainHash).toBe(
      bytesToHex(await initialChainHash(ride.nonce)),
    );

    const batch = await (async () => {
      await resume.recorder.addFix(asFix(ride.fixes[0]));
      return resume.recorder.sealOpenBatch();
    })();
    expect(decodeTrackBatch(batch?.jws ?? "")).toMatchObject({
      seq: 0,
      prev: "",
    });
  });

  it("refuses to resume a server ride with neither a local record nor signing", async () => {
    const { store } = await newStore();
    await expect(store.resumeRide(ride.ride_id)).rejects.toThrow(
      TrackStoreError,
    );
    expect(await store.readTip(ride.ride_id)).toBeNull();
  });

  it("does not splice a chain signed under a different nonce", async () => {
    const storage = new MemoryTrackStorage();
    const first = await openTrackStore({ storage });
    const recorder = await first.startServerRide(signingFor(ride));
    await recorder.addFix(asFix(ride.fixes[0]));
    await recorder.sealOpenBatch();

    // Same ride id, rotated signing material: the sealed batches belong to the
    // old generation and must not become seq 0's predecessor.
    const rotated: TrackSigning = {
      ...signingFor(ride),
      nonce: "ffeeddccbbaa99887766554433221100",
    };
    const second = await openTrackStore({
      storage: new RideRecordEvicted(storage),
    });
    const resume = await second.resumeRide(ride.ride_id, { signing: rotated });
    expect(resume.freshChain).toBe(true);
    expect(resume.tip.nextSeq).toBe(0);
    // The old generation is WIPED, not merely ignored: the new chain restarts
    // at seq 0 and would otherwise leave higher-seq orphans behind for a later
    // donation to upload.
    expect(await storage.getBatches(ride.ride_id)).toEqual([]);
    expect(await storage.getPending(ride.ride_id)).toBeNull();
  });
});

describe("private rides", () => {
  const fixedKeyBytes = new Uint8Array(32).fill(0x5a) as Bytes;

  async function privateStore() {
    const storage = new MemoryTrackStorage();
    const store = await openTrackStore({
      storage,
      randomBytes: (n) => new Uint8Array(n).fill(0xab) as Bytes,
      generatePrivateKey: () =>
        crypto.subtle.importKey(
          "raw",
          fixedKeyBytes,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
    });
    return { storage, store };
  }

  it("signs under `private` identity with a client-random key", async () => {
    const { store } = await privateStore();
    const recorder = await store.startPrivateRide();
    expect(recorder.isPrivate).toBe(true);
    expect(recorder.rideId).toBeNull();
    expect(recorder.trackId).toBe(`${PRIVATE_RIDE_ID}-${"ab".repeat(6)}`);
    expect(recorder.nonce).toBe("ab".repeat(16));

    await recorder.addFix({ tMs: 1000, lat: 39.7, lon: -105, accM: 4 });
    const batch = await recorder.sealOpenBatch();
    const [headerSeg] = (batch?.jws ?? "").split(".");
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(headerSeg)),
    ) as { alg: string; typ: string; kid: string };
    expect(header).toEqual({
      alg: "HS256",
      typ: TRACK_JWS_TYP,
      kid: PRIVATE_RIDE_ID,
    });
    expect(decodeTrackBatch(batch?.jws ?? "").rid).toBe(PRIVATE_RIDE_ID);
    expect(await recomputeChainRoot(recorder.nonce, [batch?.jws ?? ""])).toBe(
      recorder.chainRootHash,
    );
  });

  it("never assembles a donation payload", async () => {
    const { store } = await privateStore();
    const recorder = await store.startPrivateRide();
    await recorder.addFix({ tMs: 1000, lat: 39.7, lon: -105 });
    await recorder.finish();
    await expect(recorder.buildDonation()).rejects.toMatchObject({
      code: "private_ride",
    });
  });

  it("mints a new chain when a private ride's local record is gone", async () => {
    const { store } = await privateStore();
    const resume = await store.resumeRide(`${PRIVATE_RIDE_ID}-${"ab".repeat(6)}`, {
      isPrivate: true,
    });
    expect(resume).toMatchObject({
      keySource: "generated",
      freshChain: true,
      continued: false,
    });
  });
});

describe("donation payload", () => {
  const ride = vectors.rides.primary;

  it("carries every sealed batch, in seq order, and nothing else", async () => {
    const sc = scenario("valid");
    const { store } = await newStore();
    const recorder = await store.startServerRide(signingFor(ride));
    await recordAll(recorder, replayFixes(sc));

    const body = await recorder.buildDonation();
    expect(body.batches).toEqual(sc.batches);
    // The batches ARE the body: the server recomputes the chain root from
    // them, and a client-supplied one was never read.
    expect(Object.keys(body)).toEqual(["batches"]);
    // The recorder still tracks the root locally — it is what continues a
    // chain across a resume.
    expect(recorder.chainRootHash).toBe(sc.chain_root_hash);
  });

  it("is an empty batch list when nothing was ever sealed", async () => {
    const { store } = await newStore();
    const recorder = await store.startServerRide(signingFor(ride));
    const body = await recorder.buildDonation();
    expect(body.batches).toEqual([]);
    expect(Object.keys(body)).toEqual(["batches"]);
  });

  it("discards a track locally without uploading anything", async () => {
    const { storage, store } = await newStore();
    const recorder = await store.startServerRide(signingFor(ride));
    await recorder.addFix(asFix(ride.fixes[0]));
    await recorder.sealOpenBatch();
    await recorder.discard();
    expect(await storage.getBatches(ride.ride_id)).toEqual([]);
    expect(await store.readTip(ride.ride_id)).toBeNull();
    expect(await store.listTrackIds()).toEqual([]);
  });
});

describe("no-IndexedDB fallback", () => {
  it("degrades to memory and flags it for the UI", async () => {
    const store = await openTrackStore({ indexedDBFactory: null });
    expect(store.durable).toBe(false);
    expect(store.warning).toBe("no_indexeddb");

    const recorder = await store.startServerRide(
      signingFor(vectors.rides.primary),
    );
    expect(recorder.durable).toBe(false);
    await recorder.addFix({ tMs: 1000, lat: 39.7, lon: -105 });
    expect((await recorder.finish()).sealed?.seq).toBe(0);
  });

  it("degrades when IndexedDB exists but refuses to open", async () => {
    const hostile = {
      open: () => {
        const request = {
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
          onblocked: null as null | (() => void),
          error: new DOMException("quota"),
          result: null,
        };
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    } as unknown as IDBFactory;
    const store = await openTrackStore({ indexedDBFactory: hostile });
    expect(store.durable).toBe(false);
    expect(store.warning).toBe("indexeddb_failed");
  });
});

describe("IndexedDB schema", () => {
  it("creates the sfyi-tracks stores the spec names", async () => {
    // A full IDB fake is out of scope (the adapter itself is exercised in the
    // browser during F3 acceptance), but the schema is a spec'd contract —
    // `sfyi-tracks` with `rides`, `batches`, `pending` — and a name typo would
    // silently strand every previously recorded track.
    const created: Record<string, unknown> = {};
    const indexes: Record<string, string[]> = {};
    let openedName = "";
    let openedVersion = 0;

    const fakeDb = {
      objectStoreNames: { contains: () => false },
      createObjectStore: (name: string, opts: { keyPath: unknown }) => {
        created[name] = opts.keyPath;
        indexes[name] = [];
        return {
          createIndex: (indexName: string) => {
            indexes[name].push(indexName);
          },
        };
      },
    };
    const factory = {
      open: (name: string, version: number) => {
        openedName = name;
        openedVersion = version;
        const request = {
          result: fakeDb,
          error: null,
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
          onblocked: null as null | (() => void),
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    } as unknown as IDBFactory;

    const store = await openTrackStore({ indexedDBFactory: factory });
    expect(store.durable).toBe(true);
    expect(store.warning).toBeNull();
    expect(openedName).toBe(TRACK_DB_NAME);
    expect(openedVersion).toBe(TRACK_DB_VERSION);
    expect(created).toEqual({
      [TRACK_STORE_RIDES]: "trackId",
      [TRACK_STORE_BATCHES]: ["trackId", "seq"],
      [TRACK_STORE_PENDING]: "trackId",
    });
    // The batches index is what keys a resume's tip rehydration by rideId.
    expect(indexes[TRACK_STORE_BATCHES]).toEqual(["trackId"]);
  });
});

describe("importTrackKey", () => {
  let key: CryptoKey;
  beforeAll(async () => {
    key = await importTrackKey(vectors.rides.primary.key_b64url);
  });

  it("imports a non-extractable signing key", async () => {
    expect(key.type).toBe("secret");
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeTruthy();
  });
});
