// The four favourite destinations a rider can set from settings: Home, Work,
// and two they name themselves.
//
// WHY SLOTS, WHEN `favorites.ts` ALREADY EXISTS. That store is the general case
// — any number of saved places, named as you go — and it stays exactly as it
// is. But every way to add to it runs through picking a destination: you save a
// place by going there. There is no way to sit down and say "this is my house",
// and no fixed row a rider can rely on being there. The four slots are that
// fixed part: always present, always in the same order, each one either set or
// visibly empty and asking to be filled.
//
// ONE STORE, NOT TWO. A slot IS a `Favorite`, kept in the same blob under the
// same key, identified by a reserved `id`. So the "Where to?" lists that already
// render favourites pick the slots up with no change to their own logic, a place
// saved as a slot is a place like any other everywhere else in the app, and
// there is no second notion of "saved place" to keep in sync. The alternative —
// a parallel store — would have meant a rider's Home appearing twice in one
// list, which is the bug `favorites.ts` already carries a comment about
// avoiding for the profile's home/work columns.
//
// The reserved ids are stable strings rather than positions, because
// `addFavorite` dedupes by id and a rider who moves house must overwrite their
// Home rather than gain a second one.

import {
  addFavorite,
  loadFavorites,
  removeFavorite,
  saveFavorites,
  type Favorite,
} from "./favorites.ts";

export type FavoriteSlotId = "home" | "work" | "custom1" | "custom2";

export const FAVORITE_SLOT_IDS: readonly FavoriteSlotId[] = [
  "home",
  "work",
  "custom1",
  "custom2",
] as const;

/** The `Favorite.id` a slot occupies. Prefixed so it cannot collide with a
 *  `crypto.randomUUID()` or the `f<base36>` fallback `favorites.ts` mints. */
export function slotFavoriteId(slot: FavoriteSlotId): string {
  return `slot:${slot}`;
}

export function slotOfFavoriteId(id: string): FavoriteSlotId | null {
  if (!id.startsWith("slot:")) return null;
  const rest = id.slice("slot:".length);
  return FAVORITE_SLOT_IDS.includes(rest as FavoriteSlotId)
    ? (rest as FavoriteSlotId)
    : null;
}

export function isSlotFavorite(fav: Favorite): boolean {
  return slotOfFavoriteId(fav.id) !== null;
}

/** What a slot is called and shown as before the rider renames it.
 *
 *  Home and Work are NOT renameable and the two customs are: "Home" and "Work"
 *  are the words the profile's own columns use and the words `favorites.ts`'s
 *  `QUICK_NAMES` chips offer, and a rider who renamed their Home slot to
 *  "Mum's" would then have an app whose other surfaces still say Home. The
 *  customs exist precisely so there is somewhere to put "Mum's". */
export const FAVORITE_SLOT_DEFAULTS: Record<
  FavoriteSlotId,
  { emoji: string; label: string; renameable: boolean; hint: string }
> = {
  home: { emoji: "🏠", label: "Home", renameable: false, hint: "Where you live." },
  work: { emoji: "💼", label: "Work", renameable: false, hint: "Where you work." },
  custom1: {
    emoji: "📍",
    label: "Custom 1",
    renameable: true,
    hint: "Anywhere you go often — name it whatever you call it.",
  },
  custom2: {
    emoji: "📍",
    label: "Custom 2",
    renameable: true,
    hint: "A second one, same idea.",
  },
};

export interface FavoriteSlot {
  id: FavoriteSlotId;
  /** The rider's label when set, else the slot's default name. Always a
   *  non-empty string, so a caller never has to decide what to draw. */
  label: string;
  emoji: string;
  renameable: boolean;
  hint: string;
  /** Null when the slot has no place yet — the empty row that invites a pin. */
  place: { lat: number; lon: number } | null;
}

/** Every slot, set or not, always four long and always in order. */
export function readSlots(favs: readonly Favorite[] = loadFavorites()): FavoriteSlot[] {
  return FAVORITE_SLOT_IDS.map((id) => {
    const def = FAVORITE_SLOT_DEFAULTS[id];
    const fav = favs.find((f) => f.id === slotFavoriteId(id));
    return {
      id,
      // A stored slot's label wins, but only if it still has one: a blank
      // label is the one thing a row cannot render, and `favorites.ts` already
      // refuses to load those, so this is belt-and-braces.
      label: fav && fav.label.trim() ? fav.label : def.label,
      emoji: fav?.emoji || def.emoji,
      renameable: def.renameable,
      hint: def.hint,
      place: fav ? { lat: fav.lat, lon: fav.lon } : null,
    };
  });
}

