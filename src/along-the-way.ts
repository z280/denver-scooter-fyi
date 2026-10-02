/** Phase 2 — the hand-off plan. The client-cheap plan search.
 *
 *  THE CORRECTION THIS EXISTS FOR (docs/ALONG_THE_WAY_PLAN.md §2, master §6.0):
 *  the scooter that meets the rider's spec is a WAYPOINT, not a walk target.
 *  A plan is `walk → [ride → [hand-off → ride]*]? → walk`, and the answer to
 *  "the scooter you want is 14 minutes away" is to ride something ordinary to
 *  it, not to walk for 14 minutes.
 *
 *  PURE. No DOM, no network, no map. It runs on every device refresh, so it
 *  has to be cheap, and it has to be testable without booting MapLibre. Every
 *  input that could drift — the clock, the tax rate, the free-minute balance,
 *  the search bounds — is INJECTED rather than read, because a search that
 *  reads ambient state ranks identical inputs differently run to run (§2.1).
 *
 *  THE SCALAR IS GENERALISED COST: seconds, plus money converted to seconds
 *  at `SECONDS_PER_CENT`, plus preference penalties. Money is genuinely in the
 *  ranking because an unlock fee is the entire reason a hand-off might not be
 *  worth taking — and three of the five tiers pay nothing for one.
 */

import type { DeviceProperties } from "./api";
import { EQUITY_AREA_RATE, type RatePlan } from "./config";
import { isInEquityArea } from "./equity-areas";
import { WALK_METERS_PER_MIN } from "./locate";
import { billableMinutes } from "./ride-cost";
import { DETOUR_FACTOR, straightLineMeters } from "./reach";
import {
  matches,
  relax,
  relaxationLadder,
  type RideSpec,
  type SpecField,
} from "./ride-spec";

// ---------------------------------------------------------------------------
// Constants. The ones shared with the server lane are marked; a client that
// degrades to a DIFFERENT value degrades to a different ANSWER, not a rougher
// one, which would break §2.3's reconciliation rules invisibly.
// ---------------------------------------------------------------------------

/** Master plan §6.3.0. $1 unlock = 13 min 20 s; one preserved free Access
 *  minute = 2 minutes of extra travel.
 *
 *  BELOW ABOUT 4 s/¢ THE ACCESS CLIFF STOPS CHANGING ROUTES AT ALL, which is
 *  why this is not a free parameter: staying inside the free hour means
 *  walking instead of riding, trading a minute of time for a billable minute
 *  (15¢), and that trade only pays while 15¢ outranks 60 seconds. Set this
 *  near a value-of-time-at-minimum-wage figure and the state augmentation
 *  below becomes dead weight while every test still passes.
 *
 *  AND THE CONSTANT MUST NEVER ARBITRATE "RIDE OR WALK". Implementing the
 *  search turned up the reason, which neither plan had worked out. Walking a
 *  straight-line metre takes 1.006 s here and riding it takes 0.270 s, so
 *  riding beats walking only while
 *
 *      r < (1.006 − 0.270) / (cents-per-minute / 60 × 0.270)
 *
 *  which is r < 6.54 for a resident (25¢/min) and r < 4.19 for a VISITOR
 *  (39¢/min). The cliff needs r > 4. The window where one rate does both jobs
 *  is 4.00–4.19 wide for a visitor and empty in practice — so no value of this
 *  constant can serve both decisions, and tuning it is not the fix.
 *
 *  The fix is that the two decisions are not the same decision. A rider who
 *  asked for wheels has already chosen to ride; the walk-only plan is master
 *  §6.2's degenerate edge, for when walking is genuinely better — a 200 m
 *  trip, not a 4 km one. So it competes only inside the rider's own walk cap
 *  (see `rankPlans`), and with that the rate is left doing the job it was
 *  derived for: trading an unlock against minutes saved BETWEEN ride plans,
 *  and pricing the Access cliff. In that role r > 4 binds and 8 holds. */
export const SECONDS_PER_CENT = 8;

/** Valhalla's Hybrid default, 18 km/h. Every rider-facing profile in the
 *  API's `config.json` routes with `bicycle_type: "Hybrid"` and none sets
 *  `cycling_speed`, so the cheap tier agrees with the expensive one rather
 *  than being independently right about how fast a Veo goes (§2.1). */
export const RIDE_METERS_PER_SEC = 5;

/** `bonus_favorite`, master §8.6. A rider will walk about a minute and a half
 *  further for a scooter they already like — big enough to break a tie, small
 *  enough that it never beats a genuinely better trip. */
export const FAVORITE_BONUS_SECONDS = 90;

