// Screen 7's turn-by-turn navigation overlay (frontend plan, `ride-nav-hud.ts`
// row; master plan Part 0 Screen 7 "When in navigation mode, show a
// step-by-step navigation HUD in the center... corners carry an arrow
// insignia... Press and hold closes/removes navigation guidance").
//
// This module is invoked FROM `ride-hud.ts` (the F3 HUD lane owns that
// wiring, plus the shared `watchPosition` callback that feeds `feedFix`
// below) but touches nothing outside the `container` element it is handed —
// no import of `ride-modal.ts`, `main.ts`, or `devices.ts` state. See the
// `createNavHud` doc comment for the exact contract.
//
// ── What it renders ─────────────────────────────────────────────────────
// A CENTER instruction card (current maneuver's text + a coarse directional
// glyph) flanked by two corner arrow buttons. A short press on either arrow
// opens a step-by-step directions LIST panel on that side (compressing
// whatever the caller considers "the ride root" — this module never reaches
// for that element itself; it reports the compression state via
// `onCompress(side)` and lets the caller apply the CSS class). A PRESS-AND-
// HOLD on either arrow dismisses navigation guidance entirely and tears this
// module's own DOM down.
//
// `NAV_DISMISS_HOLD_MS` is 800ms — deliberately NOT the same value as
// `devices.ts`'s `RIDE_LONGPRESS_MS` (450ms, the ride-mode device-popup
// long-press). That constant is read, confirmed, and intentionally NOT
// reused: dismissing nav guidance is a more consequential, harder-to-undo
// action than peeking a device popup (guidance is gone until the rider
// re-enables it, if the HUD even offers a way back), so it should take a
// deliberately longer hold to trigger by accident. The two constants living
// in different files at different values is the point, not an oversight.
//
// ── Maneuver advance: MONOTONIC shape-index progression ────────────────
// The route's shape (decoded from the session doc's `route.polyline`) is
// matched against each GPS fix by nearest-point search, but that search is
// constrained to a forward-looking WINDOW starting at the last matched
// index — never regressing to an earlier index even when a later fix is
// geometrically closer to an earlier shape point. Plain nearest-point
// matching breaks on out-and-back routes (the return leg runs back past
// points the outbound leg already used) and on a GPS jump landing across a
// switchback (a noisy fix can land closer, as the crow flies, to a shape
// point on a nearby-but-already-passed leg than to the true next point).
// A separate, UNCONSTRAINED measurement (searched over the whole shape, no
// window) still runs on every fix and feeds the off-route test below — but
// it is a point-to-SEGMENT (line) distance (`distanceToLineString`), not a
// point-to-VERTEX one (review fix: `nearestShapeIndex`'s vertex-only search
// can badly over-report distance on a sparse polyline — a rider at a
// segment's midpoint reads as far from either endpoint despite being on the
// line itself; see that function's own doc comment).
//
// ── Off-route re-route ──────────────────────────────────────────────────
// >50m from the route line, sustained for 10s, triggers a re-route: a fresh
// `GET /route` call (`api.ts`'s `fetchRoute`) from the current fix to the
// session doc's retained destination, requesting ONLY the previously
// selected profile (never all four again). Capped to <=1/min via a simple
// timestamp gate — a client-side courtesy on top of `route_ip`'s shared
// 30/min budget, not a replacement for it. A re-route NEVER calls
// `postRideRoute` — the Screen 4 choice pinned in the session doc's
// `rideRouteId` stays the subject of Screen 9's survey and the nav-distance
// bonus; a re-route only swaps the displayed geometry/maneuvers in place
// (reported to the caller via `onRouteUpdate`, if given — this module never
// touches `ride-session.ts` itself).
//
// ── Polyline decoding ────────────────────────────────────────────────────
// `polyline-encode.ts` ships an encoder only ("the server owns decoding...
// a decoder has no product use here" — true when that module was written).
// This module is the first place that DOES need to decode: the session
// doc's `route.polyline` (precision-5 encoded) must become a coordinate
// array to match GPS fixes against and to seed the initial center-card /
// panel content. Per this lane's file-ownership boundary (own/create
// `ride-nav-hud.ts` only, edit nothing existing), the decoder lives here
// rather than being added to `polyline-encode.ts` — `decodePolyline` below
// is the standard inverse of `encodePolyline`'s algorithm, verified against
// the same fixtures in this module's test file. A future consolidation
// could lift it into `polyline-encode.ts`; noted for the integrator.

