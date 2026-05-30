import type { BoundaryLayer, BoundaryProperties } from "./api.ts";
import type { Overlays } from "./overlays.ts";
import { indexFeature, type IndexedFeature } from "./geo.ts";
import { prettyRegion } from "./util.ts";

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
   * means show every region of the layer (used for v1/v2 which select all).
   * `display: null` means no overlay is filter-managed right now (main.ts
   * should release whatever it was previously managing).
   */
  display: { layer: BoundaryLayer; subset: string[] | null } | null;
}

/** Layers where any selection means "all regions of that layer". */
const ALL_OR_NOTHING: ReadonlySet<BoundaryLayer> = new Set(["v1", "v2"]);

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
    this.recomputeAndEmit();
  }

  private clearSelection(): void {
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
