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

/** The body of a function or method, comments stripped, closing at the brace that
 *  matches the declaration's OWN indentation.
 *
 *  Two corrections, both found by mutation:
 *
 *  1. The first version sliced to the end of the file, which swept in every other
 *     occurrence in a 4,000-line module and failed on code the test was not about.
 *  2. The second closed on a line that is exactly `}`, which is right for a
 *     top-level function and WRONG FOR A CLASS METHOD — a method closes on `  }`,
 *     so the slice ran on to the end of the class and picked up every other
 *     method's code. A `toContain` against such a slice is satisfied by anything
 *     in the file below it, which is how an assertion about one method passed while
 *     that method was gutted.
 *
 *  So the closing brace is derived from the signature's indentation, and a
 *  signature that cannot be found throws rather than returning the whole file. */
export function functionBody(source: string, signaturePrefix: string): string {
  const from = source.indexOf(signaturePrefix);
  if (from === -1) throw new Error(`no function matching ${signaturePrefix}`);
  const lineStart = source.lastIndexOf("\n", from) + 1;
  const indent = source.slice(lineStart, from).match(/^[ \t]*/)?.[0] ?? "";
  const rest = source.slice(from);
  const closer = `\n${indent}}`;
  const end = rest.indexOf(closer, 1);
  return withoutComments(end === -1 ? rest : rest.slice(0, end));
}
