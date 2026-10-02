// @vitest-environment happy-dom
//
// The contract the iOS shake-to-undo fix rests on: a marked field's edits are
// applied BY US (so WebKit registers no undo entry, so a shaken phone has
// nothing to offer to undo), and typing still behaves exactly as it did — same
// caret, same `maxLength`, same `input`/`change` events the screens listen
// for. Anything we can't re-implement faithfully must fall through to WebKit
// rather than mangle the text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UNDO_FREE_ATTR,
  dropNativeUndoHistory,
  installUndoFreeTyping,
  isRideLive,
  isUndoFree,
  markUndoFree,
  resetUndoClearing,
  setRideLive,
} from "./ios-shake-undo.ts";

let dispose: (() => void) | null = null;

function field(
  opts: { tag?: "input" | "textarea"; type?: string; maxLength?: number; guard?: boolean } = {},
): HTMLInputElement | HTMLTextAreaElement {
  const node = document.createElement(opts.tag ?? "input");
  if (node instanceof HTMLInputElement) node.type = opts.type ?? "text";
  if (opts.maxLength !== undefined) node.maxLength = opts.maxLength;
  document.body.append(node);
  if (opts.guard !== false) markUndoFree(node);
  return node;
}

/** Dispatch the `beforeinput` WebKit would send, and report whether the
 *  default was prevented — i.e. whether we took the edit off WebKit's hands
 *  (no undo entry) or left it to the engine (undo entry). */
function beforeInput(
  target: HTMLElement,
  init: { inputType: string; data?: string | null; cancelable?: boolean; isComposing?: boolean },
): boolean {
  const e = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: init.cancelable ?? true,
    inputType: init.inputType,
    data: init.data ?? null,
    isComposing: init.isComposing ?? false,
  });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

/** Type through the guard the way a keyboard would, one character at a time. */
function type(target: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  for (const ch of text) beforeInput(target, { inputType: "insertText", data: ch });
}

function caret(target: HTMLInputElement | HTMLTextAreaElement): [number, number] {
  return [target.selectionStart ?? -1, target.selectionEnd ?? -1];
}

beforeEach(() => {
  dispose?.();
  document.body.replaceChildren();
  // A case that ends before its throwaway frame is dropped would leave the
  // coalescing flag set, making every later clear a no-op.
  resetUndoClearing();
  setRideLive(false);
  dispose = installUndoFreeTyping(document);
});

describe("marking", () => {
  it("is opt-in — an unmarked field is left entirely to WebKit", () => {
    const plain = field({ guard: false });
    expect(isUndoFree(plain)).toBe(false);
    expect(beforeInput(plain, { inputType: "insertText", data: "7" })).toBe(false);
    expect(plain.value).toBe(""); // happy-dom applies no default action either
  });

  it("marks with the documented attribute", () => {
    const input = field();
    expect(input.getAttribute(UNDO_FREE_ATTR)).toBe("on");
    expect(isUndoFree(input)).toBe(true);
  });

  it("covers fields mounted after install (the wizard rebuilds its screens)", () => {
    const late = field();
    type(late, "42");
    expect(late.value).toBe("42");
  });
});