/** Rule 1's escape hatch is measured against a FIXED five minutes, never the
 *  rider's `maxWalkMinutes` (1–15). With a 3-minute cap and a non-risky
 *  vehicle 4 minutes away, testing the cap would admit a risky vehicle where
 *  rule 1 says it must not. Rule 1 is a PLATFORM rule; the cap is a RIDER
 *  preference; they cannot share a radius (§2.1). */
export const RISK_FALLBACK_WALK_SECONDS = 5 * 60;

/** Master §6.2's bounded selection, cold-start values only. PROVISIONAL: the
 *  real figures are measured against the deployed matrix's own limits, and at
 *  `N = 20` the server's second call is 20 × 21 = 420 pairs, which is the
 *  number to measure against. Used when the client has never had a candidates
 *  response or the call failed; otherwise `ctx.bounds` carries the server's. */
export const DEFAULT_BOUNDS: SearchBounds = { firstHops: 8, pickups: 12 };

/** The Access Program's free hour, in whole minutes — the height of the
 *  state augmentation below. */
export const FREE_MINUTE_BUDGET = 60;

/** How many plans the list may show. A CAP, never a quota: a valid result can
 *  hold only the walk-only plan (an empty fleet, or a fleet whose every
 *  vehicle fails a `must`). */
export const MAX_PLANS = 4;

/** Nondominated labels kept per `(node, free minutes consumed)` state. This is
 *  what makes the search k-best rather than single-best, so `backups` are real
 *  alternatives the rider can be moved to without a fresh search (§3.1).
 *
 *  NOT A HOP CAP. Chaining stays unbounded and limited by the money term, as
 *  master rule 3 requires; this bounds how many ALTERNATIVES are carried per
 *  state, not how long a plan may be. */
const LABELS_PER_STATE = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LngLat {
  lat: number;
  lng: number;
}

export interface SearchBounds {
  /** The best `W` vehicles by walk seconds, as first hops. */
  firstHops: number;
  /** The best `H` vehicles by how much ride-leg they remove, as pickups. */
  pickups: number;
}

export interface InRideState {
  vehicleIdentifier: string;
  /** What the CURRENT vehicle can still do. */
  rangeMeters: number;
  /** Always true — continuing costs no unlock, because it is already paid. */
  unlockPaid: true;
  /** Minutes of today's free hour spent BEFORE this rental began. A BASELINE,
   *  not a running total, so it cannot go stale.
   *
   *  Usage now is `freeMinutesUsedBeforeRide + billableMinutes(now −
   *  Date.parse(rideStartedAt))` — through `billableMinutes`, never a raw
   *  subtraction. `now` is epoch MILLISECONDS and this is MINUTES, so the bare
   *  difference is a unit error; and Veo bills the STARTED minute, so a rider
   *  61 seconds in has spent 2 free minutes, not 1. Rounding down would rank
   *  them with free minutes they do not have and price a paid minute as free,
   *  which is the one direction §2.2 forbids. */
  freeMinutesUsedBeforeRide: number;
  /** ISO 8601. The other half of that sum. */
  rideStartedAt: string;
}

export interface TripLeg {
  mode: "walk" | "ride";
  seconds: number;
  meters: number;
  /** Ride legs only. */
  vehicle?: DeviceProperties;
  /** 0 on a walk leg, on a free-unlock tier, and on a continuation edge. */
  unlockCents: number;
  /** This leg's PAID minutes at this leg's own rate. */
  minuteCents: number;
  /** `ctx.taxRate` on this leg's unlock + minutes. Its own component for the
   *  same reason the unlock is: fold it into the others and the rider can no
   *  longer see which leg costs the extra unlock, and the server tier's
   *  figures can no longer be reconciled against ours component by
   *  component. */
  taxCents: number;
  /** Access tier only; 0 otherwise. */
  freeMinutesUsed: number;
}

export interface TripPlan {
  legs: TripLeg[];
  /** Derived from the legs, never stored beside them, so they cannot drift. */
  totalSeconds: number;
  estimatedCents: number;
  handOffs: number;
  /** The ranking scalar. Exposed because §3.1's re-solve threshold compares
   *  plans by it, and because a plan list that cannot explain its own order is
   *  not debuggable. */
  generalisedCost: number;
  /** Always true in this tier. §2.3's rule 3 replaces these figures with the
   *  routed ones at the moment a decision is made; until then every surface
   *  says "estimated", because `reach.ts`'s own words apply — it is an
   *  estimate and must be labelled one. */
  isEstimate: true;
}

