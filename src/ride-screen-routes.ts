// Screen 4 — Route choice (frontend plan, `ride-screen-routes.ts` row; master
// Part 0 Screen 4). Shown IFF navigation is on (mirrors Screen 3's own skip
// rule exactly — ride-modal.ts's module doc: "Screens 3/4 return true when
// navigation is off"). Fires the deployed Valhalla profiles' `/route` calls
// in parallel with `maneuvers=true`; tombstone loading cards with a
// left-to-right shimmer wipe while they're in flight; on load, a 40/60 split
// — route toggle cards on the 40 side, all loaded routes drawn on a map
// colored by profile on the 60 side. Selecting a card re-emphasizes it on the
// map (others dimmed, never hidden). On NEXT, persists the chosen route via
// `POST /ride-routes` when `nav_improvement` is on — non-blocking, a
// tolerated 404 until API phase A3 deploys the endpoint.
//
// ---------------------------------------------------------------------------
// DEVIATION 1 — no shared MapLibre instance; this screen builds its own.
//
// `ride-modal.ts`'s `RideScreenContext`/`RideModalHooks` (read in full before
// writing this file) expose NO map handle today — `jumpToDevice` is the only
// map-adjacent hook, and it's a callback into `devices.ts`'s map, not a
// reference this screen could add layers to. Neither sibling F2 screen module
// (`ride-screen-select.ts`, `ride-screen-dest.ts`) takes a map dependency
// either. Adding a `map` field to `RideModalHooks` would mean editing
// `ride-modal.ts`, which this lane does not own (file-ownership rule), and
// code that referenced a hook that doesn't exist yet would fail
// `tsc --noEmit` against the CURRENT repo state.
//
// So: this screen constructs its OWN small MapLibre instance (real
// `maplibre-gl`, a runtime dep already in the app) inside the secondary pane,
// dependency-injected via `deps.createMap` exactly like `ride-screen-dest.ts`
// injects `deps.createSearch` — production gets a real map, tests get a
// fake. It deliberately does NOT reuse `map.ts`'s Protomaps/pmtiles style
// (that would double-load the same vector tiles a second time for a modal
// preview, and re-register the `pmtiles://` protocol from a second call
// site): a flat, theme-matched background color is enough context for "here
// are your route choices," and it keeps this preview map fast, dependency-
// light, and fully self-contained. A `shared_file_edits` entry proposes the
// small `RideModalHooks.map` addition for the integrator, so a future pass
// can swap this out for the shared instance if that's preferred — this
// lane's shipped behavior does not depend on that landing.
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
  fetchRouteProfiles as defaultFetchRouteProfiles,
  postRideRoute as defaultPostRideRoute,
  type PostRideRouteIn,
  type PostRideRouteResponse,
  type RideThemeChoice,
  type RouteProfile,
  type RouteProfilesResponse,
  type RouteQuery,
  type RouteResponse,
} from "./api.ts";
import { encodePolyline } from "./polyline-encode.ts";
import { emptyFC } from "./util.ts";
import { previewBasemapStyle } from "./map.ts";
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MLMap,
} from "maplibre-gl";

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

export type RouteMapFlavor = "light" | "dark";

/** The subset of `maplibre-gl`'s `Map` this screen actually calls — narrow on
 *  purpose so a test double doesn't have to fake the whole class (the
 *  `DevicesLike`/`LocateLike` idiom sibling F2 screens already use). */
export type RouteMapLike = Pick<
  MLMap,
  "addSource" | "getSource" | "addLayer" | "fitBounds" | "resize" | "remove"
>;

