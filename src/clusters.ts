import maplibregl, { type Map as MLMap, type LngLatLike } from "maplibre-gl";
import type {
  BoundaryLayer,
  BoundaryProperties,
  DevicesResponse,
} from "./api.ts";
import type { Overlays } from "./overlays.ts";
import { indexFeature, pointInFeature, type IndexedFeature } from "./geo.ts";
import { prettyRegion } from "./util.ts";

// 30 ft in meters. Tuned for volunteers placing cards on physically-clumped devices.
const EPS_METERS = 9.144;

// Equirectangular meters-per-degree at Denver's latitude is accurate enough at
// the ~10 m scale we cluster at and lets us use squared-distance comparisons.
const DENVER_LAT_RAD = (39.74 * Math.PI) / 180;
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LNG = 111_132 * Math.cos(DENVER_LAT_RAD);

export interface FoundCluster {
  count: number;
  lng: number;
  lat: number;
  // Bounding box of the member devices. Single-link clustering can chain points
  // out well beyond EPS_METERS, so we fit the map to this extent rather than a
  // fixed zoom to guarantee the whole cluster lands on screen.
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** Single-link clustering: connected components of points within EPS_METERS. */
function findClusters(
  features: DevicesResponse["features"],
  minCount: number,
): FoundCluster[] {
  const n = features.length;
  if (n === 0) return [];

  // Sparse grid keyed by cell index, cell size = eps so neighbors fall in own + 8 cells.
  const cellLat = EPS_METERS / M_PER_DEG_LAT;
  const cellLng = EPS_METERS / M_PER_DEG_LNG;
  const cells = new Map<string, number[]>();
  const lngs = new Float64Array(n);
  const lats = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [lng, lat] = features[i].geometry.coordinates;
    lngs[i] = lng;
    lats[i] = lat;
    const key = `${Math.floor(lng / cellLng)},${Math.floor(lat / cellLat)}`;
    let bucket = cells.get(key);
    if (!bucket) cells.set(key, (bucket = []));
    bucket.push(i);
  }

  // Union-find with path compression.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const eps2 = EPS_METERS * EPS_METERS;
  for (let i = 0; i < n; i++) {
    const lng = lngs[i];
    const lat = lats[i];
    const cx = Math.floor(lng / cellLng);
    const cy = Math.floor(lat / cellLat);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const dx_m = (lngs[j] - lng) * M_PER_DEG_LNG;
          const dy_m = (lats[j] - lat) * M_PER_DEG_LAT;
          if (dx_m * dx_m + dy_m * dy_m <= eps2) union(i, j);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }

