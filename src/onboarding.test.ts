// @vitest-environment happy-dom
//
// The first-run tour (onboarding.ts).
//
// What matters here is the contract main.ts wires against: auto-show exactly
// once per browser, skippable at every screen, eight screens with a live
// progress readout, and the final CTA (and ONLY the final CTA) firing the
// Find-a-ride hand-off.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDED_KEY,
  ONBOARDING_SCREENS,
  hasOnboarded,
  maybeShowOnboarding,
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
});

describe("the tour's screens", () => {
  it("has exactly eight, one per idea, in order", () => {
    expect(ONBOARDING_SCREENS.map((s) => s.id)).toEqual([
      "welcome",
      "models",
      "features",
      "rideability",
      "ride-mode",
      "routing",
      "contribute",
      "territory",
    ]);
  });

  const screen = (id: string) => {
    const s = ONBOARDING_SCREENS.find((s) => s.id === id);
    if (!s) throw new Error(`no screen ${id}`);
    return s;
  };

  it("the features slide sells the filter and the confirm-for-points CTA", () => {
    const body = screen("features").body;
    expect(body).toContain("rider-confirmed");
    expect(body).toContain("Confirm its features");
    expect(body).toContain("earn points");
    expect(body).toContain("onboarding-confirm.webp");
  });

  it("names all four models on the model-choice screen, Rover included", () => {
    const models = screen("models").body;
    for (const m of ["Astro", "Cosmo", "Apollo", "Rover"]) {
      expect(models).toContain(m);
    }
    // "Trike" was Veo's old name for the Rover — riders must never see it —
    // and the old "the operator app treats every scooter the same" line was
    // retired: Veo added vehicle-type filtering, so the claim went stale.
    expect(models).not.toContain("Trike");
    expect(models).not.toContain("operator app");
  });

  it("shows the four real route profiles, by their in-app names", () => {
    // Mirrors ride-screen-routes.ts's FALLBACK_PROFILES labels — the tour
    // must promise the buttons Screen 4 of the wizard actually renders.
    const body = screen("routing").body;
    for (const label of [
      "Safe &amp; Protected",
      "The Range Maximizer",
      "The Shaded Canopy",
      "Commuter Express",
    ]) {
      expect(body).toContain(label);
    }
  });

  it("teaches the three rideability tiers", () => {
    const body = screen("rideability").body;
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
  it("walks forward and back with a live n / 8 progress readout", () => {
    maybeShowOnboarding(hooks());
    expect(progressText()).toBe("1 / 8");
    // Screen 1's primary is "Get Started" and there is no Back yet.
    expect(document.querySelector(".onboarding__next")?.textContent).toBe(
      "Get Started",
    );
    expect(document.querySelector(".onboarding__back")).toBeNull();

    click(".onboarding__next");
    expect(progressText()).toBe("2 / 8");
    expect(document.querySelector(".onboarding__back")).not.toBeNull();

    click(".onboarding__back");
    expect(progressText()).toBe("1 / 8");
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
    expect(progressText()).toBe("8 / 8");
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
