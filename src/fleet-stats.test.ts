// @vitest-environment happy-dom
//
// The rider-stats panel: a handful of cards, each one figure with its window
// and sample.
//
// What is pinned here, and why each is a requirement rather than taste:
//
//   * every card carries its window and its sample. A figure without them is
//     the one that gets quoted back at you naked.
//   * counting eras. Rides, dwell and failed starts were counted three ways;
//     a figure whose window reaches back across 2026-10-06 01:36Z (or a later
//     `comparable_since` from the server) is not shown at all.
//   * each card stands alone: one failed fetch hides one card.
//   * same numbers, different verbs. The civic voice (weseeyouveo.com's embed)
//     may select words only, never a figure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComplianceResponse,
  DeviceHistoryHour,
  FleetOutcomesResponse,
} from "./api.ts";
import type {
  AnalyticsDevicesByRegionResponse,
  AnalyticsDwellResponse,
  AnalyticsRidesResponse,
} from "./analytics-api.ts";
import {
  VOICES,
  buildCards,
  buildFleetStats,
  denverMidnight,
  eraDays,
  eraStart,
  formatKm,
  formatMinutes,
  formatOdds,
  formatRate,
  hourRangeText,
  renderFleetStats,
  type RangeDevice,
  type StatsData,
  type StatsVoice,
} from "./fleet-stats.ts";

// 20:30 MDT on Thursday, October 8, 2026. "Yesterday" is October 7.
const NOW = new Date("2026-10-09T02:30:00Z");
const ERA = "2026-10-06T01:36:00+00:00";

/** A UTC instant as the API writes a bucket: ISO with the Denver offset
 *  (MDT, -06:00, until November 1). */
function denverIso(t: number): string {
  return `${new Date(t - 6 * 3_600_000).toISOString().slice(0, 19)}-06:00`;
}

function outcomes(over: Partial<FleetOutcomesResponse> = {}): FleetOutcomesResponse {
  return {
    window: "since_reset",
    counted_since: "sql/089",
    counted_since_at: "2026-10-07T04:12:57Z",
    radius_meters: 25,
    rentals: 49_037,
    no_gos: 2_412,
    no_go_rate: 0.0492,
    min_rentals_for_rate: 200,
    vehicles: 6_721,
    stayed_window: "since_stayed_counter",
    stayed_counted_since: "2026-10-09T02:01:13Z",
    stayed_radius_meters: 50,
    stayed_rentals: 451,
    stayed: 9,
    stayed_rate: 0.02,
    by_model: [],
    ...over,
  };
}

function fleet(over: Partial<DeviceHistoryHour> = {}): DeviceHistoryHour {
  return {
    hour: "2026-10-09T02:00:00+00:00",
    total: 7_601,
    available: 7_133,
    reserved: 236,
    out_of_service: 232,
    models: {
      Astro: { reserved: 35, available: 2_328, out_of_service: 50 },
      Cosmo: { reserved: 138, available: 3_900, out_of_service: 156 },
      Rover: { reserved: 0, available: 19, out_of_service: 1 },
      Apollo: { reserved: 63, available: 886, out_of_service: 25 },
    },
    ...over,
  };
}

/** Hourly rides from 18:00 MDT Oct 5 (before the era) to the current,
 *  partial hour. Every hour is 1,000 rides except two: a pre-era hour of
 *  9,999 that must never be called the busiest, and 4-5 PM on Oct 7. */
