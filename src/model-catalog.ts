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
