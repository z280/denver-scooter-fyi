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

import type { Map as MLMap, MapMouseEvent } from "maplibre-gl";
import {
  TRIPLE_CLICK_WINDOW_MS,
  createTripleClickDetector,
} from "./triple-click.ts";
import { topAnchorIndex } from "./map-bands.ts";

/** What a source found under the pointer. */
export interface InspectHit {
  /** Identity for the triple recognizer: three taps must land on the SAME
   *  thing. Namespaced by source ("zone:", "equity:", "hex:", "spot") so two
   *  sources can never collide. */
  key: string;
  /** Open the explanation. */
  open(): void;
  /** Hold the map's double-click zoom while a run on this target is in
   *  progress. True for small, deliberate targets (zones, hexes), where a
   *  zoom on the second tap would yank the target away. False for the big
   *  ones — an Equity Area covers a third of the city, and turning
   *  double-tap zoom off over all of it would break how people move the
   *  map. There, the second tap zooms around the finger, the point under it
   *  stays put, and the third tap still lands. */
  holdsDoubleClickZoom?: boolean;
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

/** Taps further apart than this (screen px) are not "the same place", even
 *  if they resolve to the same key — three taps across one big equity area
 *  are three separate taps. Generous for fingers. */
export const TAP_SLOP_PX = 24;

export interface MapInspectorOptions {
  /** Top first: the first source with a hit answers. */
  sources: InspectSource[];
  /** Always answers: the card for a spot nothing else claims. */
  fallback: (lngLat: InspectLngLat) => InspectHit;
  /** Called after every completed triple (the nudge uses it to retire
   *  itself once someone has done the gesture). */
  onTriple?: () => void;
  now?: () => number;
}

export class MapInspector {
  private readonly detector = createTripleClickDetector<string>();
  private lastPoint: InspectPoint | null = null;
  private dczSuppressTimer: number | undefined;
  private dczWasEnabled = false;
  private readonly now: () => number;

  constructor(
    private readonly map: MLMap,
    private readonly opts: MapInspectorOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  attach(): void {
    this.map.on("click", (e: MapMouseEvent) =>
      this.handleTap(e.point, e.lngLat),
    );
  }

  /** Forget any half-finished run. */
  reset(): void {
    this.detector.reset();
    this.lastPoint = null;
    this.restoreDoubleClickZoom();
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

  handleTap(point: InspectPoint, lngLat: InspectLngLat): void {
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

    if (!this.detector.register(hit.key, this.now())) {
      if (hit.holdsDoubleClickZoom) this.suppressDoubleClickZoom();
      return;
    }
    this.lastPoint = null;
    this.restoreDoubleClickZoom();
    hit.open();
    this.opts.onTriple?.();
  }

  /** Did the tap land on a scooter, cluster, pin or route — anything drawn
   *  above the area bands? Those are not area questions. Maps without a
   *  style (tests) or without the band anchors yet have nothing above. */
  private tappedSomethingAbove(point: InspectPoint): boolean {
    const top = topAnchorIndex(this.map);
    if (top < 0 || typeof this.map.queryRenderedFeatures !== "function") {
      return false;
    }
    const order = new Map<string, number>();
    (this.map.getStyle()?.layers ?? []).forEach((l, i) => order.set(l.id, i));
    return this.map
      .queryRenderedFeatures([point.x, point.y])
      .some((f) => (order.get(f.layer.id) ?? -1) > top);
  }

  /** Hold double-click zoom for one triple-click window (moved here from
   *  hexdensity.ts, which used to own the gesture). Restores only what it
   *  turned off: if the map had it disabled already, it stays that way. */
  private suppressDoubleClickZoom(): void {
    const dcz = this.map.doubleClickZoom;
    if (this.dczSuppressTimer !== undefined) {
      clearTimeout(this.dczSuppressTimer);
    } else if (dcz?.isEnabled()) {
      this.dczWasEnabled = true;
      dcz.disable();
    }
    this.dczSuppressTimer = setTimeout(() => {
      this.dczSuppressTimer = undefined;
      this.restoreDoubleClickZoom();
    }, TRIPLE_CLICK_WINDOW_MS) as unknown as number;
  }

  private restoreDoubleClickZoom(): void {
    if (this.dczSuppressTimer !== undefined) {
      clearTimeout(this.dczSuppressTimer);
      this.dczSuppressTimer = undefined;
    }
    if (!this.dczWasEnabled) return;
    this.dczWasEnabled = false;
    this.map.doubleClickZoom?.enable();
  }
}

// ---------------------------------------------------------------------------
// The plain-spot card: what a triple tap says where nothing else answers.
// ---------------------------------------------------------------------------

export const SPOT_INSPECT_TITLE = "Nothing marked here";

export interface SpotFacts {
  /** Are the city's rule zones (no riding / no parking / slow) drawn? If
   *  not, the card cannot say there is none here. */
  zonesShown: boolean;
  /** Is this spot in an Equity Area? null = the boundaries have not loaded,
   *  so say nothing rather than guess. */
  inEquityArea: boolean | null;
}

/** Pure, so every branch of the copy is assertable. Never claims more than
 *  the map knows: a hidden layer or unloaded data is said out loud, not
 *  read as "nothing here". */
export function buildSpotHtml(f: SpotFacts): string {
  const zones = f.zonesShown
    ? "No city slow, no-riding or no-parking zone covers this spot."
    : "City zones are switched off in Areas, so this can't rule one out.";
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
