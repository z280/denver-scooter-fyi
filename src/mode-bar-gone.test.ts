// Phase 6 §6.2/§6.6 — the mode bar is GONE, and nothing reaches for it.
//
// `#mode-switch` was a `hidden` two-button bar that the home bar entered a
// ride by synthetically CLICKING. That was right for the move which put the
// home bar in charge — it relocated the entry point without re-deriving any
// behaviour — and wrong to leave: the seam was invisible, and two modules had
// already had to learn about it (`wireFreshnessCollapse` was corrected to lift
// `#home-bar` instead, and `install-prompt.ts` carries the same note). The
// plan's prediction was "a third will get it wrong".
//
// So this is a source-level test, which the repo does not otherwise do. It is
// here because the thing being asserted IS a source-level fact: not "clicking
// the bar still works" but "there is no bar, and no code looks for one". A
// behavioural test cannot express that, and the trap this closes is somebody
// reintroducing the query, not somebody breaking a button.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const srcDir = join(ROOT, "src");
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, text: readFileSync(join(srcDir, f), "utf8") }));

describe("the mode bar", () => {
  it("is absent from index.html", () => {
    expect(html).not.toMatch(/id="mode-switch"/);
    expect(html).not.toMatch(/class="mode-btn"/);
    expect(html).not.toMatch(/data-mode="(?:ride|riding)"/);
  });

  it("is not queried by any module", () => {
    // Mentions in prose are fine and deliberate — several comments record why
    // the element is gone. A SELECTOR is not: that is the seam coming back.
    const offenders = sources.filter(({ text }) =>
      /(?:querySelector|querySelectorAll|getElementById)\s*(?:<[^>]*>)?\s*\(\s*[`'"][^`'"]*mode-switch/.test(
        text,
      ),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("left no element for `#ride-open` either", () => {
    // The 🧭 button's id. Nothing referenced it even before the bar went,
    // which is how its whole branch turned out to be unreachable.
    expect(html).not.toMatch(/id="ride-open"/);
    // Again: a selector, not a mention. A comment explaining why the branch
    // was unreachable is the record of this change, not a relapse.
    const offenders = sources.filter(({ text }) =>
      /(?:querySelector|querySelectorAll|getElementById)\s*(?:<[^>]*>)?\s*\(\s*[`'"][^`'"]*ride-open/.test(
        text,
      ),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("carries no dead mode-bar styling", () => {
    // The rules outlived the element they styled by exactly one commit.
    const css = readFileSync(join(srcDir, "style.css"), "utf8");
    expect(css).not.toMatch(/^\s*\.mode-(?:switch|btn)[^a-z-]/m);
  });

  it("still gives the home bar a named way in", () => {
    // Deleting the bar must not delete the entry. `enterFindWheels` is what
    // the onboarding card and the home bar call now, directly.
    const main = sources.find((s) => s.file === "main.ts")!.text;
    expect(main).toMatch(/let enterFindWheels: \(\) => void/);
    expect(main).toMatch(/enterFindWheels = \(\) => \{/);
    // ...and it is actually called, not merely declared.
    const calls = main.match(/\benterFindWheels\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
