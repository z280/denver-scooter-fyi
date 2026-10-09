// @vitest-environment happy-dom
//
// Condition checks (fleet reports Phase 3, plan §4.4): the step after Confirm
// Features that lets a rider standing at a reported scooter clear or reconfirm
// its reports with a test ride. Every branch the API can answer with has a
// sentence, the points are promised honestly, and only signed-in riders see it.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ConditionCheckResult, type ConditionsResponse } from "./api.ts";
import {
  buildCheckBody,
  conditionErrorCode,
  conditionErrorMessage,
  conditionInviteLine,
  conditionItemLabel,
  pointsPromise,
  readyToSend,
  resultLines,
  withheldMessage,
} from "./condition-check.ts";
import { openConfirmFeatures } from "./device-features.ts";

const VID = "8c4a1f0d2e9b7a35";

function conditions(over: Partial<ConditionsResponse> = {}): ConditionsResponse {
  return {
    vehicle_identifier: VID,
    as_of: "2026-10-09T18:00:00+00:00",
    needs_condition_check: true,
    conditions: [
      {
        report_id: 812,
        report_type: "inaccessible",
        reason: null,
        observed_at: "2026-10-06T17:40:00+00:00",
        reported_at: "2026-10-06T18:02:11+00:00",
        own_report: false,
      },
      {
        report_id: 830,
        report_type: "not_rideable",
        reason: "flat_tire",
        observed_at: "2026-10-08T09:00:00+00:00",
        reported_at: "2026-10-08T09:05:00+00:00",
        own_report: false,
      },
    ],
    auto_resolves: [],
    points: { base: 10, feed_confirmed: 40, max: 50, eligible: true, withheld_reason: null },
    feed_window_minutes: 20,
    ...over,
  };
}

function result(over: Partial<ConditionCheckResult> = {}): ConditionCheckResult {
  return {
    check_id: 501,
    vehicle_identifier: VID,
    submitted_at: "2026-10-09T18:03:00+00:00",
    test_ride: true,
    discarded: false,
    resolved: [812],
    reconfirmed: [830],
    found: [],
    stale: [],
    points_awarded: 10,
    points_pending: 40,
    points_withheld_reason: null,
    feed_status: "pending",
    feed_window_minutes: 20,
    ...over,
  };
}

const apiErr = (status: number, code?: string): ApiError =>
  new ApiError("x", "HTTP_ERROR", {
    status,
    detail: code ? { code, message: "m" } : undefined,
  });

