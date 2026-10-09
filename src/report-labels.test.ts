// Report labels (fleet reports Phase 3): what a standing report makes the app
// SAY about a scooter — never whether it is shown.
import { describe, expect, it } from "vitest";
import {
  denverDateDaysAgo,
  latestReportLine,
  NOT_RIDEABLE_DECOYS,
  NOT_RIDEABLE_REASONS,
  OBSERVED_PRESETS,
  observedAtFor,
  readLatestReport,
  reportRisk,
  reportRiskNote,
  reportedPhrase,
} from "./report-labels.ts";
import { assessReliability, reliabilityHeadline } from "./reliability.ts";

const TRACKED = {
  number_failed_starts: 0,
  first_observed_at_location: new Date(Date.now() - 3_600_000).toISOString(),
  quality_designation: "good",
};

describe("reportRisk — the label fields", () => {
  it("has_negative_report reads high risk, with the reason", () => {
    expect(
      reportRisk({
        has_negative_report: true,
        negative_report_risk: "high_risk",
        negative_report_reason: "not_rideable",
        negative_report_reason_detail: "flat_tire",
      }),
    ).toEqual({ risk: "high_risk", phrase: "reported not rideable (flat tire)" });
  });

  it("reads the MapLibre-flattened string form too", () => {
    expect(
      reportRisk({ has_negative_report: "true", negative_report_reason: "inaccessible" })
        ?.phrase,
    ).toBe("reported inaccessible");
  });

  it("an anonymous report over 24 h reads unknown risk, with the reason", () => {
    expect(
      reportRisk({
        has_negative_report: false,
        negative_report_risk: "unknown",
        negative_report_reason: "damaged",
      }),
    ).toEqual({ risk: "unknown", phrase: "reported damaged" });
  });

  it("is null with no report, and null when the detail query failed", () => {
    expect(reportRisk({ has_negative_report: false, negative_report_risk: null })).toBeNull();
    expect(reportRisk({})).toBeNull();
  });

  it("still reads high risk when only the detail fields are null", () => {
    // `has_negative_report` comes from the payload's own query; the reason
    // fields are null when their query failed. The label stands, generic.
    expect(
      reportRisk({
        has_negative_report: true,
        negative_report_risk: null,
        negative_report_reason: null,
        negative_report_reason_detail: null,
      }),
    ).toEqual({ risk: "high_risk", phrase: "reported by a rider" });
  });

  it("names every reason and every type", () => {
    for (const r of NOT_RIDEABLE_REASONS) {
      expect(reportedPhrase("not_rideable", r.reason)).toMatch(/^reported not rideable \(.+\)$/);
    }
    expect(reportedPhrase("not_rideable", null)).toBe("reported not rideable");
    expect(reportedPhrase("dead_battery")).toBe("reported dead battery");
    expect(reportedPhrase("not_found")).toBe("reported not where the map says");
    // A reason only means something on not_rideable.
    expect(reportedPhrase("damaged", "flat_tire")).toBe("reported damaged");
  });

  it("discourages retrieval for inaccessible", () => {
    expect(
      reportRiskNote({ has_negative_report: true, negative_report_reason: "inaccessible" }),
    ).toMatch(/don't go in/);
  });

  it("offers the owner's six reasons and two decoys, in order", () => {
    expect(NOT_RIDEABLE_REASONS.map((r) => r.label)).toEqual([
      "Acceleration issue",
      "Flat tire(s)",
      "Wheel problem",
      "Lighting problem",
      "Seat problem",
      "Handlebar problem",
    ]);
    expect(NOT_RIDEABLE_DECOYS.map((d) => d.reason)).toEqual(["cannot_find", "dead_battery"]);
  });
});

describe("reliability — reports fold into the existing tier, not a parallel one", () => {
  it("a standing report is the risk tier, and its reason is the reason", () => {
    const info = assessReliability({
      ...TRACKED,
      has_negative_report: true,
      negative_report_reason: "not_rideable",
      negative_report_reason_detail: "flat_tire",
    });
    expect(info).toEqual({ tier: "risk", reasons: ["reported not rideable (flat tire)"] });
  });

  it("a faded anonymous report is unknown, never ok", () => {
    const info = assessReliability({
      ...TRACKED,
      has_negative_report: false,
      negative_report_risk: "unknown",
      negative_report_reason: "inaccessible",
    });
    expect(info.tier).toBe("unknown");
    expect(info.reasons).toEqual(["reported inaccessible"]);
  });

  it("a faded report never masks a stronger verdict", () => {
    const info = assessReliability({
      ...TRACKED,
      number_failed_starts: 3,
      negative_report_risk: "unknown",
      negative_report_reason: "damaged",
    });
    expect(info.tier).toBe("risk");
    expect(info.reasons[0]).toMatch(/failed starts/);
  });

  it("the headline carries the reason only when the report sets the tier", () => {
    const flagged = {
      has_negative_report: true,
      negative_report_reason: "not_rideable",
      negative_report_reason_detail: "flat_tire",
    };
    expect(reliabilityHeadline("risk", flagged)).toBe(
      "High risk: reported not rideable (flat tire)",
    );
    expect(
      reliabilityHeadline("risk", { has_negative_report: true, negative_report_reason: "inaccessible" }),
    ).toBe("High risk: reported inaccessible");
    expect(
      reliabilityHeadline("unknown", { negative_report_risk: "unknown", negative_report_reason: "not_found" }),
    ).toBe("Unknown risk: reported not where the map says");
    // High risk for failed starts plus a faded report: plain label.
    expect(
      reliabilityHeadline("risk", { negative_report_risk: "unknown", negative_report_reason: "damaged" }),
    ).toBe("High risk");
    expect(reliabilityHeadline("ok", {})).toBe("Likely rideable");
    expect(reliabilityHeadline("risk", {})).toBe("High risk");
  });
});

describe("latest_report — the details tile line", () => {
  it("shows type, Denver observed date and the anonymous flag", () => {
    expect(
      latestReportLine({
        report_type: "inaccessible",
        reason: null,
        // 03:00 UTC on Oct 9 is still Oct 8 in Denver.
        observed_at: "2026-10-09T03:00:00Z",
        reported_at: "2026-10-09T03:05:00Z",
        anonymous: true,
      }),
    ).toBe("Last report: Inaccessible · Oct 8 (anonymous)");
  });

  it("names the not-rideable reason, signed in", () => {
    expect(
      latestReportLine({
        report_type: "not_rideable",
        reason: "flat_tire",
        observed_at: "2026-10-08T18:00:00Z",
        reported_at: "2026-10-08T18:00:00Z",
        anonymous: false,
      }),
    ).toBe("Last report: Not rideable (flat tire) · Oct 8");
  });

  it("falls back to the reported date, and reads the flattened JSON string", () => {
    const flat = JSON.stringify({
      report_type: "damaged",
      reason: null,
      observed_at: null,
      reported_at: "2026-10-07T18:00:00Z",
      anonymous: false,
    });
    expect(latestReportLine(flat)).toBe("Last report: Damaged · Oct 7");
  });

  it("is nothing at all when there is no report", () => {
    expect(latestReportLine(null)).toBeNull();
    expect(latestReportLine(undefined)).toBeNull();
    expect(latestReportLine("null")).toBeNull();
    expect(latestReportLine("{not json")).toBeNull();
    expect(readLatestReport({ reason: "x" })).toBeNull();
  });
});

describe("When did you notice? — presets, not a date input", () => {
  // 2026-10-09 05:30 UTC = Oct 8, 23:30 in Denver (MDT, UTC-6).
  const LATE_EVENING = Date.parse("2026-10-09T05:30:00Z");

  it("counts back from Denver's date, not UTC's", () => {
    expect(denverDateDaysAgo(0, LATE_EVENING)).toBe("2026-10-08");
    expect(denverDateDaysAgo(1, LATE_EVENING)).toBe("2026-10-07");
  });

  it("sends nothing for Today, and a Denver date otherwise", () => {
    expect(observedAtFor("today", LATE_EVENING)).toBeUndefined();
    expect(observedAtFor("yesterday", LATE_EVENING)).toBe("2026-10-07");
    expect(observedAtFor("few_days", LATE_EVENING)).toBe("2026-10-06");
    expect(observedAtFor("week", LATE_EVENING)).toBe("2026-10-01");
  });

  it("never reaches past the API's 30-day limit", () => {
    expect(Math.max(...OBSERVED_PRESETS.map((p) => p.daysAgo))).toBeLessThan(30);
    expect(OBSERVED_PRESETS.map((p) => p.label)).toEqual([
      "Today",
      "Yesterday",
      "2–3 days ago",
      "About a week ago",
    ]);
  });
});
