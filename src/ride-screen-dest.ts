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
import { fetchProfile, type GeocodeKind, type GeocodeResult } from "./api.ts";
import { isAuthenticated } from "./map-auth.js";
import type { HomeWorkPoints } from "./home-work-pins.ts";
import type { RideSessionDest, RideSessionStore } from "./ride-session.ts";
import { track } from "./telemetry.ts";
import {
  createGeocodeSearch,
  type GeocodeSearchClient,
  type GeocodeSearchHandlers,
} from "./geocode-search.ts";
import {
  QUICK_NAMES,
  defaultEmoji,
  forgetFavorite,
  isFavorited,
  isSamePlace,
  loadFavorites,
  recordFavorite,
  type Favorite,
} from "./favorites.ts";

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
  /** The rider's saved home/work locations, for the Saved-places rows above
   *  the recents. Injected for tests; defaults to reading the signed-in
   *  profile, resolving all-null when signed out or the fetch fails — the
   *  suggestions are a bonus, never a reason the screen can't render. */
  getHomeWork?(): Promise<HomeWorkPoints>;
  /** Drop a pin by tapping the map, for destinations that have no address to
   *  type. A friend's meetup spot — the gazebo in City Park — is a real
   *  destination that no geocoder will ever return, and without this the
   *  rider's only options are a nearby address that is not the place, or
   *  giving up on navigation. Optional: when absent the row is simply not
   *  offered, so the screen still works wherever no map is wired (tests, and
   *  any future non-map surface).
   *
   *  Resolves null when the rider cancels; never rejects. */
  pickOnMap?(): Promise<{ lat: number; lng: number } | null>;
}

function defaultCreateSearch(handlers: GeocodeSearchHandlers): GeocodeSearchClient {
  return createGeocodeSearch(handlers);
}

const NO_HOME_WORK: HomeWorkPoints = { home: null, work: null };

/** Same profile→points mapping `account.ts`'s `publishLocations` uses. A
 *  signed-out rider is the common case and not an error — skip the fetch
 *  entirely rather than burning a guaranteed 401. */
async function defaultGetHomeWork(): Promise<HomeWorkPoints> {
  if (!isAuthenticated()) return NO_HOME_WORK;
  try {
    const p = await fetchProfile();
    return {
      home:
        p.home_lat != null && p.home_lng != null
          ? { lat: p.home_lat, lng: p.home_lng }
          : null,
      work:
        p.work_lat != null && p.work_lng != null
          ? { lat: p.work_lat, lng: p.work_lng }
          : null,
    };
  } catch {
    return NO_HOME_WORK;
  }
}

/** Register Screen 3. Call once at startup; returns an unregister function
 *  for tests/HMR. */
