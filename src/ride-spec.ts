// YOUR IDEAL SCOOTER.
//
// A spec is what a rider is willing to ride: kind of device, required
// equipment, minimum quality, minimum battery — and, the field that makes it
// a spec rather than a saved filter, which of those are MUST rather than
// PREFER.
//
// WHY THAT DISTINCTION IS THE WHOLE POINT. The Filters drawer already lets a
// rider narrow the map by every one of these. But a filter HIDES: it decides
// what is drawn, it is changed a dozen times while somebody pokes around, and
// it lives in localStorage on one phone. A spec DISQUALIFIES AND RANKS: it
// decides what the app will walk you to, it is saved to the account, and when
// nothing matches it is relaxed — in a published order — rather than
// returning an empty list. Fusing the two would mean narrowing the map to
// look at something quietly changes what the app walks you to two minutes
// later. So they are two objects with a one-tap bridge (`toFilterSnapshot` /
// `fromFilterSnapshot` below), and `filter-presets.ts` is untouched.
//
// PURE. No DOM, no network, no map, and — deliberately — no import of
// `devices.ts`, which would drag maplibre into a module whose whole job is to
// be testable without one. The model and posture facts it needs live in
// `model-catalog.ts` for exactly that reason.
//
// UNKNOWN NEVER SATISFIES A REQUIREMENT. The API serializes a feature nobody
// has confirmed as `null`, a model it cannot name as absent, and a battery it
// cannot compute as missing. All three read as "does not match" against a
// positive requirement, because the alternative is telling a rider a scooter
// has a basket on the strength of nobody having looked. The UI copy has to
// say so too: "confirmed to have a basket", never "has a basket".
//
// The one apparent exception is `mustReach`, and it is not an exception —
// see `matches` below.

import type { DeviceProperties } from "./api.ts";
import type { QualityFilter } from "./devices.ts";
import type { FilterSnapshot } from "./filter-presets.ts";
import {
  FEATURE_FILTER_KEYS,
  matchesFeatureFilter,
  type FeatureFilterKey,
} from "./device-features.ts";
import {
  ALL_MODELS,
  RIDE_TYPE_BY_MODEL,
  modelKeyOf,
  type ModelKey,
  type RideType,
} from "./model-catalog.ts";
import { canReach } from "./reach.ts";

/** The requirements a vehicle can be judged against, and therefore the
 *  things that can be marked `must` or reported as unmet.
 *
 *  `maxWalkMinutes` is deliberately NOT one: it is a fact about the trip, not
 *  about the vehicle, and cannot be answered from a device's properties. It
 *  belongs to the search (and is clamped there against
 *  `DIBS_MAX_WALK_MINUTES`, since a candidate further than that cannot
 *  legally be claimed). */
export type SpecField =
  | "models"
  | "features"
  | "min_battery"
  | "min_quality"
  | "must_reach";

export const SPEC_FIELDS: readonly SpecField[] = [
  "models",
  "features",
  "min_battery",
  "min_quality",
  "must_reach",
];

export interface RideSpec {
  /** Recognized models the rider will take. `null` means any — which is not
   *  the same as listing all four, because a model that joins the fleet later
   *  is included by `null` and excluded by an exhaustive list. */
  models: ModelKey[] | null;
  /** Equipment that must be CONFIRMED present. Same vocabulary and same
   *  semantics as the Filters drawer's Features section — `matchesFeatureFilter`
   *  is shared rather than reimplemented, so the two can't drift on what
   *  "has a bell" means. */
  features: FeatureFilterKey[];
  /** Percent. 0 = no floor. */
  minBattery: number;
  minQuality: QualityFilter;
  /** "Only ones that can get me there." A claim about a specific trip, so it
   *  does nothing until a destination exists. */
  mustReach: boolean;
  /** How far the rider will walk to the vehicle. Not a `SpecField`; see
   *  above. */
  maxWalkMinutes: number;
  /** Which requirements are HARD. Everything else is a preference: it moves
   *  the ranking and is given up, in `relaxationLadder`'s order, before the
   *  app reports that nothing matches. */
  must: SpecField[];
}

