// @vitest-environment happy-dom
//
// 🏆 Territory control's pure half: the `/leaderboard/map` payload →
// FeatureCollection transform (ring closure, lng/lat order, null-color
// defaulting, the single fill opacity) and the cell-detail panel's content
// generation from a leader + runners_up + empty-cell fixture set.
//
// What used to be tested here and no longer exists: the topbar 🏆 button,
// the map view it toggled, and the hex-density/choropleth pause hooks that
// view needed. Territory control is a `hexdensity.ts` metric now — its map
// behavior is covered in hexdensity.test.ts.
import { describe, expect, it } from "vitest";
import { latLngToCell } from "h3-js";

import type { LeaderboardCell, LeaderboardMapResponse } from "./api.ts";
import {
  LEADERBOARD_NEUTRAL_COLOR,
  TERRITORY_FILL_OPACITY,
  buildLeaderboardDetailHtml,
  escapeHtml,
  formatWindowRange,
  hexWithAlpha,
  leaderboardMapToFeatureCollection,
} from "./leaderboard.ts";

// Real, valid Denver-area H3 r8 cells (generated, not hand-typed hex
// literals) — cellToBoundary throws/misbehaves on a made-up string, so the
// ring-closure/lng-lat-order assertions need genuine cells.
const CELL_NO_LEADER = latLngToCell(39.7392, -104.9903, 8);
const CELL_UNCLAIMED_COLORS = latLngToCell(39.75, -105.0, 8);
const CELL_CLAIMED = latLngToCell(39.72, -104.95, 8);

function baseResponse(
  cells: Record<string, LeaderboardCell>,
): LeaderboardMapResponse {
  return {
    computed_at: "2026-07-30T04:00:00Z",
    window_start: "2026-07-23T00:00:00Z",
    window_end: "2026-07-30T00:00:00Z",
    cells,
  };
}

const EMPTY_CELL: LeaderboardCell = {
  total_points: 0,
  distinct_earners: 0,
  leader: null,
  runners_up: [],
};

const CLAIMED_CELL: LeaderboardCell = {
  total_points: 144,
  distinct_earners: 4,
  leader: {
    display_name: "Duke Swift 🦦",
    points: 88,
    ruling_color: "#7c54cd",
    ruling_border_color: "#382264",
    ruling_alpha: 0.6,
  },
  runners_up: [
    {
      display_name: "Rider2 🦊",
      points: 30,
      ruling_color: null,
      ruling_border_color: null,
      ruling_alpha: null,
    },
  ],
};

