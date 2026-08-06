// @vitest-environment happy-dom
//
// The Leaderboard drawer: the live regional tally, the points ledger built
// from `/points/schedule`, and the Show Territory Control switch's two-way
// relationship with the Areas drawer's hex control.
import { describe, expect, it, vi } from "vitest";

import type {
  LeaderboardRegionalResponse,
  PointsScheduleResponse,
} from "./api.ts";
import { TERRITORY_FILL_OPACITY } from "./leaderboard.ts";
import {
  buildAboutHtml,
  buildPointsScheduleHtml,
  buildRegionalTallyHtml,
  formatScheduleValue,
  humanizeAction,
  wireLeaderboardPanel,
  type LeaderboardPanelElements,
} from "./leaderboard-panel.ts";

const TALLY: LeaderboardRegionalResponse = {
  computed_at: "2026-07-30T18:42:11Z",
  window_start: "2026-07-02T18:42:11Z",
  window_end: "2026-07-30T18:42:11Z",
  leaders: [
    {
      rank: 1,
      display_name: "Duke Swift 🦦",
      points: 1312,
      ruling_color: "#7c54cd",
      ruling_border_color: "#382264",
      ruling_alpha: 0.6,
    },
    {
      rank: 2,
      display_name: "Rider2 🦊",
      points: 210,
      ruling_color: null,
      ruling_border_color: null,
      ruling_alpha: null,
    },
  ],
};

const SCHEDULE: PointsScheduleResponse = {
  qr_scan: { points: 100 },
  gbfs_trip_validated: { points: 20 },
  profile_completion: { points: 10 },
  report_not_found: { points: 4 },
  battery_contribution: { base: 8, per_step: 2, step_km: 2 },
  nav_distance_bonus: { base: 0, per_step: 2, step_km: 3 },
};

