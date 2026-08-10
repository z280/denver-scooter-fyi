// @vitest-environment happy-dom
//
// Admin Tools analytics. Pure coverage for the data shaping (city rows
// summed per day, silent days filled with explicit zeros, nice axis
// maxima, path building) plus modal-level checks with injected fetchers:
// the traffic report's two-charts-one-axis-each rule, the events report's
// compare overlay and its legend, the table view, the stale-response
// guard, and teardown.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DAY_RANGES,
  SERIES_COLORS_DARK,
  SERIES_COLORS_LIGHT,
  dayExtent,
  fillDayGaps,
  linePath,
  niceMax,
  openAdminAnalytics,
  shortDay,
  sumByDay,
} from "./admin-analytics.ts";
import type {
  AnalyticsDailyRow,
  AnalyticsEventDailyRow,
} from "./api.ts";

beforeEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

function eventRow(
  day: string,
  events: number,
  city: number | null = 1,
): AnalyticsEventDailyRow {
  return {
    day,
    city_id: city,
    events,
    visitors: Math.ceil(events / 2),
    sessions: Math.ceil(events / 2),
    prop_summary: null,
  };
}

function dailyRow(day: string, events: number): AnalyticsDailyRow {
  return {
    day,
    events,
    max_event_visitors: Math.ceil(events / 10),
    max_event_sessions: Math.ceil(events / 8),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("sumByDay", () => {
  it("sums multiple per-city rows into one figure per day", () => {
    const rows = [eventRow("2026-08-01", 5, 1), eventRow("2026-08-01", 3, 2)];
    expect(sumByDay(rows, "events").get("2026-08-01")).toBe(8);
  });
});

describe("fillDayGaps", () => {
  it("fills silent days with explicit zeros — a line must not skip them", () => {
    const byDay = new Map([
      ["2026-08-01", 4],
      ["2026-08-03", 6],
    ]);
    expect(fillDayGaps(byDay, "2026-08-01", "2026-08-04")).toEqual([
      { day: "2026-08-01", value: 4 },
      { day: "2026-08-02", value: 0 },
      { day: "2026-08-03", value: 6 },
      { day: "2026-08-04", value: 0 },
    ]);
  });

  it("degrades to empty on garbage dates", () => {
    expect(fillDayGaps(new Map(), "not-a-date", "2026-08-04")).toEqual([]);
  });
});

describe("dayExtent", () => {
  it("spans every series' rows so both fill the SAME range", () => {
    expect(
      dayExtent([
        [{ day: "2026-08-02" }, { day: "2026-08-05" }],
        [{ day: "2026-07-30" }],
      ]),
    ).toEqual(["2026-07-30", "2026-08-05"]);
    expect(dayExtent([[], []])).toBeNull();
  });
});

describe("niceMax", () => {
  it("rounds up to 1/2/5 steps and never returns zero", () => {
    expect(niceMax(0)).toBe(5);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(500)).toBe(500);
    expect(niceMax(501)).toBe(1000);
  });
});

describe("linePath", () => {
  it("spreads points across the width, zero at the baseline", () => {
    const d = linePath(
      [
        { day: "a", value: 0 },
        { day: "b", value: 10 },
      ],
      100,
      50,
      10,
    );
    expect(d).toBe("M 0.0,50.0 L 100.0,0.0");
  });

  it("draws a short dash for a single point instead of nothing", () => {
    expect(linePath([{ day: "a", value: 5 }], 100, 50, 10)).toContain("L");
  });

  it("returns empty for no points", () => {
    expect(linePath([], 100, 50, 10)).toBe("");
  });
});

describe("shortDay + ranges", () => {
  it("formats compact UTC labels and offers analyst-sized windows", () => {
    expect(shortDay("2026-08-10")).toMatch(/Aug/);
    expect([...DAY_RANGES]).toEqual([7, 30, 90, 365]);
  });
});

// ---------------------------------------------------------------------------
// the modal
// ---------------------------------------------------------------------------

describe("openAdminAnalytics", () => {
  it("traffic: two charts, one axis each — visitors/sessions never share the events axis", async () => {
    const fetchDaily = vi.fn(async () => ({
      days: 30,
      daily: [dailyRow("2026-08-01", 400), dailyRow("2026-08-02", 300)],
    }));
    openAdminAnalytics("traffic", { fetchDaily });
    await flush();
    const charts = document.querySelectorAll(".admin-analytics__chart");
    expect(charts.length).toBe(2);
    expect(charts[0].textContent).toContain("Visitors & sessions");
    expect(charts[1].textContent).toContain("Total events");
    // The two-series chart carries a legend; the single-series one doesn't
    // (its title names it).
    expect(charts[0].querySelector(".admin-analytics__legend")).not.toBeNull();
    expect(charts[1].querySelector(".admin-analytics__legend")).toBeNull();
  });

  it("events: compare overlays a second series in the second validated color", async () => {
    const fetchEventDaily = vi.fn(async (name: string) => ({
      name,
      days: 30,
      daily: [eventRow("2026-08-01", name === "page_load" ? 9 : 4)],
    }));
    openAdminAnalytics("events", { fetchEventDaily });
    await flush();
    // Pick a compare event through the control's normal path.
    const selects = document.querySelectorAll<HTMLSelectElement>(
      ".admin-analytics__control select",
    );
    selects[1].value = "ride_open";
    selects[1].dispatchEvent(new Event("change"));
    await flush();

    expect(fetchEventDaily).toHaveBeenCalledWith("page_load", 30);
    expect(fetchEventDaily).toHaveBeenCalledWith("ride_open", 30);
    const paths = document.querySelectorAll(
      '.admin-analytics__svg path[stroke]',
    );
    expect(paths.length).toBe(2);
    const strokes = [...paths].map((p) => p.getAttribute("stroke"));
    expect(strokes).toContain(SERIES_COLORS_LIGHT[0]);
    expect(strokes).toContain(SERIES_COLORS_LIGHT[1]);
    const legend = document.querySelector(".admin-analytics__legend");
    expect(legend?.textContent).toContain("page_load");
    expect(legend?.textContent).toContain("ride_open");
  });

  it("dark theme picks the dark-validated pair", async () => {
    document.documentElement.dataset.theme = "dark";
    const fetchEventDaily = vi.fn(async (name: string) => ({
      name,
      days: 30,
      daily: [eventRow("2026-08-01", 5)],
    }));
    openAdminAnalytics("events", { fetchEventDaily });
    await flush();
    const path = document.querySelector('.admin-analytics__svg path[stroke]');
    expect(path?.getAttribute("stroke")).toBe(SERIES_COLORS_DARK[0]);
  });

  it("table view renders every figure as text, newest day first", async () => {
    const fetchDaily = vi.fn(async () => ({
      days: 30,
      daily: [dailyRow("2026-08-01", 100), dailyRow("2026-08-02", 200)],
    }));
    openAdminAnalytics("traffic", { fetchDaily });
    await flush();
    document
      .querySelector<HTMLButtonElement>(".admin-analytics__table-toggle")!
      .click();
    const table = document.querySelector(".admin-analytics__table");
    expect(table).not.toBeNull();
    const firstDataRow = table!.querySelectorAll("tbody tr")[0];
    expect(firstDataRow.textContent).toContain("2026-08-02");
  });

  it("a stale response never paints over a newer selection", async () => {
    let resolveSlow: (v: {
      name: string;
      days: number;
      daily: AnalyticsEventDailyRow[];
    }) => void = () => {};
    const fetchEventDaily = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockImplementation(async (name: string) => ({
        name,
        days: 7,
        daily: [eventRow("2026-08-02", 42)],
      }));
    openAdminAnalytics("events", { fetchEventDaily });
    // Change the range while the first request is still in flight…
    const selects = document.querySelectorAll<HTMLSelectElement>(
      ".admin-analytics__control select",
    );
    const range = selects[selects.length - 1];
    range.value = "7";
    range.dispatchEvent(new Event("change"));
    await flush();
    // …then let the SLOW (stale) response land. It must be discarded.
    resolveSlow({
      name: "page_load",
      days: 30,
      daily: [eventRow("2026-08-01", 999999)],
    });
    await flush();
    expect(document.body.textContent).not.toContain("999,999");
  });

  it("failure shows honest copy, and × closes", async () => {
    const fetchDaily = vi.fn(async () => {
      throw new Error("401");
    });
    openAdminAnalytics("traffic", { fetchDaily });
    await flush();
    expect(document.body.textContent).toContain("Couldn't load analytics");
    document
      .querySelector<HTMLButtonElement>(".admin-analytics__close")!
      .click();
    expect(document.querySelector(".admin-analytics")).toBeNull();
  });

  it("opens at most one at a time", async () => {
    const fetchDaily = vi.fn(async () => ({ days: 30, daily: [] }));
    openAdminAnalytics("traffic", { fetchDaily });
    openAdminAnalytics("traffic", { fetchDaily });
    expect(document.querySelectorAll(".admin-analytics").length).toBe(1);
  });
});
