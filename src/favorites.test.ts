// @vitest-environment happy-dom
//
// Saved places — the local store behind Screen 3's "Saved places" section.
// Covers the list rules (newest first, replace-don't-duplicate, cap), the
// same-place tolerance that keeps a rider's own house off the list twice, and
// the storage discipline every UI-pref module here follows: a corrupt or
// version-skewed blob degrades to "no favorites" instead of throwing.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAVORITES_KEY,
  MAX_FAVORITES,
  addFavorite,
  defaultEmoji,
  forgetFavorite,
  isFavorited,
  isSamePlace,
  loadFavorites,
  recordFavorite,
  removeFavorite,
  type Favorite,
} from "./favorites.ts";

function fav(label: string, lat = 39.74, lon = -104.99): Favorite {
  return { id: `id-${label}`, emoji: "📍", label, lat, lon };
}

beforeEach(() => {
  localStorage.clear();
});

describe("list rules", () => {
  it("puts the place just saved at the top", () => {
    const next = addFavorite([fav("Work", 39.75, -104.98)], {
      emoji: "🏠",
      label: "Home",
      lat: 39.74,
      lon: -104.99,
    });
    expect(next.map((f) => f.label)).toEqual(["Home", "Work"]);
  });

  it("replaces rather than duplicates when the same place is saved again", () => {
    // A rider renaming their house, not acquiring a second one.
    const existing = [fav("Home", 39.74, -104.99)];
    const next = addFavorite(existing, {
      emoji: "🏠",
      label: "casa",
      lat: 39.74, // same doorstep
      lon: -104.99,
    });
    expect(next).toHaveLength(1);
    expect(next[0].label).toBe("casa");
  });

  it("replaces rather than duplicates when a name is reused for a new place", () => {
    // Moving house must not leave two rows both called Home.
    const next = addFavorite([fav("Home", 39.74, -104.99)], {
      emoji: "🏠",
      label: "home", // same name, different case
      lat: 39.8,
      lon: -105.05,
    });
    expect(next).toHaveLength(1);
    expect(next[0].lat).toBe(39.8);
  });

  it("caps the list", () => {
    let list: Favorite[] = [];
    for (let i = 0; i < MAX_FAVORITES + 5; i += 1) {
      list = addFavorite(list, {
        emoji: "📍",
        label: `place ${i}`,
        lat: 39.7 + i / 1000,
        lon: -104.9 - i / 1000,
      });
    }
    expect(list).toHaveLength(MAX_FAVORITES);
    expect(list[0].label).toBe(`place ${MAX_FAVORITES + 4}`);
  });

  it("forgets by id", () => {
    const list = [fav("Home", 39.74, -104.99), fav("Work", 39.75, -104.98)];
    expect(removeFavorite(list, "id-Home").map((f) => f.label)).toEqual(["Work"]);
  });

  it("gives every saved place an id without being handed one", () => {
    const next = addFavorite([], {
      emoji: "📍",
      label: "Gazebo",
      lat: 39.75,
      lon: -104.95,
    });
    expect(next[0].id).toBeTruthy();
  });
});

describe("same place", () => {
  it("treats a few metres apart as the same doorstep", () => {
    // The profile's Home and a locally-saved Home will never be bit-identical;
    // if they did not collapse, the rider would see their own house twice.
    expect(
      isSamePlace({ lat: 39.7319, lon: -104.9721 }, { lat: 39.73195, lon: -104.97205 }),
    ).toBe(true);
  });

  it("keeps two doors on the same block apart", () => {
    expect(
      isSamePlace({ lat: 39.7319, lon: -104.9721 }, { lat: 39.7331, lon: -104.9721 }),
    ).toBe(false);
  });

  it("answers whether a place is already saved", () => {
    const list = [fav("Home", 39.74, -104.99)];
    expect(isFavorited(list, { lat: 39.74001, lon: -104.99001 })).toBe(true);
    expect(isFavorited(list, { lat: 39.8, lon: -105.05 })).toBe(false);
  });
});

