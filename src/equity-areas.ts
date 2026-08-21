// The city's official Equity Area map — one map, no longer a question.
//
// Denver spent the contract's first year not saying which polygon the Veo
// license agreement's Equity Area language meant. This app hedged the way
// you do when the answer matters and nobody will give it: it drew the two
// candidate "Disadvantaged Areas" versions (v1, v2) and let riders pick
// among DOTI's six ranked equity tiers (er1..er6) to estimate against.
// In August 2026 the city named the map. That map is this file.
//
// So the old surfaces are gone from the UI — see config.ts's
// RETIRED_OVERLAYS for why they are retired rather than deleted — and
// everything that asks "is this point in an equity area?" now asks here.
// One answer, in one place, for the overlay, the on-screen indicator, and
// the ride HUD's start/end flags.
//
// WHY THE GEOMETRY IS BUNDLED, NOT FETCHED --------------------------------
// The API serves the same polygons at /api/v1/boundaries/equity, and this
// could have loaded them from there like every other overlay. It doesn't,
// for two reasons:
//
//   1. The er1..er6 experience is the cautionary tale. Those layers shipped
//      in the frontend before the endpoint existed, so the estimator spent
//      weeks rendering "boundaries aren't published yet" at riders who had
//      no idea what that meant. A rider standing in an equity area should
//      not be told the discount is unavailable because a deploy is ordered
//      wrong.
//   2. The indicator makes a claim about MONEY — that a ride here should
//      cost $0.13/min. That claim should not be able to disagree with the
//      polygon the compliance numbers are computed against because a CDN
//      served a stale layer. The file here is generated from the same
//      source as the API's data/equity.geojson, geometry-identical, and
//      tests assert the naming matches.
//
// It is a ~190 KB asset fetched once, lazily, on first need — a rider who
// never opens the overlay and never rides never downloads it.

import { indexFeature, pointInAny, type IndexedFeature } from "./geo.ts";

/** Path to the bundled copy of the official map (public/). */
export const EQUITY_AREAS_URL = "/equity-areas.geojson";

/** Purple, distinct from every device color and from the retired overlays'
 *  red/violet — this is a different map, and it should not read as one of
 *  the two it replaced. */
export const EQUITY_AREA_COLOR = "#6a1b9a";

/** Below this zoom the map is showing more city than neighborhood, and
 *  "you are in an equity area" stops being a statement about where the
 *  rider is. Roughly a 12-block view. */
export const EQUITY_INDICATOR_MIN_ZOOM = 13.5;

/** The rider-facing explanation, verbatim as the city's contract terms were
 *  given to us. Exported as a constant because it is quoted in three places
 *  (the indicator's modal, the tests, and the ride summary) and a paraphrase
 *  in any one of them is a different promise. */
export const EQUITY_DISCOUNT_NOTICE =
  "Veo contract with City of Denver says rides that stop or start in this " +
  "area should cost $0.13/min, please screenshot your receipt if you do " +
  "not see this discount!";

/** Short form for the indicator chip itself. */
export const EQUITY_INDICATOR_LABEL = "Equity Area · $0.13/min";

export interface EquityAreaProperties {
  region_name: string;
  region_type: "equity";
  region_category: "equity_areas";
}

export type EquityAreaCollection = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  EquityAreaProperties
>;

let loadPromise: Promise<EquityAreaCollection> | null = null;
let indexed: IndexedFeature<EquityAreaProperties>[] | null = null;

/** Fetch (once) the official map's GeoJSON.
 *
 *  The promise is cached on SUCCESS only: a failed load clears it so the
 *  next caller retries rather than inheriting a rejection forever. A rider
 *  whose first fetch died on a flaky connection should get the indicator
 *  when they pan, not never. */
export function loadEquityAreas(): Promise<EquityAreaCollection> {
  loadPromise ??= fetch(EQUITY_AREAS_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`equity areas: HTTP ${r.status}`);
      return r.json() as Promise<EquityAreaCollection>;
    })
    .then((data) => {
      indexed = data.features.map((f) => indexFeature(f));
      return data;
    })
    .catch((err) => {
      loadPromise = null;
      throw err;
    });
  return loadPromise;
}

/** The indexed polygons, or null if the map hasn't finished loading.
 *  Synchronous by design — the callers that need it (a map `move` handler,
 *  a HUD tick) run far more often than the load, and awaiting inside them
 *  would make every frame a microtask. */
export function equityAreaIndex(): IndexedFeature<EquityAreaProperties>[] | null {
  return indexed;
}

/** Load-and-index, for callers that can wait (the ride HUD's start/end
 *  flags, which run twice a ride). */
export async function equityAreaFeatures(): Promise<
  IndexedFeature<EquityAreaProperties>[]
> {
  await loadEquityAreas();
  return indexed ?? [];
}

/** Is (lng, lat) inside an equity area? `null` means "don't know yet" —
 *  the map hasn't loaded — which callers must distinguish from `false`,
 *  since telling a rider they are NOT in an equity area when we simply
 *  haven't looked is worse than saying nothing. */
export function isInEquityArea(lng: number, lat: number): boolean | null {
  if (!indexed) return null;
  return pointInAny(lng, lat, indexed);
}

/** The area containing (lng, lat), or null. Used for the indicator's
 *  "EQ_014" detail line. */
export function equityAreaAt(
  lng: number,
  lat: number,
): EquityAreaProperties | null {
  if (!indexed) return null;
  for (const idx of indexed) {
    if (pointInAny(lng, lat, [idx])) return idx.feature.properties;
  }
  return null;
}

/** "EQ_014" -> "Equity Area 014". Mirrors util.ts's prettyRegion for the
 *  v1/v2 layers this map replaced, so the label reads the same as the one
 *  riders saw before. */
export function prettyEquityArea(regionName: string): string {
  return `Equity Area ${regionName.replace(/^EQ_/, "")}`;
}

/** Reset module state. Test-only — the caches above are deliberately
 *  process-lifetime in the browser. */
export function __resetEquityAreasForTest(): void {
  loadPromise = null;
  indexed = null;
}
