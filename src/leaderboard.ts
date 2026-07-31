// 🏆 Leaderboard view (frontend plan `docs/PLAN_RIDE_MODE_FRONTEND.md`,
// "Leaderboard view" section; master plan Part 0's "owner addition, rough
// bang out" and §1.2 Decision 5). A choropleth of H3 r8 cells colored by
// each cell's leading account's ruling colors, opened from a 🏆 topbar
// button left of the profile button. Zero devices while open (via
// `devices.ts`'s `setLeaderboardActive`); click a cell for a detail panel
// built from the SAME `/leaderboard/map` fetch (leader + runners_up +
// totals — no second request). Rough-cut scope, owner-approved — see the
// frontend plan's "Independence" bullet: this module touches no
// ride-session/track/wizard code, and its only API dependency is A4.
//
// House pattern: a small injected-`deps` seam (mirrors `ride-screen-dest.ts`)
// rather than importing `main.ts` state directly, so `open()`/`close()`'s
// side effects (hiding devices, closing popups, pausing hex density/the
// region choropleth) are unit-testable without a real MapLibre map.

import maplibregl, {
  type Map as MLMap,
  type GeoJSONSource,
} from "maplibre-gl";
import {
  fetchLeaderboardMap,
  type LeaderboardCell,
  type LeaderboardEntry,
  type LeaderboardMapResponse,
} from "./api.ts";
import { FIRST_DEVICE_LAYER, openFloatingModal } from "./devices.ts";
import { closeAllPopups as defaultCloseAllPopups } from "./chrome.ts";
import { isAuthenticated as defaultIsAuthenticated } from "./map-auth.js";
import { commas, emptyFC } from "./util.ts";
import { cellToBoundary, isValidCell } from "h3-js";

// ---------------------------------------------------------------------------
// Generic "pause a live-applying control while the leaderboard is open"
// helper. Hex density and the region choropleth both shade the map by a
// fill, colliding with the leaderboard's own choropleth; `main.ts` already
// keeps the two mutually exclusive with each other, so at most one of these
// two pause instances is ever actually paused-with-a-non-null value. The
// generic form covers both without duplicating the pause/resume/intercept
// bookkeeping (`HexSize | null` for hex density, `BoundaryLayer | null` for
// the region choropleth) — `main.ts` (which owns both controls' DOM and the
// real `apply` calls) instantiates one of these per control; this lane only
// owns the pure state machine.
// ---------------------------------------------------------------------------

/** The narrow shape `LeaderboardView` needs — just enough to pause/resume on
 *  open/close, deliberately blind to what's being paused. */
export interface Pausable {
  pause(): void;
  resume(): void;
}

export interface LayerPauseHooks<T> {
  /** Read whatever the control currently reports as "active" — used to seed
   *  (and, defensively, re-seed at `pause()` time) the stored value, so a
   *  pause/resume with no intervening `recordChange()` is a no-op round trip
   *  even if the control's value moved by some path other than
   *  `recordChange` (e.g. hex density and the choropleth turning each other
   *  off). */
  getActive(): T;
  /** Push a value through to the real layer (`hexDensity.setSize` /
   *  `overlays.setChoropleth`). May be async; the pause controller doesn't
   *  await it — every existing call site already fires and forgets. */
  apply(value: T): void | Promise<void>;
}

export interface LayerPause<T> extends Pausable {
  isPaused(): boolean;
  /** The control's own change handler calls this on every user pick.
   *  Applies immediately when not paused (today's behavior, unchanged);
   *  while paused, only updates the stored value — the layer call is
   *  deferred to `resume()`, so a mid-open pick can't paint hexes under the
   *  leaderboard fills. */
  recordChange(value: T): void;
  /** The value `resume()` would apply right now. Exposed mainly for tests. */
  storedValue(): T;
}

/** Build a pause controller for one live-applying control. `offValue` is
 *  what `pause()` forces the layer to (`null` for both hex density and the
 *  choropleth — their shared "off" representation). */
export function createLayerPause<T>(
  hooks: LayerPauseHooks<T>,
  offValue: T,
): LayerPause<T> {
  let stored = hooks.getActive();
  let paused = false;
  return {
    isPaused: () => paused,
    storedValue: () => stored,
    pause(): void {
      if (paused) return;
      stored = hooks.getActive();
      paused = true;
      void hooks.apply(offValue);
    },
    resume(): void {
      if (!paused) return;
      paused = false;
      void hooks.apply(stored);
    },
    recordChange(value: T): void {
      stored = value;
      if (!paused) void hooks.apply(value);
    },
  };
}

// ---------------------------------------------------------------------------
// Payload → FeatureCollection transform.
// ---------------------------------------------------------------------------

