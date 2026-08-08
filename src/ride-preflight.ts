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
// So this is a shortcut, not a second wizard. Three toggles, then straight
// into ride mode — skipping every screen the answers make unnecessary and
// visiting every screen they make necessary.
//
// THE THREE TOGGLES, and why these three:
//   Navigation directions      default OFF  — turn-by-turn is heavier (two
//                                             more screens and a geocode);
//                                             off keeps "grab it and go".
//   Save Tracks to Local Device default ON  — the app's community-data
//                                             mission, and it is local-only
//                                             until a rider donates it.
//   Veo cost HUD               default ON   — the reason most riders open
//                                             ride mode at all.
// These match `ride-settings.ts`'s `defaultRideOptions()` field for field.
// They are the same `RideOptions` fields the wizard's own Screen 2 panel
// writes — this module does not invent a parallel settings vocabulary, it
// just asks about three of them in one breath.
//
// WHERE THE ANSWERS SEND YOU (`preflightLanding` below is the whole rule):
//   navigation ON   -> Screen 3 (destination) -> 4 (routes) -> 6
//   navigation OFF  -> Screen 6 directly
//
// Screen 6 is ALWAYS in the flow, even when the rider has nothing left to
// answer, and that is deliberate rather than an oversight in the skipping:
// it is the reducer's only legal seat for `rideStarted` (see
// `ride-screen-start.ts`'s header), so a path that skipped it could never
// reach `riding` at all. It starts the ride automatically on mount — there
// is no Start-in-Veo page any more, so this survey no longer asks whether
// the rider has unlocked anything in Veo either.
//
// House rules followed, same as every other modal in this program:
// `document.createElement` only (never innerHTML), a `cleanupFns[]`
// teardown list, and a real focus trap (`modal-focus-trap.ts`).

import { trapFocusWithin } from "./modal-focus-trap.ts";
import {
  openRideModal,
  type RidePreflightChoices,
  type ScreenId,
} from "./ride-modal.ts";

export type { RidePreflightChoices };

/** Everything the survey collects — three `RideOptions` fields verbatim. */
export type RidePreflightAnswers = RidePreflightChoices;

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
};

/** Where the survey's answers put the rider.
 *
 *  Pure, exported, and tested on its own because it is the actual product
 *  decision in this module — the DOM below is just how the questions get
 *  asked. */
export function preflightLanding(answers: RidePreflightAnswers): {
  fastForwardTo: ScreenId;
} {
  return {
    // Navigation is the only answer that adds screens. Screen 3's own skip
    // predicate reads `options.navigation` too, so this is belt-and-braces
    // — but landing on 3 rather than 6 is what makes the destination search
    // the first thing a nav rider sees instead of something they have to
    // walk back to. Screen 6 starts the ride automatically either way.
    fastForwardTo: answers.navigation ? "3" : "6",
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
  {
    key: "save_tracks",
    label: "Save Tracks to Local Device",
    hint: "Your route is recorded on this phone only. Nothing is sent unless you donate it after the ride.",
  },
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
  /** Plate, when resolved. Feeds Screen 2's manual path. */
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

    // ---- what happens next, in one line. A rider should never tap "Enter
    // Ride Mode" wondering whether they are about to get three more screens.
    body.append(el("p", `${ROOT_CLASS}__next`, describeNext(answers)));
  }

  goBtn.addEventListener("click", () => {
    const { fastForwardTo } = preflightLanding(answers);
    const enter = options.enterRideMode ?? openRideModal;
    // Close BEFORE opening the wizard: the wizard installs its own focus
    // trap, and two live traps fight over Tab.
    close();
    enter({
      vehicleIdentifier: options.vehicleIdentifier ?? undefined,
      plate: options.plate ?? undefined,
      fastForwardTo,
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
 *  test that pins its branches — the copy is the only thing telling a
 *  rider whether they are about to be asked more questions. */
export function describeNext(answers: RidePreflightAnswers): string {
  return answers.navigation
    ? "Next: pick a destination and a route, then ride mode starts."
    : "Next: ride mode starts.";
}
