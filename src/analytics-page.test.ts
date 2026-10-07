// @vitest-environment happy-dom
//
// The /analytics page against mocked endpoints: every chart shows its
// window, sample, definition and caveat; one failing endpoint costs one card;
// the controls drive the requests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dwellTable, formatMinutes, mountAnalytics, undercountPlacement } from "./analytics-page.ts";
import { bucketSlots } from "./analytics-data.ts";

const W = { window_start: "2026-09-30T22:00:00+00:00", window_end: "2026-10-07T22:00:00+00:00", timezone: "America/Denver" };

function hours(n: number, f: (i: number, iso: string) => object) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Date.parse(W.window_start) + i * 3_600_000;
    // Denver-local ISO with offset, as the API sends it (MDT, -06:00)
    const local = new Date(t - 6 * 3_600_000).toISOString().slice(0, 19) + "-06:00";
    out.push({ bucket: local, ...f(i, local) });
  }
  return out;
}

const FIX: Record<string, unknown> = {
  "/api/v1/analytics/fleet-counts": {
    as_of: "2026-10-07T22:30:00+00:00",
    visible_now: 7696,
    visible_now_by_model: { Cosmo: 4260, Astro: 2428, Apollo: 988, Rover: 20 },
    ever_seen_total: 9100,
    ever_seen_by_model: { Cosmo: 5000, Astro: 2900, Apollo: 1150, Rover: 40, Unknown: 10 },
    ever_seen_since: "2026-05-30T12:00:00+00:00",
    definition: "Visible now: every vehicle in the latest feed cycle, any status.",
  },
  "/api/v1/analytics/rides": {
    ...W,
    granularity: "hour",
    region: { type: "city", name: "Denver" },
    models: ["Astro", "Cosmo"],
    series: hours(168, (i) => ({ by_model: { Cosmo: i % 24, Astro: 2 }, total: (i % 24) + 2 })),
    rides: 12345,
    data_through: W.window_end,
    definition: "A ride is a vehicle that moved from one stop to another (trip_events).",
  },
  "/api/v1/analytics/failed-starts": {
    ...W,
    granularity: "hour",
    region: { type: "city", name: "Denver" },
    models: ["Cosmo"],
    series: hours(100, () => ({ by_model: { Cosmo: 1 }, total: 1, stops_with_failures: 1 })),
    failed_starts: 100,
    stops_with_failures: 90,
    data_through: "2026-10-07T16:00:00+00:00",
    definition: "A failed start is a rental that ended where it began.",
    caveat: "Failed starts have been under-reported since 2026-08-10 (a counting fix is in progress); a drop after that date is not an improvement.",
    undercount_since: "2026-08-10",
  },
  "/api/v1/analytics/fleet-status": {
    ...W,
    granularity: "hour",
    model: null,
    series: hours(168, (i) => ({ available: 5000, in_use: 300, out_of_service: 200, off_map: i > 160 ? 40 : null, cycles: 30 })),
    definition: "Averages per bucket of the feed's own status counts. Off-map … null before (not zero).",
  },
  "/api/v1/analytics/equity-compliance": {
    ...W,
    granularity: "hour",
    threshold_percent: 30,
    series: hours(168, (i) => ({ percent: 25 + (i % 10), cycles: 30, meets_threshold: 25 + (i % 10) >= 30 })),
    buckets: 168,
    buckets_meeting_threshold: 84,
    definition: "Average, per bucket, of the share of the Denver fleet inside the official Equity Areas.",
  },
  "/api/v1/analytics/devices-by-region": {
    ...W,
    region_type: "neighborhood",
    as_of: "2026-10-07T22:30:00+00:00",
    regions: [
      { region: "NB_CBD", now: 312, average: 290.4, cycles: 5040 },
      { region: "NB_FivePoints", now: 145, average: 150.1, cycles: 5040 },
    ],
    definition: "Vehicles the feed shows inside the region, whatever their status: vehicles on the map.",
  },
  "/api/v1/analytics/dwell": {
    ...W,
    region_type: "council_district",
    models: ["Astro", "Cosmo"],
    regions: [
      { region: "CD_10", by_model: { Cosmo: { dwells: 400, average_minutes: 95.5 }, Astro: { dwells: 12, average_minutes: null } } },
      { region: "CD_2", by_model: { Cosmo: { dwells: 300, average_minutes: 40 } } },
    ],
    min_dwells_for_average: 30,
    data_through: "2026-10-07T16:00:00+00:00",
    definition: "Dwell is how long a vehicle stayed at a stop, from arrival to departure.",
  },
  "/api/v1/spatial-snapshot": {
    snapshot_time: "2026-10-07T22:30:00+00:00",
    layer: "neighborhood",
    regions: { NB_FivePoints: { total: 1 }, NB_AthmarPark: { total: 2 } },
  },
};

