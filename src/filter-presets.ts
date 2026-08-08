// Saved map-filter sets: serialize exactly what the Filters drawer owns —
// nothing else — to localStorage, with Save/Load controls in that drawer.
// main.ts supplies the state access (snapshot/apply/suggestName); this
// module owns storage and the drawer UI.

import type { BoundaryLayer } from "./api.ts";
import type { FeatureFilterKey } from "./device-features.ts";
import type { QualityFilter, RideType } from "./devices.ts";
import { ALL_MODELS, type ModelKey } from "./model-catalog.ts";
import { track } from "./telemetry.ts";

/** One saved filter set. `area` stores only the display selection
 *  (layer + subset) — polygons are re-resolved on load, because the live
 *  AreaFilterState carries computed geometry that must not be serialized. */
export interface FilterPreset {
  name: string;
  rideTypes: RideType[];
  models: ModelKey[];
  /** The model line-up that existed when this preset was SAVED. A stored
   *  `models` array only encodes which of the models the saver could see
   *  were left on — it says nothing about models that joined the fleet
   *  later, and reading their absence as "deselected" is how every pre-Rover
   *  preset silently hid every Rover on the map (the lineup gained `trike`
   *  on 2026-07-30, two days after presets shipped). `effectiveModels`
   *  defaults any model this preset never knew about to ON. Optional
   *  because presets from before this field lack it — those knew exactly
   *  the pre-Rover trio (`LEGACY_KNOWN_MODELS`). */
  knownModels?: ModelKey[];
  /** Optional because presets saved before the Features filter existed
   *  lack it — absent applies as "no selection" (the filter's off state). */
  features?: FeatureFilterKey[];
  hideUnavailable: boolean;
  minBattery: number;
  quality: QualityFilter;
  area: { layer: BoundaryLayer; subset: string[] | null } | null;
}

export type FilterSnapshot = Omit<FilterPreset, "name">;

// Versioned blob so a later schema change can migrate instead of throw.
interface StoredPresets {
  v: 1;
  presets: FilterPreset[];
}

const KEY = "scooter-fyi-filter-presets";

const RIDE_TYPES: readonly string[] = ["standing", "sitting"];
// Derived from the shared catalog, never a second hardcoded list (review
// fix): a copy here that lagged a model addition would reintroduce the
// exact "new model hidden by old preset" bug effectiveModels prevents.
const MODEL_KEYS: readonly string[] = ALL_MODELS;
/** What a preset with no `knownModels` member could possibly have known:
 *  the lineup as it stood before the field existed. `trike` joined on
 *  2026-07-30 and the field shipped later still, so any preset old enough
 *  to lack the field is also old enough to predate the Rover. If a rider
 *  saved a preset in the gap between the two and DID mean to hide Rovers,
 *  applying it now shows them again — one tap to re-hide, against every
 *  older preset permanently hiding a model its saver never heard of. */
const LEGACY_KNOWN_MODELS: readonly ModelKey[] = ["astro", "cosmo", "apollo"];

/** The models a preset actually asks to show: its stored selection, plus
 *  every model that did not exist when it was saved. Absence from `models`
 *  is only a choice for a model the saver could have toggled. */
export function effectiveModels(
  p: Pick<FilterPreset, "models" | "knownModels">,
): Set<ModelKey> {
  const known = new Set<string>(p.knownModels ?? LEGACY_KNOWN_MODELS);
  const want = new Set<ModelKey>(p.models);
  for (const m of ALL_MODELS) {
    if (!known.has(m)) want.add(m);
  }
  return want;
}
const FEATURE_KEYS: readonly string[] = [
  "bell",
  "basket",
  "cup_holder",
  "missing",
];
const QUALITIES: readonly string[] = ["any", "no-risk", "ok-only"];

/** Structural validation — a hand-edited or corrupted blob must not apply
 *  as e.g. "hide every device". Unknown members are dropped, not thrown. */
function isValidPreset(p: FilterPreset): boolean {
  return (
    typeof p?.name === "string" &&
    Array.isArray(p.rideTypes) &&
    p.rideTypes.every((t) => RIDE_TYPES.includes(t)) &&
    Array.isArray(p.models) &&
    p.models.every((m) => MODEL_KEYS.includes(m)) &&
    (p.knownModels === undefined ||
      (Array.isArray(p.knownModels) &&
        p.knownModels.every((m) => MODEL_KEYS.includes(m)))) &&
    (p.features === undefined ||
      (Array.isArray(p.features) &&
        p.features.every((f) => FEATURE_KEYS.includes(f)))) &&
    typeof p.hideUnavailable === "boolean" &&
    typeof p.minBattery === "number" &&
    p.minBattery >= 0 &&
    p.minBattery <= 100 &&
    QUALITIES.includes(p.quality) &&
    (p.area === null ||
      (typeof p.area?.layer === "string" &&
        (p.area.subset === null ||
          (Array.isArray(p.area.subset) &&
            p.area.subset.every((s) => typeof s === "string")))))
  );
}

