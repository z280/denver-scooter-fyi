// Screen 3 — "Where to?" (frontend plan, `ride-screen-dest.ts` row; master
// Part 0 Screen 3). Shown IFF `RideOptions.navigation` is on. Centered title
// ("Where to?" — free, via `.ride-modal__title`'s own `text-align: center`,
// nothing this screen needs to do), a wide text bar at the top; as the rider
// types, suggested addresses appear (debounced + abort-safe + cached through
// `geocode-search.ts`, biased with the resolved GPS fix); tapping an address
// selects it and advances to Screen 4.
//
// `in_coverage=false` results render GREYED, not hidden — selecting one still
// works (master: "an out-of-coverage destination degrades gracefully: nav
// off, ride proceeds"). That degrade itself happens downstream, in
// `ride-screen-routes.ts` (Screen 4), off the routing call's own
// `out_of_coverage` error — this screen's only job is to pass the picked
// destination through, carrying the flag along for Screen 4's UI hint.
//
// ---------------------------------------------------------------------------
// RESOLVED — `RideSessionDest` now declares `inCoverage` too.
//
// This lane originally shipped `RideDestWithCoverage` below as a local,
// purely-additive EXTENSION of `RideSessionDest` (`ride-session.ts`'s own
// `{ label, lat, lon }` had no coverage flag, and this lane's file ownership
// didn't include it), constructed via `fromResult`/`fromRecent` rather than
// an inline object literal so the extra field could ride along on the actual
// runtime object without an excess-property error. `ride-session.ts` has
// since landed the exact additive diff proposed here (`inCoverage?: boolean`
// on `RideSessionDest` + a `parseDest` line), so the persisted round-trip
// through `parseRideSession` now preserves it too — a reload mid-Screen-4
// keeps the greyed-route hint instead of silently dropping it. This module's
// `RideDestWithCoverage` alias is kept as-is (identical shape now, just
// documenting this screen's own contract) rather than removed, so nothing
// here needed to change.
// ---------------------------------------------------------------------------

import {
  registerRideScreen,
  type RideScreen,
  type RideScreenContext,
} from "./ride-modal.ts";
import type { LngLat, Locate } from "./locate.ts";
import { markUndoFree } from "./ios-shake-undo.ts";
import type { GeocodeKind, GeocodeResult } from "./api.ts";
import type { RideSessionDest, RideSessionStore } from "./ride-session.ts";
import { track } from "./telemetry.ts";
import {
  createGeocodeSearch,
  type GeocodeSearchClient,
  type GeocodeSearchHandlers,
} from "./geocode-search.ts";

// ---------------------------------------------------------------------------
// `RideSessionDest` + the geocode coverage flag — see the DEVIATION note above.
// ---------------------------------------------------------------------------

export interface RideDestWithCoverage extends RideSessionDest {
  inCoverage?: boolean;
}

// ---------------------------------------------------------------------------
// Recent destinations — `localStorage "scooter-fyi-recent-dests"`, max 5,
// most-recent-first, deduped by label. UI-pref key (hyphenated convention);
// every read/write try/catch wrapped (private-mode degradation).
// ---------------------------------------------------------------------------

export const RECENT_DESTS_KEY = "scooter-fyi-recent-dests";
export const MAX_RECENT_DESTS = 5;

export interface RecentDest {
  label: string;
  lat: number;
  lon: number;
  inCoverage: boolean;
}

interface StoredRecentDests {
  v: 1;
  dests: RecentDest[];
}

function isValidRecentDest(d: unknown): d is RecentDest {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return (
    typeof r.label === "string" &&
    r.label.trim().length > 0 &&
    typeof r.lat === "number" &&
    Number.isFinite(r.lat) &&
    typeof r.lon === "number" &&
    Number.isFinite(r.lon) &&
    typeof r.inCoverage === "boolean"
  );
}

/** A hand-edited or version-skewed blob degrades to "no recents" rather than
 *  throwing or applying garbage — same discipline as `filter-presets.ts`. */
