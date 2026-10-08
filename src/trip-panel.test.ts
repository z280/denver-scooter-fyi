// @vitest-environment happy-dom
//
// The reading surface. Most of what is asserted here is about saying nothing
// we cannot stand behind — no ETA without a route, no step we invented — and
// about the stepper holding its place while the ride moves underneath it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTripPanel,
  distanceLine,
  etaLine,
  routingPreferenceLabel,
  tripSpendLine,
  tripSteps,
  type TripPanelState,
} from "./trip-panel.ts";
import { setHandOffCap } from "./plan-prefs.ts";
import { activeTrip, recordLeg, startTrip } from "./trip-legs.ts";

const HOME = { label: "Home", lat: 39.7285, lon: -105.0345 };
const A = { label: "Liftoff 🍉 167", lat: 39.73, lon: -105.0 };
const B = { label: "Perseus 🎯 619", lat: 39.75, lon: -104.97 };

const state = (over: Partial<TripPanelState> = {}): TripPanelState => ({
  dest: HOME,
  routeSeconds: null,
  routeMeters: null,
  nowMs: Date.parse("2026-10-08T17:00:00Z"),
  ...over,
});

const bank = (rideId: string) =>
  recordLeg({ rideId, costCents: 300, meters: 1000, seconds: 400, endedAtMs: 1 });

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

describe("the arrival estimate", () => {
  it("is absent without a chosen route, rather than guessed", () => {
    // Navigation is off by default, so most rides have none — and a time
    // derived from a straight line is the one figure here a rider could check
    // against their own watch and find wrong.
    expect(etaLine(state())).toBeNull();
    expect(distanceLine(state())).toBeNull();
  });

  it("reads from the route when there is one", () => {
    const line = etaLine(state({ routeSeconds: 21 * 60 }))!;
    expect(line).toMatch(/^arriving ~/);
    expect(line).toContain("21 min");
    expect(distanceLine(state({ routeMeters: 4828 }))).toBe("3.0 mi");
  });

  it("refuses nonsense from the route rather than rendering it", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -60]) {
      expect(etaLine(state({ routeSeconds: bad }))).toBeNull();
      expect(distanceLine(state({ routeMeters: bad }))).toBeNull();
    }
  });

  it("never rounds a real ride down to zero minutes", () => {
    expect(etaLine(state({ routeSeconds: 10 }))).toContain("1 min");
  });
});

describe("the itinerary, derived", () => {
  it("has no steps at all without a multi-leg trip", () => {
    // A stepper over a single item is chrome.
    expect(tripSteps(null)).toEqual([]);
  });

  it("ends each step at its hand-off and the last at the destination", () => {
    startTrip({ plannedRides: 3, dest: HOME, handOffs: [A, B] });
    const steps = tripSteps(activeTrip());
    expect(steps.map((s) => s.to)).toEqual([A.label, B.label, "Home"]);
    expect(steps.map((s) => s.handOff)).toEqual([true, true, false]);
  });

  it("marks what is behind, what is now, and what is ahead", () => {
    startTrip({ plannedRides: 3, dest: HOME, handOffs: [A, B] });
    bank("one");
    const steps = tripSteps(activeTrip());
    expect(steps.map((s) => s.done)).toEqual([true, false, false]);
    expect(steps.map((s) => s.current)).toEqual([false, true, false]);
  });

  it("still renders a step whose hand-off could not be named", () => {
    // The step is real even when the label is not. Leaving the row out would
    // make the plan look shorter than it is.
    startTrip({ plannedRides: 2, dest: HOME, handOffs: [{ ...A, label: "" }] });
    expect(tripSteps(activeTrip())[0].to).toBe("your next scooter");
  });
});

describe("the running total", () => {
  it("says nothing before a leg has been banked", () => {
    startTrip({ plannedRides: 2, dest: HOME });
    expect(tripSpendLine(activeTrip())).toBeNull();
    expect(tripSpendLine(null)).toBeNull();
  });

  it("uses the same ≈/≥ rule the HUD and Screen 8 use", () => {
    startTrip({ plannedRides: 3, dest: HOME });
    bank("one");
    expect(tripSpendLine(activeTrip())).toBe("≈ $3.00 over 1 leg so far");
    recordLeg({
      rideId: "two",
      costCents: 200,
      meters: null,
      seconds: 100,
      endedAtMs: 2,
    });
    expect(tripSpendLine(activeTrip())).toBe("≥ $5.00 over 2 legs so far");
  });
});

describe("the planning preference", () => {
  it("reads back whatever the rider chose", () => {
    setHandOffCap(0);
    expect(routingPreferenceLabel()).toBe("One scooter only");
    setHandOffCap(1);
    expect(routingPreferenceLabel()).toBe("At most one switch");
    setHandOffCap(null);
    expect(routingPreferenceLabel()).toBe("Any number of switches");
  });
});

describe("the panel", () => {
  function mount(over: Partial<TripPanelState> = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    const handle = buildTripPanel(host, { state: () => state(over) });
    return { host, handle };
  }

  it("says what to do when there is no destination, and still shows the preference", () => {
    const { host } = mount({ dest: null });
    expect(host.textContent).toContain("No destination yet");
    expect(host.textContent).toContain("Planning preference");
  });

  it("shows the destination and explains a missing ETA", () => {
    const { host } = mount();
    expect(host.textContent).toContain("Home");
    expect(host.textContent).toContain("turn-by-turn is off");
  });

  it("points at where the preference lives rather than offering a second copy", () => {
    // A setting with two homes is a setting that disagrees with itself.
    const { host } = mount();
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).toContain("In-Ride Preferences");
  });

  it("steps through a multi-leg plan, and holds its place across a refresh", () => {
    startTrip({ plannedRides: 3, dest: HOME, handOffs: [A, B] });
    const { host, handle } = mount();
    expect(host.textContent).toContain("Step 1 of 3");

    const next = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Next ›",
    )!;
    next.click();
    expect(host.textContent).toContain("Step 2 of 3");

    // A rider reading ahead must not be yanked back because the ride moved.
    handle.refresh();
    expect(host.textContent).toContain("Step 2 of 3");
  });

  it("will not step past either end", () => {
    startTrip({ plannedRides: 2, dest: HOME, handOffs: [A] });
    const { host } = mount();
    const btn = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === label,
      )!;
    expect(btn("‹ Back").disabled).toBe(true);
    btn("Next ›").click();
    expect(host.textContent).toContain("Step 2 of 2");
    expect(btn("Next ›").disabled).toBe(true);
  });

  it("offers 'Show on map' only when the host gave it somewhere to look", () => {
    startTrip({ plannedRides: 2, dest: HOME, handOffs: [A] });
    const host = document.createElement("div");
    document.body.append(host);
    const showOnMap = vi.fn();
    buildTripPanel(host, { state: () => state(), showOnMap });
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Show on map")!
      .click();
    expect(showOnMap).toHaveBeenCalledWith(A);

    const bare = document.createElement("div");
    document.body.append(bare);
    buildTripPanel(bare, { state: () => state() });
    expect(
      [...bare.querySelectorAll("button")].some((b) => b.textContent === "Show on map"),
    ).toBe(false);
  });
});
