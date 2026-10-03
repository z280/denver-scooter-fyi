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
  /** Stable identity for this scale across rebuilds, used only to put keyboard
   *  focus back where the rider left it (see `pendingKeyboardFocus`). Defaults
   *  to the question, which is already unique per screen — pass one explicitly
   *  if two scales on a screen ever ask the same question. */
  name?: string;
}

/** The scale whose keyboard focus is owed a restore, by `name`.
 *
 *  Arrow keys on a radiogroup SELECT as they move, and selecting here calls the
 *  host's `onSelect` — which, for the survey, is `renderLeft()`: the pane is
 *  rebuilt and the focused button is thrown away mid-keystroke. A keyboard
 *  rider would arrow once and land back on `<body>`, which is worse than the
 *  no-arrow-keys state this replaced. So the move records which scale it was
 *  in, and the next build of a scale with that name takes focus back.
 *
 *  Module-level rather than per-instance precisely because the instance does
 *  not survive. Cleared on use, so a mouse rebuild never steals focus. */
let pendingKeyboardFocus: string | null = null;

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

  const name = options.name ?? options.question;
  const buttons: HTMLButtonElement[] = [];

  SATISFACTION_STEPS.forEach((s, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emoji-scale__btn";
    btn.dataset.step = String(s.step);
    btn.setAttribute("role", "radio");
    const active = options.value === s.step;
    btn.setAttribute("aria-checked", String(active));
    btn.classList.toggle("is-active", active);
    // Roving tabindex: the radiogroup is ONE Tab stop, not five. Five stops is
    // the thing a screen-reader rider notices first — Tab walks faces instead
    // of walking the form — and the ARIA radiogroup pattern is a package deal
    // with the arrow keys below. Unanswered, the entry point is the first face.
    btn.tabIndex = active || (options.value === null && i === 0) ? 0 : -1;
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
    // Arrow keys select as they move, which is the pattern's own rule: on a
    // radiogroup, moving IS choosing. Enter and Space need nothing — a real
    // <button> already fires `click` on both.
    btn.addEventListener("keydown", (e) => {
      const target = keyboardTarget(e.key, i);
      if (target === null) return;
      e.preventDefault();
      // Clamped, not wrapped, unlike `ride-settings.ts`'s segmented controls:
      // those are unordered choices where wrapping is a convenience, and this
      // is a scale. Arrowing right off 😍 and landing on 😠 would turn the
      // best answer into the worst one with one keystroke too many.
      if (target === i) return;
      // Claim the restore BEFORE `onSelect`, because `onSelect` may rebuild
      // this scale synchronously and the new build is what reads the flag.
      pendingKeyboardFocus = name;
      buttons[target].focus();
      options.onSelect(SATISFACTION_STEPS[target].step);
      // The host left the DOM alone, so there is nothing to restore and the
      // claim must not sit there waiting to hijack an unrelated rebuild.
      if (buttons[target].isConnected) pendingKeyboardFocus = null;
    });
    group.append(btn);
    buttons.push(btn);
  });

  wrap.append(group);

  if (pendingKeyboardFocus === name) {
    pendingKeyboardFocus = null;
    const landing =
      buttons.find((b) => b.getAttribute("aria-checked") === "true") ??
      buttons[0];
    // Deferred because the host has not appended `wrap` yet — focusing a
    // detached node is a silent no-op that leaves focus on <body>.
    queueMicrotask(() => {
      try {
        if (landing.isConnected) landing.focus();
      } catch {
        /* a survey must never die of a focus call */
      }
    });
  }

  return wrap;
}

/** Which index a key means, or null if the key is not ours. Home/End because a
 *  five-point scale's ends are the two answers worth reaching in one key. */
function keyboardTarget(key: string, from: number): number | null {
  const last = SATISFACTION_STEPS.length - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return Math.min(from + 1, last);
    case "ArrowLeft":
    case "ArrowUp":
      return Math.max(from - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/** Test seam: forget any owed focus restore between cases. */
export function resetEmojiScaleFocus(): void {
  pendingKeyboardFocus = null;
}
