// @vitest-environment happy-dom
//
// The map bridge, through the DOM.
//
// The rules themselves live in ride-spec.ts (what a spec means) and
// ride-spec-store.ts (whether the map still matches one) and are tested
// there. What is only testable here is the WIRING: that the toggle drives
// `apply`, that a rider's own filter change clears it, that turning it off
// puts back what they had, and that the one thing this module could plausibly
// get wrong — reading its OWN `apply()` as a rider edit and detaching halfway
// through attaching — does not happen.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./map-auth.js", () => ({ isAuthenticated: () => false }));

import { wireRideSpecPanel, type RideSpecPanelHandle } from "./ride-spec-panel.ts";
import { LOCAL_SPEC_NAME, saveLocalSpec } from "./ride-spec-store.ts";
import { defaultSpec, toFilterSnapshot, type RideSpec } from "./ride-spec.ts";
import type { FilterSnapshot } from "./filter-presets.ts";

const BASE: FilterSnapshot = {
  rideTypes: ["sitting", "standing"],
  models: ["astro", "cosmo", "apollo", "trike"],
  knownModels: ["astro", "cosmo", "apollo", "trike"],
  features: [],
  hideUnavailable: false,
  minBattery: 0,
  quality: "any",
  area: null,
};

const COMMUTER: RideSpec = {
  ...defaultSpec(),
  models: ["cosmo"],
  features: ["basket"],
  minBattery: 40,
};

