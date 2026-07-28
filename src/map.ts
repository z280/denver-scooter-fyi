import maplibregl, {
  type LayerSpecification,
  type StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { DENVER_BOUNDS, BASEMAP_PMTILES_URL } from "./config.ts";

const BASEMAP_SOURCE = "protomaps";

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

function buildStyle(flavor: Flavor): StyleSpecification {
  const base = basemapLayers(flavor);
  currentBasemapIds = new Set(base.map((l) => l.id));
  return {
    version: 8,
    glyphs: asset("fonts/{fontstack}/{range}.pbf"),
    sprite: asset(`sprites/${flavor}`),
    sources: {
      [BASEMAP_SOURCE]: {
        type: "vector",
        url: `pmtiles://${BASEMAP_PMTILES_URL}`,
        attribution:
          '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> © <a href="https://openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: base,
  };
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

  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
    "bottom-left",
  );
  map.addControl(
    new maplibregl.AttributionControl({ compact: true }),
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
