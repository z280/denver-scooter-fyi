// The /analytics page: how Veo's Denver fleet performs, for the owner and
// anyone they send the link to (docs: the API repo's PLAN_FLEET_ANALYTICS.md).
//
// Its own Vite entry (analytics.html), like embed/stats: no map, no account
// state, nothing that adds a byte to the map's bundle.
//
// THE RULES THIS PAGE KEEPS, in the order a reader would notice them broken:
//   * Every chart states its window (Denver time), its sample and the API's
//     own definition line — and its caveat, where the API gives one. A figure
//     without them is not shown at all (a card waits in "Loading" instead).
//   * One failing endpoint costs one card. Each chart loads, fails and
//     retries on its own; the rest of the page is unaffected.
//   * Null is not zero. A bucket with no data is a gap in a line or a shaded
//     slot in a bar chart, never a dip to the axis (analytics-data.ts).
//   * scooter.fyi reports, it does not argue: the copy says what was counted.

import "./analytics.css";

import { fetchBoundary, fetchSpatialSnapshot, NoDataError } from "./api.ts";
import {
  fetchAnalyticsDevicesByRegion,
  fetchAnalyticsDwell,
  fetchAnalyticsEquity,
  fetchAnalyticsFailedStarts,
  fetchAnalyticsFleetCounts,
  fetchAnalyticsFleetStatus,
  fetchAnalyticsRides,
  FLEET_STATUS_RETENTION_DAYS,
  type AnalyticsDwellResponse,
  type AnalyticsFleetCountsResponse,
  type AnalyticsGranularity,
  type AnalyticsRegionLayer,
  type AnalyticsRegionType,
  type AnalyticsCountingEras,
  type CountingChange,
} from "./analytics-api.ts";
import {
  anyOlder,
  asOfLabel,
  changeMarkers,
  changeWhen,
  olderMask,
  spanBand,
  type SlotChart,
  clampDays,
  commas,
  controlsFromSearch,
  controlsToSearch,
  dateLabel,
  denverLocalToUtc,
  GRANULARITIES,
  GRANULARITY_LABELS,
  lineSeries,
  modelLabel,
  modelStacks,
  orderModels,
  plural,
  REGION_TYPE_LABELS,
  REGION_TYPES,
  regionLabel,
  sortRegionNames,
  updateControls,
  WINDOW_OPTIONS,
  windowAllowed,
  windowLabel,
  windowOptionLabel,
  type ControlsState,
} from "./analytics-data.ts";
import {
  dataTable,
  h,
  legend,
  renderHeatTable,
  renderLines,
  renderRankedBars,
  renderStackedBars,
  type Marker,
} from "./analytics-charts.ts";

/** Drop the nulls from a list of optional nodes. */
const present = (...nodes: (HTMLElement | null)[]): HTMLElement[] => nodes.filter((n): n is HTMLElement => !!n);

// ---------------------------------------------------------------------------
// A chart card: title, window/sample line, body, legend, definition, caveat
// ---------------------------------------------------------------------------

export interface CardMeta {
  /** "Sep 7 – Oct 7, Denver time" — required: no figure without a window. */
  window: string;
  /** "12,345 rides" — required: no figure without a sample. */
  sample: string;
  definition: string;
  caveat?: string;
  /** Extra factual notes (data-through, region), shown muted. */
  notes?: string[];
}

export class Card {
  readonly root: HTMLElement;
  readonly controls: HTMLElement;
  readonly body: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly foot: HTMLElement;

  constructor(id: string, title: string) {
    this.root = h("section", "an-card");
    this.root.id = id;
    this.root.setAttribute("aria-labelledby", `${id}-h`);
    const head = h("header", "an-card__head");
    const h2 = h("h2", "an-card__title", title);
    h2.id = `${id}-h`;
    this.meta = h("p", "an-card__meta");
    this.controls = h("div", "an-card__controls");
    head.append(h2, this.meta);
    this.body = h("div", "an-card__body");
    this.foot = h("div", "an-card__foot");
    this.root.append(head, this.controls, this.body, this.foot);
  }

  setTitle(title: string): void {
    this.root.querySelector(".an-card__title")!.textContent = title;
  }

