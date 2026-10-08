import type { LngLatBoundsLike } from "maplibre-gl";
import type { BoundaryLayer } from "./api.ts";
import { EQUITY_AREA_COLOR } from "./equity-areas.ts";

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

/** Contractual SLA threshold for avg_percent_all_devices_equity (RFP §3.0)
 *  — the share of the fleet the contract requires in equity areas over the
 *  6-9 AM window. The server computes pass/fail with this same number; it
 *  is repeated here only to draw the target line on the gauge. */
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

/** The boundary overlays offered in the Areas drawer.
 *
 *  The two "Disadvantaged Areas" versions are NOT here any more. They were
 *  the city's two candidate equity maps, drawn side by side because the
 *  contract negotiations cited both and nobody would say which one bound
 *  the SLA. In August 2026 the city said: neither — it is the map in
 *  equity-areas.ts. Showing all three would ask a rider to adjudicate a
 *  question that has been answered, so the official one gets its own
 *  control (see the Areas drawer's "Equity areas" section) and these are
 *  retired to RETIRED_OVERLAYS below. */
export const OVERLAYS: OverlayDef[] = [
  { layer: "neighborhood", label: "Neighborhoods", color: "#1e88e5" },
  { layer: "council_district", label: "City Council Districts", color: "#00897b" },
  { layer: "community_network", label: "City Regions", color: "#6d4c41" },
];

/** The superseded equity maps: v1/v2 and the six ranked tiers.
 *
 *  RETIRED, NOT DELETED — deliberately, in three senses:
 *
 *   * The API still computes, stores and serves all of them, and still
 *     carries their history back to 2025. This app is an audit tool; the
 *     record of what the numbers looked like under the old maps is part of
 *     what it is for.
 *   * `OVERLAY_BY_LAYER` below still resolves them, so overlays.ts can
 *     still draw one if something asks — nothing in the shipping UI does.
 *   * Whoever comes to this file wondering where the v1/v2 checkboxes went
 *     finds the answer here rather than in a year-old commit message.
 *
 *  Adding one back to `OVERLAYS` is all it takes to put it on screen. */
/** The official Equity Area map's label and color.
 *
 *  NOT in `OVERLAYS` — the Areas drawer gives it a dedicated switch rather
 *  than a checkbox in the outline list, and its polygons are drawn by
 *  equity-map.ts from the bundled asset, not by `Overlays.toggle`.
 *
 *  It still needs an entry in `OVERLAY_BY_LAYER` below, because the layer is
 *  reachable through two OTHER doors that both go through
 *  `Overlays.ensureLayer` and read `.color` from there: the choropleth
 *  select and the area filter's category list. Leaving it out crashed both
 *  with "Cannot read properties of undefined (reading 'color')". */
export const EQUITY_AREA_OVERLAY: OverlayDef = {
  layer: "equity",
  label: "Equity Areas",
  color: EQUITY_AREA_COLOR,
};

export const RETIRED_OVERLAYS: OverlayDef[] = [
  { layer: "v1", label: "Disadvantaged Areas (v1)", color: "#e53935" },
  { layer: "v2", label: "Disadvantaged Areas (v2)", color: "#8e24aa" },
];

/** Equity-rank tiers er1..er6 — retired alongside v1/v2, for the same
 *  reason and on the same terms. The rank picker they drove (a rider
 *  choosing which tiers to estimate against, because the city had not said)
 *  is gone from the compliance drawer; the constants stay so the layers
 *  remain nameable and drawable. */
export const EQUITY_RANK_COLOR = "#7b1fa2";
export const EQUITY_RANK_NUMBERS = [1, 2, 3, 4, 5, 6] as const;
export type EquityRank = (typeof EQUITY_RANK_NUMBERS)[number];

export function equityRankLayer(rank: EquityRank): BoundaryLayer {
  return `er${rank}` as BoundaryLayer;
}

const EQUITY_RANK_OVERLAYS: OverlayDef[] = EQUITY_RANK_NUMBERS.map((r) => ({
  layer: equityRankLayer(r),
  label: `Equity Rank ${r}`,
  color: EQUITY_RANK_COLOR,
}));

