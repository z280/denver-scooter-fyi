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
