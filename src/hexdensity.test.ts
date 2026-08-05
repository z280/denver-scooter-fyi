// @vitest-environment happy-dom
//
// Hex shading's two additions: the `territory_control` metric (a different
// endpoint, pinned to r8, painted per-feature rather than off a ramp) and
// the triple-click readout that both it and the six ramp metrics answer.
//
// A fake MapLibre map stands in for the real one — enough of the surface to
// observe what got set on the source and the paint properties, which is the
// whole of what this module does to a map.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { latLngToCell } from "h3-js";

import type { H3AggregatesResponse, LeaderboardMapResponse } from "./api.ts";
import {
  HEX_INSPECT_TITLE,
  HexDensity,
  TERRITORY_HEX_SIZE,
  TERRITORY_METRIC,
  buildHexInspectHtml,
} from "./hexdensity.ts";
import { LEADERBOARD_DETAIL_TITLE } from "./leaderboard.ts";

const CELL_R8 = latLngToCell(39.7392, -104.9903, 8);
const CELL_R9 = latLngToCell(39.7392, -104.9903, 9);

function fakeMap() {
  const paint = new globalThis.Map<string, unknown>();
  const layerClicks: ((e: unknown) => void)[] = [];
  const setData = vi.fn();
  const dcz = {
    enabled: true,
    isEnabled: () => dcz.enabled,
    enable: vi.fn(() => {
      dcz.enabled = true;
    }),
    disable: vi.fn(() => {
      dcz.enabled = false;
    }),
  };
  const sources = new globalThis.Map<string, { setData: typeof setData }>();
  return {
    paint,
    layerClicks,
    setData,
    doubleClickZoom: dcz,
    addSource: (id: string) => sources.set(id, { setData }),
    getSource: (id: string) => sources.get(id),
    addLayer: () => {},
    getLayer: () => undefined,
    on: (type: string, _layer: string, fn: (e: unknown) => void) => {
      if (type === "click") layerClicks.push(fn);
    },
    setPaintProperty: (layer: string, prop: string, value: unknown) => {
      paint.set(`${layer}.${prop}`, value);
    },
    getCanvas: () => ({ style: {} }),
  };
}

function territoryPayload(): LeaderboardMapResponse {
  return {
    computed_at: "2026-07-30T04:00:00Z",
    window_start: "2026-07-23T00:00:00Z",
    window_end: "2026-07-30T00:00:00Z",
    cells: {
      [CELL_R8]: {
        total_points: 144,
        distinct_earners: 4,
        leader: {
          display_name: "Duke swift🦦",
          points: 88,
          ruling_color: "#7c54cd",
          ruling_border_color: "#382264",
          ruling_alpha: 0.6,
        },
        runners_up: [],
      },
    },
  };
}

function aggregatesPayload(): H3AggregatesResponse {
  return {
    cells: {
      [CELL_R9]: {
        device_count: 7,
        trips_started_24h: 3,
        starts_per_hour_peak: 1.5,
        avg_battery_percent: 62,
        risk_share: 0.25,
        avg_dwell_hours: 3.5,
      },
    },
  } as unknown as H3AggregatesResponse;
}

function setup() {
  const map = fakeMap();
  const legend = document.createElement("div");
  const fetchTerritory = vi.fn(async () => territoryPayload());
  const fetchAggregates = vi.fn(async () => aggregatesPayload());
  const openProfile = vi.fn();
  const hex = new HexDensity(
    map as never,
    legend,
    {
      fetchTerritory,
      fetchAggregates,
      openProfile,
      isAuthenticated: () => true,
    },
  );
  return { map, legend, hex, fetchTerritory, fetchAggregates, openProfile };
}

