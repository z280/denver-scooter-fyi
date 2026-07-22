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

// Whether Google sign-in is offered — and the GIS client id to init with —
// now comes from the backend's GET /api/v1/auth/config (see auth-config.ts),
// the single source of truth. The old frontend GOOGLE_AUTH_ENABLED /
// GOOGLE_OAUTH_CLIENT_ID constants were removed so the two can't drift.

/** Admin allowlist for the Google sign-in gate (see
 *  docs/API_REQUIREMENTS.md §2.2), kept here for reference / parity with the
 *  server config. The binding decision is enforced SERVER-SIDE: the API
 *  verifies the Google token and, for a verified email on this list, stamps
 *  the session's `admin` scope. The frontend trusts only that scope (see
 *  isAdminSession) — it does NOT gate admin on this list, so a magic-link
 *  session for an allowlisted email is correctly not treated as admin. */
export const ADMIN_EMAILS: readonly string[] = ["zneill@gmail.com"];

/** True if `email` is on the admin allowlist (case-insensitive). Reference
 *  helper only — the UI does not use it to decide admin (the server's scope
 *  is authoritative); kept alongside ADMIN_EMAILS for parity/tests. */
export function isAdminEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && ADMIN_EMAILS.includes(email.toLowerCase());
}

/** Adjust tracker token from Veo's own QR stickers. Campaign-scoped, so
 *  Veo could rotate it — if unlock links stop resolving, refresh it from
 *  any scooter's QR code. */
export const VEO_ADJUST_TOKEN = "622qh4";

/** Veo's PUBLIC GBFS free_bike_status feed for Denver. The browser fetches
 *  this directly (see gbfs.ts) to recover a vehicle's plate — the number
 *  painted on the deck / in the QR code — from each entry's rental_uris
 *  `&number=` param. This keeps the plate out of OUR API: we source it
 *  straight from Veo, client-side. Verified CORS-open (Access-Control-
 *  Allow-Origin present) 2026-07; if Veo ever closes it, this needs a
 *  same-origin passthrough instead. */
export const VEO_GBFS_FREE_BIKE_STATUS_URL =
  "https://cluster-prod.veoride.com/api/shares/name/den/gbfs/free_bike_status";

/** The exact deep-link format printed on every scooter: opens the Veo app
 *  to this vehicle when installed, else Adjust bounces to the app store. */
export function veoDeepLink(vehicleNumber: string): string {
  return `https://gmjc.adj.st/?adj_t=${VEO_ADJUST_TOKEN}&number=${encodeURIComponent(vehicleNumber)}`;
}

// ---------- Report improperly-parked vehicle to Veo ----------
// A rider who spots a badly-parked Veo (blocking a sidewalk, ADA ramp,
// transit stop…) can file it with Veo directly. Veo takes those reports
// through a public Zendesk help-center form, which supports pre-filling
// fields straight from the URL via Zendesk's `tf_` ("ticket field")
// convention. We assemble that URL from what the map already knows, so the
// rider only reviews and submits — we never auto-submit (it's their report,
// under their identity, and Zendesk gates submit with its own anti-spam).

/** Everything we can pre-fill about a badly-parked vehicle. All optional
 *  except the coordinates — the report is meaningless without a location. */
export interface ParkingReportInput {
  lat: number;
  lng: number;
  /** Painted vehicle number / QR plate, when we have it. */
  plate?: string | null;
  /** Friendly model name (e.g. "Astro"). */
  modelName?: string | null;
  /** Stable vehicle identifier from the feed. */
  vehicleId?: string | null;
  /** Human dwell string (e.g. "3d 4h") for "parked here for at least…". */
  dwellText?: string | null;
  /** Reverse-geocoded street address for the coordinates, when resolved
   *  (see geocode.ts). Populated asynchronously; null falls back to coords. */
  address?: string | null;
}

/** Vehicle Type dropdown OPTION TAGS (not the visible labels) for Veo's form.
 *  Zendesk dropdowns prefill by tag. Astro is a standing scooter → the
 *  "Scooter" option; Cosmo and Apollo are their own options. Our type-5 is a
 *  Cosmo too, so it maps there. **TODO(maintainer):** fill these from the live
 *  form (the extraction snippet reports each option's tag). Empty = unset, so
 *  the rider picks manually. */
const VEO_VEHICLE_TYPE_TAGS = { scooter: "", cosmo: "", apollo: "" };

/** Map our friendly model name → the Vehicle Type dropdown's option tag. */
function vehicleTypeTag(modelName: string | null | undefined): string {
  const m = (modelName ?? "").toLowerCase();
  if (m.includes("astro")) return VEO_VEHICLE_TYPE_TAGS.scooter;
  if (m.includes("apollo")) return VEO_VEHICLE_TYPE_TAGS.apollo;
  if (m.includes("cosmo")) return VEO_VEHICLE_TYPE_TAGS.cosmo;
  return ""; // unknown model → leave the dropdown for the rider
}