function rides(over: Partial<AnalyticsRidesResponse> = {}): AnalyticsRidesResponse {
  const series = [];
  const start = Date.parse("2026-10-06T00:00:00Z");
  const end = Date.parse("2026-10-09T02:00:00Z");
  for (let t = start; t <= end; t += 3_600_000) {
    const bucket = denverIso(t);
    let total = 1_000;
    if (t === start) total = 9_999;
    if (bucket === "2026-10-07T16:00:00-06:00") total = 2_500;
    series.push({
      bucket,
      by_model: { Cosmo: total },
      total,
      ...(t === end ? { partial: true } : {}),
    });
  }
  return {
    window_start: "2026-10-06T00:00:00Z",
    window_end: "2026-10-09T03:00:00Z",
    timezone: "America/Denver",
    granularity: "hour",
    region: { type: "city", name: "Denver" },
    models: ["Cosmo"],
    series,
    rides: series.reduce((s, b) => s + b.total, 0),
    data_through: "2026-10-09T02:30:00Z",
    definition: "A ride is a vehicle that moved from one stop to another.",
    comparable_since: ERA,
    ...over,
  };
}

function gather(): AnalyticsDevicesByRegionResponse {
  return {
    window_start: "2026-10-02T06:00:00Z",
    window_end: "2026-10-09T03:00:00Z",
    timezone: "America/Denver",
    region_type: "neighborhood",
    as_of: "2026-10-09T02:20:01Z",
    regions: [
      { region: "NB_CentralPark", now: 231, average: 232.2, cycles: 4_763 },
      { region: "NB_FivePoints", now: 493, average: 504.8, cycles: 4_763 },
      { region: "NB_Baker", now: 135, average: null, cycles: 0 },
    ],
    definition: "Vehicles the feed shows inside the region.",
  };
}

function dwell(over: Partial<AnalyticsDwellResponse> = {}): AnalyticsDwellResponse {
  return {
    window_start: "2026-10-06T06:00:00Z",
    window_end: "2026-10-09T03:00:00Z",
    timezone: "America/Denver",
    region_type: "city",
    models: ["Apollo", "Cosmo"],
    regions: [
      {
        region: "Denver",
        by_model: {
          Apollo: { dwells: 100, average_minutes: 200 },
          Cosmo: { dwells: 300, average_minutes: 400 },
          Rover: { dwells: 6, average_minutes: null },
        },
      },
    ],
    min_dwells_for_average: 30,
    data_through: "2026-10-08T20:21:31Z",
    definition: "Dwell is how long a vehicle stayed at a stop.",
    comparable_since: ERA,
    ...over,
  };
}

function equity(over: Partial<ComplianceResponse> = {}): ComplianceResponse {
  return {
    sla_date: "2026-10-08",
    window_start_ts: "2026-10-08T12:00:00+00:00",
    window_end_ts: "2026-10-08T15:00:00+00:00",
    snapshot_count: 91,
    avg_percent_all_devices_equity: 15.15,
    compliance_equity_pass: false,
    ...over,
  } as ComplianceResponse;
}

function devices(): RangeDevice[] {
  return [
    { properties: { estimated_range_meters: 20_000, current_range_meters: 25_000, battery_reading: "stale" } },
    { properties: { estimated_range_meters: 27_300, current_range_meters: 34_030, battery_reading: "stale" } },
    { properties: { estimated_range_meters: 30_000, current_range_meters: 40_000, battery_reading: "fresh" } },
    { properties: { estimated_range_meters: null, current_range_meters: 10_000 } },
  ];
}

function data(over: Partial<StatsData> = {}): StatsData {
  return {
    now: NOW,
    outcomes: outcomes(),
    fleet: fleet(),
    rides: rides(),
    gather: gather(),
    dwell: dwell(),
    equity: equity(),
    devices: devices(),
    ...over,
  };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.replaceChildren(host);
});

function render(over: Partial<StatsData> = {}, voice: StatsVoice = "rider"): HTMLElement {
  host.replaceChildren(buildFleetStats(data(over), voice));
  return host;
}

function card(key: string, over: Partial<StatsData> = {}, voice: StatsVoice = "rider") {
  return render(over, voice).querySelector<HTMLElement>(`[data-card="${key}"]`);
}

const ALL_CARDS = ["now", "rides", "range", "gather", "dwell", "equity", "outcomes"];

