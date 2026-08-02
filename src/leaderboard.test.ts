// @vitest-environment happy-dom
//
// 🏆 Leaderboard view. Covers, per the frontend plan's Vitest-introduction
// bullet: the payload → FeatureCollection transform (ring closure, lng/lat
// order, null-color defaulting), the generic hex-density/choropleth
// pause/resume hook (pure logic), the cell-detail content generation from a
// leader+runners_up+empty-cell fixture set, and `wireLeaderboard`'s DOM/open
// behavior (topbar insertBefore, aria-pressed, the open()/close() side
// effects on devices/popups/pause hooks). `Devices.setLeaderboardActive`'s
// own interaction with `filtered()` is covered separately in
// `devices.test.ts` — this lane's one `devices.ts` addition, tested against
// the real class rather than this module's `LeaderboardDevicesLike` seam.
import { describe, expect, it, vi } from "vitest";
import { latLngToCell } from "h3-js";

import type { LeaderboardCell, LeaderboardMapResponse } from "./api.ts";
import {
  LEADERBOARD_DETAIL_TITLE,
  LEADERBOARD_NEUTRAL_COLOR,
  buildLeaderboardDetailHtml,
  createLayerPause,
  leaderboardMapToFeatureCollection,
  wireLeaderboard,
  type LeaderboardDeps,
  type LeaderboardDevicesLike,
  type Pausable,
} from "./leaderboard.ts";

// ---------------------------------------------------------------------------
// leaderboardMapToFeatureCollection
// ---------------------------------------------------------------------------

// Real, valid Denver-area H3 r8 cells (generated, not hand-typed hex
// literals) — cellToBoundary throws/misbehaves on a made-up string, so the
// ring-closure/lng-lat-order assertions need genuine cells.
const CELL_NO_LEADER = latLngToCell(39.7392, -104.9903, 8);
const CELL_UNCLAIMED_COLORS = latLngToCell(39.75, -105.0, 8);
const CELL_CLAIMED = latLngToCell(39.72, -104.95, 8);

function baseResponse(cells: Record<string, LeaderboardCell>): LeaderboardMapResponse {
  return {
    computed_at: "2026-07-30T04:00:00Z",
    window_start: "2026-07-23T00:00:00Z",
    window_end: "2026-07-30T00:00:00Z",
    cells,
  };
}

