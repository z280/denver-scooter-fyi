// Screen 4 — Route choice (frontend plan, `ride-screen-routes.ts` row; master
// Part 0 Screen 4). Shown IFF navigation is on (mirrors Screen 3's own skip
// rule exactly — ride-modal.ts's module doc: "Screens 3/4 return true when
// navigation is off"). Fires the deployed Valhalla profiles' `/route` calls
// in parallel with `maneuvers=true`; tombstone loading cards with a
// left-to-right shimmer wipe while they're in flight. The screen renders as
// a BOTTOM HALF-DRAWER over the real map (`presentation: "sheet"` —
// ride-modal.ts): route cards in the drawer, and the SELECTED route drawn on
// the main map as a solid line in its profile color via the injected
// `routePreview` handle (`route-preview.ts`), re-framed into the strip above
// the drawer. Each card carries an ℹ that explains what its routing profile
// optimizes for. On NEXT, persists the chosen route via `POST /ride-routes`
// when `nav_improvement` is on — non-blocking, a tolerated 404 until API
// phase A3 deploys the endpoint.
//
// ---------------------------------------------------------------------------
// DEVIATION 1 — RESOLVED. This screen originally built its own small
// MapLibre instance inside the secondary pane (the modal shell exposed no
// map handle, and this lane couldn't edit ride-modal.ts). The sheet
// presentation dissolves the problem from the other side: the MAIN map is
// simply visible behind the drawer, and the integrator (main.ts) injects a
// `RoutePreviewHandle` bound to it — no second MapLibre instance, no
// double-loaded tiles, and the rider inspects their route on the same map
// they'll ride it on.
//
// DEVIATION 2 — route origin ("the resolved device/start position").
//
// `RideSessionDevice` (ride-session.ts, not this lane's to edit) carries no
// coordinates — only `vehicleIdentifier`/`plate`/`model`/`batteryConfirmed`,
// or `{ own: true }`. The plan's own language for "where the rider is"
// throughout Screens 2/3 is "the resolved GPS position" (`Locate.current()`),
// which is also accurate to within the "next to" scale Decision 4 promises
// (≤~8 m for an auto-preselected device). `resolveOrigin()` below uses that
// fix as the primary source, falling back to a `devices.ts` feed lookup by
// `vehicleIdentifier` (an OPTIONAL injected dependency) only when GPS is
// unavailable — never the reverse, since the live fix is fresher than a
// snapshot from whenever the device list last refreshed.
//
// DEVIATION 3 — out-of-coverage handling: inline degrade, not a skip rule.
//
// The brief offered two options ("skip this screen or gracefully show only
// in-coverage profiles / a message"). This screen does NOT fold coverage into
// the `skip()` predicate: `ride-modal.ts`'s own comments attribute the
// Screens-3/4 skip rule to `navigation` alone, `RideScreenSkipContext` is
// deliberately read-only (no session mutation from a gate — see that file's
// comments), and the AUTHORITATIVE coverage signal is `/route`'s own
// `out_of_coverage` 400 (api.ts's `fetchRoute` doc), not Screen 3's
// `in_coverage` hint (a coarser, advisory flag riders can already override by
// picking a greyed-out result — see `ride-screen-dest.ts`). So: every profile
// is always attempted; a PARTIAL failure renders only the profiles that
// resolved ("gracefully show only in-coverage profiles"); a TOTAL failure
// (all four out of coverage / erroring) swaps the whole screen for a
// "direct route not available, navigation will be off" message with a
// [Continue without navigation] button that clears `navigation` and
// `nav_improvement` on the session's `RideOptions` and advances — the
// "nav off, ride proceeds" graceful degrade the master plan calls for.
// ---------------------------------------------------------------------------

import {
  registerRideScreen,
  type RideScreen,
  type RideScreenContext,
} from "./ride-modal.ts";
import { distanceMeters, type Locate, type LngLat } from "./locate.ts";
import type { Devices } from "./devices.ts";
import type { RideDestWithCoverage } from "./ride-screen-dest.ts";
import {
  selectedDevice,
  type RideSessionDoc,
  type RideSessionRoute,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  ApiError,
  fetchRoute as defaultFetchRoute,
  fetchRouteOptions as defaultFetchRouteOptions,
  postRideRoute as defaultPostRideRoute,
  type PostRideRouteIn,
  type PostRideRouteResponse,
  type RouteOption,
  type RouteOptionsResponse,
  type RouteProfile,
  type RouteProfilesResponse,
  type RouteQuery,
  type RouteResponse,
} from "./api.ts";
import { encodePolyline } from "./polyline-encode.ts";
import { rideModalRoot } from "./ride-modal.ts";
import type { RoutePreviewHandle } from "./route-preview.ts";
import type { LngLatBoundsLike } from "maplibre-gl";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type SessionLike = Pick<RideSessionStore, "current" | "dispatch" | "patch">;