describe("the cards", () => {
  it("renders all seven, in order, with failed starts not leading", () => {
    const keys = Array.from(render().querySelectorAll<HTMLElement>(".stat-card")).map(
      (c) => c.dataset.card,
    );
    expect(keys).toEqual(ALL_CARDS);
    expect(keys[0]).not.toBe("outcomes");
  });

  it("puts a window and a sample on every card", () => {
    for (const voice of ["rider", "civic"] as const) {
      for (const c of Array.from(render({}, voice).querySelectorAll(".stat-card"))) {
        const metas = c.querySelectorAll(".stat-card__meta");
        expect(metas.length, `${voice} ${c.getAttribute("data-card")}`).toBeGreaterThan(0);
        for (const m of Array.from(metas)) {
          expect(m.querySelector(".stat-card__window")?.textContent?.trim()).toBeTruthy();
          expect(m.querySelector(".stat-card__sample")?.textContent?.trim()).toBeTruthy();
        }
      }
    }
  });

  it("right now: vehicles on the map, in use, and the model mix", () => {
    const text = card("now")?.textContent ?? "";
    expect(text).toContain("7,601");
    expect(text).toContain("236 of them are out on a ride");
    expect(text).toContain("Cosmo 4,194 · Astro 2,413 · Apollo 974 · Rover 20");
  });

  it("right now: hidden when the latest sample is stale", () => {
    expect(card("now", { fleet: fleet({ hour: "2026-10-08T22:00:00+00:00" }) })).toBeNull();
  });

  it("right now: keeps the total when the status breakdown is unknown", () => {
    const text = card("now", { fleet: fleet({ reserved: null, models: null }) })?.textContent ?? "";
    expect(text).toContain("7,601");
    expect(text).not.toContain("on a ride");
  });

  it("rides: yesterday's total and the busiest current-era hour", () => {
    const text = card("rides")?.textContent ?? "";
    // 23 hours at 1,000 and 4-5 PM at 2,500.
    expect(text).toContain("25,500");
    expect(text).toContain("rides started in Denver");
    expect(text).toContain("4–5 PM, October 7, with 2,500 rides");
    // Hours start at the first whole Denver day of the era (01:36Z Oct 6 is
    // still Oct 5 in Denver).
    expect(text).toContain("Busiest hour since October 6");
    expect(text).toContain("Wednesday, October 7");
    // The 9,999 hour predates the counting fix.
    expect(text).not.toContain("9,999");
  });

  it("range: our median beside Veo's, with the method", () => {
    const text = card("range")?.textContent ?? "";
    expect(text).toContain("27 km");
    expect(text).toContain("Veo's own estimate for the same vehicles: 34 km.");
    expect(text).toContain("battery % × 364 m");
    expect(text).toContain("full to empty");
    expect(text).toContain("median of 3 vehicles");
    // Two of three readings are stale.
    expect(text).toContain("67% of these readings");
  });

  it("range: no card without the map's feed (the embed)", () => {
    expect(card("range", { devices: null })).toBeNull();
    expect(card("range", { devices: [{ properties: {} }] })).toBeNull();
  });

  it("where they gather: the neighbourhood with the highest average", () => {
    const text = card("gather")?.textContent ?? "";
    expect(text).toContain("Five Points");
    expect(text).toContain("505 on average, 493 right now");
    expect(text).toContain("4,763 feed cycles, 2 neighbourhoods");
    expect(text).toContain("Since October 2");
  });

  it("dwell: the stop-weighted average, ignoring withheld cells", () => {
    const text = card("dwell")?.textContent ?? "";
    // (100 × 200 + 300 × 400) / 400 = 350 min.
    expect(text).toContain("5 h 50 min");
    expect(text).toContain("400 stops");
    expect(text).toContain("Since October 6");
  });

  it("equity: the 6-9 AM share against 30%, with the server's verdict", () => {
    const text = card("equity")?.textContent ?? "";
    expect(text).toContain("15.2%");
    expect(text).toContain("6–9 AM");
    expect(text).toContain("at least 30%");
    expect(text).toContain("fell short");
    expect(text).toContain("91 feed cycles");
    const met = card("equity", { equity: equity({ compliance_equity_pass: true }) })?.textContent;
    expect(met).toContain("met it");
  });

  it("equity: hidden when the day has no equity figure", () => {
    expect(card("equity", { equity: equity({ avg_percent_all_devices_equity: null }) })).toBeNull();
  });

  it("outcomes: ended where they began, with round trips, beside never left the spot", () => {
    const c = card("outcomes")!;
    const text = c.textContent ?? "";
    expect(text).toContain("4.9%");
    expect(text).toContain("ended within 25 m of where they began");
    expect(text).toContain("came back to the same spot");
    expect(text).toContain("2,412 of 49,037 rentals");
    expect(text).toContain("2.0%");
    expect(text).toContain("never left the spot");
    expect(text).toContain("more than 50 m");
    expect(text).toContain("9 of 451 rentals");
    // Each figure has its own window.
    expect(c.querySelectorAll(".stat-card__meta")).toHaveLength(2);
  });

  it("outcomes: counts, not a rate, under the floor", () => {
    const c = card("outcomes", {
      outcomes: outcomes({ rentals: 40, no_gos: 4, no_go_rate: null, stayed_rentals: 10, stayed: 0, stayed_rate: null }),
    })!;
    const fig = c.querySelector(".stat-card__figure")!;
    expect(fig.textContent).toContain("Too few for a rate yet");
    expect(fig.textContent).not.toContain("%");
    expect(c.textContent).toContain("a rate needs 200");
  });
});

