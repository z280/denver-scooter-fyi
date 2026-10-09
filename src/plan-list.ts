// §2.4 — the plan list. Phase 2 shipped engine-first: `rankPlans` has been
// tested, priced and bounded for a while, and nothing in the app called it.
// This is the derivation half of its first surface — `RankPlansResult` in,
// rows of text in, no DOM — so that every claim the list makes about time,
// money and risk is assertable without a browser.
//
// ---------------------------------------------------------------------------
// WHAT THE LEG STRUCTURE ACTUALLY IS, because the wording depends on it and
// guessing produced the wrong sentence twice.
//
// A plan is `[walk?, ride, ride, …]`. There is at most ONE walk leg, it is
// first, and there is never a walk between two rides — `searchOnce` says so in
// as many words: "a hand-off lands ON the next vehicle: no walk leg between
// them, which is the whole point of the model". There is no trailing walk
// either, because the last ride edge runs to the destination. Two shapes sit
// outside that: the walk-only plan, which is `[walk]` and nothing else, and a
// re-solve's continuation plan, which starts on a ride because the rider is
// already aboard.
//
// So each leg ends somewhere nameable: a walk ends at the first vehicle (or,
// alone, at the destination), and a ride ends at the next ride's vehicle or at
// the destination. That is the whole wording rule.
// ---------------------------------------------------------------------------

import type { RankPlansResult, TripPlan, TripLeg } from "./along-the-way.ts";
import { capNote, capPlans, type HandOffCap } from "./plan-prefs.ts";
import { idealShare, idealShareChip } from "./ideal-share.ts";
import {
  orderByPriority,
  routePriorityNote,
  type FleetPoint,
  type RoutePriority,
} from "./route-priority.ts";
import type { RatePlan } from "./config.ts";
import {
  equityDisclosures,
  hasEquityLeg,
  startInAreaSaving,
  type EquityDisclosure,
  type StartInAreaSaving,
} from "./equity-savings.ts";
import type { FreeMinuteEstimate } from "./free-minutes.ts";
import { freeMinutesCopy, type FreeMinutesCopy } from "./free-minutes-control.ts";
import { formatCents } from "./ride-cost.ts";
import type { MatchContext, RideSpec, SpecField } from "./ride-spec.ts";
import { qualifiedVehicleName } from "./vehicle-name.ts";
import { reportRisk } from "./report-labels.ts";

/** Same vocabulary as the spec sheet's own field labels. Imported in spirit
 *  rather than in code: `ride-spec-panel.ts`'s copy is module-private and
 *  pulling a DOM module in here to borrow a string literal would make this
 *  file untestable in node for no gain. Kept in step by
 *  `plan-list.test.ts`, which asserts the two agree. */
export const RELAXED_FIELD_LABEL: Record<SpecField, string> = {
  models: "Model",
  features: "Equipment",
  min_battery: "Battery",
  min_quality: "Quality",
  must_reach: "Range",
};

/** A chip on a plan row. `kind` is enumerated so a surface can order and style
 *  them without matching on prose — the same rule §8's telemetry props follow,
 *  and for the same reason: free text from a UI is how an address or an amount
 *  ends up somewhere it should not be. */
export interface PlanChip {
  kind: "equity_saving" | "hand_off" | "risk" | "free_minutes" | "ideal_share";
  text: string;
}

export interface PlanLegLine {
  mode: "walk" | "ride";
  /** "Walk 4 min to Lunar 🐸 928" */
  text: string;
  /** Present on ride legs whose vehicle is known. */
  vehicleName?: string;
}

