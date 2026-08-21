// The official Equity Area map on the map, and the on-screen indicator that
// tells a rider when they are looking at one.
//
// Two surfaces, one source of truth (equity-areas.ts):
//
//   * The OVERLAY — the polygons drawn on the map. Off by default. It is a
//     compliance boundary, not a rider feature; most people opening this app
//     want to find a scooter, and a purple wash over a third of the city is
//     not what they came for. Riders who want it turn it on in Areas.
//
//   * The INDICATOR — a chip that appears when the map is zoomed into an
//     equity area, saying "$0.13/min", and explains itself when tapped.
//     This one IS a rider feature, and the whole point of the app: the
//     discount exists in a contract, and a rider standing in the area has
//     no way to know they are owed it.
//
// The overlay does NOT gate the indicator. Someone who never turns on the
// polygons still gets told they are in one — otherwise the discount stays
// discoverable only by people already looking for it, which is the exact
// asymmetry this app exists to fix.
//
// WHAT THE INDICATOR MEASURES ---------------------------------------------
// The map's CENTER, not the rider's GPS. The chip says "you are looking at
// an equity area", which is true of a rider standing in one (the map
// follows them) and also true of someone checking before they walk over.
// Keying it to GPS would make it silent for everyone who has not granted
// location permission — most first visits — and it is a claim about the
// map, which is the thing on screen.

import type { Map as MLMap } from "maplibre-gl";
import { FIRST_DEVICE_LAYER } from "./devices.ts";
import {
  EQUITY_AREA_COLOR,
  EQUITY_AREA_UNLOCK_NOTE,
  EQUITY_DISCOUNT_NOTICE,
  EQUITY_INDICATOR_LABEL,
  EQUITY_INDICATOR_MIN_ZOOM,
  equityAreaAt,
  isInEquityArea,
  loadEquityAreas,
  prettyEquityArea,
} from "./equity-areas.ts";

const SRC = "equity-areas";
const FILL = "equity-areas-fill";
const LINE = "equity-areas-line";

/** What the indicator should currently say, given a map position. Pure, so
 *  the decision is testable without a map or a DOM.
 *
 *  `null` means "show nothing", and it covers three genuinely different
 *  situations that all warrant silence: zoomed too far out to be making a
 *  claim about a place, not in an area, and — importantly — the map not
 *  loaded yet. That last one is why `isInEquityArea` returns null rather
 *  than false: telling a rider they are NOT in an equity area because we
 *  have not looked yet is a wrong answer, where saying nothing is merely
 *  an absent one. */
export function indicatorState(
  zoom: number,
  lng: number,
  lat: number,
): { areaName: string | null } | null {
  if (zoom < EQUITY_INDICATOR_MIN_ZOOM) return null;
  const inside = isInEquityArea(lng, lat);
  if (inside !== true) return null;
  return { areaName: equityAreaAt(lng, lat)?.region_name ?? null };
}

/** Body markup for the explainer, quoting the contract terms verbatim.
 *  `openModal` is injected rather than imported so this module doesn't pull
 *  in devices.ts (and the whole map popup stack) just to render a dialog. */
export function explainerHtml(areaName: string | null): string {
  const where = areaName
    ? `<p class="equity-explainer__where">You're looking at <strong>${prettyEquityArea(areaName)}</strong>.</p>`
    : "";
  return `
    <div class="equity-explainer">
      ${where}
      <p class="equity-explainer__quote">${EQUITY_DISCOUNT_NOTICE}</p>
      <p class="equity-explainer__note">${EQUITY_AREA_UNLOCK_NOTE}</p>
      <p class="equity-explainer__note">
        The discount applies to a ride that <strong>starts or ends</strong> in
        an equity area — not only one that stays inside the whole way, and you
        do not have to enroll in anything: the contract says Veo applies it
        automatically. If your receipt charges the standard rate, the
        screenshot is what makes the difference provable later.
      </p>
      <p class="equity-explainer__note equity-explainer__note--source">
        Boundaries: the City of Denver's official Equity Area map for the Veo
        contract. It is the same map this app's daily compliance numbers are
        computed against.
      </p>
    </div>`;
}

