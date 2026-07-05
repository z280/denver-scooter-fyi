import type { LngLatBoundsLike } from "maplibre-gl";
import type { BoundaryLayer } from "./api.ts";

/** Fit-to-Denver bounding box: [west, south] .. [east, north]. */
export const DENVER_BOUNDS: LngLatBoundsLike = [
  [-105.11, 39.61],
  [-104.6, 39.91],
];

// Self-hosted basemap archive. It lives on R2, not on Pages with the rest of
// the static assets, because pmtiles needs HTTP Range requests and Cloudflare
// Pages does not serve them — it returns the whole file, which makes the
// pmtiles client throw. R2 serves 206 Partial Content (CORS in r2-cors.json).
export const BASEMAP_PMTILES_URL =
  "https://pub-0eac47b8fe1545b794aabed7f91694ac.r2.dev/denver.pmtiles";

/** Device positions repoll cadence. Upstream only updates every ~10 min. */
export const REFRESH_MS = 90_000;

/** Contractual SLA threshold for avg_percent_all_devices_v1 (RFP §3.0). */
export const COMPLIANCE_THRESHOLD = 30;

/** Colorblind-safe (Okabe–Ito) device colors. */
export const DEVICE_COLORS = {
  scooter: "#E69F00",
  bicycle: "#009E73",
  unknown: "#999999",
  cluster: "#0072B2",
} as const;

export interface OverlayDef {
  layer: BoundaryLayer;
  label: string;
  color: string;
}

/** The five boundary overlays, with the exact required UI labels. */
export const OVERLAYS: OverlayDef[] = [
  { layer: "v1", label: "Disadvantaged Areas (v1)", color: "#e53935" },
  { layer: "v2", label: "Disadvantaged Areas (v2)", color: "#8e24aa" },
  { layer: "neighborhood", label: "Neighborhoods", color: "#1e88e5" },
  { layer: "council_district", label: "City Council Districts", color: "#00897b" },
  { layer: "community_network", label: "City Regions", color: "#6d4c41" },
];

export const OVERLAY_BY_LAYER: Record<BoundaryLayer, OverlayDef> = Object.fromEntries(
  OVERLAYS.map((o) => [o.layer, o]),
) as Record<BoundaryLayer, OverlayDef>;

/** Adjust tracker token from Veo's own QR stickers. Campaign-scoped, so
 *  Veo could rotate it — if unlock links stop resolving, refresh it from
 *  any scooter's QR code. */
export const VEO_ADJUST_TOKEN = "622qh4";

/** The exact deep-link format printed on every scooter: opens the Veo app
 *  to this vehicle when installed, else Adjust bounces to the app store. */
export function veoDeepLink(vehicleNumber: string): string {
  return `https://gmjc.adj.st/?adj_t=${VEO_ADJUST_TOKEN}&number=${encodeURIComponent(vehicleNumber)}`;
}
