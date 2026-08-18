// @vitest-environment happy-dom
//
// Screen 3 — "Where to?" Covers: the skip gate (navigation on/off), the
// search wiring (bias passed through, results rendered, `in_coverage`
// greying as a pure rendering decision), selecting an address/recent dest
// dispatching `setDest` and advancing the flow, and recent-destination
// storage (add/dedupe/cap-at-5/most-recent-first, including the persisted
// round trip through real localStorage).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeocodeResult } from "./api.ts";
import type { RideOptions } from "./api.ts";
import type { LngLat } from "./locate.ts";
import {
  currentRideScreen,
  openRideModal,
  resetRideModal,
  resolveStartScreen,
  rideModalRoot,
} from "./ride-modal.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideSessionStore,
  type WizardScreenId,
} from "./ride-session.ts";
import type { GeocodeSearchClient, GeocodeSearchHandlers } from "./geocode-search.ts";
import { loadFavorites, recordFavorite } from "./favorites.ts";
import {
  MAX_RECENT_DESTS,
  RECENT_DESTS_KEY,
  loadRecentDests,
  pushRecentDest,
  recordRecentDest,
  wireRideScreenDest,
  type LocateLike,
  type RecentDest,
  type RideDestWithCoverage,
  type RideScreenDestDeps,
} from "./ride-screen-dest.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function baseOptions(navigation: boolean): RideOptions {
  return {
    cost_hud: false,
    speedometer: "classic",
    theme: "auto",
    navigation,
    save_tracks: false,
    battery_modeling: false,
    nav_improvement: false,
    end_survey: false,
    own_device: false,
  };
}

function sessionAt(
  screen: WizardScreenId,
  navigation = true,
): RideSessionStore {
  const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
  store.dispatch({ type: "open", options: baseOptions(navigation), screen });
  return store;
}

function fakeLocate(fix: LngLat | null): LocateLike {
  return { current: () => fix };
}

interface FakeSearch {
  createSearch(handlers: GeocodeSearchHandlers): GeocodeSearchClient;
  calls: { q: string; bias?: { lat?: number; lon?: number } }[];
  cancelCalls: number;
  emitResults(results: GeocodeResult[], q: string): void;
  emitError(err: unknown, q: string): void;
}

function fakeSearch(): FakeSearch {
  const calls: { q: string; bias?: { lat?: number; lon?: number } }[] = [];
  let cancelCalls = 0;
  let handlers: GeocodeSearchHandlers | null = null;
  const client: GeocodeSearchClient = {
    query: (q, bias) => {
      calls.push({ q, bias });
    },
    cancel: () => {
      cancelCalls += 1;
    },
    dispose: () => {},
  };
  return {
    createSearch: (h) => {
      handlers = h;
      return client;
    },
    calls,
    get cancelCalls() {
      return cancelCalls;
    },
    emitResults: (results, q) => handlers?.onResults(results, q),
    emitError: (err, q) => handlers?.onError?.(err, q),
  };
}

function result(
  label: string,
  overrides: Partial<GeocodeResult> = {},
): GeocodeResult {
  return {
    label,
    lat: 39.74,
    lon: -104.99,
    kind: "street",
    in_coverage: true,
    ...overrides,
  };
}

function wire(
  session: RideSessionStore,
  overrides: Partial<Omit<RideScreenDestDeps, "session">> = {},
): () => void {
  return wireRideScreenDest({
    session,
    locate: fakeLocate(null),
    ...overrides,
  });
}

function input(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    '[aria-label="Destination address"]',
  );
  if (!el) throw new Error("destination input not found");
  return el;
}

function typeInto(text: string): void {
  const el = input();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function optionRows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".ride-option")];
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  resetRideModal();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// skip()
// ---------------------------------------------------------------------------

describe("wireRideScreenDest — skip gate", () => {
  it("shows the screen when navigation is on", () => {
    const session = sessionAt("3", true);
    wire(session);
    expect(resolveStartScreen({ fastForwardTo: "3" })).toBe("3");
  });

  it("skips the screen when navigation is off", () => {
    const session = sessionAt("3", false);
    wire(session);
    // Unregistered downstream screens step in once "3" is skipped.
    expect(resolveStartScreen({ fastForwardTo: "3" })).not.toBe("3");
  });

  it("skips when there is no session doc at all", () => {
    const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
    wire(store);
    expect(resolveStartScreen({ fastForwardTo: "3" })).not.toBe("3");
  });
});