describe("buildRegionalTallyHtml", () => {
  it("ranks riders with their points", () => {
    const html = buildRegionalTallyHtml(TALLY);
    expect(html).toContain("Duke Swift 🦦");
    expect(html).toContain("1,312");
    expect(html).toContain("Rider2 🦊");
    expect(html).toContain("210");
  });

  it("swatches a claimed rider at the global territory opacity", () => {
    const html = buildRegionalTallyHtml(TALLY);
    expect(html).toContain(`rgba(124, 84, 205, ${TERRITORY_FILL_OPACITY})`);
  });

  it("gives a rider with no colors the outline-only swatch", () => {
    expect(buildRegionalTallyHtml(TALLY)).toContain(
      "leaderboard-panel__swatch--none",
    );
  });

  it("shows the rolling window the ranking covers", () => {
    expect(buildRegionalTallyHtml(TALLY)).toContain("Rolling window:");
  });

  it("distinguishes 'still loading' from 'that failed'", () => {
    expect(buildRegionalTallyHtml(null)).toContain("Loading");
    expect(buildRegionalTallyHtml(null, true)).toContain("Couldn't load");
  });

  it("an empty board invites rather than reading as broken", () => {
    const html = buildRegionalTallyHtml({ ...TALLY, leaders: [] });
    expect(html).toContain("Be first");
  });

  it("escapes display names", () => {
    const html = buildRegionalTallyHtml({
      ...TALLY,
      leaders: [{ ...TALLY.leaders[0]!, display_name: "<script>x</script>" }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("formatScheduleValue", () => {
  it("renders a flat award", () => {
    expect(formatScheduleValue(SCHEDULE, "gbfs_trip_validated")).toBe("20 pts");
  });

  it("renders a formula award with its base", () => {
    expect(formatScheduleValue(SCHEDULE, "battery_contribution")).toBe(
      "8 pts + 2 pts per 2 km",
    );
  });

  it("omits a zero base rather than promising '0 pts +'", () => {
    expect(formatScheduleValue(SCHEDULE, "nav_distance_bonus")).toBe(
      "2 pts per 3 km",
    );
  });

  it("tolerates the bare-number encoding the API may use for a flat award", () => {
    expect(formatScheduleValue({ gbfs_trip_validated: 20 }, "gbfs_trip_validated")).toBe("20 pts");
  });

  it("returns null for an action the API didn't publish", () => {
    expect(formatScheduleValue(SCHEDULE, "not_a_real_action")).toBeNull();
    expect(formatScheduleValue(null, "gbfs_trip_validated")).toBeNull();
  });
});

describe("buildPointsScheduleHtml", () => {
  it("lists published awards under their group headings", () => {
    const html = buildPointsScheduleHtml(SCHEDULE);
    expect(html).toContain("Complete a validated trip");
    expect(html).toContain("20 pts");
    expect(html).toContain("Riding");
    expect(html).toContain("Reporting a device");
  });

  it("suppresses qr_scan even when the server still publishes it", () => {
    // The QR-scan flow never shipped client-side, so its award is a promise
    // nobody can collect on — hidden from the named rows AND from the
    // humanized "More" pass (SCHEDULE carries it at 100 pts).
    const html = buildPointsScheduleHtml(SCHEDULE);
    expect(html).not.toContain("QR");
    expect(html).not.toContain("Qr scan");
    expect(html).not.toContain("100 pts");
  });

  it("drops a row the API didn't publish rather than showing a blank award", () => {
    const html = buildPointsScheduleHtml(SCHEDULE);
    expect(html).not.toContain("Finish the end-of-ride survey");
  });

  it("renders an award this build has never heard of", () => {
    const html = buildPointsScheduleHtml({
      ...SCHEDULE,
      brand_new_award: { points: 42 },
    });
    expect(html).toContain("Brand new award");
    expect(html).toContain("42 pts");
  });

  it("hardcodes no point values — every number comes from the schedule", () => {
    const html = buildPointsScheduleHtml({ device_photo: { points: 7 } });
    expect(html).toContain("7 pts");
    expect(html).not.toContain("100 pts");
  });

  it("distinguishes 'still loading' from 'that failed'", () => {
    expect(buildPointsScheduleHtml(null)).toContain("Loading");
    expect(buildPointsScheduleHtml(null, true)).toContain("Couldn't load");
  });
});

describe("humanizeAction", () => {
  it("turns a ledger key into something readable", () => {
    expect(humanizeAction("gbfs_trip_validated")).toBe("Gbfs trip validated");
  });
});

describe("buildAboutHtml", () => {
  it("explains territory control and where to find it", () => {
    const html = buildAboutHtml();
    expect(html).toContain("Territory control");
    expect(html).toContain("Areas");
    expect(html).toContain("28-day");
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function setup(overrides: Partial<{
  fetchRegional: () => Promise<LeaderboardRegionalResponse>;
  fetchSchedule: () => Promise<PointsScheduleResponse>;
}> = {}) {
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  const els: LeaderboardPanelElements = {
    toggle,
    regionalBody: document.createElement("div"),
    aboutBody: document.createElement("div"),
    scheduleBody: document.createElement("div"),
  };
  const setTerritory = vi.fn();
  const fetchRegional = vi.fn(overrides.fetchRegional ?? (async () => TALLY));
  const fetchSchedule = vi.fn(overrides.fetchSchedule ?? (async () => SCHEDULE));
  const handle = wireLeaderboardPanel(els, {
    setTerritory,
    fetchRegional,
    fetchSchedule,
  });
  return { els, toggle, setTerritory, fetchRegional, fetchSchedule, handle };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("wireLeaderboardPanel", () => {
  it("renders the explainer immediately — it needs no network", () => {
    const { els } = setup();
    expect(els.aboutBody.innerHTML).toContain("Territory control");
  });

  it("flipping the switch on asks the app for territory shading", () => {
    const { toggle, setTerritory } = setup();
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(setTerritory).toHaveBeenCalledWith(true);
  });

  it("flipping it off asks for the shading to stop", () => {
    const { toggle, setTerritory } = setup();
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(setTerritory).toHaveBeenCalledWith(false);
  });

  it("syncTerritory moves the switch WITHOUT calling back — no feedback loop", () => {
    const { toggle, setTerritory, handle } = setup();
    handle.syncTerritory(true);
    expect(toggle.checked).toBe(true);
    expect(setTerritory).not.toHaveBeenCalled();
  });

  it("open() loads the tally and the ledger", async () => {
    const { els, handle, fetchRegional, fetchSchedule } = setup();
    handle.open();
    await settle();
    expect(fetchRegional).toHaveBeenCalledTimes(1);
    expect(fetchSchedule).toHaveBeenCalledTimes(1);
    expect(els.regionalBody.innerHTML).toContain("Duke Swift 🦦");
    expect(els.scheduleBody.innerHTML).toContain("20 pts");
  });

  it("re-opening refetches the tally — that's what '(live)' means", async () => {
    const { handle, fetchRegional } = setup();
    handle.open();
    await settle();
    handle.close();
    handle.open();
    await settle();
    expect(fetchRegional).toHaveBeenCalledTimes(2);
  });

  it("re-opening does NOT refetch the ledger — it's a handful of constants", async () => {
    const { handle, fetchSchedule } = setup();
    handle.open();
    await settle();
    handle.open();
    await settle();
    expect(fetchSchedule).toHaveBeenCalledTimes(1);
  });

  it("a failed tally shows the retry copy, not a blank panel", async () => {
    const { els, handle } = setup({
      fetchRegional: async () => {
        throw new Error("offline");
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    handle.open();
    await settle();
    expect(els.regionalBody.innerHTML).toContain("Couldn't load");
    err.mockRestore();
  });

  it("close() abandons an in-flight load rather than painting it late", async () => {
    let release: (v: LeaderboardRegionalResponse) => void = () => {};
    const { els, handle } = setup({
      fetchRegional: () =>
        new Promise<LeaderboardRegionalResponse>((r) => {
          release = r;
        }),
    });
    handle.open();
    handle.close();
    release(TALLY);
    await settle();
    expect(els.regionalBody.innerHTML).not.toContain("Duke Swift 🦦");
  });
});
