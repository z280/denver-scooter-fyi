// @vitest-environment happy-dom
//
// The show-once contextual tip toast (discovery-tips.ts): each key fires at
// most once per browser, dismisses by ✕ or timer, and a newer tip replaces
// any tip still on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TIP_DISMISS_MS,
  TIP_KEY_PREFIX,
  showTipOnce,
  tipSeen,
} from "./discovery-tips.ts";

function tip(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".discovery-tip");
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("showTipOnce", () => {
  it("shows the first time and marks the key seen immediately", () => {
    expect(tipSeen("analysis")).toBe(false);
    expect(showTipOnce("analysis", "Explore the ecosystem.")).toBe(true);
    expect(tip()?.textContent).toContain("Explore the ecosystem.");
    expect(localStorage.getItem(TIP_KEY_PREFIX + "analysis")).toBe("1");
    expect(tipSeen("analysis")).toBe(true);
  });

  it("never shows the same key twice", () => {
    showTipOnce("analysis", "first");
    tip()?.remove();
    expect(showTipOnce("analysis", "second")).toBe(false);
    expect(tip()).toBeNull();
  });

  it("dismisses via the ✕", () => {
    showTipOnce("high-risk", "Why this is high risk.");
    tip()!
      .querySelector<HTMLButtonElement>(".discovery-tip__close")!
      .click();
    expect(tip()).toBeNull();
  });

  it("auto-dismisses after the timeout", () => {
    showTipOnce("territory", "Defend your hex.");
    expect(tip()).not.toBeNull();
    vi.advanceTimersByTime(TIP_DISMISS_MS + 1);
    expect(tip()).toBeNull();
  });

  it("a newer tip replaces one still on screen", () => {
    showTipOnce("a", "older tip");
    showTipOnce("b", "newer tip");
    const tips = document.querySelectorAll(".discovery-tip");
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toContain("newer tip");
  });
});
