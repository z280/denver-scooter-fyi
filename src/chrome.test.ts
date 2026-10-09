// @vitest-environment happy-dom
//
// The ribbon's screen-space etiquette. On a phone the left tab strip slides
// out ACROSS whatever is open — a drawer, a device card — so the strip has to
// stand aside for them and come back afterwards.
//
// The hard part is not the collapse, it is the bookkeeping around it:
//
//   * collapsing the ribbon normally CLOSES the open left drawer (a drawer
//     with no visible origin is a dead end). Collapsing it *for* that drawer
//     has to not do that, or the yield closes the thing it was making room
//     for.
//   * the restore must put back only what we took. A rider who tucked the
//     strip away themselves should not find it back when a popup closes.
//   * none of it may happen on a desktop, where both fit side by side.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  initChrome,
  isRibbonOpen,
  setRibbonOpen,
  yieldRibbonToDrawer,
  restoreRibbonAfterDrawer,
} from "./chrome.ts";

/** Stub `matchMedia` so the module's own 640px query answers `narrow`. */
function stubWidth(narrow: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: narrow && q.includes("max-width"),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
        onchange: null,
      }) as unknown as MediaQueryList,
  );
}

function layout(): { leftTab: HTMLButtonElement; profileTab: HTMLButtonElement } {
  document.body.className = "";
  document.body.innerHTML = `
    <button id="ribbon-toggle"></button>
    <button class="drawer-tab drawer-tab--topbar" data-drawer="account"></button>
    <nav id="drawer-tabs"><button class="drawer-tab" data-drawer="devices"></button></nav>`;
  const leftTab = document.querySelector<HTMLButtonElement>(
    "#drawer-tabs .drawer-tab",
  )!;
  const profileTab = document.querySelector<HTMLButtonElement>(
    ".drawer-tab--topbar",
  )!;
  // Stand in for wireDrawers: the only thing chrome.ts asks of a tab is that
  // clicking it toggles `is-active`.
  for (const tab of [leftTab, profileTab]) {
    tab.addEventListener("click", () => tab.classList.toggle("is-active"));
  }
  return { leftTab, profileTab };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the ribbon stands aside for a drawer", () => {
  it("collapses on a phone and comes back when the drawer closes", () => {
    stubWidth(true);
    layout();
    setRibbonOpen(true);
    expect(isRibbonOpen()).toBe(true);

    yieldRibbonToDrawer();
    expect(isRibbonOpen()).toBe(false);

    restoreRibbonAfterDrawer();
    expect(isRibbonOpen()).toBe(true);
  });

  it("leaves the drawer that it is making room FOR open", () => {
    // The trap. applyRibbon's close path clicks the active left tab, because
    // a drawer whose tab strip just vanished has no visible origin. For a
    // yield that is exactly backwards.
    stubWidth(true);
    const { leftTab } = layout();
    setRibbonOpen(true);
    leftTab.click();
    expect(leftTab.classList.contains("is-active")).toBe(true);

    yieldRibbonToDrawer();
    expect(isRibbonOpen()).toBe(false);
    expect(leftTab.classList.contains("is-active")).toBe(true);
  });

  it("still closes a stranded drawer when the rider collapses the strip", () => {
    // Same path, the non-yield case, which must keep working.
    stubWidth(true);
    const { leftTab } = layout();
    setRibbonOpen(true);
    leftTab.click();

    setRibbonOpen(false);
    expect(leftTab.classList.contains("is-active")).toBe(false);
  });

  it("does nothing on a desktop, where both fit", () => {
    stubWidth(false);
    layout();
    setRibbonOpen(true);

    yieldRibbonToDrawer();
    expect(isRibbonOpen()).toBe(true);
    restoreRibbonAfterDrawer();
    expect(isRibbonOpen()).toBe(true);
  });

  it("does not open a ribbon the rider had already closed", () => {
    // Restoring unconditionally would hand a phone rider a menu they never
    // asked for, every time they shut a device card.
    stubWidth(true);
    layout();
    setRibbonOpen(false);

    yieldRibbonToDrawer();
    restoreRibbonAfterDrawer();
    expect(isRibbonOpen()).toBe(false);
  });

  it("forgets the loan once the rider works the hamburger", () => {
    // Yield, then a deliberate close: the strip is now closed because the
    // rider closed it, so the drawer closing afterwards must not reopen it.
    stubWidth(true);
    layout();
    setRibbonOpen(true);
    yieldRibbonToDrawer();
    setRibbonOpen(true, { persist: true });
    setRibbonOpen(false, { persist: true });

    restoreRibbonAfterDrawer();
    expect(isRibbonOpen()).toBe(false);
  });

  it("restores once, not once per popup", () => {
    stubWidth(true);
    layout();
    setRibbonOpen(true);
    yieldRibbonToDrawer();
    restoreRibbonAfterDrawer();
    setRibbonOpen(false);

    restoreRibbonAfterDrawer();
    expect(isRibbonOpen()).toBe(false);
  });
});

describe("the profile drawer and the main menu", () => {
  it("closes the profile drawer when the strip opens on a phone", () => {
    // "Vice versa": the profile drawer hangs off the top bar, so a ribbon
    // collapse leaves it alone — but it is full height on a phone, and the
    // strip sliding out underneath it serves nobody.
    stubWidth(true);
    const { profileTab } = layout();
    setRibbonOpen(false);
    profileTab.click();
    expect(profileTab.classList.contains("is-active")).toBe(true);

    setRibbonOpen(true);
    expect(profileTab.classList.contains("is-active")).toBe(false);
  });

  it("leaves the profile drawer alone on a desktop", () => {
    stubWidth(false);
    const { profileTab } = layout();
    setRibbonOpen(false);
    profileTab.click();

    setRibbonOpen(true);
    expect(profileTab.classList.contains("is-active")).toBe(true);
  });

  it("initChrome opens the ribbon on a desktop and closes it on a phone", () => {
    // The breakpoint default, asserted here because every yield above is a
    // no-op when this is wrong in the closed direction.
    stubWidth(false);
    layout();
    initChrome();
    expect(isRibbonOpen()).toBe(true);

    stubWidth(true);
    layout();
    initChrome();
    expect(isRibbonOpen()).toBe(false);
  });
});