describe("insertion", () => {
  it("applies typed text itself, so the edit never reaches WebKit's undo queue", () => {
    const input = field() as HTMLInputElement;
    expect(beforeInput(input, { inputType: "insertText", data: "1" })).toBe(true);
    type(input, "234");
    expect(input.value).toBe("1234");
    expect(caret(input)).toEqual([4, 4]);
  });

  it("inserts at the caret and replaces a selection", () => {
    const input = field() as HTMLInputElement;
    type(input, "1279");
    input.setSelectionRange(2, 2);
    type(input, "3");
    expect(input.value).toBe("12379");
    expect(caret(input)).toEqual([3, 3]);

    input.setSelectionRange(1, 4);
    type(input, "0");
    expect(input.value).toBe("109");
    expect(caret(input)).toEqual([2, 2]);
  });

  it("enforces maxLength, which the cancelled native path would have done", () => {
    const input = field({ maxLength: 4 }) as HTMLInputElement;
    type(input, "1234567");
    expect(input.value).toBe("1234");
  });

  it("still allows an over-long paste to fill the remaining room", () => {
    const input = field({ maxLength: 6 }) as HTMLInputElement;
    type(input, "12");
    const e = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertFromPaste",
      data: "3456789",
    });
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(input.value).toBe("123456");
  });

  it("turns Return into a newline in a textarea and defers on a single-line input", () => {
    const area = field({ tag: "textarea" }) as HTMLTextAreaElement;
    type(area, "ab");
    expect(beforeInput(area, { inputType: "insertLineBreak" })).toBe(true);
    expect(area.value).toBe("ab\n");

    const input = field() as HTMLInputElement;
    expect(beforeInput(input, { inputType: "insertLineBreak" })).toBe(false);
  });
});

describe("deletion", () => {
  it("backspaces one character, or the selection when there is one", () => {
    const input = field() as HTMLInputElement;
    type(input, "1234");
    expect(beforeInput(input, { inputType: "deleteContentBackward" })).toBe(true);
    expect(input.value).toBe("123");

    input.setSelectionRange(0, 2);
    beforeInput(input, { inputType: "deleteContentBackward" });
    expect(input.value).toBe("3");
    expect(caret(input)).toEqual([0, 0]);
  });

  it("deletes a whole astral character rather than half a surrogate pair", () => {
    const input = field() as HTMLInputElement;
    input.value = "a🛴";
    input.setSelectionRange(3, 3);
    beforeInput(input, { inputType: "deleteContentBackward" });
    expect(input.value).toBe("a");
  });

  it("handles forward, word and line deletes", () => {
    const input = field() as HTMLInputElement;
    input.value = "1600 Broadway";
    input.setSelectionRange(13, 13);
    beforeInput(input, { inputType: "deleteWordBackward" });
    expect(input.value).toBe("1600 ");

    input.value = "1600 Broadway";
    input.setSelectionRange(4, 4);
    beforeInput(input, { inputType: "deleteContentForward" });
    expect(input.value).toBe("1600Broadway");

    const area = field({ tag: "textarea" }) as HTMLTextAreaElement;
    area.value = "one\ntwo";
    area.setSelectionRange(7, 7);
    beforeInput(area, { inputType: "deleteSoftLineBackward" });
    expect(area.value).toBe("one\n");
  });

  it("does nothing at the ends of the value", () => {
    const input = field() as HTMLInputElement;
    input.setSelectionRange(0, 0);
    expect(beforeInput(input, { inputType: "deleteContentBackward" })).toBe(false);
    expect(input.value).toBe("");
  });
});

describe("what we deliberately hand back to WebKit", () => {
  it("defers on composition, uncancelable events and autocorrect replacements", () => {
    const input = field() as HTMLInputElement;
    expect(
      beforeInput(input, { inputType: "insertText", data: "あ", isComposing: true }),
    ).toBe(false);
    expect(
      beforeInput(input, { inputType: "insertText", data: "x", cancelable: false }),
    ).toBe(false);
    // Autocorrect's target range is the misspelled word, which a form control
    // doesn't expose — guessing from the caret would duplicate text.
    expect(
      beforeInput(input, { inputType: "insertReplacementText", data: "the" }),
    ).toBe(false);
    expect(input.value).toBe("");
  });

  it("leaves readonly and disabled fields alone", () => {
    const ro = field() as HTMLInputElement;
    ro.readOnly = true;
    expect(beforeInput(ro, { inputType: "insertText", data: "1" })).toBe(false);
  });

  it("refuses an undo that lands on a guarded field", () => {
    // Nothing of ours is in the queue, so a replayed edit here belongs to some
    // other field's history — blocking it beats rewriting a plate mid-ride.
    const input = field() as HTMLInputElement;
    type(input, "1234");
    expect(beforeInput(input, { inputType: "historyUndo" })).toBe(true);
    expect(input.value).toBe("1234");
  });
});

