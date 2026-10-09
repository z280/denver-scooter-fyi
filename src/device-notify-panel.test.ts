// @vitest-environment happy-dom
//
// The move-watch toast. The list that used to live beside it is
// `tools-mine.ts` now, and is pinned in `tools-mine.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";

import { showMovedToast } from "./device-notify-panel.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("the in-app toast", () => {
  const toast = () => document.querySelector<HTMLElement>(".notify-moved-toast");

  it("interrupts, and says so to assistive tech", () => {
    showMovedToast("🛴 Lunar 🐸 928 has moved — somebody rode it.");
    expect(toast()?.textContent).toContain("has moved");
    // `alert`, not `status`: this interrupts on purpose.
    expect(toast()?.getAttribute("role")).toBe("alert");
  });

  it("does not disappear on its own", async () => {
    vi.useFakeTimers();
    showMovedToast("🛴 it moved");
    // "It moved" is the whole content and there is no second chance to read it,
    // unlike a countdown, which is still true a minute later.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toast()).not.toBeNull();
    vi.useRealTimers();
  });

  it("offers to take the rider to it, and closes when it does", () => {
    const onShow = vi.fn();
    showMovedToast("🛴 it moved", onShow);
    const show = [...toast()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Show me",
    )!;
    show.click();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(toast()).toBeNull();
  });

  it("can be dismissed", () => {
    showMovedToast("🛴 it moved");
    const close = [...toast()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Dismiss",
    )!;
    close.click();
    expect(toast()).toBeNull();
  });

  it("replaces an earlier one rather than stacking", () => {
    showMovedToast("first");
    showMovedToast("second");
    expect(document.querySelectorAll(".notify-moved-toast")).toHaveLength(1);
    expect(toast()?.textContent).toContain("second");
  });
});
