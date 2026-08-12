// @vitest-environment happy-dom
//
// The strip under the map. Most of what is pinned here is that it RESERVES
// space rather than covering the map, and that a private scooter is a
// first-class citizen of it — the app serves people who already own one, and
// a dock that only lit up for rentals would say otherwise every time.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createActiveVehicle, type ActiveVehicleHandle } from "./active-vehicle.ts";

let root: HTMLElement;
let strip: ActiveVehicleHandle | null = null;
const calls: string[] = [];

function mount(withEnd = true) {
  strip = createActiveVehicle(root, {
    onOpen: () => void calls.push("open"),
    ...(withEnd ? { onEnd: () => void calls.push("end") } : {}),
  });
  return strip;
}

const text = (sel: string) => root.querySelector(sel)?.textContent ?? "";

beforeEach(() => {
  document.body.replaceChildren();
  document.body.className = "";
  root = document.createElement("div");
  document.body.append(root);
  calls.length = 0;
});

afterEach(() => {
  strip?.destroy();
  strip = null;
});

describe("reserving the space", () => {
  it("takes no space until something is running", () => {
    mount();
    expect(root.hidden).toBe(true);
    expect(document.body.classList.contains("has-active-vehicle")).toBe(false);
  });

  it("reserves space via the body class the map's height is computed against", () => {
    // This is what makes it a region and not another floating panel: the map
    // gives up the space rather than being covered by it.
    mount().set({ name: "Lunar 🐸 928" });
    expect(document.body.classList.contains("has-active-vehicle")).toBe(true);
    expect(root.hidden).toBe(false);
  });

  it("gives the space back when the ride ends", () => {
    const s = mount();
    s.set({ name: "Lunar 🐸 928" });
    s.set(null);
    expect(document.body.classList.contains("has-active-vehicle")).toBe(false);
    expect(s.isShowing()).toBe(false);
  });

  it("does not leave the map short after teardown", () => {
    const s = mount();
    s.set({ name: "Lunar 🐸 928" });
    s.destroy();
    strip = null;
    expect(document.body.classList.contains("has-active-vehicle")).toBe(false);
  });
});

describe("what it says", () => {
  it("names the vehicle", () => {
    mount().set({ name: "Lunar 🐸 928" });
    expect(text(".active-vehicle__name")).toBe("Lunar 🐸 928");
  });

  it("treats the rider's own scooter as first class", () => {
    mount().set({ name: "My scooter", own: true, model: "NIU KQi3" });
    expect(text(".active-vehicle__name")).toBe("My scooter");
    expect(text(".active-vehicle__meta")).toContain("Your own");
    expect(text(".active-vehicle__meta")).toContain("NIU KQi3");
  });

  it("shows charge when anything reports one", () => {
    mount().set({ name: "Lunar 🐸 928", batteryPercent: 64 });
    expect(text(".active-vehicle__meta")).toContain("64%");
  });

  it("says nothing about charge when nobody knows it", () => {
    // A private scooter has no reported charge unless the rider told us.
    mount().set({ name: "My scooter", own: true });
    expect(text(".active-vehicle__meta")).not.toContain("%");
  });

  it("never renders a separator between things that are not there", () => {
    // " · · " reads as a rendering fault, not as missing data.
    mount().set({ name: "Lunar 🐸 928" });
    expect(text(".active-vehicle__meta")).not.toContain("·");
  });

  it("carries free-text context, like the walk to it", () => {
    mount().set({ name: "Lunar 🐸 928", detail: "3 min · 240 m" });
    expect(text(".active-vehicle__meta")).toContain("3 min");
  });
});

describe("what it does", () => {
  it("takes the rider back to what they are on", () => {
    mount().set({ name: "Lunar 🐸 928" });
    root.querySelector<HTMLButtonElement>(".active-vehicle__main")!.click();
    expect(calls).toEqual(["open"]);
  });

  it("ending does not also trigger going back", () => {
    // The body of the strip is one big "take me back" target; ending is the
    // rarer, deliberate act and must not ride on top of it.
    mount().set({ name: "Lunar 🐸 928" });
    root.querySelector<HTMLButtonElement>(".active-vehicle__end")!.click();
    expect(calls).toEqual(["end"]);
  });

  it("offers no End while there is nothing to end", () => {
    // Walking to a scooter is not a ride yet.
    mount(false).set({ name: "Lunar 🐸 928", detail: "walking to it" });
    expect(root.querySelector(".active-vehicle__end")).toBeNull();
  });
});
