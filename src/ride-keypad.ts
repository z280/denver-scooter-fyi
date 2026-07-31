// Custom numeric keypad for the ride wizard's landscape layout.
//
// Why it exists (frontend plan, `ride-keypad.ts` row + owner's Screen 2 copy):
// in landscape the native keyboard eats the half of the screen the wizard needs
// for the options list, so Screen 2 renders our own keypad in the right pane
// and suppresses the system one. In PORTRAIT there is no keypad at all — the
// native keyboard is the right tool, reached with `inputmode="numeric"` on both
// confirm fields (the plate field stays `type="text"` + pattern-filtered so an
// alphanumeric plate would still type if Veo ever ships one; every observed Veo
// plate is all-digit today).
//
// The suppression contract, verbatim from the plan: while the custom keypad is
// attached the input carries `inputmode="none"` — the standard, reliable way to
// suppress the native keyboard on iOS Safari (≥12.2) and Android Chrome. NOT
// `readonly`: readonly has focus/caret quirks, suppresses `beforeinput`, and
// announces the field as read-only to assistive tech. `detach()` restores
// whatever `inputmode` the field had before, so turning the phone back to
// portrait hands the native keyboard straight back.
//
// The keypad is real buttons in a grid, so it is keyboard- and
// screen-reader-operable; pointer presses deliberately do NOT steal focus from
// the input (the caret stays visible and a physical keyboard keeps working),
// while Tab/Enter/Space activation behaves normally.

/** `inputmode` while the custom keypad owns the field. */
export const KEYPAD_INPUTMODE = "none";
/** `inputmode` for the portrait/native path on both confirm fields. */
export const NATIVE_NUMERIC_INPUTMODE = "numeric";

export interface RideKeypadOptions {
  /** Accessible name for the keypad group. */
  label?: string;
  /** Label for the commit key. Default "Done". */
  doneLabel?: string;
  /** Caps entry length when the bound input has no `maxlength` (or to cap it
   *  tighter). The input's own `maxlength` wins when it is the smaller. */
  maxLength?: number;
  /** Fired after every value mutation, with the input's new value. */
  onChange?(value: string, input: HTMLInputElement): void;
  /** Fired by the Done key (after its change event). Screen 2 uses it to move
   *  focus on to the next field / dismiss the keypad. */
  onDone?(value: string, input: HTMLInputElement): void;
  /** Fired by Clear, after the value is emptied. */
  onClear?(input: HTMLInputElement): void;
}

export interface RideKeypadHandle {
  /** The keypad element — the owning screen slots it into a pane. */
  readonly element: HTMLElement;
  /** Bind to an input: sets `inputmode="none"` and routes keys into it.
   *  Re-attaching to a different input detaches the previous one first, so the
   *  field left behind gets its native keyboard back. */
  attach(input: HTMLInputElement, opts?: { focus?: boolean }): void;
  /** Unbind and restore the input's previous `inputmode`. Idempotent. */
  detach(): void;
  attachedInput(): HTMLInputElement | null;
  /** Detach and remove the element from the DOM. */
  destroy(): void;
}

type KeyDef =
  | { kind: "digit"; digit: string }
  | { kind: "backspace" }
  | { kind: "clear" }
  | { kind: "done" };

/** Digits only, capped. The keypad can only produce digits, and this is also
 *  the portrait path's pattern filter (`input` listener on a `type="text"`
 *  plate field), so both keyboards agree on what a plate/battery value is. */
export function sanitizeNumeric(raw: string, maxLength?: number): string {
  const digits = (raw || "").replace(/\D+/g, "");
  if (maxLength === undefined || maxLength < 0) return digits;
  return digits.slice(0, maxLength);
}

/** Portrait/native defaults for a ride numeric field: the numeric keyboard, a
 *  digit pattern, no autofill noise. Deliberately leaves `type` alone — the
 *  plate field must stay `type="text"` (see the module header). */
export function applyNativeNumericInput(
  input: HTMLInputElement,
  opts: { maxLength?: number } = {},
): void {
  input.setAttribute("inputmode", NATIVE_NUMERIC_INPUTMODE);
  input.autocomplete = "off";
  input.setAttribute("pattern", "[0-9]*");
  if (opts.maxLength !== undefined) input.maxLength = opts.maxLength;
}

const KEY_ROWS: KeyDef[][] = [
  [
    { kind: "digit", digit: "1" },
    { kind: "digit", digit: "2" },
    { kind: "digit", digit: "3" },
  ],
  [
    { kind: "digit", digit: "4" },
    { kind: "digit", digit: "5" },
    { kind: "digit", digit: "6" },
  ],
  [
    { kind: "digit", digit: "7" },
    { kind: "digit", digit: "8" },
    { kind: "digit", digit: "9" },
  ],
  [{ kind: "clear" }, { kind: "digit", digit: "0" }, { kind: "backspace" }],
];

