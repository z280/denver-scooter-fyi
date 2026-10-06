// Triple-tap ANYWHERE on the map: "what is this, here?"
//
// The gesture used to belong to the hex layer alone (see triple-click.ts for
// why three taps and not one or two). That made the answer depend on which
// layer happened to own the click: three taps on a no-parking zone with
// Territory Control on came back as "Unclaimed territory", because the hex
// fill was the only thing listening — and since it had also been created
// last, it was drawn on top of the zone too.
//
// This module owns the gesture for the whole map and answers with the
// MOST RELEVANT thing under the finger, in the same order map-bands.ts
// stacks them, top first:
//
//   1. the city's zones      (no riding / no parking / slow) — a rule
//   2. an Equity Area        — a price a rider is owed
//   3. territory / hex cell  — numbers about the area
//   4. anything else         — a plain "what's here" card, so a triple tap
//                              never silently does nothing
//
// Each layer module answers for itself through `InspectSource`; this module
// only decides who goes first, recognizes the triple, and keeps the map's
// double-click zoom out of the way while a run is in progress.
//
// Taps that land on something drawn ABOVE the areas — a scooter, a cluster,
// a pin, a route — are not area questions. They belong to that thing's own
// click handler, so they abandon a run instead of counting toward one.
// Area-like layers drawn up there (a scooter's range halo, which can be
// kilometres across; 3D buildings during a ride) do NOT block: they are
// translucent context, and blocking on them would switch the gesture off
// across whole neighbourhoods.

import type { Map as MLMap, MapMouseEvent, MapTouchEvent } from "maplibre-gl";
import { createTripleClickDetector } from "./triple-click.ts";
import { layerOrder, topAnchorIndex } from "./map-bands.ts";

/** What a source found under the pointer. */
export interface InspectHit {
  /** Identity for the triple recognizer: three taps must land on the SAME
   *  thing. Namespaced by source ("zone:", "equity:", "hex:", "spot") so two
   *  sources can never collide. */
  key: string;
  /** Open the explanation. */
  open(): void;
}

export interface InspectPoint {
  x: number;
  y: number;
}
export interface InspectLngLat {
  lng: number;
  lat: number;
}

/** One layer module's answer to "is there something of yours here?". */
export interface InspectSource {
  hitAt(point: InspectPoint, lngLat: InspectLngLat): InspectHit | null;
}

/** Layer types above the area bands that a tap passes through. */
const PASS_THROUGH_TYPES = new Set<string>([
  "fill",
  "fill-extrusion",
  "background",
  "raster",
  "hillshade",
  "heatmap",
]);

/** Taps further apart than this (screen px) are not "the same place", even
 *  if they resolve to the same key — three taps across one big equity area
 *  are three separate taps. Generous for fingers. */
export const TAP_SLOP_PX = 24;

// ---------------------------------------------------------------------------
// Input: why taps are read from TOUCH events, and why this owns double-tap zoom.
//
// On a phone the browser's `click` is the wrong signal. It arrives ~300-400 ms
// after the finger lifts (the browser is waiting to see whether this is a
// double-tap), and three quick taps are read as a double-tap GESTURE, whose
// clicks arrive late or not at all. MapLibre's own double-tap zoom listens to
// raw touches and fires regardless. On Android that added up to exactly the
// reported symptom: triple-tap "just zooms me in", and no card.
//
// So: a touch tap is recognized here from touchstart/touchend (short, still),
// the late `click` that echoes it is ignored, and mouse clicks still come
// through `click`. And the map's built-in double-tap/double-click zoom is
// replaced by one this module runs: on the second tap it waits
// ZOOM_DEFER_MS for a third, zooms in only if none comes, and a triple-tap
// never zooms. Double-tap zoom keeps working everywhere, one beat later.
// ---------------------------------------------------------------------------

/** A touch counts as a tap if it lifts within this long... */
export const TAP_MAX_MS = 450;
/** ...and moves no further than this (screen px). MapLibre's click tolerance
 *  is 3 px, which a fingertip blows through routinely. */
export const TAP_MAX_MOVE_PX = 12;
/** The browser's delayed `click` for a touch tap lands inside this. */
export const TOUCH_ECHO_MS = 900;
/** Max gap between the two taps of a double tap (MapLibre uses 500 ms). */
export const DOUBLE_TAP_GAP_MS = 500;
/** After a double tap, wait this long for a third before zooming. */
export const ZOOM_DEFER_MS = 300;

