// H3 hexagon shading tool. Grids the map into hexagons at one of three H3
// resolutions and colors each cell by one of seven per-cell metrics — device
// density plus five usage/health metrics (trip activity, battery, risk,
// dwell) that used to require opening every popup by hand, and territory
// control, which colors each cell by whoever holds it.
//
// One fetch per resolution carries all six aggregate metrics together
// (they're all fields on the same per-cell object), so switching among them
// is a local re-render — no extra network round trip. Only a resolution
// change re-fetches.
//
// Territory control is the exception, and deliberately not a seventh field
// on that payload: it comes from `/leaderboard/map`, it only exists at r8,
// and it is colored per-feature by its holder's ruling colors rather than
// off a ramp. It lives here anyway rather than in a map mode of its own
// (which is what it used to be) because from the rider's side it is the
// same question every other metric answers — "shade these hexagons by
// this" — and sharing one fill layer is what lets it compose with the rest
// of the map instead of taking the map over.
//
// Triple-clicking any shaded cell opens its exact value; see
// `triple-click.ts` for why that gesture and not a plainer one.

import { cellToBoundary } from "h3-js";
import type {
  Map as MLMap,
  GeoJSONSource,
  MapLayerMouseEvent,
} from "maplibre-gl";
import {
  fetchH3Aggregates,
  fetchLeaderboardMap,
  type H3AggregatesResponse,
  type H3Resolution,
  type LeaderboardMapResponse,
} from "./api.ts";
import { FIRST_DEVICE_LAYER, formatDwellHours, openFloatingModal } from "./devices.ts";
import {
  LEADERBOARD_DETAIL_TITLE,
  buildLeaderboardDetailHtml,
  escapeHtml,
  formatWindowRange,
  leaderboardMapToFeatureCollection,
} from "./leaderboard.ts";
import { isAuthenticated as defaultIsAuthenticated } from "./map-auth.js";
import {
  TRIPLE_CLICK_WINDOW_MS,
  createTripleClickDetector,
} from "./triple-click.ts";
import { commas, emptyFC, h3ToHex } from "./util.ts";

export type HexSize = "small" | "medium" | "large";
/** Which per-cell value the cell color encodes. The first six are
 *  `H3CellMetrics` fields; `territory_control` is the leaderboard feed. */
export type HexMetric =
  | "device_count"
  | "trips_started_24h"
  | "starts_per_hour_peak"
  | "avg_battery_percent"
  | "risk_share"
  | "avg_dwell_hours"
  | "territory_control";

/** The one metric that is not an H3-aggregates field. Exported because
 *  `main.ts` has to recognize it to pin the size control. */
export const TERRITORY_METRIC = "territory_control" satisfies HexMetric;

/** Territory control exists at r8 and nowhere else: the area-leader report
 *  is computed per r8 cell, so there is no r9/r10 answer to render. That's
 *  why picking it snaps the size control to Large and holds it there —
 *  offering sizes that can only redraw the same hexagons would be a lie. */
export const TERRITORY_HEX_SIZE = "large" satisfies HexSize;

/** Larger cells = coarser H3 resolution. res 8 ≈ 0.7 km edge (large),
 *  res 9 ≈ 0.26 km (medium), res 10 ≈ 0.10 km (small). */
const RES_BY_SIZE: Record<HexSize, H3Resolution> = {
  large: 8,
  medium: 9,
  small: 10,
};

const SRC = "hex-density";
const FILL = "hex-density-fill";
const LINE = "hex-density-line";

/** The aggregate metrics' shared fill opacity and outline. Territory control
 *  overrides all four with per-feature expressions and has to be able to put
 *  them back, so they're named rather than inlined in `ensureLayers`. */
const RAMP_FILL_OPACITY = 0.55;
const RAMP_LINE_COLOR = "#2171b5";
const RAMP_LINE_WIDTH = 0.8;
const RAMP_LINE_OPACITY = 0.45;
const TERRITORY_LINE_WIDTH = 1.2;

