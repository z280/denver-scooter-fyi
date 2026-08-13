// The home surface: "Where are you going?"
//
// WHAT THIS REPLACES. The bottom of the map used to be a three-way mode bar —
// 🛴 Find wheels / 📊 Analysis / 🧭 Ride. It asked the rider to classify
// themselves before the app would help: which of our three internal surfaces
// do you want? Nobody arrives at a scooter map wanting a surface. They arrive
// wanting to get somewhere.
//
// So the bottom of the screen asks the only question a rider actually has an
// answer to on arrival — where are you going — and everything else follows
// from it. Analysis is not deleted; it moves to the ribbon with the other
// map-control surfaces, which is what it always was.
//
// THE ORDER OF THE TWO QUESTIONS IS THE DESIGN. Destination first, wheels
// second. A rider always knows where they are going; whether they want a Veo
// depends on how far it turns out to be, and on a map they have not looked at
// yet. Asking "scooter or your own?" first — which the old mode bar did, in
// effect — forces the guess before the information.
//
// NO DEFAULT ON THE WHEELS TOGGLE. Neither option is preselected and neither
// is styled as the recommendation. This app is not only for Veo riders: a
// preselected "find me a scooter" quietly tells an NIU owner they are using
// it wrong, and a preselected "got my own" hides the fleet from someone who
// needed it. An unanswered question is honest; a wrong default is not.
//
// GPS IS NEVER DEMANDED. The bar works with no location at all — you can
// still search, still save places, still plan. Location is offered as the
// convenient answer to "starting from where", with naming a start point as
// the equal alternative, because a rider who has declined the permission
// prompt has not thereby declined the app.

import { markUndoFree } from "./ios-shake-undo.ts";
import type { GeocodeKind, GeocodeResult } from "./api.ts";
import type { LngLat } from "./locate.ts";
import { track } from "./telemetry.ts";
import {
  createGeocodeSearch,
  type GeocodeSearchClient,
  type GeocodeSearchHandlers,
} from "./geocode-search.ts";
import { isSamePlace, loadFavorites, type Favorite } from "./favorites.ts";
import { fetchProfile } from "./api.ts";
import { isAuthenticated } from "./map-auth.js";
import {
  loadRecentDests,
  recordRecentDest,
  type RecentDest,
} from "./ride-screen-dest.ts";
import type { TripPlace, TripWheels } from "./pending-trip.ts";

export interface HomeBarDeps {
  /** The live GPS fix, or null. Read-only — turning location ON is the top
   *  bar's button, which the rider can already press unprompted; this bar
   *  only ever reflects and points at it. */
  locate: {
    current(): LngLat | null;
    onFix(cb: (pos: LngLat) => void): () => void;
    onError(cb: () => void): () => void;
    trigger(): void;
  };
  /** Injected for tests; defaults to `geocode-search.ts`, whose debounce,
   *  abort and cache machinery has its own test file. */
  createSearch?(handlers: GeocodeSearchHandlers): GeocodeSearchClient;
  /** Tap the map to drop a pin — for a destination or a start point with no
   *  address. Absent means the row is not offered. */
  pickOnMap?(hint?: string): Promise<{ lat: number; lng: number } | null>;
  /** The rider answered both questions. */
  onPlanTrip(trip: { dest: TripPlace; wheels: TripWheels; start: TripPlace | null }): void;
  /** Every change to the chosen points, so the map can draw them.
   *
   *  Picking a point used to do nothing visible: you tapped the map, the app
   *  took the coordinate and moved on, and the map looked exactly as it had
   *  before — the one interaction with no address to confirm it was also the
   *  one with no confirmation at all. Fires on choose, on change-your-mind
   *  and on close, so the map never keeps a pin for a trip that is no longer
   *  being planned. */
  onPlacesChange?(places: { dest: TripPlace | null; start: TripPlace | null }): void;
  /** The rider's saved Home and Work, for the pinned row. Injected for tests;
   *  defaults to the signed-in profile. Only coordinates are stored, so the
   *  labels are "Home" and "Work" — which is what the rider calls them and
   *  what should appear as the destination downstream. Never awaited by the
   *  bar's own open path: the row appears when it appears. */
  getHomeWork?(): Promise<{ home: TripPlace | null; work: TripPlace | null }>;
}