export interface MapInspectorOptions {
  /** Top first: the first source with a hit answers. */
  sources: InspectSource[];
  /** Always answers: the card for a spot nothing else claims. */
  fallback: (lngLat: InspectLngLat) => InspectHit;
  /** Called after every completed triple (the nudge uses it to retire
   *  itself once someone has done the gesture). */
  onTriple?: () => void;
  /** True while taps mean something else (map-pick mode: the tap drops a
   *  pin). Such taps neither count nor open anything. */
  suspended?: () => boolean;
  now?: () => number;
}

export class MapInspector {
  private readonly detector = createTripleClickDetector<string>();
  private lastPoint: InspectPoint | null = null;
  private readonly now: () => number;

  /** Gesture-level tap run for double-tap zoom: counts EVERY tap, blocked or
   *  not (a double-tap on a scooter still zooms), unlike `detector`. */
  private gestureCount = 0;
  private gestureLast: { pt: InspectPoint; at: number } | null = null;
  private pendingZoom: ReturnType<typeof setTimeout> | undefined;
  /** Whether this module took double-tap zoom over from the map (it only
   *  does if the map had it on). */
  private ownsZoom = false;

  /** `stamp` is the DOM event's own timeStamp: when the finger actually
   *  went down, not when a busy main thread got round to the handler. */
  private touchStart: { pt: InspectPoint; at: number; stamp: number } | null = null;
  private lastTouchTapAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly map: MLMap,
    private readonly opts: MapInspectorOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  attach(): void {
    const dcz = this.map.doubleClickZoom;
    if (dcz?.isEnabled()) {
      dcz.disable();
      this.ownsZoom = true;
    }
    this.map.on("touchstart", (e: MapTouchEvent) => {
      this.touchStart =
        e.points.length === 1
          ? {
              pt: { x: e.point.x, y: e.point.y },
              at: this.now(),
              stamp: e.originalEvent?.timeStamp ?? Number.NaN,
            }
          : null;
    });
    this.map.on("touchmove", (e: MapTouchEvent) => {
      // A second finger makes it a pinch, not a tap.
      if (e.points.length > 1) this.touchStart = null;
    });
    this.map.on("touchend", (e: MapTouchEvent) => {
      const start = this.touchStart;
      this.touchStart = null;
      if (!start || (e.originalEvent?.touches?.length ?? 0) > 0) return;
      const endStamp = e.originalEvent?.timeStamp ?? Number.NaN;
      const held =
        Number.isFinite(start.stamp) && Number.isFinite(endStamp)
          ? endStamp - start.stamp
          : this.now() - start.at;
      if (held > TAP_MAX_MS) return;
      if (Math.hypot(e.point.x - start.pt.x, e.point.y - start.pt.y) > TAP_MAX_MOVE_PX) {
        return;
      }
      this.lastTouchTapAt = this.now();
      this.tap(e.point, e.lngLat);
    });
    this.map.on("click", (e: MapMouseEvent) => {
      if (this.now() - this.lastTouchTapAt < TOUCH_ECHO_MS) return; // touch echo
      this.tap(e.point, e.lngLat);
    });
  }

  /** One recognized tap, from either input path. */
  tap(point: InspectPoint, lngLat: InspectLngLat): void {
    this.trackZoomGesture(point, lngLat);
    this.handleTap(point, lngLat);
  }

  /** Forget any half-finished run. */
  reset(): void {
    this.detector.reset();
    this.lastPoint = null;
  }

  /** The hit a triple tap HERE would open. Exposed for tests and for the
   *  nudge's copy; does not touch the run. */
  resolve(point: InspectPoint, lngLat: InspectLngLat): InspectHit | null {
    if (this.tappedSomethingAbove(point)) return null;
    for (const src of this.opts.sources) {
      const hit = src.hitAt(point, lngLat);
      if (hit) return hit;
    }
    return this.opts.fallback(lngLat);
  }

