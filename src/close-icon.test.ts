// @vitest-environment happy-dom
//
// One close button, everywhere. The audit of 2026-10-09 found ~25 dismiss
// controls drawn six different ways: text "×" and "✕" in whatever font the
// button inherited (often the user agent's Arial), sitting low on the
// baseline; hit targets from 18×18 to 44×44; and a shared rule whose
// `padding-right: 40px` pushed the × out of its own circle on five cards.
// These pin the shape of the fix so it doesn't drift back.
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";

import { readSource } from "../tests/helpers/source-text.ts";
import { CLOSE_ICON_SVG, applyCloseFace } from "./close-icon.ts";

const css = readSource("src/style.css");
const html = readSource("index.html");

/** The shared block, from its banner to the end of the file. */
function sharedBlock(): string {
  const at = css.indexOf("SHARED BUTTONS: every close");
  expect(at).toBeGreaterThan(-1);
  return css.slice(at);
}

/** The LAST rule in `block` whose selector list ends with `selector`. */
function rule(block: string, selector: string): string {
  const at = block.lastIndexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return block.slice(at, block.indexOf("}", at));
}

describe("applyCloseFace", () => {
  it("adds the class and the SVG glyph, and keeps the button's name", () => {
    const b = document.createElement("button");
    b.setAttribute("aria-label", "Close");
    applyCloseFace(b);
    expect(b.classList.contains("btn-close")).toBe(true);
    expect(b.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(b.textContent).toBe("");
    expect(b.getAttribute("aria-label")).toBe("Close");
  });

  it("marks the on-colour variant", () => {
    const b = applyCloseFace(document.createElement("button"), { onColor: true });
    expect(b.classList.contains("btn-close--on-color")).toBe(true);
  });
});

describe("no close button is a text ×", () => {
  it("index.html's drawer closes carry the class and the same SVG", () => {
    const closes = html.match(/<button class="drawer-close[^"]*"[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(closes.length).toBeGreaterThanOrEqual(11);
    const path = CLOSE_ICON_SVG.match(/<path[^>]*\/>/)![0];
    for (const b of closes) {
      expect(b, b).toContain("btn-close");
      expect(b, b).toContain(path);
      expect(b, b).toMatch(/aria-label="[^"]+"/);
    }
    expect(html).not.toMatch(/&times;<\/button>/);
  });

  it("no module builds a dismiss button with a text glyph", () => {
    const offenders: string[] = [];
    for (const f of readdirSync("src")) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readSource(`src/${f}`);
      const bad = [
        /el\("button",[^)]*,\s*"(?:×|✕)"\)/,
        /\.textContent = "(?:×|✕)";/,
        />(?:×|✕|&times;)<\/button>/,
      ];
      for (const re of bad) if (re.test(src)) offenders.push(`${f}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the shared rule", () => {
  const block = sharedBlock();

  it("is a 44×44 target with a token face and the app's font", () => {
    const r = rule(block, "button.btn-close");
    expect(r).toContain("width: 44px");
    expect(r).toContain("height: 44px");
    expect(r).toContain("font: inherit");
    expect(r).toContain("appearance: none");
    expect(r).toMatch(/--bc-face: var\(--/);
    expect(r).toMatch(/--bc-ink: var\(--/);
  });

  it("has a focus ring", () => {
    expect(rule(block, "button.btn-close:focus-visible")).toContain("outline: 2px solid");
  });

  it("keeps a 44px target on the inline variant", () => {
    const r = rule(block, "button.btn-close.btn-close--inline::after");
    expect(r).toContain("inset: -10px"); // 24 + 2×10 = 44
  });

  it("restyles MapLibre's popup ✕ to match", () => {
    expect(block).toContain(".maplibregl-popup .maplibregl-popup-close-button > span");
  });

  it("gives every Next the same 44px primary face", () => {
    const r = rule(block, ".ride-modal__next");
    expect(r).toContain("background: var(--accent)");
    expect(block).toMatch(/\.login-btn,\s*\.onboarding__next,\s*\.onboarding__back,\s*\.ride-modal__next \{\s*min-height: 44px/);
  });

  it("the card heads' corner padding no longer lands on the buttons", () => {
    // The bug: `.qr-scan__close, …` shared a selector list with the heads'
    // `padding-right: 40px`, so the × sat at the left edge of its circle.
    const at = css.indexOf("padding-right: 40px;");
    const selectors = css.slice(css.lastIndexOf("}", at), at);
    expect(selectors).not.toMatch(/__close\s*,/);
  });
});

describe("an open popup outranks the floating chrome", () => {
  it("lifts popups over MapLibre's control corners and hides fixed chrome", () => {
    expect(css).toMatch(/\.maplibregl-popup \{\s*z-index: 3;/);
    for (const sel of [".home-bar:not(.is-open)", ".brand-link", ".triple-tap-nudge"]) {
      expect(css).toContain(`body:has(.maplibregl-popup) ${sel}`);
    }
  });
});