export interface RideScreenRoutesDeps {
  session: SessionLike;
  locate: LocateLike;
  /** Injected for tests; omit in production to skip the device-feed origin
   *  refinement entirely (GPS-only). */
  devices?: DevicesLike;
  /** Injected for tests; defaults to `api.ts`'s `fetchRouteProfiles`. */
  fetchRouteProfiles?(signal?: AbortSignal): Promise<RouteProfilesResponse>;
  /** Injected for tests; defaults to `api.ts`'s `fetchRoute`. */
  fetchRoute?(q: RouteQuery, signal?: AbortSignal): Promise<RouteResponse>;
  /** Injected for tests; defaults to `api.ts`'s `postRideRoute`. Never called
   *  with an abort signal tied to this screen's lifetime — see the NEXT
   *  handler: the POST must outlive the screen (non-blocking ≠ discarded). */
  postRideRoute?(body: PostRideRouteIn): Promise<PostRideRouteResponse>;
  /** Injected for tests; production default builds a real, tile-free
   *  MapLibre instance (DEVIATION 1). Resolves once the style has loaded
   *  and the container has a real (non-zero) size. */
  createMap?(
    container: HTMLElement,
    flavor: RouteMapFlavor,
    signal?: AbortSignal,
  ): Promise<RouteMapLike>;
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
export const PROFILE_COLORS: Record<string, string> = {
  safe: "#0072B2",
  range: "#009E73",
  shade: "#CC79A7",
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
  { key: "express", label: "Commuter Express", shade_ranked: false },
];

const TOMBSTONE_COUNT = 4;

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit tests)
// ---------------------------------------------------------------------------

export type RouteState =
  | { key: string; label: string; status: "loading" }
  | { key: string; label: string; status: "ready"; response: RouteResponse }
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

/** `auto` follows the app's LIVE theme first — `data-theme` on the root
 *  element, kept current by theme.ts (manual toggle or sun-sync) — so the
 *  preview map can never sit dark inside a light modal (or vice versa),
 *  which reads as a broken render, not a preference. The OS preference is
 *  only the fallback for the no-DOM/test case. Ride-scoped only: this never
 *  touches `setManualTheme`/the durable preference, exactly like the HUD's
 *  own ☀/☾ toggle. */
export function resolveFlavor(theme: RideThemeChoice): RouteMapFlavor {
  if (theme === "light" || theme === "dark") return theme;
  try {
    const live =
      typeof document !== "undefined"
        ? document.documentElement.dataset.theme
        : undefined;
    if (live === "light" || live === "dark") return live;
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function buildPointsFeatureCollection(
  origin: LngLat,
  dest: RideDestWithCoverage,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      pointFeature(origin.lng, origin.lat, "origin"),
      pointFeature(dest.lon, dest.lat, "dest"),
    ],
  };
}

function pointFeature(
  lng: number,
  lat: number,
  kind: "origin" | "dest",
): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { kind },
    geometry: { type: "Point", coordinates: [lng, lat] },
  };
}

/** All READY routes, colored by profile; the selected one sorted last so it
 *  paints on top of the dimmed others (never hidden — "selecting a route
 *  toggles which one is visually emphasized, others dimmed"). */
export function buildRouteFeatureCollection(
  results: ReadonlyMap<string, RouteState>,
  selected: string | null,
): GeoJSON.FeatureCollection {
  const ready: { key: string; response: RouteResponse }[] = [];
  for (const state of results.values()) {
    if (state.status === "ready") ready.push({ key: state.key, response: state.response });
  }
  ready.sort((a, b) => Number(a.key === selected) - Number(b.key === selected));
  return {
    type: "FeatureCollection",
    features: ready.map(({ key, response }) => ({
      type: "Feature",
      properties: { profile: key, selected: key === selected },
      geometry: response.geometry,
    })),
  };
}

/** Bounding box of origin + destination + every loaded route's shape — always
 *  at least the two points, since `buildLoadedScreen` only runs once both
 *  exist. */
