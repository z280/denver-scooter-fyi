// Crowdsourced device features — the "☑️ Confirm Features" flow.
//
// Veo's feed says nothing about what is bolted to a scooter, so a Cosmo with
// a cup holder and one without are indistinguishable on the map and there is
// no way to filter for either. A rider standing next to one can see the
// answer in a second. This module is how they tell us, and how they get paid
// for it.
//
// THE MODAL, question for question (owner's copy):
//   Does this <Cosmo> have…
//     a bell?                  Yes / No
//     a cup holder?            Yes / No
//     a phone holder?          Yes / No
//     a basket?                Yes / No
//     And they're all in good condition?   Yes / No
//   [if No] Which are present but not in good condition?  <the present ones>
//   To confirm, please enter the plate number under the QR code on the device
//
// The presence questions ask only whether the thing is BOLTED ON — "a bell?",
// not "a working bell?" — because the condition question right underneath is
// what asks whether it works. Asking about working-ness twice makes "No" to
// the bell mean two things at once (absent, or present but silent), and the
// broken-bell reading is the one that loses: the rider answers No, nothing
// is present to itemise, and the fault never reaches the API at all.
//
// BASKET IS ASKED OF EVERY DEVICE, not just the models that ship with one.
// It briefly wasn't — the question arrived Cosmo-only — and that was wrong
// on the fleet: the Rover carries a cargo basket as standard equipment
// (`devices.ts`'s model catalog says so), so a model gate would have made a
// bent Rover basket permanently unreportable. Asking everyone also keeps
// this list FIXED, which is what lets a "not asked" answer stay
// unrepresentable: every rider sees every question, so `null` can only ever
// mean "hasn't answered yet".
//
// NEITHER TOGGLE IS PRESSED BY DEFAULT. That is a real product rule, not a
// styling detail: a pre-pressed answer is an answer the rider did not give,
// and this whole feature is only worth anything if the data is what somebody
// actually looked at. So `null` is a first-class state here, Send stays
// disabled until all five questions are answered, and there is no "skip".
//
// THE PLATE is the anti-abuse story — you cannot read the plate under a
// scooter's QR code from your sofa. A WRONG plate is deliberately NOT an
// error: the API accepts it, stores it, and pays nothing. So this module
// never validates the plate locally, never compares it to a plate the client
// happens to have resolved from GBFS, and never blocks Send on it. Doing any
// of those would (a) turn a server rule into a client rule two deploys away
// from disagreeing with it, and (b) hand anyone with dev tools a free
// plate oracle. The rider is told plainly what the plate is for, up front,
// and finds out afterwards whether it earned anything.
//
// House rules, as everywhere else in this program: `document.createElement`
// only (never innerHTML), a `cleanupFns[]` teardown list, and a real focus
// trap (`modal-focus-trap.ts`).

import {
  fetchPointsSchedule,
  pointsScheduleEntry,
  type PointsScheduleResponse,
} from "./api.ts";
import { trapFocusWithin } from "./modal-focus-trap.ts";
import { ReportHttpError, submitDeviceFeatureReport } from "./reports.ts";

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/** `feature_status` on a device's map payload. Codes on the wire, labels in
 *  `FEATURE_STATUS_LABEL` — the API publishes the code and the owner's
 *  three labels are frontend copy, which is what lets the wording change
 *  without a migration. */
export type FeatureStatus =
  | "needs_features_confirmed"
  | "needs_review"
  | "up_to_date";

/** The owner's three labels, verbatim. */
export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = {
  needs_features_confirmed: "Needs features confirmed",
  needs_review: "Needs review",
  up_to_date: "Up to date",
};

/** One line of why the rider should care, per status. */
export const FEATURE_STATUS_HINT: Record<FeatureStatus, string> = {
  needs_features_confirmed: "Nobody has told us what's on this one yet.",
  needs_review: "Two riders disagreed about this one — a third opinion settles it.",
  up_to_date: "Confirmed. Tell us again if something has changed.",
};

/** The `user_points` action each status pays, so the modal's "+N pts" copy
 *  is read from `GET /points/schedule` rather than hardcoded. Same
 *  drift-proofing discipline the ride wizard's Screen 2 uses. */
export const FEATURE_STATUS_ACTION: Record<FeatureStatus, string> = {
  needs_features_confirmed: "device_features_first",
  needs_review: "device_features_review",
  up_to_date: "device_features_reconfirm",
};

