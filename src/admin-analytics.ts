// Tools → analytics charts.
//
// Three modal "reports". The first two are admin-only (the Tools drawer
// hides the section for everyone else, and the endpoints are require_admin
// regardless); the third is public:
//
//   traffic  — the site pulse: unique visitors & sessions as two lines,
//              with total events as ITS OWN chart below. Events run one to
//              two orders of magnitude above visitors, and a shared y-axis
//              would flatten the visitor line into the baseline (and a
//              second y-axis is the classic chart crime) — so: two charts,
//              one axis each.
//   events   — one event name's per-day count, with an optional SECOND
//              event overlaid for comparison (same day range, same axis —
//              both series are "events per day", so one scale is honest).
//   devices  — PUBLIC: the fleet by hour over up to 14 days —
//              total/available/reserved/out-of-service, with a Model
//              selector that scopes ALL four metrics to one device model
//              (the API carries the same status counts per model). Hours
//              whose breakdown predates the snapshot table come back null
//              from the API — a null BREAKS the line (see linePath) and
//              prints "–" in the table; plotting zero would chart a fleet
//              collapse that never happened.
//
// Chart discipline (the dataviz method, applied):
//   * line charts for change-over-time; 2px lines; one y-axis per chart;
//   * series colors are per-theme pairs VALIDATED by the palette script
//     (lightness band, chroma, CVD ΔE, normal-vision floor, contrast vs
//     this app's --bg-elev surfaces) — never eyeballed;
//   * a legend renders whenever two series share a plot (never for one —
//     the title names it); labels/values wear text tokens, never series
//     colors;
//   * a crosshair + tooltip on hover; a table view toggle so every figure
//     is readable without color at all;
//   * gaps in the rollup (days with no rows) are filled with explicit
//     zeros — a line that skips silent days would draw a trend that
//     never happened.
//
// House rules as everywhere: `document.createElement`/`createElementNS`
// only, a `cleanupFns[]` teardown list, a real focus trap, one instance at
// a time.

import {
  fetchAnalyticsDaily as defaultFetchDaily,
  fetchAnalyticsEventDaily as defaultFetchEventDaily,
  fetchDeviceHistoryHourly as defaultFetchDeviceHistory,
  type DeviceHistoryHour,
} from "./api.ts";
import { trapFocusWithin } from "./modal-focus-trap.ts";
import { TELEMETRY_EVENTS } from "./telemetry.ts";

// ---------------------------------------------------------------------------
// Validated series palettes — scripts/validate_palette.js, six checks, both
// against this app's real chart surfaces (--bg-elev: #ffffff / #1c2230).
// ---------------------------------------------------------------------------

export const SERIES_COLORS_LIGHT = [
  "#0066FF",
  "#B45309",
  "#0D8A66",
  "#7C3AED",
  "#DB2777",
] as const;
export const SERIES_COLORS_DARK = [
  "#4C8DFF",
  "#D97706",
  "#1FA184",
  "#9B7BF0",
  "#D9548F",
] as const;

export function seriesColors(): readonly string[] {
  const dark =
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark";
  return dark ? SERIES_COLORS_DARK : SERIES_COLORS_LIGHT;
}

export const DAY_RANGES = [7, 30, 90, 365] as const;

/** The devices report ranges — the snapshot table keeps 30 days, the API
 *  serves at most 14. */
export const DEVICE_DAY_RANGES = [1, 3, 7, 14] as const;

// ---------------------------------------------------------------------------
// Pure data shaping (exported for unit tests)
// ---------------------------------------------------------------------------

export interface DayPoint {
  /** ISO date ("2026-08-10") or, for the hourly devices report, an ISO
   *  timestamp ("2026-08-10T14:00:00+00:00"). */
  day: string;
  /** Null = "unknown for this point" (a backfilled fleet-history hour) —
   *  it breaks the line and prints "–", never a fake zero. */
  value: number | null;
}