// ---------------------------------------------------------------------------
// search wiring + in_coverage greying
// ---------------------------------------------------------------------------

describe("Screen 3 — search", () => {
  it("debounces through geocode-search.ts's client and biases with the resolved fix", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, {
      locate: fakeLocate({ lng: -104.98, lat: 39.75 }),
      createSearch: fs.createSearch,
    });
    openRideModal({ fastForwardTo: "3" });
    typeInto("colfax");
    expect(fs.calls).toHaveLength(1);
    expect(fs.calls[0].q).toBe("colfax");
    expect(fs.calls[0].bias).toEqual({ lat: 39.75, lon: -104.98 });
  });

  it("passes no bias when there is no GPS fix", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, { createSearch: fs.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("colfax");
    expect(fs.calls[0].bias).toBeUndefined();
  });

  it("renders suggestions once the client resolves", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, { createSearch: fs.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("colfax");
    fs.emitResults([result("1 Colfax Ave"), result("2 Colfax Ave")], "colfax");
    expect(optionRows().map((r) => r.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1 Colfax Ave"),
        expect.stringContaining("2 Colfax Ave"),
      ]),
    );
  });

  it("greys an in_coverage:false suggestion but keeps it selectable and advancing", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, { createSearch: fs.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("aurora");
    fs.emitResults(
      [result("In town", { in_coverage: true }), result("Way out", { in_coverage: false })],
      "aurora",
    );
    const rows = optionRows();
    const inTown = rows.find((r) => r.textContent?.includes("In town"));
    const wayOut = rows.find((r) => r.textContent?.includes("Way out"));
    expect(inTown?.classList.contains("is-out-of-coverage")).toBe(false);
    expect(wayOut?.classList.contains("is-out-of-coverage")).toBe(true);

    // Still selectable: clicking it sets the destination and advances anyway.
    wayOut!.click();
    expect(session.current()?.dest?.label).toBe("Way out");
    expect(currentRideScreen()).toBe("4");
  });

  it("selecting an in-coverage suggestion dispatches setDest and advances to Screen 4", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, { createSearch: fs.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("colfax");
    fs.emitResults([result("1 Colfax Ave", { lat: 39.74, lon: -104.98 })], "colfax");
    optionRows()[0].click();
    const stored = session.current()?.dest as RideDestWithCoverage | undefined;
    expect(stored).toMatchObject({
      label: "1 Colfax Ave",
      lat: 39.74,
      lon: -104.98,
    });
    // The `in_coverage` flag rides along on the runtime object (see the
    // module's DEVIATION note) even though `RideSessionDest` itself doesn't
    // declare the field yet.
    expect(stored?.inCoverage).toBe(true);
    expect(currentRideScreen()).toBe("4");
  });

  it("forwards every keystroke to the debounced client — debounce/cancel-on-requery is geocode-search.ts's own job, covered in its own test file", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, { createSearch: fs.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("col");
    typeInto("colf");
    expect(fs.calls.map((c) => c.q)).toEqual(["col", "colf"]);
  });

  it("clearing the field back to empty cancels the search and hides suggestions", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, { createSearch: fs.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("colfax");
    fs.emitResults([result("1 Colfax Ave")], "colfax");
    expect(optionRows().length).toBeGreaterThan(0);
    typeInto("");
    expect(fs.cancelCalls).toBe(1);
    expect(optionRows().length).toBe(0);
  });

  it("shows a degrade message on a search error without crashing", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, { createSearch: fs.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("colfax");
    fs.emitError(new Error("sidecar down"), "colfax");
    expect(rideModalRoot()?.textContent).toContain("Couldn't load suggestions");
  });

  it("focuses the search bar on mount", () => {
    const session = sessionAt("3");
    wire(session);
    openRideModal({ fastForwardTo: "3" });
    expect(document.activeElement).toBe(input());
  });
});

// ---------------------------------------------------------------------------
// Recent destinations — rendering
// ---------------------------------------------------------------------------