export interface HomeBarHandle {
  /** Fold back to the resting pill — called when another surface takes over
   *  (a ride starts, the wizard opens) so two things never claim the bottom
   *  of the screen at once. */
  collapse(): void;
  /** Open straight to the destination search and answer exactly that one
   *  question — no "need wheels / got my own" step, no trip dispatched. For
   *  the rider who is already standing at a scooter and wants to correct
   *  where they're headed before any route is computed. `onPicked` fires
   *  once, on a choice; backing out simply never calls it. */
  openForDestination(onPicked: (place: TripPlace) => void): void;
  isOpen(): boolean;
  destroy(): void;
}

type Phase = "collapsed" | "destination" | "wheels";
type SearchStatus = "idle" | "searching" | "error";
/** Which slot a map pick or a search result is filling. The start point uses
 *  the same picker and the same search as the destination — it is the same
 *  question asked about the other end of the trip, and giving it a second,
 *  lesser input would be the worse UX for no gain. */
type Slot = "dest" | "start";

const PLACEHOLDER = "Where are you going?";

/** Home/Work off the signed-in profile. A signed-out rider is the common case
 *  and not an error — skip the fetch rather than burning a guaranteed 401,
 *  same as `ride-screen-dest.ts` does for the same two points. */
async function defaultGetHomeWork(): Promise<{
  home: TripPlace | null;
  work: TripPlace | null;
}> {
  if (!isAuthenticated()) return { home: null, work: null };
  try {
    const p = await fetchProfile();
    return {
      home:
        p.home_lat != null && p.home_lng != null
          ? { label: "Home", lat: p.home_lat, lon: p.home_lng }
          : null,
      work:
        p.work_lat != null && p.work_lng != null
          ? { label: "Work", lat: p.work_lat, lon: p.work_lng }
          : null,
    };
  } catch {
    return { home: null, work: null };
  }
}