export function computeBounds(
  origin: LngLat,
  dest: RideDestWithCoverage,
  results: ReadonlyMap<string, RouteState>,
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

const ROUTE_SRC = "ride-route-lines";
const ROUTE_LAYER = "ride-route-lines-layer";
const POINTS_SRC = "ride-route-points";
const POINTS_LAYER = "ride-route-points-layer";

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
  let selectedProfile: string | null = null;
  let mapHandle: RouteMapLike | null = null;

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

  // ---------------- secondary pane (map preview) ----------------
  const mapContainer = el("div", "ride-route-map");
  mapContainer.setAttribute("aria-hidden", "true");
  const secondary = el("div", "ride-route-overview");
  secondary.append(mapContainer);

  // ---------------- map lifecycle ----------------
  void (async () => {
    try {
      const flavor = resolveFlavor(doc.options.theme);
      const handle = await (deps.createMap ?? defaultCreateMap)(
        mapContainer,
        flavor,
        abort.signal,
      );
      if (destroyed) {
        safeRemoveMap(handle);
        return;
      }
      mapHandle = handle;
      ensureRouteLayers(mapHandle);
      renderMap();
    } catch (e) {
      if (destroyed || isAbortError(e)) return;
      console.error("ride route map failed to initialize", e);
      renderMapFallback();
    }
  })();

  function renderMapFallback(): void {
    mapContainer.replaceChildren();
    mapContainer.setAttribute("aria-hidden", "false");
    mapContainer.classList.add("ride-route-map--fallback");
    mapContainer.append(
      el(
        "p",
        "ride-modal__hint",
        "Map preview unavailable — pick a route from the list.",
      ),
    );
  }

  function renderMap(): void {
    if (!mapHandle) return;
    const pointsSrc = mapHandle.getSource(POINTS_SRC) as GeoJSONSource | undefined;
    pointsSrc?.setData(buildPointsFeatureCollection(origin, dest));
    const routesSrc = mapHandle.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
    routesSrc?.setData(buildRouteFeatureCollection(results, selectedProfile));
    try {
      mapHandle.fitBounds(computeBounds(origin, dest, results), {
        padding: 48,
        maxZoom: 16,
        duration: 0,
      });
    } catch (e) {
      // A degenerate (zero-area, single-point) bounds can throw in some
      // MapLibre builds — the preview still shows at whatever framing
      // resulted, which is harmless; this is cosmetic, never fatal.
      console.error("ride route map fitBounds failed", e);
    }
  }

  // ---------------- data loading ----------------
  void loadRoutes();

  async function loadRoutes(): Promise<void> {
    let list: RouteProfile[];
    try {
      const resp = await (deps.fetchRouteProfiles ?? defaultFetchRouteProfiles)(
        abort.signal,
      );
      list = resp.profiles.length > 0 ? resp.profiles : FALLBACK_PROFILES;
    } catch (e) {
      if (destroyed) return;
      if (!isAbortError(e)) {
        console.error(
          "route profiles fetch failed — using the known fallback list",
          e,
        );
      }
      list = FALLBACK_PROFILES;
    }
    if (destroyed) return;
    results = new Map(
      list.map((p) => [p.key, { key: p.key, label: p.label, status: "loading" as const }]),
    );
    render();

    await Promise.allSettled(
      list.map(async (p) => {
        try {
          const rr = await (deps.fetchRoute ?? defaultFetchRoute)(
            {
              from: [origin.lat, origin.lng],
              to: [dest.lat, dest.lon],
              profile: p.key,
              vehicle_model: selectedDevice(doc.device)?.model ?? undefined,
              maneuvers: true,
            },
            abort.signal,
          );
          if (destroyed) return;
          results.set(p.key, { key: p.key, label: p.label, status: "ready", response: rr });
          if (rr.properties.beta_warning && betaEl.hidden) {
            betaEl.textContent = `⚠️ ${rr.properties.beta_warning}`;
            betaEl.hidden = false;
          }
        } catch (e) {
          if (destroyed) return;
          if (!isAbortError(e)) {
            console.error(`route fetch failed for profile "${p.key}"`, e);
          }
          results.set(p.key, { key: p.key, label: p.label, status: "error" });
        }
        if (destroyed) return;
        if (selectedProfile === null) {
          const s = results.get(p.key);
          if (s?.status === "ready") selectedProfile = p.key;
        }
        render();
      }),
    );
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
      betaWarning: chosen.properties.beta_warning ?? null,
    };
    deps.session.dispatch({ type: "setRoute", route: sessionRoute });
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
    const loadingProfiles = results.size === 0;
    const readyCount = countByStatus(results, "ready");
    const settled = !loadingProfiles && allSettled(results);

    if (loadingProfiles) {
      statusEl.textContent = "Loading route options…";
    } else if (readyCount === 0 && settled) {
      statusEl.textContent =
        "No routes are available for this trip — you can continue without navigation.";
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

    renderMap();
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
    const li = el("li");
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
    btn.addEventListener("click", () => select(state.key));
    li.append(btn);
    return li;
  }

  render();

  return {
    title: "Choose your route",
    primary,
    secondary,
    split: "40-60",
    onHeaderNext: advance,
    onOrientationChange() {
      // The pane's pixel box changes shape on the flip (2-column ⇄ stacked);
      // wait a frame for the CSS grid to settle before resizing the canvas.
      if (mapHandle) requestAnimationFrame(() => mapHandle?.resize());
    },
    destroy() {
      destroyed = true;
      abort.abort();
      if (mapHandle) safeRemoveMap(mapHandle);
      mapHandle = null;
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
// Map layers
// ---------------------------------------------------------------------------

function ensureRouteLayers(map: RouteMapLike): void {
  if (!map.getSource(ROUTE_SRC)) {
    map.addSource(ROUTE_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: ROUTE_LAYER,
      type: "line",
      source: ROUTE_SRC,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "match",
          ["get", "profile"],
          "safe",
          PROFILE_COLORS.safe,
          "range",
          PROFILE_COLORS.range,
          "shade",
          PROFILE_COLORS.shade,
          "express",
          PROFILE_COLORS.express,
          FALLBACK_PROFILE_COLOR,
        ] as ExpressionSpecification,
        "line-width": ["case", ["==", ["get", "selected"], true], 6, 3] as ExpressionSpecification,
        "line-opacity": [
          "case",
          ["==", ["get", "selected"], true],
          0.95,
          0.35,
        ] as ExpressionSpecification,
      },
    });
  }
  if (!map.getSource(POINTS_SRC)) {
    map.addSource(POINTS_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: POINTS_LAYER,
      type: "circle",
      source: POINTS_SRC,
      paint: {
        "circle-radius": 7,
        "circle-color": [
          "match",
          ["get", "kind"],
          "origin",
          "#0072B2",
          "dest",
          "#D55E00",
          "#666666",
        ] as ExpressionSpecification,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
  }
}

function safeRemoveMap(map: RouteMapLike): void {
  try {
    map.remove();
  } catch {
    /* already removed / never fully initialized — nothing to clean up */
  }
}

// ---------------------------------------------------------------------------
// Default map factory (production) — see DEVIATION 1 above.
// ---------------------------------------------------------------------------

async function defaultCreateMap(
  container: HTMLElement,
  flavor: RouteMapFlavor,
  signal?: AbortSignal,
): Promise<RouteMapLike> {
  // Real streets under the route lines (revising DEVIATION 1's original
  // flat-background compromise — riders read an unlabeled colored line on a
  // blank panel as a broken render, not a preview). The pmtiles:// protocol
  // is already registered globally by map.ts's createMap(), which always
  // runs long before this modal can open, and previewBasemapStyle() shares
  // the main map's self-hosted archive/glyphs/sprites, so the extra cost is
  // a handful of cached tile reads for one modal-sized viewport.
  const map = new maplibregl.Map({
    container,
    style: previewBasemapStyle(flavor),
    // Denver center — replaced by fitBounds() the instant origin/dest are
    // known, which is immediately after this promise resolves.
    center: [-104.9903, 39.7392],
    zoom: 12,
    attributionControl: false,
    // A static preview: the route layers repaint via setData/fitBounds, and
    // an accidentally-pannable aria-hidden pane inside a modal is a trap.
    interactive: false,
  });
  await waitForLoadAndSize(map, container);
  if (signal?.aborted) {
    map.remove();
    throw new DOMException("aborted", "AbortError");
  }
  return map;
}

/** Resolves once the style has loaded AND the container has a real
 *  (non-zero) size — copies `map.ts`'s own "start at 0×0, poll each frame
 *  until sized" fix for the same class of bug (a modal pane isn't laid out
 *  yet at the instant this screen's factory runs). Resolves early if the map
 *  is removed before either condition lands, so a fast teardown never hangs
 *  the caller. */
function waitForLoadAndSize(map: MLMap, container: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let loaded = false;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    map.once("remove", finish);
    map.once("load", () => {
      loaded = true;
    });
    const poll = (): void => {
      if (settled) return;
      if (loaded && container.clientWidth > 0 && container.clientHeight > 0) {
        map.resize();
        finish();
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
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
