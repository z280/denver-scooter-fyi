// Vitest setup: guarantee a WebCrypto implementation with `subtle`.
//
// track-store.ts signs every sealed batch with HMAC-SHA256 through
// `crypto.subtle`, and its tests verify against golden vectors byte-shared with
// the API's pytest suite. Node ≥20 exposes WebCrypto as `globalThis.crypto` in
// the `node` environment, but the `happy-dom` environment installs its own
// `crypto` shim that has no `subtle` — so any DOM-flavoured test that touches
// signing would fail for a reason that has nothing to do with the code under
// test. Patch it once, here, in whichever environment is active.
import { webcrypto } from "node:crypto";

const existing = globalThis.crypto as Crypto | undefined;
if (!existing?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto as unknown as Crypto,
    configurable: true,
    writable: true,
  });
}
