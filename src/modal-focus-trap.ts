// Minimal, dependency-free Tab focus trap for a full-screen dialog overlay
// (`role="dialog"` `aria-modal="true"`) — the house rule every new modal in
// this program must satisfy (`docs/PLAN_RIDE_MODE_FRONTEND.md`'s house
// rules: "Focus trapping is required too... neither `ride-wizard.ts` nor
// `openFloatingModal` has one to copy"). `ride-modal.ts` wrote its own,
// private `trapFocus()` for the wizard shell; Screens 8/9/10 (`ride-post-*
// .ts`, via the `ride-post.ts` barrel) are deliberately standalone
// full-screen overlays OUTSIDE that chrome (see ride-post-s8.ts's
// ARCHITECTURE note for why), so they need the same discipline without a
// risky refactor of ride-modal.ts's already-tested private implementation.
// This module is that shared copy — logic mirrors `ride-modal.ts`'s
// `trapFocus()`/`focusableWithin()` field-for-field.

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(node: HTMLElement): boolean {
  // offsetParent is null for display:none (and for a node not yet attached
  // to the document) — happy-dom and real browsers agree on this enough for
  // "is this something Tab could actually land on".
  return node.offsetParent !== null || node === document.activeElement;
}

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isVisible);
}

/** Keep Tab inside `root` and pull focus back onto `root` itself if anything
 *  outside steals it (programmatic focus, or the browser cycling in from its
 *  own chrome) — same recovery `ride-modal.ts`'s own trap uses, recovering
 *  onto the dialog root rather than a specific control so Tab from there
 *  walks the content normally. Returns a teardown; call it when the dialog
 *  closes. `isActive()` lets one call survive a `replaceChildren()` rebuild
 *  (a re-render) rather than needing to be re-attached on every paint —
 *  every one of this module's callers rebuilds its body on every state
 *  change but keeps the same outer `root` node for the dialog's lifetime. */
export function trapFocusWithin(
  root: HTMLElement,
  isActive: () => boolean = () => true,
): () => void {
  if (!root.hasAttribute("tabindex")) root.tabIndex = -1;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Tab" || !isActive()) return;
    const focusables = focusableWithin(root);
    if (focusables.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === root || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last || !root.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener("keydown", onKeyDown);

  const onFocusIn = (e: FocusEvent): void => {
    if (!isActive()) return;
    const target = e.target;
    if (target instanceof Node && root.contains(target)) return;
    root.focus();
  };
  document.addEventListener("focusin", onFocusIn);

  return () => {
    root.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("focusin", onFocusIn);
  };
}
