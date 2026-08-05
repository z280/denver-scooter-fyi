// @vitest-environment happy-dom
//
// The contract the iOS shake-to-undo fix rests on: a marked field's edits are
// applied BY US (so WebKit registers no undo entry, so a shaken phone has
// nothing to offer to undo), and typing still behaves exactly as it did — same
// caret, same `maxLength`, same `input`/`change` events the screens listen
// for. Anything we can't re-implement faithfully must fall through to WebKit
// rather than mangle the text.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  UNDO_FREE_ATTR,
  dropNativeUndoHistory,
  installUndoFreeTyping,
  isUndoFree,
  markUndoFree,
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
