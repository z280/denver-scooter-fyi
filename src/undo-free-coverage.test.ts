// The iOS shake-to-undo bug, kept from coming back by a NEW field.
//
// `ios-shake-undo.ts` stops "Undo Typing" alerts over the ride HUD in two ways:
// fields marked with `markUndoFree()` never put an edit in WebKit's page-wide
// undo queue, and the queue is cleared at ride start and behind any unguarded
// field left mid-ride. The marking is opt-in, so the way the bug returns is a
// field added to a ride-flow module by someone who never read that file — a
// `type="number"` box WebKit edits itself (unguardable), or a text box nobody
// marked. The owner's rule (2026-10-09): "Don't reintroduce the iPhone shake
// bug!"
//
// So this reads the SOURCE of every module whose fields a rider types into on
// the way into, during, or straight after a ride, and fails when:
//   - a text-like `<input>` (text/search/tel/url/email, or no type at all) or a
//     `<textarea>` is created without `markUndoFree()` on it, or
//   - an input WebKit edits itself (number/date/time/…) is created at all,
// unless the field is in ALLOWED below with the reason it is safe. Checkboxes,
// radios, ranges and file pickers never enter the undo queue and are ignored.
//
// It is a static scan, so it has limits worth knowing: it follows a field by
// its variable name from where it is created to the next creation under the
// same name, and it reads `<input>`/`<textarea>` tags in template strings. A
// field created some other way (a helper in another module, `cloneNode`) is
// not seen — the DOM tests next to each module are the proof for those. A tag
// written out in a COMMENT is read as markup too; reword the comment. The
// sanity block at the bottom fails if the scan stops recognising fields it is
// known to guard, so a regex that rots cannot pass by finding nothing.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** Ride-flow modules: every `ride-*.ts`, plus the surfaces a ride passes
 *  through or can open over the HUD. */
const EXTRA_MODULES = [
  "home-bar.ts", // destination search — the first thing typed before a ride
  "plan-list-panel.ts", // the plan list a ride is chosen from
  "devices.ts", // the device popup, reachable mid-ride on a long press
  "device-features.ts", // ☑️ Confirm Features, opened from that popup
  "equity-receipt-form.ts", // behind the equity chip, which stays up mid-ride
  "rider-story-sheet.ts", // mounted on the failed-start and post-ride screens
  "along-the-way.ts",
  "arrival-panel.ts",
];

function rideFlowModules(): string[] {
  const ride = readdirSync(SRC).filter(
    (f) => /^ride-.*\.ts$/.test(f) && !f.endsWith(".test.ts"),
  );
  return [...ride, ...EXTRA_MODULES].sort();
}

/** Fields that are safe without the guard, and why. Key: `file:variable` for a
 *  scripted field, `file:<tag.class` for markup (or `file:<tag …` and its first
 *  characters when it has no class). */
const ALLOWED: Record<string, string> = {
  "devices.ts:<textarea.device-popup__report-desc":
    "Model-report prose: keeps autocorrect; ios-shake-undo.ts's mid-ride clear runs when it is left (the regression note in its header).",
  "ride-post-s9.ts:textarea":
    "Post-ride navigation feedback (prose). The HUD has left `riding` by then, and the next ride starts with a clear.",
  "ride-post-s9.ts:input":
    "Post-ride model-bonus number box (pre-dates the 2026-10-09 audit). Not reachable while a ride is live; the next ride starts with a clear.",
  "rider-story-sheet.ts:box":
    "The story textarea (prose). Mounted on the stats drawer, the failed-start screen and the post-ride screen — never over the riding view.",
  "rider-story-sheet.ts:mail":
    "Optional reply-to email (free text, keeps autofill). Same surfaces as the story box — never over the riding view.",
  "ride-spec-panel.ts:nameInput":
    "Spec name (free text). The sheet opens from the Filters drawer, which `body.ride-active` hides for the whole ride.",
  "equity-receipt-form.ts:dateInput":
    "Native date picker. equity-map.ts does not offer this form while a ride is live.",
  "equity-receipt-form.ts:timeInput":
    "Native time picker. equity-map.ts does not offer this form while a ride is live.",
};

const TEXTY = new Set(["text", "search", "tel", "url", "email"]);
const NATIVE_EDITED = new Set([
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "password",
]);

interface Finding {
  key: string;
  kind: "unguarded" | "native-edited";
  detail: string;
}

interface Scan {
  findings: Finding[];
  guarded: string[];
}

