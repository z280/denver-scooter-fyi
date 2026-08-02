// @vitest-environment happy-dom
//
// Scaffold proof for the F1 test runner, deliberately in the `tests/` tree
// rather than beside a source file: it asserts that BOTH include globs resolve
// (this file plus `src/api.test.ts`), that the per-file happy-dom docblock
// above actually swaps the environment, and that the WebCrypto setup file
// applies inside that environment too — the three things later phases' tests
// (track-store HMAC, modal DOM assertions) depend on and would otherwise
// discover the hard way.
import { describe, expect, it } from "vitest";

describe("test scaffold", () => {
  it("provides a DOM in files that opt into happy-dom", () => {
    const el = document.createElement("div");
    el.className = "ride-modal";
    document.body.append(el);
    expect(document.querySelector(".ride-modal")).toBe(el);
    el.remove();
  });

  it("provides WebCrypto with subtle in the DOM environment", async () => {
    expect(typeof crypto.subtle?.importKey).toBe("function");
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(mac)).toHaveLength(32);
  });
});
