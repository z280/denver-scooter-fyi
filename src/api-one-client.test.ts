// One endpoint, one client.
//
// `GET /api/v1/tracked-rides` had TWO wrappers for a while: `ride-post-s10.ts`
// built one as a documented deviation, flagged "for the integrator to fold into
// api.ts properly whenever that file next gets touched", and Phase 2 §2.2 then
// touched api.ts for the same endpoint and added a second — different signature,
// different return shape, neither aware of the other.
//
// Nothing broke, which is why it would have survived: two clients for one GET
// agree until one of them learns something the other does not. This is the
// assertion that would have caught it, and it is cheap enough to cover the whole
// surface rather than just that one path.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withoutComments } from "../tests/helpers/source-text.ts";

const srcDir = join(import.meta.dirname);
const modules = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
  .map((f) => ({ file: f, text: withoutComments(readFileSync(join(srcDir, f), "utf8")) }));

/** Every module that builds a request URL for itself, rather than calling a
 *  client in `api.ts`. */
function callersOf(pattern: RegExp): string[] {
  return modules
    .filter((m) => m.file !== "api.ts" && pattern.test(m.text))
    .map((m) => m.file);
}

describe("api.ts is the only module that builds API URLs", () => {
  it("holds the sole client for the tracked-rides list", () => {
    // The specific regression: a second `/api/v1/tracked-rides` URL built outside
    // api.ts. `authedFetchJSON` is exported, so building one is easy and silent.
    expect(callersOf(/["'`]\/api\/v1\/tracked-rides/)).toEqual([]);
  });

  /** Modules that build their own request, each for a stated reason.
   *
   *  A PINNED SET RATHER THAN A BAN, because a flat ban is wrong here: these three
   *  predate this test and each has a reason in its own file. The point of pinning
   *  is that a FOURTH has to be added deliberately, with a reason, which is the
   *  step the duplicate tracked-rides client skipped.
   *
   *  A first version of this test banned them outright and failed on all three —
   *  the same over-constraint that made `onboarding-audit.test.ts` demand an
   *  element with `id="e69f00"`. A test that fails on code that is deliberately
   *  that way gets "fixed" by weakening it. */
  const ALLOWED = new Map([
    // Refreshing the session cannot go through a client that refreshes the session.
    ["auth-session.ts", "/api/v1/auth/refresh"],
    // Its own header: "flushes bypass api.ts (an analytics post must never
    // surface as a rider-facing error) ... a failed flush drops the batch".
    ["telemetry.ts", "/api/v1/telemetry/events"],
    // Device photos, whose own lane owns the endpoint and its multipart upload.
    ["device-photos.ts", "/api/v1/devices/"],
  ]);

  it("holds every versioned API URL but the pinned exceptions", () => {
    const offenders = modules
      .filter((m) => m.file !== "api.ts")
      .flatMap((m) => {
        const hits = m.text.match(/["'`]\/api\/v1\/[^"'`$]*/g) ?? [];
        const allowed = ALLOWED.get(m.file);
        return hits
          .map((h) => h.replace(/^["'`]/, ""))
          .filter((path) => !(allowed && path.startsWith(allowed)))
          .map((path) => `${m.file}: ${path}`);
      });
    expect(offenders).toEqual([]);
  });

  it("keeps the exception list honest — every entry is still used", () => {
    // An allowlist nobody prunes becomes a list of permissions for code that no
    // longer exists, and then a new offender can hide behind a stale entry.
    for (const [file, path] of ALLOWED) {
      const mod = modules.find((m) => m.file === file);
      expect(mod, file).toBeDefined();
      expect(mod!.text, `${file} no longer builds ${path}`).toContain(path);
    }
  });
});
