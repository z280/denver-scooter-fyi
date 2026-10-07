// @vitest-environment happy-dom
//
// What is pinned here: that the walk-only row cannot be chosen (there is no
// walking flow to choose it INTO), that the disclosures reach the document
// rather than a drawer, and that a plan's cost is never shown as $0.00.
import { describe, expect, it, vi } from "vitest";

import type { PlanListView, PlanRow } from "./plan-list.ts";
import { createPlanListPanel } from "./plan-list-panel.ts";

function row(over: Partial<PlanRow> = {}): PlanRow {
  return {
    plan: {
      legs: [],
      totalSeconds: 720,
      estimatedCents: 350,
      handOffs: 0,
      generalisedCost: 720,
      isEstimate: true,
    },
    headline: "One scooter",
    minutesLabel: "12 min",
    costLabel: "$3.50",
    legLines: [
      { mode: "walk", text: "Walk 2 min to Lunar 🐸 928" },
      { mode: "ride", text: "Ride Lunar 🐸 928 10 min to Union Station", vehicleName: "Lunar 🐸 928" },
    ],
    chips: [],
    disclosures: [],
    saving: null,
    // A REAL ROW HAS A VEHICLE. The default was null, which made every fixture a
    // plan the panel cannot act on — the case the guard below now catches, and
    // which no test was asserting on purpose.
    firstVehicle: { device_id: "d1", vehicle_identifier: "v1" } as PlanRow["firstVehicle"],
    isWalkOnly: false,
    ...over,
  };
}

function view(over: Partial<PlanListView> = {}): PlanListView {
  return {
    rows: [row()],
    estimateNote: "Times and prices are estimates — we cannot see Veo's meter.",
    relaxedLabels: [],
    capRelaxed: false,
    riskWarning: null,
    freeMinutes: null,
    ...over,
  };
}

function mount(v: PlanListView, deps: Partial<Parameters<typeof createPlanListPanel>[2]> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const handle = createPlanListPanel(root, v, {
    onChoose: deps.onChoose ?? vi.fn(),
    onCancel: deps.onCancel ?? vi.fn(),
    ...(deps.onRefresh ? { onRefresh: deps.onRefresh } : {}),
    ...(deps.onCorrectFreeMinutes
      ? { onCorrectFreeMinutes: deps.onCorrectFreeMinutes }
      : {}),
  });
  return { root, handle };
}