/** Color/label lookup for EVERY layer, retired ones included. overlays.ts
 *  reads `.color` from here whenever it materializes a layer, so this must
 *  stay exhaustive over BoundaryLayer even for layers the UI no longer
 *  offers — a missing entry is an undefined dereference at draw time, not a
 *  type error, because the Record is asserted rather than inferred. */
export const OVERLAY_BY_LAYER: Record<BoundaryLayer, OverlayDef> = Object.fromEntries(
  [
    ...OVERLAYS,
    EQUITY_AREA_OVERLAY,
    ...RETIRED_OVERLAYS,
    ...EQUITY_RANK_OVERLAYS,
  ].map((o) => [o.layer, o]),
) as Record<BoundaryLayer, OverlayDef>;

// Whether Google sign-in is offered — and the GIS client id to init with —
// now comes from the backend's GET /api/v1/auth/config (see auth-config.ts),
// the single source of truth. The old frontend GOOGLE_AUTH_ENABLED /
// GOOGLE_OAUTH_CLIENT_ID constants were removed so the two can't drift.

/** Admin allowlist for the Google sign-in gate (see
 *  the backend's API.md), kept here for reference / parity with the
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

// Plates (the number painted on the deck / in the QR code) come from OUR API,
// never from Veo's servers in the rider's browser: a background pull from the
// browser hands Veo every rider's IP (owner decision 2026-10-08). See
// plates.ts — `/vehicles/plates` serves them to signed-in riders only, one
// batch of nearby vehicles at a time; the public `/vehicles/resolve` maps a
// plate the rider already holds to a vehicle and reveals no plate. The only
// Veo URLs left below are navigation the rider chooses (the deep link and
// Adjust bounce, the Zendesk form).

/** The exact deep-link format printed on every scooter: opens the Veo app
 *  to this vehicle when installed, else Adjust bounces to the app store. */
export function veoDeepLink(vehicleNumber: string): string {
  return `https://gmjc.adj.st/?adj_t=${VEO_ADJUST_TOKEN}&number=${encodeURIComponent(vehicleNumber)}`;
}

/** We See You Veo, the property a rider story can be sent to.
 *
 *  A SECOND ORIGIN, named here rather than inlined, because posting to it is
 *  the one thing this app does that leaves our own infrastructure. Everything
 *  that reaches it does so because a rider ticked a box that said what was
 *  being sent and to whom (`rider-story.ts`).
 *
 *  In dev it goes through Vite's proxy: that server's CORS allowlist holds the
 *  production origins and nothing else, deliberately — adding localhost to a
 *  live allowlist to make local testing convenient is how an allowlist stops
 *  meaning anything. The proxy is a server-side hop, so no CORS applies. */
export const WSYV_BASE = import.meta.env.DEV ? "/wsyv" : "https://weseeyouveo.com";

// ---------- The governing documents ----------
//
// ONE LIST, because there are three places that must agree about these URLs:
// the map's own footer (`legal-links.ts`), the About drawer's prose, and
// anywhere a sign-in flow has to say what the rider is agreeing to. Three
// hand-maintained copies of the same two links is the drift this file already
// carries a complaint about elsewhere (the dibs rules, in three places).
//
// They are served by the API, not bundled: `data.scooter.fyi/legal/*` renders
// `src/templates/legal/*.html` over there. `GET /api/v1/meta/privacy` is NOT
// generated from that template — it is a hand-maintained copy in the API's
// `src/api_meta.py`, so the two can drift and must be updated together.
export const PRIVACY_POLICY_URL = "https://data.scooter.fyi/legal/privacy-policy";
export const TERMS_OF_SERVICE_URL = "https://data.scooter.fyi/legal/terms-of-service";

export const LEGAL_LINKS: readonly { label: string; href: string }[] = [
  {
    label: "Privacy",
    href: PRIVACY_POLICY_URL,
  },
  {
    label: "Terms",
    href: TERMS_OF_SERVICE_URL,
  },
];

