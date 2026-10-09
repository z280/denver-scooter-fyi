// "Report a problem" — the chips inside the device card's ⚠️ Report modal
// (docs/FLEET_REPORTS_PLAN.md §2.1, §2.10; owner 2026-10-09).
//
// THE FLOW, kept to taps:
//   1. What's wrong?   Not rideable · Dead battery · Damaged · Inaccessible
//   2. (Not rideable)  Why not?  Acceleration issue · Flat tire(s) · Wheel
//                      problem · Lighting problem · Seat problem · Handlebar
//                      problem · Can't find it · Dead battery · Something else
//   3. When did you notice?  Today · Yesterday · 2–3 days ago · About a week ago
//      — the tap on a "when" chip sends.
//
// "Can't find it" and "Dead battery" in the Why-not picker are DECOYS: they are
// different reports, and the SERVER re-files them (`not_found`,
// `dead_battery`). The confirmation names what the server actually filed, from
// its response, so a rider who picked "Can't find it" is told it went in as
// "Can't find it" rather than "Not rideable".
//
// NO DATE INPUT. The device card is reachable mid-ride on a long press, and a
// native date field is edited by WebKit itself, so it can never be kept out of
// iOS's shake-to-undo queue (`ios-shake-undo.ts`). The four presets carry the
// whole question; `undo-free-coverage.test.ts` scans this module for fields.
//
// A report only ever LABELS a scooter ("High risk: reported inaccessible"). It
// never removes it from the map, a list or a plan.
//
// The chips themselves are rendered as markup into the modal (devices.ts
// builds its modals from HTML); the steps under them are built with
// `createElement` and wired here, so devices.ts only calls two functions.

import {
  NOT_RIDEABLE_DECOYS,
  NOT_RIDEABLE_REASONS,
  OBSERVED_PRESETS,
  REPORT_TYPE_LABEL,
  observedAtFor,
  reportTypeLabel,
  type NegativeReportType,
  type ObservedPreset,
} from "./report-labels.ts";
import {
  ReportHttpError,
  submitDeviceReport,
  type DeviceReportType,
  type DeviceReportResult,
} from "./reports.ts";

function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

/** The top-level chips, in order. */
export const REPORT_CHIPS: readonly {
  type: Extract<DeviceReportType, "not_rideable" | "dead_battery" | "damaged" | "inaccessible">;
  glyph: string;
  label: string;
}[] = [
  { type: "not_rideable", glyph: "🚫", label: "Not rideable" },
  { type: "dead_battery", glyph: "🪫", label: "Dead battery" },
  { type: "damaged", glyph: "🛴", label: "Damaged" },
  { type: "inaccessible", glyph: "🔒", label: "Inaccessible" },
];

/** One line under the chips. Inaccessible is the one that needs explaining,
 *  and its copy discourages retrieval (§2.1). */
export const INACCESSIBLE_HINT =
  "Inaccessible = you can see it but can't reach it: fenced in, locked inside, private property. Don't go in.";

/** The modal's "Report a problem" block. `blockedReason` gates every chip
 *  (drawn, `aria-disabled`, tappable so it can say why). Empty string when the
 *  vehicle has no usable identifier — the API refuses those. */
export function reportProblemHtml(vid: string, blockedReason: string | null): string {
  if (vid.length < 16) return "";
  const blockedAttr = blockedReason
    ? ` data-blocked="${escapeHtml(blockedReason)}" aria-disabled="true"`
    : "";
  const gateNote = blockedReason
    ? `<p class="device-popup__report-gate">⚠️ ${escapeHtml(blockedReason)}</p>`
    : "";
  const chips = REPORT_CHIPS.map(
    (c) =>
      `<button type="button" class="device-popup__report-chip${blockedReason ? " is-blocked" : ""}" data-action="report-device" data-type="${c.type}"${blockedAttr}>${c.glyph} ${escapeHtml(c.label)}</button>`,
  ).join("\n");
  return `<div class="device-popup__report-device" data-vid="${escapeHtml(vid)}">
    <span class="device-popup__report-device-label">Report a problem</span>
    ${gateNote}
    <div class="device-popup__report-chips">${chips}</div>
    <p class="device-popup__report-hint">${escapeHtml(INACCESSIBLE_HINT)}</p>
    <div class="device-popup__report-step" hidden></div>
    <p class="device-popup__report-device-status" role="status" aria-live="polite"></p>
  </div>`;
}

/** What the rider has picked so far. */
export interface ReportDraft {
  type: (typeof REPORT_CHIPS)[number]["type"];
  /** A real reason, a decoy, or null ("Something else" / not asked). */
  reason: string | null;
}

/** The request for a draft and a "when" preset. Pure — the tests pin it. */
export function reportPayload(
  vid: string,
  draft: ReportDraft,
  preset: ObservedPreset,
  coords: [number, number],
  now: number = Date.now(),
): Parameters<typeof submitDeviceReport>[0] {
  const body: Parameters<typeof submitDeviceReport>[0] = {
    vehicle_identifier: vid,
    report_type: draft.type,
    lat: coords[1],
    lng: coords[0],
  };
  if (draft.type === "not_rideable" && draft.reason) body.reason = draft.reason;
  const observed = observedAtFor(preset, now);
  if (observed) body.observed_at = observed;
  return body;
}

