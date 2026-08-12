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
    onStartNavigation: () => void calls.push("nav"),
    onConfirmStarted: () => void calls.push("started"),
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
    expect(named("Start 3D navigation")).toBeTruthy();
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

  it("leads with navigation, which is the only action that cannot fail on Veo", () => {
    arrive();
    expect(buttons()[0].textContent).toContain("Start 3D navigation");
  });

  it("offers all three things a rider does at a scooter", () => {
    arrive();
    expect(named("Start 3D navigation")).toBeTruthy();
    expect(named("It's unlocked")).toBeTruthy();
    expect(named("Open in Veo")).toBeTruthy();
  });

  it("deep-links Veo by plate", () => {
    arrive();
    const veo = named("Open in Veo") as HTMLAnchorElement;
    expect(veo.tagName).toBe("A");
    expect(veo.href).toContain("ABC123");
  });

  it("still works for a vehicle with no plate", () => {
    // No deep link possible — say what to do instead of showing a dead button.
    const p = createArrivalPanel(root, {
      vehicle: { name: "Lunar 🐸 928" },
      destinationLabel: "Home",
      onStartNavigation: () => {},
      onConfirmStarted: () => {},
      onCancel: () => {},
    });
    p.update({ ...BASE, arrived: true });
    expect(named("Open in Veo")).toBeFalsy();
    expect(root.querySelector(".arrival__note")?.textContent).toContain("Veo app");
    p.destroy();
  });

  it("reports the two outcomes separately", () => {
    arrive();
    named("Start 3D navigation")!.click();
    named("It's unlocked")!.click();
    expect(calls).toEqual(["nav", "started"]);
  });

  it("does not fall back to the walking face on a later fix", () => {
    // GPS drifts. Having arrived, drifting 40 m must not un-arrive the rider
    // and yank the buttons out from under their thumb.
    const p = arrive();
    p.update({ ...BASE, arrived: false, remainingMeters: 42 });
    expect(named("Start 3D navigation")).toBeTruthy();
  });

  it("can be abandoned", () => {
    arrive();
    root.querySelector<HTMLButtonElement>(".arrival__close")!.click();
    expect(calls).toEqual(["cancel"]);
  });
});