export class EquityAreaMap {
  private layersAdded = false;
  private overlayOn = false;
  /** The area the chip is currently showing, so a pan within one area
   *  doesn't rewrite the DOM on every frame. */
  private shownArea: string | null | undefined = undefined;

  constructor(
    private readonly map: MLMap,
    private readonly chip: HTMLElement,
    /** Opens the tap explainer. Injected — see explainerHtml. */
    private readonly openModal: (title: string, bodyHtml: string) => void,
  ) {}

  /** Wire the chip and start watching the map. Loads the geometry lazily:
   *  the first `move` after the fetch lands is what reveals the chip, and
   *  the map fires those constantly, so no explicit re-render is needed. */
  wire(): void {
    this.chip.addEventListener("click", () => this.explain());
    this.map.on("move", () => this.syncIndicator());
    this.map.on("zoomend", () => this.syncIndicator());
    void loadEquityAreas()
      .then(() => this.syncIndicator())
      .catch((e) => {
        // A rider who can't load the map still gets a working app; the chip
        // simply never appears. Worth a console line, not a banner.
        console.error("equity areas failed to load", e);
      });
  }

  isOverlayVisible(): boolean {
    return this.overlayOn;
  }

  /** Show or hide the polygons. Idempotent, and safe to call before the
   *  geometry has loaded — it awaits the fetch. */
  async setOverlayVisible(visible: boolean): Promise<void> {
    await this.ensureLayers();
    this.overlayOn = visible;
    const vis = visible ? "visible" : "none";
    this.map.setLayoutProperty(FILL, "visibility", vis);
    this.map.setLayoutProperty(LINE, "visibility", vis);
  }

  private async ensureLayers(): Promise<void> {
    if (this.layersAdded) return;
    const data = await loadEquityAreas();
    // Re-check after the await: two concurrent callers (the Areas toggle and
    // a deep link, say) can both get past the guard above before either
    // finishes, and addSource throws on a duplicate id.
    if (this.layersAdded) return;
    this.map.addSource(SRC, { type: "geojson", data });
    this.map.addLayer(
      {
        id: FILL,
        type: "fill",
        source: SRC,
        layout: { visibility: "none" },
        // Lighter than the retired overlays' 0.12: this one covers a large
        // share of the city, and at 0.12 the basemap underneath stopped
        // being readable where two areas met.
        paint: { "fill-color": EQUITY_AREA_COLOR, "fill-opacity": 0.1 },
      },
      FIRST_DEVICE_LAYER,
    );
    this.map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        layout: { visibility: "none", "line-join": "round" },
        paint: {
          "line-color": EQUITY_AREA_COLOR,
          "line-width": 1.8,
          "line-opacity": 0.9,
        },
      },
      FIRST_DEVICE_LAYER,
    );
    this.layersAdded = true;
  }

  /** Reconcile the chip with where the map is now. Called on every `move`,
   *  so it does the cheap zoom check first and bails before any
   *  point-in-polygon work when the map is zoomed out. */
  syncIndicator(): void {
    const c = this.map.getCenter();
    const state = indicatorState(this.map.getZoom(), c.lng, c.lat);
    const areaName = state?.areaName ?? null;

    if (!state) {
      if (this.shownArea !== undefined) {
        this.chip.hidden = true;
        this.shownArea = undefined;
      }
      return;
    }
    if (this.shownArea === areaName && !this.chip.hidden) return;

    this.shownArea = areaName;
    this.chip.hidden = false;
    this.chip.textContent = EQUITY_INDICATOR_LABEL;
    this.chip.setAttribute(
      "aria-label",
      areaName
        ? `${prettyEquityArea(areaName)} — rides that start or end here should cost 13 cents a minute. Tap for details.`
        : "Equity area — rides that start or end here should cost 13 cents a minute. Tap for details.",
    );
  }

  /** Open the explainer for whatever the chip is currently showing. */
  explain(): void {
    this.openModal(
      "You're in an Equity Area",
      explainerHtml(this.shownArea ?? null),
    );
  }
}
