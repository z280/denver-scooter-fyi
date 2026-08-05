// 🏆 Territory control — the pure half of the leaderboard: the
// `/leaderboard/map` payload → GeoJSON transform, and the per-cell detail
// panel's content.
//
// This module used to own a whole map view of its own, opened from a 🏆
// topbar button, which hid every device and paused hex density and the
// region choropleth so its fills had the map to themselves. That view is
// gone. Territory control is now one more entry in the Areas drawer's
// "Shade by" list (`hexdensity.ts`'s `territory_control` metric), which
// means it composes with the rest of the map the same way every other hex
// metric does — nothing to pause, nothing to hide, one fill layer instead
// of two. The 🏆 lives in the main menu now (`leaderboard-panel.ts`) and
// opens a panel of rankings, not a map mode.
//
// What's left here is deliberately map-free and DOM-free so it stays
// unit-testable without a MapLibre instance: `hexdensity.ts` calls
// `leaderboardMapToFeatureCollection` to paint, and calls
// `buildLeaderboardDetailHtml` when a triple-click asks a cell who holds
// it.

import type {
  LeaderboardCell,
  LeaderboardEntry,
  LeaderboardMapResponse,
} from "./api.ts";
import { commas } from "./util.ts";
import { cellToBoundary, isValidCell } from "h3-js";

// ---------------------------------------------------------------------------
// Payload → FeatureCollection transform.
// ---------------------------------------------------------------------------

/** Neutral defaults are a FRONTEND decision — the API sends null colors on
 *  an unclaimed cell or an un-colored leader; it never invents a default. */
export const LEADERBOARD_NEUTRAL_COLOR = "#8a8f98";

/** THE fill opacity for every claimed territory hexagon, everywhere.
 *
 *  Riders used to set this themselves, per account, through a slider next
 *  to their ruling colors (`ruling_alpha`, still on the wire). That made
 *  the map's legibility a per-rider setting: one territory at 0.10 and its
 *  neighbor at 1.00 read as "empty" versus "solid" rather than as two
 *  claims of equal weight, and a rider could make their own hexes shout by
 *  turning theirs up. A single constant is the fix — the shade of a cell
 *  now says who holds it and nothing else. The slider is gone from the
 *  profile and `ruling_alpha` is not read anywhere in this app. */
export const TERRITORY_FILL_OPACITY = 0.55;

const NO_LEADER_LINE_OPACITY = 0.15;
/** A cell whose leader hasn't claimed a color pair. Not a user setting —
 *  a distinct state, drawn as a ghost of a claim so it reads as "held, but
 *  uncolored" rather than as a dimmer version of someone's territory. */
const UNCLAIMED_FILL_OPACITY = 0.22;
/** The border always renders opaque, regardless of the fill. */
const OPAQUE = 1;

export interface LeaderboardCellProperties {
  cell: string;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineOpacity: number;
  hasLeader: boolean;
}

export type LeaderboardFeature = GeoJSON.Feature<
  GeoJSON.Polygon,
  LeaderboardCellProperties
>;

function cellPaint(
  cell: LeaderboardCell,
): Omit<LeaderboardCellProperties, "cell"> {
  const leader = cell.leader;
  if (!leader) {
    return {
      hasLeader: false,
      fillColor: LEADERBOARD_NEUTRAL_COLOR,
      fillOpacity: 0,
      lineColor: LEADERBOARD_NEUTRAL_COLOR,
      lineOpacity: NO_LEADER_LINE_OPACITY,
    };
  }
  if (!leader.ruling_color || !leader.ruling_border_color) {
    return {
      hasLeader: true,
      fillColor: LEADERBOARD_NEUTRAL_COLOR,
      fillOpacity: UNCLAIMED_FILL_OPACITY,
      lineColor: LEADERBOARD_NEUTRAL_COLOR,
      lineOpacity: OPAQUE,
    };
  }
  return {
    hasLeader: true,
    fillColor: leader.ruling_color,
    // Not `leader.ruling_alpha` — see TERRITORY_FILL_OPACITY.
    fillOpacity: TERRITORY_FILL_OPACITY,
    lineColor: leader.ruling_border_color,
    lineOpacity: OPAQUE,
  };
}

/** h3-js returns `[lat, lng]`; flip to GeoJSON `[lng, lat]` and close the
 *  ring — the same pattern as `hexdensity.ts` (~line 247). UNLIKE
 *  `hexdensity.ts`'s `ring()`, this does NOT run cell ids through
 *  `util.ts`'s `h3ToHex` decimal-id shim: the leaderboard payload's cell
 *  keys are already canonical h3 strings (server-side `h3.int_to_str`), so
 *  that shim does not apply here. */
function ringFor(cellId: string): GeoJSON.Position[] | null {
  // h3-js's cellToBoundary does NOT validate its input — fed a malformed
  // string it silently returns a nonsense boundary rather than throwing, so
  // isValidCell() is the actual guard; the try/catch below is defense in
  // depth for whatever it doesn't catch.
  if (!isValidCell(cellId)) return null;
  try {
    const boundary = cellToBoundary(cellId);
    const ring = boundary.map(([lat, lng]) => [lng, lat] as GeoJSON.Position);
    if (ring.length > 0) ring.push(ring[0]);
    if (ring.length < 4) return null;
    return ring;
  } catch {
    return null;
  }
}