let calls: string[] = [];
let failing = new Set<string>();

beforeEach(() => {
  calls = [];
  failing = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(String(input), "http://x");
      calls.push(u.pathname + u.search);
      if (failing.has(u.pathname)) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 });
      const body = FIX[u.pathname];
      if (!body) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  document.body.innerHTML = '<main id="root"></main>';
});

afterEach(() => {
  document.body.innerHTML = "";
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const card = (id: string) => document.getElementById(id)!;
const text = (id: string) => card(id).textContent ?? "";

describe("the analytics page", () => {
  it("renders every chart with its window, sample and definition", async () => {
    mountAnalytics(document.getElementById("root")!, { search: "" });
    await settle();
    const window = "Sep 30, 4:00 PM – Oct 7, 4:00 PM, Denver time";
    // a 7-day window shows as dates
    const win7 = "Sep 30 – Oct 7, Denver time";
    for (const id of ["an-rides", "an-failed", "an-status", "an-equity", "an-devices", "an-dwell"]) {
      const meta = card(id).querySelector(".an-card__meta")!.textContent!;
      expect(meta.includes(win7) || meta.includes(window), `${id}: ${meta}`).toBe(true);
      expect(card(id).querySelector(".an-def")?.textContent, id).toBeTruthy();
      expect(card(id).querySelector(".an-state--error"), id).toBeNull();
    }
    expect(text("an-rides")).toContain("12,345 rides");
    expect(text("an-rides")).toContain("All of Denver");
    expect(card("an-rides").querySelectorAll(".viz-bars rect").length).toBeGreaterThan(100);
    expect(text("an-failed")).toContain("100 failed starts at 90 stops");
    expect(text("an-equity")).toContain("84 of 168 hours at or above 30%");
    expect(text("an-equity")).toContain("30% (Exhibit B)");
    expect(text("an-devices")).toContain("Vehicles on the map by neighborhood");
    expect(text("an-devices")).toContain("Five Points");
    expect(text("an-dwell")).toContain("Council District 2");
    expect(text("an-dwell")).toContain("n=12");
  });

  it("shows the failed-starts caveat and the whole-window undercount note", async () => {
    mountAnalytics(document.getElementById("root")!, { search: "" });
    await settle();
    const caveat = card("an-failed").querySelector(".an-caveat")!;
    expect(caveat.textContent).toContain("under-reported since 2026-08-10");
    expect(caveat.getAttribute("role")).toBe("note");
    // Sep 30 – Oct 7 is entirely after Aug 10
    expect(text("an-failed")).toContain("This whole window is after Aug 10, 2026");
    expect(text("an-failed")).toContain("Counted through");
  });

  it("draws gaps, not zeros, where off-map is null", async () => {
    mountAnalytics(document.getElementById("root")!, { search: "" });
    await settle();
    const dashed = card("an-status").querySelectorAll(".viz-line--dashed");
    expect(dashed).toHaveLength(1); // one run: only the last hours have off-map
    expect(text("an-status")).toContain("blank, not zero");
  });

  it("renders the number cards: visible now and one per model ever seen", async () => {
    mountAnalytics(document.getElementById("root")!, { search: "" });
    await settle();
    const labels = [...document.querySelectorAll(".an-tile__label")].map((n) => n.textContent);
    expect(labels).toEqual([
      "Vehicles visible now",
      "Cosmo",
      "Astro",
      "Apollo",
      "Rover",
      "Unknown",
    ]);
    expect(document.querySelector(".an-tile__value")!.textContent).toBe("7,696");
  });

  it("keeps the rest of the page when one endpoint fails", async () => {
    failing.add("/api/v1/analytics/rides");
    failing.add("/api/v1/analytics/fleet-counts");
    mountAnalytics(document.getElementById("root")!, { search: "" });
    await settle();
    expect(card("an-rides").querySelector(".an-state--error")).not.toBeNull();
    expect(card("an-rides").querySelector("button")!.textContent).toBe("Retry");
    expect(document.querySelector(".an-counts .an-state--error")).not.toBeNull();
    for (const id of ["an-failed", "an-status", "an-equity", "an-devices", "an-dwell"]) {
      expect(card(id).querySelector(".an-state--error"), id).toBeNull();
      expect(card(id).querySelector(".an-def"), id).not.toBeNull();
    }
    failing.clear();
    card("an-rides").querySelector("button")!.click();
    await settle();
    expect(text("an-rides")).toContain("12,345 rides");
  });

  it("sends the controls to the API and the region to the rides and failed-starts charts", async () => {
    const states: string[] = [];
    mountAnalytics(document.getElementById("root")!, { search: "?days=30&g=day", onState: (s) => states.push(s) });
    await settle();
    expect(calls).toContain("/api/v1/analytics/rides?days=30&granularity=day&region_type=city");
    const layer = document.querySelector<HTMLSelectElement>('select[name="region_type"]')!;
    layer.value = "neighborhood";
    layer.dispatchEvent(new Event("change"));
    await settle();
    // First region alphabetically by label: Athmar Park
    expect(calls).toContain("/api/v1/analytics/rides?days=30&granularity=day&region_type=neighborhood&region_name=NB_AthmarPark");
    expect(calls).toContain("/api/v1/analytics/failed-starts?days=30&granularity=day&region_type=neighborhood&region_name=NB_AthmarPark");
    expect(states.at(-1)).toBe("?days=30&g=day&layer=neighborhood&region=NB_AthmarPark");
    // hour granularity disables the long windows and clamps days
    const gran = document.querySelector<HTMLSelectElement>('select[name="granularity"]')!;
    gran.value = "hour";
    gran.dispatchEvent(new Event("change"));
    await settle();
    const win = document.querySelector<HTMLSelectElement>('select[name="days"]')!;
    expect(win.value).toBe("30");
    expect([...win.options].find((o) => o.value === "90")!.disabled).toBe(true);
  });
});

describe("helpers", () => {
  it("places the undercount marker inside, before or after the window", () => {
    const slots = bucketSlots("2026-08-01T06:00:00Z", "2026-08-20T06:00:00Z", "day");
    const inside = undercountPlacement(slots, "2026-08-20T06:00:00Z", "2026-08-10");
    expect(inside).toEqual({ index: 9 });
    expect(undercountPlacement(slots, "2026-08-20T06:00:00Z", "2026-07-01")).toBe("whole");
    expect(undercountPlacement(slots, "2026-08-20T06:00:00Z", "2026-09-01")).toBeNull();
  });

  it("keeps counts where the dwell average is null, and merges Trike into Rover", () => {
    const t = dwellTable({
      ...W,
      region_type: "council_district",
      models: ["Trike", "Rover"],
      regions: [{ region: "CD_1", by_model: { Trike: { dwells: 40, average_minutes: 10 }, Rover: { dwells: 20, average_minutes: 40 } } }],
      min_dwells_for_average: 30,
      data_through: null,
      definition: "",
    });
    expect(t.columns).toEqual(["Rover"]);
    expect(t.rows[0].cells[0]).toEqual({ value: 20, count: 60 });
    expect(formatMinutes(95.5)).toBe("1.6 h");
    expect(formatMinutes(42)).toBe("42 min");
  });
});
