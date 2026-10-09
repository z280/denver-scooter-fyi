// Condition checks — "is this reported scooter still broken?" (docs/
// FLEET_REPORTS_PLAN.md §4.4/§4.5, API.md "Condition checks").
//
// A sticky report needs a way for RIDERS to clear it, not only a 100 m move or
// an admin. Feature confirmation is where a rider is already standing at the
// scooter answering questions, so the check rides along with it: after the
// features step, `device-features.ts` mounts this.
//
// THE FLOW (owner's copy):
//   Would you like to confirm condition (ride-ability) as well?
//   (requires starting scooter)                              Yes / No thanks
//   → each standing report, with its date:   Still a problem?  Yes / No
//   → Did you do a test ride?                                 Yes / No
//     "No" throws every answer away — said up front, not discovered later.
//   → POST with the feature report's id as proof of presence.
//
// POINTS ARE SHOWN HONESTLY: +10 when the check lands, +40 only once Veo's
// feed shows the test ride (a rental or a move within the window) — and when
// the server will withhold them (your own reports, a cooldown, the daily cap),
// it says so before the rider starts the scooter, not after.
//
// Signed-in riders only: both endpoints need a bearer token, and a resolution
// is attributed. The caller decides whether to mount this at all.
//
// No text inputs: Yes/No buttons only, so nothing here can enter iOS's
// shake-to-undo queue (`ios-shake-undo.ts`).

import {
  ApiError,
  fetchConditions,
  pointsScheduleEntry,
  postConditionCheck,
  type ConditionCheckBody,
  type ConditionCheckResult,
  type ConditionItem,
  type ConditionPoints,
  type ConditionsResponse,
  type PointsScheduleResponse,
} from "./api.ts";
import { denverShortDate, reportTypeLabel } from "./report-labels.ts";

// Wire types and the two calls live in api.ts (the one client for /api/v1).
export type {
  ConditionAnswer,
  ConditionCheckBody,
  ConditionCheckResult,
  ConditionItem,
  ConditionPoints,
  ConditionsResponse,
} from "./api.ts";
export { fetchConditions, postConditionCheck } from "./api.ts";

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/** These MUST match the API's `condition_check` / `condition_check_confirmed`
 *  awards; `/points/schedule` and the GET's own `points` are the authority. */
export const CONDITION_POINTS_FALLBACK = { base: 10, confirmed: 40 } as const;

export function conditionPointValues(
  schedule: PointsScheduleResponse | null,
  points?: Pick<ConditionPoints, "base" | "feed_confirmed"> | null,
): { base: number; confirmed: number } {
  const base =
    points?.base ??
    pointsScheduleEntry(schedule, "condition_check")?.points ??
    CONDITION_POINTS_FALLBACK.base;
  const confirmed =
    points?.feed_confirmed ??
    pointsScheduleEntry(schedule, "condition_check_confirmed")?.points ??
    CONDITION_POINTS_FALLBACK.confirmed;
  return { base, confirmed };
}

/** The map popup's invitation for a scooter with `needs_condition_check`. */
export function conditionInviteLine(
  schedule: PointsScheduleResponse | null = null,
): string {
  const { base, confirmed } = conditionPointValues(schedule);
  return `Riders reported a problem — confirm its condition for up to ${base + confirmed} points`;
}

/** Why the server will pay nothing, in plain words. */
export function withheldMessage(reason: string | null | undefined): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case "own_reports_only":
      return "No points for this one — the only reports here are yours. Your answers still count.";
    case "cooldown":
      return "No points this time — you've already been paid for checking this scooter in the last 24 hours. Your answers still count.";
    case "daily_cap":
      return "No points this time — you've reached today's 10 paid checks. Your answers still count.";
    case "no_location":
      return "No points this time — we couldn't place the scooter. Your answers still count.";
    case "no_test_ride":
      return "No test ride, so no points.";
    default:
      return "No points for this check. Your answers still count.";
  }
}

