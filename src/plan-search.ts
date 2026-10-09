// The one place that assembles a `RankPlansContext` and runs the Phase 2
// search. Deps-injected so the assembly is testable in node: every field of
// that context is a decision — which fleet, whose position, which rate, how
// many free minutes — and getting one wrong changes the plans a rider is
// offered without changing anything visible.
//
// IT LIVES HERE AND NOT IN main.ts because main.ts is where that kind of
// decision goes unreviewed. Four of these fields have a documented wrong
// answer that main.ts has no way to assert against:
//
//   * THE FLEET IS UNFILTERED. `rankPlans`'s own doc: "feed it the UNFILTERED
//     fleet (`devices.allFeatures()`, never `visibleFeatures()`) — a rider's
//     leftover map filters are a view, not a statement of what they will
//     ride." The spec is what says what they will ride.
//   * FREE MINUTES ARE RESOLVED BEFORE THE CALL, never inside it, and only the
//     Access tier has any. `freeMinutesForPlanning` owns the resolution.
//   * THE TAX RATE IS INJECTED. `ride-cost.ts` holds it as mutable module
//     state, and the server must be using the same figure.
//   * `now` IS PASSED, never defaulted to `Date.now()` inside the search.

import { handOffCap } from "./plan-prefs.ts";
import { routePriority, type FleetPoint } from "./route-priority.ts";
import {
  rankPlans,
  type LngLat,
  type RankPlansContext,
  type RankPlansResult,
} from "./along-the-way.ts";
import type { DeviceProperties } from "./api.ts";
import type { RatePlan } from "./config.ts";
import {
  estimateFreeMinutes,
  freeMinutesForPlanning,
  type FreeMinuteEstimate,
  type RideSpan,
} from "./free-minutes.ts";
import type { TripPlace } from "./pending-trip.ts";
import { planListView, type PlanListView } from "./plan-list.ts";
import type { SpecField } from "./ride-spec.ts";
import type { RideSpec } from "./ride-spec.ts";

export type FleetFeature = GeoJSON.Feature<GeoJSON.Point, DeviceProperties>;

export interface PlanSearchDeps {
  /** `devices.allFeatures()`. See the header: never the filtered view. */
  fleet(): readonly FleetFeature[];
  /** Where the rider is. Null when there is no GPS fix. */
  origin(): LngLat | null;
  /** The rider's "ideal scooter", or the default sheet. */
  spec(): RideSpec;
  /** One line naming what the rider's interview answer did to this search, or
   *  null. Optional: a host that never asks the interview has nothing to say,
   *  and this module neither knows nor cares what the question was. */
  interviewNote?(relaxed: readonly SpecField[]): string | null;
  /** The rider's ideal scooter in one line, for the "proceed with this?" row,
   *  or null when there is nothing to confirm. */
  idealSpecSummary?(): string | null;
  /** Whether that sheet is in force for this search. Absent reads as true,
   *  which is what every caller before the control existed meant. */
  idealSpecInUse?(): boolean;
  /** The same spec, but NULL when the rider has not configured one.
   *
   *  A second accessor rather than a nullable `spec()`, because the two
   *  questions genuinely differ. The SEARCH wants a sheet to match against and
   *  the default one is the right answer for a rider who has set nothing — it
   *  means "anything goes". The VIEW wants to know whether there is a
   *  preference at all: a share computed against a spec that requires nothing
   *  is 100% for every vehicle in the city, which is an empty opinion dressed
   *  up as agreement, and the prompt to set one up must not appear to somebody
   *  who already did.
   *
   *  Optional, so a caller that has no notion of a configured spec — tests,
   *  and anything predating the preference — behaves exactly as before. */
  activeSpec?(): RideSpec | null;
  /** Whether the rider HAS a sheet, regardless of whether it is in force for
   *  this search. `activeSpec` goes null when they stand it down, and the
   *  offer to set one up must not appear to somebody who has one and simply
   *  turned it off. Absent reads as "the one in `activeSpec` is all there
   *  is", which is what every caller before this existed meant. */
  hasSavedSpec?(): boolean;
  rate(): RatePlan;
  taxRate(): number;
  now(): number;
  /** Vehicle keys the rider has favourited. */
  favorites?(): ReadonlySet<string>;
  /** Today's tracked rides, for the free-minute estimate. Null when signed out
   *  or when the fetch failed — both of which mean "we cannot count", which
   *  `estimateFreeMinutes` answers pessimistically on purpose. */
  rides?(): readonly RideSpan[] | null;
  signedIn?(): boolean;
  /** §2.2's control: "I've got about N free minutes left". */
  riderSaysRemaining?(): number | null;
}

export type PlanSearchOutcome =
  | {
      kind: "ok";
      view: PlanListView;
      result: RankPlansResult;
      /** The free-minute figure this search was priced with, so §2.2's control
       *  can show the rider the SAME number rather than deriving its own. Null
       *  for the four tiers with no free hour, which is also what hides the
       *  control for them. */
      freeMinutes: FreeMinuteEstimate | null;
    }
  /** No GPS fix. Reported rather than guessed: a plan list computed from a
   *  wrong origin is four wrong answers, and walking the rider to a scooter
   *  that is not near them is the one failure this surface can cause. */
  | { kind: "no_fix" };

