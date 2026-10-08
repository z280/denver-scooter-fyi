// The analytics page's pure half: Denver-time buckets (across both DST
// changes), gap handling, labels, and the controls' invariants.

import { describe, expect, it } from "vitest";

import {
  bucketLabel,
  bucketSlots,
  clampDays,
  contiguousRuns,
  controlsFromSearch,
  controlsToSearch,
  DEFAULT_CONTROLS,
  denverLocalToUtc,
  changeMarkers,
  lineSegments,
  olderMask,
  slotPosition,
  spanBand,
  lineSeries,
  modelColor,
  modelLabel,
  modelStacks,
  niceScale,
  orderModels,
  pickTicks,
  regionLabel,
  sortRegionNames,
  truncateToBucket,
  updateControls,
  windowAllowed,
  windowLabel,
} from "./analytics-data.ts";

const iso = (ms: number) => new Date(ms).toISOString();

describe("Denver calendar buckets", () => {
  it("converts Denver wall time to UTC on both sides of DST", () => {
    // MDT (UTC-6) in October, MST (UTC-7) in December.
    expect(iso(denverLocalToUtc(2026, 10, 7))).toBe("2026-10-07T06:00:00.000Z");
    expect(iso(denverLocalToUtc(2026, 12, 1))).toBe("2026-12-01T07:00:00.000Z");
  });

  it("has 25 hours on the fall-back day and 23 on the spring-forward day", () => {
    const fall = bucketSlots("2026-11-01T06:00:00+00:00", "2026-11-02T07:00:00+00:00", "hour");
    expect(fall).toHaveLength(25);
    const spring = bucketSlots("2027-03-14T07:00:00+00:00", "2027-03-15T06:00:00+00:00", "hour");
    expect(spring).toHaveLength(23);
  });

  it("steps days across fall-back without drifting off midnight", () => {
    const days = bucketSlots("2026-10-30T12:00:00Z", "2026-11-04T12:00:00Z", "day");
    expect(days.map((d) => bucketLabel(d, "day"))).toEqual(["Oct 30", "Oct 31", "Nov 1", "Nov 2", "Nov 3", "Nov 4"]);
    // Nov 1 is midnight MDT (06:00Z), Nov 2 midnight MST (07:00Z)
    expect(iso(days[2])).toBe("2026-11-01T06:00:00.000Z");
    expect(iso(days[3])).toBe("2026-11-02T07:00:00.000Z");
  });

  it("matches the API's offset-carrying bucket strings exactly", () => {
    // _bucket_iso: Denver-local naive + ZoneInfo → "...-06:00" / "...-07:00"
    const slots = bucketSlots("2026-10-31T06:00:00+00:00", "2026-11-03T07:00:00+00:00", "day");
    expect(slots).toContain(Date.parse("2026-11-01T00:00:00-06:00"));
    expect(slots).toContain(Date.parse("2026-11-02T00:00:00-07:00"));
  });

  it("starts weeks on Monday and months on the 1st, in Denver", () => {
    // Wed Oct 7 2026 → Mon Oct 5
    const wk = truncateToBucket(Date.parse("2026-10-07T20:00:00Z"), "week");
    expect(bucketLabel(wk, "week")).toBe("Week of Oct 5");
    // 03:00Z on Oct 1 is still Sep 30 in Denver
    const mo = truncateToBucket(Date.parse("2026-10-01T03:00:00Z"), "month");
    expect(bucketLabel(mo, "month")).toBe("Sep 2026");
  });

  it("labels hours in Denver time, and tells the two fall-back 1 AMs apart", () => {
    expect(bucketLabel(Date.parse("2026-10-07T15:00:00-06:00"), "hour")).toBe("Oct 7, 3 PM");
    // API hour buckets are true UTC hours: Nov 1 has two 01:00 buckets.
    expect(bucketLabel(Date.parse("2026-11-01T01:00:00-06:00"), "hour")).toBe("Nov 1, 1 AM MDT");
    expect(bucketLabel(Date.parse("2026-11-01T01:00:00-07:00"), "hour")).toBe("Nov 1, 1 AM MST");
    expect(bucketLabel(Date.parse("2026-11-01T02:00:00-07:00"), "hour")).toBe("Nov 1, 2 AM");
    expect(bucketLabel(Date.parse("2027-03-14T03:00:00-06:00"), "hour")).toBe("Mar 14, 3 AM");
  });

  it("gives each fall-back 01:00 bucket its own slot", () => {
    const slots = bucketSlots("2026-11-01T06:00:00+00:00", "2026-11-01T10:00:00+00:00", "hour");
    const a = slots.indexOf(Date.parse("2026-11-01T01:00:00-06:00"));
    const b = slots.indexOf(Date.parse("2026-11-01T01:00:00-07:00"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBe(a + 1);
    const chart = lineSeries(
      "2026-11-01T06:00:00+00:00",
      "2026-11-01T10:00:00+00:00",
      "hour",
      [
        { bucket: "2026-11-01T01:00:00-06:00", v: 1 },
        { bucket: "2026-11-01T01:00:00-07:00", v: 2 },
      ],
      [{ key: "v", name: "v", color: "x" }],
    );
    expect(chart.series[0].values.slice(a, a + 2)).toEqual([1, 2]);
  });

  it("puts hourly ticks on Denver midnights only", () => {
    const slots = bucketSlots("2026-10-01T06:00:00Z", "2026-10-08T06:00:00Z", "hour");
    const ticks = pickTicks(slots, "hour", 10);
    expect(ticks).toHaveLength(7);
    for (const i of ticks) expect(bucketLabel(slots[i], "hour")).toMatch(/12 AM$/);
    expect(pickTicks(slots, "hour", 3).length).toBeLessThanOrEqual(4);
  });
});

describe("window label", () => {
  it("names the window in Denver time", () => {
    expect(windowLabel("2026-09-07T22:00:00+00:00", "2026-10-07T22:00:00+00:00")).toBe("Sep 7 – Oct 7, Denver time");
  });
  it("shows hours for a short window", () => {
    expect(windowLabel("2026-10-06T22:00:00+00:00", "2026-10-07T22:00:00+00:00")).toBe(
      "Oct 6, 4:00 PM – Oct 7, 4:00 PM, Denver time",
    );
  });
  it("shows years when the window crosses one", () => {
    expect(windowLabel("2025-12-01T12:00:00Z", "2026-01-15T12:00:00Z")).toBe("Dec 1, 2025 – Jan 15, 2026, Denver time");
  });
});

describe("series → chart arrays", () => {
  const base = {
    window_start: "2026-10-01T06:00:00+00:00",
    window_end: "2026-10-05T06:00:00+00:00",
    granularity: "day" as const,
  };

  it("stacks by model, zero-fills processed buckets and leaves unprocessed ones null", () => {
    const chart = modelStacks({
      ...base,
      models: ["Astro", "Cosmo", "Trike"],
      data_through: "2026-10-04T06:00:00+00:00", // Oct 4 not yet counted
      series: [
        { bucket: "2026-10-01T00:00:00-06:00", by_model: { Astro: 3, Cosmo: 5 }, total: 8 },
        { bucket: "2026-10-03T00:00:00-06:00", by_model: { Trike: 1 }, total: 1 },
      ],
    });
    expect(chart.slots).toHaveLength(4);
    expect(chart.series.map((s) => s.name)).toEqual(["Cosmo", "Astro", "Rover"]);
    expect(chart.series[0].values).toEqual([5, 0, 0, null]);
    expect(chart.series[2].values).toEqual([0, 0, 1, null]);
    expect(chart.unplaced).toBe(0);
  });

  it("carries the API's partial flag: a complete prior bucket and a partial current one", () => {
    const chart = modelStacks({
      window_start: "2026-10-05T06:00:00+00:00",
      window_end: "2026-10-07T22:00:00+00:00",
      granularity: "day",
      models: ["Cosmo"],
      data_through: "2026-10-07T22:00:00+00:00",
      series: [
        { bucket: "2026-10-05T00:00:00-06:00", by_model: { Cosmo: 900 }, total: 900 },
        { bucket: "2026-10-06T00:00:00-06:00", by_model: { Cosmo: 1000 }, total: 1000 },
        { bucket: "2026-10-07T00:00:00-06:00", by_model: { Cosmo: 400 }, total: 400, partial: true },
      ],
    });
    expect(chart.series[0].values).toEqual([900, 1000, 400]);
    expect(chart.partial).toEqual([false, false, true]);
    const lines = lineSeries("2026-10-06T06:00:00+00:00", "2026-10-07T22:00:00+00:00", "day", [
      { bucket: "2026-10-06T00:00:00-06:00", percent: 31 },
      { bucket: "2026-10-07T00:00:00-06:00", percent: 22, partial: true },
    ], [{ key: "percent", name: "p", color: "x" }]);
    expect(lines.partial).toEqual([false, true]);
  });

  it("dashes exactly the line segments that touch an incomplete bucket", () => {
    expect(lineSegments([1, 2, 3, 4], [false, false, false, true])).toEqual([
      { start: 0, values: [1, 2, 3], dashed: false },
      { start: 2, values: [3, 4], dashed: true },
    ]);
    expect(lineSegments([1, null, 5], [false, false, true])).toEqual([
      { start: 0, values: [1], dashed: false },
      { start: 2, values: [5], dashed: true },
    ]);
    expect(lineSegments([1, 2], [false, false])).toEqual([{ start: 0, values: [1, 2], dashed: false }]);
  });

  it("treats everything as not-yet-counted when the rollup is empty", () => {
    const chart = modelStacks({ ...base, models: [], series: [], data_through: null });
    expect(chart.series).toEqual([]);
  });

  it("keeps null as a gap in lines — missing buckets and null fields alike", () => {
    const chart = lineSeries(base.window_start, base.window_end, "day", [
      { bucket: "2026-10-01T00:00:00-06:00", available: 10, off_map: null },
      { bucket: "2026-10-03T00:00:00-06:00", available: 12, off_map: 4 },
    ], [
      { key: "available", name: "Available", color: "x" },
      { key: "off_map", name: "Off-map", color: "y" },
    ]);
    expect(chart.series[0].values).toEqual([10, null, 12, null]);
    expect(chart.series[1].values).toEqual([null, null, 4, null]);
  });

  it("splits values into contiguous runs at every null", () => {
    expect(contiguousRuns([1, 2, null, 3, null, null, 4, 5])).toEqual([
      { start: 0, values: [1, 2] },
      { start: 3, values: [3] },
      { start: 6, values: [4, 5] },
    ]);
    expect(contiguousRuns([null, null])).toEqual([]);
  });

  it("picks nice axis maxima", () => {
    expect(niceScale(0)).toEqual({ max: 1, step: 1 });
    expect(niceScale(37)).toEqual({ max: 40, step: 10 });
    expect(niceScale(1234)).toEqual({ max: 1500, step: 500 });
  });
});

describe("names", () => {
  it("prettifies region names with the app's helper", () => {
    expect(regionLabel("NB_FivePoints", "neighborhood")).toBe("Five Points");
    expect(regionLabel("CD_9", "council_district")).toBe("Council District 9");
    expect(regionLabel("anything", "city")).toBe("Denver");
  });

  it("sorts council districts numerically", () => {
    expect(sortRegionNames(["CD_10", "CD_2", "CD_1"], "council_district")).toEqual(["CD_1", "CD_2", "CD_10"]);
  });

  it("orders and labels models, Rover for the wire's Trike, Unknown last", () => {
    expect(modelLabel("Trike")).toBe("Rover");
    expect(modelLabel(" ")).toBe("Unknown");
    expect(orderModels(["Unknown", "Rover", "Apollo", "Zeta", "Astro", "Cosmo", "Trike"])).toEqual([
      "Cosmo",
      "Astro",
      "Apollo",
      "Rover",
      "Zeta",
      "Unknown",
    ]);
  });

  it("keeps a model's color whatever else is on screen", () => {
    expect(modelColor("Astro")).toBe("var(--viz-2)");
    expect(modelColor("Rover")).toBe("var(--viz-4)");
    expect(modelColor("Unknown")).toBe("var(--viz-unknown)");
  });
});

describe("controls", () => {
  it("caps hourly windows at 31 days", () => {
    expect(clampDays(90, "hour")).toBe(31);
    expect(clampDays(90, "day")).toBe(90);
    expect(clampDays(0, "day")).toBe(1);
    expect(windowAllowed(90, "hour")).toBe(false);
    expect(updateControls({ ...DEFAULT_CONTROLS, granularity: "day", days: 90 }, { granularity: "hour" }).days).toBe(31);
  });

  it("drops a stale region on a layer change, and any region for the city", () => {
    const s = { ...DEFAULT_CONTROLS, regionType: "neighborhood" as const, regionName: "NB_FivePoints" };
    expect(updateControls(s, { regionType: "council_district" }).regionName).toBeNull();
    expect(updateControls(s, { regionType: "city" }).regionName).toBeNull();
    expect(updateControls(s, { days: 30 }).regionName).toBe("NB_FivePoints");
  });

  it("round-trips through the URL and survives junk", () => {
    const s = updateControls(DEFAULT_CONTROLS, {
      days: 30,
      granularity: "day",
      regionType: "neighborhood",
      regionName: "NB_FivePoints",
      dwellLayer: "neighborhood",
    });
    expect(controlsFromSearch(controlsToSearch(s))).toEqual(s);
    expect(controlsFromSearch("?days=abc&g=fortnight&layer=planet&region=<script>")).toEqual(DEFAULT_CONTROLS);
    expect(controlsFromSearch("?days=200&g=hour").days).toBe(31);
  });
});

describe("counting eras", () => {
  const slots = bucketSlots("2026-10-01T06:00:00Z", "2026-10-08T06:00:00Z", "day"); // Oct 1..7 (Denver)

  it("positions an instant fractionally within its slot, null outside the axis", () => {
    // Oct 6 01:36Z = Oct 5, 7:36 PM MDT: slot 4 (Oct 5), 19.6/24 of the way in
    expect(slotPosition(slots, "day", Date.parse("2026-10-06T01:36:00Z"))).toBeCloseTo(4 + 19.6 / 24, 5);
    expect(slotPosition(slots, "day", slots[0])).toBeNull();
    expect(slotPosition(slots, "day", Date.parse("2026-09-01T00:00:00Z"))).toBeNull();
    expect(slotPosition(slots, "day", Date.parse("2026-10-09T00:00:00Z"))).toBeNull();
  });

  it("mutes every bucket that starts before comparable_since, straddlers included", () => {
    expect(olderMask(slots, "2026-10-06T01:36:00+00:00")).toEqual([true, true, true, true, true, false, false]);
    expect(olderMask(slots, undefined)).toEqual(Array(7).fill(false));
    expect(olderMask(slots, null)).toEqual(Array(7).fill(false));
    expect(olderMask(slots, "not a date")).toEqual(Array(7).fill(false));
  });

  it("marks only the changes inside the window", () => {
    const m = changeMarkers(slots, "day", [
      { at: "2026-08-10T04:15:00+00:00", summary: "a" },
      { at: "2026-10-06T01:36:00+00:00", summary: "b" },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0].label).toBe("Counting change Oct 5");
    expect(changeMarkers(slots, "day", undefined)).toEqual([]);
  });

  it("clips a span to the axis", () => {
    expect(spanBand(slots, "day", Date.parse("2026-08-10T06:00:00Z"), Date.parse("2026-10-03T06:00:00Z"))).toEqual({ from: 0, to: 2 });
    expect(spanBand(slots, "day", Date.parse("2026-10-03T06:00:00Z"), Infinity)).toEqual({ from: 2, to: 7 });
    expect(spanBand(slots, "day", Date.parse("2026-11-01T00:00:00Z"), Infinity)).toBeNull();
    expect(spanBand([], "day", 0, 1)).toBeNull();
  });
});
