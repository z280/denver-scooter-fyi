// The compliance card's line under a day with no equity figure. It used to
// have one explanation ("predates the map, being reprocessed"); the server
// can now also say the day was reprocessed and CANNOT be measured, and the
// card must not keep promising a number that is never coming.
import { describe, expect, it } from "vitest";

import type { ComplianceResponse } from "./api.ts";
import { missingFigureNote } from "./compliance.ts";

function sla(extra: Partial<ComplianceResponse> = {}): ComplianceResponse {
  return {
    sla_date: "2026-08-09",
    window_start_ts: "2026-08-09T12:00:00+00:00",
    window_end_ts: "2026-08-09T15:00:00+00:00",
    snapshot_count: 91,
    avg_total_devices_denver: 7760,
    avg_percent_all_devices_equity: null,
    compliance_equity_pass: null,
    avg_percent_all_devices_v1: 20,
    avg_percent_all_devices_v2: 17,
    compliance_v1_pass: false,
    compliance_v2_pass: false,
    computed_at: "2026-08-09T15:02:00+00:00",
    ...extra,
  };
}

describe("missingFigureNote", () => {
  it("says pending when the server hasn't reached the day", () => {
    expect(missingFigureNote(sla())).toContain("being reprocessed");
    // An older API omits the field entirely; same answer.
    expect(missingFigureNote(sla({ equity_unmeasurable_reason: null })))
      .toContain("being reprocessed");
  });

  it("says unmeasurable — and not a failure — when the server concluded so", () => {
    const note = missingFigureNote(sla({ equity_unmeasurable_reason: "low_fidelity" }));
    expect(note).toContain("Unmeasurable");
    expect(note).toContain("Not a failure");
    expect(note).not.toContain("being reprocessed");
  });
});
