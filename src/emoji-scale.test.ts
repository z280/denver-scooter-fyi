// @vitest-environment happy-dom
//
// The five-face scale: the two mappings onto the API's existing numeric
// columns, and the control's accessibility contract. See `emoji-scale.ts` for
// why the wire format deliberately did not change, and why the two mappings are
// not the same function.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SATISFACTION_STEPS,
  buildEmojiScale,
  npsToStep,
  stepLabel,
  stepToNps,
  stepToTenScale,
  tenScaleToStep,
} from "./emoji-scale.ts";

describe("the 1–10 rating mapping", () => {
  it("spreads the five faces evenly across the column's range", () => {
    expect([1, 2, 3, 4, 5].map(stepToTenScale)).toEqual([2, 4, 6, 8, 10]);
  });

  it("stays inside the API's ge=1 le=10 bounds for every face", () => {
    for (const { step } of SATISFACTION_STEPS) {
      const v = stepToTenScale(step);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(10);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("round-trips every face", () => {
    for (const { step } of SATISFACTION_STEPS) {
      expect(tenScaleToStep(stepToTenScale(step))).toBe(step);
    }
  });

  it("puts a value from the old ten-button row on the nearest face", () => {
    // A 7 was a real answer typed by a real rider; refusing it would lose a
    // stored survey rather than render it.
    expect(tenScaleToStep(7)).toBe(4);
    expect(tenScaleToStep(1)).toBe(1);
    expect(tenScaleToStep(5)).toBe(3);
  });

  it("reads nothing as nothing", () => {
    expect(tenScaleToStep(null)).toBeNull();
    expect(tenScaleToStep(undefined)).toBeNull();
    expect(tenScaleToStep(Number.NaN)).toBeNull();
  });

  it("clamps a step outside 1–5 rather than emitting an out-of-range value", () => {
    expect(stepToTenScale(0)).toBe(2);
    expect(stepToTenScale(99)).toBe(10);
    expect(stepToTenScale(Number.NaN)).toBe(2);
  });
});

describe("the NPS mapping", () => {
  it("respects NPS's own bands instead of spreading evenly", () => {
    // 0–6 detractor, 7–8 passive, 9–10 promoter. A linear map (0/3/5/8/10)
    // would have put the middle face at 5 and still called the fourth passive —
    // but the point is that only the TOP face is a promoter and the middle one
    // sits at the top of the detractor band, not halfway down it.
    expect([1, 2, 3, 4, 5].map(stepToNps)).toEqual([0, 3, 6, 8, 10]);
    const bandOf = (v: number) => (v <= 6 ? "detractor" : v <= 8 ? "passive" : "promoter");
    expect([1, 2, 3, 4, 5].map((s) => bandOf(stepToNps(s)))).toEqual([
      "detractor",
      "detractor",
      "detractor",
      "passive",
      "promoter",
    ]);
  });

  it("stays inside the API's ge=0 le=10 bounds", () => {
    for (const { step } of SATISFACTION_STEPS) {
      const v = stepToNps(step);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
    }
  });

  it("round-trips every face", () => {
    for (const { step } of SATISFACTION_STEPS) {
      expect(npsToStep(stepToNps(step))).toBe(step);
    }
  });

  it("puts a stored score on the nearest face, breaking a tie upward", () => {
    // 7 is exactly between the 6 and 8 faces, and those two are in DIFFERENT
    // bands — rounding down would read a passive rider back as a detractor.
    expect(npsToStep(7)).toBe(4);
    expect(npsToStep(9)).toBe(5); // promoter, nearest 10
    expect(npsToStep(1)).toBe(1);
    expect(npsToStep(5)).toBe(3); // still a detractor, as 5 is
    expect(npsToStep(null)).toBeNull();
  });

  it("is NOT the same function as the rating mapping", () => {
    // Guards against a future "simplification" that collapses the two and
    // silently reclassifies two of the five faces.
    expect([1, 2, 3, 4, 5].map(stepToNps)).not.toEqual(
      [1, 2, 3, 4, 5].map(stepToTenScale),
    );
  });
});

describe("the control", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    host = document.createElement("div");
    document.body.append(host);
  });

  function build(value: number | null = null) {
    const onSelect = vi.fn();
    const el = buildEmojiScale({ question: "How was it?", value, onSelect });
    host.append(el);
    return { el, onSelect };
  }

  const faces = () =>
    [...host.querySelectorAll<HTMLButtonElement>(".emoji-scale__btn")];

  it("renders exactly five faces, low to high", () => {
    build();
    expect(faces()).toHaveLength(5);
    expect(faces().map((b) => b.dataset.step)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("gives every face a word, not just a glyph", () => {
    build();
    // An emoji's meaning is not stable across platforms, and a face alone is
    // not something a screen reader can read out.
    for (const [i, btn] of faces().entries()) {
      const label = SATISFACTION_STEPS[i].label;
      expect(btn.getAttribute("aria-label")).toBe(label);
      expect(btn.querySelector(".emoji-scale__label")?.textContent).toBe(label);
    }
  });

  it("marks the glyph and the caption decorative, so the label is read once", () => {
    build();
    const btn = faces()[0];
    expect(btn.querySelector(".emoji-scale__glyph")?.getAttribute("aria-hidden")).toBe("true");
    expect(btn.querySelector(".emoji-scale__label")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is a radiogroup named by its question", () => {
    build();
    const group = host.querySelector(".emoji-scale")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("How was it?");
    for (const btn of faces()) expect(btn.getAttribute("role")).toBe("radio");
  });

  it("shows which face is chosen, in markup and in state", () => {
    build(3);
    const checked = faces().filter((b) => b.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0].dataset.step).toBe("3");
    expect(checked[0].classList.contains("is-active")).toBe(true);
  });

  it("reports the step that was pressed", () => {
    const { onSelect } = build();
    faces()[4].click();
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it("asks the question above the faces", () => {
    build();
    expect(host.querySelector(".emoji-scale__question")?.textContent).toBe("How was it?");
  });

  it("takes the host's own field and question classes, so one selector finds it", () => {
    host.append(
      buildEmojiScale({
        question: "How was it?",
        value: null,
        onSelect: () => {},
        fieldClass: "host__field",
        questionClass: "host__question",
      }),
    );
    expect(host.querySelector(".emoji-scale-field.host__field")).toBeTruthy();
    expect(host.querySelector(".emoji-scale__question.host__question")).toBeTruthy();
  });
});

describe("stepLabel", () => {
  it("names each step, and survives a value outside the range", () => {
    expect([1, 2, 3, 4, 5].map(stepLabel)).toEqual([
      "Awful",
      "Poor",
      "Okay",
      "Good",
      "Great",
    ]);
    expect(stepLabel(0)).toBe("Awful");
    expect(stepLabel(9)).toBe("Great");
  });
});
