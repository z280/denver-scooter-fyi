// @vitest-environment happy-dom
//
// ride-preflight.ts: the device card's "Use in Ride Mode" quick survey.
//
// The routing rule (`preflightLanding`) is the actual product decision in
// that module — the DOM is only how the questions get asked — so it gets
// tested over every answer combination rather than by example. On top of
// that: the defaults (which the owner specified individually and which must
// match the wizard's own), and the entry blob handed to the wizard. The old
// "Starting it in Veo" either/or is gone — Screen 6 auto-starts for
// everyone, so the survey has nothing to ask about Veo starts any more.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PREFLIGHT_DEFAULTS,
  describeNext,
  openRidePreflight,
  preflightLanding,
  type RidePreflightAnswers,
} from "./ride-preflight.ts";
import { defaultRideOptions } from "./ride-settings.ts";
import type { RideModalEntry } from "./ride-modal.ts";

function answers(over: Partial<RidePreflightAnswers> = {}): RidePreflightAnswers {
  return { ...PREFLIGHT_DEFAULTS, ...over };
}

beforeEach(() => {
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("defaults", () => {
  it("are the three the owner specified", () => {
    expect(PREFLIGHT_DEFAULTS.navigation).toBe(false); // "Navigation directions OFF"
    expect(PREFLIGHT_DEFAULTS.save_tracks).toBe(true); // "Save Tracks … ON"
    expect(PREFLIGHT_DEFAULTS.cost_hud).toBe(true); // "Veo cost HUD ON"
  });

  it("match the wizard's own RideOptions defaults field for field", () => {
    // The survey is a shortcut INTO the wizard, not a different product. If
    // these ever diverge, the same rider gets different defaults depending
    // on which door they came through — and nothing else would catch it,
    // because ride-preflight.ts deliberately does not import the nine-field
    // blob just to read three fields out of it.
    const wizard = defaultRideOptions();
    expect(PREFLIGHT_DEFAULTS.navigation).toBe(wizard.navigation);
    expect(PREFLIGHT_DEFAULTS.save_tracks).toBe(wizard.save_tracks);
    expect(PREFLIGHT_DEFAULTS.cost_hud).toBe(wizard.cost_hud);
  });
});

// ---------------------------------------------------------------------------
// Routing — the whole rule, over every combination
// ---------------------------------------------------------------------------

describe("preflightLanding", () => {
  it("sends a navigation rider to the destination screen first", () => {
    expect(preflightLanding(answers({ navigation: true })).fastForwardTo).toBe("3");
  });

  it("sends everyone else straight to the start screen", () => {
    expect(preflightLanding(answers({ navigation: false })).fastForwardTo).toBe("6");
  });

  it("routes on navigation alone — the cost HUD no longer affects landing", () => {
    // Screen 6 auto-starts for everyone now, so there is no start-link
    // screen for the cost HUD to route around.
    for (const navigation of [true, false]) {
      for (const cost_hud of [true, false]) {
        const landing = preflightLanding(answers({ navigation, cost_hud }));
        expect(landing).toEqual({ fastForwardTo: navigation ? "3" : "6" });
      }
    }
  });
});

describe("describeNext", () => {
  it("warns about the extra screens a navigation rider is about to get", () => {
    expect(describeNext(answers({ navigation: true }))).toContain("destination");
  });

  it("promises nothing further when there is nothing further", () => {
    expect(describeNext(answers({ navigation: false }))).toBe(
      "Next: ride mode starts.",
    );
  });

  it("never mentions starting in Veo — that page is gone", () => {
    for (const navigation of [true, false]) {
      expect(describeNext(answers({ navigation }))).not.toContain("Veo");
    }
  });
});

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

function open(over: Parameters<typeof openRidePreflight>[0] extends infer T
  ? Partial<T>
  : never = {}) {
  const enterRideMode = vi.fn();
  const close = openRidePreflight({
    deviceLabel: "Cosmo — plate 1025543",
    vehicleIdentifier: "8c4a1f0d2e9b7a35",
    plate: "1025543",
    enterRideMode: enterRideMode as never,
    ...over,
  });
  return { enterRideMode, close };
}

function toggle(option: string): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    `[data-option="${option}"]`,
  );
  if (!btn) throw new Error(`no toggle for ${option}`);
  return btn;
}

