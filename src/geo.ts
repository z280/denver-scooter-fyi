// Point-in-polygon utilities for client-side area filtering.

type Poly = GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** Boundary feature with a memoized bounding box for fast pre-rejection. */
export interface IndexedFeature<P = GeoJSON.GeoJsonProperties> {
  feature: GeoJSON.Feature<Poly, P>;
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY]
}

export function indexFeature<P>(
  feature: GeoJSON.Feature<Poly, P>,
): IndexedFeature<P> {
  return { feature, bbox: computeBbox(feature.geometry) };
}

export function computeBbox(geom: Poly): [number, number, number, number] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const rings =
    geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  for (const ring of rings) {
    for (const pt of ring as [number, number][]) {
      const x = pt[0];
      const y = pt[1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Is (lng, lat) inside the indexed Polygon/MultiPolygon feature? */
export function pointInFeature<P>(
  lng: number,
  lat: number,
  idx: IndexedFeature<P>,
): boolean {
  const [minX, minY, maxX, maxY] = idx.bbox;
  if (lng < minX || lng > maxX || lat < minY || lat > maxY) return false;

  const geom = idx.feature.geometry;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (poly.length === 0) continue;
    if (!pointInRing(lng, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lng, lat, poly[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Is (lng, lat) inside ANY of the indexed features? */
export function pointInAny<P>(
  lng: number,
  lat: number,
  features: IndexedFeature<P>[],
): boolean {
  for (const f of features) if (pointInFeature(lng, lat, f)) return true;
  return false;
}
