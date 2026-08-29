// Where a rider's specs live, and the one piece of state the map bridge needs
// that nothing else owns: WHICH SPEC, IF ANY, IS CURRENTLY DRIVING THE MAP.
//
// TWO HOMES, ONE SOURCE OF TRUTH. Signed in, specs live on the account
// (`/api/v1/profile/ride-specs`, five of them) so the same rider gets the same
// answers on their other phone. Signed out, one unnamed spec lives in
// localStorage — the map bridge, the filters and the ranking all work
// anonymously, and only dibs needs an account. The server wins when both
// exist, following `applyServerRatePlan`'s precedent in ride-cost.ts.
//
// ATTACHMENT IS THE INTERESTING PART, and it is not something the presets
// have. "Show only my ideal scooters" leaves the map in a state that CLAIMS to
// be a spec, and the moment the rider nudges any filter that claim stops being
// true. A toggle that stays lit over filters it no longer describes is the UI
// telling a lie, so this module holds the attachment, is handed every filter
// change, and detaches on the first one it did not make itself.
//
// No DOM here. The panel renders; this decides.

import {
  deleteRideSpec as apiDeleteRideSpec,
  listRideSpecs as apiListRideSpecs,
  putRideSpec as apiPutRideSpec,
} from "./api.ts";
import type { FilterSnapshot } from "./filter-presets.ts";
import {
  readSpec,
  toFilterSnapshot,
  writeSpec,
  type RideSpec,
} from "./ride-spec.ts";

/** The anonymous rider's single spec. Dotted key: this is ride state, not a
 *  map-UI preference (`scooter-fyi-*`). */
export const LOCAL_SPEC_KEY = "scooter_fyi.ride_spec";

/** Matches the API's MAX_RIDE_SPECS. Duplicated as a client-side guard so the
 *  sheet can say "you have five" before spending a round trip on a 409 — the
 *  server is still the one that enforces it. */
export const MAX_RIDE_SPECS = 5;

export interface NamedSpec {
  name: string;
  spec: RideSpec;
  /** Server timestamp, for "most recently updated first". Absent for the
   *  local one, which is the only one there is. */
  updatedAt?: string;
}

/** The unnamed local spec's stand-in name. Never sent to the server: the
 *  local store has one slot, and naming it would imply a list. */
export const LOCAL_SPEC_NAME = "My ideal scooter";

// ---------------------------------------------------------------------------
// Local storage
// ---------------------------------------------------------------------------

export function loadLocalSpec(): RideSpec | null {
  try {
    const raw = localStorage.getItem(LOCAL_SPEC_KEY);
    return raw ? readSpec(JSON.parse(raw)) : null;
  } catch {
    // Private mode, a corrupt blob, or a hand edit. `readSpec` already
    // degrades a malformed object to a usable spec; this catch is for the
    // cases where there is nothing to degrade.
    return null;
  }
}

/** Returns false when the write was refused (private mode), so a caller can
 *  say so rather than claiming the device saved it. */
export function saveLocalSpec(spec: RideSpec): boolean {
  try {
    localStorage.setItem(LOCAL_SPEC_KEY, JSON.stringify(writeSpec(spec)));
    return true;
  } catch {
    return false;
  }
}