describe("storage", () => {
  it("round-trips through real localStorage", () => {
    recordFavorite({ emoji: "🏠", label: "Home", lat: 39.74, lon: -104.99 });
    expect(loadFavorites().map((f) => f.label)).toEqual(["Home"]);
  });

  it("forgets through real localStorage", () => {
    const saved = recordFavorite({
      emoji: "🏠",
      label: "Home",
      lat: 39.74,
      lon: -104.99,
    });
    expect(forgetFavorite(saved[0].id)).toEqual([]);
    expect(loadFavorites()).toEqual([]);
  });

  it("degrades to no favorites on a corrupt blob", () => {
    localStorage.setItem(FAVORITES_KEY, "{not json");
    expect(loadFavorites()).toEqual([]);
  });

  it("degrades to no favorites on a version it does not know", () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify({ v: 2, favs: [fav("Home")] }));
    expect(loadFavorites()).toEqual([]);
  });

  it("drops individual entries that are not usable", () => {
    // A saved place with no coordinates would route the rider to NaN.
    localStorage.setItem(
      FAVORITES_KEY,
      JSON.stringify({
        v: 1,
        favs: [
          fav("Good"),
          { id: "x", emoji: "📍", label: "No position" },
          { id: "y", emoji: "📍", label: "", lat: 1, lon: 2 },
        ],
      }),
    );
    expect(loadFavorites().map((f) => f.label)).toEqual(["Good"]);
  });

  it("survives storage being unavailable", () => {
    // Private mode: the save cannot persist, but it must not throw and lose
    // the rider their place mid-flow.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    expect(() =>
      recordFavorite({ emoji: "📍", label: "Gazebo", lat: 39.75, lon: -104.95 }),
    ).not.toThrow();
    setItem.mockRestore();
  });
});

describe("default glyph", () => {
  it("follows what the geocoder said the place is", () => {
    expect(defaultEmoji("house")).toBe("🏠");
    expect(defaultEmoji("locality")).toBe("🏙️");
    expect(defaultEmoji(undefined)).toBe("📍");
  });
});

describe("a session where storage refuses writes (Copilot, PR #74)", () => {
  it("keeps earlier saves visible for the rest of the visit", () => {
    // THE BUG: `persistFavorites` swallowed the failure, but `recordFavorite`
    // re-reads `loadFavorites()` on every save. So in private mode the second
    // save read back an EMPTY store and returned a list containing only the
    // newest place — the rider watched a favourite they had just saved
    // disappear, with no error and nothing to retry.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });

    const first = recordFavorite({
      label: "Home", emoji: "🏠", lat: 39.7285, lon: -105.0345,
    });
    expect(first.map((f) => f.label)).toEqual(["Home"]);

    const second = recordFavorite({
      label: "Work", emoji: "💼", lat: 39.7392, lon: -104.9903,
    });
    // BOTH, newest first — not just "Work".
    expect(second.map((f) => f.label)).toEqual(["Work", "Home"]);
    expect(loadFavorites().map((f) => f.label)).toEqual(["Work", "Home"]);

    setItem.mockRestore();
  });

  it("goes back to trusting storage the moment a write succeeds", () => {
    // The mirror must not outlive the outage, or a later read serves a stale
    // copy of a list that has since been written properly.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException("QuotaExceededError");
      });

    recordFavorite({ label: "Home", emoji: "🏠", lat: 39.7285, lon: -105.0345 });
    // This one lands.
    recordFavorite({ label: "Work", emoji: "💼", lat: 39.7392, lon: -104.9903 });
    setItem.mockRestore();

    // Storage now holds both; a fresh read comes from it, not the mirror.
    localStorage.setItem(
      FAVORITES_KEY,
      JSON.stringify({ v: 1, favs: [] }),
    );
    expect(loadFavorites()).toEqual([]);
  });
});
