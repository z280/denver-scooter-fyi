// Owner decision 2026-10-08: the rider's browser makes NO background request
// to Veo's servers. Plates come from our own API (src/plates.ts). The only
// Veo-owned URLs the app may carry are user-initiated navigation — the
// Adjust deep link printed on the sticker (`gmjc.adj.st`) and Veo's Zendesk
// help-centre form / support address (`veoride.zendesk.com`).
//
// Source-level on purpose: a fetch mock only proves the paths a test drives;
// this proves no path exists. Comments are stripped first so prose that
// explains the old design can't trip (or satisfy) it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/source-text.ts";

const ROOT = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|js|mjs)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = sourceFiles(join(ROOT, "src"));

describe("no direct-to-Veo requests from the browser", () => {
  it("finds the app's sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no source names a veoride.com host or a GBFS feed URL", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const code = withoutComments(readFileSync(f, "utf8"));
      // Any *.veoride.com host — the GBFS cluster, the API, the website.
      // `veoride.zendesk.com` (support navigation) is a different domain.
      if (/[a-z0-9.-]*\.?veoride\.com\b/i.test(code.replace(/veoride\.zendesk\.com/gi, ""))) {
        offenders.push(`${f}: veoride.com`);
      }
      if (/free_bike_status|gbfs\.json|\/gbfs\//i.test(code)) {
        offenders.push(`${f}: GBFS feed URL`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the old browser-side GBFS client is gone", () => {
    expect(files.some((f) => f.endsWith("gbfs.ts"))).toBe(false);
    for (const f of files) {
      const code = withoutComments(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(/GbfsPlates|VEO_GBFS_FREE_BIKE_STATUS_URL/);
    }
  });
});