export function createRideKeypad(
  options: RideKeypadOptions = {},
): RideKeypadHandle {
  const label = options.label ?? "Numeric keypad";
  const root = el("div", "ride-keypad");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", label);

  let input: HTMLInputElement | null = null;
  /** The field's `inputmode` before we took it over — `null` = no attribute. */
  let restoreInputMode: string | null = null;
  let destroyed = false;

  const effectiveMax = (): number | undefined => {
    const fromAttr = input && input.maxLength >= 0 ? input.maxLength : undefined;
    const fromOpts = options.maxLength;
    if (fromAttr === undefined) return fromOpts;
    if (fromOpts === undefined) return fromAttr;
    return Math.min(fromAttr, fromOpts);
  };

  /** Write a value, keep the caret sane, then emit. Both `input` and `change`
   *  fire on every mutation: the native `change`-on-commit moment has no
   *  analogue here (the keypad never blurs the field), and Screen 2's
   *  plate-mismatch check has to see keypad edits through whichever of the two
   *  events it listens for. */
  const commit = (next: string, caret: number): void => {
    const target = input;
    if (!target) return;
    target.value = next;
    const pos = Math.max(0, Math.min(caret, next.length));
    try {
      target.setSelectionRange(pos, pos);
    } catch {
      // Some input types reject selection APIs; the value is what matters.
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    options.onChange?.(target.value, target);
  };

  const selection = (target: HTMLInputElement): [number, number] => {
    const len = target.value.length;
    const start = target.selectionStart ?? len;
    const end = target.selectionEnd ?? len;
    return start <= end ? [start, end] : [end, start];
  };

  const pressDigit = (digit: string): void => {
    const target = input;
    if (!target) return;
    const max = effectiveMax();
    const [start, end] = selection(target);
    const value = target.value;
    // A full field with no selection to overwrite ignores the press rather than
    // silently dropping the rider's first digits.
    if (max !== undefined && start === end && value.length >= max) return;
    const next = sanitizeNumeric(
      value.slice(0, start) + digit + value.slice(end),
      max,
    );
    commit(next, start + 1);
  };

  const pressBackspace = (): void => {
    const target = input;
    if (!target) return;
    const [start, end] = selection(target);
    const value = target.value;
    if (start !== end) {
      commit(value.slice(0, start) + value.slice(end), start);
      return;
    }
    if (start === 0) return;
    commit(value.slice(0, start - 1) + value.slice(start), start - 1);
  };

  const pressClear = (): void => {
    const target = input;
    if (!target) return;
    if (target.value !== "") commit("", 0);
    options.onClear?.(target);
  };

  const pressDone = (): void => {
    const target = input;
    if (!target) return;
    options.onDone?.(target.value, target);
  };

  const press = (key: KeyDef): void => {
    if (destroyed || !input) return;
    switch (key.kind) {
      case "digit":
        pressDigit(key.digit);
        break;
      case "backspace":
        pressBackspace();
        break;
      case "clear":
        pressClear();
        break;
      case "done":
        pressDone();
        break;
    }
  };

  const makeKey = (key: KeyDef): HTMLButtonElement => {
    const btn = el("button", "ride-keypad__key");
    btn.type = "button";
    switch (key.kind) {
      case "digit":
        btn.classList.add("ride-keypad__key--digit");
        btn.textContent = key.digit;
        btn.dataset.key = key.digit;
        break;
      case "backspace":
        btn.classList.add("ride-keypad__key--backspace");
        btn.textContent = "⌫";
        btn.dataset.key = "backspace";
        btn.setAttribute("aria-label", "Backspace");
        break;
      case "clear":
        btn.classList.add("ride-keypad__key--clear");
        btn.textContent = "Clear";
        btn.dataset.key = "clear";
        break;
      case "done":
        btn.classList.add("ride-keypad__key--done");
        btn.textContent = options.doneLabel ?? "Done";
        btn.dataset.key = "done";
        break;
    }
    // Pointer presses must not move focus off the input: the caret stays where
    // the rider can see it and a physical keyboard keeps typing into the field.
    // preventDefault on pointerdown/mousedown suppresses the focus shift
    // without suppressing the click (unlike touchstart, which can cancel it).
    const keepFocus = (e: Event): void => {
      e.preventDefault();
      input?.focus();
    };
    btn.addEventListener("pointerdown", keepFocus);
    btn.addEventListener("mousedown", keepFocus);
    btn.addEventListener("click", () => press(key));
    return btn;
  };

  for (const row of KEY_ROWS) {
    const rowEl = el("div", "ride-keypad__row");
    for (const key of row) rowEl.append(makeKey(key));
    root.append(rowEl);
  }
  const doneRow = el("div", "ride-keypad__row ride-keypad__row--done");
  doneRow.append(makeKey({ kind: "done" }));
  root.append(doneRow);

  const detach = (): void => {
    const target = input;
    input = null;
    if (!target) return;
    if (restoreInputMode === null) target.removeAttribute("inputmode");
    else target.setAttribute("inputmode", restoreInputMode);
    restoreInputMode = null;
    delete target.dataset.rideKeypad;
    root.removeAttribute("aria-controls");
  };

  return {
    element: root,
    attach(next, opts = {}) {
      if (destroyed) return;
      if (input === next) return;
      detach();
      input = next;
      restoreInputMode = next.getAttribute("inputmode");
      // Never `readonly` — see the module header.
      next.setAttribute("inputmode", KEYPAD_INPUTMODE);
      next.dataset.rideKeypad = "on";
      if (next.id) root.setAttribute("aria-controls", next.id);
      if (opts.focus !== false) {
        try {
          next.focus();
        } catch {
          /* not focusable yet (not in the document) — the screen re-focuses */
        }
      }
    },
    detach,
    attachedInput: () => input,
    destroy() {
      detach();
      destroyed = true;
      root.remove();
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
