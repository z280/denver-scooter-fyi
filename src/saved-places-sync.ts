// The account half of `favorites.ts`: a rider's saved places, mirrored to the
// server so they survive a new phone.
//
// WHAT THIS IS NOT. It is not a second source of truth. `favorites.ts` is the
// store the app reads, in both states, and every write lands there first; this
// module hangs off its sync hook and copies the result up. Signed out, nothing
// here runs and the app is exactly what it was. Signed in, the only difference
// a rider can see is that a new device starts with their places on it.
//
// ENCRYPTED AT REST, server-side. The column holds a Fernet token rather than
// these objects (API `src/place_crypto.py`): "Home" next to a coordinate, an
// email and a phone number in one row is a dossier, and a database dump, a
// backup bucket or a read replica should not contain it. The server can still
// decrypt — it has to, to hand them back to the next device — so this is
// encryption at rest and not end-to-end, which is what the privacy policy now
// says rather than implying a guarantee the architecture does not make.
//
// THE MERGE RULE IS "LOCAL WINS, THE SERVER FILLS THE GAPS", and it is chosen
// for the harm it avoids rather than for being clever. There are no timestamps
// on either side, so "newest wins" is not available; what IS knowable is that
// the local list is the one the rider is looking at right now. A merge that
// silently moved the Home on their screen because another device remembered an
// older address would be the one failure here that costs somebody a trip. So a
// conflicting id keeps the local row, every id the server has and this device
// does not is adopted, and the union goes back up.
//
// The cost of that rule, stated plainly: a place deleted on this device while
// SIGNED OUT comes back at the next sign-in, because the server still has it
// and a gap is indistinguishable from a deletion. Deleting while signed in
// propagates immediately, which is the case that actually happens. Choosing the
// other way round would mean a fresh install — whose local list is empty, i.e.
// all gaps — wiping the account, and that is unrecoverable where this is
// merely annoying.

import {
  MAX_FAVORITES,
  loadFavorites,
  saveFavorites,
  setFavoritesSyncHook,
  type Favorite,
} from "./favorites.ts";
import type { SavedPlace } from "./api.ts";

/** Validated on the way IN, like every other blob this app reads.
 *
 *  The server validates too — and refuses worse input than this does — but a
 *  client that trusts a payload because something upstream should have checked
 *  it is one deployment away from rendering `undefined, undefined` as a
 *  coordinate. Range-checked and not merely parsed, for the same reason
 *  `saved_places.py` is: a latitude of 412 is not a place. */
function cleanPlace(raw: unknown): Favorite | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const { id, label, emoji, lat, lon } = r;
  if (typeof id !== "string" || !id) return null;
  if (typeof label !== "string" || !label.trim()) return null;
  if (typeof lat !== "number" || !Number.isFinite(lat)) return null;
  if (typeof lon !== "number" || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    id,
    label: label.trim(),
    emoji: typeof emoji === "string" ? emoji : "",
    lat,
    lon,
  };
}

export function cleanPlaces(raw: unknown): Favorite[] {
  if (!Array.isArray(raw)) return [];
  const out: Favorite[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const place = cleanPlace(entry);
    // DROPS BAD ROWS RATHER THAN REFUSING THE LIST: one unparseable entry
    // from an older build must not cost a rider every other place they saved.
    if (place && !seen.has(place.id)) {
      seen.add(place.id);
      out.push(place);
    }
  }
  return out.slice(0, MAX_FAVORITES);
}

/** The wire shape. Identical five fields, named here so a future divergence is
 *  a compile error rather than a silent field drop. */
function toWire(fav: Favorite): SavedPlace {
  return { id: fav.id, label: fav.label, emoji: fav.emoji, lat: fav.lat, lon: fav.lon };
}

/** Order-insensitive equality, used both to decide whether a push is worth
 *  making and to recognise this module's own writes coming back through the
 *  favourites hook. Order is deliberately NOT compared: `favorites.ts` keeps
 *  newest-first and the server keeps insertion order, so comparing it would
 *  make every reconcile look like a change and push on every page load. */
