// The Tools drawer clean-up (2026-10-09). Source-level, like
// mode-bar-gone.test.ts, because what is asserted IS a source-level fact: each
// duplicate is gone from the drawer, and the thing it duplicated is still
// reachable from its own home.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const main = readFileSync(join(ROOT, "src", "main.ts"), "utf8");

/** Just the Tools drawer's markup. */
const tools = (() => {
  const start = html.indexOf('<aside class="drawer" id="drawer-tools"');
  const end = html.indexOf("</aside>", start);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, end);
})();

describe("the Tools drawer has no duplicates", () => {
  it("no longer offers Confirm features by QR — the ribbon's Scan does that", () => {
    expect(tools).not.toMatch(/id="tools-confirm-qr"/);
    expect(tools).not.toMatch(/<h3[^>]*>Confirm features by QR/);
    expect(main).not.toMatch(/tools-confirm-qr/);
    // The replacement is still there, and still opens the features flow.
    expect(html).toMatch(/id="ribbon-qr"/);
    expect(main).toMatch(/onConfirmFeatures:\s*\(rawValue\)/);
  });

  it("no longer carries a second Compliance calendar button", () => {
    expect(tools).not.toMatch(/id="tools-compliance-calendar"/);
    // It lives inside the Equity Compliance drawer...
    expect(html).toMatch(/id="compliance-open-calendar"/);
    // ...and Tools no longer opens it: it is a statistic, reached from the
    // Rider stats drawer's Equity Areas card (owner, 2026-10-09).
    expect(tools).not.toMatch(/id="tools-open-compliance"/);
  });

  it("has one dibs-and-watches list instead of two overlapping ones", () => {
    expect(tools).not.toMatch(/id="tools-my-dibs"/);
    expect(tools).not.toMatch(/id="tools-notify-moved"/);
    expect(tools).toMatch(/id="tools-mine"/);
    // First thing in the drawer: the only things here that expire.
    expect(tools.indexOf('id="tools-mine"')).toBeLessThan(tools.indexOf('id="finder-label"'));
  });

  it("carries no admin controls at all — they moved to ⚙ Admin", () => {
    expect(tools).not.toMatch(/id="tools-admin"/);
    expect(tools).not.toMatch(/Admin tools/);
    expect(tools).not.toMatch(/tools-admin-(traffic|events|watch)/);
    expect(main).not.toMatch(/tools-admin-(traffic|events)/);
  });
});

describe("the ⚙ Admin drawer's markup", () => {
  const tab = (() => {
    const m = html.match(/<button[^>]*data-drawer="admin"[^>]*>/s);
    return m ? m[0] : "";
  })();

  it("is a ribbon tab, hidden until the server says admin", () => {
    const nav = html.slice(html.indexOf('<nav id="drawer-tabs"'), html.indexOf("</nav>"));
    expect(nav).toContain('data-drawer="admin"');
    expect(tab).toMatch(/\bhidden\b/);
    expect(tab).toMatch(/class="drawer-tab"/);
  });

  it("ships an empty drawer body — controls are built only for an admin", () => {
    expect(html).toMatch(/<div class="drawer-body" id="admin-panel"><\/div>/);
    expect(html).not.toMatch(/id="admin-manage"|id="admin-traffic"|id="admin-server-link"/);
  });

  it("makes the tab's hidden win over .drawer-tab's display", () => {
    const css = readFileSync(join(ROOT, "src", "tools-drawer.css"), "utf8");
    expect(css).toMatch(/\.drawer-tab\[data-drawer="admin"\]\[hidden\]\s*\{\s*display:\s*none !important;/);
  });
});
