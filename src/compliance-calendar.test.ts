// @vitest-environment happy-dom
//
// 📅 The compliance calendar.
//
// Almost everything here is about the difference between "Veo missed the
// target" and "we have no number for this day". A red/green calendar that
// paints unmeasured days red is an accusation this app cannot back, and
// this app's standing rests entirely on its numbers being defensible. So
// the four statuses each get their own coverage, and the summary line's
// denominator gets its own test.
//
// The date helpers get their own too, for a duller but nastier reason:
// `new Date("2026-08-01")` is midnight UTC, which in Denver is July 31st.
// Parsed naively, every month would be labelled with the previous month's
// name and every grid would start one column early.
import { describe, expect, it, vi } from "vitest";

import type {
  ComplianceCalendarDay,
  ComplianceCalendarMonth,
  ComplianceCalendarResponse,
} from "./api.ts";
import {
  calendarHtml,
  errorHtml,
  monthGridHtml,
  monthTitle,
  openComplianceCalendar,
  weekdayIndex,
} from "./compliance-calendar.ts";

function day(
  date: string,
  status: ComplianceCalendarDay["status"],
  percent: number | null = null,
  in_future = false,
): ComplianceCalendarDay {
  return { date, status, percent, snapshot_count: percent === null ? 0 : 90, in_future };
}

function month(
  m: string,
  days: ComplianceCalendarDay[],
): ComplianceCalendarMonth {
  return {
    month: m,
    first_date: days[0].date,
    last_date: days[days.length - 1].date,
    days,
    pass_days: days.filter((d) => d.status === "pass").length,
    fail_days: days.filter((d) => d.status === "fail").length,
  };
}

function response(months: ComplianceCalendarMonth[]): ComplianceCalendarResponse {
  return { group: "equity", threshold: 30, today: "2026-08-21", months };
}

describe("date helpers", () => {
  it("labels a month with its own name, not the previous one's", () => {
    // The UTC-midnight trap: a naive parse of "2026-08" lands on July 31st
    // in Denver.
    expect(monthTitle("2026-08")).toBe("August 2026");
    expect(monthTitle("2026-01")).toBe("January 2026");
    expect(monthTitle("2026-12")).toBe("December 2026");
  });

  it("degrades to the raw string on garbage rather than printing NaN", () => {
    expect(monthTitle("nonsense")).toBe("nonsense");
  });

  it("puts each date in its real weekday column", () => {
    // 2026-08-01 is a Saturday; 2026-08-02 a Sunday.
    expect(weekdayIndex("2026-08-01")).toBe(6);
    expect(weekdayIndex("2026-08-02")).toBe(0);
    expect(weekdayIndex("2026-02-01")).toBe(0);   // Sunday
  });
});

