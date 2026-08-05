// Keeping iOS's "shake to undo" alert off the rider's face during a ride.
//
// THE SYMPTOM: iPhone riders get "Undo Typing / Cancel" alerts over the HUD,
// over and over, for the whole ride. A scooter deck is a continuous shake
// generator, so anything that arms the shake gesture fires constantly.
//
// THE CAUSE (best reading of WebKit's behaviour — see the on-device probe at
// `public/shake-undo-probe.html`): it is NOT that we leave a text field
// focused. The HUD has no text inputs at all, and the wizard screens are torn
// out of the DOM (`RideModal` calls `replaceChildren()`) before the HUD comes
// up. What survives is the UNDO STACK. WebKit keeps one undo queue per web
// view — shared across every text field, and deliberately not cleared when a
// field is blurred or tabbed out of (that is what makes ⌘Z keep working after
// you leave a field). We never navigate: the whole app is one document for
// the life of the session. So the handful of characters a rider types into
// the plate field / sign-in code / destination search before they start
// rolling leaves undo entries sitting in that queue, and iOS offers to undo
// them on every bump in the road, long after the field itself is gone.
//
// There is no web API to turn the gesture off (`applicationSupportsShakeToEdit`
// is UIKit-only, and we are a PWA, not a native shell), and Settings →
// Accessibility → Touch → Shake to Undo is the rider's switch, not ours. What
// we CAN control is whether there is ever anything in the queue to undo:
//
//   1. PREVENTION (`installUndoFreeTyping` + `markUndoFree`) — the real fix.
//      WebKit only registers an undo entry for an edit IT performs. A value
//      written by script (`field.value = …`) registers nothing; this is
//      already why the landscape keypad in `ride-keypad.ts` never provokes the
//      alert. So on the ride flow's text fields we cancel `beforeinput` and
//      apply the same edit ourselves. The rider still gets the native
//      keyboard and types normally — the edit just never enters the undo
//      queue. The trade is that ⌘Z/shake no longer undoes typing in those
//      fields, which is exactly what we want here.
//
//   2. CLEARING (`dropNativeUndoHistory`) — belt to prevention's braces, run
//      when the HUD goes live. Anything typed before the guard was installed,
//      or via an edit we deliberately left to WebKit (see `planEdit`'s bail
//      cases), is already in the queue and cannot be popped from script.
//      Tearing down a subframe makes WebKit clear the page's edit commands,
//      which empties it. This one leans on WebKit internals rather than a
//      spec, so it is strictly best-effort and wrapped accordingly.
//
// Deliberately not UA-gated. The behaviour is harmless everywhere else (a
// plate field does not need an undo history on any platform), and a
// mechanism that only ever runs on iOS is a mechanism that never runs in
// dev or in tests.

/** Marks a field whose edits must not enter WebKit's undo queue. Set through
 *  `markUndoFree()`; read by the delegated `beforeinput` guard. */
export const UNDO_FREE_ATTR = "data-undo-free";

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** `<input type>`s that hold plain user-typed text and support the selection
 *  API. `password` is left out on purpose: nothing in the ride flow uses one,
 *  and re-implementing edits on a field we cannot read back safely is not a
 *  trade worth making. */
const TEXTY_INPUT_TYPES = new Set(["text", "search", "tel", "url", "email"]);

/** Opt a field into script-applied editing. Fields are opt-in rather than
 *  blanket-guarded so prose fields (the post-ride notes textarea, say) keep
 *  WebKit's own editing — autocorrect there matters more than the alert does,
 *  since the rider is parked by then. */
export function markUndoFree(field: TextField): void {
  field.setAttribute(UNDO_FREE_ATTR, "on");
}

export function isUndoFree(field: Element): boolean {
  return field.getAttribute(UNDO_FREE_ATTR) === "on";
}

/** Install the guard. One delegated capture-phase listener covers every
 *  marked field, including ones mounted later — the wizard rebuilds its
 *  screens constantly, so per-field wiring would have to be re-run on every
 *  render. Returns a disposer. */
