// A TEMPORAL-DEAD-ZONE GUARD FOR THE ONE MODULE NO OTHER TEST CAN SEE.
//
// `main.ts` is the app entry. Nothing imports it, so nothing EVALUATES it in
// the unit suite — the suite can only read it as text. That gap shipped a bug
// that broke the entire app:
//
//     const rideHud = wireRideHud();          // line 793
//     const rideVoice = createRideVoice(...); // line 854
//     function wireRideHud() { ... voice: rideVoice ... }
//
// `function` declarations hoist; `const` does not. So `wireRideHud()` ran while
// `rideVoice` was still in its temporal dead zone and threw `ReferenceError:
// Cannot access 'rideVoice' before initialization` during module evaluation —
// which aborts every statement BELOW it. The map and the top bar still rendered
// (they are markup), so the app looked alive while every `wire*` call, the
// ride-modal screen registry and the Ride Mode button's own click handler never
// happened. Ride mode was simply gone, and the console error was the only clue.
//
// `ride-voice-wired.test.ts` asserted `voice: rideVoice` appears in main.ts. It
// did appear. A text test cannot see evaluation order, and the assertion it
// makes is exactly the one the bug satisfies.
//
// WHY A REAL PARSER AND NOT A REGEX. The dangerous reference is one that is
// evaluated WHEN THE FUNCTION IS CALLED. A reference inside a nested callback
// (`freeMinutesAtStart: () => planningFreeMinuteEstimate(...)`) is evaluated
// later and is perfectly legal — `wireRideHud` is full of them. A regex over the
// function body cannot tell the two apart, so it would either miss the bug or
// flag a dozen legal lines, and the second kind of failure gets "fixed" by
// deleting the test. `typescript` is already a devDependency, so this walks the
// real AST and descends into nested functions only to SKIP them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const MAIN = "src/main.ts";

function parse(relativePath: string): ts.SourceFile {
  const abs = join(import.meta.dirname, "..", relativePath);
  return ts.createSourceFile(
    relativePath,
    readFileSync(abs, "utf8"),
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
  );
}

interface Decl {
  name: string;
  /** Character offset of the declaration's start. */
  pos: number;
}

/** Every top-level `const`/`let` binding name, with where it is declared.
 *  `var` is excluded on purpose: it hoists and initialises to `undefined`, so
 *  it has no dead zone to fall into (and this file contains none). */
function topLevelLexicalDecls(sf: ts.SourceFile): Decl[] {
  const out: Decl[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const flags = stmt.declarationList.flags;
    const lexical =
      (flags & ts.NodeFlags.Const) !== 0 || (flags & ts.NodeFlags.Let) !== 0;
    if (!lexical) continue;
    for (const d of stmt.declarationList.declarations) {
      // Destructuring patterns bind several names; collect each.
      const collect = (n: ts.BindingName): void => {
        if (ts.isIdentifier(n)) {
          out.push({ name: n.text, pos: stmt.getStart(sf) });
          return;
        }
        for (const el of n.elements) {
          if (ts.isOmittedExpression(el)) continue;
          collect(el.name);
        }
      };
      collect(d.name);
    }
  }
  return out;
}

/** Top-level `function foo() {}` declarations, by name. */
function topLevelFunctions(sf: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const out = new Map<string, ts.FunctionDeclaration>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) out.set(stmt.name.text, stmt);
  }
  return out;
}

/** Identifiers this function reads AS SOON AS IT IS CALLED.
 *
 *  Descends the body but stops at any nested function, arrow, class or getter
 *  body — those are evaluated later, if ever, so a dead-zone reference inside
 *  one is not a boot-order hazard. Property NAMES (`{ voice: x }`'s `voice`)
 *  and member accesses (`a.b`'s `b`) are skipped: neither is a variable read. */
function eagerlyReadIdentifiers(fn: ts.FunctionDeclaration): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node)
    ) {
      return; // deferred — not evaluated by the call itself
    }
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isPropertyName =
        (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isBindingElement(p) && p.propertyName === node);
      if (!isPropertyName) names.add(node.text);
      return;
    }
    node.forEachChild(walk);
  };
  if (fn.body) fn.body.forEachChild(walk);
  return names;
}

/** Top-level statements that CALL a bare identifier: `foo();` and
 *  `const x = foo();`. Those are the calls that run during module evaluation. */
function topLevelCalls(sf: ts.SourceFile): { callee: string; pos: number }[] {
  const out: { callee: string; pos: number }[] = [];
  const note = (expr: ts.Expression, pos: number): void => {
    let e: ts.Expression = expr;
    // `void foo()` and `await foo()` wrappers still call at top level.
    while (ts.isVoidExpression(e) || ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) {
      e = e.expression;
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      out.push({ callee: e.expression.text, pos });
    }
  };
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt)) {
      note(stmt.expression, stmt.getStart(sf));
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (d.initializer) note(d.initializer, stmt.getStart(sf));
      }
    }
  }
  return out;
}

describe("main.ts module-evaluation order", () => {
  it("never calls a top-level function that reads a not-yet-initialised const", () => {
    const sf = parse(MAIN);
    const decls = topLevelLexicalDecls(sf);
    const fns = topLevelFunctions(sf);
    const lineOf = (pos: number): number =>
      sf.getLineAndCharacterOfPosition(pos).line + 1;

    const violations: string[] = [];
    for (const call of topLevelCalls(sf)) {
      const fn = fns.get(call.callee);
      if (!fn) continue; // imported, or not a top-level function declaration
      const reads = eagerlyReadIdentifiers(fn);
      for (const decl of decls) {
        if (decl.pos <= call.pos) continue; // declared before the call — fine
        if (!reads.has(decl.name)) continue;
        violations.push(
          `${call.callee}() is called at line ${lineOf(call.pos)} but reads ` +
            `'${decl.name}', which is not declared until line ${lineOf(decl.pos)} ` +
            `— that is a ReferenceError at boot, and it aborts the rest of ${MAIN}.`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("declares rideVoice above the wireRideHud() call that reads it", () => {
    // The specific regression, pinned by name as well as by the general rule
    // above: this one cost the whole app, and a named assertion says so in the
    // failure message instead of leaving the next reader to rediscover why.
    const sf = parse(MAIN);
    const voice = topLevelLexicalDecls(sf).find((d) => d.name === "rideVoice");
    const call = topLevelCalls(sf).find((c) => c.callee === "wireRideHud");
    expect(voice, "main.ts no longer declares a top-level `rideVoice`").toBeDefined();
    expect(call, "main.ts no longer calls wireRideHud() at top level").toBeDefined();
    expect(voice!.pos).toBeLessThan(call!.pos);
  });

  it("detects the hazard when the declaration order is reversed (meta-test)", () => {
    // Proves the walker above can actually SEE this bug rather than passing
    // because it finds nothing. Mirrors the real shape: a hoisted function
    // called before the const it reads eagerly, plus a later const it reads
    // only inside a callback — which must NOT be reported.
    const sf = ts.createSourceFile(
      "fixture.ts",
      [
        "const hud = wire();",
        "const voice = make();",
        "const lazy = 1;",
        "function wire() {",
        "  return build({ voice, onTick: () => lazy });",
        "}",
      ].join("\n"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const decls = topLevelLexicalDecls(sf);
    const call = topLevelCalls(sf).find((c) => c.callee === "wire")!;
    const reads = eagerlyReadIdentifiers(topLevelFunctions(sf).get("wire")!);
    const after = decls.filter((d) => d.pos > call.pos && reads.has(d.name));
    expect(after.map((d) => d.name)).toEqual(["voice"]);
  });
});