export function clearLocalSpec(): void {
  try {
    localStorage.removeItem(LOCAL_SPEC_KEY);
  } catch {
    /* nothing to clear, or nothing that can be */
  }
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export interface SpecStoreDeps {
  /** Injected so the store can be tested without the auth layer, and so a
   *  signed-out session never fires a guaranteed 401. */
  signedIn(): boolean;
  list?: typeof apiListRideSpecs;
  put?: typeof apiPutRideSpec;
  remove?: typeof apiDeleteRideSpec;
}

/** Every spec this rider has, newest first.
 *
 *  Signed out — or signed in with the request failing — this is the local
 *  spec, or nothing. A network failure must not empty a rider's list on
 *  screen: falling back to the local copy is the honest degradation, and the
 *  panel says which it is showing.
 */
export async function listSpecs(deps: SpecStoreDeps): Promise<NamedSpec[]> {
  if (deps.signedIn()) {
    try {
      const rows = await (deps.list ?? apiListRideSpecs)();
      return rows.flatMap((r) => {
        const spec = readSpec(r.settings);
        // A row whose blob will not read is dropped rather than rendered as
        // an empty spec: an empty spec matches everything, and silently
        // showing a rider "no requirements" under a name they chose is worse
        // than showing one row fewer.
        return spec ? [{ name: r.name, spec, updatedAt: r.updated_at }] : [];
      });
    } catch {
      /* fall through to the local copy */
    }
  }
  const local = loadLocalSpec();
  return local ? [{ name: LOCAL_SPEC_NAME, spec: local }] : [];
}

/** Save under a name. Signed out, the name is ignored and the single local
 *  slot is written; the return says which happened so the panel can be honest
 *  about where it went. */
export async function saveSpec(
  deps: SpecStoreDeps,
  name: string,
  spec: RideSpec,
): Promise<{ where: "account" | "device" | "nowhere" }> {
  if (deps.signedIn()) {
    try {
      await (deps.put ?? apiPutRideSpec)(name, writeSpec(spec));
      // Mirror to the device too. A signed-in rider who later signs out, or
      // opens the app offline, keeps the spec they just wrote — and the
      // mirror is what `loadLocalSpec` reads on the next cold start, before
      // any request has landed.
      saveLocalSpec(spec);
      return { where: "account" };
    } catch {
      /* fall through: better on the device than lost */
    }
  }
  return { where: saveLocalSpec(spec) ? "device" : "nowhere" };
}

export async function deleteSpec(
  deps: SpecStoreDeps,
  name: string,
): Promise<void> {
  if (deps.signedIn()) {
    try {
      await (deps.remove ?? apiDeleteRideSpec)(name);
      return;
    } catch {
      /* fall through */
    }
  }
  clearLocalSpec();
}

// ---------------------------------------------------------------------------
// Attachment — which spec is driving the map
// ---------------------------------------------------------------------------

export interface Attachment {
  /** The spec's name, for the drawer's "showing: Commuter" line. */
  name: string;
  /** What the map looked like BEFORE the projection, so turning the toggle
   *  off restores what the rider had rather than a default. */
  restore: FilterSnapshot;
  /** What the projection produced. Any filter state that is not this is a
   *  rider edit, and detaches. */
  projected: FilterSnapshot;
}

/** Are two snapshots the same filter? Order-insensitive on the three lists,
 *  because the controls emit them in whatever order the DOM is in and a
 *  reordering is not an edit.
 *
 *  `knownModels` is excluded deliberately: it is provenance (what the saver
 *  could see), not filter state, and comparing it would detach a spec the
 *  moment a preset from an older lineup was loaded alongside. */
export function sameFilters(a: FilterSnapshot, b: FilterSnapshot): boolean {
  const set = (xs: readonly string[] | undefined): string =>
    [...(xs ?? [])].sort().join(",");
  return (
    set(a.rideTypes) === set(b.rideTypes) &&
    set(a.models) === set(b.models) &&
    set(a.features) === set(b.features) &&
    a.hideUnavailable === b.hideUnavailable &&
    a.minBattery === b.minBattery &&
    a.quality === b.quality &&
    a.area?.layer === b.area?.layer &&
    set(a.area?.subset ?? undefined) === set(b.area?.subset ?? undefined)
  );
}

/** Holds the attachment and decides when it is over.
 *
 *  Deliberately a tiny object rather than a module-level variable: the tests
 *  need two of them, and a module global would make "does a filter change
 *  detach?" a question you can only answer by reloading the page.
 */
export class SpecAttachment {
  private current: Attachment | null = null;

  get(): Attachment | null {
    return this.current;
  }

  get attachedName(): string | null {
    return this.current?.name ?? null;
  }

  /** Project `spec` onto `live` and remember both sides. The caller applies
   *  the returned snapshot; this only records what it should look like. */
  attach(name: string, spec: RideSpec, live: FilterSnapshot): FilterSnapshot {
    const projected = toFilterSnapshot(spec, live);
    this.current = { name, restore: live, projected };
    return projected;
  }

  /** Turn the toggle off: forget the attachment and hand back the filters the
   *  rider had before it went on. Null when nothing was attached. */
  detachAndRestore(): FilterSnapshot | null {
    const restore = this.current?.restore ?? null;
    this.current = null;
    return restore;
  }

  /** Hand this every filter change. Returns true when the change was a rider
   *  edit that ended the attachment — which is the moment the toggle has to
   *  clear and say what it detached from.
   *
   *  Compares against the PROJECTION rather than tracking who called what: a
   *  flag saying "this change was mine" is one `await` away from being wrong,
   *  and the question is really "does the map still show the spec", which the
   *  snapshot answers directly. */
  noticeFilterChange(live: FilterSnapshot): boolean {
    if (!this.current) return false;
    if (sameFilters(live, this.current.projected)) return false;
    this.current = null;
    return true;
  }

  /** Re-apply the spec after a detach — "back to Commuter". Returns null when
   *  there is nothing to go back to. */
  reattach(
    name: string,
    spec: RideSpec,
    live: FilterSnapshot,
  ): FilterSnapshot {
    return this.attach(name, spec, live);
  }
}