export interface PlanRow {
  plan: TripPlan;
  /** "One scooter", "Two scooters, one hand-off", "Walk the whole way". */
  headline: string;
  /** "17 min". */
  minutesLabel: string;
  /** "$3.50" — every unlock in the plan included, per §2.4. */
  costLabel: string;
  legLines: PlanLegLine[];
  chips: PlanChip[];
  /** §5.2's lines, travelling with the plan. Empty unless it has an equity
   *  leg. */
  disclosures: EquityDisclosure[];
  /** Phase 5a's figures, when there are any. */
  saving: StartInAreaSaving | null;
  /** The vehicle the rider goes to first, for the hand-off into the walk flow.
   *  Null on the walk-only plan, which has nowhere to be taken. */
  firstVehicle: TripLeg["vehicle"] | null;
  /** Fraction of ridden seconds on vehicles that fully meet the rider's spec,
   *  or null when no spec is configured (and so no question). */
  idealShare: number | null;
  /** This row IS the walk-only plan. The surface treats it differently — there
   *  is no vehicle to claim and no cost to show. */
  isWalkOnly: boolean;
  /** The vehicle leg TWO starts on — where the rider swaps — or null on a plan
   *  with no hand-off.
   *
   *  Carried so a surface can offer to go and look at it. The hand-off is the
   *  part of a split plan a rider cannot picture from the text: "park it and
   *  take another" names an action but not a PLACE, and the place is what
   *  decides whether the plan is acceptable. Leg one's vehicle is already
   *  `firstVehicle` and is not a swap — it is the walk the rider is about to
   *  take.
   *
   *  `DeviceProperties` carries no coordinates, so a surface that wants to put
   *  this on a map looks the feature up by `device_id`, exactly as
   *  `takePlanRow` already does for the first vehicle and the hand-off list. */
  switchoverVehicle: TripLeg["vehicle"] | null;
}

export interface PlanListView {
  rows: PlanRow[];
  /** Shown once, above the list, never per row: every figure in the client
   *  tier is an estimate and `TripPlan.isEstimate` is `true` by construction.
   *  Repeating it on four rows trains riders to stop reading it. */
  estimateNote: string;
  /** Requirements given up to find anything at all, in the ladder's own order.
   *  Empty when the rider got exactly what they asked for. */
  relaxedLabels: string[];
  /** The walk cap was stretched to reach a non-risky vehicle (§2.1). A
   *  separate field from `relaxedLabels` because the cap is not a `SpecField`
   *  — `RankPlansResult` draws the same line for the same reason. */
  capRelaxed: boolean;
  /** Some offered plan starts on a `risk`-tier vehicle because nothing better
   *  was within five minutes. Read from the result rather than re-scanned off
   *  the legs, since the warning is conditioned on the fallback having fired,
   *  not on a tier appearing. */
  riskWarning: string | null;
  /** §2.2's control, or null for the four tiers with no free hour.
   *
   *  NULL IS WHAT HIDES IT, and that is the right mechanism rather than a flag
   *  the surface has to remember to check: a tier with no free minutes has
   *  nothing for the rider to correct, and a control offering to adjust a budget
   *  that does not exist invites them to tell us something we will ignore. */
  freeMinutes: FreeMinutesCopy | null;
  /** The rider's hand-off cap removed rows from this list, in their own words,
   *  or null when it did not.
   *
   *  It names the SETTING rather than just the count, because the complaint it
   *  answers is "why am I not being shown the cheap one" and a bare "2 plans
   *  hidden" does not answer it. Null when nothing was hidden, which is the
   *  common case and the default. */
  capNote: string | null;
  /** What the rider's interview answer did to this search, in their terms, or
   *  null. Said BECAUSE the complaint this answers was that the answer
   *  vanished: a rider who is told "showing Cosmos, which is what you asked
   *  for" can see their input arrived. */
  interviewNote: string | null;
  /** The ideal-split preference reordered this list, in the rider's own words,
   *  or null. Said only when it MOVED something: a standing explanation of a
   *  preference that changed nothing is a line riders learn to skip, and then
   *  miss on the day it matters. */
  priorityNote: string | null;
  /** True when no "ideal scooter" is configured. The surface offers to set one
   *  up — a preference about which scooter you get is worth nothing until the
   *  app knows which scooter you want. */
  needsSpec: boolean;
  /** The rider's ideal scooter, when they HAVE one, so the surface can ask
   *  whether to proceed with it instead of silently applying it.
   *
   *  WHY ASKING IS BETTER THAN APPLYING. The sheet is standing state: it was
   *  filled in once and binds every search afterwards. That is right for a
   *  preference and wrong for THIS trip, where a rider in a hurry may happily
   *  take the scruffy scooter they would normally decline — and until they can
   *  see the sheet is in force, a short list reads as an empty city rather than
   *  as their own filter. So it is named, with a way to stand it down for this
   *  search and a way to go and change it.
   *
   *  Null when there is nothing to confirm: either no spec at all (`needsSpec`
   *  covers that) or a spec that asks for nothing, where offering to turn it
   *  off would invent a choice. */
  idealSpec: { summary: string; inUse: boolean } | null;
}

