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
    destinationLabel: () => "Home",
    onChangeDestination: () => void calls.push("change_dest"),
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
    // The destination sits in the body, next to the control that changes it —
    // it is the one fact here the rider can still act on, and a subtitle is
    // where an app puts what it does not expect you to touch.
    expect(root.querySelector(".arrival__dest-label")?.textContent).toContain("Home");
  });

  it("offers to change the destination BEFORE any route is computed", () => {
    arrive();
    const change = root.querySelector<HTMLButtonElement>(".arrival__dest-change");
    expect(change?.textContent).toBe("Change");
    change!.click();
    expect(calls).toContain("change_dest");
    // And it did NOT quietly hand the rider onward to route selection.
    expect(calls).not.toContain("route");
  });

  it("asks for a destination when there isn't one, rather than hiding the row", () => {
    // A rider who only asked to be walked to a scooter can still say where
    // they are going, here, without backing all the way out.
    let label: string | null = null;
    const p = createArrivalPanel(root, {
      vehicle: { name: "Lunar 🐸 928" },
      destinationLabel: () => label,
      onChangeDestination: () => {
        label = "Villa Park Mini Mart";
        p.refreshDestination();
      },
      onChooseRoute: () => {},
      onCancel: () => {},
    });
    p.update({ ...BASE, arrived: true });
    expect(root.querySelector(".arrival__dest-label")?.textContent).toBe("No destination set");
    const set = root.querySelector<HTMLButtonElement>(".arrival__dest-change");
    expect(set?.textContent).toBe("Set");
    set!.click();
    // Repainted against the new answer, not the one captured at mount.
    expect(root.querySelector(".arrival__dest-label")?.textContent).toBe("Villa Park Mini Mart");
    p.destroy();
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
      destinationLabel: () => "Home",
      onChangeDestination: () => {},
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

// ---------------------------------------------------------------------------
// "It won't start" — the walk's worst outcome, recorded.
//
// This is the most certain anyone is ever going to be about a scooter: they
// walked to it. See `ride-failed-start.ts` for what the fleet infers when
// nobody tells it (short version: a guess from GBFS id rotations, needing two
// of them to downgrade a device).
// ---------------------------------------------------------------------------

describe("not rideable", () => {
  function arrived(
    onNotRideable?: () => Promise<string>,
  ): ArrivalPanelHandle {
    const p = mount(onNotRideable ? { onNotRideable } : {});
    p.update({ ...BASE, arrived: true });
    return p;
  }

  it("offers nothing when the caller did not wire it", () => {
    arrived();
    expect(named("It won't start")).toBeFalsy();
  });

  it("is on the arrived face, below the route button", () => {
    arrived(async () => "ok");
    const labels = buttons().map((b) => b.textContent ?? "");
    const route = labels.findIndex((l) => l.includes("Choose your route"));
    const broken = labels.findIndex((l) => l.includes("It won't start"));
    expect(route).toBeGreaterThanOrEqual(0);
    expect(broken).toBeGreaterThan(route);
  });

  it("is not offered while still walking — they haven't tried it yet", () => {
    mount({ onNotRideable: async () => "ok" }).update(BASE);
    expect(named("It won't start")).toBeFalsy();
  });

  it("reports, shows what came of it, and offers only the way back", async () => {
    let called = 0;
    arrived(async () => {
      called += 1;
      return "Thanks — we've marked this one as not rideable.";
    });
    named("It won't start")!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(called).toBe(1);
    expect(root.querySelector(".arrival__sub")?.textContent).toContain(
      "not rideable",
    );
    expect(buttons().map((b) => b.textContent)).toEqual([
      "🗺️Find another scooter",
    ]);
    named("Find another scooter")!.click();
    expect(calls).toContain("cancel");
  });

  it("sends one report however many times the button is pressed", async () => {
    let called = 0;
    arrived(async () => {
      called += 1;
      await new Promise((r) => setTimeout(r, 5));
      return "ok";
    });
    const btn = named("It won't start")!;
    btn.click();
    btn.click();
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(1);
  });

  it("still hands them back the map when the report rejects", async () => {
    arrived(() => Promise.reject(new Error("offline")));
    named("It won't start")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector(".arrival__sub")?.textContent).toContain(
      "still isn't rideable",
    );
    expect(named("Find another scooter")).toBeTruthy();
  });

  it("moves focus to the outcome, because the button it was on is gone", async () => {
    // The report is async and the button that started it is deleted when the
    // result lands, so without this the rider is on <body> and a screen reader
    // has been told neither that the report went through nor that only one
    // action is left. The outcome text is the announcement; the button after
    // it is next in reading order.
    arrived(async () => "Thanks — we've marked this one as not rideable.");
    named("It won't start")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(root.querySelector(".arrival__head"));
    expect(document.activeElement?.textContent).toContain("Not rideable");
  });

  it("a scooter that went while the report was in flight keeps the gone face", async () => {
    const p = arrived(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "reported";
    });
    named("It won't start")!.click();
    p.reportGone("Someone just took Lunar 🐸 928.");
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector(".arrival__title")?.textContent).toContain(
      "Someone just took",
    );
  });
});
