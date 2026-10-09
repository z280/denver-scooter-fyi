// WHERE ALONG THE ROUTE TO SWAP, and on whose terms.
//
// `rankPlans` answers "what are the ways there" with one scalar: generalised
// cost, which is seconds plus money at `SECONDS_PER_CENT`. That scalar is
// right for finding the plans and wrong for choosing between them, because
// riders do not all want the same thing out of a split trip. Four riders
// looking at the same four plans want four different ones:
//
//   Comfort     most of the trip on the scooter I actually like
//   Savings     the Equity Area discount, and I'll take a longer ride for it
//   Flexibility swap somewhere there are other scooters, in case mine is gone
//   Simplicity  fewest hand-offs, least faff
//
// WHY THIS RE-ORDERS RATHER THAN RE-SEARCHES. The alternative was four cost
// functions inside `searchOnce`, and it is the wrong shape twice over. The
// label-setting search needs non-negative edge costs and prices the
// free-minute cliff as search state, so a per-priority bonus large enough to
// move a swap is also large enough to break both. And three of these four
// preferences are properties of a WHOLE PLAN — the share of the ride on an
// ideal scooter, whether the swap point has company, how many hand-offs there
// are — which an edge relaxation cannot see at all. The search already
// retains up to `LABELS_PER_STATE` nondominated labels per state and hands
// back everything past `MAX_PLANS` as `backups`, so the candidate set is
// genuinely wider than the four rows a rider sees. Choosing from that set is
// the honest lever.
//
// PURE. No DOM, no network, no clock — the fleet, the spec and the match
// context are all injected, for `along-the-way.ts`'s reason: a ranking that
// reads ambient state orders identical inputs differently run to run.

import type { DeviceProperties } from "./api";
import type { TripLeg, TripPlan } from "./along-the-way";
import { straightLineMeters } from "./reach";
import { matches, type MatchContext, type RideSpec } from "./ride-spec";

/** The rider's answer to "given that this trip splits, split it how?". */
export type RoutePriority = "comfort" | "savings" | "flexibility" | "simplicity";

/** Comfort's one hard number: at most a quarter of the riding may be on a
 *  scooter the rider did not ask for.
 *
 *  A CAP AND NOT A WEIGHT, because that is what the rider said. A weight lets
 *  a long enough non-ideal leg buy its way back with a saving, which is the
 *  one trade somebody choosing Comfort has already declined. */
export const MAX_NON_IDEAL_SHARE = 0.25;

/** How far from a swap another scooter counts as "there too".
 *
 *  Two minutes' walk. The question this answers is "if my scooter is gone
 *  when I arrive, is there another one I can see?", so the radius is the one
 *  a rider will actually cross while standing at the swap, not a planning
 *  distance. */
export const SWAP_ALTERNATIVE_METERS = 150;

/** Money differences at or below this are a tie, and something else decides.
 *
 *  Mirrors `ideal-share.ts`'s own tolerance, and for the same reason: below a
 *  few cents the rider cannot act on the difference, so letting it dictate
 *  the order spends the list's one ranking slot on noise. */
export const TIE_CENTS = 50;

export const ROUTE_PRIORITY_KEY = "scooter-fyi-route-priority";

/** Comfort is the owner's stated default: the preference that preceded this
 *  one offered "More of my ideal scooter" against "Cheapest" and defaulted to
 *  the former, so a rider who never opens this control keeps the behaviour
 *  they already had. */
export const DEFAULT_ROUTE_PRIORITY: RoutePriority = "comfort";

export interface RoutePriorityOption {
  value: RoutePriority;
  label: string;
  hint: string;
}

/** The rider's own words, which the surfaces must not paraphrase: the hint is
 *  the only place the trade-off each one MAKES is stated, and a rider picking
 *  blind is picking the first option. */
export const ROUTE_PRIORITY_OPTIONS: readonly RoutePriorityOption[] = [
  {
    value: "comfort",
    label: "Comfort and speed",
    hint: "Keeps you on your ideal scooter for at least three quarters of the riding, even if another plan is cheaper.",
  },
  {
    value: "savings",
    label: "Savings",
    hint: "Cheapest first, and among plans that cost about the same it hunts for a swap inside an Equity Area. Will accept a longer ride, never a bigger bill.",
  },
  {
    value: "flexibility",
    label: "Flexibility",
    hint: "Swaps where other scooters you'd accept are standing, so a taken scooter is not a dead end.",
  },
  {
    value: "simplicity",
    label: "Simplicity",
    hint: "Fewest hand-offs and least walking. Skips a discount that costs you a detour.",
  },
];

