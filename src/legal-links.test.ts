// @vitest-environment happy-dom
//
// The governing documents' footer. Small surface, three things worth pinning:
// that both documents are actually reachable (this is the only always-visible
// copy), that the links are safe to open, and that the group announces itself
// as something other than two stray words in the map chrome.

import { describe, expect, it } from "vitest";

import { LEGAL_LINKS } from "./config.ts";
import { buildLegalLinks, createLegalLinks } from "./legal-links.ts";

describe("the legal footer", () => {
  const links = () => [
    ...buildLegalLinks().querySelectorAll<HTMLAnchorElement>(
      ".legal-links__panel a",
    ),
  ];

  it("renders every governing document, from the one shared list", () => {
    // The list is shared with the About drawer's prose precisely so these two
    // cannot drift; reading it here rather than restating the URLs is what
    // makes that true of the test as well.
    expect(links()).toHaveLength(LEGAL_LINKS.length);
    expect(links().map((a) => a.textContent)).toEqual(
      LEGAL_LINKS.map((l) => l.label),
    );
    expect(links().map((a) => a.getAttribute("href"))).toEqual(
      LEGAL_LINKS.map((l) => l.href),
    );
  });

  it("covers both the privacy policy and the terms", () => {
    // Belt and braces against the shared list itself losing one: this is the
    // only always-visible copy of either document in the app.
    const hrefs = links().map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.includes("privacy"))).toBe(true);
    expect(hrefs.some((h) => h.includes("terms"))).toBe(true);
  });

  it("opens them without handing the new page a handle on this one", () => {
    for (const a of links()) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toContain("noopener");
      expect(a.rel).toContain("noreferrer");
    }
  });

  it("announces the panel as a named group", () => {
    const el = buildLegalLinks();
    const panel = el.querySelector(".legal-links__panel")!;
    expect(panel.getAttribute("role")).toBe("navigation");
    expect(panel.getAttribute("aria-label")).toBe("Legal");
  });

  it("collapses behind a chip that says what is inside it", () => {
    // Measured, not chosen: at 390px the open panel did not fit beside the
    // home bar, so the chip is what has to clear it. "Legal" is the longest
    // word that does.
    const el = buildLegalLinks();
    expect(el.tagName).toBe("DETAILS");
    // Closed by default — it is chrome, not a notice.
    expect(el.hasAttribute("open")).toBe(false);
    const summary = el.querySelector("summary");
    expect(summary?.textContent).toBe("Legal");
  });

  it("joins the map's own control stack rather than floating over it", () => {
    // `maplibregl-ctrl` is what gives it the corner's spacing; without it the
    // pill sits in the wrong place by the library's control margin.
    expect(buildLegalLinks().classList.contains("maplibregl-ctrl")).toBe(true);
  });

  it("is a control that cleans up after itself", () => {
    const ctrl = createLegalLinks();
    const el = ctrl.onAdd();
    document.body.append(el);
    expect(el.isConnected).toBe(true);
    ctrl.onRemove();
    expect(el.isConnected).toBe(false);
    // And a second remove is not an error — MapLibre can call it on a map
    // that is already being torn down.
    expect(() => ctrl.onRemove()).not.toThrow();
  });
});
