// @vitest-environment happy-dom
//
// Picking a point on the map. The load-bearing behaviours are the two that
// would be invisible until a rider hit them: Escape must cancel the pick
// WITHOUT reaching the drawer's own document-level Escape handler, and the
// listener that makes that possible must not outlive the pick.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMapPick, type PickMap } from "./map-pick.ts";

/** Minimal stand-in for the slice of MapLibre the picker touches. */
function fakeMap(): PickMap & {
  emitClick(lat: number, lng: number): void;
  cursor(): string;
  clickHandlers: number;
} {
  const handlers: ((e: { lngLat: { lat: number; lng: number } }) => void)[] = [];
  const style = { cursor: "" };
  return {
    on(_type, listener) {
      handlers.push(listener);
      return undefined;
    },
    getCanvas: () => ({ style }),
    emitClick(lat, lng) {
      for (const h of handlers) h({ lngLat: { lat, lng } });
    },
    cursor: () => style.cursor,
    get clickHandlers() {
      return handlers.length;
    },
  };
}

const escape = (): boolean =>
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
});

// ---------- picking ----------

describe("picking", () => {
  it("stays in pick mode for the rest of the click that ended it", async () => {
    // THE BUG: onModeChange(false) fired synchronously inside the click, and
    // devices.ts registers its own click handler LATER (main.ts calls
    // addLayers() long after createMapPick), so MapLibre ran it next — with
    // popup suppression already lifted. Tapping the map to drop a pin on a
    // dense block opened a scooter popup over the pin.
    const map = fakeMap();
    const seen: boolean[] = [];
    const pick = createMapPick(map, { onModeChange: (on) => void seen.push(on) });
    const pending = pick.pick();
    map.emitClick(1, 2);
    // Same tick as the click: still suppressing.
    expect(seen).toEqual([true]);
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([true, false]);
  });

  it("resolves with the tapped point and restores the cursor", async () => {
    const map = fakeMap();
    const pick = createMapPick(map);

    const pending = pick.pick();
    expect(pick.isPicking()).toBe(true);
    expect(map.cursor()).toBe("crosshair");

    map.emitClick(39.7392, -104.9903);
    await expect(pending).resolves.toEqual({ lat: 39.7392, lng: -104.9903 });
    expect(pick.isPicking()).toBe(false);
    expect(map.cursor()).toBe("");
  });

  it("registers its map handler once, and ignores taps when idle", () => {
    const map = fakeMap();
    const pick = createMapPick(map);
    expect(map.clickHandlers).toBe(1);

    // Not picking: a tap must do nothing at all.
    map.emitClick(1, 2);
    expect(pick.isPicking()).toBe(false);

    void pick.pick();
    void pick.pick();
    expect(map.clickHandlers).toBe(1);
  });

  it("announces entering and leaving the mode", async () => {
    const onModeChange = vi.fn();
    const map = fakeMap();
    const pick = createMapPick(map, { onModeChange });

    const pending = pick.pick();
    expect(onModeChange).toHaveBeenLastCalledWith(true);
    map.emitClick(1, 2);
    await pending;
    // Leaving pick mode is deferred one task on purpose (see teardown): the
    // device layers' click handler is registered after this one and would
    // otherwise open a popup on top of the point just chosen. So the promise
    // resolves BEFORE the mode is announced as over.
    expect(onModeChange).toHaveBeenLastCalledWith(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(onModeChange).toHaveBeenLastCalledWith(false);
  });

  it("shows an instruction bar with the caller's wording, and removes it", async () => {
    const map = fakeMap();
    const pick = createMapPick(map);

    const pending = pick.pick({ hint: "Tap the map to set your home" });
    const bar = document.getElementById("map-pick-bar");
    expect(bar?.textContent).toContain("Tap the map to set your home");

    map.emitClick(1, 2);
    await pending;
    expect(document.getElementById("map-pick-bar")).toBeNull();
  });

  it("cancels from the bar's own button", async () => {
    const map = fakeMap();
    const pick = createMapPick(map);
    const pending = pick.pick();

    document
      .querySelector<HTMLButtonElement>(".map-pick-bar__cancel")!
      .click();
    await expect(pending).resolves.toBeNull();
  });

  it("supersedes a pending pick rather than leaving it hanging", async () => {
    const map = fakeMap();
    const pick = createMapPick(map);

    const first = pick.pick();
    const second = pick.pick();
    await expect(first).resolves.toBeNull();

    map.emitClick(3, 4);
    await expect(second).resolves.toEqual({ lat: 3, lng: 4 });
  });
});

// ---------- Escape, and the drawer it must not close ----------

describe("Escape", () => {
  it("cancels the pick", async () => {
    const map = fakeMap();
    const pick = createMapPick(map);
    const pending = pick.pick();

    escape();
    await expect(pending).resolves.toBeNull();
    expect(map.cursor()).toBe("");
  });

  it("does not reach a document handler like the drawer's close-on-Escape", () => {
    const drawerWouldClose = vi.fn();
    // The drawer listens in the bubble phase on document, as wireDrawers does.
    document.addEventListener("keydown", drawerWouldClose);

    const map = fakeMap();
    const pick = createMapPick(map);
    void pick.pick();

    escape();
    expect(drawerWouldClose).not.toHaveBeenCalled();

    document.removeEventListener("keydown", drawerWouldClose);
  });

  it("stops swallowing Escape the moment the pick ends", async () => {
    const drawerWouldClose = vi.fn();
    document.addEventListener("keydown", drawerWouldClose);

    const map = fakeMap();
    const pick = createMapPick(map);
    const pending = pick.pick();
    map.emitClick(1, 2);
    await pending;

    escape();
    // The drawer's Escape works again — the picker is out of the way.
    expect(drawerWouldClose).toHaveBeenCalledTimes(1);

    document.removeEventListener("keydown", drawerWouldClose);
  });

  it("adds its document listener only while a pick is pending", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    const addSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation(((type: string, ...rest: unknown[]) => {
        added.push(type);
        return (origAdd as (...a: unknown[]) => void)(type, ...rest);
      }) as typeof document.addEventListener);
    const removeSpy = vi
      .spyOn(document, "removeEventListener")
      .mockImplementation(((type: string, ...rest: unknown[]) => {
        removed.push(type);
        return (origRemove as (...a: unknown[]) => void)(type, ...rest);
      }) as typeof document.removeEventListener);

    const map = fakeMap();
    const pick = createMapPick(map);
    expect(added).toHaveLength(0); // nothing until a pick starts

    const pending = pick.pick();
    expect(added).toEqual(["keydown"]);

    map.emitClick(1, 2);
    await pending;
    expect(removed).toEqual(["keydown"]);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

// ---------- teardown ----------

describe("teardown", () => {
  it("resolves a pending pick and refuses new ones after dispose", async () => {
    const map = fakeMap();
    const pick = createMapPick(map);
    const pending = pick.pick();

    pick.dispose();
    await expect(pending).resolves.toBeNull();
    expect(document.getElementById("map-pick-bar")).toBeNull();

    await expect(pick.pick()).resolves.toBeNull();
    expect(pick.isPicking()).toBe(false);
  });
});
