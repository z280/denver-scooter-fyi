// The recognized Veo model line-up — the single source of truth for model
// keys. Lives in its own dependency-free module so storage/pure modules
// (filter-presets.ts) can share the list with the map layer without
// dragging in devices.ts's maplibre dependency.
//
// The keys are WIRE FORMAT, not copy: they are baked into saved filter
// presets, sprite ids, and the `vehicle_model` field the routing API
// receives ("trike" stays "trike" even though Veo markets it as the
// Rover — see devices.ts's modelKeyOf). Adding a model here is the ONLY
// list edit required for presets to stay forward-compatible: everything
// that validates or iterates model keys derives from this constant.

export type ModelKey = "astro" | "cosmo" | "apollo" | "trike";

export const ALL_MODELS: readonly ModelKey[] = [
  "astro",
  "cosmo",
  "apollo",
  "trike",
];

/** Rider-facing marketing name for each key. This is the copy side of the
 *  key/copy split the module header describes: the WIRE key for the
 *  three-wheeler stays "trike", but every surface that shows a rider a
 *  model name must say "Rover" — capitalizing the raw key was how Rovers
 *  leaked out as "Trike" (and, via a raw-`vehicle_model_name` lookup, as
 *  "Veo Unknown") after the marketing rename. */
export const MODEL_NAMES: Record<ModelKey, string> = {
  astro: "Astro",
  cosmo: "Cosmo",
  apollo: "Apollo",
  trike: "Rover",
};

/** Ride posture, the primary "what am I sitting on" split. Derived from the
 *  server-corrected `vehicle_use_type` with model names as tiebreaker. */
export type RideType = "sitting" | "standing";

export const ALL_RIDE_TYPES: readonly RideType[] = ["sitting", "standing"];

/** Which recognized models serve each ride type — the Astro is the only
 *  standing scooter in the line-up; everything else is seated. Drives the
 *  Filters drawer's ride-type → model sync (main.ts), which exists to keep
 *  the two deliberately-redundant controls from combining into a dead
 *  filter (ride type: seated, model: Astro → nothing shown), and the ride
 *  spec's model-widening rung (ride-spec.ts), which relaxes a model
 *  requirement to "anything you'd sit on the same way". */
export const MODELS_BY_RIDE_TYPE: Record<RideType, readonly ModelKey[]> = {
  standing: ["astro"],
  sitting: ["cosmo", "apollo", "trike"],
};

/** The inverse of MODELS_BY_RIDE_TYPE, derived rather than written out: two
 *  hand-maintained directions of one relationship is how they drift. */
export const RIDE_TYPE_BY_MODEL: Record<ModelKey, RideType> = Object.fromEntries(
  (Object.entries(MODELS_BY_RIDE_TYPE) as [RideType, readonly ModelKey[]][]).flatMap(
    ([type, models]) => models.map((m) => [m, type] as const),
  ),
) as Record<ModelKey, RideType>;

/** Recognized Veo model, or null for mystery hardware. Veo's marketing name
 *  for the three-wheeler is "Rover" — accept it alongside the feed's
 *  historical "trike" spelling, but keep the INTERNAL key "trike": it is
 *  baked into saved filter presets, sprite ids, and the `vehicle_model`
 *  field the routing API receives, so the key is wire format, not copy.
 *
 *  Lives here rather than in devices.ts for the reason the model list does:
 *  ride-spec.ts has to answer "is this a Cosmo?" and must not import the
 *  map layer (and therefore maplibre) to do it. Re-exported from devices.ts
 *  so the existing importers keep one import site. */
export function modelKeyOf(p: {
  vehicle_model_name?: string | null;
}): ModelKey | null {
  const model = (p.vehicle_model_name ?? "").trim().toLowerCase();
  if (model === "rover") return "trike";
  return model === "astro" ||
    model === "cosmo" ||
    model === "apollo" ||
    model === "trike"
    ? (model as ModelKey)
    : null;
}

/** Ride posture for the "Device use" icon style and the ride-type filter:
 *  the server-corrected `vehicle_use_type` decides, with the seated models
 *  (Cosmo, Apollo, Rover) as the tiebreaker when it's absent.
 *
 *  The tiebreaker reads RIDE_TYPE_BY_MODEL rather than re-listing the seated
 *  models inline, which is what it used to do — a third copy of the same
 *  relationship, one `modelKeyOf` away from the two above it. */
export function rideTypeOf(p: {
  vehicle_use_type?: string | null;
  vehicle_model_name?: string | null;
}): RideType {
  if (p.vehicle_use_type === "sitting") return "sitting";
  const key = modelKeyOf(p);
  return key === null ? "standing" : RIDE_TYPE_BY_MODEL[key];
}
