// Integration barrel for the post-ride flow — Screens 8 (ending), 9 (survey),
// 10 (eligibility). Frontend plan `ride-post.ts` row; F4 Phase.
//
// The three lanes that built Screens 8/9/10 each landed a standalone module
// (`ride-post-s8.ts` / `ride-post-s9.ts` / `ride-post-s10.ts`) rather than one
// merged file, and left the "how do these become one flow" decision to the
// integrator (see each module's own header notes). Decision: keep them as
// three separate, independently-tested modules and let THIS thin file be the
// single `ride-post.ts` the module map names — one `wireRidePost()` call for
// `main.ts`, no risky three-way merge of already-passing test suites.
//
// Screens 8 and 10 are fully self-wiring: `wireRideScreen8` / `wireRidePostS10`
// each subscribe to the ride-session store and mount/unmount purely off
// `phaseOf(doc)`. Screen 9 shipped WITHOUT an equivalent — only a pure
// `buildRidePostS9Screen()` builder plus a `shouldShowRidePostS9()` pre-check,
// with its own comments saying a host will call it (see
// ride-post-s10.ts's "IMPORTANT cross-lane gap" integrator note). This file
// supplies that missing host (`mountRidePostS9`/the survey branch below),
// copying the exact subscribe-and-mount-off-`phaseOf(doc)` shape S8/S10
// already use, and the same `.ride-post-modal` / `.ride-post-modal__card`
// shell both of them render into — so all three screens are wired
// identically from `main.ts`'s point of view and share one visual chrome.
//
// No `registerRideScreen` call anywhere here: `ride-modal.ts`'s `ScreenId`
// or `RIDE_SCREEN_FLOW` are what the six-screen wizard, not this
// non-linear ending→survey→eligibility tail (see ride-post-s8.ts's
// ARCHITECTURE note for the full reasoning, which applies equally to 9/10).

import type { LngLat } from "./locate.ts";
import { openTrackStore, type TrackStore } from "./track-store.ts";
import {
  phaseOf,
  type RideGateFacts,
  type RideRecoveryNote,
  type RideSessionDoc,
  type RideSessionStore,
} from "./ride-session.ts";
import type { ResolvedRideModePoints } from "./ride-settings.ts";
import {
  wireRideScreen8,
  type LocateLike,
  type RideScreen8Deps,
} from "./ride-post-s8.ts";
import { buildRidePostS9Screen, type RidePostS9Deps } from "./ride-post-s9.ts";
import { wireRidePostS10, type RidePostS10Deps } from "./ride-post-s10.ts";
import { trapFocusWithin } from "./modal-focus-trap.ts";

export interface RidePostDeps {
  session: RideSessionStore;
  locate: LocateLike;
  /** `RideHud.getLastFix()` — threaded through to Screen 8 (review fix: see
   *  `ride-post-s8.ts`'s `getLastFix` doc comment for why it's preferred
   *  over `locate.current()`). Defaults to a stub returning `null`, which
   *  falls through to `locate.current()` (tests, or a private ride the HUD
   *  never tracked). */
  getLastFix?(): LngLat | null;
  /** Screen 9's pane-header point values — same "copy can never drift"
   *  discipline as Screen 2's ℹ modals. Read fresh on every Screen 9 mount
   *  (a getter, not a static value) so a `main.ts`-level `loadRideModePoints()`
   *  that resolves after boot but before a rider ever reaches Screen 9 (the
   *  overwhelmingly common case — Screen 9 can't be reached without first
   *  completing Screens 1-6 and a whole ride) is still picked up. Omitted or
   *  still-unresolved falls back to Screen 9's own baked-in default. */
  points?(): ResolvedRideModePoints | undefined;
  /** Threaded from `main.ts`'s own recovery step — see ride-post-s8.ts's
   *  RECOVERY-NOTE GAP note. Static, read once at wire time: recovery is a
   *  once-per-page-load reconciliation that has already finished by the time
   *  `main.ts` calls `wireRidePost` (see that call site's own comment). */
  recoveryNote?: RideRecoveryNote | null;
  /** Injected for tests; defaults to a lazily-opened `openTrackStore()`. */
  getGateFacts?(trackId: string | null): Promise<RideGateFacts>;
  /** Shared TrackStore accessor (review fix): with IndexedDB unavailable,
   *  `openTrackStore()` degrades to a fresh, empty in-memory adapter on
   *  EVERY call, so a `getGateFacts`/donation reader that opens its own store
   *  independently of `main.ts`'s recording instance never sees this tab's
   *  actual batches. `main.ts` passes its own module-level `getTrackStore()`
   *  singleton here so Screens 8/9/10 all read the SAME store the ride was
   *  recorded into. Defaults to a lazily-opened, module-private
   *  `openTrackStore()` (kept for tests/back-compat / no injected caller). */
  getTrackStore?(): Promise<TrackStore>;
  /** Where every screen mounts; defaults to `document.body`. */
  mountRoot?: HTMLElement;
}

