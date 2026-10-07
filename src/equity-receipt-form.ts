// "Didn't get the discount?" — the receipt form behind the Equity Area
// explainer. Phase 1 (capture) of scooter-fyi-api's
// docs/PLAN_EQUITY_RECEIPTS.md: collect what a Veo receipt actually carries,
// plus proof of the rider's plan, and hand it to the API. Matching it to a
// ride we saw in the feed happens server-side, later; this module never
// promises a result.
//
// WHAT A RECEIPT CARRIES, and so what this asks for. A Veo receipt shows the
// scooter code (the plate), the trip minutes, the costs and a CHARGE DATE —
// no time of day and no location. So the plate, minutes, a cost and the date
// are required; the start time and the two map pins are optional tie-breakers
// for the day a rider took two rides of the same length.
//
// THE PLAN SCREENSHOT IS REQUIRED, not a nice-to-have. Veo's likely answer to
// an equity claim is "your plan doesn't get that rate"; the contract
// (Exhibit A §5.2) applies the Equity Area rate whatever the plan. Proof of
// the plan is what lets the claim stand, so the form will not send without it.
//
// VALIDATION MIRRORS THE SERVER'S GATE (plate 7–10 digits, minutes 1–600, at
// least one cost) so a rider hears about a typo before uploading two images
// over a phone connection. The server still decides; these are the same
// rules, said earlier.
//
// House rules, as in device-features.ts: `document.createElement` only, a
// `cleanupFns[]` teardown, a real focus trap, and nothing pre-filled that the
// rider did not give us — the one exception is the rate plan, which comes
// from their own profile and says so.

import {
  ApiError,
  fetchProfile,
  submitDiscountReport,
  type ApiRatePlan,
  type DeclaredRatePlan,
  type DiscountReportIn,
  type DiscountReportResult,
} from "./api.ts";
import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import { trapFocusWithin } from "./modal-focus-trap.ts";
import { isQrScannerOpen, openQrScanner } from "./qr-scan.ts";
import { plateFromQr } from "./qr-utility.ts";
import { savedRatePlan, toApiRatePlan } from "./ride-cost.ts";
import type { PickedPoint } from "./map-pick.ts";

/** Per image, matching the API's 413. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 600;
/** The API refuses charge dates before this (scooter-fyi-api's gate). */
export const EARLIEST_CHARGE_DATE = "2024-01-01";

/** The copy the plan pins down, verbatim. */
export const MSG_RECEIVED = "Received. We'll check it against what we saw in the feed.";
export const MSG_NOT_RATE_CHECKABLE =
  "Thanks for taking part. We can't check a rate from this, so we haven't kept it.";
export const MSG_RATE_LIMITED = "You've sent a lot today — try again tomorrow.";
export const MSG_TOO_LARGE = "One of the images is too large. Each must be 10 MB or less.";
export const MSG_TOO_LARGE_ONE = "That image is over 10 MB.";
export const MSG_TOTAL_BELOW_SUBTOTAL =
  "The cost with tax can't be less than the cost before tax.";
export const MSG_PLAN_REQUIRED =
  "Add a screenshot of the screen in the Veo app that shows your plan or pass.";

// ---------------------------------------------------------------------------
// Parsing — pure, so every rule is testable without a DOM
// ---------------------------------------------------------------------------

export type Parsed<T> =
  | { kind: "blank" }
  | { kind: "ok"; value: T }
  | { kind: "invalid" };

/** "$4.50" → 450 cents, by STRING arithmetic. `Math.round(4.5 * 100)`
 *  happens to work, but `0.29 * 100` is 28.999999999999996 and a receipt
 *  check that is off by a cent is a receipt check that is wrong. So the
 *  dollars and the cents are read as two integers and never meet a float.
 *  Accepts an optional "$", up to two decimals ("4.5" is 450), and nothing
 *  negative. */
/** The API's ceiling for a single ride's cost ($1,000). Above it the server
 *  names the field as invalid, and for `total_cents` that would surface as
 *  "less than the cost before tax", which is the wrong message. */
export const MAX_COST_CENTS = 100_000;

