// "Use in Ride Mode" — the device card's one-screen pre-ride survey.
//
// WHY THIS EXISTS ----------------------------------------------------------
// The Screens 1–6 wizard (`ride-modal.ts`) is the front door to ride mode:
// it asks who you are, where you are, which scooter, then walks a linear
// flow. That is the right shape when a rider opens 🧭 with nothing in mind.
// It is the wrong shape when they are already standing at a specific
// scooter with its popup open on their phone — they have ALREADY answered
// "which scooter", and re-asking is the single loudest piece of friction
// left in the flow.
//
// So this is a shortcut, not a second wizard. Two toggles and (sometimes)
// one either/or, then straight into ride mode — skipping every screen the
// answers make unnecessary and visiting every screen they make necessary.
//
// THE TWO TOGGLES, and why these two:
//   Navigation directions      default OFF  — turn-by-turn is heavier (two
//                                             more screens and a geocode);
//                                             off keeps "grab it and go".
//   Veo cost HUD               default ON   — the reason most riders open
//                                             ride mode at all.
// These match `ride-settings.ts`'s `defaultRideOptions()` field for field.
//
// It was three. "Save Tracks to Local Device" left because it was never
// really a per-ride question — the answer a rider gives is the answer they
// give every time, so asking it each ride only bought a screen. It is one
// standing setting now, in Settings → Local Data, owned by
// `track-preference.ts`, and this modal reads it rather than asking.
// They are the same `RideOptions` fields the wizard's own Screen 2 panel
// writes — this module does not invent a parallel settings vocabulary, it
// just asks about three of them in one breath.
//
// WHERE THE ANSWERS SEND YOU (`preflightLanding` below is the whole rule):
//   navigation ON   -> Screen 3 (destination) -> 4 (routes) -> 6
//   navigation OFF  -> Screen 6 directly
//   "give me a link" -> Screen 6 renders its Open-in-Veo buttons normally
//   "already started"/cost HUD off -> Screen 6 auto-starts on mount
//
// Screen 6 is ALWAYS in the flow, even when the rider has nothing left to
// answer, and that is deliberate rather than an oversight in the skipping:
// it is the reducer's only legal seat for `rideStarted` (see
// `ride-screen-start.ts`'s header), so a path that skipped it could never
// reach `riding` at all. `autoStart` is how it stays out of the way — the
// screen mounts, starts the ride, and hands off without the rider seeing a
// decision they already made here.
//
// COST HUD OFF is a real branch, not a display tweak. When it is off we
// stop asking about Veo entirely: no "did you start it?", no start link,
// and — per the owner — no rate-plan reconfirmation either (that lives in
// the profile, and asking again here would be exactly the pre-ride friction
// this screen exists to remove). The ride simply starts, with the HUD's cost
// readout hidden.
//
// House rules followed, same as every other modal in this program:
// `document.createElement` only (never innerHTML), a `cleanupFns[]`
// teardown list, and a real focus trap (`modal-focus-trap.ts`).

import { trapFocusWithin } from "./modal-focus-trap.ts";
import {
  openRideModal,
  type RidePreflightChoices,
  type RideStartIntent,
  type ScreenId,
} from "./ride-modal.ts";
import { savesTracks } from "./track-preference.ts";

export type { RidePreflightChoices, RideStartIntent };

/** Everything the survey collects. The three booleans are `RideOptions`
 *  fields verbatim; `startIntent` is not an option — it only decides which
 *  face Screen 6 shows. */
export interface RidePreflightAnswers extends RidePreflightChoices {
  startIntent: RideStartIntent;
}

/** Product defaults, stated once. Deliberately duplicated from
 *  `ride-settings.ts`'s `defaultRideOptions()` rather than imported: that
 *  function returns the full nine-field blob including the four donation
 *  options and `own_device`, and importing it here to pick three fields out
 *  would tie this module to a shape it does not use. The values are asserted
 *  equal in `ride-preflight.test.ts`, so the two cannot silently drift. */
export const PREFLIGHT_DEFAULTS: RidePreflightAnswers = {
  navigation: false,
  save_tracks: true,
  cost_hud: true,
  // Only ever read when `cost_hud` is on. "Give me a link" is the default
  // because it is the answer that costs a rider nothing to be wrong about:
  // a rider who already started can tap "I already started" on Screen 6,
  // whereas defaulting to "already started" would silently skip past the
  // one screen that hands out the start link.
  startIntent: "need-link",
};

/** Where the survey's answers put the rider, and whether Screen 6 should
 *  start the ride by itself.
 *
 *  Pure, exported, and tested on its own because it is the actual product
 *  decision in this module — the DOM below is just how the questions get
 *  asked. */