/** Read-only: GPS enablement is Screen 1's job; this screen only ever reads
 *  the resolved fix. */
export type LocateLike = Pick<Locate, "current">;

/** Optional — only used to refine the route ORIGIN when GPS is unavailable;
 *  see DEVIATION 2 above. */
export type DevicesLike = Pick<Devices, "allFeatures">;

export interface RideScreenRoutesDeps {
  session: SessionLike;
  locate: LocateLike;
  /** Injected for tests; omit in production to skip the device-feed origin
   *  refinement entirely (GPS-only). */
  devices?: DevicesLike;
  /** Injected for tests; defaults to `api.ts`'s `fetchRouteProfiles`. */
  fetchRouteProfiles?(signal?: AbortSignal): Promise<RouteProfilesResponse>;
  /** Injected for tests; defaults to `api.ts`'s `fetchRoute`. Still used for
   *  ONE call, at the moment of commitment, to fetch turn-by-turn for the
   *  route the rider actually chose — see `advance`. */
  fetchRoute?(q: RouteQuery, signal?: AbortSignal): Promise<RouteResponse>;
  /** Injected for tests; defaults to `api.ts`'s `fetchRouteOptions`. */
  fetchRouteOptions?(
    q: { from: [number, number]; to: [number, number]; vehicle_model?: string;
         battery_percent?: number | null },
    signal?: AbortSignal,
  ): Promise<RouteOptionsResponse>;
  /** Injected for tests; defaults to `api.ts`'s `postRideRoute`. Never called
   *  with an abort signal tied to this screen's lifetime — see the NEXT
   *  handler: the POST must outlive the screen (non-blocking ≠ discarded). */
  postRideRoute?(body: PostRideRouteIn): Promise<PostRideRouteResponse>;
  /** The main map's route-preview layers (`route-preview.ts`), injected by
   *  the integrator. Optional so the screen still works with nothing behind
   *  the drawer (a test, or a headless build) — the cards and their ℹ
   *  copy carry the choice on their own. */
  routePreview?: RoutePreviewHandle;
}

/** Register Screen 4. Call once at startup; returns an unregister function
 *  for tests/HMR. */
export function wireRideScreenRoutes(deps: RideScreenRoutesDeps): () => void {
  return registerRideScreen("4", {
    // Mirrors ride-screen-dest.ts's Screen 3 skip rule exactly (DEVIATION 3).
    skip: () => !(deps.session.current()?.options.navigation ?? false),
    factory: (ctx) => buildRoutesScreen(ctx, deps),
  });
}

// ---------------------------------------------------------------------------
// Tunables / fallbacks
// ---------------------------------------------------------------------------

/** Colorblind-safe (Okabe–Ito), one per deployed Valhalla profile — see
 *  `colorForProfile` for the fallback an unrecognized future key gets. */
/** One Okabe–Ito color per profile, assigned for SEMANTIC fit: green for
 *  the tree canopy, the palette's one purple for the night ride, deep blue
 *  for safety, orange for the express hustle, sky blue for range (the
 *  neutral leftover — nothing about battery is a color). All five stay
 *  inside the palette, so every pair remains distinguishable under
 *  color-vision deficiency; the two blues also differ strongly in
 *  lightness. */
export const PROFILE_COLORS: Record<string, string> = {
  safe: "#0072B2",
  range: "#56B4E9",
  shade: "#009E73",
  night: "#CC79A7",
  express: "#E69F00",
};
export const FALLBACK_PROFILE_COLOR = "#8a8f98";

export function colorForProfile(key: string): string {
  return PROFILE_COLORS[key] ?? FALLBACK_PROFILE_COLOR;
}

/** Last-resort profile list, used ONLY when `GET /route/profiles` itself is
 *  unreachable (never for the normal path — that always calls the live
 *  endpoint, per the lane brief's "confirm... rather than hardcoding").
 *  Labels are the master vision's own Screen 4 copy, so this is a safety net
 *  against a dead sidecar, not a second source of truth. */
