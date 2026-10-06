// The "tap tap tap" nudge: a small chip that teaches the triple-tap.
//
// The gesture is invisible by nature — nothing on the map says "three taps
// here" — so a rider finds it only by being told. One-time tips
// (discovery-tips.ts) are the wrong shape for that: a tip that showed once,
// on a visit when the rider was busy finding a scooter, is a tip they never
// read. So this one comes back:
//
//   * at most once a WEEK (NUDGE_INTERVAL_MS), shown for a while and then
//     tucked away on its own;
//   * until the rider either dismisses it with ✕ ("got it, stop") or does
//     the gesture themselves (they have learned it, so the lesson is over).
//
// Styled after the equity chip (the one thing on the map already asking to
// be tapped), with three little fingers that tap in turn.

/** UI preference, not app state — same prefix family as the tips. */
export const NUDGE_STORAGE_KEY = "scooter-fyi-triple-tap-nudge";

export const NUDGE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long it stays up if ignored. Long enough to notice between taps on
 *  scooters; short enough not to become furniture. */
export const NUDGE_VISIBLE_MS = 20_000;

/** Wait this long after the map settles before showing, so it never lands
 *  on top of the first thing a rider is trying to do. */
export const NUDGE_DELAY_MS = 6_000;

export const NUDGE_TEXT = "Triple-tap anything on the map to see what it is";

export interface NudgeState {
  /** Epoch ms of the last time it was shown; 0 = never. */
  lastShown: number;
  /** Dismissed, or the gesture was done: never again. */
  done: boolean;
}

/** Pure: should the nudge show now? */
export function shouldShowNudge(state: NudgeState, now: number): boolean {
  if (state.done) return false;
  return now - state.lastShown >= NUDGE_INTERVAL_MS;
}

export function readNudgeState(storage: Storage | null = safeStorage()): NudgeState {
  const fallback: NudgeState = { lastShown: 0, done: false };
  if (!storage) return { lastShown: 0, done: true }; // storage blocked: stay quiet
  try {
    const raw = storage.getItem(NUDGE_STORAGE_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<NudgeState>;
    return {
      lastShown: Number.isFinite(v.lastShown) ? Number(v.lastShown) : 0,
      done: v.done === true,
    };
  } catch {
    return fallback;
  }
}

export function writeNudgeState(
  state: NudgeState,
  storage: Storage | null = safeStorage(),
): void {
  try {
    storage?.setItem(NUDGE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode: it may show again next week, which is fine */
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface NudgeOptions {
  now?: () => number;
  storage?: Storage | null;
}

export class TripleTapNudge {
  private el: HTMLElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly storage: Storage | null;

  constructor(opts: NudgeOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.storage = opts.storage === undefined ? safeStorage() : opts.storage;
  }

  /** Show it if it is due. Returns whether it showed. */
  maybeShow(): boolean {
    const state = readNudgeState(this.storage);
    if (!shouldShowNudge(state, this.now()) || this.el) return false;
    writeNudgeState({ ...state, lastShown: this.now() }, this.storage);
    this.render();
    return true;
  }

  /** The rider did a triple tap: the lesson is learned. */
  learned(): void {
    this.retire();
  }

  /** ✕: "got it". */
  dismiss(): void {
    this.retire();
  }

  isShowing(): boolean {
    return this.el !== null;
  }

  private retire(): void {
    const state = readNudgeState(this.storage);
    if (!state.done) writeNudgeState({ ...state, done: true }, this.storage);
    this.hide();
  }

  private hide(): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.el?.remove();
    this.el = null;
  }

  private render(): void {
    const chip = document.createElement("div");
    chip.className = "triple-tap-nudge";
    chip.setAttribute("role", "status");

    const taps = document.createElement("span");
    taps.className = "triple-tap-nudge__taps";
    taps.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) {
      const finger = document.createElement("span");
      finger.className = "triple-tap-nudge__tap";
      finger.textContent = "👆";
      taps.appendChild(finger);
    }

    const text = document.createElement("span");
    text.className = "triple-tap-nudge__text";
    text.textContent = NUDGE_TEXT;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "triple-tap-nudge__close";
    close.setAttribute("aria-label", "Got it, don't show this again");
    close.textContent = "×";
    close.addEventListener("click", () => this.dismiss());

    chip.append(taps, text, close);
    document.body.appendChild(chip);
    this.el = chip;
    // Ignored, it just goes away until next week; only ✕ or the gesture
    // itself retire it for good.
    this.hideTimer = setTimeout(() => this.hide(), NUDGE_VISIBLE_MS);
  }
}
