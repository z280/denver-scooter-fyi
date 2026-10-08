// @vitest-environment happy-dom
//
// The assertions that matter here are the refusals and the merge direction.
// This module's two ways of failing quietly are a sync that wipes a rider's
// account from a fresh install, and a push loop that fires once per page load
// forever — neither of which looks like an error from the outside.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetSavedPlacesSyncForTests,
  cleanPlaces,
  mergePlaces,
  reconcileSavedPlaces,
  samePlaces,
  startSavedPlacesSync,
  syncSavedPlacesFromProfile,
} from "./saved-places-sync.ts";
import {
  _resetFavoritesForTests,
  loadFavorites,
  recordFavorite,
  saveFavorites,
  type Favorite,
} from "./favorites.ts";
import type { SavedPlace } from "./api.ts";

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
  _resetFavoritesForTests();
  _resetSavedPlacesSyncForTests();
});

const place = (over: Partial<Favorite> = {}): Favorite => ({
  id: "slot:home",
  label: "Home",
  emoji: "🏠",
  lat: 39.7285,
  lon: -105.0345,
  ...over,
});

const deps = (signedIn = true) => ({
  signedIn: () => signedIn,
  push: vi.fn().mockResolvedValue(undefined),
});

describe("validation on the way in", () => {
  it("accepts an ordinary place", () => {
    expect(cleanPlaces([place()])).toEqual([place()]);
  });

  it.each([
    ["not an array", "nope"],
    ["null", null],
  ])("treats %s as nothing", (_label, bad) => {
    expect(cleanPlaces(bad)).toEqual([]);
  });

  it("drops bad rows rather than refusing the list", () => {
    // One unparseable entry from an older build must not cost a rider every
    // other place they saved.
    const out = cleanPlaces([
      place(),
      "junk",
      { id: "x" },
      place({ id: "gym", label: "Gym" }),
    ]);
    expect(out.map((f) => f.id)).toEqual(["slot:home", "gym"]);
  });

  it("range-checks coordinates rather than merely parsing them", () => {
    // 412 is not a latitude, and storing it means a map somewhere later tries
    // to fly to it.
    expect(cleanPlaces([place({ lat: 412 })])).toEqual([]);
    expect(cleanPlaces([place({ lon: -999 })])).toEqual([]);
  });

  it("dedupes on id, first row winning", () => {
    const out = cleanPlaces([place({ label: "First" }), place({ label: "Second" })]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("First");
  });
});

describe("samePlaces", () => {
  it("ignores order, because the two sides keep different ones", () => {
    // `favorites.ts` is newest-first and the server keeps insertion order.
    // Comparing order would make every reconcile look like a change and push
    // on every page load.
    const a = place();
    const b = place({ id: "gym", label: "Gym" });
    expect(samePlaces([a, b], [b, a])).toBe(true);
  });

  it("notices a moved house", () => {
    expect(samePlaces([place()], [place({ lat: 40 })])).toBe(false);
  });

  it("notices a rename and a different length", () => {
    expect(samePlaces([place()], [place({ label: "Casa" })])).toBe(false);
    expect(samePlaces([place()], [])).toBe(false);
  });
});

describe("the merge rule", () => {
  it("keeps the local row when both sides have that id", () => {
    // THE ONE THAT WOULD HURT SOMEBODY: a rider who moved house and updated
    // Home on this phone must not have the move undone by another device that
    // still remembers the old address.
    const merged = mergePlaces([place({ lat: 40, lon: -106 })], [place()]);
    expect(merged).toEqual([place({ lat: 40, lon: -106 })]);
  });

  it("adopts every id the server has and this device does not", () => {
    const merged = mergePlaces([place()], [place({ id: "gym", label: "Gym" })]);
    expect(merged.map((f) => f.id)).toEqual(["slot:home", "gym"]);
  });

  it("gives a fresh install the whole account", () => {
    // The case that decides the rule's direction: an empty local list is all
    // gaps, so the other way round would wipe the account.
    expect(mergePlaces([], [place(), place({ id: "gym", label: "Gym" })])).toHaveLength(2);
  });
});

describe("reconcile", () => {
  it("does nothing at all when the field was absent", () => {
    // An older deployment. "This server does not know about saved places" is
    // not "the rider has none", and treating them alike would read silence as
    // an empty account.
    saveFavorites([place()]);
    expect(reconcileSavedPlaces(undefined)).toBeNull();
    expect(loadFavorites()).toHaveLength(1);
  });

  it("pulls the server's places into the local store", () => {
    const result = reconcileSavedPlaces([place() as SavedPlace]);
    expect(result).toMatchObject({ pulled: true, needsPush: false });
    expect(loadFavorites().map((f) => f.id)).toEqual(["slot:home"]);
  });

  it("asks for a push when this device has something the server lacks", () => {
    saveFavorites([place({ id: "gym", label: "Gym" })]);
    const result = reconcileSavedPlaces([place() as SavedPlace]);
    expect(result).toMatchObject({ pulled: true, needsPush: true });
    expect(result!.places).toHaveLength(2);
  });

  it("is a no-op when the two sides already agree", () => {
    saveFavorites([place()]);
    expect(reconcileSavedPlaces([place() as SavedPlace])).toMatchObject({
      pulled: false,
      needsPush: false,
    });
  });
});

describe("the mirror", () => {
  it("pushes a local edit while signed in", async () => {
    const d = deps(true);
    startSavedPlacesSync(d);
    recordFavorite({ emoji: "🏋️", label: "Gym", lat: 39.7, lon: -105 });
    await vi.waitFor(() => expect(d.push).toHaveBeenCalledTimes(1));
    expect(d.push.mock.calls[0][0][0]).toMatchObject({ label: "Gym" });
  });

  it("stays silent signed out", () => {
    const d = deps(false);
    startSavedPlacesSync(d);
    recordFavorite({ emoji: "🏋️", label: "Gym", lat: 39.7, lon: -105 });
    expect(d.push).not.toHaveBeenCalled();
  });

  it("does not echo the list the server just gave us", () => {
    // Without the guard this fires once per page load, forever.
    const d = deps(true);
    startSavedPlacesSync(d);
    syncSavedPlacesFromProfile([place() as SavedPlace], d);
    expect(d.push).not.toHaveBeenCalled();
  });

  it("sends nothing for a local write that changed nothing", () => {
    // The other half of the echo guard, and the half the `applying` flag does
    // NOT cover: plenty of ordinary actions re-write an identical list —
    // renaming a slot to the name it already has, or re-pinning a place to the
    // coordinates it is already at. Each one is a PUT of a list the server
    // already holds.
    const d = deps(true);
    startSavedPlacesSync(d);
    syncSavedPlacesFromProfile([place() as SavedPlace], d);
    saveFavorites([place()]);
    expect(d.push).not.toHaveBeenCalled();

    // And it is a guard, not a mute: a real change still goes.
    saveFavorites([place({ label: "Casa" })]);
    expect(d.push).toHaveBeenCalledTimes(1);
  });

  it("pushes the union exactly once when both sides had something", () => {
    // The reconcile writes locally, which fires the hook — so without the
    // applying flag this races two PUTs of the same list.
    saveFavorites([place({ id: "gym", label: "Gym" })]);
    const d = deps(true);
    startSavedPlacesSync(d);
    const result = syncSavedPlacesFromProfile([place() as SavedPlace], d);
    expect(result!.places).toHaveLength(2);
    expect(d.push).toHaveBeenCalledTimes(1);
    expect(d.push.mock.calls[0][0]).toHaveLength(2);
  });

  it("pushes a deletion made while signed in", async () => {
    const d = deps(true);
    startSavedPlacesSync(d);
    syncSavedPlacesFromProfile(
      [place() as SavedPlace, place({ id: "gym", label: "Gym" }) as SavedPlace],
      d,
    );
    d.push.mockClear();
    saveFavorites([place()]);
    await vi.waitFor(() => expect(d.push).toHaveBeenCalledTimes(1));
    expect(d.push.mock.calls[0][0]).toHaveLength(1);
  });

  it("re-pushes after a failed push instead of believing it landed", async () => {
    // A swallowed rejection that also marked the list as synced would mean the
    // rider's next edit compared against a server state that never existed.
    const d = {
      signedIn: () => true,
      push: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined),
    };
    startSavedPlacesSync(d);
    saveFavorites([place()]);
    await vi.waitFor(() => expect(d.push).toHaveBeenCalledTimes(1));
    // Same list again: normally an echo, but the first push failed, so we no
    // longer know what the server has and must send it.
    saveFavorites([place()]);
    await vi.waitFor(() => expect(d.push).toHaveBeenCalledTimes(2));
  });

  it("sends the five wire fields and nothing else", () => {
    const d = deps(true);
    startSavedPlacesSync(d);
    saveFavorites([place()]);
    expect(Object.keys(d.push.mock.calls[0][0][0]).sort()).toEqual([
      "emoji",
      "id",
      "label",
      "lat",
      "lon",
    ]);
  });

  it("still mirrors when local storage refused the write", async () => {
    // Private browsing is exactly the case where the rider's places only
    // survive if the account has them.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
      clear: () => {},
    });
    const d = deps(true);
    startSavedPlacesSync(d);
    expect(saveFavorites([place()])).toBe(false);
    await vi.waitFor(() => expect(d.push).toHaveBeenCalledTimes(1));
  });
});