async function defaultGetGateFacts(
  trackId: string | null,
  getTrackStore: () => Promise<TrackStore>,
): Promise<RideGateFacts> {
  if (!trackId) return { hasWaypoints: false };
  try {
    const store = await getTrackStore();
    const tip = await store.readTip(trackId);
    return {
      hasWaypoints: (tip?.waypointCount ?? 0) + (tip?.pendingCount ?? 0) > 0,
    };
  } catch {
    return { hasWaypoints: false };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// ---------------------------------------------------------------------------
// Screen 9 host — the piece ride-post-s9.ts itself does not provide.
// ---------------------------------------------------------------------------

interface MountedRidePostS9 {
  destroy(): void;
}

function mountRidePostS9(
  doc: RideSessionDoc,
  deps: Required<Pick<RidePostDeps, "session" | "mountRoot">> &
    Pick<RidePostDeps, "points"> & { getGateFacts(trackId: string | null): Promise<RideGateFacts> },
  onClosed: () => void,
): MountedRidePostS9 {
  const trackId = doc.trackKeyId ?? doc.rideId;

  const screenDeps: RidePostS9Deps = {
    session: deps.session,
    getGateFacts: () => deps.getGateFacts(trackId),
    points: deps.points?.(),
  };
  const screen = buildRidePostS9Screen(screenDeps);

  const backdrop = el("div", "ride-post-modal");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "ride-post-s9-title");
  const card = el("div", "ride-post-modal__card ride-post-s9");
  const title = el("h2", "ride-modal__lede");
  title.id = "ride-post-s9-title";
  title.textContent = screen.title;
  card.append(title, screen.primary);
  backdrop.append(card);

  let destroyed = false;
  // House rule: "anything modal" needs a focus trap — see
  // modal-focus-trap.ts's header for why this is a standalone copy rather
  // than ride-modal.ts's own private one (this barrel's mount is exactly the
  // kind of standalone-overlay host that note describes).
  const untrapFocus = trapFocusWithin(backdrop, () => !destroyed);
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    untrapFocus();
    screen.destroy();
    backdrop.remove();
    onClosed();
  }

  deps.mountRoot.append(backdrop);
  const focusTarget = card.querySelector<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
  );
  try {
    focusTarget?.focus();
  } catch {
    /* detached — nothing to focus yet */
  }

  return { destroy };
}

function wireRidePostS9(deps: {
  session: RideSessionStore;
  mountRoot: HTMLElement;
  points?(): ResolvedRideModePoints | undefined;
  getGateFacts(trackId: string | null): Promise<RideGateFacts>;
}): () => void {
  let mounted: MountedRidePostS9 | null = null;

  function syncToPhase(doc: RideSessionDoc | null): void {
    const inPhase = doc !== null && phaseOf(doc) === "survey(9)";
    if (inPhase && !mounted && doc) {
      mounted = mountRidePostS9(doc, deps, () => {
        mounted = null;
      });
    } else if (!inPhase && mounted) {
      mounted.destroy();
      mounted = null;
    }
  }

  syncToPhase(deps.session.current());
  const unsubscribe = deps.session.subscribe((doc) => syncToPhase(doc));

  return () => {
    unsubscribe();
    mounted?.destroy();
    mounted = null;
  };
}

// ---------------------------------------------------------------------------
// Entry point — the ONE call `main.ts` needs.
// ---------------------------------------------------------------------------

/** Wire Screens 8, 9, and 10. Call once at startup (see `main.ts`'s own
 *  comment at the call site for why it waits on the first recovery pass).
 *  Returns a full teardown of all three sub-screens, for tests/HMR. */
export function wireRidePost(deps: RidePostDeps): () => void {
  const mountRoot = deps.mountRoot ?? document.body;
  const getTrackStore = deps.getTrackStore ?? openTrackStore;
  const getGateFacts =
    deps.getGateFacts ??
    ((trackId: string | null) => defaultGetGateFacts(trackId, getTrackStore));

  const unwireS8 = wireRideScreen8({
    session: deps.session,
    locate: deps.locate,
    recoveryNote: deps.recoveryNote ?? null,
    mountRoot,
    // Same resolved `getGateFacts` as S9 below — both read through the one
    // shared `getTrackStore` (see the module's shared-store review fix).
    getGateFacts,
    getLastFix: deps.getLastFix ?? (() => null),
  } satisfies RideScreen8Deps);

  const unwireS9 = wireRidePostS9({
    session: deps.session,
    mountRoot,
    points: deps.points,
    getGateFacts,
  });

  const unwireS10 = wireRidePostS10({
    session: deps.session,
    mountRoot,
    getTrackStore,
    // Same getter `ride-post.ts`'s barrel hands S9 above — see
    // ride-post-s10.ts's own doc comment on why this must stay a getter
    // read fresh per mount, not a value captured once here.
    points: deps.points,
  } satisfies RidePostS10Deps);

  return () => {
    unwireS8();
    unwireS9();
    unwireS10();
  };
}