export function wireRideScreenDest(deps: RideScreenDestDeps): () => void {
  return registerRideScreen("3", {
    // Master Part 0: "shown IF navigation on." No session doc (shouldn't
    // happen mid-wizard, but a throwing/missing read must not strand the
    // rider on a screen with nothing to search against) also skips.
    skip: () => {
      const doc = deps.session.current();
      if (!(doc?.options.navigation ?? false)) return true;
      // ALREADY ANSWERED. The home bar asks "where are you going?" before
      // anything else, so by the time the wizard opens the destination is on
      // the session. Showing this screen anyway made the rider type it a
      // second time — and, worse, made the app look like it had forgotten.
      // Back still reaches it, which is the right way to change your mind.
      return doc?.dest != null;
    },
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
  /** Saved home/work, all-null until (and unless) the async load lands —
   *  the screen renders immediately either way, and the rows appear on the
   *  re-render when the profile answers. */
  let saved: HomeWorkPoints = { home: null, work: null };
  /** Locally saved places — available immediately and to everyone, unlike the
   *  profile's home/work, which need an account and a round trip. */
  let favorites: Favorite[] = loadFavorites();
  /** The place currently being named, or null. Non-null takes over the list:
   *  naming is a decision, and leaving the search results visible underneath
   *  invites the rider to tap one and lose what they were saving. */
  let naming: { label: string; lat: number; lon: number; emoji: string } | null =
    null;
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

  function selectDest(
    dest: RideDestWithCoverage,
    opts: { record?: boolean } = {},
  ): void {
    if (destroyed) return;
    track("geocode_search", { outcome: "picked" });
    deps.session.dispatch({ type: "setDest", dest });
    // Saved-places picks skip the recents ledger (record: false): Home and
    // Work are already permanent rows on this screen, and echoing them into
    // "Recent destinations" would show the same place twice forever.
    if (opts.record !== false) {
      recents = recordRecentDest({
        label: dest.label,
        lat: dest.lat,
        lon: dest.lon,
        inCoverage: dest.inCoverage ?? true,
      });
    }
    ctx.next();
  }

  /** A trailing control on a row — saving it, or forgetting it. Rendered as a
   *  SIBLING of the row button, never inside it: a button within a button is
   *  invalid markup that browsers resolve by dropping the inner one, and the
   *  row is the bigger tap target of the two. */
  interface RowAction {
    glyph: string;
    title: string;
    onClick: () => void;
  }

  function renderRow(
    label: string,
    meta: string | null,
    outOfCoverage: boolean,
    onClick: () => void,
    action?: RowAction,
  ): HTMLElement {
    const li = el("li", action ? "ride-screen-dest__row" : "");
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
    if (action) {
      const btn = el("button", "ride-screen-dest__action", action.glyph);
      btn.type = "button";
      btn.title = action.title;
      btn.setAttribute("aria-label", action.title);
      btn.addEventListener("click", (e) => {
        // The row underneath would otherwise select the destination and
        // advance the wizard — the rider asked to save it, not to ride to it.
        e.stopPropagation();
        action.onClick();
      });
      li.append(btn);
    }
    return li;
  }

  /** The save affordance for a place that is not saved yet, or nothing at all
   *  when it already is — a star that does nothing is worse than no star. */
  function saveAction(place: {
    label: string;
    lat: number;
    lon: number;
    kind?: GeocodeKind;
  }): RowAction | undefined {
    if (isFavorited(favorites, place)) return undefined;
    return {
      glyph: "☆",
      title: `Save ${place.label}`,
      onClick: () => {
        naming = {
          label: place.label,
          lat: place.lat,
          lon: place.lon,
          emoji: defaultEmoji(place.kind),
        };
        render();
      },
    };
  }

  /** Naming a place, inline. Deliberately NOT a dialog on top of the wizard:
   *  the rider is four screens into a flow that is about to put them on a
   *  scooter, and a second modal over a modal is the point where people back
   *  out. Pre-filled with the address so "just save it" is one tap, and the
   *  two names anybody actually uses are one tap each. */
  function renderNaming(place: NonNullable<typeof naming>): void {
    listEl.append(el("li", "ride-screen-dest__section", "Save this place"));

    const li = el("li", "ride-screen-dest__naming");
    li.append(el("p", "ride-modal__hint", place.label));

    const field = el("input", "select ride-screen-dest__input") as HTMLInputElement;
    field.type = "text";
    field.value = place.label;
    field.setAttribute("aria-label", "Name for this place");
    field.placeholder = "Name this place";
    markUndoFree(field);

    const chips = el("div", "ride-screen-dest__chips");
    for (const quick of QUICK_NAMES) {
      const chip = el("button", "text-btn", `${quick.emoji} ${quick.label}`);
      chip.type = "button";
      chip.addEventListener("click", () => {
        place.emoji = quick.emoji;
        field.value = quick.label;
        field.focus();
      });
      chips.append(chip);
    }

    const save = el("button", "ride-option ride-screen-dest__save", "Save");
    save.type = "button";
    const cancel = el("button", "text-btn", "Cancel");
    cancel.type = "button";

    const commit = (): void => {
      const name = field.value.trim();
      if (!name) {
        field.focus();
        return;
      }
      favorites = recordFavorite({
        emoji: place.emoji,
        label: name,
        lat: place.lat,
        lon: place.lon,
      });
      naming = null;
      // Back to an empty input, where the new favorite is now a row: the
      // rider saved it in order to use it, and making them retype the search
      // to find it again would be absurd.
      input.value = "";
      liveQuery = "";
      results = [];
      status = "idle";
      search.cancel();
      render();
    };

    save.addEventListener("click", commit);
    cancel.addEventListener("click", () => {
      naming = null;
      render();
    });
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });

    li.append(field, chips, el("div", "ride-screen-dest__naming-actions"));
    (li.lastElementChild as HTMLElement).append(save, cancel);
    listEl.append(li);
    field.focus();
    field.select();
  }

  /** Tap the map, then name what you tapped. The two halves are one gesture
   *  from the rider's point of view, so a cancelled pick cancels the whole
   *  thing rather than dropping them into a naming form for nowhere. */
  function startMapPick(): void {
    const pick = deps.pickOnMap;
    if (!pick) return;
    void Promise.resolve()
      .then(() => pick())
      .then((point) => {
        if (destroyed || !point) return;
        naming = {
          label: "Dropped pin",
          lat: point.lat,
          lon: point.lng,
          emoji: "📍",
        };
        render();
      })
      .catch(() => {
        /* a failed pick is a cancelled pick — the screen is unchanged */
      });
  }

  function render(): void {
    listEl.replaceChildren();
    statusEl.hidden = true;

    if (naming) {
      renderNaming(naming);
      return;
    }

    if (isEmpty()) {
      // Saved places first: they are the destinations a rider picks most and
      // types least, so they outrank the recents. The dest label stays the
      // bare name — it is what Screens 4/6 echo back ("to Home") — while the
      // row shows the glyph. Coverage is unknown for a stored coordinate
      // pair; Screen 4 already degrades gracefully off the routing call's own
      // out_of_coverage error, so no flag here.
      const savedRows: {
        display: string;
        dest: RideDestWithCoverage;
        action?: RowAction;
      }[] = [];
      // The profile's home/work come first and keep their fixed glyphs.
      // Anything the rider ALSO saved locally at the same spot is dropped
      // rather than shown twice: one doorstep, one row.
      if (saved.home) {
        savedRows.push({
          display: "🏠 Home",
          dest: { label: "Home", lat: saved.home.lat, lon: saved.home.lng },
        });
      }
      if (saved.work) {
        savedRows.push({
          display: "💼 Work",
          dest: { label: "Work", lat: saved.work.lat, lon: saved.work.lng },
        });
      }
      for (const f of favorites) {
        if (savedRows.some((s) => isSamePlace(s.dest, f))) continue;
        savedRows.push({
          display: `${f.emoji} ${f.label}`.trim(),
          dest: { label: f.label, lat: f.lat, lon: f.lon },
          action: {
            glyph: "✕",
            title: `Forget ${f.label}`,
            onClick: () => {
              favorites = forgetFavorite(f.id);
              render();
            },
          },
        });
      }
      if (savedRows.length > 0 || deps.pickOnMap) {
        listEl.append(el("li", "ride-screen-dest__section", "Saved places"));
      }
      for (const s of savedRows) {
        listEl.append(
          renderRow(
            s.display,
            null,
            false,
            // Saved picks skip the recents ledger: they are already permanent
            // rows here, and echoing them into "Recent destinations" would
            // show the same place twice forever.
            () => selectDest(s.dest, { record: false }),
            s.action,
          ),
        );
      }
      if (deps.pickOnMap) {
        listEl.append(
          renderRow(
            "📍 Pick a point on the map",
            "For somewhere with no address — a trailhead, a gazebo, a corner of the park.",
            false,
            () => startMapPick(),
          ),
        );
      }
      if (recents.length === 0) return;
      listEl.append(
        el("li", "ride-screen-dest__section", "Recent destinations"),
      );
      for (const r of recents) {
        listEl.append(
          renderRow(
            r.label,
            null,
            !r.inCoverage,
            () => selectDest(fromRecent(r)),
            saveAction(r),
          ),
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
        renderRow(
          r.label,
          KIND_LABEL[r.kind],
          !r.in_coverage,
          () => selectDest(fromResult(r)),
          saveAction({ label: r.label, lat: r.lat, lon: r.lon, kind: r.kind }),
        ),
      );
    }
  }
  render();

  // Fire-and-forget: the screen is already interactive on recents/search,
  // and the Saved-places rows appear whenever the profile answers — but
  // only if the rider is still on the empty-input suggestion view; a
  // mid-typing re-render would stomp live search results. Wrapped so that
  // neither a rejecting nor a synchronously-throwing loader (an injected
  // one — the default can do neither) can break the screen build or leak
  // an unhandled rejection; either failure just means no saved rows.
  void Promise.resolve()
    .then(() => (deps.getHomeWork ?? defaultGetHomeWork)())
    .then((points) => {
      if (destroyed) return;
      saved = points;
      if (isEmpty()) render();
    })
    .catch(() => {
      /* the suggestions are a bonus — recents and search carry the screen */
    });

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