export const FALLBACK_PROFILES: RouteProfile[] = [
  { key: "safe", label: "Safe & Protected", shade_ranked: false },
  { key: "range", label: "The Range Maximizer", shade_ranked: false },
  { key: "shade", label: "The Shaded Canopy", shade_ranked: true },
  { key: "night", label: "Night Owl", shade_ranked: false },
  { key: "express", label: "Commuter Express", shade_ranked: false },
];

const TOMBSTONE_COUNT = 4;

/** What each routing profile optimizes for — the ℹ copy on every route
 *  card. Grounded in the Screen 2 "Destination Navigation" modal's own
 *  description of the four styles; an unrecognized future profile gets the
 *  honest generic line rather than silence. */
export const PROFILE_INFO: Record<string, string> = {
  safe:
    "Prioritizes protected bike lanes, trails, and calm streets, and specifically avoids roads on the City of Denver's High Injury Network. The safest way there, even when it isn't the shortest.",
  range:
    "Avoids hills and stop-start climbs to stretch your battery — the route that gets there on the fewest percentage points.",
  shade:
    "Prefers tree cover and shadowed streets to keep you out of the sun as much as possible. Best on hot, bright afternoons.",
  night:
    "Night Owl routes are optimized for safe riding after dark, preferring streets — which are more likely to be lit and have people around — over dark, isolated trails.",
  express:
    "The most direct route — fewest detours, fastest arrival, traded against the safety, battery, and shade the other styles optimize for.",
};

export const FALLBACK_PROFILE_INFO =
  "A routing style from our directions engine — select it to see its shape on the map.";

export function profileInfoText(key: string): string {
  return PROFILE_INFO[key] ?? FALLBACK_PROFILE_INFO;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit tests)
// ---------------------------------------------------------------------------

export type RouteState =
  | { key: string; label: string; status: "loading" }
  | {
      key: string;
      label: string;
      status: "ready";
      response: RouteResponse;
      /** The deduped option this row came from, when it came from
       *  `/route/options` — carries the folded profile names and the arrival
       *  battery, neither of which fits in a `/route` Feature. Absent for a
       *  row built any other way. */
      option?: RouteOption;
    }
  | { key: string; label: string; status: "error" };

export function countByStatus(
  results: ReadonlyMap<string, RouteState>,
  status: RouteState["status"],
): number {
  let n = 0;
  for (const s of results.values()) if (s.status === status) n += 1;
  return n;
}

export function allSettled(results: ReadonlyMap<string, RouteState>): boolean {
  for (const s of results.values()) if (s.status === "loading") return false;
  return true;
}

/** Miles, one decimal; a very short leg reads "<0.1 mi" rather than a
 *  misleadingly precise "0.0 mi". */
export function formatMiles(meters: number): string {
  const mi = meters / 1609.344;
  if (mi < 0.05) return "<0.1 mi";
  return `${mi.toFixed(1)} mi`;
}

/** Whole minutes, floored at 1 — a sub-minute route still reads "1 min", not
 *  the more alarming "0 min". */
export function formatMinutes(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** Fallback distance when `RouteProperties.distance_meters` is null (the
 *  wire type allows it) — sums the LineString's own segments so the toggle
 *  card and the `/ride-routes` POST always have a number. */
export function lineStringLengthMeters(
  coords: readonly GeoJSON.Position[],
): number {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const [lngA, latA] = coords[i - 1];
    const [lngB, latB] = coords[i];
    total += distanceMeters({ lng: lngA, lat: latA }, { lng: lngB, lat: latB });
  }
  return total;
}

/** The route ORIGIN — see DEVIATION 2. GPS fix first (freshest, and the
 *  language every other ride screen uses); the selected device's last feed
 *  position only as a fallback, and only when `deps.devices` was injected. */
export function resolveOrigin(
  doc: RideSessionDoc,
  deps: Pick<RideScreenRoutesDeps, "locate" | "devices">,
): LngLat | null {
  const fix = deps.locate.current();
  if (fix) return fix;
  const sel = selectedDevice(doc.device);
  if (sel && deps.devices) {
    const match = deps.devices
      .allFeatures()
      .find((f) => f.properties.vehicle_identifier === sel.vehicleIdentifier);
    if (match) {
      const [lng, lat] = match.geometry.coordinates;
      return { lng, lat };
    }
  }
  return null;
}

/** Screen 4's origin/destination marker colors on the main-map preview —
 *  the same pair the old embedded map used. */
export const ORIGIN_MARKER_COLOR = "#0072B2";
export const DEST_MARKER_COLOR = "#D55E00";

