import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAVORITES_KEY,
  _resetFavoritesForTests,
  loadFavorites,
  recordFavorite,
} from "./favorites.ts";
import {
  FAVORITE_SLOT_IDS,
  assignSlotPlace,
  clearSlot,
  isSlotFavorite,
  orderedFavorites,
  readSlot,
  readSlots,
  renameSlot,
  setSlots,
  slotFavoriteId,
  slotOfFavoriteId,
} from "./favorite-slots.ts";

const fakeStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  // `favorites.ts` keeps a session mirror for the case where storage refuses
  // writes, and it is module state: without this, the quota-failure case below
  // leaves it populated and every later test reads the mirror instead of the
  // storage it just arranged.
  _resetFavoritesForTests();
});

describe("slot identity", () => {
  it("round-trips every slot id through its reserved favourite id", () => {
    for (const id of FAVORITE_SLOT_IDS) {
      expect(slotOfFavoriteId(slotFavoriteId(id))).toBe(id);
    }
  });

  it("does not claim an ordinary favourite's id", () => {
    // `favorites.ts` mints a UUID, or `f<base36>` where crypto is absent.
    expect(slotOfFavoriteId("0f8c7a6e-1111-2222-3333-444455556666")).toBeNull();
    expect(slotOfFavoriteId("fabc123xyz")).toBeNull();
    // A near miss must not resolve either.
    expect(slotOfFavoriteId("slot:kitchen")).toBeNull();
    expect(slotOfFavoriteId("slot:")).toBeNull();
  });
});

describe("reading slots", () => {
  it("always returns all four, in order, set or not", () => {
    const slots = readSlots();
    expect(slots.map((s) => s.id)).toEqual(["home", "work", "custom1", "custom2"]);
    expect(slots.every((s) => s.place === null)).toBe(true);
    // An unset slot still has something to draw.
    expect(slots.map((s) => s.label)).toEqual(["Home", "Work", "Custom 1", "Custom 2"]);
  });

  it("only Home and Work refuse renaming", () => {
    const renameable = Object.fromEntries(
      readSlots().map((s) => [s.id, s.renameable]),
    );
    expect(renameable).toEqual({
      home: false,
      work: false,
      custom1: true,
      custom2: true,
    });
  });

  it("reports only the set slots for a destination list, in slot order", () => {
    assignSlotPlace("custom2", { lat: 39.75, lon: -104.99 });
    assignSlotPlace("home", { lat: 39.7, lon: -104.9 });
    // Insertion order was custom2 first; slot order still wins, because the
    // four rows are fixed and a destination list must not reshuffle them.
    expect(setSlots().map((s) => s.id)).toEqual(["home", "custom2"]);
  });
});

describe("assigning a place", () => {
  it("stores the slot as an ordinary favourite under its reserved id", () => {
    const { favorites, persisted } = assignSlotPlace("home", { lat: 39.7, lon: -104.9 });
    expect(persisted).toBe(true);
    const fav = favorites.find((f) => f.id === "slot:home")!;
    expect(fav).toMatchObject({ label: "Home", emoji: "🏠", lat: 39.7, lon: -104.9 });
    // ONE store, so it is readable through favorites.ts with no special case —
    // which is exactly how the "Where to?" lists pick it up unchanged.
    expect(loadFavorites().some((f) => f.id === "slot:home")).toBe(true);
    expect(isSlotFavorite(fav)).toBe(true);
  });

  it("moving house overwrites the slot instead of adding a second Home", () => {
    assignSlotPlace("home", { lat: 39.7, lon: -104.9 });
    assignSlotPlace("home", { lat: 40.1, lon: -105.2 });
    const homes = loadFavorites().filter((f) => f.id === "slot:home");
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatchObject({ lat: 40.1, lon: -105.2 });
    expect(readSlot("home").place).toEqual({ lat: 40.1, lon: -105.2 });
  });

  it("keeps a custom slot's chosen name when its place moves", () => {
    assignSlotPlace("custom1", { lat: 39.7, lon: -104.9 });
    renameSlot("custom1", "Gym");
    assignSlotPlace("custom1", { lat: 39.8, lon: -104.8 });
    expect(readSlot("custom1").label).toBe("Gym");
  });

  it("leaves an unrelated favourite alone", () => {
    recordFavorite({ emoji: "📍", label: "the gazebo", lat: 39.73, lon: -104.98 });
    assignSlotPlace("work", { lat: 39.7, lon: -104.9 });
    expect(loadFavorites().some((f) => f.label === "the gazebo")).toBe(true);
  });
});

