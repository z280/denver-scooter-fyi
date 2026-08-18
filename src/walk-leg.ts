// Walking to the scooter — the leg between choosing a vehicle and riding it.
//
// WHAT THIS REPLACES. Picking a scooter drew a dashed straight line to it and
// offered a "Directions" link that opened Google or Apple Maps. So the app's
// answer to "how do I actually get to this thing" was to send the rider to a
// different app, at the exact moment they are standing on a pavement deciding
// whether to trust this one. We have a router. It routes pedestrians on the
// same tiles (`GET /api/v1/route/walk`).
//
// ARRIVAL IS OBSERVED, NOT ASSUMED. The panel flips to "you're here" off the
// GPS fix, with a generous radius and a manual override — see ARRIVAL_METERS.
// A rider standing next to the scooter looking at a screen that still says
// "walk 200 m" has been told the app does not know where they are.

import { fetchWalkRoute, type WalkRoute } from "./api.ts";
import { distanceMeters, type LngLat } from "./locate.ts";

/** How close counts as arrived.
 *
 *  Deliberately loose. Consumer GPS in a street canyon is routinely 20-30 m
 *  out, a scooter's own reported position is a GBFS sample that may be minutes
 *  stale, and the two errors do not cancel. Tight enough and a rider standing
 *  with a hand on the handlebar never sees the arrival panel; loose enough and
 *  it appears a few seconds early, while they can see the scooter. The second
 *  failure is obviously the cheaper one. */
export const ARRIVAL_METERS = 35;

/** Re-route while walking at most this often. The route barely changes over
 *  20 m of pavement and the endpoint is IP rate-limited at 30/min. */
const REROUTE_METERS = 60;

export interface WalkTarget {
  lat: number;
  lng: number;
  /** What to call the thing being walked to — a vehicle's name, ideally. */
  label: string;
}

export interface WalkState {
  /** Straight-line metres left, which is what arrival is judged on. The
   *  ROUTED distance is what gets shown; they differ, and conflating them
   *  would either strand the rider or arrive them a block early. */
  remainingMeters: number | null;
  routeMeters: number | null;
  routeSeconds: number | null;
  arrived: boolean;
  /** True while the first route is still in flight, so the panel can say
   *  "working it out" instead of showing a confident blank. */
  loading: boolean;
  /** Set when routing failed. The walk is not blocked by this — the rider can
   *  see the scooter on the map — so this is a note, not an error state. */
  error: boolean;
}

export interface WalkLegDeps {
  locate: {
    current(): LngLat | null;
    onFix(cb: (pos: LngLat) => void): () => void;
  };
  /** Draw (or clear) the walking line. */
  drawRoute(coords: [number, number][] | null): void;
  onChange(state: WalkState): void;
  /** Injected for tests. */
  fetchRoute?: typeof fetchWalkRoute;
}

export interface WalkLegHandle {
  /** Force the arrived state — the rider tapped "I'm here". Their eyes beat
   *  our radius, always. */
  markArrived(): void;
  state(): WalkState;
  stop(): void;
}

export function startWalkLeg(target: WalkTarget, deps: WalkLegDeps): WalkLegHandle {
  const fetchRoute = deps.fetchRoute ?? fetchWalkRoute;
  let stopped = false;
  let lastRoutedFrom: LngLat | null = null;
  let inflight: AbortController | null = null;

  let state: WalkState = {
    remainingMeters: null,
    routeMeters: null,
    routeSeconds: null,
    arrived: false,
    loading: false,
    error: false,
  };

  const emit = (patch: Partial<WalkState>): void => {
    state = { ...state, ...patch };
    if (!stopped) deps.onChange(state);
  };

  const route = (from: LngLat): void => {
    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    emit({ loading: state.routeMeters === null, error: false });
    void fetchRoute(
      [from.lat, from.lng],
      [target.lat, target.lng],
      {},
      ctrl.signal,
    )
      .then((r: WalkRoute) => {
        if (stopped || ctrl.signal.aborted) return;
        lastRoutedFrom = from;
        deps.drawRoute(r.geometry.coordinates);
        emit({
          routeMeters: r.properties.distance_meters,
          routeSeconds: r.properties.duration_seconds,
          loading: false,
          error: false,
        });
      })
      .catch(() => {
        if (stopped || ctrl.signal.aborted) return;
        // A walk that will not route is not a dead end: the scooter is on the
        // map and the rider can see it. Keep the straight-line distance, say
        // nothing alarming, and let them walk.
        emit({ loading: false, error: true });
      });
  };

  const consider = (pos: LngLat): void => {
    if (stopped) return;
    const remaining = distanceMeters(pos, { lat: target.lat, lng: target.lng });
    const arrived = state.arrived || remaining <= ARRIVAL_METERS;
    emit({ remainingMeters: remaining, arrived });
    if (arrived) {
      // Nothing left to route to, and a line to a place you are standing in
      // is clutter.
      deps.drawRoute(null);
      return;
    }
    const moved =
      lastRoutedFrom === null || distanceMeters(pos, lastRoutedFrom) > REROUTE_METERS;
    if (moved) route(pos);
  };

  const off = deps.locate.onFix((pos) => consider(pos));
  const first = deps.locate.current();
  if (first) consider(first);

  return {
    markArrived() {
      if (stopped || state.arrived) return;
      deps.drawRoute(null);
      emit({ arrived: true });
    },
    state: () => state,
    stop() {
      stopped = true;
      off();
      inflight?.abort();
      deps.drawRoute(null);
    },
  };
}

/** "3 min · 240 m" — what a rider actually wants off a walk. Time first,
 *  because the decision it feeds ("is this one worth it?") is a time
 *  decision; distance second, because it is what they can check against the
 *  world. Falls back to the straight-line distance when routing failed. */
export function formatWalkLeg(state: WalkState): string {
  const meters = state.routeMeters ?? state.remainingMeters;
  if (meters === null) return "Working out the walk…";
  const rounded = meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
  if (state.routeSeconds === null) return rounded;
  const mins = Math.max(1, Math.round(state.routeSeconds / 60));
  return `${mins} min · ${rounded}`;
}