import {
  fetchRoute as apiFetchRoute,
  type RouteManeuver,
  type RouteResponse,
} from "./api.ts";
import { distanceMeters } from "./locate.ts";
import type { LngLatCoord } from "./polyline-encode.ts";
import type { RideSessionRoute } from "./ride-session.ts";

// ---------------------------------------------------------------------------
// Tunables (exported so tests can assert against them directly rather than
// hard-coding magic numbers, and so the integrator can see them at a glance).
// ---------------------------------------------------------------------------

/** Press-and-hold duration, either corner arrow, to dismiss guidance. See the
 *  module header for why this is deliberately not `devices.ts`'s 450ms. */
export const NAV_DISMISS_HOLD_MS = 800;

/** Off-route threshold: distance (meters) from the route line, by the
 *  UNCONSTRAINED nearest-point search. */
export const NAV_OFF_ROUTE_DISTANCE_M = 50;

/** Off-route must be sustained this long (ms) before a re-route fires. */
export const NAV_OFF_ROUTE_SUSTAIN_MS = 10_000;

/** Client-side courtesy cap on re-routes: at most one per this many ms,
 *  regardless of how long/how often the sustained condition re-fires. A
 *  simple timestamp gate, per the frontend plan ("rate-budget-aware...
 *  implement it as a simple timestamp-gate"). */
export const NAV_REROUTE_COOLDOWN_MS = 60_000;

/** Forward-looking window (in SHAPE-POINT indices, not meters) the monotonic
 *  matcher searches from the last matched index. Generous relative to
 *  typical fix-to-fix travel (a scooter covers well under 50 shape points'
 *  worth of ground between GPS fixes at any plausible fix rate) while still
 *  bounded well short of "the whole route" — which is what makes an
 *  out-and-back's return leg unable to snap back to the outbound leg's
 *  indices. */
export const NAV_MATCH_FORWARD_WINDOW_POINTS = 50;

// ---------------------------------------------------------------------------
// Pure geometry/matching helpers — no DOM, fully unit-testable on their own.
// ---------------------------------------------------------------------------

export interface ShapeFix {
  lat: number;
  lng: number;
}

export interface ShapeMatch {
  /** Index into the coordinate array. */
  index: number;
  /** Great-circle distance (meters) from `fix` to that point. */
  distanceM: number;
}

/** Nearest-point match, searching only `coords[fromIndex..toIndex]`
 *  inclusive (both bounds clamped into range). An empty `coords` returns
 *  index 0 with `Infinity` distance rather than throwing — callers treat
 *  that as "nothing to match against yet" (e.g. an unparseable/empty stored
 *  polyline). */
export function nearestShapeIndex(
  coords: readonly LngLatCoord[],
  fix: ShapeFix,
  fromIndex: number,
  toIndex: number,
): ShapeMatch {
  if (coords.length === 0) return { index: 0, distanceM: Infinity };
  const lo = Math.max(0, Math.min(fromIndex, coords.length - 1));
  const hi = Math.max(lo, Math.min(toIndex, coords.length - 1));
  let bestIndex = lo;
  let bestDist = Infinity;
  for (let i = lo; i <= hi; i++) {
    const [lng, lat] = coords[i];
    const d = distanceMeters({ lat, lng }, { lat: fix.lat, lng: fix.lng });
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return { index: bestIndex, distanceM: bestDist };
}

/** Squared-length-free point-to-segment distance in a flat, LOCAL xy plane
 *  (meters) — the perpendicular distance from `p` to the closest point on
 *  segment `a`-`b`, clamped to the segment's own endpoints when the
 *  perpendicular foot falls outside it. */
function pointToSegmentDistanceXY(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq),
  );
  const projX = a[0] + t * abx;
  const projY = a[1] + t * aby;
  return Math.hypot(p[0] - projX, p[1] - projY);
}

