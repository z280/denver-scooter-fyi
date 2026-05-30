import maplibregl, { type Map as MLMap, type LngLatLike } from "maplibre-gl";
import type { DevicesResponse } from "./api.ts";

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
    for (const i of indices) {
      sumLng += lngs[i];
      sumLat += lats[i];
    }
    out.push({
      count: indices.length,
      lng: sumLng / indices.length,
      lat: sumLat / indices.length,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

export class Clusters {
  private features: DevicesResponse["features"] = [];
  private minCount: number;
  private popup: maplibregl.Popup | null = null;

  constructor(
    private readonly map: MLMap,
    private readonly listEl: HTMLElement,
    private readonly minInput: HTMLInputElement,
  ) {
    this.minCount = Math.max(2, parseInt(this.minInput.value, 10) || 15);
    this.minInput.addEventListener("change", () => {
      const v = parseInt(this.minInput.value, 10);
      if (!Number.isFinite(v) || v < 2) return;
      this.minCount = v;
      this.render();
    });
  }

  update(features: DevicesResponse["features"]): void {
    this.features = features;
    this.render();
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

      const meta = document.createElement("span");
      meta.className = "cluster-item__meta";
      meta.textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;

      btn.append(count, meta);
      btn.addEventListener("click", () => this.go(c));
      li.append(btn);
      this.listEl.append(li);
    }
  }

  private go(c: FoundCluster): void {
    const center: LngLatLike = [c.lng, c.lat];
    // On desktop, shift the cluster right so the controls panel doesn't cover
    // it. On mobile the panel is a bottom sheet, so no horizontal shift.
    const isMobile = window.matchMedia("(max-width: 640px)").matches;
    this.map.easeTo({
      center,
      zoom: 19,
      duration: 700,
      padding: isMobile ? undefined : { left: 320, top: 0, right: 0, bottom: 0 },
    });
    if (this.popup) this.popup.remove();

    const root = document.createElement("div");
    root.className = "cluster-popup";

    const countEl = document.createElement("div");
    countEl.className = "cluster-popup__count";
    countEl.textContent = `${c.count} scooters here`;

    const link = document.createElement("a");
    link.className = "cluster-popup__link";
    link.href = `https://www.google.com/maps?q=${c.lat},${c.lng}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open in Maps ↗";

    root.append(countEl, link);

    this.popup = new maplibregl.Popup({ closeButton: true, offset: 14 })
      .setLngLat(center)
      .setDOMContent(root)
      .addTo(this.map);
  }
}
