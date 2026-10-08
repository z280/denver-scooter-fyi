// Fleet analytics: the drawing half. Hand-rolled SVG rather than a charting
// library, for three reasons that held up once the charts were listed:
//   * the main chart is a STACKED histogram, which uPlot (the planned
//     library) only does through a plugin and manual band math;
//   * every chart needs the same three extras — a gap where data is null, a
//     vertical "undercount since" marker or a horizontal threshold, and a
//     hover readout — and they are each a dozen lines in SVG;
//   * SVG renders in happy-dom, so the tests can assert what is on screen.
// The page is its own Vite entry, so none of this reaches the map's bundle.
//
// Shapes follow the house dataviz rules: one y-axis, thin marks, recessive
// grid, color by entity (analytics-data.ts modelColor), a legend for two or
// more series, a hover readout, and a data table behind a disclosure so a
// figure is never color-only.

import {
  bucketLabel,
  commas,
  lineSegments,
  PARTIAL_LABEL,
  niceScale,
  pickTicks,
  stackMax,
  tickLabel,
  type ChartSeries,
  type SlotChart,
} from "./analytics-data.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const M = { top: 14, right: 10, bottom: 24, left: 44 };

function chartHeight(width: number): number {
  return width < 480 ? 200 : 240;
}

/** Draw now and again whenever the container's width changes. */
function responsive(container: HTMLElement, draw: (width: number) => void): void {
  let last = -1;
  const run = () => {
    const w = Math.round(container.clientWidth || 640);
    if (w === last) return;
    last = w;
    draw(w);
  };
  observers.get(container)?.disconnect();
  run();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => run());
    ro.observe(container);
    observers.set(container, ro);
  }
}

const observers = new WeakMap<HTMLElement, ResizeObserver>();

export interface ValueFormat {
  (v: number): string;
}

const defaultFormat: ValueFormat = (v) =>
  Math.abs(v) >= 100 || Number.isInteger(v) ? commas(Math.round(v)) : v.toFixed(1);

function yAxis(
  g: SVGGElement,
  width: number,
  height: number,
  scale: { max: number; step: number },
  format: ValueFormat,
): (v: number) => number {
  const plotH = height - M.top - M.bottom;
  const y = (v: number) => M.top + plotH - (v / scale.max) * plotH;
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const yy = Math.round(y(v)) + 0.5;
    g.append(svg("line", { x1: M.left, x2: width - M.right, y1: yy, y2: yy, class: v === 0 ? "viz-baseline" : "viz-grid" }));
    const t = svg("text", { x: M.left - 6, y: yy + 4, "text-anchor": "end", class: "viz-tick" });
    t.textContent = format(v);
    g.append(t);
  }
  return y;
}

function xAxis(g: SVGGElement, chart: SlotChart, width: number, height: number, x: (i: number) => number) {
  const ticks = pickTicks(chart.slots, chart.granularity, Math.max(2, (width - M.left - M.right) / 64));
  for (const i of ticks) {
    const t = svg("text", { x: x(i), y: height - 6, "text-anchor": "middle", class: "viz-tick" });
    t.textContent = tickLabel(chart.slots[i], chart.granularity);
    g.append(t);
  }
}

/** Hover readout: a crosshair at the hovered slot and a tooltip listing every
 *  series there. The hit target is the whole plot, not the thin mark. */