export function installUndoFreeTyping(
  root: Document | HTMLElement = document,
): () => void {
  const onBeforeInput = (e: Event): void => {
    handleBeforeInput(e as InputEvent);
  };
  const onFocusIn = (e: Event): void => {
    const field = e.target;
    if (!isTextField(field) || !isUndoFree(field)) return;
    focusState.set(field, { valueAtFocus: field.value, sawNativeEdit: false });
  };
  const onFocusOut = (e: Event): void => {
    const field = e.target;
    if (!isTextField(field)) return;
    const state = focusState.get(field);
    focusState.delete(field);
    if (!state || state.sawNativeEdit) return; // WebKit will fire its own
    // Every edit went through us, and a script-written value does not make
    // the control "dirty" in WebKit's eyes — so its change-on-blur never
    // fires. Stand in for it, once, and only if the value actually moved.
    if (field.value !== state.valueAtFocus) {
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  root.addEventListener("beforeinput", onBeforeInput, true);
  root.addEventListener("focusin", onFocusIn, true);
  root.addEventListener("focusout", onFocusOut, true);
  return () => {
    root.removeEventListener("beforeinput", onBeforeInput, true);
    root.removeEventListener("focusin", onFocusIn, true);
    root.removeEventListener("focusout", onFocusOut, true);
  };
}

interface FocusState {
  valueAtFocus: string;
  /** An edit we handed back to WebKit — it owns the `change` event now, and
   *  it has put an entry in the undo queue that only `dropNativeUndoHistory`
   *  can clear. */
  sawNativeEdit: boolean;
}
const focusState = new WeakMap<TextField, FocusState>();

function handleBeforeInput(e: InputEvent): void {
  const field = e.target;
  if (!isTextField(field) || !isUndoFree(field)) return;
  if (field.readOnly || field.disabled) return;

  if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
    // A shake the rider accepted (or ⌘Z from a paired keyboard) landing on a
    // guarded field. Our edits are not in the queue, so whatever WebKit would
    // replay here belongs to some other field's history — refuse it rather
    // than let it rewrite a plate number mid-ride.
    if (e.cancelable) e.preventDefault();
    return;
  }

  // Composition (IME) and uncancelable edits are WebKit's to own; forcing our
  // way in mangles the text far more visibly than an undo alert.
  if (e.isComposing || !e.cancelable) {
    noteNativeEdit(field);
    return;
  }

  const edit = planEdit(field, e);
  if (!edit) {
    noteNativeEdit(field);
    return;
  }

  e.preventDefault();
  field.value = edit.value;
  try {
    field.setSelectionRange(edit.caret, edit.caret);
  } catch {
    // Selection APIs can throw on some input types; the value is what matters.
  }
  field.dispatchEvent(makeInputEvent(e.inputType, edit.data));
}

function noteNativeEdit(field: TextField): void {
  const state = focusState.get(field);
  if (state) state.sawNativeEdit = true;
}

interface PlannedEdit {
  value: string;
  caret: number;
  /** Echoed onto the synthetic `input` event so listeners see what native
   *  typing would have given them. */
  data: string | null;
}

/** Work out the field's next value, or `null` to let WebKit do this one.
 *  Bailing costs an undo entry, so bail only where faithfully re-implementing
 *  the edit is genuinely out of reach. */
function planEdit(field: TextField, e: InputEvent): PlannedEdit | null {
  const rawStart = field.selectionStart;
  const rawEnd = field.selectionEnd;
  if (rawStart === null || rawEnd === null) return null;
  const value = field.value;
  const start = Math.min(rawStart, rawEnd);
  const end = Math.max(rawStart, rawEnd);
  const type = e.inputType;

  if (type.startsWith("insert")) {
    const text = insertionText(field, e);
    if (text === null) return null;
    const clamped = clampToMaxLength(field, value, end - start, text);
    return {
      value: value.slice(0, start) + clamped + value.slice(end),
      caret: start + clamped.length,
      data: text,
    };
  }

  if (type.startsWith("delete")) {
    const range = deletionRange(type, value, start, end);
    if (!range) return null;
    return {
      value: value.slice(0, range[0]) + value.slice(range[1]),
      caret: range[0],
      data: null,
    };
  }

  // Formatting commands (`formatBold` and friends) never reach a form
  // control in practice, and we have no faithful answer for them.
  return null;
}

function insertionText(field: TextField, e: InputEvent): string | null {
  switch (e.inputType) {
    case "insertText":
      return e.data ?? null;
    case "insertFromPaste":
    case "insertFromDrop":
    case "insertFromYank":
      // `dataTransfer` is the paste's real payload; `data` is a fallback some
      // engines fill in instead. No plain text either way → WebKit's problem.
      return e.dataTransfer?.getData("text/plain") ?? e.data ?? null;
    case "insertLineBreak":
    case "insertParagraph":
      // A single-line input ignores these (or submits the form) — leave that
      // to WebKit, which will not register an undo entry for a no-op.
      return field instanceof HTMLTextAreaElement ? "\n" : null;
    default:
      // `insertReplacementText` (autocorrect, dictation fix-ups) lands here on
      // purpose: the range it replaces is the misspelled word, which a form
      // control does not expose through `getTargetRanges()`, so guessing from
      // the caret would duplicate text rather than replace it.
      return null;
  }
}

/** `maxLength` is enforced by the browser's own editing path — which we just
 *  cancelled — so it is ours to apply. */
function clampToMaxLength(
  field: TextField,
  value: string,
  replacedLength: number,
  text: string,
): string {
  const max = field.maxLength;
  if (max < 0) return text;
  const room = max - (value.length - replacedLength);
  return room <= 0 ? "" : text.slice(0, room);
}

/** `[from, to)` to remove, or `null` when there is nothing to delete. */
function deletionRange(
  type: string,
  value: string,
  start: number,
  end: number,
): [number, number] | null {
  // Any non-empty selection is deleted wholesale, whatever the flavour of
  // delete asked for it — that is what every engine does.
  if (start !== end) return [start, end];

  switch (type) {
    case "deleteContentBackward":
      return start === 0 ? null : [prevCodePoint(value, start), start];
    case "deleteContentForward":
      return end === value.length ? null : [end, nextCodePoint(value, end)];
    case "deleteWordBackward":
      return start === 0 ? null : [wordStart(value, start), start];
    case "deleteWordForward":
      return end === value.length ? null : [end, wordEnd(value, end)];
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
      return start === 0 ? null : [lineStart(value, start), start];
    case "deleteSoftLineForward":
    case "deleteHardLineForward":
      return end === value.length ? null : [end, lineEnd(value, end)];
    case "deleteEntireSoftLine":
      return [lineStart(value, start), lineEnd(value, end)];
    default:
      // `deleteByCut` / `deleteByDrag` with nothing selected delete nothing.
      return null;
  }
}

/** Step one code point, so an emoji or other astral character leaves as a
 *  unit instead of as half a surrogate pair. */
function prevCodePoint(value: string, at: number): number {
  const cp = value.codePointAt(at - 2);
  return cp !== undefined && cp > 0xffff ? at - 2 : at - 1;
}

function nextCodePoint(value: string, at: number): number {
  const cp = value.codePointAt(at);
  return cp !== undefined && cp > 0xffff ? at + 2 : at + 1;
}

const SPACE = /\s/;

function wordStart(value: string, at: number): number {
  let i = at;
  while (i > 0 && SPACE.test(value[i - 1]!)) i--;
  while (i > 0 && !SPACE.test(value[i - 1]!)) i--;
  return i;
}

function wordEnd(value: string, at: number): number {
  let i = at;
  while (i < value.length && SPACE.test(value[i]!)) i++;
  while (i < value.length && !SPACE.test(value[i]!)) i++;
  return i;
}

function lineStart(value: string, at: number): number {
  const i = value.lastIndexOf("\n", at - 1);
  return i < 0 ? 0 : i + 1;
}

function lineEnd(value: string, at: number): number {
  const i = value.indexOf("\n", at);
  return i < 0 ? value.length : i;
}

function makeInputEvent(inputType: string, data: string | null): Event {
  try {
    return new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType,
      data,
    });
  } catch {
    // Environments without the InputEvent constructor still need the plain
    // `input` notification — every listener in the app reads `.value`.
    return new Event("input", { bubbles: true });
  }
}

