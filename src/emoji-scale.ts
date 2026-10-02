// Five faces instead of ten numbers.
//
// WHY. A ten-button segmented row is about 30 px per target on a phone, which
// is under every touch-target guideline there is and well under what a thumb
// can hit while standing on a pavement having just got off a scooter. Riders
// mis-tap it, and a mis-tapped 7-instead-of-8 is indistinguishable from an
// opinion — so the row collected noise and called it data. Five faces are
// ~60 px each, legible at a glance, and nobody has to decide what the
// difference between a 6 and a 7 is.
//
// WHY THE WIRE FORMAT DOES NOT CHANGE. The API stores `nav_route_rating` as
// 1–10 and `nav_nps` as 0–10, with `Field(ge=…, le=…)` bounds, and there is a
// history of these rows already. Narrowing the column would invalidate it and
// buy nothing: a five-point scale maps cleanly onto ten, so the client sends
// the ten-point value its face stands for and every existing reader keeps
// working. The mapping is here, in one place, with the arithmetic written down.
//
// WHY THE MAPS ARE NOT THE SAME. A satisfaction rating is linear — five steps
// across a range, so step/5 × 10. NPS is not: it is cut into detractor (0–6),
// passive (7–8) and promoter (9–10), and a linear map would put the middle face
// at 6 and the fourth at 8, silently calling a neutral rider a detractor at one
// end and refusing to let four-out-of-five be a promoter at the other. So NPS
// gets its own table, pinned to those bands.

export interface EmojiStep {
  /** 1–5, low to high. The index the UI works in. */
  step: number;
  emoji: string;
  /** Said out loud by screen readers, and used as the visible caption on the
   *  chosen face. A face alone is not an accessible control. */
  label: string;
}

/** "How was it?", five ways. Deliberately not seven: the two extra steps buy
 *  nothing a rider can tell apart, and cost the width that makes the rest
 *  tappable. */
export const SATISFACTION_STEPS: readonly EmojiStep[] = [
  { step: 1, emoji: "😠", label: "Awful" },
  { step: 2, emoji: "🙁", label: "Poor" },
  { step: 3, emoji: "😐", label: "Okay" },
  { step: 4, emoji: "🙂", label: "Good" },
  { step: 5, emoji: "😍", label: "Great" },
];

/** A five-step answer as the API's 1–10 rating. Linear: step/5 × 10, so the
 *  faces land on 2/4/6/8/10 and the midpoint face is a 6 — above the 1–10
 *  scale's own middle, which is correct, because "Okay" is not "bad". */
export function stepToTenScale(step: number): number {
  return clampStep(step) * 2;
}

/** The inverse, for rendering a stored rating back onto the faces (a draft, or
 *  a survey read back). Rounds to the nearest face rather than refusing
 *  anything that was not one of the five — a 7 from the old ten-button row is
 *  a real answer and belongs on 🙂. */
export function tenScaleToStep(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampStep(Math.round(value / 2));
}

/** A five-step answer as an NPS score, pinned to NPS's own bands rather than
 *  spread evenly: 0 / 3 / 6 / 8 / 10 puts the middle face at the top of the
 *  detractor band, the fourth squarely passive, and only the top face a
 *  promoter. That is what the three bands mean, and a linear map would have
 *  quietly reclassified two of the five. */
const NPS_BY_STEP: readonly number[] = [0, 3, 6, 8, 10];

export function stepToNps(step: number): number {
  return NPS_BY_STEP[clampStep(step) - 1];
}

/** The inverse — nearest face by distance, so a stored 7 (passive) reads back
 *  as 🙂 rather than being rejected.
 *
 *  A TIE BREAKS UPWARD, which is the whole reason this is a loop and not a
 *  table lookup. 7 sits exactly between the 6 and 8 faces, and those two are in
 *  different NPS bands: rounding down would read a passive score back as the
 *  detractor face, misreporting the rider to themselves. `<=` is what makes the
 *  later face win. */
export function npsToStep(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  let best = 1;
  for (let i = 0; i < NPS_BY_STEP.length; i += 1) {
    if (Math.abs(NPS_BY_STEP[i] - value) <= Math.abs(NPS_BY_STEP[best - 1] - value)) {
      best = i + 1;
    }
  }
  return best;
}

function clampStep(step: number): number {
  if (!Number.isFinite(step)) return 1;
  return Math.min(5, Math.max(1, Math.round(step)));
}

export function stepLabel(step: number): string {
  return SATISFACTION_STEPS[clampStep(step) - 1].label;
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

export interface EmojiScaleOptions {
  /** Asked above the faces, and the radiogroup's accessible name. */
  question: string;
  /** Currently chosen step (1–5), or null for unanswered. */
  value: number | null;
  onSelect(step: number): void;
  /** Extra class on the wrapper, for a host with its own field styling. */
  fieldClass?: string;
  /** Extra class on the question paragraph. A host whose other fields label
   *  themselves with a particular class can pass it, so one selector still
   *  finds every question on the screen — the scale is a field like any other
   *  and should not need a second lookup. */
  questionClass?: string;
}

/** Build the row.
 *
 *  A radiogroup of five buttons, each carrying its emoji AND its word. The
 *  word is not decoration: an emoji's meaning is not stable across platforms
 *  (one vendor's 😐 is another's grimace), and a rider choosing between five
 *  unlabelled faces is guessing at our intent rather than reporting theirs.
 *  It is also the only thing a screen reader has to go on. */
export function buildEmojiScale(options: EmojiScaleOptions): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = options.fieldClass
    ? `emoji-scale-field ${options.fieldClass}`
    : "emoji-scale-field";

  const prompt = document.createElement("p");
  prompt.className = options.questionClass
    ? `emoji-scale__question ${options.questionClass}`
    : "emoji-scale__question";
  prompt.textContent = options.question;
  wrap.append(prompt);

  const group = document.createElement("div");
  group.className = "emoji-scale";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", options.question);

  for (const s of SATISFACTION_STEPS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emoji-scale__btn";
    btn.dataset.step = String(s.step);
    btn.setAttribute("role", "radio");
    const active = options.value === s.step;
    btn.setAttribute("aria-checked", String(active));
    btn.classList.toggle("is-active", active);
    // The label is what assistive tech reads; the glyph is marked decorative
    // so it is not announced as "angry face" before it.
    btn.setAttribute("aria-label", s.label);

    const glyph = document.createElement("span");
    glyph.className = "emoji-scale__glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = s.emoji;
    const caption = document.createElement("span");
    caption.className = "emoji-scale__label";
    caption.setAttribute("aria-hidden", "true");
    caption.textContent = s.label;
    btn.append(glyph, caption);

    btn.addEventListener("click", () => options.onSelect(s.step));
    group.append(btn);
  }

  wrap.append(group);
  return wrap;
}
