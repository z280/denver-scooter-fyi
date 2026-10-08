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
import { assignSlotPlace, renameSlot } from "./favorite-slots.ts";
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

  it("HAS NO DEFAULT — no option is preselected or marked primary", () => {
    // Product decision, pinned here on purpose. A preselected "find me a
    // scooter" tells an NIU owner they are the wrong kind of user; a
    // preselected "got my own" hides the fleet from someone who needed it.
    // Survived a third option being added, which is when a rule like this is
    // most likely to quietly acquire a "sensible" default.
    toWheels();
    const all = [
      wheelNamed("Need wheels")!,
      wheelNamed("Already started one")!,
      wheelNamed("Got my own")!,
    ];
    for (const btn of all) {
      expect(btn).toBeTruthy();
      expect(btn.getAttribute("aria-pressed")).toBeNull();
      expect(btn.className).toBe(all[0].className);
      expect(btn.hasAttribute("disabled")).toBe(false);
    }
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

describe("there is always a way out", () => {
  it("keeps the close button on the wheels step", () => {
    // It used to live inside the head, which is hidden once the search box
    // has nothing to do — taking the only exit with it.
    const search = fakeSearch();
    mount({ createSearch: search.createSearch });
    pill().click();
    typeInto("champa");
    search.emitResults([result("1500 Champa St, Denver")], "champa");
    rowNamed("1500 Champa")!.click();
    const close = q<HTMLButtonElement>(".home-bar__close")!;
    expect(close).toBeTruthy();
    expect(close.hidden).toBe(false);
    close.click();
    expect(bar!.isOpen()).toBe(false);
  });
});

describe("pinned Home and Work", () => {
  const HOME = { label: "Home", lat: 39.7285, lon: -105.0345 };
  const WORK = { label: "Work", lat: 39.7392, lon: -104.9903 };

  const pins = (): HTMLButtonElement[] =>
    [...root.querySelectorAll<HTMLButtonElement>(".home-bar__quick")];
  const grid = (): HTMLElement | null => q<HTMLElement>(".home-bar__pinned");

  it("shares one row when both are set", async () => {
    mount({ getHomeWork: () => ({ home: HOME, work: WORK }) });
    pill().click();
    await vi.waitFor(() => expect(pins()).toHaveLength(2));
    expect(grid()!.classList.contains("is-pair")).toBe(true);
    expect(pins().map((b) => b.textContent)).toEqual(["🏠Home", "💼Work"]);
  });

  it("NEVER renders a half-width lone button — one set takes the whole row", async () => {
    // The owner's rule, verbatim: "if only one set, whole row, no weird half
    // buttons allowed ever". Asserted on the class the grid template keys
    // off, because that is the only thing that decides the width.
    mount({ getHomeWork: () => ({ home: HOME, work: null }) });
    pill().click();
    await vi.waitFor(() => expect(pins()).toHaveLength(1));
    expect(grid()!.classList.contains("is-single")).toBe(true);
    expect(grid()!.classList.contains("is-pair")).toBe(false);
  });

  it("holds the same rule when it is Work that is set alone", async () => {
    mount({ getHomeWork: () => ({ home: null, work: WORK }) });
    pill().click();
    await vi.waitFor(() => expect(pins()).toHaveLength(1));
    expect(pins()[0].textContent).toBe("💼Work");
    expect(grid()!.classList.contains("is-single")).toBe(true);
  });

  it("renders no row at all when neither is set", async () => {
    mount({ getHomeWork: () => ({ home: null, work: null }) });
    pill().click();
    await new Promise((r) => setTimeout(r, 0));
    // Not an empty row, and not a pair of "set your home" placeholders —
    // they are set in the profile, and prompting here would be a second
    // place to answer the same question.
    expect(grid()).toBeNull();
  });

  it("shows one row per doorstep when the Home SLOT holds the same place", async () => {
    // The duplicate this guards against: a signed-in rider sets Home in the
    // profile (the server columns, which feed the pinned pair) and the account
    // drawer mirrors it into the Home favourite SLOT, which lands in
    // `loadFavorites`. Both halves then render — Home pinned at the top and
    // Home again under "Saved places" — unless the list drops it.
    assignSlotPlace("home", { lat: HOME.lat, lon: HOME.lon });
    mount({ getHomeWork: () => ({ home: HOME, work: null }) });
    pill().click();
    await vi.waitFor(() => expect(pins()).toHaveLength(1));
    const texts = [...root.querySelectorAll(".home-bar__row")].map(
      (r) => r.textContent ?? "",
    );
    expect(texts.filter((t) => t.includes("Home"))).toHaveLength(0);
  });

  it("still lists a saved place that is NOT the pinned one", async () => {
    // The dedupe is by coordinates, not by label: a rider's gym stays listed.
    assignSlotPlace("custom1", { lat: 39.76, lon: -104.88 });
    renameSlot("custom1", "Gym");
    mount({ getHomeWork: () => ({ home: HOME, work: null }) });
    pill().click();
    await vi.waitFor(() => expect(pins()).toHaveLength(1));
    const texts = [...root.querySelectorAll(".home-bar__row")].map(
      (r) => r.textContent ?? "",
    );
    expect(texts.some((t) => t.includes("Gym"))).toBe(true);
  });

  it("picks the destination straight through, without a recents echo", async () => {
    const { planned } = mount({ getHomeWork: () => ({ home: HOME, work: WORK }) });
    pill().click();
    await vi.waitFor(() => expect(pins()).toHaveLength(2));
    pins()[0].click();
    // Destination answered; the wheels question is what comes next.
    expect(planned).toHaveLength(0);
    expect(root.textContent).toContain("Need wheels");
  });

  it("draws the pinned row from the favourite slots, signed out", async () => {
    // It used to come from the signed-in profile over a fetch, so a signed-out
    // rider never got the row at all — despite the slots having always worked
    // without an account. No stubbed loader here on purpose: this is the real
    // default path reading the real store.
    assignSlotPlace("home", { lat: HOME.lat, lon: HOME.lon });
    mount({});
    pill().click();
    // In the FIRST paint, with nothing awaited: device state has nothing to
    // wait for, which is the whole point of reading it here.
    expect(pins()).toHaveLength(1);
    expect(grid()!.textContent).toContain("Home");
  });
});

// ---------------------------------------------------------------------------
// "I've already started one" — the third answer, and the one that can be
// refused.
//
// It is NOT a flavour of "got my own": there is a rental running, so the ride
// is tracked against a specific vehicle and priced, where an own-device ride is
// private and unpriced. Both skip the picker and that is all they share. The
// vehicle comes from a QR scan, which means this is the only answer whose host
// can come back and say "not yet" — and a rider who backs out of a camera has
// not changed their mind about where they are going.
// ---------------------------------------------------------------------------

describe("already started one", () => {
  function toWheels(over: Partial<HomeBarDeps> = {}) {
    const search = fakeSearch();
    const out = mount({ createSearch: search.createSearch, ...over });
    pill().click();
    typeInto("champa");
    search.emitResults([result("1500 Champa St, Denver")], "champa");
    rowNamed("1500 Champa")!.click();
    return out;
  }
  const started = () => wheelNamed("Already started one")!;
  const wheels = () => [
    ...root.querySelectorAll<HTMLButtonElement>(".home-bar__wheel"),
  ];

  it("is offered between the other two", () => {
    toWheels();
    const names = wheels().map((b) => b.textContent ?? "");
    expect(names[0]).toContain("Need wheels");
    expect(names[1]).toContain("Already started one");
    expect(names[2]).toContain("Got my own");
  });

  it("says the scan is coming, rather than springing a camera", () => {
    toWheels();
    expect(started().textContent).toMatch(/scan/i);
  });

  it("hands over its own wheels value, not own's", () => {
    const { planned } = toWheels();
    started().click();
    expect(planned[0].wheels).toBe("started");
    // The distinction the whole option exists for: an own-device ride prices
    // nothing and names no vehicle.
    expect(planned[0].wheels).not.toBe("own");
    expect(planned[0].dest.label).toBe("1500 Champa St, Denver");
  });

  it("keeps the rider's destination when the host refuses", async () => {
    // A cancelled scan. Backing out of a camera is not changing your mind.
    const { planned } = toWheels({ onPlanTrip: () => false });
    started().click();
    expect(planned).toHaveLength(0);
    expect(bar!.isOpen()).toBe(true);
    expect(q(".home-bar__to")?.textContent).toContain("1500 Champa St, Denver");
    // ...and they can answer again, including differently.
    expect(started().hasAttribute("disabled")).toBe(false);
  });

  it("keeps it when the host refuses asynchronously", async () => {
    let settle: (v: boolean) => void = () => {};
    toWheels({
      onPlanTrip: () => new Promise<boolean>((r) => { settle = r; }),
    });
    started().click();
    // Held while the camera is up: an unmarked button over a slow viewfinder
    // reads as a dead one.
    expect(started().hasAttribute("disabled")).toBe(true);
    expect(started().classList.contains("is-working")).toBe(true);

    settle(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(bar!.isOpen()).toBe(true);
    expect(started().hasAttribute("disabled")).toBe(false);
    expect(started().classList.contains("is-working")).toBe(false);
  });

  it("holds EVERY choice while one is pending, so a bounced thumb starts one scan", async () => {
    let calls = 0;
    toWheels({
      onPlanTrip: () => {
        calls += 1;
        return new Promise<boolean>(() => {});
      },
    });
    started().click();
    started().click();
    wheelNamed("Need wheels")!.click();
    expect(calls).toBe(1);
    for (const b of wheels()) expect(b.hasAttribute("disabled")).toBe(true);
  });

  it("folds away when the host takes it", async () => {
    toWheels({ onPlanTrip: () => Promise.resolve(true) });
    started().click();
    await Promise.resolve();
    await Promise.resolve();
    expect(bar!.isOpen()).toBe(false);
  });

  it("stays put when the host throws", () => {
    toWheels({
      onPlanTrip: () => {
        throw new Error("boom");
      },
    });
    started().click();
    // A host that threw has certainly not taken the trip.
    expect(bar!.isOpen()).toBe(true);
    expect(started().hasAttribute("disabled")).toBe(false);
  });

  it("still collapses in the SAME TICK for a synchronous host", () => {
    // Every existing caller returns void. Deferring those by a microtask would
    // leave the bar sitting over a wizard that has already opened — a flicker
    // nobody would be able to place later.
    toWheels();
    wheelNamed("Got my own")!.click();
    expect(bar!.isOpen()).toBe(false);
  });
});
