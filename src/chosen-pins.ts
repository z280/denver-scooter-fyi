// The scooters the rider actually chose, marked out from the fleet.
//
// WHY THIS EXISTS. A plan names two scooters and the map draws them exactly
// like the two hundred it did not pick. The rider walks out of the drawer
// holding "Liftoff 🍉 167, then Perseus 🎯 619" and looks at a field of
// identical dots. The one scooter that matters is the one you cannot find.
//
// It is worse for the HAND-OFF. Leg one's scooter you walk to, and the walk
// flow leads you there; leg two's you have to recognise across a street while
// standing over a scooter you are about to park. "Park it and take another"
// names an action and not a place, and the place is the whole question.
//
// So: a large pin, over the top of everything, labelled. Two kinds, because
// they answer different questions — ⭐ is "this is yours, go to it" and 📍 is
// "this is where you swap". Same shape as trip-pins.ts's layer, and for the
// same reasons: create the source and layers once, then only ever setData;
// the layers are never removed, because the map outlives every panel that
// draws into it.

import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";

import { emptyFC } from "./util.ts";

const SRC = "chosen-pts";
const HALO_LAYER = "chosen-pts-halo";
const PIN_LAYER = "chosen-pts-pin";

/** The colour of "this one is yours". Matches the accent the rest of the app
 *  uses for a chosen thing rather than inventing a sixth map colour. */
const CHOSEN = "#0066ff";
/** The hand-off is a different question, so a different colour — amber reads
 *  as "something happens here" without the alarm of the destination's red. */
const HANDOFF = "#b06a00";

export interface ChosenPin {
  lat: number;
  lon: number;
  label: string;
  /** `first` is the scooter the rider is walking to now; `handoff` is where
   *  they swap. */
  kind: "first" | "handoff";
}

export interface ChosenPinsHandle {
  /** Replaces everything drawn. An empty list clears. */
  set(pins: readonly ChosenPin[]): void;
  clear(): void;
}

export function toFeatureCollection(
  pins: readonly ChosenPin[],
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: {
        kind: p.kind,
        label: p.label,
        glyph: p.kind === "first" ? "⭐" : "📍",
      },
    })),
  };
}

export function createChosenPins(map: MLMap): ChosenPinsHandle {
  const ensureLayers = (): void => {
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data: emptyFC() });

    // A wide, soft halo so the pin is findable while the map is still moving
    // — at a city zoom the glyph itself is a few pixels and the halo is what
    // the eye lands on.
    map.addLayer({
      id: HALO_LAYER,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": 22,
        "circle-color": [
          "case",
          ["==", ["get", "kind"], "handoff"],
          HANDOFF,
          CHOSEN,
        ],
        "circle-opacity": 0.18,
      },
    });

    // Added with no `before`, so this lands ON TOP of the device pins. That
    // is the point: a scooter icon covering the marker would hide the answer
    // to the question the rider just asked.
    map.addLayer({
      id: PIN_LAYER,
      type: "symbol",
      source: SRC,
      layout: {
        "text-field": ["concat", ["get", "glyph"], " ", ["get", "label"]],
        "text-size": 15,
        "text-offset": [0, -1.2],
        "text-anchor": "bottom",
        // NEVER dropped for collision. The fleet is dense and these pins sit
        // in the middle of it, so collision-based placement would hide
        // exactly the marker the rider is looking for, exactly when the map
        // is busiest. An unlabelled marker in a field of scooters confirms
        // nothing.
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": [
          "case",
          ["==", ["get", "kind"], "handoff"],
          HANDOFF,
          CHOSEN,
        ],
        "text-halo-color": "#ffffff",
        "text-halo-width": 2,
      },
    });
  };

  const write = (data: GeoJSON.FeatureCollection): void => {
    // GUARDED like every other layer owner here: `addSource` throws "Style is
    // not done loading" when the map is still booting, and this is called
    // from a panel that can render before the style settles.
    if (!map.isStyleLoaded() && !map.getSource(SRC)) return;
    ensureLayers();
    (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(data);
  };

  return {
    set(pins) {
      write(toFeatureCollection(pins));
    },
    clear() {
      write(emptyFC());
    },
  };
}