/** The confirmation, naming what the SERVER filed. */
export function reportConfirmation(
  draft: ReportDraft,
  res: DeviceReportResult,
): string {
  if (res.deduped) return "✓ Already reported recently — thanks.";
  const filedAs = res.reportType ?? draft.type;
  const remapped = Boolean(res.remappedFromReason) || filedAs !== draft.type;
  const label =
    remapped && filedAs in REPORT_TYPE_LABEL
      ? REPORT_TYPE_LABEL[filedAs as NegativeReportType]
      : reportTypeLabel(filedAs, draft.reason);
  return remapped
    ? `✓ Filed as "${label}". Thanks!`
    : `✓ Reported: ${label}. Thanks!`;
}

export function reportErrorMessage(err: unknown): string {
  if (err instanceof ReportHttpError) {
    if (err.status === 422) {
      return "That date is too far back to report — pick a more recent one.";
    }
    if (err.status === 429) {
      return "That's a lot of reports — try again in a little while.";
    }
  }
  return "Couldn't send — please try again.";
}

export interface WireReportChipsOptions {
  vid: string;
  coords: [number, number];
  /** Injected for tests. */
  submit?: typeof submitDeviceReport;
  now?: () => number;
}

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

/** Wire the chips `reportProblemHtml` rendered inside `root`. */
export function wireReportChips(
  root: HTMLElement | null,
  opts: WireReportChipsOptions,
): void {
  const chips = root?.querySelectorAll<HTMLButtonElement>(
    '[data-action="report-device"]',
  );
  if (!root || !chips?.length) return;
  const status = root.querySelector<HTMLElement>(
    ".device-popup__report-device-status",
  );
  const step = root.querySelector<HTMLElement>(".device-popup__report-step");
  let draft: ReportDraft | null = null;
  let sending = false;
  let sent = false;
  /** False until a Not-rideable report has had its "Why not?" answered. */
  let reasonAsked = false;

  const setStatus = (text: string, state?: "ok" | "error"): void => {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("device-popup__report-device-status--ok", state === "ok");
    status.classList.toggle("device-popup__report-device-status--error", state === "error");
  };

  const pickRow = (
    question: string,
    options: { key: string; label: string; attr: string }[],
    onPick: (key: string) => void,
  ): HTMLElement => {
    const wrap = el("div", "device-popup__report-q");
    wrap.append(el("p", "device-popup__report-q-label", question));
    const row = el("div", "device-popup__report-chips");
    for (const o of options) {
      const b = el("button", "device-popup__report-chip device-popup__report-chip--sub", o.label);
      b.type = "button";
      b.setAttribute(o.attr, o.key);
      b.addEventListener("click", () => onPick(o.key));
      row.append(b);
    }
    wrap.append(row);
    return wrap;
  };

  const renderStep = (): void => {
    if (!step) return;
    step.replaceChildren();
    if (!draft || sent) {
      step.hidden = true;
      return;
    }
    step.hidden = false;
    const needsReason = draft.type === "not_rideable" && draft.reason === null && !reasonAsked;
    if (needsReason) {
      step.append(
        pickRow(
          "Why not?",
          [
            ...NOT_RIDEABLE_REASONS.map((r) => ({ key: r.reason, label: r.label, attr: "data-reason" })),
            ...NOT_RIDEABLE_DECOYS.map((d) => ({ key: d.reason, label: d.label, attr: "data-reason" })),
            { key: "", label: "Something else", attr: "data-reason" },
          ],
          (key) => {
            if (!draft) return;
            draft.reason = key || null;
            reasonAsked = true;
            renderStep();
          },
        ),
      );
      return;
    }
    step.append(
      pickRow(
        "When did you notice?",
        OBSERVED_PRESETS.map((p) => ({ key: p.preset, label: p.label, attr: "data-when" })),
        (key) => void send(key as ObservedPreset),
      ),
    );
  };
  const send = async (preset: ObservedPreset): Promise<void> => {
    if (!draft || sending || sent) return;
    sending = true;
    const current = { ...draft };
    for (const b of root.querySelectorAll<HTMLButtonElement>(
      ".device-popup__report-chip",
    )) {
      b.disabled = true;
    }
    setStatus("Sending…");
    try {
      const res = await (opts.submit ?? submitDeviceReport)(
        reportPayload(opts.vid, current, preset, opts.coords, (opts.now ?? Date.now)()),
      );
      sent = true;
      renderStep();
      setStatus(reportConfirmation(current, res), "ok");
    } catch (err) {
      for (const b of root.querySelectorAll<HTMLButtonElement>(
        ".device-popup__report-chip",
      )) {
        b.disabled = false;
      }
      setStatus(reportErrorMessage(err), "error");
    } finally {
      sending = false;
    }
  };

  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      // Blocked chips stay TAPPABLE on purpose — `aria-disabled`, never
      // `disabled` — because a button that cannot be pressed can never
      // deliver its own reason, and on a phone there is no tooltip.
      const blocked = chip.dataset.blocked;
      if (blocked) {
        setStatus(blocked, "error");
        return;
      }
      if (sending || sent) return;
      const type = chip.dataset.type as ReportDraft["type"];
      draft = { type, reason: null };
      reasonAsked = type !== "not_rideable";
      chips.forEach((c) => c.classList.toggle("is-on", c === chip));
      setStatus("");
      renderStep();
    });
  });
}
