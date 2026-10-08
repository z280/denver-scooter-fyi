// Screenshot the surfaces a change touches, through the Vite dev server.
//
// WHY A HARNESS AND NOT JUST THE APP. Half of what is worth looking at needs
// state the app cannot reach offline — a multi-leg trip in progress, a profile
// with an unverified phone, a route with four maneuvers. `shots/harness.ts`
// mounts those panels directly with fixtures, which is also why they render
// against the REAL stylesheet rather than a mock of it: a layout bug that only
// shows up next to its own CSS is most of what a screenshot is for.
//
// It earned its keep immediately: the first run threw
// "Cannot access 'phoneVerified' before initialization" off the real app page,
// a boot-stopping temporal-dead-zone error that tsc and vitest cannot see.
//
// Run: npx vite --port 5173 &  then  node scripts/shots.mjs docs/screenshots
// SHOT_EXECUTABLE points at a browser binary when Playwright's own revision
// is absent (a prebaked container image), same as scripts/smoke.mjs.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const ORIGIN = process.env.SHOT_ORIGIN ?? "http://127.0.0.1:5173";
const OUT = process.argv[2] ?? "docs/screenshots";
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch(
  process.env.SHOT_EXECUTABLE ? { executablePath: process.env.SHOT_EXECUTABLE } : {},
);
const errors = [];
const page = await browser.newPage({ viewport: { width: 440, height: 1400 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => errors.push(e.stack || String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
await page.goto(`${ORIGIN}/scripts/shots/harness.html`, { waitUntil: "load", timeout: 60_000 });
await page.waitForTimeout(2500);

const shots = [
  ["nav-prefs", "#nav-prefs"],
  ["trip-clear", "#trip"],
  ["trip-clear-confirm", "#trip2"],
  ["nav-step-magnifier", "#hud"],
];
for (const [name, sel] of shots) {
  const node = await page.$(sel);
  if (!node) { errors.push(`missing ${sel}`); continue; }
  await node.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`wrote ${OUT}/${name}.png`);
}
// --- The real app, at phone width, for the ribbon's screen-space etiquette.
// Offline: no vehicles, no tiles. The chrome is the subject.
const app = await browser.newPage({ viewport: { width: 412, height: 780 }, deviceScaleFactor: 2 });
app.on("pageerror", (e) => errors.push(`app: ${e.stack || String(e)}`));
await app.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: 60_000 });
await app.waitForTimeout(4000);
// The welcome card owns the screen on a first visit and intercepts the tab
// click below. Dismissed through its own close button so its teardown runs.
const welcomeClose = await app.$(".onboarding button[aria-label*='lose'], .onboarding .onboarding__close");
if (welcomeClose) await welcomeClose.click();
else await app.evaluate(() => document.querySelector(".onboarding")?.remove());
await app.waitForTimeout(400);
// Force the phone case regardless of the stored preference.
await app.evaluate(() => {
  document.body.classList.add("ribbon-open");
});
await app.screenshot({ path: `${OUT}/ribbon-open.png` });
console.log(`wrote ${OUT}/ribbon-open.png`);
await app.click('.drawer-tab[data-drawer="devices"]');
await app.waitForTimeout(900);
await app.screenshot({ path: `${OUT}/ribbon-yielded.png` });
console.log(`wrote ${OUT}/ribbon-yielded.png`);

await browser.close();
if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
