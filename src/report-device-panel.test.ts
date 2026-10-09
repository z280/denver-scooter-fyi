// @vitest-environment happy-dom
//
// The ⚠️ Report modal's chips (fleet reports Phase 3): Inaccessible, the
// "Why not?" picker with its two decoys, and "When did you notice?" presets —
// and exactly what each tap sends.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./map-auth.js", () => ({
  isAuthenticated: () => false,
  getAuth: () => null,
}));

import {
  INACCESSIBLE_HINT,
  reportConfirmation,
  reportPayload,
  reportProblemHtml,
  wireReportChips,
} from "./report-device-panel.ts";
import { ReportHttpError, type DeviceReportResult } from "./reports.ts";

const VID = "8c4a1f0d2e9b7a35";
const COORDS: [number, number] = [-104.99, 39.74];
// 2026-10-09 18:00 UTC = noon in Denver.
const NOON = Date.parse("2026-10-09T18:00:00Z");

function mount(
  submit = vi.fn(async (): Promise<DeviceReportResult> => ({ deduped: false })),
  blocked: string | null = null,
) {
  const root = document.createElement("div");
  root.innerHTML = reportProblemHtml(VID, blocked);
  document.body.append(root);
  wireReportChips(root, { vid: VID, coords: COORDS, submit, now: () => NOON });
  const btn = (sel: string) => root.querySelector<HTMLButtonElement>(sel)!;
  const chip = (type: string) => btn(`[data-action="report-device"][data-type="${type}"]`);
  const status = () =>
    root.querySelector<HTMLElement>(".device-popup__report-device-status")!.textContent;
  const labels = (attr: string) =>
    [...root.querySelectorAll<HTMLButtonElement>(`[${attr}]`)].map((b) => b.textContent);
  return { root, submit, btn, chip, status, labels };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("the chips", () => {
  it("offers Inaccessible beside the three rideability chips, and explains it", () => {
    const { root, chip } = mount();
    for (const t of ["not_rideable", "dead_battery", "damaged", "inaccessible"]) {
      expect(chip(t)).not.toBeNull();
    }
    expect(chip("inaccessible").textContent).toContain("Inaccessible");
    expect(root.textContent).toContain(INACCESSIBLE_HINT);
    expect(INACCESSIBLE_HINT).toMatch(/can't reach it/);
    expect(INACCESSIBLE_HINT).toMatch(/Don't go in/);
  });

  it("renders nothing for a vehicle without a usable identifier", () => {
    expect(reportProblemHtml("abc", null)).toBe("");
  });

  it("a blocked chip says why and sends nothing", () => {
    const { chip, submit, status } = mount(undefined, "You're too far away.");
    chip("inaccessible").click();
    expect(status()).toBe("You're too far away.");
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("Not rideable → Why not? → When?", () => {
  it("asks why, with six reasons, the two decoys and an out", () => {
    const { chip, labels } = mount();
    chip("not_rideable").click();
    expect(labels("data-reason")).toEqual([
      "Acceleration issue",
      "Flat tire(s)",
      "Wheel problem",
      "Lighting problem",
      "Seat problem",
      "Handlebar problem",
      "Can't find it",
      "Dead battery",
      "Something else",
    ]);
    // Nothing is sent until the rider says when.
    expect(labels("data-when")).toEqual([]);
  });

  it("sends the reason and the observed date", async () => {
    const { chip, btn, submit, status } = mount();
    chip("not_rideable").click();
    btn('[data-reason="flat_tire"]').click();
    btn('[data-when="yesterday"]').click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith({
      vehicle_identifier: VID,
      report_type: "not_rideable",
      reason: "flat_tire",
      observed_at: "2026-10-08",
      lat: COORDS[1],
      lng: COORDS[0],
    });
    await vi.waitFor(() =>
      expect(status()).toBe("✓ Reported: Not rideable (flat tire). Thanks!"),
    );
  });

  it("sends a decoy as not_rideable + reason and shows what the SERVER filed", async () => {
    const submit = vi.fn(
      async (): Promise<DeviceReportResult> => ({
        deduped: false,
        reportType: "not_found",
        remappedFromReason: "cannot_find",
      }),
    );
    const { chip, btn, status } = mount(submit);
    chip("not_rideable").click();
    btn('[data-reason="cannot_find"]').click();
    btn('[data-when="today"]').click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const body = (submit.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(body.report_type).toBe("not_rideable");
    expect(body.reason).toBe("cannot_find");
    // Today sends no observed_at: the server's own clock is more precise.
    expect(body).not.toHaveProperty("observed_at");
    await vi.waitFor(() => expect(status()).toBe('✓ Filed as "Can\'t find it". Thanks!'));
  });

  it("the dead-battery decoy is confirmed as Dead battery", () => {
    expect(
      reportConfirmation(
        { type: "not_rideable", reason: "dead_battery" },
        { deduped: false, reportType: "dead_battery", remappedFromReason: "dead_battery" },
      ),
    ).toBe('✓ Filed as "Dead battery". Thanks!');
  });

  it("Something else sends no reason", () => {
    const { chip, btn, submit } = mount();
    chip("not_rideable").click();
    btn('[data-reason=""]').click();
    btn('[data-when="week"]').click();
    const body = (submit.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("reason");
    expect(body.observed_at).toBe("2026-10-02");
  });
});

describe("the other chips go straight to When?", () => {
  it("Inaccessible asks no reason and sends the preset's date", async () => {
    const { chip, btn, labels, submit, status } = mount();
    chip("inaccessible").click();
    expect(labels("data-reason")).toEqual([]);
    expect(labels("data-when")).toEqual([
      "Today",
      "Yesterday",
      "2–3 days ago",
      "About a week ago",
    ]);
    btn('[data-when="few_days"]').click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith({
      vehicle_identifier: VID,
      report_type: "inaccessible",
      observed_at: "2026-10-07",
      lat: COORDS[1],
      lng: COORDS[0],
    });
    await vi.waitFor(() => expect(status()).toBe("✓ Reported: Inaccessible. Thanks!"));
  });

  it("never sends a reason on a type that cannot carry one", () => {
    expect(
      reportPayload(VID, { type: "damaged", reason: "flat_tire" }, "today", COORDS, NOON),
    ).not.toHaveProperty("reason");
  });

  it("a deduped report says so", () => {
    expect(reportConfirmation({ type: "damaged", reason: null }, { deduped: true })).toMatch(
      /Already reported/,
    );
  });

  it("a refused date says what to do, and the chips come back", async () => {
    const submit = vi.fn(async (): Promise<DeviceReportResult> => {
      throw new ReportHttpError(422);
    });
    const { chip, btn, status } = mount(submit);
    chip("damaged").click();
    btn('[data-when="week"]').click();
    await vi.waitFor(() => expect(status()).toMatch(/more recent/));
    expect(chip("damaged").disabled).toBe(false);
  });
});

describe("no date input anywhere in the flow", () => {
  it("renders buttons only — nothing iOS shake-to-undo could catch", () => {
    const { root, chip } = mount();
    chip("not_rideable").click();
    expect(root.querySelector("input, textarea, select")).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-reason="seat"]')!.click();
    expect(root.querySelector("input, textarea, select")).toBeNull();
  });
});
