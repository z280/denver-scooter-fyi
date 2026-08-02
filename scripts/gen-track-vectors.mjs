#!/usr/bin/env node
// Regenerates tests/fixtures/track-chain-vectors.json — the golden track-chain
// vectors, committed BYTE-IDENTICALLY to both repos at that same literal path
// (denver-scooter-fyi's Vitest suite and scooter-fyi-api's
// tests/test_track_verify.py both consume it). That one file is the contract.
//
//   node scripts/gen-track-vectors.mjs            # rewrite the fixture
//   node scripts/gen-track-vectors.mjs --check    # fail if it would change
//
// This script is a DELIBERATELY INDEPENDENT implementation of the master plan's
// Part 2 chain format: it shares no code with src/track-store.ts and uses
// node:crypto rather than WebCrypto. That is the point — src/track-store.test.ts
// replays the fixture's fix streams through the real recorder and asserts the
// compact JWS strings and chain_root_hash come out identical, so agreement here
// is evidence about the format, not about a shared helper.
//
// Everything is fixed input: no Math.random, no Date.now, integer micro-degree
// geometry (no trig, whose last bit is engine-defined). Running this twice, or
// on another machine, produces the same bytes.

import { createHmac, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "tests",
  "fixtures",
  "track-chain-vectors.json",
);

// ---------------------------------------------------------------------------
// Part 2 primitives (independent of src/track-store.ts)
// ---------------------------------------------------------------------------

const MAX_WAYPOINTS_PER_BATCH = 25;
const MAX_BATCH_SPAN_MS = 60_000;
const JWS_TYP = "sfyi-track+jws";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (buf) => createHash("sha256").update(buf).digest();
const ascii = (text) => Buffer.from(text, "ascii");

/** H_-1 = sha256(nonce) — over the nonce's 16 RAW bytes (hex-decoded first). */
const initialChainHash = (nonceHex) => sha256(Buffer.from(nonceHex, "hex"));

/** H_n = sha256(H_{n-1} || sha256(jws_n)); sha256(jws) over the JWS's ASCII. */
const advanceChainHash = (prev, jws) =>
  sha256(Buffer.concat([prev, sha256(ascii(jws))]));

const chainRootHash = (nonceHex, jwsList) =>
  jwsList
    .reduce((h, jws) => advanceChainHash(h, jws), initialChainHash(nonceHex))
    .toString("hex");

function signJws(keyBytes, kid, payload) {
  // Key order is Part 2's order in both objects; JSON.stringify preserves
  // insertion order for non-index keys, which is what makes this byte-stable.
  const header = { alg: "HS256", typ: JWS_TYP, kid };
  const signingInput = `${b64url(ascii(JSON.stringify(header)))}.${b64url(
    ascii(JSON.stringify(payload)),
  )}`;
  const mac = createHmac("sha256", keyBytes).update(ascii(signingInput)).digest();
  return `${signingInput}.${b64url(mac)}`;
}

// ---------------------------------------------------------------------------
// Deterministic ride geometry: integer micro-degree steps, so the fixture never
// depends on the platform's Math.sin/Math.cos.
// ---------------------------------------------------------------------------

const LAT_STEPS_UDEG = [80, 70, 90];
const LON_STEPS_UDEG = [90, 95, 85];

/** [t_ms, lat, lon, acc_m] with lat/lon already at 6 decimals and acc an
 *  integer — exactly what a conforming client puts in a waypoint tuple. */
function makeFixes({ count, startMs, startLatUdeg, startLonUdeg, gapAt }) {
  const fixes = [];
  let t = startMs;
  let latU = startLatUdeg;
  let lonU = startLonUdeg;
  for (let i = 0; i < count; i += 1) {
    if (i > 0) {
      t += gapAt === i ? 75_000 : 2_000;
      latU += LAT_STEPS_UDEG[(i - 1) % LAT_STEPS_UDEG.length];
      lonU += LON_STEPS_UDEG[(i - 1) % LON_STEPS_UDEG.length];
    }
    fixes.push([t, latU / 1e6, lonU / 1e6, 5 + (i % 7)]);
  }
  return fixes;
}

