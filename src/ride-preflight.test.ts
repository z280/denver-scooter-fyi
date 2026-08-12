// @vitest-environment happy-dom
//
// ride-preflight.ts: the device card's "Use in Ride Mode" quick survey.
//
// The routing rule (`preflightLanding`) is the actual product decision in
// that module — the DOM is only how the questions get asked — so it gets
// tested exhaustively over all eight answer combinations rather than by
// example. On top of that: the defaults (which the owner specified
// individually and which must match the wizard's own), the cost-HUD-off
// branch that REMOVES the Veo question rather than disabling it, and the
// entry blob handed to the wizard.
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

  it("default the Veo question to 'give me a link'", () => {
    // The answer that costs nothing to be wrong about: a rider who already
    // started can still tap "I already started" on Screen 6, but defaulting
    // the other way would skip past the screen that hands out the link.
    expect(PREFLIGHT_DEFAULTS.startIntent).toBe("need-link");
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

  it("does not auto-start a rider who still needs the Veo link", () => {
    const landing = preflightLanding(
      answers({ cost_hud: true, startIntent: "need-link" }),
    );
    expect(landing.autoStart).toBe(false);
  });

  it("auto-starts a rider who already unlocked the scooter", () => {
    const landing = preflightLanding(
      answers({ cost_hud: true, startIntent: "already-started" }),
    );
    expect(landing.autoStart).toBe(true);
  });

  it("auto-starts whenever the cost HUD is off, whatever the intent says", () => {
    // The owner's rule: cost HUD off "removes consideration about starting
    // veo". So the stale startIntent underneath is not consulted — a rider
    // who picked "give me a link" and THEN turned the HUD off must not be
    // routed to a link screen the survey stopped showing them.
    for (const startIntent of ["need-link", "already-started"] as const) {
      expect(
        preflightLanding(answers({ cost_hud: false, startIntent })).autoStart,
      ).toBe(true);
    }
  });

  it("keeps navigation and auto-start independent", () => {
    // A nav rider who already started still visits 3 and 4; Screen 6 then
    // starts by itself. Neither answer overrides the other.
    const landing = preflightLanding(
      answers({ navigation: true, startIntent: "already-started" }),
    );
    expect(landing).toEqual({ fastForwardTo: "3", autoStart: true });
  });

  it("covers all eight combinations without a surprise", () => {
    for (const navigation of [true, false]) {
      for (const cost_hud of [true, false]) {
        for (const startIntent of ["need-link", "already-started"] as const) {
          const landing = preflightLanding(
            answers({ navigation, cost_hud, startIntent }),
          );
          expect(landing.fastForwardTo).toBe(navigation ? "3" : "6");
          expect(landing.autoStart).toBe(
            !cost_hud || startIntent === "already-started",
          );
        }
      }
    }
  });
});

describe("describeNext", () => {
  it("warns about the extra screens a navigation rider is about to get", () => {
    expect(describeNext(answers({ navigation: true }))).toContain("destination");
  });

  it("promises nothing further when there is nothing further", () => {
    expect(
      describeNext(answers({ navigation: false, cost_hud: false })),
    ).toBe("Next: ride mode starts.");
  });

  it("promises the link when the rider asked for one", () => {
    expect(
      describeNext(answers({ navigation: false, startIntent: "need-link" })),
    ).toContain("link to open in Veo");
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
  it("renders the two toggles in their default states", () => {
    open();
    expect(toggle("navigation").textContent).toBe("OFF");
    expect(toggle("cost_hud").textContent).toBe("ON");
  });

  it("DOES NOT ask about saving tracks — that is a standing setting now", () => {
    // It moved to Settings -> Local Data (`track-preference.ts`). A rider
    // standing at a scooter should not be asked a question whose answer never
    // varies between rides.
    open();
    expect(
      document.querySelector('[data-option="save_tracks"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Save Tracks");
  });

  it("carries the STANDING track preference into the ride it starts", () => {
    localStorage.setItem("scooter-fyi-save-tracks", "0");
    const { enterRideMode } = open();
    document.querySelector<HTMLButtonElement>(".login-btn")!.click();
    const entry = enterRideMode.mock.calls[0][0] as RideModalEntry;
    // Not asked here, but still honoured: a rider who turned recording off in
    // Settings must not have it silently back on for this ride.
    expect(entry.preflight!.save_tracks).toBe(false);
    localStorage.removeItem("scooter-fyi-save-tracks");
  });

  it("reports state to assistive tech, not just visually", () => {
    open();
    expect(toggle("cost_hud").getAttribute("aria-checked")).toBe("true");
    toggle("cost_hud").click();
    expect(toggle("cost_hud").getAttribute("aria-checked")).toBe("false");
  });

  it("asks the Veo question while the cost HUD is on", () => {
    open();
    expect(
      document.querySelectorAll("[data-intent]").length,
    ).toBe(2);
    expect(document.body.textContent).toContain("I started the Veo already");
    expect(document.body.textContent).toContain("Give me a link to Open in Veo");
  });

  it("REMOVES the Veo question when the cost HUD goes off", () => {
    // Not disabled — absent. The owner's rule is that turning the cost HUD
    // off removes the consideration of starting Veo altogether, and a
    // greyed-out control still asks the rider to think about it.
    open();
    toggle("cost_hud").click();
    expect(document.querySelectorAll("[data-intent]").length).toBe(0);
    expect(document.body.textContent).not.toContain("I started the Veo already");
  });

  it("brings the Veo question back if the rider changes their mind", () => {
    open();
    toggle("cost_hud").click();
    toggle("cost_hud").click();
    expect(document.querySelectorAll("[data-intent]").length).toBe(2);
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
    expect(next()).toContain("link to open in Veo");
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
    expect(entry.autoStart).toBe(false);
  });

  it("reflects toggles flipped before the rider commits", () => {
    const { enterRideMode } = open();
    toggle("navigation").click();
    document.querySelector<HTMLButtonElement>(".login-btn")!.click();
    const entry = enterRideMode.mock.calls[0][0] as RideModalEntry;
    expect(entry.preflight).toEqual({
      navigation: true,
      // Default-on standing preference, untouched by this modal.
      save_tracks: true,
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