  setLoading(text = "Loading…"): void {
    this.root.setAttribute("aria-busy", "true");
    this.meta.textContent = "";
    this.foot.replaceChildren();
    this.body.replaceChildren(h("div", "an-state an-state--loading", text));
  }

  setError(err: unknown, retry?: () => void): void {
    this.root.removeAttribute("aria-busy");
    this.meta.textContent = "";
    this.foot.replaceChildren();
    const box = h("div", "an-state an-state--error");
    box.setAttribute("role", "alert");
    box.append(
      h(
        "span",
        undefined,
        err instanceof NoDataError
          ? `No data for this view yet (${err.status}).`
          : "This chart could not load. The rest of the page is unaffected.",
      ),
    );
    if (retry) {
      const b = h("button", "an-btn", "Retry");
      b.type = "button";
      b.addEventListener("click", retry);
      box.append(b);
    }
    this.body.replaceChildren(box);
  }

  /** Render a figure. The meta goes on first, so there is no moment where a
   *  chart is on screen without its window and sample. */
  show(meta: CardMeta, draw: (body: HTMLElement, foot: HTMLElement) => void): void {
    this.root.removeAttribute("aria-busy");
    this.meta.replaceChildren(
      h("span", "an-window", meta.window),
      document.createTextNode(" · "),
      h("span", "an-sample", meta.sample),
    );
    this.foot.replaceChildren();
    this.body.replaceChildren();
    draw(this.body, this.foot);
    for (const n of meta.notes ?? []) this.foot.append(h("p", "an-note", n));
    this.foot.append(h("p", "an-def", meta.definition));
    if (meta.caveat) {
      const c = h("p", "an-caveat", meta.caveat);
      c.setAttribute("role", "note");
      this.foot.append(c);
    }
  }
}

// ---------------------------------------------------------------------------
// Loaders: one per chart, each independent
// ---------------------------------------------------------------------------

interface Loader {
  /** Which controls this chart depends on; it reloads only when this changes. */
  key(s: ControlsState): string;
  load(s: ControlsState): void;
}

function makeLoader<T>(
  card: Card,
  key: (s: ControlsState) => string,
  fetcher: (s: ControlsState, signal: AbortSignal) => Promise<T> | null,
  render: (data: T, s: ControlsState) => void,
  waiting = "Loading the region list…",
): Loader {
  let ctl: AbortController | null = null;
  let seq = 0;
  const load = (s: ControlsState) => {
    ctl?.abort();
    ctl = new AbortController();
    const mine = ++seq;
    const p = fetcher(s, ctl.signal);
    if (!p) {
      card.setLoading(waiting);
      return;
    }
    card.setLoading();
    p.then(
      (data) => {
        if (mine !== seq) return;
        try {
          render(data, s);
        } catch (e) {
          console.error("analytics render failed", e);
          card.setError(e, () => load(s));
        }
      },
      (e) => {
        if (mine !== seq || (e as Error)?.name === "AbortError") return;
        console.warn("analytics fetch failed", e);
        card.setError(e, () => load(s));
      },
    );
  };
  return { key, load };
}

