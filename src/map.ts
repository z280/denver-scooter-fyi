import maplibregl, {
  type LayerSpecification,
  type StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { DENVER_BOUNDS, BASEMAP_PMTILES_URL } from "./config.ts";
import { legalAttribution } from "./legal-links.ts";

const BASEMAP_SOURCE = "protomaps";

/** The basemap credit, which is a CONDITION of the Protomaps/OSM licence.
 *
 *  It is declared on the source below AND passed to the attribution control
 *  as custom attribution, because the source declaration alone does not
 *  survive: MapLibre replaces a vector source's fields with the TileJSON it
 *  loads from the source `url`, and the self-hosted pmtiles archive's
 *  metadata carries no attribution — so the control rendered EMPTY, with the
 *  ⓘ collapsed to zero width and the credit nowhere on the page. Verified in
 *  a browser against the live dev build, both before and after this line
 *  existed.
 *
 *  Declared in both places rather than only the one that works: the source
 *  field is what a future basemap pipeline (or an archive rebuilt with
 *  metadata) would honour, and a credit that depends on which of two
 *  mechanisms wins is the one that goes missing again. */
const BASEMAP_ATTRIBUTION =
  '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> © <a href="https://openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a>';

/** Basemap color scheme. Dark uses the Protomaps charcoal `dark` flavor (not
 *  `black`): this is a data map, and labels/overlays read better on charcoal. */
export type Flavor = "light" | "dark";

// Absolute base for self-hosted assets. Built by string concat (not `new URL`)
// so the {fontstack}/{range} glyph tokens are NOT percent-encoded.
const ASSET_BASE = new URL(import.meta.env.BASE_URL, location.origin).href;

function asset(path: string): string {
  return ASSET_BASE + path;
}

function basemapLayers(flavor: Flavor): LayerSpecification[] {
  // Flavor-prefixed ids: MapLibre bakes data-driven paint (e.g. landcover's
  // kind→color match) into per-layer-id tile buckets, so re-adding a layer
  // under the SAME id after a flavor swap renders stale colors from the old
  // flavor. Fresh ids force fresh buckets.
  return layers(BASEMAP_SOURCE, namedFlavor(flavor), { lang: "en" }).map(
    (l) => ({ ...l, id: `${flavor}-${l.id}` }),
  );
}

/** Ids of the basemap layers currently in the style. App layers (devices,
 *  overlays, …) are never in this set — it's what lets setBasemapFlavor swap
 *  the basemap out from under them without touching their z-order. */
let currentBasemapIds = new Set<string>();

function styleFor(flavor: Flavor, base: LayerSpecification[]): StyleSpecification {
  return {
    version: 8,
    glyphs: asset("fonts/{fontstack}/{range}.pbf"),
    sprite: asset(`sprites/${flavor}`),
    sources: {
      [BASEMAP_SOURCE]: {
        type: "vector",
        url: `pmtiles://${BASEMAP_PMTILES_URL}`,
        attribution: BASEMAP_ATTRIBUTION,
      },
    },
    layers: base,
  };
}

function buildStyle(flavor: Flavor): StyleSpecification {
  const base = basemapLayers(flavor);
  currentBasemapIds = new Set(base.map((l) => l.id));
  return styleFor(flavor, base);
}

/** Basemap style for small SECONDARY maps (the ride wizard's route preview).
 *  Same self-hosted archive/glyphs/sprites as the main map — the pmtiles://
 *  protocol is registered once, globally, by createMap(), and the pmtiles
 *  Protocol's directory cache makes a second consumer cheap. Deliberately
 *  does NOT touch `currentBasemapIds`: that set is setBasemapFlavor's
 *  bookkeeping for the MAIN map's layers, and a preview building a style
 *  must never confuse it. */
export function previewBasemapStyle(flavor: Flavor): StyleSpecification {
  return styleFor(flavor, basemapLayers(flavor));
}

/** Recolor the live map by swapping ONLY the basemap layers. The shared
 *  vector source stays mounted, so no tiles re-fetch and no app state is
 *  lost — the swap is instant. New basemap layers are inserted beneath the
 *  lowest non-basemap layer, preserving device/cluster/overlay z-order. */
export function setBasemapFlavor(map: maplibregl.Map, flavor: Flavor): void {
  const next = basemapLayers(flavor);
  const anchor = map
    .getStyle()
    .layers.find((l) => !currentBasemapIds.has(l.id))?.id;
  for (const id of currentBasemapIds) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  map.setSprite(asset(`sprites/${flavor}`));
  for (const layer of next) map.addLayer(layer, anchor);
  currentBasemapIds = new Set(next.map((l) => l.id));
}

export interface MapHandles {
  map: maplibregl.Map;
  /** Exposed so locate.ts can subscribe to fixes and mode presets can
   *  trigger the permission prompt from a user gesture. */
  geolocate: maplibregl.GeolocateControl;
}

/** The gesture handlers that can tilt or spin a map, as a structural type so
 *  the rule below is testable without a WebGL context. */
export interface FlatCameraHandles {
  dragRotate: { disable(): void };
  touchZoomRotate: { disableRotation(): void };
  touchPitch: { disable(): void };
  keyboard: { disableRotation(): void };
}

/** Take tilt and rotation away from the rider's fingers.
 *
 *  Extracted from `createMap` so it can be asserted: constructing a real
 *  MapLibre map needs WebGL, so a test that only ever runs through
 *  `createMap` cannot check this rule at all — and this is a rule that failed
 *  silently in production, which is exactly the kind that needs a test.
 *
 *  Programmatic camera moves are untouched: `ride-hud.ts`'s follow-cam drives
 *  pitch and bearing through `easeTo`, which no handler governs. Disabling the
 *  gestures is precisely what lets the follow-cam own tilt outright. */
export function lockToFlatCamera(map: FlatCameraHandles): void {
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.touchPitch.disable();
  // Keyboard pitch/rotate (shift+arrows) goes the same way, and for the same
  // reason: it is a gesture that reaches a framing nothing can undo.
  map.keyboard.disableRotation();
}

export function createMap(container: string, flavor: Flavor = "light"): MapHandles {
  // Register the pmtiles:// protocol so MapLibre can read the self-hosted archive.
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  const map = new maplibregl.Map({
    container,
    style: buildStyle(flavor),
    bounds: DENVER_BOUNDS,
    fitBoundsOptions: { padding: 24 },
    attributionControl: false,
    hash: false,
    maxZoom: 18,
    minZoom: 9,
    // Keeps panning scoped to the metro area (no wandering off to an empty
    // map with no device data) without it being mistaken for a broken drag.
    // The margin beyond DENVER_BOUNDS matters more than it looks: fitBounds
    // picks whichever axis the viewport's aspect ratio constrains harder, so
    // on a wide-but-short window (a maximized-but-not-tall desktop browser,
    // or a phone in landscape) the initial fit already sits close to a thin
    // margin's edge — a single ordinary drag hits it, and since only the
    // pinned axis stops while the other keeps panning, it reads as "grabbing
    // the map doesn't move it right" rather than "reached the edge." Sized
    // to comfortably clear that on realistic desktop window shapes.
    maxBounds: [
      [-105.6, 39.25],
      [-104.1, 40.25],
    ],
  });

  // THE 2D MAP IS NEVER TILTED (frontend plan §6.3.1). The app has exactly
  // two framings: this one, flat, and `ride-hud.ts`'s 3D follow-cam. There is
  // nothing in between and no gesture that produces one.
  //
  // This was a live bug rather than a tidying opportunity. MapLibre enables
  // pitch and rotate by default, so a two-finger drag tilted the map — and the
  // navigation control below is registered `showCompass: false`, which is the
  // only control that would put it back. A rider who tilted the map by
  // accident had no way to undo it.
  //
  // The follow-cam is unaffected: it drives pitch and bearing PROGRAMMATICALLY
  // through `easeTo`, and these handlers only govern what a rider's fingers
  // can do. Disabling them is what lets the follow-cam own tilt outright.
  lockToFlatCamera(map);

  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
    "bottom-left",
  );
  // ONE ⓘ, NOT TWO PILLS. Privacy and Terms used to be their own control in
  // this corner, directly under the attribution — and a second pill of the
  // same size beside the ⓘ made the ⓘ harder to find and harder to hit. That
  // button is not decoration: it carries the OSM/Protomaps attribution, which
  // is a CONDITION of the basemap licence, and the one rule
  // `style.css` already states about it is that it has to open.
  //
  // So the links go INSIDE it instead of beside it. They are the same kind of
  // thing a reader opens that button for — who made this, and under what
  // terms — and `customAttribution` is MapLibre's own seam for exactly this.
  // The corner goes back to two controls, the ⓘ gets its space back, and the
  // links are still one tap from anywhere on the map.
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      // Order here is not the order on screen — MapLibre sorts attributions
      // by length, so the basemap credit lands last behind the two short
      // links. That is fine (it is present and legible, which is what the
      // licence asks) and it is not worth fighting the control over.
      customAttribution: [BASEMAP_ATTRIBUTION, ...legalAttribution()],
    }),
    "bottom-left",
  );
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserLocation: true,
    showAccuracyCircle: true,
  });
  // Registered top-left: chrome.ts adopts this corner's container into the
  // top bar's left cluster, beside the hamburger.
  map.addControl(geolocate, "top-left");



  // Hosts that lay the page out only after scripts run (embedded webviews,
  // headless previews) hand MapLibre a 0×0 container, so it falls back to a
  // 400×300 canvas — and the later 0→real-size transition can miss its
  // ResizeObserver, leaving the map tiny forever. When we start from 0×0,
  // poll each frame until the canvas agrees with the container, then stop.
  // rAF pauses in hidden tabs, so this resumes exactly when layout can
  // actually happen; in a normal browser the container is never 0×0 and the
  // guard doesn't even start.
  if (map.getContainer().clientWidth === 0) {
    let cancelled = false;
    map.once("remove", () => {
      cancelled = true;
    });
    const settle = (): void => {
      if (cancelled) return; // map removed — don't poll (or resize) a corpse
      const el = map.getContainer();
      const canvas = map.getCanvas();
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0 && canvas.clientWidth === w && canvas.clientHeight === h) {
        return; // matched — done for good, ResizeObserver owns it from here
      }
      if (w > 0 && h > 0) map.resize();
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }

  return { map, geolocate };
}
