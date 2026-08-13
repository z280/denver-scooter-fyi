// DIBS.
//
// Veo has no reservation system. A rider who spots a scooter four blocks away
// and starts walking has no way to say "that one's mine", and no way to settle
// it if somebody else arrives at the same moment. Dibs is the honest answer to
// that: not a lock, not a hold, not a promise the app cannot keep — a
// timestamped claim, exactly as binding as calling dibs on the front seat.
//
// WHY A TIMESTAMP IS THE WHOLE FEATURE. The certificate is not decoration. Two
// people standing at one scooter, each holding a phone, can settle it the way
// people actually settle these things: whose claim is older. That is a real
// mechanism, it needs no server, no account, and no cooperation from Veo — and
// it is genuinely the best anyone can do here, which is why it is worth
// building rather than apologising for.
//
// DENVER TIME, ALWAYS. The claim is about a scooter on a Denver street and is
// read out loud to somebody standing on it. A traveller's phone set to New
// York would print a time an hour ahead of every other certificate at that
// intersection, and the one thing this artifact has to get right is which
// claim came first.
//
// It is deliberately local. A server registry would make dibs enforceable-ish
// and would therefore be a promise — someone else's dibs would start
// preventing your ride, on a vehicle neither of you has any actual claim to.
// Dibs is a social object, not a lock, and keeping it on the phone keeps that
// honest.

export const DIBS_KEY = "scooter-fyi-dibs";

// THE RULES. Dibs is not binding on anyone, but it has to be binding on the
// CLAIMANT, or it is just a button that hoards scooters. Somebody who calls
// dibs on six vehicles and walks towards none of them has made the map worse
// for everybody and better for nobody, including themselves.
//
// So a claim decays in two ways, and both are about whether the rider is
// actually coming.

/** Rule 1: ten minutes to start walking, or the claim is void. Not ten
 *  minutes to ARRIVE — ten minutes to set off. Standing still is the only
 *  thing this punishes. */
export const DIBS_START_GRACE_MS = 10 * 60_000;

/** Rule 2, first half: you cannot call dibs on something you could not
 *  plausibly reach. Fifteen minutes of walking is the far edge of "I am
 *  coming to get that"; past it, a claim is speculation. */
export const DIBS_MAX_WALK_MINUTES = 15;

/** Rule 2, second half: a claim never outlives 25 minutes, whatever happens —
 *  the ten-minute grace plus the fifteen-minute walk it was allowed to be.
 *  This is the ceiling that makes the whole thing safe to hand out. */
export const DIBS_MAX_TOTAL_MS = 25 * 60_000;

/** How close counts as "still coming". Consumer GPS wanders tens of metres
 *  while a phone sits on a table, so progress has to clear the noise before
 *  it counts as walking — otherwise a stationary rider passes rule 1 by
 *  standing still next to a drifting fix. */
export const DIBS_PROGRESS_METERS = 40;

/** Hard ceiling on simultaneous claims, under any circumstances.
 *
 *  Dibs costs a rider nothing to call, which is exactly why it needs a
 *  ceiling: without one the cheapest strategy is to claim every scooter you
 *  can see and sort it out later, and a map where the good vehicles are all
 *  spoken for by one person is worse for everybody — including them, since
 *  the whole thing only works if other riders take it seriously. */
export const DIBS_MAX_CONCURRENT = 3;

/** How close two claims have to be to count as one group.
 *
 *  Multiple dibs are legitimate in one case: a few people walking to the same
 *  rack together. That is a cluster, not a spread — 150 m is a rack, a plaza,
 *  a block of parked scooters. Claims further apart than this are one person
 *  hedging across the city, which is the thing the ceiling exists to stop. */
export const DIBS_GROUP_METERS = 150;

/** Straight-line metres between two points. Duplicated from locate.ts rather
 *  than imported: this module is the rules, and the rules should not need the
 *  map's geolocation machinery to be evaluated (or stubbed, in a test). */
export function metersBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type DibsVerdict =
  /** Not signed in. Dibs is an assertion about WHO called it, and a
   *  certificate naming nobody is weak evidence in the argument it exists to
   *  settle — so this one is a gate rather than a nudge. */
  | { kind: "signed_out" }
  /** Nothing in the way. */
  | { kind: "ok" }
  /** They already hold this exact vehicle. */
  | { kind: "already" }
  /** At the ceiling. No question to ask — this one is simply refused. */
  | { kind: "at_limit"; held: Dibs[] }
  /** They hold others, and this one is nowhere near them. Ask whether to
   *  release the existing claims or keep them as a group. */
  | { kind: "ask"; held: Dibs[]; nearest: number };