describe("the survey UI", () => {
  it("renders the three toggles in their default states", () => {
    open();
    expect(toggle("navigation").textContent).toBe("OFF");
    expect(toggle("save_tracks").textContent).toBe("ON");
    expect(toggle("cost_hud").textContent).toBe("ON");
  });

  it("reports state to assistive tech, not just visually", () => {
    open();
    expect(toggle("cost_hud").getAttribute("aria-checked")).toBe("true");
    toggle("cost_hud").click();
    expect(toggle("cost_hud").getAttribute("aria-checked")).toBe("false");
  });

  it("never asks the old 'Starting it in Veo' question", () => {
    // The Start-in-Veo page is gone and Screen 6 auto-starts, so the survey
    // asking whether the rider has unlocked anything would be dead weight.
    open();
    expect(document.querySelectorAll("[data-intent]").length).toBe(0);
    expect(document.body.textContent).not.toContain("Starting it in Veo");
  });

  it("keeps focus on the control the rider just used", () => {
    // Every tap re-renders the body, which would otherwise drop focus to
    // <body> and make the whole panel unusable by keyboard.
    open();
    toggle("navigation").click();
    expect(document.activeElement).toBe(toggle("navigation"));
  });

  it("tells the rider what happens next, live", () => {
    open();
    const next = () =>
      document.querySelector(".ride-preflight__next")?.textContent ?? "";
    expect(next()).toBe("Next: ride mode starts.");
    toggle("navigation").click();
    expect(next()).toContain("destination");
  });
});

describe("entering ride mode", () => {
  function enter(): RideModalEntry {
    const { enterRideMode } = open();
    document.querySelector<HTMLButtonElement>(".login-btn")!.click();
    expect(enterRideMode).toHaveBeenCalledTimes(1);
    return enterRideMode.mock.calls[0][0] as RideModalEntry;
  }

  it("hands the wizard the device it already knows about", () => {
    const entry = enter();
    expect(entry.vehicleIdentifier).toBe("8c4a1f0d2e9b7a35");
    expect(entry.plate).toBe("1025543");
  });

  it("carries the survey answers so the session doc can be seeded", () => {
    const entry = enter();
    expect(entry.preflight).toEqual({
      navigation: false,
      save_tracks: true,
      cost_hud: true,
    });
  });

  it("carries the routing decision", () => {
    const entry = enter();
    expect(entry.fastForwardTo).toBe("6");
  });

  it("reflects toggles flipped before the rider commits", () => {
    const { enterRideMode } = open();
    toggle("navigation").click();
    toggle("save_tracks").click();
    document.querySelector<HTMLButtonElement>(".login-btn")!.click();
    const entry = enterRideMode.mock.calls[0][0] as RideModalEntry;
    expect(entry.preflight).toEqual({
      navigation: true,
      save_tracks: false,
      cost_hud: true,
    });
    expect(entry.fastForwardTo).toBe("3");
  });

  it("closes itself before opening the wizard", () => {
    // Two live focus traps fight over Tab, so the survey must be gone by the
    // time the wizard installs its own.
    const { enterRideMode } = open();
    (enterRideMode as ReturnType<typeof vi.fn>).mockImplementation(() => {
      expect(document.querySelector(".ride-preflight")).toBeNull();
    });
    document.querySelector<HTMLButtonElement>(".login-btn")!.click();
    expect(enterRideMode).toHaveBeenCalled();
  });

  it("notifies the caller so it can close its own popup", () => {
    const onEntered = vi.fn();
    open({ onEntered });
    document.querySelector<HTMLButtonElement>(".login-btn")!.click();
    expect(onEntered).toHaveBeenCalledWith(
      expect.objectContaining({ cost_hud: true }),
    );
  });
});

describe("dismissal", () => {
  it("closes on Escape without entering ride mode", () => {
    const onCancel = vi.fn();
    const { enterRideMode } = open({ onCancel });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".ride-preflight")).toBeNull();
    expect(enterRideMode).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("stops listening for Escape once closed", () => {
    const onCancel = vi.fn();
    open({ onCancel });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("never leaves two surveys open at once", () => {
    open();
    open();
    expect(document.querySelectorAll(".ride-preflight").length).toBe(1);
  });

  it("TEARS DOWN the previous survey rather than just unhooking its DOM", () => {
    // Counting elements is not enough: removing the node leaves this
    // modal's document-level Escape handler AND `trapFocusWithin`'s
    // document `focusin` handler attached. The orphaned trap is the real
    // damage — its `isActive()` closes over a `closed` flag that never
    // flipped, so it stays live forever and keeps yanking focus back onto a
    // node that is no longer in the document.
    const onCancel = vi.fn();
    open({ onCancel });
    open(); // the second open must run the first's teardown

    // One Escape must reach exactly ONE listener — the live modal's. If the
    // first survey's handler were still attached it would fire too, and its
    // onCancel would run for a survey the rider already left behind.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not let an orphaned focus trap steal focus", () => {
    // The user-visible symptom of the leak: focus outside the (now removed)
    // first modal gets snatched back to its detached card.
    open();
    const stale = document.querySelector<HTMLElement>(".ride-preflight__card");
    open();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(document.activeElement).not.toBe(stale);
  });

  it("clears its slot on close so a later open is not a no-op", () => {
    const first = open();
    first.close();
    open();
    expect(document.querySelectorAll(".ride-preflight").length).toBe(1);
  });
});
