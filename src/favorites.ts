// Saved places a rider names themselves — "Home", "Work", "the gazebo".
//
// WHY LOCAL. Home and Work already exist, but as two fixed columns on the
// signed-in profile (`home_lat`/`work_lat`), which means a signed-out rider
// has no saved places at all and nobody has a third one. This store is the
// general case: any number, any name, and no account required. Same storage
// discipline as `recent-dests` and `filter-presets` — versioned blob, every
// read validated, every read/write try/catch wrapped, and a corrupt or
// version-skewed blob degrades to "no favorites" rather than throwing.
//
// It does NOT replace profile home/work. Those are still the rows a signed-in
// rider gets on a new device, and they draw the map pins. Screen 3 shows both
// and dedupes by position, so a rider who has set both sees one Home.
//
// The cap is what fits on a phone without a scroll: past a dozen, a saved
// place is slower to find than to retype, and the recents list already covers
// "somewhere I went once".

export const FAVORITES_KEY = "scooter-fyi-favorites";
export const MAX_FAVORITES = 12;

/** How close two saved points must be to count as the same place. ~11 m at
 *  Denver's latitude — tight enough to keep two doors on a block apart, loose
 *  enough that the profile's Home and a locally-saved Home collapse into one
 *  row instead of showing the rider their own house twice. */
export const SAME_PLACE_DEGREES = 0.0001;

export interface Favorite {
  id: string;
  /** Leading glyph, so a list of saved places is scannable at a glance. */
  emoji: string;
  /** The rider's own words. This is what Screens 4/6 echo back ("to Home"),
   *  which is the whole reason naming exists — "1226 E 10th Ave, Denver" is
   *  not what anyone calls their house. */
  label: string;
  lat: number;
  lon: number;
}

interface StoredFavorites {
  v: 1;
  favs: Favorite[];
}

function isValidFavorite(f: unknown): f is Favorite {
  if (!f || typeof f !== "object") return false;
  const r = f as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.emoji === "string" &&
    typeof r.label === "string" &&
    r.label.trim().length > 0 &&
    typeof r.lat === "number" &&
    Number.isFinite(r.lat) &&
    typeof r.lon === "number" &&
    Number.isFinite(r.lon)
  );
}

/** The session's own copy, used ONLY when storage refuses writes.
 *
 *  Null while storage is working, which is the normal case: storage is then
 *  the single source of truth and a mirror could only drift from it.
 *
 *  It exists because `persistFavorites` swallowing a failure was not enough
 *  to keep the promise its own comment makes ("the pick still works this
 *  visit"). It did not: `recordFavorite` re-reads `loadFavorites()` on every
 *  save, so in private mode the second save read back the empty store and
 *  returned a list containing only the newest place — quietly dropping one
 *  the rider had just watched appear. Found by Copilot on PR #74. */
let sessionFavs: Favorite[] | null = null;

export function loadFavorites(): Favorite[] {
  if (sessionFavs !== null) return sessionFavs.slice();
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as StoredFavorites;
    if (blob?.v !== 1 || !Array.isArray(blob.favs)) return [];
    return blob.favs.filter(isValidFavorite).slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

function persistFavorites(favs: Favorite[]): boolean {
  try {
    const blob: StoredFavorites = { v: 1, favs };
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(blob));
    // Storage is truth again — drop any mirror so a later read cannot serve
    // a stale copy of a list that has since been written properly.
    sessionFavs = null;
    return true;
  } catch {
    // Private mode or quota. Hold the list in memory so the rest of THIS
    // visit stays coherent: without it the next save re-reads an empty
    // store and the rider watches an earlier favourite disappear.
    sessionFavs = favs.slice();
    return false;
  }
}

/** Distinct enough for a list this size, and never a reason a save fails:
 *  `crypto.randomUUID` is absent over plain HTTP and on older WebViews. */
function newId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    /* fall through */
  }
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function isSamePlace(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): boolean {
  return (
    Math.abs(a.lat - b.lat) < SAME_PLACE_DEGREES &&
    Math.abs(a.lon - b.lon) < SAME_PLACE_DEGREES
  );
}

/** Pure list logic, exported so ordering, replacement and the cap are testable
 *  without touching `localStorage`.
 *
 *  Naming the same place twice REPLACES rather than appends: a rider who saves
 *  their house as "Home" and later as "casa" meant to rename it, and two rows
 *  on one doorstep is the failure this dedupe exists to prevent. Re-using a
 *  name for a different place also replaces, for the same reason in reverse —
 *  moving house should not leave two rows both called Home. */
export function addFavorite(
  existing: readonly Favorite[],
  fav: Omit<Favorite, "id"> & { id?: string },
): Favorite[] {
  const entry: Favorite = { ...fav, id: fav.id ?? newId() };
  const kept = existing.filter(
    (f) =>
      f.id !== entry.id &&
      !isSamePlace(f, entry) &&
      f.label.trim().toLowerCase() !== entry.label.trim().toLowerCase(),
  );
  // Newest first: the place just saved is the one about to be ridden to.
  return [entry, ...kept].slice(0, MAX_FAVORITES);
}

export function removeFavorite(
  existing: readonly Favorite[],
  id: string,
): Favorite[] {
  return existing.filter((f) => f.id !== id);
}

/** Save and persist. Returns the new list so a caller can re-render without a
 *  second `loadFavorites()` round trip. */
export function recordFavorite(fav: Omit<Favorite, "id">): Favorite[] {
  const next = addFavorite(loadFavorites(), fav);
  persistFavorites(next);
  return next;
}

export function forgetFavorite(id: string): Favorite[] {
  const next = removeFavorite(loadFavorites(), id);
  persistFavorites(next);
  return next;
}

/** True when this place is already saved — drives whether a row offers to
 *  save it or shows that it is already a favorite. */
export function isFavorited(
  favs: readonly Favorite[],
  at: { lat: number; lon: number },
): boolean {
  return favs.some((f) => isSamePlace(f, at));
}

/** The two names riders reach for, offered as one-tap chips so naming a place
 *  is not a typing exercise. `Home` and `Work` deliberately match the words
 *  the profile rows already use, so a signed-out rider's list reads the same
 *  as a signed-in one's. */
export const QUICK_NAMES: readonly { emoji: string; label: string }[] = [
  { emoji: "🏠", label: "Home" },
  { emoji: "💼", label: "Work" },
];

/** A sensible glyph for a place the rider has not chosen one for, picked from
 *  what the geocoder said it is. Never load-bearing — purely so a fresh list
 *  does not read as a column of identical stars. */
export function defaultEmoji(kind?: string): string {
  switch (kind) {
    case "house":
      return "🏠";
    case "street":
      return "🛣️";
    case "locality":
      return "🏙️";
    default:
      return "📍";
  }
}