/** Fallbacks for when `/points/schedule` hasn't answered (offline, or an API
 *  older than this feature). These MUST match src/points.py's constants; the
 *  schedule is the authority whenever it is reachable, and these exist only
 *  so the modal never renders "+undefined pts". */
export const FEATURE_POINTS_FALLBACK: Record<FeatureStatus, number> = {
  needs_features_confirmed: 12,
  needs_review: 14,
  up_to_date: 6,
};

/** Normalize whatever the payload carried into a known status. An unknown or
 *  missing value reads as "needs confirming", which is both the API's own
 *  default and the safe answer: it invites a report rather than suppressing
 *  one. */
export function asFeatureStatus(raw: unknown): FeatureStatus {
  const s = typeof raw === "string" ? raw : "";
  if (s === "needs_review" || s === "up_to_date") return s;
  return "needs_features_confirmed";
}

export function featurePointsFor(
  status: FeatureStatus,
  schedule: PointsScheduleResponse | null,
): number {
  const entry = pointsScheduleEntry(schedule, FEATURE_STATUS_ACTION[status]);
  return entry?.points ?? FEATURE_POINTS_FALLBACK[status];
}

// ---------------------------------------------------------------------------
// The features
// ---------------------------------------------------------------------------

/** Wire vocabulary — these strings go to the API verbatim in
 *  `poor_condition` and must match `FEATURE_KEYS` in
 *  `scooter-fyi-api/src/device_features.py`. */
export type FeatureKey = "bell" | "cup_holder" | "phone_holder" | "basket";

/** Every question, in the order the modal asks. One fixed list for every
 *  device in the fleet — see the header on why the basket is not gated on
 *  the model. */
export const FEATURE_QUESTIONS: readonly {
  key: FeatureKey;
  question: string;
  /** How the feature is named in the condition follow-up, where the phrasing
   *  is a list item rather than a question. */
  noun: string;
}[] = [
  { key: "bell", question: "a bell?", noun: "Bell" },
  { key: "cup_holder", question: "a cup holder?", noun: "Cup holder" },
  { key: "phone_holder", question: "a phone holder?", noun: "Phone holder" },
  { key: "basket", question: "a basket?", noun: "Basket" },
];

/** The modal's live state. `null` is "not answered" — the whole reason Send
 *  stays disabled — and is distinct from `false`. */
export interface FeatureAnswerState {
  bell: boolean | null;
  cup_holder: boolean | null;
  phone_holder: boolean | null;
  basket: boolean | null;
  allGood: boolean | null;
  /** Only meaningful when `allGood === false`. Always a subset of the
   *  features answered `true`; `prunePoorCondition` keeps it that way. */
  poor: FeatureKey[];
  plate: string;
}

export function emptyAnswers(): FeatureAnswerState {
  return {
    bell: null,
    cup_holder: null,
    phone_holder: null,
    basket: null,
    allGood: null,
    poor: [],
    plate: "",
  };
}

/** Which features the rider has confirmed PRESENT — the options the
 *  condition follow-up offers. */
export function presentFeatures(a: FeatureAnswerState): FeatureKey[] {
  return FEATURE_QUESTIONS.filter((q) => a[q.key] === true).map((q) => q.key);
}

/** Drop condition selections for features that are no longer marked present.
 *  Run after every presence toggle: a rider who ticks "the bell is broken"
 *  and then flips the bell to No would otherwise send a contradiction the
 *  API rejects with a 422 — and would see a validation error for a box they
 *  can no longer even see. */
export function prunePoorCondition(a: FeatureAnswerState): FeatureKey[] {
  const present = new Set(presentFeatures(a));
  return a.poor.filter((k) => present.has(k));
}

/** Is the survey complete enough to send?
 *
 *  All four presence questions answered, a plate typed, and — when the rider
 *  said things are NOT all in good condition — at least one feature named.
 *  That last rule mirrors the API's own 422
 *  (`all_good_condition: false` with an empty `poor_condition` is rejected,
 *  because the server stores only the list and an un-itemised complaint
 *  would round-trip as "all good" and ping-pong the vehicle into
 *  needs-review forever). Enforcing it here means
 *  the rider is stopped by a disabled button with a visible reason, not by a
 *  422 after they hit Send.
 *
 *  A rider who answered No to everything present has nothing to itemise, so
 *  the follow-up cannot be shown at all — `readyToSubmit` treats that as
 *  complete rather than unanswerable. */
