// @vitest-environment happy-dom
//
// modal-focus-trap.ts — the shared Tab-trap for Screens 8/9/10's standalone
// overlays (see the module's own header for why this exists as a separate
// copy from ride-modal.ts's private trap). Covers: Tab wraps last → first
// and Shift+Tab wraps first → last, a focus landing outside the root gets
// pulled back onto the root, the "nothing focusable" fallback focuses the
// root itself, `isActive() === false` disables all of the above, and the
// returned teardown actually removes both listeners.
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetFocusTrapsForTests,
  ownsFocusRecovery,
  trapFocusWithin,
} from "./modal-focus-trap.ts";

function tab(shiftKey = false): void {
  const active = document.activeElement ?? document.body;
  active.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
  );
}

function buildDialog(): { root: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
  const root = document.createElement("div");
  root.setAttribute("role", "dialog");
  const first = document.createElement("button");
  first.textContent = "First";
  const middle = document.createElement("button");
  middle.textContent = "Middle";
  const last = document.createElement("button");
  last.textContent = "Last";
  root.append(first, middle, last);
  document.body.append(root);
  return { root, first, last };
}

afterEach(() => {
  document.body.replaceChildren();
  // The recovery stack is module state: a trap left registered by one test keeps
  // winning `ownsFocusRecovery` and silences every trap the next test builds.
  _resetFocusTrapsForTests();
});

describe("trapFocusWithin", () => {

  it("Tab from the last focusable wraps to the first", () => {
    const { root, first, last } = buildDialog();
    const untrap = trapFocusWithin(root);
    last.focus();
    tab();
    expect(document.activeElement).toBe(first);
    untrap();
  });

  it("Shift+Tab from the first focusable wraps to the last", () => {
    const { root, first, last } = buildDialog();
    const untrap = trapFocusWithin(root);
    first.focus();
    tab(true);
    expect(document.activeElement).toBe(last);
    untrap();
  });

  it("a focusin landing outside root is pulled back onto root", () => {
    const { root } = buildDialog();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    const untrap = trapFocusWithin(root);

    outside.focus();
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(document.activeElement).toBe(root);
    untrap();
  });

  it("Tab with nothing focusable inside focuses the root itself", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const untrap = trapFocusWithin(root);
    root.focus();
    tab();
    expect(document.activeElement).toBe(root);
    untrap();
  });

  it("does nothing once isActive() reports false (e.g. after the caller marks itself destroyed)", () => {
    const { root, last } = buildDialog();
    let destroyed = false;
    trapFocusWithin(root, () => !destroyed);
    destroyed = true;
    last.focus();
    tab();
    // No wrap happened — focus stayed exactly where Tab's default (untouched,
    // since this fake dispatch never actually moves focus itself) left it.
    expect(document.activeElement).toBe(last);
  });

  it("the returned teardown removes both listeners — no further trapping after calling it", () => {
    const { root, last } = buildDialog();
    const untrap = trapFocusWithin(root);
    untrap();
    last.focus();
    tab();
    expect(document.activeElement).toBe(last);

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(document.activeElement).toBe(outside);
  });
});

// ---------------------------------------------------------------------------
// Two dialogs at once
//
// Every trap listens for `focusin` on `document`, and `HTMLElement.focus()`
// dispatches `focusin` SYNCHRONOUSLY. So with two traps live, each recovering
// focus the other then rejects, recovery recursed on one stack until it died —
// reachable by opening the ride modal while the first-run tour was still up.
// The registry decides which trap is in charge: the last one registered that is
// still active and still in the document.
// ---------------------------------------------------------------------------