/** Build one GeoJSON FeatureCollection from the whole `/leaderboard/map`
 *  payload. Pure — no map/DOM — so paint stays entirely data-driven
 *  (`["get", "fillColor"]` etc.) and the transform is unit-testable without
 *  a MapLibre instance. A cell whose id doesn't decode to a valid boundary
 *  (malformed/unknown h3 string) is skipped rather than throwing, matching
 *  `hexdensity.ts`'s own defensiveness. */
export function leaderboardMapToFeatureCollection(
  resp: LeaderboardMapResponse,
): GeoJSON.FeatureCollection<GeoJSON.Polygon, LeaderboardCellProperties> {
  const features: LeaderboardFeature[] = [];
  for (const [cellId, cell] of Object.entries(resp.cells)) {
    const ring = ringFor(cellId);
    if (!ring) continue;
    features.push({
      type: "Feature",
      id: cellId,
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { cell: cellId, ...cellPaint(cell) },
    });
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Cell detail panel — pure content generation (no DOM), fed entirely from
// the already-fetched payload. `openFloatingModal`'s `bodyHtml` contract is
// caller-escaped innerHTML, so every interpolated payload string is escaped.
// ---------------------------------------------------------------------------

export const LEADERBOARD_DETAIL_TITLE = "🏆 Territory rankings";

/** HTML-escape a value for safe interpolation into the detail panel's
 *  `bodyHtml`. Duplicated from devices.ts's module-private helper (same
 *  behavior) rather than exported — a 6-line pure function isn't worth a
 *  second shared-file touchpoint on top of `openFloatingModal`. */
export function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

/** #rrggbb + alpha → rgba() string, so a swatch previews the same fill the
 *  map paints. */
export function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function formatWindowDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** The rider's colors as a small square — the same fill the map paints for
 *  their territory, so the swatch and the hexagons agree by construction. */
export function leaderSwatchHtml(entry: LeaderboardEntry): string {
  if (!entry.ruling_color) return "";
  const border = entry.ruling_border_color ?? entry.ruling_color;
  const bg = hexWithAlpha(entry.ruling_color, TERRITORY_FILL_OPACITY);
  return `<span class="leaderboard-detail__swatch" style="background:${escapeHtml(bg)};border-color:${escapeHtml(border)}"></span>`;
}

export interface LeaderboardDetailInput {
  cellId: string;
  /** null when the clicked cell id has no matching payload entry — a
   *  defensive case (rendered features always come from `resp.cells`, so
   *  this shouldn't happen); treated identically to a genuinely unclaimed
   *  cell (`cell.leader === null`). */
  cell: LeaderboardCell | null;
  windowStart: string;
  windowEnd: string;
  /** Gates the "claim your colors" hint — shown only when signed in. */
  signedIn: boolean;
}

/** Build the detail panel's `bodyHtml` — the three fixture cases the test
 *  suite exercises are: a claimed cell (leader + runners-up + totals), an
 *  unclaimed cell (`leader: null`), and a leader with unclaimed colors
 *  (`ruling_color: null`, folded into the leader-section render).
 *
 *  The cell id is shown here for the same reason the non-territory hex
 *  inspector shows one: a triple-click is a "tell me exactly what this
 *  hexagon is" gesture, and the H3 id is the only stable name it has. */
export function buildLeaderboardDetailHtml(
  input: LeaderboardDetailInput,
): string {
  const { cellId, cell, windowStart, windowEnd, signedIn } = input;
  const windowLine = `Window: ${escapeHtml(formatWindowDate(windowStart))} – ${escapeHtml(formatWindowDate(windowEnd))}`;
  const cellLine = `<p class="hex-inspect__cell">H3 cell <code>${escapeHtml(cellId)}</code></p>`;

  if (!cell || !cell.leader) {
    const hint = signedIn
      ? `<p class="leaderboard-detail__hint">Set your ruling colors in your profile to claim this territory. <button type="button" class="text-btn" data-action="open-profile">Open profile</button></p>`
      : "";
    return [
      `<div class="leaderboard-detail">`,
      `<p class="leaderboard-detail__empty">🏳️ Unclaimed territory</p>`,
      hint,
      cellLine,
      `<p class="leaderboard-detail__totals">${windowLine}</p>`,
      `</div>`,
    ].join("");
  }

  const leader = cell.leader;
  const leaderHtml = [
    `<div class="leaderboard-detail__leader">`,
    leaderSwatchHtml(leader),
    `<div>`,
    `<div class="leaderboard-detail__leader-name">${escapeHtml(leader.display_name)}</div>`,
    `<div class="leaderboard-detail__leader-points">${commas(leader.points)} pts</div>`,
    `</div>`,
    `</div>`,
  ].join("");

  const runnerRows = cell.runners_up
    .map(
      (r) =>
        `<div class="leaderboard-detail__runner"><span>${escapeHtml(r.display_name)}</span><span>${commas(r.points)} pts</span></div>`,
    )
    .join("");
  const runnersHtml = runnerRows
    ? `<div class="leaderboard-detail__runners">${runnerRows}</div>`
    : "";

  return [
    `<div class="leaderboard-detail">`,
    leaderHtml,
    runnersHtml,
    cellLine,
    `<p class="leaderboard-detail__totals">${commas(cell.total_points)} total pts · ${commas(cell.distinct_earners)} distinct earners<br>${windowLine}</p>`,
    `</div>`,
  ].join("");
}