export function readyToSubmit(a: FeatureAnswerState): boolean {
  // Driven off the question list rather than four named checks, so a fifth
  // feature is gated by adding it to FEATURE_QUESTIONS and nothing else.
  if (FEATURE_QUESTIONS.some((q) => a[q.key] === null)) return false;
  if (a.allGood === null) return false;
  if (a.allGood === false && presentFeatures(a).length > 0 && a.poor.length === 0) {
    return false;
  }
  return a.plate.trim().length > 0;
}

/** The request body. `all_good_condition` is derived from the pruned list
 *  rather than sent as the rider's raw tap, because the API requires the two
 *  to agree: a rider who said "not all good" on a scooter with nothing
 *  present has no itemisable fault, and the honest wire value there is
 *  `true`.
 *
 *  All four presence answers are always sent, `has_basket` included. Every
 *  rider is shown every question, so an unanswered one is unreachable
 *  through the UI (Send is disabled) and `false` is an honest default rather
 *  than a claim about something nobody was asked. */
export function toRequestBody(
  a: FeatureAnswerState,
): {
  has_bell: boolean;
  has_cup_holder: boolean;
  has_phone_holder: boolean;
  has_basket: boolean;
  all_good_condition: boolean;
  poor_condition: FeatureKey[];
} {
  const poor = prunePoorCondition(a);
  return {
    has_bell: a.bell === true,
    has_cup_holder: a.cup_holder === true,
    has_phone_holder: a.phone_holder === true,
    has_basket: a.basket === true,
    all_good_condition: poor.length === 0,
    poor_condition: poor,
  };
}

/** Why a submission failed, in the rider's language.
 *
 *  `submitDeviceFeatureReport` throws `ReportHttpError` carrying the status
 *  precisely so a caller can tell these apart, and collapsing every one of
 *  them into "check your connection" both lies to the rider whose connection
 *  is fine and hides a 422 — which is always OUR bug, since the modal's own
 *  Send gate is supposed to make an invalid body unreachable. Exported so the
 *  branches are testable without a live modal.
 *
 *  Anything without a status (a genuine network failure, a thrown TypeError)
 *  falls through to the connection message, which is the honest answer when
 *  we never heard back at all. */
