// The Account drawer's first tab: what the ride screen shows while you are on
// it, and what Veo is charging you for being there.
//
// EVERY CONTROL HERE WORKS SIGNED OUT, which is why this is its own module
// rather than another section inside `account.ts`. That file builds the
// signed-in surface and is only ever constructed with a token; these are device
// preferences in localStorage and have no account to wait for. A signed-out
// rider opening the drawer lands here and can actually change something.
//
// TRIP PLANS AND FAVOURITE DESTINATIONS USED TO BE HERE and are now the
// Navigation tab (`account-nav.ts`). They are about where a route goes, not
// about what the ride screen draws, and they sat here only because this was the
// one ungated tab at the time. What is left is the screen, the rate plan that
// feeds its cost readout, and what the receipts have taught that estimate —
// which is one subject rather than two.
//
// The rate plan is the one with a server half, and it is handled the way
// `ride-cost.ts` already designed for: this panel calls `saveRatePlan()`, which
// writes the local cache and fires the sync hook. `account.ts` registers that
// hook while signed in and owns the `PUT /profile`, so this module never
// imports the API client, and signing in does not change what this control
// does — only whether anything is listening. `setRatePlan` and `setRateStatus`
// on the handle are how the account side reports back.

import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import { calibrationSentence, clearCalibration } from "./cost-calibration.ts";
import {
  DEFAULT_RATE_PLAN,
  savedRatePlan,
  saveRatePlan,
} from "./ride-cost.ts";
import {
  SPEEDOMETER_STYLES,
  setShowsCostHud,
  setSpeedometerStyle,
  showsCostHud,
  speedometerStyle,
} from "./ride-display-prefs.ts";
import type { SpeedometerStyle } from "./api.ts";