function markup(): void {
  document.body.replaceChildren();
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <input type="checkbox" id="spec-apply-toggle" />
    <button id="spec-edit" type="button"></button>
    <button id="spec-save-from-filters" type="button"></button>
    <div id="spec-panel"></div>`;
  document.body.append(wrap);
}

/** A stand-in Filters drawer: `apply` writes into the same variable
 *  `snapshot` reads, which is exactly the relationship main.ts's
 *  `applyFilterSnapshot` / `snapshotFilters` pair has. */
/** The handle the most recent `harness().wire()` produced, so a test can ask
 *  the panel what it believes without threading it through every helper. */
let lastHandle: RideSpecPanelHandle | null = null;
const currentHandle = (): RideSpecPanelHandle | null => lastHandle;

function harness(initial: FilterSnapshot = BASE) {
  let live: FilterSnapshot = initial;
  const applied: FilterSnapshot[] = [];
  let handle: RideSpecPanelHandle | null = null;
  return {
    applied,
    get live() {
      return live;
    },
    deps: {
      snapshot: () => live,
      apply: async (s: FilterSnapshot) => {
        applied.push(s);
        // FAITHFUL TO main.ts's applyFilterSnapshot, which drives the
        // controls ONE AT A TIME — three toggle groups, then availability,
        // battery, quality, then an awaited area restore — each firing the
        // drawer's change signal on the way past. Setting `live = s` in one
        // step would make every intermediate state match the projection, and
        // the in-flight-guard test below would pass whether or not the guard
        // existed. (It did, until this harness was fixed.)
        const steps: Partial<FilterSnapshot>[] = [
          { rideTypes: s.rideTypes },
          { models: s.models, knownModels: s.knownModels },
          { features: s.features },
          { hideUnavailable: s.hideUnavailable },
          { minBattery: s.minBattery },
          { quality: s.quality },
        ];
        for (const step of steps) {
          live = { ...live, ...step };
          handle?.onFiltersChanged();
        }
        await Promise.resolve();
        live = { ...live, area: s.area };
        handle?.onFiltersChanged();
      },
      signedIn: () => false,
    },
    wire(): RideSpecPanelHandle {
      handle = wireRideSpecPanel(this.deps)!;
      lastHandle = handle;
      return handle;
    },
    /** A rider nudging a control. */
    edit(patch: Partial<FilterSnapshot>): void {
      live = { ...live, ...patch };
      handle?.onFiltersChanged();
    },
  };
}

const toggle = () => document.getElementById("spec-apply-toggle") as HTMLInputElement;
const panelText = () => document.getElementById("spec-panel")!.textContent ?? "";
const editBtn = () => document.getElementById("spec-edit") as HTMLButtonElement;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  markup();
});

describe("wiring", () => {
  it("returns null when its markup is absent, rather than throwing", () => {
    document.body.replaceChildren();
    expect(
      wireRideSpecPanel({ snapshot: () => BASE, apply: async () => {} }),
    ).toBeNull();
  });

  it("disables the toggle until there is a spec to apply", async () => {
    const h = harness();
    h.wire();
    await flush();
    expect(toggle().disabled).toBe(true);
    expect(editBtn().textContent).toContain("Set my ideal scooter");
  });

  it("enables the toggle and names the spec once there is one", async () => {
    saveLocalSpec(COMMUTER);
    const h = harness();
    h.wire();
    await flush();
    expect(toggle().disabled).toBe(false);
    expect(editBtn().textContent).toContain(LOCAL_SPEC_NAME);
  });
});

describe("spec → map", () => {
  beforeEach(() => saveLocalSpec(COMMUTER));

  it("applies the projection when switched on", async () => {
    const h = harness();
    h.wire();
    await flush();
    toggle().checked = true;
    toggle().dispatchEvent(new Event("change"));
    await flush();

    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]).toEqual(toFilterSnapshot(COMMUTER, BASE));
    expect(panelText()).toContain(LOCAL_SPEC_NAME);
  });

  it("does not detach while applying its own projection", async () => {
    // The failure this guards: `apply()` drives the controls one at a time,
    // so every intermediate state differs from the projection. Without the
    // in-flight guard the toggle would clear itself halfway through turning
    // itself on — and the map would be left showing a spec nothing claims.
    const h = harness();
    h.wire();
    await flush();
    toggle().checked = true;
    toggle().dispatchEvent(new Event("change"));
    await flush();

    expect(toggle().checked).toBe(true);
    expect(panelText()).not.toContain("Filters changed");
  });

  it("refuses to switch on with no spec, and says where to make one", async () => {
    localStorage.clear();
    const h = harness();
    h.wire();
    await flush();
    toggle().disabled = false; // as if the rider got at it anyway
    toggle().checked = true;
    toggle().dispatchEvent(new Event("change"));
    await flush();

    expect(toggle().checked).toBe(false);
    expect(h.applied).toHaveLength(0);
    expect(panelText()).toContain("Edit");
  });
});

describe("detachment", () => {
  beforeEach(() => saveLocalSpec(COMMUTER));

  async function attached() {
    const h = harness();
    h.wire();
    await flush();
    toggle().checked = true;
    toggle().dispatchEvent(new Event("change"));
    await flush();
    return h;
  }

  it("clears the toggle on the rider's first edit and names what it lost", async () => {
    const h = await attached();
    h.edit({ minBattery: 90 });

    expect(toggle().checked).toBe(false);
    expect(panelText()).toContain("Filters changed");
    expect(panelText()).toContain(LOCAL_SPEC_NAME);
  });

  it("offers one tap back, which re-projects onto the EDITED map", async () => {
    const h = await attached();
    h.edit({ minBattery: 90, area: { layer: "neighborhood", subset: ["Baker"] } });
    const edited = h.live;

    const back = document
      .getElementById("spec-panel")!
      .querySelector("button") as HTMLButtonElement;
    expect(back.textContent).toContain(LOCAL_SPEC_NAME);
    back.click();
    await flush();

    expect(toggle().checked).toBe(true);
    // The area the rider chose while detached survives — a spec has nothing
    // to say about geography, so re-applying must not throw it away.
    expect(h.applied.at(-1)).toEqual(toFilterSnapshot(COMMUTER, edited));
    expect(h.applied.at(-1)!.area).toEqual(edited.area);
  });

  it("says nothing on a change that leaves the map matching", async () => {
    const h = await attached();
    // Same filters, different list order — not an edit.
    h.edit({ models: [...h.live.models].reverse() });
    expect(toggle().checked).toBe(true);
    expect(panelText()).not.toContain("Filters changed");
  });
});

describe("switching off", () => {
  beforeEach(() => saveLocalSpec(COMMUTER));

  it("puts back the filters the rider had before, not a default", async () => {
    const before: FilterSnapshot = { ...BASE, quality: "ok-only", minBattery: 20 };
    const h = harness(before);
    h.wire();
    await flush();
    toggle().checked = true;
    toggle().dispatchEvent(new Event("change"));
    await flush();

    toggle().checked = false;
    toggle().dispatchEvent(new Event("change"));
    await flush();

    expect(h.applied.at(-1)).toEqual(before);
    expect(panelText()).toBe("");
  });
});

describe("activeSpec", () => {
  it("is null until a spec is driving the map, and null again after a detach", async () => {
    saveLocalSpec(COMMUTER);
    const h = harness();
    const handle = h.wire();
    await flush();
    expect(handle.activeSpec()).toBeNull();

    toggle().checked = true;
    toggle().dispatchEvent(new Event("change"));
    await flush();
    expect(handle.activeSpec()).toEqual(COMMUTER);

    h.edit({ minBattery: 90 });
    expect(handle.activeSpec()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// savedSpec — what the rider HAS, which is not what the map is showing
// ---------------------------------------------------------------------------
describe("savedSpec", () => {
  // The bug this exists for: the planner read the rider's sheet off
  // `activeSpec`, so a rider who had saved one but never lit the map toggle
  // was told they had never made one.
  it("is the rider's spec with nothing attached to the map", async () => {
    saveLocalSpec(COMMUTER);
    const handle = harness().wire();
    await flush();
    expect(handle.activeSpec()).toBeNull();
    expect(handle.savedSpec()).toEqual(COMMUTER);
  });

  it("survives the filter edit that detaches the map", async () => {
    saveLocalSpec(COMMUTER);
    const h = harness();
    const handle = h.wire();
    await flush();
    toggle().checked = true;
    toggle().dispatchEvent(new Event("change"));
    await flush();
    expect(handle.activeSpec()).toEqual(COMMUTER);

    h.edit({ minBattery: 90 });
    expect(handle.activeSpec()).toBeNull();
    // The map stopped showing only their scooters. They did not stop having a
    // preference.
    expect(handle.savedSpec()).toEqual(COMMUTER);
  });

  it("is null, with no name, for a rider who has none", async () => {
    const handle = harness().wire();
    await flush();
    expect(handle.savedSpec()).toBeNull();
    expect(handle.savedSpecName()).toBeNull();
  });

  it("names the spec it returns", async () => {
    saveLocalSpec(COMMUTER);
    const handle = harness().wire();
    await flush();
    expect(handle.savedSpecName()).toBe(LOCAL_SPEC_NAME);
  });
});

// ---------------------------------------------------------------------------
// The attached spec and the selected spec are different things
// ---------------------------------------------------------------------------
describe("when the list reloads while a spec is attached", () => {
  // `chosen` is a MOVING TARGET: reloading picks a different spec if the
  // attached one was deleted or renamed elsewhere. Everything that answers
  // "which spec is the map showing?" must come from the attachment, or the
  // panel names one spec while acting on another.
  const OTHER: RideSpec = {
    ...defaultSpec(),
    models: ["astro"],
    minBattery: 90,
  };

  /** Attach the local spec, then swap what a reload would find. Clicking Edit
   *  is what reloads the list in this panel. */
  async function attachedThenReplaced() {
    saveLocalSpec(COMMUTER);
    const h = harness();
    h.wire();
    await flush();

    toggle().checked = true;
    toggle().dispatchEvent(new Event("change"));
    await flush();
    expect(toggle().checked).toBe(true);

    // The attached spec is gone from storage; a reload now finds OTHER.
    saveLocalSpec(OTHER);
    editBtn().click();
    await flush();
    document.querySelector(".ranks-modal")?.remove(); // close the sheet

    return h;
  }

  it("still reports the spec the map was projected from", async () => {
    await attachedThenReplaced();
    // activeSpec() must be the attached one, not whatever reloading selected.
    expect(currentHandle()!.activeSpec()).toEqual(COMMUTER);
  });

  it("names the spec that detached, not the one now selected", async () => {
    const h = await attachedThenReplaced();
    h.edit({ minBattery: 5 });
    expect(panelText()).toContain(LOCAL_SPEC_NAME);
    expect(currentHandle()!.activeSpec()).toBeNull();
  });

  it("re-applies the spec that detached when Back is tapped", async () => {
    // The bug this guards: Back was wired to `applySpec()`, which used the
    // CURRENT selection — so the button could say "Back to X" and apply Y.
    const h = await attachedThenReplaced();
    h.edit({ minBattery: 5 });

    const back = document
      .getElementById("spec-panel")!
      .querySelector("button") as HTMLButtonElement;
    back.click();
    await flush();

    expect(h.applied.at(-1)).toEqual(toFilterSnapshot(COMMUTER, h.live));
    expect(currentHandle()!.activeSpec()).toEqual(COMMUTER);
  });
});

// ---------------------------------------------------------------------------
// The sheet's relaxation ladder
// ---------------------------------------------------------------------------
describe("the ladder re-renders when the model choice changes", () => {
  // The ladder has a models rung (widenModelsToPosture), so a model change can
  // add or remove a step. Every other control in the sheet re-rendered it;
  // the model checkboxes did not, and the list a rider reads before deciding
  // what to mark "must" went stale.
  async function openSheet() {
    saveLocalSpec({ ...defaultSpec(), models: null });
    const h = harness();
    h.wire();
    await flush();
    editBtn().click();
    await flush();
    return h;
  }

  const ladderText = () =>
    document.querySelector(".spec-ladder")?.textContent ?? "";

  it("gains a rung when the rider narrows to one seated model", async () => {
    await openSheet();
    // "Any model" has nothing to widen to, so no models rung.
    expect(ladderText()).toContain("Everything here is a must");

    const anyModel = document.querySelector(
      ".ranks-modal input[type=checkbox]",
    ) as HTMLInputElement;
    anyModel.checked = false;
    anyModel.dispatchEvent(new Event("change"));

    const boxes = [
      ...document.querySelectorAll<HTMLInputElement>(
        ".quick-filters input[type=checkbox]",
      ),
    ];
    const cosmo = boxes.find(
      (b) => b.parentElement?.textContent?.includes("Cosmo"),
    )!;
    cosmo.checked = true;
    cosmo.dispatchEvent(new Event("change"));

    expect(ladderText()).toContain("any seated model");
  });
});