export function describeSubmitError(err: unknown): string {
  const status = err instanceof ReportHttpError ? err.status : null;
  if (status === 401) {
    return "Your session expired — sign in again and your answers will earn points.";
  }
  if (status === 404) {
    return "We don't have a record of this scooter anymore — it may have left the fleet.";
  }
  if (status === 422) {
    // Unreachable through the UI: `readyToSubmit` enforces the same rules
    // the API validates. Saying so plainly beats a misleading "check your
    // connection" if it ever does happen.
    return "Something about that answer didn't add up on our side — please report this as a bug.";
  }
  if (status === 429) {
    return "That's a lot of scooters in one hour — take a short break and try again.";
  }
  if (status !== null && status >= 500) {
    return "Our server had a problem saving that — try again in a moment.";
  }
  return "Couldn't send that — check your connection and try again.";
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export interface ConfirmFeaturesOptions {
  deviceId: string;
  vehicleIdentifier: string;
  /** Friendly model name for the question stem — "Does this Cosmo have…".
   *  Falls back to "scooter" when the model is unrecognized. */
  modelName?: string | null;
  status: FeatureStatus;
  lat?: number;
  lng?: number;
  /** Injected for tests; defaults to the real POST. */
  submit?: typeof submitDeviceFeatureReport;
  /** Injected for tests; defaults to `fetchPointsSchedule`. */
  loadSchedule?: typeof fetchPointsSchedule;
  /** Fires after a successful submission, with what the server actually
   *  paid. Lets the caller refresh its own copy of the device. */
  onSubmitted?(result: { plateValid: boolean; pointsAwarded: number }): void;
  onClose?(): void;
}

const ROOT_CLASS = "device-features";

/** Teardown for the modal that is currently open, if any. Same rule, and the
 *  same reasoning, as `ride-preflight.ts`'s: removing the previous element
 *  detaches the DOM but runs no teardown, leaving this modal's document-level
 *  Escape handler AND `trapFocusWithin`'s document `focusin` handler live —
 *  and the orphaned trap's `isActive()` reads a `closed` flag that never
 *  flipped, so it keeps pulling focus onto a detached node forever. */
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

/** Open the Confirm Features modal. Returns a close function. At most one is
 *  open at a time. */
export function openConfirmFeatures(
  options: ConfirmFeaturesOptions,
): () => void {
  activeClose?.();
  document.querySelector(`.${ROOT_CLASS}`)?.remove();

  const answers = emptyAnswers();
  const cleanupFns: (() => void)[] = [];
  let closed = false;
  let sending = false;
  let schedule: PointsScheduleResponse | null = null;
  let statusLine: string | null = null;
  let done = false;

  const modelLabel = options.modelName?.trim() || "scooter";

  const backdrop = el("div", ROOT_CLASS);
  const card = el("div", `${ROOT_CLASS}__card`);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "device-features-title");

  const head = el("div", `${ROOT_CLASS}__head`);
  const title = el("h3", undefined, "☑️ Confirm Features");
  title.id = "device-features-title";
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
    options.onClose?.();
  }

  /** A Yes/No pair. Neither is pressed until the rider presses one — the
   *  product rule this modal exists to honour. */
  function yesNo(
    label: string,
    value: boolean | null,
    onPick: (v: boolean) => void,
    idPrefix: string,
  ): HTMLElement {
    const row = el("div", `${ROOT_CLASS}__row`);
    const q = el("span", `${ROOT_CLASS}__q`, label);
    const group = el("div", `${ROOT_CLASS}__yesno`);
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const [text, v] of [["Yes", true], ["No", false]] as const) {
      const b = el("button", `${ROOT_CLASS}__toggle`, text);
      b.type = "button";
      b.dataset.pick = `${idPrefix}-${text.toLowerCase()}`;
      const on = value === v;
      b.classList.toggle("is-on", on);
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.addEventListener("click", () => {
        onPick(v);
        render();
        body.querySelector<HTMLButtonElement>(`[data-pick="${b.dataset.pick}"]`)?.focus();
      });
      group.append(b);
    }
    row.append(q, group);
    return row;
  }

  function render(): void {
    body.replaceChildren();

    if (done) {
      renderDone();
      return;
    }

    // ---- status + what it pays
    const points = featurePointsFor(options.status, schedule);
    const badge = el("div", `${ROOT_CLASS}__status`);
    badge.dataset.status = options.status;
    badge.append(
      el("span", `${ROOT_CLASS}__status-label`, FEATURE_STATUS_LABEL[options.status]),
      el("span", `${ROOT_CLASS}__status-points`, `+${points} pts`),
    );
    body.append(badge);
    body.append(
      el("p", `${ROOT_CLASS}__hint`, FEATURE_STATUS_HINT[options.status]),
    );

    // ---- the four presence questions
    body.append(
      el("p", `${ROOT_CLASS}__stem`, `Does this ${modelLabel} have…`),
    );
    for (const q of FEATURE_QUESTIONS) {
      body.append(
        yesNo(q.question, answers[q.key], (v) => {
          answers[q.key] = v;
          answers.poor = prunePoorCondition(answers);
        }, q.key),
      );
    }

    // ---- condition
    body.append(
      yesNo(
        "And they're all in good condition?",
        answers.allGood,
        (v) => {
          answers.allGood = v;
          if (v) answers.poor = [];
        },
        "allgood",
      ),
    );

    // ---- the follow-up, only when the rider said No AND there is something
    // present to name. "No" on a scooter carrying none of the four is an
    // answer about nothing, so we don't ask a question with no options.
    const present = presentFeatures(answers);
    if (answers.allGood === false && present.length > 0) {
      const wrap = el("div", `${ROOT_CLASS}__poor`);
      wrap.append(
        el(
          "p",
          `${ROOT_CLASS}__q`,
          "Which are present but not in good condition?",
        ),
      );
      const opts = el("div", `${ROOT_CLASS}__poor-opts`);
      for (const key of present) {
        const noun = FEATURE_QUESTIONS.find((q) => q.key === key)!.noun;
        const b = el("button", `${ROOT_CLASS}__poor-opt`, noun);
        b.type = "button";
        b.dataset.poor = key;
        const on = answers.poor.includes(key);
        b.classList.toggle("is-on", on);
        // Multi-select, so these are checkboxes rather than radios — a
        // rider can legitimately report two broken things at once.
        b.setAttribute("role", "checkbox");
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.addEventListener("click", () => {
          answers.poor = on
            ? answers.poor.filter((k) => k !== key)
            : [...answers.poor, key];
          render();
          body.querySelector<HTMLButtonElement>(`[data-poor="${key}"]`)?.focus();
        });
        opts.append(b);
      }
      wrap.append(opts);
      body.append(wrap);
    }

    // ---- plate
    const plateWrap = el("div", `${ROOT_CLASS}__plate`);
    const plateLabel = el(
      "label",
      `${ROOT_CLASS}__q`,
      "To confirm, please enter the plate number under the QR code on the device",
    );
    plateLabel.htmlFor = "device-features-plate";
    const plateInput = el("input", `${ROOT_CLASS}__plate-input`);
    plateInput.id = "device-features-plate";
    plateInput.type = "text";
    // `inputMode` rather than `type="number"`: plates are digit strings, and
    // a number input would strip a leading zero and offer spinners for a
    // value that is not a quantity.
    plateInput.inputMode = "numeric";
    plateInput.autocomplete = "off";
    plateInput.value = answers.plate;
    plateInput.placeholder = "e.g. 1025543";
    plateInput.addEventListener("input", () => {
      answers.plate = plateInput.value;
      // Only the Send button's disabled state depends on this, so re-sync it
      // in place rather than re-rendering — a full render would steal focus
      // out of the field on every keystroke.
      syncSend();
    });
    plateWrap.append(plateLabel, plateInput);
    body.append(plateWrap);

    // ---- send
    const actions = el("div", `${ROOT_CLASS}__actions`);
    const send = el("button", "login-btn", sending ? "Sending…" : "Send");
    send.type = "button";
    send.dataset.action = "submit";
    send.addEventListener("click", () => void submit());
    actions.append(send);
    body.append(actions);

    const note = el("p", `${ROOT_CLASS}__status-line`);
    note.dataset.role = "status";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    if (statusLine) note.textContent = statusLine;
    body.append(note);

    syncSend();
  }

  function syncSend(): void {
    const send = body.querySelector<HTMLButtonElement>('[data-action="submit"]');
    if (!send) return;
    send.disabled = sending || !readyToSubmit(answers);
  }

  function renderDone(): void {
    body.append(el("p", `${ROOT_CLASS}__stem`, "Thanks — logged."));
    if (statusLine) {
      body.append(el("p", `${ROOT_CLASS}__hint`, statusLine));
    }
    const actions = el("div", `${ROOT_CLASS}__actions`);
    const doneBtn = el("button", "login-btn", "Done");
    doneBtn.type = "button";
    doneBtn.addEventListener("click", close);
    actions.append(doneBtn);
    body.append(actions);
    doneBtn.focus();
  }

  async function submit(): Promise<void> {
    if (sending || !readyToSubmit(answers)) return;
    sending = true;
    statusLine = null;
    render();
    const post = options.submit ?? submitDeviceFeatureReport;
    try {
      const result = await post({
        vehicle_identifier: options.vehicleIdentifier,
        device_id: options.deviceId,
        submitted_plate: answers.plate,
        ...toRequestBody(answers),
        lat: options.lat,
        lng: options.lng,
      });
      if (closed) return;
      sending = false;
      done = true;
      // The one place the wrong-plate rule becomes visible, and it is
      // deliberately after the fact and deliberately not scolding: the
      // report WAS accepted and does still help, it just didn't earn
      // anything. Saying "wrong plate" and nothing else would read as a
      // rejection of work the rider actually did.
      statusLine = result.plate_valid
        ? result.points_awarded > 0
          ? `+${result.points_awarded} pts. It can take a few minutes to show on the map.`
          : "Logged. You've already earned points for this scooter today — this still counts toward the data."
        : "That plate didn't match this scooter, so no points this time — your answers were still recorded.";
      render();
      options.onSubmitted?.({
        plateValid: result.plate_valid,
        pointsAwarded: result.points_awarded,
      });
    } catch (err) {
      if (closed) return;
      sending = false;
      statusLine = describeSubmitError(err);
      render();
    }
  }

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  cleanupFns.push(() => document.removeEventListener("keydown", onKey));

  render();
  document.body.appendChild(backdrop);
  cleanupFns.push(trapFocusWithin(card, () => !closed));
  activeClose = close;

  // Points copy comes from the server so it cannot contradict the ledger.
  // Rendered with the fallback first and upgraded when this lands — a modal
  // that waits on a network call to show its first question is a modal that
  // feels broken on a bad connection.
  void (options.loadSchedule ?? fetchPointsSchedule)()
    .then((s) => {
      if (closed || done) return;
      schedule = s;
      render();
    })
    .catch(() => {
      /* the baked-in fallback is already on screen */
    });

  return close;
}