/** One sequential ColorBrewer ramp per metric so switching "shade by" is
 *  visually unmistakable even without reading the legend. */
const RAMP_BLUES = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];
const RAMP_PURPLES = ["#dadaeb", "#bcbddc", "#9e9ac8", "#756bb1", "#54278f"];
const RAMP_ORANGES = ["#fdd0a2", "#fdae6b", "#fd8d3c", "#e6550d", "#a63603"];
const RAMP_GREENS = ["#c7e9c0", "#a1d99b", "#74c476", "#31a354", "#006d2c"];
const RAMP_REDS = ["#fcbba1", "#fc9272", "#fb6a4a", "#de2d26", "#a50f15"];
const RAMP_GREYS = ["#d9d9d9", "#bdbdbd", "#969696", "#636363", "#252525"];

/** Every aggregate metric — i.e. every `HexMetric` except the territory
 *  feed, which is rendered and inspected down its own path. */
export type HexRampMetric = Exclude<HexMetric, typeof TERRITORY_METRIC>;

interface MetricConfig {
  /** Human name, used by the triple-click readout (the `<select>` carries
   *  its own copy of these in index.html — this one exists so the readout
   *  doesn't have to reach into the DOM to name what it's showing). */
  label: string;
  ramp: string[];
  /** Legend's high-end label for a given max cell value (the low end is
   *  always "0", the ramp's other fixed point). */
  legendHigh: (max: number) => string;
  /** The triple-click readout's value line. UNLIKE `legendHigh` this must
   *  not round: the whole point of the gesture is to see the number behind
   *  a color, so a metric whose display form is lossy (a share rendered as
   *  a percent, dwell rendered as "3h 20m") states the stored value too. */
  exact: (value: number) => string;
}

/** Drop the trailing garbage a float multiplication leaves behind, without
 *  rounding anything a reader would miss: 12 significant digits is far more
 *  than any of these metrics carries, and well inside the ~15 digits where
 *  doubles stop being exact. */
function trimFloat(n: number): number {
  return Number(n.toPrecision(12));
}

const METRIC: Record<HexRampMetric, MetricConfig> = {
  device_count: {
    label: "Device density",
    ramp: RAMP_BLUES,
    legendHigh: (max) => `${commas(max)} / cell`,
    exact: (v) => `${v.toLocaleString("en-US")} devices`,
  },
  trips_started_24h: {
    label: "Trips started (24h)",
    ramp: RAMP_PURPLES,
    legendHigh: (max) => `${commas(max)} trips / 24h`,
    exact: (v) => `${v.toLocaleString("en-US")} trips in the last 24h`,
  },
  starts_per_hour_peak: {
    label: "Starts per hour (peak)",
    ramp: RAMP_ORANGES,
    legendHigh: (max) => `${commas(max)} starts/hr (peak)`,
    exact: (v) => `${v} starts per hour at peak`,
  },
  avg_battery_percent: {
    label: "Avg. battery",
    ramp: RAMP_GREENS,
    legendHigh: (max) => `${commas(max)}% avg battery`,
    exact: (v) => `${v}% average battery`,
  },
  risk_share: {
    label: "High-risk share",
    ramp: RAMP_REDS,
    legendHigh: (max) => `${commas(max * 100)}% high-risk`,
    // The share itself is the stored value and is printed verbatim; the
    // percent beside it is a restatement, so it drops the float noise
    // `v * 100` introduces (0.3333333333 → 33.333333329999995) rather than
    // presenting an artifact of binary arithmetic as data.
    exact: (v) => `${v} (${trimFloat(v * 100)}% of devices high-risk)`,
  },
  avg_dwell_hours: {
    label: "Avg. dwell time",
    ramp: RAMP_GREYS,
    legendHigh: (max) => `${formatDwellHours(max)} avg dwell`,
    exact: (v) => `${v} hours (${formatDwellHours(v)}) average dwell`,
  },
};

