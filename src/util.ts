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

const PREFIXES: Record<BoundaryLayer, RegExp> = {
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
 *   V1_001        -> "Equity Area 001"
 */
export function prettyRegion(name: string, layer: BoundaryLayer): string {
  const stripped = name.replace(PREFIXES[layer], "");
  switch (layer) {
    case "council_district":
      return `Council District ${stripped}`;
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