export interface RankPlansContext {
  from: LngLat;
  to: { lat: number; lon: number };
  spec: RideSpec;
  rate: RatePlan;
  /** RESOLVED BY THE CALLER, never null. This function has no tracked-ride
   *  input, so it could not estimate a null even in principle — §2.2's control
   *  owns the estimate (or the pessimistic 0 for a signed-out rider). */
  freeMinutesLeft: number;
  /** §6.2's bounded selection. Inputs, not constants: the two repos share no
   *  runtime module and the real values are not fixed until the deployed
   *  matrix is measured, so they arrive on the candidates response and fall
   *  back to `DEFAULT_BOUNDS`. */
  bounds?: SearchBounds;
  /** `ride-cost.ts` holds the tax rate as MUTABLE module state. Injected, and
   *  the same figure the server uses. */
  taxRate: number;
  favorites?: ReadonlySet<string>;
  exclude?: ReadonlySet<string>;
  /** Null on an initial search; set on every re-solve (§3.2). */
  inRide?: InRideState | null;
  /** The evaluation instant, epoch ms. Required, and never defaulted to
   *  `Date.now()` inside. */
  now: number;
}

export interface RankPlansResult {
  plans: TripPlan[];
  backups: TripPlan[];
  relaxed: SpecField[];
  /** Rule 1's fallback fired: some offered plan has a `risk`-tier FIRST HOP
   *  because nothing non-risky was within a five-minute walk. Readable from
   *  the result rather than inferred by re-scanning legs, because the UI's
   *  warning is conditioned on it. */
  riskTierOffered: boolean;
  /** Master §6.2's `P → D` edge, ALWAYS computed and ranked by the same
   *  scalar as everything else — so the planner can choose it when walking is
   *  genuinely best, and so §2.5's headline case can compare a hand-off plan
   *  against it.
   *
   *  It appears in `plans` only when its walk is inside the rider's
   *  `maxWalkMinutes`, or when there is nothing to ride at all. A rider who
   *  said "I will walk at most 12 minutes" and asked for wheels is not served
   *  by being offered a 67-minute walk, however it ranks — and at any
   *  exchange rate that lets the Access cliff bite, that is exactly what a
   *  4 km trip ranks as. See `SECONDS_PER_CENT` for why this is a cap
   *  question and not a tuning question. */
  walkOnly: TripPlan;
  /** The rider's `maxWalkMinutes` was relaxed to reach a non-risky vehicle
   *  inside the fixed five minutes (§2.1). Disclosed like any relaxation, and
   *  a SEPARATE FIELD rather than an entry in `relaxed` because the walk cap
   *  is NOT a `SpecField`: `ride-spec.ts`'s ladder covers models, features,
   *  battery, quality and reach, and the cap is none of them. The plan says
   *  this relaxation "sits on the relaxation ladder", which the types do not
   *  yet bear out — widening `SpecField` would touch the spec sheet, the
   *  persistence round-trip and the API's own field list, so it is reported
   *  here and flagged rather than forced through in Phase 2. */
  capRelaxed: boolean;
}

// ---------------------------------------------------------------------------
// Geometry and pricing primitives
// ---------------------------------------------------------------------------

/** Straight line through `reach.ts`'s detour factor, which is the ratio this
 *  codebase already lives with (1.33 and 1.18 measured against donated
 *  tracks, rounded up). */
function roadMeters(a: LngLat, b: LngLat): number {
  return straightLineMeters(a, { lat: b.lat, lon: b.lng }) * DETOUR_FACTOR;
}

/** Walk seconds, UNROUNDED. `locate.ts`'s `walkMinutes` rounds to whole
 *  minutes with a floor of 1 — right for a label and fatal for a ranking,
 *  since most candidates in a trip sit inside the same minute and would all
 *  tie. The pace is the shared thing; the rounding is not. */
function walkSeconds(meters: number): number {
  return (meters / WALK_METERS_PER_MIN) * 60;
}

function rideSeconds(meters: number): number {
  return meters / RIDE_METERS_PER_SEC;
}

/** RULE 1'S SUBJECT, and it is deliberately wider than `matches()`'s
 *  `no-risk` predicate.
 *
 *  `ride-spec.ts`'s min_quality check reads `tier !== "risk"`, which lets
 *  `high_risk` through the `no-risk` filter. Rule 1 cannot inherit that: its
 *  whole point is that the platform does not offer a vehicle that probably
 *  will not start, and `high_risk` is worse than `risk`, not better. Copying
 *  the narrower predicate here would spread what looks like a bug in that one
 *  into the planner. Flagged rather than fixed in place, because changing
 *  `matches()` changes the map's filter too — a user-visible change and not
 *  Phase 2's business. */
function isRisky(props: DeviceProperties): boolean {
  const tier = props.reliability_tier;
  return tier === "risk" || tier === "high_risk";
}

function vehicleKey(props: DeviceProperties): string {
  return props.vehicle_identifier ?? props.device_id;
}