function pointFeature(
  lng: number,
  lat: number,
  kind: "origin" | "dest",
): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: {
      kind,
      color: kind === "origin" ? ORIGIN_MARKER_COLOR : DEST_MARKER_COLOR,
    },
    geometry: { type: "Point", coordinates: [lng, lat] },
  };
}

/** What the main map draws while the drawer is up: origin + destination
 *  dots, and THE SELECTED ROUTE (only) as a solid line in its profile
 *  color — a route's shape appears when the rider selects its card, and
 *  swaps when they pick another. Nothing selected (still loading, or every
 *  profile failed) draws just the two dots. */
export function buildPreviewFeatureCollection(
  origin: LngLat,
  dest: RideDestWithCoverage,
  results: ReadonlyMap<string, RouteState>,
  selected: string | null,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [
    pointFeature(origin.lng, origin.lat, "origin"),
    pointFeature(dest.lon, dest.lat, "dest"),
  ];
  const state = selected ? results.get(selected) : undefined;
  if (state?.status === "ready") {
    features.push({
      type: "Feature",
      properties: { profile: state.key, color: colorForProfile(state.key) },
      geometry: state.response.geometry,
    });
  }
  return { type: "FeatureCollection", features };
}

/** Bounding box of origin + destination + the SELECTED route's shape (the
 *  only one drawn) — always at least the two points, since
 *  `buildLoadedScreen` only runs once both exist. Pass `selected: null` to
 *  frame every loaded route instead. */
