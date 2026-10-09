// The Account drawer's Navigation tab: how a route may be built, and the four
// places a rider goes.
//
// WHY THIS IS ITS OWN TAB. Both halves were on In-Ride, which is about what the
// ride SCREEN shows — the speedometer, the cost readout, the rate plan behind
// it. "May a route park one scooter and start another" and "where is Home" are
// not that. They are what you decide before you set off, and they were filed
// with the display preferences only because In-Ride happened to be the one tab
// that worked signed out. They do too, which is the point: every control here
// is a device preference in localStorage, so this tab is never gated and a
// rider who has never signed in can set all of it.
//
// The two halves belong together for a reason beyond "neither fitted elsewhere".
// A hand-off is a route with a stop in it, and a favourite is where a route
// ends; set the cap to one scooter and the four slots are what the planner is
// routing between. The split preference comes with the cap because it is the
// second half of the same question — the cap is "will I switch at all", the
// split is "given that I am, which scooter do I want to be on for most of it" —
// and leaving it behind on In-Ride would have stranded a control whose only
// subject is the one that moved.
//
// SAME SEAMS AS `account-inride.ts`, deliberately: no API client, no map
// import. `pickLocation` is passed in, so this module
// stays testable without either.

import {
  FAVORITE_SLOT_IDS,
  assignSlotPlace,
  clearSlot,
  readSlots,
  renameSlot,
  type FavoriteSlot,
  type FavoriteSlotId,
} from "./favorite-slots.ts";
import {
  ROUTE_PRIORITY_OPTIONS,
  routePriority,
  setRoutePriority,
} from "./route-priority.ts";
import {
  HAND_OFF_CAP_OPTIONS,
  handOffCap,
  setHandOffCap,
  type HandOffCap,
} from "./plan-prefs.ts";
import {
  autoDibs,
  dibsSmsAlerts,
  setAutoDibs,
  setDibsSmsAlerts,
} from "./dibs-prefs.ts";
import { reverseGeocode } from "./geocode.ts";

export interface NavPanelDeps {
  /** Let the rider drop a pin for a favourite. Absent means the row offers
   *  only "Use my location" and "Clear" — which is also what keeps this module
   *  free of any map import, exactly as `account.ts`'s home/work rows are. */
  pickLocation?(label: string): Promise<{ lat: number; lng: number } | null>;
  /** A favourite was added, renamed or cleared. The destination lists read the
   *  store on open, so this is only for anything holding a rendered copy. */
  onFavoritesChanged?(): void;
  /** A Home or Work slot changed. Only for redrawing the map pins, which are
   *  drawn from these slots — there is no profile column to mirror into any
   *  more. Fired for the two custom slots too, since all four are saved places
   *  and the caller may care about any of them.
   *
   *  NOT how a slot reaches the account: that is `favorites.ts`'s own sync
   *  hook, which carries all four (and every other saved place) into the
   *  encrypted `saved_places` blob without this module knowing. */
  /** Whether the rider has configured an "ideal scooter".
   *
   *  Asked rather than imported: the spec lives behind a panel in another
   *  drawer, and this module has no business reaching into it. Absent reads as
   *  "not configured", which is the safe answer — it produces a row saying the
   *  split preference has nothing to prefer yet, which is true of a build that
   *  never wired this. */
  hasIdealSpec?(): boolean;
  /** Whether the rider has a PROVED phone number on their profile.
   *
   *  Three-valued on purpose. `true` and `false` are what they say; `null` is
   *  "we have not looked yet" — the profile fetch is in flight, or there is no
   *  session to fetch for. A null must not be rendered as "you have no phone",
   *  because that sentence tells a rider with a verified number to go and
   *  verify it. Absent dep reads as null for the same reason.
   *
   *  Asked rather than imported: this module never touches the API client, the
   *  same rule that keeps the rate plan and the map picker out of it. */
  phoneVerified?(): boolean | null;
}

