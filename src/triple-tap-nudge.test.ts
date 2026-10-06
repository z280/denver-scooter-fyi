// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NUDGE_INTERVAL_MS,
  NUDGE_STORAGE_KEY,
  NUDGE_TEXT,
  NUDGE_VISIBLE_MS,
  TripleTapNudge,
  readNudgeState,
  shouldShowNudge,
} from "./triple-tap-nudge.ts";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const T0 = 1_800_000_000_000;

beforeEach(() => document.body.replaceChildren());
afterEach(() => vi.useRealTimers());

describe("shouldShowNudge", () => {
  it("shows the first time, then at most once a week, never once done", () => {
    expect(shouldShowNudge({ lastShown: 0, done: false }, T0)).toBe(true);
    expect(shouldShowNudge({ lastShown: T0, done: false }, T0 + NUDGE_INTERVAL_MS - 1)).toBe(false);
    expect(shouldShowNudge({ lastShown: T0, done: false }, T0 + NUDGE_INTERVAL_MS)).toBe(true);
    expect(shouldShowNudge({ lastShown: 0, done: true }, T0)).toBe(false);
  });
});

describe("TripleTapNudge", () => {
  it("shows the chip with three tapping fingers, and not again the same week", () => {
    let now = T0;
    const storage = memStorage();
    const n = new TripleTapNudge({ now: () => now, storage });
    expect(n.maybeShow()).toBe(true);
    const chip = document.querySelector(".triple-tap-nudge")!;
    expect(chip.textContent).toContain(NUDGE_TEXT);
    expect(chip.querySelectorAll(".triple-tap-nudge__tap")).toHaveLength(3);

    const again = new TripleTapNudge({ now: () => (now += 60_000), storage });
    expect(again.maybeShow()).toBe(false);
  });

  it("tucks itself away if ignored, and comes back next week", () => {
    vi.useFakeTimers();
    let now = T0;
    const storage = memStorage();
    const n = new TripleTapNudge({ now: () => now, storage });
    n.maybeShow();
    vi.advanceTimersByTime(NUDGE_VISIBLE_MS);
    expect(document.querySelector(".triple-tap-nudge")).toBeNull();
    now += NUDGE_INTERVAL_MS;
    expect(n.maybeShow()).toBe(true);
  });

  it("✕ retires it for good", () => {
    let now = T0;
    const storage = memStorage();
    const n = new TripleTapNudge({ now: () => now, storage });
    n.maybeShow();
    document.querySelector<HTMLButtonElement>(".triple-tap-nudge__close")!.click();
    expect(document.querySelector(".triple-tap-nudge")).toBeNull();
    now += NUDGE_INTERVAL_MS * 10;
    expect(n.maybeShow()).toBe(false);
    expect(readNudgeState(storage).done).toBe(true);
  });

  it("doing the gesture retires it too: the lesson is learned", () => {
    const storage = memStorage();
    const n = new TripleTapNudge({ now: () => T0, storage });
    n.maybeShow();
    n.learned();
    expect(n.isShowing()).toBe(false);
    expect(JSON.parse(storage.getItem(NUDGE_STORAGE_KEY)!).done).toBe(true);
  });

  it("stays quiet when storage is blocked rather than nagging every load", () => {
    const n = new TripleTapNudge({ now: () => T0, storage: null });
    expect(n.maybeShow()).toBe(false);
  });
});
