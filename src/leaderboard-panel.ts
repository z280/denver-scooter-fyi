// 🏆 The Leaderboard panel — the main-menu drawer that replaced the topbar
// trophy button.
//
// The old button toggled a map mode: it blanked every device and took the
// map over with a choropleth. That conflated two things riders actually want
// separately — "shade the map by who holds what" (now the Areas drawer's
// `territory_control` hex metric) and "show me the rankings" (this panel).
// Splitting them means the map keeps working while you read the board, and
// the board keeps working while you look at something else on the map.
//
// The panel owns: the Show Territory Control switch — a second, more
// discoverable entry point to the same hex-metric control, which is why it
// takes a `setTerritory`/`syncTerritory` pair rather than touching the map
// itself — plus three accordions: the live regional tally, an explainer, and
// the points ledger read from the API so the copy cannot promise a number
// the server does not pay.

import {
  fetchLeaderboardRegionalLive,
  fetchPointsSchedule,
  pointsScheduleEntry,
  type LeaderboardRegionalResponse,
  type PointsScheduleResponse,
} from "./api.ts";
import {
  TERRITORY_FILL_OPACITY,
  escapeHtml,
  formatWindowRange,
  hexWithAlpha,
} from "./leaderboard.ts";
import { TRIPLE_CLICK_COUNT } from "./triple-click.ts";
import { commas } from "./util.ts";

// ---------------------------------------------------------------------------
// Live regional tally.
// ---------------------------------------------------------------------------

/** Pure content for the "Total Regional Points (live)" accordion. `resp` is
 *  null before the first load lands and after a failed one; `error` picks
 *  between those two, so a slow network doesn't read as a broken board. */
export function buildRegionalTallyHtml(
  resp: LeaderboardRegionalResponse | null,
  error?: boolean,
): string {
  if (!resp) {
    return error
      ? `<p class="leaderboard-panel__empty">Couldn't load the tally just now — reopen the panel to retry.</p>`
      : `<p class="leaderboard-panel__empty">Loading…</p>`;
  }
  if (resp.leaders.length === 0) {
    return `<p class="leaderboard-panel__empty">No points earned in the window yet. Be first.</p>`;
  }
  const rows = resp.leaders
    .map((entry) => {
      const swatch = entry.ruling_color
        ? `<span class="leaderboard-panel__swatch" style="background:${escapeHtml(
            hexWithAlpha(entry.ruling_color, TERRITORY_FILL_OPACITY),
          )};border-color:${escapeHtml(
            entry.ruling_border_color ?? entry.ruling_color,
          )}"></span>`
        : `<span class="leaderboard-panel__swatch leaderboard-panel__swatch--none"></span>`;
      return [
        `<li class="leaderboard-panel__row">`,
        `<span class="leaderboard-panel__rank">${commas(entry.rank)}</span>`,
        swatch,
        `<span class="leaderboard-panel__name">${escapeHtml(entry.display_name)}</span>`,
        `<span class="leaderboard-panel__points">${commas(entry.points)}</span>`,
        `</li>`,
      ].join("");
    })
    .join("");
  return [
    `<ol class="leaderboard-panel__rows">${rows}</ol>`,
    `<p class="leaderboard-panel__meta">${windowLine(resp)}</p>`,
  ].join("");
}

function windowLine(resp: LeaderboardRegionalResponse): string {
  return escapeHtml(
    `Rolling window: ${formatWindowRange(resp.window_start, resp.window_end)}`,
  );
}

// ---------------------------------------------------------------------------
// Points ledger.
// ---------------------------------------------------------------------------

/** Rider-facing names for the ledger's action keys, grouped the way someone
 *  earning them would think about them. The VALUES are never written here —
 *  they come from `/points/schedule`, which exists precisely so this copy
 *  cannot drift from what the server pays. */
const SCHEDULE_GROUPS: { title: string; actions: [string, string][] }[] = [
  {
    title: "Riding",
    actions: [
      ["gbfs_trip_validated", "Complete a validated trip"],
      ["waypoint", "Per ride waypoint uploaded"],
      ["battery_contribution", "Donate battery data on a ride"],
      ["nav_distance_bonus", "Navigation distance bonus"],
      ["nav_route_feedback", "Rate a suggested route"],
      ["nav_qualitative_feedback", "Tell us why a route worked (or didn't)"],
      ["ride_survey", "Finish the end-of-ride survey"],
    ],
  },
  {
    title: "Reporting a device",
    actions: [
      ["report_not_rideable", "Report a device that won't ride"],
      ["report_vehicle_issue", "Report a vehicle issue"],
      ["report_improper_parking", "Report improper parking"],
      ["report_not_found", "Report a device that isn't there"],
    ],
  },
  {
    title: "Adding to the map",
    actions: [
      ["device_photo", "Add a device photo"],
      ["device_features_first", "Be first to confirm a device's features"],
      ["device_features_review", "Review features flagged for a second look"],
      ["device_features_reconfirm", "Re-confirm features already up to date"],
    ],
  },
  {
    title: "Your account",
    actions: [["profile_completion", "Complete your profile"]],
  },
];