export interface NavPanelHandle {
  /** Re-read every control from storage. Called when the tab is shown, since
   *  a sign-in can have merged places in from the account and the ideal-scooter
   *  spec lives in another drawer entirely. */
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

/** The dibs SMS switch's ids — see the Calling dibs section below. */
export const DIBS_SMS_TOGGLE_ID = "dibs-sms-toggle";
export const DIBS_SMS_SETTING_ID = "dibs-sms-setting";

function section(title: string): HTMLElement {
  const sec = el("section", "account-section");
  sec.append(el("h3", "account-section__title", title));
  return sec;
}

/** The copy shown when a write is refused. Said plainly rather than as a
 *  success, because a preference that did not persist will be gone next visit
 *  and a rider who is told "Saved." has been lied to. */
const NOT_PERSISTED = "Applied, but not saved on this device (private browsing?).";

export function buildNavPanel(
  host: HTMLElement,
  deps: NavPanelDeps = {},
): NavPanelHandle {
  let disposed = false;

  // ---------------------------------------------------------------------
  // Trip planning
  // ---------------------------------------------------------------------

  // WHY A SETTING AND NOT A CLEVERNESS. `rankPlans` prices a hand-off honestly,
  // so a two-scooter plan that comes out cheaper really is cheaper. What the
  // arithmetic cannot price is whether the rider WANTS to park one scooter,
  // find another and start a second rental mid-trip — for plenty of people the
  // answer is no at any price. Until this existed, their only way to decline
  // was to notice the hand-off in the list and pick a different row, every
  // single time.
  const planning = section("Trip plans");
  planning.append(
    el(
      "p",
      "account-hint",
      "When you ask \u201cWhere to?\u201d we look for the quickest and cheapest ways there \u2014 sometimes that means riding one scooter, parking it, and taking another.",
    ),
  );
  const capStatus = makeStatus();
  const capWrap = el("div", "account-field");
  capWrap.append(el("span", "control-label", "Switching scooters"));
  const capSelect = el("select", "select");
  capSelect.setAttribute("aria-label", "Switching scooters");
  for (const option of HAND_OFF_CAP_OPTIONS) {
    const opt = el("option", undefined, option.label);
    opt.value = option.value === null ? "any" : String(option.value);
    capSelect.append(opt);
  }
  // Same reasoning as the speedometer's hint: three short labels that do not
  // describe themselves, and the consequence of each is what the rider is
  // actually choosing between.
  const capHint = el("p", "account-hint");
  const paintCapHint = (): void => {
    const chosen = HAND_OFF_CAP_OPTIONS.find(
      (o) => (o.value === null ? "any" : String(o.value)) === capSelect.value,
    );
    capHint.textContent = chosen?.hint ?? "";
  };
  capSelect.addEventListener("change", () => {
    const next: HandOffCap = capSelect.value === "any" ? null : capSelect.value === "0" ? 0 : 1;
    paintCapHint();
    capStatus.set(setHandOffCap(next) ? "Saved." : NOT_PERSISTED);
  });
  capWrap.append(capSelect, capHint, capStatus.node);
  planning.append(capWrap);

  // WHERE ALONG THE ROUTE to swap, once the rider has accepted a split.
  // Separate from the cap above because they answer different questions: the
  // cap is "will I switch at all", this is "given that I am switching, on
  // whose terms". A rider who capped hand-offs at zero never sees this one
  // fire, and that is fine — it costs them one row they can ignore, where
  // folding the two into a single control would mean neither said what it
  // meant.
  //
  // FOUR OPTIONS AND NOT TWO. Its ancestor offered "More of my ideal scooter"
  // against "Cheapest", which is this same axis flattened to the point where
  // two of the four answers had nowhere to go: a rider hunting the Equity
  // Area discount and a rider who simply wants the fewest hand-offs were both
  // filed under "Cheapest", and the list behaved identically for them.
  const splitStatus = makeStatus();
  const splitWrap = el("div", "account-field");
  splitWrap.append(el("span", "control-label", "When a trip is split"));
  const splitSelect = el("select", "select");
  splitSelect.setAttribute("aria-label", "When a trip is split");
  for (const option of ROUTE_PRIORITY_OPTIONS) {
    const opt = el("option", undefined, option.label);
    opt.value = option.value;
    splitSelect.append(opt);
  }
  const splitHint = el("p", "account-hint");
  const paintSplitHint = (): void => {
    const chosen = ROUTE_PRIORITY_OPTIONS.find((o) => o.value === splitSelect.value);
    splitHint.textContent = chosen?.hint ?? "";
  };
  splitSelect.addEventListener("change", () => {
    // Read back through the option list rather than casting the raw value: a
    // <select> can only hold what we put in it today, and a cast would stop
    // being true the moment somebody adds a fifth option elsewhere.
    const next = ROUTE_PRIORITY_OPTIONS.find((o) => o.value === splitSelect.value);
    if (!next) return;
    paintSplitHint();
    splitStatus.set(setRoutePriority(next.value) ? "Saved." : NOT_PERSISTED);
  });
  splitWrap.append(splitSelect, splitHint, splitStatus.node);
  planning.append(splitWrap);

  // IT DOES NOTHING UNTIL AN IDEAL SCOOTER EXISTS, and saying so here is the
  // difference between a control that looks broken and one that is waiting.
  // Rendered unconditionally rather than hidden when a spec is configured: the
  // drawer is built once and a rider can set a spec up without this panel
  // hearing about it, so a hidden-when-set row would be stale more often than
  // it was right. `refresh()` repaints it on reopen.
  const splitNeedsSpec = el("p", "account-hint");
  planning.append(splitNeedsSpec);

  // ---------------------------------------------------------------------
  // Calling dibs
  // ---------------------------------------------------------------------

  const dibs = section("Calling dibs");
  dibs.append(
    el(
      "p",
      "account-hint",
      "Dibs is a public claim on a scooter while you walk to it \u2014 a certificate anyone standing at it can read, so they know somebody is on the way.",
    ),
  );

  const autoStatus = makeStatus();
  const autoLabel = el("label", "switch account-switch");
  const autoInput = el("input");
  autoInput.type = "checkbox";
  autoLabel.append(autoInput, el("span", undefined, "Automatically call dibs"));
  const autoHint = el(
    "p",
    "account-hint",
    "On by default. When you pick a scooter off a route we claim it and start watching it, so you don\u2019t have to press anything while you\u2019re walking.",
  );
  autoInput.addEventListener("change", () => {
    autoStatus.set(setAutoDibs(autoInput.checked) ? "Saved." : NOT_PERSISTED);
  });
  dibs.append(autoLabel, autoHint, autoStatus.node);

  const smsStatus = makeStatus();
  const smsLabel = el("label", "switch account-switch");
  const smsInput = el("input");
  smsInput.type = "checkbox";
  // Named, because the dibs certificate links here ("turn SMS on or off") and
  // has to find the switch to scroll to it. `DIBS_SMS_SETTING_ID` is the
  // label, focusable even while the switch is disabled for want of a phone —
  // that is when the hint beside it matters most.
  smsInput.id = DIBS_SMS_TOGGLE_ID;
  smsLabel.id = DIBS_SMS_SETTING_ID;
  smsLabel.tabIndex = -1;
  smsLabel.append(
    smsInput,
    el("span", undefined, "Notify me via SMS if my dibs are disrespected"),
  );
  // Two hints, and which one shows is the whole of the gating. The reason a
  // control is disabled has to sit next to the control — a greyed switch with
  // no explanation reads as a broken app, and a rider cannot guess that the fix
  // is on a different tab.
  const smsHint = el("p", "account-hint");
  smsInput.addEventListener("change", () => {
    smsStatus.set(setDibsSmsAlerts(smsInput.checked) ? "Saved." : NOT_PERSISTED);
  });
  dibs.append(smsLabel, smsHint, smsStatus.node);

  /** Enable or disable the SMS switch, and say why.
   *
   *  `null` — the profile has not answered yet, or there is no session — is
   *  treated as "cannot offer this", NOT as "you have no phone". The difference
   *  matters: the second sentence tells a rider with a verified number to go
   *  and verify it, which is the app contradicting itself. */
  const paintSms = (): void => {
    const verified = deps.phoneVerified?.() ?? null;
    smsInput.disabled = verified !== true;
    smsLabel.classList.toggle("is-disabled", verified !== true);
    if (verified === true) {
      // SAYS WHAT WE CAN SEE. The fleet feed tells us a rental started on a
      // vehicle, never whose rental it is — so the text reports that, and
      // this hint promises the same thing rather than the stronger claim the
      // switch's own label makes. Over-promising here is how the first
      // alert about the rider's own ride reads as a bug.
      smsHint.textContent =
        "We\u2019ll text you if a rental starts on a scooter you called dibs on \u2014 we can\u2019t tell whose, so the message says so.";
      return;
    }
    smsHint.textContent =
      verified === false
        ? "Needs a verified phone number \u2014 add one under Profile, above these tabs, and verify it with the code we text you."
        : "Sign in and verify a phone number to turn this on.";
  };

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
  // SAID OUT LOUD, because it is the rider's home address and because the
  // answer changed. These used to be device-only. They still are signed out;
  // signed in they are copied to the account so a new phone starts with them,
  // and the copy is encrypted at rest there. Worded without reference to the
  // current session on purpose — this panel never asks whether anyone is
  // signed in, and a sentence that flipped as a token expired would be worse
  // than one that states both halves.
  favs.append(
    el(
      "p",
      "account-hint",
      "Kept on this device. While you’re signed in they’re also saved to your account, encrypted, so a new phone starts with them.",
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

  host.append(planning, dibs, favs);

  const refresh = (): void => {
    const cap = handOffCap();
    capSelect.value = cap === null ? "any" : String(cap);
    paintCapHint();
    splitSelect.value = routePriority();
    paintSplitHint();
    const hasSpec = deps.hasIdealSpec?.() ?? false;
    splitNeedsSpec.textContent = hasSpec
      ? "Your ideal scooter is set up — Filters → My ideal scooter to change it."
      : "You haven't set up an ideal scooter yet, so this has nothing to prefer. Filters → My ideal scooter.";
    autoInput.checked = autoDibs();
    smsInput.checked = dibsSmsAlerts();
    paintSms();
    rerenderSlots();
  };
  refresh();

  return {
    refresh,
    dispose() {
      disposed = true;
    },
  };
}
