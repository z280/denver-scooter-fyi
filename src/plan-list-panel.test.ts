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
    firstVehicle: null,
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
    const r = row({ firstVehicle: { device_id: "d1" } as PlanRow["firstVehicle"] });
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

  it("stops answering taps once destroyed", () => {
    const onChoose = vi.fn();
    const r = row({ firstVehicle: { device_id: "d1" } as PlanRow["firstVehicle"] });
    const { root, handle } = mount(view({ rows: [r] }), { onChoose });
    const go = root.querySelector<HTMLButtonElement>(".planlist__go")!;
    handle.destroy();
    go.click();
    expect(onChoose).not.toHaveBeenCalled();
  });
});
