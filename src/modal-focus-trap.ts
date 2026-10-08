// Minimal, dependency-free Tab focus trap for a full-screen dialog overlay
// (`role="dialog"` `aria-modal="true"`) — the house rule every new modal in
// this program must satisfy (`docs/implemented/PLAN_RIDE_MODE_FRONTEND.md`'s house
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

// ---------------------------------------------------------------------------
// WHO OWNS FOCUS WHEN TWO DIALOGS ARE OPEN
//
// Every trap listens for `focusin` on `document`, because programmatic focus can
// land outside a dialog without a Tab keydown ever reaching it. With two traps
// live at once that recovery is mutually recursive, and `HTMLElement.focus()`
// dispatches `focusin` SYNCHRONOUSLY, so it recurses on one stack:
//
//   focus lands in B  ->  A sees a target outside A, focuses A's root
//                     ->  B sees a target outside B, focuses B's card
//                     ->  A sees a target outside A, ...            (stack dies)
//
// Reachable by opening the ride modal while the first-run tour is still up. Each
// trap on its own is correct; what was missing was any notion of which one is in
// charge.
//
// This registry supplies it: the LAST trap to register that is still active and
// still in the document owns focus recovery, and every other trap stands down
// until it leaves. That is also the right behaviour independently of the crash —
// a dialog opened over another dialog owns focus, and the one underneath should
// not be clawing it back.
//
// `ride-modal.ts` has its own, older, private trap (it predates this module and
// its own comment explains why it was not folded in). It registers here too, so
// the two cannot fight. Only `focusin` needs this: the Tab handlers listen on
// each trap's own root, so an event only ever reaches the trap containing it.
// ---------------------------------------------------------------------------

interface TrapEntry {
  root: HTMLElement;
  isActive: () => boolean;
}

const traps: TrapEntry[] = [];

/** Join the focus-recovery stack. Returns the leave function, which callers
 *  MUST run on teardown — a trap left registered over a detached root would keep
 *  winning `ownsFocusRecovery` and silence every trap below it. (The
 *  `isConnected` check below is the belt to that braces, not a substitute.) */
export function registerFocusTrap(
  root: HTMLElement,
  isActive: () => boolean = () => true,
): () => void {
  const entry: TrapEntry = { root, isActive };
  traps.push(entry);
  return () => {
    const i = traps.indexOf(entry);
    if (i >= 0) traps.splice(i, 1);
  };
}

/** Does `root`'s trap currently own pulling stray focus back?
 *
 *  The topmost registered trap that is both active and still in the document.
 *  Inactive or detached entries are skipped rather than ending the search, so a
 *  dialog that has closed without tearing down cannot leave the one underneath
 *  it unable to hold focus. */
export function ownsFocusRecovery(root: HTMLElement): boolean {
  for (let i = traps.length - 1; i >= 0; i -= 1) {
    const entry = traps[i];
    if (!entry.isActive() || !entry.root.isConnected) continue;
    return entry.root === root;
  }
  // Nothing is holding focus — an unregistered caller may as well recover.
  return true;
}

/** TEST-ONLY. The registry is module state, so one test's undisposed trap
 *  silences the next test's. */
export function _resetFocusTrapsForTests(): void {
  traps.length = 0;
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

  const leaveStack = registerFocusTrap(root, isActive);

  const onFocusIn = (e: FocusEvent): void => {
    if (!isActive()) return;
    // A dialog opened over this one owns focus now. Without this the two
    // recover from each other on one synchronous stack until it gives out.
    if (!ownsFocusRecovery(root)) return;
    const target = e.target;
    if (target instanceof Node && root.contains(target)) return;
    root.focus();
  };
  document.addEventListener("focusin", onFocusIn);

  return () => {
    root.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("focusin", onFocusIn);
    leaveStack();
  };
}