/** Twelve minutes is inside `DIBS_MAX_WALK_MINUTES` (15) with room to spare,
 *  so a spec's default never produces a candidate the claim step refuses. */
export const DEFAULT_MAX_WALK_MINUTES = 12;

export const DEFAULT_SPEC: RideSpec = {
  models: null,
  features: [],
  minBattery: 0,
  minQuality: "any",
  mustReach: false,
  maxWalkMinutes: DEFAULT_MAX_WALK_MINUTES,
  must: [],
};

export function defaultSpec(): RideSpec {
  return { ...DEFAULT_SPEC, features: [], must: [] };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface SpecMatch {
  /** Rentable at all. NOT a `SpecField` and never relaxable: a disabled or
   *  in-use vehicle is not a worse candidate, it is not a candidate. */
  available: boolean;
  /** Every requirement this vehicle does not meet, hard and soft alike —
   *  which is what lets a swap card say "no basket (you preferred one)"
   *  instead of just ranking it lower for reasons nobody can see. */
  unmet: SpecField[];
  /** Of those, the ones the rider marked `must`. Non-empty ⇒ disqualified. */
  unmetMust: SpecField[];
  /** The disqualification verdict: available, with no hard requirement
   *  broken. This is what a search filters on. */
  qualifies: boolean;
  /** Nothing at all unmet. What a "perfect match" badge would key off. */
  ideal: boolean;
}

export interface MatchContext {
  /** Where the vehicle is, and where the rider is going. Needed only by
   *  `mustReach`; omitting it makes that requirement pass, because a
   *  destination the rider has not given is not a destination the vehicle
   *  has failed to reach. */
  at?: { lat: number; lng: number };
  dest?: { lat: number; lon: number } | null;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Does this vehicle meet the spec, and if not, exactly which parts fail?
 *
 *  Per-field verdicts rather than a boolean, because three callers need
 *  different slices of the answer: the search filters on `qualifies`, the
 *  ranking penalises each entry in `unmet`, and the UI prints them.
 *
 *  ON `mustReach` AND THE "UNKNOWN NEVER SATISFIES" RULE. A vehicle whose
 *  range the feed never reported passes this requirement, which looks like an
 *  exception and is not. The other requirements are POSITIVE CLAIMS about
 *  equipment — "it has a basket" — and an unconfirmed one must not be
 *  asserted. Reach is a NEGATIVE SCREEN: the question is whether we know the
 *  vehicle cannot make it, and "nobody told us its range" is not that
 *  knowledge. `devices.ts`'s own reach filter draws the line in the same
 *  place, deliberately: hiding working scooters on the strength of a missing
 *  field is a worse error than showing one that turns out to be short.
 */
export function matches(
  props: DeviceProperties,
  spec: RideSpec,
  ctx: MatchContext = {},
): SpecMatch {
  const available = !truthy(props.is_disabled) && !truthy(props.is_reserved);
  const unmet: SpecField[] = [];

  if (spec.models !== null) {
    const key = modelKeyOf(props);
    // Mystery hardware fails a model requirement, and this is the ONE place
    // this module knowingly reads a device differently from the map. The
    // Filters drawer keeps unrecognized models visible when a model is
    // toggled off ("deselecting one model shouldn't silently hide mystery
    // scooters the rider never toggled"), which is right for a hide-filter.
    // A spec is a positive claim — "I want a Cosmo" — and an unnamed vehicle
    // is not a confirmed Cosmo. `toFilterSnapshot` therefore projects onto a
    // map view that is a SUPERSET of what the spec accepts; see its doc.
    if (key === null || !spec.models.includes(key)) unmet.push("models");
  }

  if (spec.features.length > 0) {
    if (!matchesFeatureFilter(props.device_features, new Set(spec.features))) {
      unmet.push("features");
    }
  }

  if (spec.minBattery > 0) {
    const pct = numOrNull(props.battery_percent);
    if (pct === null || pct < spec.minBattery) unmet.push("min_battery");
  }

  if (spec.minQuality !== "any") {
    // The map's own predicate, character for character (devices.ts's
    // `filtered()`): `ok-only` wants exactly "ok"; `no-risk` wants anything
    // that is not "risk", so an absent tier survives it. Two tiers of one
    // question must not disagree about what they mean.
    const tier = props.reliability_tier;
    const ok = spec.minQuality === "ok-only" ? tier === "ok" : tier !== "risk";
    if (!ok) unmet.push("min_quality");
  }

  if (spec.mustReach && ctx.dest && ctx.at) {
    const verdict = canReach({
      rangeMeters: numOrNull(props.current_range_meters),
      scooter: ctx.at,
      dest: ctx.dest,
    });
    if (verdict === "no") unmet.push("must_reach");
  }

  const hard = new Set(spec.must);
  // `must_reach` is hard whenever it is on, whether or not the rider also
  // listed it in `must` — it is not a preference that can be traded away
  // (see `relaxationLadder`), so listing it there is redundant rather than
  // wrong, and leaving it out does not make it soft.
  const unmetMust = unmet.filter((f) => hard.has(f) || f === "must_reach");

  return {
    available,
    unmet,
    unmetMust,
    qualifies: available && unmetMust.length === 0,
    ideal: available && unmet.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The relaxation ladder
// ---------------------------------------------------------------------------
//
// When nothing matches, the app gives requirements up rather than handing
// back an empty list — but in a FIXED, PUBLISHED order, and it always says
// what it gave up. A search that quietly loosens a rider's requirements is
// one they stop being able to trust; a search that reports "no scooters"
// when it means "none with a basket" is one they stop using.

/** One step down the ladder. `feature` is set only on a features rung, which
 *  drops requirements one at a time rather than all at once. */
export interface Relaxation {
  field: SpecField;
  feature?: FeatureFilterKey;
  /** Rider-facing, and written to complete "…so we also looked at". */
  label: string;
}

/** The order preferred equipment is given up in: least to most costly to go
 *  without. `missing` leads because it is not a rideability property at all
 *  (it selects vehicles nobody has confirmed — a points-hunter's filter, not
 *  a commuter's), then the nicety, then the safety item, then the one that
 *  carries your shopping. */
export const FEATURE_RELAX_ORDER: readonly FeatureFilterKey[] = [
  "missing",
  "cup_holder",
  "bell",
  "basket",
];

const FEATURE_LABEL: Record<FeatureFilterKey, string> = {
  bell: "a bell",
  basket: "a basket",
  cup_holder: "a cup holder",
  missing: "unconfirmed equipment",
};

/** Every relaxation available for this spec, in the order they are applied.
 *
 *  Never included, at any rung: availability, anything in `must`, and
 *  `mustReach`. A vehicle that cannot reach the destination is not a worse
 *  candidate, it is not a candidate — trading that away would strand
 *  somebody, which is a different class of failure from disappointing them.
 */
export function relaxationLadder(spec: RideSpec): Relaxation[] {
  const hard = new Set(spec.must);
  const out: Relaxation[] = [];

  // 1. The battery floor, first, because it is the requirement most likely
  //    to be a round number the rider picked rather than a real need.
  if (!hard.has("min_battery") && spec.minBattery > 0) {
    out.push({ field: "min_battery", label: "any charge level" });
  }

  // 2. Preferred equipment, one at a time.
  if (!hard.has("features")) {
    for (const key of FEATURE_RELAX_ORDER) {
      if (spec.features.includes(key)) {
        out.push({ field: "features", feature: key, label: FEATURE_LABEL[key] });
      }
    }
  }

  // 3. The model, widened to the postures the rider actually chose — and no
  //    further. Putting somebody who asked for a seated Rover onto a standing
  //    Astro is not a relaxation, it is a different vehicle, and the ladder
  //    stops before it makes that choice on their behalf.
  if (!hard.has("models") && spec.models !== null) {
    const widened = widenModelsToPosture(spec.models);
    if (widened !== null && widened.length > spec.models.length) {
      out.push({ field: "models", label: describePostures(spec.models) });
    }
  }

  // 4. Quality, last, and only the top rung. `no-risk` is the floor: handing
  //    a rider a vehicle our own signals call high-risk, without asking, is
  //    the one relaxation that can end a trip worse than finding nothing.
  if (!hard.has("min_quality") && spec.minQuality === "ok-only") {
    out.push({ field: "min_quality", label: "anything not flagged high-risk" });
  }

  return out;
}

/** Every recognized model sharing a posture with one of `models`. Returns
 *  null when the input already covers every posture's line-up (nothing to
 *  widen to). */
export function widenModelsToPosture(models: ModelKey[]): ModelKey[] | null {
  const postures = new Set<RideType>(models.map((m) => RIDE_TYPE_BY_MODEL[m]));
  if (postures.size === 0) return null;
  const widened = ALL_MODELS.filter((m) => postures.has(RIDE_TYPE_BY_MODEL[m]));
  return widened.length === models.length ? null : [...widened];
}

function describePostures(models: ModelKey[]): string {
  const postures = new Set<RideType>(models.map((m) => RIDE_TYPE_BY_MODEL[m]));
  if (postures.size === 1) {
    return postures.has("sitting")
      ? "any seated model"
      : "any standing model";
  }
  return "any model";
}

/** The spec with the first `rungs` relaxations applied.
 *
 *  Monotonic by construction: each rung only ever removes a requirement, so
 *  rung n+1 admits every vehicle rung n admits. That property is what makes
 *  it safe for a search to climb until it has enough candidates and then
 *  stop — and it is asserted in the tests, because a ladder that could
 *  narrow would make a search loop forever or, worse, quietly skip a vehicle
 *  it had already accepted.
 */
export function relax(spec: RideSpec, rungs: number): RideSpec {
  const ladder = relaxationLadder(spec);
  let out: RideSpec = { ...spec, features: [...spec.features], must: [...spec.must] };
  for (const step of ladder.slice(0, Math.max(0, rungs))) {
    switch (step.field) {
      case "min_battery":
        out = { ...out, minBattery: 0 };
        break;
      case "features":
        out = {
          ...out,
          features: out.features.filter((f) => f !== step.feature),
        };
        break;
      case "models":
        out = { ...out, models: widenModelsToPosture(out.models ?? []) ?? out.models };
        break;
      case "min_quality":
        out = { ...out, minQuality: "no-risk" };
        break;
      case "must_reach":
        // Unreachable: the ladder never emits this rung. Left explicit so a
        // future edit that DID emit one fails the type check here rather
        // than silently falling through and appearing to work.
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The map bridge
// ---------------------------------------------------------------------------

/** Project a spec onto the map's filter state — "Show only my ideal
 *  scooters".
 *
 *  LOSSY IN TWO STATED DIRECTIONS, and both belong in the UI rather than in
 *  a comment nobody reads:
 *
 *    1. The map can only show or hide, so MUSTS AND PREFERENCES BOTH BECOME
 *       PLAIN FILTERS. That is what the toggle's helper line says, and it is
 *       the difference a rider would otherwise notice and not understand.
 *    2. The result is a SUPERSET of what the spec accepts: a model filter
 *       keeps mystery hardware visible (devices.ts, deliberately), while the
 *       spec rejects it. So a scooter can be on the map under this toggle and
 *       still not be one the trip search would offer.
 *
 *  Map-only state — the area filter and the ride-type toggles — is carried
 *  through from `current` untouched, because a spec has nothing to say about
 *  geography or about a control whose work the model list already does.
 *
 *  `hideUnavailable` is the exception, and is forced ON. Availability is the
 *  one requirement the spec never relaxes, and a view labelled "your ideal
 *  scooters" that includes one somebody is riding is simply a false label.
 */
export function toFilterSnapshot(
  spec: RideSpec,
  current: FilterSnapshot,
): FilterSnapshot {
  return {
    rideTypes: [...current.rideTypes],
    models: spec.models === null ? [...ALL_MODELS] : [...spec.models],
    // Stamped with the CURRENT line-up, always. A snapshot that claimed to
    // know only some of today's models would have every later model default
    // back ON when it was applied (`effectiveModels`) — right for a preset
    // saved last year, wrong for one generated from a spec a moment ago.
    knownModels: [...ALL_MODELS],
    features: [...spec.features],
    hideUnavailable: true,
    minBattery: spec.minBattery,
    quality: spec.minQuality,
    area: current.area,
  };
}

/** Seed a spec from what the rider has set on the map — "Save these as my
 *  ideal scooter".
 *
 *  EVERYTHING COMES BACK AS A PREFERENCE. Defaulting to `must` would put hard
 *  requirements on the rider's behalf that they never stated, and hard
 *  requirements are what make a search come back empty. They promote the ones
 *  that are really non-negotiable in the sheet, which is one tap each and a
 *  decision only they can make.
 *
 *  Three spec fields have no map representation and take their defaults:
 *  `mustReach` (the map's reach filter is a per-trip switch, not part of the
 *  snapshot), `maxWalkMinutes`, and `must` itself. So this is not the inverse
 *  of `toFilterSnapshot` and must not be used as one.
 */
export function fromFilterSnapshot(snap: FilterSnapshot): RideSpec {
  const models = [...snap.models].filter((m): m is ModelKey =>
    (ALL_MODELS as readonly string[]).includes(m),
  );
  const everyModel = ALL_MODELS.every((m) => models.includes(m));
  return {
    ...defaultSpec(),
    models: everyModel ? null : models,
    features: [...(snap.features ?? [])],
    minBattery: snap.minBattery,
    minQuality: snap.quality,
  };
}

// ---------------------------------------------------------------------------
// Reading a stored spec
// ---------------------------------------------------------------------------

/** Structural validation for a blob that arrived from storage.
 *
 *  Needed because the server stores a spec VERBATIM and never looks inside —
 *  which is the right contract (it keeps an API deploy out of the way of
 *  every new requirement) and means the client is the only thing standing
 *  between a corrupt or hand-edited blob and a search that silently accepts
 *  nothing. Unknown members are dropped rather than thrown, the same
 *  discipline `filter-presets.ts` applies to its own storage.
 *
 *  Returns a spec or null; never throws.
 */
export function readSpec(raw: unknown): RideSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const models =
    o.models === null || o.models === undefined
      ? null
      : Array.isArray(o.models)
        ? o.models.filter((m): m is ModelKey =>
            (ALL_MODELS as readonly string[]).includes(m as string),
          )
        : null;

  const features = Array.isArray(o.features)
    ? o.features.filter((f): f is FeatureFilterKey =>
        (FEATURE_FILTER_KEYS as readonly string[]).includes(f as string),
      )
    : [];

  const minBattery =
    typeof o.min_battery === "number" && Number.isFinite(o.min_battery)
      ? Math.min(100, Math.max(0, o.min_battery))
      : 0;

  const minQuality: QualityFilter =
    o.min_quality === "no-risk" || o.min_quality === "ok-only"
      ? o.min_quality
      : "any";

  const maxWalk =
    typeof o.max_walk_minutes === "number" && Number.isFinite(o.max_walk_minutes)
      ? Math.max(1, Math.round(o.max_walk_minutes))
      : DEFAULT_MAX_WALK_MINUTES;

  const must = Array.isArray(o.must)
    ? o.must.filter((f): f is SpecField =>
        (SPEC_FIELDS as readonly string[]).includes(f as string),
      )
    : [];

  return {
    models,
    features,
    minBattery,
    minQuality,
    mustReach: o.must_reach === true,
    maxWalkMinutes: maxWalk,
    must,
  };
}

/** The wire form — snake_case, matching `PUT /api/v1/profile/ride-specs/{name}`
 *  and `POST /api/v1/trip/candidates`. Written out field by field rather than
 *  spread, so a field added to `RideSpec` for local UI state cannot leak into
 *  a stored blob by accident. */
export function writeSpec(spec: RideSpec): Record<string, unknown> {
  return {
    models: spec.models === null ? null : [...spec.models],
    features: [...spec.features],
    min_battery: spec.minBattery,
    min_quality: spec.minQuality,
    must_reach: spec.mustReach,
    max_walk_minutes: spec.maxWalkMinutes,
    must: [...spec.must],
  };
}

/** Does this vehicle even bear asking about? A cheap pre-filter for callers
 *  that only need the verdict. */
export function qualifies(
  props: DeviceProperties,
  spec: RideSpec,
  ctx: MatchContext = {},
): boolean {
  return matches(props, spec, ctx).qualifies;
}