/** Actions deliberately NOT listed, even if the API publishes them.
 *  `qr_scan` never shipped client-side — advertising 100 pts for a flow
 *  that doesn't exist is a promise nobody can collect on. Suppressed here
 *  (not just unnamed) because the humanized "More" pass below would
 *  otherwise resurrect it straight from the server's schedule. */
const HIDDEN_ACTIONS = new Set(["qr_scan"]);

/** Every action this module names, for the "did the API send something we
 *  don't know about" pass below. */
const KNOWN_ACTIONS = new Set(
  SCHEDULE_GROUPS.flatMap((g) => g.actions.map(([action]) => action)),
);

/** `gbfs_trip_validated` → "Gbfs trip validated". Only ever used for an
 *  action this build has never heard of — the API's schedule is the source
 *  of truth for what exists, so a new award shows up in this list the day it
 *  ships rather than the day the frontend is next touched. */
export function humanizeAction(action: string): string {
  const spaced = action.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One award's value, in the two shapes the schedule uses: a flat award, or
 *  `base + per_step` per started `step_km`. Returns null when the API didn't
 *  publish the action at all, so the row can be dropped rather than rendered
 *  as an empty promise. */
export function formatScheduleValue(
  schedule: PointsScheduleResponse | null,
  action: string,
): string | null {
  const entry = pointsScheduleEntry(schedule, action);
  if (!entry) return null;
  if (typeof entry.points === "number") return `${commas(entry.points)} pts`;
  if (typeof entry.per_step === "number" && typeof entry.step_km === "number") {
    const base = entry.base ?? 0;
    const per = `${commas(entry.per_step)} pts per ${entry.step_km} km`;
    return base > 0 ? `${commas(base)} pts + ${per}` : per;
  }
  return null;
}

/** Pure content for the "Earning Points" accordion. */
export function buildPointsScheduleHtml(
  schedule: PointsScheduleResponse | null,
  error?: boolean,
): string {
  if (!schedule) {
    return error
      ? `<p class="leaderboard-panel__empty">Couldn't load the points ledger just now — reopen the panel to retry.</p>`
      : `<p class="leaderboard-panel__empty">Loading…</p>`;
  }

  const sections: string[] = [];
  for (const group of SCHEDULE_GROUPS) {
    const rows = group.actions
      .map(([action, label]) => {
        const value = formatScheduleValue(schedule, action);
        return value === null
          ? ""
          : `<div class="ledger__row"><span>${escapeHtml(label)}</span><span class="ledger__pts">${escapeHtml(value)}</span></div>`;
      })
      .join("");
    if (!rows) continue;
    sections.push(
      `<div class="ledger__group"><h4 class="ledger__title">${escapeHtml(group.title)}</h4>${rows}</div>`,
    );
  }

  // Anything the API publishes that this build has no copy for. Rendering it
  // humanized beats hiding an award riders can actually earn.
  const extraRows = Object.keys(schedule)
    .filter((action) => !KNOWN_ACTIONS.has(action) && !HIDDEN_ACTIONS.has(action))
    .sort()
    .map((action) => {
      const value = formatScheduleValue(schedule, action);
      return value === null
        ? ""
        : `<div class="ledger__row"><span>${escapeHtml(humanizeAction(action))}</span><span class="ledger__pts">${escapeHtml(value)}</span></div>`;
    })
    .join("");
  if (extraRows) {
    sections.push(
      `<div class="ledger__group"><h4 class="ledger__title">More</h4>${extraRows}</div>`,
    );
  }

  if (sections.length === 0) {
    return `<p class="leaderboard-panel__empty">The points ledger is empty right now.</p>`;
  }
  return `<div class="ledger">${sections.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Explainer.
// ---------------------------------------------------------------------------

/** The "What's this?" copy. A function rather than a constant so the one
 *  number in it — how many clicks a triple is — is read from
 *  `triple-click.ts` instead of typed twice. */
export function buildAboutHtml(): string {
  return [
    `<div class="leaderboard-about">`,
    `<p>Every action you take on the map earns points, and every point is stamped with where you earned it. Those two facts are the whole leaderboard.</p>`,
    `<p><strong>Territory control</strong> divides the city into hexagons and colors each one with the ruling colors of whoever has earned the most points inside it over the last 28 days. Turn it on above, or pick it under <em>Shade by</em> in the Areas menu — it's the same control. ${escapeHtml(String(TRIPLE_CLICK_COUNT))} quick clicks on a hexagon show who holds it and who's closing in.</p>`,
    `<p><strong>Total Regional Points</strong> ranks riders across the whole city rather than hexagon by hexagon.</p>`,
    `<p>Both are <strong>live</strong>. Points you earn count the moment they land — a hexagon can change hands while you're looking at it, and the board moves without waiting for an overnight tally.</p>`,
    `<p>It's a rolling 28-day window, so territory has to be defended — an area you led last month goes back up for grabs as those points age out.</p>`,
    `<p>To claim colors of your own, open your profile and pick a fill and border pair under Community. Every pair is exclusive: once it's yours, nobody else can take it. Until you pick, your hexagons render grey.</p>`,
    `<p>You can leave the boards entirely from your profile's privacy settings — turn off "show in leaderboards" and your points stop appearing here and on the map. They keep counting for you; they just stop being public.</p>`,
    `</div>`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Wiring.
// ---------------------------------------------------------------------------

export interface LeaderboardPanelElements {
  /** The Show Territory Control switch. */
  toggle: HTMLInputElement;
  regionalBody: HTMLElement;
  aboutBody: HTMLElement;
  scheduleBody: HTMLElement;
}

export interface LeaderboardPanelDeps {
  /** Turn the map's territory-control shading on or off. Owned by `main.ts`
   *  (it owns the hex-density controls); this panel only asks. */
  setTerritory(on: boolean): void;
  /** Defaults to the real endpoints; injectable for tests. */
  fetchRegional?: (
    signal?: AbortSignal,
  ) => Promise<LeaderboardRegionalResponse>;
  fetchSchedule?: (signal?: AbortSignal) => Promise<PointsScheduleResponse>;
}

export interface LeaderboardPanelHandle {
  /** Call when the drawer becomes visible: refreshes the live tally (that's
   *  what "live" has to mean) and loads the ledger once. */
  open(): void;
  /** Call when the drawer is hidden — drops any in-flight fetch. */
  close(): void;
  /** Reflect the map's actual territory state back into the switch, so
   *  changing "Shade by" in the Areas menu moves this toggle too. Does NOT
   *  call back into `setTerritory` — that would loop. */
  syncTerritory(on: boolean): void;
}

export function wireLeaderboardPanel(
  els: LeaderboardPanelElements,
  deps: LeaderboardPanelDeps,
): LeaderboardPanelHandle {
  let controller: AbortController | null = null;
  let schedule: PointsScheduleResponse | null = null;
  /** Guards `syncTerritory` from being read as a user toggle. */
  let syncing = false;

  els.aboutBody.innerHTML = buildAboutHtml();
  els.regionalBody.innerHTML = buildRegionalTallyHtml(null);
  els.scheduleBody.innerHTML = buildPointsScheduleHtml(null);

  els.toggle.addEventListener("change", () => {
    if (syncing) return;
    deps.setTerritory(els.toggle.checked);
  });

  const loadRegional = (signal: AbortSignal): void => {
    const fetchRegional = deps.fetchRegional ?? fetchLeaderboardRegionalLive;
    fetchRegional(signal)
      .then((resp) => {
        if (signal.aborted) return;
        els.regionalBody.innerHTML = buildRegionalTallyHtml(resp);
      })
      .catch((e: unknown) => {
        if (signal.aborted || (e as Error).name === "AbortError") return;
        console.error("live regional leaderboard fetch failed", e);
        els.regionalBody.innerHTML = buildRegionalTallyHtml(null, true);
      });
  };

  const loadSchedule = (signal: AbortSignal): void => {
    // The schedule is a handful of constants behind an hour of CDN cache —
    // load it once per page, not once per open.
    if (schedule) return;
    const fetchSchedule = deps.fetchSchedule ?? fetchPointsSchedule;
    fetchSchedule(signal)
      .then((resp) => {
        if (signal.aborted) return;
        schedule = resp;
        els.scheduleBody.innerHTML = buildPointsScheduleHtml(resp);
      })
      .catch((e: unknown) => {
        if (signal.aborted || (e as Error).name === "AbortError") return;
        console.error("points schedule fetch failed", e);
        els.scheduleBody.innerHTML = buildPointsScheduleHtml(null, true);
      });
  };

  return {
    open(): void {
      controller?.abort();
      controller = new AbortController();
      els.regionalBody.innerHTML = buildRegionalTallyHtml(null);
      loadRegional(controller.signal);
      loadSchedule(controller.signal);
    },
    close(): void {
      controller?.abort();
      controller = null;
    },
    syncTerritory(on: boolean): void {
      if (els.toggle.checked === on) return;
      syncing = true;
      els.toggle.checked = on;
      syncing = false;
    },
  };
}
