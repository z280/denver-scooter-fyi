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
import type { RatePlan } from "./config.ts";
import {
  equityDisclosures,
  hasEquityLeg,
  startInAreaSaving,
  type EquityDisclosure,
  type StartInAreaSaving,
} from "./equity-savings.ts";
import { formatCents } from "./ride-cost.ts";
import type { SpecField } from "./ride-spec.ts";
import { vehicleDisplayName } from "./vehicle-name.ts";

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
  kind: "equity_saving" | "hand_off" | "risk" | "free_minutes";
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
  /** This row IS the walk-only plan. The surface treats it differently — there
   *  is no vehicle to claim and no cost to show. */
  isWalkOnly: boolean;
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
 *  it from a GBFS lookup needing a GPS fix and a reachable feed. This module is
 *  pure and has neither. `plate_suffix` IS on the payload and
 *  `vehicleDisplayName` prefers it over a derived suffix anyway, so nothing is
 *  lost but the dependency. */
function legVehicleName(leg: TripLeg): string | null {
  const v = leg.vehicle;
  if (!v) return null;
  return vehicleDisplayName(v.public_name, null, v.vehicle_model_name, v.plate_suffix);
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
): PlanChip[] {
  const chips: PlanChip[] = [];
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
    chips.push({ kind: "risk", text: "Flagged — may not unlock" });
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
  const destinationLabel = input.destinationLabel ?? null;
  const baseline = savingBaseline(result);

  const rows = result.plans.map((plan): PlanRow => {
    const saving = baseline ? startInAreaSaving(plan, baseline, rate) : null;
    const first = rideLegs(plan)[0];
    const isWalkOnly = plan === result.walkOnly;
    return {
      plan,
      headline: planHeadline(plan),
      minutesLabel: `${minutes(plan.totalSeconds)} min`,
      costLabel: formatCents(plan.estimatedCents),
      legLines: planLegLines(plan, destinationLabel),
      chips: chipsFor(plan, saving),
      disclosures: equityDisclosures(plan, rate, saving),
      saving,
      firstVehicle: first?.vehicle ?? null,
      isWalkOnly,
    };
  });

  return {
    rows,
    estimateNote: ESTIMATE_NOTE,
    relaxedLabels: result.relaxed.map((f) => RELAXED_FIELD_LABEL[f]),
    capRelaxed: result.capRelaxed,
    riskWarning: result.riskTierOffered ? RISK_WARNING : null,
  };
}