describe("two live traps", () => {
  /** A trap whose root's `focus()` dispatches `focusin`, as a real one does.
   *  happy-dom does not, and without it this file cannot reproduce the bug at
   *  all — it would be testing a DOM that cannot have it. */
  const dialogWithRealFocus = (): { root: HTMLElement; focusCalls: () => number } => {
    const root = document.createElement("div");
    root.setAttribute("role", "dialog");
    root.append(document.createElement("button"));
    document.body.append(root);
    let calls = 0;
    root.focus = (): void => {
      calls += 1;
      // Guard the harness itself, so a regression is a failed assertion rather
      // than a dead worker: real focus recursion would not stop here.
      if (calls > 50) return;
      root.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    };
    return { root, focusCalls: () => calls };
  };

  it("does not recurse when both would recover from each other", () => {
    const a = dialogWithRealFocus();
    const b = dialogWithRealFocus();
    const stopA = trapFocusWithin(a.root);
    const stopB = trapFocusWithin(b.root);

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // B is on top, so B recovers exactly once and A stands down. Before the
    // registry this was A→B→A→… until the stack gave out.
    expect(b.focusCalls()).toBe(1);
    expect(a.focusCalls()).toBe(0);

    stopB();
    stopA();
  });

  it("hands recovery back to the dialog underneath when the top one tears down", () => {
    const a = dialogWithRealFocus();
    const b = dialogWithRealFocus();
    const stopA = trapFocusWithin(a.root);
    const stopB = trapFocusWithin(b.root);
    stopB();

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(a.focusCalls()).toBe(1);
    stopA();
  });

  it("skips a top trap that has gone inactive without tearing down", () => {
    const a = dialogWithRealFocus();
    const b = dialogWithRealFocus();
    const stopA = trapFocusWithin(a.root);
    let bOpen = true;
    const stopB = trapFocusWithin(b.root, () => bOpen);
    bOpen = false;

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // A closed-but-not-disposed dialog must not leave the one underneath it
    // unable to hold focus.
    expect(a.focusCalls()).toBe(1);
    expect(b.focusCalls()).toBe(0);
    stopB();
    stopA();
  });

  it("skips a top trap whose root was detached without tearing down", () => {
    const a = dialogWithRealFocus();
    const b = dialogWithRealFocus();
    const stopA = trapFocusWithin(a.root);
    const stopB = trapFocusWithin(b.root);
    b.root.remove();

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(a.focusCalls()).toBe(1);
    stopB();
    stopA();
  });

  it("still lets a lone trap recover", () => {
    // The ordinary case, and the one a bad fix would break by standing every
    // trap down.
    const a = dialogWithRealFocus();
    const stopA = trapFocusWithin(a.root);

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(a.focusCalls()).toBe(1);
    stopA();
  });

  it("leaves focus alone when it lands inside the owning dialog", () => {
    const a = dialogWithRealFocus();
    const b = dialogWithRealFocus();
    const stopA = trapFocusWithin(a.root);
    const stopB = trapFocusWithin(b.root);

    b.root.querySelector("button")!.dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );

    expect(b.focusCalls()).toBe(0);
    expect(a.focusCalls()).toBe(0);
    stopB();
    stopA();
  });
});

describe("ownsFocusRecovery", () => {
  // Exported, so an unregistered root is a real input — `ride-modal.ts` asks
  // about its own root, and any future dialog with a hand-rolled trap can too.
  // These pin the two answers no trap inside this module can reach, because a
  // trap always registers before it asks.
  it("lets an unregistered caller recover when nothing claims the stack", () => {
    const root = document.createElement("div");
    document.body.append(root);
    // Standing down here would mean a dialog that joined no stack could never
    // hold focus at all — a worse failure than the one the stack exists to fix.
    expect(ownsFocusRecovery(root)).toBe(true);
  });

  it("refuses an unregistered caller while a live trap holds the stack", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const stop = trapFocusWithin(owner);

    const stranger = document.createElement("div");
    document.body.append(stranger);
    expect(ownsFocusRecovery(stranger)).toBe(false);
    expect(ownsFocusRecovery(owner)).toBe(true);
    stop();
  });

  it("goes back to allowing anyone once every trap has left", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    trapFocusWithin(owner)();

    const stranger = document.createElement("div");
    document.body.append(stranger);
    expect(ownsFocusRecovery(stranger)).toBe(true);
  });
});