/** Resolve the free-minute balance the search takes.
 *
 *  ONLY THE ACCESS TIER HAS ONE, so nothing is fetched or counted for the other
 *  four — `searchOnce`'s `freeBudget` is 0 for them regardless, and asking a
 *  signed-out Resident's tracked rides to justify a zero is work with no
 *  consequence. Exported because the §2.2 control needs to show the same figure
 *  the planner used, and a second derivation is a second answer. */
export function planningFreeMinuteEstimate(
  deps: PlanSearchDeps,
  rate: RatePlan,
): FreeMinuteEstimate | null {
  if (rate.key !== "equity") return null;
  return estimateFreeMinutes({
    rides: deps.rides?.() ?? null,
    nowMs: deps.now(),
    riderSaysRemaining: deps.riderSaysRemaining?.() ?? null,
    signedIn: deps.signedIn?.() ?? false,
  });
}

export function planningFreeMinutes(deps: PlanSearchDeps, rate: RatePlan): number {
  const estimate = planningFreeMinuteEstimate(deps, rate);
  return estimate === null ? 0 : freeMinutesForPlanning(estimate);
}

export function buildContext(
  deps: PlanSearchDeps,
  from: LngLat,
  dest: TripPlace,
): RankPlansContext {
  const rate = deps.rate();
  return {
    from,
    to: { lat: dest.lat, lon: dest.lon },
    spec: deps.spec(),
    rate,
    freeMinutesLeft: planningFreeMinutes(deps, rate),
    taxRate: deps.taxRate(),
    now: deps.now(),
    ...(deps.favorites ? { favorites: deps.favorites() } : {}),
    // NO `inRide`, which is correct for an initial search and WRONG for a
    // re-solve — and the difference is not cosmetic. With it, the search gains
    // §6.2's continuation edge ("keep riding what you have", priced with no
    // unlock because it is already paid) and bounds that edge by the vehicle's
    // remaining range. Without it, a mid-ride search charges the rider a second
    // unlock for the scooter they are sitting on and systematically prefers
    // handing off, because carrying on is not in the graph to lose.
    //
    // This surface only opens from the home bar's "need wheels", which is a
    // rider who is not on a scooter, so omitting it is right today. It is
    // recorded here rather than left to be inferred because the fix is not
    // "pass the field": `InRideState` wants a free-minute BASELINE from before
    // the rental began, and §3.2's re-solve is where that lives.
  };
}

/** The fleet as bare points, for `route-priority.ts`'s Flexibility count.
 *
 *  A projection and not a pass-through: that module is pure and knows nothing
 *  about GeoJSON, and handing it the features would make the shape of our
 *  feed its problem. Features without coordinates are dropped rather than
 *  defaulted to (0, 0), which would plant a scooter in the Atlantic and count
 *  it as company for every swap on earth. */
function fleetPoints(feats: readonly FleetFeature[]): FleetPoint[] {
  const out: FleetPoint[] = [];
  for (const f of feats) {
    const c = f.geometry?.coordinates;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    if (!f.properties) continue;
    out.push({ properties: f.properties, lat: c[1], lon: c[0] });
  }
  return out;
}

/** Search, and shape the result into §2.4's rows. */
export function searchPlans(
  deps: PlanSearchDeps,
  dest: TripPlace,
): PlanSearchOutcome {
  const from = deps.origin();
  if (!from) return { kind: "no_fix" };
  const ctx = buildContext(deps, from, dest);
  const feats = [...deps.fleet()];
  const result = rankPlans(feats, ctx);
  const freeMinutes = planningFreeMinuteEstimate(deps, ctx.rate);
  return {
    kind: "ok",
    result,
    freeMinutes,
    view: planListView({
      result,
      rate: ctx.rate,
      destinationLabel: dest.label,
      freeMinutes,
      // Read at search time rather than captured, so a rider who changes
      // either of these in the drawer and comes back gets the list they just
      // asked for.
      handOffCap: handOffCap(),
      // The host writes this: only it knows what the rider was asked and what
      // they answered. Absent in a caller that never ran the interview, which
      // reads as "nothing to say".
      interviewNote: deps.interviewNote?.(result.relaxed) ?? null,
      idealSpecSummary: deps.idealSpecSummary?.() ?? null,
      idealSpecInUse: deps.idealSpecInUse?.() ?? true,
      spec: deps.activeSpec ? deps.activeSpec() : null,
      hasSpec: deps.hasSavedSpec?.(),
      // The SAME context the search matched with, so the share and the filter
      // cannot disagree about the same vehicle.
      matchContext: { dest: { lat: dest.lat, lon: dest.lon } },
      routePriority: routePriority(),
      // The SAME fleet the search ran on, so Flexibility's count of what is
      // standing at a swap cannot disagree with the plan that chose it.
      fleet: fleetPoints(feats),
    }),
  };
}
