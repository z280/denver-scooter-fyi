// The corner × that landed inside the Dynamic Island.
//
// WHAT WENT WRONG. The owner asked for "the X should be top right", and the
// shared rule that delivered it pins the button to the card with
// `top: 6px; right: 6px`. Five of the six cards that share that rule float in
// the middle of the screen with the overlay holding them clear of every edge,
// and for those 6px is exactly right.
//
// `.equity-receipt__card` is the sixth. On a phone it is a full-height sheet:
// `inset: 0` on the overlay, `width: 100%` on the card, so the card's top-right
// corner IS the screen's top-right corner. The card already carried
// `env(safe-area-inset-top)` in its padding — but an absolutely positioned
// child resolves `top` against the padding BOX, not the padding, so the × never
// saw it. At 6px its whole 44px target sat inside the ~59px Dynamic Island
// strip, where iOS keeps the taps. The button rendered perfectly and could not
// be pressed. Reported 2026-10-10 on an iPhone 14 Pro Max and a 15 Pro Max.
//
// Nothing caught it because every non-notched viewport — desktop, the test
// suite, an older phone — resolves `env()` to 0, where the bug does not exist.
//
// This reads the stylesheet, like `close-button-face.test.ts` next door and for
// the same reason: the failure is a declaration that is absent, not one that
// computes oddly, and no DOM test without a notch can see it. Comments are
// stripped first — this file's own prose names every identifier asserted on
// below, and `tests/helpers/source-text.ts` exists because a source test that
// matches prose is testing prose.
import { describe, expect, it } from "vitest";

import { readSource, withoutComments } from "../tests/helpers/source-text.ts";

const css = withoutComments(readSource("src/style.css"));

/** The declaration block that pins the × to its card's corner. */
function pinnedCornerBlock(): string {
  const anchor = css.indexOf(".home-bar__sheet .home-bar__close.btn-close {");
  expect(anchor, "the pinned-corner rule").toBeGreaterThan(-1);
  const open = css.indexOf("{", anchor);
  return css.slice(open, css.indexOf("}", open));
}

/** A rule's body, by the exact selector line that opens it. */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  return css.slice(open, css.indexOf("}", open));
}

describe("the corner × clears the safe-area inset on a full-bleed card", () => {
  it("offsets from a variable rather than pinning at a bare 6px", () => {
    const pinned = pinnedCornerBlock();
    expect(pinned).toContain("top: calc(6px + var(--card-safe-top, 0px))");
    expect(pinned).toContain("right: calc(6px + var(--card-safe-right, 0px))");
    // The bug, verbatim. `calc(6px + …)` contains no such declaration, so this
    // fails the moment somebody flattens it back.
    expect(pinned).not.toMatch(/top:\s*6px\s*;/);
    expect(pinned).not.toMatch(/right:\s*6px\s*;/);
  });

  it("falls back to 0px, so the five floating cards are untouched", () => {
    // The fallback is what keeps this a one-card change: a card that says
    // nothing gets the old geometry exactly. Asserted by counting the
    // DECLARATIONS rather than by reading each card's own rule — four of the
    // six cards have no rule of their own at all (`.ride-preflight__card` and
    // friends share `.device-features__card`'s), so "the variable is set in
    // exactly the two receipt branches and nowhere else" is both the real
    // invariant and the only one that can be checked.
    const pinned = pinnedCornerBlock();
    expect(pinned).toContain("var(--card-safe-top, 0px)");
    expect(pinned).toContain("var(--card-safe-right, 0px)");
    const declarations = css.match(/--card-safe-top:/g) ?? [];
    expect(declarations).toHaveLength(2);
    expect(css.match(/--card-safe-right:/g) ?? []).toHaveLength(2);
  });

  it("publishes the inset from the receipt sheet, which runs edge to edge", () => {
    const card = block(".equity-receipt__card");
    expect(card).toContain("--card-safe-top: env(safe-area-inset-top)");
    expect(card).toContain("--card-safe-right: env(safe-area-inset-right)");
  });

  it("still pads flowed content clear of all four insets", () => {
    // The padding and the variable are two different jobs: the padding holds
    // the form's first field below the island, the variable moves the × that
    // the padding cannot reach. Losing either one leaves half the sheet wrong.
    const card = block(".equity-receipt__card");
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(card, side).toContain(`env(safe-area-inset-${side})`);
    }
  });

  it("clears the inset again where the sheet becomes a floating card", () => {
    // From 600px up the overlay centres the card and pads it away from the
    // edges, so the corner stops being the screen's. Keeping the inset here
    // would hang the × that many pixels down inside the card instead.
    const at = css.indexOf("@media (min-width: 600px)", css.indexOf(".equity-receipt {"));
    expect(at, "the receipt's own breakpoint").toBeGreaterThan(-1);
    const branch = css.slice(at, css.indexOf("\n}", css.indexOf(".equity-receipt__card", at)));
    expect(branch).toContain("--card-safe-top: 0px");
    expect(branch).toContain("--card-safe-right: 0px");
  });
});