describe("counting eras", () => {
  it("drops rides when yesterday is not wholly inside the server's era", () => {
    expect(card("rides", { rides: rides({ comparable_since: "2026-10-07T12:00:00Z" }) })).toBeNull();
  });

  it("never lets an older comparable_since pull the window back", () => {
    // The known floor wins over a server that has not heard of the fix.
    expect(eraStart({ comparable_since: "2026-08-10T04:15:00Z" }).toISOString())
      .toBe("2026-10-06T01:36:00.000Z");
    expect(card("rides", { rides: rides({ comparable_since: "2026-08-10T04:15:00Z" }) })?.textContent)
      .not.toContain("9,999");
  });

  it("drops dwell whose window opens before the era", () => {
    expect(card("dwell", { dwell: dwell({ window_start: "2026-10-05T06:00:00Z" }) })).toBeNull();
    expect(card("dwell", { dwell: dwell({ comparable_since: "2026-10-07T00:00:00Z" }) })).toBeNull();
  });

  it("drops failed starts counted from before the fix, or from an old API", () => {
    expect(card("outcomes", { outcomes: outcomes({ counted_since_at: "2026-09-01T00:00:00Z" }) })).toBeNull();
    expect(card("outcomes", { outcomes: outcomes({ window: "lifetime", counted_since_at: null }) })).toBeNull();
  });

  it("asks dwell only for whole Denver days inside the era", () => {
    const era = new Date(ERA);
    // Oct 6, 7 and 8 start after 01:36Z on Oct 6 (which is still Oct 5 in Denver).
    expect(eraDays(era, NOW)).toBe(3);
    expect(eraDays(new Date("2026-10-08T07:00:00Z"), NOW)).toBe(0);
    expect(denverMidnight("2026-10-07").toISOString()).toBe("2026-10-07T06:00:00.000Z");
    // After the November fall-back, midnight is 07:00Z.
    expect(denverMidnight("2026-11-05").toISOString()).toBe("2026-11-05T07:00:00.000Z");
  });
});