beforeEach(() => {
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

describe("copy", () => {
  it("lists each report with the date the reporter saw it", () => {
    const c = conditions().conditions;
    expect(conditionItemLabel(c[0])).toBe("Inaccessible · seen Oct 6");
    expect(conditionItemLabel(c[1])).toBe("Not rideable (flat tire) · seen Oct 8");
    expect(conditionItemLabel({ ...c[1], own_report: true })).toMatch(/\(your report\)$/);
  });

  it("promises +10 now and +40 on the feed, from the server's own numbers", () => {
    expect(pointsPromise(conditions(), null)).toBe(
      "+10 now, +40 when the feed sees your test ride",
    );
    expect(
      pointsPromise(
        conditions({ points: { base: 12, feed_confirmed: 30, max: 42, eligible: true, withheld_reason: null } }),
        null,
      ),
    ).toBe("+12 now, +30 when the feed sees your test ride");
  });

  it("says up front when points are withheld, and why", () => {
    for (const [reason, re] of [
      ["own_reports_only", /yours/],
      ["cooldown", /24 hours/],
      ["daily_cap", /10 paid checks/],
      ["no_location", /couldn't place/],
    ] as const) {
      expect(
        pointsPromise(
          conditions({ points: { base: 10, feed_confirmed: 40, max: 50, eligible: false, withheld_reason: reason } }),
          null,
        ),
      ).toMatch(re);
    }
    expect(withheldMessage(null)).toBeNull();
  });

  it("invites with the maximum", () => {
    expect(conditionInviteLine()).toBe(
      "Riders reported a problem — confirm its condition for up to 50 points",
    );
    expect(
      conditionInviteLine({
        condition_check: { points: 10 },
        condition_check_confirmed: { points: 40 },
      } as never),
    ).toMatch(/up to 50 points/);
  });
});

describe("every error has a sentence", () => {
  const CASES: [ApiError | Error, string, RegExp][] = [
    [apiErr(409, "nothing_to_check"), "nothing_to_check", /nothing to check/i],
    [apiErr(422, "presence_not_proven"), "presence_not_proven", /plate or QR/],
    [apiErr(422, "unanswered"), "unanswered", /answer every report/],
    [apiErr(422, "unknown_report"), "unknown_report", /different scooter/],
    [apiErr(422, "not_a_condition"), "not_a_condition", /can't clear|isn't something/],
    [apiErr(404, "unknown_vehicle"), "unknown_vehicle", /left the fleet/],
    [new ApiError("t", "TOKEN_REJECTED"), "signed_out", /sign in/],
    [new ApiError("t", "NO_AUTH"), "signed_out", /sign in/],
    [apiErr(429), "rate_limited", /try again later/],
    [apiErr(503), "server", /server/],
    [new TypeError("fetch failed"), "network", /connection/],
    [apiErr(422), "unexpected", /bug/],
  ];
  for (const [err, code, re] of CASES) {
    it(`${code}`, () => {
      expect(conditionErrorCode(err)).toBe(code);
      expect(conditionErrorMessage(code)).toMatch(re);
    });
  }
});

describe("the body", () => {
  const list = conditions().conditions;

  it("needs the test-ride answer, and with Yes every condition", () => {
    const s = { answers: new Map<number, boolean>(), testRide: null as boolean | null };
    expect(readyToSend(s, list)).toBe(false);
    s.testRide = true;
    expect(readyToSend(s, list)).toBe(false);
    s.answers.set(812, false);
    expect(readyToSend(s, list)).toBe(false);
    s.answers.set(830, true);
    expect(readyToSend(s, list)).toBe(true);
  });

  it("with No needs nothing else — the answers are discarded anyway", () => {
    expect(readyToSend({ answers: new Map(), testRide: false }, list)).toBe(true);
  });

  it("cites the feature report as proof of presence", () => {
    expect(
      buildCheckBody(
        { answers: new Map([[812, false], [830, true]]), testRide: true },
        list,
        { featureReportId: 9917 },
      ),
    ).toEqual({
      answers: [
        { report_id: 812, still_a_problem: false },
        { report_id: 830, still_a_problem: true },
      ],
      test_ride: true,
      feature_report_id: 9917,
    });
  });
});

describe("the result", () => {
  it("counts what changed and states the pending +40", () => {
    expect(resultLines(result())).toEqual([
      "1 report cleared — thanks.",
      "1 report confirmed as still a problem.",
      "+10 pts now, +40 more when the feed sees your test ride (within 20 minutes).",
    ]);
  });

  it("a discarded check says nothing was saved", () => {
    expect(
      resultLines(result({ test_ride: false, discarded: true, resolved: [], reconfirmed: [], points_awarded: 0, points_pending: 0, points_withheld_reason: "no_test_ride" })),
    ).toEqual([
      "No test ride, so your answers weren't saved and no points were awarded. Thanks for looking.",
    ]);
  });

  it("says when points were withheld, and counts stale answers and found reports", () => {
    const lines = resultLines(
      result({ resolved: [], found: [840], reconfirmed: [], stale: [812], points_awarded: 0, points_pending: 0, points_withheld_reason: "cooldown" }),
    );
    expect(lines[0]).toBe("1 report cleared — thanks.");
    expect(lines[1]).toMatch(/already been cleared/);
    expect(lines[2]).toMatch(/24 hours/);
  });
});

// ---------------------------------------------------------------------------
// The flow, inside Confirm Features
// ---------------------------------------------------------------------------

function openFlow(over: Record<string, unknown> = {}) {
  const submit = vi.fn().mockResolvedValue({
    id: 9917,
    plate_valid: true,
    points_awarded: 12,
    feature_status: "needs_features_confirmed",
    deduped: false,
    vehicle_identifier: VID,
    qr_matched: null,
  });
  const fetchConditions = vi.fn(async () => conditions());
  const postConditionCheck = vi.fn(async () => result());
  openConfirmFeatures({
    deviceId: "dev1",
    vehicleIdentifier: VID,
    modelName: "Apollo",
    status: "needs_features_confirmed",
    submit: submit as never,
    loadSchedule: (() => new Promise(() => {})) as never,
    signedIn: () => true,
    needsConditionCheck: true,
    fetchConditions,
    postConditionCheck,
    ...over,
  });
  return { submit, fetchConditions, postConditionCheck };
}

const q = <T extends HTMLElement = HTMLButtonElement>(sel: string): T | null =>
  document.querySelector<T>(sel);
const click = (sel: string): void => {
  const b = q(sel);
  if (!b) throw new Error(`no ${sel}`);
  b.click();
};

async function finishFeatures(): Promise<void> {
  for (const id of ["bell-yes", "cup_holder-no", "phone_holder-no", "basket-no", "allgood-yes"]) {
    click(`[data-pick="${id}"]`);
  }
  const plate = q<HTMLInputElement>(".device-features__plate-input")!;
  plate.value = "1025543";
  plate.dispatchEvent(new Event("input"));
  click('[data-action="submit"]');
  await vi.waitFor(() => expect(document.body.textContent).toContain("Thanks — logged."));
}

const text = (): string => document.body.textContent ?? "";

describe("the step in Confirm Features", () => {
  it("asks, after the features, in the owner's words", async () => {
    openFlow();
    await finishFeatures();
    expect(text()).toContain("Would you like to confirm condition (ride-ability) as well?");
    expect(text()).toContain("Requires starting the scooter.");
  });

  it("is not offered signed out", async () => {
    const { fetchConditions } = openFlow({ signedIn: () => false });
    await finishFeatures();
    expect(text()).not.toContain("confirm condition");
    expect(q('[data-action="condition-start"]')).toBeNull();
    expect(fetchConditions).not.toHaveBeenCalled();
  });

  it("is not offered when the map says nothing stands", async () => {
    openFlow({ needsConditionCheck: false });
    await finishFeatures();
    expect(q('[data-action="condition-start"]')).toBeNull();
  });

  it("is not offered when the plate didn't match (no proof of presence)", async () => {
    openFlow({
      submit: vi.fn().mockResolvedValue({
        id: 9917, plate_valid: false, points_awarded: 0,
        feature_status: "up_to_date", deduped: false, vehicle_identifier: VID, qr_matched: null,
      }) as never,
    });
    await finishFeatures();
    expect(q('[data-action="condition-start"]')).toBeNull();
  });

  it("No thanks closes the modal", async () => {
    openFlow();
    await finishFeatures();
    click('[data-action="condition-skip"]');
    expect(q(".device-features")).toBeNull();
  });

  it("fetches the conditions and lists each with its date and Still a problem?", async () => {
    const { fetchConditions } = openFlow();
    await finishFeatures();
    click('[data-action="condition-start"]');
    await vi.waitFor(() => expect(text()).toContain("Riders reported:"));
    expect(fetchConditions).toHaveBeenCalledWith(VID);
    expect(text()).toContain("Inaccessible · seen Oct 6");
    expect(text()).toContain("Not rideable (flat tire) · seen Oct 8");
    expect(document.querySelectorAll('[data-pick^="cond-"][data-pick$="-yes"]')).toHaveLength(2);
    expect(text()).toContain("Still a problem?");
    expect(text()).toContain("Did you do a test ride?");
    expect(text()).toContain("Answer No and your answers are thrown away");
    expect(q('[data-role="points"]')?.textContent).toBe(
      "+10 now, +40 when the feed sees your test ride",
    );
  });

  it("Yes to the test ride needs every answer, then POSTs them with the feature id", async () => {
    const { postConditionCheck } = openFlow();
    await finishFeatures();
    click('[data-action="condition-start"]');
    await vi.waitFor(() => expect(q('[data-pick="testride-yes"]')).not.toBeNull());
    click('[data-pick="testride-yes"]');
    expect(q<HTMLButtonElement>('[data-action="condition-submit"]')!.disabled).toBe(true);
    click('[data-pick="cond-812-no"]');
    expect(q<HTMLButtonElement>('[data-action="condition-submit"]')!.disabled).toBe(true);
    click('[data-pick="cond-830-yes"]');
    expect(q<HTMLButtonElement>('[data-action="condition-submit"]')!.disabled).toBe(false);
    click('[data-action="condition-submit"]');
    await vi.waitFor(() => expect(postConditionCheck).toHaveBeenCalledTimes(1));
    expect(postConditionCheck).toHaveBeenCalledWith(VID, {
      answers: [
        { report_id: 812, still_a_problem: false },
        { report_id: 830, still_a_problem: true },
      ],
      test_ride: true,
      feature_report_id: 9917,
    });
    await vi.waitFor(() => expect(text()).toContain("Condition check sent."));
    expect(text()).toContain("+10 pts now, +40 more when the feed sees your test ride");
    click('[data-action="condition-done"]');
    expect(q(".device-features")).toBeNull();
  });

  it("No to the test ride sends test_ride:false and reports the discard", async () => {
    const postConditionCheck = vi.fn(async () =>
      result({ test_ride: false, discarded: true, resolved: [], reconfirmed: [], points_awarded: 0, points_pending: 0, points_withheld_reason: "no_test_ride" }),
    );
    openFlow({ postConditionCheck });
    await finishFeatures();
    click('[data-action="condition-start"]');
    await vi.waitFor(() => expect(q('[data-pick="testride-no"]')).not.toBeNull());
    click('[data-pick="cond-812-no"]');
    click('[data-pick="testride-no"]');
    expect(q<HTMLButtonElement>('[data-action="condition-submit"]')!.disabled).toBe(false);
    click('[data-action="condition-submit"]');
    await vi.waitFor(() => expect(postConditionCheck).toHaveBeenCalledTimes(1));
    const body = (postConditionCheck.mock.calls[0] as unknown[])[1] as { test_ride: boolean; feature_report_id: number };
    expect(body.test_ride).toBe(false);
    expect(body.feature_report_id).toBe(9917);
    await vi.waitFor(() => expect(text()).toContain("your answers weren't saved"));
  });

  it("shows the withheld reason before the rider starts", async () => {
    openFlow({
      fetchConditions: vi.fn(async () =>
        conditions({ points: { base: 10, feed_confirmed: 40, max: 50, eligible: false, withheld_reason: "own_reports_only" } }),
      ),
    });
    await finishFeatures();
    click('[data-action="condition-start"]');
    await vi.waitFor(() => expect(q('[data-role="points"]')).not.toBeNull());
    expect(q('[data-role="points"]')!.textContent).toMatch(/only reports here are yours/);
  });

  it("an empty list reads as nothing to check", async () => {
    openFlow({ fetchConditions: vi.fn(async () => conditions({ conditions: [] })) });
    await finishFeatures();
    click('[data-action="condition-start"]');
    await vi.waitFor(() =>
      expect(q('[data-role="status"][data-code]')?.dataset.code).toBe("nothing_to_check"),
    );
  });

  for (const code of ["nothing_to_check", "presence_not_proven", "unanswered", "unknown_report", "not_a_condition"]) {
    it(`a ${code} refusal is said plainly`, async () => {
      const status = code === "nothing_to_check" ? 409 : 422;
      openFlow({ postConditionCheck: vi.fn(async () => { throw apiErr(status, code); }) });
      await finishFeatures();
      click('[data-action="condition-start"]');
      await vi.waitFor(() => expect(q('[data-pick="testride-no"]')).not.toBeNull());
      click('[data-pick="testride-no"]');
      click('[data-action="condition-submit"]');
      await vi.waitFor(() =>
        expect(q('[data-role="status"][data-code]')?.dataset.code).toBe(code),
      );
      expect(text()).toContain(conditionErrorMessage(code));
      // The list-mismatch codes offer to reload it.
      expect(q('[data-action="condition-retry"]') !== null).toBe(
        ["unanswered", "unknown_report", "not_a_condition"].includes(code),
      );
    });
  }

  it("a session that expired mid-check says to sign in", async () => {
    openFlow({ fetchConditions: vi.fn(async () => { throw new ApiError("t", "TOKEN_REJECTED"); }) });
    await finishFeatures();
    click('[data-action="condition-start"]');
    await vi.waitFor(() => expect(text()).toContain("sign in again"));
  });

  it("a rate limit says to wait", async () => {
    openFlow({ postConditionCheck: vi.fn(async () => { throw apiErr(429); }) });
    await finishFeatures();
    click('[data-action="condition-start"]');
    await vi.waitFor(() => expect(q('[data-pick="testride-no"]')).not.toBeNull());
    click('[data-pick="testride-no"]');
    click('[data-action="condition-submit"]');
    await vi.waitFor(() => expect(text()).toContain("try again later"));
  });

  it("adds no text field — nothing for iOS shake-to-undo to catch", async () => {
    openFlow();
    await finishFeatures();
    click('[data-action="condition-start"]');
    await vi.waitFor(() => expect(text()).toContain("Riders reported:"));
    expect(document.querySelectorAll(".device-features__condition input, .device-features__condition textarea")).toHaveLength(0);
  });
});