/** Feed n clicks on `cell` through the layer's click handler. */
function clickCell(
  map: ReturnType<typeof fakeMap>,
  cell: string,
  n: number,
  value?: number,
): void {
  for (let i = 0; i < n; i++) {
    for (const fn of map.layerClicks) {
      fn({ features: [{ properties: { cell, value } }] });
    }
  }
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("territory control as a hex metric", () => {
  it("fetches the leaderboard feed, not the H3 aggregates", async () => {
    const { hex, fetchTerritory, fetchAggregates } = setup();
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    expect(fetchTerritory).toHaveBeenCalledTimes(1);
    expect(fetchAggregates).not.toHaveBeenCalled();
  });

  it("paints per-feature colors instead of a ramp interpolation", async () => {
    const { hex, map } = setup();
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    expect(map.paint.get("hex-density-fill.fill-color")).toEqual([
      "get",
      "fillColor",
    ]);
    expect(map.paint.get("hex-density-fill.fill-opacity")).toEqual([
      "get",
      "fillOpacity",
    ]);
    expect(map.paint.get("hex-density-line.line-color")).toEqual([
      "get",
      "lineColor",
    ]);
  });

  it("restores the ramp paint when switching back to an aggregate metric", async () => {
    const { hex, map } = setup();
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    await hex.setMetric("device_count");
    expect(map.paint.get("hex-density-fill.fill-opacity")).toBe(0.55);
    expect(map.paint.get("hex-density-line.line-color")).toBe("#2171b5");
    expect(map.paint.get("hex-density-fill.fill-color")).toEqual(
      expect.arrayContaining(["interpolate"]),
    );
  });

  it("switching among ramp metrics at one size costs no fetch", async () => {
    const { hex, fetchAggregates } = setup();
    await hex.setView("medium", "device_count");
    expect(fetchAggregates).toHaveBeenCalledTimes(1);
    await hex.setMetric("risk_share");
    await hex.setMetric("avg_dwell_hours");
    expect(fetchAggregates).toHaveBeenCalledTimes(1);
  });

  it("crossing into territory control does refetch — it's another endpoint", async () => {
    const { hex, fetchTerritory } = setup();
    await hex.setView("medium", "device_count");
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    expect(fetchTerritory).toHaveBeenCalledTimes(1);
  });

  it("setView applies both changes with a single fetch", async () => {
    const { hex, fetchTerritory, fetchAggregates } = setup();
    await hex.setView("medium", "device_count");
    fetchAggregates.mockClear();
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    expect(fetchTerritory).toHaveBeenCalledTimes(1);
    expect(fetchAggregates).not.toHaveBeenCalled();
  });

  it("turning shading off clears the source and hides the legend", async () => {
    const { hex, map, legend } = setup();
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    expect(legend.hidden).toBe(false);
    await hex.setSize(null);
    expect(legend.hidden).toBe(true);
    expect(map.setData).toHaveBeenLastCalledWith({
      type: "FeatureCollection",
      features: [],
    });
  });

  it("a failed territory fetch clears the data rather than painting stale cells", async () => {
    const { map, legend } = setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const hex = new HexDensity(map as never, legend, {
      fetchTerritory: async () => {
        throw new Error("boom");
      },
    });
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    expect(map.setData).toHaveBeenLastCalledWith({
      type: "FeatureCollection",
      features: [],
    });
    err.mockRestore();
  });
});

describe("triple-click readout", () => {
  it("one or two clicks open nothing", async () => {
    const { hex, map } = setup();
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    clickCell(map, CELL_R8, 2);
    expect(document.querySelector(".ranks-modal")).toBeNull();
  });

  it("three clicks on a territory cell open that territory's rankings", async () => {
    const { hex, map } = setup();
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    clickCell(map, CELL_R8, 3);
    const modal = document.querySelector(".ranks-modal");
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain(LEADERBOARD_DETAIL_TITLE);
    expect(modal!.textContent).toContain("Duke swift🦦");
  });

  it("three clicks on a ramp-metric cell open its exact value", async () => {
    const { hex, map } = setup();
    await hex.setView("medium", "risk_share");
    clickCell(map, CELL_R9, 3, 0.25);
    const modal = document.querySelector(".ranks-modal");
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain(HEX_INSPECT_TITLE);
    expect(modal!.textContent).toContain(CELL_R9);
    expect(modal!.textContent).toContain("25%");
  });

  it("clicks spread across two different cells don't add up to a triple", async () => {
    const { hex, map } = setup();
    await hex.setView("medium", "device_count");
    clickCell(map, CELL_R9, 2, 7);
    clickCell(map, CELL_R8, 1, 7);
    expect(document.querySelector(".ranks-modal")).toBeNull();
  });

  it("holds the map's double-click zoom during a run, then gives it back", async () => {
    const { hex, map } = setup();
    vi.useFakeTimers();
    try {
      await hex.setView("medium", "device_count");
      clickCell(map, CELL_R9, 1, 7);
      expect(map.doubleClickZoom.disable).toHaveBeenCalled();
      clickCell(map, CELL_R9, 2, 7);
      // The third click completes the run and releases it immediately.
      expect(map.doubleClickZoom.enable).toHaveBeenCalled();
      expect(map.doubleClickZoom.enabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases double-click zoom on its own when a run is abandoned", async () => {
    const { hex, map } = setup();
    vi.useFakeTimers();
    try {
      await hex.setView("medium", "device_count");
      clickCell(map, CELL_R9, 1, 7);
      expect(map.doubleClickZoom.enabled).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(map.doubleClickZoom.enabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves double-click zoom alone if the map already had it off", async () => {
    const { hex, map } = setup();
    map.doubleClickZoom.enabled = false;
    await hex.setView("medium", "device_count");
    clickCell(map, CELL_R9, 3, 7);
    expect(map.doubleClickZoom.enable).not.toHaveBeenCalled();
  });

  it("changing the view abandons a half-finished run", async () => {
    const { hex, map } = setup();
    await hex.setView("medium", "device_count");
    clickCell(map, CELL_R9, 2, 7);
    await hex.setMetric("risk_share");
    clickCell(map, CELL_R9, 1, 0.25);
    expect(document.querySelector(".ranks-modal")).toBeNull();
  });

  it("the territory readout's Open profile button calls back to the app", async () => {
    const map = fakeMap();
    const openProfile = vi.fn();
    const hex = new HexDensity(map as never, document.createElement("div"), {
      fetchTerritory: async () => ({
        ...territoryPayload(),
        cells: {
          [CELL_R8]: {
            total_points: 0,
            distinct_earners: 0,
            leader: null,
            runners_up: [],
          },
        },
      }),
      isAuthenticated: () => true,
      openProfile,
    });
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    clickCell(map, CELL_R8, 3);
    document
      .querySelector<HTMLButtonElement>('[data-action="open-profile"]')!
      .click();
    expect(openProfile).toHaveBeenCalledTimes(1);
  });

  it("hides the claim hint when there is no profile pane to send anyone to", async () => {
    const map = fakeMap();
    const hex = new HexDensity(map as never, document.createElement("div"), {
      fetchTerritory: async () => ({
        ...territoryPayload(),
        cells: {
          [CELL_R8]: {
            total_points: 0,
            distinct_earners: 0,
            leader: null,
            runners_up: [],
          },
        },
      }),
      isAuthenticated: () => true,
      // no openProfile
    });
    await hex.setView(TERRITORY_HEX_SIZE, TERRITORY_METRIC);
    clickCell(map, CELL_R8, 3);
    expect(document.querySelector('[data-action="open-profile"]')).toBeNull();
  });
});

describe("buildHexInspectHtml", () => {
  it("names the cell, the metric and the resolution", () => {
    const html = buildHexInspectHtml({
      cellId: CELL_R9,
      metric: "device_count",
      value: 1284,
      size: "medium",
    });
    expect(html).toContain(CELL_R9);
    expect(html).toContain("Device density");
    expect(html).toContain("1,284 devices");
    expect(html).toContain("H3 resolution 9");
  });

  it("states the stored value for a metric whose display form rounds", () => {
    // The legend would say "33%"; the readout must not lose the rest.
    const html = buildHexInspectHtml({
      cellId: CELL_R9,
      metric: "risk_share",
      value: 0.3333333333,
      size: "small",
    });
    expect(html).toContain("0.3333333333");
  });

  it("does not present float noise from its own arithmetic as data", () => {
    const html = buildHexInspectHtml({
      cellId: CELL_R9,
      metric: "risk_share",
      value: 0.3333333333,
      size: "small",
    });
    expect(html).toContain("33.33333333%");
    expect(html).not.toContain("33.333333329999995");
  });

  it("states the stored hours alongside the friendly dwell string", () => {
    const html = buildHexInspectHtml({
      cellId: CELL_R9,
      metric: "avg_dwell_hours",
      value: 3.5,
      size: "large",
    });
    expect(html).toContain("3.5 hours");
  });
});