  const out: FoundCluster[] = [];
  for (const indices of groups.values()) {
    if (indices.length < minCount) continue;
    let sumLng = 0;
    let sumLat = 0;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const i of indices) {
      sumLng += lngs[i];
      sumLat += lats[i];
      if (lngs[i] < minLng) minLng = lngs[i];
      if (lngs[i] > maxLng) maxLng = lngs[i];
      if (lats[i] < minLat) minLat = lats[i];
      if (lats[i] > maxLat) maxLat = lats[i];
    }
    out.push({
      count: indices.length,
      lng: sumLng / indices.length,
      lat: sumLat / indices.length,
      minLng,
      minLat,
      maxLng,
      maxLat,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

export class Clusters {
  private features: DevicesResponse["features"] = [];
  private minCount: number;
  private popup: maplibregl.Popup | null = null;
  private enabled = false;
  // Which boundary layer labels each cluster's location. User-selectable.
  private regionLayer: BoundaryLayer;
  // Point-in-polygon index for the active region layer, plus a per-layer cache
  // so switching back and forth doesn't refetch.
  private regionIndex: IndexedFeature<BoundaryProperties>[] | null = null;
  private indexCache = new Map<
    BoundaryLayer,
    IndexedFeature<BoundaryProperties>[]
  >();

  constructor(
    private readonly map: MLMap,
    private readonly listEl: HTMLElement,
    private readonly minInput: HTMLInputElement,
    private readonly findBtn: HTMLButtonElement,
    private readonly regionSelect: HTMLSelectElement,
    private readonly overlays: Overlays,
  ) {
    this.minCount = Math.max(2, parseInt(this.minInput.value, 10) || 15);
    this.regionLayer = (this.regionSelect.value || "community_network") as BoundaryLayer;
    this.minInput.addEventListener("change", () => {
      const v = parseInt(this.minInput.value, 10);
      if (!Number.isFinite(v) || v < 2) return;
      this.minCount = v;
      if (this.enabled) this.render();
    });
    this.regionSelect.addEventListener("change", () => {
      this.regionLayer = this.regionSelect.value as BoundaryLayer;
      if (this.enabled) void this.applyRegionLayer();
    });
    this.findBtn.addEventListener("click", () => void this.activate());
    this.renderIdle();
  }

  /** Load (and cache) the active region layer's index, then re-render labels. */
  private async applyRegionLayer(): Promise<void> {
    this.regionSelect.disabled = true;
    try {
      await this.ensureRegionIndex();
      if (this.enabled) this.render();
    } catch (e) {
      console.error("region layer load failed", e);
    } finally {
      this.regionSelect.disabled = false;
    }
  }

  private async ensureRegionIndex(): Promise<void> {
    // Capture the target layer up front: the dropdown can change during the
    // await, so reading this.regionLayer afterward could cache the response
    // under the wrong key and label clusters against the wrong boundary.
    const layer = this.regionLayer;
    let idx = this.indexCache.get(layer);
    if (!idx) {
      const resp = await this.overlays.loadBoundary(layer);
      idx = resp.features.map((f) => indexFeature(f));
      this.indexCache.set(layer, idx);
    }
    // Only adopt this index if its layer is still the active selection.
    if (layer === this.regionLayer) this.regionIndex = idx;
  }

  /** Called by main.ts whenever the visible device set changes. */
  update(features: DevicesResponse["features"]): void {
    this.features = features;
    if (this.enabled) this.render();
  }

  private async activate(): Promise<void> {
    this.findBtn.disabled = true;
    try {
      await this.ensureRegionIndex();
      this.enabled = true;
      this.render();
    } catch (e) {
      console.error("cluster activation failed", e);
    } finally {
      this.findBtn.disabled = false;
    }
  }

  private renderIdle(): void {
    this.listEl.replaceChildren();
    const li = document.createElement("li");
    li.className = "cluster-list__empty";
    li.textContent = "Click the search button to find clusters.";
    this.listEl.append(li);
  }

  private render(): void {
    const clusters = findClusters(this.features, this.minCount);
    this.listEl.replaceChildren();

    if (clusters.length === 0) {
      const li = document.createElement("li");
      li.className = "cluster-list__empty";
      li.textContent = `No clusters of ${this.minCount}+ within 30 ft right now.`;
      this.listEl.append(li);
      return;
    }

    for (const c of clusters) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cluster-item";

      const count = document.createElement("span");
      count.className = "cluster-item__count";
      count.textContent = String(c.count);

      const text = document.createElement("span");
      text.className = "cluster-item__text";

      const region = document.createElement("span");
      region.className = "cluster-item__region";
      // Both selectable layers (City Regions, Neighborhoods) tile the whole
      // city, so falling outside every region means it's outside Denver.
      region.textContent = this.regionForPoint(c.lng, c.lat) ?? "Outside Denver";

      const meta = document.createElement("span");
      meta.className = "cluster-item__meta";
      meta.textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;

      text.append(region, meta);
      btn.append(count, text);
      btn.addEventListener("click", () => this.go(c));
      li.append(btn);
      this.listEl.append(li);
    }
  }

  private regionForPoint(lng: number, lat: number): string | null {
    if (!this.regionIndex) return null;
    for (const f of this.regionIndex) {
      if (pointInFeature(lng, lat, f)) {
        return prettyRegion(f.feature.properties.region_name, this.regionLayer);
      }
    }
    return null;
  }

  private go(c: FoundCluster): void {
    const center: LngLatLike = [c.lng, c.lat];
    // Fit to the cluster's actual extent so the whole clump lands on screen,
    // capped at a tight max zoom so a single-spot cluster still zooms right in.
    // On desktop, pad left so the controls panel doesn't cover the cluster; on
    // mobile the panel is a bottom sheet, so pad the bottom instead.
    const isMobile = window.matchMedia("(max-width: 640px)").matches;
    this.map.fitBounds(
      [
        [c.minLng, c.minLat],
        [c.maxLng, c.maxLat],
      ],
      {
        maxZoom: 18,
        duration: 700,
        padding: isMobile
          ? { left: 40, top: 40, right: 40, bottom: 200 }
          : { left: 360, top: 60, right: 60, bottom: 60 },
      },
    );
    if (this.popup) this.popup.remove();

    const root = document.createElement("div");
    root.className = "cluster-popup";

    const countEl = document.createElement("div");
    countEl.className = "cluster-popup__count";
    countEl.textContent = `${c.count} devices here`;
    root.append(countEl);

    const regionName = this.regionForPoint(c.lng, c.lat);
    if (regionName) {
      const reg = document.createElement("div");
      reg.className = "cluster-popup__region";
      reg.textContent = regionName;
      root.append(reg);
    }

    const link = document.createElement("a");
    link.className = "cluster-popup__link";
    link.href = `https://www.google.com/maps?q=${c.lat},${c.lng}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open in Maps ↗";
    root.append(link);

    this.popup = new maplibregl.Popup({ closeButton: true, offset: 14 })
      .setLngLat(center)
      .setDOMContent(root)
      .addTo(this.map);
  }
}
