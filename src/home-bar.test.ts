// @vitest-environment happy-dom
//
// The home bar — the surface that replaced the three-way mode bar.
//
// Most of what is asserted here is about the two questions and their ORDER:
// destination first, wheels second, neither answered for the rider. The
// wheels toggle having no default is a product decision (this app serves
// people who already own a scooter), so it is pinned by a test rather than
// left to survive on a comment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeocodeResult } from "./api.ts";
import type { LngLat } from "./locate.ts";
import { createHomeBar, type HomeBarDeps, type HomeBarHandle } from "./home-bar.ts";
import { recordFavorite } from "./favorites.ts";
import { RECENT_DESTS_KEY, loadRecentDests } from "./ride-screen-dest.ts";
import type { GeocodeSearchClient, GeocodeSearchHandlers } from "./geocode-search.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function fakeSearch() {
  const calls: { q: string; bias?: { lat?: number; lon?: number } }[] = [];
  let handlers: GeocodeSearchHandlers | null = null;
  const client: GeocodeSearchClient = {
    query: (q, bias) => void calls.push({ q, bias }),
    cancel: () => {},
    dispose: () => {},
  };
  return {
    createSearch: (h: GeocodeSearchHandlers) => {
      handlers = h;
      return client;
    },
    calls,
    emitResults: (r: GeocodeResult[], q: string) => handlers?.onResults(r, q),
    emitError: (q: string) => handlers?.onError?.(new Error("nope"), q),
  };
}

function fakeLocate(fix: LngLat | null = null) {
  let current = fix;
  const fixCbs = new Set<(p: LngLat) => void>();
  const errCbs = new Set<() => void>();
  return {
    triggered: 0,
    current: () => current,
    onFix: (cb: (p: LngLat) => void) => {
      fixCbs.add(cb);
      return () => fixCbs.delete(cb);
    },
    onError: (cb: () => void) => {
      errCbs.add(cb);
      return () => errCbs.delete(cb);
    },
    trigger(this: { triggered: number }) {
      this.triggered += 1;
    },
    /** test-only: deliver a fix as the browser would */
    emitFix(pos: LngLat) {
      current = pos;
      for (const cb of fixCbs) cb(pos);
    },
  };
}

function result(label: string, over: Partial<GeocodeResult> = {}): GeocodeResult {
  return { label, lat: 39.74, lon: -104.99, kind: "street", in_coverage: true, ...over };
}

let root: HTMLElement;
let bar: HomeBarHandle | null = null;

function mount(over: Partial<HomeBarDeps> = {}): {
  planned: Parameters<HomeBarDeps["onPlanTrip"]>[0][];
} {
  const planned: Parameters<HomeBarDeps["onPlanTrip"]>[0][] = [];
  bar = createHomeBar(root, {
    locate: fakeLocate(),
    createSearch: fakeSearch().createSearch,
    onPlanTrip: (t) => void planned.push(t),
    ...over,
  });
  return { planned };
}

const q = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
const rows = (): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>(".home-bar__row"),
];
const rowNamed = (text: string): HTMLButtonElement | undefined =>
  rows().find((r) => r.textContent?.includes(text));
const wheelNamed = (text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>(".home-bar__wheel")].find((b) =>
    b.textContent?.includes(text),
  );
const pill = (): HTMLButtonElement => q<HTMLButtonElement>(".home-bar__pill")!;
const input = (): HTMLInputElement => q<HTMLInputElement>(".home-bar__input")!;

function typeInto(text: string): void {
  const el = input();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  bar?.destroy();
  bar = null;
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------

describe("resting state", () => {
  it("asks where you are going, and nothing else", () => {
    mount();
    expect(pill().textContent).toContain("Where are you going?");
    expect(q(".home-bar__sheet")?.hidden).toBe(true);
  });

  it("does not ask the rider to classify themselves first", () => {
    // The whole point of the redesign: no "which of our surfaces do you
    // want" before the app will help. Nobody arrives wanting a surface.
    mount();
    expect(root.textContent).not.toContain("Analysis");
    expect(root.textContent).not.toContain("Find wheels");
  });

  it("opens on tap and closes on Escape", () => {
    mount();
    pill().click();
    expect(bar!.isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(bar!.isOpen()).toBe(false);
  });
});

describe("destination first", () => {
  it("offers saved places and recents before asking for a single keystroke", () => {
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.7, lon: -104.9 });
    localStorage.setItem(
      RECENT_DESTS_KEY,
      JSON.stringify({
        v: 1,
        dests: [{ label: "Union Station", lat: 39.75, lon: -105.0, inCoverage: true }],
      }),
    );
    mount();
    pill().click();
    expect(rowNamed("🏠 Home")).toBeTruthy();
    expect(rowNamed("Union Station")).toBeTruthy();
  });

  it("does not list a recent that is already a saved place", () => {
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.7, lon: -104.9 });
    localStorage.setItem(
      RECENT_DESTS_KEY,
      JSON.stringify({
        v: 1,
        dests: [{ label: "1226 E 10th Ave", lat: 39.7, lon: -104.9, inCoverage: true }],
      }),
    );
    mount();
    pill().click();
    // Same doorstep under two names is the rider's own house, twice.
    expect(rows().filter((r) => /Home|1226/.test(r.textContent ?? ""))).toHaveLength(1);
  });

  it("searches, biased by the fix when there is one", () => {
    const search = fakeSearch();
    const locate = fakeLocate({ lat: 39.74, lng: -104.99 });
    mount({ createSearch: search.createSearch, locate });
    pill().click();
    typeInto("1226 e 10th");
    expect(search.calls[0]).toMatchObject({
      q: "1226 e 10th",
      bias: { lat: 39.74, lon: -104.99 },
    });
  });

  it("says so when search is unreachable, and still offers saved places", () => {
    const search = fakeSearch();
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.7, lon: -104.9 });
    mount({ createSearch: search.createSearch });
    pill().click();
    typeInto("champa");
    search.emitError("champa");
    expect(q(".home-bar__status")?.textContent).toContain("pick a saved place");
  });
});