export interface ChartSeries {
  label: string;
  color: string;
  points: DayPoint[];
}

/** Collapse rollup rows (possibly several per day — the rollup is per
 *  city) to one summed value per day. */
export function sumByDay<T extends { day: string }>(
  rows: readonly T[],
  field: keyof T & string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r[field] ?? 0);
    if (!Number.isFinite(v)) continue;
    out.set(r.day, (out.get(r.day) ?? 0) + v);
  }
  return out;
}

/** Every day from `from` to `to` inclusive (UTC date math on ISO dates),
 *  reading missing days as EXPLICIT zeros. A rollup only has rows for days
 *  with traffic; skipping the silent days would connect a line across them
 *  and draw a trend that never happened. */
export function fillDayGaps(
  byDay: ReadonlyMap<string, number>,
  from: string,
  to: string,
): DayPoint[] {
  const points: DayPoint[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return points;
  while (cursor.getTime() <= end.getTime()) {
    const day = cursor.toISOString().slice(0, 10);
    points.push({ day, value: byDay.get(day) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

/** The [min, max] day across every series' raw rows, so a two-series chart
 *  fills both over the SAME range. Null when no rows at all. */
export function dayExtent(
  rowSets: readonly (readonly { day: string }[])[],
): [string, string] | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const rows of rowSets) {
    for (const r of rows) {
      if (min === null || r.day < min) min = r.day;
      if (max === null || r.day > max) max = r.day;
    }
  }
  return min !== null && max !== null ? [min, max] : null;
}

/** A rounded-up "nice" axis maximum (1/2/5 × 10^n), so gridlines land on
 *  readable numbers. Zero data still gets a non-zero axis. */
export function niceMax(rawMax: number): number {
  if (!(rawMax > 0)) return 5;
  const mag = 10 ** Math.floor(Math.log10(rawMax));
  for (const m of [1, 2, 5, 10]) {
    if (rawMax <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/** SVG path for a series inside a w×h plot box, y-scaled to `yMax`, x
 *  spread evenly across the points. Null values BREAK the line into
 *  separate segments (an unknown is not a zero); a segment of one point —
 *  including a single-point series — draws a short flat dash rather than
 *  nothing. */
export function linePath(
  points: readonly DayPoint[],
  w: number,
  h: number,
  yMax: number,
): string {
  const n = points.length;
  if (n === 0) return "";
  const x = (i: number): number => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number): number => h - (Math.min(v, yMax) / yMax) * h;
  const parts: string[] = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length === 1) {
      const i = run[0];
      const cy = y(points[i].value as number).toFixed(1);
      parts.push(
        `M ${(x(i) - 4).toFixed(1)},${cy} L ${(x(i) + 4).toFixed(1)},${cy}`,
      );
    } else if (run.length > 1) {
      parts.push(
        run
          .map(
            (i, k) =>
              `${k === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(points[i].value as number).toFixed(1)}`,
          )
          .join(" "),
      );
    }
    run = [];
  };
  for (let i = 0; i < n; i += 1) {
    if (points[i].value === null) flush();
    else run.push(i);
  }
  flush();
  return parts.join(" ");
}

/** "Aug 10" — compact x-tick labels in the rider's own locale. */
export function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Label for any point key: hourly keys (they contain a "T") render as
 *  "Aug 10, 2:00 PM" in the rider's own timezone — a fleet sample is a
 *  moment in time, unlike the rollups' calendar days. */
export function pointLabel(iso: string): string {
  if (!iso.includes("T")) return shortDay(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Series points from the hourly fleet rows, one per hour from the first
 *  row to the last, stepping by exactly one hour. Hours the API skipped
 *  entirely (an outage with no core total either) become null points, so
 *  the line breaks instead of gliding across the gap. Falls back to a
 *  direct row-per-point mapping if any key won't parse or the span is
 *  implausibly wide (bad clock data must not allocate a year of points). */
export function fillHourGaps(
  rows: readonly DeviceHistoryHour[],
  get: (row: DeviceHistoryHour) => number | null,
): DayPoint[] {
  const HOUR_MS = 3_600_000;
  const byMs = new Map<number, DeviceHistoryHour>();
  for (const r of rows) {
    const ms = Date.parse(r.hour);
    if (Number.isNaN(ms)) return rows.map((x) => ({ day: x.hour, value: get(x) }));
    byMs.set(ms, r);
  }
  if (byMs.size === 0) return [];
  const all = [...byMs.keys()].sort((a, b) => a - b);
  const [first, last] = [all[0], all[all.length - 1]];
  if ((last - first) / HOUR_MS > 24 * 31) {
    return rows.map((x) => ({ day: x.hour, value: get(x) }));
  }
  const points: DayPoint[] = [];
  for (let ms = first; ms <= last; ms += HOUR_MS) {
    const row = byMs.get(ms);
    points.push(
      row
        ? { day: row.hour, value: get(row) }
        : { day: new Date(ms).toISOString(), value: null },
    );
  }
  return points;
}

/** Model names ranked by their summed device-count over the window (all
 *  three statuses) — the order the Model selector lists them in, biggest
 *  slice of the fleet first. */
export function rankModels(rows: readonly DeviceHistoryHour[]): string[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    for (const [model, counts] of Object.entries(r.models ?? {})) {
      totals.set(
        model,
        (totals.get(model) ?? 0) +
          counts.available +
          counts.reserved +
          counts.out_of_service,
      );
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([model]) => model);
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export type AdminReportKind = "traffic" | "events" | "devices";

export interface AdminAnalyticsDeps {
  /** Injected for tests; default to the real fetchers ("devices" is the
   *  one public report — its fetcher is unauthenticated). */
  fetchDaily?: typeof defaultFetchDaily;
  fetchEventDaily?: typeof defaultFetchEventDaily;
  fetchDeviceHistory?: typeof defaultFetchDeviceHistory;
  onClose?(): void;
}

const ROOT_CLASS = "admin-analytics";
const PLOT_W = 640;
const PLOT_H = 220;
const SVG_NS = "http://www.w3.org/2000/svg";

let activeClose: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Open one of the two admin reports. Returns a close function; at most
 *  one analytics modal is open at a time. */
export function openAdminAnalytics(
  kind: AdminReportKind,
  deps: AdminAnalyticsDeps = {},
): () => void {
  activeClose?.();
  document.querySelector(`.${ROOT_CLASS}`)?.remove();

  const fetchDaily = deps.fetchDaily ?? defaultFetchDaily;
  const fetchEventDaily = deps.fetchEventDaily ?? defaultFetchEventDaily;
  const fetchDeviceHistory =
    deps.fetchDeviceHistory ?? defaultFetchDeviceHistory;

  const cleanupFns: (() => void)[] = [];
  let closed = false;
  let showTable = false;
  /** Monotonic request stamp — a stale response must never paint over a
   *  newer selection's. */
  let requestSeq = 0;
  let charts: { title: string; series: ChartSeries[] }[] = [];
  let status: string | null = "Loading…";

  // ---- controls state
  let days: number = kind === "devices" ? 14 : 30;
  let eventName: string = "page_load";
  let compareName: string = "";
  /** Devices report: "" = the whole fleet; else one model display name. */
  let modelFilter: string = "";
  /** Devices report: the last fetched window, so switching the model
   *  filter recomputes locally instead of refetching. */
  let deviceHours: DeviceHistoryHour[] | null = null;

  const backdrop = el("div", ROOT_CLASS);
  const card = el("div", `${ROOT_CLASS}__card`);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "admin-analytics-title");

  const head = el("div", `${ROOT_CLASS}__head`);
  const title = el(
    "h3",
    undefined,
    kind === "traffic"
      ? "📈 Traffic overview"
      : kind === "events"
        ? "📊 Events by day"
        : "🛴 Devices over time",
  );
  title.id = "admin-analytics-title";
  const closeBtn = el("button", `${ROOT_CLASS}__close`, "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(title, closeBtn);

  // ---- controls row (one row above the charts, per the interaction spec)
  const controls = el("div", `${ROOT_CLASS}__controls`);

  function makeSelect(
    label: string,
    options: readonly { value: string; label: string }[],
    value: string,
    onChange: (v: string) => void,
  ): HTMLLabelElement {
    const wrap = el("label", `${ROOT_CLASS}__control`);
    wrap.append(el("span", undefined, label));
    const sel = el("select", "select") as HTMLSelectElement;
    for (const o of options) {
      const opt = el("option", undefined, o.label) as HTMLOptionElement;
      opt.value = o.value;
      sel.append(opt);
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    wrap.append(sel);
    return wrap;
  }

  const dayOptions = (kind === "devices" ? DEVICE_DAY_RANGES : DAY_RANGES).map(
    (d) => ({
      value: String(d),
      label: d === 1 ? "24 hours" : d === 365 ? "1 year" : `${d} days`,
    }),
  );
  const eventOptions = TELEMETRY_EVENTS.map((e) => ({ value: e, label: e }));

  /** Devices report only: repopulated from each fetched window's model
   *  names (the feed's, ranked biggest first) — the selection survives a
   *  range change when the model still exists. */
  let modelSelect: HTMLSelectElement | null = null;
  if (kind === "devices") {
    const wrap = makeSelect(
      "Model",
      [{ value: "", label: "All models" }],
      "",
      (v) => {
        modelFilter = v;
        if (deviceHours) {
          buildDeviceCharts();
          render();
        }
      },
    );
    modelSelect = wrap.querySelector("select");
    controls.append(wrap);
  }
  if (kind === "events") {
    controls.append(
      makeSelect("Event", eventOptions, eventName, (v) => {
        eventName = v;
        void load();
      }),
      makeSelect(
        "Compare with",
        [{ value: "", label: "— none —" }, ...eventOptions],
        compareName,
        (v) => {
          compareName = v;
          void load();
        },
      ),
    );
  }
  controls.append(
    makeSelect("Range", dayOptions, String(days), (v) => {
      days = Number(v);
      void load();
    }),
  );
  const tableBtn = el("button", `${ROOT_CLASS}__table-toggle`, "Table view");
  tableBtn.type = "button";
  tableBtn.setAttribute("aria-pressed", "false");
  tableBtn.addEventListener("click", () => {
    showTable = !showTable;
    tableBtn.setAttribute("aria-pressed", String(showTable));
    tableBtn.textContent = showTable ? "Chart view" : "Table view";
    render();
  });
  controls.append(tableBtn);

  const body = el("div", `${ROOT_CLASS}__body`);
  const statusEl = el("p", `${ROOT_CLASS}__status`);
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");

  card.append(head, controls, statusEl, body);
  backdrop.append(card);

  function close(): void {
    if (closed) return;
    closed = true;
    if (activeClose === close) activeClose = null;
    for (const fn of cleanupFns.splice(0)) fn();
    backdrop.remove();
    deps.onClose?.();
  }

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  cleanupFns.push(() => document.removeEventListener("keydown", onKey));

  // ---- devices report: model filter + chart building ----

  /** Rebuild the Model selector from the fetched window's names. The
   *  current pick survives when it still exists; a model that vanished
   *  from the window falls back to the whole fleet. */
  function updateModelOptions(ranked: readonly string[]): void {
    if (!modelSelect) return;
    if (!ranked.includes(modelFilter)) modelFilter = "";
    modelSelect.replaceChildren();
    for (const o of [{ value: "", label: "All models" }, ...ranked.map((m) => ({ value: m, label: m }))]) {
      const opt = el("option", undefined, o.label) as HTMLOptionElement;
      opt.value = o.value;
      modelSelect.append(opt);
    }
    modelSelect.value = modelFilter;
  }

  /** The one devices chart, from the cached window and the model filter.
   *  Fleet scope reads the top-level fields; a model scope reads that
   *  model's slice — null when the hour's breakdown is unknown (backfill),
   *  an honest ZERO when the breakdown is known and the model simply had
   *  no devices in that status. */
  function buildDeviceCharts(): void {
    const hours = deviceHours ?? [];
    const palette = seriesColors();
    const pick = (
      h: DeviceHistoryHour,
      field: "available" | "reserved" | "out_of_service",
    ): number | null => {
      if (modelFilter === "") return h[field];
      if (h.models === null) return null;
      return h.models[modelFilter]?.[field] ?? 0;
    };
    const total = (h: DeviceHistoryHour): number | null => {
      if (modelFilter === "") return h.total;
      if (h.models === null) return null;
      const m = h.models[modelFilter];
      return m ? m.available + m.reserved + m.out_of_service : 0;
    };
    // Semantic colors from the validated palette: total wears the brand
    // blue, available the green, reserved the amber "paused",
    // out-of-service the red-leaning pink.
    charts = [
      {
        title:
          modelFilter === ""
            ? "Fleet by status"
            : `${modelFilter} by status`,
        series: [
          {
            label: "Total",
            color: palette[0],
            points: fillHourGaps(hours, total),
          },
          {
            label: "Available",
            color: palette[2],
            points: fillHourGaps(hours, (h) => pick(h, "available")),
          },
          {
            label: "Reserved",
            color: palette[1],
            points: fillHourGaps(hours, (h) => pick(h, "reserved")),
          },
          {
            label: "Out of service",
            color: palette[4],
            points: fillHourGaps(hours, (h) => pick(h, "out_of_service")),
          },
        ],
      },
    ];
  }

  // ---- data loading ----
  async function load(): Promise<void> {
    const seq = ++requestSeq;
    status = "Loading…";
    charts = [];
    render();
    const [colorA, colorB] = seriesColors();
    try {
      if (kind === "devices") {
        const resp = await fetchDeviceHistory(days);
        if (closed || seq !== requestSeq) return;
        if (resp.hours.length === 0) {
          status = "No fleet history in this range yet.";
          render();
          return;
        }
        deviceHours = resp.hours;
        updateModelOptions(rankModels(resp.hours));
        buildDeviceCharts();
        status = null;
      } else if (kind === "traffic") {
        const resp = await fetchDaily(days);
        if (closed || seq !== requestSeq) return;
        const extent = dayExtent([resp.daily]);
        if (!extent) {
          status = "No data in this range yet.";
          render();
          return;
        }
        charts = [
          {
            title: "Visitors & sessions per day",
            series: [
              {
                label: "Visitors",
                color: colorA,
                points: fillDayGaps(
                  sumByDay(resp.daily, "max_event_visitors"),
                  extent[0],
                  extent[1],
                ),
              },
              {
                label: "Sessions",
                color: colorB,
                points: fillDayGaps(
                  sumByDay(resp.daily, "max_event_sessions"),
                  extent[0],
                  extent[1],
                ),
              },
            ],
          },
          {
            title: "Total events per day",
            series: [
              {
                label: "Events",
                color: colorA,
                points: fillDayGaps(
                  sumByDay(resp.daily, "events"),
                  extent[0],
                  extent[1],
                ),
              },
            ],
          },
        ];
        status = null;
      } else {
        const primary = await fetchEventDaily(eventName, days);
        const compare =
          compareName && compareName !== eventName
            ? await fetchEventDaily(compareName, days)
            : null;
        if (closed || seq !== requestSeq) return;
        const extent = dayExtent(
          compare ? [primary.daily, compare.daily] : [primary.daily],
        );
        if (!extent) {
          status = "No data for this event in this range yet.";
          render();
          return;
        }
        const series: ChartSeries[] = [
          {
            label: eventName,
            color: colorA,
            points: fillDayGaps(
              sumByDay(primary.daily, "events"),
              extent[0],
              extent[1],
            ),
          },
        ];
        if (compare) {
          series.push({
            label: compareName,
            color: colorB,
            points: fillDayGaps(
              sumByDay(compare.daily, "events"),
              extent[0],
              extent[1],
            ),
          });
        }
        charts = [{ title: "Events per day", series }];
        status = null;
      }
    } catch {
      if (closed || seq !== requestSeq) return;
      status =
        kind === "devices"
          ? "Couldn't load fleet history — the API may be briefly unavailable. Try again in a minute."
          : "Couldn't load analytics — your session may have expired, or the rollup hasn't run yet today.";
      charts = [];
    }
    render();
  }

  // ---- rendering ----
  function render(): void {
    statusEl.textContent = status ?? "";
    statusEl.hidden = status === null;
    body.replaceChildren();
    for (const chart of charts) {
      body.append(showTable ? tableFor(chart) : chartFor(chart));
    }
  }

  function chartFor(chart: {
    title: string;
    series: ChartSeries[];
  }): HTMLElement {
    const wrap = el("figure", `${ROOT_CLASS}__chart`);
    wrap.append(el("figcaption", `${ROOT_CLASS}__chart-title`, chart.title));

    const yMax = niceMax(
      Math.max(
        0,
        ...chart.series.flatMap((s) =>
          s.points
            .map((p) => p.value)
            .filter((v): v is number => v !== null),
        ),
      ),
    );

    const svg = svgEl("svg", {
      viewBox: `0 0 ${PLOT_W + 56} ${PLOT_H + 34}`,
      role: "img",
      "aria-label": chart.title,
    });
    svg.classList.add(`${ROOT_CLASS}__svg`);
    const plot = svgEl("g", { transform: "translate(48, 6)" });

    // Recessive gridlines + y tick labels (text tokens, never series color).
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const y = PLOT_H - frac * PLOT_H;
      plot.append(
        svgEl("line", {
          x1: "0",
          x2: String(PLOT_W),
          y1: y.toFixed(1),
          y2: y.toFixed(1),
          class: `${ROOT_CLASS}__grid`,
        }),
      );
      const tick = svgEl("text", {
        x: "-6",
        y: (y + 3).toFixed(1),
        "text-anchor": "end",
        class: `${ROOT_CLASS}__tick`,
      });
      tick.textContent = String(Math.round(yMax * frac));
      plot.append(tick);
    }

    const first = chart.series[0]?.points ?? [];
    // ~6 x labels, always including the first and last day.
    if (first.length > 0) {
      const step = Math.max(1, Math.ceil(first.length / 6));
      for (let i = 0; i < first.length; i += step) {
        const x =
          first.length === 1 ? PLOT_W / 2 : (i / (first.length - 1)) * PLOT_W;
        const tick = svgEl("text", {
          x: x.toFixed(1),
          y: String(PLOT_H + 16),
          "text-anchor": "middle",
          class: `${ROOT_CLASS}__tick`,
        });
        tick.textContent = pointLabel(first[i].day);
        plot.append(tick);
      }
    }

    for (const s of chart.series) {
      plot.append(
        svgEl("path", {
          d: linePath(s.points, PLOT_W, PLOT_H, yMax),
          fill: "none",
          stroke: s.color,
          "stroke-width": "2",
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      );
    }

    // Crosshair + hover dot per series (hidden until hover).
    const crosshair = svgEl("line", {
      y1: "0",
      y2: String(PLOT_H),
      class: `${ROOT_CLASS}__crosshair`,
      visibility: "hidden",
    });
    plot.append(crosshair);
    const dots = chart.series.map((s) => {
      const dot = svgEl("circle", {
        r: "4",
        fill: s.color,
        stroke: "var(--bg-elev)",
        "stroke-width": "2",
        visibility: "hidden",
      });
      plot.append(dot);
      return dot;
    });

    svg.append(plot);
    wrap.append(svg);

    const tooltip = el("div", `${ROOT_CLASS}__tooltip`);
    tooltip.hidden = true;
    wrap.append(tooltip);

    svg.addEventListener("mousemove", (e) => {
      if (first.length === 0) return;
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / (PLOT_W + 56);
      const px = (e.clientX - rect.left) / scale - 48;
      const idx = Math.max(
        0,
        Math.min(
          first.length - 1,
          Math.round(
            first.length === 1 ? 0 : (px / PLOT_W) * (first.length - 1),
          ),
        ),
      );
      const x =
        first.length === 1 ? PLOT_W / 2 : (idx / (first.length - 1)) * PLOT_W;
      crosshair.setAttribute("x1", x.toFixed(1));
      crosshair.setAttribute("x2", x.toFixed(1));
      crosshair.setAttribute("visibility", "visible");
      tooltip.hidden = false;
      tooltip.replaceChildren(
        el("strong", undefined, pointLabel(first[idx].day)),
        ...chart.series.map((s, si) => {
          const v = s.points[idx]?.value ?? null;
          if (v === null) {
            // An unknown point gets no dot and an honest label.
            dots[si].setAttribute("visibility", "hidden");
            return el("div", undefined, `${s.label}: no data`);
          }
          const yMaxSafe = yMax || 1;
          dots[si].setAttribute("cx", x.toFixed(1));
          dots[si].setAttribute(
            "cy",
            (PLOT_H - (Math.min(v, yMax) / yMaxSafe) * PLOT_H).toFixed(1),
          );
          dots[si].setAttribute("visibility", "visible");
          return el(
            "div",
            undefined,
            `${s.label}: ${v.toLocaleString()}`,
          );
        }),
      );
      tooltip.style.left = `${Math.min(e.clientX - rect.left + 12, rect.width - 130)}px`;
    });
    svg.addEventListener("mouseleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      for (const d of dots) d.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    });

    // Legend only when two series share the plot — a single series is
    // named by the chart title.
    if (chart.series.length > 1) {
      const legend = el("div", `${ROOT_CLASS}__legend`);
      for (const s of chart.series) {
        const item = el("span", `${ROOT_CLASS}__legend-item`);
        const chip = el("span", `${ROOT_CLASS}__legend-chip`);
        chip.style.background = s.color;
        item.append(chip, document.createTextNode(s.label));
        legend.append(item);
      }
      wrap.append(legend);
    }
    return wrap;
  }

  function tableFor(chart: {
    title: string;
    series: ChartSeries[];
  }): HTMLElement {
    const wrap = el("figure", `${ROOT_CLASS}__chart`);
    wrap.append(el("figcaption", `${ROOT_CLASS}__chart-title`, chart.title));
    const table = el("table", `${ROOT_CLASS}__table`);
    const thead = el("thead");
    const hrow = el("tr");
    hrow.append(el("th", undefined, kind === "devices" ? "Hour" : "Day"));
    for (const s of chart.series) hrow.append(el("th", undefined, s.label));
    thead.append(hrow);
    const tbody = el("tbody");
    const daysList = chart.series[0]?.points ?? [];
    // Newest first — the row an analyst wants is almost always today's.
    for (let i = daysList.length - 1; i >= 0; i -= 1) {
      const row = el("tr");
      // Daily rows keep the raw ISO date (copyable, sortable); hourly keys
      // are unreadable raw, so they wear the local-time label.
      const key = daysList[i].day;
      row.append(el("td", undefined, key.includes("T") ? pointLabel(key) : key));
      for (const s of chart.series) {
        const v = s.points[i]?.value ?? null;
        row.append(el("td", undefined, v === null ? "–" : v.toLocaleString()));
      }
      tbody.append(row);
    }
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  render();
  document.body.appendChild(backdrop);
  cleanupFns.push(trapFocusWithin(card, () => !closed));
  activeClose = close;
  try {
    closeBtn.focus();
  } catch {
    /* not focusable yet — harmless */
  }
  void load();

  return close;
}