/** What a test-ridden check would pay, said before the rider starts. */
export function pointsPromise(
  r: Pick<ConditionsResponse, "points" | "feed_window_minutes"> | null,
  schedule: PointsScheduleResponse | null,
): string {
  if (r && !r.points.eligible) {
    return withheldMessage(r.points.withheld_reason) ?? "No points for this check.";
  }
  const { base, confirmed } = conditionPointValues(schedule, r?.points);
  return `+${base} now, +${confirmed} when the feed sees your test ride`;
}

// ---------------------------------------------------------------------------
// Errors — every code gets a sentence
// ---------------------------------------------------------------------------

/** The `code` from `{"detail": {"code", …}}`, or a transport-level stand-in:
 *  `signed_out` (401 / no session), `rate_limited` (429), `server` (5xx),
 *  `network` (no response at all). */
export function conditionErrorCode(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "NO_AUTH" || err.code === "TOKEN_REJECTED") return "signed_out";
    if (err.status === 401) return "signed_out";
    if (err.status === 429) return "rate_limited";
    const d = err.detail;
    if (d && typeof d === "object" && "code" in d) {
      return String((d as { code: unknown }).code);
    }
    if (err.status === 404) return "unknown_vehicle";
    if (err.status !== undefined && err.status >= 500) return "server";
    return "unexpected";
  }
  return "network";
}

export function conditionErrorMessage(code: string): string {
  switch (code) {
    case "nothing_to_check":
      return "There's nothing to check any more — every report on this scooter has already been cleared.";
    case "presence_not_proven":
      return "We couldn't confirm you're at this scooter. Confirm its features with the plate or QR code first, then check its condition.";
    case "unanswered":
      return "A new report came in while you were answering. Reload the list and answer every report.";
    case "unknown_report":
      return "One of those reports belongs to a different scooter. Reload the list and try again.";
    case "not_a_condition":
      return "One of those reports isn't something a condition check can clear. Reload the list and try again.";
    case "unknown_vehicle":
      return "We don't have a record of this scooter any more — it may have left the fleet.";
    case "signed_out":
      return "Your session expired — sign in again to check this scooter's condition.";
    case "rate_limited":
      return "That's a lot of checks in one hour — take a break and try again later.";
    case "server":
      return "Our server had a problem with that — try again in a moment.";
    case "network":
      return "Couldn't reach us — check your connection and try again.";
    default:
      return "Something about that didn't add up on our side — please report this as a bug.";
  }
}

/** Errors the rider fixes by fetching the list again. */
export const RELOADABLE_CODES = new Set(["unanswered", "unknown_report", "not_a_condition"]);

// ---------------------------------------------------------------------------
// The form's pure parts
// ---------------------------------------------------------------------------

/** "Not rideable (flat tire) · seen Oct 8" — the date the reporter SAW it. */
export function conditionItemLabel(c: ConditionItem): string {
  const date = denverShortDate(c.observed_at ?? c.reported_at);
  return (
    reportTypeLabel(c.report_type, c.reason) +
    (date ? ` · seen ${date}` : "") +
    (c.own_report ? " (your report)" : "")
  );
}

export interface CheckState {
  /** report_id → still a problem? Absent = unanswered. */
  answers: Map<number, boolean>;
  testRide: boolean | null;
}

/** Ready to send: the test-ride question answered, and — when it is Yes —
 *  every listed condition answered (the API's `422 unanswered`). With No the
 *  answers are discarded server-side anyway, so none are required. */
export function readyToSend(state: CheckState, conditions: readonly ConditionItem[]): boolean {
  if (state.testRide === null) return false;
  if (state.testRide === false) return true;
  return conditions.every((c) => state.answers.has(c.report_id));
}

export function buildCheckBody(
  state: CheckState,
  conditions: readonly ConditionItem[],
  proof: { featureReportId?: number; plate?: string; qrRawValue?: string },
): ConditionCheckBody {
  const body: ConditionCheckBody = {
    answers: conditions
      .filter((c) => state.answers.has(c.report_id))
      .map((c) => ({
        report_id: c.report_id,
        still_a_problem: state.answers.get(c.report_id)!,
      })),
    test_ride: state.testRide === true,
  };
  if (proof.featureReportId && proof.featureReportId > 0) {
    body.feature_report_id = proof.featureReportId;
  }
  if (proof.plate) body.submitted_plate = proof.plate;
  if (proof.qrRawValue) body.qr_raw_value = proof.qrRawValue;
  return body;
}