describe("renaming", () => {
  it("renames a custom slot that has a place", () => {
    assignSlotPlace("custom1", { lat: 39.7, lon: -104.9 });
    const { applied } = renameSlot("custom1", "  Gym  ");
    expect(applied).toBe(true);
    expect(readSlot("custom1").label).toBe("Gym");
  });

  it("refuses Home and Work rather than silently ignoring the caller", () => {
    assignSlotPlace("home", { lat: 39.7, lon: -104.9 });
    const { applied } = renameSlot("home", "Mum's");
    // A caller that offers Rename for Home has a bug, and a no-op `true` would
    // hide it. The other surfaces still say "Home", so renaming it here would
    // leave the app disagreeing with itself.
    expect(applied).toBe(false);
    expect(readSlot("home").label).toBe("Home");
  });

  it("refuses a blank name", () => {
    assignSlotPlace("custom1", { lat: 39.7, lon: -104.9 });
    expect(renameSlot("custom1", "   ").applied).toBe(false);
    expect(readSlot("custom1").label).toBe("Custom 1");
  });

  it("stores nothing for an empty slot", () => {
    // There is no favourite to carry the name, and inventing one at 0,0 would
    // put a row on Null Island into every destination list.
    expect(renameSlot("custom1", "Gym").applied).toBe(false);
    expect(loadFavorites()).toHaveLength(0);
    expect(readSlot("custom1").place).toBeNull();
  });
});

describe("clearing", () => {
  it("empties the slot but keeps the row", () => {
    assignSlotPlace("custom1", { lat: 39.7, lon: -104.9 });
    renameSlot("custom1", "Gym");
    clearSlot("custom1");
    const slot = readSlot("custom1");
    expect(slot.place).toBeNull();
    // Back to its default name: the label lived on the favourite that is gone.
    expect(slot.label).toBe("Custom 1");
    expect(readSlots()).toHaveLength(4);
  });

  it("leaves the other slots and ordinary favourites untouched", () => {
    assignSlotPlace("home", { lat: 39.7, lon: -104.9 });
    assignSlotPlace("work", { lat: 39.8, lon: -104.8 });
    recordFavorite({ emoji: "📍", label: "the gazebo", lat: 39.73, lon: -104.98 });
    clearSlot("home");
    expect(readSlot("home").place).toBeNull();
    expect(readSlot("work").place).toEqual({ lat: 39.8, lon: -104.8 });
    expect(loadFavorites().some((f) => f.label === "the gazebo")).toBe(true);
  });
});

describe("storage refusing writes", () => {
  it("reports it rather than claiming the slot saved", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    });
    const { persisted, favorites } = assignSlotPlace("home", { lat: 39.7, lon: -104.9 });
    expect(persisted).toBe(false);
    // Still correct for THIS visit — favorites.ts holds a session mirror — so
    // the rider's tap is not lost, only unremembered.
    expect(favorites.some((f) => f.id === "slot:home")).toBe(true);
  });
});

describe("corrupt storage", () => {
  it("degrades to four empty slots", () => {
    localStorage.setItem(FAVORITES_KEY, "{not json");
    expect(readSlots()).toHaveLength(4);
    expect(setSlots()).toHaveLength(0);
  });
});

describe("ordering for the destination lists", () => {
  it("puts the four slots first, in slot order, whatever the store's order", () => {
    // Saved on the road AFTER the slots, so the store returns them first.
    assignSlotPlace("work", { lat: 39.8, lon: -104.8 });
    assignSlotPlace("home", { lat: 39.7, lon: -104.9 });
    recordFavorite({ emoji: "📍", label: "the gazebo", lat: 39.73, lon: -104.98 });
    recordFavorite({ emoji: "📍", label: "the bakery", lat: 39.74, lon: -104.97 });

    expect(orderedFavorites().map((f) => f.label)).toEqual([
      "Home",
      "Work",
      "the bakery",
      "the gazebo",
    ]);
  });

  it("leaves a list with no slots exactly as it found it", () => {
    recordFavorite({ emoji: "📍", label: "first", lat: 39.73, lon: -104.98 });
    recordFavorite({ emoji: "📍", label: "second", lat: 39.74, lon: -104.97 });
    const before = loadFavorites().map((f) => f.label);
    expect(orderedFavorites().map((f) => f.label)).toEqual(before);
  });

  it("drops a slot out of the lead once it is cleared", () => {
    assignSlotPlace("home", { lat: 39.7, lon: -104.9 });
    recordFavorite({ emoji: "📍", label: "the gazebo", lat: 39.73, lon: -104.98 });
    expect(orderedFavorites()[0].label).toBe("Home");

    clearSlot("home");
    expect(orderedFavorites().map((f) => f.label)).toEqual(["the gazebo"]);
  });
});
