// The "it moved" toast — the in-app half of a move-watch alert.
//
// This file also used to hold the Tools drawer's Watched scooters list. That
// list merged with My dibs into one row-per-scooter list on 2026-10-09
// (`tools-mine.ts`), which is where watches are now shown and stopped. What
// stays here is the alert itself.
//
// NO LOCATION IN THE ALERT, which is ALONG_THE_WAY_PLAN §4.4's rule and
// `device-notify.ts`'s: the toast says only that the scooter went.

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** The in-app half of the alert.
 *
 *  ALWAYS SHOWN, alongside the lock-screen notification or instead of it: a
 *  rider looking at the screen should not be the one person who misses the
 *  message, and most will have denied or never been asked for notification
 *  permission. Shares `.dibs-toast`'s geometry and styling deliberately — this
 *  and "someone took your dibs" are the same kind of interruption about the
 *  same kind of fact, and two toast designs in one app is two things to
 *  maintain and one inconsistency for the rider.
 *
 *  Not auto-dismissed. "It moved" is the whole content of the message and there
 *  is no second chance to read it — unlike a countdown, which is still true a
 *  minute later. */
export function showMovedToast(
  message: string,
  onShow?: () => void,
): void {
  document.querySelector(".dibs-toast")?.remove();

  const toast = el("div", "dibs-toast dibs-toast--urgent notify-moved-toast");
  // `alert`, not `status`: this interrupts on purpose.
  toast.setAttribute("role", "alert");

  const body = el("div", "dibs-toast__text");
  body.append(el("strong", "", message));
  toast.append(el("span", "dibs-toast__glyph", "🔔"), body);

  if (onShow) {
    const show = el("button", "dibs-toast__view", "Show me");
    show.type = "button";
    show.addEventListener("click", () => {
      toast.remove();
      onShow();
    });
    toast.append(show);
  }

  const close = el("button", "dibs-toast__view", "Dismiss");
  close.type = "button";
  close.addEventListener("click", () => toast.remove());
  toast.append(close);

  document.body.append(toast);
}
