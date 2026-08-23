import type { BoundaryLayer, BoundaryProperties } from "./api.ts";
import type { Overlays } from "./overlays.ts";
import { indexFeature, type IndexedFeature } from "./geo.ts";
import { prettyRegion } from "./util.ts";
import { track } from "./telemetry.ts";

export interface AreaFilterElements {
  enable: HTMLInputElement; // checkbox
  body: HTMLElement; // shown when enabled
  category: HTMLSelectElement;
  multi: HTMLElement; // wraps the multi-select UI
  search: HTMLInputElement;
  options: HTMLElement; // <ul>
  status: HTMLElement;
  clear: HTMLButtonElement;
}

export interface AreaFilterState {
  /** Indexed polygons to test devices against. null = no area filter active. */
  polygons: IndexedFeature<BoundaryProperties>[] | null;
  /**
   * Overlay to display. `subset` is the list of region_names to show; null
   * means show every region of the layer (used by the equity maps, which
   * select all — see ALL_OR_NOTHING).
   * `display: null` means no overlay is filter-managed right now (main.ts
   * should release whatever it was previously managing).
   */
  display: { layer: BoundaryLayer; subset: string[] | null } | null;
}

/** Layers where any selection means "all regions of that layer".
 *
 *  These are the equity maps, whose regions are ordinally named (EQ_014,
 *  V1_007) and mean nothing to a rider picking from a list — "Equity Area
 *  014" is not a place anyone can locate. Filtering to one of the thirty is
 *  a question nobody asks; filtering to "the equity areas" is the whole
 *  point. v1/v2 stay listed here because the layers still exist even though
 *  the UI no longer offers them (config.ts's RETIRED_OVERLAYS). */
const ALL_OR_NOTHING: ReadonlySet<BoundaryLayer> = new Set(["equity", "v1", "v2"]);

export class AreaFilter {
  private enabled = false;
  private category: BoundaryLayer | null = null;
  private selected = new Set<string>();
  private indexed = new Map<BoundaryLayer, IndexedFeature<BoundaryProperties>[]>();
  private byName = new Map<BoundaryLayer, Map<string, IndexedFeature<BoundaryProperties>>>();

  constructor(
    private readonly overlays: Overlays,
    private readonly el: AreaFilterElements,
    private readonly onChange: (state: AreaFilterState) => void,
  ) {
    this.el.enable.checked = false;
    this.el.body.hidden = true;
    this.el.multi.hidden = true;
    this.el.status.hidden = true;
    this.el.clear.hidden = true;

    this.el.enable.addEventListener("change", () => this.onEnableToggle());
    this.el.category.addEventListener("change", () => this.onCategoryChange());
    this.el.search.addEventListener("input", () => this.applySearch());
    this.el.clear.addEventListener("click", () => this.clearSelection());
  }