/** The rate a single ride leg bills at.
 *
 *  THE EQUITY AREA RATE IS NOT THE RIDER'S TIER. Exhibit A §5.2 obliges Veo
 *  to discount any trip that starts or ends inside an Equity Area, and
 *  Exhibit C prices that at `$1 + 13¢/min` — AS A RATE. So a tier whose
 *  ordinary unlock is $0 does not get an equity leg for free: whether a
 *  VeoPlus Pass waives THAT dollar is exactly what the contract does not say,
 *  and §5.2 takes the worse (charged) reading. Pricing it per tier here would
 *  have the planner and the disclosure disagree about one leg, with the
 *  planner on the optimistic side.
 *
 *  NEVER OFFERED TO THE ACCESS TIER. Whether the free hour interacts with the
 *  area discount is unstated in the contract, and advice we cannot price is
 *  advice we do not give — so an Access rider is priced at their own tier
 *  throughout.
 *
 *  `isInEquityArea` returning null (geometry unknown) counts as OUTSIDE. That
 *  prices the leg at the higher ordinary rate, which is the safe direction: it
 *  never advertises a discount that will not arrive. */
export function legRate(
  rate: RatePlan,
  from: LngLat,
  to: LngLat,
): { unlockCents: number; perMinCents: number; equityArea: boolean } {
  if (rate.key === "equity") {
    return { unlockCents: rate.unlockCents, perMinCents: rate.perMinCents, equityArea: false };
  }
  const inArea =
    isInEquityArea(from.lng, from.lat) === true ||
    isInEquityArea(to.lng, to.lat) === true;
  if (!inArea) {
    return { unlockCents: rate.unlockCents, perMinCents: rate.perMinCents, equityArea: false };
  }
  return {
    unlockCents: EQUITY_AREA_RATE.unlockCents,
    perMinCents: EQUITY_AREA_RATE.perMinCents,
    equityArea: true,
  };
}

/** Today's free-minute usage on a re-solve, as a count of whole minutes.
 *
 *  Through `billableMinutes`, never a raw subtraction — see `InRideState`. */
export function freeMinutesUsedNow(inRide: InRideState, now: number): number {
  const startedAt = Date.parse(inRide.rideStartedAt);
  if (!Number.isFinite(startedAt)) return inRide.freeMinutesUsedBeforeRide;
  const elapsedMs = Math.max(0, now - startedAt);
  return inRide.freeMinutesUsedBeforeRide + billableMinutes(elapsedMs);
}

// ---------------------------------------------------------------------------
// Candidate selection — §6.2, bounded, and the only place a `risk` vehicle
// can enter the search at all.
// ---------------------------------------------------------------------------

interface Candidate {
  props: DeviceProperties;
  at: LngLat;
  key: string;
  risky: boolean;
  /** Walk seconds from the origin. */
  walkSeconds: number;
  /** Ride seconds from here to the destination — how much leg it removes. */
  toDestSeconds: number;
}

interface Selection {
  candidates: Candidate[];
  firstHops: Set<number>;
  pickups: Set<number>;
  riskAdmitted: boolean;
  /** True when the only non-risky vehicles sat beyond the rider's walk cap but
   *  inside the fixed five minutes, so the CAP was relaxed rather than rule 1
   *  (§2.1). */
  capRelaxed: boolean;
}

function toCandidates(
  feats: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
  ctx: RankPlansContext,
): Candidate[] {
  const out: Candidate[] = [];
  const dest: LngLat = { lat: ctx.to.lat, lng: ctx.to.lon };
  for (const f of feats) {
    const props = f.properties;
    if (!props) continue;
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    if (props.is_disabled === true || props.is_reserved === true) continue;
    const key = vehicleKey(props);
    if (ctx.exclude?.has(key)) continue;
    // The vehicle the rider is already on is not a vehicle to walk to; it is
    // the continuation edge, added separately.
    if (ctx.inRide && props.vehicle_identifier === ctx.inRide.vehicleIdentifier) continue;
    const at: LngLat = { lng: coords[0], lat: coords[1] };
    out.push({
      props,
      at,
      key,
      risky: isRisky(props),
      walkSeconds: walkSeconds(roadMeters(ctx.from, at)),
      toDestSeconds: rideSeconds(roadMeters(at, dest)),
    });
  }
  return out;
}

/** §6.2 steps 2–4. Step 2 and step 3 differ ON PURPOSE: a risky vehicle you
 *  walk to is sometimes the only trip available, and a risky vehicle you hand
 *  off to never is. */
