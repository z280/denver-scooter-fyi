// Boot the BUILT site in a real browser and fail on any uncaught error.
//
// WHY. On 2026-10-07 main.ts called wireRideHud() at module load before the
// `const rideVoice` it reads was declared. That is a ReferenceError at startup
// ("Cannot access 'Yw' before initialization"), it stopped main.ts before a
// single vehicle was drawn, and the map was blank for ~11 hours. Every CI check
// passed: tsc cannot see initialisation order, vitest imports modules piecemeal,
// and nothing ever loaded the page. This is the check that would have failed.
//
// WHAT IT DOES. Serves dist/ on 127.0.0.1, blocks every other host (the API,
// map tiles, fonts: CI must not depend on production, and the app has to
// survive being offline anyway), loads the page in headless Chromium, waits
// for startup to settle, and exits non-zero if the page threw anything
// uncaught, or if the page never got as far as creating the map.
//
// Run: npm run build && npm run smoke

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const DIST = resolve(process.argv[2] ?? "dist");
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS ?? 8000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

async function serveFile(res, path) {
  const body = await readFile(path);
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let path = join(DIST, rel);
    if (!path.startsWith(DIST)) throw new Error("outside dist");
    const st = await stat(path).catch(() => null);
    if (st?.isDirectory()) path = join(path, "index.html");
    else if (!st) path = join(DIST, "index.html"); // SPA fallback, as Pages does
    await serveFile(res, path);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const errors = [];
// SMOKE_CHANNEL=chrome in CI: GitHub's Ubuntu runners ship Google Chrome, so
// nothing is downloaded (`playwright install --with-deps` hung for 15+ min in
// apt on the first run). Locally, Playwright's bundled Chromium.
const browser = await chromium.launch(
  process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {},
);
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
  page.on("pageerror", (e) => errors.push(e.stack || String(e)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(SETTLE_MS);
  const started = await page.evaluate(() => !!document.querySelector("canvas.maplibregl-canvas"));
  if (!started) errors.push("the map never initialised (no maplibre canvas)");
} catch (e) {
  errors.push(`smoke harness: ${e.stack || e}`);
} finally {
  await browser.close();
  server.close();
}

if (errors.length) {
  console.error(`SMOKE FAILED: ${errors.length} uncaught error(s) booting the built site:\n`);
  for (const e of errors) console.error(`  ${e}\n`);
  exitCode = 1;
} else {
  console.log("smoke ok: the built site boots with no uncaught errors");
}
process.exit(exitCode);