export function parseCents(raw: string): Parsed<number> {
  if (raw.trim() === "") return { kind: "blank" };
  const s = raw.trim().replace(/^\$\s*/, "");
  const m = /^(\d{0,4})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return { kind: "invalid" };
  const dollars = m[1] === "" ? 0 : Number(m[1]);
  const cents = Number(((m[2] ?? "") + "00").slice(0, 2));
  return { kind: "ok", value: dollars * 100 + cents };
}

/** The code as the API wants it: spaces gone, and the "#" a receipt prints
 *  in front of it ("Ride #1018354") gone too, because a rider copying the
 *  line exactly is doing nothing wrong. */
export function normalisePlate(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/^#/, "");
}

export function isValidPlate(plate: string): boolean {
  return /^\d{7,10}$/.test(plate);
}

export function parseMinutes(raw: string): Parsed<number> {
  const s = raw.trim();
  if (s === "") return { kind: "blank" };
  if (!/^\d+$/.test(s)) return { kind: "invalid" };
  const n = Number(s);
  return n >= MIN_MINUTES && n <= MAX_MINUTES
    ? { kind: "ok", value: n }
    : { kind: "invalid" };
}

/** Denver's UTC offset, in minutes, at a given instant (-360 in summer). */
function denverOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((wallAsUtc - utcMs) / 60_000);
}

/** A Denver wall-clock date and time as ISO 8601 WITH ITS OFFSET.
 *
 *  Denver, not the phone's zone: the ride happened here, and a rider checking
 *  a receipt from somewhere else would otherwise shift it by hours. The
 *  offset is looked up twice so a time near a DST change lands on the right
 *  side of it. */