/** Can this rider call dibs on this vehicle, and if not, what do we ask?
 *
 *  Three outcomes rather than a boolean, because two of the three failures
 *  are questions and not refusals. A rider walking to a rack with two friends
 *  is doing something legitimate; a rider claiming scooters a mile apart is
 *  not; and only they know which one they are.
 */
export function canCallDibs(
  at: { lat: number; lon: number },
  now: number = Date.now(),
  /** Injected rather than imported so this module stays free of the auth
   *  layer and testable without one. */
  signedIn: boolean = true,
): DibsVerdict {
  // FIRST, because every other verdict is about claims this rider holds and
  // a signed-out rider cannot hold any: the registration is session-authed
  // (`registerDibs`), so an anonymous claim could only ever be a local note
  // to self that no other rider's map would ever see.
  if (!signedIn) return { kind: "signed_out" };
  const held = loadDibs(now);
  if (held.length === 0) return { kind: "ok" };
  if (held.some((d) => metersBetween(d, at) < SAME_PLACE_METERS)) {
    return { kind: "already" };
  }
  if (held.length >= DIBS_MAX_CONCURRENT) return { kind: "at_limit", held };
  const nearest = Math.min(...held.map((d) => metersBetween(d, at)));
  // Close enough to be one group — a rack, a plaza — so no question needed.
  if (nearest <= DIBS_GROUP_METERS) return { kind: "ok" };
  return { kind: "ask", held, nearest };
}

/** Two claims this close are the same vehicle for practical purposes. */
const SAME_PLACE_METERS = 5;

export interface Dibs {
  vehicleIdentifier: string;
  /** The vehicle's rider-facing name at the time of claiming — "Lunar 🐸 928".
   *  Stored rather than looked up, so an expired or offline certificate still
   *  says what it was for. */
  vehicleName: string;
  plate: string | null;
  /** Who called it. The signed-in display name, or the honest anonymous form
   *  — never a fabricated identity. */
  claimedBy: string;
  /** Epoch millis. The field the whole thing turns on. */
  claimedAt: number;
  /** Metres to the scooter when the claim was made — the baseline every
   *  progress check measures against. */
  startMeters: number;
  /** The closest the rider has actually got. Monotonic: wandering back out
   *  does not undo progress already made, because GPS wanders and the rule is
   *  about intent, not about walking a straight line. */
  bestMeters: number;
  /** When we first saw real movement towards it, or null while they have not
   *  set off. Rule 1 turns on exactly this field. */
  startedWalkingAt: number | null;
  /** Where the scooter is. Needed to tell "three friends at one rack" from
   *  "one rider hedging across the city" — see canCallDibs. */
  lat: number;
  lon: number;
  /** The server's record of this claim, once it has one.
   *
   *  The claim works without it — dibs is local and must not need a network
   *  round trip to be called. But the CERTIFICATE needs it: a timestamp the
   *  holder can edit settles no argument, so the artifact shown to a stranger
   *  is the server's, and this is the handle to it. Null means the
   *  registration has not landed (yet, or at all), and the certificate says so
   *  rather than pretending. */
  registration: { id: string; verifyUrl: string; qrUrl: string } | null;
}

/** When a claim dies, as an absolute instant.
 *
 *  Two ceilings, whichever comes first: the hard 25-minute cap, and — if they
 *  never set off — the ten-minute grace. */
export function dibsExpiresAt(d: Dibs): number {
  const hard = d.claimedAt + DIBS_MAX_TOTAL_MS;
  if (d.startedWalkingAt === null) {
    return Math.min(hard, d.claimedAt + DIBS_START_GRACE_MS);
  }
  return hard;
}

export function dibsMsLeft(d: Dibs, now: number = Date.now()): number {
  return Math.max(0, dibsExpiresAt(d) - now);
}

export function isDibsLive(d: Dibs, now: number = Date.now()): boolean {
  return dibsMsLeft(d, now) > 0;
}

/** Whether a scooter is close enough to claim at all (rule 2, first half).
 *  Takes the ROUTED walk in minutes — the straight-line distance would let a
 *  rider claim something across a river. */
export function isClaimable(walkMinutes: number): boolean {
  return walkMinutes <= DIBS_MAX_WALK_MINUTES;
}