function opt(label: string, value: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

const gName = (g: AnalyticsGranularity) => g; // "hour", "day", …
const plainNum = (v: number) => (Number.isInteger(v) ? commas(v) : v.toFixed(1));

function regionPhrase(type: AnalyticsRegionType, name: string): string {
  return type === "city" ? "All of Denver" : regionLabel(name, type);
}

/** The note that explains a lighter bar / dashed segment, when there is one. */
export function partialNote(chart: { partial: boolean[] }, mark: "bar" | "line"): string[] {
  const n = chart.partial.filter(Boolean).length;
  if (!n) return [];
  const what =
    mark === "bar"
      ? n === 1 ? "The lighter, outlined bar is an incomplete bucket" : `The ${n} lighter, outlined bars are incomplete buckets`
      : n === 1 ? "The dotted end of the line is an incomplete bucket" : `Dotted line segments mark ${n} incomplete buckets`;
  return [`${what}: counted so far, not a total.`];
}

/** Days to ask fleet-status for: its source keeps only `retention` days,
 *  and the endpoint refuses more with a 400. */
export function fleetStatusDays(days: number, retention: number): number {
  return Math.max(1, Math.min(days, retention));
}

function throughNote(dataThrough: string | null, windowEnd: string, unplaced = 0): string[] {
  const out: string[] = [];
  if (unplaced) out.push(`${plural(unplaced, "bucket")} from the API did not match this axis and ${unplaced === 1 ? "is" : "are"} not drawn.`);
  return [...out, ...throughLine(dataThrough, windowEnd)];
}

function throughLine(dataThrough: string | null, windowEnd: string): string[] {
  if (!dataThrough) return ["Nothing has been counted for this window yet."];
  if (Date.parse(dataThrough) < Date.parse(windowEnd)) {
    return [`Counted through ${asOfLabel(dataThrough)}; later buckets are shaded as not yet counted.`];
  }
  return [];
}

/** The failed-start undercount as a shaded span: from the Denver date
 *  `since` to the fix (`until`, UTC ISO). An older API sends no `until`, and
 *  then the span is open-ended, as the undercount then was. `whole` = it
 *  covers every bucket on the axis. */
export function undercountBand(
  slots: number[],
  g: AnalyticsGranularity,
  since: string,
  until?: string,
): { from: number; to: number; whole: boolean } | null {
  const [y, m, d] = since.split("-").map(Number);
  const from = denverLocalToUtc(y, m, d);
  const toParsed = until ? Date.parse(until) : NaN;
  const to = Number.isFinite(toParsed) ? toParsed : Infinity;
  if (!Number.isFinite(from)) return null;
  const band = spanBand(slots, g, from, to);
  return band ? { ...band, whole: band.from === 0 && band.to === slots.length } : null;
}

/** "Why the history jumps": the counting changes, collapsed by default.
 *  Null when the response carries none (an older API, or none apply). */
export function erasDetails(changes: CountingChange[] | undefined): HTMLElement | null {
  if (!changes?.length) return null;
  const d = h("details", "an-eras");
  d.append(h("summary", undefined, "Why the history jumps"));
  const ol = h("ol");
  for (const c of changes) {
    const li = h("li");
    const t = h("time", undefined, changeWhen(c.at));
    t.setAttribute("datetime", c.at);
    li.append(t, document.createTextNode(` — ${c.summary}${c.commit ? ` (${c.commit})` : ""}`));
    ol.append(li);
  }
  d.append(ol);
  return d;
}

/** Legend entry for muted, older-method buckets; null when none are shown. */
function olderLegend(chart: SlotChart): HTMLElement | null {
  if (!anyOlder(chart.older)) return null;
  return legend([{ name: "Older counting method — not comparable", color: "transparent", swatchClass: "viz-swatch--older" }]);
}

/** Era fields onto a bar chart: the muted mask and one marker per change. */
function withEras(chart: SlotChart, eras: AnalyticsCountingEras): { chart: SlotChart; markers: Marker[] } {
  const older = olderMask(chart.slots, eras.comparable_since);
  return {
    chart: { ...chart, older },
    markers: changeMarkers(chart.slots, chart.granularity, eras.counting_changes),
  };
}

function modelLegend(series: { name: string; color: string; values: (number | null)[] }[], unit: string) {
  return legend(
    series.map((s) => ({
      name: s.name,
      color: s.color,
      note: `(${commas(s.values.reduce<number>((a, v) => a + (v ?? 0), 0))} ${unit})`,
    })),
  );
}

// ---------------------------------------------------------------------------
// The number cards (#8)
// ---------------------------------------------------------------------------

export function renderCounts(container: HTMLElement, data: AnalyticsFleetCountsResponse): void {
  const tiles = h("div", "an-tiles");
  const tile = (value: number | null, label: string, sub: string, cls = "") => {
    const t = h("div", `an-tile ${cls}`.trim());
    t.append(
      h("div", "an-tile__value", value === null ? "—" : commas(value)),
      h("div", "an-tile__label", label),
      h("div", "an-tile__sub", sub),
    );
    tiles.append(t);
  };
  tile(data.visible_now, "Vehicles visible now", `Latest feed cycle, any status · as of ${asOfLabel(data.as_of)}`, "an-tile--lead");
  // Merge raw keys that share a label (a "Trike" and a "Rover" are one model).
  const ever = new Map<string, number>();
  for (const [raw, n] of Object.entries(data.ever_seen_by_model)) {
    ever.set(modelLabel(raw), (ever.get(modelLabel(raw)) ?? 0) + n);
  }
  const nowBy = new Map<string, number>();
  for (const [raw, n] of Object.entries(data.visible_now_by_model)) {
    nowBy.set(modelLabel(raw), (nowBy.get(modelLabel(raw)) ?? 0) + n);
  }
  const since = data.ever_seen_since ? `since ${asOfLabel(data.ever_seen_since).replace(/,.*$/, "")}` : "since tracking began";
  for (const m of orderModels(ever.keys())) {
    tile(ever.get(m) ?? 0, m, `ever seen ${since} · ${commas(nowBy.get(m) ?? 0)} on the map now`);
  }
  const foot = h("p", "an-def", data.definition);
  const total = h("p", "an-note", `${commas(data.ever_seen_total)} distinct vehicles ever seen ${since}.`);
  container.replaceChildren(tiles, total, foot);
}

// ---------------------------------------------------------------------------
// Dwell table data (#6)
// ---------------------------------------------------------------------------

export function dwellTable(res: AnalyticsDwellResponse) {
  const columns = orderModels(res.models);
  const rows = [...res.regions]
    .sort((a, b) =>
      regionLabel(a.region, res.region_type).localeCompare(regionLabel(b.region, res.region_type), "en", { numeric: true }),
    )
    .map((r) => ({
      label: regionPhrase(res.region_type, r.region),
      cells: columns.map((col) => {
        const cells = Object.entries(r.by_model).filter(([raw]) => modelLabel(raw) === col).map(([, c]) => c);
        if (!cells.length) return null;
        const count = cells.reduce((s, c) => s + c.dwells, 0);
        // Recombine only if every part had an average; else counts only.
        const value = cells.every((c) => c.average_minutes !== null)
          ? cells.reduce((s, c) => s + (c.average_minutes as number) * c.dwells, 0) / Math.max(1, count)
          : null;
        return { value: value === null ? null : Math.round(value * 10) / 10, count };
      }),
    }));
  const dwells = rows.reduce((s, r) => s + r.cells.reduce((a, c) => a + (c?.count ?? 0), 0), 0);
  return { columns, rows, dwells };
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min.toFixed(min < 10 ? 1 : 0)} min`;
  const hrs = min / 60;
  if (hrs < 48) return `${hrs.toFixed(1)} h`;
  return `${(hrs / 24).toFixed(1)} d`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface MountOptions {
  search: string;
  /** Called with the new query string whenever the controls change. */
  onState?: (search: string) => void;
}

export function mountAnalytics(root: HTMLElement, opts: MountOptions): { state: () => ControlsState } {
  let state = controlsFromSearch(opts.search);
  const regionNames = new Map<AnalyticsRegionLayer, Promise<string[]>>();
  // fleet-status's source keeps only this many days; learned from the
  // response's retention_days once one arrives.
  let fleetRetention = FLEET_STATUS_RETENTION_DAYS;

  // ----- controls
  const bar = h("form", "an-controls");
  bar.setAttribute("aria-label", "Chart controls");
  bar.addEventListener("submit", (e) => e.preventDefault());
  const field = (label: string, sel: HTMLSelectElement) => {
    const l = h("label", "an-field");
    l.append(h("span", "an-field__label", label), sel);
    bar.append(l);
    return l;
  };
  const winSel = h("select");
  winSel.name = "days";
  const granSel = h("select");
  granSel.name = "granularity";
  for (const g of GRANULARITIES) granSel.append(opt(GRANULARITY_LABELS[g], g));
  const layerSel = h("select");
  layerSel.name = "region_type";
  for (const t of REGION_TYPES) layerSel.append(opt(REGION_TYPE_LABELS[t], t));
  const regionSel = h("select");
  regionSel.name = "region_name";
  field("Window", winSel);
  field("Per", granSel);
  field("Area", layerSel);
  const regionField = field("Region", regionSel);
  const hint = h("p", "an-controls__hint");
  bar.append(hint);

  const syncControls = () => {
    winSel.replaceChildren();
    const opts2 = [...new Set([...WINDOW_OPTIONS, state.days])].sort((a, b) => a - b);
    for (const d of opts2) {
      const o = opt(windowOptionLabel(d), String(d));
      o.disabled = !windowAllowed(d, state.granularity);
      winSel.append(o);
    }
    winSel.value = String(state.days);
    granSel.value = state.granularity;
    layerSel.value = state.regionType;
    regionField.hidden = state.regionType === "city";
    hint.textContent =
      state.granularity === "hour"
        ? "Hourly views go back at most 31 days. Region applies to rides and failed starts; the vehicles list uses the area type."
        : "Region applies to rides and failed starts; the vehicles list uses the area type.";
  };

  // ----- cards
  const countsCard = h("section", "an-counts");
  countsCard.setAttribute("aria-label", "Fleet counts");
  const rides = new Card("an-rides", "Rides");
  const failed = new Card("an-failed", "Failed starts");
  const byRegion = new Card("an-devices", "Vehicles on the map by neighborhood");
  const equity = new Card("an-equity", "Share of the fleet in Equity Areas");
  const dwell = new Card("an-dwell", "Average dwell by model and region");
  const status = new Card("an-status", "Fleet status");

  const dwellSel = h("select");
  dwellSel.name = "dwell_region_type";
  for (const t of REGION_TYPES) dwellSel.append(opt(REGION_TYPE_LABELS[t], t));
  const dwellField = h("label", "an-field");
  dwellField.append(h("span", "an-field__label", "Regions"), dwellSel);
  dwell.controls.append(dwellField);

  const grid = h("div", "an-grid");
  grid.append(rides.root, failed.root, status.root, equity.root, byRegion.root, dwell.root);
  // One line for the whole page when the window reaches back past the
  // current counting method (API comparable_since). Fed by the three
  // affected cards as they render; absent fields never raise it.
  const banner = h("p", "an-banner");
  banner.setAttribute("role", "note");
  banner.hidden = true;
  const eraFlags = new Map<string, string | null>();
  const eraFlag = (card: string, windowStart: string, comparableSince: string | null | undefined): boolean => {
    const since = comparableSince ? Date.parse(comparableSince) : NaN;
    const before = Number.isFinite(since) && Date.parse(windowStart) < since;
    eraFlags.set(card, before ? comparableSince! : null);
    const first = [...eraFlags.values()].find((v) => v);
    banner.hidden = !first;
    banner.textContent = first
      ? `Rides, dwell and failed starts before ${changeWhen(first)} were counted differently; compare within one counting era only (older-method bars are muted).`
      : "";
    return before;
  };
  root.replaceChildren(bar, banner, countsCard, grid);

  const regionReady = (s: ControlsState) => s.regionType === "city" || !!s.regionName;
  const q = (s: ControlsState) => ({
    days: s.days,
    granularity: s.granularity,
    regionType: s.regionType,
    regionName: s.regionName,
  });
  const regionKey = (s: ControlsState) => `${s.days}|${s.granularity}|${s.regionType}|${s.regionName}`;

  const loaders: Loader[] = [
    // #8 number cards
    {
      key: () => "counts",
      load: () => {
        countsCard.replaceChildren(h("div", "an-state an-state--loading", "Loading fleet counts…"));
        fetchAnalyticsFleetCounts().then(
          (d) => renderCounts(countsCard, d),
          (e) => {
            console.warn("fleet counts failed", e);
            const box = h("div", "an-state an-state--error", "Fleet counts could not load. The charts below are unaffected.");
            box.setAttribute("role", "alert");
            countsCard.replaceChildren(box);
          },
        );
      },
    },
    // #1 rides
    makeLoader(
      rides,
      regionKey,
      (s, sig) => (regionReady(s) ? fetchAnalyticsRides(q(s), sig) : null),
      (d) => {
        const stacks = modelStacks(d);
        const { chart, markers } = withEras(stacks, d);
        eraFlag("rides", d.window_start, d.comparable_since);
        rides.setTitle(`Rides per ${gName(d.granularity)}, by model`);
        rides.show(
          {
            window: windowLabel(d.window_start, d.window_end),
            sample: `${plural(d.rides, "ride")} · ${regionPhrase(d.region.type, d.region.name)}`,
            definition: d.definition,
            caveat: d.caveat,
            notes: [...throughNote(d.data_through, d.window_end, stacks.unplaced), ...partialNote(chart, "bar")],
          },
          (body, foot) => {
            renderStackedBars(body, chart, { ariaLabel: `Rides per ${d.granularity} by model`, totalLabel: "All models", markers });
            foot.append(...present(modelLegend(chart.series, "rides"), olderLegend(chart), erasDetails(d.counting_changes), dataTable(chart, plainNum, "All models")));
          },
        );
      },
    ),
    // #2 failed starts
    makeLoader(
      failed,
      regionKey,
      (s, sig) => (regionReady(s) ? fetchAnalyticsFailedStarts(q(s), sig) : null),
      (d) => {
        const stacks = modelStacks(d);
        const { chart, markers } = withEras(stacks, d);
        eraFlag("failed", d.window_start, d.comparable_since);
        const band = undercountBand(chart.slots, chart.granularity, d.undercount_since, d.undercount_until);
        const since = dateLabel(d.undercount_since);
        const span = d.undercount_until ? `${since} – ${changeWhen(d.undercount_until).replace(/ Denver time$/, "")}` : `since ${since}`;
        failed.setTitle(`Failed starts per ${gName(d.granularity)}, by model`);
        const notes = [...throughNote(d.data_through, d.window_end, stacks.unplaced), ...partialNote(chart, "bar")];
        if (band?.whole) notes.unshift(`This whole window falls in the undercount (${span}), so every bucket is affected.`);
        else if (band) notes.unshift(`The tinted span is the undercount (${span}).`);
        failed.show(
          {
            window: windowLabel(d.window_start, d.window_end),
            sample: `${plural(d.failed_starts, "failed start")} at ${plural(d.stops_with_failures, "stop")} · ${regionPhrase(d.region.type, d.region.name)}`,
            definition: d.definition,
            caveat: d.caveat,
            notes,
          },
          (body, foot) => {
            renderStackedBars(body, chart, {
              ariaLabel: `Failed starts per ${d.granularity} by model`,
              totalLabel: "All models",
              markers,
              band: band && !band.whole ? { from: band.from, to: band.to, label: "Undercounted" } : undefined,
            });
            foot.append(...present(modelLegend(chart.series, "failed starts"), olderLegend(chart), erasDetails(d.counting_changes), dataTable(chart, plainNum, "All models")));
          },
        );
      },
    ),
    // #7 fleet status
    makeLoader(
      status,
      (s) => `${s.days}|${s.granularity}`,
      (s, sig) => fetchAnalyticsFleetStatus(fleetStatusDays(s.days, fleetRetention), s.granularity, sig),
      (d, s) => {
        if (d.retention_days && d.retention_days > 0) fleetRetention = d.retention_days;
        const keep = d.retention_days ?? fleetRetention;
        const capped = s.days > keep;
        const chart = lineSeries(d.window_start, d.window_end, d.granularity, d.series, [
          { key: "available", name: "Available", color: "var(--viz-avail)" },
          { key: "in_use", name: "In use", color: "var(--viz-inuse)" },
          { key: "out_of_service", name: "Out of service", color: "var(--viz-oos)" },
          { key: "off_map", name: "Off-map", color: "var(--viz-offmap)", dashed: true },
        ]);
        const cycles = d.series.reduce((s, r) => s + r.cycles, 0);
        const offMapPoints = chart.series[3].values.filter((v) => v !== null).length;
        status.setTitle(`Fleet status, average per ${gName(d.granularity)}`);
        status.show(
          {
            window: windowLabel(d.window_start, d.window_end),
            sample: `${plural(cycles, "feed cycle")} averaged${capped ? ` · last ${keep} days only` : ""}`,
            definition: d.definition,
            notes: [
              ...(capped
                ? [`Covers the last ${keep} days only, not the ${windowOptionLabel(s.days)} selected: the source keeps ${keep} days of fleet-status history. The other charts show the full window.`]
                : []),
              ...partialNote(chart, "line"),
              offMapPoints === 0
                ? "Off-map has no points in this window: it is recorded from Oct 7, 2026, and earlier buckets are blank, not zero."
                : "Off-map is recorded from Oct 7, 2026; earlier buckets are blank, not zero.",
            ],
          },
          (body, foot) => {
            renderLines(body, chart, { ariaLabel: `Vehicles available, in use, out of service and off-map per ${d.granularity}` });
            foot.append(legend(chart.series), dataTable(chart, plainNum));
          },
        );
      },
    ),
    // #5 equity compliance
    makeLoader(
      equity,
      (s) => `${s.days}|${s.granularity}`,
      (s, sig) => fetchAnalyticsEquity(s.days, s.granularity, sig),
      (d) => {
        const chart = lineSeries(d.window_start, d.window_end, d.granularity, d.series, [
          { key: "percent", name: "Share in Equity Areas", color: "var(--viz-1)" },
        ]);
        const cycles = d.series.reduce((s, r) => s + r.cycles, 0);
        equity.setTitle(`Share of the fleet in Equity Areas, per ${gName(d.granularity)}`);
        equity.show(
          {
            window: windowLabel(d.window_start, d.window_end),
            sample: `${commas(d.buckets_meeting_threshold)} of ${plural(d.buckets, d.granularity)} at or above ${d.threshold_percent}% · ${plural(cycles, "cycle")}`,
            definition: d.definition,
            notes: partialNote(chart, "line"),
          },
          (body, foot) => {
            renderLines(body, chart, {
              ariaLabel: `Percent of the fleet in Equity Areas per ${d.granularity}, with the ${d.threshold_percent}% line`,
              threshold: { value: d.threshold_percent, label: `${d.threshold_percent}% (Exhibit B)` },
              format: (v) => `${Math.round(v)}%`,
              yMax: 100,
            });
            foot.append(dataTable(chart, (v) => `${v.toFixed(1)}%`));
          },
        );
      },
    ),
    // #4 devices by region
    makeLoader(
      byRegion,
      (s) => `${s.days}|${s.regionType === "city" ? "neighborhood" : s.regionType}|${s.regionName}`,
      (s, sig) =>
        fetchAnalyticsDevicesByRegion(
          (s.regionType === "city" ? "neighborhood" : s.regionType) as AnalyticsRegionLayer,
          clampDays(s.days, "day"),
          sig,
        ),
      (d, s) => {
        const layerName = REGION_TYPE_LABELS[d.region_type].toLowerCase();
        byRegion.setTitle(`Vehicles on the map by ${layerName}`);
        const cycles = Math.max(0, ...d.regions.map((r) => r.cycles));
        byRegion.show(
          {
            window: windowLabel(d.window_start, d.window_end),
            sample: `${plural(d.regions.length, "region")} · ${plural(cycles, "cycle")} averaged · now = ${asOfLabel(d.as_of)}`,
            definition: d.definition,
          },
          (body, foot) => {
            renderRankedBars(
              body,
              d.regions.map((r) => ({
                label: regionLabel(r.region, d.region_type),
                average: r.average,
                now: r.now,
                cycles: r.cycles,
              })),
              { limit: 15, averageLabel: "window average" },
            );
            if (s.regionName) {
              const want = regionLabel(s.regionName, d.region_type);
              body.querySelectorAll<HTMLElement>(".viz-rank__row").forEach((li) => {
                if (li.querySelector(".viz-rank__name")?.textContent === want) li.classList.add("is-selected");
              });
            }
            foot.append(
              legend([
                { name: "Window average (bar)", color: "var(--viz-1)" },
                { name: "Now (tick)", color: "var(--fg)" },
              ]),
            );
          },
        );
      },
    ),
    // #6 dwell
    makeLoader(
      dwell,
      (s) => `${s.days}|${s.dwellLayer}`,
      (s, sig) => fetchAnalyticsDwell(s.dwellLayer, clampDays(s.days, "day"), sig),
      (d) => {
        const t = dwellTable(d);
        const mixed = eraFlag("dwell", d.window_start, d.comparable_since);
        dwell.show(
          {
            window: windowLabel(d.window_start, d.window_end),
            sample: `${plural(t.dwells, "closed stop")} · averages need ${d.min_dwells_for_average}+ stops`,
            definition: d.definition,
            caveat: d.caveat,
            notes: [
              ...(mixed && d.comparable_since
                ? [`This window starts before ${changeWhen(d.comparable_since)}, so its averages mix counting methods.`]
                : []),
              ...(d.data_through ? [`Stops closed through ${asOfLabel(d.data_through)}.`] : []),
            ],
          },
          (body, foot) => {
            const why = erasDetails(d.counting_changes);
            if (why) foot.append(why);
            if (!t.rows.length) {
              body.append(h("div", "an-state", "No closed stops in this window."));
              return;
            }
            renderHeatTable(body, {
              columns: t.columns,
              rows: t.rows,
              format: formatMinutes,
              countLabel: (n) => `n=${commas(n)}`,
              corner: REGION_TYPE_LABELS[d.region_type],
            });
          },
        );
      },
    ),
  ];
  const keys = new Map<Loader, string>();

  const reload = (force = false) => {
    for (const l of loaders) {
      const k = l.key(state);
      if (!force && keys.get(l) === k) continue;
      keys.set(l, k);
      l.load(state);
    }
  };

  const namesFor = (layer: AnalyticsRegionLayer): Promise<string[]> => {
    let p = regionNames.get(layer);
    if (!p) {
      p = fetchSpatialSnapshot(layer)
        .then((r) => Object.keys(r.regions))
        .catch(() => fetchBoundary(layer).then((b) => b.features.map((f) => f.properties.region_name)))
        .then((names) => sortRegionNames(names, layer));
      p.catch(() => regionNames.delete(layer));
      regionNames.set(layer, p);
    }
    return p;
  };

  const fillRegions = () => {
    if (state.regionType === "city") return;
    const layer = state.regionType;
    regionSel.disabled = true;
    regionSel.replaceChildren(opt("Loading…", ""));
    namesFor(layer).then(
      (names) => {
        if (state.regionType !== layer) return;
        regionSel.replaceChildren(...names.map((n) => opt(regionLabel(n, layer), n)));
        regionSel.disabled = false;
        const pick = state.regionName && names.includes(state.regionName) ? state.regionName : names[0] ?? null;
        regionSel.value = pick ?? "";
        if (pick !== state.regionName) set({ regionName: pick });
      },
      () => {
        if (state.regionType !== layer) return;
        regionSel.replaceChildren(opt("Region list unavailable", ""));
        // A region typed into the URL still works without the list.
        if (state.regionName) {
          regionSel.replaceChildren(opt(regionLabel(state.regionName, layer), state.regionName));
          regionSel.disabled = false;
        }
      },
    );
  };

  const set = (patch: Partial<ControlsState>) => {
    const prevLayer = state.regionType;
    state = updateControls(state, patch);
    syncControls();
    opts.onState?.(controlsToSearch(state));
    if (state.regionType !== prevLayer) fillRegions();
    reload();
  };

  winSel.addEventListener("change", () => set({ days: Number(winSel.value) }));
  granSel.addEventListener("change", () => set({ granularity: granSel.value as AnalyticsGranularity }));
  layerSel.addEventListener("change", () => set({ regionType: layerSel.value as AnalyticsRegionType }));
  regionSel.addEventListener("change", () => regionSel.value && set({ regionName: regionSel.value }));
  dwellSel.value = state.dwellLayer;
  dwellSel.addEventListener("change", () => set({ dwellLayer: dwellSel.value as AnalyticsRegionType }));

  syncControls();
  fillRegions();
  reload(true);
  return { state: () => state };
}

const mountPoint = typeof document !== "undefined" ? document.getElementById("analytics") : null;
if (mountPoint) {
  mountAnalytics(mountPoint, {
    search: location.search,
    onState: (search) => {
      try {
        history.replaceState(null, "", `${location.pathname}${search}`);
      } catch {
        /* a sandboxed frame may refuse; the page still works */
      }
    },
  });
}