export function loadPresets(): FilterPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as StoredPresets;
    if (blob?.v !== 1 || !Array.isArray(blob.presets)) return [];
    return blob.presets.filter(isValidPreset);
  } catch {
    return [];
  }
}

function persistPresets(presets: FilterPreset[]): boolean {
  try {
    const blob: StoredPresets = { v: 1, presets };
    localStorage.setItem(KEY, JSON.stringify(blob));
    return true;
  } catch {
    return false; // private mode — nothing sticks, tell the user
  }
}

export interface FilterPresetDeps {
  /** Capture the Filters drawer's current state. */
  snapshot(): FilterSnapshot;
  /** Drive every control to match `s` through its normal event path.
   *  Async: restoring an area selection may fetch boundary polygons. */
  apply(s: FilterSnapshot): Promise<void>;
  /** Suggested preset name, from the shared chip-label helper. */
  suggestName(): string;
}

export function wireFilterPresets(deps: FilterPresetDeps): void {
  const saveBtn = document.getElementById("preset-save") as HTMLButtonElement | null;
  const loadBtn = document.getElementById("preset-load") as HTMLButtonElement | null;
  const panel = document.getElementById("preset-panel");
  if (!saveBtn || !loadBtn || !panel) return;

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // One apply at a time: a second load while an area restore is still in
  // flight would interleave on the AreaFilter's category state.
  let busy = false;

  const note = (text: string, focus?: HTMLButtonElement): void => {
    const p = el("p", "preset-note", text);
    // Announce the outcome — the buttons the user was on get destroyed by
    // this re-render, so a silent swap reads as nothing happening.
    p.setAttribute("role", "status");
    panel.replaceChildren(p);
    focus?.focus();
  };

  // ---- Save: inline name row, prefilled with the suggestion ----
  const renderSave = (): void => {
    const form = el("form", "preset-form");
    const input = el("input", "select");
    input.type = "text";
    input.value = deps.suggestName();
    input.maxLength = 80;
    input.setAttribute("aria-label", "Preset name");
    const confirm = el("button", "login-btn", "Save");
    confirm.type = "submit";
    const cancel = el("button", "text-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => panel.replaceChildren());
    form.append(input, el("div", "preset-form__row"));
    form.lastElementChild?.append(confirm, cancel);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim() || deps.suggestName();
      // Same name replaces — saving twice shouldn't pile up duplicates.
      const rest = loadPresets().filter((p) => p.name !== name);
      const ok = persistPresets([...rest, { name, ...deps.snapshot() }]);
      if (ok) track("filter_preset", { action: "save" });
      note(
        ok ? `Saved “${name}”.` : "Couldn't save — storage is unavailable (private mode?).",
        saveBtn,
      );
    });
    panel.replaceChildren(form);
    input.focus();
    input.select();
  };

  // ---- Load: list of saved sets; tap applies, ✕ deletes ----
  const renderLoad = (): void => {
    const presets = loadPresets();
    if (presets.length === 0) {
      note("No saved filters yet — set up the drawer and hit Save.");
      return;
    }
    const list = el("ul", "preset-list");
    for (const preset of presets) {
      const li = el("li", "preset-item");
      const applyBtn = el("button", "preset-item__apply", preset.name);
      applyBtn.type = "button";
      applyBtn.addEventListener("click", async () => {
        track("filter_preset", { action: "apply" });
        // Area restore is async — hold the whole list disabled until it
        // settles (the busy flag also blocks a fresh list rendered from a
        // re-tap of Load while this apply is in flight).
        if (busy) return;
        busy = true;
        for (const b of list.querySelectorAll("button")) b.disabled = true;
        try {
          await deps.apply(preset);
          note(`Loaded “${preset.name}”.`, loadBtn);
        } catch (e) {
          console.error("preset load failed", e);
          note("Couldn't load that preset — try again.", loadBtn);
        } finally {
          busy = false;
        }
      });
      const del = el("button", "preset-item__delete", "×");
      del.type = "button";
      del.setAttribute("aria-label", `Delete preset ${preset.name}`);
      del.addEventListener("click", () => {
        if (busy) return;
        track("filter_preset", { action: "delete" });
        persistPresets(loadPresets().filter((p) => p.name !== preset.name));
        renderLoad();
        loadBtn.focus(); // the ✕ that had focus is gone with the re-render
      });
      li.append(applyBtn, del);
      list.append(li);
    }
    panel.replaceChildren(list);
  };

  saveBtn.addEventListener("click", () => {
    if (!busy) renderSave();
  });
  loadBtn.addEventListener("click", () => {
    if (!busy) renderLoad();
  });
}