describe("the plan list panel", () => {
  it("renders one row per plan and never pads the list", () => {
    const { root } = mount(view({ rows: [row()] }));
    expect(root.querySelectorAll(".planlist__row")).toHaveLength(1);
  });

  it("offers a way to take a plan that has a vehicle", () => {
    const onChoose = vi.fn();
    const r = row();
    const { root } = mount(view({ rows: [r] }), { onChoose });
    const go = root.querySelector<HTMLButtonElement>(".planlist__go")!;
    expect(go).not.toBeNull();
    go.click();
    expect(onChoose).toHaveBeenCalledWith(r);
  });

  it("shows the walk-only row WITHOUT an action, because there is nothing to walk to", () => {
    // A button that goes nowhere is worse than no button. The row still earns
    // its place: it is what riding is being compared against.
    const { root } = mount(
      view({ rows: [row({ isWalkOnly: true, headline: "Walk the whole way" })] }),
    );
    expect(root.querySelector(".planlist__row--walk")).not.toBeNull();
    expect(root.querySelector(".planlist__go")).toBeNull();
    expect(root.textContent).toContain("Walk the whole way");
  });

  it("does not print a price on the walk, which has none", () => {
    const { root } = mount(view({ rows: [row({ isWalkOnly: true, costLabel: "$0.00" })] }));
    expect(root.querySelector(".planlist__cost")).toBeNull();
    expect(root.textContent).not.toContain("$0.00");
  });

  it("puts the equity disclosures in the document, collapsed but findable", () => {
    const { root } = mount(
      view({
        rows: [
          row({
            disclosures: [
              { kind: "screenshot", text: "This should cost about $2.30. If Veo bills you the base rate instead, screenshot the receipt." },
              { kind: "second_unlock", text: "Includes a $1.00 unlock for the Equity Area leg." },
            ],
          }),
        ],
      }),
    );
    // In the DOM, not behind a fetch or a second screen: a <details> is
    // searchable and copyable where an off-screen drawer is not.
    expect(root.querySelectorAll(".planlist__whyitem")).toHaveLength(2);
    expect(root.textContent).toContain("screenshot the receipt");
    expect(root.querySelector("details")).not.toBeNull();
  });

  it("leads the notes with the risk warning when one fired", () => {
    const { root } = mount(view({ riskWarning: "RISKY", relaxedLabels: ["Battery"] }));
    const notes = [...root.querySelectorAll(".planlist__note")].map((n) => n.textContent);
    expect(notes[0]).toBe("RISKY");
    expect(notes.join(" ")).toContain("Battery");
  });

  it("says so plainly rather than rendering an empty box", () => {
    const { root } = mount(view({ rows: [] }));
    expect(root.querySelectorAll(".planlist__row")).toHaveLength(0);
    expect(root.textContent).toContain("Nothing we can offer");
  });

  it("closes on the ✕", () => {
    const onCancel = vi.fn();
    const { root } = mount(view(), { onCancel });
    root.querySelector<HTMLButtonElement>(".planlist__close")!.click();
    expect(onCancel).toHaveBeenCalled();
  });

  it("repaints in place on a fresh search rather than closing under the rider", () => {
    const { root, handle } = mount(view({ rows: [row()] }));
    handle.update(view({ rows: [row({ headline: "Two scooters, one hand-off" }), row()] }));
    expect(root.querySelectorAll(".planlist__row")).toHaveLength(2);
    expect(root.textContent).toContain("Two scooters, one hand-off");
    // And the notes are replaced, not appended to.
    expect(root.querySelectorAll(".planlist__note--quiet")).toHaveLength(1);
  });

  it("offers Look again only when the caller can actually re-search", () => {
    expect(mount(view()).root.querySelector(".planlist__again")).toBeNull();
    const onRefresh = vi.fn();
    const { root } = mount(view(), { onRefresh });
    const again = root.querySelector<HTMLButtonElement>(".planlist__again")!;
    again.click();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("does not stack a second Look again on every repaint", () => {
    const onRefresh = vi.fn();
    const { root, handle } = mount(view(), { onRefresh });
    handle.update(view());
    handle.update(view());
    expect(root.querySelectorAll(".planlist__again")).toHaveLength(1);
  });

  it("hides the free-minute control entirely for a tier with no free hour", () => {
    // Null is the mechanism, not a flag the panel has to remember: a control
    // offering to adjust a budget that does not exist invites the rider to tell
    // us something we will ignore.
    const { root } = mount(view({ freeMinutes: null }));
    expect(root.querySelector<HTMLElement>(".planlist__free")!.hidden).toBe(true);
    expect(root.querySelector(".planlist__freeinput")).toBeNull();
  });

  it("shows the figure and which way it is wrong, above the plans", () => {
    const { root } = mount(
      view({
        freeMinutes: {
          headline: "About 45 free minutes left today",
          basisNote: "…this is the most you have left, not the least.",
          correctionLabel: "I've got about this many left:",
          corrected: false,
        },
      }),
    );
    const free = root.querySelector<HTMLElement>(".planlist__free")!;
    expect(free.hidden).toBe(false);
    expect(free.textContent).toContain("About 45 free minutes left today");
    expect(free.textContent).toContain("not the least");
    // ABOVE the plans: the figure is an input to every price below it, so a
    // rider who reads a price first has read a number they are about to be told
    // was a guess.
    const rows = root.querySelector<HTMLElement>(".planlist__body")!;
    expect(free.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("takes the rider's correction, and an empty box clears it", () => {
    const onCorrectFreeMinutes = vi.fn();
    const { root } = mount(
      view({
        freeMinutes: {
          headline: "h",
          basisNote: "b",
          correctionLabel: "l",
          corrected: false,
        },
      }),
      { onCorrectFreeMinutes },
    );
    const input = root.querySelector<HTMLInputElement>(".planlist__freeinput")!;
    input.value = "12";
    root.querySelector<HTMLButtonElement>(".planlist__freesave")!.click();
    expect(onCorrectFreeMinutes).toHaveBeenCalledWith(12);

    // "I did not answer" and "I have none left" are different answers, and only
    // one of them is the rider's — so an empty box clears rather than becoming 0.
    input.value = "";
    root.querySelector<HTMLButtonElement>(".planlist__freesave")!.click();
    expect(onCorrectFreeMinutes).toHaveBeenLastCalledWith(null);
  });

  it("accepts Enter in the box, since that is what a number field invites", () => {
    const onCorrectFreeMinutes = vi.fn();
    const { root } = mount(
      view({
        freeMinutes: { headline: "h", basisNote: "b", correctionLabel: "l", corrected: false },
      }),
      { onCorrectFreeMinutes },
    );
    const input = root.querySelector<HTMLInputElement>(".planlist__freeinput")!;
    input.value = "7";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onCorrectFreeMinutes).toHaveBeenCalledWith(7);
  });

  it("offers a way back to our estimate only once a correction is on record", () => {
    const base = { headline: "h", basisNote: "b", correctionLabel: "l" };
    const onCorrectFreeMinutes = vi.fn();
    expect(
      mount(view({ freeMinutes: { ...base, corrected: false } }), { onCorrectFreeMinutes }).root
        .querySelector(".planlist__freeundo"),
    ).toBeNull();
    const { root } = mount(view({ freeMinutes: { ...base, corrected: true } }), {
      onCorrectFreeMinutes,
    });
    root.querySelector<HTMLButtonElement>(".planlist__freeundo")!.click();
    expect(onCorrectFreeMinutes).toHaveBeenCalledWith(null);
  });

  it("shows the figure read-only when the caller cannot take a correction", () => {
    // Knowing the number the plans were priced with is most of the point, so the
    // readout survives without the input rather than disappearing with it.
    const { root } = mount(
      view({
        freeMinutes: { headline: "About 45 left", basisNote: "b", correctionLabel: "l", corrected: false },
      }),
    );
    expect(root.textContent).toContain("About 45 left");
    expect(root.querySelector(".planlist__freeinput")).toBeNull();
  });

  it("offers no button on a row it cannot point anywhere", () => {
    // Not reachable through `planListView` today, which sets `isWalkOnly` from
    // the same fact. It is guarded anyway because the failure is the one thing
    // this row exists to avoid: `onChoose` returns silently with no vehicle, so
    // the rider gets a button that does nothing when tapped — worse than no
    // button, and indistinguishable from a broken app.
    const { root } = mount(view({ rows: [row({ firstVehicle: null })] }));
    expect(root.querySelector(".planlist__go")).toBeNull();
    expect(root.textContent).toContain("cannot point you");
    // And it is NOT dressed as the walk, which would be a different lie.
    expect(root.querySelector(".planlist__row--walk")).toBeNull();
  });

  it("stops answering taps once destroyed", () => {
    const onChoose = vi.fn();
    const r = row();
    const { root, handle } = mount(view({ rows: [r] }), { onChoose });
    const go = root.querySelector<HTMLButtonElement>(".planlist__go")!;
    handle.destroy();
    go.click();
    expect(onChoose).not.toHaveBeenCalled();
  });
});
