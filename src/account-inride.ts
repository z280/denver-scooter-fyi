// The Account drawer's first tab: what the ride screen shows, and where the
// rider goes often.
//
// EVERY CONTROL HERE WORKS SIGNED OUT, which is why this is its own module
// rather than another section inside `account.ts`. That file builds the
// signed-in surface and is only ever constructed with a token; these four
// controls are device preferences in localStorage and have no account to wait
// for. A signed-out rider opening the drawer lands here and can actually change
// something.
//
// The rate plan is the one with a server half, and it is handled the way
// `ride-cost.ts` already designed for: this panel calls `saveRatePlan()`, which
// writes the local cache and fires the sync hook. `account.ts` registers that
// hook while signed in and owns the `PUT /profile`, so this module never
// imports the API client, and signing in does not change what this control
// does — only whether anything is listening. `setRatePlan` and `setRateStatus`
// on the handle are how the account side reports back.

import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import {
  FAVORITE_SLOT_IDS,
  assignSlotPlace,
  clearSlot,
  readSlots,
  renameSlot,
  type FavoriteSlot,
  type FavoriteSlotId,
} from "./favorite-slots.ts";
import { calibrationSentence, clearCalibration } from "./cost-calibration.ts";
import { reverseGeocode } from "./geocode.ts";
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

export interface InRidePanelDeps {
  /** Let the rider drop a pin for a favourite. Absent means the row offers
   *  only "Use my location" and "Clear" — which is also what keeps this module
   *  free of any map import, exactly as `account.ts`'s home/work rows are. */
  pickLocation?(label: string): Promise<{ lat: number; lng: number } | null>;
  /** A favourite was added, renamed or cleared. The destination lists read the
   *  store on open, so this is only for anything holding a rendered copy. */
  onFavoritesChanged?(): void;
  /** The Home or Work slot was set or cleared. Those two have a server half —
   *  the profile's `home_lat`/`work_lat` columns, which draw the map pins and
   *  count towards the profile-completion award — and this is the seam to it,
   *  for the same reason the rate plan has one: this module never imports the
   *  API client, so the host decides whether anything is listening. Absent, or
   *  signed out, and the slot is simply device-local, which is the whole point
   *  of the slots. Never fired for the two custom slots: they have no column.
   *
   *  Fired AFTER the local write, so the rider's row is already correct and a
   *  failed round trip costs them nothing they can see. */
  onHomeWorkChanged?(
    kind: "home" | "work",
    place: { lat: number; lon: number } | null,
  ): void;
}

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

