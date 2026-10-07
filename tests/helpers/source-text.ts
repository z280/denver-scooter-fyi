// Shared by the source-level tests (`mode-bar-gone`, `plan-list-wired`,
// `device-card-tiers`, `onboarding-audit`). Not a test file, so the include
// globs leave it alone — same arrangement as `tests/fixtures`.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS: A SOURCE TEST THAT MATCHES PROSE IS TESTING PROSE.
//
// This repo comments heavily, and the comments explain the very identifiers the
// source-level tests assert on. `onboarding-audit.test.ts` pinned the closing
// CTA's call ORDER and passed with the order reversed, because the comment above
// the code — which exists to explain why `homeBar?.openForTrip()` is not enough —
// mentioned `openForTrip()` earlier in the file than the call did. Found by
// mutation; it would never have been found by reading.
//
// None of the other source assertions were passing on a comment when this was
// written. They were all one explanatory sentence away from it, which is not a
// property worth relying on.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

export function readSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Drop `//` line comments and `/* *\/` block comments.
 *
 *  DELIBERATELY NOT A PARSER. It strips whole-line `//` comments and block
 *  comments, and leaves a trailing `// like this` one alone — stripping those
 *  needs string-literal awareness, and a regex that tries gets `"http://x"`
 *  wrong. Whole-line and block comments are where this codebase's prose lives,
 *  which is what the tests were tripping over. */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** The body of a top-level `function name(...)`, comments stripped.
 *
 *  Slices to the first line that is exactly `}`, which is where a top-level
 *  function in this codebase ends. Slicing to the end of the file instead — the
 *  first version — swept in every other occurrence in a 4,000-line module and
 *  failed on code the test was not about. */
export function functionBody(source: string, signaturePrefix: string): string {
  const from = source.indexOf(signaturePrefix);
  if (from === -1) throw new Error(`no function matching ${signaturePrefix}`);
  const rest = source.slice(from);
  const end = rest.indexOf("\n}\n");
  return withoutComments(end === -1 ? rest : rest.slice(0, end));
}
