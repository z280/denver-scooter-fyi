// The "Edit Profile" modal: the rider's contact details, off the Profile tab.
//
// WHY A MODAL. Email and phone are the two fields on this whole surface that a
// rider touches once and then never again — they are account plumbing, not
// settings. Kept inline they were the first thing on the Profile tab and the
// largest thing on it, with the phone-verification flow (send a code, type it
// back, resend) unfolding in the middle of the panel. So the tab now carries a
// single "Edit Profile" button and the fields live behind it.
//
// THIS MODULE OWNS NO FIELDS. It is a shell: `account.ts` builds the inputs with
// the same `textField` and `phoneVerificationRow` builders it always used, and
// hands them over as nodes. Every save path, every error message and the
// verification state machine stay exactly where they were and keep their tests;
// all that changed is which element they are appended to. Passing built nodes
// rather than a spec is what makes that true — a shell that described the fields
// would be a second place for them to drift.
//
// House rules, same as every other modal in this program: `createElement` only
// (never `innerHTML`), a `cleanupFns[]` teardown list, and a real focus trap
// (`modal-focus-trap.ts`). Escape and a backdrop click both close; focus
// returns to whatever opened it, because a rider who closes a dialog with the
// keyboard and lands at the top of the document has lost their place.

import { trapFocusWithin } from "./modal-focus-trap.ts";
import { applyCloseFace } from "./close-icon.ts";

export interface EditProfileModalDeps {
  /** The rows to show, in order. Built and owned by the caller. */
  fields: readonly HTMLElement[];
  /** Fired after the modal is gone. The Profile tab redraws its summary line
   *  from here, since a save inside may have changed what it says. */
  onClose?(): void;
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

/** Open it. Returns the close function so a caller can dismiss it
 *  programmatically — a lost session, for one, where leaving a form open over a
 *  signed-out drawer would invite edits that cannot be saved. */
export function openEditProfileModal(deps: EditProfileModalDeps): () => void {
  // One at a time. Opening a second over the first would detach the first's
  // Escape handler from anything reachable while leaving it registered.
  document
    .querySelector<HTMLButtonElement>(".account-editprofile__close")
    ?.click();

  const backdrop = el("div", "account-editprofile");
  const card = el("div", "account-editprofile__card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");

  const head = el("div", "account-editprofile__head");
  const title = el("h3", undefined, "Edit Profile");
  title.id = "account-editprofile-title";
  card.setAttribute("aria-labelledby", title.id);
  const closeBtn = applyCloseFace(el("button", "account-editprofile__close"));
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close Edit Profile");
  head.append(title, closeBtn);

  const body = el("div", "account-editprofile__body");
  body.append(
    el(
      "p",
      "account-hint",
      "How we reach you. A verified phone number can also sign you in.",
    ),
    ...deps.fields,
  );

  card.append(head, body);
  backdrop.append(card);

  const cleanupFns: (() => void)[] = [];
  let closed = false;
  // Where focus was when this opened. Captured before the dialog is attached,
  // because attaching and focusing moves it.
  const opener =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    // ASKED BEFORE THE NODE IS DETACHED, and that order is the whole point:
    // once `backdrop` is out of the document, `document.activeElement` has
    // already fallen back to `<body>`, which the detached backdrop does not
    // contain — so a check made afterwards says "focus is elsewhere" every
    // time and the opener never gets it back.
    const active = document.activeElement;
    const focusWasOurs =
      active === null || active === document.body || backdrop.contains(active);
    for (const fn of cleanupFns.splice(0)) fn();
    backdrop.remove();
    // Only when the dialog still had focus: if the rider has clicked some other
    // control in the drawer, yanking it back is the rude option.
    if (opener?.isConnected && focusWasOurs) opener.focus();
    deps.onClose?.();
  };

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  // Capture phase: a field inside may well want Escape for its own purposes
  // (clearing a combobox), and this must not take it from them — but nothing
  // in `deps.fields` does today, and the alternative, a bubbling listener on
  // document, fires after any element that stops propagation has swallowed it.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  cleanupFns.push(() => document.removeEventListener("keydown", onKey, true));

  document.body.append(backdrop);
  cleanupFns.push(trapFocusWithin(card, () => !closed));

  // The first field, not the ✕: a rider who pressed "Edit Profile" came to
  // type. Falls back to the card so the trap always has somewhere to recover.
  const first = body.querySelector<HTMLElement>(
    'input:not([disabled]), select:not([disabled]), button:not([disabled])',
  );
  (first ?? card).focus();

  return close;
}