/** The result, in sentences. */
export function resultLines(r: ConditionCheckResult): string[] {
  if (r.discarded || !r.test_ride) {
    return ["No test ride, so your answers weren't saved and no points were awarded. Thanks for looking."];
  }
  const lines: string[] = [];
  const cleared = r.resolved.length + r.found.length;
  if (cleared > 0) {
    lines.push(
      cleared === 1
        ? "1 report cleared — thanks."
        : `${cleared} reports cleared — thanks.`,
    );
  }
  if (r.reconfirmed.length > 0) {
    lines.push(
      r.reconfirmed.length === 1
        ? "1 report confirmed as still a problem."
        : `${r.reconfirmed.length} reports confirmed as still a problem.`,
    );
  }
  if (r.stale.length > 0) {
    lines.push(
      r.stale.length === 1
        ? "1 report had already been cleared, so that answer changed nothing."
        : `${r.stale.length} reports had already been cleared, so those answers changed nothing.`,
    );
  }
  const withheld = withheldMessage(r.points_withheld_reason);
  if (withheld) {
    lines.push(withheld);
  } else if (r.points_awarded > 0) {
    const pending = r.points_pending > 0 ? r.points_pending : 0;
    lines.push(
      pending > 0
        ? `+${r.points_awarded} pts now, +${pending} more when the feed sees your test ride (within ${r.feed_window_minutes} minutes).`
        : `+${r.points_awarded} pts.`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The step, mounted inside the Confirm Features modal
// ---------------------------------------------------------------------------

export interface ConditionCheckOptions {
  vehicleIdentifier: string;
  /** The feature report's `id` — the proof of presence. */
  featureReportId?: number;
  plate?: string;
  qrRawValue?: string;
  schedule?: PointsScheduleResponse | null;
  /** Injected for tests. */
  fetchConditions?: typeof fetchConditions;
  postCheck?: typeof postConditionCheck;
  /** The rider is finished with the modal. */
  onDone(): void;
}

const C = "device-features";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

type Phase =
  | { kind: "offer" }
  | { kind: "loading" }
  | { kind: "form"; data: ConditionsResponse }
  | { kind: "sending"; data: ConditionsResponse }
  | { kind: "result"; result: ConditionCheckResult }
  | { kind: "error"; code: string; data: ConditionsResponse | null };

/** Render the condition-check step into `host` (replacing its contents) and
 *  keep it live. Returns a teardown that stops late responses landing. */
export function mountConditionCheck(
  host: HTMLElement,
  opts: ConditionCheckOptions,
): () => void {
  let phase: Phase = { kind: "offer" };
  let alive = true;
  const state: CheckState = { answers: new Map(), testRide: null };
  const schedule = opts.schedule ?? null;

  const button = (
    text: string,
    action: string,
    onClick: () => void,
    secondary = false,
  ): HTMLButtonElement => {
    const b = el("button", secondary ? "login-btn login-btn--secondary" : "login-btn", text);
    b.type = "button";
    b.dataset.action = action;
    b.addEventListener("click", onClick);
    return b;
  };

  const yesNo = (
    label: string,
    value: boolean | null,
    pick: string,
    onPick: (v: boolean) => void,
  ): HTMLElement => {
    const row = el("div", `${C}__row`);
    row.append(el("span", `${C}__q`, label));
    const group = el("div", `${C}__yesno`);
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const [text, v] of [["Yes", true], ["No", false]] as const) {
      const b = el("button", `${C}__toggle`, text);
      b.type = "button";
      b.dataset.pick = `${pick}-${text.toLowerCase()}`;
      const on = value === v;
      b.classList.toggle("is-on", on);
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.addEventListener("click", () => {
        onPick(v);
        render();
        host.querySelector<HTMLButtonElement>(`[data-pick="${b.dataset.pick}"]`)?.focus();
      });
      group.append(b);
    }
    row.append(group);
    return row;
  };

  const load = async (): Promise<void> => {
    phase = { kind: "loading" };
    state.answers.clear();
    state.testRide = null;
    render();
    try {
      const data = await (opts.fetchConditions ?? fetchConditions)(opts.vehicleIdentifier);
      if (!alive) return;
      phase =
        data.conditions.length === 0
          ? { kind: "error", code: "nothing_to_check", data }
          : { kind: "form", data };
    } catch (err) {
      if (!alive) return;
      phase = { kind: "error", code: conditionErrorCode(err), data: null };
    }
    render();
  };

  const send = async (data: ConditionsResponse): Promise<void> => {
    if (!readyToSend(state, data.conditions)) return;
    phase = { kind: "sending", data };
    render();
    try {
      const result = await (opts.postCheck ?? postConditionCheck)(
        opts.vehicleIdentifier,
        buildCheckBody(state, data.conditions, {
          featureReportId: opts.featureReportId,
          plate: opts.plate,
          qrRawValue: opts.qrRawValue,
        }),
      );
      if (!alive) return;
      phase = { kind: "result", result };
    } catch (err) {
      if (!alive) return;
      phase = { kind: "error", code: conditionErrorCode(err), data };
    }
    render();
  };

  const actions = (...btns: HTMLElement[]): HTMLElement => {
    const row = el("div", `${C}__actions`);
    row.append(...btns);
    return row;
  };

  function render(): void {
    const wrap = el("div", `${C}__condition`);
    wrap.dataset.phase = phase.kind;
    switch (phase.kind) {
      case "offer":
        wrap.append(
          el("p", `${C}__stem`, "Would you like to confirm condition (ride-ability) as well?"),
          el("p", `${C}__hint`, "Requires starting the scooter."),
          actions(
            button("No thanks", "condition-skip", () => opts.onDone(), true),
            button("Yes", "condition-start", () => void load()),
          ),
        );
        break;
      case "loading":
        wrap.append(el("p", `${C}__hint`, "Loading this scooter's reports…"));
        break;
      case "form":
      case "sending": {
        const data = phase.data;
        const sending = phase.kind === "sending";
        wrap.append(el("p", `${C}__stem`, "Riders reported:"));
        for (const c of data.conditions) {
          const item = el("div", `${C}__cond`);
          item.dataset.reportId = String(c.report_id);
          item.append(el("p", `${C}__cond-label`, conditionItemLabel(c)));
          item.append(
            yesNo("Still a problem?", state.answers.get(c.report_id) ?? null, `cond-${c.report_id}`, (v) => {
              state.answers.set(c.report_id, v);
            }),
          );
          wrap.append(item);
        }
        wrap.append(
          yesNo("Did you do a test ride?", state.testRide, "testride", (v) => {
            state.testRide = v;
          }),
          el(
            "p",
            `${C}__hint`,
            "Answer No and your answers are thrown away — a check only counts after a test ride.",
          ),
        );
        const pts = el("p", `${C}__cond-points`, pointsPromise(data, schedule));
        pts.dataset.role = "points";
        wrap.append(pts);
        const sendBtn = button(sending ? "Sending…" : "Send", "condition-submit", () => void send(data));
        sendBtn.disabled = sending || !readyToSend(state, data.conditions);
        wrap.append(actions(sendBtn));
        break;
      }
      case "result":
        wrap.append(el("p", `${C}__stem`, "Condition check sent."));
        for (const line of resultLines(phase.result)) {
          wrap.append(el("p", `${C}__hint`, line));
        }
        wrap.append(actions(button("Done", "condition-done", () => opts.onDone())));
        break;
      case "error": {
        const msg = el("p", `${C}__status-line`, conditionErrorMessage(phase.code));
        msg.dataset.role = "status";
        msg.dataset.code = phase.code;
        msg.setAttribute("role", "status");
        wrap.append(msg);
        const btns: HTMLElement[] = [];
        if (RELOADABLE_CODES.has(phase.code) || phase.code === "network" || phase.code === "server") {
          btns.push(button("Try again", "condition-retry", () => void load(), true));
        }
        btns.push(button("Done", "condition-done", () => opts.onDone()));
        wrap.append(actions(...btns));
        break;
      }
    }
    host.replaceChildren(wrap);
  }

  render();
  return () => {
    alive = false;
  };
}