export function loadRecentDests(): RecentDest[] {
  try {
    const raw = localStorage.getItem(RECENT_DESTS_KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as StoredRecentDests;
    if (blob?.v !== 1 || !Array.isArray(blob.dests)) return [];
    return blob.dests.filter(isValidRecentDest).slice(0, MAX_RECENT_DESTS);
  } catch {
    return [];
  }
}

function persistRecentDests(dests: RecentDest[]): boolean {
  try {
    const blob: StoredRecentDests = { v: 1, dests };
    localStorage.setItem(RECENT_DESTS_KEY, JSON.stringify(blob));
    return true;
  } catch {
    return false; // private mode — the pick still works this visit
  }
}

/** Pure list logic — most-recent-first, deduped by label (case-insensitive:
 *  Photon can format-vary the same address across two searches), capped at
 *  `MAX_RECENT_DESTS`. Exported so ordering/dedupe/cap are unit-testable
 *  without touching `localStorage`. */
export function pushRecentDest(
  existing: readonly RecentDest[],
  dest: RecentDest,
): RecentDest[] {
  const deduped = existing.filter(
    (d) => d.label.toLowerCase() !== dest.label.toLowerCase(),
  );
  return [dest, ...deduped].slice(0, MAX_RECENT_DESTS);
}

/** Record a pick and persist it. Returns the new list so the caller can
 *  re-render without a second `loadRecentDests()` round trip. */
export function recordRecentDest(dest: RecentDest): RecentDest[] {
  const next = pushRecentDest(loadRecentDests(), dest);
  persistRecentDests(next);
  return next;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type SessionLike = Pick<RideSessionStore, "current" | "dispatch">;

/** Read-only: this screen only ever reads the resolved fix to bias the
 *  search — GPS enablement is Screen 1's job. */
export type LocateLike = Pick<Locate, "current">;

export interface RideScreenDestDeps {
  session: SessionLike;
  locate: LocateLike;
  /** Injected for tests; defaults to wrapping `createGeocodeSearch` from
   *  `geocode-search.ts`. That module's OWN debounce/abort/cache machinery
   *  has its own dedicated test file — a test here can fake the client
   *  wholesale and just assert on what this screen does with its callbacks. */
  createSearch?(handlers: GeocodeSearchHandlers): GeocodeSearchClient;
}

function defaultCreateSearch(handlers: GeocodeSearchHandlers): GeocodeSearchClient {
  return createGeocodeSearch(handlers);
}

/** Register Screen 3. Call once at startup; returns an unregister function
 *  for tests/HMR. */
export function wireRideScreenDest(deps: RideScreenDestDeps): () => void {
  return registerRideScreen("3", {
    // Master Part 0: "shown IF navigation on." No session doc (shouldn't
    // happen mid-wizard, but a throwing/missing read must not strand the
    // rider on a screen with nothing to search against) also skips.
    skip: () => !(deps.session.current()?.options.navigation ?? false),
    factory: (ctx) => buildDestScreen(ctx, deps),
  });
}

// ---------------------------------------------------------------------------
// Screen build
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<GeocodeKind, string> = {
  house: "Address",
  street: "Street",
  poi: "Place",
  locality: "Area",
};

function fromResult(r: GeocodeResult): RideDestWithCoverage {
  return { label: r.label, lat: r.lat, lon: r.lon, inCoverage: r.in_coverage };
}

function fromRecent(r: RecentDest): RideDestWithCoverage {
  return { label: r.label, lat: r.lat, lon: r.lon, inCoverage: r.inCoverage };
}

type SearchStatus = "idle" | "searching" | "error";

function buildDestScreen(
  ctx: RideScreenContext,
  deps: RideScreenDestDeps,
): RideScreen {
  let destroyed = false;
  let recents = loadRecentDests();
  let results: GeocodeResult[] = [];
  let status: SearchStatus = "idle";
  /** The trimmed text the live `results`/`status` belong to — guards a
   *  callback that resolves after this screen already asked for something
   *  else. Belt-and-suspenders: `geocode-search.ts`'s own abort already
   *  prevents a superseded response from calling back at all; this also
   *  covers a same-tick edge the abort path can't (a cache hit resolving
   *  synchronously for a query event the input has already moved past). */
  let liveQuery = "";

  const input = el("input", "select ride-screen-dest__input") as HTMLInputElement;
  input.type = "search";
  input.placeholder = "Search for an address in Denver…";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Destination address");
  // Longest bout of typing anywhere in the wizard, and it happens moments
  // before the rider starts rolling — exactly the undo entries that would
  // haunt the HUD. Autocorrect is already off here, so nothing is lost by
  // applying the edits ourselves (ios-shake-undo.ts).
  markUndoFree(input);

  const statusEl = el("p", "ride-modal__hint");
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  statusEl.hidden = true;

  const listEl = el("ol", "ride-options ride-screen-dest__list");

  const root = el("div", "ride-wizard__body ride-screen-dest");
  root.append(
    el("h3", "ride-modal__lede", "Where to?"),
    input,
    statusEl,
    listEl,
  );

  // Picking a destination advances by itself, so the header Next only has
  // work to do when the session ALREADY carries one (the rider came back to
  // change their mind and didn't) — otherwise the required information is
  // missing and it stays disabled.
  ctx.setNextEnabled((deps.session.current()?.dest ?? null) !== null);

  const search = (deps.createSearch ?? defaultCreateSearch)({
    onResults: (r, q) => {
      if (destroyed || q !== liveQuery) return;
      results = r;
      status = "idle";
      render();
    },
    onError: (_err, q) => {
      if (destroyed || q !== liveQuery) return;
      results = [];
      status = "error";
      render();
    },
  });
  ctx.onCleanup(() => search.dispose());

  function isEmpty(): boolean {
    return input.value.trim() === "";
  }

  function selectDest(dest: RideDestWithCoverage): void {
    if (destroyed) return;
    track("geocode_search", { outcome: "picked" });
    deps.session.dispatch({ type: "setDest", dest });
    recents = recordRecentDest({
      label: dest.label,
      lat: dest.lat,
      lon: dest.lon,
      inCoverage: dest.inCoverage ?? true,
    });
    ctx.next();
  }

  function renderRow(
    label: string,
    meta: string | null,
    outOfCoverage: boolean,
    onClick: () => void,
  ): HTMLElement {
    const li = el("li");
    const row = el("button", "ride-option");
    row.type = "button";
    row.classList.toggle("is-out-of-coverage", outOfCoverage);
    row.append(el("div", "ride-option__title", label));
    if (outOfCoverage) {
      row.append(
        el(
          "div",
          "ride-option__desc",
          "Outside our navigation coverage — you can still pick it, but you'll ride without turn-by-turn.",
        ),
      );
    } else if (meta) {
      row.append(el("div", "ride-option__desc", meta));
    }
    row.addEventListener("click", () => onClick());
    li.append(row);
    return li;
  }

  function render(): void {
    listEl.replaceChildren();
    statusEl.hidden = true;

    if (isEmpty()) {
      if (recents.length === 0) return;
      listEl.append(
        el("li", "ride-screen-dest__section", "Recent destinations"),
      );
      for (const r of recents) {
        listEl.append(
          renderRow(r.label, null, !r.inCoverage, () => selectDest(fromRecent(r))),
        );
      }
      return;
    }

    if (status === "searching") {
      statusEl.hidden = false;
      statusEl.textContent = "Searching…";
      return;
    }
    if (status === "error") {
      statusEl.hidden = false;
      statusEl.textContent =
        "Couldn't load suggestions right now — try again in a moment, or pick a recent destination.";
      return;
    }
    if (results.length === 0) {
      track("geocode_search", { outcome: "no_results" });
      statusEl.hidden = false;
      statusEl.textContent = "No matches yet — keep typing, or try a nearby cross street.";
      return;
    }
    for (const r of results) {
      listEl.append(
        renderRow(r.label, KIND_LABEL[r.kind], !r.in_coverage, () =>
          selectDest(fromResult(r)),
        ),
      );
    }
  }
  render();

  input.addEventListener("input", () => {
    const raw = input.value;
    const trimmed = raw.trim();
    if (!trimmed) {
      liveQuery = "";
      status = "idle";
      results = [];
      search.cancel();
      render();
      return;
    }
    liveQuery = trimmed;
    status = "searching";
    render();
    const fix: LngLat | null = deps.locate.current();
    search.query(raw, fix ? { lat: fix.lat, lon: fix.lng } : undefined);
  });

  return {
    title: "Where to?",
    primary: root,
    // ride-modal.ts's own focus-on-mount comment names this screen's search
    // bar as the intended exception to "skip text-entry fields on mount".
    initialFocus: input,
    destroy() {
      destroyed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