/** Fold a fresh distance reading into a claim. Returns the updated record, or
 *  the same one when nothing changed, so callers can skip a write. */
export function recordProgress(
  d: Dibs,
  meters: number,
  now: number = Date.now(),
): Dibs {
  if (meters >= d.bestMeters) return d;
  const next: Dibs = { ...d, bestMeters: meters };
  // Rule 1 is satisfied by MOVEMENT, not by arrival: once they have closed
  // the noise floor, the grace stops applying and the hard cap takes over.
  if (next.startedWalkingAt === null && d.startMeters - meters >= DIBS_PROGRESS_METERS) {
    next.startedWalkingAt = now;
  }
  return next;
}

interface StoredDibs {
  v: 1;
  dibs: Dibs[];
}

function isValid(d: unknown): d is Dibs {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return (
    typeof r.vehicleIdentifier === "string" && r.vehicleIdentifier.length > 0 &&
    typeof r.vehicleName === "string" &&
    typeof r.claimedBy === "string" &&
    typeof r.claimedAt === "number" && Number.isFinite(r.claimedAt) &&
    typeof r.lat === "number" && Number.isFinite(r.lat) &&
    typeof r.lon === "number" && Number.isFinite(r.lon) &&
    typeof r.startMeters === "number" && Number.isFinite(r.startMeters) &&
    typeof r.bestMeters === "number" && Number.isFinite(r.bestMeters) &&
    (r.startedWalkingAt === null ||
      (typeof r.startedWalkingAt === "number" && Number.isFinite(r.startedWalkingAt)))
  );
}

export function loadDibs(now: number = Date.now()): Dibs[] {
  try {
    const raw = localStorage.getItem(DIBS_KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as StoredDibs;
    if (blob?.v !== 1 || !Array.isArray(blob.dibs)) return [];
    return blob.dibs.filter(isValid).filter((d) => isDibsLive(d, now));
  } catch {
    return [];
  }
}

function persist(dibs: Dibs[]): void {
  try {
    localStorage.setItem(DIBS_KEY, JSON.stringify({ v: 1, dibs } satisfies StoredDibs));
  } catch {
    /* private mode — the claim still stands for this visit */
  }
}

/** Call dibs. Re-claiming the same vehicle KEEPS the original timestamp:
 *  the earlier claim is the whole asset, and letting a second tap quietly
 *  reset it to now would throw away the only thing dibs is good for. */
export function callDibs(
  claim: Omit<Dibs, "claimedAt" | "bestMeters" | "startedWalkingAt" | "registration">,
  now: number = Date.now(),
): Dibs {
  const existing = loadDibs(now);
  const already = existing.find((d) => d.vehicleIdentifier === claim.vehicleIdentifier);
  if (already) return already;
  const dibs: Dibs = {
    ...claim,
    bestMeters: claim.startMeters,
    startedWalkingAt: null,
    registration: null,
    claimedAt: now,
  };
  persist([dibs, ...existing]);
  return dibs;
}

/** Write an updated claim back. Used by the progress tracker. */
export function saveDibs(updated: Dibs, now: number = Date.now()): void {
  const rest = loadDibs(now).filter(
    (d) => d.vehicleIdentifier !== updated.vehicleIdentifier,
  );
  persist([updated, ...rest]);
}

export function dropDibs(vehicleIdentifier: string, now: number = Date.now()): Dibs[] {
  const next = loadDibs(now).filter((d) => d.vehicleIdentifier !== vehicleIdentifier);
  persist(next);
  return next;
}

export function dibsOn(
  vehicleIdentifier: string,
  now: number = Date.now(),
): Dibs | null {
  return loadDibs(now).find((d) => d.vehicleIdentifier === vehicleIdentifier) ?? null;
}

/** Denver time, to the second, in the form a person reads aloud.
 *
 *  Pinned to America/Denver rather than the device's zone — see the module
 *  header. Seconds are shown because two claims on one scooter can easily
 *  land in the same minute, and the minute is not the answer to the question
 *  the certificate exists to settle. */
export function denverStamp(at: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(at));
}

/** How long ago, for the badge rather than the certificate. */
export function dibsAge(dibs: Dibs, now: number = Date.now()): string {
  const mins = Math.floor((now - dibs.claimedAt) / 60_000);
  if (mins < 1) return "just now";
  return `${mins} min ago`;
}