export function computeBounds(
  origin: LngLat,
  dest: RideDestWithCoverage,
  results: ReadonlyMap<string, RouteState>,
  selected: string | null = null,
): LngLatBoundsLike {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const extend = (lng: number, lat: number): void => {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };
  extend(origin.lng, origin.lat);
  extend(dest.lon, dest.lat);
  for (const state of results.values()) {
    if (state.status !== "ready") continue;
    if (selected !== null && state.key !== selected) continue;
    for (const [lng, lat] of state.response.geometry.coordinates) extend(lng, lat);
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/** Screen 8/9's nav-off degrade: clears BOTH `navigation` and
 *  `nav_improvement` (there is nothing left for either to do once no route
 *  was chosen or persisted for this ride) and drops any half-set route. A
 *  no-op when navigation is already off, so calling this speculatively never
 *  spuriously re-persists the session doc. */
export function clearNavigationForRide(
  deps: Pick<RideScreenRoutesDeps, "session">,
  doc: RideSessionDoc,
): void {
  if (doc.options.navigation || doc.options.nav_improvement) {
    deps.session.dispatch({
      type: "setOptions",
      options: { ...doc.options, navigation: false, nav_improvement: false },
    });
  }
  if (doc.route !== null) {
    deps.session.dispatch({ type: "setRoute", route: null });
  }
}

// ---------------------------------------------------------------------------
// Screen build
// ---------------------------------------------------------------------------

function buildRoutesScreen(
  ctx: RideScreenContext,
  deps: RideScreenRoutesDeps,
): RideScreen {
  const doc = deps.session.current();
  const dest = doc ? (doc.dest as RideDestWithCoverage | null) : null;
  const origin = doc ? resolveOrigin(doc, deps) : null;

  if (!doc || !dest || !origin) {
    return buildDegradeScreen(
      ctx,
      deps,
      doc,
      "We couldn't work out where to route from or to for this ride — you can still ride, just without turn-by-turn.",
    );
  }
  return buildLoadedScreen(ctx, deps, doc, origin, dest);
}

// ---------------- degrade screen (missing info, or every profile failed) ---

function buildDegradeScreen(
  ctx: RideScreenContext,
  deps: RideScreenRoutesDeps,
  doc: RideSessionDoc | null,
  message: string,
): RideScreen {
  let destroyed = false;

  const wrap = el("div", "ride-modal__placeholder ride-route-degrade");
  wrap.append(
    el("p", "ride-modal__lede", "Direct route not available"),
    el("p", "ride-modal__hint", message),
  );
  const continueWithoutNav = (): void => {
    if (destroyed) return;
    const fresh = deps.session.current() ?? doc;
    if (fresh) clearNavigationForRide(deps, fresh);
    ctx.next();
  };
  const continueBtn = el("button", "login-btn", "Continue without navigation");
  continueBtn.type = "button";
  continueBtn.addEventListener("click", continueWithoutNav);
  wrap.append(continueBtn);

  // Nothing is missing here — the only way forward is "continue without
  // navigation", and the header Next does exactly that.
  ctx.setNextEnabled(true);

  return {
    title: "Choose your route",
    primary: wrap,
    initialFocus: continueBtn,
    onHeaderNext: continueWithoutNav,
    destroy() {
      destroyed = true;
    },
  };
}

// ---------------- loaded screen (normal path) -------------------------------

function buildLoadedScreen(
  ctx: RideScreenContext,
  deps: RideScreenRoutesDeps,
  doc: RideSessionDoc,
  origin: LngLat,
  dest: RideDestWithCoverage,
): RideScreen {
  let destroyed = false;
  const abort = new AbortController();

  let results = new Map<string, RouteState>();
  /** Profile keys the server could not route at all, so the status line can
   *  account for them instead of quietly showing a shorter list. */
  let unavailable: string[] = [];
  /** Explicit, rather than inferred from `results.size === 0`. The old screen
   *  seeded one entry per profile before fetching, so an empty map could only
   *  mean "not started"; one call that FAILS also leaves it empty, and reading
   *  that as "still loading" left the rider on a spinner forever instead of on
   *  the documented degrade. */
  let loaded = false;
  /** The beta notice now arrives once, on the response, rather than repeated
   *  on every option. Held so `advance` can carry it into the session route —
   *  the nav HUD keeps showing it for the whole ride. */
  let betaWarning: string | null = null;
  let selectedProfile: string | null = null;
  /** Close function for the open profile-ℹ modal, if any — closed on
   *  re-open (one at a time) and on screen teardown, same discipline as
   *  ride-settings.ts's options panel. */
  let closeInfoModal: (() => void) | null = null;

  // ---------------- primary pane (toggle list) ----------------
  const statusEl = el("p", "ride-modal__hint ride-route-status");
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  // The API's directions-are-beta disclaimer, shown wherever directions are
  // rendered (the /route contract). Text comes off the response, never
  // hardcoded — the field disappears when directions leave beta and this
  // line disappears with it.
  const betaEl = el("p", "ride-modal__hint ride-route-beta");
  betaEl.hidden = true;
  const listEl = el("ol", "ride-options ride-route-list");
  const nextBtn = el("button", "login-btn ride-route-next", "NEXT >>");
  nextBtn.type = "button";
  nextBtn.disabled = true;
  const controls = el("div", "ride-route-controls");
  controls.append(nextBtn);

  const primary = el("div", "ride-wizard__body ride-route-panel");
  primary.append(
    el("h3", "ride-modal__lede", "Choose your route"),
    statusEl,
    betaEl,
    listEl,
    controls,
  );

  // ---------------- main-map preview ----------------
  // The drawer covers the bottom half; the selected route draws on the real
  // map above it through the injected handle. Every render pushes the fresh
  // FeatureCollection (selected route only, solid, profile-colored) plus
  // the bounds to frame in the visible strip.
  function renderPreview(): void {
    deps.routePreview?.set(
      buildPreviewFeatureCollection(origin, dest, results, selectedProfile),
      computeBounds(origin, dest, results, selectedProfile),
    );
  }

  // ---------------- data loading ----------------
  void loadRoutes();

  async function loadRoutes(): Promise<void> {
    // ONE call, not one-per-profile-plus-a-profile-list.
    //
    // Asking for every profile separately offered the rider five choices that
    // were two or three roads, and let two of them quote different durations
    // for a byte-identical shape. The server now groups by the shape that
    // comes back and returns one option per ROAD, so the list is choices
    // rather than synonyms, and there is no second number to contradict the
    // first. It also carries each option's own geometry, which is why the
    // preview needs no follow-up request.
    let resp: RouteOptionsResponse;
    try {
      resp = await (deps.fetchRouteOptions ?? defaultFetchRouteOptions)(
        {
          from: [origin.lat, origin.lng],
          to: [dest.lat, dest.lon],
          vehicle_model: selectedDevice(doc.device)?.model ?? undefined,
          // The charge the rider confirmed at the scooter, so every row can
          // say what will be left on arrival rather than only what it spends.
          // Null for an own-device ride today: RideSessionOwnDevice carries
          // no charge, so there is nothing honest to send. Every row then
          // shows the burn without an arrival figure, which is the truthful
          // degrade rather than a guess.
          battery_percent: selectedDevice(doc.device)?.batteryConfirmed ?? null,
        },
        abort.signal,
      );
    } catch (e) {
      if (destroyed) return;
      if (!isAbortError(e)) console.error("route options fetch failed", e);
      // Total failure is the documented degrade: nav off, the ride proceeds.
      results = new Map();
      loaded = true;
      render();
      return;
    }
    if (destroyed) return;

    unavailable = resp.profiles_unavailable ?? [];
    betaWarning = resp.beta_warning ?? null;
    if (betaWarning && betaEl.hidden) {
      betaEl.textContent = `⚠️ ${betaWarning}`;
      betaEl.hidden = false;
    }

    results = new Map(
      resp.options.map((o) => [o.key, {
        key: o.key,
        label: o.label,
        status: "ready" as const,
        option: o,
        response: optionAsRoute(o),
      }]),
    );
    if (selectedProfile === null || !results.has(selectedProfile)) {
      selectedProfile = resp.options[0]?.key ?? null;
    }
    loaded = true;
    render();
  }

  /** An option, shaped like the `/route` Feature the rest of this screen (and
   *  the session doc) already speaks. Keeps the rewiring to the fetch. */
  function optionAsRoute(o: RouteOption): RouteResponse {
    const { geometry, ...properties } = o;
    return {
      type: "Feature",
      geometry,
      properties: properties as unknown as RouteResponse["properties"],
    } as RouteResponse;
  }

  // ---------------- selection ----------------
  function select(key: string): void {
    if (destroyed) return;
    const s = results.get(key);
    if (s?.status !== "ready") return;
    selectedProfile = key;
    render();
  }

  // ---------------- advance ----------------
  /** Turn-by-turn for the route the rider actually chose.
   *
   *  `/route/options` deliberately omits maneuvers: they roughly double a
   *  response, and paying that for every option to use one of them is exactly
   *  the waste the single-call rewrite removed. So they are fetched once, at
   *  the moment of commitment, for the one profile that won.
   *
   *  Never fatal. A ride with a drawn line and no spoken turns is a worse
   *  ride; a ride that refuses to start because a second request failed is
   *  not a ride at all. */
  async function maneuversFor(key: string): Promise<RideSessionRoute["maneuvers"]> {
    try {
      const rr = await (deps.fetchRoute ?? defaultFetchRoute)(
        {
          from: [origin.lat, origin.lng],
          to: [dest.lat, dest.lon],
          profile: key,
          vehicle_model: selectedDevice(doc.device)?.model ?? undefined,
          maneuvers: true,
        },
        abort.signal,
      );
      return rr.properties.maneuvers ?? [];
    } catch (e) {
      if (!isAbortError(e)) console.error("maneuvers fetch failed", e);
      return [];
    }
  }

  function advance(): void {
    if (destroyed) return;
    const fresh = deps.session.current() ?? doc;
    const state = selectedProfile ? results.get(selectedProfile) : undefined;
    if (!selectedProfile || state?.status !== "ready") {
      // Nothing usable was ever selected (every profile out of coverage /
      // erroring) — the graceful degrade: nav off, ride proceeds.
      clearNavigationForRide(deps, fresh);
      ctx.next();
      return;
    }
    const chosen = state.response;
    const sessionRoute: RideSessionRoute = {
      profile: selectedProfile,
      rideRouteId: null,
      distanceM:
        chosen.properties.distance_meters ??
        lineStringLengthMeters(chosen.geometry.coordinates),
      durationS: chosen.properties.duration_seconds,
      polyline: encodePolyline(
        chosen.geometry.coordinates.map(
          ([lng, lat]) => [lng, lat] as [number, number],
        ),
      ),
      maneuvers: chosen.properties.maneuvers ?? [],
      betaWarning: betaWarning ?? chosen.properties.beta_warning ?? null,
    };
    deps.session.dispatch({ type: "setRoute", route: sessionRoute });
    // Turns arrive a moment later and patch the route in place, so the flow
    // never waits on a second request to move forward.
    const chosenKey = selectedProfile;
    if (sessionRoute.maneuvers.length === 0) {
      void maneuversFor(chosenKey).then((maneuvers) => {
        if (maneuvers.length === 0) return;
        const live = deps.session.current();
        if (live?.route?.profile !== chosenKey) return;
        deps.session.dispatch({
          type: "setRoute",
          route: { ...live.route, maneuvers },
        });
      });
    }
    // Advance FIRST — the POST is non-blocking (frontend plan: "route choice
    // must proceed... until A3 deploys"). Fired after `ctx.next()` so it
    // survives this screen's teardown; `persistRoute` re-reads the session
    // fresh before patching, never touches `destroyed`.
    ctx.next();
    void persistRoute(deps, fresh, selectedProfile, chosen, origin, dest);
  }
  nextBtn.addEventListener("click", () => advance());

  // ---------------- render ----------------
  function render(): void {
    const loadingProfiles = !loaded;
    const readyCount = countByStatus(results, "ready");
    const settled = !loadingProfiles && allSettled(results);

    if (loadingProfiles) {
      statusEl.textContent = "Loading route options…";
    } else if (readyCount === 0 && settled) {
      statusEl.textContent =
        "No routes are available for this trip — you can continue without navigation.";
    } else if (unavailable.length > 0) {
      // The server names the profiles it could not route — the High Injury
      // Network exclusions mean `safe` can legitimately find nothing where
      // `express` does. Say so rather than silently offering a shorter list.
      const total = results.size + unavailable.length;
      statusEl.textContent = `${results.size} of ${total} route styles are available for this trip.`;
    } else if (readyCount < results.size) {
      statusEl.textContent = `${readyCount} of ${results.size} route styles are available for this trip.`;
    } else {
      statusEl.textContent = "";
    }
    statusEl.hidden = statusEl.textContent === "";

    listEl.replaceChildren();
    if (loadingProfiles) {
      for (let i = 0; i < TOMBSTONE_COUNT; i += 1) listEl.append(tombstoneRow());
    } else {
      for (const state of results.values()) {
        if (state.status === "error") continue;
        listEl.append(state.status === "loading" ? tombstoneRow() : routeRow(state));
      }
    }

    nextBtn.textContent =
      readyCount === 0 && settled ? "Continue without navigation" : "NEXT >>";
    nextBtn.disabled =
      loadingProfiles || (readyCount === 0 && !settled) || (readyCount > 0 && selectedProfile === null);
    // The header Next mirrors the pane's own button — same enablement, and
    // the same `advance()` (via `onHeaderNext`), so the route pick is
    // committed to the session whichever button the rider reaches for.
    ctx.setNextEnabled(!nextBtn.disabled);

    renderPreview();
  }

  function tombstoneRow(): HTMLElement {
    const li = el("li");
    const card = el("div", "ride-option ride-route-tombstone");
    card.setAttribute("aria-hidden", "true");
    card.append(
      el("div", "ride-route-tombstone__bar ride-route-tombstone__bar--title"),
      el("div", "ride-route-tombstone__bar ride-route-tombstone__bar--meta"),
    );
    li.append(card);
    return li;
  }

  function routeRow(state: Extract<RouteState, { status: "ready" }>): HTMLElement {
    // The select button and the ℹ button are SIBLINGS in a flex row — a
    // button nested inside a button is invalid HTML and double-fires the
    // outer click on some engines.
    const li = el("li", "ride-route-item");
    const btn = el("button", "ride-option ride-route-option");
    btn.type = "button";
    btn.dataset.profile = state.key;
    const isSelected = state.key === selectedProfile;
    btn.classList.toggle("is-selected", isSelected);
    btn.setAttribute("aria-pressed", isSelected ? "true" : "false");

    const title = el("div", "ride-option__title");
    const swatch = el("span", "ride-route-swatch");
    swatch.style.background = colorForProfile(state.key);
    title.append(swatch, document.createTextNode(state.label));

    const rr = state.response;
    const distance = rr.properties.distance_meters ?? lineStringLengthMeters(rr.geometry.coordinates);
    const meta = el(
      "div",
      "ride-option__meta",
      `${formatMiles(distance)} · ${formatMinutes(rr.properties.duration_seconds)}`,
    );

    btn.append(title, meta);

    const opt = state.option;
    if (opt) {
      // The other names for this same road. Folded, not hidden: a rider
      // looking for "the shaded one" can see that it is this one, without
      // being offered it twice.
      if (opt.also.length > 0) {
        // "also the The Shaded Canopy route" — the labels are proper names
        // and several already start with "The", so the sentence supplies no
        // article of its own.
        btn.append(
          el("div", "ride-route-also",
            `Also: ${opt.also.map((a) => a.label).join(" · ")}`),
        );
      }
      // What is in the battery on arrival — the number the rider wants and
      // cannot work out in their head — rather than only what the ride spends.
      if (opt.arrival_percent !== null) {
        const ok = opt.will_make_it !== false;
        const line = el(
          "div",
          `ride-route-battery${ok ? "" : " is-warning"}`,
          ok
            ? `🔋 ~${Math.round(opt.arrival_percent)}% left on arrival`
            : `⚠️ May not make it — as little as ${Math.round(opt.arrival_percent_low ?? 0)}% left`,
        );
        btn.append(line);
      }
    }
    btn.addEventListener("click", () => select(state.key));

    const infoBtn = el("button", "ride-route-info", "ℹ");
    infoBtn.type = "button";
    infoBtn.dataset.profileInfo = state.key;
    infoBtn.setAttribute("aria-label", `About the ${state.label} route style`);
    infoBtn.setAttribute("aria-haspopup", "dialog");
    infoBtn.addEventListener("click", () => openProfileInfo(state.key, state.label));

    li.append(btn, infoBtn);
    return li;
  }

  // ---------------- profile ℹ modal ----------------
  // Reuses the shared `.ranks-modal` floating shell (the same classes the
  // Screen 2 ℹ modals and devices.ts's Details modal use) — ride-modal.ts's
  // own Escape handling explicitly defers to an open `.ranks-modal`, which
  // is what lets Escape close THIS without also closing the wizard.
  // Appended into `rideModalRoot()` so the wizard's focus trap tolerates
  // focus landing on the close button.
  function openProfileInfo(key: string, label: string): void {
    closeInfoModal?.();

    const backdrop = el("div", "ranks-modal");
    const card = el("div", "ranks-modal__card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "ride-route-info-title");

    const head = el("div", "ranks-modal__head");
    const heading = el("h3", undefined, label);
    heading.id = "ride-route-info-title";
    const closeBtn = el("button", "ranks-modal__close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    head.append(heading, closeBtn);

    const body = el("div", "ride-info-modal__body");
    body.append(el("p", undefined, profileInfoText(key)));
    card.append(head, body);
    backdrop.append(card);

    const previouslyFocused = document.activeElement;
    let closed = false;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (closeInfoModal === close) closeInfoModal = null;
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        try {
          previouslyFocused.focus();
        } catch {
          /* the launching control went away — nothing to restore to */
        }
      }
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    (rideModalRoot() ?? document.body).append(backdrop);
    try {
      closeBtn.focus();
    } catch {
      /* not focusable yet — the modal still works, just not pre-focused */
    }
    closeInfoModal = close;
  }

  render();

  return {
    title: "Choose your route",
    primary,
    // Bottom half-drawer over the real map — the preview lines above are
    // this screen's "secondary pane" now.
    presentation: "sheet",
    onHeaderNext: advance,
    destroy() {
      destroyed = true;
      abort.abort();
      closeInfoModal?.();
      closeInfoModal = null;
      // Whatever the rider does next (Screen 6, back to 3, close) the
      // preview belongs to this screen alone — the ride's own route line
      // is ride-route-line.ts's job, drawn fresh by the HUD.
      deps.routePreview?.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Route persistence (NEXT) — see the advance() comment above for the
// non-blocking / survives-teardown contract.
// ---------------------------------------------------------------------------

async function persistRoute(
  deps: RideScreenRoutesDeps,
  doc: RideSessionDoc,
  profileKey: string,
  rr: RouteResponse,
  origin: LngLat,
  dest: RideDestWithCoverage,
): Promise<void> {
  if (!doc.options.nav_improvement) return; // consent gate
  const distance = rr.properties.distance_meters ?? lineStringLengthMeters(rr.geometry.coordinates);
  const body: PostRideRouteIn = {
    tracked_ride_id: doc.rideId,
    profile: profileKey,
    origin: [origin.lat, origin.lng],
    destination: [dest.lat, dest.lon],
    route_polyline: encodePolyline(
      rr.geometry.coordinates.map(([lng, lat]) => [lng, lat] as [number, number]),
    ),
    distance_meters: Math.round(Math.min(80_000, Math.max(0, distance))),
    duration_seconds: Math.round(
      Math.min(10_800, Math.max(0, rr.properties.duration_seconds)),
    ),
    battery_percent_estimate: rr.properties.battery_percent_estimate ?? null,
  };
  try {
    const res = await (deps.postRideRoute ?? defaultPostRideRoute)(body);
    // Re-read fresh and only patch if the rider's choice hasn't since moved
    // on (a fast New-Destination re-pick, in principle) — never clobber a
    // newer selection with this stale response.
    const fresh = deps.session.current();
    if (fresh?.route?.profile === profileKey) {
      deps.session.patch({ route: { ...fresh.route, rideRouteId: res.ride_route_id } });
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      // TOLERATED: `POST /ride-routes` ships in API phase A3. `rideRouteId`
      // stays null; nav points are forfeited for this ride, nothing else
      // changes — the ride already advanced past this screen.
      return;
    }
    console.error(
      "POST /ride-routes failed (non-fatal — route choice already advanced)",
      e,
    );
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

// ---------------------------------------------------------------------------
// DOM helper (ride-modal.ts's, verbatim in spirit)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