describe("leaderboardMapToFeatureCollection", () => {
  it("closes the ring (first point repeated as the last) for every cell", () => {
    const resp = baseResponse({
      [CELL_NO_LEADER]: { total_points: 0, distinct_earners: 0, leader: null, runners_up: [] },
    });
    const fc = leaderboardMapToFeatureCollection(resp);
    expect(fc.features).toHaveLength(1);
    const ring = fc.features[0]!.geometry.coordinates[0]!;
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("emits coordinates as [lng, lat], not h3-js's native [lat, lng]", () => {
    const resp = baseResponse({
      [CELL_NO_LEADER]: { total_points: 0, distinct_earners: 0, leader: null, runners_up: [] },
    });
    const ring = leaderboardMapToFeatureCollection(resp).features[0]!.geometry
      .coordinates[0]!;
    // Denver: longitude ~ -105..-104 (big negative), latitude ~ 39..40
    // (small positive) — unambiguous which slot is which.
    for (const [x, y] of ring) {
      expect(x).toBeLessThan(-100);
      expect(y).toBeGreaterThan(30);
      expect(y).toBeLessThan(45);
    }
  });

  it("no leader → no fill (opacity 0) + a hairline neutral outline at 0.15 opacity", () => {
    const resp = baseResponse({
      [CELL_NO_LEADER]: { total_points: 0, distinct_earners: 0, leader: null, runners_up: [] },
    });
    const props = leaderboardMapToFeatureCollection(resp).features[0]!.properties;
    expect(props.hasLeader).toBe(false);
    expect(props.fillColor).toBe(LEADERBOARD_NEUTRAL_COLOR);
    expect(props.fillOpacity).toBe(0);
    expect(props.lineColor).toBe(LEADERBOARD_NEUTRAL_COLOR);
    expect(props.lineOpacity).toBe(0.15);
  });

  it("leader with unclaimed (null) colors → neutral fill @ 0.22 + OPAQUE neutral border", () => {
    const resp = baseResponse({
      [CELL_UNCLAIMED_COLORS]: {
        total_points: 40,
        distinct_earners: 3,
        leader: {
          display_name: "Sir Newbie",
          points: 22,
          ruling_color: null,
          ruling_border_color: null,
          ruling_alpha: null,
        },
        runners_up: [],
      },
    });
    const props = leaderboardMapToFeatureCollection(resp).features[0]!.properties;
    expect(props.hasLeader).toBe(true);
    expect(props.fillColor).toBe(LEADERBOARD_NEUTRAL_COLOR);
    expect(props.fillOpacity).toBe(0.22);
    expect(props.lineColor).toBe(LEADERBOARD_NEUTRAL_COLOR);
    // Opaque regardless of the fill's alpha — account.ts:794's convention.
    expect(props.lineOpacity).toBe(1);
  });

  it("leader with claimed colors → leader's ruling_color @ ruling_alpha, border @ opacity 1.0", () => {
    const resp = baseResponse({
      [CELL_CLAIMED]: {
        total_points: 88,
        distinct_earners: 5,
        leader: {
          display_name: "Duke Speedy",
          points: 60,
          ruling_color: "#ff8800",
          ruling_border_color: "#cc6600",
          ruling_alpha: 0.45,
        },
        runners_up: [],
      },
    });
    const props = leaderboardMapToFeatureCollection(resp).features[0]!.properties;
    expect(props.hasLeader).toBe(true);
    expect(props.fillColor).toBe("#ff8800");
    expect(props.fillOpacity).toBe(0.45);
    expect(props.lineColor).toBe("#cc6600");
    expect(props.lineOpacity).toBe(1);
  });

  it("skips a malformed cell id instead of throwing", () => {
    const resp = baseResponse({
      "not-a-real-h3-cell": { total_points: 0, distinct_earners: 0, leader: null, runners_up: [] },
      [CELL_NO_LEADER]: { total_points: 0, distinct_earners: 0, leader: null, runners_up: [] },
    });
    const fc = leaderboardMapToFeatureCollection(resp);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.properties.cell).toBe(CELL_NO_LEADER);
  });

  it("every feature carries its own cell id, and an empty payload yields an empty FeatureCollection", () => {
    expect(leaderboardMapToFeatureCollection(baseResponse({})).features).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createLayerPause — the hex-density / region-choropleth pause/resume hook.
// Pure logic: given a stored active value, pause() forces the layer off,
// resume() re-applies the stored value; a change WHILE paused only updates
// the stored value.
// ---------------------------------------------------------------------------

describe("createLayerPause", () => {
  it("hex-density scenario: pause() calls setSize(null); resume() re-applies the value active at pause time", () => {
    const applied: (string | null)[] = [];
    let active: string | null = "large"; // mirrors HexSize
    const pause = createLayerPause<string | null>(
      { getActive: () => active, apply: (v) => void applied.push(v) },
      null,
    );
    pause.pause();
    expect(applied).toEqual([null]); // setSize(null)
    pause.resume();
    expect(applied).toEqual([null, "large"]); // setSize("large") again
  });

  it("recordChange applies immediately while not paused (today's live-apply behavior)", () => {
    const applied: (string | null)[] = [];
    const pause = createLayerPause<string | null>(
      { getActive: () => null, apply: (v) => void applied.push(v) },
      null,
    );
    pause.recordChange("medium");
    expect(applied).toEqual(["medium"]);
    expect(pause.storedValue()).toBe("medium");
  });

  it("recordChange WHILE paused only updates the stored value — the layer call defers to resume()", () => {
    const applied: (string | null)[] = [];
    const pause = createLayerPause<string | null>(
      { getActive: () => "small", apply: (v) => void applied.push(v) },
      null,
    );
    pause.pause();
    applied.length = 0; // clear the pause()-triggered null apply
    pause.recordChange("large"); // a mid-open pick
    expect(applied).toEqual([]); // NOT applied yet — would paint under the leaderboard
    pause.resume();
    expect(applied).toEqual(["large"]); // caught up on close
  });

  it("pause()/resume() are idempotent — a double call doesn't re-apply", () => {
    const applied: (string | null)[] = [];
    const pause = createLayerPause<string | null>(
      { getActive: () => "medium", apply: (v) => void applied.push(v) },
      null,
    );
    pause.pause();
    pause.pause();
    expect(applied).toEqual([null]);
    pause.resume();
    pause.resume();
    expect(applied).toEqual([null, "medium"]);
  });

  it("isPaused() reflects state", () => {
    const pause = createLayerPause<string | null>({ getActive: () => null, apply: () => {} }, null);
    expect(pause.isPaused()).toBe(false);
    pause.pause();
    expect(pause.isPaused()).toBe(true);
    pause.resume();
    expect(pause.isPaused()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildLeaderboardDetailHtml — three cases: a claimed cell with runners-up,
// an unclaimed cell (signed in → hint), an unclaimed cell (signed out → no
// hint). Plus an escaping check, since bodyHtml is caller-escaped innerHTML.
// ---------------------------------------------------------------------------

describe("buildLeaderboardDetailHtml", () => {
  const WINDOW = { windowStart: "2026-07-23T00:00:00Z", windowEnd: "2026-07-30T00:00:00Z" };

  it("case 1 — claimed cell: generous leader section + runners-up + totals", () => {
    const cell: LeaderboardCell = {
      total_points: 120,
      distinct_earners: 6,
      leader: {
        display_name: "Duke Speedy",
        points: 80,
        ruling_color: "#ff8800",
        ruling_border_color: "#cc6600",
        ruling_alpha: 0.5,
      },
      runners_up: [
        { display_name: "Baron Slowpoke", points: 30, ruling_color: null, ruling_border_color: null, ruling_alpha: null },
        { display_name: "Countess Coaster", points: 10, ruling_color: null, ruling_border_color: null, ruling_alpha: null },
      ],
    };
    const html = buildLeaderboardDetailHtml({ cellId: "x", cell, ...WINDOW, signedIn: false });
    expect(html).toContain("Duke Speedy");
    expect(html).toContain("80 pts");
    expect(html).toContain("leaderboard-detail__swatch");
    // The swatch renders as rgba() (fill color + ruling_alpha composited),
    // matching account.ts's own preview convention — not the raw hex.
    expect(html).toContain("background:rgba(255, 136, 0, 0.5)");
    expect(html).toContain("border-color:#cc6600");
    expect(html).toContain("Baron Slowpoke");
    expect(html).toContain("Countess Coaster");
    expect(html).toContain("120 total pts");
    expect(html).toContain("6 distinct earners");
    expect(html).not.toContain("Unclaimed territory");
  });

  it("case 2 — unclaimed cell, signed in: 'Unclaimed territory' + a hint pointing at the profile", () => {
    const html = buildLeaderboardDetailHtml({
      cellId: "x",
      cell: { total_points: 0, distinct_earners: 0, leader: null, runners_up: [] },
      ...WINDOW,
      signedIn: true,
    });
    expect(html).toContain("Unclaimed territory");
    expect(html).toContain("ruling colors");
    expect(html).toContain('data-action="open-profile"');
  });

  it("case 3 — unclaimed cell, signed out: 'Unclaimed territory' with NO profile hint", () => {
    const html = buildLeaderboardDetailHtml({
      cellId: "x",
      cell: { total_points: 0, distinct_earners: 0, leader: null, runners_up: [] },
      ...WINDOW,
      signedIn: false,
    });
    expect(html).toContain("Unclaimed territory");
    expect(html).not.toContain('data-action="open-profile"');
  });

  it("a null `cell` (defensive — clicked id absent from the payload) renders identically to a genuinely unclaimed cell", () => {
    const html = buildLeaderboardDetailHtml({ cellId: "x", cell: null, ...WINDOW, signedIn: false });
    expect(html).toContain("Unclaimed territory");
  });

  it("escapes an untrusted display_name (bodyHtml is caller-escaped innerHTML)", () => {
    const cell: LeaderboardCell = {
      total_points: 4,
      distinct_earners: 1,
      leader: {
        display_name: '<img src=x onerror=alert(1)>',
        points: 4,
        ruling_color: null,
        ruling_border_color: null,
        ruling_alpha: null,
      },
      runners_up: [],
    };
    const html = buildLeaderboardDetailHtml({ cellId: "x", cell, ...WINDOW, signedIn: false });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("window dates render as human-readable, not raw ISO", () => {
    const html = buildLeaderboardDetailHtml({
      cellId: "x",
      cell: { total_points: 0, distinct_earners: 0, leader: null, runners_up: [] },
      ...WINDOW,
      signedIn: false,
    });
    expect(html).not.toContain("2026-07-23T00:00:00Z");
    expect(html).toContain("Window:");
  });
});

// ---------------------------------------------------------------------------
// wireLeaderboard — topbar insertBefore + open()/close() side effects.
// ---------------------------------------------------------------------------

function fakeMLMap() {
  const sources = new globalThis.Map<string, { setData: ReturnType<typeof vi.fn> }>();
  return {
    addSource: (id: string) => {
      sources.set(id, { setData: vi.fn() });
    },
    getSource: (id: string) => sources.get(id),
    addLayer: () => {},
    getLayer: () => undefined,
    on: () => {},
    getCanvas: () => ({ style: {} }),
  };
}

function fakeDevices(): LeaderboardDevicesLike & { calls: boolean[] } {
  const calls: boolean[] = [];
  return { calls, setLeaderboardActive: (on) => calls.push(on) };
}

function fakePausable(): Pausable & { pauseCalls: number; resumeCalls: number } {
  return {
    pauseCalls: 0,
    resumeCalls: 0,
    pause() {
      this.pauseCalls++;
    },
    resume() {
      this.resumeCalls++;
    },
  };
}

function setupTopbar(): { right: HTMLElement; profileBtn: HTMLButtonElement } {
  const right = document.createElement("div");
  right.className = "topbar__right";
  const profileBtn = document.createElement("button");
  profileBtn.className = "topbar__btn drawer-tab drawer-tab--topbar";
  profileBtn.dataset.drawer = "account";
  right.appendChild(profileBtn);
  document.body.appendChild(right);
  return { right, profileBtn };
}

function emptyResponse(): LeaderboardMapResponse {
  return baseResponse({});
}

describe("wireLeaderboard", () => {
  it("inserts the 🏆 button immediately left of the profile button, aria-pressed=false initially", () => {
    const { right, profileBtn } = setupTopbar();
    wireLeaderboard(fakeMLMap() as unknown as Parameters<typeof wireLeaderboard>[0], profileBtn, {
      devices: fakeDevices(),
    });
    const btn = right.firstElementChild as HTMLButtonElement;
    expect(btn).not.toBe(profileBtn);
    expect(btn.nextElementSibling).toBe(profileBtn);
    expect(btn.textContent).toBe("🏆");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("open() hides devices, closes popups, pauses hex/choropleth, and fetches the map", async () => {
    const { profileBtn } = setupTopbar();
    const devices = fakeDevices();
    const hexDensityPause = fakePausable();
    const choroplethPause = fakePausable();
    const closeAllPopups = vi.fn();
    const fetchMap = vi.fn().mockResolvedValue(emptyResponse());
    const deps: LeaderboardDeps = {
      devices,
      closeAllPopups,
      hexDensityPause,
      choroplethPause,
      fetchMap,
      isAuthenticated: () => false,
    };
    const handle = wireLeaderboard(
      fakeMLMap() as unknown as Parameters<typeof wireLeaderboard>[0],
      profileBtn,
      deps,
    );

    handle.open();

    expect(devices.calls).toEqual([true]);
    expect(closeAllPopups).toHaveBeenCalledTimes(1);
    expect(hexDensityPause.pauseCalls).toBe(1);
    expect(choroplethPause.pauseCalls).toBe(1);
    expect(handle.isOpen()).toBe(true);
    await vi.waitFor(() => expect(fetchMap).toHaveBeenCalledTimes(1));
  });

  it("close() restores devices and resumes hex/choropleth", async () => {
    const { profileBtn } = setupTopbar();
    const devices = fakeDevices();
    const hexDensityPause = fakePausable();
    const choroplethPause = fakePausable();
    const fetchMap = vi.fn().mockResolvedValue(emptyResponse());
    const handle = wireLeaderboard(
      fakeMLMap() as unknown as Parameters<typeof wireLeaderboard>[0],
      profileBtn,
      { devices, hexDensityPause, choroplethPause, fetchMap, closeAllPopups: () => {} },
    );
    handle.open();
    await vi.waitFor(() => expect(fetchMap).toHaveBeenCalledTimes(1));

    handle.close();

    expect(devices.calls).toEqual([true, false]);
    expect(hexDensityPause.resumeCalls).toBe(1);
    expect(choroplethPause.resumeCalls).toBe(1);
    expect(handle.isOpen()).toBe(false);
  });

  it("clicking the button toggles the view open, then closed", () => {
    const { right, profileBtn } = setupTopbar();
    const devices = fakeDevices();
    wireLeaderboard(fakeMLMap() as unknown as Parameters<typeof wireLeaderboard>[0], profileBtn, {
      devices,
      closeAllPopups: () => {},
      fetchMap: vi.fn().mockResolvedValue(emptyResponse()),
    });
    const btn = right.firstElementChild as HTMLButtonElement;

    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(devices.calls).toEqual([true]);

    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(devices.calls).toEqual([true, false]);
  });

  it("a second open() while already open is a no-op (idempotent)", () => {
    const { profileBtn } = setupTopbar();
    const devices = fakeDevices();
    const closeAllPopups = vi.fn();
    const handle = wireLeaderboard(
      fakeMLMap() as unknown as Parameters<typeof wireLeaderboard>[0],
      profileBtn,
      { devices, closeAllPopups, fetchMap: vi.fn().mockResolvedValue(emptyResponse()) },
    );
    handle.open();
    handle.open();
    expect(devices.calls).toEqual([true]);
    expect(closeAllPopups).toHaveBeenCalledTimes(1);
  });

  it("open()/close() work with no hex-density or choropleth pause deps at all (both optional)", () => {
    const { profileBtn } = setupTopbar();
    const devices = fakeDevices();
    const handle = wireLeaderboard(
      fakeMLMap() as unknown as Parameters<typeof wireLeaderboard>[0],
      profileBtn,
      { devices, closeAllPopups: () => {}, fetchMap: vi.fn().mockResolvedValue(emptyResponse()) },
    );
    expect(() => {
      handle.open();
      handle.close();
    }).not.toThrow();
  });
});

// Title constant sanity — used verbatim by main.ts's wireX() nowhere else,
// but the modal's title contract (openFloatingModal's first arg) is a plain
// string, not re-derived per click.
describe("LEADERBOARD_DETAIL_TITLE", () => {
  it("is a stable, non-empty title", () => {
    expect(LEADERBOARD_DETAIL_TITLE.length).toBeGreaterThan(0);
  });
});
