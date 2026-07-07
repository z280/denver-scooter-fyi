// User-location plumbing for "worth the walk" economics: tracks the
// GeolocateControl's fixes, computes straight-line walk estimates, and
// draws a dashed guide line from the user to a selected device. Location
// is strictly opt-in — nothing here runs until the user taps the
// geolocate button (or a mode preset triggers it, which is itself a tap).

import type { Map as MLMap, GeolocateControl, GeoJSONSource } from "maplibre-gl";
import { emptyFC } from "./util.ts";

const LINE_SRC = "walk-line";
const LINE_LAYER = "walk-line-dash";

/** Straight-line detour factor and walking speed for estimates: Denver's
 *  street grid rarely costs more than ~30% over the crow-flies path, and
 *  3 mph is a typical urban walking pace. */
const DETOUR = 1.3;
const WALK_METERS_PER_MIN = 80.5; // 3 mph

export interface LngLat {
  lng: number;
  lat: number;
}

export function distanceMeters(a: LngLat, b: LngLat): number {
  // Haversine.
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round((meters * DETOUR) / WALK_METERS_PER_MIN));
}

export function formatWalk(meters: number): string {
  const mi = (meters * DETOUR) / 1609.344;
  return `~${walkMinutes(meters)} min walk (${mi.toFixed(1)} mi)`;
}

/** Platform-appropriate walking-directions handoff URL. Both open the
 *  native maps app when installed; neither needs an API key. */
export function walkingDirectionsUrl(dest: LngLat): string {
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return isApple
    ? `https://maps.apple.com/?daddr=${dest.lat},${dest.lng}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=walking`;
}

/** Fixes older than this are treated as "location unknown" — walk
 *  estimates from a stale position are worse than none. Generous enough
 *  that a stationary rider (whose watchPosition may go quiet) keeps their
 *  estimates; short enough that a disabled watch ages out quickly. */
const FIX_MAX_AGE_MS = 5 * 60_000;

export class Locate {
  private position: LngLat | null = null;
  private fixedAt = 0;
  private fixListeners = new Set<(pos: LngLat) => void>();
  private errorListeners = new Set<() => void>();

  constructor(
    private readonly map: MLMap,
    private readonly control: GeolocateControl,
  ) {
    control.on("geolocate", (e) => {
      this.position = { lng: e.coords.longitude, lat: e.coords.latitude };
      this.fixedAt = Date.now();
      for (const cb of this.fixListeners) cb(this.position);
    });
    // NOTE: deliberately no `trackuserlocationend` handler — MapLibre fires
    // it whenever a map move breaks the camera lock (active → background),
    // but the watch keeps delivering fixes in background state. The
    // staleness window below handles a watch that actually stopped.
    control.on("error", () => {
      this.position = null;
      this.clearLine();
      for (const cb of this.errorListeners) cb();
    });
  }

  /** Notify on every location fix. Returns an unsubscribe function. */
  onFix(cb: (pos: LngLat) => void): () => void {
    this.fixListeners.add(cb);
    return () => this.fixListeners.delete(cb);
  }

  /** Notify when geolocation errors (denied / unavailable). Returns an
   *  unsubscribe function. */
  onError(cb: () => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  /** Last known user position, or null when not locating (or the last fix
   *  has gone stale). */
  current(): LngLat | null {
    if (!this.position) return null;
    if (Date.now() - this.fixedAt > FIX_MAX_AGE_MS) return null;
    return this.position;
  }

  /** Programmatically start locating (fires the browser permission prompt
   *  if needed). Must be called from a user gesture. Uses the same
   *  freshness gate as current(): a stale fix means the watch died, so
   *  re-trigger rather than no-op (otherwise the Find-a-ride "Awaiting
   *  approval…" step could wait forever on a fix that never comes). */
  trigger(): void {
    if (!this.current()) this.control.trigger();
  }

  /** Dashed straight line user → target (orientation aid, not a route). */
  showLineTo(target: LngLat): void {
    if (!this.position) return;
    this.ensureLayer();
    const src = this.map.getSource(LINE_SRC) as GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [this.position.lng, this.position.lat],
              [target.lng, target.lat],
            ],
          },
          properties: {},
        },
      ],
    });
  }

  clearLine(): void {
    const src = this.map.getSource(LINE_SRC) as GeoJSONSource | undefined;
    src?.setData(emptyFC());
  }

  private ensureLayer(): void {
    if (this.map.getSource(LINE_SRC)) return;
    this.map.addSource(LINE_SRC, { type: "geojson", data: emptyFC() });
    this.map.addLayer({
      id: LINE_LAYER,
      type: "line",
      source: LINE_SRC,
      layout: { "line-cap": "round" },
      paint: {
        "line-color": "#0072B2",
        "line-width": 2.5,
        "line-opacity": 0.75,
        "line-dasharray": [1.5, 2],
      },
    });
  }
}
