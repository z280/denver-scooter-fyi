// Does the app actually BOOT? The one question the unit suite cannot ask.
//
// `src/main.ts` is the entry point: nothing imports it, so vitest never
// evaluates it. Every other module is covered by tests that run its code, but
// main.ts is only ever read as text. A boot-time throw there — a temporal dead
// zone, a missing `need()` id, a bad import — aborts every statement below it
// and silently removes whole features while the page still renders, because the
// map and chrome are markup. That is exactly how ride mode disappeared once:
// `wireRideHud()` ran one line above the `const rideVoice` it reads.
//
// `src/main-boot-order.test.ts` catches that specific class statically. This
// catches ALL of them, by loading the real page in a real browser and failing on
// any uncaught error. Usage:
//
//     npm run dev           # in one shell
//     npm run smoke         # in another
//
// Not part of `npm test` on purpose: it needs a dev server and a browser, and a
// unit suite that needs either is a unit suite people stop running. Chromium
// resolves through PLAYWRIGHT_BROWSERS_PATH when one is set, else playwright's
// own download.
import { chromium } from "playwright";

const URL = process.env.SMOKE_URL ?? "http://127.0.0.1:5173/";
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS ?? 8000);

// Boot noise that is NOT the app's fault and must not fail the run: tiles and
// the API are remote, and a sandbox without egress fails both. A real boot bug
// shows up as a pageerror, which is never filtered.
const IGNORE =
  /ERR_CERT_AUTHORITY_INVALID|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR_|GL Driver|WebGL|\[vite\]|pmtiles/i;

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH
    ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium`
    : undefined,
});
const context = await browser.newContext({
  permissions: ["geolocation"],
  geolocation: { latitude: 39.7392, longitude: -104.9903 },
  viewport: { width: 420, height: 900 },
});
const page = await context.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(`${e.message}\n    ${e.stack ?? ""}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (!IGNORE.test(text)) consoleErrors.push(text);
});

console.log(`smoke: loading ${URL}`);
try {
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
} catch (e) {
  console.error(`smoke: could not load ${URL} — is \`npm run dev\` running?`);
  console.error(String(e));
  await browser.close();
  process.exit(2);
}
await page.waitForTimeout(SETTLE_MS);

// A boot that threw halfway leaves the chrome in place but the wiring absent, so
// "the page rendered" proves nothing — #free-ride and #ride-hud are both markup
// and are there either way. The only honest check is to USE the thing: press
// Ride Mode and see whether a ride actually starts. That button's handler, the
// ride-modal screen registry and the session store are all wired by statements
// below the point where a boot-time throw stops, so a started ride is proof the
// module ran to the end. It is also the exact symptom that was reported.
//
// The first-run tour opens over the button and runs its own focus trap. Dismiss
// it and WAIT FOR IT TO GO before clicking anything — never `force: true` past
// it. Forcing the click opens the ride modal under the tour's live trap, and the
// two traps then steal focus from each other without end (`ride-modal.ts`'s
// `onFocusIn` ↔ `modal-focus-trap.ts`'s `onFocusIn`, a few thousand frames deep
// until the stack gives out). That is a real robustness wart, but it is reached
// only by synthesising a click a rider cannot make — the tour covers the button
// — so provoking it here would make this script fail for a reason that is not
// the boot.
await page.locator('.onboarding button:has-text("Skip")').first().click().catch(() => {});
await page
  .locator(".onboarding")
  .waitFor({ state: "detached", timeout: 8000 })
  .catch(() => {});

let rideStarted = false;
try {
  await page.locator("#free-ride").click({ timeout: 8000 });
  await page.waitForFunction(
    () => {
      try {
        const raw = localStorage.getItem("scooter_fyi.ride_session");
        return raw !== null && JSON.parse(raw).state === "riding";
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 10000 },
  );
  rideStarted = true;
} catch {
  rideStarted = false;
}

const wired = { rideModeStartsARide: rideStarted };

let failed = false;
if (pageErrors.length) {
  failed = true;
  console.error(`\nsmoke: ${pageErrors.length} UNCAUGHT ERROR(S) during boot:`);
  for (const e of pageErrors) console.error(`  - ${e}`);
}
if (consoleErrors.length) {
  failed = true;
  console.error(`\nsmoke: ${consoleErrors.length} console error(s) during boot:`);
  for (const e of consoleErrors) console.error(`  - ${e}`);
}
for (const [name, ok] of Object.entries(wired)) {
  if (!ok) {
    failed = true;
    console.error(`smoke: post-boot check failed: ${name}`);
  }
}

await browser.close();
if (failed) {
  console.error("\nsmoke: FAILED");
  process.exit(1);
}
console.log("smoke: OK — booted with no uncaught errors");