function select(
  all: Candidate[],
  ctx: RankPlansContext,
  couldEndOn: (c: Candidate) => boolean,
): Selection {
  const bounds = ctx.bounds ?? DEFAULT_BOUNDS;
  const capSeconds = ctx.spec.maxWalkMinutes * 60;

  const nonRisky = all.filter((c) => !c.risky);
  const insideCap = nonRisky.filter((c) => c.walkSeconds <= capSeconds);
  const insideFive = nonRisky.filter((c) => c.walkSeconds <= RISK_FALLBACK_WALK_SECONDS);

  let firstHopPool: Candidate[];
  let riskAdmitted = false;
  let capRelaxed = false;

  if (insideCap.length > 0) {
    firstHopPool = insideCap;
  } else if (insideFive.length > 0) {
    // RELAX THE CAP, NEVER RULE 1. The cap is a rider preference and sits on
    // the relaxation ladder; rule 1 does not. "You will walk a minute longer
    // than you asked" is a better answer than "here is a scooter that
    // probably will not start", and far better than an empty list. The real
    // walk time is shown either way.
    firstHopPool = insideFive;
    capRelaxed = true;
  } else {
    // Only now may a risky vehicle be a first hop, and only inside the
    // rider's own cap. This is the sole place in the entire search that
    // admits one.
    const risky = all.filter((c) => c.risky && c.walkSeconds <= capSeconds);
    firstHopPool = risky;
    riskAdmitted = risky.length > 0;
  }

  const firstHopList = [...firstHopPool]
    .sort((a, b) => a.walkSeconds - b.walkSeconds)
    .slice(0, bounds.firstHops);

  // Pickups never refill from the risk tier. No exception, ever.
  //
  // And they are drawn from the vehicles the rider would be happy to END ON,
  // not from the whole fleet: ranking the fleet by progress alone can leave
  // the spec-matching scooter out of the pool entirely, and then no plan ends
  // on one — which is the only thing the rider asked for.
  const pickupList = nonRisky
    .filter(couldEndOn)
    .sort((a, b) => a.toDestSeconds - b.toDestSeconds)
    .slice(0, bounds.pickups);

  const candidates: Candidate[] = [];
  const index = new Map<Candidate, number>();
  const firstHops = new Set<number>();
  const pickups = new Set<number>();
  const add = (c: Candidate): number => {
    let i = index.get(c);
    if (i === undefined) {
      i = candidates.length;
      candidates.push(c);
      index.set(c, i);
    }
    return i;
  };
  for (const c of firstHopList) firstHops.add(add(c));
  for (const c of pickupList) pickups.add(add(c));

  return { candidates, firstHops, pickups, riskAdmitted, capRelaxed };
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

interface RideEdge {
  /** Index into `candidates`, or -1 for the in-ride continuation vehicle. */
  vehicle: number;
  /** Destination node: a candidate index, or DEST. */
  to: number;
  meters: number;
  seconds: number;
}

const DEST = -2;
const ORIGIN = -1;

interface Label {
  node: number;
  /** Free minutes of the rider's remaining balance consumed so far. */
  freeUsed: number;
  cost: number;
  legs: TripLeg[];
  /** Vehicle keys already ridden, so a plan cannot revisit one. */
  used: ReadonlySet<string>;
}

/** Price one ride leg, given the free-minute balance on arrival at its start. */
function priceRide(
  edge: RideEdge,
  props: DeviceProperties,
  from: LngLat,
  to: LngLat,
  ctx: RankPlansContext,
  freeRemaining: number,
  unlockPaid: boolean,
  isFavorite: boolean,
): { leg: TripLeg; cost: number; freeUsed: number } {
  const rate = legRate(ctx.rate, from, to);
  const billable = billableMinutes(edge.seconds * 1000);
  const freeUsed = ctx.rate.key === "equity" ? Math.min(freeRemaining, billable) : 0;
  const paidMinutes = billable - freeUsed;
  const unlockCents = unlockPaid ? 0 : rate.unlockCents;
  const minuteCents = paidMinutes * rate.perMinCents;
  const taxCents = Math.round((unlockCents + minuteCents) * ctx.taxRate);
  const money = unlockCents + minuteCents + taxCents;
  // The favourite bonus is a PREFERENCE, so it is clamped at the leg's own
  // cost: Dijkstra needs non-negative edges, and a bonus large enough to make
  // a leg free is already doing more than a preference should.
  const bonus = isFavorite ? FAVORITE_BONUS_SECONDS : 0;
  const cost = Math.max(0, edge.seconds + money * SECONDS_PER_CENT - bonus);
  return {
    leg: {
      mode: "ride",
      seconds: edge.seconds,
      meters: edge.meters,
      vehicle: props,
      unlockCents,
      minuteCents,
      taxCents,
      freeMinutesUsed: freeUsed,
    },
    cost,
    freeUsed,
  };
}

function walkLeg(meters: number): TripLeg {
  return {
    mode: "walk",
    seconds: walkSeconds(meters),
    meters,
    unlockCents: 0,
    minuteCents: 0,
    taxCents: 0,
    freeMinutesUsed: 0,
  };
}

function finish(legs: TripLeg[], cost: number): TripPlan {
  let totalSeconds = 0;
  let estimatedCents = 0;
  let handOffs = 0;
  let rides = 0;
  for (const leg of legs) {
    totalSeconds += leg.seconds;
    estimatedCents += leg.unlockCents + leg.minuteCents + leg.taxCents;
    if (leg.mode === "ride") rides += 1;
  }
  handOffs = Math.max(0, rides - 1);
  return {
    legs,
    totalSeconds,
    estimatedCents,
    handOffs,
    generalisedCost: cost,
    isEstimate: true,
  };
}

/** One pass of the search at a fixed spec. Returns complete plans, best first. */
function searchOnce(
  feats: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
  ctx: RankPlansContext,
  spec: RideSpec,
): { plans: TripPlan[]; walkOnly: TripPlan; riskTierOffered: boolean; capRelaxed: boolean } {
  const dest: LngLat = { lat: ctx.to.lat, lng: ctx.to.lon };
  const all = toCandidates(feats, ctx);

  // THE FREE-MINUTE BALANCE IS SEARCH STATE, NOT AN INPUT. Pricing a whole
  // plan under one regime — every minute free, or every minute paid — is
  // unsound: master §6.3's counterexample has an optimum that NEITHER regime
  // returns, because uniform pricing destroys the exact trade-off the cliff
  // creates (spend more total minutes to stay inside the free hour). So a node
  // is `(location, free minutes consumed)`.
  //
  // It collapses to a single layer for every rider without a free balance,
  // which is four of the five tiers and any Access rider who has spent the
  // hour — so the exact answer is free for most riders.
  const alreadyUsed = ctx.inRide ? freeMinutesUsedNow(ctx.inRide, ctx.now) : 0;
  const freeBudget =
    ctx.rate.key === "equity"
      ? Math.max(0, Math.min(FREE_MINUTE_BUDGET, ctx.freeMinutesLeft) - alreadyUsed)
      : 0;

  // WHICH LEGS THE SPEC BINDS ON — an inference, because neither plan says.
  //
  // The original ask was "plan to RIDE to a device that meets their
  // specifications", so the spec describes the vehicle the rider ENDS ON. A
  // starter is something ordinary you ride to get there.
  //
  // Reading it the other way — every vehicle in the plan must satisfy every
  // `must` — deletes the feature: if the Astro you walk to needs the basket
  // too, there is nothing to hand off FROM, and the plan collapses back to
  // "walk to the matching scooter", which is the misreading revision 3 exists
  // to correct. So:
  //
  //   * the LAST ride leg's vehicle must satisfy the rider's musts — it is
  //     the one they keep, and §5.2 says musts are never relaxed;
  //   * EVERY leg's vehicle must pass `mustReach` for ITS OWN endpoint, which
  //     is the per-leg rule master §5.2 calls load-bearing;
  //   * a starter needs only that, plus availability and rule 1.
  //
  // The one line of the plan that pulls the other way — "a favourite that
  // fails a `must` is disqualified like anything else" — is about favourites
  // not buying their way past a requirement, and still holds: a favourite
  // cannot become the vehicle you end on without satisfying the musts.
  const starterSpec: RideSpec = {
    ...spec,
    models: null,
    features: [],
    minBattery: 0,
    minQuality: "any",
    must: spec.must.filter((f) => f === "must_reach"),
  };

  /** Does this vehicle qualify for a leg ENDING at `legEnd`?
   *
   *  `mustReach` is evaluated per leg, against that leg's own endpoint. Handing
   *  `matches()` the final destination for every candidate disqualifies
   *  precisely the vehicles this phase exists to use: a scruffy Astro with
   *  1.5 km of range is a fine STARTER when its hand-off is 1.2 km away, and
   *  useless only as a vehicle for the whole trip. */
  const qualifiesFor = (c: Candidate, legEnd: LngLat, isFinalLeg: boolean): boolean => {
    const m = matches(c.props, isFinalLeg ? spec : starterSpec, {
      at: { lat: c.at.lat, lng: c.at.lng },
      dest: { lat: legEnd.lat, lon: legEnd.lng },
    });
    // The last leg's vehicle is the one the rider KEEPS, so it owes them
    // everything they asked for at this rung. A starter owes only
    // availability, rule 1, and reach to its own hand-off.
    return isFinalLeg ? m.ideal : m.unmetMust.length === 0 && m.available;
  };

  /** Would the rider be happy to END on this vehicle? Pickups are drawn from
   *  these, because the point of a hand-off is the vehicle you keep. Reach is
   *  left out here and checked per leg.
   *
   *  `ideal`, NOT `qualifies` — everything the rider asked for, preferences
   *  included. `qualifies` only enforces the musts, and with no musts set it
   *  is true of every available vehicle, which would make the relaxation
   *  ladder unreachable: nothing is ever "not found", so nothing ever gets
   *  given up, so `relaxed` could never be anything but empty. The ladder
   *  exists precisely to trade PREFERENCES away one rung at a time, and it
   *  only has work to do if the pool starts out demanding all of them. */
  const couldEndOn = (c: Candidate): boolean => {
    const m = matches(c.props, spec, { at: { lat: c.at.lat, lng: c.at.lng } });
    return m.ideal;
  };

  const sel = select(all, { ...ctx, spec }, couldEndOn);
  const { candidates } = sel;

  const positionOf = (node: number): LngLat =>
    node === DEST ? dest : node === ORIGIN ? ctx.from : candidates[node].at;

  // Ride edges out of each candidate: to every pickup, and to the destination.
  const rideEdgesFrom = (node: number): RideEdge[] => {
    const c = candidates[node];
    const out: RideEdge[] = [];
    const toDestMeters = roadMeters(c.at, dest);
    if (qualifiesFor(c, dest, true)) {
      out.push({ vehicle: node, to: DEST, meters: toDestMeters, seconds: rideSeconds(toDestMeters) });
    }
    for (const j of sel.pickups) {
      if (j === node) continue;
      const end = candidates[j].at;
      const meters = roadMeters(c.at, end);
      // A hand-off has to make progress; riding away from the destination to
      // reach a pickup is never part of an optimal plan and generating those
      // edges only slows the search down.
      if (candidates[j].toDestSeconds >= c.toDestSeconds) continue;
      if (!qualifiesFor(c, end, false)) continue;
      out.push({ vehicle: node, to: j, meters, seconds: rideSeconds(meters) });
    }
    return out;
  };

  const isFavorite = (c: Candidate): boolean => ctx.favorites?.has(c.key) === true;

  // Label-setting search over `(node, freeUsed)`. Up to LABELS_PER_STATE
  // nondominated labels per state, which is what makes `backups` real
  // alternatives rather than a second search.
  const seen = new Map<string, number[]>();
  const queue: Label[] = [];
  const complete: TripPlan[] = [];

  const push = (label: Label): void => {
    const key = `${label.node}:${label.freeUsed}`;
    const costs = seen.get(key) ?? [];
    if (costs.length >= LABELS_PER_STATE && costs[costs.length - 1] <= label.cost) return;
    costs.push(label.cost);
    costs.sort((a, b) => a - b);
    if (costs.length > LABELS_PER_STATE) costs.length = LABELS_PER_STATE;
    seen.set(key, costs);
    queue.push(label);
  };

  // The walk-only plan. Master §6.2's `P → D` edge: no vehicle at all, when
  // that is genuinely best. A planner that cannot REPRESENT walking cannot
  // choose it, and §2.5's headline test compares a hand-off plan against the
  // direct walk, which needs both in one list to compare at all.
  const directWalk = walkLeg(roadMeters(ctx.from, dest));
  const walkOnly = finish([directWalk], directWalk.seconds);
  complete.push(walkOnly);

  // Edges leaving the origin.
  for (const i of sel.firstHops) {
    const c = candidates[i];
    const meters = roadMeters(ctx.from, c.at);
    push({
      node: i,
      freeUsed: 0,
      cost: walkSeconds(meters),
      legs: [walkLeg(meters)],
      used: new Set(),
    });
  }

  // THE CONTINUATION EDGE. On a re-solve the rider is ON a vehicle, so the
  // origin also gets "keep riding what you have" — priced with NO unlock
  // because it is already paid, and bounded by that vehicle's remaining range.
  // Without it a re-solve would systematically prefer handing off, because
  // carrying on would not be in the graph to lose.
  if (ctx.inRide) {
    const current = feats.find(
      (f) => f.properties?.vehicle_identifier === ctx.inRide!.vehicleIdentifier,
    );
    const props = current?.properties;
    if (props) {
      const continueTo: number[] = [DEST, ...sel.pickups];
      for (const target of continueTo) {
        const end = positionOf(target);
        const meters = roadMeters(ctx.from, end);
        if (meters > ctx.inRide.rangeMeters) continue;
        if (target !== DEST && candidates[target].toDestSeconds >= rideSeconds(roadMeters(ctx.from, dest))) {
          continue;
        }
        const edge: RideEdge = { vehicle: -1, to: target, meters, seconds: rideSeconds(meters) };
        const priced = priceRide(
          edge,
          props,
          ctx.from,
          end,
          ctx,
          freeBudget,
          true,
          ctx.favorites?.has(vehicleKey(props)) === true,
        );
        const label: Label = {
          node: target,
          freeUsed: priced.freeUsed,
          cost: priced.cost,
          legs: [priced.leg],
          used: new Set([vehicleKey(props)]),
        };
        if (target === DEST) complete.push(finish(label.legs, label.cost));
        else push(label);
      }
    }
  }

  while (queue.length > 0) {
    // Cheapest first. The queue stays small (bounded candidates × ≤61 free
    // layers × LABELS_PER_STATE), so a linear scan beats a heap's overhead.
    let best = 0;
    for (let k = 1; k < queue.length; k += 1) {
      if (queue[k].cost < queue[best].cost) best = k;
    }
    const label = queue.splice(best, 1)[0];
    const c = candidates[label.node];
    if (!c) continue;
    if (label.used.has(c.key)) continue;

    for (const edge of rideEdgesFrom(label.node)) {
      const end = positionOf(edge.to);
      const priced = priceRide(
        edge,
        c.props,
        c.at,
        end,
        ctx,
        Math.max(0, freeBudget - label.freeUsed),
        false,
        isFavorite(c),
      );
      const legs = [...label.legs, priced.leg];
      const cost = label.cost + priced.cost;
      const used = new Set(label.used);
      used.add(c.key);
      if (edge.to === DEST) {
        complete.push(finish(legs, cost));
        continue;
      }
      const target = candidates[edge.to];
      if (used.has(target.key)) continue;
      // A hand-off lands ON the next vehicle: no walk leg between them, which
      // is the whole point of the model — the spec-matching scooter is a
      // waypoint, not somewhere you walk to.
      push({
        node: edge.to,
        freeUsed: label.freeUsed + priced.freeUsed,
        cost,
        legs,
        used,
      });
    }
  }

  complete.sort((a, b) => a.generalisedCost - b.generalisedCost);

  // Distinct by vehicle sequence: two plans that ride the same scooters in the
  // same order are one plan, and offering the rider a "backup" identical to
  // their plan is worse than offering none.
  const byShape = new Map<string, TripPlan>();
  for (const plan of complete) {
    const shape = plan.legs
      .filter((l) => l.mode === "ride")
      .map((l) => (l.vehicle ? vehicleKey(l.vehicle) : "?"))
      .join(">");
    if (!byShape.has(shape)) byShape.set(shape, plan);
  }

  return {
    plans: [...byShape.values()],
    walkOnly,
    riskTierOffered: sel.riskAdmitted,
    capRelaxed: sel.capRelaxed,
  };
}

/**
 * Rank multi-leg trip plans over the fleet.
 *
 * Feed it the UNFILTERED fleet (`devices.allFeatures()`, never
 * `visibleFeatures()`): a rider's leftover map filters are a view, not a
 * statement of what they will ride. Unfiltered is not unbounded, though —
 * §6.2's selection step is what enters the graph, because the bbox and the
 * walk cap bound the FIRST hop only and say nothing about downstream nodes.
 */
export function rankPlans(
  feats: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
  ctx: RankPlansContext,
): RankPlansResult {
  const ladder = relaxationLadder(ctx.spec);
  const relaxed: SpecField[] = [];

  // Monotonic relaxation over PLANS, not just vehicles: climb the published
  // ladder only until a plan with a ride leg exists. The walk-only plan always
  // exists, so "nothing found" has to mean "nothing to ride", or the ladder
  // would never climb at all.
  for (let rungs = 0; rungs <= ladder.length; rungs += 1) {
    const spec = rungs === 0 ? ctx.spec : relax(ctx.spec, rungs);
    const result = searchOnce(feats, ctx, spec);
    const ridden = result.plans.filter((p) => p.handOffs > 0 || p.legs.some((l) => l.mode === "ride"));
    const isLast = rungs === ladder.length;
    if (ridden.length > 0 || isLast) {
      if (rungs > 0) {
        for (const rung of ladder.slice(0, rungs)) {
          if (!relaxed.includes(rung.field)) relaxed.push(rung.field);
        }
      }
      // The walk-only plan is ranked with everything else but OFFERED only
      // inside the rider's own cap, or when there is nothing to ride.
      const capSeconds = ctx.spec.maxWalkMinutes * 60;
      const walkIsOfferable =
        result.walkOnly.totalSeconds <= capSeconds || ridden.length === 0;
      const ordered = walkIsOfferable
        ? result.plans
        : result.plans.filter((p) => p !== result.walkOnly);
      return {
        plans: ordered.slice(0, MAX_PLANS),
        backups: ordered.slice(MAX_PLANS),
        relaxed,
        riskTierOffered: result.riskTierOffered,
        walkOnly: result.walkOnly,
        capRelaxed: result.capRelaxed,
      };
    }
  }

  // Unreachable: the loop above always returns on its last iteration.
  const empty = finish([walkLeg(0)], 0);
  return {
    plans: [],
    backups: [],
    relaxed,
    riskTierOffered: false,
    walkOnly: empty,
    capRelaxed: false,
  };
}
