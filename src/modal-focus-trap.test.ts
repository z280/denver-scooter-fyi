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
import { trapFocusWithin } from "./modal-focus-trap.ts";

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

describe("trapFocusWithin", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

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
