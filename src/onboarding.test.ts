// @vitest-environment happy-dom
//
// The first-run tour and the first-ride rotate overlay (onboarding.ts).
//
// What matters here is the contract main.ts wires against: auto-show exactly
// once per browser, skippable at every screen, seven screens with a live
// progress readout, the final CTA (and ONLY the final CTA) firing the
// Find-a-ride hand-off, and the rotate overlay deferring its caller's
// proceed() to a real button press — remembering the choice only when asked.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDED_KEY,
  ONBOARDING_SCREENS,
  RIDE_ROTATE_KEY,
  hasOnboarded,
  maybeShowFirstRideOverlay,
  maybeShowOnboarding,
  rideRotateChoice,
  showOnboarding,
} from "./onboarding.ts";

function tour(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".onboarding");
}

function click(sel: string): void {
  const btn = document.querySelector<HTMLButtonElement>(sel);
  if (!btn) throw new Error(`missing ${sel}`);
  btn.click();
}

function progressText(): string {
  return (
    document.querySelector(".onboarding__progress")?.textContent?.trim() ?? ""
  );
}

const hooks = () => ({ onStartExploring: vi.fn() });

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  // A prior test's tour may still be registered as open in module state —
  // close it through its own UI if present.
  document.querySelector<HTMLButtonElement>(".onboarding__skip")?.click();
  document
    .querySelector<HTMLButtonElement>('.first-ride [data-rotate="portrait"]')
    ?.click();
});

describe("the tour's screens", () => {
  it("has exactly seven, one per idea, in the spec's order", () => {
    expect(ONBOARDING_SCREENS.map((s) => s.id)).toEqual([
      "welcome",
      "models",
      "rideability",
      "ride-mode",
      "routing",
      "contribute",
      "territory",
    ]);
  });

  it("names all four models on the model-choice screen", () => {
    const models = ONBOARDING_SCREENS[1].body;
    for (const m of ["Astro", "Cosmo", "Apollo", "Trike"]) {
      expect(models).toContain(m);
    }
  });

  it("teaches the three rideability tiers", () => {
    const body = ONBOARDING_SCREENS[2].body;
    for (const label of ["Likely Rideable", "Unknown Risk", "High Risk"]) {
      expect(body).toContain(label);
    }
  });
});

describe("maybeShowOnboarding", () => {
  it("shows on a fresh browser and never auto-shows again after a skip", () => {
    expect(hasOnboarded()).toBe(false);
    expect(maybeShowOnboarding(hooks())).toBe(true);
    expect(tour()).not.toBeNull();

    click(".onboarding__skip");
    expect(tour()).toBeNull();
    expect(hasOnboarded()).toBe(true);
    expect(localStorage.getItem(ONBOARDED_KEY)).toBe("1");

    expect(maybeShowOnboarding(hooks())).toBe(false);
    expect(tour()).toBeNull();
  });

  it("skip does NOT fire the Find-a-ride hand-off", () => {
    const h = hooks();
    maybeShowOnboarding(h);
    click(".onboarding__skip");
    expect(h.onStartExploring).not.toHaveBeenCalled();
  });
});

describe("navigation", () => {
  it("walks forward and back with a live n / 7 progress readout", () => {
    maybeShowOnboarding(hooks());
    expect(progressText()).toBe("1 / 7");
    // Screen 1's primary is "Get Started" and there is no Back yet.
    expect(document.querySelector(".onboarding__next")?.textContent).toBe(
      "Get Started",
    );
    expect(document.querySelector(".onboarding__back")).toBeNull();

    click(".onboarding__next");
    expect(progressText()).toBe("2 / 7");
    expect(document.querySelector(".onboarding__back")).not.toBeNull();

    click(".onboarding__back");
    expect(progressText()).toBe("1 / 7");
    click(".onboarding__skip"); // teardown via the tour's own UI
  });

  it("Escape closes as a skip", () => {
    const h = hooks();
    maybeShowOnboarding(h);
    tour()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(tour()).toBeNull();
    expect(hasOnboarded()).toBe(true);
    expect(h.onStartExploring).not.toHaveBeenCalled();
  });

  it("the final screen's Start Exploring fires the hand-off and closes", () => {
    const h = hooks();
    maybeShowOnboarding(h);
    for (let i = 0; i < ONBOARDING_SCREENS.length - 1; i++) {
      click(".onboarding__next");
    }
    expect(progressText()).toBe("7 / 7");
    const cta = document.querySelector<HTMLButtonElement>(".onboarding__next")!;
    expect(cta.textContent).toBe("Start Exploring");
    cta.click();
    expect(tour()).toBeNull();
    expect(h.onStartExploring).toHaveBeenCalledTimes(1);
    expect(hasOnboarded()).toBe(true);
  });
});

describe("replay", () => {
  it("showOnboarding still opens after the flag is set, and never stacks", () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    showOnboarding(hooks());
    expect(tour()).not.toBeNull();
    showOnboarding(hooks()); // a second replay click while open
    expect(document.querySelectorAll(".onboarding").length).toBe(1);
    click(".onboarding__skip");
  });
});

describe("first-ride rotate overlay", () => {
  function overlay(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".first-ride");
  }

  it("shows on first entry and defers proceed() to a button", () => {
    const proceed = vi.fn();
    expect(maybeShowFirstRideOverlay(proceed)).toBe(true);
    expect(overlay()).not.toBeNull();
    expect(proceed).not.toHaveBeenCalled();

    click('.first-ride [data-rotate="landscape"]');
    expect(overlay()).toBeNull();
    expect(proceed).toHaveBeenCalledTimes(1);
    // Not remembered: nothing stored, so it shows again next entry.
    expect(rideRotateChoice()).toBeNull();
    const again = vi.fn();
    expect(maybeShowFirstRideOverlay(again)).toBe(true);
    click('.first-ride [data-rotate="portrait"]');
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("Remember my choice persists it and suppresses the overlay after", () => {
    const proceed = vi.fn();
    maybeShowFirstRideOverlay(proceed);
    const remember =
      document.querySelector<HTMLInputElement>("#first-ride-remember")!;
    remember.checked = true;
    click('.first-ride [data-rotate="portrait"]');
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(RIDE_ROTATE_KEY)).toBe("portrait");
    expect(rideRotateChoice()).toBe("portrait");

    const next = vi.fn();
    expect(maybeShowFirstRideOverlay(next)).toBe(false);
    expect(overlay()).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it("Escape proceeds without remembering", () => {
    const proceed = vi.fn();
    maybeShowFirstRideOverlay(proceed);
    overlay()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(overlay()).toBeNull();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(rideRotateChoice()).toBeNull();
  });
});