export const ESTIMATE_NOTE =
  "Times and prices are estimates — we cannot see Veo's meter.";

export const RISK_WARNING =
  "Nothing better was within a five-minute walk, so a plan below starts on a " +
  "scooter that has been flagged. It may not unlock.";

/** Whole minutes, rounded up, floored at 1. A 40-second walk is "1 min": the
 *  rider is not served by "0 min", and `along-the-way.ts` keeps its seconds
 *  unrounded precisely so the RANKING is not forced through this. */
function minutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/** "Lunar 🐸 928", through the one naming function the rest of the app uses.
 *
 *  `plate` is passed as null on purpose. The raw plate is not on the public
 *  payload at all (`api.ts` says why: publishing live plates would let Veo
 *  reconcile our map against their fleet), and the callers that have one got
 *  it from a signed-in plate lookup (plates.ts) needing a GPS fix. This module is
 *  pure and has neither. `plate_suffix` IS on the payload and
 *  `vehicleDisplayName` prefers it over a derived suffix anyway, so nothing is
 *  lost but the dependency. */
function legVehicleName(leg: TripLeg, operator?: string | null): string | null {
  const v = leg.vehicle;
  if (!v) return null;
  // TYPE FIRST, name second. On a pavement "which one" is the useful half and
  // `vehicleDisplayName` is right; in a list of PLANS it is not — "Ride Onward
  // 🌳 500 19 min to Liftoff 🍉 167" says nothing about what the rider is
  // being sent to sit on, and whether a leg is standing on an Astro or sitting
  // on a Rover changes "will I take this plan" more than the name does.
  return qualifiedVehicleName({
    publicName: v.public_name,
    modelName: v.vehicle_model_name,
    suffix: v.plate_suffix,
    operator,
  });
}

function rideLegs(plan: TripPlan): TripLeg[] {
  return plan.legs.filter((l) => l.mode === "ride");
}

export function planHeadline(plan: TripPlan): string {
  const rides = rideLegs(plan).length;
  if (rides === 0) return "Walk the whole way";
  if (rides === 1) return "One scooter";
  if (rides === 2) return "Two scooters, one hand-off";
  return `${rides} scooters, ${rides - 1} hand-offs`;
}

/** One line per leg, each naming where that leg ENDS — see the module header
 *  for why that is always answerable. */
export function planLegLines(
  plan: TripPlan,
  destinationLabel: string | null,
): PlanLegLine[] {
  const dest = destinationLabel || "your destination";
  const lines: PlanLegLine[] = [];
  for (let i = 0; i < plan.legs.length; i += 1) {
    const leg = plan.legs[i];
    // Where this leg ends: the next ride's vehicle, or the destination.
    let nextVehicle: string | null = null;
    for (let j = i + 1; j < plan.legs.length; j += 1) {
      if (plan.legs[j].mode === "ride") {
        nextVehicle = legVehicleName(plan.legs[j]);
        break;
      }
    }
    const endsAt = nextVehicle ?? dest;
    const mins = minutes(leg.seconds);
    if (leg.mode === "walk") {
      lines.push({ mode: "walk", text: `Walk ${mins} min to ${endsAt}` });
      continue;
    }
    const name = legVehicleName(leg);
    lines.push({
      mode: "ride",
      text: name
        ? `Ride ${name} ${mins} min to ${endsAt}`
        : `Ride ${mins} min to ${endsAt}`,
      ...(name ? { vehicleName: name } : {}),
    });
  }
  return lines;
}