  /** The triple-tap half: count toward a run on the thing under the tap and
   *  open it on the third. */
  handleTap(point: InspectPoint, lngLat: InspectLngLat): void {
    if (this.opts.suspended?.()) {
      this.reset();
      return;
    }
    const hit = this.resolve(point, lngLat);
    if (!hit) {
      this.reset();
      return;
    }
    const last = this.lastPoint;
    if (last && Math.hypot(point.x - last.x, point.y - last.y) > TAP_SLOP_PX) {
      this.detector.reset();
    }
    this.lastPoint = { x: point.x, y: point.y };

    if (!this.detector.register(hit.key, this.now())) return;
    this.lastPoint = null;
    this.cancelPendingZoom();
    hit.open();
    this.opts.onTriple?.();
  }

  /** The double-tap-zoom half (see the header): zoom on a double tap, but
   *  only once it is clear it is not the start of a triple. */
  private trackZoomGesture(point: InspectPoint, lngLat: InspectLngLat): void {
    if (!this.ownsZoom) return;
    const t = this.now();
    const prev = this.gestureLast;
    const continues =
      prev !== null &&
      t - prev.at <= DOUBLE_TAP_GAP_MS &&
      Math.hypot(point.x - prev.pt.x, point.y - prev.pt.y) <= TAP_SLOP_PX;
    this.gestureCount = continues ? this.gestureCount + 1 : 1;
    this.gestureLast = { pt: { x: point.x, y: point.y }, at: t };
    if (this.gestureCount === 2) {
      this.cancelPendingZoom();
      this.pendingZoom = setTimeout(() => {
        this.pendingZoom = undefined;
        this.map.easeTo({
          zoom: Math.min(this.map.getZoom() + 1, this.map.getMaxZoom()),
          around: [lngLat.lng, lngLat.lat],
          duration: 300,
        });
      }, ZOOM_DEFER_MS);
    } else if (this.gestureCount >= 3) {
      // A triple: never a zoom.
      this.cancelPendingZoom();
      this.gestureCount = 0;
      this.gestureLast = null;
    }
  }

  private cancelPendingZoom(): void {
    if (this.pendingZoom !== undefined) clearTimeout(this.pendingZoom);
    this.pendingZoom = undefined;
  }

  /** Did the tap land on a scooter, cluster, pin or route — anything
   *  point- or line-like drawn above the area bands? Those are not area
   *  questions. Area-like layer types up there pass through (see the header).
   *  Maps without the band anchors yet (tests) have nothing above. */
  private tappedSomethingAbove(point: InspectPoint): boolean {
    const top = topAnchorIndex(this.map);
    if (top < 0 || typeof this.map.queryRenderedFeatures !== "function") {
      return false;
    }
    const order = new Map<string, number>();
    layerOrder(this.map).forEach((id, i) => order.set(id, i));
    return this.map
      .queryRenderedFeatures([point.x, point.y])
      .some(
        (f) =>
          (order.get(f.layer.id) ?? -1) > top && !PASS_THROUGH_TYPES.has(f.layer.type),
      );
  }
}

// ---------------------------------------------------------------------------
// The plain-spot card: what a triple tap says where nothing else answers.
// ---------------------------------------------------------------------------

export const SPOT_INSPECT_TITLE = "Nothing marked here";

export interface SpotFacts {
  /** The city's rule zones (no riding / no parking / slow): drawn, switched
   *  off in Areas, or not loaded (yet, or the fetch failed). Only "shown"
   *  lets the card say there is none here. */
  zones: "shown" | "off" | "not_loaded";
  /** Is this spot in an Equity Area? null = the boundaries have not loaded,
   *  so say nothing rather than guess. */
  inEquityArea: boolean | null;
}

/** Pure, so every branch of the copy is assertable. Never claims more than
 *  the map knows: a hidden layer or unloaded data is said out loud, not
 *  read as "nothing here". */
export function buildSpotHtml(f: SpotFacts): string {
  const zones =
    f.zones === "shown"
      ? "No city slow, no-riding or no-parking zone covers this spot."
      : f.zones === "off"
        ? "City zones are switched off in Areas, so this can't rule one out."
        : "City zones haven't loaded, so this can't rule one out.";
  const equity =
    f.inEquityArea === false
      ? "<p>It's outside Denver's Equity Areas, so no Equity Area discount applies here.</p>"
      : "";
  return `
    <div class="spot-inspect">
      <p>${zones}</p>
      ${equity}
      <p class="spot-inspect__hint">Triple-tap a coloured zone, an Equity Area or a territory hexagon to find out what it is.</p>
    </div>`;
}
