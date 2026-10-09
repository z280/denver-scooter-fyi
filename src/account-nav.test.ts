// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./geocode.ts", () => ({ reverseGeocode: vi.fn().mockResolvedValue(null) }));

import { DIBS_SMS_SETTING_ID, DIBS_SMS_TOGGLE_ID, buildNavPanel } from "./account-nav.ts";
import { _resetFavoritesForTests, loadFavorites } from "./favorites.ts";
import { readSlot } from "./favorite-slots.ts";
import { MAX_HAND_OFFS_KEY, handOffCap } from "./plan-prefs.ts";
import { idealSplit } from "./ideal-share.ts";

const fakeStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

let host: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  _resetFavoritesForTests();
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.append(host);
});

const select = (label: string): HTMLSelectElement =>
  [...host.querySelectorAll<HTMLSelectElement>("select")].find(
    (s) => s.getAttribute("aria-label") === label,
  )!;

const change = (node: HTMLSelectElement | HTMLInputElement): void => {
  node.dispatchEvent(new Event("change", { bubbles: true }));
};

const slotRow = (label: string): HTMLElement =>
  [...host.querySelectorAll<HTMLElement>(".account-favslot")].find((r) =>
    r.querySelector(".control-label")?.textContent?.includes(label),
  )!;

const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );

describe("favourite destinations", () => {
  it("shows all four rows, unset, with Home and Work named for us", () => {
    buildNavPanel(host);
    const labels = [...host.querySelectorAll<HTMLElement>(".account-favslot .control-label")]
      .map((n) => n.textContent ?? "");
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("Home");
    expect(labels[1]).toContain("Work");
    expect(labels[2]).toContain("Custom 1");
    expect(labels[3]).toContain("Custom 2");
    expect(host.textContent).toContain("Not set");
  });

  it("only offers Rename on the two custom rows, and only once set", () => {
    buildNavPanel(host);
    // Nothing is set yet, so there is nothing to name.
    for (const label of ["Home", "Work", "Custom 1", "Custom 2"]) {
      expect(button(slotRow(label), "Rename")?.hidden).not.toBe(false);
    }
  });

  it("hides 'Pick on map' when no picker was supplied", () => {
    buildNavPanel(host);
    expect(button(slotRow("Home"), "Pick on map")!.hidden).toBe(true);
  });

  it("stores a picked place against the slot and redraws the row", async () => {
    const pickLocation = vi.fn().mockResolvedValue({ lat: 39.7, lng: -104.9 });
    buildNavPanel(host, { pickLocation });

    button(slotRow("Home"), "Pick on map")!.click();
    await vi.waitFor(() => {
      expect(readSlot("home").place).toEqual({ lat: 39.7, lon: -104.9 });
    });
    expect(slotRow("Home").textContent).not.toContain("Not set");
    // One store: it is an ordinary favourite, which is how "Where to?" finds it.
    expect(loadFavorites().some((f) => f.id === "slot:home")).toBe(true);
  });

  it("tells the host about every slot that changes, customs included", async () => {
    // There is no profile column to mirror into any more — Home and Work are
    // two saved places like the other two, and this seam exists only so the
    // map pins (drawn from these same slots) can be repainted.
    const pickLocation = vi.fn().mockResolvedValue({ lat: 39.7, lng: -104.9 });
    const onFavoritesChanged = vi.fn();
    buildNavPanel(host, { pickLocation, onFavoritesChanged });

    for (const label of ["Work", "Custom 2"]) {
      onFavoritesChanged.mockClear();
      button(slotRow(label), "Pick on map")!.click();
      await vi.waitFor(() => expect(onFavoritesChanged).toHaveBeenCalled());
    }

    // Clearing is a change too: the pin has to come off the map with the slot.
    onFavoritesChanged.mockClear();
    button(slotRow("Work"), "Clear")!.click();
    expect(onFavoritesChanged).toHaveBeenCalled();
    expect(readSlot("work").place).toBeNull();
  });

  it("renames a custom slot once it has a place", async () => {
    const pickLocation = vi.fn().mockResolvedValue({ lat: 39.7, lng: -104.9 });
    buildNavPanel(host, { pickLocation });
    const row = slotRow("Custom 1");
    button(row, "Pick on map")!.click();
    await vi.waitFor(() => {
      expect(readSlot("custom1").place).not.toBeNull();
    });

    const rename = button(slotRow("Custom 1"), "Rename")!;
    expect(rename.hidden).toBe(false);
    rename.click();
    const input = slotRow("Custom 1").querySelector<HTMLInputElement>('input[type="text"]')!;
    input.value = "Gym";
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(readSlot("custom1").label).toBe("Gym");
    expect(slotRow("Gym").textContent).toContain("Gym");
  });

  it("clearing empties the slot but keeps the row", async () => {
    const pickLocation = vi.fn().mockResolvedValue({ lat: 39.7, lng: -104.9 });
    buildNavPanel(host, { pickLocation });
    button(slotRow("Home"), "Pick on map")!.click();
    await vi.waitFor(() => {
      expect(readSlot("home").place).not.toBeNull();
    });

    button(slotRow("Home"), "Clear")!.click();
    expect(readSlot("home").place).toBeNull();
    expect(host.querySelectorAll(".account-favslot")).toHaveLength(4);
    expect(slotRow("Home").textContent).toContain("Not set");
  });

  it("tells the host when a favourite changed", async () => {
    const onFavoritesChanged = vi.fn();
    const pickLocation = vi.fn().mockResolvedValue({ lat: 39.7, lng: -104.9 });
    buildNavPanel(host, { pickLocation, onFavoritesChanged });
    button(slotRow("Home"), "Pick on map")!.click();
    await vi.waitFor(() => expect(onFavoritesChanged).toHaveBeenCalled());
  });
});