/** The plan the equity chip's saving is measured against: the best-ranked plan
 *  that rides something and is NOT itself discounted.
 *
 *  THREE THINGS IT MUST NOT BE, each of which produces a wrong number rather
 *  than a missing one:
 *
 *   - another equity plan, which reports the gap between two discounts as the
 *     discount;
 *   - the walk-only plan, which costs nothing, so every equity plan would read
 *     as losing money against it. A saving is a comparison between two ways of
 *     RIDING;
 *   - drawn from the offered four only. The ordinary price of this trip does
 *     not change because a cheaper plan ranked fifth, so `backups` are in
 *     scope. They are the same ranking, cut at `MAX_PLANS`.
 *
 *  `null` when the trip has no undiscounted way to ride it at all — then there
 *  is no saving to name, and §5.2's disclosures travel with the plan anyway. */
export function savingBaseline(result: RankPlansResult): TripPlan | null {
  for (const plan of [...result.plans, ...result.backups]) {
    if (hasEquityLeg(plan)) continue;
    if (rideLegs(plan).length === 0) continue;
    return plan;
  }
  return null;
}

function chipsFor(
  plan: TripPlan,
  saving: StartInAreaSaving | null,
  spec: RideSpec | null,
  ctx: MatchContext,
): PlanChip[] {
  const chips: PlanChip[] = [];
  // How the trip divides between the rider's ideal scooter and the rest. Only
  // on a genuine split — see `idealShareChip` for why all-of-it and none-of-it
  // both say nothing.
  const share = idealShareChip(plan, spec, ctx);
  if (share) chips.push({ kind: "ideal_share", text: share });
  if (saving) {
    const walk =
      saving.extraWalkMinutes > 0
        ? ` · ${saving.extraWalkMinutes} min more walking`
        : "";
    chips.push({
      kind: "equity_saving",
      text: `Starts in an Equity Area · saves ${saving.savingLabel}${walk}`,
    });
  }
  if (plan.handOffs > 0) {
    chips.push({
      kind: "hand_off",
      text:
        plan.handOffs === 1
          ? "One hand-off"
          : `${plan.handOffs} hand-offs`,
    });
  }
  // Read off the legs, unlike the list-level risk warning: this is "the
  // scooter you start on is flagged", which is a property of THIS plan, where
  // `riskTierOffered` is a property of the search having had to fall back.
  const first = rideLegs(plan)[0];
  const tier = first?.vehicle?.reliability_tier;
  if (tier === "risk" || tier === "high_risk") {
    // When a rider report is why, say which — "High risk: reported
    // inaccessible" — rather than a generic flag.
    const report = first?.vehicle ? reportRisk(first.vehicle) : null;
    chips.push({
      kind: "risk",
      text:
        report?.risk === "high_risk"
          ? `High risk: ${report.phrase}`
          : "Flagged — may not unlock",
    });
  }
  const free = plan.legs.reduce((n, l) => n + l.freeMinutesUsed, 0);
  if (free > 0) {
    chips.push({
      kind: "free_minutes",
      text: `Uses ${free} of today's free minutes`,
    });
  }
  return chips;
}