export function denverIso(date: string, time: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let off = denverOffsetMinutes(wall);
  off = denverOffsetMinutes(wall - off * 60_000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${date}T${time.slice(0, 5)}:00${sign}${hh}:${mm}`;
}

/** The latest charge date that is not "in the future": the later of today in
 *  Denver and today on the phone, so a rider whose phone is a zone ahead is
 *  never told yesterday's receipt hasn't happened yet. */
export function latestChargeDate(now: Date): string {
  const denver = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(now);
  const local = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return denver > local ? denver : local;
}

/** The profile's plan, refined by the local VeoPlus choice when the bases
 *  agree — the same rule as ride-cost.ts's `applyServerRatePlan`, minus its
 *  write to localStorage (opening a form should not change a setting). */
export function prefillRatePlan(
  server: ApiRatePlan | null,
  local: RatePlanKey | null,
): DeclaredRatePlan {
  if (!server) return local ?? "unknown";
  if (local && toApiRatePlan(local) === server) return local;
  return server;
}

export type FieldKey =
  | "plate"
  | "minutes"
  | "cost"
  | "chargeDate"
  | "startTime"
  | "receipt"
  | "plan";

/** Everything the rider entered, as the form holds it. */
export interface ReceiptFormValues {
  plate: string;
  minutes: string;
  subtotal: string;
  total: string;
  chargeDate: string;
  startTime: string;
  ratePlan: DeclaredRatePlan;
  pinStart: PickedPoint | null;
  pinEnd: PickedPoint | null;
  receipt: File | null;
  plan: File | null;
}

export type ValidationResult =
  | { ok: true; input: DiscountReportIn }
  | { ok: false; errors: Partial<Record<FieldKey, string>> };

function imageError(file: File | null, missing: string): string | undefined {
  if (!file) return missing;
  if (file.type && !file.type.startsWith("image/")) return "That file isn't an image.";
  if (file.size > MAX_IMAGE_BYTES) return MSG_TOO_LARGE_ONE;
  return undefined;
}

/** The whole form's rules in one place, in field order. */
export function validateReceipt(
  v: ReceiptFormValues,
  now: Date,
): ValidationResult {
  const errors: Partial<Record<FieldKey, string>> = {};

  const plate = normalisePlate(v.plate);
  if (plate === "") errors.plate = "Enter the scooter code from the receipt.";
  else if (!isValidPlate(plate))
    errors.plate = "The scooter code is 7 to 10 digits, like 1018354.";

  const minutes = parseMinutes(v.minutes);
  if (minutes.kind === "blank") errors.minutes = "Enter the trip minutes.";
  else if (minutes.kind === "invalid")
    errors.minutes = `Trip minutes are a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}.`;

  const subtotal = parseCents(v.subtotal);
  const total = parseCents(v.total);
  if (subtotal.kind === "invalid" || total.kind === "invalid")
    errors.cost = "Enter costs in dollars and cents, like 4.50.";
  else if (subtotal.kind === "blank" && total.kind === "blank")
    errors.cost = "Enter at least one of the two costs.";
  else if ((subtotal.kind === "ok" && subtotal.value > MAX_COST_CENTS) ||
           (total.kind === "ok" && total.value > MAX_COST_CENTS))
    errors.cost = "That's more than any single ride costs. Check the decimal point.";
  else if (subtotal.kind === "ok" && total.kind === "ok" && total.value < subtotal.value)
    errors.cost = MSG_TOTAL_BELOW_SUBTOTAL;

  const max = latestChargeDate(now);
  if (v.chargeDate === "") errors.chargeDate = "Enter the charge date from the receipt.";
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(v.chargeDate) || Number.isNaN(Date.parse(v.chargeDate)))
    errors.chargeDate = "Enter the charge date as a date.";
  else if (v.chargeDate > max) errors.chargeDate = "The charge date can't be in the future.";
  else if (v.chargeDate < EARLIEST_CHARGE_DATE)
    errors.chargeDate = "That's earlier than we can check. Receipts from 2024 on only.";

  if (v.startTime !== "" && !/^\d{2}:\d{2}/.test(v.startTime))
    errors.startTime = "Enter the start time as a time, or leave it blank.";

  const receiptErr = imageError(v.receipt, "Add a screenshot of the receipt.");
  if (receiptErr) errors.receipt = receiptErr;
  const planErr = imageError(v.plan, MSG_PLAN_REQUIRED);
  if (planErr) errors.plan = planErr;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const input: DiscountReportIn = {
    vehicle_plate: plate,
    trip_minutes: (minutes as { value: number }).value,
    charge_date: v.chargeDate,
    declared_rate_plan: v.ratePlan,
    receipt: v.receipt as File,
    plan_evidence: v.plan as File,
  };
  if (subtotal.kind === "ok") input.subtotal_cents = subtotal.value;
  if (total.kind === "ok") input.total_cents = total.value;
  if (v.startTime !== "") input.approx_started_at = denverIso(v.chargeDate, v.startTime);
  if (v.pinStart) input.pin_start = v.pinStart;
  if (v.pinEnd) input.pin_end = v.pinEnd;
  return { ok: true, input };
}

/** What happened to a failed send, for the form to say. */
export type SubmitOutcome =
  | { kind: "signed_out" }
  | { kind: "not_rate_checkable" }
  | { kind: "rate_limited" }
  /** The server named the fields at fault: shown inline, under each one. */
  | { kind: "fields"; errors: Partial<Record<FieldKey, string>>; summary?: string }
  | { kind: "failed"; message: string };

/** What the API's `invalid_field` names mean in this form. The pins and the
 *  plan have no error line of their own (both are optional or prefilled), so
 *  they go in the summary instead. */
const FIELD_ERRORS: Record<string, { key: FieldKey; msg: string } | { summary: string }> = {
  vehicle_plate: { key: "plate", msg: "The scooter code is 7 to 10 digits, like 1018354." },
  trip_minutes: { key: "minutes", msg: `Trip minutes are a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}.` },
  subtotal_cents: { key: "cost", msg: "Check the costs: dollars and cents, like 4.50." },
  total_cents: { key: "cost", msg: MSG_TOTAL_BELOW_SUBTOTAL },
  charge_date: { key: "chargeDate", msg: "Check the charge date: not in the future, and from 2024 on." },
  approx_started_at: { key: "startTime", msg: "Check the start time, or leave it blank." },
  declared_rate_plan: { summary: "Pick your rate plan again from the list." },
  pin_start: { summary: "The start pin didn't come through. Pick it on the map again." },
  pin_end: { summary: "The end pin didn't come through. Pick it on the map again." },
};

function detailOf(err: ApiError): Record<string, unknown> {
  return typeof err.detail === "object" && err.detail !== null
    ? (err.detail as Record<string, unknown>)
    : {};
}

export function describeSubmitError(err: unknown): SubmitOutcome {
  if (err instanceof ApiError) {
    if (err.code === "NO_AUTH" || err.code === "TOKEN_REJECTED" || err.status === 401)
      return { kind: "signed_out" };
    if (err.status === 422 && err.errorKey === "not_rate_checkable")
      return { kind: "not_rate_checkable" };
    if (err.status === 422 && err.errorKey === "plan_evidence_required")
      return { kind: "fields", errors: { plan: MSG_PLAN_REQUIRED } };
    if (err.status === 422 && err.errorKey === "receipt_required")
      return { kind: "fields", errors: { receipt: "Add a screenshot of the receipt." } };
    if (err.status === 422 && err.errorKey === "invalid_field") {
      const names = detailOf(err).fields;
      const errors: Partial<Record<FieldKey, string>> = {};
      const notes: string[] = [];
      for (const name of Array.isArray(names) ? names : []) {
        const m = FIELD_ERRORS[String(name)];
        if (!m) continue;
        if ("summary" in m) notes.push(m.summary);
        else errors[m.key] ??= m.msg;
      }
      if (Object.keys(errors).length || notes.length)
        return { kind: "fields", errors, summary: notes.join(" ") || undefined };
    }
    if (err.status === 429) return { kind: "rate_limited" };
    if (err.status === 400 && err.errorKey === "unreadable_image") {
      // e.g. an Android HEIC: retrying won't help, a different file will.
      const msg = "We couldn't read this image. Try a PNG or JPEG screenshot.";
      const field = detailOf(err).field;
      if (field === "plan_evidence") return { kind: "fields", errors: { plan: msg } };
      return { kind: "fields", errors: { receipt: msg } };
    }
    if (err.errorKey === "storage_unavailable")
      return { kind: "failed", message: "We can't take images right now. Your form is still here; try again later." };
    if (err.status === 413) {
      const field = detailOf(err).field;
      if (field === "receipt") return { kind: "fields", errors: { receipt: MSG_TOO_LARGE_ONE } };
      if (field === "plan_evidence") return { kind: "fields", errors: { plan: MSG_TOO_LARGE_ONE } };
      return { kind: "failed", message: MSG_TOO_LARGE };
    }
    if (err.status === 422)
      return { kind: "failed", message: "Something in the form didn't check out. Look it over and try again." };
    return { kind: "failed", message: "That didn't send — the server had a problem. Try again in a minute." };
  }
  return { kind: "failed", message: "That didn't send. Check your connection and try again." };
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export interface ReceiptFormDeps {
  isSignedIn(): boolean;
  /** The app's own sign-in door. Called after this form has closed. */
  openSignIn(): void;
  /** One-shot map pick (main.ts's `createMapPick`). Omitted → no pin
   *  buttons, rather than buttons that do nothing. */
  pickOnMap?(hint: string): Promise<PickedPoint | null>;
  /** Camera → plate. Defaults to qr-scan + `plateFromQr`. Resolves null for
   *  a cancel AND for a sticker that held no plate; `scanned` tells them
   *  apart for the message. */
  scanPlate?(): Promise<{ plate: string | null; scanned: boolean }>;
  /** Injected for tests; default reads the profile, then the local choice. */
  loadRatePlan?(): Promise<DeclaredRatePlan>;
  /** Injected for tests; defaults to the real POST. */
  submit?(input: DiscountReportIn): Promise<DiscountReportResult>;
  now?(): Date;
  /** Where focus goes when the form closes. */
  returnFocusTo?: HTMLElement | null;
  onClose?(): void;
}

const ROOT_CLASS = "equity-receipt";

/** Same one-at-a-time rule as device-features.ts, for the same reason: a
 *  bare `.remove()` would orphan the Escape listener and the focus trap. */
let activeClose: (() => void) | null = null;

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

async function defaultLoadRatePlan(): Promise<DeclaredRatePlan> {
  const local = savedRatePlan();
  try {
    const profile = await fetchProfile();
    return prefillRatePlan(profile.rate_plan, local);
  } catch {
    return local ?? "unknown";
  }
}

function defaultScanPlate(): Promise<{ plate: string | null; scanned: boolean }> {
  return new Promise((resolve) => {
    let handed = false;
    openQrScanner({
      prompt: "Scan the QR code on the scooter you rode",
      onScan: (raw) => {
        handed = true;
        resolve({ plate: plateFromQr(raw), scanned: true });
      },
      // qr-scan closes itself and THEN delivers the payload (see main.ts's
      // scanForStartedVehicle), so cancel is decided a microtask late.
      onClose: () => {
        queueMicrotask(() => {
          if (!handed) resolve({ plate: null, scanned: false });
        });
      },
    });
  });
}

/** Open the receipt form. Returns a close function. */
export function openEquityReceiptForm(deps: ReceiptFormDeps): () => void {
  activeClose?.();
  document.querySelector(`.${ROOT_CLASS}`)?.remove();

  const now = deps.now ?? (() => new Date());
  const submit = deps.submit ?? ((input: DiscountReportIn) => submitDiscountReport(input));
  const cleanupFns: (() => void)[] = [];
  let closed = false;
  let sending = false;
  /** Map pick or camera up: the form steps aside and lets that layer own
   *  focus and Escape. */
  let away = false;
  let pinStart: PickedPoint | null = null;
  let pinEnd: PickedPoint | null = null;

  const backdrop = el("div", ROOT_CLASS);
  const card = el("div", `${ROOT_CLASS}__card`);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "equity-receipt-title");

  const head = el("div", `${ROOT_CLASS}__head`);
  const title = el("h3", undefined, "Didn't get the discount?");
  title.id = "equity-receipt-title";
  const closeBtn = el("button", `${ROOT_CLASS}__close`, "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(title, closeBtn);

  const body = el("div", `${ROOT_CLASS}__body`);
  card.append(head, body);
  backdrop.append(card);

  function close(): void {
    if (closed) return;
    closed = true;
    if (activeClose === close) activeClose = null;
    for (const fn of cleanupFns.splice(0)) fn();
    backdrop.remove();
    deps.returnFocusTo?.focus();
    deps.onClose?.();
  }

  // ---- signed out ---------------------------------------------------------

  function showSignedOut(): void {
    const note = el(
      "p",
      `${ROOT_CLASS}__lede`,
      "Receipts need an account, so each one can be traced to a real rider.",
    );
    const btn = el("button", "login-btn", "Sign in to send a receipt");
    btn.type = "button";
    btn.dataset.role = "sign-in";
    btn.addEventListener("click", () => {
      close();
      deps.openSignIn();
    });
    body.replaceChildren(note, btn);
    btn.focus();
  }

  // ---- the form -----------------------------------------------------------

  const form = el("form", `${ROOT_CLASS}__form`);
  form.noValidate = true; // our messages, announced our way

  const lede = el(
    "p",
    `${ROOT_CLASS}__lede`,
    "Send the receipt from a ride that started or ended in an Equity Area and " +
      "wasn't charged $1 + 13¢ a minute. Copy the numbers as printed; we " +
      "check them against the screenshot and what we saw in the feed.",
  );

  // Announced on a failed send: the count and what to fix.
  const alertBox = el("div", `${ROOT_CLASS}__alert`);
  alertBox.setAttribute("role", "alert");
  alertBox.hidden = true;

  const errorNodes = new Map<FieldKey, { node: HTMLElement; control: HTMLElement }>();

  /** label + control + optional hint + error line, wired for assistive tech. */
  function field(
    key: FieldKey | null,
    id: string,
    labelText: string,
    control: HTMLElement,
    hint?: string,
    /** What goes in the layout when the control sits in a row with others
     *  (the plate box and its Scan button); the control itself keeps the
     *  id, the label and the descriptions. */
    layout: HTMLElement = control,
  ): HTMLElement {
    const wrap = el("div", `${ROOT_CLASS}__field`);
    const label = el("label", `${ROOT_CLASS}__label`, labelText);
    label.htmlFor = id;
    control.id = id;
    const describedBy: string[] = [];
    wrap.append(label);
    if (hint) {
      const h = el("p", `${ROOT_CLASS}__hint`, hint);
      h.id = `${id}-hint`;
      describedBy.push(h.id);
      wrap.append(h);
    }
    wrap.append(layout);
    if (key) {
      const err = el("p", `${ROOT_CLASS}__error`);
      err.id = `${id}-error`;
      err.hidden = true;
      describedBy.push(err.id);
      wrap.append(err);
      errorNodes.set(key, { node: err, control });
    }
    if (describedBy.length) control.setAttribute("aria-describedby", describedBy.join(" "));
    return wrap;
  }

  function textInput(inputMode: string, autocomplete = "off"): HTMLInputElement {
    const i = el("input", `${ROOT_CLASS}__input`);
    i.type = "text";
    i.inputMode = inputMode;
    i.setAttribute("autocomplete", autocomplete);
    return i;
  }

  // Scooter code, with the camera beside it.
  const plateInput = textInput("numeric");
  plateInput.setAttribute("aria-required", "true");
  plateInput.setAttribute("spellcheck", "false");
  // The format, shown in the box itself: the 7-digit number after "Ride #".
  plateInput.placeholder = "e.g. 1018354";
  const plateRow = el("div", `${ROOT_CLASS}__row`);
  plateRow.append(plateInput);
  const scanBtn = el("button", `login-btn login-btn--secondary ${ROOT_CLASS}__scan`, "Scan QR");
  scanBtn.type = "button";
  plateRow.append(scanBtn);
  const plateField = field(
    "plate",
    "equity-receipt-plate",
    "Scooter code",
    plateInput,
    "The number after \"Ride #\" on the receipt. If you're still at the scooter, you can scan its QR code instead.",
    plateRow,
  );

  const minutesInput = textInput("numeric");
  minutesInput.setAttribute("aria-required", "true");
  minutesInput.placeholder = "e.g. 16";
  const minutesField = field("minutes", "equity-receipt-minutes", "Trip minutes", minutesInput);

  // Two costs, one rule (at least one), so one error line under both.
  const subtotalInput = textInput("decimal");
  const totalInput = textInput("decimal");
  subtotalInput.placeholder = "e.g. 5.00";
  totalInput.placeholder = "e.g. 5.46";
  const costs = el("fieldset", `${ROOT_CLASS}__costs`);
  const legend = el("legend", `${ROOT_CLASS}__label`, "Cost");
  const costHint = el("p", `${ROOT_CLASS}__hint`, "Fill in at least one, in dollars, like 4.50.");
  costHint.id = "equity-receipt-cost-hint";
  const costErr = el("p", `${ROOT_CLASS}__error`);
  costErr.id = "equity-receipt-cost-error";
  costErr.hidden = true;
  const costRow = el("div", `${ROOT_CLASS}__row`);
  for (const [input, id, text] of [
    [subtotalInput, "equity-receipt-subtotal", "Before tax ($)"],
    [totalInput, "equity-receipt-total", "With tax ($)"],
  ] as const) {
    const cell = el("div", `${ROOT_CLASS}__cell`);
    const l = el("label", `${ROOT_CLASS}__sublabel`, text);
    l.htmlFor = id;
    input.id = id;
    input.setAttribute("aria-describedby", `${costHint.id} ${costErr.id}`);
    cell.append(l, input);
    costRow.append(cell);
  }
  costs.append(legend, costHint, costRow, costErr);
  errorNodes.set("cost", { node: costErr, control: subtotalInput });

  const dateInput = el("input", `${ROOT_CLASS}__input`);
  dateInput.type = "date";
  dateInput.max = latestChargeDate(now());
  dateInput.min = EARLIEST_CHARGE_DATE;
  dateInput.setAttribute("aria-required", "true");
  const dateField = field(
    "chargeDate",
    "equity-receipt-date",
    "Charge date",
    dateInput,
    "As printed on the receipt.",
  );

  const timeInput = el("input", `${ROOT_CLASS}__input`);
  timeInput.type = "time";
  const timeField = field(
    "startTime",
    "equity-receipt-time",
    "About what time did you start? (optional)",
    timeInput,
    "Only needed if you took more than one ride of that length that day.",
  );

  // Pins: optional, and only offered when there is a map to pick on.
  const pinsWrap = el("div", `${ROOT_CLASS}__field`);
  const pick = deps.pickOnMap;
  if (pick) {
    const label = el("p", `${ROOT_CLASS}__label`, "Where did the ride start and end? (optional)");
    const hint = el(
      "p",
      `${ROOT_CLASS}__hint`,
      "Roughly is fine. The receipt has no location, so this helps tell your ride apart.",
    );
    const row = el("div", `${ROOT_CLASS}__row`);
    const pinButton = (which: "start" | "end"): HTMLButtonElement => {
      const b = el("button", `login-btn login-btn--secondary ${ROOT_CLASS}__pin`);
      b.type = "button";
      b.dataset.pin = which;
      const paint = (): void => {
        const set = (which === "start" ? pinStart : pinEnd) !== null;
        b.textContent = which === "start"
          ? set ? "Start set ✓ (change)" : "Pick start on map"
          : set ? "End set ✓ (change)" : "Pick end on map";
      };
      paint();
      b.addEventListener("click", () => {
        stepAside(true);
        void pick(
          which === "start"
            ? "Tap the map where the ride started"
            : "Tap the map where the ride ended",
        ).then((p) => {
          stepAside(false);
          if (closed) return;
          if (p) {
            if (which === "start") pinStart = p;
            else pinEnd = p;
          }
          paint();
          b.focus();
        });
      });
      return b;
    };
    row.append(pinButton("start"), pinButton("end"));
    pinsWrap.append(label, hint, row);
  }

  const planSelect = el("select", `${ROOT_CLASS}__input`);
  for (const p of RATE_PLANS) {
    const o = el("option", undefined, p.label);
    o.value = p.key;
    planSelect.append(o);
  }
  const unsure = el("option", undefined, "Not sure");
  unsure.value = "unknown";
  planSelect.append(unsure);
  planSelect.value = "unknown";
  const planField = field(
    null,
    "equity-receipt-plan",
    "Your rate plan",
    planSelect,
  );

  function fileInput(): HTMLInputElement {
    const i = el("input", `${ROOT_CLASS}__file`);
    i.type = "file";
    i.accept = "image/*";
    i.setAttribute("aria-required", "true");
    return i;
  }
  const receiptInput = fileInput();
  const receiptField = field(
    "receipt",
    "equity-receipt-receipt",
    "Receipt screenshot",
    receiptInput,
    "The receipt screen in the Veo app. Up to 10 MB.",
  );
  const planInput = fileInput();
  const planEvidenceField = field(
    "plan",
    "equity-receipt-plan-evidence",
    "Plan screenshot",
    planInput,
    "The screen in the Veo app showing your active plan or pass (or that you have none). " +
      "The contract gives the Equity Area rate whatever plan you're on, so proof of your plan is what makes the claim stand.",
  );

  const status = el("p", `${ROOT_CLASS}__status`);
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const sendBtn = el("button", "login-btn", "Send receipt");
  sendBtn.type = "submit";
  const actions = el("div", `${ROOT_CLASS}__actions`);
  actions.append(sendBtn);

  form.append(
    lede,
    alertBox,
    plateField,
    minutesField,
    costs,
    dateField,
    timeField,
    ...(pick ? [pinsWrap] : []),
    planField,
    receiptField,
    planEvidenceField,
    status,
    actions,
  );

  function values(): ReceiptFormValues {
    return {
      plate: plateInput.value,
      minutes: minutesInput.value,
      subtotal: subtotalInput.value,
      total: totalInput.value,
      chargeDate: dateInput.value,
      startTime: timeInput.value,
      ratePlan: planSelect.value as DeclaredRatePlan,
      pinStart,
      pinEnd,
      receipt: receiptInput.files?.[0] ?? null,
      plan: planInput.files?.[0] ?? null,
    };
  }

  function showErrors(errors: Partial<Record<FieldKey, string>>, summary?: string): void {
    let first: HTMLElement | null = null;
    for (const [key, { node, control }] of errorNodes) {
      const msg = errors[key];
      node.textContent = msg ?? "";
      node.hidden = !msg;
      const controls = key === "cost" ? [subtotalInput, totalInput] : [control];
      for (const c of controls) {
        if (msg) c.setAttribute("aria-invalid", "true");
        else c.removeAttribute("aria-invalid");
      }
      if (msg && !first) first = control;
    }
    const n = Object.keys(errors).length;
    const count = n === 0 ? "" : n === 1 ? "One thing to fix before sending." : `${n} things to fix before sending.`;
    const text = [count, summary].filter(Boolean).join(" ");
    alertBox.textContent = text;
    alertBox.hidden = text === "";
    (first as HTMLElement | null)?.focus();
  }

  function showAlert(text: string): void {
    alertBox.textContent = text;
    alertBox.hidden = false;
    alertBox.scrollIntoView?.({ block: "nearest" });
  }

  function showDone(): void {
    const msg = el("p", `${ROOT_CLASS}__done`, MSG_RECEIVED);
    msg.setAttribute("role", "status");
    const done = el("button", "login-btn", "Close");
    done.type = "button";
    done.addEventListener("click", close);
    body.replaceChildren(msg, done);
    done.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (sending) return;
    const result = validateReceipt(values(), now());
    if (!result.ok) {
      showErrors(result.errors);
      return;
    }
    showErrors({});
    sending = true;
    sendBtn.disabled = true;
    status.textContent = "Sending…";
    submit(result.input)
      .then(() => {
        if (closed) return;
        showDone();
      })
      .catch((err: unknown) => {
        if (closed) return;
        status.textContent = "";
        const outcome = describeSubmitError(err);
        switch (outcome.kind) {
          case "signed_out":
            showSignedOut();
            return;
          case "fields":
            showErrors(outcome.errors, outcome.summary);
            return;
          case "not_rate_checkable":
            showAlert(MSG_NOT_RATE_CHECKABLE);
            return;
          case "rate_limited":
            showAlert(MSG_RATE_LIMITED);
            return;
          default:
            showAlert(outcome.message);
        }
      })
      .finally(() => {
        sending = false;
        sendBtn.disabled = false;
      });
  });

  scanBtn.addEventListener("click", () => {
    away = true;
    void (deps.scanPlate ?? defaultScanPlate)().then(({ plate, scanned }) => {
      away = false;
      if (closed) return;
      const err = errorNodes.get("plate")!.node;
      if (plate) {
        plateInput.value = normalisePlate(plate);
        err.hidden = true;
        plateInput.removeAttribute("aria-invalid");
      } else if (scanned) {
        err.textContent = "That QR code didn't hold a scooter code. Type the code from the receipt instead.";
        err.hidden = false;
      }
      plateInput.focus();
    });
  });

  /** Hide for a map pick: the card covers the map on a phone. */
  function stepAside(on: boolean): void {
    away = on;
    backdrop.hidden = on;
  }

  // ---- shell wiring -------------------------------------------------------

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  // Capture phase on window, so Escape here is ours and does not also reach
  // a document-level handler underneath. While the camera or a map pick is
  // up, that layer owns Escape instead.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || away || isQrScannerOpen()) return;
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);
  cleanupFns.push(() => window.removeEventListener("keydown", onKey, true));

  document.body.appendChild(backdrop);
  cleanupFns.push(trapFocusWithin(card, () => !closed && !away));
  activeClose = close;

  if (!deps.isSignedIn()) {
    showSignedOut();
  } else {
    body.replaceChildren(form);
    plateInput.focus();
    // Pre-select the rider's own plan; "Not sure" until it lands, and kept
    // if they have already chosen something by then.
    let touched = false;
    planSelect.addEventListener("change", () => (touched = true), { once: true });
    void (deps.loadRatePlan ?? defaultLoadRatePlan)()
      .then((plan) => {
        if (closed || touched) return;
        planSelect.value = plan;
      })
      .catch(() => {
        /* "Not sure" stays */
      });
  }

  return close;
}