/** Cell-color legend copy for territory control. Not a ramp: the colors are
 *  the riders', so the legend explains the encoding instead of scaling it. */
const TERRITORY_LEGEND_TEXT =
  "Each hexagon takes its holder's ruling colors. Outlined-only cells are unclaimed.";

// ---------------------------------------------------------------------------
// The triple-click readout — pure content generation, no DOM/map, so the
// exact-value formatting is testable on its own.
// ---------------------------------------------------------------------------

export const HEX_INSPECT_TITLE = "⬢ Hexagon detail";

export interface HexInspectInput {
  /** Canonical H3 string (what `h3ToHex` produces), not the API's decimal
   *  id — this is shown to the rider and pasted into other H3 tools. */
  cellId: string;
  metric: HexRampMetric;
  value: number;
  size: HexSize;
}

/** The non-territory readout: which hexagon, and exactly what it's worth.
 *  Escaped for `openFloatingModal`'s caller-escaped-innerHTML contract. */
export function buildHexInspectHtml(input: HexInspectInput): string {
  const cfg = METRIC[input.metric];
  return [
    `<div class="hex-inspect">`,
    `<p class="hex-inspect__cell">H3 cell <code>${escapeHtml(input.cellId)}</code></p>`,
    `<dl class="hex-inspect__rows">`,
    `<dt>Shaded by</dt><dd>${escapeHtml(cfg.label)}</dd>`,
    `<dt>Exact value</dt><dd>${escapeHtml(cfg.exact(input.value))}</dd>`,
    `<dt>Cell size</dt><dd>${escapeHtml(input.size)} (H3 resolution ${RES_BY_SIZE[input.size]})</dd>`,
    `</dl>`,
    `</div>`,
  ].join("");
}

// ---------------------------------------------------------------------------

export interface HexDensityDeps {
  /** Called when the territory readout's "Open profile" button is pressed —
   *  `main.ts` owns the profile button, this module shouldn't know it
   *  exists. Absent = the hint renders without a working button, which is
   *  why the hint itself is only shown when this is wired. */
  openProfile?: () => void;
  /** Defaults to `map-auth.js`'s `isAuthenticated`; injectable for tests. */
  isAuthenticated?: () => boolean;
  /** Both default to `api.ts`'s real fetchers; injectable for tests. */
  fetchTerritory?: (signal?: AbortSignal) => Promise<LeaderboardMapResponse>;
  fetchAggregates?: (
    res: H3Resolution,
    signal?: AbortSignal,
  ) => Promise<H3AggregatesResponse>;
}

export class HexDensity {
  private size: HexSize | null = null;
  private metric: HexMetric = "device_count";
  /** Latest H3 aggregates fetch for the active size — every ramp metric
   *  reads from this same object, since one fetch carries all six fields. */
  private aggregates: H3AggregatesResponse | null = null;
  /** Latest `/leaderboard/map` fetch, backing both the territory fills and
   *  the triple-click detail panel (one payload, no second request). */
  private territory: LeaderboardMapResponse | null = null;
  /** ONE controller for whichever fetch is in flight, aggregates or
   *  territory alike: switching between the two kinds mid-flight has to
   *  cancel the other, and two independent controllers couldn't. */
  private dataController: AbortController | null = null;
  /** cell id → GeoJSON ring, memoized (boundaries never change). */
  private ringCache = new Map<string, GeoJSON.Position[]>();
  private tripleClick = createTripleClickDetector<string>();
  private dczSuppressTimer: number | undefined;
  private dczWasEnabled = false;

  constructor(
    private readonly map: MLMap,
    private readonly legendEl: HTMLElement,
    private readonly deps: HexDensityDeps = {},
  ) {}

  /** Off (null) or one of the three cell sizes. */
  setSize(size: HexSize | null): Promise<void> {
    return this.setView(size, this.metric);
  }

