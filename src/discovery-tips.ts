// Progressive discovery: small, show-once contextual tips instead of
// front-loading every advanced feature into onboarding. Each tip fires the
// FIRST time its moment happens (first Analysis open, first High-Risk popup,
// first Territory Control enable, the post-onboarding "tap any scooter"
// nudge) and never again — the seen flag persists per browser.
//
// Deliberately dumb: one floating toast at a time, dismissed by its ✕ or a
// timer. Who calls showTipOnce, and when, is main.ts's wiring business.

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

/** Show `message` as a floating tip exactly once per browser. Returns
 *  whether it displayed. A new tip replaces any tip still on screen —
 *  two stacked toasts read as noise, and the newer moment is the one the
 *  user is actually in. */
export function showTipOnce(key: string, message: string): boolean {
  if (tipSeen(key)) return false;
  markTipSeen(key);

  document.querySelector(".discovery-tip")?.remove();

  const tip = document.createElement("div");
  tip.className = "discovery-tip";
  tip.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "discovery-tip__text";
  text.textContent = message;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "discovery-tip__close";
  closeBtn.setAttribute("aria-label", "Dismiss tip");
  closeBtn.textContent = "×";

  const timer = setTimeout(() => tip.remove(), TIP_DISMISS_MS);
  closeBtn.addEventListener("click", () => {
    clearTimeout(timer);
    tip.remove();
  });

  tip.append(text, closeBtn);
  document.body.append(tip);
  return true;
}
