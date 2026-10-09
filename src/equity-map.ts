// The official Equity Area map on the map, and the on-screen indicator that
// tells a rider when they are looking at one.
//
// Two surfaces, one source of truth (equity-areas.ts):
//
//   * The OVERLAY — the polygons drawn on the map. ON by default now, and
//     MUTED by default: outlines a rider can see without being asked, over a
//     fill faint enough that the basemap and the scooters on top of it still
//     read. The old default was off, for a good reason that turned out to be
//     an argument about opacity rather than about presence — a purple wash
//     over a third of the city is not what someone came for, but the fact
//     that the city drew a line and a discount lives inside it IS the point
//     of this app, and a boundary nobody can see explains nothing. So the
//     boundary is always drawn, quietly; "Muted display" in Areas is what
//     turns it up to the old full-strength wash.
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
import { isRideLive } from "./ios-shake-undo.ts";
import { bandBefore } from "./map-bands.ts";
import type {
  InspectHit,
  InspectLngLat,
  InspectPoint,
  InspectSource,
} from "./map-inspect.ts";
import {
  EQUITY_AREA_COLOR,
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

/** The two strengths the overlay draws at.
 *
 *  MUTED is the default, and it is deliberately outline-forward: the line
 *  carries where the boundary is, and the fill is there only to say which side
 *  of it you are on. At 0.04 two overlapping areas still do not stack into
 *  something that hides the basemap, which is what the old 0.12 did.
 *
 *  FULL is the previous look, kept for a rider actually studying coverage —
 *  the compliance question ("is 30% of the fleet in here?") is asked of the
 *  area, not of the streets, so there the wash is the useful rendering. */
const PAINT = {
  muted: { fill: 0.04, line: 0.45, width: 1 },
  full: { fill: 0.1, line: 0.9, width: 1.8 },
} as const;

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

/** Minimal HTML escape for values interpolated below.
 *
 *  `openFloatingModal` escapes only the TITLE and takes `bodyHtml` raw, so
 *  escaping the body's interpolated values is this function's job. Today
 *  every one of them is ours — an `EQ_\d{3}` name out of a bundled asset,
 *  and two copy constants — so nothing here is currently exploitable. It is
 *  escaped anyway because the safety rests entirely on where the data comes
 *  from, and the next caller to pass this a region name from the API (the
 *  `equity` boundary endpoint serves the same shape) would not think to
 *  check. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Body markup for the explainer, quoting the contract terms verbatim.
 *  `openModal` is injected rather than imported so this module doesn't pull
 *  in devices.ts (and the whole map popup stack) just to render a dialog. */
export function explainerHtml(
  areaName: string | null,
  opts: { receiptButton?: boolean } = {},
): string {
  const where = areaName
    ? `<p class="equity-explainer__where">You're in <strong>${escapeHtml(prettyEquityArea(areaName))}</strong>.</p>`
    : "";
  // Only when there is a form to open — a button wired to nothing is worse
  // than no button. See `EquityAreaMap.openReceiptForm`.
  const receipt = opts.receiptButton
    ? `<button type="button" class="login-btn login-btn--secondary equity-explainer__receipt" data-equity-receipt>Didn't get the discount?</button>`
    : "";
  // Short on purpose (owner, 2026-10-07: "more concise"): where you are,
  // what the ride should cost, that it is automatic whatever your plan, and
  // what to do if it wasn't. EQUITY_DISCOUNT_NOTICE's longer wording stays on
  // the ride HUD.
  return `
    <div class="equity-explainer">
      ${where}
      <p class="equity-explainer__note">
        A ride that <strong>starts or ends</strong> here should cost
        <strong>$1 unlock + 13¢/min</strong> (about $2.30 for 10 minutes),
        whatever plan you're on. Veo applies it automatically under its City
        contract.
      </p>
      <p class="equity-explainer__note">Charged more? Keep a screenshot of the receipt.</p>
      <p class="equity-explainer__note equity-explainer__note--source">
        Map: the City of Denver's official Equity Areas.
      </p>
      ${receipt}
    </div>`;
}

export class EquityAreaMap implements InspectSource {
  private layersAdded = false;
  /** Default ON — see the header. */
  private overlayOn = true;
  /** Default MUTED — see `PAINT`. */
  private muted = true;
  /** The area the chip is currently showing, so a pan within one area
   *  doesn't rewrite the DOM on every frame. */
  private shownArea: string | null | undefined = undefined;

  constructor(
    private readonly map: MLMap,
    private readonly chip: HTMLElement,
    /** Opens the tap explainer. Injected — see explainerHtml. `onOpen` gets
     *  the dialog once it is in the DOM, to wire the receipt button. */
    private readonly openModal: (
      title: string,
      bodyHtml: string,
      onOpen?: (root: HTMLElement | null) => void,
    ) => void,
    /** "Didn't get the discount?" — opens equity-receipt-form.ts. Injected
     *  for the same reason as `openModal`; omitted, the button is not drawn. */
    private readonly openReceiptForm?: () => void,
  ) {}

  /** Open the explainer, with the receipt button wired when there is a form
   *  behind it. Both entry points (the chip, the triple-tap) go through here
   *  so neither can end up with a dead button. */
  private openExplainer(title: string, areaName: string | null): void {
    // NOT WHILE A RIDE IS LIVE. The chip stays on screen through the riding
    // view (the HUD is a transparent, click-through frame there), so the
    // explainer is one tap away mid-ride — and the receipt form behind it has
    // a date and a time picker, which WebKit edits itself and the undo-free
    // guard cannot cover (`ios-shake-undo.ts`). Anything they put in the undo
    // queue mid-ride is offered back as "Undo Typing" on every bump. There is
    // also nothing to file yet: a receipt is for a ride that has ended. The
    // explainer itself has no fields, so it still opens; only the door to the
    // form waits for the ride to finish.
    const openForm = isRideLive() ? undefined : this.openReceiptForm;
    if (!openForm) {
      this.openModal(title, explainerHtml(areaName));
      return;
    }
    this.openModal(title, explainerHtml(areaName, { receiptButton: true }), (root) =>
      root
        ?.querySelector("[data-equity-receipt]")
        ?.addEventListener("click", () => openForm()),
    );
  }

  /** Wire the chip and start watching the map. Loads the geometry lazily,
   *  then syncs once when it lands — a rider who opens the app already
   *  centred on an equity area and never touches the map would otherwise
   *  wait for a `move` that never comes. After that the map's own `move`
   *  and `zoomend` events keep it current. */
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

  isOverlayMuted(): boolean {
    return this.muted;
  }

  /** Show or hide the polygons. Idempotent, and safe to call before the
   *  geometry has loaded — it awaits the fetch. */
  async setOverlayVisible(visible: boolean): Promise<void> {
    // State BEFORE the await: `ensureLayers` builds the layer specs from
    // these fields, and the fetch it waits on can easily outlive the call
    // that asked. Assigning after would build the layers at the old setting
    // and then correct them — a visible flash of the wrong look on arrival.
    this.overlayOn = visible;
    await this.ensureLayers();
    const vis = visible ? "visible" : "none";
    this.map.setLayoutProperty(FILL, "visibility", vis);
    this.map.setLayoutProperty(LINE, "visibility", vis);
  }

  /** Switch between the quiet outline and the full wash. Independent of
   *  visibility on purpose: a rider who turns the overlay off and back on
   *  should find it the strength they left it, not reset to the default. */
  async setOverlayMuted(muted: boolean): Promise<void> {
    this.muted = muted; // before the await — see setOverlayVisible
    await this.ensureLayers();
    this.applyPaint();
  }

  private applyPaint(): void {
    const p = this.muted ? PAINT.muted : PAINT.full;
    this.map.setPaintProperty(FILL, "fill-opacity", p.fill);
    this.map.setPaintProperty(LINE, "line-opacity", p.line);
    this.map.setPaintProperty(LINE, "line-width", p.width);
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
        // Built from the CURRENT state rather than a hardcoded default: the
        // Areas checkboxes may have been restored from storage and applied
        // before the geometry fetch resolved, and a layer that ignored that
        // would flash the default strength on arrival.
        layout: { visibility: this.overlayOn ? "visible" : "none" },
        paint: {
          "fill-color": EQUITY_AREA_COLOR,
          "fill-opacity": (this.muted ? PAINT.muted : PAINT.full).fill,
        },
      },
      bandBefore(this.map, "equity"),
    );
    this.map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        layout: {
          visibility: this.overlayOn ? "visible" : "none",
          "line-join": "round",
        },
        paint: {
          "line-color": EQUITY_AREA_COLOR,
          "line-width": (this.muted ? PAINT.muted : PAINT.full).width,
          "line-opacity": (this.muted ? PAINT.muted : PAINT.full).line,
        },
      },
      bandBefore(this.map, "equity"),
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

  /** `InspectSource` for the triple-tap inspector, second in its order
   *  (under the city's zones, over territory). Only while the overlay is
   *  drawn: with it switched off there is no purple on the map to explain,
   *  and a territory hex the rider CAN see should win the tap. That case is
   *  `hiddenAreaSource()`, which answers beneath territory instead. */
  hitAt(_point: InspectPoint, lngLat: InspectLngLat): InspectHit | null {
    return this.overlayOn && this.layersAdded ? this.hitForLngLat(lngLat) : null;
  }

  /** The Equity Area at `lngLat` when the overlay is OFF — asked after
   *  territory, before the plain-spot card. Being owed a discount is worth
   *  saying even when the boundary is not drawn; the indicator chip makes
   *  the same call. */
  hiddenAreaSource(): InspectSource {
    return {
      // Not drawn = overlay off, or on but not rendered yet.
      hitAt: (_p, lngLat) =>
        this.overlayOn && this.layersAdded ? null : this.hitForLngLat(lngLat),
    };
  }

  hitForLngLat(lngLat: InspectLngLat): InspectHit | null {
    const area = equityAreaAt(lngLat.lng, lngLat.lat);
    if (!area) return null;
    return {
      key: `equity:${area.region_name}`,
      open: () => this.openExplainer("This is an Equity Area", area.region_name),
    };
  }

  /** Open the explainer for whatever the chip is currently showing. */
  explain(): void {
    this.openExplainer("You're in an Equity Area", this.shownArea ?? null);
  }
}