export interface InRidePanelHandle {
  /** The account resolved a plan from the server — show it without firing a
   *  save back, which would bounce the value between the two sides. */
  setRatePlan(key: RatePlanKey | null): void;
  /** Where the account's sync hook reports the outcome of its PUT. */
  setRateStatus(message: string, isError?: boolean): void;
  /** Re-read every control from storage. Called when the drawer reopens, since
   *  the HUD's own wrench panel can change the rate plan mid-ride. */
  refresh(): void;
  dispose(): void;
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

interface StatusLine {
  node: HTMLElement;
  set(msg: string, isError?: boolean): void;
}

function makeStatus(): StatusLine {
  const node = el("p", "account-magic-status");
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  return {
    node,
    set(msg, isError = false) {
      node.textContent = msg;
      node.classList.toggle("account-magic-status--error", isError);
    },
  };
}

function section(title: string): HTMLElement {
  const sec = el("section", "account-section");
  sec.append(el("h3", "account-section__title", title));
  return sec;
}

/** The copy shown when a write is refused. Said plainly rather than as a
 *  success, because a preference that did not persist will be gone next visit
 *  and a rider who is told "Saved." has been lied to. */
const NOT_PERSISTED = "Applied, but not saved on this device (private browsing?).";

/** No deps object. Everything this panel needs is either a localStorage
 *  preference it reads directly or the rate plan's server half, which reaches
 *  it through the handle rather than through a callback — the map picker and
 *  the favourite seams went to `account-nav.ts` with the sections that used
 *  them. An empty `deps = {}` left behind would be a parameter every caller
 *  has to supply and nothing reads. */
export function buildInRidePanel(host: HTMLElement): InRidePanelHandle {
  const cleanups: (() => void)[] = [];

  // ---------------------------------------------------------------------
  // Ride screen — the two display preferences
  // ---------------------------------------------------------------------

  const display = section("Ride screen");
  display.append(
    el(
      "p",
      "account-hint",
      "What the ride screen shows. Each ride starts from these; the wrench panel on the ride screen can still change that ride only.",
    ),
  );

  const speedoStatus = makeStatus();
  const speedoWrap = el("div", "account-field");
  speedoWrap.append(el("span", "control-label", "Speedometer"));
  const speedoSelect = el("select", "select");
  speedoSelect.setAttribute("aria-label", "Speedometer");
  for (const style of SPEEDOMETER_STYLES) {
    const opt = el("option", undefined, style.label);
    opt.value = style.value;
    speedoSelect.append(opt);
  }
  // The chosen style's own sentence, under the select. The three names do not
  // describe themselves — "Classic" shows the dial AND the digital readout —
  // and a rider picking between them needs to be told which, so the hint is
  // part of the control rather than a one-off note about it.
  const speedoHint = el("p", "account-hint");
  const paintSpeedoHint = (): void => {
    const chosen = SPEEDOMETER_STYLES.find((s) => s.value === speedoSelect.value);
    speedoHint.textContent = chosen?.hint ?? "";
  };
  speedoSelect.addEventListener("change", () => {
    const next = speedoSelect.value as SpeedometerStyle;
    paintSpeedoHint();
    // Called ONCE and the result reused: writing the preference twice to work
    // out both the message and the error flag would be two storage writes per
    // change, and the second could disagree with the first.
    const ok = setSpeedometerStyle(next);
    speedoStatus.set(ok ? "Saved." : NOT_PERSISTED, !ok);
  });
  speedoWrap.append(speedoSelect, speedoHint, speedoStatus.node);

  const costStatus = makeStatus();
  const costLabel = el("label", "switch account-switch");
  const costInput = el("input");
  costInput.type = "checkbox";
  costLabel.append(costInput, el("span", undefined, "Show Veo cost"));
  const costHint = el(
    "p",
    "account-hint",
    "A running estimate of what Veo is charging, from your rate plan below. Never shown on your own scooter or bike — there is no Veo meter to picture.",
  );
  costInput.addEventListener("change", () => {
    costStatus.set(setShowsCostHud(costInput.checked) ? "Saved." : NOT_PERSISTED);
  });

  display.append(speedoWrap, costLabel, costHint, costStatus.node);

  // ---------------------------------------------------------------------
  // Rate plan
  // ---------------------------------------------------------------------

  const rate = section("Veo rate plan");
  rate.append(
    el(
      "p",
      "account-hint",
      "What Veo charges you. Everything the app prices — the cost readout, the ride summary, the trip plans — is worked out from this.",
    ),
  );
  const rateStatus = makeStatus();
  const rateWrap = el("div", "account-field");
  rateWrap.append(el("span", "control-label", "Rate plan"));
  const rateSelect = el("select", "select");
  rateSelect.setAttribute("aria-label", "Rate plan");
  for (const plan of RATE_PLANS) {
    const opt = el("option", undefined, plan.label);
    opt.value = plan.key;
    rateSelect.append(opt);
  }
  // DEFAULTS TO FULL-PRICE NON-RESIDENT, and the select SHOWS that rather than
  // opening on a blank "choose one". `DEFAULT_RATE_PLAN` is what the app
  // already prices against for a rider who has not chosen (see its own comment
  // on why the default must not be the cheaper tier), so a placeholder would
  // hide the assumption every estimate is already making. A rider on a cheaper
  // tier can see at a glance that this is not theirs yet.
  const rateDefaultNote = el(
    "p",
    "account-hint",
    "Standard visitor pricing is assumed until you pick — the full-price rate, so an estimate is never lower than your real bill.",
  );
  rateSelect.addEventListener("change", () => {
    const key = rateSelect.value as RatePlanKey;
    if (!RATE_PLANS.some((p) => p.key === key)) return;
    rateDefaultNote.hidden = true;
    // `saveRatePlan` writes the local cache AND fires the account sync hook,
    // which owns the PUT and reports through `setRateStatus` below. Only the
    // cache-write failure is this panel's to report, and it must win over the
    // hook's optimistic copy: the account may well have saved it, but this
    // device will not remember the Pass variant the server cannot hold.
    if (!saveRatePlan(key)) rateStatus.set(NOT_PERSISTED, true);
    else rateStatus.set("Saved.");
  });
  rateWrap.append(rateSelect, rateDefaultNote, rateStatus.node);
  rate.append(rateWrap);

  // ---------------------------------------------------------------------
  // §11.2 — what the receipts taught the cost estimate
  // ---------------------------------------------------------------------

  // ONLY VISIBLE WHEN THERE IS SOMETHING TO SAY. A section explaining that we
  // have learned nothing yet is a settings row about our own internals, and
  // the rider cannot act on it — the way to make it appear is to file a
  // receipt, which is a thing they do for their own reasons.
  const calib = section("Cost estimate");
  const calibLine = el("p", "account-hint");
  const calibClear = el("button", "text-btn", "Reset this");
  calibClear.type = "button";
  const calibStatus = makeStatus();
  calib.append(calibLine, calibClear, calibStatus.node);
  calibClear.addEventListener("click", () => {
    clearCalibration();
    calibStatus.set("Reset — estimates start from our own clock again.");
    renderCalibration();
  });
  function renderCalibration(): void {
    const sentence = calibrationSentence();
    calib.hidden = sentence === null;
    if (sentence !== null) calibLine.textContent = sentence;
  }
  renderCalibration();

  host.append(display, rate, calib);

  const refresh = (): void => {
    speedoSelect.value = speedometerStyle();
    paintSpeedoHint();
    costInput.checked = showsCostHud();
    const saved = savedRatePlan();
    rateSelect.value = saved ?? DEFAULT_RATE_PLAN;
    rateDefaultNote.hidden = saved !== null;
    // A receipt filed since the drawer was last open can have changed this.
    renderCalibration();
  };
  refresh();

  return {
    setRatePlan(key) {
      // Assigning `.value` does not fire `change`, so this cannot loop back
      // into a save — which is the whole reason the account side calls it
      // instead of dispatching an event.
      rateSelect.value = key ?? DEFAULT_RATE_PLAN;
      rateDefaultNote.hidden = key !== null;
    },
    setRateStatus(message, isError = false) {
      rateStatus.set(message, isError);
    },
    refresh,
    dispose() {
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}