function isTextField(node: EventTarget | null): node is TextField {
  if (typeof HTMLTextAreaElement !== "undefined" && node instanceof HTMLTextAreaElement) {
    return true;
  }
  if (typeof HTMLInputElement !== "undefined" && node instanceof HTMLInputElement) {
    return TEXTY_INPUT_TYPES.has(node.type);
  }
  return false;
}

/** Best-effort emptying of WebKit's undo queue, plus the obvious hygiene of
 *  not leaving a field focused when the HUD takes the screen.
 *
 *  The queue itself is unreachable from script — there is no API to pop it,
 *  and draining it with `execCommand("undo")` would only refill the redo side
 *  (which iOS offers on a shake just the same). What DOES clear it is a frame
 *  going away: WebKit clears the page's registered edit commands when a
 *  frame's editor is torn down. So we mount a throwaway subframe and drop it.
 *
 *  Unverified against a device from here, cheap enough to be worth trying
 *  anyway, and entirely contained: if WebKit ever stops behaving this way,
 *  the cost is one empty iframe that lived for a frame or two. Prevention
 *  above is what the fix actually rests on. */
export function dropNativeUndoHistory(): void {
  try {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  } catch {
    /* nothing focusable — fine */
  }

  try {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", "");
    frame.tabIndex = -1;
    frame.src = "about:blank";
    frame.style.cssText =
      "position:absolute;left:-9999px;top:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
    document.body.append(frame);
    // Let the about:blank load commit before tearing it down — the teardown
    // is the part that clears the edit commands.
    const drop = (): void => frame.remove();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(drop);
    else setTimeout(drop, 0);
  } catch {
    /* no DOM to work with (SSR/tests) — the prevention path carries it */
  }
}