/** Minimum perpendicular (point-to-LINE, not point-to-vertex) distance,
 *  meters, from `fix` to any segment of `coords`. Review fix: vertex-only
 *  nearest-point matching (`nearestShapeIndex`) can badly over-report
 *  distance on a sparse polyline — a rider at the exact midpoint of a 160m
 *  straight segment is ~80m from either endpoint despite being 0m from the
 *  route LINE, which would wrongly declare them off-route and trigger a
 *  reroute every cooldown. GeoJSON LineString semantics never guarantee
 *  vertices dense enough for vertex distance to stand in for line distance,
 *  so the off-route sample below measures the line directly. Uses a local
 *  equirectangular (flat-earth) projection centered on `fix` — accurate to
 *  well under a meter of error at city scale over segment lengths this
 *  short, ample margin for a 50m threshold; `nearestShapeIndex` /
 *  `advanceMonotonic` (true great-circle distance) remain the maneuver
 *  ADVANCE mechanism — this function is used ONLY for the off-route sample,
 *  per the frontend plan. An empty `coords` returns `Infinity` — nothing to
 *  measure against; a single-point `coords` falls back to point distance. */
export function distanceToLineString(
  coords: readonly LngLatCoord[],
  fix: ShapeFix,
): number {
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) {
    const [lng, lat] = coords[0];
    return distanceMeters({ lat, lng }, { lat: fix.lat, lng: fix.lng });
  }
  const latRad = (fix.lat * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(latRad);
  const toXY = (lng: number, lat: number): [number, number] => [
    (lng - fix.lng) * mPerDegLng,
    (lat - fix.lat) * mPerDegLat,
  ];
  const fixXY: [number, number] = [0, 0];

  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[i + 1];
    const d = pointToSegmentDistanceXY(fixXY, toXY(lng1, lat1), toXY(lng2, lat2));
    if (d < best) best = d;
  }
  return best;
}

/** One step of MONOTONIC advance: nearest-point match constrained to the
 *  forward window `[lastIndex, lastIndex + window]`. Can never return an
 *  index less than `lastIndex` — `nearestShapeIndex` already clamps its
 *  search to `[lastIndex, ...]`, and the explicit floor below is a
 *  defensive belt-and-suspenders that keeps the monotonic guarantee true by
 *  construction even if the search primitive above is ever refactored. */
export function advanceMonotonic(
  coords: readonly LngLatCoord[],
  fix: ShapeFix,
  lastIndex: number,
  window: number = NAV_MATCH_FORWARD_WINDOW_POINTS,
): ShapeMatch {
  const from = Math.max(0, lastIndex);
  const to = from + Math.max(0, window);
  const match = nearestShapeIndex(coords, fix, from, to);
  return match.index < from ? { ...match, index: from } : match;
}

/** The maneuver the matched shape index has REACHED, advancing forward only
 *  from `fromIndex` (the previous call's result — feed it back in so this
 *  is monotonic across a whole ride, exactly like `advanceMonotonic`).
 *  Zero-length legs (`end_shape_index <= begin_shape_index`, which the API
 *  is not expected to send but which would otherwise wedge the loop) are
 *  skipped without getting stuck. */
export function currentManeuverIndex(
  maneuvers: readonly RouteManeuver[],
  matchedShapeIndex: number,
  fromIndex: number = 0,
): number {
  if (maneuvers.length === 0) return 0;
  let idx = Math.max(0, Math.min(fromIndex, maneuvers.length - 1));
  while (
    idx < maneuvers.length - 1 &&
    matchedShapeIndex >= maneuvers[idx].end_shape_index
  ) {
    idx++;
  }
  return idx;
}

/** Sum of great-circle segment lengths from `coords[fromIndex]` to
 *  `coords[toIndex]` (both clamped; a `toIndex` at or before `fromIndex`
 *  yields 0 rather than a negative/garbage number). */