function hover(
  wrap: HTMLElement,
  root: SVGSVGElement,
  chart: SlotChart,
  width: number,
  height: number,
  slotX: (i: number) => number,
  slotW: number,
  format: ValueFormat,
  totalLabel?: string,
) {
  const n = chart.slots.length;
  if (!n) return;
  const cross = svg("line", { y1: M.top, y2: height - M.bottom, class: "viz-cross" });
  cross.style.display = "none";
  root.append(cross);
  const tip = h("div", "viz-tip");
  tip.hidden = true;
  wrap.append(tip);
  const hit = svg("rect", {
    x: M.left,
    y: M.top,
    width: Math.max(0, width - M.left - M.right),
    height: Math.max(0, height - M.top - M.bottom),
    class: "viz-hit",
  });
  root.append(hit);
  const show = (clientX: number) => {
    const box = root.getBoundingClientRect();
    const px = clientX - box.left;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - M.left) / slotW)));
    const cx = slotX(i);
    cross.setAttribute("x1", String(cx));
    cross.setAttribute("x2", String(cx));
    cross.style.display = "";
    tip.replaceChildren(h("div", "viz-tip__title", bucketLabel(chart.slots[i], chart.granularity)));
    if (chart.partial[i]) tip.append(h("div", "viz-tip__partial", `Incomplete bucket: counted so far`));
    if (chart.older?.[i]) tip.append(h("div", "viz-tip__partial", OLDER_LABEL_CAP));
    let total = 0;
    let any = false;
    for (const s of chart.series) {
      const v = s.values[i];
      const row = h("div", "viz-tip__row");
      const sw = h("span", "viz-swatch");
      sw.style.background = s.color;
      row.append(sw, h("span", "viz-tip__name", s.name), h("span", "viz-tip__val", v === null ? "no data" : format(v)));
      tip.append(row);
      if (v !== null) {
        total += v;
        any = true;
      }
    }
    if (totalLabel && chart.series.length > 1) {
      const row = h("div", "viz-tip__row viz-tip__total");
      row.append(h("span", "viz-tip__name", totalLabel), h("span", "viz-tip__val", any ? format(total) : "no data"));
      tip.append(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth || 160;
    const left = cx + 12 + tw > width ? cx - 12 - tw : cx + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${M.top}px`;
  };
  const hide = () => {
    cross.style.display = "none";
    tip.hidden = true;
  };
  hit.addEventListener("pointermove", (e) => show(e.clientX));
  hit.addEventListener("pointerdown", (e) => show(e.clientX));
  hit.addEventListener("pointerleave", hide);
}

export function legend(series: { name: string; color: string; dashed?: boolean; note?: string; swatchClass?: string }[]): HTMLElement {
  const ul = h("ul", "viz-legend");
  for (const s of series) {
    const li = h("li");
    const sw = h("span", ["viz-swatch", s.dashed ? "viz-swatch--dashed" : "", s.swatchClass ?? ""].filter(Boolean).join(" "));
    sw.style.setProperty("--swatch", s.color);
    sw.style.background = s.dashed ? "" : s.color;
    li.append(sw, document.createTextNode(s.note ? `${s.name} ${s.note}` : s.name));
    ul.append(li);
  }
  return ul;
}

/** A data table behind a disclosure, built only when opened (an hourly month
 *  is 744 rows). */
export function dataTable(chart: SlotChart, format: ValueFormat = defaultFormat, totalLabel?: string): HTMLElement {
  const d = h("details", "viz-table");
  d.append(h("summary", undefined, "Show data table"));
  d.addEventListener("toggle", () => {
    if (!d.open || d.querySelector("table")) return;
    const wrap = h("div", "viz-table__scroll");
    const t = h("table");
    const head = h("tr");
    head.append(h("th", undefined, "Bucket"));
    for (const s of chart.series) head.append(h("th", undefined, s.name));
    if (totalLabel) head.append(h("th", undefined, totalLabel));
    t.append(h("thead"));
    t.tHead!.append(head);
    const body = h("tbody");
    chart.slots.forEach((ms, i) => {
      const tr = h("tr");
      const tags = [chart.partial[i] ? PARTIAL_LABEL : "", chart.older?.[i] ? OLDER_LABEL : ""].filter(Boolean);
      tr.append(h("td", undefined, bucketLabel(ms, chart.granularity) + (tags.length ? ` (${tags.join("; ")})` : "")));
      tr.className = [chart.partial[i] ? "is-partial" : "", chart.older?.[i] ? "is-older" : ""].filter(Boolean).join(" ");
      let tot = 0;
      let any = false;
      for (const s of chart.series) {
        const v = s.values[i];
        tr.append(h("td", undefined, v === null ? "—" : format(v)));
        if (v !== null) {
          tot += v;
          any = true;
        }
      }
      if (totalLabel) tr.append(h("td", undefined, any ? format(tot) : "—"));
      body.append(tr);
    });
    t.append(body);
    wrap.append(t);
    d.append(wrap);
  });
  return d;
}

export interface Marker {
  /** Slot position; fractional = part-way through a slot. */
  index: number;
  label: string;
}

/** Tooltip / table wording for a bucket counted under an older method. */
export const OLDER_LABEL = "older counting method — not comparable";
const OLDER_LABEL_CAP = "Older counting method — not comparable";

function drawMarker(g: SVGGElement, x: number, height: number, label: string, width: number, row = 0) {
  const xx = Math.round(x) + 0.5;
  g.append(svg("line", { x1: xx, x2: xx, y1: M.top - 4, y2: height - M.bottom, class: "viz-marker" }));
  const right = xx > width * 0.6;
  const t = svg("text", {
    x: right ? xx - 4 : xx + 4,
    y: M.top + 6 + row * 14,
    "text-anchor": right ? "end" : "start",
    class: "viz-marker__label",
  });
  t.textContent = label;
  g.append(t);
}

/** Stacked bars, one stack per slot. A slot whose every series is null is
 *  shaded as "no data" — distinct from a zero, which is simply empty. */
export function renderStackedBars(
  container: HTMLElement,
  chart: SlotChart,
  opts: {
    markers?: Marker[];
    /** A shaded span in slot units (e.g. the failed-start undercount). */
    band?: { from: number; to: number; label: string };
    format?: ValueFormat;
    ariaLabel: string;
    totalLabel?: string;
  },
): void {
  const format = opts.format ?? defaultFormat;
  container.classList.add("viz");
  responsive(container, (width) => {
    const height = chartHeight(width);
    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": opts.ariaLabel });
    const g = svg("g");
    root.append(g);
    const n = chart.slots.length;
    const plotW = width - M.left - M.right;
    const slotW = n ? plotW / n : plotW;
    const scale = niceScale(stackMax(chart.series));
    const y = yAxis(g, width, height, scale, format);
    const x = (i: number) => M.left + i * slotW + slotW / 2;
    const gap = slotW > 8 ? 2 : slotW > 3 ? 1 : 0;
    const bw = Math.max(0.5, slotW - gap);
    if (opts.band) {
      const bx = M.left + opts.band.from * slotW;
      const band = svg("rect", {
        x: bx,
        y: M.top,
        width: Math.max(1, (opts.band.to - opts.band.from) * slotW),
        height: height - M.top - M.bottom,
        class: "viz-band",
      });
      const bt = svg("title");
      bt.textContent = opts.band.label;
      band.append(bt);
      g.append(band);
      // Below the marker label rows (at most two in practice).
      const lt = svg("text", { x: bx + 4, y: M.top + 6 + 14 * Math.min(2, opts.markers?.length ?? 0), class: "viz-band__label" });
      lt.textContent = opts.band.label;
      if ((opts.band.to - opts.band.from) * slotW > 90) g.append(lt);
    }
    const bars = svg("g", { class: "viz-bars" });
    for (let i = 0; i < n; i++) {
      const left = M.left + i * slotW + gap / 2;
      if (chart.series.every((s) => s.values[i] === null)) {
        bars.append(svg("rect", { x: M.left + i * slotW, y: M.top, width: slotW, height: height - M.top - M.bottom, class: "viz-nodata" }));
        continue;
      }
      let acc = 0;
      const part = chart.partial[i];
      const old = chart.older?.[i];
      for (const s of chart.series) {
        const v = s.values[i] ?? 0;
        if (v <= 0) continue;
        const y0 = y(acc);
        const y1 = y(acc + v);
        acc += v;
        const r = svg("rect", { x: left, y: y1, width: bw, height: Math.max(0.5, y0 - y1), fill: s.color });
        const cls = [slotW > 6 ? "viz-seg" : "", part ? "viz-seg--partial" : "", old ? "viz-seg--older" : ""].filter(Boolean).join(" ");
        if (cls) r.setAttribute("class", cls);
        bars.append(r);
      }
      // An incomplete bucket: lighter fill (above) and a dashed outline over
      // the stack, so a short last bar reads as "so far", not as a drop.
      if (part && acc > 0) {
        const outline = svg("rect", { x: left, y: y(acc), width: bw, height: Math.max(0.5, y(0) - y(acc)), class: "viz-partial-outline" });
        const t = svg("title");
        t.textContent = `${bucketLabel(chart.slots[i], chart.granularity)} (${PARTIAL_LABEL})`;
        outline.append(t);
        bars.append(outline);
      }
    }
    g.append(bars);
    xAxis(g, chart, width, height, x);
    // Each label takes the first row where its (estimated) extent does not
    // overlap a label already placed; labels right of 60% grow leftwards.
    const rows: [number, number][][] = [];
    for (const m of [...(opts.markers ?? [])].sort((a, b) => a.index - b.index)) {
      const mx = M.left + m.index * slotW;
      const w = m.label.length * 6.3 + 8;
      const ext: [number, number] = mx > width * 0.6 ? [mx - w, mx] : [mx, mx + w];
      let row = rows.findIndex((r) => r.every(([a, b]) => ext[1] <= a || ext[0] >= b));
      if (row < 0) row = rows.push([]) - 1;
      rows[row].push(ext);
      drawMarker(g, mx, height, m.label, width, row);
    }
    const wrap = h("div", "viz-plot");
    wrap.append(root);
    hover(wrap, root, chart, width, height, x, slotW, format, opts.totalLabel);
    container.replaceChildren(wrap);
  });
}

/** Lines over the slot axis. Null breaks the line (a gap, never a dip to
 *  zero); a lone point between gaps is drawn as a dot. */
export function renderLines(
  container: HTMLElement,
  chart: SlotChart,
  opts: {
    threshold?: { value: number; label: string };
    format?: ValueFormat;
    ariaLabel: string;
    yMax?: number;
  },
): void {
  const format = opts.format ?? defaultFormat;
  container.classList.add("viz");
  responsive(container, (width) => {
    const height = chartHeight(width);
    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": opts.ariaLabel });
    const g = svg("g");
    root.append(g);
    const n = chart.slots.length;
    const plotW = width - M.left - M.right;
    const slotW = n ? plotW / n : plotW;
    let max = 0;
    for (const s of chart.series) for (const v of s.values) if (v !== null && v > max) max = v;
    if (opts.threshold) max = Math.max(max, opts.threshold.value * 1.15);
    const scale = niceScale(opts.yMax !== undefined ? Math.min(opts.yMax, max) || opts.yMax : max);
    const y = yAxis(g, width, height, scale, format);
    const x = (i: number) => M.left + i * slotW + slotW / 2;
    if (opts.threshold) {
      const ty = Math.round(y(opts.threshold.value)) + 0.5;
      g.append(svg("line", { x1: M.left, x2: width - M.right, y1: ty, y2: ty, class: "viz-threshold" }));
      const t = svg("text", { x: width - M.right - 2, y: ty - 5, "text-anchor": "end", class: "viz-threshold__label" });
      t.textContent = opts.threshold.label;
      g.append(t);
    }
    for (const s of chart.series) {
      for (const run of lineSegments(s.values, chart.partial)) {
        if (run.values.length === 1) {
          g.append(svg("circle", { cx: x(run.start), cy: y(run.values[0]), r: 2.5, fill: s.color, class: run.dashed ? "viz-dot viz-dot--partial" : "viz-dot" }));
          continue;
        }
        const d = run.values.map((v, k) => `${k ? "L" : "M"}${x(run.start + k).toFixed(1)},${y(v).toFixed(1)}`).join("");
        const cls = ["viz-line", s.dashed ? "viz-line--dashed" : "", run.dashed ? "viz-line--partial" : ""].filter(Boolean).join(" ");
        g.append(svg("path", { d, stroke: s.color, class: cls }));
      }
    }
    xAxis(g, chart, width, height, x);
    const wrap = h("div", "viz-plot");
    wrap.append(root);
    hover(wrap, root, chart, width, height, x, slotW, format);
    container.replaceChildren(wrap);
  });
}

/** Ranked horizontal bars in HTML (long region names wrap; SVG text does
 *  not). Each row: label, a bar for the window average and a tick for now. */
export function renderRankedBars(
  container: HTMLElement,
  rows: { label: string; average: number | null; now: number | null; cycles: number }[],
  opts: { limit: number; averageLabel: string },
): void {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.average ?? 0, r.now ?? 0)));
  const list = h("ol", "viz-rank");
  const draw = (all: boolean) => {
    list.replaceChildren();
    for (const r of all ? rows : rows.slice(0, opts.limit)) {
      const li = h("li", "viz-rank__row");
      const name = h("span", "viz-rank__name", r.label);
      const track = h("span", "viz-rank__track");
      const bar = h("span", "viz-rank__bar");
      bar.style.width = `${((r.average ?? 0) / max) * 100}%`;
      track.append(bar);
      if (r.now !== null) {
        const tick = h("span", "viz-rank__now");
        tick.style.left = `${(r.now / max) * 100}%`;
        track.append(tick);
      }
      const vals = h(
        "span",
        "viz-rank__vals",
        `${r.average === null ? "—" : r.average.toFixed(1)} avg · ${r.now === null ? "—" : commas(r.now)} now`,
      );
      li.title = `${r.label}: ${opts.averageLabel} ${r.average ?? "no data"}, now ${r.now ?? "no data"} (${commas(r.cycles)} cycles)`;
      li.append(name, vals, track);
      list.append(li);
    }
  };
  draw(false);
  container.replaceChildren(list);
  if (rows.length > opts.limit) {
    const btn = h("button", "viz-more", `Show all ${rows.length}`);
    btn.type = "button";
    let all = false;
    btn.addEventListener("click", () => {
      all = !all;
      draw(all);
      btn.textContent = all ? `Show top ${opts.limit}` : `Show all ${rows.length}`;
    });
    container.append(btn);
  }
}

/** Region × model table, cells shaded by average (one hue, light→dark). A
 *  cell under the sample floor shows its count and no average. */
export function renderHeatTable(
  container: HTMLElement,
  data: {
    columns: string[];
    rows: { label: string; cells: ({ value: number | null; count: number } | null)[] }[];
    format: (v: number) => string;
    countLabel: (n: number) => string;
    corner: string;
  },
): void {
  let max = 0;
  for (const r of data.rows) for (const c of r.cells) if (c && c.value !== null) max = Math.max(max, c.value);
  const scroll = h("div", "viz-heat__scroll");
  const t = h("table", "viz-heat");
  const head = h("tr");
  head.append(h("th", undefined, data.corner));
  for (const c of data.columns) head.append(h("th", undefined, c));
  const thead = h("thead");
  thead.append(head);
  const body = h("tbody");
  for (const r of data.rows) {
    const tr = h("tr");
    tr.append(h("th", undefined, r.label));
    for (const c of r.cells) {
      const td = h("td");
      if (!c) {
        td.className = "viz-heat__empty";
        td.textContent = "—";
      } else if (c.value === null) {
        td.className = "viz-heat__thin";
        td.append(h("span", "viz-heat__count", data.countLabel(c.count)));
        td.title = "Too few stops for an average";
      } else {
        td.style.setProperty("--heat", String(max ? c.value / max : 0));
        td.className = "viz-heat__cell";
        td.append(h("span", "viz-heat__val", data.format(c.value)), h("span", "viz-heat__count", data.countLabel(c.count)));
      }
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(thead, body);
  scroll.append(t);
  container.replaceChildren(scroll);
}

export type { ChartSeries };
