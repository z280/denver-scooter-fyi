// The eight dismissals that share one rule, and the face that rule forgot.
//
// WHAT WENT WRONG, because the shape of it is the point. Six surfaces each had
// a near-identical × rule; they were consolidated into one shared rule to stop
// them drifting. The consolidation took the GEOMETRY — size, circle, centring —
// and left the FACE behind, and nothing noticed because three of the rules that
// were emptied out still carry comments saying "face, shape and ink come from
// the shared metal + round-✕ rules above". No metal rule ever matched these
// selectors.
//
// So for months every one of these rendered with the user agent's button
// defaults: `#efefef`, a `2px outset` 3D bevel, hard black ink and Arial,
// forced into a 34px circle — a 1990s OS button on a card floating over a map,
// and identical in dark mode because none of it came from a token.
//
// This reads the stylesheet rather than a browser, which is the right altitude
// for the failure: it was never that the rule computed oddly, it was that the
// declarations were absent. A jsdom test would have passed throughout.
import { describe, expect, it } from "vitest";

import { readSource } from "../tests/helpers/source-text.ts";

const css = readSource("src/style.css");

/** The eight in the shared rule. Listed here rather than parsed out of the
 *  stylesheet on purpose: if somebody adds a tenth dismissal to that selector
 *  list and not to this one, the new test failure is the reminder. */
const SHARED = [
  "arrival__close",
  "home-bar__close",
  "qr-scan__close",
  "device-features__close",
  "equity-receipt__close",
  "ride-preflight__close",
  "admin-analytics__close",
  "ride-modal__close",
];

/** The declaration block whose selector list contains all eight. */
function sharedBlock(): string {
  const anchor = css.indexOf(".ride-modal__close {");
  expect(anchor).toBeGreaterThan(-1);
  const open = css.indexOf("{", anchor);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

describe("the shared dismiss rule carries a face, not just a shape", () => {
  const block = sharedBlock();

  it("still covers all eight surfaces", () => {
    const selectorStart = css.lastIndexOf("\n\n", css.indexOf(".ride-modal__close {"));
    const selectors = css.slice(selectorStart, css.indexOf(".ride-modal__close {"));
    for (const name of SHARED.slice(0, -1)) {
      expect(selectors, name).toContain(`.${name},`);
    }
  });

  it("resets the user agent's button, which is what made it look like Windows 95", () => {
    // `appearance` alone is not enough — the 2px outset bevel and the grey
    // face survive it on some engines — so the border and background are
    // declared outright.
    expect(block).toContain("appearance: none");
    expect(block).toMatch(/border:\s*1px solid/);
    expect(block).toMatch(/background:\s*var\(--/);
  });

  it("takes every colour from a token, so dark mode is not a second rule", () => {
    // The UA default was `#efefef` on `#000`, identical in both themes. Every
    // colour here has to come from the token block or the bug comes back the
    // moment somebody reads it in the dark.
    const colours = block.match(/(?:background|color|border):[^;]+;/g) ?? [];
    expect(colours.length).toBeGreaterThan(0);
    for (const decl of colours) {
      expect(decl, decl).toMatch(/var\(--/);
    }
  });

  it("inherits the app's font rather than the agent's Arial", () => {
    // These carry a glyph, and a × from a different family is visibly a
    // different ×.
    expect(block).toContain("font-family: inherit");
  });

  it("gives a keyboard rider a focus ring, since `appearance: none` took the UA's", () => {
    const focus = css.slice(css.indexOf(".ride-modal__close:focus-visible"));
    expect(focus.slice(0, 200)).toContain("outline:");
  });
});