export function readSlot(
  id: FavoriteSlotId,
  favs: readonly Favorite[] = loadFavorites(),
): FavoriteSlot {
  return readSlots(favs).find((s) => s.id === id)!;
}

/** The set slots only, in slot order — what a "Where to?" list wants. */
export function setSlots(
  favs: readonly Favorite[] = loadFavorites(),
): FavoriteSlot[] {
  return readSlots(favs).filter((s) => s.place !== null);
}

/** Give a slot a place, keeping whatever label it already had.
 *
 *  Returns the new full favourites list, as `favorites.ts`'s own writers do.
 *  `persisted` is false when storage refused the write, so a caller can say the
 *  choice won't outlive the tab rather than claiming it saved. */
export function assignSlotPlace(
  id: FavoriteSlotId,
  place: { lat: number; lon: number },
  label?: string,
): { favorites: Favorite[]; persisted: boolean } {
  const current = loadFavorites();
  const existing = current.find((f) => f.id === slotFavoriteId(id));
  const def = FAVORITE_SLOT_DEFAULTS[id];
  const wanted = (label ?? existing?.label ?? def.label).trim() || def.label;
  const next = addFavorite(current, {
    id: slotFavoriteId(id),
    emoji: existing?.emoji || def.emoji,
    label: wanted,
    lat: place.lat,
    lon: place.lon,
  });
  return { favorites: next, persisted: saveFavorites(next) };
}

/** Rename a slot. Only meaningful for the two customs, and refused for the
 *  other two rather than silently ignored — a caller that offers the control
 *  for Home has a bug, and a no-op return would hide it.
 *
 *  Renaming an EMPTY slot is allowed and stores nothing: there is no favourite
 *  to carry the name, and inventing one at 0,0 would put a row on Null Island
 *  into every destination list. The label is simply not kept until the slot has
 *  a place, which is also when a rider can see it. */
export function renameSlot(
  id: FavoriteSlotId,
  label: string,
): { favorites: Favorite[]; persisted: boolean; applied: boolean } {
  const current = loadFavorites();
  const trimmed = label.trim();
  if (!FAVORITE_SLOT_DEFAULTS[id].renameable || !trimmed) {
    return { favorites: current, persisted: true, applied: false };
  }
  const existing = current.find((f) => f.id === slotFavoriteId(id));
  if (!existing) return { favorites: current, persisted: true, applied: false };
  const next = addFavorite(current, { ...existing, label: trimmed });
  return { favorites: next, persisted: saveFavorites(next), applied: true };
}

/** Empty a slot. The slot itself stays — it is one of four fixed rows — so this
 *  drops the favourite behind it and the row goes back to its default name. */
export function clearSlot(id: FavoriteSlotId): {
  favorites: Favorite[];
  persisted: boolean;
} {
  const next = removeFavorite(loadFavorites(), slotFavoriteId(id));
  return { favorites: next, persisted: saveFavorites(next) };
}

/** Favourites with the four slots first, in slot order, then everything else
 *  untouched.
 *
 *  WHY ORDERING NEEDS SAYING AT ALL. A slot is an ordinary favourite, so the
 *  "Where to?" lists already render one with no code of their own — that is the
 *  point of keeping one store. But `loadFavorites()` returns newest-first, which
 *  is right for places saved as you go and wrong for these: a rider who set Home
 *  in settings and then saved three places on the road would find Home fourth.
 *  The four are meant to be the rows you do not have to look for.
 *
 *  Stable within each group: the slots keep their declared order and the rest
 *  keep the store's, so this only ever lifts the four. */
export function orderedFavorites(
  favs: readonly Favorite[] = loadFavorites(),
): Favorite[] {
  const slots: Favorite[] = [];
  for (const id of FAVORITE_SLOT_IDS) {
    const fav = favs.find((f) => f.id === slotFavoriteId(id));
    if (fav) slots.push(fav);
  }
  return [...slots, ...favs.filter((f) => !isSlotFavorite(f))];
}