describe("formatting", () => {
  it("keeps one decimal on a rate and passes null through", () => {
    expect(formatRate(0.0492)).toBe("4.9%");
    expect(formatRate(null)).toBeNull();
  });

  it("gives the ratio people repeat, and none for zero", () => {
    expect(formatOdds(0.0492)).toBe("about 1 in 20");
    expect(formatOdds(0)).toBeNull();
  });

  it("formats km like the popup and minutes as hours", () => {
    expect(formatKm(27_300)).toBe("27 km");
    expect(formatKm(9_960)).toBe("10 km");
    expect(formatKm(4_240)).toBe("4.2 km");
    expect(formatMinutes(48)).toBe("48 min");
    expect(formatMinutes(342)).toBe("5 h 42 min");
    expect(formatMinutes(120)).toBe("2 h");
  });

  it("names an hour in Denver time", () => {
    expect(hourRangeText(new Date("2026-10-06T22:00:00Z"))).toBe("4–5 PM, October 6");
    expect(hourRangeText(new Date("2026-10-06T17:00:00Z"))).toBe("11 AM–12 PM, October 6");
  });
});

describe("the voice", () => {
  it("offers exactly the two properties' voices", () => {
    expect(Object.keys(VOICES).sort()).toEqual(["civic", "rider"]);
  });

  it("renders the same figures and windows under either voice", () => {
    const figures = (voice: StatsVoice) =>
      Array.from(render({}, voice).querySelectorAll(".stat-card__value, .stat-card__meta"))
        .map((n) => n.textContent)
        .join("|");
    expect(figures("civic")).toBe(figures("rider"));
    expect(buildCards(data(), "civic").map((c) => c.key))
      .toEqual(buildCards(data(), "rider").map((c) => c.key));
  });

  it("renders different words under each voice", () => {
    expect(render({}, "rider").querySelector(".stats-title")?.textContent).not.toBe(
      render({}, "civic").querySelector(".stats-title")?.textContent,
    );
  });

  it("keeps the civic voice in the third person", () => {
    const text = render({}, "civic").querySelector(".stat-cards")?.textContent ?? "";
    expect(text).not.toMatch(/\b(you|your|we|our)\b/i);
  });

  /** Every string either copy table can produce, with sample arguments. */
  function allCopy(voice: StatsVoice): string {
    const c = VOICES[voice];
    return [
      c.title, c.standfirst, c.unavailable, c.crossPromo.lead,
      c.now.kicker, c.now.label, c.now.inUse("1"), c.now.window,
      c.rides.kicker, c.rides.label, c.rides.busiest("4–5 PM", "1", "October 6"),
      c.range.kicker, c.range.label, c.range.veo("34 km"), c.range.method, c.range.stale("80%"), c.range.window,
      c.gather.kicker, c.gather.label, c.gather.line("1", "2"),
      c.dwell.kicker, c.dwell.label, c.dwell.method,
      c.equity.kicker, c.equity.label("6–9 AM"),
      c.equity.verdict("30%", true), c.equity.verdict("30%", false), c.equity.verdict("30%", null),
      c.outcomes.kicker, c.outcomes.label("25 m"), c.outcomes.roundTrips,
      c.outcomes.underFloor("40"), c.outcomes.stayedLabel("50 m"),
    ].join(" ");
  }

  it("never names a culprit or argues, in either voice", () => {
    const forbidden =
      /\b(fail(s|ed|ing|ure)?|broken|neglect\w*|blame|refus\w+|abandon\w+|should|must|demand\w*|monopol\w+)\b/i;
    for (const voice of ["rider", "civic"] as const) {
      const words = allCopy(voice);
      expect(words, voice).not.toMatch(forbidden);
      expect(words, voice).not.toMatch(/\bVeo (is|was|has|does|keeps|leaves)\b/);
      // The old disclaimer style is gone.
      expect(words, voice).not.toMatch(/speak for/i);
    }
  });
});

