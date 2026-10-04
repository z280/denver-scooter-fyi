// @vitest-environment happy-dom
//
// The Tools drawer's watch list. It renders and decides nothing — every rule it
// shows lives in `device-notify.ts` — so what is pinned here is what the rider
// can see and press, and the one promise the copy is allowed to make.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  showMovedToast,
  wireDeviceNotifyPanel,
  type DeviceNotifyPanelHandle,
} from "./device-notify-panel.ts";
import { MAX_WATCHED_DEVICES, type WatchedDevice } from "./device-notify.ts";

let section: HTMLElement;
let list: HTMLElement;
let status: HTMLElement;
let panel: DeviceNotifyPanelHandle | null = null;

function watch(over: Partial<WatchedDevice> = {}): WatchedDevice {
  return {
    vehicleIdentifier: "0123456789abcdef",
    name: "Lunar 🐸 928",
    lat: 39.74,
    lon: -104.99,
    since: 1_700_000_000_000,
    ...over,
  };
}

function mount(
  watches: WatchedDevice[],
  over: Partial<Parameters<typeof wireDeviceNotifyPanel>[0]> = {},
) {
  let current = watches;
  const remove = vi.fn((id: string) => {
    current = current.filter((w) => w.vehicleIdentifier !== id);
    return current;
  });
  panel = wireDeviceNotifyPanel({
    section,
    list,
    status,
    locate: { current: () => null },
    read: () => current,
    remove,
    ...over,
  });
  return { panel, remove };
}

const rows = () => [...list.querySelectorAll<HTMLElement>(".notify-moved__row")];
const buttonIn = (row: HTMLElement, label: string) =>
  [...row.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label,
  );

beforeEach(() => {
  document.body.replaceChildren();
  section = document.createElement("section");
  list = document.createElement("ul");
  status = document.createElement("p");
  section.append(list, status);
  document.body.append(section);
});

afterEach(() => {
  panel?.destroy();
  panel = null;
  document.body.replaceChildren();
});

describe("the list", () => {
  it("is shown even with nothing in it, and says where the switch is", () => {
    // Unlike its Favorite Scooters predecessor, which hid itself while signed
    // out: watching needs no account, so there is no state in which this
    // heading is a reminder of something the visitor cannot have.
    mount([]);
    expect(section.hidden).toBe(false);
    expect(list.textContent).toContain("Notify me if moved");
  });

  it("names each watched scooter", () => {
    mount([
      watch({ vehicleIdentifier: "a".repeat(16), name: "Lunar 🐸 928" }),
      watch({ vehicleIdentifier: "b".repeat(16), name: "Solar ☀️ 12" }),
    ]);
    expect(rows()).toHaveLength(2);
    expect(list.textContent).toContain("Lunar 🐸 928");
    expect(list.textContent).toContain("Solar ☀️ 12");
  });

  it("promises only what it can keep", () => {
    mount([watch()]);
    // The check runs on the device feed's own refresh, in this tab. The
    // backgrounded half needs an API-side watcher that is not in this repo
    // (ALONG_THE_WAY_PLAN §9.4), so the copy must not imply a closed tab buzzes.
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("while the app is open");
  });

  it("says when the list is full, rather than silently refusing later", () => {
    const full = Array.from({ length: MAX_WATCHED_DEVICES }, (_, i) =>
      watch({ vehicleIdentifier: String(i).padStart(16, "0"), name: `v${i}` }),
    );
    mount(full);
    expect(status.textContent).toContain(String(MAX_WATCHED_DEVICES));
    expect(status.textContent).toMatch(/stop watching one/i);
  });

  it("shows a distance only when the rider's location is known", () => {
    mount([watch()], { locate: { current: () => null } });
    expect(list.querySelector(".notify-moved__where")).toBeNull();

    panel?.destroy();
    list.replaceChildren();
    mount([watch()], {
      locate: { current: () => ({ lng: -104.98, lat: 39.75 }) },
    });
    expect(list.querySelector(".notify-moved__where")?.textContent).toBeTruthy();
  });
});

describe("stopping a watch", () => {
  it("removes the row and tells the caller", () => {
    const onChanged = vi.fn();
    const { remove } = mount([watch()], { onChanged });
    buttonIn(rows()[0], "Stop")!.click();
    expect(remove).toHaveBeenCalledWith(watch().vehicleIdentifier);
    expect(rows()).toHaveLength(0);
    // The bell on an open popup has to un-press, which is what the caller does
    // with this.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("leaves the other rows alone", () => {
    mount([
      watch({ vehicleIdentifier: "a".repeat(16), name: "A" }),
      watch({ vehicleIdentifier: "b".repeat(16), name: "B" }),
    ]);
    buttonIn(rows()[0], "Stop")!.click();
    expect(rows()).toHaveLength(1);
    expect(list.textContent).toContain("B");
  });

  it("names the scooter for assistive tech, since every row says 'Stop'", () => {
    mount([watch({ name: "Lunar 🐸 928" })]);
    expect(buttonIn(rows()[0], "Stop")?.getAttribute("aria-label")).toBe(
      "Stop watching Lunar 🐸 928",
    );
  });
});

describe("showing one on the map", () => {
  it("offers Show only when the caller can do it", () => {
    mount([watch()]);
    expect(buttonIn(rows()[0], "Show")).toBeFalsy();

    panel?.destroy();
    list.replaceChildren();
    const onShowOnMap = vi.fn();
    mount([watch()], { onShowOnMap });
    buttonIn(rows()[0], "Show")!.click();
    expect(onShowOnMap).toHaveBeenCalledWith(watch());
  });
});

describe("refresh", () => {
  it("repaints against the current list", () => {
    let current = [watch({ vehicleIdentifier: "a".repeat(16), name: "A" })];
    panel = wireDeviceNotifyPanel({
      section,
      list,
      status,
      locate: { current: () => null },
      read: () => current,
      remove: () => current,
    });
    expect(rows()).toHaveLength(1);
    current = [...current, watch({ vehicleIdentifier: "b".repeat(16), name: "B" })];
    panel.refresh();
    expect(rows()).toHaveLength(2);
  });

  it("does nothing once destroyed", () => {
    const { panel: p } = mount([watch()]);
    p.destroy();
    expect(() => p.refresh()).not.toThrow();
    expect(rows()).toHaveLength(0);
  });
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
