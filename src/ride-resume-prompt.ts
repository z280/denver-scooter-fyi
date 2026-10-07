// The resume-or-end prompt — reload recovery finding a server ride the local
// doc didn't expect (`ride-session.ts`'s `recoverRideSession`, action
// `prompt_resume_or_end`) and Screen 6's `POST /tracked-rides` 409 (its own
// doc comment: "throws ApiError with status: 409 when an active ride already
// exists — the resume-or-end prompt's trigger") both resolve to the SAME
// `RideRecoveryOutcome` shape via `ride-session.ts`'s exported
// `recoveryForServerConflict`. This module is the one place that turns that
// outcome into the rider's actual choice, reusing the reducer's own
// already-built actions for it:
//
//   [Resume] → dispatch `adoptServerRide` (doc adopts that ride's identity),
//              re-attach `track-store`'s local recorder under the resume
//              plan's key, hand off to the caller (`onResumed`) so it can
//              show the HUD — mirrors `main.ts`'s own `restore_riding`
//              handling of the exact same `TrackResumePlan` shape.
//   [End it] → send that ride's single `PATCH /end` (tolerating a 409 —
//              "already reported" — as success, same discipline as
//              `ride-post-s8.ts`'s `onRushQuit`), THEN dispatch `abandon`.
//              Nothing further to collect: this tab never rode it.
//
// Reuses the same `.ride-post-modal`/`.ride-post-modal__card` floating
// chrome and focus-trap discipline as `ride-post-s8.ts`/`ride-post-s10.ts` —
// one more member of that family, mounted independently of `ride-modal.ts`'s
// wizard shell (it must be showable on a cold reload before the wizard has
// ever opened, or on top of a mid-Screen-6 wizard).

import {
  ApiError,
  endTrackedRide as defaultEndTrackedRide,
  type EndRideIn,
  type TrackedRide,
} from "./api.ts";
import type { Locate, LngLat } from "./locate.ts";
import type {
  RideRecoveryOutcome,
  RideSessionStore,
} from "./ride-session.ts";
import {
  endRecoveryCopy,
  endRecoveryOffer,
  type EndRecoveryOffer,
} from "./ride-end-recovery.ts";
import { defaultRideOptionsFor } from "./ride-settings.ts";
import type { TrackRecorder, TrackStore } from "./track-store.ts";
import { trapFocusWithin } from "./modal-focus-trap.ts";

export type SessionLike = Pick<RideSessionStore, "dispatch">;

export type LocateLike = Pick<Locate, "current" | "trigger" | "onFix">;

export interface ShowResumeOrEndDeps {
  session: SessionLike;
  locate: LocateLike;
  /** Injected for tests; defaults to a lazily-opened `openTrackStore()`.
   *  `main.ts` passes its own shared singleton so [Resume] re-attaches the
   *  SAME store the rest of the app records into (see `ride-post.ts`'s
   *  identical shared-store discipline). */
  getTrackStore(): Promise<TrackStore>;
  /** Fires once [Resume] has dispatched `adoptServerRide` and re-attached
   *  (or failed to re-attach) the local recorder — the caller's seam for
   *  `rideHud.beginHandoff`. `recorder` is null when nothing could be
   *  reattached (e.g. offline); the ride is still adopted either way. */
  onResumed(ride: TrackedRide, startedAtMs: number, recorder: TrackRecorder | null): void;
  /** Injected for tests; defaults to `endTrackedRide` from api.ts. */
  endTrackedRide?(
    rideId: string,
    body: EndRideIn,
    signal?: AbortSignal,
  ): Promise<TrackedRide>;
  /** Clock injection for tests; defaults to `Date.now`. */
  now?(): number;
  /** Where the prompt mounts; defaults to `document.body`. */
  mountRoot?: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isAlreadyReportedError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/** `locate.trigger()` + a one-shot wait for the next fix, bounded so [End it]
 *  never hangs forever on a rider who denies the permission prompt outright. */
function waitForFix(locate: LocateLike, timeoutMs = 8000): Promise<LngLat | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unFix: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      unFix?.();
      resolve(null);
    }, timeoutMs);
    unFix = locate.onFix((pos) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unFix?.();
      resolve(pos);
    });
    locate.trigger();
  });
}

/** Show the resume-or-end prompt for `outcome` (must carry `outcome.ride` —
 *  the reducer/reload recovery table only ever produces `action:
 *  "prompt_resume_or_end"` alongside one). Returns a dispose function
 *  (tests/HMR); the prompt also disposes itself once either button
 *  succeeds. */