/** Neutral defaults are a FRONTEND decision — the API sends null colors on
 *  an unclaimed cell or an un-colored leader; it never invents a default. */
export const LEADERBOARD_NEUTRAL_COLOR = "#8a8f98";
const NO_LEADER_LINE_OPACITY = 0.15;
const UNCLAIMED_FILL_OPACITY = 0.22;
/** account.ts:794's documented convention: the border always renders
 *  opaque, matching the leaderboard map — regardless of `ruling_alpha`. */
const OPAQUE = 1;
/** account.ts's own fallback when `ruling_alpha` is unexpectedly absent
 *  alongside a present `ruling_color` (the API nulls them together, but a
 *  skewed/partial payload shouldn't render an invisible fill). */
const DEFAULT_RULING_ALPHA = 0.6;

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
    fillOpacity: leader.ruling_alpha ?? DEFAULT_RULING_ALPHA,
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
function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

/** #rrggbb + alpha → rgba() string, matching account.ts's own swatch
 *  preview helper (~line 794) so the detail panel's leader swatch renders
 *  identically to the profile pane's. */
function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function formatWindowDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function leaderSwatchHtml(entry: LeaderboardEntry): string {
  if (!entry.ruling_color) return "";
  const border = entry.ruling_border_color ?? entry.ruling_color;
  const bg = hexWithAlpha(entry.ruling_color, entry.ruling_alpha ?? DEFAULT_RULING_ALPHA);
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
  /** Gates the "claim your colors" hint — shown only when signed in (master
   *  Part 0 / frontend plan: "Empty cell → 'Unclaimed territory' +
   *  (signed-in) a hint pointing at the profile ruling-colors section"). */
  signedIn: boolean;
}

/** Build the detail panel's `bodyHtml` — the three fixture cases the test
 *  suite exercises are: a claimed cell (leader + runners-up + totals), an
 *  unclaimed cell (`leader: null`), and a leader with unclaimed colors
 *  (`ruling_color: null`, folded into the leader-section render). */