describe("the wheels question", () => {
  function toWheels(over: Partial<HomeBarDeps> = {}) {
    const search = fakeSearch();
    const out = mount({ createSearch: search.createSearch, ...over });
    pill().click();
    typeInto("champa");
    search.emitResults([result("1500 Champa St, Denver")], "champa");
    rowNamed("1500 Champa")!.click();
    return out;
  }

  it("is asked only after a destination, never before", () => {
    mount();
    pill().click();
    expect(wheelNamed("Need wheels")).toBeFalsy();
    expect(wheelNamed("Got my own")).toBeFalsy();
  });

  it("echoes the destination back while asking", () => {
    toWheels();
    expect(q(".home-bar__to")?.textContent).toContain("1500 Champa St, Denver");
  });

  it("HAS NO DEFAULT — neither option is preselected or marked primary", () => {
    // Product decision, pinned here on purpose. A preselected "find me a
    // scooter" tells an NIU owner they are the wrong kind of user; a
    // preselected "got my own" hides the fleet from someone who needed it.
    toWheels();
    const need = wheelNamed("Need wheels")!;
    const own = wheelNamed("Got my own")!;
    for (const btn of [need, own]) {
      expect(btn.getAttribute("aria-pressed")).toBeNull();
      expect(btn.className).toBe(own.className);
      expect(btn.hasAttribute("disabled")).toBe(false);
    }
    expect(need.className).toBe(own.className);
  });

  it("hands over the trip once both questions are answered", () => {
    const { planned } = toWheels();
    wheelNamed("Need wheels")!.click();
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      wheels: "need",
      dest: { label: "1500 Champa St, Denver", lat: 39.74, lon: -104.99 },
      start: null,
    });
  });

  it("distinguishes the rider who has their own wheels", () => {
    const { planned } = toWheels();
    wheelNamed("Got my own")!.click();
    expect(planned[0].wheels).toBe("own");
  });

  it("folds back to the pill once a flow takes over", () => {
    toWheels();
    wheelNamed("Got my own")!.click();
    expect(bar!.isOpen()).toBe(false);
  });

  it("lets the rider change their mind about where", () => {
    toWheels();
    root.querySelector<HTMLButtonElement>(".home-bar__linkbtn")!.click();
    expect(wheelNamed("Need wheels")).toBeFalsy();
    expect(input()).toBeTruthy();
  });

  it("remembers the destination as a recent", () => {
    toWheels();
    expect(loadRecentDests().map((d) => d.label)).toEqual(["1500 Champa St, Denver"]);
  });

  it("does not re-record a saved place as a recent", () => {
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.7, lon: -104.9 });
    mount();
    pill().click();
    rowNamed("🏠 Home")!.click();
    // It is a permanent row already; echoing it in shows it twice forever.
    expect(loadRecentDests()).toEqual([]);
  });
});

describe("location is offered, never demanded", () => {
  it("works with no fix at all, and points at the control the rider can press", () => {
    mount({ locate: fakeLocate(null) });
    pill().click();
    const hint = q(".home-bar__hint")!;
    expect(hint.textContent).toContain("Turn on location");
    // Nothing here reads as an error — the rider simply hasn't turned it on.
    expect(hint.textContent).not.toMatch(/error|denied|required|failed/i);
  });

  it("offers naming a start point as the equal alternative", () => {
    mount({ locate: fakeLocate(null) });
    pill().click();
    expect(q(".home-bar__pin")).toBeTruthy();
  });

  it("says where it will start from once a fix lands", () => {
    const locate = fakeLocate(null);
    mount({ locate });
    pill().click();
    locate.emitFix({ lat: 39.74, lng: -104.99 });
    expect(q(".home-bar__hint")?.textContent).toContain("Starting from your location");
  });

  it("a named start point rides along with the trip", () => {
    const search = fakeSearch();
    const { planned } = mount({ createSearch: search.createSearch, locate: fakeLocate(null) });
    pill().click();
    // Name the start...
    q<HTMLButtonElement>(".home-bar__pin")!.click();
    typeInto("union");
    search.emitResults([result("Union Station", { lat: 39.75, lon: -105.0 })], "union");
    rowNamed("Union Station")!.click();
    // ...then the destination.
    typeInto("champa");
    search.emitResults([result("1500 Champa St, Denver")], "champa");
    rowNamed("1500 Champa")!.click();
    wheelNamed("Got my own")!.click();
    expect(planned[0].start).toMatchObject({ label: "Union Station", lat: 39.75 });
    expect(planned[0].dest).toMatchObject({ label: "1500 Champa St, Denver" });
  });
});

