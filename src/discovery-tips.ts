// Progressive discovery: small, show-once contextual tips instead of
// front-loading every advanced feature into onboarding. Each tip fires the
// FIRST time its moment happens (first Analysis open, first High-Risk popup,
// first Territory Control enable, the post-onboarding "tap any scooter"
// nudge) and never again — the seen flag persists per browser.
//
// Deliberately dumb: one floating toast at a time, dismissed by its ✕ or a
// timer. Who calls showTipOnce, and when, is main.ts's wiring business.

import { applyCloseFace } from "./close-icon.ts";

/** Hyphenated prefix — UI preference, not app state. */
export const TIP_KEY_PREFIX = "scooter-fyi-tip-";

/** How long an undismissed tip lingers. Long enough to read twice; short
 *  enough that it never feels like chrome. */
export const TIP_DISMISS_MS = 14_000;

export function tipSeen(key: string): boolean {
  try {
    return localStorage.getItem(TIP_KEY_PREFIX + key) === "1";
  } catch {
    return true; // storage blocked: silence beats a tip on every load
  }
}

function markTipSeen(key: string): void {
  try {
    localStorage.setItem(TIP_KEY_PREFIX + key, "1");
  } catch {
    /* private mode — the tip just may show again next load */
  }
}

export interface TipOptions {
  /** Dock the tip INSIDE a surface, right after the element this returns,
   *  instead of floating it over the page. For a tip about something on a
   *  card — the high-risk tip explains the device card's verdict — a floating
   *  toast lands on that card's own buttons (it covered "Report" and
   *  "Details" on a phone). Called again whenever the tip is knocked out of
   *  the DOM: the device card re-renders its HTML once plates hydrate, and
   *  the tip moves into the new card rather than vanishing with the old one.
   *  `null` means the surface is gone (card closed): the tip goes with it. */
  anchor?: () => Element | null;
}

/** Show `message` as a floating tip exactly once per browser. Returns
 *  whether it displayed. A new tip replaces any tip still on screen —
 *  two stacked toasts read as noise, and the newer moment is the one the
 *  user is actually in. */
export function showTipOnce(
  key: string,
  message: string,
  opts: TipOptions = {},
): boolean {
  if (tipSeen(key)) return false;
  const anchor = opts.anchor ? opts.anchor() : null;
  // Asked to dock but the surface is already gone: keep the tip for the next
  // time rather than spend the one showing on nothing.
  if (opts.anchor && !anchor) return false;
  markTipSeen(key);

  document.querySelector(".discovery-tip")?.remove();

  const tip = document.createElement("div");
  tip.className = anchor ? "discovery-tip discovery-tip--inline" : "discovery-tip";
  tip.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "discovery-tip__text";
  text.textContent = message;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "discovery-tip__close";
  closeBtn.setAttribute("aria-label", "Dismiss tip");
  applyCloseFace(closeBtn);

  let observer: MutationObserver | null = null;
  const remove = (): void => {
    clearTimeout(timer);
    observer?.disconnect();
    observer = null;
    tip.remove();
  };
  const timer = setTimeout(remove, TIP_DISMISS_MS);
  closeBtn.addEventListener("click", remove);

  tip.append(text, closeBtn);
  if (anchor && opts.anchor) {
    const find = opts.anchor;
    anchor.after(tip);
    observer = new MutationObserver(() => {
      if (tip.isConnected) return;
      const next = find();
      if (next) next.after(tip);
      else remove();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.body.append(tip);
  }
  return true;
}
