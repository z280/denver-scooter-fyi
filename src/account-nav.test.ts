// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./geocode.ts", () => ({ reverseGeocode: vi.fn().mockResolvedValue(null) }));

import { buildNavPanel } from "./account-nav.ts";
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

  it("reports Home and Work up to the server half, and only those two", async () => {
    // The seam exists so the profile's home_lat/work_lat columns — which draw
    // the map pins and count towards the profile-completion award — do not
    // disagree with the slot the rider just set. The two custom slots have no
    // column, so firing for them would be a patch with nothing in it.
    const pickLocation = vi.fn().mockResolvedValue({ lat: 39.7, lng: -104.9 });
    const onHomeWorkChanged = vi.fn();
    buildNavPanel(host, { pickLocation, onHomeWorkChanged });

    button(slotRow("Work"), "Pick on map")!.click();
    await vi.waitFor(() => {
      expect(onHomeWorkChanged).toHaveBeenCalledWith("work", {
        lat: 39.7,
        lon: -104.9,
      });
    });

    // Clearing is a write too: the column has to go null with the slot.
    button(slotRow("Work"), "Clear")!.click();
    expect(onHomeWorkChanged).toHaveBeenLastCalledWith("work", null);

    onHomeWorkChanged.mockClear();
    button(slotRow("Custom 2"), "Pick on map")!.click();
    await vi.waitFor(() => {
      expect(readSlot("custom2").place).not.toBeNull();
    });
    expect(onHomeWorkChanged).not.toHaveBeenCalled();
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