function distanceAlongCoords(
  coords: readonly LngLatCoord[],
  fromIndex: number,
  toIndex: number,
): number {
  if (coords.length === 0) return 0;
  const lo = Math.max(0, Math.min(fromIndex, coords.length - 1));
  const hi = Math.max(lo, Math.min(toIndex, coords.length - 1));
  let total = 0;
  for (let i = lo; i < hi; i++) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[i + 1];
    total += distanceMeters({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
  }
  return total;
}

// ---------------------------------------------------------------------------
// Off-route detection + re-route rate cap — a pure reducer over a tiny state
// shape, so the sustain/cooldown timing is testable without real timers, a
// DOM, or a mocked `fetch`.
// ---------------------------------------------------------------------------

export interface OffRouteState {
  /** Timestamp (ms) the CURRENT off-route excursion began, or `null` while
   *  on-route. Reset to `null` the instant a sample comes back <= threshold. */
  sinceMs: number | null;
  /** Timestamp (ms) of the last re-route ATTEMPT (gated on attempt, not
   *  success, so a failed fetch still counts against the cooldown — this is
   *  a courtesy cap on hitting the shared `route_ip` budget, not a "retry
   *  until it works" mechanism). `null` before the first attempt. */
  lastRerouteAtMs: number | null;
}

export interface OffRouteDecision {
  /** The state to carry into the next sample. */
  state: OffRouteState;
  /** True exactly when this sample is the one that should trigger a
   *  `fetchRoute` call — sustained off-route AND past the cooldown. */
  shouldReroute: boolean;
}

export const INITIAL_OFF_ROUTE_STATE: OffRouteState = {
  sinceMs: null,
  lastRerouteAtMs: null,
};

/** One off-route sample. Pure: no clock reads, no I/O — `atMs` is passed in
 *  (the caller's injectable `now()`), so the whole sustain+cooldown state
 *  machine is deterministic under test. */
export function noteOffRouteSample(
  state: OffRouteState,
  distanceM: number,
  atMs: number,
  opts: { thresholdM?: number; sustainMs?: number; cooldownMs?: number } = {},
): OffRouteDecision {
  const thresholdM = opts.thresholdM ?? NAV_OFF_ROUTE_DISTANCE_M;
  const sustainMs = opts.sustainMs ?? NAV_OFF_ROUTE_SUSTAIN_MS;
  const cooldownMs = opts.cooldownMs ?? NAV_REROUTE_COOLDOWN_MS;

  if (!(distanceM > thresholdM)) {
    // Back on route (or a non-finite/garbage sample): the excursion is over.
    return { state: { ...state, sinceMs: null }, shouldReroute: false };
  }

  const sinceMs = state.sinceMs ?? atMs;
  if (atMs - sinceMs < sustainMs) {
    return { state: { ...state, sinceMs }, shouldReroute: false };
  }

  const cooled =
    state.lastRerouteAtMs === null || atMs - state.lastRerouteAtMs >= cooldownMs;
  if (!cooled) {
    // Still sustained-off-route, but a re-route already fired within the
    // cooldown window — the whole point of the rate cap.
    return { state: { ...state, sinceMs }, shouldReroute: false };
  }

  return { state: { sinceMs, lastRerouteAtMs: atMs }, shouldReroute: true };
}

// ---------------------------------------------------------------------------
// Polyline decode — the mirror of `encodePolyline` (see the module header).
// ---------------------------------------------------------------------------

/** Decode a precision-`precision` Google Encoded Polyline (default 5,
 *  matching `encodePolyline`'s default and what the session doc's
 *  `route.polyline` / `POST /ride-routes`' `route_polyline` store) into
 *  `[lng, lat]` pairs — GeoJSON order, the mirror of `encodePolyline`'s
 *  input order. An empty string decodes to `[]`. */
export function decodePolyline(
  encoded: string,
  precision: number = 5,
): LngLatCoord[] {
  const factor = Math.pow(10, precision);
  let index = 0;
  let lat = 0;
  let lng = 0;
  const out: LngLatCoord[] = [];
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    out.push([lng / factor, lat / factor]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presentation helpers (small, private, not part of the tested contract).
// ---------------------------------------------------------------------------

function formatDistanceShort(m: number): string {
  if (!Number.isFinite(m) || m < 0) return "";
  const feet = m * 3.28084;
  if (feet < 500) return `${Math.round(feet / 10) * 10} ft`;
  const mi = m / 1609.344;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

/** Coarse rotation (degrees) for the center card's directional glyph, keyed
 *  off Valhalla's maneuver type codes. Decorative only — the instruction
 *  TEXT is authoritative; getting a type code's bucket slightly wrong only
 *  mis-rotates an icon; it never mis-states a turn. */
function maneuverGlyphRotationDeg(type: number): number {
  if (type === 12 || type === 13) return 180; // u-turn, either side
  if (type === 11) return 120; // sharp right
  if ([2, 5, 10, 18, 20, 23].includes(type)) return 90; // right family
  if (type === 9) return 35; // slight right
  if (type === 14) return -120; // sharp left
  if ([3, 6, 15, 19, 21, 24].includes(type)) return -90; // left family
  if (type === 16) return -35; // slight left
  return 0; // straight / continue / start / destination / merge / unknown
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function svgArrowIcon(direction: "left" | "right"): SVGSVGElement {
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = svgEl("path");
  path.setAttribute("d", direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7");
  svg.appendChild(path);
  return svg;
}

/** The center card's directional glyph — a plain up-arrow, rotated per
 *  `maneuverGlyphRotationDeg`. */
function svgManeuverIcon(): SVGSVGElement {
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("nav-hud__icon-arrow");
  const path = svgEl("path");
  path.setAttribute("d", "M12 20V4M12 4l-6 6M12 4l6 6");
  svg.appendChild(path);
  return svg;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The session doc's retained destination — only the fields a re-route's
 *  `GET /route` call needs. See `ride-session.ts`'s `RideSessionDest` for
 *  the full shape the caller reads this from (`label`/`inCoverage` don't
 *  matter here). */
export interface NavHudDest {
  lat: number;
  lon: number;
}

/** Reported after a successful off-route re-route so the caller can, e.g.,
 *  redraw a MapLibre route source. Purely informational — this module's own
 *  center card and side panel already reflect the new maneuvers on their
 *  own; nothing requires the caller to act on this. */
export interface NavHudRouteUpdate {
  /** `[lng, lat]` pairs — GeoJSON order, straight from the fresh
   *  `/route` response's `geometry.coordinates`. */
  coordinates: LngLatCoord[];
  maneuvers: RouteManeuver[];
}

export interface NavHudOptions {
  /** The Screen 4 choice, read directly off the session doc's `route`
   *  field (`ride-session.ts`'s `RideSessionRoute`) — `polyline` seeds the
   *  initial shape, `maneuvers` seeds the initial instruction list,
   *  `profile` is the ONLY profile a re-route ever requests. `rideRouteId`/
   *  `distanceM`/`durationS` are read but otherwise untouched: this module
   *  never calls `postRideRoute` and never mutates the session doc itself —
   *  a re-route's new geometry is reported via `onRouteUpdate`, and it is
   *  the CALLER's decision whether/how to persist it. */
  route: RideSessionRoute;
  /** The session doc's retained destination — the off-route re-router's
   *  target. Required: this module is only ever constructed when a route
   *  (and therefore a destination) is active — an out-of-coverage /
   *  nav-off ride never calls `createNavHud` at all. */
  dest: NavHudDest;
  /** The selected device's model, when known — passed through to
   *  `fetchRoute`'s `vehicle_model` on re-route so range/battery-aware
   *  routing stays consistent with Screen 4's original request. Optional:
   *  own-device rides and guest rides may have none. */
  vehicleModel?: string | null;
  /** Fired once, when a press-and-hold on either corner arrow dismisses
   *  guidance. This module tears its own DOM out of `container` and stops
   *  reacting to `feedFix` calls immediately afterward — the caller does
   *  NOT need to call `dispose()` in response, though doing so is a
   *  harmless no-op (`dispose()` is idempotent and safe to call either way,
   *  including after a dismiss). */
  onDismiss: () => void;
  /** Fired whenever the left/right panel's open state changes — `null`
   *  when neither is open (including once on dismiss). The CALLER owns
   *  applying whatever CSS class it uses for "the ride root is compressed"
   *  (the frontend plan's example: `nav-compressed-left` /
   *  `nav-compressed-right`) to whatever element it considers the ride
   *  root — this module only ever touches `container` and its own
   *  children, never anything outside it. */
  onCompress: (side: "left" | "right" | null) => void;
  /** Fired after a successful off-route re-route. See `NavHudRouteUpdate`. */
  onRouteUpdate?: (update: NavHudRouteUpdate) => void;
  /** Injected for tests; defaults to `api.ts`'s `fetchRoute`. */
  fetchRoute?: (
    q: Parameters<typeof apiFetchRoute>[0],
    signal?: AbortSignal,
  ) => Promise<RouteResponse>;
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface NavHud {
  /** Feed one GPS fix. `accuracy` (meters) is part of the contract for a
   *  future confidence-weighted match but is not read today — the frontend
   *  plan's off-route test is purely distance+time based. */
  feedFix(lat: number, lng: number, accuracy?: number | null): void;
  /** Tear down: remove this module's DOM from `container`, cancel any
   *  in-flight re-route, clear timers. Idempotent — safe to call more than
   *  once, and safe to call after a press-and-hold dismiss already tore
   *  things down (does NOT re-fire `onDismiss`). */
  dispose(): void;
}

/** Build the Screen 7 nav overlay as children of `container` (never removed
 *  or replaced wholesale — only its own appended children come and go, so a
 *  caller that reuses one `container` element across rides gets it back
 *  clean after `dispose()`). See the module header for the full behavioral
 *  spec; `NavHudOptions` above documents every callback's exact contract. */
export function createNavHud(
  container: HTMLElement,
  opts: NavHudOptions,
): NavHud {
  const fetchRouteFn = opts.fetchRoute ?? apiFetchRoute;
  const now = opts.now ?? (() => Date.now());

  let coords: LngLatCoord[] = decodePolyline(opts.route.polyline);
  let maneuvers: RouteManeuver[] = opts.route.maneuvers.slice();
  let profile = opts.route.profile;
  let lastMatchedIndex = 0;
  let currentManeuverIdx = 0;
  let offRoute: OffRouteState = { ...INITIAL_OFF_ROUTE_STATE };
  let panelSide: "left" | "right" | null = null;
  let destroyed = false;
  let rerouteAbort: AbortController | null = null;
  let leftHoldTimer: number | undefined;
  let rightHoldTimer: number | undefined;
  const cleanupFns: Array<() => void> = [];

  // ---------------- DOM ----------------
  container.classList.add("nav-hud");

  const bar = document.createElement("div");
  bar.className = "nav-hud__bar";

  const leftBtn = document.createElement("button");
  leftBtn.type = "button";
  leftBtn.className = "nav-hud__arrow nav-hud__arrow--left";
  leftBtn.setAttribute("aria-pressed", "false");
  leftBtn.setAttribute(
    "aria-label",
    "Show turn-by-turn directions on the left. Press and hold to dismiss navigation.",
  );
  leftBtn.appendChild(svgArrowIcon("left"));

  const card = document.createElement("div");
  card.className = "nav-hud__card";
  const iconWrap = document.createElement("div");
  iconWrap.className = "nav-hud__icon";
  const iconArrow = svgManeuverIcon();
  iconWrap.appendChild(iconArrow);
  const textWrap = document.createElement("div");
  textWrap.className = "nav-hud__text";
  const instructionEl = document.createElement("div");
  instructionEl.className = "nav-hud__instruction";
  const metaEl = document.createElement("div");
  metaEl.className = "nav-hud__meta";
  textWrap.append(instructionEl, metaEl);
  card.append(iconWrap, textWrap);

  const rightBtn = document.createElement("button");
  rightBtn.type = "button";
  rightBtn.className = "nav-hud__arrow nav-hud__arrow--right";
  rightBtn.setAttribute("aria-pressed", "false");
  rightBtn.setAttribute(
    "aria-label",
    "Show turn-by-turn directions on the right. Press and hold to dismiss navigation.",
  );
  rightBtn.appendChild(svgArrowIcon("right"));

  bar.append(leftBtn, card, rightBtn);

  const panel = document.createElement("div");
  panel.className = "nav-hud__panel";
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Turn-by-turn directions");

  const panelHead = document.createElement("div");
  panelHead.className = "nav-hud__panel-head";
  const panelTitle = document.createElement("span");
  panelTitle.textContent = "Directions";
  const panelClose = document.createElement("button");
  panelClose.type = "button";
  panelClose.className = "nav-hud__panel-close";
  panelClose.setAttribute("aria-label", "Close directions list");
  panelClose.textContent = "×";
  panelHead.append(panelTitle, panelClose);

  const stepsList = document.createElement("ol");
  stepsList.className = "nav-hud__steps";

  panel.append(panelHead, stepsList);

  container.append(bar, panel);

  // ---------------- panel + dismiss state machine ----------------

  function setPanelSide(side: "left" | "right" | null): void {
    panelSide = side;
    panel.hidden = side === null;
    panel.classList.toggle("nav-hud__panel--left", side === "left");
    panel.classList.toggle("nav-hud__panel--right", side === "right");
    leftBtn.setAttribute("aria-pressed", String(side === "left"));
    rightBtn.setAttribute("aria-pressed", String(side === "right"));
    opts.onCompress(side);
  }

  function togglePanel(side: "left" | "right"): void {
    if (destroyed) return;
    setPanelSide(panelSide === side ? null : side);
  }

  const onPanelClose = () => setPanelSide(null);
  panelClose.addEventListener("click", onPanelClose);
  cleanupFns.push(() => panelClose.removeEventListener("click", onPanelClose));

  function teardown(fireDismiss: boolean): void {
    if (destroyed) return;
    destroyed = true;
    window.clearTimeout(leftHoldTimer);
    window.clearTimeout(rightHoldTimer);
    rerouteAbort?.abort();
    for (const fn of cleanupFns) fn();
    bar.remove();
    panel.remove();
    container.classList.remove("nav-hud");
    if (fireDismiss) {
      opts.onCompress(null);
      opts.onDismiss();
    }
  }

  function attachArrow(btn: HTMLButtonElement, side: "left" | "right"): void {
    let held = false;
    const clearHold = () => {
      window.clearTimeout(side === "left" ? leftHoldTimer : rightHoldTimer);
    };
    const onPointerDown = () => {
      if (destroyed) return;
      held = false;
      clearHold();
      const timer = window.setTimeout(() => {
        held = true;
        teardown(true);
      }, NAV_DISMISS_HOLD_MS);
      if (side === "left") leftHoldTimer = timer;
      else rightHoldTimer = timer;
    };
    const onPointerUp = () => clearHold();
    const onClick = () => {
      if (held) {
        // The hold already fired (and tore this module down) — the browser
        // still delivers a trailing click after pointerup regardless of
        // dwell time; swallow it so a long-press dismiss never ALSO toggles
        // a panel that no longer exists.
        held = false;
        return;
      }
      togglePanel(side);
    };
    btn.addEventListener("pointerdown", onPointerDown);
    btn.addEventListener("pointerup", onPointerUp);
    btn.addEventListener("pointerleave", onPointerUp);
    btn.addEventListener("pointercancel", onPointerUp);
    btn.addEventListener("click", onClick);
    cleanupFns.push(() => {
      btn.removeEventListener("pointerdown", onPointerDown);
      btn.removeEventListener("pointerup", onPointerUp);
      btn.removeEventListener("pointerleave", onPointerUp);
      btn.removeEventListener("pointercancel", onPointerUp);
      btn.removeEventListener("click", onClick);
    });
  }
  attachArrow(leftBtn, "left");
  attachArrow(rightBtn, "right");

  // ---------------- rendering ----------------

  function renderCard(): void {
    const maneuver = maneuvers[currentManeuverIdx] ?? null;
    if (!maneuver) {
      instructionEl.textContent = "Follow the route";
      metaEl.textContent = "";
      iconArrow.style.transform = "rotate(0deg)";
      return;
    }
    instructionEl.textContent = maneuver.instruction || "Continue";
    const remaining = distanceAlongCoords(
      coords,
      lastMatchedIndex,
      maneuver.end_shape_index,
    );
    const streets = maneuver.street_names.join(" / ");
    metaEl.textContent = [formatDistanceShort(remaining), streets]
      .filter((s) => s !== "")
      .join(" · ");
    iconArrow.style.transform = `rotate(${maneuverGlyphRotationDeg(maneuver.type)}deg)`;
  }

  function renderPanel(): void {
    stepsList.replaceChildren();
    maneuvers.forEach((m, i) => {
      const li = document.createElement("li");
      li.className = "nav-hud__step";
      if (i === currentManeuverIdx) li.classList.add("is-current");
      if (i < currentManeuverIdx) li.classList.add("is-done");
      const text = document.createElement("span");
      text.className = "nav-hud__step-text";
      text.textContent = m.instruction || "Continue";
      li.appendChild(text);
      if (m.street_names.length > 0) {
        const streets = document.createElement("span");
        streets.className = "nav-hud__step-streets";
        streets.textContent = m.street_names.join(" / ");
        li.appendChild(streets);
      }
      stepsList.appendChild(li);
    });
  }

  renderCard();
  renderPanel();

  // ---------------- off-route re-route ----------------

  async function doReroute(fix: ShapeFix): Promise<void> {
    rerouteAbort?.abort();
    const ac = new AbortController();
    rerouteAbort = ac;
    try {
      const resp = await fetchRouteFn(
        {
          from: [fix.lat, fix.lng],
          to: [opts.dest.lat, opts.dest.lon],
          profile,
          vehicle_model: opts.vehicleModel ?? undefined,
          maneuvers: true,
        },
        ac.signal,
      );
      if (destroyed || ac.signal.aborted) return;
      coords = resp.geometry.coordinates.map(
        (p) => [p[0], p[1]] as LngLatCoord,
      );
      maneuvers = resp.properties.maneuvers ?? [];
      lastMatchedIndex = 0;
      currentManeuverIdx = 0;
      // The excursion is over — a brand new shape starting from "here" —
      // but keep `lastRerouteAtMs` so the cooldown still applies.
      offRoute = { sinceMs: null, lastRerouteAtMs: offRoute.lastRerouteAtMs };
      renderCard();
      renderPanel();
      opts.onRouteUpdate?.({
        coordinates: coords.slice(),
        maneuvers: maneuvers.slice(),
      });
    } catch (err) {
      if (isAbortError(err) || destroyed) return;
      // Rate-limited / out of coverage / offline: keep guiding on the stale
      // route rather than going blank. `lastRerouteAtMs` was already
      // stamped at attempt time, so this failure still counts against the
      // cooldown (no retry storm against the shared `route_ip` budget).
      console.error("ride-nav-hud: off-route re-route failed", err);
    }
  }

  return {
    feedFix(lat, lng, accuracy) {
      // `accuracy` is part of the public contract (room for a future
      // confidence-weighted match) but the spec's off-route test is purely
      // distance+time based — nothing here gates on it today.
      void accuracy;
      if (destroyed) return;
      if (coords.length === 0) return;

      const windowed = advanceMonotonic(
        coords,
        { lat, lng },
        lastMatchedIndex,
        NAV_MATCH_FORWARD_WINDOW_POINTS,
      );
      lastMatchedIndex = windowed.index;
      currentManeuverIdx = currentManeuverIndex(
        maneuvers,
        lastMatchedIndex,
        currentManeuverIdx,
      );

      // Review fix: the off-route sample measures distance to the route
      // LINE (`distanceToLineString`), not to the nearest shape VERTEX — see
      // that function's own doc comment for why vertex distance is wrong
      // here. `nearestShapeIndex`/`advanceMonotonic` above remain the
      // maneuver-advance mechanism; this is a separate, parallel measurement
      // that never affects `lastMatchedIndex`.
      const offRouteDistanceM = distanceToLineString(coords, { lat, lng });
      const decision = noteOffRouteSample(offRoute, offRouteDistanceM, now());
      offRoute = decision.state;

      renderCard();
      renderPanel();

      if (decision.shouldReroute) void doReroute({ lat, lng });
    },
    dispose() {
      teardown(false);
    },
  };
}