  /** Switch what the cell color encodes, at the current size. */
  setMetric(metric: HexMetric): Promise<void> {
    return this.setView(this.size, metric);
  }

  /** Set both at once. Picking territory control snaps the size control to
   *  Large, so that pick changes both — and doing it in two calls would
   *  fire two fetches and paint an empty frame in between. This is the one
   *  path both setters go through. */
  async setView(size: HexSize | null, metric: HexMetric): Promise<void> {
    const wasTerritory = this.metric === TERRITORY_METRIC;
    const sizeChanged = this.size !== size;
    const metricChanged = this.metric !== metric;
    if (!sizeChanged && !metricChanged) return;
    this.size = size;
    this.metric = metric;
    this.tripleClick.reset();
    // Switching among the six aggregate metrics at an unchanged size is
    // free — they are all fields on the payload already loaded. Changing
    // size, or crossing into or out of territory control (a different
    // endpoint entirely), is not.
    const needsFetch =
      sizeChanged ||
      (metricChanged && (wasTerritory || metric === TERRITORY_METRIC));
    if (needsFetch) {
      await this.syncData();
      // Superseded while the fetch was out — the newer call owns the render.
      if (this.size !== size || this.metric !== metric) return;
    }
    this.render();
  }

  isActive(): boolean {
    return this.size !== null;
  }

  activeMetric(): HexMetric {
    return this.metric;
  }

  /** Re-fetch the active payload on the device-refresh tick (if hex shading
   *  is on) — mirrors Overlays.refreshChoropleth. Both endpoints are
   *  CDN-cached so this is cheap even on the faster poll cadence. */
  async refresh(): Promise<void> {
    if (!this.size) return;
    const size = this.size;
    const metric = this.metric;
    await this.syncData();
    if (this.size === size && this.metric === metric) this.render();
  }