describe("leaderboardMapToFeatureCollection", () => {
  it("closes the ring (first point repeated as the last) for every cell", () => {
    const fc = leaderboardMapToFeatureCollection(
      baseResponse({ [CELL_NO_LEADER]: EMPTY_CELL }),
    );
    expect(fc.features).toHaveLength(1);
    const ring = fc.features[0]!.geometry.coordinates[0]!;
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("emits coordinates as [lng, lat], not h3-js's native [lat, lng]", () => {
    const ring = leaderboardMapToFeatureCollection(
      baseResponse({ [CELL_NO_LEADER]: EMPTY_CELL }),
    ).features[0]!.geometry.coordinates[0]!;
    // Denver: longitude ~ -105..-104 (big negative), latitude ~ 39..40
    // (small positive) — unambiguous which slot is which.
    for (const [x, y] of ring) {
      expect(x).toBeLessThan(-100);
      expect(y).toBeGreaterThan(30);
      expect(y).toBeLessThan(45);
    }
  });

  it("no leader → no fill (opacity 0) + a hairline neutral outline", () => {
    const props = leaderboardMapToFeatureCollection(
      baseResponse({ [CELL_NO_LEADER]: EMPTY_CELL }),
    ).features[0]!.properties;
    expect(props.hasLeader).toBe(false);
    expect(props.fillColor).toBe(LEADERBOARD_NEUTRAL_COLOR);
    expect(props.fillOpacity).toBe(0);
    expect(props.lineColor).toBe(LEADERBOARD_NEUTRAL_COLOR);
    expect(props.lineOpacity).toBe(0.15);
  });

  it("a leader with no claimed colors reads as held-but-uncolored", () => {
    const props = leaderboardMapToFeatureCollection(
      baseResponse({
        [CELL_UNCLAIMED_COLORS]: {
          ...EMPTY_CELL,
          leader: {
            display_name: "Rider2 🦊",
            points: 12,
            ruling_color: null,
            ruling_border_color: null,
            ruling_alpha: null,
          },
        },
      }),
    ).features[0]!.properties;
    expect(props.hasLeader).toBe(true);
    expect(props.fillColor).toBe(LEADERBOARD_NEUTRAL_COLOR);
    // Distinct from both an unclaimed cell (0) and a real claim.
    expect(props.fillOpacity).toBe(0.22);
    expect(props.lineOpacity).toBe(1);
  });

  it("a claimed cell takes its leader's colors", () => {
    const props = leaderboardMapToFeatureCollection(
      baseResponse({ [CELL_CLAIMED]: CLAIMED_CELL }),
    ).features[0]!.properties;
    expect(props.fillColor).toBe("#7c54cd");
    expect(props.lineColor).toBe("#382264");
    expect(props.lineOpacity).toBe(1);
  });

  it("ignores ruling_alpha and fills at the one global opacity", () => {
    const shouty: LeaderboardCell = {
      ...CLAIMED_CELL,
      leader: { ...CLAIMED_CELL.leader!, ruling_alpha: 1 },
    };
    const meek: LeaderboardCell = {
      ...CLAIMED_CELL,
      leader: { ...CLAIMED_CELL.leader!, ruling_alpha: 0.1 },
    };
    const of = (cell: LeaderboardCell): number =>
      leaderboardMapToFeatureCollection(baseResponse({ [CELL_CLAIMED]: cell }))
        .features[0]!.properties.fillOpacity;
    expect(of(shouty)).toBe(TERRITORY_FILL_OPACITY);
    expect(of(meek)).toBe(TERRITORY_FILL_OPACITY);
    expect(of(shouty)).toBe(of(meek));
  });

  it("carries the cell id on each feature (the triple-click readout reads it)", () => {
    const f = leaderboardMapToFeatureCollection(
      baseResponse({ [CELL_CLAIMED]: CLAIMED_CELL }),
    ).features[0]!;
    expect(f.properties.cell).toBe(CELL_CLAIMED);
    expect(f.id).toBe(CELL_CLAIMED);
  });

  it("skips a cell id that isn't a valid H3 string instead of throwing", () => {
    const fc = leaderboardMapToFeatureCollection(
      baseResponse({ "not-an-h3-cell": EMPTY_CELL, [CELL_CLAIMED]: CLAIMED_CELL }),
    );
    expect(fc.features.map((f) => f.properties.cell)).toEqual([CELL_CLAIMED]);
  });
});

describe("formatWindowRange", () => {
  it("renders two ISO timestamps as local dates", () => {
    const out = formatWindowRange("2026-07-23T00:00:00Z", "2026-07-30T00:00:00Z");
    expect(out).toContain("–");
    expect(out).not.toContain("Invalid Date");
  });

  it("falls back to the raw string rather than printing 'Invalid Date'", () => {
    // Every surface that quotes the window — the cell panel, the territory
    // legend, the panel's tally — goes through this, so an unexpected value
    // from the API degrades to something legible in all three at once.
    expect(formatWindowRange("nonsense", "2026-07-30T00:00:00Z")).toContain(
      "nonsense",
    );
    expect(formatWindowRange("nonsense", "also-nonsense")).not.toContain(
      "Invalid Date",
    );
  });
});

describe("hexWithAlpha", () => {
  it("expands #rrggbb to rgba()", () => {
    expect(hexWithAlpha("#7c54cd", 0.55)).toBe("rgba(124, 84, 205, 0.55)");
  });

  it("passes a value it can't parse straight through", () => {
    expect(hexWithAlpha("rebeccapurple", 0.55)).toBe("rebeccapurple");
  });
});

describe("buildLeaderboardDetailHtml", () => {
  const base = {
    cellId: CELL_CLAIMED,
    windowStart: "2026-07-23T00:00:00Z",
    windowEnd: "2026-07-30T00:00:00Z",
    signedIn: false,
  };

  it("renders the leader, the runners-up and the cell totals", () => {
    const html = buildLeaderboardDetailHtml({ ...base, cell: CLAIMED_CELL });
    expect(html).toContain("Duke Swift 🦦");
    expect(html).toContain("88 pts");
    expect(html).toContain("Rider2 🦊");
    expect(html).toContain("30 pts");
    expect(html).toContain("144 total pts");
    expect(html).toContain("4 distinct earners");
  });

  it("names the cell, so a triple-click answers 'what exactly is this'", () => {
    const html = buildLeaderboardDetailHtml({ ...base, cell: CLAIMED_CELL });
    expect(html).toContain(CELL_CLAIMED);
  });

  it("swatches the leader at the global opacity, not their stored alpha", () => {
    const html = buildLeaderboardDetailHtml({
      ...base,
      cell: {
        ...CLAIMED_CELL,
        leader: { ...CLAIMED_CELL.leader!, ruling_alpha: 1 },
      },
    });
    expect(html).toContain(hexWithAlpha("#7c54cd", TERRITORY_FILL_OPACITY));
    expect(html).not.toContain("rgba(124, 84, 205, 1)");
  });

  it("an unclaimed cell says so, with no leader block", () => {
    const html = buildLeaderboardDetailHtml({ ...base, cell: EMPTY_CELL });
    expect(html).toContain("Unclaimed territory");
    expect(html).not.toContain("leaderboard-detail__leader");
  });

  it("a cell id with no payload entry is treated as unclaimed, not as an error", () => {
    const html = buildLeaderboardDetailHtml({ ...base, cell: null });
    expect(html).toContain("Unclaimed territory");
  });

  it("offers the claim-your-colors hint only when signed in", () => {
    expect(
      buildLeaderboardDetailHtml({ ...base, cell: EMPTY_CELL, signedIn: true }),
    ).toContain('data-action="open-profile"');
    expect(
      buildLeaderboardDetailHtml({ ...base, cell: EMPTY_CELL, signedIn: false }),
    ).not.toContain('data-action="open-profile"');
  });

  it("escapes a display name — the panel's contract is caller-escaped HTML", () => {
    const html = buildLeaderboardDetailHtml({
      ...base,
      cell: {
        ...CLAIMED_CELL,
        leader: {
          ...CLAIMED_CELL.leader!,
          display_name: '<img src=x onerror="alert(1)">',
        },
      },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("escapeHtml", () => {
  it("neutralizes every character that can break out of an attribute or a tag", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
