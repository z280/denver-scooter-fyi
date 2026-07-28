// Saved map-filter sets: serialize exactly what the Filters drawer owns —
// nothing else — to localStorage, with Save/Load controls in that drawer.
// main.ts supplies the state access (snapshot/apply/suggestName); this
// module owns storage and the drawer UI.

import type { BoundaryLayer } from "./api.ts";
import type { ModelKey, QualityFilter, RideType } from "./devices.ts";

/** One saved filter set. `area` stores only the display selection
 *  (layer + subset) — polygons are re-resolved on load, because the live
 *  AreaFilterState carries computed geometry that must not be serialized. */
export interface FilterPreset {
  name: string;
  rideTypes: RideType[];
  models: ModelKey[];
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
const MODEL_KEYS: readonly string[] = ["astro", "cosmo", "apollo"];
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