export function createHomeBar(root: HTMLElement, deps: HomeBarDeps): HomeBarHandle {
  let phase: Phase = "collapsed";
  let slot: Slot = "dest";
  let dest: TripPlace | null = null;
  let start: TripPlace | null = null;
  let favorites: Favorite[] = loadFavorites();
  let recents: RecentDest[] = loadRecentDests();
  /** Home/Work from the signed-in profile. Starts empty and fills in when the
   *  fetch lands — the bar must be usable the instant it opens, so this is
   *  never awaited, and a signed-out rider simply never gets the row. */
  let homeWork: { home: TripPlace | null; work: TripPlace | null } = {
    home: null,
    work: null,
  };
  let results: GeocodeResult[] = [];
  let status: SearchStatus = "idle";
  let liveQuery = "";
  let destroyed = false;

  // -- resting state: one wide tap target, and nothing else ------------------
  const pill = el("button", "home-bar__pill");
  pill.type = "button";
  pill.append(el("span", "home-bar__pill-glyph", "🔎"), el("span", "", PLACEHOLDER));
  pill.addEventListener("click", () => open());

  // -- open state -----------------------------------------------------------
  const sheet = el("div", "home-bar__sheet");
  sheet.hidden = true;

  const input = el("input", "home-bar__input") as HTMLInputElement;
  input.type = "search";
  input.placeholder = PLACEHOLDER;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", PLACEHOLDER);
  markUndoFree(input);

  const closeBtn = el("button", "home-bar__close", "✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => collapse());

  const head = el("div", "home-bar__head");
  head.append(input);

  const statusEl = el("p", "home-bar__status");
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  statusEl.hidden = true;

  const listEl = el("ul", "home-bar__list");
  const footEl = el("div", "home-bar__foot");

  // The close button is a direct child of the sheet, not of the head: it is
  // positioned against the sheet's corner regardless, and living inside the
  // head meant it vanished with it on the wheels step — leaving a panel with
  // no way out.
  sheet.append(closeBtn, head, statusEl, listEl, footEl);
  root.append(sheet, pill);

  const search = (deps.createSearch ?? createGeocodeSearch)({
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

  // A fix arriving (or failing) changes only the start-point line, but the
  // rider may be looking straight at it when the permission prompt resolves.
  const offFix = deps.locate.onFix(() => {
    if (!destroyed && phase !== "collapsed") render();
  });
  const offErr = deps.locate.onError(() => {
    if (!destroyed && phase !== "collapsed") render();
  });

  function emitPlaces(): void {
    deps.onPlacesChange?.({ dest, start });
  }

  /** Set while the bar is answering ONE question for another surface (the
   *  arrival panel's "Change destination"), instead of planning a whole
   *  trip. Cleared the moment it fires, and by `collapse`, so an abandoned
   *  change can never leak into the next ordinary trip the bar plans. */
  let destOnly: ((place: TripPlace) => void) | null = null;

  function open(): void {
    if (destroyed) return;
    destOnly = null;
    phase = "destination";
    slot = "dest";
    favorites = loadFavorites();
    recents = loadRecentDests();
    track("home_bar", { action: "open" });
    render();
    input.focus();
    // Fire-and-forget, after the first paint. The bar is fully usable without
    // it, and a rider who already knows where they are going should never
    // wait on a profile fetch to start typing.
    void loadHomeWork();
  }

  async function loadHomeWork(): Promise<void> {
    const get = deps.getHomeWork ?? defaultGetHomeWork;
    try {
      const next = await get();
      if (destroyed) return;
      homeWork = next;
      // Only repaint if there is something to add AND the rider is still
      // looking at the list it belongs in — a late fetch must not stomp a
      // sheet they have since typed into or moved past.
      if ((next.home || next.work) && phase === "destination" && !input.value.trim()) {
        render();
      }
    } catch {
      /* no pinned row is a fine outcome; it is a shortcut, not a feature */
    }
  }

  function collapse(opts: { keepPlaces?: boolean } = {}): void {
    if (destroyed) return;
    // Whether the rider picked a destination or backed out, the one-question
    // errand is over — a stale callback here would fire on some unrelated
    // trip later and change a destination nobody asked to change.
    destOnly = null;
    // A trip that was handed to a flow keeps its pins — that flow is now
    // showing the rider the route to them. Backing out of planning drops
    // them, so the map does not keep a destination nobody is going to.
    if (!opts.keepPlaces) {
      dest = null;
      start = null;
      emitPlaces();
    }
    phase = "collapsed";
    input.value = "";
    liveQuery = "";
    results = [];
    status = "idle";
    search.cancel();
    render();
  }

  function chooseDest(place: TripPlace, opts: { record?: boolean } = {}): void {
    dest = place;
    if (opts.record !== false) {
      recents = recordRecentDest({
        label: place.label,
        lat: place.lat,
        lon: place.lon,
        inCoverage: true,
      });
    }
    // Destination-only: the rider is standing at a scooter, so "need wheels
    // or got my own" is a question they have already answered with their
    // feet. Asking it again would be the app forgetting where they are.
    if (destOnly) {
      const done = destOnly;
      destOnly = null;
      track("home_bar", { action: "dest_chosen_only" });
      emitPlaces();
      collapse({ keepPlaces: true });
      done(place);
      return;
    }
    phase = "wheels";
    input.value = "";
    liveQuery = "";
    results = [];
    status = "idle";
    search.cancel();
    track("home_bar", { action: "dest_chosen" });
    emitPlaces();
    render();
  }

  function chooseStart(place: TripPlace | null): void {
    start = place;
    slot = "dest";
    phase = dest ? "wheels" : "destination";
    input.value = "";
    liveQuery = "";
    results = [];
    search.cancel();
    emitPlaces();
    render();
  }

  function pick(place: TripPlace, opts: { record?: boolean } = {}): void {
    if (slot === "start") chooseStart(place);
    else chooseDest(place, opts);
  }

  // -- rendering ------------------------------------------------------------

  function render(): void {
    const open = phase !== "collapsed";
    sheet.hidden = !open;
    pill.hidden = open;
    root.classList.toggle("is-open", open);
    // The map has to stay reachable behind an open sheet — a rider mid-search
    // who wants to look at the map should not have to close anything.
    document.body.classList.toggle("home-bar-open", open);
    if (!open) return;

    listEl.replaceChildren();
    footEl.replaceChildren();
    statusEl.hidden = true;
    // The search box has nothing to do on the wheels step — the destination
    // is chosen and echoed back two lines below it. Leaving an empty
    // "Where are you going?" above the answer to that very question reads as
    // an unfinished form. "change" is how you go back to it.
    input.hidden = phase === "wheels";
    // ...and the head with it: an empty 40px band above the answer is the
    // most expensive thing on a surface floating over a map.
    head.hidden = phase === "wheels";

    if (phase === "wheels") {
      renderWheels();
      return;
    }
    renderSearch();
    renderStartLine();
  }

  function renderSearch(): void {
    input.placeholder =
      slot === "start" ? "Where are you starting from?" : PLACEHOLDER;
    input.setAttribute("aria-label", input.placeholder);

    const typed = input.value.trim();
    if (typed) {
      if (status === "searching") return say("Searching…");
      if (status === "error") {
        return say("Couldn't reach search just now — pick a saved place, or try again in a moment.");
      }
      if (results.length === 0) {
        return say("No matches yet — keep typing, or try a nearby cross street.");
      }
      for (const r of results) {
        listEl.append(
          row(r.label, KIND_LABEL[r.kind], () =>
            pick({ label: r.label, lat: r.lat, lon: r.lon }),
          ),
        );
      }
      return;
    }

    // Empty input: everything the rider has already told us, before we ask
    // them to type anything.
    renderPinned();
    if (favorites.length > 0) {
      listEl.append(section("Saved places"));
      for (const f of favorites) {
        listEl.append(
          row(`${f.emoji} ${f.label}`.trim(), null, () =>
            // Saved places skip the recents ledger: they are permanent rows
            // already, and echoing them in would show the same place twice.
            pick({ label: f.label, lat: f.lat, lon: f.lon }, { record: false }),
          ),
        );
      }
    }
    const unsavedRecents = recents.filter(
      (r) => !favorites.some((f) => isSamePlace(f, r)),
    );
    if (unsavedRecents.length > 0) {
      listEl.append(section("Recent"));
      for (const r of unsavedRecents) {
        listEl.append(
          row(r.label, null, () => pick({ label: r.label, lat: r.lat, lon: r.lon })),
        );
      }
    }
    if (deps.pickOnMap) {
      listEl.append(
        row(
          "📍 Pick a point on the map",
          "For somewhere with no address — a trailhead, a gazebo, a corner of the park.",
          () => startMapPick(),
        ),
      );
    }
    if (listEl.childElementCount === 0) {
      say("Type an address, a place, or a cross street.");
    }
  }

  /** Home and Work, pinned above everything else.
   *
   *  They are the two destinations a rider picks most and the two they should
   *  never have to type, so they sit at the top as tap targets rather than in
   *  the saved-places list — which is alphabetical-ish, unbounded, and makes
   *  the two most likely answers findable rather than immediate.
   *
   *  LAYOUT RULE, and it is absolute: two set, they share the row; one set,
   *  it takes the whole row. A lone half-width button next to dead space is
   *  never rendered — it reads as a missing element or a broken layout, and
   *  the grid below is written so that state cannot be expressed. Neither
   *  set renders nothing at all, not an empty row or a pair of placeholders
   *  prompting setup; that belongs in the profile, where they are set. */
  function renderPinned(): void {
    // Shown for the start slot too: "where are you starting from?" has the
    // same two most-likely answers, and `pick` already routes by slot.
    const pinned: { glyph: string; label: string; place: TripPlace }[] = [];
    if (homeWork.home) {
      pinned.push({ glyph: "🏠", label: "Home", place: homeWork.home });
    }
    if (homeWork.work) {
      pinned.push({ glyph: "💼", label: "Work", place: homeWork.work });
    }
    if (pinned.length === 0) return;

    const grid = el("div", "home-bar__pinned");
    // The class carries the count, so CSS decides the widths and no branch
    // here can accidentally produce a half-width single.
    grid.classList.add(pinned.length === 1 ? "is-single" : "is-pair");
    for (const p of pinned) {
      const btn = el("button", "home-bar__quick");
      btn.type = "button";
      btn.append(
        el("span", "home-bar__quick-glyph", p.glyph),
        el("span", "home-bar__quick-label", p.label),
      );
      btn.addEventListener("click", () => {
        track("home_bar", { action: "pinned_chosen" });
        // Not recorded as a recent: it is already a permanent row, and
        // echoing it below would show the same place twice.
        pick(p.place, { record: false });
      });
      grid.append(btn);
    }
    listEl.append(grid);
  }

  /** The start-point line. Three states, and none of them is a demand:
   *   - a fix:        "Starting from your location"
   *   - no fix:       the grey hint pointing at the top bar's own button,
   *                   plus the red pin that sets a start point by hand
   *   - a named start: what they named, and a way to undo it */
  function renderStartLine(): void {
    if (start) {
      const line = el("p", "home-bar__hint", `Starting from ${start.label}`);
      const undo = el("button", "home-bar__linkbtn", "use my location instead");
      undo.type = "button";
      undo.addEventListener("click", () => {
        chooseStart(null);
        deps.locate.trigger();
      });
      line.append(" ", undo);
      footEl.append(line);
      return;
    }
    if (deps.locate.current()) {
      footEl.append(el("p", "home-bar__hint", "Starting from your location"));
      return;
    }
    const line = el("p", "home-bar__hint");
    line.append(
      // Deliberately grey and quiet: this is an explanation, not an error.
      // Nothing here has failed — the rider simply has not turned location on,
      // which is a choice the app respects and works around.
      el("span", "", "Turn on location "),
      el("span", "home-bar__hint-arrow", "↑"),
      el("span", "", " above for directions from where you are — or "),
    );
    const setStart = el("button", "home-bar__pin", "●");
    setStart.type = "button";
    setStart.title = "Set a starting point";
    setStart.setAttribute("aria-label", "Set a starting point");
    setStart.addEventListener("click", () => {
      slot = "start";
      input.value = "";
      liveQuery = "";
      results = [];
      phase = "destination";
      render();
      input.focus();
    });
    line.append(setStart, el("span", "", " set a starting point."));
    footEl.append(line);
  }

  /** The second question. Two buttons, equal weight, neither preselected —
   *  see this module's header. */
  function renderWheels(): void {
    const to = el("div", "home-bar__to");
    to.append(el("span", "home-bar__to-label", "To"), el("strong", "", dest!.label));
    const change = el("button", "home-bar__linkbtn", "change");
    change.type = "button";
    change.addEventListener("click", () => {
      phase = "destination";
      slot = "dest";
      render();
      input.focus();
    });
    to.append(change);
    listEl.append(to);

    listEl.append(section("How are you getting there?"));

    const choices = el("div", "home-bar__wheels");
    for (const choice of WHEELS) {
      const btn = el("button", "home-bar__wheel");
      btn.type = "button";
      // Glyph beside the name on one line, blurb under both: two lines, not
      // three centred ones in a narrow column.
      const head = el("span", "home-bar__wheel-head");
      head.append(
        el("span", "home-bar__wheel-glyph", choice.glyph),
        el("span", "home-bar__wheel-name", choice.name),
      );
      btn.append(head, el("span", "home-bar__wheel-desc", choice.desc));
      btn.addEventListener("click", () => {
        if (!dest) return;
        track("home_bar", { action: "plan", wheels: choice.value });
        deps.onPlanTrip({ dest, wheels: choice.value, start });
        // The chosen flow owns the screen now — but the pins stay, because
        // that flow is about to route to them.
        collapse({ keepPlaces: true });
      });
      choices.append(btn);
    }
    listEl.append(choices);
    // The start line only earns its place here when there is something to DO
    // about it. "Starting from your location" answers a question nobody asked
    // on a screen about how you are getting there — but "we don't know where
    // you are starting from" is worth saying before a route is planned from
    // it, and this is the last screen before that happens.
    if (!start && !deps.locate.current()) renderStartLine();
  }

  function startMapPick(): void {
    const pickFn = deps.pickOnMap;
    if (!pickFn) return;
    const hint =
      slot === "start"
        ? "Tap the map to set your starting point"
        : "Tap the map to drop a pin on your destination";
    // Fold away while the map is being tapped — the sheet covers the bottom
    // half of a phone, which is half the places a rider might want to tap.
    const wasPhase = phase;
    phase = "collapsed";
    render();
    void Promise.resolve()
      .then(() => pickFn(hint))
      .then((point) => {
        if (destroyed) return;
        phase = wasPhase;
        if (!point) return render();
        pick({ label: "Dropped pin", lat: point.lat, lon: point.lng });
      })
      .catch(() => {
        if (destroyed) return;
        phase = wasPhase;
        render();
      });
  }

  // -- small builders -------------------------------------------------------

  function say(text: string): void {
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  function section(text: string): HTMLElement {
    return el("li", "home-bar__section", text);
  }

  function row(label: string, meta: string | null, onClick: () => void): HTMLElement {
    const li = el("li");
    const btn = el("button", "home-bar__row");
    btn.type = "button";
    btn.append(el("span", "home-bar__row-title", label));
    if (meta) btn.append(el("span", "home-bar__row-desc", meta));
    btn.addEventListener("click", onClick);
    li.append(btn);
    return li;
  }

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
    const fix = deps.locate.current();
    search.query(raw, fix ? { lat: fix.lat, lon: fix.lng } : undefined);
  });

  // Escape closes the sheet, matching every other dismissible surface here.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || phase === "collapsed") return;
    e.stopPropagation();
    collapse();
  };
  document.addEventListener("keydown", onKeyDown);

  render();

  return {
    collapse,
    openForDestination(onPicked) {
      open();
      // After `open`, which clears it — this is the one caller that wants it
      // set, and setting it first would just be undone.
      destOnly = onPicked;
    },
    isOpen: () => phase !== "collapsed",
    destroy: () => {
      destroyed = true;
      document.removeEventListener("keydown", onKeyDown);
      offFix();
      offErr();
      search.dispose();
      document.body.classList.remove("home-bar-open");
      root.replaceChildren();
    },
  };
}

const WHEELS: readonly {
  value: TripWheels;
  glyph: string;
  name: string;
  desc: string;
}[] = [
  {
    value: "need",
    glyph: "🛴",
    name: "Need wheels",
    desc: "Find me one nearby",
  },
  {
    value: "own",
    glyph: "🚲",
    name: "Got my own",
    desc: "Just take me there",
  },
];

const KIND_LABEL: Record<GeocodeKind, string> = {
  house: "Address",
  street: "Street",
  poi: "Place",
  locality: "Area",
};

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