export interface PlanListInput {
  result: RankPlansResult;
  rate: RatePlan;
  /** What the rider typed into the home bar, echoed into the leg wording. */
  destinationLabel?: string | null;
  /** The figure the search was priced with. Passed in rather than derived here,
   *  so the control and the plans cannot disagree about the same hour. */
  freeMinutes?: FreeMinuteEstimate | null;
  /** The rider's hand-off cap. Omitted means no cap, which is the default and
   *  what every caller before this setting existed effectively passed.
   *
   *  Applied HERE rather than inside `rankPlans`, deliberately. The planner's
   *  job is to find and price the ways of getting there; the rider's cap is
   *  about which of them they are willing to be shown. Folding it into the
   *  search would make a preference look like a property of the fleet, and
   *  would silently change `relaxed` and `capRelaxed` — the honesty machinery
   *  that explains what the SEARCH gave up — into something that also covers a
   *  setting the rider could change in two taps. */
  handOffCap?: HandOffCap;
  /** One line naming what the rider's interview answer did to this search, or
   *  null when it did nothing (or was never asked).
   *
   *  PASSED IN AND NOT DERIVED, because this module knows nothing about the
   *  wizard and should not start: it is handed a `spec` that has already been
   *  narrowed, and cannot tell which of the narrowing came from a sheet the
   *  rider filled in months ago and which from a question asked on the way out
   *  of the door. `interview-spec.ts` can, so it writes the sentence and this
   *  only finds it a place to sit. */
  interviewNote?: string | null;
  /** The rider's ideal scooter in one line (`specSummary`), or null/absent when
   *  there is nothing to confirm. Handed in, not composed here. */
  idealSpecSummary?: string | null;
  /** Whether that sheet was actually applied to THIS search. False after the
   *  rider stands it down, which is what lets the surface show the sheet and
   *  its own off-state in the same row. Defaults true, which is what every
   *  caller before the control existed meant. */
  idealSpecInUse?: boolean;
  /** The rider's saved "ideal scooter", or null when they have not made one.
   *  Null is NOT `defaultSpec()`: a share computed against a spec that
   *  requires nothing is 100% for every vehicle in the city, which is an empty
   *  opinion dressed up as agreement. */
  spec?: RideSpec | null;
  /** Whether the rider HAS an ideal scooter, which is not the same question as
   *  whether one is in force for this search.
   *
   *  `spec` answers "what should I score shares against", and goes null the
   *  moment the sheet is stood down. Reading the prompt off that null told a
   *  rider who had made one — and then turned it off for one trip, or simply
   *  never projected it onto the map filters — that they had never made one,
   *  under a button offering to set up the thing they already had.
   *
   *  Defaults to `spec !== null`, which is what every caller predating this
   *  field meant: the sheet they passed was the only one there was. */
  hasSpec?: boolean;
  /** What `matches` needs for `mustReach`. Same object the search used, so the
   *  share cannot disagree with the filter about the same vehicle. */
  matchContext?: MatchContext;
  /** How to break a near-tie on price. Defaults to the cheapest-first
   *  behaviour every caller had before this preference existed. */
  /** Where along the route to swap, and on whose terms.
   *
   *  ABSENT MEANS "NOBODY ASKED", and the planner's own order survives
   *  untouched. Not a default of `comfort`: this is a pure view function, and
   *  a view that silently applies a preference its caller never expressed
   *  cannot be used to test anything else — every assertion about the list
   *  would be entangled with a reordering nobody requested. The real caller
   *  (`plan-search.ts`) always passes the rider's stored answer, so the
   *  absent case is for tests and for callers that predate the preference. */
  routePriority?: RoutePriority;
  /** For Flexibility, which asks whether other scooters the rider would
   *  accept are standing at the swap. Absent is not empty — see
   *  `swapCompany` — so a caller with no fleet to offer leaves it out and
   *  Flexibility falls back to price rather than demoting every plan. */
  fleet?: readonly FleetPoint[] | null;
}

/** Turn a search result into the rows §2.4 describes.
 *
 *  ONE, NOT TWO, IS THE FLOOR. `MAX_PLANS` is a cap and never a quota, and a
 *  valid result can hold only the walk-only plan — an empty fleet, or a fleet
 *  whose every vehicle fails a `must`. So this returns exactly as many rows as
 *  there are plans, and the surface renders what it is given. A list padded to
 *  two either fabricates the second or implies one exists, which is the same
 *  dishonesty as a flagged vehicle shown without its warning. */