describe("trip plans", () => {
  it("offers the three hand-off caps and saves a pick", () => {
    buildNavPanel(host);
    const cap = select("Switching scooters");
    expect(cap.value).toBe("any");

    cap.value = "0";
    change(cap);
    expect(handOffCap()).toBe(0);
  });

  it("explains each cap, because the three labels do not describe themselves", () => {
    buildNavPanel(host);
    const cap = select("Switching scooters");
    const hintOf = () =>
      cap.parentElement!.querySelector(".account-hint")!.textContent;
    const atAny = hintOf();
    cap.value = "0";
    change(cap);
    expect(hintOf()).not.toBe(atAny);
    expect(hintOf()!.length).toBeGreaterThan(0);
  });

  it("saves the split preference", () => {
    buildNavPanel(host);
    const split = select("When a trip is split");
    split.value = "prefer_ideal";
    change(split);
    expect(idealSplit()).toBe("prefer_ideal");
  });

  it("says plainly when the split preference has nothing to prefer yet", () => {
    // A control that silently does nothing looks broken; one that says it is
    // waiting on an ideal scooter tells the rider how to make it matter.
    buildNavPanel(host, { hasIdealSpec: () => false });
    expect(host.textContent).toContain("haven't set up an ideal scooter");

    document.body.replaceChildren();
    const second = document.createElement("div");
    document.body.append(second);
    buildNavPanel(second, { hasIdealSpec: () => true });
    expect(second.textContent).toContain("ideal scooter is set up");
  });
});

describe("refresh", () => {
  it("re-reads the preferences, which another surface can have changed", () => {
    const handle = buildNavPanel(host);
    localStorage.setItem(MAX_HAND_OFFS_KEY, "0");

    handle.refresh();

    expect(select("Switching scooters").value).toBe("0");
  });
});

describe("the dibs SMS switch, as the certificate's link finds it", () => {
  it("is the Calling dibs SMS checkbox, under ids the certificate link targets", () => {
    buildNavPanel(host);
    const input = host.querySelector<HTMLInputElement>(`#${DIBS_SMS_TOGGLE_ID}`);
    const label = host.querySelector<HTMLElement>(`#${DIBS_SMS_SETTING_ID}`);
    expect(input?.type).toBe("checkbox");
    expect(label?.contains(input!)).toBe(true);
    expect(label?.textContent).toContain("Notify me via SMS if my dibs are disrespected");
    // Focusable even while the switch is disabled (no verified phone), so the
    // link can still land on it and the hint beside it.
    expect(label?.tabIndex).toBe(-1);
    expect(input?.closest(".account-section")?.textContent).toContain("Calling dibs");
  });
});