/** The client's sealing rule, restated: 25 waypoints or 60 s, whichever first,
 *  plus a final partial batch at ride end. The fix that REACHES the 60 s bound
 *  opens the next batch, so a batch always spans strictly less than 60 s. */
function groupFixes(fixes) {
  const groups = [];
  let open = null;
  for (const [t, lat, lon, acc] of fixes) {
    if (open && t - open.t0 >= MAX_BATCH_SPAN_MS) {
      groups.push(open);
      open = null;
    }
    if (!open) open = { t0: t, t1: t, pts: [] };
    open.pts.push([t - open.t0, lat, lon, acc]);
    open.t1 = t;
    if (open.pts.length >= MAX_WAYPOINTS_PER_BATCH) {
      groups.push(open);
      open = null;
    }
  }
  if (open) groups.push(open);
  return groups;
}

function sealChain({ rid, kid, nonce, keyBytes, groups, recSeqs = [] }) {
  const jwsList = [];
  let prev = "";
  groups.forEach((group, seq) => {
    const payload = {
      v: 1,
      rid,
      non: nonce,
      seq,
      prev,
      t0: group.t0,
      t1: group.t1,
      pts: group.pts,
      rec: recSeqs.includes(seq),
    };
    const jws = signJws(keyBytes, kid, payload);
    jwsList.push(jws);
    prev = sha256(ascii(jws)).toString("hex");
  });
  return jwsList;
}

// ---------------------------------------------------------------------------
// Fixed ride contexts
// ---------------------------------------------------------------------------

const keyBytes = (a, b) =>
  Buffer.from(Array.from({ length: 32 }, (_, i) => (i * a + b) & 0xff));

const PRIMARY_KEY = keyBytes(7, 13);
const FOREIGN_KEY = keyBytes(11, 29);
const SHORT_KEY = keyBytes(13, 41);

const PRIMARY_T0 = Date.parse("2026-07-15T17:00:00.000Z");
const SHORT_T0 = Date.parse("2026-07-16T14:30:00.000Z");

