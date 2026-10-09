// §11.9 — the trip that has legs, so the ride can represent what the planner
// promised.
//
// THE GAP THIS CLOSES. `along-the-way.ts` ranks plans with hand-offs in them:
// ride scooter A, park it, step onto scooter B, carry on. The plan list renders
// those plans and a rider can pick one. But `takePlanRow` then walked them to
// the first vehicle and threw the plan away, and the ride flow below it has no
// idea a second leg was ever coming — the HUD's clock restarts, the cost
// restarts, the trail is a new trail, and Screen 8 congratulates the rider on
// arriving when they are standing at a hand-off point with a mile still to go.
// "Along the way" was a planning feature the ride itself could not represent.
//
// WHY A SEPARATE STORE, AND NOT THE SESSION DOC. A leg IS a ride: a hand-off
// means parking one Veo vehicle and unlocking another, which is a new
// `tracked_rides` row, a new signing key, a new `RideSessionDoc`. The session
// doc is per-ride by construction and `ride-session.ts`'s reducer is where that
// is enforced, so a trip spanning legs cannot live in it — it would be erased
// by exactly the transition it exists to survive. (The S8 [New Destination]
// loop is the other thing entirely: same rideId, same vehicle, new
// destination. That one the session doc handles already, and it is NOT a leg.)
//
// WHAT IS DELIBERATELY NOT HERE:
//
//   - No server round trip. A trip is a device-local intention, like a
//     favourite or a filter. The legs it is made of are each a real server
//     ride already; the ledger that groups them adds nothing the server needs
//     and would need a migration, an endpoint and a sync story to add nothing.
//   - No planned ROUTE. The ledger stores how many ride legs the chosen plan
//     had and nothing about their shape, because by the time leg 2 starts the
//     fleet has moved: the vehicle the plan named may be gone, and re-solving
//     is `along-the-way.ts`'s job, not a stored promise's. The count is what
//     the rider was told ("2 hand-offs") and the count is what we are honest
//     about.
//   - No auto-advance. Finishing leg 1 does not start leg 2. The rider is
//     standing on a pavement deciding, and a flow that moved on for them would
//     be guessing at the one moment they are certain.

export const ACTIVE_TRIP_KEY = "scooter-fyi-trip";

/** Blob version. A bump means "read as no trip", which is the right failure:
 *  an abandoned half-trip costs a rider nothing, and carrying a shape we no
 *  longer understand costs them a wrong badge for the rest of the ride. */
const TRIP_BLOB_V = 1;

/** One finished leg. Every figure is nullable because every figure can be
 *  genuinely absent — a private ride has no `rideId`, a ride whose GPS never
 *  resolved has no distance, and an own-device leg has no cost. A null is "we
 *  do not know", and the totals below say so rather than reading it as zero. */
export interface TripLegRecord {
  /** The server ride id, or the local `trackKeyId` for a private leg. Null
   *  only if neither existed, which should not happen and is not worth
   *  throwing over. */
  rideId: string | null;
  /** Estimated cost in cents, as the ride's own summary computed it. Null on
   *  an own-device leg: there is no Veo billing clock to picture. */
  costCents: number | null;
  /** Measured metres, null when the track has no distance. */
  meters: number | null;
  /** The leg's own span in seconds. */
  seconds: number | null;
  endedAtMs: number;
}

export interface ActiveTrip {
  /** Local id, for nothing but telling two trips apart in a log. */
  id: string;
  /** How many RIDE legs the plan the rider chose had. Always ≥ 2 — a
   *  single-ride plan is an ordinary ride and starts no trip, because a "leg 1
   *  of 1" badge is chrome that tells a rider something they knew. */
  plannedRides: number;
  /** Where the trip is going, with coordinates and not just a name.
   *
   *  THE COORDINATES ARE THE POINT. Finishing leg one leaves the rider at a
   *  hand-off spot with the rest of the way still to cover, and the rest of
   *  the way has to be RE-SOLVED rather than replayed: the vehicle the
   *  original plan named may be gone, and `along-the-way.ts` is the thing that
   *  knows how to ask again. It needs a destination to ask about, so the trip
   *  carries one. Null when the rider never named one, in which case the
   *  ledger still counts legs and totals and simply has nothing to offer at
   *  the end of each. */
  dest: TripDest | null;
  /** Where each hand-off happens: the pickup point of legs 2..N, in order, as
   *  the plan named them at the moment the rider took it.
   *
   *  THIS IS WHAT A LEG ACTUALLY ROUTES TO, and leaving it out was a real bug
   *  rather than a simplification. Without it the wizard seeded every leg with
   *  the FINAL destination, so a rider on leg one of a two-scooter plan was
   *  navigated straight past the scooter they were supposed to switch to — the
   *  app routing around its own plan.
   *
   *  STALE BY DESIGN, and that is survivable where routing to the wrong place
   *  is not. The vehicle may well have moved or been taken by the time leg one
   *  ends; what catches that is the re-solve at the end of each leg, which asks
   *  the planner again from where the rider is actually standing. Until then,
   *  "go to roughly where the next scooter was" is right and "go to the far end
   *  of the trip" is wrong.
   *
   *  Shorter than `plannedRides - 1` is legal: a plan taken before this field
   *  existed, or one whose vehicles could not be located on the map, simply
   *  falls through to the final destination. */
  handOffs: TripDest[];
  completed: TripLegRecord[];
  startedAtMs: number;
}