interface ZendeskCustomField {
  /** Numeric Zendesk custom-field id — the `NNN` in `tf_NNN`. */
  fieldId: string;
  /** Our report → the string Zendesk expects for this field. For a
   *  dropdown/checkbox the string must be the option's *tag*, not its label. */
  map: (r: ParkingReportInput) => string;
}

/** Veo's public "improperly parked vehicle" Zendesk form.
 *
 *  `tf_subject` and `tf_description` are Zendesk's stable built-in prefill
 *  params and carry the full report on their own, so this is useful as-is.
 *
 *  `customFields` targets Veo's *custom* fields (location dropdown, vehicle
 *  number, etc.). Those ids are instance-specific and only readable off the
 *  live form's HTML (the page blocks automated fetches), so the list is left
 *  empty as a deliberate TODO — fill a `fieldId` in and its value rides along
 *  automatically, no other code change needed. */
export const VEO_ZENDESK_PARKING: {
  baseUrl: string;
  ticketFormId: string;
  customFields: ZendeskCustomField[];
} = {
  baseUrl: "https://veoride.zendesk.com/hc/en-us/requests/new",
  ticketFormId: "24858990499988",
  // Custom fields. **TODO(maintainer):** fill each `fieldId` (the numeric
  // Zendesk custom-field id, the NNN in tf_NNN) from the live form — the
  // extraction snippet in the PR reports them. An empty fieldId is skipped at
  // build time, so the field is simply left for the rider to fill. Likewise
  // fill VEO_VEHICLE_TYPE_TAGS above with each dropdown option's tag.
  customFields: [
    // Vehicle number (text) — the plate under the QR code. Resolved from
    // Veo's own GBFS client-side (see gbfs.ts / effectivePlate).
    { fieldId: "360038000552", map: (r) => r.plate ?? "" },
    // Vehicle type (dropdown) — Astro→Scooter, Cosmo→Cosmo, Apollo→Apollo.
    // Field id confirmed off the live form; the option TAGS still need filling
    // in VEO_VEHICLE_TYPE_TAGS (the field is a JS dropdown, so its tags aren't
    // in the page HTML). Until then vehicleTypeTag() returns "" and the empty
    // value is skipped at build time — the rider just picks it manually.
    { fieldId: "360029446151", map: (r) => vehicleTypeTag(r.modelName) },
    // Location (text: "address or cross streets") — reverse-geocoded address,
    // else the raw coords.
    {
      fieldId: "24861449413652",
      map: (r) => r.address ?? `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`,
    },
  ],
};

/** Google Maps "search this point" link — a universal, keyless location
 *  reference to drop in the report body. */
function mapsPointUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** Build the Veo Zendesk deep-link with the report pre-filled. The rider
 *  reviews, adds the specific problem (blocking sidewalk, ramp, …), and
 *  submits. */
export function veoParkingReportUrl(r: ParkingReportInput): string {
  const idBits = [
    r.plate ? `vehicle #${r.plate}` : null,
    r.modelName ?? null,
  ].filter((b): b is string => !!b);
  const subject = `Improperly parked Veo${idBits.length ? " — " + idBits.join(", ") : ""}`;

  const body = [
    "Reporting a Veo vehicle that appears to be improperly parked.",
    "",
    r.plate ? `Vehicle number: ${r.plate}` : null,
    r.modelName ? `Model: ${r.modelName}` : null,
    r.vehicleId ? `Vehicle ID: ${r.vehicleId}` : null,
    r.address
      ? `Location: ${r.address} (${r.lat.toFixed(6)}, ${r.lng.toFixed(6)})`
      : `Location: ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`,
    `Map: ${mapsPointUrl(r.lat, r.lng)}`,
    r.dwellText ? `Parked here for at least: ${r.dwellText}` : null,
    "",
    "Reported via denver.scooter.fyi. Please describe the specific problem " +
      "(blocking sidewalk, ADA ramp, transit stop, driveway, etc.) before sending.",
  ].filter((l): l is string => l !== null);

  const params = new URLSearchParams();
  params.set("ticket_form_id", VEO_ZENDESK_PARKING.ticketFormId);
  params.set("tf_subject", subject);
  params.set("tf_description", body.join("\n"));
  for (const cf of VEO_ZENDESK_PARKING.customFields) {
    if (!cf.fieldId) continue;
    const value = cf.map(r);
    if (value) params.set(`tf_${cf.fieldId}`, value);
  }
  return `${VEO_ZENDESK_PARKING.baseUrl}?${params.toString()}`;
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
