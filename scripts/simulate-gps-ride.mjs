#!/usr/bin/env node
// Fakes a rider's GPS movement through a real, visible browser so ride mode
// can be tested end-to-end without physically being in Denver (or on a
// scooter at all). Built for "I'm travelling, can I still test a ride?" —
// see the header of each mode below for what it actually drives.
//
// Setup (once):
//   npm install -D playwright
//   npx playwright install chromium
//
// Usage:
//   node scripts/simulate-gps-ride.mjs                  # interactive mode
//   node scripts/simulate-gps-ride.mjs --auto-guest      # automated smoke test
//   node scripts/simulate-gps-ride.mjs --minutes 6 --lat 39.7392 --lon -104.9903
//
// ---------------------------------------------------------------------------
// INTERACTIVE MODE (default) — the actual "test my own real ride" tool.
//
// Opens a real, visible Chromium window against the live app (or --local for
// your dev server), overrides its GPS to a starting point in Denver, and
// then keeps moving that fake position along a short generated path in the
// background for the configured duration — while YOU drive the actual UI by
// hand in the window: sign in for real (magic link / SMS / Google — nothing
// this script can do for you), pick a real nearby device from the live GBFS
// feed, start the ride, and end it once the console tells you the simulated
// trip has cleared the server's donation-eligibility minimums.
//
// A signed-in (non-guest) ride is REQUIRED to reach Screens 8/9/10 at all —
// "Ride as Guest" makes a private ride, and private rides skip straight to
// `done` (ride-session.ts's reducer: `if (doc.private || ...) return
// accept(doc, withPhase(doc, "done"), ...)`). If you only want a fast,
// no-login smoke test of the wizard + HUD, use --auto-guest instead — it
// won't reach the donation flow, but needs nothing from you.
//
// Why the login step isn't automated too: this repo has no committed,
// verified selectors for the magic-link/SMS/Google sign-in screens (only the
// guest path has been exercised by an automated script), and getting that
// wrong would silently strand you on a broken step instead of just letting
// you do the two-second real thing by hand.
//
// A persistent browser profile is kept in `.gps-sim-profile/` (gitignored)
// so you only have to sign in once — subsequent runs reuse the session.
//
// ---------------------------------------------------------------------------
// --auto-guest MODE — a fast, hands-off regression smoke test.
//
// Fully automated: opens the ride modal, signs in as a guest, picks the
// nearest ranked device, starts the ride, walks the same simulated GPS path,
// and ends the ride via the HUD's own exit prompt (the guest/private path —
// NOT `ride-post-s8.ts`'s Screen 8, since a private ride never reaches it).
// Screenshots land in `scripts/.gps-sim-shots/`. Useful for "did I break the
// wizard" without needing a real account or GPS movement to actually matter,
// since a private ride's summary doesn't depend on distance/duration
// thresholds the way a real donation-eligible one does.
//
// ---------------------------------------------------------------------------
// The simulated path itself: a short, gently zigzagging walk starting at
// --lat/--lon (default: Civic Center Park, downtown Denver), stepping every
// --step-seconds (default 15s) in real wall-clock time — there is no way to
// fast-forward a live server's own clock, so a meaningful test genuinely
// takes a few minutes. Each step logs cumulative distance/elapsed time
// against the API's real donation-eligibility minimums (src/track_verify.py
// in scooter-fyi-api: MIN_WAYPOINTS=10, MIN_DISTANCE_METERS=500,
// MIN_DURATION_MS=180_000) so you know the moment it's safe to end the ride
// and expect an "eligible" verdict rather than "trip_too_short".

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(HERE, "..", ".gps-sim-profile");
const SHOTS_DIR = join(HERE, ".gps-sim-shots");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    autoGuest: false,
    local: false,
    minutes: 5,
    stepSeconds: 15,
    lat: 39.7392, // Civic Center Park, downtown Denver — dense in real GBFS
    lon: -104.9903, // devices most hours of the day.
    bearingDeg: 35, // roughly NE; arbitrary, just needs to be consistent.
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto-guest") opts.autoGuest = true;
    else if (a === "--local") opts.local = true;
    else if (a === "--minutes") opts.minutes = Number(argv[++i]);
    else if (a === "--step-seconds") opts.stepSeconds = Number(argv[++i]);
    else if (a === "--lat") opts.lat = Number(argv[++i]);
    else if (a === "--lon") opts.lon = Number(argv[++i]);
    else if (a === "--bearing") opts.bearingDeg = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/simulate-gps-ride.mjs [--auto-guest] [--local] " +
          "[--minutes N] [--step-seconds N] [--lat N] [--lon N] [--bearing DEG]",
      );
      process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Path generation — a gentle real-world-plausible zigzag, not a straight