describe("the story slot and cross-promotion", () => {
  it("sits after the cards and before the cross-promotion", () => {
    const h = render();
    const slot = h.querySelector('[data-role="story-host"]')!;
    const cards = h.querySelector(".stat-cards")!;
    const promo = h.querySelector(".stats-promo")!;
    expect(cards.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(promo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.childNodes.length).toBe(0);
  });

  it("points each site at the other, safely", () => {
    const link = (voice: StatsVoice) =>
      render({}, voice).querySelector<HTMLAnchorElement>(".stats-promo a")!;
    expect(link("rider").href).toContain("weseeyouveo.com");
    expect(link("civic").href).toContain("scooter.fyi");
    expect(link("rider").rel).toContain("noopener");
    expect(link("rider").target).toBe("_blank");
  });

  it("says unavailable, and offers no story, when no card could be built", () => {
    const h = render({
      outcomes: null, fleet: null, rides: null, gather: null, dwell: null, equity: null, devices: null,
    });
    expect(h.textContent).toContain("Stats are unavailable right now");
    expect(h.querySelector('[data-role="story-host"]')).toBeNull();
  });
});

describe("loading", () => {
  /** A fetch stub that answers each endpoint from the fixtures, except the
   *  ones named in `fail`. */
  function stubFetch(fail: string[] = []) {
    const routes: [string, unknown][] = [
      ["/fleet/outcomes", outcomes()],
      ["/devices/history/hourly", { days: 1, hours: [fleet()] }],
      ["/analytics/rides", rides()],
      ["/analytics/devices-by-region", gather()],
      ["/analytics/dwell", dwell()],
      ["/compliance/daily/latest", equity()],
    ];
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (fail.some((f) => url.includes(f))) throw new Error("offline");
      const hit = routes.find(([path]) => url.includes(path));
      if (!hit) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(hit[1]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderLive = (hooks = {}, voice: StatsVoice = "rider") =>
    renderFleetStats(host, voice, { now: () => NOW, devices: () => devices(), ...hooks });

  const keys = () =>
    Array.from(host.querySelectorAll<HTMLElement>(".stat-card")).map((c) => c.dataset.card);

  it("fetches every endpoint in parallel and renders every card", async () => {
    const spy = stubFetch();
    await renderLive();
    expect(keys()).toEqual(ALL_CARDS);
    const urls = spy.mock.calls.map(([u]) => String(u));
    expect(urls).toHaveLength(6);
    // Dwell is asked for whole days inside the era only.
    expect(urls.find((u) => u.includes("/analytics/dwell"))).toContain("days=3");
    expect(urls.find((u) => u.includes("/analytics/rides"))).toContain("granularity=hour");
  });

  it("hides only the card whose fetch failed", async () => {
    for (const [path, key] of [
      ["/fleet/outcomes", "outcomes"],
      ["/devices/history/hourly", "now"],
      ["/analytics/rides", "rides"],
      ["/analytics/devices-by-region", "gather"],
      ["/analytics/dwell", "dwell"],
      ["/compliance/daily/latest", "equity"],
    ] as const) {
      stubFetch([path]);
      await renderLive();
      expect(keys(), path).toEqual(ALL_CARDS.filter((k) => k !== key));
      vi.restoreAllMocks();
    }
  });

  it("keeps the other cards when the map's feed throws", async () => {
    stubFetch();
    await renderLive({ devices: () => { throw new Error("no map"); } });
    expect(keys()).toEqual(ALL_CARDS.filter((k) => k !== "range"));
  });

  it("renders the embed's voice without a range card", async () => {
    stubFetch();
    await renderFleetStats(host, "civic", { now: () => NOW });
    expect(keys()).toEqual(ALL_CARDS.filter((k) => k !== "range"));
    expect(host.querySelector(".stats-title")?.textContent).toBe(VOICES.civic.title);
  });

  it("hands the story slot over once the figures are on screen", async () => {
    stubFetch();
    const mountStory = vi.fn();
    await renderLive({ mountStory });
    expect(mountStory).toHaveBeenCalledTimes(1);
    expect((mountStory.mock.calls[0][0] as HTMLElement).isConnected).toBe(true);
  });

  it("says unavailable, and asks for no story, when everything is offline", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const mountStory = vi.fn();
    await renderFleetStats(host, "rider", { now: () => NOW, mountStory });
    expect(host.textContent).toContain("Stats are unavailable right now");
    expect(mountStory).not.toHaveBeenCalled();
  });
});