// ---------- Billing queries (Phase 8 §8.5) ----------

/** Where a fare query goes, in one place beside the rate plans it is about.
 *
 *  THE RIDER SENDS IT, from their own address, and the app never does. That is
 *  not a limitation to route around: sending it would mean this project
 *  asserting a contract claim on somebody's behalf, from an address they do not
 *  control. So this is a `mailto:` recipient, not an API the app posts to.
 *
 *  It sits here rather than in `receipt-panel.ts` for the same reason
 *  `VEO_ZENDESK_PARKING` does: the address is a fact about Veo, the panel is a
 *  surface, and a surface that owns an address is a surface somebody has to go
 *  and edit when the address changes.
 *
 *  SUPPLIED BY THE OWNER (2026-10-07). It was deliberately left empty until
 *  then, because every other Veo endpoint in this file was verified against
 *  something Veo publishes — the Zendesk form's own field ids, the Adjust
 *  deep-link token — and a plausible-looking address is worse than none here:
 *  the complaint path's whole value is that it reaches somebody, and a wrong
 *  recipient produces a rider who believes they filed a billing query and did
 *  not. `complaintReady()` below stays, for the same reason it was written: it
 *  is the guard that keeps an un-addressed draft from looking like the feature
 *  working, and it costs nothing now that the address is real.
 *
 *  It is a Zendesk support address, which is why it reads like one — mail to it
 *  opens a ticket in the same system `VEO_ZENDESK_PARKING` posts to. */
export const VEO_SUPPORT_EMAIL = "support@veoride.zendesk.com";

/** Whether §8.5's complaint path can be offered at all.
 *
 *  A `mailto:` with an empty `to` opens a blank draft, which looks like the
 *  feature working. So the panel asks this instead of assuming, and offers the
 *  rider the copyable body with no recipient rather than a draft addressed to
 *  nobody. */
export function complaintReady(): boolean {
  return VEO_SUPPORT_EMAIL.includes("@");
}

/** The contract row a fare query cites. Verbatim and under the facts, never
 *  woven into them — at the single-receipt level an overcharge is
 *  indistinguishable from a bug, and the complaint should read like the billing
 *  query it is. Adjectives are what make it read like an accusation. */
export const EQUITY_DISCOUNT_CITATION =
  "Veo's contract with the City and County of Denver (Exhibit A §5.2) requires " +
  "a fare discount for any trip that starts or ends within a designated Equity " +
  "Area, priced by Exhibit C at $1.00 + $0.13/minute.";

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
  // NO `vehicleId` AND NO `dwellText`. Both used to be here and both used to
  // go into the report body; see `veoParkingReportUrl` for why they came out.
  // They are deleted rather than left unused, because a field sitting on this
  // interface is an invitation to put it back in the body — and the next
  // person to do that would be restoring a privacy decision's opposite
  // without ever reading the reason.
  /** Reverse-geocoded street address for the coordinates, when resolved
   *  (see geocode.ts). Populated asynchronously; null falls back to coords. */
  address?: string | null;
}

/** Vehicle Type dropdown OPTION TAGS (not the visible labels) for Veo's form.
 *  Zendesk dropdowns prefill by tag. Astro is a standing scooter → the
 *  "Scooter" option; Cosmo, Apollo and the Rover are their own options. Our type-5
 *  is a Cosmo too, so it maps there. **TODO(maintainer):** fill these from the
 *  live form (the extraction snippet reports each option's tag). Empty = unset,
 *  so the rider picks manually. */
const VEO_VEHICLE_TYPE_TAGS = { scooter: "", cosmo: "", apollo: "", trike: "" };