// ruler line, so consecutive-waypoint distances look like an actual walk.
// ---------------------------------------------------------------------------

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLon(atLatDeg) {
  return METERS_PER_DEG_LAT * Math.cos((atLatDeg * Math.PI) / 180);
}

/** Steps of ~40m each, alternating +/-12 degrees off the base bearing so the
 *  path isn't perfectly straight. Returns [{lat, lon}], length `steps`. */
function generatePath(startLat, startLon, bearingDeg, steps) {
  const path = [{ lat: startLat, lon: startLon }];
  const stepMeters = 40;
  let lat = startLat;
  let lon = startLon;
  for (let i = 1; i < steps; i++) {
    const jitter = i % 2 === 0 ? 12 : -12;
    const bearing = ((bearingDeg + jitter) * Math.PI) / 180;
    const dLat = (stepMeters * Math.cos(bearing)) / METERS_PER_DEG_LAT;
    const dLon = (stepMeters * Math.sin(bearing)) / metersPerDegLon(lat);
    lat += dLat;
    lon += dLon;
    path.push({ lat, lon });
  }
  return path;
}

function haversineMeters(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Real thresholds from scooter-fyi-api's src/track_verify.py — kept as a
// LITERAL COPY (not imported; separate repo) purely to print progress
// against them. If those constants change, this drifts — it's advisory
// console output, not something the ride itself depends on.
const MIN_WAYPOINTS = 10;
const MIN_DISTANCE_METERS = 500;
const MIN_DURATION_MS = 180_000;

// ---------------------------------------------------------------------------
// Shared: walk the path in the background, logging progress.
// ---------------------------------------------------------------------------

async function walkPath(context, path, stepSeconds, onStep) {
  const startedAtMs = Date.now();
  let cumulativeMeters = 0;
  for (let i = 0; i < path.length; i++) {
    const point = path[i];
    if (i > 0) cumulativeMeters += haversineMeters(path[i - 1], point);
    await context.setGeolocation({
      latitude: point.lat,
      longitude: point.lon,
      accuracy: 8,
    });
    const elapsedMs = Date.now() - startedAtMs;
    const eligible =
      i + 1 >= MIN_WAYPOINTS &&
      cumulativeMeters >= MIN_DISTANCE_METERS &&
      elapsedMs >= MIN_DURATION_MS;
    onStep({
      step: i + 1,
      total: path.length,
      point,
      cumulativeMeters,
      elapsedMs,
      eligible,
    });
    if (i < path.length - 1) {
      await new Promise((r) => setTimeout(r, stepSeconds * 1000));
    }
  }
  // Hold at the final point rather than snapping back anywhere — the ride
  // shouldn't visibly teleport just because the generated path ran out.
}

function formatProgress({ step, total, cumulativeMeters, elapsedMs, eligible }) {
  const mm = String(Math.floor(elapsedMs / 60_000)).padStart(2, "0");
  const ss = String(Math.floor((elapsedMs % 60_000) / 1000)).padStart(2, "0");
  const dist = cumulativeMeters.toFixed(0);
  const base = `[t+${mm}:${ss}] step ${step}/${total} — ~${dist}m travelled`;
  return eligible ? `${base} — ✅ donation-eligible thresholds cleared` : base;
}

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

async function runInteractive(opts) {
  const appUrl = opts.local ? "http://localhost:5173/" : "https://denver.scooter.fyi/";
  mkdirSync(PROFILE_DIR, { recursive: true });

  console.log(`Launching a real Chromium window against ${appUrl}`);
  console.log(`(Signed-in session persists in ${PROFILE_DIR} across runs.)\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 480, height: 900 },
    geolocation: { latitude: opts.lat, longitude: opts.lon, accuracy: 8 },
    permissions: ["geolocation"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    "The browser window is now at your fake starting position in Denver.\n" +
      "In that window: sign in for real if you aren't already, tap the 🧭 Ride\n" +
      "button, pick a real nearby device from the list, and start the ride —\n" +
      "all by hand. This script will start moving your fake GPS in the\n" +
      "background the moment you press Enter here.\n",
  );
  await rl.question("Press Enter to start the simulated walk… ");
  rl.close();

  const path = generatePath(
    opts.lat,
    opts.lon,
    opts.bearingDeg,
    Math.max(MIN_WAYPOINTS + 4, Math.round((opts.minutes * 60) / opts.stepSeconds)),
  );
  console.log(
    `\nWalking a ${path.length}-point simulated path, one step every ` +
      `${opts.stepSeconds}s (~${Math.round((path.length * opts.stepSeconds) / 60)} min total).\n` +
      "End your ride in the app once you see the eligible ✅ line below — " +
      "ending earlier will land you on a genuine (and correct) trip_too_short " +
      "verdict, same as it would for a real too-short ride.\n",
  );

  await walkPath(context, path, opts.stepSeconds, (progress) => {
    console.log(formatProgress(progress));
  });

  console.log(
    "\nPath complete — holding your fake position at its last point.\n" +
      "Finish testing in the browser window, then Ctrl+C here when you're done.",
  );
  await new Promise(() => {}); // hold open until the user Ctrl+Cs
}

// ---------------------------------------------------------------------------
// --auto-guest mode — fully automated, no login required, private ride only.
// ---------------------------------------------------------------------------

async function runAutoGuest(opts) {
  const appUrl = opts.local ? "http://localhost:5173/" : "https://denver.scooter.fyi/";
  mkdirSync(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    geolocation: { latitude: opts.lat, longitude: opts.lon, accuracy: 8 },
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log("PAGE EXCEPTION:", err.message));

  console.log(`--auto-guest: driving the guest wizard + HUD against ${appUrl}`);

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.click("#ride-open");
  await page.waitForTimeout(600);
  await page.click(".ride-modal button:has-text('Ride as Guest')");
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SHOTS_DIR, "01-device-select.png") });

  await page.click(".ride-modal .ride-option >> nth=0");
  await page.waitForTimeout(300);
  await page.click(".ride-modal button:has-text('NEXT')");
  await page.waitForTimeout(800);
  await page.click(".ride-modal button:has-text('I already started')");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS_DIR, "02-hud.png") });
  console.log(`shot: ${join(SHOTS_DIR, "02-hud.png")}`);

  const path = generatePath(
    opts.lat,
    opts.lon,
    opts.bearingDeg,
    Math.max(6, Math.round((opts.minutes * 60) / opts.stepSeconds)),
  );
  await walkPath(context, path, opts.stepSeconds, (progress) => {
    console.log(formatProgress(progress));
  });

  await page.click('[data-hud="exit"]');
  await page.waitForTimeout(400);
  await page.click('[data-hud-prompt="exit"] [data-hud="end"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS_DIR, "03-post-ride.png") });
  console.log(`shot: ${join(SHOTS_DIR, "03-post-ride.png")}`);
  console.log(
    "\n--auto-guest done (private/guest ride — this never reaches Screens " +
      "8/9/10; use interactive mode signed in for real to test those).",
  );

  await browser.close();
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.autoGuest) {
    await runAutoGuest(opts);
  } else {
    await runInteractive(opts);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
