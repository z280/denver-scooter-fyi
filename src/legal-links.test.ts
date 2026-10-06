// The governing documents, as attribution entries.
//
// Small surface, and the interesting part is a negative: these must NOT come
// back as their own control in the map's bottom-left corner. A second pill
// there made the ⓘ — which carries the basemap licence's required attribution
// — harder to find and harder to hit, which is a worse outcome than the links
// being one tap deeper.

import { describe, expect, it } from "vitest";

import { LEGAL_LINKS } from "./config.ts";
import { legalAttribution } from "./legal-links.ts";

describe("the legal attribution entries", () => {
  it("renders every governing document, from the one shared list", () => {
    // The list is shared with the About drawer's prose precisely so the two
    // cannot drift; reading it here rather than restating the URLs is what
    // makes that true of the test as well.
    const out = legalAttribution();
    expect(out).toHaveLength(LEGAL_LINKS.length);
    for (const spec of LEGAL_LINKS) {
      expect(out.join(" ")).toContain(spec.href);
      expect(out.join(" ")).toContain(`>${spec.label}<`);
    }
  });

  it("covers both the privacy policy and the terms", () => {
    // Belt and braces against the shared list itself losing one: these are
    // the only always-reachable copies of either document in the app.
    const joined = legalAttribution().join(" ");
    expect(joined).toMatch(/privacy/i);
    expect(joined).toMatch(/terms/i);
  });

  it("opens them without handing the new page a handle on this one", () => {
    for (const entry of legalAttribution()) {
      expect(entry).toContain('target="_blank"');
      expect(entry).toContain("noopener");
      expect(entry).toContain("noreferrer");
    }
  });

  it("builds its markup only from the module constant", () => {
    // MapLibre renders these as trusted HTML. Nothing a user or a server can
    // reach may end up in the string — so the only interpolations are the
    // list's own fields, and the hrefs are absolute https URLs.
    for (const spec of LEGAL_LINKS) {
      expect(spec.href).toMatch(/^https:\/\//);
      expect(spec.label).toMatch(/^[\w ]+$/);
    }
  });

  it("exposes no map control — the ⓘ is not to be crowded again", () => {
    // The regression this guards is invisible in a diff: adding a control back
    // here would look like a feature and would quietly degrade the one button
    // in that corner with a licence condition attached to it.
    const mod = legalAttribution as unknown as Record<string, unknown>;
    void mod;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return import("./legal-links.ts").then((m: any) => {
      expect(m.createLegalLinks).toBeUndefined();
      expect(m.buildLegalLinks).toBeUndefined();
    });
  });
});