export function showResumeOrEnd(
  outcome: RideRecoveryOutcome,
  deps: ShowResumeOrEndDeps,
): () => void {
  const mountRoot = deps.mountRoot ?? document.body;
  const endTrackedRide = deps.endTrackedRide ?? defaultEndTrackedRide;
  const now = deps.now ?? (() => Date.now());

  if (!outcome.ride) {
    console.error("resume-or-end prompt: outcome carried no ride to act on");
    return () => {};
  }
  // Rebound with an explicit non-null type (rather than relying on narrowing
  // of `outcome.ride` itself) so the nested `onResume`/`onEnd` closures below
  // see a permanently non-nullable `TrackedRide`.
  const ride: TrackedRide = outcome.ride;

  let destroyed = false;
  let busy = false;
  let error: string | null = null;
  /** §11.4 case 2's offer, once the track store has been asked. `undefined` means
   *  not asked yet, `null` means asked and there is nothing honest to offer — the
   *  prompt renders immediately either way and gains the button when it lands,
   *  because a recovery prompt that waits on IndexedDB is worse than one that
   *  grows a third option a moment later. */
  let recovery: EndRecoveryOffer | null | undefined = undefined;

  const backdrop = el("div", "ride-post-modal");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "ride-resume-prompt-title");
  const card = el("div", "ride-post-modal__card ride-resume-prompt");
  backdrop.append(card);

  const untrapFocus = trapFocusWithin(backdrop, () => !destroyed);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    untrapFocus();
    backdrop.remove();
  }

  function render(): void {
    card.replaceChildren();
    const title = el(
      "h2",
      "ride-modal__lede",
      "You already have a ride in progress",
    );
    title.id = "ride-resume-prompt-title";
    card.append(title);
    card.append(
      el(
        "p",
        "ride-modal__hint",
        "We found an active ride on your account that this device doesn't currently know about. Resume tracking it here, or end it now.",
      ),
    );

    if (error) {
      const err = el("p", "ride-post-s8__error", error);
      err.setAttribute("role", "status");
      err.setAttribute("aria-live", "polite");
      card.append(err);
    }
    if (busy) {
      card.append(el("p", "ride-modal__hint", "Working…"));
    }

    const actions = el("div", "ride-wizard__actions");
    const resumeBtn = el("button", "login-btn", "Resume ride");
    resumeBtn.type = "button";
    resumeBtn.disabled = busy;
    resumeBtn.addEventListener("click", () => void onResume());
    // §11.4 case 2. OFFERED ABOVE [End it] AND LABELLED WITH THE TIME, because
    // the two buttons are nearly the same action and the difference between them
    // is the only thing worth reading: "End it" stamps now, this one stamps when
    // the ride actually stopped being recorded. A rider abandoning a ride at
    // 4:12pm and recovering at 9pm otherwise files a five-hour ride.
    if (recovery) {
      card.append(el("p", "ride-modal__hint", endRecoveryCopy(recovery)));
      const atBtn = el(
        "button",
        "login-btn login-btn--secondary",
        `End it at ${recovery.timeLabel}`,
      );
      atBtn.type = "button";
      atBtn.disabled = busy;
      atBtn.addEventListener("click", () => void onEnd(recovery ?? undefined));
      actions.append(atBtn);
    }
    const endBtn = el(
      "button",
      "login-btn login-btn--secondary",
      recovery ? "End it now instead" : "End it",
    );
    endBtn.type = "button";
    endBtn.disabled = busy;
    endBtn.addEventListener("click", () => void onEnd());
    actions.append(resumeBtn, endBtn);
    card.append(actions);

    const focusTarget = card.querySelector<HTMLElement>("button:not([disabled])");
    try {
      focusTarget?.focus();
    } catch {
      /* detached — nothing to focus yet */
    }
  }

  async function onResume(): Promise<void> {
    if (busy || destroyed) return;
    busy = true;
    error = null;
    render();

    const startedMs = Date.parse(ride.started_at);
    const startedAtMs = Number.isFinite(startedMs) ? startedMs : now();
    const transition = deps.session.dispatch({
      type: "adoptServerRide",
      rideId: ride.id,
      startedAtMs,
      trackKeyId: ride.id,
      // `RideSessionStore.dispatch`'s no-doc branch (this prompt's whole
      // reason for existing on the "missing local doc" path) needs an
      // options blob to seed a brand-new doc from nothing — an undefined
      // `options` here would make dispatch silently no-op (return null)
      // whenever the server ride predates A1's `ride_options` field. A
      // resumed server ride is never private, so `authenticated: true` (only
      // an authed rider can have a server-conflicting ride at all — see
      // `recoverRideSession`'s own auth gate).
      options:
        ride.ride_options ??
        defaultRideOptionsFor({ private: false, authenticated: true }),
    });
    if (!transition || !transition.accepted) {
      busy = false;
      error = "Couldn't resume — you're already on a different ride in this tab.";
      render();
      return;
    }

    let recorder: TrackRecorder | null = null;
    if (outcome.resume) {
      try {
        const trackStore = await deps.getTrackStore();
        const resumed = await trackStore.resumeRide(outcome.resume.trackId, {
          signing: outcome.resume.signing ?? undefined,
        });
        recorder = resumed.recorder;
      } catch (e) {
        console.error(
          "resume-or-end prompt: resuming the local track recorder failed",
          e,
        );
      }
    }
    if (destroyed) return;
    destroy();
    deps.onResumed(ride, startedAtMs, recorder);
  }

  /** `at` present: §11.4 case 2's recovered end. Absent: the original behaviour,
   *  stamping now — which is correct for a rider who just finished and is
   *  explicitly offered as "End it now instead" when a recovery is available. */
  async function onEnd(at?: EndRecoveryOffer): Promise<void> {
    if (busy || destroyed) return;
    let fix = deps.locate.current();
    if (!fix) {
      busy = true;
      error = null;
      render();
      fix = await waitForFix(deps.locate);
      if (destroyed) return;
      if (!fix) {
        busy = false;
        error =
          "We need a GPS fix to end that ride — check location services and try again.";
        render();
        return;
      }
    }
    busy = true;
    error = null;
    render();
    try {
      await endTrackedRide(ride.id, {
        ended_at: new Date(at ? at.endedAtMs : now()).toISOString(),
        // The CURRENT position either way, because `EndRideIn` requires one and
        // this is the only one available. On a recovered end that is not where the
        // ride stopped, which is why the metadata says so rather than leaving a
        // consumer to assume a witnessed fix.
        end_lat: fix.lat,
        end_lon: fix.lng,
        ...(at ? { metadata: at.metadata } : {}),
      });
    } catch (e) {
      if (destroyed) return;
      if (!isAlreadyReportedError(e)) {
        busy = false;
        error = "Couldn't end that ride — check your connection and try again.";
        render();
        return;
      }
      // 409 = already reported — proceed as success (same discipline as
      // ride-post-s8.ts's onRushQuit).
    }
    if (destroyed) return;
    deps.session.dispatch({ type: "abandon" });
    destroy();
  }

  /** §11.4 case 2 — ask the local track store when it last recorded this ride.
   *
   *  AFTER THE FIRST RENDER, never before it. A recovery prompt that waits on
   *  IndexedDB to appear is worse than one that grows a third option a moment
   *  later: the two buttons it already has are both usable, and the rider may
   *  well be reaching for [Resume] regardless.
   *
   *  Every failure path leaves `recovery` null, which is the existing behaviour.
   *  A store that will not open, a ride this device never recorded, or a tip
   *  whose timestamps do not make sense all mean "we cannot honestly say when it
   *  ended" — and the prompt says nothing rather than guessing. */
  async function loadRecovery(): Promise<void> {
    // GATED ON `outcome.resume`, for two reasons that happen to agree.
    //
    // It is the signal that THIS DEVICE HAS A LOCAL TRACK for the ride — without
    // one, `readTip` answers null and there is nothing to recover, so opening
    // IndexedDB would be work with a known-empty result. [Resume]'s own branch
    // gates on the same field for the same reason, and a test pins that the store
    // is never opened without it.
    //
    // It also carries the right KEY. `trackId` is not necessarily `ride.id` — it
    // is `ride.id` for a server ride today, and reading the plan's own id rather
    // than assuming they match is correct by construction instead of by
    // coincidence.
    const plan = outcome.resume;
    if (!plan) {
      recovery = null;
      return;
    }
    try {
      const store = await deps.getTrackStore();
      const tip = await store.readTip(plan.trackId);
      if (destroyed) return;
      recovery = endRecoveryOffer({
        lastPointMs: tip?.lastPointMs ?? null,
        startedAtMs: Date.parse(ride.started_at),
        now: now(),
      });
    } catch {
      if (destroyed) return;
      recovery = null;
    }
    // Only repaint when there is something new to show, and never over a rider
    // mid-action: a button appearing under a thumb that is already pressing one is
    // how a rider ends a ride at the wrong time by accident.
    if (recovery && !busy) render();
  }

  mountRoot.append(backdrop);
  render();
  void loadRecovery();

  return destroy;
}
