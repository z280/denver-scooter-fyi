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

/** Equity-rank tiers er1..er6. One shared color so the "Equity Ranking
 *  (Selected)" union reads as a single overlay regardless of which ranks
 *  are on. Kept out of OVERLAYS so they don't each get an individual
 *  boundary-outline checkbox — the rank toggles live in the compliance
 *  drawer and drive the union overlay instead. */
export const EQUITY_RANK_COLOR = "#7b1fa2";
export const EQUITY_RANK_NUMBERS = [1, 2, 3, 4, 5, 6] as const;
export type EquityRank = (typeof EQUITY_RANK_NUMBERS)[number];
export const EQUITY_RANK_DEFAULT: readonly EquityRank[] = [1, 2];

export function equityRankLayer(rank: EquityRank): BoundaryLayer {
  return `er${rank}` as BoundaryLayer;
}

const EQUITY_RANK_OVERLAYS: OverlayDef[] = EQUITY_RANK_NUMBERS.map((r) => ({
  layer: equityRankLayer(r),
  label: `Equity Rank ${r}`,
  color: EQUITY_RANK_COLOR,
}));

/** Color/label lookup for every layer, including the equity ranks (which
 *  aren't in OVERLAYS). overlays.ts reads `.color` from here for er layers. */
export const OVERLAY_BY_LAYER: Record<BoundaryLayer, OverlayDef> = Object.fromEntries(
  [...OVERLAYS, ...EQUITY_RANK_OVERLAYS].map((o) => [o.layer, o]),
) as Record<BoundaryLayer, OverlayDef>;

/** Admin allowlist for the forthcoming Google sign-in gate (see
 *  docs/API_REQUIREMENTS.md §2.2). A Google-verified email on this list is
 *  meant to receive the `admin` scope — access to private per-scooter fields
 *  and future admin tooling.
 *
 *  NOTE: this list grants nothing on its own. The binding decision is
 *  enforced SERVER-SIDE once auth ships (the API verifies the Google token
 *  and stamps the scope); this is only the client-side mirror the UI reads to
 *  decide what to show. Hardcoded for now until the auth flow surfaces an
 *  email — the current AuthBlob carries only a token, no identity. */
export const ADMIN_EMAILS: readonly string[] = ["zneill@gmail.com"];

/** True if `email` is on the admin allowlist (case-insensitive). Wired ahead
 *  of the Google gate; nothing calls it yet because no email is available
 *  until sign-in provides one. */
export function isAdminEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && ADMIN_EMAILS.includes(email.toLowerCase());
}

/** Adjust tracker token from Veo's own QR stickers. Campaign-scoped, so
 *  Veo could rotate it — if unlock links stop resolving, refresh it from
 *  any scooter's QR code. */
export const VEO_ADJUST_TOKEN = "622qh4";

/** The exact deep-link format printed on every scooter: opens the Veo app
 *  to this vehicle when installed, else Adjust bounces to the app store. */
export function veoDeepLink(vehicleNumber: string): string {
  return `https://gmjc.adj.st/?adj_t=${VEO_ADJUST_TOKEN}&number=${encodeURIComponent(vehicleNumber)}`;
}

// ---------- Ride pricing ----------
// Veo's Denver rates are locked in the city licensing agreement for the
// contract's duration, so constants are safe. All amounts in cents.

export type RatePlanKey = "resident" | "visitor" | "equity";

export interface RatePlan {
  key: RatePlanKey;
  label: string;
  unlockCents: number;
  perMinCents: number;
}

export const RATE_PLANS: RatePlan[] = [
  { key: "resident", label: "Resident — $1 + 25¢/min", unlockCents: 100, perMinCents: 25 },
  { key: "visitor", label: "Visitor — $1 + 39¢/min", unlockCents: 100, perMinCents: 39 },
  // Equity program: 60 free min/day, then 15¢/min with no unlock fee. The
  // ticker can't know how much of today's free hour is left, so it prices
  // minutes beyond 60 and labels the estimate accordingly.
  { key: "equity", label: "Equity program — 60 free min/day, then 15¢/min", unlockCents: 0, perMinCents: 15 },
];

/** "If Veo had competition" comparator for the ride summary. Lime's
 *  typical mid-market US pricing; update to Lime's last-known Denver rates
 *  when confirmed. */
export const COMPARATOR = {
  name: "Lime",
  unlockCents: 100,
  perMinCents: 30,
  weekPassCents: 499,
};
