// Vitest config — introduced by ride-mode phase F1.
//
// Deliberately a SEPARATE file from vite.config.ts rather than a `test` block
// inside it: Vitest prefers vitest.config.ts and then ignores vite.config.ts
// entirely, so the test runner never drags in the dev-server proxy, the
// manualChunks split or the build target — none of which a unit test wants —
// and the app's build config stays a single-purpose file.
//
// Environment: `node` by default, because the units F1–F4 test are DOM-free
// (the ride-session reducer, the track-store chain math, cost/tax math,
// eligibility-copy generation, the leaderboard payload transform). A test that
// needs a DOM opts in per file with a docblock on line 1:
//
//     // @vitest-environment happy-dom
//
// which is the version-proof replacement for the removed `environmentMatchGlobs`
// option. `happy-dom` is a devDependency for exactly that.
//
// Test files may live beside their source (`src/**/*.test.ts`) or in the
// `tests/` tree (`tests/**/*.test.ts`) — later phases add both. Shared golden
// vectors live at `tests/fixtures/track-chain-vectors.json`, committed
// byte-identically at that same literal path in the API repo; it is a fixture,
// not a test file, so the include globs leave it alone.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Guarantees `crypto.subtle` in every environment — the track-store HMAC
    // tests need WebCrypto, and happy-dom does not supply it.
    setupFiles: ["tests/setup/webcrypto.ts"],
    // A `vi.stubGlobal("fetch", ...)` in one file must not leak into the next.
    unstubGlobals: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
