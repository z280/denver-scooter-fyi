// @vitest-environment happy-dom
//
// The Account drawer's tab shell. These cover the two properties the rest of
// the drawer leans on — the strip survives panel rebuilds, and a disabled tab
// stays reachable so the rider can be told why it's dimmed — plus the ARIA
// wiring and the roving-tabindex contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_TAB_IDS,
  createAccountTabs,
  type AccountTabId,
} from "./account-tabs.ts";

let host: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("section");
  document.body.append(host);
});

afterEach(() => {
  document.body.replaceChildren();
});

const tabFor = (id: AccountTabId): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`#account-tab-${id}`)!;

// ---------- structure ----------

describe("structure and aria", () => {
  it("renders four tabs and four panels, correctly paired", () => {
    const tabs = createAccountTabs(host);
    const strip = host.querySelector('[role="tablist"]')!;
    expect(strip.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(host.querySelectorAll('[role="tabpanel"]')).toHaveLength(4);

    for (const id of ACCOUNT_TAB_IDS) {
      const tab = tabFor(id);
      const panel = tabs.panel(id);
      expect(tab.getAttribute("aria-controls")).toBe(panel.id);
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });

  it("shows only the selected panel and defaults to login", () => {
    const tabs = createAccountTabs(host);
    expect(tabs.selected()).toBe("login");
    expect(tabs.panel("login").hidden).toBe(false);
    expect(tabs.panel("profile").hidden).toBe(true);
    expect(tabFor("login").getAttribute("aria-selected")).toBe("true");
    expect(tabFor("profile").getAttribute("aria-selected")).toBe("false");
  });

  it("honours the initial tab", () => {
    const tabs = createAccountTabs(host, { initial: "community" });
    expect(tabs.selected()).toBe("community");
    expect(tabs.panel("community").hidden).toBe(false);
  });

  it("keeps exactly one tab stop, on the selected tab", () => {
    const tabs = createAccountTabs(host);
    const stops = () =>
      ACCOUNT_TAB_IDS.filter((id) => tabFor(id).tabIndex === 0);
    expect(stops()).toEqual(["login"]);
    tabs.select("profile");
    expect(stops()).toEqual(["profile"]);
  });
});

// ---------- selection ----------

describe("selection", () => {
  it("selects on click and fires onShow once per change", () => {
    const onShow = vi.fn();
    const tabs = createAccountTabs(host, { onShow });
    onShow.mockClear(); // the constructor announces the initial panel

    tabFor("profile").click();
    expect(tabs.selected()).toBe("profile");
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith("profile");

    // Re-selecting the same tab is not a change.
    tabFor("profile").click();
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("announces the initial panel on construction", () => {
    const onShow = vi.fn();
    createAccountTabs(host, { initial: "local", onShow });
    expect(onShow).toHaveBeenCalledWith("local");
  });
});

// ---------- disabled tabs ----------

describe("disabled tabs", () => {
  it("marks them aria-disabled but leaves them focusable", () => {
    const tabs = createAccountTabs(host);
    tabs.setEnabled("profile", false);
    const tab = tabFor("profile");
    expect(tab.getAttribute("aria-disabled")).toBe("true");
    expect(tab.classList.contains("is-disabled")).toBe(true);
    // Crucially NOT the `disabled` property, which would make it unfocusable.
    expect(tab.disabled).toBe(false);
    tab.focus();
    expect(document.activeElement).toBe(tab);
  });

  it("refuses selection and reports why", () => {
    const onBlocked = vi.fn();
    const onShow = vi.fn();
    const tabs = createAccountTabs(host, { onBlocked, onShow });
    tabs.setEnabled("local", false);
    onShow.mockClear();

    tabFor("local").click();
    expect(tabs.selected()).toBe("login");
    expect(tabs.panel("local").hidden).toBe(true);
    expect(onBlocked).toHaveBeenCalledWith("local");
    expect(onShow).not.toHaveBeenCalled();
  });

  it("force overrides the gate", () => {
    const tabs = createAccountTabs(host);
    tabs.setEnabled("profile", false);
    tabs.select("profile", { force: true });
    expect(tabs.selected()).toBe("profile");
  });

  it("re-enabling restores normal selection", () => {
    const tabs = createAccountTabs(host);
    tabs.setEnabled("profile", false);
    tabs.select("profile");
    expect(tabs.selected()).toBe("login");
    tabs.setEnabled("profile", true);
    tabs.select("profile");
    expect(tabs.selected()).toBe("profile");
    expect(tabFor("profile").getAttribute("aria-disabled")).toBe("false");
  });
});

// ---------- keyboard ----------

describe("keyboard", () => {
  const key = (k: string): void => {
    host
      .querySelector('[role="tablist"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  };

  it("moves and selects with arrows, wrapping at both ends", () => {
    const tabs = createAccountTabs(host);
    key("ArrowRight");
    expect(tabs.selected()).toBe("profile");
    key("ArrowLeft");
    expect(tabs.selected()).toBe("login");
    // wraps backwards from the first tab to the last
    key("ArrowLeft");
    expect(tabs.selected()).toBe("local");
    // and forwards from the last back to the first
    key("ArrowRight");
    expect(tabs.selected()).toBe("login");
  });

  it("jumps with Home and End", () => {
    const tabs = createAccountTabs(host, { initial: "profile" });
    key("End");
    expect(tabs.selected()).toBe("local");
    key("Home");
    expect(tabs.selected()).toBe("login");
  });

  it("moves focus onto a disabled tab without selecting it", () => {
    const onBlocked = vi.fn();
    const tabs = createAccountTabs(host, { onBlocked });
    tabs.setEnabled("profile", false);
    key("ArrowRight");
    expect(tabs.selected()).toBe("login");
    expect(document.activeElement).toBe(tabFor("profile"));
    expect(onBlocked).toHaveBeenCalledWith("profile");
  });

  it("ignores keys it does not handle", () => {
    const tabs = createAccountTabs(host);
    key("a");
    expect(tabs.selected()).toBe("login");
  });
});

// ---------- teardown ----------

describe("teardown", () => {
  it("stops responding to clicks after dispose", () => {
    const tabs = createAccountTabs(host);
    tabs.dispose();
    tabFor("profile").click();
    expect(tabs.selected()).toBe("login");
  });

  it("stops responding to keyboard after dispose", () => {
    const tabs = createAccountTabs(host);
    tabs.dispose();
    host
      .querySelector('[role="tablist"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    expect(tabs.selected()).toBe("login");
  });
});