describe("the month grid", () => {
  it("pads with blanks so the 1st lands in its weekday column", () => {
    // 2026-08-01 is a Saturday → six leading blanks. Without them the grid
    // is still seven-wide but nobody can match a cell to a day.
    const html = monthGridHtml(month("2026-08", [day("2026-08-01", "pass", 41)]));
    expect(html.match(/cal__cell--blank/g)).toHaveLength(6);
  });

  it("needs no padding when the 1st is a Sunday", () => {
    const html = monthGridHtml(month("2026-02", [day("2026-02-01", "pass", 41)]));
    expect(html).not.toContain("cal__cell--blank");
  });

  it("colors a passing day green and a failing day red", () => {
    const html = monthGridHtml(
      month("2026-08", [day("2026-08-01", "pass", 41.2), day("2026-08-02", "fail", 18.9)]),
    );
    expect(html).toContain("cal__cell is-pass");
    expect(html).toContain("cal__cell is-fail");
  });

  it("does NOT color an unmeasured day as a failure", () => {
    // The whole reason this isn't a two-color calendar. `no_data` means the
    // nightly job never ran; `pending` means the day predates the official
    // map. Neither is Veo missing a target.
    const html = monthGridHtml(
      month("2026-08", [day("2026-08-01", "no_data"), day("2026-08-02", "pending")]),
    );
    expect(html).toContain("cal__cell is-no-data");
    expect(html).toContain("cal__cell is-pending");
    expect(html).not.toContain("is-fail");
  });

  it("draws a day that hasn't happened as an empty slot", () => {
    const html = monthGridHtml(
      month("2026-08", [day("2026-08-25", "no_data", null, true)]),
    );
    expect(html).toContain("cal__cell--future");
    expect(html).toContain(`aria-label="2026-08-25 — hasn't happened yet"`);
    // A future day is not "no data" — nobody is owed a number for tomorrow.
    expect(html).not.toContain("is-no-data");
  });

  it("counts the summary against MEASURED days, not calendar days", () => {
    // "4 of 31" would be a lie on a month that is half over or half
    // unreprocessed.
    const html = monthGridHtml(
      month("2026-08", [
        day("2026-08-01", "pass", 41),
        day("2026-08-02", "fail", 12),
        day("2026-08-03", "pending"),
        day("2026-08-04", "no_data"),
      ]),
    );
    expect(html).toContain("1 of 2 measured days met the target");
  });

  it("says so plainly when nothing is measured yet", () => {
    const html = monthGridHtml(month("2026-08", [day("2026-08-01", "pending")]));
    expect(html).toContain("No measured days yet");
  });

  it("gives every cell an accessible label, not just a hover title", () => {
    const html = monthGridHtml(month("2026-08", [day("2026-08-01", "fail", 18.9)]));
    expect(html).toContain('aria-label="2026-08-01 — missed the 30% target — 18.9%"');
  });
});

describe("the full calendar", () => {
  it("renders every month it is given", () => {
    const html = calendarHtml(
      response([
        month("2026-07", [day("2026-07-01", "pass", 41)]),
        month("2026-08", [day("2026-08-01", "fail", 12)]),
      ]),
    );
    expect(html).toContain("July 2026");
    expect(html).toContain("August 2026");
  });

  it("states the target it is drawing against", () => {
    expect(calendarHtml(response([month("2026-08", [day("2026-08-01", "pass", 41)])])))
      .toContain("30% of the active fleet");
  });

  it("explains the reprocessing color only when one is on screen", () => {
    // A legend entry for a state the reader cannot see is just more to read.
    const withPending = calendarHtml(
      response([month("2026-08", [day("2026-08-01", "pending")])]),
    );
    expect(withPending).toContain("Reprocessing");
    expect(withPending).toContain("not a day Veo missed");

    const without = calendarHtml(
      response([month("2026-08", [day("2026-08-01", "pass", 41)])]),
    );
    expect(without).not.toContain("Reprocessing");
  });

  it("blames our own feed, not Veo, when it can't load", () => {
    expect(errorHtml()).toContain("not a verdict on Veo");
  });
});

describe("opening it", () => {
  it("paints a loading state before the fetch resolves", async () => {
    let resolve!: (v: ComplianceCalendarResponse) => void;
    const pending = new Promise<ComplianceCalendarResponse>((r) => {
      resolve = r;
    });
    openComplianceCalendar(() => pending);

    // The modal is on screen immediately: a button that does nothing until
    // the network answers reads as broken.
    expect(document.querySelector(".ranks-modal")).toBeTruthy();
    expect(document.body.textContent).toContain("Loading…");

    resolve(response([month("2026-08", [day("2026-08-01", "pass", 41)])]));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("August 2026"),
    );
  });

  it("asks for two months — this one and last", async () => {
    const fetcher = vi.fn().mockResolvedValue(response([]));
    openComplianceCalendar(fetcher);
    expect(fetcher).toHaveBeenCalledWith(2);
  });

  it("shows the error state when the fetch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    openComplianceCalendar(() => Promise.reject(new Error("down")));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("isn't available right now"),
    );
  });

  it("does not throw when the modal closes mid-fetch", async () => {
    let resolve!: (v: ComplianceCalendarResponse) => void;
    const pending = new Promise<ComplianceCalendarResponse>((r) => {
      resolve = r;
    });
    openComplianceCalendar(() => pending);
    document.querySelector(".ranks-modal")?.remove();

    resolve(response([month("2026-08", [day("2026-08-01", "pass", 41)])]));
    await expect(pending).resolves.toBeTruthy();
  });
});
