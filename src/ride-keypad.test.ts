// @vitest-environment happy-dom
//
// The landscape keypad's input semantics, and the one contract the plan is
// explicit about: `inputmode="none"` while attached (never `readonly`), and the
// field's previous `inputmode` — `numeric`, the portrait/native path — restored
// on detach, so turning the phone back hands the native keyboard over.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEYPAD_INPUTMODE,
  NATIVE_NUMERIC_INPUTMODE,
  applyNativeNumericInput,
  createRideKeypad,
  sanitizeNumeric,
} from "./ride-keypad.ts";

function makeInput(maxLength?: number): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  applyNativeNumericInput(input, { maxLength });
  document.body.append(input);
  return input;
}

function key(root: HTMLElement, name: string): HTMLButtonElement {
  const btn = root.querySelector<HTMLButtonElement>(`[data-key="${name}"]`);
  if (!btn) throw new Error(`no key ${name}`);
  return btn;
}

function type(root: HTMLElement, digits: string): void {
  for (const d of digits) key(root, d).click();
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("sanitizeNumeric", () => {
  it("keeps digits only and honours the cap", () => {
    expect(sanitizeNumeric("10a2b5 543")).toBe("1025543");
    expect(sanitizeNumeric("1025543", 4)).toBe("1025");
    expect(sanitizeNumeric("77", 0)).toBe("");
    expect(sanitizeNumeric("77", -1)).toBe("77");
    expect(sanitizeNumeric("")).toBe("");
  });
});

describe("applyNativeNumericInput", () => {
  it("sets the portrait native-keyboard contract without changing the type", () => {
    const input = makeInput(7);
    expect(input.getAttribute("inputmode")).toBe(NATIVE_NUMERIC_INPUTMODE);
    expect(input.getAttribute("pattern")).toBe("[0-9]*");
    expect(input.type).toBe("text");
    expect(input.maxLength).toBe(7);
  });
});

describe("attach / detach", () => {
  it("switches inputmode to none — and never sets readonly", () => {
    const pad = createRideKeypad();
    const input = makeInput(7);
    pad.attach(input);
    expect(input.getAttribute("inputmode")).toBe(KEYPAD_INPUTMODE);
    expect(input.readOnly).toBe(false);
    expect(input.hasAttribute("readonly")).toBe(false);
    expect(input.dataset.rideKeypad).toBe("on");
    expect(pad.attachedInput()).toBe(input);
  });

  it("restores the previous inputmode on detach (portrait gets its keyboard back)", () => {
    const pad = createRideKeypad();
    const input = makeInput(7);
    pad.attach(input);
    pad.detach();
    expect(input.getAttribute("inputmode")).toBe(NATIVE_NUMERIC_INPUTMODE);
    expect(input.dataset.rideKeypad).toBeUndefined();
    expect(pad.attachedInput()).toBeNull();
  });

  it("removes the attribute entirely when the field had none", () => {
    const pad = createRideKeypad();
    const bare = document.createElement("input");
    document.body.append(bare);
    pad.attach(bare);
    expect(bare.getAttribute("inputmode")).toBe(KEYPAD_INPUTMODE);
    pad.detach();
    expect(bare.hasAttribute("inputmode")).toBe(false);
  });

  it("re-attaching to another field releases the first one", () => {
    const pad = createRideKeypad();
    const plate = makeInput(7);
    const battery = makeInput(3);
    pad.attach(plate);
    pad.attach(battery);
    expect(plate.getAttribute("inputmode")).toBe(NATIVE_NUMERIC_INPUTMODE);
    expect(battery.getAttribute("inputmode")).toBe(KEYPAD_INPUTMODE);
    expect(pad.attachedInput()).toBe(battery);
  });

  it("focuses the field by default, and not when told not to", () => {
    const pad = createRideKeypad();
    const a = makeInput(7);
    pad.attach(a);
    expect(document.activeElement).toBe(a);
    const b = makeInput(3);
    pad.attach(b, { focus: false });
    expect(document.activeElement).toBe(a);
  });

  it("detach is idempotent and destroy takes the element out of the DOM", () => {
    const pad = createRideKeypad();
    const input = makeInput(7);
    document.body.append(pad.element);
    pad.attach(input);
    pad.detach();
    pad.detach();
    pad.destroy();
    expect(pad.element.isConnected).toBe(false);
    expect(input.getAttribute("inputmode")).toBe(NATIVE_NUMERIC_INPUTMODE);
    // A destroyed keypad is inert.
    pad.attach(input);
    expect(pad.attachedInput()).toBeNull();
  });
});

describe("key semantics", () => {
  it("appends digits and stops at the field's maxlength", () => {
    const pad = createRideKeypad();
    const input = makeInput(4);
    pad.attach(input);
    type(pad.element, "102554");
    expect(input.value).toBe("1025");
  });

  it("honours the option cap when the field has no maxlength", () => {
    const pad = createRideKeypad({ maxLength: 3 });
    const bare = document.createElement("input");
    document.body.append(bare);
    pad.attach(bare);
    type(pad.element, "98765");
    expect(bare.value).toBe("987");
  });

  it("takes the tighter of the two caps", () => {
    const pad = createRideKeypad({ maxLength: 5 });
    const input = makeInput(2);
    pad.attach(input);
    type(pad.element, "9999");
    expect(input.value).toBe("99");
  });

  it("backspace removes the last character, clear empties the field", () => {
    const pad = createRideKeypad();
    const input = makeInput(7);
    pad.attach(input);
    type(pad.element, "102");
    key(pad.element, "backspace").click();
    expect(input.value).toBe("10");
    key(pad.element, "clear").click();
    expect(input.value).toBe("");
    // Backspace on an empty field is a no-op, not an error.
    key(pad.element, "backspace").click();
    expect(input.value).toBe("");
  });

  it("inserts at the caret and replaces a selection", () => {
    const pad = createRideKeypad();
    const input = makeInput(7);
    pad.attach(input);
    type(pad.element, "1053");
    input.setSelectionRange(2, 2);
    key(pad.element, "9").click();
    expect(input.value).toBe("10953");
    input.setSelectionRange(0, 2);
    key(pad.element, "7").click();
    expect(input.value).toBe("7953");
  });

  it("emits input and change on every mutation, and onDone on Done", () => {
    const onChange = vi.fn();
    const onDone = vi.fn();
    const onClear = vi.fn();
    const pad = createRideKeypad({ onChange, onDone, onClear });
    const input = makeInput(7);
    const inputEvents: string[] = [];
    const changeEvents: string[] = [];
    input.addEventListener("input", () => inputEvents.push(input.value));
    input.addEventListener("change", () => changeEvents.push(input.value));
    pad.attach(input);

    type(pad.element, "10");
    expect(inputEvents).toEqual(["1", "10"]);
    expect(changeEvents).toEqual(["1", "10"]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("10", input);

    key(pad.element, "clear").click();
    expect(onClear).toHaveBeenCalledWith(input);

    key(pad.element, "done").click();
    expect(onDone).toHaveBeenCalledWith("", input);
  });

  it("does nothing at all with no field attached", () => {
    const onChange = vi.fn();
    const pad = createRideKeypad({ onChange });
    type(pad.element, "1");
    key(pad.element, "backspace").click();
    key(pad.element, "done").click();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("accessibility", () => {
  it("is a labelled group of real buttons, all keyboard reachable", () => {
    const pad = createRideKeypad({ label: "Plate keypad" });
    document.body.append(pad.element);
    expect(pad.element.getAttribute("role")).toBe("group");
    expect(pad.element.getAttribute("aria-label")).toBe("Plate keypad");
    const keys = [...pad.element.querySelectorAll<HTMLButtonElement>("button")];
    // 0-9 + clear + backspace + done
    expect(keys).toHaveLength(13);
    for (const btn of keys) {
      expect(btn.type).toBe("button");
      expect(btn.tabIndex).toBe(0);
      expect((btn.textContent ?? "").length).toBeGreaterThan(0);
    }
    expect(key(pad.element, "backspace").getAttribute("aria-label")).toBe(
      "Backspace",
    );
  });

  it("points aria-controls at the field it drives", () => {
    const pad = createRideKeypad();
    const input = makeInput(7);
    input.id = "ride-plate";
    pad.attach(input);
    expect(pad.element.getAttribute("aria-controls")).toBe("ride-plate");
    pad.detach();
    expect(pad.element.hasAttribute("aria-controls")).toBe(false);
  });

  it("a pointer press keeps focus on the field instead of the key", () => {
    const pad = createRideKeypad();
    document.body.append(pad.element);
    const input = makeInput(7);
    pad.attach(input);
    const btn = key(pad.element, "5");
    const ev = new Event("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    btn.click();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("5");
  });
});