export function buildInRidePanel(
  host: HTMLElement,
  deps: InRidePanelDeps = {},
): InRidePanelHandle {
  let disposed = false;
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

  // ---------------------------------------------------------------------
  // Favourite destinations
  // ---------------------------------------------------------------------

  const favs = section("Favorite destinations");
  favs.append(
    el(
      "p",
      "account-hint",
      "Four places, one tap away whenever you open “Where to?”. Home and Work keep their names; the other two are yours to label.",
    ),
  );

  const slotRows = new Map<FavoriteSlotId, { render(slot: FavoriteSlot): void }>();

  const rerenderSlots = (): void => {
    for (const slot of readSlots()) slotRows.get(slot.id)?.render(slot);
  };

  const buildSlotRow = (id: FavoriteSlotId): HTMLElement => {
    const wrap = el("div", "account-field account-favslot");
    const labelSpan = el("span", "control-label");
    const hint = el("p", "account-hint");
    const rowEl = el("div", "account-field__row account-location");
    const value = el("span", "account-location__value");
    const status = makeStatus();

    const renameBtn = el("button", "text-btn", "Rename");
    renameBtn.type = "button";
    const pickBtn = el("button", "text-btn", "Pick on map");
    pickBtn.type = "button";
    pickBtn.hidden = !deps.pickLocation;
    const useBtn = el("button", "text-btn", "Use my location");
    useBtn.type = "button";
    const clearBtn = el("button", "text-btn", "Clear");
    clearBtn.type = "button";

    // A rename box that replaces the row's buttons while it is open, so the
    // drawer never shows two ways to change the same name at once.
    const renameForm = el("form", "account-field__row");
    const renameInput = el("input", "input");
    renameInput.type = "text";
    renameInput.maxLength = 40;
    renameInput.setAttribute("aria-label", "Name for this favorite");
    const renameSave = el("button", "text-btn", "Save");
    renameSave.type = "submit";
    const renameCancel = el("button", "text-btn", "Cancel");
    renameCancel.type = "button";
    renameForm.append(renameInput, renameSave, renameCancel);
    renameForm.hidden = true;

    let current: FavoriteSlot | null = null;

    const render = (slot: FavoriteSlot): void => {
      current = slot;
      labelSpan.textContent = `${slot.emoji} ${slot.label}`;
      hint.textContent = slot.hint;
      renameBtn.hidden = !slot.renameable || slot.place === null;
      clearBtn.hidden = slot.place === null;
      if (slot.place === null) {
        value.textContent = "Not set";
        return;
      }
      const { lat, lon } = slot.place;
      value.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      // The address is nicer to read than a coordinate pair, but it arrives
      // late and the row may have moved on by then — re-check before painting,
      // the same guard `account.ts`'s home/work rows use.
      void reverseGeocode(lat, lon).then((addr) => {
        if (disposed || !addr) return;
        const now = current?.place;
        if (now && now.lat === lat && now.lon === lon) value.textContent = addr;
      });
    };

    const place = (lat: number, lon: number): void => {
      const { persisted } = assignSlotPlace(id, { lat, lon });
      status.set(persisted ? "Saved." : NOT_PERSISTED, !persisted);
      rerenderSlots();
      deps.onFavoritesChanged?.();
      if (id === "home" || id === "work") {
        deps.onHomeWorkChanged?.(id, { lat, lon });
      }
    };

    useBtn.addEventListener("click", () => {
      if (!("geolocation" in navigator)) {
        status.set("This browser can't share your location.", true);
        return;
      }
      useBtn.disabled = true;
      status.set("Locating…");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          useBtn.disabled = false;
          place(
            Number(pos.coords.latitude.toFixed(5)),
            Number(pos.coords.longitude.toFixed(5)),
          );
        },
        () => {
          useBtn.disabled = false;
          status.set("Couldn't get your location.", true);
        },
      );
    });

    pickBtn.addEventListener("click", () => {
      const picker = deps.pickLocation;
      if (!picker) return;
      status.set("Tap the map…");
      void picker(current?.label ?? id).then((point) => {
        if (disposed) return;
        if (!point) {
          status.set("");
          return;
        }
        place(point.lat, point.lng);
      });
    });

    clearBtn.addEventListener("click", () => {
      const { persisted } = clearSlot(id);
      status.set(persisted ? "Cleared." : NOT_PERSISTED, !persisted);
      rerenderSlots();
      deps.onFavoritesChanged?.();
      if (id === "home" || id === "work") deps.onHomeWorkChanged?.(id, null);
    });

    const openRename = (): void => {
      renameInput.value = current?.label ?? "";
      renameForm.hidden = false;
      rowEl.hidden = true;
      renameInput.focus();
      renameInput.select();
    };
    const closeRename = (): void => {
      renameForm.hidden = true;
      rowEl.hidden = false;
      renameBtn.focus();
    };
    renameBtn.addEventListener("click", openRename);
    renameCancel.addEventListener("click", closeRename);
    renameForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const { persisted, applied } = renameSlot(id, renameInput.value);
      if (!applied) {
        status.set("Give it a name first.", true);
        return;
      }
      status.set(persisted ? "Saved." : NOT_PERSISTED, !persisted);
      closeRename();
      rerenderSlots();
      deps.onFavoritesChanged?.();
    });

    rowEl.append(value, pickBtn, useBtn, renameBtn, clearBtn);
    wrap.append(labelSpan, hint, rowEl, renameForm, status.node);
    slotRows.set(id, { render });
    return wrap;
  };

  for (const id of FAVORITE_SLOT_IDS) favs.append(buildSlotRow(id));

  host.append(display, rate, calib, favs);

  const refresh = (): void => {
    speedoSelect.value = speedometerStyle();
    paintSpeedoHint();
    costInput.checked = showsCostHud();
    const saved = savedRatePlan();
    rateSelect.value = saved ?? DEFAULT_RATE_PLAN;
    rateDefaultNote.hidden = saved !== null;
    // A receipt filed since the drawer was last open can have changed this.
    renderCalibration();
    rerenderSlots();
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
      disposed = true;
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}
