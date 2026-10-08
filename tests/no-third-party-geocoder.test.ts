// Owner directive 2026-10-08: the browser makes NO request to OpenStreetMap's
// Nominatim. Reverse geocoding goes through our own API
// (GET /api/v1/geocode/reverse, src/geocode.ts → src/api.ts).
//
// Sibling of no-veo-requests.test.ts, and source-level for the same reason: a
// fetch mock only proves the paths a test drives; this proves no path exists.
// Comments are stripped first so prose explaining the old design can't trip it.
// (The map's attribution LINK to openstreetmap.org is navigation, not a
// request, and is a different host.)
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

describe("no requests to OpenStreetMap's Nominatim", () => {
  it("finds the app's sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no source names a Nominatim host", () => {
    const offenders = files.filter((f) =>
      /nominatim/i.test(withoutComments(readFileSync(f, "utf8"))),
    );
    expect(offenders).toEqual([]);
  });

  it("index.html loads nothing from Nominatim", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    expect(html).not.toMatch(/nominatim\.openstreetmap\.org/i);
  });

  it("geocode.ts reverse-geocodes through api.ts", () => {
    const code = withoutComments(readFileSync(join(ROOT, "src/geocode.ts"), "utf8"));
    expect(code).toMatch(/fetchReverseGeocode/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });
});
