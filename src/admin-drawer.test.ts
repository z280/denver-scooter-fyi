// @vitest-environment happy-dom
//
// ⚙ Admin: the tab and its controls exist only while the server calls this
// session an admin, and follow that flag live.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SERVER_ADMIN_URL, wireAdminDrawer } from "./admin-drawer.ts";

let tab: HTMLButtonElement;
let body: HTMLElement;
let watchHost: HTMLElement;

function mount() {
  const deps = {
    tab,
    body,
    watchHost,
    close: vi.fn(() => tab.classList.remove("is-active")),
    openManageAdmins: vi.fn(),
    openReport: vi.fn(),
  };
  return { h: wireAdminDrawer(deps), deps };
}

beforeEach(() => {
  document.body.replaceChildren();
  tab = document.createElement("button");
  tab.className = "drawer-tab";
  tab.dataset.drawer = "admin";
  tab.hidden = true;
  body = document.createElement("div");
  watchHost = document.createElement("div");
  watchHost.id = "tools-mine-admin";
  document.body.append(tab, body);
});

describe("for a non-admin", () => {
  it("never shows the tab and builds no admin control", () => {
    const { h } = mount();
    h.setAdmin(false);
    expect(tab.hidden).toBe(true);
    expect(body.childElementCount).toBe(0);
    for (const id of ["admin-manage", "admin-traffic", "admin-events", "admin-server-link", "tools-mine-admin"]) {
      expect(document.getElementById(id)).toBeNull();
    }
  });
});

describe("for an admin", () => {
  it("shows the tab and every admin control", () => {
    const { h, deps } = mount();
    h.setAdmin(true);
    expect(tab.hidden).toBe(false);
    expect(h.isAdmin()).toBe(true);
    expect(body.contains(watchHost)).toBe(true);
    (document.getElementById("admin-manage") as HTMLButtonElement).click();
    expect(deps.openManageAdmins).toHaveBeenCalledTimes(1);
    (document.getElementById("admin-traffic") as HTMLButtonElement).click();
    (document.getElementById("admin-events") as HTMLButtonElement).click();
    expect(deps.openReport.mock.calls).toEqual([["traffic"], ["events"]]);
    const link = document.getElementById("admin-server-link") as HTMLAnchorElement;
    expect(link.href).toBe(SERVER_ADMIN_URL);
    expect(SERVER_ADMIN_URL).toBe("https://data.scooter.fyi/admin");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener");
    expect(link.textContent).toBe("Server admin panel ↗");
  });

  it("disappears live when admin ends, closing the drawer if it was open", () => {
    const { h, deps } = mount();
    h.setAdmin(true);
    tab.classList.add("is-active");
    h.setAdmin(false);
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(tab.hidden).toBe(true);
    expect(body.childElementCount).toBe(0);
    expect(document.getElementById("admin-manage")).toBeNull();
  });

  it("comes back on the next sign-in", () => {
    const { h } = mount();
    h.setAdmin(true);
    h.setAdmin(false);
    h.setAdmin(true);
    expect(tab.hidden).toBe(false);
    expect(document.querySelectorAll("#admin-manage")).toHaveLength(1);
  });
});
