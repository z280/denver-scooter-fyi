import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { DENVER_BOUNDS, BASEMAP_PMTILES_URL } from "./config.ts";

const BASEMAP_SOURCE = "protomaps";

// Absolute base for self-hosted assets. Built by string concat (not `new URL`)
// so the {fontstack}/{range} glyph tokens are NOT percent-encoded.
const ASSET_BASE = new URL(import.meta.env.BASE_URL, location.origin).href;

function asset(path: string): string {
  return ASSET_BASE + path;
}

function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: asset("fonts/{fontstack}/{range}.pbf"),
    sprite: asset("sprites/light"),
    sources: {
      [BASEMAP_SOURCE]: {
        type: "vector",
        url: `pmtiles://${BASEMAP_PMTILES_URL}`,
        attribution:
          '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> © <a href="https://openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: layers(BASEMAP_SOURCE, namedFlavor("light"), { lang: "en" }),
  };
}

export interface MapHandles {
  map: maplibregl.Map;
  /** Exposed so locate.ts can subscribe to fixes and mode presets can
   *  trigger the permission prompt from a user gesture. */
  geolocate: maplibregl.GeolocateControl;
}

export function createMap(container: string): MapHandles {
  // Register the pmtiles:// protocol so MapLibre can read the self-hosted archive.
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  const map = new maplibregl.Map({
    container,
    style: buildStyle(),
    bounds: DENVER_BOUNDS,
    fitBoundsOptions: { padding: 24 },
    attributionControl: false,
    hash: false,
    maxZoom: 18,
    minZoom: 9,
    maxBounds: [
      [-105.35, 39.45],
      [-104.35, 40.05],
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
  map.addControl(geolocate, "top-right");

  return { map, geolocate };
}