const RIDE_OPTIONS = {
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

// 102 fixes at 2 s, with a 75 s background-throttle gap before index 55 so the
// chain exercises BOTH seal rules plus a final partial batch:
//   seq 0,1 count-sealed (25) · seq 2 time-sealed (5) · seq 3 count-sealed (25)
//   · seq 4 final partial (22)
const PRIMARY_FIXES = makeFixes({
  count: 102,
  startMs: PRIMARY_T0,
  startLatUdeg: 39_740_000,
  startLonUdeg: -104_990_000,
  gapAt: 55,
});

// 5 fixes: below every volume minimum (10 waypoints / 500 m / 3 min). Its own
// ride context so the feed anchors match its short path and the FIRST failing
// check really is `volume`, not `gbfs_end`.
const SHORT_FIXES = makeFixes({
  count: 5,
  startMs: SHORT_T0,
  startLatUdeg: 39_701_000,
  startLonUdeg: -104_961_000,
  gapAt: -1,
});

function rideContext({ id, vehicle, nonce, key, fixes, label }) {
  const first = fixes[0];
  const last = fixes[fixes.length - 1];
  const startedAtMs = first[0] - 5_000;
  const endedAtMs = last[0] + 20_000;
  return {
    label,
    ride_id: id,
    vehicle_identifier: vehicle,
    nonce,
    key_b64url: b64url(key),
    // Server-stamped ride window (`started_at` at key issuance,
    // `user_reported_ended_at` at PATCH /end). Check 3 bounds the chain to it.
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    started_at: new Date(startedAtMs).toISOString(),
    ended_at: new Date(endedAtMs).toISOString(),
    // Feed-anchored start (A1 stamps these) + resolved GBFS end, positioned so
    // check 5 passes on the unmutated chain.
    feed_start_lat: first[1],
    feed_start_lon: first[2],
    gbfs_end_lat: last[1],
    gbfs_end_lon: last[2],
    gbfs_left_feed_at_ms: startedAtMs + 30_000,
    gbfs_reappeared_at_ms: endedAtMs + 60_000,
    ride_options: RIDE_OPTIONS,
    fixes,
  };
}

const RIDES = {
  primary: rideContext({
    label: "A ~4.6 min, ~1.2 km tracked Veo ride that passes every check.",
    id: "7f3d1c2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    vehicle: "a1b2c3d4e5f60718",
    nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    key: PRIMARY_KEY,
    fixes: PRIMARY_FIXES,
  }),
  short: rideContext({
    label: "A 5-waypoint, 8-second ride: below every volume minimum.",
    id: "2b6c9a10-3d4e-4f50-8a61-b72c83d94e05",
    vehicle: "0f1e2d3c4b5a6978",
    nonce: "9a8b7c6d5e4f30211203f4e5d6c7b8a9",
    key: SHORT_KEY,
    fixes: SHORT_FIXES,
  }),
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function waypointCount(jwsList) {
  return jwsList.reduce((n, jws) => {
    const payload = JSON.parse(
      Buffer.from(jws.split(".")[1], "base64url").toString("utf8"),
    );
    return n + payload.pts.length;
  }, 0);
}

function scenario(fields) {
  const { name, ride, description, batches, replay, expected } = fields;
  return {
    name,
    ride,
    description,
    signing_key: fields.signing_key ?? "ride",
    rec_batches: fields.rec_batches ?? [],
    derived_from: fields.derived_from ?? null,
    replay: replay ?? null,
    batch_count: batches.length,
    waypoint_count: waypointCount(batches),
    chain_root_hash: chainRootHash(RIDES[ride].nonce, batches),
    batches,
    expected,
  };
}

/** Rewrite one decimal of one latitude inside an already-signed batch, leaving
 *  the MAC segment untouched — a content tamper with a stale signature. */
function tamperBatchLatitude(jws) {
  const [header, payloadSeg, mac] = jws.split(".");
  const payload = JSON.parse(
    Buffer.from(payloadSeg, "base64url").toString("utf8"),
  );
  const from = payload.pts[0][1];
  const to = Number((from + 0.000001).toFixed(6));
  payload.pts[0][1] = to;
  const tampered = `${header}.${b64url(ascii(JSON.stringify(payload)))}.${mac}`;
  return { jws: tampered, from, to };
}

function build() {
  const primary = RIDES.primary;
  const short = RIDES.short;
  const primaryGroups = groupFixes(primary.fixes);

  const valid = sealChain({
    rid: primary.ride_id,
    kid: primary.ride_id,
    nonce: primary.nonce,
    keyBytes: PRIMARY_KEY,
    groups: primaryGroups,
  });

  // ----- recovered batch: identical to `valid` except seq 2 is rec:true (the
  // time-sealed 5-point batch, replayed from the `pending` store after a crash).
  const recovered = sealChain({
    rid: primary.ride_id,
    kid: primary.ride_id,
    nonce: primary.nonce,
    keyBytes: PRIMARY_KEY,
    groups: primaryGroups,
    recSeqs: [2],
  });

  // ----- foreign key: same ride id and nonce, signed with someone else's key.
  const foreign = sealChain({
    rid: primary.ride_id,
    kid: primary.ride_id,
    nonce: primary.nonce,
    keyBytes: FOREIGN_KEY,
    groups: primaryGroups,
  });

  // ----- flipped bit: tamper the LAST batch's payload and keep its signature.
  // Deliberately the last one: no successor carries its hash, so the `prev`
  // links all still verify and check 1 is the ONLY failure.
  const tamper = tamperBatchLatitude(valid[valid.length - 1]);
  const flipped = [...valid.slice(0, -1), tamper.jws];

  // ----- reordered: valid signatures, shuffled order → seq no longer
  // contiguous ascending and `prev` no longer matches the predecessor.
  const reordered = [valid[0], valid[1], valid[3], valid[2], valid[4]];

  // ----- teleport: one fix displaced ~5.5 km, signed and chained honestly.
  const teleportFixes = primary.fixes.map((f, i) =>
    i === 60 ? [f[0], Number((f[1] + 0.05).toFixed(6)), f[2], f[3]] : [...f],
  );
  const teleport = sealChain({
    rid: primary.ride_id,
    kid: primary.ride_id,
    nonce: primary.nonce,
    keyBytes: PRIMARY_KEY,
    groups: groupFixes(teleportFixes),
  });

  // ----- out-of-bounds timestamps: the first batch's fixes moved 15 min before
  // the server-stamped `started_at`. Still strictly increasing across the
  // flattened track, so only check 3's WINDOW bound fails.
  const oobFixes = primary.fixes.map((f, i) =>
    i < 25 ? [f[0] - 900_000, f[1], f[2], f[3]] : [...f],
  );
  const outOfBounds = sealChain({
    rid: primary.ride_id,
    kid: primary.ride_id,
    nonce: primary.nonce,
    keyBytes: PRIMARY_KEY,
    groups: groupFixes(oobFixes),
  });

  // ----- volume floor.
  const shortChain = sealChain({
    rid: short.ride_id,
    kid: short.ride_id,
    nonce: short.nonce,
    keyBytes: SHORT_KEY,
    groups: groupFixes(short.fixes),
  });

  const scenarios = [
    scenario({
      name: "valid",
      ride: "primary",
      description:
        "The reference chain. Exercises all three seal triggers: seq 0/1/3 sealed at 25 waypoints, seq 2 sealed by the 60 s bound after a 75 s GPS gap, seq 4 the final partial batch at ride end.",
      batches: valid,
      replay: { fixes: "ride" },
      expected: {
        verdict: "valid",
        failing_check: null,
        verification_key: null,
        reasons: [],
        note: "Every check passes: 102 waypoints, ~1.2 km, ~4.6 min, max segment speed ~6.5 m/s, first/last waypoints on the feed anchors.",
      },
    }),
    scenario({
      name: "recovered-batch",
      ride: "primary",
      description:
        "Byte-for-byte the `valid` chain except seq 2 carries rec:true: the batch a client seals from the `pending` store after a crash mid-batch. `rec` is informational and must not affect the verdict.",
      batches: recovered,
      rec_batches: [2],
      replay: { fixes: "ride" },
      derived_from: {
        scenario: "valid",
        mutation: { kind: "set_rec_true", seq: 2 },
      },
      expected: {
        verdict: "valid",
        failing_check: null,
        verification_key: null,
        reasons: [],
        note: "A recovered batch is a first-class batch. Its chain_root_hash differs from `valid` because rec:true changes the signed bytes of seq 2 onward.",
      },
    }),
    scenario({
      name: "flipped-bit",
      ride: "primary",
      description:
        "The `valid` chain with one latitude digit rewritten inside the FINAL batch's payload and the original MAC left in place. The last batch has no successor carrying its hash, so the `prev` links still verify, making check 1 the only failure.",
      batches: flipped,
      derived_from: {
        scenario: "valid",
        mutation: {
          kind: "rewrite_payload_field",
          seq: valid.length - 1,
          field: "pts[0][1]",
          from: tamper.from,
          to: tamper.to,
          signature: "unchanged",
        },
      },
      expected: {
        verdict: "invalid",
        failing_check: "signature",
        verification_key: "chain",
        reasons: ["chain_invalid"],
        note: "A2 check 1: any signature failure is chain_invalid. The response's `verification` dict has no separate signature key, so the observable field is `chain`.",
      },
    }),
    scenario({
      name: "signed-with-foreign-key",
      ride: "primary",
      description:
        "A complete, internally consistent chain for this ride id and nonce, signed with a DIFFERENT 32-byte key. It verifies perfectly under `foreign_key_b64url` and must fail under the ride's own key.",
      batches: foreign,
      signing_key: "foreign",
      replay: { fixes: "ride" },
      expected: {
        verdict: "invalid",
        failing_check: "signature",
        verification_key: "chain",
        reasons: ["chain_invalid"],
        note: "The per-ride key is the binding of last resort: a chain built for any other ride or account fails check 1, not a later heuristic.",
      },
    }),
    scenario({
      name: "reordered",
      ride: "primary",
      description:
        "The `valid` batches with seq 2 and seq 3 swapped in the uploaded array. Every signature is still valid; the chain is not.",
      batches: reordered,
      derived_from: {
        scenario: "valid",
        mutation: { kind: "swap_positions", positions: [2, 3] },
      },
      expected: {
        verdict: "invalid",
        failing_check: "chain",
        verification_key: "chain",
        reasons: ["chain_invalid"],
        note: "A2 check 2: seq must be contiguous from 0 in the order given, and each `prev` must equal sha256 of the predecessor's compact JWS.",
      },
    }),
    scenario({
      name: "teleport",
      ride: "primary",
      description:
        "Honestly signed and chained, but fix index 60 is displaced ~5.5 km, producing a ~2.8 km/s out-and-back spike mid-chain. The last waypoint is untouched, so the GBFS end correlation would still pass.",
      batches: teleport,
      replay: { fixes: teleportFixes },
      derived_from: {
        scenario: "valid",
        mutation: { kind: "displace_fix", index: 60, lat_delta: 0.05 },
      },
      expected: {
        verdict: "invalid",
        failing_check: "speed",
        verification_key: "speed",
        reasons: [],
        note: "A2 check 4 hard-rejects any segment above 20 m/s after the accuracy adjustment (accuracy clamped to 50 m). The plan names no reason token for a speed hard-reject, so assert on the check, not on `reasons`.",
      },
    }),
    scenario({
      name: "out-of-bounds-timestamps",
      ride: "primary",
      description:
        "Honestly signed and chained, but the first batch's 25 fixes are stamped 15 minutes before the server-stamped `started_at`. Timestamps remain strictly increasing across the flattened track, so only the ride-window bound fails.",
      batches: outOfBounds,
      replay: { fixes: oobFixes },
      derived_from: {
        scenario: "valid",
        mutation: {
          kind: "shift_fix_times",
          indices: "0..24",
          delta_ms: -900_000,
        },
      },
      expected: {
        verdict: "invalid",
        failing_check: "monotonic",
        verification_key: "monotonic",
        reasons: [],
        note: "A2 check 3 requires t0(first) >= started_at - 120 s and t1(last) <= user_reported_ended_at + 120 s. Here t0(first) is 895 s early. The plan names no reason token for a bounds failure.",
      },
    }),
    scenario({
      name: "truncated-tail",
      ride: "primary",
      description:
        "The `valid` chain with its final batch silently dropped. Part 2 documents this as an ACCEPTED limit: nothing marks the final batch, so a truncated prefix is a valid chain. It only shrinks the claimable distance.",
      batches: valid.slice(0, -1),
      derived_from: {
        scenario: "valid",
        mutation: { kind: "drop_trailing_batches", count: 1 },
      },
      expected: {
        verdict: "valid",
        failing_check: null,
        verification_key: null,
        reasons: [],
        note: "Chain-level checks pass by design. Whether the ride stays ELIGIBLE is then decided by check 5: the surviving last waypoint must still correlate with the GBFS end, which is why truncation buys a forger nothing.",
      },
    }),
    scenario({
      name: "volume-too-few-waypoints",
      ride: "short",
      description:
        "A perfectly signed single-batch chain for a 5-waypoint, 8-second, ~47 m ride. Its own ride context, with feed anchors on its own endpoints, so the volume floor is genuinely the first failing check.",
      batches: shortChain,
      replay: { fixes: "ride" },
      expected: {
        verdict: "invalid",
        failing_check: "volume",
        verification_key: "volume",
        reasons: ["too_few_waypoints", "trip_too_short"],
        note: "A2 check 6 floors: >=10 waypoints, >=500 m, >=3 min. This chain misses all three, so both reasons apply; assert reasons as a set.",
      },
    }),
  ];

  return {
    schema_version: 1,
    contract: {
      canonical_path: "tests/fixtures/track-chain-vectors.json",
      repos: ["denver-scooter-fyi", "scooter-fyi-api"],
      generator: "denver-scooter-fyi scripts/gen-track-vectors.mjs",
      spec: "RIDE_MODE_OVERHAUL_PLAN.md Part 2 (committed byte-identically to both repos)",
      consumers: [
        "denver-scooter-fyi src/track-store.test.ts",
        "scooter-fyi-api tests/test_track_verify.py",
      ],
      encoding_rules: [
        "Every sha256 input and intermediate value is RAW BYTES, never hex text.",
        "The nonce is hex-decoded to its 16 raw bytes before hashing: H_-1 = sha256(hex_decode(nonce)).",
        "sha256(jws_n) is taken over the ASCII bytes of the compact JWS string.",
        "H_n = sha256(H_{n-1} || sha256(jws_n)); `prev` and `chain_root_hash` serialize as lowercase hex.",
        "Protected header is exactly {\"alg\":\"HS256\",\"typ\":\"sfyi-track+jws\",\"kid\":\"<ride_id>\"} in that key order.",
        "Payload key order is v, rid, non, seq, prev, t0, t1, pts, rec.",
        "Waypoint tuples are [dt_ms, lat, lon, acc_m]: dt_ms relative to the batch's t0, lat/lon at 6 decimals, acc_m an integer.",
        "Batches seal at 25 waypoints or 60 s, whichever comes first, plus a final partial batch at ride end. The fix that reaches the 60 s bound opens the NEXT batch, so a sealed batch always spans strictly less than 60 s.",
      ],
      pipeline_order: [
        "signature",
        "chain",
        "monotonic",
        "speed",
        "gbfs_start",
        "gbfs_end",
        "volume",
      ],
      conventions: [
        "All times are epoch milliseconds.",
        "Every scenario's `chain_root_hash` is H_n folded over `batches` EXACTLY as listed, including the deliberately broken chains, so a verifier can always assert its own recomputation against it.",
        "`expected.failing_check` is the FIRST check in `pipeline_order` that fails. Later checks are unspecified and must not be asserted.",
        "`expected.verification_key` is the key in the donation response's `verification` object that must not read \"ok\"; check 1 (signature) surfaces there as `chain`, matching A2's \"any failure -> chain_invalid\".",
        "`expected.reasons` is a set, from the A2 reason vocabulary, and is empty where the plan names no reason token for that check.",
        "`signing_key` is \"ride\" for the ride context's own `key_b64url`, or \"foreign\" for the top-level `foreign_key_b64url`.",
        "`replay` says how to reproduce `batches` byte-for-byte: `replay.fixes` is \"ride\" for the ride context's own `fixes`, or an inline array for a mutated stream. `replay` ITSELF is null (NOT an object with a null `fixes`) when the chain is a post-hoc mutation of another scenario's batches and is not replayable from fixes, so test `replay` for null before reaching for `fixes`. This file is pure ASCII by design - keep it that way so both repos read identical bytes with any default encoding.",
        "`ride.fixes` entries are [t_ms, lat, lon, acc_m] already rounded exactly as a waypoint tuple requires, so a client's own rounding is a no-op on them.",
        "Geometry is generated from integer micro-degree steps, never trigonometry, so the file is byte-reproducible on any engine.",
      ],
    },
    reason_vocabulary: [
      "start_mismatch",
      "end_mismatch",
      "tracking_not_opted",
      "too_few_waypoints",
      "trip_too_short",
      "chain_invalid",
      "internal_error",
    ],
    limits: {
      max_waypoints_per_batch: MAX_WAYPOINTS_PER_BATCH,
      max_batch_span_ms: MAX_BATCH_SPAN_MS,
      jws_alg: "HS256",
      jws_typ: JWS_TYP,
      payload_version: 1,
      private_ride_id: "private",
    },
    foreign_key_b64url: b64url(FOREIGN_KEY),
    rides: RIDES,
    scenarios,
  };
}

/** JSON.stringify(x, null, 2) explodes every waypoint tuple over six lines.
 *  Collapse arrays whose elements are all numbers back onto one line — purely
 *  cosmetic, and applied identically on every run. */
function compactNumberArrays(json) {
  return json.replace(
    /\[\s*(-?\d[\d.eE+-]*(?:\s*,\s*-?\d[\d.eE+-]*)*)\s*\]/g,
    (_match, inner) => `[${inner.replace(/\s+/g, "")}]`,
  );
}

const text = `${compactNumberArrays(JSON.stringify(build(), null, 2))}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT_PATH, "utf8");
  } catch {
    current = "";
  }
  if (current !== text) {
    console.error(
      `track-chain-vectors.json is out of date — run: node scripts/gen-track-vectors.mjs`,
    );
    process.exit(1);
  }
  console.log("track-chain-vectors.json is up to date");
} else {
  writeFileSync(OUT_PATH, text);
  console.log(`wrote ${OUT_PATH} (${Buffer.byteLength(text)} bytes)`);
}