export function buildLeaderboardDetailHtml(input: LeaderboardDetailInput): string {
  const { cell, windowStart, windowEnd, signedIn } = input;
  const windowLine = `Window: ${escapeHtml(formatWindowDate(windowStart))} – ${escapeHtml(formatWindowDate(windowEnd))}`;

  if (!cell || !cell.leader) {
    const hint = signedIn
      ? `<p class="leaderboard-detail__hint">Set your ruling colors in your profile to claim this territory. <button type="button" class="text-btn" data-action="open-profile">Open profile</button></p>`
      : "";
    return [
      `<div class="leaderboard-detail">`,
      `<p class="leaderboard-detail__empty">🏳️ Unclaimed territory</p>`,
      hint,
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
    `<p class="leaderboard-detail__totals">${commas(cell.total_points)} total pts · ${commas(cell.distinct_earners)} distinct earners<br>${windowLine}</p>`,
    `</div>`,
  ].join("");
}

// ---------------------------------------------------------------------------
// The view: map layers, fetch, open/close orchestration.
// ---------------------------------------------------------------------------

const SRC = "leaderboard-map";
const FILL = "leaderboard-fill";
const LINE = "leaderboard-line";

export interface LeaderboardDevicesLike {
  setLeaderboardActive(on: boolean): void;
}

export interface LeaderboardDeps {
  devices: LeaderboardDevicesLike;
  /** Defaults to `chrome.ts`'s `closeAllPopups`; injectable for tests. */
  closeAllPopups?: () => void;
  /** Owned by `main.ts` (it owns the hex-density seg control) — see the
   *  frontend plan's Leaderboard section. Absent = nothing to pause (tests,
   *  or a future caller with no hex-density wiring yet). */
  hexDensityPause?: Pausable;
  /** Same, for the region choropleth's `<select>`. */
  choroplethPause?: Pausable;
  /** Defaults to `api.ts`'s `fetchLeaderboardMap`; injectable for tests. */
  fetchMap?: (signal?: AbortSignal) => Promise<LeaderboardMapResponse>;
  /** Defaults to `map-auth.js`'s `isAuthenticated`; injectable for tests. */
  isAuthenticated?: () => boolean;
}

export class LeaderboardView {
  private isOpen_ = false;
  private layersReady = false;
  private fetchController: AbortController | null = null;
  private lastResponse: LeaderboardMapResponse | null = null;

  constructor(
    private readonly map: MLMap,
    private readonly deps: LeaderboardDeps,
    private readonly button: HTMLButtonElement,
    private readonly profileButtonEl: HTMLElement,
  ) {}

  isOpen(): boolean {
    return this.isOpen_;
  }

  toggle(): void {
    if (this.isOpen_) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen_) return;
    this.isOpen_ = true;
    this.button.setAttribute("aria-pressed", "true");
    this.deps.devices.setLeaderboardActive(true);
    (this.deps.closeAllPopups ?? defaultCloseAllPopups)();
    this.deps.hexDensityPause?.pause();
    this.deps.choroplethPause?.pause();
    this.ensureLayers();
    void this.load();
  }

  close(): void {
    if (!this.isOpen_) return;
    this.isOpen_ = false;
    this.button.setAttribute("aria-pressed", "false");
    this.fetchController?.abort();
    this.fetchController = null;
    this.deps.devices.setLeaderboardActive(false);
    this.deps.hexDensityPause?.resume();
    this.deps.choroplethPause?.resume();
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    src?.setData(emptyFC());
    // Close the cell-detail panel too, through its own ✕ so its Escape
    // listener detaches (a bare .remove() would orphan it) — same
    // discipline as chrome.ts's closeAllPopups.
    document
      .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")
      ?.click();
  }

  private ensureLayers(): void {
    if (this.layersReady) return;
    this.layersReady = true;
    this.map.addSource(SRC, { type: "geojson", data: emptyFC() });
    const before = this.map.getLayer(FIRST_DEVICE_LAYER)
      ? FIRST_DEVICE_LAYER
      : undefined;
    this.map.addLayer(
      {
        id: FILL,
        type: "fill",
        source: SRC,
        paint: {
          "fill-color": ["get", "fillColor"],
          "fill-opacity": ["get", "fillOpacity"],
        },
      },
      before,
    );
    this.map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        paint: {
          "line-color": ["get", "lineColor"],
          "line-opacity": ["get", "lineOpacity"],
          "line-width": 1.2,
        },
      },
      before,
    );
    this.map.on("click", FILL, (e) => this.handleClick(e));
    this.map.on("mouseenter", FILL, () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", FILL, () => {
      this.map.getCanvas().style.cursor = "";
    });
  }

  private async load(): Promise<void> {
    this.fetchController?.abort();
    const controller = new AbortController();
    this.fetchController = controller;
    try {
      const fetchMap = this.deps.fetchMap ?? fetchLeaderboardMap;
      const resp = await fetchMap(controller.signal);
      if (this.fetchController !== controller) return; // superseded by a newer open
      this.lastResponse = resp;
      const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
      src?.setData(leaderboardMapToFeatureCollection(resp));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error("leaderboard map fetch failed", e);
    }
  }

  private handleClick(e: maplibregl.MapLayerMouseEvent): void {
    const f = e.features?.[0];
    if (!f || !this.lastResponse) return;
    const cellId = String((f.properties as { cell?: unknown })?.cell ?? "");
    if (!cellId) return;
    const cell = this.lastResponse.cells[cellId] ?? null;
    const signedIn = (this.deps.isAuthenticated ?? defaultIsAuthenticated)();
    const html = buildLeaderboardDetailHtml({
      cellId,
      cell,
      windowStart: this.lastResponse.window_start,
      windowEnd: this.lastResponse.window_end,
      signedIn,
    });
    openFloatingModal(LEADERBOARD_DETAIL_TITLE, html, (root) => {
      root
        ?.querySelector<HTMLButtonElement>('[data-action="open-profile"]')
        ?.addEventListener("click", () => {
          document
            .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")
            ?.click();
          this.profileButtonEl.click();
        });
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export interface LeaderboardHandle {
  toggle(): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

/** Wire the 🏆 topbar button + the choropleth view. Call once from
 *  `main.ts`, after `createMap()` — a plain `insertBefore`, immediately
 *  left of the profile button in `.topbar__right`; NOT the chrome.ts
 *  IControl-adoption pattern (that's for MapLibre controls stuck in the
 *  map's stacking context — the profile button is a plain topbar button,
 *  and the 🏆 is just its sibling). */
export function wireLeaderboard(
  map: MLMap,
  profileButtonEl: HTMLElement,
  deps: LeaderboardDeps,
): LeaderboardHandle {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "topbar__btn leaderboard-toggle";
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", "Leaderboard");
  button.title = "Leaderboard";
  button.textContent = "🏆";
  profileButtonEl.parentElement?.insertBefore(button, profileButtonEl);

  const view = new LeaderboardView(map, deps, button, profileButtonEl);
  button.addEventListener("click", () => view.toggle());

  return {
    toggle: () => view.toggle(),
    open: () => view.open(),
    close: () => view.close(),
    isOpen: () => view.isOpen(),
  };
}
