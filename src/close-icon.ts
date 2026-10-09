// The one close glyph, for every dismiss control in the app.
//
// WHY AN SVG. The text "×" sits on the font's baseline, so in a round button
// it lands low and slightly off-centre — and its size and stroke change with
// whichever font the button happened to inherit (several were still on the
// user agent's Arial). Two stroked lines in a 24-unit box are centred by
// construction and inherit `currentColor`, so one rule (`.btn-close` in
// style.css) styles every close button, in both themes.
//
// index.html's drawer headers carry the same markup inline; keep them in step
// (close-icon.test.ts checks).

/** Two strokes, centred, `currentColor`. Decorative: the button carries the
 *  accessible name in its `aria-label`. */
export const CLOSE_ICON_SVG =
  '<svg class="btn-close__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
  "</svg>";

/** Give `btn` the shared close face: the `.btn-close` class (44px target,
 *  soft round face, focus ring) and the SVG glyph. `onColor` is for buttons
 *  sitting on a saturated background (the triple-tap chip, the ride HUD's
 *  badge) where the default muted ink would vanish. Returns `btn`. */
export function applyCloseFace<T extends HTMLElement>(
  btn: T,
  opts: { onColor?: boolean } = {},
): T {
  btn.classList.add("btn-close");
  if (opts.onColor) btn.classList.add("btn-close--on-color");
  btn.innerHTML = CLOSE_ICON_SVG;
  return btn;
}