/** Map our friendly model name → the Vehicle Type dropdown's option tag. */
function vehicleTypeTag(modelName: string | null | undefined): string {
  const m = (modelName ?? "").toLowerCase();
  if (m.includes("astro")) return VEO_VEHICLE_TYPE_TAGS.scooter;
  if (m.includes("apollo")) return VEO_VEHICLE_TYPE_TAGS.apollo;
  if (m.includes("cosmo")) return VEO_VEHICLE_TYPE_TAGS.cosmo;
  // Veo's marketing name for the three-wheeler is "Rover"; older feed
  // rows (and our internal key) still say "trike" — same dropdown option.
  if (m.includes("trike") || m.includes("rover")) return VEO_VEHICLE_TYPE_TAGS.trike;
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
    // Vehicle number (text) — the plate under the QR code. From our own
    // `/vehicles/plates` for signed-in riders (plates.ts / effectivePlate);
    // empty for a guest, who types it on the form.
    { fieldId: "360038000552", map: (r) => r.plate ?? "" },
    // Vehicle type (dropdown) — Astro→Scooter, Cosmo→Cosmo, Apollo→Apollo,
    // Rover→Trike (Veo's form may still label the option by the old name).
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

  // WHAT THIS REPORT MAY CONTAIN, AND WHY IT IS SO SHORT.
  //
  // Everything in here is something the RIDER can see standing in front of
  // the vehicle, or something VEO already knows. Nothing from our own
  // observation of the fleet goes in, and the report does not say where it
  // was composed. Three things were removed for that reason, and each would
  // be easy to put back by accident:
  //
  //   * "Parked here for at least 3d 4h" — that is OUR dwell measurement,
  //     derived from a two-minute ingest cycle the rider never saw. It reads
  //     as the rider's own observation and it is not; it is a claim from a
  //     monitoring system, filed under a rider's name and their identity.
  //   * "Vehicle ID: …" — a salted HMAC of the plate (`identity.hash_plate`).
  //     Veo cannot resolve it, so it carries no information to the recipient
  //     and advertises an identifier scheme of ours for nothing.
  //   * "Reported via …" — the report is the rider's, filed under their
  //     identity on Veo's own form. Attaching our name to it makes a single
  //     rider's complaint look like an organised campaign, which is both
  //     untrue and the easiest way for Veo to dismiss the whole class of
  //     them.
  //
  // Anything added here later gets the same test: could the person sending
  // this have seen it themselves? If not, it does not belong in their words.
  const body = [
    "Reporting a Veo vehicle that appears to be improperly parked.",
    "",
    r.plate ? `Vehicle number: ${r.plate}` : null,
    r.modelName ? `Model: ${r.modelName}` : null,
    r.address
      ? `Location: ${r.address} (${r.lat.toFixed(6)}, ${r.lng.toFixed(6)})`
      : `Location: ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`,
    `Map: ${mapsPointUrl(r.lat, r.lng)}`,
    "",
    "Please describe the specific problem (blocking sidewalk, ADA ramp, " +
      "transit stop, driveway, etc.) before sending.",
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

// TWO DIFFERENT THINGS, both of which the contract calls "equity" ---------
//
// Exhibit C's pricing table has four rows, and this app long carried only
// three of them. The one it was missing is the one that matters most to a
// rider standing in an equity area:
//
//   * RATE_PLANS below are RIDER TIERS — which pricing bracket a person is
//     enrolled in. The rider picks theirs; it applies to every ride they
//     take, anywhere in the city.
//
//   * EQUITY_AREA_RATE is GEOGRAPHIC and AUTOMATIC. Exhibit A §5.2 obliges
//     Veo to discount "any trip that starts or ends within a designated
//     Equity Area" — the rider does not opt in, does not enroll, and does
//     not have to know it exists. Exhibit C prices it at $1 + $0.13/min.
//
// They are orthogonal axes, and conflating them is how a rider gets talked
// out of a refund. See EQUITY_AREA_RATE below.

// One flat list, VeoPlus variants included (per Zeke, PR #37): rate is a
// single field, not a rate + a separate VeoPlus checkbox. The Pass waives
// the unlock fee, so its variants just carry unlockCents: 0. The Access
// tier gets no variant — its unlock is already free, so a Pass changes
// nothing.
export type RatePlanKey =
  | "resident"
  | "resident_plus"
  | "visitor"
  | "visitor_plus"
  | "equity";

export interface RatePlan {
  key: RatePlanKey;
  label: string;
  unlockCents: number;
  perMinCents: number;
  /** VeoPlus Pass variant (free unlocks baked into unlockCents). */
  veoPlus?: boolean;
}

export const RATE_PLANS: RatePlan[] = [
  { key: "resident", label: "Resident — $1 + 25¢/min", unlockCents: 100, perMinCents: 25 },
  { key: "resident_plus", label: "Resident w/ VeoPlus Pass — free unlocks + 25¢/min", unlockCents: 0, perMinCents: 25, veoPlus: true },
  { key: "visitor", label: "Visitor — $1 + 39¢/min", unlockCents: 100, perMinCents: 39 },
  { key: "visitor_plus", label: "Visitor w/ VeoPlus Pass — free unlocks + 39¢/min", unlockCents: 0, perMinCents: 39, veoPlus: true },
  // Denver's income-qualified rider tier — Exhibit C calls it the Access
  // Program. 60 free min/day, then 15¢/min with no unlock fee; the ticker
  // can't know how much of today's free hour is left, so it prices minutes
  // beyond 60 and labels the estimate accordingly.
  //
  // The KEY stays "equity" because it is the server's `rate_plan` enum
  // value (see toApiRatePlan / the API's PUT /api/v1/profile) and riders
  // already have it stored — renaming it is a cross-repo migration, not a
  // relabel. The LABEL changed because "Equity program" and "Equity Area"
  // are different contract rows, and a rider who reads this line as the
  // area discount concludes they are already getting it.
  { key: "equity", label: "Access Program (income-qualified) — 60 free min/day, then 15¢/min", unlockCents: 0, perMinCents: 15 },
];

/** Exhibit C, "Equity Area Pricing" row: $1 unlock + $0.13/minute, fixed
 *  for the whole contract term (May 2026 – May 2029) and adjustable only
 *  for documented cost-of-service increases with DOTI approval
 *  (Exhibit A §7.1).
 *
 *  Deliberately NOT a member of RATE_PLANS. Every entry there is something
 *  a rider chooses; this is something the contract obliges Veo to apply on
 *  its own, to any trip that starts or ends in an Equity Area, whatever
 *  tier the rider is on (Exhibit A §5.2, "shall"). Putting it in the picker
 *  would frame an automatic entitlement as an option you have to know to
 *  select — which is the failure mode this whole app exists to correct.
 *
 *  Note the $1 unlock. It is easy to read "$0.13/min" as the whole story
 *  and then read a $1 line on a receipt as the discount having been
 *  ignored. It hasn't; the unlock is in the contract's own row.
 *
 *  One thing Exhibit C does NOT say: whether a VeoPlus Pass waives this
 *  unlock the way it waives the standard one. The Equity Area row has no
 *  Pass variant and no "Maximums" figure at all, unlike Base Price
 *  ($0.49/min cap), Resident Pass ($0.33/min) and Access ($0.19/min). So
 *  the rate is modeled exactly as written, with no inferred interaction. */
export const EQUITY_AREA_RATE = {
  unlockCents: 100,
  perMinCents: 13,
} as const;

/** One purchasable comparator pass: a flat price for a block of riding
 *  minutes, unlocks included (no per-ride unlock charge). */
export interface ComparatorPass {
  minutes: number;
  cents: number;
}

/** "If Veo had competition" comparator for the ride summary. Lime's
 *  typical mid-market US pricing; update to Lime's last-known Denver rates
 *  when confirmed.
 *
 *  Pass-based pricing only — that's how a regular rider would realistically
 *  pay: buy a block of minutes up front, ride unlock-free. (The old
 *  pay-as-you-go `unlockCents`/`perMinCents` fields left with their last
 *  consumer, the retired "typical pricing" summary row.) Keep `passes`
 *  sorted by minutes ascending — `comparatorPassQuote`'s smallest-covering-
 *  pass search assumes it. */
export const COMPARATOR = {
  name: "Lime",
  passes: [
    { minutes: 30, cents: 299 },
    { minutes: 60, cents: 499 },
    { minutes: 120, cents: 1299 },
  ] as ComparatorPass[],
};