function isRoutePriority(v: unknown): v is RoutePriority {
  return ROUTE_PRIORITY_OPTIONS.some((o) => o.value === v);
}

/** Read the stored preference.
 *
 *  MIGRATES THE TWO-OPTION ANCESTOR. `scooter-fyi-ideal-split` held
 *  `prefer_ideal` / `cheapest`, which is this same axis at lower resolution,
 *  and a rider who set it deliberately should not be silently reset to the
 *  default. Read-only: the old key is left where it is rather than rewritten,
 *  so rolling this change back restores their setting intact. */
export function routePriority(): RoutePriority {
  try {
    const raw = localStorage.getItem(ROUTE_PRIORITY_KEY);
    if (isRoutePriority(raw)) return raw;
    const legacy = localStorage.getItem("scooter-fyi-ideal-split");
    if (legacy === "cheapest") return "savings";
    if (legacy === "prefer_ideal") return "comfort";
    return DEFAULT_ROUTE_PRIORITY;
  } catch {
    // Private mode, or storage refused. The default is a real answer.
    return DEFAULT_ROUTE_PRIORITY;
  }
}

/** Returns false when the write was refused, so a caller can say so rather
 *  than claiming the device saved it. */
export function setRoutePriority(value: RoutePriority): boolean {
  try {
    localStorage.setItem(ROUTE_PRIORITY_KEY, value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Measurements. One per priority, each answerable from a plan alone except
// `swapCompany`, which needs the fleet.
// ---------------------------------------------------------------------------

export interface FleetPoint {
  properties: DeviceProperties;
  lat: number;
  lon: number;
}

function rideLegs(plan: TripPlan): TripLeg[] {
  return plan.legs.filter((l) => l.mode === "ride");
}

function seconds(leg: TripLeg): number {
  return Number.isFinite(leg.seconds) && leg.seconds > 0 ? leg.seconds : 0;
}

/** Share of the RIDING spent on a scooter the rider did not ask for, 0..1.
 *
 *  Null when there is no spec or nothing to measure — null is not zero, and
 *  "none of it is on the wrong scooter" is a claim this cannot make without a
 *  sheet to check against.
 *
 *  Walking is excluded on purpose. This is the share the 25% cap is about,
 *  and the cap is about which scooter is under the rider, not about how they
 *  got to it. */
export function nonIdealShare(
  plan: TripPlan,
  spec: RideSpec | null,
  ctx: MatchContext = {},
): number | null {
  if (spec === null) return null;
  const legs = rideLegs(plan);
  if (legs.length === 0) return null;
  let total = 0;
  let off = 0;
  for (const leg of legs) {
    const s = seconds(leg);
    total += s;
    if (!leg.vehicle || !matches(leg.vehicle, spec, ctx).ideal) off += s;
  }
  if (total <= 0) return null;
  return off / total;
}

/** Does this plan keep the rider on what they asked for? True when there is
 *  no sheet to fail: a rider with no stated preference cannot be on the wrong
 *  scooter, and demoting every plan for a cap nobody set would make Comfort
 *  rank identically to its own fallback. */
export function meetsComfortCap(
  plan: TripPlan,
  spec: RideSpec | null,
  ctx: MatchContext = {},
): boolean {
  const off = nonIdealShare(plan, spec, ctx);
  if (off === null) return true;
  return off <= MAX_NON_IDEAL_SHARE;
}

/** Share of the riding billed at the Equity Area rate, 0..1.
 *
 *  Reads `leg.equityArea`, which `legRate` wrote at pricing time, rather than
 *  re-testing the polygons. A second copy of that rule is a second answer,
 *  and the rider would be reading ours while the planner priced with theirs.
 *
 *  THIS IS WHY A MID-WAY SWAP IS WORTH HUNTING FOR. `legRate` gives a leg the
 *  discount when EITHER endpoint is in an area, so a swap inside one earns it
 *  for the leg arriving and the leg leaving — one swap point, two discounted
 *  legs. A plan that merely ends in an area gets one. */
export function equityShare(plan: TripPlan): number | null {
  const legs = rideLegs(plan);
  if (legs.length === 0) return null;
  let total = 0;
  let discounted = 0;
  for (const leg of legs) {
    const s = seconds(leg);
    total += s;
    if (leg.equityArea) discounted += s;
  }
  if (total <= 0) return null;
  return discounted / total;
}

/** How many OTHER scooters the rider would accept are standing at this plan's
 *  loneliest swap.
 *
 *  `Infinity` for a plan with no hand-off: there is no swap, so no swap can
 *  fail, which is the most flexible a plan can be. A rider who picked
 *  Flexibility to avoid being stranded by a taken scooter is best served by
 *  not depending on one.
 *
 *  THE LONELIEST SWAP, not the average. A chain is as strong as its weakest
 *  link, and averaging lets a plan with one well-stocked swap and one
 *  deserted one outrank a plan with two adequate ones.
 *
 *  Null when the fleet cannot answer — no fleet passed, or a hand-off vehicle
 *  that is not in it. Null is not zero: "we could not look" and "we looked
 *  and found nothing" are different, and only the second is a reason to
 *  demote a plan. */
export function swapCompany(
  plan: TripPlan,
  fleet: readonly FleetPoint[] | null,
  spec: RideSpec | null,
  ctx: MatchContext = {},
): number | null {
  const legs = rideLegs(plan);
  if (legs.length < 2) return Infinity;
  if (!fleet || fleet.length === 0 || spec === null) return null;

  const byId = new Map<string, FleetPoint>();
  for (const f of fleet) {
    const id = f.properties.device_id;
    if (id) byId.set(id, f);
  }

  let worst = Infinity;
  // The swap points are where legs 2..N START, which is where each of those
  // vehicles is standing now. Leg one's pickup is the walk the rider is about
  // to take, not a hand-off — the same rule `planLedger` follows.
  for (const leg of legs.slice(1)) {
    const id = leg.vehicle?.device_id;
    const at = id ? byId.get(id) : undefined;
    if (!at) return null;
    let company = 0;
    for (const other of fleet) {
      if (other.properties.device_id === id) continue;
      const meters = straightLineMeters(
        { lat: at.lat, lng: at.lon },
        { lat: other.lat, lon: other.lon },
      );
      if (meters > SWAP_ALTERNATIVE_METERS) continue;
      // Straight-line, deliberately: this is a question about what is in
      // sight from the swap, and a detour factor would understate how many
      // scooters a rider standing there can actually walk to.
      if (!matches(other.properties, spec, ctx).ideal) continue;
      company += 1;
    }
    worst = Math.min(worst, company);
  }
  return worst;
}

/** Seconds on foot. Simplicity's second question, after the hand-off count:
 *  "walking a little further to find discounts" is exactly the kind of faff
 *  it exists to decline. */
export function walkSeconds(plan: TripPlan): number {
  let total = 0;
  for (const leg of plan.legs) {
    if (leg.mode === "walk") total += seconds(leg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export interface PriorityContext {
  spec: RideSpec | null;
  /** For `swapCompany`. Null where the caller has no fleet to offer, which
   *  makes Flexibility fall back to price rather than invent an answer. */
  fleet?: readonly FleetPoint[] | null;
  match?: MatchContext;
}

/** Everything the comparators read, measured once per plan.
 *
 *  Measured UP FRONT rather than inside the comparator, because a comparator
 *  is called O(n log n) times and `swapCompany` is O(fleet) per hand-off —
 *  and because a measurement that runs inside a sort can observe a different
 *  answer on two different comparisons and produce an ordering that is not an
 *  ordering at all. */
interface Measured<T> {
  row: T;
  index: number;
  plan: TripPlan;
  cents: number;
  totalSeconds: number;
  handOffs: number;
  walk: number;
  nonIdeal: number | null;
  comfortOk: boolean;
  equity: number | null;
  company: number | null;
}

/** Cheapest-anchored price bucket: every plan within `TIE_CENTS` of the best
 *  price on the list is one bucket, so a preference can decide between them.
 *
 *  ANCHORED ON THE CHEAPEST, not on the neighbour, which is the mistake the
 *  two-option preference this replaced had already found: a chain of 49¢
 *  steps would otherwise carry a plan a long way up the list for a difference
 *  the rider would certainly notice. */
function tiedWithCheapest(cents: number, cheapest: number): boolean {
  return cents - cheapest <= TIE_CENTS;
}

type Comparator<T> = (a: Measured<T>, b: Measured<T>) => number;

function byPriority<T>(priority: RoutePriority, cheapest: number): Comparator<T> {
  const cheaper: Comparator<T> = (a, b) => a.cents - b.cents;
  const quicker: Comparator<T> = (a, b) => a.totalSeconds - b.totalSeconds;
  const tie: Comparator<T> = (a, b) => {
    const aTied = tiedWithCheapest(a.cents, cheapest);
    const bTied = tiedWithCheapest(b.cents, cheapest);
    if (aTied !== bTied) return aTied ? -1 : 1;
    return 0;
  };

  switch (priority) {
    // THE CAP FIRST, and it is the only place a hard constraint appears. A
    // plan that breaks it sorts below every plan that keeps it however much
    // cheaper it is — that is what "no more than 25%" means — but it is
    // DEMOTED and not dropped, because a rider whose every option breaks the
    // cap is better served by the best of them plus a sentence saying so than
    // by an empty list.
    case "comfort":
      return (a, b) => {
        // THE SHARE IS THE WHOLE ORDER, and the cap needs no separate gate in
        // front of it: a plan that keeps the cap has a smaller share than one
        // that breaks it, by definition, so a `comfortOk` test here could
        // never change an answer this line does not already give. It had one
        // — and it was wrong. A walk-only plan has no ride legs, so it cannot
        // fail a cap about which scooter you are on, and the gate floated it
        // above every plan that rides. A rider who asked to spend the trip on
        // their own scooter did not ask to walk. Null sorts last, which is
        // what `?? 1` says. (`capUnmet` still reads `meetsComfortCap` — that
        // is a claim about the list, not an ordering.)
        const aOff = a.nonIdeal ?? 1;
        const bOff = b.nonIdeal ?? 1;
        if (aOff !== bOff) return aOff - bOff;
        return quicker(a, b) || cheaper(a, b);
      };

    // MONEY IS PRIMARY AND THE EQUITY SHARE BREAKS ITS TIES — in that order,
    // and the order is the whole design.
    //
    // The concession the rider offered was TIME: "even if the total ride is a
    // bit longer". They did not offer money, and a Savings setting that picks
    // the dearer plan has failed at the one thing its name promises. So time
    // is out of the key until the money is settled — which is the planner's
    // own scalar being declined, since generalised cost would take the
    // quicker one — and price stays in front of the share.
    //
    // THE SHARE CANNOT BE PRIMARY, and the arithmetic is why. An Equity Area
    // leg bills at $1 + 13¢/min against the resident's $1 + 25¢/min: the
    // UNLOCK IS THE SAME. So a mid-way swap inside an area buys 12¢/min at
    // the price of a second $1 unlock, and needs about 8.3 minutes of
    // discounted riding just to break even. Below that the higher-equity plan
    // is simply the more expensive one, and ranking it first would spend a
    // rider's money chasing a discount that did not pay for itself.
    //
    // What the share IS for: two plans that cost about the same, where one
    // swaps inside an area and one does not. That is the mid-way swap worth
    // hunting for, and `TIE_CENTS` is where "about the same" is written down.
    case "savings":
      return (a, b) => {
        const t = tie(a, b);
        if (t !== 0) return t;
        const aEq = a.equity ?? -1;
        const bEq = b.equity ?? -1;
        if (aEq !== bEq) return bEq - aEq;
        return cheaper(a, b) || quicker(a, b);
      };

    // Company at the swap first, then price. A plan whose swap we could not
    // measure (`null`) sorts on price alone rather than being demoted: we did
    // not look, and a plan must not lose for our ignorance.
    case "flexibility":
      return (a, b) => {
        const aCo = a.company;
        const bCo = b.company;
        if (aCo !== null && bCo !== null && aCo !== bCo) return bCo - aCo;
        if ((aCo === null) !== (bCo === null)) {
          // Measured beats unmeasured only when the measurement is good news;
          // an unmeasured plan is not worse than a swap we know is deserted.
          const measured = aCo === null ? bCo! : aCo;
          const preferMeasured = measured > 0;
          if (aCo === null) return preferMeasured ? 1 : -1;
          return preferMeasured ? -1 : 1;
        }
        return cheaper(a, b) || quicker(a, b);
      };

    // Hand-offs, then time on foot, then price. Nothing here is a tie-band:
    // a rider who asked for simplicity wants the simple plan, not the simple
    // plan that happens to be within 50¢.
    case "simplicity":
      return (a, b) => {
        if (a.handOffs !== b.handOffs) return a.handOffs - b.handOffs;
        if (a.walk !== b.walk) return a.walk - b.walk;
        return cheaper(a, b) || quicker(a, b);
      };
  }
}

export interface PriorityOrder<T> {
  rows: T[];
  /** The preference actually moved something, so a surface can say so without
   *  diffing two arrays it did not build. */
  moved: boolean;
  /** Comfort only: nothing on the list keeps the 25% cap. Disclosed rather
   *  than hidden — a rider who asked to stay on their own scooter and is
   *  being shown plans that do not is owed the reason. */
  capUnmet: boolean;
}

/** Order the plans by what the rider asked for.
 *
 *  STABLE WHEREVER IT HAS NO OPINION: ties fall back to the order `rankPlans`
 *  produced, so the planner's own judgement survives in every case this
 *  preference does not actually speak to. */
export function orderByPriority<T extends { plan: TripPlan }>(
  rows: readonly T[],
  priority: RoutePriority,
  ctx: PriorityContext,
): PriorityOrder<T> {
  if (rows.length < 2) {
    return {
      rows: [...rows],
      moved: false,
      capUnmet:
        priority === "comfort" &&
        rows.length === 1 &&
        !meetsComfortCap(rows[0].plan, ctx.spec, ctx.match),
    };
  }

  const match = ctx.match ?? {};
  const fleet = ctx.fleet ?? null;
  const measured: Measured<T>[] = rows.map((row, index) => ({
    row,
    index,
    plan: row.plan,
    cents: row.plan.estimatedCents,
    totalSeconds: row.plan.totalSeconds,
    handOffs: row.plan.handOffs,
    walk: walkSeconds(row.plan),
    nonIdeal: nonIdealShare(row.plan, ctx.spec, match),
    comfortOk: meetsComfortCap(row.plan, ctx.spec, match),
    equity: equityShare(row.plan),
    company:
      priority === "flexibility"
        ? swapCompany(row.plan, fleet, ctx.spec, match)
        : null,
  }));

  const cheapest = Math.min(...measured.map((m) => m.cents));
  const compare = byPriority<T>(priority, cheapest);
  // `Array#sort` is stable by specification, so equal elements keep the order
  // `rankPlans` gave them and no index tiebreak is needed. One was here, and
  // no mutation of it could fail a test — a line that cannot be wrong is a
  // line that cannot be right either, and it read as load-bearing.
  measured.sort(compare);

  return {
    rows: measured.map((m) => m.row),
    moved: measured.some((m, position) => m.index !== position),
    capUnmet: priority === "comfort" && measured.every((m) => !m.comfortOk),
  };
}

/** What to say above a list this preference ordered, or null.
 *
 *  SAID ONLY WHEN IT DID SOMETHING. A standing explanation of a preference
 *  that changed nothing is a line riders learn to skip, and then miss on the
 *  day it matters — `idealSplitNote`'s rule, kept.
 *
 *  The unmet cap is the exception: it is said whether or not the order moved,
 *  because it is not about the ordering. It is the app telling a rider that
 *  what they asked for was not available, which is owed either way. */
export function routePriorityNote(
  order: Pick<PriorityOrder<never>, "moved" | "capUnmet">,
  priority: RoutePriority,
  hasSpec: boolean,
): string | null {
  if (priority === "comfort" && order.capUnmet && hasSpec) {
    return (
      "Every plan here puts more than a quarter of the riding on a scooter " +
      "that is not your ideal one. These are the closest we found."
    );
  }
  if (!order.moved) return null;
  switch (priority) {
    case "comfort":
      return hasSpec
        ? "Sorted to keep you on your ideal scooter for as much of the ride as possible."
        : null;
    case "savings":
      return "Sorted for the Equity Area discount — a swap inside an area earns it on both legs.";
    case "flexibility":
      return hasSpec
        ? "Sorted to swap where other scooters you'd accept are standing."
        : null;
    case "simplicity":
      return "Sorted for the fewest hand-offs and the least walking.";
  }
}
