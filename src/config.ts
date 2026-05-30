import type { LngLatBoundsLike } from "maplibre-gl";
import type { BoundaryLayer } from "./api.ts";

/** Fit-to-Denver bounding box: [west, south] .. [east, north]. */
export const DENVER_BOUNDS: LngLatBoundsLike = [
  [-105.11, 39.61],
  [-104.6, 39.91],
];

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