  /**
   * Map-click entry point: toggle `regionName` (of `layer`) in the filter,
   * standing up whatever state that requires — enabling the filter and/or
   * switching the category to the clicked layer first. Keeps the drawer's
   * checkboxes in sync so the UI always mirrors what the map shows. For the
   * all-or-nothing layers (v1/v2) there is no per-region toggle; switching
   * to them already selects every region.
   */
  async toggleRegionFromMap(
    layer: BoundaryLayer,
    regionName: string,
  ): Promise<void> {
    if (!this.enabled) {
      this.enabled = true;
      this.el.enable.checked = true;
      this.el.body.hidden = false;
    }
    if (this.category !== layer) {
      this.el.category.value = layer;
      await this.onCategoryChange();
    }
    if (ALL_OR_NOTHING.has(layer)) return;
    for (const cb of this.el.options.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]",
    )) {
      if (cb.value === regionName) {
        cb.checked = !cb.checked;
        this.onOptionToggle(regionName, cb.checked);
        return;
      }
    }
  }

  /**
   * Preset entry point: set the whole selection programmatically — enable
   * state, category, and subset — keeping the drawer's controls in sync,
   * exactly like toggleRegionFromMap does for map clicks. Async because the
   * category's boundary polygons may still need fetching; callers should
   * disable their trigger until this settles. `null` disables the filter.
   */
  async applySelection(
    display: { layer: BoundaryLayer; subset: string[] | null } | null,
  ): Promise<void> {
    if (!display) {
      if (this.enabled || this.el.enable.checked) {
        this.enabled = false;
        this.el.enable.checked = false;
        this.el.body.hidden = true;
        this.emit(null);
      }
      return;
    }
    this.enabled = true;
    this.el.enable.checked = true;
    this.el.body.hidden = false;
    if (this.category !== display.layer) {
      this.el.category.value = display.layer;
      await this.onCategoryChange();
    } else {
      // Same category as last time (e.g. restoring after a reset that only
      // unchecked the enable box): onCategoryChange won't run, so make sure
      // the polygons are resolved before the recompute below.
      await this.ensureIndexed(display.layer);
    }
    // The awaits yield: bail if the user disabled the filter mid-fetch
    // rather than resurrecting a selection they just cleared.
    if (!this.enabled) return;
    if (ALL_OR_NOTHING.has(display.layer) || !display.subset) {
      // Full-layer selection. The changed-category path already emitted in
      // onCategoryChange; the same-category path hasn't — recompute either
      // way (it re-emits the same state, which is idempotent downstream).
      this.recomputeAndEmit();
      return;
    }
    this.selected = new Set();
    for (const cb of this.el.options.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]",
    )) {
      const on = display.subset.includes(cb.value);
      cb.checked = on;
      if (on) this.selected.add(cb.value);
    }
    this.recomputeAndEmit();
  }

  private onEnableToggle(): void {
    this.enabled = this.el.enable.checked;
    this.el.body.hidden = !this.enabled;
    if (!this.enabled) {
      // Disabling the filter releases the managed overlay too. main.ts will
      // see display:null and turn the prior overlay off + clear its subset.
      this.emit(null);
    } else {
      this.recomputeAndEmit();
    }
  }

  private async onCategoryChange(): Promise<void> {
    const value = this.el.category.value as BoundaryLayer | "";
    this.category = value || null;
    this.selected.clear();
    this.el.search.value = "";

    if (!this.category) {
      this.el.multi.hidden = true;
      this.el.status.hidden = true;
      this.el.clear.hidden = true;
      this.emit(null);
      return;
    }

    const indexed = await this.ensureIndexed(this.category);
    // The fetch yielded: the user may have disabled the filter or switched
    // category again while it was in flight — don't emit for a stale state.
    if (!this.enabled || this.category !== value) return;

    if (ALL_OR_NOTHING.has(this.category)) {
      // v1/v2 select every region of that layer in one go.
      this.el.multi.hidden = true;
      this.el.clear.hidden = true;
      this.showStatus(`Filtering to all ${indexed.length} regions.`);
      this.onChange({
        polygons: indexed,
        display: { layer: this.category, subset: null },
      });
    } else {
      this.renderOptions(indexed);
      this.el.multi.hidden = false;
      this.el.clear.hidden = true;
      this.showStatus(`Pick one or more to filter.`);
      // Filter inactive until user picks at least one.
      this.emit(null);
    }
  }

  private async ensureIndexed(
    layer: BoundaryLayer,
  ): Promise<IndexedFeature<BoundaryProperties>[]> {
    const cached = this.indexed.get(layer);
    if (cached) return cached;
    const resp = await this.overlays.loadBoundary(layer);
    const indexed = resp.features.map((f) => indexFeature(f));
    this.indexed.set(layer, indexed);
    const byName = new Map<string, IndexedFeature<BoundaryProperties>>();
    for (const i of indexed) byName.set(i.feature.properties.region_name, i);
    this.byName.set(layer, byName);
    return indexed;
  }

  private renderOptions(items: IndexedFeature<BoundaryProperties>[]): void {
    const layer = this.category;
    if (!layer) return;
    const rows = items
      .map((i) => ({
        name: i.feature.properties.region_name,
        label: prettyRegion(i.feature.properties.region_name, layer),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const li = document.createElement("li");
      const label = document.createElement("label");
      label.className = "area-option";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = r.name;
      cb.dataset.label = r.label;
      cb.addEventListener("change", () => this.onOptionToggle(r.name, cb.checked));
      const text = document.createElement("span");
      text.textContent = r.label;
      label.append(cb, text);
      li.append(label);
      frag.append(li);
    }
    this.el.options.replaceChildren(frag);
  }

  private applySearch(): void {
    const q = this.el.search.value.trim().toLowerCase();
    for (const li of this.el.options.children) {
      const cb = (li as HTMLElement).querySelector(
        "input[type=checkbox]",
      ) as HTMLInputElement | null;
      if (!cb) continue;
      const label = (cb.dataset.label ?? "").toLowerCase();
      (li as HTMLElement).hidden = q.length > 0 && !label.includes(q);
    }
  }

  private onOptionToggle(name: string, on: boolean): void {
    if (on) this.selected.add(name);
    else this.selected.delete(name);
    track("area_filter", { action: "set" });
    this.recomputeAndEmit();
  }

  private clearSelection(): void {
    track("area_filter", { action: "clear" });
    this.selected.clear();
    for (const cb of this.el.options.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]:checked",
    )) {
      cb.checked = false;
    }
    this.recomputeAndEmit();
  }

  private recomputeAndEmit(): void {
    if (!this.enabled || !this.category) {
      this.emit(null);
      return;
    }
    if (ALL_OR_NOTHING.has(this.category)) {
      const indexed = this.indexed.get(this.category) ?? [];
      // v1/v2 show every region of the layer — no subset filter.
      this.onChange({
        polygons: indexed,
        display: { layer: this.category, subset: null },
      });
      return;
    }
    if (this.selected.size === 0) {
      this.showStatus("Pick one or more to filter.");
      this.el.clear.hidden = true;
      this.emit(null);
      return;
    }
    const byName = this.byName.get(this.category);
    if (!byName) return;
    const polys: IndexedFeature<BoundaryProperties>[] = [];
    const subset: string[] = [];
    for (const name of this.selected) {
      const f = byName.get(name);
      if (f) {
        polys.push(f);
        subset.push(name);
      }
    }
    this.showStatus(
      `${this.selected.size} selected — showing devices inside.`,
    );
    this.el.clear.hidden = false;
    this.onChange({
      polygons: polys,
      display: { layer: this.category, subset },
    });
  }

  private emit(polygons: AreaFilterState["polygons"]): void {
    this.onChange({ polygons, display: null });
  }

  private showStatus(text: string): void {
    this.el.status.textContent = text;
    this.el.status.hidden = false;
  }
}
