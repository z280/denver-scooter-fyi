// @vitest-environment happy-dom
//
// The panel that carries a rider from "I picked that one" to "I'm moving".
// What is pinned here is the ORDER of the arrived actions and the fact that
// starting navigation never depends on Veo cooperating.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createArrivalPanel, type ArrivalPanelHandle } from "./arrival-panel.ts";
import type { WalkState } from "./walk-leg.ts";

const BASE: WalkState = {
  remainingMeters: 240, routeMeters: 240, routeSeconds: 190,
  arrived: false, loading: false, error: false,
};

let root: HTMLElement;
let panel: ArrivalPanelHandle | null = null;
const calls: string[] = [];

function mount(over: Partial<Parameters<typeof createArrivalPanel>[1]> = {}) {
  panel = createArrivalPanel(root, {
    vehicle: { name: "Lunar 🐸 928", plate: "ABC123" },
    destinationLabel: "Home",
    onChooseRoute: () => void calls.push("route"),
    onCancel: () => void calls.push("cancel"),
    ...over,
  });
  return panel;
}

const buttons = () => [...root.querySelectorAll<HTMLElement>(".arrival__action")];
const named = (t: string) => buttons().find((b) => b.textContent?.includes(t));

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("div");
  document.body.append(root);
  calls.length = 0;
});

afterEach(() => {
  panel?.destroy();
  panel = null;
});

describe("while walking", () => {
  it("says how far, to what", () => {
    mount().update(BASE);
    expect(root.querySelector(".arrival__title")?.textContent).toBe("🚶 3 min · 240 m");
    expect(root.querySelector(".arrival__sub")?.textContent).toBe("to Lunar 🐸 928");
  });

  it("offers no ride actions yet", () => {
    mount().update(BASE);
    expect(named("Start 3D navigation")).toBeFalsy();
    expect(named("Open in Veo")).toBeFalsy();
  });

  it("lets the rider arrive early", () => {
    const p = mount();
    p.update(BASE);
    named("I'm at the scooter")!.click();
    expect(named("Choose your route")).toBeTruthy();
  });

  it("a routing failure reads as a note, not a failure", () => {
    mount().update({ ...BASE, error: true, routeMeters: null, routeSeconds: null });
    const note = root.querySelector(".arrival__note")?.textContent ?? "";
    expect(note).toContain("pinned on the map");
    expect(note).not.toMatch(/error|failed|unavailable/i);
  });
});

describe("at the scooter", () => {
  function arrive() {
    const p = mount();
    p.update({ ...BASE, arrived: true });
    return p;
  }

  it("names the vehicle and the destination, so the panel explains itself", () => {
    // The rider may have pocketed the phone for the whole walk.
    arrive();
    expect(root.querySelector(".arrival__title")?.textContent).toContain("Lunar 🐸 928");
    expect(root.querySelector(".arrival__sub")?.textContent).toContain("Home");
  });

  it("DOES NOT OFFER TO UNLOCK THE SCOOTER YET", () => {
    // Veo bills from unlock. Offering it here let a rider start the meter and
    // then spend two minutes reading route options.
    arrive();
    expect(named("Open in Veo")).toBeFalsy();
    expect(named("It's unlocked")).toBeFalsy();
  });

  it("says why unlocking is not on this screen", () => {
    // A rider standing at a scooter with the Veo app one tap away needs a
    // reason not to open it yet, and "the meter starts at unlock" is one.
    arrive();
    expect(root.querySelector(".arrival__note")?.textContent).toMatch(/meter/i);
  });

  it("offers exactly one way forward", () => {
    arrive();
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].textContent).toContain("Choose your route");
  });

  it("hands off to route selection", () => {
    arrive();
    named("Choose your route")!.click();
    expect(calls).toEqual(["route"]);
  });

  it("still explains itself for a vehicle with no plate", () => {
    const p = createArrivalPanel(root, {
      vehicle: { name: "Lunar 🐸 928" },
      destinationLabel: "Home",
      onChooseRoute: () => {},
      onCancel: () => {},
    });
    p.update({ ...BASE, arrived: true });
    expect(root.querySelector(".arrival__note")?.textContent).toMatch(/meter/i);
    p.destroy();
  });

  it("does not fall back to the walking face on a later fix", () => {
    // GPS drifts. Having arrived, drifting 40 m must not un-arrive the rider
    // and yank the button out from under their thumb.
    const p = arrive();
    p.update({ ...BASE, arrived: false, remainingMeters: 42 });
    expect(named("Choose your route")).toBeTruthy();
  });

  it("can be abandoned", () => {
    arrive();
    root.querySelector<HTMLButtonElement>(".arrival__close")!.click();
    expect(calls).toEqual(["cancel"]);
  });
});

describe("the dibs clock on the chip", () => {
  const claim = (over: Partial<import("./dibs.ts").Dibs> = {}) => ({
    vehicleIdentifier: "abc",
    vehicleName: "Lunar 🐸 928",
    plate: null,
    claimedBy: "Resourceful 🌈",
    claimedAt: Date.now(),
    startMeters: 600,
    bestMeters: 600,
    lat: 39.74,
    lon: -104.99,
    startedWalkingAt: null,
    registration: null,
    ...over,
  });

  const line = () => root.querySelector(".arrival__dibs")?.textContent ?? "";

  it("counts the grace down while they have not set off", () => {
    // The only clock they can do anything about before they move.
    mount({ dibs: () => claim() }).update(BASE);
    expect(line()).toMatch(/Start walking within \d+ min/);
  });

  it("switches to the hold once they ARE moving", () => {
    // The grace is satisfied and irrelevant; showing both would be two
    // countdowns competing for one glance.
    mount({ dibs: () => claim({ startedWalkingAt: Date.now() }) }).update(BASE);
    expect(line()).toMatch(/Dibs hold for another/);
    expect(line()).not.toMatch(/Start walking/);
  });

  it("goes urgent when the grace is nearly gone", () => {
    mount({ dibs: () => claim({ claimedAt: Date.now() - 8 * 60_000 }) }).update(BASE);
    expect(root.querySelector(".arrival__dibs")?.classList.contains("is-urgent")).toBe(true);
  });

  it("says so plainly once the claim is dead", () => {
    mount({ dibs: () => claim({ claimedAt: Date.now() - 60 * 60_000 }) }).update(BASE);
    expect(line()).toContain("expired");
  });

  it("says nothing at all when the rider never called dibs", () => {
    // Most walks are not claims, and a clock for a claim that does not exist
    // is noise on the one surface that has to stay glanceable.
    mount().update(BASE);
    expect(root.querySelector(".arrival__dibs")).toBeNull();
  });
});
