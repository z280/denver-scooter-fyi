// Equity-rank estimate + overlay. The city gave us a ranked equity map
// (er1..er6) but never said which ranks bind the SLA, so instead of
// hardcoding one we let users pick a rank set (default 1 + 2). From that
// selection we derive two things:
//   1. a live "% of the fleet inside the selected ranks" estimate, and
//   2. an "Equity Ranking (Selected)" map overlay drawing the union.
//
// Everything is client-side point-in-polygon over the current fleet — no
// server-side SLA average exists for ranks yet (see docs/API_REQUIREMENTS
// §1.3). The estimate is a right-now snapshot, labeled as such.

import type { BoundaryLayer, BoundaryProperties, DevicesResponse } from "./api.ts";
import type { Overlays } from "./overlays.ts";
import { indexFeature, pointInAny, type IndexedFeature } from "./geo.ts";
import {
  EQUITY_RANK_DEFAULT,
  EQUITY_RANK_NUMBERS,
  equityRankLayer,
  type EquityRank,
} from "./config.ts";

const STORAGE_KEY = "scooter_fyi.equity_ranks";

export interface EquityEstimate {
  /** % of the fleet inside the selected ranks' union, or null if no ranks
   *  selected / no devices yet. */
  percent: number | null;
  inside: number;
  total: number;
}

export class EquityRanks {
  private selected = new Set<EquityRank>(loadSelection());
  private overlayVisible = false;
  private polyCache = new Map<BoundaryLayer, IndexedFeature<BoundaryProperties>[]>();
  private lastFeatures: DevicesResponse["features"] = [];
  /** er layers whose boundary fetch 404'd — the API PR that ships er1..er6
   *  may not be deployed yet. Tracked so the UI can say "not published yet"
   *  instead of spinning on "computing…", and so we retry rather than cache
   *  an empty result forever. */
  private unavailable = new Set<BoundaryLayer>();

  constructor(
    private readonly overlays: Overlays,
    /** Fired after any selection/estimate change so the UI can re-render. */
    private readonly onChange: () => void,
  ) {}

  getSelected(): ReadonlySet<EquityRank> {
    return this.selected;
  }

  isOverlayVisible(): boolean {
    return this.overlayVisible;
  }

  /** Toggle one rank. Recomputes the estimate and re-syncs the overlay. */
  async toggleRank(rank: EquityRank, on: boolean): Promise<void> {
    if (on) this.selected.add(rank);
    else this.selected.delete(rank);
    saveSelection(this.selected);
    // Warm the polygon cache for a newly-selected rank so the estimate and
    // overlay have data.
    if (on) await this.ensurePolys(equityRankLayer(rank));
    await this.syncOverlay();
    this.onChange();
  }

  /** Show/hide the union overlay for the currently-selected ranks. */
  async setOverlayVisible(visible: boolean): Promise<void> {
    this.overlayVisible = visible;
    await this.syncOverlay();
  }

  /** Feed the current fleet so the estimate tracks live device counts.
   *  Called from the refresh loop with the unfiltered citywide features. */
  update(features: DevicesResponse["features"]): void {
    this.lastFeatures = features;
    this.onChange();
  }

  /** Current in-app estimate over the last fed fleet. Synchronous: it uses
   *  whatever rank polygons are already cached (selected ranks are warmed
   *  on toggle and at startup), so a just-selected rank with no polygons
   *  yet simply doesn't contribute until its fetch lands + onChange fires. */
  estimate(): EquityEstimate {
    const total = this.lastFeatures.length;
    if (this.selected.size === 0 || total === 0) {
      return { percent: null, inside: 0, total };
    }
    const polys: IndexedFeature<BoundaryProperties>[] = [];
    for (const rank of this.selected) {
      const cached = this.polyCache.get(equityRankLayer(rank));
      if (cached) polys.push(...cached);
    }
    if (polys.length === 0) return { percent: null, inside: 0, total };
    let inside = 0;
    for (const f of this.lastFeatures) {
      const [lng, lat] = f.geometry.coordinates;
      if (pointInAny(lng, lat, polys)) inside += 1;
    }
    return { percent: (inside / total) * 100, inside, total };
  }

  /** True when at least one selected rank's boundary failed to load (the
   *  er1..er6 API endpoints aren't deployed yet). */
  isUnavailable(): boolean {
    for (const rank of this.selected) {
      if (this.unavailable.has(equityRankLayer(rank))) return true;
    }
    return false;
  }

  /** Warm the polygon cache for all initially-selected ranks. Call once at
   *  startup so the first estimate has data. Never rejects — a missing er
   *  endpoint is expected pre-deploy and handled per-layer. */
  async warm(): Promise<void> {
    await Promise.allSettled(
      [...this.selected].map((r) => this.ensurePolys(equityRankLayer(r))),
    );
    this.onChange();
  }

  /** Load + index a layer's polygons, caching on success. On failure (most
   *  likely a 404 before the er endpoints deploy) it records the layer as
   *  unavailable and returns [] WITHOUT caching, so a later call retries. */
  private async ensurePolys(
    layer: BoundaryLayer,
  ): Promise<IndexedFeature<BoundaryProperties>[]> {
    const cached = this.polyCache.get(layer);
    if (cached) return cached;
    try {
      const resp = await this.overlays.loadBoundary(layer);
      const indexed = resp.features.map((f) => indexFeature(f));
      this.polyCache.set(layer, indexed);
      this.unavailable.delete(layer);
      return indexed;
    } catch {
      this.unavailable.add(layer);
      return [];
    }
  }

  /** Reconcile every er layer's outline visibility with (overlayVisible ∧
   *  selected). Runs on toggle, selection change, and overlay show/hide.
   *  Per-layer failures (missing endpoint) are swallowed so one absent rank
   *  can't break the others. */
  private async syncOverlay(): Promise<void> {
    await Promise.allSettled(
      EQUITY_RANK_NUMBERS.map((rank) =>
        this.overlays.toggle(
          equityRankLayer(rank),
          this.overlayVisible && this.selected.has(rank),
        ),
      ),
    );
  }
}

function loadSelection(): EquityRank[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (n): n is EquityRank =>
            typeof n === "number" &&
            (EQUITY_RANK_NUMBERS as readonly number[]).includes(n),
        );
        // An explicitly-empty saved selection is honored; only a
        // missing/corrupt entry falls back to the default.
        if (valid.length > 0 || parsed.length === 0) return valid;
      }
    }
  } catch {
    /* fall through to default */
  }
  return [...EQUITY_RANK_DEFAULT];
}

function saveSelection(sel: Set<EquityRank>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...sel].sort()));
  } catch {
    /* private mode — selection just won't persist */
  }
}
