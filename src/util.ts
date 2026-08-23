import type { BoundaryLayer } from "./api.ts";

const denverTimeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Denver",
});

/** ISO timestamp -> "HH:MM" in Denver local time. */
export function denverTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return denverTimeFmt.format(d);
}

/** Group digits with commas: 5873 -> "5,873". */
export function commas(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// Partial: only the layers whose coded region_names actually reach
// prettyRegion (the area-filter list, choropleth, neighborhood search) need
// a prefix. The retired equity ranks er1..er6 were never labeled per-region,
// so they're deliberately absent — an unknown layer just falls through to
// splitCamel on the raw name.
const PREFIXES: Partial<Record<BoundaryLayer, RegExp>> = {
  equity: /^EQ_/,
  v1: /^V1_/,
  v2: /^V2_/,
  neighborhood: /^NB_/,
  council_district: /^CD_/,
  community_network: /^CN_/,
};

/**
 * Turn a coded region_name into a human-readable label.
 *   NB_AthmarPark -> "Athmar Park"
 *   NB_FivePoints -> "Five Points"
 *   CD_3          -> "Council District 3"
 *   CN_Central    -> "Central"
 *   EQ_014        -> "Equity Area 014"
 *   V1_001        -> "Equity Area 001"
 */
export function prettyRegion(name: string, layer: BoundaryLayer): string {
  const prefix = PREFIXES[layer];
  const stripped = prefix ? name.replace(prefix, "") : name;
  switch (layer) {
    case "council_district":
      return `Council District ${stripped}`;
    case "equity":
    case "v1":
    case "v2":
      return `Equity Area ${stripped}`;
    default:
      return splitCamel(stripped);
  }
}

/** "AthmarPark" -> "Athmar Park"; keeps acronyms together. */
export function splitCamel(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

export function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** Convert an H3 cell id from the API's decimal-integer form (kept exact as a
 *  string by parseDevicesResponse) into the canonical hex form h3-js expects.
 *  A value that already contains hex letters is assumed canonical and passed
 *  through unchanged. */
export function h3ToHex(index: string): string {
  return /^[0-9]+$/.test(index) ? BigInt(index).toString(16) : index;
}