// ---------------------------------------------------------------------------
// Reading the map payload
// ---------------------------------------------------------------------------

/** The `device_features` object as it survives the trip through the map.
 *
 *  MapLibre flattens feature properties for the click path, which stringifies
 *  a nested object; the raw-GeoJSON path (the worth-the-walk "Show me" jump)
 *  hands over the real object. Both arrive here, plus `null` for every device
 *  nobody has confirmed yet — which is the common case and is NOT an error.
 *  Anything unparseable reads as "unknown", same as null: a scooter we can't
 *  describe is a scooter worth asking about. */
export function readDeviceFeatures(raw: unknown): {
  bell: boolean;
  cup_holder: boolean;
  phone_holder: boolean;
  basket: boolean;
  poor_condition: FeatureKey[];
} | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    if (!value || value === "null") return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const known = new Set<string>(FEATURE_QUESTIONS.map((q) => q.key));
  const poor = Array.isArray(o.poor_condition)
    ? (o.poor_condition.filter(
        (k): k is FeatureKey => typeof k === "string" && known.has(k),
      ))
    : [];
  return {
    bell: o.bell === true,
    cup_holder: o.cup_holder === true,
    phone_holder: o.phone_holder === true,
    // Absent from every consensus confirmed before baskets were asked
    // about, all of which read as "no basket" — the same answer this
    // returned before the question existed, and one a reconfirmation
    // corrects.
    basket: o.basket === true,
    poor_condition: poor,
  };
}