  /** Fetch whatever the active (size, metric) pair needs, canceling any
   *  stale in-flight fetch so a slow response can't clobber a newer one.
   *  No-op when hex shading is off. */
  private async syncData(): Promise<void> {
    this.dataController?.abort();
    this.dataController = null;
    if (!this.size) return;
    const controller = new AbortController();
    this.dataController = controller;
    const territory = this.metric === TERRITORY_METRIC;
    try {
      if (territory) {
        const fetchTerritory = this.deps.fetchTerritory ?? fetchLeaderboardMap;
        const data = await fetchTerritory(controller.signal);
        // Only the most recent request may commit — abort() doesn't guarantee
        // an older in-flight fetch can't still resolve after a newer one.
        if (this.dataController === controller) this.territory = data;
      } else {
        const fetchAggregates = this.deps.fetchAggregates ?? fetchH3Aggregates;
        const data = await fetchAggregates(
          RES_BY_SIZE[this.size],
          controller.signal,
        );
        if (this.dataController === controller) this.aggregates = data;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error(
        territory ? "leaderboard map fetch failed" : "h3 aggregates fetch failed",
        e,
      );
      if (this.dataController === controller) {
        if (territory) this.territory = null;
        else this.aggregates = null;
      }
    }
  }

  private ensureLayers(): void {
    if (this.map.getSource(SRC)) return;
    this.map.addSource(SRC, { type: "geojson", data: emptyFC() });
    const before = this.map.getLayer(FIRST_DEVICE_LAYER)
      ? FIRST_DEVICE_LAYER
      : undefined;
    this.map.addLayer(
      {
        id: FILL,
        type: "fill",
        source: SRC,
        paint: { "fill-opacity": RAMP_FILL_OPACITY, "fill-color": "#6baed6" },
      },
      before,
    );
    this.map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        paint: {
          "line-color": RAMP_LINE_COLOR,
          "line-width": RAMP_LINE_WIDTH,
          "line-opacity": RAMP_LINE_OPACITY,
        },
      },
      before,
    );
    this.map.on("click", FILL, (e) => this.handleClick(e));
  }

  private render(): void {
    if (!this.size) {
      this.clear();
      return;
    }
    this.ensureLayers();
    if (this.metric === TERRITORY_METRIC) {
      this.renderTerritory();
      return;
    }
    const metric = this.metric;
    const values = this.metricValues(metric);

    let max = 0;
    const feats: GeoJSON.Feature<
      GeoJSON.Polygon,
      { value: number; cell: string }
    >[] = [];
    for (const [id, value] of values) {
      const ring = this.ring(id);
      if (!ring) continue;
      if (value > max) max = value;
      feats.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        // `cell` rides along for the triple-click readout: the aggregates
        // payload keys cells by the API's decimal id, and the canonical h3
        // string is the one worth showing a rider.
        properties: { value, cell: h3ToHex(id) },
      });
    }
    // Only guard the degenerate all-zero/empty case (MapLibre's interpolate
    // stops must be strictly increasing) — don't force a floor of 1, or a
    // fractional metric like risk_share gets its legend/ramp inflated to
    // "100%" whenever the real max is under 1.
    if (max <= 0) max = 1;

    const src = this.map.getSource(SRC) as GeoJSONSource;
    src.setData({ type: "FeatureCollection", features: feats });

    const ramp = METRIC[metric].ramp;
    const stops: (number | string)[] = [];
    ramp.forEach((color, i) => {
      stops.push((max * i) / (ramp.length - 1), color);
    });
    this.map.setPaintProperty(FILL, "fill-color", [
      "interpolate",
      ["linear"],
      ["get", "value"],
      ...stops,
    ]);
    // Put back whatever a previous territory render overrode.
    this.map.setPaintProperty(FILL, "fill-opacity", RAMP_FILL_OPACITY);
    this.map.setPaintProperty(LINE, "line-color", RAMP_LINE_COLOR);
    this.map.setPaintProperty(LINE, "line-width", RAMP_LINE_WIDTH);
    this.map.setPaintProperty(LINE, "line-opacity", RAMP_LINE_OPACITY);

    this.renderLegend(max);
  }

  /** Territory control paints per-feature rather than off a ramp: the color
   *  IS the holder's, carried on each feature by
   *  `leaderboardMapToFeatureCollection`. */
  private renderTerritory(): void {
    const src = this.map.getSource(SRC) as GeoJSONSource;
    src.setData(
      this.territory
        ? leaderboardMapToFeatureCollection(this.territory)
        : emptyFC(),
    );
    this.map.setPaintProperty(FILL, "fill-color", ["get", "fillColor"]);
    this.map.setPaintProperty(FILL, "fill-opacity", ["get", "fillOpacity"]);
    this.map.setPaintProperty(LINE, "line-color", ["get", "lineColor"]);
    this.map.setPaintProperty(LINE, "line-opacity", ["get", "lineOpacity"]);
    this.map.setPaintProperty(LINE, "line-width", TERRITORY_LINE_WIDTH);
    this.renderTerritoryLegend();
  }

  /** Read one metric field per cell from the last aggregates fetch,
   *  skipping cells where it's null (e.g. avg_battery_percent for a cell
   *  with no parked devices). */
  private metricValues(metric: HexRampMetric): Map<string, number> {
    const values = new Map<string, number>();
    if (!this.aggregates) return values;
    for (const [id, cell] of Object.entries(this.aggregates.cells)) {
      const v = cell[metric];
      if (v === null || v === undefined) continue;
      values.set(id, v);
    }
    return values;
  }

  private ring(id: string): GeoJSON.Position[] | null {
    const cached = this.ringCache.get(id);
    if (cached) return cached;
    try {
      // h3-js returns [lat, lng]; flip to GeoJSON [lng, lat] and close the ring.
      const boundary = cellToBoundary(h3ToHex(id));
      const ring = boundary.map(([lat, lng]) => [lng, lat] as GeoJSON.Position);
      if (ring.length > 0) ring.push(ring[0]);
      if (ring.length < 4) return null;
      this.ringCache.set(id, ring);
      return ring;
    } catch {
      return null;
    }
  }

  private clear(): void {
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    src?.setData(emptyFC());
    this.legendEl.hidden = true;
    this.tripleClick.reset();
    this.restoreDoubleClickZoom();
  }

  private renderLegend(max: number): void {
    const metric = this.metric as HexRampMetric;
    this.legendEl.replaceChildren();
    const bar = document.createElement("div");
    bar.className = "legend__bar";
    for (const color of METRIC[metric].ramp) {
      const sw = document.createElement("span");
      sw.className = "legend__swatch";
      sw.style.background = color;
      bar.appendChild(sw);
    }
    const scale = document.createElement("div");
    scale.className = "legend__scale";
    const lo = document.createElement("span");
    lo.textContent = "0";
    const hi = document.createElement("span");
    hi.textContent = METRIC[metric].legendHigh(max);
    scale.append(lo, hi);
    this.legendEl.append(bar, scale);
    this.legendEl.hidden = false;
  }

  private renderTerritoryLegend(): void {
    this.legendEl.replaceChildren();
    const note = document.createElement("p");
    note.className = "legend__note";
    note.textContent = TERRITORY_LEGEND_TEXT;
    this.legendEl.appendChild(note);
    if (this.territory) {
      const window_ = document.createElement("p");
      window_.className = "legend__note";
      window_.textContent = `Window: ${formatWindowRange(this.territory.window_start, this.territory.window_end)}`;
      this.legendEl.appendChild(window_);
    }
    this.legendEl.hidden = false;
  }

  // -------------------------------------------------------------------------
  // Triple-click readout.
  // -------------------------------------------------------------------------

  private handleClick(e: MapLayerMouseEvent): void {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as { cell?: unknown; value?: unknown } | null;
    const cellId = String(props?.cell ?? "");
    if (!cellId) return;
    if (!this.tripleClick.register(cellId)) {
      // A run is under way. The map's own double-click zoom would fire on
      // the way to the third click and yank the target out from under the
      // pointer, so it's held off for the length of the window — narrowly,
      // and only once a click has actually landed on a hexagon.
      this.suppressDoubleClickZoom();
      return;
    }
    this.restoreDoubleClickZoom();
    if (this.metric === TERRITORY_METRIC) this.openTerritoryDetail(cellId);
    else this.openMetricDetail(cellId, Number(props?.value));
  }

  private openTerritoryDetail(cellId: string): void {
    const resp = this.territory;
    if (!resp) return;
    const signedIn = (this.deps.isAuthenticated ?? defaultIsAuthenticated)();
    const openProfile = this.deps.openProfile;
    const html = buildLeaderboardDetailHtml({
      cellId,
      cell: resp.cells[cellId] ?? null,
      windowStart: resp.window_start,
      windowEnd: resp.window_end,
      // No point inviting someone to open a profile pane this module has no
      // way to reach.
      signedIn: signedIn && !!openProfile,
    });
    openFloatingModal(LEADERBOARD_DETAIL_TITLE, html, (root) => {
      root
        ?.querySelector<HTMLButtonElement>('[data-action="open-profile"]')
        ?.addEventListener("click", () => {
          document
            .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")
            ?.click();
          openProfile?.();
        });
    });
  }

  private openMetricDetail(cellId: string, value: number): void {
    if (!this.size || !Number.isFinite(value)) return;
    openFloatingModal(
      HEX_INSPECT_TITLE,
      buildHexInspectHtml({
        cellId,
        metric: this.metric as HexRampMetric,
        value,
        size: this.size,
      }),
    );
  }

  /** Hold the map's double-click/double-tap zoom for one triple-click
   *  window. Deliberately not a permanent disable while shading is on:
   *  double-click zoom is how people navigate, and it stays available
   *  everywhere except the fraction of a second after a click has landed on
   *  a hexagon. Restores only what it turned off — if the map had double-
   *  click zoom disabled already, it stays that way. */
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