describe("Screen 3 — saved places (home/work)", () => {
  const HOME = { lat: 39.71, lng: -104.98 };
  const WORK = { lat: 39.75, lng: -104.99 };

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("suggests Home and Work above the recents once the profile answers", async () => {
    localStorage.setItem(
      RECENT_DESTS_KEY,
      JSON.stringify({
        v: 1,
        dests: [{ label: "Union Station", lat: 39.75, lon: -105.0, inCoverage: true }],
      }),
    );
    const session = sessionAt("3");
    wire(session, { getHomeWork: async () => ({ home: HOME, work: WORK }) });
    openRideModal({ fastForwardTo: "3" });
    await flush();
    const text = rideModalRoot()?.textContent ?? "";
    expect(text).toContain("Saved places");
    expect(text.indexOf("🏠 Home")).toBeLessThan(text.indexOf("Union Station"));
    expect(text).toContain("💼 Work");
  });

  it("picking Home dispatches the saved coordinates and advances", async () => {
    const session = sessionAt("3");
    wire(session, { getHomeWork: async () => ({ home: HOME, work: null }) });
    openRideModal({ fastForwardTo: "3" });
    await flush();
    const row = optionRows().find((r) => r.textContent?.includes("Home"));
    row!.click();
    // The bare word, not the glyph — it is what Screens 4/6 echo back.
    expect(session.current()?.dest).toMatchObject({
      label: "Home",
      lat: HOME.lat,
      lon: HOME.lng,
    });
    expect(currentRideScreen()).toBe("4");
    // Permanent rows don't echo into the recents ledger — the same place
    // twice forever would be the only possible outcome.
    expect(loadRecentDests()).toEqual([]);
  });

  it("renders no Saved-places section when the profile has neither", async () => {
    const session = sessionAt("3");
    wire(session, { getHomeWork: async () => ({ home: null, work: null }) });
    openRideModal({ fastForwardTo: "3" });
    await flush();
    expect(rideModalRoot()?.textContent).not.toContain("Saved places");
  });

  it("only Work set: no Home row, and the section still renders", async () => {
    const session = sessionAt("3");
    wire(session, { getHomeWork: async () => ({ home: null, work: WORK }) });
    openRideModal({ fastForwardTo: "3" });
    await flush();
    const text = rideModalRoot()?.textContent ?? "";
    expect(text).toContain("Saved places");
    expect(text).toContain("💼 Work");
    expect(text).not.toContain("🏠 Home");
  });

  it("a rejecting or throwing loader costs only the rows, never the screen", async () => {
    const session = sessionAt("3");
    wire(session, {
      getHomeWork: () => Promise.reject(new Error("profile down")),
    });
    openRideModal({ fastForwardTo: "3" });
    await flush();
    // The screen is intact and searchable; there is just no Saved section.
    expect(input()).not.toBeNull();
    expect(rideModalRoot()?.textContent).not.toContain("Saved places");

    resetRideModal();
    document.body.replaceChildren();
    const session2 = sessionAt("3");
    wire(session2, {
      getHomeWork: () => {
        throw new Error("sync throw");
      },
    });
    // A synchronously-throwing loader must not break the screen build.
    openRideModal({ fastForwardTo: "3" });
    await flush();
    expect(input()).not.toBeNull();
  });

  it("a late profile answer does not stomp live search results", async () => {
    // The rider starts typing before the profile fetch lands: the answer
    // must be held for the next empty-input view, not re-rendered over the
    // results list.
    let resolveHomeWork: (p: { home: typeof HOME | null; work: null }) => void = () => {};
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, {
      createSearch: fs.createSearch,
      getHomeWork: () =>
        new Promise((resolve) => {
          resolveHomeWork = resolve;
        }),
    });
    openRideModal({ fastForwardTo: "3" });
    // Let the (deliberately still-pending) loader be invoked so its
    // resolver is captured, then start typing before it answers.
    await flush();
    typeInto("colfax");
    fs.emitResults([result("1 Colfax Ave")], "colfax");
    resolveHomeWork({ home: HOME, work: null });
    await flush();
    const text = rideModalRoot()?.textContent ?? "";
    expect(text).toContain("1 Colfax Ave");
    expect(text).not.toContain("Saved places");
    // …but clearing the field brings the saved rows straight back.
    typeInto("");
    expect(rideModalRoot()?.textContent).toContain("🏠 Home");
  });
});

