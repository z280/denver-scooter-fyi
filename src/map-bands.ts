// The map's stacking order for AREAS, made explicit.
//
// Every area layer used to insert itself "just under the scooters"
// (FIRST_DEVICE_LAYER), which made the stacking order an accident of WHEN
// each layer was first created: territory hexes, created the moment
// someone switched Territory Control on, landed on top of the city's
// no-parking zones and the equity areas that had loaded at startup. What a
// rider saw on top was therefore not what mattered most.
//
// The order is a decision, so it lives here. Bottom to top:
//
//   shading  — territory / hex metrics, the region choropleth and boundary
//              overlays: context about an AREA's numbers
//   equity   — the city's Equity Areas: a price a rider is owed
//   zones    — the city's slow / no-parking / no-riding zones: a rule a
//              rider can break
//
// and the scooters (and every pin, route and trail drawn above them) stay
// on top of all three. The triple-tap inspector (map-inspect.ts) answers in
// the same order, so the thing that explains itself is the thing on top.
//
// Each band is held open by an invisible anchor layer; a module adds its
// layers `before` its band's anchor, which puts them at the top of that
// band whenever they are created. Anchors are `background` layers with
// visibility "none": they draw nothing and cost no pass.

import type { Map as MLMap } from "maplibre-gl";
import { FIRST_DEVICE_LAYER } from "./devices.ts";

export type MapBand = "shading" | "equity" | "zones";

/** Bottom to top. */
export const MAP_BANDS: readonly MapBand[] = ["shading", "equity", "zones"];

export const BAND_ANCHOR: Record<MapBand, string> = {
  shading: "band-anchor-shading",
  equity: "band-anchor-equity",
  zones: "band-anchor-zones",
};

/** The id to pass as `before` when adding a layer that belongs to `band`.
 *
 *  Creates the three anchors on first use, in order, just under the
 *  scooters (or at the top of the stack if the device layers do not exist
 *  yet; they are added later, above them). A map without `getLayer` (the
 *  unit tests' minimal fakes) gets the old behaviour: FIRST_DEVICE_LAYER. */
export function bandBefore(map: MLMap, band: MapBand): string {
  const m = map as Partial<MLMap>;
  if (typeof m.getLayer !== "function" || typeof m.addLayer !== "function") {
    return FIRST_DEVICE_LAYER;
  }
  ensureBands(map);
  return BAND_ANCHOR[band];
}

export function ensureBands(map: MLMap): void {
  if (map.getLayer(BAND_ANCHOR.zones)) return;
  const under = map.getLayer(FIRST_DEVICE_LAYER) ? FIRST_DEVICE_LAYER : undefined;
  for (const band of MAP_BANDS) {
    if (map.getLayer(BAND_ANCHOR[band])) continue;
    map.addLayer(
      {
        id: BAND_ANCHOR[band],
        type: "background",
        layout: { visibility: "none" },
        paint: { "background-opacity": 0 },
      },
      under,
    );
  }
}

/** The style index of the topmost anchor, or -1. Anything drawn ABOVE it
 *  (scooters, pins, routes) is not an area, and a tap that lands on one is
 *  that thing's business, not the inspector's. */
export function topAnchorIndex(map: MLMap): number {
  return layerOrder(map).indexOf(BAND_ANCHOR.zones);
}

/** Layer ids bottom to top. `getLayersOrder` where the map has it: called on
 *  every tap, and `getStyle()` serialises the whole style, GeoJSON included. */
export function layerOrder(map: MLMap): string[] {
  const m = map as Partial<MLMap>;
  if (typeof m.getLayersOrder === "function") return m.getLayersOrder.call(map);
  return (m.getStyle?.call(map)?.layers ?? []).map((l) => l.id);
}