const CREATE =
  /(?:const|let)\s+(\w+)\s*=\s*(?:el|document\.createElement)\(\s*["'](input|textarea)["']/g;
const TAG = /<(input|textarea)\b[^>]*>/g;

function scan(file: string): Scan {
  return scanSource(file, readFileSync(join(SRC, file), "utf8"));
}

/** The scan proper, over source text — split out so the scanner itself can be
 *  tested on a fixture. */
function scanSource(file: string, src: string): Scan {
  const findings: Finding[] = [];
  const guarded: string[] = [];

  const creations = [...src.matchAll(CREATE)].map((m) => ({
    name: m[1]!,
    tag: m[2]!,
    at: m.index!,
  }));
  creations.forEach((c, i) => {
    // This field's stretch of source: up to the next creation under the same
    // name, so a `box` reused per checkbox is judged one box at a time.
    const next = creations.slice(i + 1).find((o) => o.name === c.name);
    const body = src.slice(c.at, next ? next.at : undefined);
    const key = `${file}:${c.name}`;
    const marked = new RegExp(`markUndoFree\\(\\s*${c.name}\\s*\\)`).test(body);
    let type = "textarea";
    if (c.tag === "input") {
      const t = new RegExp(`\\b${c.name}\\.type\\s*=\\s*["']([\\w-]+)["']`).exec(body);
      type = t ? t[1]! : "text"; // an <input> with no type is a text box
    }
    if (NATIVE_EDITED.has(type)) {
      findings.push({ key, kind: "native-edited", detail: `type="${type}"` });
    } else if (type === "textarea" || TEXTY.has(type)) {
      if (marked) guarded.push(key);
      else findings.push({ key, kind: "unguarded", detail: type });
    }
  });

  for (const m of src.matchAll(TAG)) {
    const tag = m[0];
    // Named by its class where it has one (stable across reformatting), else
    // by the tag's opening text.
    const cls = /\bclass="([^"]+)"/.exec(tag)?.[1];
    const key = `${file}:<${m[1]}${cls ? `.${cls.split(/\s+/).join(".")}` : ` ${tag.replace(/\s+/g, " ").slice(m[1]!.length + 2, 40)}`}`;
    const type =
      m[1] === "textarea" ? "textarea" : (/\btype="([\w-]+)"/.exec(tag)?.[1] ?? "text");
    if (NATIVE_EDITED.has(type)) {
      findings.push({ key, kind: "native-edited", detail: `type="${type}"` });
    } else if (type === "textarea" || TEXTY.has(type)) {
      if (/data-undo-free="on"/.test(tag)) guarded.push(key);
      else findings.push({ key, kind: "unguarded", detail: type });
    }
  }
  return { findings, guarded };
}

const results = new Map(rideFlowModules().map((f) => [f, scan(f)]));

describe("every typed field in a ride-flow module is undo-free, or says why not", () => {
  for (const [file, { findings }] of results) {
    it(file, () => {
      const offending = findings
        .filter((f) => !(f.key in ALLOWED))
        .map((f) =>
          f.kind === "native-edited"
            ? `${f.key} is ${f.detail}: WebKit edits it itself and markUndoFree cannot ` +
              `guard it — use type="text" + inputMode + a JS bound + markUndoFree ` +
              `(see ride-keypad.ts), or add it to ALLOWED with the reason it is safe`
            : `${f.key} (${f.detail}) has no markUndoFree() — add it (ios-shake-undo.ts), ` +
              `or add it to ALLOWED with the reason it is safe`,
        );
      expect(offending).toEqual([]);
    });
  }

  it("has no stale ALLOWED entries", () => {
    // An exception for a field that is gone, or now guarded, is a hole waiting
    // for the next field to fall into under the same name.
    const live = new Set(
      [...results.values()].flatMap((r) => r.findings.map((f) => f.key)),
    );
    expect(Object.keys(ALLOWED).filter((k) => !live.has(k))).toEqual([]);
  });
});

describe("the scan still sees what it is known to guard", () => {
  const guarded = new Set([...results.values()].flatMap((r) => r.guarded));
  it.each([
    "ride-screen-select.ts:plateInput",
    "ride-screen-auth.ts:emailInput",
    "ride-screen-auth.ts:codeInput",
    "ride-screen-dest.ts:input",
    "home-bar.ts:input",
    "device-features.ts:plateInput",
    "plan-list-panel.ts:input",
    "ride-spec-panel.ts:walk",
    "equity-receipt-form.ts:i",
  ])("%s", (key) => {
    expect(guarded.has(key)).toBe(true);
  });

  it("flags an unmarked text box and a number box", () => {
    // The scanner itself, on a fixture, so a broken regex cannot pass by
    // finding nothing anywhere.
    const fixture = [
      'const a = el("input", "x");',
      'const b = document.createElement("input");',
      'b.type = "number";',
      'const c = el("input");',
      'c.type = "checkbox";',
      'const d = el("textarea");',
      "markUndoFree(d);",
      'const html = `<input type="tel" name="p"><textarea data-undo-free="on"></textarea>`;',
    ].join("\n");
    const kinds = scanSource("fixture.ts", fixture).findings.map((f) => `${f.key}|${f.kind}`);
    expect(kinds).toEqual([
      "fixture.ts:a|unguarded",
      "fixture.ts:b|native-edited",
      'fixture.ts:<input type="tel" name="p">|unguarded',
    ]);
  });
});