// ---------------------------------------------------------------------------
// Filtering the map by confirmed equipment
// ---------------------------------------------------------------------------

/** What the Filters drawer's Features section can select. The three
 *  equipment keys are the crowdsourced features riders actually shop for
 *  (the phone holder never made the cut — nobody plans a ride around one);
 *  "missing" is the ¯\_(ツ)_/¯ option, matching devices nobody has
 *  confirmed yet. */
export type FeatureFilterKey = "bell" | "basket" | "cup_holder" | "missing";

export const FEATURE_FILTER_KEYS: readonly FeatureFilterKey[] = [
  "bell",
  "basket",
  "cup_holder",
  "missing",
];

/** Does a device pass the Features filter?
 *
 *  This is a REQUIRE filter, not a hide filter like the ride-type/model
 *  toggles: most of the fleet has no confirmed data at all, so
 *  "everything on, tap to hide" has nothing to hide. Empty selection =
 *  filter off.
 *
 *  Selected equipment keys AND together — a rider picking Bell + Basket
 *  wants one scooter carrying both, not either. ¯\_(ツ)_/¯ (missing) ORs
 *  in the unconfirmed devices: no data doesn't mean no bell, and without
 *  this option requiring any feature would silently hide the (majority)
 *  unconfirmed fleet. Selected alone, it shows ONLY unconfirmed devices —
 *  which is also how a points-hunter finds scooters worth confirming. */
export function matchesFeatureFilter(
  rawFeatures: unknown,
  selected: ReadonlySet<FeatureFilterKey>,
): boolean {
  if (selected.size === 0) return true;
  const known = readDeviceFeatures(rawFeatures);
  if (!known) return selected.has("missing");
  const wanted = [...selected].filter(
    (k): k is Exclude<FeatureFilterKey, "missing"> => k !== "missing",
  );
  // Missing-data only: confirmed devices are exactly what's excluded.
  if (wanted.length === 0) return false;
  return wanted.every((k) => known[k]);
}

/** "🔔 Bell · 🥤 Cup holder (worn)" — the confirmed equipment, in one line.
 *  A scooter with none of the four reads "None of the four" rather than an
 *  empty string: somebody DID look, and that is a different fact from nobody
 *  having looked. */
export function summarizeFeatures(f: {
  bell: boolean;
  cup_holder: boolean;
  phone_holder: boolean;
  /** Optional so a caller holding a pre-basket consensus object still
   *  type-checks; absent reads the same as `false`. */
  basket?: boolean;
  poor_condition: FeatureKey[];
}): string {
  const poor = new Set(f.poor_condition);
  const parts: string[] = [];
  const add = (key: FeatureKey, label: string): void => {
    if (!f[key]) return;
    parts.push(poor.has(key) ? `${label} (needs work)` : label);
  };
  add("bell", "🔔 Bell");
  add("cup_holder", "🥤 Cup holder");
  add("phone_holder", "📱 Phone holder");
  add("basket", "🧺 Basket");
  return parts.length ? parts.join(" · ") : "None of the four";
}