describe("events the screens listen for", () => {
  it("fires input per edit, carrying the inputType", () => {
    const input = field() as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener("input", (e) => {
      seen.push((e as InputEvent).inputType ?? "");
      expect(input.value).toBe("1"); // value is set before the event
    });
    type(input, "1");
    expect(seen).toEqual(["insertText"]);
  });

  it("stands in for the change-on-blur WebKit skips for script-set values", () => {
    const input = field() as HTMLInputElement;
    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    type(input, "1234");
    input.dispatchEvent(new Event("focusout", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the value never moved", () => {
    const input = field() as HTMLInputElement;
    const onChange = vi.fn();
    input.addEventListener("change", onChange);
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    input.dispatchEvent(new Event("focusout", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("defers to WebKit's own change event once an edit went native", () => {
    const input = field() as HTMLInputElement;
    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    type(input, "12");
    // Autocorrect fires natively — WebKit owns the control's dirty state now,
    // and doubling up would double-submit whatever listens for change.
    beforeInput(input, { inputType: "insertReplacementText", data: "34" });
    input.dispatchEvent(new Event("focusout", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("hands the fields back to WebKit", () => {
    const input = field() as HTMLInputElement;
    dispose?.();
    dispose = null;
    expect(beforeInput(input, { inputType: "insertText", data: "1" })).toBe(false);
  });
});

describe("dropNativeUndoHistory", () => {
  it("blurs whatever is focused and tears a subframe down again", () => {
    vi.useFakeTimers();
    const input = field() as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    dropNativeUndoHistory();
    expect(document.activeElement).not.toBe(input);
    expect(document.querySelectorAll("iframe").length).toBe(1);

    vi.advanceTimersByTime(50);
    expect(document.querySelectorAll("iframe").length).toBe(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// The regression. "Undo Typing" came back, and the one-shot clear at ride start
// is why.
//
// The module's own cause analysis says "the HUD has no text inputs at all" —
// true of the HUD, false of what opens OVER it. During a ride `devices.ts`
// keeps the device popup on a long press, and from it a rider reaches the
// model-report textarea (focused on open) and ☑️ Confirm Features' plate field.
// Both fill WebKit's queue after the single clear has spent its one shot, and
// every bump for the rest of the ride offers to undo them.
// ---------------------------------------------------------------------------

describe("clearing again, mid-ride", () => {
  beforeEach(() => {
    setRideLive(false);
  });

  afterEach(() => {
    setRideLive(false);
  });

  const frames = () => document.querySelectorAll("iframe").length;

  it("tracks whether a ride is up", () => {
    expect(isRideLive()).toBe(false);
    setRideLive(true);
    expect(isRideLive()).toBe(true);
    setRideLive(false);
    expect(isRideLive()).toBe(false);
  });

  it("takes another shot when an UNGUARDED field is left mid-ride", () => {
    setRideLive(true);
    // The report textarea: prose, so it deliberately keeps WebKit's own
    // editing (and its autocorrect) — which means WebKit holds an undo entry
    // the moment the rider types in it.
    const prose = field({ tag: "textarea", guard: false });
    prose.focus();
    prose.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(frames()).toBe(1);
  });

  it("does NOT fire for a guarded field, whose edits never entered the queue", () => {
    setRideLive(true);
    const plate = field() as HTMLInputElement;
    plate.focus();
    plate.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    beforeInput(plate, { inputType: "insertText", data: "1" });
    plate.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // Nothing to clear: the edit was applied by script, so it was never
    // registered. An iframe here would be pure churn.
    expect(frames()).toBe(0);
  });

  it("DOES fire for a guarded field whose edit was handed back to WebKit", () => {
    setRideLive(true);
    const plate = field() as HTMLInputElement;
    plate.focus();
    plate.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    // An uncancelable edit is WebKit's to own — and it puts an entry in the
    // queue that only this clear can remove.
    beforeInput(plate, { inputType: "insertText", data: "1", cancelable: false });
    plate.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(frames()).toBe(1);
  });

  it("does nothing at all when no ride is running", () => {
    setRideLive(false);
    // Off the scooter an undo entry is a feature. Emptying the queue behind a
    // rider typing an address in Account would take away a ⌘Z they may want.
    const prose = field({ tag: "textarea", guard: false });
    prose.focus();
    prose.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(frames()).toBe(0);
  });

  it("leaves focus alone — the rider is on their way to the next field", () => {
    setRideLive(true);
    const first = field({ guard: false }) as HTMLInputElement;
    const second = field({ guard: false }) as HTMLInputElement;
    second.focus();
    // `focusout` on the field being LEFT, with focus already moved on. The
    // ride-start clear blurs on purpose; this one must not fight for the caret.
    first.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(document.activeElement).toBe(second);
    expect(frames()).toBe(1);
  });

  it("still blurs on the ride-start clear", () => {
    const input = field() as HTMLInputElement;
    input.focus();
    dropNativeUndoHistory();
    expect(document.activeElement).not.toBe(input);
  });

  it("ignores a blur that was not a text field", () => {
    setRideLive(true);
    const btn = document.createElement("button");
    document.body.append(btn);
    btn.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(frames()).toBe(0);
  });
});

describe("coalescing the teardown", () => {
  afterEach(() => {
    setRideLive(false);
  });

  it("stacks no frames when a rider tabs through a form mid-ride", () => {
    vi.useFakeTimers();
    setRideLive(true);
    const a = field({ guard: false });
    const b = field({ guard: false });
    const c = field({ guard: false });
    for (const f of [a, b, c]) {
      f.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
    // They would all clear the same queue, and the pending one has not been
    // torn down yet — so it still catches everything registered up to its exit.
    expect(document.querySelectorAll("iframe").length).toBe(1);

    vi.advanceTimersByTime(50);
    expect(document.querySelectorAll("iframe").length).toBe(0);

    // ...and the next blur after that one has gone gets its own.
    a.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(document.querySelectorAll("iframe").length).toBe(1);
    vi.advanceTimersByTime(50);
    vi.useRealTimers();
  });
});

describe("the teardown backstop", () => {
  afterEach(() => {
    setRideLive(false);
    resetUndoClearing();
  });

  it("drops the frame even where requestAnimationFrame never fires", () => {
    // A backgrounded tab does not run rAF, and a coalescing flag left set there
    // would block every later clear for the rest of the ride — BRB plus a switch
    // away is all it takes.
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    dropNativeUndoHistory();
    expect(document.querySelectorAll("iframe").length).toBe(1);
    vi.advanceTimersByTime(100);
    expect(document.querySelectorAll("iframe").length).toBe(0);

    // ...and the next clear is not a no-op.
    dropNativeUndoHistory();
    expect(document.querySelectorAll("iframe").length).toBe(1);
    vi.advanceTimersByTime(100);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("drops it once, not twice, when both the frame and the timer fire", () => {
    vi.useFakeTimers();
    const rafs: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafs.push(cb);
      return 1;
    });
    dropNativeUndoHistory();
    expect(document.querySelectorAll("iframe").length).toBe(1);
    for (const cb of rafs) cb();
    expect(document.querySelectorAll("iframe").length).toBe(0);
    // The backstop arrives after the frame has already gone: idempotent, and it
    // must not clear a flag belonging to a LATER clear.
    dropNativeUndoHistory();
    expect(document.querySelectorAll("iframe").length).toBe(1);
    vi.advanceTimersByTime(100);
    expect(document.querySelectorAll("iframe").length).toBe(0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