export function planListView(input: PlanListInput): PlanListView {
  const { result, rate } = input;
  const spec = input.spec ?? null;
  const hasSpec = input.hasSpec ?? spec !== null;
  const destinationLabel = input.destinationLabel ?? null;
  const baseline = savingBaseline(result);

  const allRows = result.plans.map((plan): PlanRow => {
    const saving = baseline ? startInAreaSaving(plan, baseline, rate) : null;
    const ridden = rideLegs(plan);
    const first = ridden[0];
    // THE PLAN'S OWN SHAPE, not `plan === result.walkOnly`.
    //
    // Identity happens to hold today — `searchOnce` pushes the same object into
    // `complete` and `rankPlans` returns both from the same call — and it is the
    // wrong thing to depend on. Anything that copies or re-wraps a plan on the
    // way out turns this false, and the failure is not that a label goes missing:
    // the panel then renders a "Take this one" button on a row whose
    // `firstVehicle` is null, which is precisely the button-that-goes-nowhere
    // this row exists to avoid. A plan with no ride leg IS the walk, by
    // definition and by any route through the search.
    const isWalkOnly = first === undefined;
    return {
      plan,
      headline: planHeadline(plan),
      minutesLabel: `${minutes(plan.totalSeconds)} min`,
      costLabel: formatCents(plan.estimatedCents),
      legLines: planLegLines(plan, destinationLabel),
      chips: chipsFor(plan, saving, spec, input.matchContext ?? {}),
      disclosures: equityDisclosures(plan, rate, saving),
      saving,
      firstVehicle: first?.vehicle ?? null,
      // Leg TWO's vehicle: where the rider swaps. `?? null` and not `!`,
      // because a one-scooter plan has no second ride leg and the walk-only
      // plan has none at all.
      switchoverVehicle: ridden[1]?.vehicle ?? null,
      idealShare: idealShare(plan, spec, input.matchContext ?? {}),
      isWalkOnly,
    };
  });

  // The cap thins the finished rows rather than the raw plans, so a hidden row
  // is one that was fully priced and explained — which is what lets the note
  // below say how many, and what lets the walk-only row survive any cap by
  // construction rather than by a special case.
  const cap = input.handOffCap ?? null;
  const { kept, hidden } = capPlans(allRows, cap);

  // AFTER the cap, so the preference orders what the rider will actually see
  // rather than a list half of which is about to be removed — otherwise a
  // promoted plan could be hidden a line later and the note would explain a
  // reordering nobody can observe.
  const priority = input.routePriority ?? null;
  const order =
    priority === null
      ? { rows: [...kept], moved: false, capUnmet: false }
      : orderByPriority(kept, priority, {
          spec,
          fleet: input.fleet,
          match: input.matchContext,
        });
  const ordered = order.rows;

  return {
    rows: ordered,
    capNote: capNote(hidden, cap),
    interviewNote: input.interviewNote ?? null,
    priorityNote:
      priority === null ? null : routePriorityNote(order, priority, spec !== null),
    // Asked only when there is a multi-scooter plan on offer. Prompting a
    // rider to configure an ideal scooter on a list of one-scooter plans is
    // asking them to answer a question nothing is about to use.
    needsSpec: !hasSpec && ordered.some((r) => r.plan.handOffs > 0),
    // Only when the rider HAS a sheet and it asks for something — not only
    // while it is in force. The row carries the switch that puts a stood-down
    // sheet back; hiding it the moment the sheet goes off makes turning it off
    // a one-way door. The summary is handed in rather than composed here, for
    // the same reason `interviewNote` is: naming models is not this module's
    // job.
    idealSpec:
      input.idealSpecSummary && hasSpec
        ? { summary: input.idealSpecSummary, inUse: input.idealSpecInUse ?? true }
        : null,
    estimateNote: ESTIMATE_NOTE,
    relaxedLabels: result.relaxed.map((f) => RELAXED_FIELD_LABEL[f]),
    capRelaxed: result.capRelaxed,
    riskWarning: result.riskTierOffered ? RISK_WARNING : null,
    freeMinutes: input.freeMinutes ? freeMinutesCopy(input.freeMinutes) : null,
  };
}