export function preflightLanding(answers: RidePreflightAnswers): {
  fastForwardTo: ScreenId;
  autoStart: boolean;
} {
  return {
    // Navigation is the only answer that adds screens. Screen 3's own skip
    // predicate reads `options.navigation` too, so this is belt-and-braces
    // — but landing on 3 rather than 6 is what makes the destination search
    // the first thing a nav rider sees instead of something they have to
    // walk back to.
    fastForwardTo: answers.navigation ? "3" : "6",
    // Nothing left to ask about Veo: either they told us they have already
    // unlocked it, or they turned the cost HUD off, which the owner's spec
    // defines as removing the consideration about starting Veo altogether.
    autoStart: !answers.cost_hud || answers.startIntent === "already-started",
  };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** The toggle rows, in the owner's order and with the owner's labels. The
 *  label is written in its DEFAULT state ("Navigation directions OFF") the
 *  way the spec lists it; the live control reads out the CURRENT state, so
 *  a rider never has to work out whether the words describe what is or what
 *  would be. */
const ROWS: readonly {
  key: keyof RidePreflightChoices;
  label: string;
  hint: string;
}[] = [
  {
    key: "navigation",
    label: "Navigation directions",
    hint: "Turn-by-turn to a destination you pick next. Off = straight to riding.",
  },
  // No "Save Tracks to Local Device" row. It is one standing answer per
  // rider now, set in Settings → Local Data and read from
  // `track-preference.ts` — a rider who wants their tracks wants them every
  // ride, and asking again each time only ever produced the same answer at
  // the cost of a screen. `RidePreflightChoices.save_tracks` still carries
  // it to the session doc; it just isn't asked here.
  {
    key: "cost_hud",
    label: "Veo cost HUD",
    hint: "A running cost estimate on the ride screen, from your saved rate plan.",
  },
];

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export interface RidePreflightOptions {
  /** Human name for the scooter — the model, plus a plate when we have one.
   *  Purely for the header; nothing keys off it. */
  deviceLabel: string;
  /** 16-hex identifier to preselect on Screen 2. */
  vehicleIdentifier?: string | null;
  /** Plate, when resolved. Feeds Screen 2's manual path and Screen 6's
   *  Open-in-Veo deep link. */
  plate?: string | null;
  /** Starting answers. Defaults to `PREFLIGHT_DEFAULTS`; a caller can seed
   *  from a previous session. */
  initial?: Partial<RidePreflightAnswers>;
  /** Injected for tests. Defaults to `openRideModal`. */
  enterRideMode?: typeof openRideModal;
  /** Fires after the wizard has been handed the answers, so the caller can
   *  close its own popup. */
  onEntered?(answers: RidePreflightAnswers): void;
  /** Dismissed without entering ride mode. */
  onCancel?(): void;
}

const ROOT_CLASS = "ride-preflight";

/** Teardown for the survey that is currently open, if any.
 *
 *  "At most one at a time" used to be enforced by removing the previous
 *  element, which detaches the DOM but runs NO teardown — and this modal
 *  installs two DOCUMENT-level listeners (the Escape handler here, and
 *  `trapFocusWithin`'s `focusin` handler). An orphaned trap is worse than a
 *  leak: its `isActive()` closes over a `closed` flag that never flipped, so
 *  it stays live forever and keeps yanking focus back onto a node that is no
 *  longer in the document. Holding the real `close` and calling it is what
 *  makes the singleton rule actually mean "torn down". */
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

/** Open the survey. Returns a close function so a caller (or a test) can
 *  dismiss it without going through the UI. At most one is open at a time —
 *  a second call closes the first, matching `openFloatingModal`'s rule. */
export function openRidePreflight(options: RidePreflightOptions): () => void {
  // Tear the previous one DOWN, don't just unhook its DOM.
  activeClose?.();
  // Belt and braces: a stray node with no live teardown (hot reload, a test
  // that hand-injected one) still gets swept.
  document.querySelector(`.${ROOT_CLASS}`)?.remove();

  const answers: RidePreflightAnswers = {
    ...PREFLIGHT_DEFAULTS,
    // The rider's standing choice, read fresh at open time — this modal no
    // longer has a row for it, so a stale module-load copy would be the only
    // value it ever carried and a rider who turned tracking off in Settings
    // would keep recording.
    save_tracks: savesTracks(),
    ...options.initial,
  };
  const cleanupFns: (() => void)[] = [];
  let closed = false;

  const backdrop = el("div", ROOT_CLASS);
  const card = el("div", `${ROOT_CLASS}__card`);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "ride-preflight-title");

  const head = el("div", `${ROOT_CLASS}__head`);
  const title = el("h3", undefined, "🧭 Use in Ride Mode");
  title.id = "ride-preflight-title";
  const closeBtn = el("button", `${ROOT_CLASS}__close`, "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(title, closeBtn);

  const lede = el("p", `${ROOT_CLASS}__lede`, options.deviceLabel);
  const body = el("div", `${ROOT_CLASS}__body`);
  const actions = el("div", `${ROOT_CLASS}__actions`);

  const goBtn = el("button", "login-btn", "Enter Ride Mode");
  goBtn.type = "button";
  actions.append(goBtn);

  card.append(head, lede, body, actions);
  backdrop.append(card);

  function close(): void {
    if (closed) return;
    closed = true;
    // Only clear the slot if it is still OURS: a re-entrant open has already
    // pointed it at the new modal by the time this runs.
    if (activeClose === close) activeClose = null;
    for (const fn of cleanupFns.splice(0)) fn();
    backdrop.remove();
  }

  // ---- toggle rows
  function renderBody(): void {
    body.replaceChildren();

    for (const row of ROWS) {
      const wrap = el("div", `${ROOT_CLASS}__row`);
      const labels = el("div", `${ROOT_CLASS}__labels`);
      labels.append(
        el("span", `${ROOT_CLASS}__label`, row.label),
        el("span", `${ROOT_CLASS}__hint`, row.hint),
      );

      const btn = el("button", `${ROOT_CLASS}__toggle`);
      btn.type = "button";
      btn.dataset.option = row.key;
      const on = answers[row.key];
      btn.textContent = on ? "ON" : "OFF";
      btn.classList.toggle("is-on", on);
      // The button IS the state, so it is a switch, not a checkbox: screen
      // readers announce "Veo cost HUD, on" rather than reading the visible
      // "ON" text as a second, unrelated word.
      btn.setAttribute("role", "switch");
      btn.setAttribute("aria-checked", on ? "true" : "false");
      btn.setAttribute("aria-label", row.label);
      btn.addEventListener("click", () => {
        answers[row.key] = !answers[row.key];
        renderBody();
        // Re-rendering blows away focus; put it back on the control the
        // rider just used, or the toggle row becomes unusable by keyboard.
        body
          .querySelector<HTMLButtonElement>(`[data-option="${row.key}"]`)
          ?.focus();
      });

      wrap.append(labels, btn);
      body.append(wrap);
    }

    // ---- the Veo either/or, shown ONLY when the cost HUD is on.
    //
    // The owner's rule: "If they choose veo cost hud off, we remove
    // consideration about starting veo." So this is not disabled-but-
    // present — it is absent, along with the question of whether the rider
    // has unlocked anything yet.
    if (answers.cost_hud) {
      const group = el("div", `${ROOT_CLASS}__startgroup`);
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "Starting the scooter in Veo");
      group.append(
        el("span", `${ROOT_CLASS}__label`, "Starting it in Veo"),
      );

      const choices: readonly { intent: RideStartIntent; label: string }[] = [
        { intent: "already-started", label: "I started the Veo already" },
        { intent: "need-link", label: "Give me a link to Open in Veo" },
      ];
      const opts = el("div", `${ROOT_CLASS}__startopts`);
      for (const choice of choices) {
        const b = el("button", `${ROOT_CLASS}__startopt`, choice.label);
        b.type = "button";
        b.dataset.intent = choice.intent;
        const selected = answers.startIntent === choice.intent;
        b.classList.toggle("is-selected", selected);
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", selected ? "true" : "false");
        b.addEventListener("click", () => {
          answers.startIntent = choice.intent;
          renderBody();
          body
            .querySelector<HTMLButtonElement>(`[data-intent="${choice.intent}"]`)
            ?.focus();
        });
        opts.append(b);
      }
      group.append(opts);
      body.append(group);
    }

    // ---- what happens next, in one line. A rider should never tap "Enter
    // Ride Mode" wondering whether they are about to get three more screens.
    body.append(el("p", `${ROOT_CLASS}__next`, describeNext(answers)));
  }

  goBtn.addEventListener("click", () => {
    const { fastForwardTo, autoStart } = preflightLanding(answers);
    const enter = options.enterRideMode ?? openRideModal;
    // Close BEFORE opening the wizard: the wizard installs its own focus
    // trap, and two live traps fight over Tab.
    close();
    enter({
      vehicleIdentifier: options.vehicleIdentifier ?? undefined,
      plate: options.plate ?? undefined,
      fastForwardTo,
      autoStart,
      preflight: {
        navigation: answers.navigation,
        save_tracks: answers.save_tracks,
        cost_hud: answers.cost_hud,
      },
    });
    options.onEntered?.({ ...answers });
  });

  closeBtn.addEventListener("click", () => {
    close();
    options.onCancel?.();
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      close();
      options.onCancel?.();
    }
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      close();
      options.onCancel?.();
    }
  };
  document.addEventListener("keydown", onKey);
  cleanupFns.push(() => document.removeEventListener("keydown", onKey));

  renderBody();
  document.body.appendChild(backdrop);
  cleanupFns.push(trapFocusWithin(card, () => !closed));
  activeClose = close;
  goBtn.focus();

  return close;
}

/** One line of "here's what tapping the button does". Exported for the
 *  test that pins the four branches — the copy is the only thing telling a
 *  rider whether they are about to be asked more questions. */
export function describeNext(answers: RidePreflightAnswers): string {
  const { autoStart } = preflightLanding(answers);
  if (answers.navigation) {
    return autoStart
      ? "Next: pick a destination and a route, then ride mode starts."
      : "Next: pick a destination and a route, then your link to open in Veo.";
  }
  return autoStart
    ? "Next: ride mode starts."
    : "Next: your link to open in Veo.";
}