describe("map pick", () => {
  it("is offered only when a map is wired", () => {
    mount();
    pill().click();
    expect(rowNamed("Pick a point on the map")).toBeFalsy();
    bar!.destroy();
    root.replaceChildren();
    mount({ pickOnMap: () => Promise.resolve(null) });
    pill().click();
    expect(rowNamed("Pick a point on the map")).toBeTruthy();
  });

  it("folds away while the map is being tapped, then comes back with the pin", async () => {
    let resolve!: (p: { lat: number; lng: number } | null) => void;
    const { planned } = mount({
      pickOnMap: () => new Promise((r) => (resolve = r)),
    });
    pill().click();
    rowNamed("Pick a point on the map")!.click();
    // The sheet covers the bottom half of a phone — half the places a rider
    // might want to tap. This is synchronous with the tap: the picker is
    // invoked a microtask later, so folding away must not wait on it.
    expect(bar!.isOpen()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    resolve({ lat: 39.7485, lng: -104.9498 });
    await new Promise((r) => setTimeout(r, 0));
    expect(wheelNamed("Need wheels")).toBeTruthy();
    wheelNamed("Need wheels")!.click();
    expect(planned[0].dest).toMatchObject({ label: "Dropped pin", lat: 39.7485 });
  });

  it("a cancelled pick returns the rider to where they were", async () => {
    mount({ pickOnMap: () => Promise.resolve(null) });
    pill().click();
    rowNamed("Pick a point on the map")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(bar!.isOpen()).toBe(true);
    expect(wheelNamed("Need wheels")).toBeFalsy();
  });
});

describe("teardown", () => {
  it("stops listening for Escape and for fixes", () => {
    const locate = fakeLocate(null);
    mount({ locate });
    pill().click();
    bar!.destroy();
    bar = null;
    expect(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    ).not.toThrow();
    expect(() => locate.emitFix({ lat: 1, lng: 2 })).not.toThrow();
    expect(document.body.classList.contains("home-bar-open")).toBe(false);
  });
});

describe("storage degradation", () => {
  it("still opens when localStorage is unreadable", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    mount();
    expect(() => pill().click()).not.toThrow();
    expect(bar!.isOpen()).toBe(true);
    getItem.mockRestore();
  });
});

describe("the search box knows when it is done", () => {
  it("is gone once a destination is chosen", () => {
    // An empty "Where are you going?" sitting above the answer to that very
    // question reads as an unfinished form.
    const search = fakeSearch();
    mount({ createSearch: search.createSearch });
    pill().click();
    expect(input().hidden).toBe(false);
    typeInto("champa");
    search.emitResults([result("1500 Champa St, Denver")], "champa");
    rowNamed("1500 Champa")!.click();
    expect(input().hidden).toBe(true);
  });

  it("comes back when the rider changes their mind", () => {
    const search = fakeSearch();
    mount({ createSearch: search.createSearch });
    pill().click();
    typeInto("champa");
    search.emitResults([result("1500 Champa St, Denver")], "champa");
    rowNamed("1500 Champa")!.click();
    root.querySelector<HTMLButtonElement>(".home-bar__linkbtn")!.click();
    expect(input().hidden).toBe(false);
  });
});

describe("the start line knows when it is noise", () => {
  function toWheels(over: Partial<HomeBarDeps> = {}) {
    const search = fakeSearch();
    const out = mount({ createSearch: search.createSearch, ...over });
    pill().click();
    typeInto("champa");
    search.emitResults([result("1500 Champa St, Denver")], "champa");
    rowNamed("1500 Champa")!.click();
    return out;
  }

  it("says nothing about the start when GPS already answers it", () => {
    // "Starting from your location" answers a question nobody asked on a
    // screen about how you are getting there.
    toWheels({ locate: fakeLocate({ lat: 39.74, lng: -104.99 }) });
    expect(q(".home-bar__hint")).toBeNull();
  });

  it("still speaks up when nobody knows where the trip starts", () => {
    // This is the last screen before a route gets planned from that point.
    toWheels({ locate: fakeLocate(null) });
    expect(q(".home-bar__hint")?.textContent).toContain("Turn on location");
  });

  it("says nothing once a start point has been named", () => {
    const search = fakeSearch();
    mount({ createSearch: search.createSearch, locate: fakeLocate(null) });
    pill().click();
    q<HTMLButtonElement>(".home-bar__pin")!.click();
    typeInto("union");
    search.emitResults([result("Union Station", { lat: 39.75, lon: -105.0 })], "union");
    rowNamed("Union Station")!.click();
    typeInto("champa");
    search.emitResults([result("1500 Champa St, Denver")], "champa");
    rowNamed("1500 Champa")!.click();
    expect(q(".home-bar__hint")).toBeNull();
  });
});