describe("Screen 3 — recent destinations", () => {
  it("renders recent destinations when the field is empty", () => {
    localStorage.setItem(
      RECENT_DESTS_KEY,
      JSON.stringify({
        v: 1,
        dests: [{ label: "Union Station", lat: 39.75, lon: -105.0, inCoverage: true }],
      }),
    );
    const session = sessionAt("3");
    wire(session);
    openRideModal({ fastForwardTo: "3" });
    expect(rideModalRoot()?.textContent).toContain("Union Station");
  });

  it("selecting a recent destination dispatches setDest and advances", () => {
    localStorage.setItem(
      RECENT_DESTS_KEY,
      JSON.stringify({
        v: 1,
        dests: [{ label: "Union Station", lat: 39.75, lon: -105.0, inCoverage: true }],
      }),
    );
    const session = sessionAt("3");
    wire(session);
    openRideModal({ fastForwardTo: "3" });
    const row = optionRows().find((r) => r.textContent?.includes("Union Station"));
    row!.click();
    expect(session.current()?.dest?.label).toBe("Union Station");
    expect(currentRideScreen()).toBe("4");
  });

  it("a selection is recorded into localStorage for the next visit", () => {
    const session = sessionAt("3");
    const fs = fakeSearch();
    wire(session, { createSearch: fs.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("colfax");
    fs.emitResults([result("1 Colfax Ave")], "colfax");
    optionRows()[0].click();
    expect(loadRecentDests().map((d) => d.label)).toEqual(["1 Colfax Ave"]);
  });
});

// ---------------------------------------------------------------------------
// Recent destinations — pure storage logic
// ---------------------------------------------------------------------------

function dest(label: string, inCoverage = true): RecentDest {
  return { label, lat: 39.7, lon: -105.0, inCoverage };
}

describe("pushRecentDest", () => {
  it("adds most-recent-first", () => {
    const list = pushRecentDest([dest("A")], dest("B"));
    expect(list.map((d) => d.label)).toEqual(["B", "A"]);
  });

  it("dedupes by label, case-insensitively, keeping the new entry first", () => {
    const list = pushRecentDest([dest("Union Station"), dest("Coors Field")], dest("union station"));
    expect(list.map((d) => d.label)).toEqual(["union station", "Coors Field"]);
  });

  it("caps at MAX_RECENT_DESTS, dropping the oldest", () => {
    let list: RecentDest[] = [];
    for (let i = 0; i < MAX_RECENT_DESTS + 2; i += 1) {
      list = pushRecentDest(list, dest(`stop-${i}`));
    }
    expect(list.length).toBe(MAX_RECENT_DESTS);
    expect(list[0].label).toBe(`stop-${MAX_RECENT_DESTS + 1}`); // most recent
    expect(list.map((d) => d.label)).not.toContain("stop-0"); // oldest dropped
  });
});

describe("recordRecentDest / loadRecentDests — persisted round trip", () => {
  it("persists and reloads through real localStorage", () => {
    recordRecentDest(dest("Union Station"));
    recordRecentDest(dest("Coors Field"));
    expect(loadRecentDests().map((d) => d.label)).toEqual(["Coors Field", "Union Station"]);
  });

  it("ignores a corrupt blob rather than throwing", () => {
    localStorage.setItem(RECENT_DESTS_KEY, "{not json");
    expect(loadRecentDests()).toEqual([]);
  });

  it("ignores a wrong-version blob", () => {
    localStorage.setItem(RECENT_DESTS_KEY, JSON.stringify({ v: 2, dests: [dest("X")] }));
    expect(loadRecentDests()).toEqual([]);
  });

  it("drops individually invalid entries without discarding the valid ones", () => {
    localStorage.setItem(
      RECENT_DESTS_KEY,
      JSON.stringify({
        v: 1,
        dests: [dest("Valid"), { label: "bad", lat: "nope", lon: 1, inCoverage: true }],
      }),
    );
    expect(loadRecentDests().map((d) => d.label)).toEqual(["Valid"]);
  });

  it("degrades to an empty list when localStorage throws (private mode)", () => {
    const real = localStorage.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    expect(loadRecentDests()).toEqual([]);
    Storage.prototype.getItem = real;
  });
});

// ---------------------------------------------------------------------------
// Saved places (favorites.ts) — the local list, the star, the map-pick row
// ---------------------------------------------------------------------------

describe("wireRideScreenDest — saved places", () => {
  function openAt3(overrides: Partial<Omit<RideScreenDestDeps, "session">> = {}) {
    const session = sessionAt("3", true);
    wire(session, { createSearch: fakeSearch().createSearch, ...overrides });
    openRideModal({ fastForwardTo: "3" });
    return session;
  }

  function rowByText(text: string): HTMLButtonElement | undefined {
    return optionRows().find((r) => r.textContent?.includes(text));
  }

  /** The pick promise threads through several microtask hops before the
   *  naming form lands; a macrotask clears all of them regardless of how many
   *  there are, so the test asserts on the outcome rather than on the shape of
   *  the chain. */
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  function actions(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>(".ride-screen-dest__action")];
  }

  it("shows a locally saved place with no account and no network", () => {
    // The whole reason this store is local: the profile's home/work need an
    // account and a round trip, so a signed-out rider had no saved places.
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.74, lon: -104.99 });
    openAt3();
    expect(rowByText("🏠 Home")).toBeTruthy();
  });

  it("rides to the rider's own name for the place, not the address", () => {
    // Screens 4 and 6 echo this label back ("to Home"), which is the entire
    // point of letting a rider name somewhere.
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.74, lon: -104.99 });
    const session = openAt3();
    rowByText("🏠 Home")?.click();
    expect(session.current()?.dest?.label).toBe("Home");
  });

  it("does not echo a saved place into recent destinations", () => {
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.74, lon: -104.99 });
    openAt3();
    rowByText("🏠 Home")?.click();
    // It is already a permanent row; showing it twice forever is the bug.
    expect(loadRecentDests()).toEqual([]);
  });

  it("shows one Home when the profile and the local list agree", () => {
    // Same doorstep, two sources. A rider seeing their own house twice would
    // reasonably conclude one of them is wrong.
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.74001, lon: -104.99001 });
    openAt3({
      getHomeWork: () =>
        Promise.resolve({ home: { lat: 39.74, lng: -104.99 }, work: null }),
    });
    return Promise.resolve().then(() => {
      expect(optionRows().filter((r) => r.textContent?.includes("Home"))).toHaveLength(1);
    });
  });

  it("offers to save a search result, and stops the row from advancing", () => {
    const search = fakeSearch();
    const session = sessionAt("3", true);
    wire(session, { createSearch: search.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("1226 e 10th");
    search.emitResults([result("1226 E 10th Ave, Denver", { kind: "house" })], "1226 e 10th");

    actions()[0].click();
    // Tapping the star must not select the destination underneath it.
    expect(session.current()?.dest ?? null).toBeNull();
    const name = document.querySelector<HTMLInputElement>('[aria-label="Name for this place"]');
    expect(name?.value).toBe("1226 E 10th Ave, Denver");
  });

  it("saves under the name the rider typed and shows it straight away", () => {
    const search = fakeSearch();
    const session = sessionAt("3", true);
    wire(session, { createSearch: search.createSearch });
    openRideModal({ fastForwardTo: "3" });
    typeInto("1226 e 10th");
    search.emitResults([result("1226 E 10th Ave, Denver", { kind: "house" })], "1226 e 10th");
    actions()[0].click();

    const name = document.querySelector<HTMLInputElement>('[aria-label="Name for this place"]')!;
    name.value = "Home";
    rowByText("Save")?.click();

    expect(loadFavorites().map((f) => f.label)).toEqual(["Home"]);
    // Saved in order to be used — the rider should not have to search again.
    expect(input().value).toBe("");
    expect(rowByText("Home")).toBeTruthy();
  });

  it("forgets a saved place", () => {
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.74, lon: -104.99 });
    openAt3();
    actions()[0].click();
    expect(loadFavorites()).toEqual([]);
    expect(rowByText("🏠 Home")).toBeFalsy();
  });

  it("offers the map-pick failsafe only when a map is wired", () => {
    openAt3();
    expect(rowByText("Pick a point on the map")).toBeFalsy();
    resetRideModal();
    document.body.replaceChildren();
    openAt3({ pickOnMap: () => Promise.resolve(null) });
    expect(rowByText("Pick a point on the map")).toBeTruthy();
  });

  it("names a dropped pin, so an unaddressable place can be saved", async () => {
    // The gazebo in City Park: a real destination no geocoder will return.
    openAt3({ pickOnMap: () => Promise.resolve({ lat: 39.7485, lng: -104.9498 }) });
    rowByText("Pick a point on the map")?.click();
    await flush();
    const name = document.querySelector<HTMLInputElement>('[aria-label="Name for this place"]')!;
    name.value = "The gazebo";
    rowByText("Save")?.click();
    expect(loadFavorites()[0]).toMatchObject({ label: "The gazebo", lat: 39.7485 });
  });

  it("a cancelled map pick leaves the screen alone", async () => {
    openAt3({ pickOnMap: () => Promise.resolve(null) });
    rowByText("Pick a point on the map")?.click();
    await flush();
    expect(document.querySelector('[aria-label="Name for this place"]')).toBeNull();
    expect(loadFavorites()).toEqual([]);
  });
});