export function samePlaces(
  a: readonly Favorite[],
  b: readonly Favorite[],
): boolean {
  if (a.length !== b.length) return false;
  const key = (f: Favorite): string =>
    `${f.id}\u0000${f.label}\u0000${f.emoji}\u0000${f.lat}\u0000${f.lon}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
}

/** Union of the two lists: local rows kept as they are, server rows adopted
 *  wherever this device has no row with that id.
 *
 *  Local order first so the store's newest-first ordering survives, then the
 *  adopted rows in the order the server gave them. `favorite-slots.ts`'s
 *  `orderedFavorites` lifts the four slots above both, so this ordering is only
 *  ever about the rest. */
export function mergePlaces(
  local: readonly Favorite[],
  remote: readonly Favorite[],
): Favorite[] {
  const mine = new Set(local.map((f) => f.id));
  return [...local, ...remote.filter((f) => !mine.has(f.id))].slice(
    0,
    MAX_FAVORITES,
  );
}

/** What a reconcile decided, so a caller (and a test) can see it rather than
 *  infer it from side effects. */
export interface ReconcileResult {
  /** The list after merging — what the device now holds. */
  places: Favorite[];
  /** The local store was changed (the server had something this device did
   *  not). */
  pulled: boolean;
  /** The server list differs from the merge, so it needs the union. */
  needsPush: boolean;
}

/** Merge a freshly-fetched profile's places into the local store.
 *
 *  `remote` is `undefined` when the field was absent from the payload, which is
 *  what an older deployment sends — and the distinction is load-bearing: an
 *  absent field means "this server does not know about saved places", not "the
 *  rider has none". Treating the two alike would push a list up to a server
 *  that drops it, or, worse, read the silence as an empty account and leave a
 *  rider convinced their places had synced. So absent means do nothing at all.
 */
export function reconcileSavedPlaces(
  remote: SavedPlace[] | undefined,
): ReconcileResult | null {
  if (remote === undefined) return null;
  const local = loadFavorites();
  const theirs = cleanPlaces(remote);
  const merged = mergePlaces(local, theirs);
  const pulled = !samePlaces(local, merged);
  if (pulled) {
    applying = true;
    try {
      saveFavorites(merged);
    } finally {
      // `finally`, because a storage layer that throws must not leave the
      // mirror permanently deaf to every later edit the rider makes.
      applying = false;
    }
  }
  return { places: merged, pulled, needsPush: !samePlaces(theirs, merged) };
}

/** The last list this module knows the server has. Null means "no idea", which
 *  is the state before the first reconcile and after a failed push. */
let serverCopy: Favorite[] | null = null;

/** True while a reconcile is writing the merged list into the local store.
 *
 *  WHY A FLAG AND NOT JUST THE ECHO GUARD. `reconcileSavedPlaces` writes
 *  through `saveFavorites`, which fires the favourites hook — so without this,
 *  a reconcile that pulls something new would push from inside the hook AND
 *  again from the explicit decision below, racing two PUTs of the same list.
 *  The reconcile knows strictly more than the hook does (it has both sides),
 *  so it takes the decision and the hook stands down for that one write. */
let applying = false;

/** TEST-ONLY, and for the same reason `favorites.ts` has one: these are module
 *  state that outlives a test, and a case that leaves `serverCopy` set makes
 *  the next one's first push look like an echo and vanish. */
export function _resetSavedPlacesSyncForTests(): void {
  serverCopy = null;
  applying = false;
  setFavoritesSyncHook(null);
}

export interface SavedPlacesSyncDeps {
  /** True while there is a session to sync to. Asked on every write rather
   *  than captured, because a token can expire under a drawer that is open. */
  signedIn(): boolean;
  /** Send the list. Rejections are swallowed by the caller — the local write
   *  already happened and the rider's row already says "Saved", so a dead
   *  network must not retract it. The next reconcile picks the difference up. */
  push(places: SavedPlace[]): Promise<unknown>;
}

/** Register the mirror. Called once at boot, signed in or not: the hook asks
 *  `signedIn()` per write, so nothing has to be re-wired when a session
 *  starts or ends. */
export function startSavedPlacesSync(deps: SavedPlacesSyncDeps): void {
  setFavoritesSyncHook((favs) => {
    if (applying || !deps.signedIn()) return;
    const next = favs.slice();
    // THE ECHO GUARD. A reconcile writes the merged list locally, which fires
    // this hook, which would push the list the server just gave us straight
    // back at it — once per page load, forever. Comparing against what we
    // believe the server holds costs nothing and ends it.
    if (serverCopy && samePlaces(serverCopy, next)) return;
    serverCopy = next;
    void deps.push(next.map(toWire)).catch(() => {
      // We no longer know what the server has, so the next reconcile must not
      // be allowed to treat its own result as already-pushed.
      serverCopy = null;
    });
  });
}

/** Fold a profile's places in and push the union back if the server is behind.
 *
 *  The whole of a sign-in's work, in one call: pull, merge, push. Returns the
 *  reconcile for a caller that wants to react (the destination lists re-read
 *  the store when they open, so most do not). */
export function syncSavedPlacesFromProfile(
  remote: SavedPlace[] | undefined,
  deps: SavedPlacesSyncDeps,
): ReconcileResult | null {
  const result = reconcileSavedPlaces(remote);
  if (!result) return null;
  // What the server holds, as of this payload — set whether or not a push
  // follows, so the rider's next edit is compared against the truth rather
  // than against nothing.
  serverCopy = cleanPlaces(remote);
  if (result.needsPush && deps.signedIn()) {
    serverCopy = result.places;
    void deps.push(result.places.map(toWire)).catch(() => {
      serverCopy = null;
    });
  }
  return result;
}