/** Deliberately a bare shape rather than an import of `TripPlace`: that type
 *  lives in a module full of DOM-adjacent trip plumbing, and the three fields
 *  it shares with this one are the three a stored blob can validate. */
export interface TripDest {
  label: string;
  lat: number;
  lon: number;
}

export interface TripTotals {
  /** Legs finished so far. */
  legsDone: number;
  plannedRides: number;
  costCents: number;
  meters: number;
  seconds: number;
  /** True when ANY finished leg was missing a figure, so every total above is
   *  a floor rather than a sum. A total presented as complete over the legs
   *  that happened to be measured is the kind of number that gets noticed once
   *  and never trusted again — `ride-accumulation.ts` learned the same lesson
   *  and this is the same rule. */
  partial: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseLeg(v: unknown): TripLegRecord | null {
  if (!isRecord(v)) return null;
  const endedAtMs = numOrNull(v.endedAtMs);
  if (endedAtMs === null) return null;
  return {
    rideId: typeof v.rideId === "string" ? v.rideId : null,
    costCents: numOrNull(v.costCents),
    meters: numOrNull(v.meters),
    seconds: numOrNull(v.seconds),
    endedAtMs,
  };
}

function parseDest(v: unknown): TripDest | null {
  if (!isRecord(v)) return null;
  const lat = numOrNull(v.lat);
  const lon = numOrNull(v.lon);
  // A destination without coordinates is not a destination: the only thing
  // the trip needs one FOR is re-solving the rest of the way, and a label
  // alone cannot be solved against. Dropped rather than half-kept.
  if (lat === null || lon === null) return null;
  return { label: typeof v.label === "string" ? v.label : "", lat, lon };
}

/** Parse a stored trip, or null. Validated field by field rather than cast:
 *  this blob survives a reload and a deploy, so a doc written by an older
 *  build — or by nothing at all — must read as "no trip" instead of as a trip
 *  with `NaN` legs. */
function parseTrip(v: unknown): ActiveTrip | null {
  if (!isRecord(v)) return null;
  const planned = numOrNull(v.plannedRides);
  const startedAtMs = numOrNull(v.startedAtMs);
  if (planned === null || startedAtMs === null) return null;
  // A trip with fewer than two ride legs is not a trip. Rejecting it on READ
  // as well as on write means a hand-edited or truncated blob cannot put the
  // app into a state `startTrip` refuses to create.
  if (!Number.isInteger(planned) || planned < 2) return null;
  const rawLegs = Array.isArray(v.completed) ? v.completed : [];
  const completed: TripLegRecord[] = [];
  for (const raw of rawLegs) {
    const leg = parseLeg(raw);
    if (leg !== null) completed.push(leg);
  }
  const handOffs: TripDest[] = [];
  for (const raw of Array.isArray(v.handOffs) ? v.handOffs : []) {
    const dest = parseDest(raw);
    // A hand-off that will not parse STOPS the list rather than being skipped,
    // because these are positional: dropping the middle one would silently
    // route leg two to leg three's pickup. Truncating falls through to the
    // final destination, which is wrong in a way a rider can see.
    if (dest === null) break;
    handOffs.push(dest);
  }
  return {
    id: typeof v.id === "string" ? v.id : "trip",
    plannedRides: planned,
    dest: parseDest(v.dest),
    handOffs,
    completed,
    startedAtMs,
  };
}

/** The trip in progress, or null.
 *
 *  Same storage discipline as `favorites.ts` and `filter-presets.ts`: a
 *  versioned blob, every read validated, every read and write wrapped, and
 *  anything unexpected degrading to "no trip" rather than throwing — this is
 *  read on the ride surface, where an exception would take the HUD with it. */
export function activeTrip(): ActiveTrip | null {
  try {
    const raw = localStorage.getItem(ACTIVE_TRIP_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw) as { v?: unknown; trip?: unknown };
    if (!isRecord(blob) || blob.v !== TRIP_BLOB_V) return null;
    return parseTrip(blob.trip);
  } catch {
    return null;
  }
}

/** Returns false when storage refused the write (private mode, or quota).
 *
 *  NO SESSION MIRROR, unlike `favorites.ts`. That store mirrors a failed write
 *  in memory so a rider does not watch a saved place vanish. A trip is
 *  different: it is read by surfaces built fresh across a reload, and a mirror
 *  would show a leg badge that the next reload contradicts. Better to have no
 *  trip than one that exists on one screen. */
function persist(trip: ActiveTrip): boolean {
  try {
    localStorage.setItem(
      ACTIVE_TRIP_KEY,
      JSON.stringify({ v: TRIP_BLOB_V, trip }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Begin a trip. Returns the trip, or null when the plan does not need one.
 *
 *  REPLACES ANY TRIP IN PROGRESS, on purpose: choosing a new multi-leg plan is
 *  the rider saying where they are going now, and two live trips is a state
 *  with no rider-facing meaning. */
export function startTrip(input: {
  plannedRides: number;
  dest?: TripDest | null;
  handOffs?: readonly TripDest[];
  nowMs?: number;
  id?: string;
}): ActiveTrip | null {
  const planned = input.plannedRides;
  if (!Number.isInteger(planned) || planned < 2) return null;
  const trip: ActiveTrip = {
    id: input.id ?? `trip-${Math.random().toString(36).slice(2, 10)}`,
    plannedRides: planned,
    dest: input.dest ?? null,
    handOffs: [...(input.handOffs ?? [])],
    completed: [],
    startedAtMs: input.nowMs ?? Date.now(),
  };
  persist(trip);
  return trip;
}

/** Record a finished leg. Returns the updated trip, or null when no trip is in
 *  progress — which is the common case and not an error: most rides are one
 *  ride.
 *
 *  IDEMPOTENT ON `rideId`, because Screen 8 can render more than once for one
 *  ride (a re-render, a reload onto the same doc, the rider backing into it)
 *  and a leg counted twice would both inflate the total and skip a leg in the
 *  badge. A leg with no id cannot be deduped and is appended as-is; that is
 *  the private-ride case, where there is nothing to double-count against. */
export function recordLeg(leg: TripLegRecord): ActiveTrip | null {
  const trip = activeTrip();
  if (trip === null) return null;
  if (leg.rideId !== null && trip.completed.some((l) => l.rideId === leg.rideId)) {
    return trip;
  }
  const next: ActiveTrip = { ...trip, completed: [...trip.completed, leg] };
  persist(next);
  return next;
}

/** Forget the trip. Called when the rider arrives, abandons, or starts
 *  something that is not this trip. */
export function endTrip(): void {
  try {
    localStorage.removeItem(ACTIVE_TRIP_KEY);
  } catch {
    // Nothing to do and nothing to report: a trip that cannot be cleared is
    // cleared by the next `startTrip`, which replaces whatever is there.
  }
}

/** Where the leg being ridden right now should actually take the rider.
 *
 *  The next hand-off if there is one, else the trip's own destination. This is
 *  the function the wizard seeds `dest` from, and the whole reason `handOffs`
 *  exists: a rider on leg one of a two-scooter plan who is navigated to the far
 *  end of the trip has been routed around the plan they chose.
 *
 *  Indexed by legs COMPLETED, not by `currentLeg`, which clamps — a rider who
 *  re-solved and took an extra hop has already passed every hand-off the
 *  original plan knew about, so they are heading for the destination now. */
export function legDestination(trip: ActiveTrip): TripDest | null {
  return trip.handOffs[trip.completed.length] ?? trip.dest;
}

/** Where to seed the wizard's `dest` for the leg about to be ridden.
 *
 *  THE ONE RULE, in one place. It used to be an expression inlined at the
 *  wizard's open hook, spelled as "if there is a pending trip AND an active
 *  trip AND this leg ends at a hand-off, use the hand-off; otherwise use the
 *  pending trip's destination". Three of those four cases are wrong:
 *
 *    * ON LEG TWO THERE IS NO PENDING TRIP. `takePendingTrip` consumed it when
 *      the wizard opened for leg one, and nothing puts it back — so the whole
 *      branch was skipped, no `setDest` was dispatched at all, and the leg ran
 *      with whatever destination the doc happened to carry. Proven: the old
 *      expression returns `null` for leg 2 of 2.
 *    * A WIZARD REOPENED for the same leg hits the same hole, for the same
 *      reason: the pending trip is a one-shot and the reopen is the second
 *      shot.
 *    * AND THE FALLBACK WAS THE PENDING TRIP rather than the trip's own
 *      destination, so the one store that actually knows where the rider is
 *      going was consulted last.
 *
 *  The trip is the authority when there is one: its next hand-off if a leg
 *  remains, else its own destination. `fallback` is only for a ride with no
 *  trip ledger at all, which is the ordinary one-scooter case.
 *
 *  Returns null only when nothing anywhere knows a destination — a free ride,
 *  or a wizard opened cold. */
export function legTarget(
  trip: ActiveTrip | null,
  fallback: TripDest | null = null,
): TripDest | null {
  if (trip === null) return fallback;
  return legDestination(trip) ?? fallback;
}

/** True when this leg ends at a hand-off rather than at the destination, which
 *  is what lets a surface say "to your next scooter" instead of "to Home". */
export function legEndsAtHandOff(trip: ActiveTrip): boolean {
  return trip.handOffs[trip.completed.length] !== undefined;
}

/** Totals over the legs finished SO FAR. Never includes the leg in progress:
 *  the HUD shows that one live, and adding a moving figure to a settled one
 *  gives a number that is neither. */
export function tripTotals(trip: ActiveTrip): TripTotals {
  let costCents = 0;
  let meters = 0;
  let seconds = 0;
  let partial = false;
  for (const leg of trip.completed) {
    if (leg.costCents === null || leg.meters === null || leg.seconds === null) {
      partial = true;
    }
    costCents += leg.costCents ?? 0;
    meters += leg.meters ?? 0;
    seconds += leg.seconds ?? 0;
  }
  return {
    legsDone: trip.completed.length,
    plannedRides: trip.plannedRides,
    costCents,
    meters,
    seconds,
    partial,
  };
}

/** Which leg is being ridden right now, 1-based.
 *
 *  Legs done plus one, CLAMPED to the planned count: a rider who re-solved
 *  mid-trip can ride more legs than the plan predicted (the fleet moved, the
 *  vehicle was gone, they took two shorter hops instead of one), and "leg 4 of
 *  3" is the badge announcing our own arithmetic rather than their trip. The
 *  honest reading of the last slot is "the last leg", so that is what it
 *  says. */
export function currentLeg(trip: ActiveTrip): number {
  return Math.min(trip.completed.length + 1, trip.plannedRides);
}

/** True when the leg about to be ridden is the last one the plan predicted. */
export function onFinalLeg(trip: ActiveTrip): boolean {
  return trip.completed.length + 1 >= trip.plannedRides;
}

/** True when every planned leg has been ridden. */
export function tripComplete(trip: ActiveTrip): boolean {
  return trip.completed.length >= trip.plannedRides;
}

/** "Leg 2 of 3" — the HUD badge, and nothing more than that.
 *
 *  No destination in it: the badge sits on a screen where the nav pane already
 *  names the destination, and a rider glancing at a phone on a handlebar mount
 *  while moving can read three words or six, not both. */
export function legBadge(trip: ActiveTrip): string {
  return `Leg ${currentLeg(trip)} of ${trip.plannedRides}`;
}

/** What a chosen plan should be recorded as, decided before anything is
 *  written down or anyone starts walking.
 *
 *  `stale` is the one that matters and the one that was missing. A plan with
 *  two rides whose SECOND vehicle can no longer be found is not a one-scooter
 *  ride — the rider chose a split for a reason, usually that one scooter
 *  cannot make the distance, and the app is not entitled to decide the reason
 *  has lapsed. Treating it as an ordinary ride walked them to the first
 *  scooter and, with no ledger to read, routed them to the FINAL destination:
 *  the exact wrong-destination bug `legTarget` exists to prevent, arriving by
 *  a different door and without even a leg badge to give it away. */
export type PlanLedger =
  | { kind: "single" }
  | { kind: "stale" }
  | { kind: "trip"; handOffs: readonly TripDest[] };

/** Decide it. Pure, and generic over the vehicle, so the rule can be tested
 *  without a map, a feed or a DOM — `main.ts` owns looking a vehicle up and
 *  naming it, and passes that in as `place`.
 *
 *  WHY TRUNCATE AND THEN REFUSE, rather than skipping the gap. These are
 *  POSITIONAL: hand-off `i` is where leg `i + 1` begins. Dropping an
 *  unlocatable middle vehicle and closing the gap would route leg two to leg
 *  three's pickup, which is worse than not going. So the list stops at the
 *  first vehicle it cannot place, and a multi-ride plan left with no hand-offs
 *  at all is stale rather than single.
 *
 *  A plan that loses only its LATER hand-offs still runs: the rider can be
 *  taken as far as the hand-offs that were found, and the next leg re-solves
 *  from where they actually are. */
export function planLedger<V>(
  rideVehicles: readonly (V | null)[],
  place: (vehicle: V) => TripDest | null,
): PlanLedger {
  if (rideVehicles.length < 2) return { kind: "single" };
  const handOffs: TripDest[] = [];
  // Leg one's own pickup is the walk the rider is about to take, so it is not
  // a hand-off and is skipped.
  for (const v of rideVehicles.slice(1)) {
    if (v === null) break;
    const at = place(v);
    if (at === null) break;
    handOffs.push(at);
  }
  return handOffs.length === 0 ? { kind: "stale" } : { kind: "trip", handOffs };
}
