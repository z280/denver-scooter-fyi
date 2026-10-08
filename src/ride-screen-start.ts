// Screen 6 — "Open in Veo" (frontend plan, `ride-screen-start.ts` row;
// master Part 0 Screen 6: "Most similar to the current pre-start page. Since
// the scooter and its start link are known: offer Android and Apple
// 'Start in Veo' buttons which trigger a default 10 s countdown; an
// 'I already started' button skips the countdown. After countdown or manual
// start, ride mode initiates.").
//
// This is the reducer's ONLY seat for `rideStarted` (`ride-session.ts`:
// legal only from phase `countdown` or `wizard:6`), so it owns the single
// `POST /tracked-rides` call for this flow — the master's data-flow diagram
// ("S6 start) → POST /tracked-rides") and the reducer's own recovery-table
// comment ("crash before `startTrackedRide` resolved … reopen the wizard at
// `wizard:6`") both anchor the call here, not earlier in the wizard.
//
// ---------------------------------------------------------------------------
// RESOLVED (review pass) — Screen 6 is universal for any selected device.
//
// The original skip predicate gated Screen 6 on a real (non-"own") Veo device
// AND `RideOptions.cost_hud === true`, quoting the master doc's Screen 6
// heading literally: "(specific Veo device + cost-HUD tracking opted)". Taken
// literally, that left an "own device" ride and a real-device ride with the
// cost HUD off with no way to ever dispatch `rideStarted` — the reducer's
// ONLY seat for that action — so neither could ever reach `riding`. Flagged
// as a blocker in review: master Part 0 clearly intends "My own Device" to be
// a first-class Screen 2 choice, so the gate itself was the bug, not a
// product decision to relitigate.
//
// Resolution: `startScreenSkip` now only skips when NO device is selected at
// all (`doc.device === null`) — own-device and real-device rides both land
// on Screen 6. Inside the screen, `own-device` renders a simplified "Start
// ride mode" affordance (no Veo deep links/plate/countdown — there is no Veo
// app to coordinate with for a private ride) that goes straight through the
// same `finishStart()` used by the countdown/"I already started" paths for a
// real device. `cost_hud` no longer gates entry to this screen at all — it
// only ever affected the HUD's own display, per its name.
//
// UPDATE (onboarding-friendliness pass): an own-device ("My Scooter/Bike")
// ride now AUTO-STARTS on mount instead of showing even that one-button
// affordance — with no Veo app in the picture, the tap answered nothing.
// The simplified face survives only as the fallback after a failed attempt.
// Riders on a real Veo scooter keep this page as-is: they genuinely need
// the start link / countdown to coordinate unlocking in the Veo app.
// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------
// FIX — guest/private rides must never call the authed-only start endpoint.
//
// `startTrackedRide` (api.ts) is `authedFetchJSON`-backed — session-authed,
// 401s with no bearer token. `startScreenSkip` only gates on a real device +
// `cost_hud`, not on auth, and `cost_hud` defaults `true`
// (`ride-settings.ts`'s `defaultRideOptions`) — so an unauthenticated guest
// who picks a real Veo device reaches this screen in the common case. A
// guest's real-device pick is still a PRIVATE ride (`ride-screen-select.ts`'s
// `syncSessionDevice` now sets `doc.private` accordingly — see its own
// comment for why), and `ride-session.ts`'s `rideStarted` action already
// supports a `rideId: null` / `private: true` local-only start for exactly
// this case. `finishStart` below branches on `doc.private`: a private ride
// never attempts the network call (which would otherwise throw `NO_AUTH` and
// strand the guest on a "Couldn't start the ride" loop with no way forward)
// and instead starts the ride locally, matching the master glossary's guest
// ride ("no server key, no points; tracks stay local").
//
// ---------------------------------------------------------------------------
// SCOPE NOTE — track-store is deliberately NOT touched here.
//
// `startTrackedRide`'s response carries `track_signing` (the per-ride HMAC
// key material `track-store.ts` needs to start recording), but wiring
// `openTrackStore()` / `TrackRecorder.startServerRide()` is Phase F3's job
// ("live track-store integration", a separate lane) together with the shared
// `watchPosition` feed. This screen's contract with that lane is the
// `onRideStarted` hook below: it fires with the full `StartedTrackedRide`
// (track_signing included) right after the session dispatch, before
// `ctx.next()` hands off to the HUD, so whichever module owns the recorder
// can start it before any fix arrives. Until that lane wires the hook, this
// screen still compiles and works — `onRideStarted` is optional.
// ---------------------------------------------------------------------------

import {
  registerRideScreen,
  type RideScreen,
  type RideScreenContext,
} from "./ride-modal.ts";
import type { Locate, LngLat } from "./locate.ts";
import { veoDeepLink } from "./config.ts";
import { MODEL_NAMES, type ModelKey } from "./model-catalog.ts";
import {
  isOwnDevice,
  selectedDevice,
  type RideSessionDoc,
  type RideSessionSelectedDevice,
  type RideSessionStore,
} from "./ride-session.ts";
import {
  ApiError,
  startTrackedRide as defaultStartTrackedRide,
  type StartedTrackedRide,
  type StartTrackedRideIn,
} from "./api.ts";
import {
  failedStartCounted,
  reportFailedStart,
  type FailedStartResult,
} from "./ride-failed-start.ts";
import { submitDeviceReport as defaultSubmitDeviceReport } from "./reports.ts";
import {
  fetchSurveyOptions as defaultFetchSurveyOptions,
  submitRiderStory as defaultSubmitRiderStory,
} from "./api.ts";
import {
  preRideReachSentence,
  rideReach,
  shouldWarnReach,
} from "./ride-reach.ts";
import { mountStoryPanel, type StoryPanel } from "./rider-story-sheet.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Screen 6's default countdown, in seconds. MUST match `ride-hud.ts`'s own
 *  default delay (the `<option selected>` in its `#hud-delay` picker) — the
 *  master vision names "a default 10 s countdown" once, and the legacy HUD's
 *  in-page countdown is that same default until F3 retires it. `ride-hud.ts`
 *  is out of this lane's edit scope (a sibling F3 lane owns it), so this
 *  constant can't import the other side's value — instead, this module's own
 *  test file reads `ride-hud.ts`'s SOURCE to pull the live default out of it,
 *  so the two can never silently drift apart without a failing test flagging
 *  it. Do not "fix" this test by hardcoding a second literal `10`. */
export const START_COUNTDOWN_S = 10;

// ---------------------------------------------------------------------------
// Skip predicate
// ---------------------------------------------------------------------------

/** Screen 6 shows for any selected device — own or real — and skips only
 *  when nothing was picked at all. See the module RESOLVED note above for
 *  why this no longer gates on `cost_hud`. */
export function startScreenSkip(doc: RideSessionDoc | null): boolean {
  if (!doc) return true;
  return doc.device === null;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type SessionLike = Pick<RideSessionStore, "current" | "dispatch">;

/** Read-only: GPS enablement is Screen 1's job, this screen only reads the
 *  resolved fix (the ride's `start_lat`/`start_lon`) and reacts to a late one
 *  arriving. */
export type LocateLike = Pick<Locate, "current" | "onFix">;

export interface RideScreenStartDeps {
  session: SessionLike;
  locate: LocateLike;
  /** Injected for tests; defaults to `startTrackedRide` from api.ts. */
  startTrackedRide?(
    body: StartTrackedRideIn,
    signal?: AbortSignal,
  ): Promise<StartedTrackedRide>;
  /** Fires once, right after a successful start (session already dispatched
   *  `rideStarted`, before `ctx.next()` hands off) — see the module's SCOPE
   *  NOTE. Optional so this lane's own tests, and any build before the
   *  track-store lane wires it, don't need a fake. */
  onRideStarted?(ride: StartedTrackedRide): void;
  /** Fires once, right after a successful PRIVATE start (session already
   *  dispatched `rideStarted` with this same `trackKeyId`, before
   *  `ctx.next()` hands off) — the private-ride mirror of `onRideStarted`.
   *  Lets the integrator mint the local `TrackRecorder` under the SAME id
   *  the session doc already carries: `track-store.ts`'s
   *  `resumeRide(trackId, {isPrivate: true})` mints a brand-new private ride
   *  under a caller-supplied id when no local record exists yet (see that
   *  function's own doc comment) — the one-ID contract this hook exists to
   *  make possible. Optional for the same reasons as `onRideStarted`. */
  /** The survey instrument's value sets, and the story submission. Injected
   *  for the same reason `submitDeviceReport` is — and here it also keeps the
   *  test suite off the network: this screen fetches the neighbourhood list in
   *  the background, and an un-stubbed default makes a real request from
   *  every test that opens the failure face. */
  fetchSurveyOptions?: typeof defaultFetchSurveyOptions;
  submitRiderStory?: typeof defaultSubmitRiderStory;
  onPrivateRideStarted?(trackKeyId: string): void;
  /** Fires when `startTrackedRide` throws a 409 — "an active ride already
   *  exists" (that function's own doc comment: "the resume-or-end prompt's
   *  trigger"). The caller fetches the conflicting ride and shows the shared
   *  prompt (`ride-resume-prompt.ts`'s `showResumeOrEnd`, built from
   *  `ride-session.ts`'s exported `recoveryForServerConflict`) instead of
   *  this screen's own dead-end static error copy. Optional: omitted falls
   *  back to `describeStartError`'s static 409 message (tests, or any build
   *  before this hook is wired). */
  onServerConflict?(): void;
  /** Clock injection for tests; defaults to `Date.now`. Only used as a
   *  fallback when the server's own `started_at` fails to parse, and as the
   *  private-ride start clock (there is no server `started_at` to prefer). */
  now?(): number;
  /** Injected for tests (deterministic ids); defaults to
   *  `crypto.getRandomValues`. Only used for a private/guest ride's local
   *  `trackKeyId` — a real server ride's id comes from the API response. */
  randomBytes?(n: number): Uint8Array;
  /** §11.5's BEFORE half: `current_range_meters` for the chosen vehicle, from
   *  the UNFILTERED feed, or null when the feed has no figure for it.
   *
   *  The same narrow method the HUD takes for the during-ride warning, and for
   *  the same two reasons: this screen has no other business knowing a GBFS
   *  property name, and a stub for a test is one function instead of a
   *  FeatureCollection. Optional — omitted, there is no observation, and the
   *  confidence floor says nothing rather than guessing. */
  rangeMetersFor?(vehicleIdentifier: string): number | null;
  /** Injected for tests; defaults to `submitDeviceReport` from reports.ts.
   *  Carries this screen's "It won't start" report — see
   *  `ride-failed-start.ts` for why this screen is where that button belongs
   *  and what the fleet does without it. */
  submitDeviceReport?: typeof defaultSubmitDeviceReport;
}

/** Register Screen 6. Call once at startup; returns an unregister function
 *  for tests/HMR. */
export function wireRideScreenStart(deps: RideScreenStartDeps): () => void {
  return registerRideScreen("6", {
    skip: () => startScreenSkip(deps.session.current()),
    factory: (ctx) => buildStartScreen(ctx, deps),
  });
}

// ---------------------------------------------------------------------------
// Copy / formatting helpers
// ---------------------------------------------------------------------------

function deviceSummaryLabel(device: RideSessionSelectedDevice): string {
  // MODEL_NAMES, never a capitalized key: the "trike" key's rider-facing
  // name is "Rover" (model-catalog.ts). The session stores the model as a
  // plain string (a persisted doc may predate a key), so resolve through
  // modelKeyOf-compatible lookup and fall back to the stored text as-is.
  const key = device.model as ModelKey | null;
  const name =
    key !== null && key in MODEL_NAMES ? MODEL_NAMES[key] : device.model ?? "Scooter";
  return device.plate ? `${name} — plate ${device.plate}` : name;
}

function describeStartError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "You already have an active ride running — check another tab or device, or come back once it's finished.";
    }
    if (err.status === 404) {
      return "That scooter isn't in the live feed anymore — go back and pick another.";
    }
  }
  return "Couldn't start the ride — check your connection and try again.";
}

/** The server's own `started_at` is the authoritative clock (it is what the
 *  ride row itself was created with); the client `now()` is only a fallback
 *  for the — extremely unlikely — case that field fails to parse. */
/** §11.2: how far back a scan is still evidence about THIS ride.
 *
 *  A rider who scans a sticker and starts the ride is doing it inside a minute
 *  or two: open Veo, find the unlock, press it. Past this, the scan is about a
 *  scooter they looked at and walked away from — maybe they scanned three, or
 *  scanned one and took a phone call — and backdating the clock to it would
 *  invent minutes nobody was charged for. Five minutes is generous for the
 *  real case and far short of the ones that would do harm. */
export const MAX_SCAN_BACKDATE_MS = 5 * 60_000;

/** The scan time, when it is still evidence, else null.
 *
 *  Refuses a timestamp in the FUTURE as well as a stale one: a device whose
 *  clock jumped would otherwise hand us a negative elapsed time, and a clock
 *  that counts backwards is worse than one that starts late. */
export function usableScanStart(
  scannedAtMs: number | undefined,
  nowMs: number,
): number | null {
  if (scannedAtMs === undefined || !Number.isFinite(scannedAtMs)) return null;
  const age = nowMs - scannedAtMs;
  if (age < 0 || age > MAX_SCAN_BACKDATE_MS) return null;
  return scannedAtMs;
}

/** When the ride started, best available.
 *
 *  THE ORDER IS EARLIEST-OBSERVED-WINS, and that is the whole of §11.2's first
 *  half. The server's `started_at` is when the row was created, which is after
 *  the rider unlocked; the scan is before it. Veo bills from the unlock, which
 *  sits between the two, so taking the scan makes our clock run LONG and the
 *  server's makes it run SHORT. Long is the safe way for a cost estimate to be
 *  wrong: a rider who budgeted for more than Veo charged is not the rider this
 *  can harm, and the ±15s nudges exist precisely because the short version was
 *  what we shipped.
 *
 *  `Math.min` rather than "prefer the scan": a scan that somehow postdates the
 *  server row is not evidence of anything, and the guard costs one call. */
function resolveStartedAtMs(
  ride: StartedTrackedRide,
  now: () => number,
  scannedAtMs: number | undefined,
): number {
  const parsed = Date.parse(ride.started_at);
  const serverMs = Number.isFinite(parsed) ? parsed : now();
  const scan = usableScanStart(scannedAtMs, now());
  return scan === null ? serverMs : Math.min(scan, serverMs);
}

/** `private-<hex>` local track id (ride-session.ts's `RideSessionDoc.
 *  trackKeyId` doc: "a `private-<hex>` local id for a private one"; the same
 *  convention `track-store.ts`'s own `startPrivateRide` uses). Generated here
 *  rather than imported from `track-store.ts` — wiring the actual recorder is
 *  Phase F3's job (see the module SCOPE NOTE); this is only what the SESSION
 *  transition needs to identify the local, unsigned recording it names. */
function randomPrivateTrackId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(6);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `private-${hex}`;
}

/** Funnel telemetry over the window CustomEvent channel, the same way
 *  `ride-modal.ts` does it — so this screen keeps importing no app state and
 *  `telemetry.ts` keeps its allowlist and its opt-out as the only gate. The
 *  outcome rides along because "reported" and "deduped" mean different things
 *  about how much of the fleet is already known to be broken. */
function emitFailedStartTrack(outcome: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent("scooter:track", {
        detail: { n: "ride_failed_start", p: { outcome } },
      }),
    );
  } catch {
    /* telemetry must never break the flow */
  }
}

function defaultRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Screen build
// ---------------------------------------------------------------------------

function buildStartScreen(
  ctx: RideScreenContext,
  deps: RideScreenStartDeps,
): RideScreen {
  const doc0 = deps.session.current();
  const device0 = doc0 ? selectedDevice(doc0.device) : null;
  const own0 = doc0 ? isOwnDevice(doc0.device) : false;

  // Defensive: `startScreenSkip` should have kept the router off this screen
  // for anything else, but a stray direct `ctx.go("6")` (or a test harness
  // building the factory straight) must not crash — never strand the rider
  // inside a broken dialog (`ride-modal.ts`'s own discipline for a throwing
  // factory).
  if (!doc0 || (!device0 && !own0)) {
    const root = el("div", "ride-wizard__body ride-screen-start");
    root.append(
      el("p", "ride-wizard__lede", "No scooter selected"),
      el(
        "p",
        "ride-wizard__hint",
        "Go back and pick the scooter you're standing next to before opening it in Veo.",
      ),
    );
    return { title: "Open in Veo", primary: root };
  }

  let destroyed = false;
  let mode: "idle" | "counting" = "idle";
  let busy = false;
  let remaining = START_COUNTDOWN_S;
  let errorMessage: string | null = null;
  let fix: LngLat | null = deps.locate.current();
  let countdownTimer: number | undefined;
  let abortController: AbortController | null = null;
  /** The "It won't start" report, once it has come back. Non-null switches
   *  the screen to its own face: the rider has stopped trying to start THIS
   *  scooter, so re-rendering the Veo buttons under the answer would invite
   *  them to try again on a scooter they just told us is dead. */
  let failedStart: FailedStartResult | null = null;
  /** The story panel under the failure message, and the list its third-party
   *  lane needs. Both are lazy: a rider whose scooter starts normally never
   *  pays for either. */
  let storyPanel: StoryPanel | null = null;
  let storyNeighborhoods: readonly string[] | null = null;
  let storyNeighborhoodsTried = false;
  let reportingFailedStart = false;

  // ---- Auto-start (the device-card "Use in Ride Mode" survey path).
  //
  // `ride-preflight.ts` sets `entry.autoStart` when its survey established
  // that there is nothing left to ask about Veo: either the rider said they
  // had already unlocked the scooter, or they turned the cost HUD off, which
  // per spec removes the consideration of starting Veo altogether.
  //
  // This screen still RUNS — it is the reducer's only legal seat for
  // `rideStarted` (module header), so a path that skipped it could never
  // reach `riding` — it just doesn't ask anything. It takes exactly the
  // "I already started" branch, which is the same branch the button would
  // have taken, so there is no second start path to keep in sync.
  //
  // `autoStartSettled` is what stops it being a trap: the moment the attempt
  // comes back unsuccessfully (a failed start, or the 409 that hands off to
  // the resume-or-end prompt) the screen falls back to its normal, fully
  // interactive idle render. A rider is never left staring at "Starting your
  // ride…" with no control on screen.
  //
  // An own-device ("My Scooter/Bike") ride ALWAYS auto-starts: there is no
  // Veo app to coordinate with, so the old "Start ride mode" button was one
  // pointless tap — non-Veo riders go straight to riding. The interactive
  // own-device face below survives only as the fallback after a failed
  // attempt.
  const autoStart = ctx.entry.autoStart === true || own0;
  let autoStartSettled = false;

  const root = el("div", "ride-wizard__body ride-screen-start");

  function canStart(): boolean {
    return !busy && mode === "idle" && fix !== null;
  }

  /** Fire the auto-start once the preconditions hold. Called at mount and
   *  again on every location fix — at mount there is very often no fix yet
   *  (Screen 1 primed the permission; the first reading can lag), and
   *  auto-start must wait for it exactly as the buttons do rather than
   *  failing on the spot. */
  function maybeAutoStart(): void {
    if (!autoStart || autoStartSettled || destroyed) return;
    if (!canStart()) return;
    autoStartSettled = true;
    onAlreadyStarted();
  }

  function render(): void {
    root.replaceChildren();
    if (reportingFailedStart) {
      root.append(el("p", "ride-wizard__lede", "Telling the fleet…"));
      return;
    }
    if (failedStart) {
      renderFailedStart();
      return;
    }
    if (busy) {
      root.append(el("p", "ride-wizard__lede", "Starting your ride…"));
      return;
    }
    if (mode === "counting") {
      renderCounting();
      return;
    }
    if (autoStart && !autoStartSettled) {
      renderAutoStart();
      return;
    }
    renderIdle();
  }

  /** The auto-start face: no Veo deep links, no countdown, no "I already
   *  started" — every one of those re-asks something the device card's
   *  survey already settled. Just enough to explain the pause while we wait
   *  on a location fix. */
  function renderAutoStart(): void {
    root.append(el("p", "ride-wizard__lede", "Starting ride mode…"));
    appendWaitingAndError();
    // An auto-start waiting on a location fix is the longest this screen ever
    // shows nothing to press, and a rider whose scooter will not turn on is
    // exactly who is sitting through it. Without this the face is a dead end:
    // the survey already answered every question, so there is no other button
    // here to reach for. Own-device rides get it too — reporting needs a Veo
    // vehicle and there is none, so it answers honestly and still hands them
    // the picker rather than leaving them stuck.
    const actions = el("div", "ride-wizard__actions");
    actions.append(failedStartButton());
    root.append(actions);
  }

  /** After the report. One sentence about where the information went, the
   *  offer to say what happened in their own words, and one button — back to
   *  the picker, because a rider who has just told us their scooter is dead
   *  wants a different scooter.
   *
   *  ORDER MATTERS AND IS THE RULE. The report is the useful artefact and it
   *  has already landed by the time anything here renders; the story is
   *  offered AFTER it, never instead of it and never in front of it. A rider
   *  who ignores the box has still done the thing that helps the next person. */
  function renderFailedStart(): void {
    const result = failedStart;
    if (!result) return;
    root.append(el("p", "ride-wizard__lede", "This one isn't rideable"));
    const note = el("p", "ride-wizard__hint", result.message);
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    root.append(note);

    appendStoryPanel();

    const actions = el("div", "ride-wizard__actions");
    const pickBtn = el("button", "login-btn", "Pick another scooter");
    pickBtn.type = "button";
    pickBtn.addEventListener("click", () => {
      storyPanel?.destroy();
      storyPanel = null;
      failedStart = null;
      // Screen 2 is the picker. Dispatch the `goto` as well as navigating the
      // shell: the shell's own `onScreenChange` persists it, but `go()` is
      // the router's call and the doc has to agree with where the rider is.
      deps.session.dispatch({ type: "goto", screen: "2" });
      ctx.go("2");
    });
    actions.append(pickBtn);
    root.append(actions);
    // No "try it anyway". The report we just sent says this scooter does not
    // ride; offering a second attempt on the same screen would be the app
    // disagreeing with the rider about something they can see and we cannot.
  }

  /** The story offer, under the report.
   *
   *  `ride-failed-start.ts` turns this moment into one enum, and that enum is
   *  the whole of what the fleet learns from the most certain person in the
   *  app: somebody standing over a scooter that will not turn on. The sentence
   *  they could write is the part no count can carry, and this is the only
   *  moment they will ever be asked.
   *
   *  Offered on every outcome, including `unreportable` and `failed`. A rider
   *  whose report could not be sent has MORE to say about their morning, not
   *  less, and the panel keeps the story locally either way. */
  function appendStoryPanel(): void {
    const host = el("div", "ride-screen-start__story");
    root.append(host);

    const doc = deps.session.current();
    const device = doc ? selectedDevice(doc.device) : null;
    storyPanel?.destroy();
    storyPanel = mountStoryPanel(host, {
      origin: "failed_start",
      context: {
        happenedAt: new Date().toISOString(),
        vehicleModel: device?.model ?? null,
        // The app's own verdict on this vehicle is a genuinely useful field
        // ("it said it was fine" is a different complaint from "it was
        // broken"), but the session doc does not carry the reliability tier
        // and threading it through the picker is a wider change than this
        // lane. Omitted rather than guessed: the payload field is optional
        // and the disclosure simply does not mention what we do not send.
        appAssessment: null,
      },
      neighborhoods: storyNeighborhoods,
      submit: (draftId, payload) =>
        (deps.submitRiderStory ?? defaultSubmitRiderStory)(draftId, payload),
    });

    // Fetch the instrument's neighbourhood list once, in the background. The
    // panel renders immediately without it — the question is the point and it
    // does not need a list — and re-mounts with the third-party lane enabled
    // when it arrives. A failure is silent and permanent for this screen: the
    // rider still gets the box, and simply is not offered a send we could not
    // file correctly.
    if (!storyNeighborhoodsTried) {
      storyNeighborhoodsTried = true;
      void (deps.fetchSurveyOptions ?? defaultFetchSurveyOptions)()
        .then((opts) => {
          if (destroyed || !failedStart) return;
          storyNeighborhoods = opts.neighborhoods;
          render();
        })
        .catch(() => {
          /* no send option this time; the story is still kept locally */
        });
    }
  }

  /** The exit this screen was missing. A rider standing over a scooter that
   *  will not turn on is at the most certain moment anyone is ever going to be
   *  about a device's rideability, and until now the only button that could
   *  record it lived in the map popup they were no longer looking at. See
   *  `ride-failed-start.ts` for what the fleet infers without it. */
  function failedStartButton(): HTMLButtonElement {
    const btn = el(
      "button",
      "login-btn login-btn--ghost ride-screen-start__not-rideable",
      "🚫 It won't start",
    );
    btn.type = "button";
    btn.addEventListener("click", () => void onFailedStart());
    return btn;
  }

  /** §11.5's "Before": refuse quietly rather than cheerfully.
   *
   *  A line of copy, never a gate on starting. The rider is standing at the
   *  scooter and can see its own gauge, both figures are estimates (a straight
   *  line standing in for a road, an operator's projection standing in for a
   *  model), and a wizard that refused to proceed on this evidence would be
   *  wrong often enough to be worth defeating.
   *
   *  THIS SCREEN, AND NOT SCREEN 2 OR 4, for a reason worth recording because
   *  §11.5 names Screen 2: Screen 2 knows neither the destination nor the
   *  battery — it is disambiguation, and on the common flow the destination is
   *  not chosen yet. Screen 4 has both but only renders when navigation is on,
   *  which is off by default, so a warning that lived there would be absent
   *  from most rides. Screen 6 is the one seat every ride passes through
   *  holding both facts.
   *
   *  It reuses the during-ride verdict with nothing travelled, rather than a
   *  second rule: a rider told nothing here and then warned eight metres into
   *  the ride would rightly conclude the warning is noise.
   *
   *  Silent for an own-device ride (no Veo range figure exists), for a ride
   *  with no destination (no question to answer), before the first fix, and
   *  whenever the feed gave no range — the confidence floor, which is the
   *  whole design of this feature. */
  function appendReachNote(): void {
    const doc = deps.session.current();
    const device = doc ? selectedDevice(doc.device) : null;
    const id = device?.vehicleIdentifier ?? null;
    if (!doc || !doc.dest || id === null) return;
    const range = deps.rangeMetersFor?.(id) ?? null;
    const input = {
      startRangeMeters: range,
      travelledMeters: 0,
      at: fix,
      dest: { lat: doc.dest.lat, lon: doc.dest.lon },
    };
    if (!shouldWarnReach({ ...input, alreadyWarned: false })) return;
    const sentence = preRideReachSentence(rideReach(input), doc.dest.label);
    if (sentence === null) return;
    const note = el("p", "ride-wizard__hint ride-wizard__hint--warning", sentence);
    // Announced, because it is new information appearing under a lede the
    // rider has already read — and polite, because they are mid-task.
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    root.append(note);
  }

  /** Shared by both the real-device and own-device idle renders. */
  function appendWaitingAndError(): void {
    if (fix === null) {
      root.append(
        el(
          "p",
          "ride-wizard__hint",
          "Waiting for your location before we can start the ride…",
        ),
      );
    }

    if (errorMessage) {
      const err = el("p", "ride-modal__hint", errorMessage);
      err.setAttribute("role", "status");
      err.setAttribute("aria-live", "polite");
      root.append(err);
    }
  }

  /** "My own Device" idle render — no Veo app to coordinate with, so no
   *  deep links, plate, or countdown: a single button starts the (always
   *  private) ride immediately, same as "I already started" for a real
   *  device. */
  function renderOwnDeviceIdle(): void {
    root.append(el("p", "ride-wizard__lede", "My Scooter/Bike"));
    root.append(
      el(
        "p",
        "ride-wizard__hint",
        "There's no Veo app to coordinate with — ride mode starts tracking as soon as you tap Start.",
      ),
    );
    appendWaitingAndError();

    const actions = el("div", "ride-wizard__actions");
    const startBtn = el("button", "login-btn", "Start ride mode");
    startBtn.type = "button";
    startBtn.disabled = !canStart();
    startBtn.addEventListener("click", () => onAlreadyStarted());
    actions.append(startBtn);
    root.append(actions);
  }

  function renderIdle(): void {
    const doc = deps.session.current();
    const device = doc ? selectedDevice(doc.device) : null;
    const own = doc ? isOwnDevice(doc.device) : false;
    if (!doc || (!device && !own)) {
      root.append(
        el(
          "p",
          "ride-wizard__hint",
          "Go back and pick the scooter you're standing next to before opening it in Veo.",
        ),
      );
      return;
    }

    if (!device) {
      // Guard above guarantees `own` is true here.
      renderOwnDeviceIdle();
      return;
    }

    root.append(el("p", "ride-wizard__lede", deviceSummaryLabel(device)));
    root.append(
      el(
        "p",
        "ride-wizard__hint",
        `Tap Open in Veo, then unlock the scooter in the app. Ride mode begins ${START_COUNTDOWN_S}s later — or tap "I already started" if you've already unlocked it.`,
      ),
    );
    appendReachNote();
    appendWaitingAndError();

    const plate = device.plate || null;
    // Both buttons resolve the SAME Adjust universal link — one `href`
    // computed once and assigned to both anchors, byte-identical by
    // construction (Android/Apple are per-platform labels only; Adjust's own
    // redirect handles app-vs-store routing — see the module map row).
    const href = plate ? veoDeepLink(plate) : null;

    const actions = el("div", "ride-wizard__actions");
    const androidBtn = el(
      "a",
      "login-btn",
      "▶️ Open in Veo — Android",
    ) as HTMLAnchorElement;
    const appleBtn = el(
      "a",
      "login-btn",
      "▶️ Open in Veo — iPhone",
    ) as HTMLAnchorElement;
    for (const a of [androidBtn, appleBtn]) {
      if (href) {
        a.href = href;
      } else {
        a.removeAttribute("href");
      }
      const disabled = !canStart();
      a.toggleAttribute("disabled", disabled);
      a.setAttribute("aria-disabled", disabled ? "true" : "false");
      a.addEventListener("click", (e) => {
        if (!canStart()) {
          e.preventDefault();
          return;
        }
        onStartTapped();
      });
    }

    const alreadyBtn = el(
      "button",
      "login-btn login-btn--secondary",
      "I already started",
    );
    alreadyBtn.type = "button";
    alreadyBtn.disabled = !canStart();
    alreadyBtn.addEventListener("click", () => onAlreadyStarted());

    actions.append(androidBtn, appleBtn, alreadyBtn, failedStartButton());
    root.append(actions);
    if (!plate) {
      root.append(
        el(
          "p",
          "ride-wizard__hint",
          "We don't have this scooter's plate yet — you can still start once you're on the scooter.",
        ),
      );
    }
  }

  function renderCounting(): void {
    const card = el("div", "ride-screen-start__countdown");
    card.append(
      el(
        "div",
        "ride-screen-start__countdown-digit",
        String(Math.max(0, remaining)),
      ),
      el(
        "p",
        "ride-wizard__hint",
        "Scan the QR and start the scooter — the clock starts when this hits zero.",
      ),
    );
    const cancelBtn = el(
      "button",
      "login-btn login-btn--secondary",
      "Cancel",
    );
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => onCancelCountdown());
    card.append(cancelBtn);
    // THE MOMENT THIS IS FOR. The rider is watching a countdown having just
    // been told to "scan the QR and start the scooter"; if it beeps and
    // refuses, this is the second they know, and Cancel alone threw that away.
    // An own-device ride never counts down, so there is no non-Veo case here.
    card.append(failedStartButton());
    root.append(card);
  }

  // ---------------- actions ----------------

  function onStartTapped(): void {
    if (!canStart()) return;
    errorMessage = null;
    mode = "counting";
    remaining = START_COUNTDOWN_S;
    // Screen 6's own transition — legal only from `wizard:6` (ride-session.ts).
    deps.session.dispatch({ type: "startCountdown" });
    render();
    countdownTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(countdownTimer);
        countdownTimer = undefined;
        void finishStart();
      } else {
        render();
      }
    }, 1000);
  }

  function onAlreadyStarted(): void {
    if (!canStart()) return;
    errorMessage = null;
    // The `beginCountdown(0)` equivalent: straight to `finishStart` without
    // ever dispatching `startCountdown` — `rideStarted` is legal directly
    // from `wizard:6` (ride-session.ts), so no phase change is needed first.
    void finishStart();
  }

  /** Record the failure, then put the rider in front of the picker.
   *
   *  Order matters. The countdown stops FIRST — a timer left running would
   *  fire `finishStart` under the report and begin a ride on the scooter the
   *  rider just said does not move. The session goes back to `wizard:6` by the
   *  same sanctioned route Cancel uses, because an un-started countdown is the
   *  only thing that can legally be walked back. */
  async function onFailedStart(): Promise<void> {
    if (reportingFailedStart || busy) return;
    if (countdownTimer !== undefined) {
      window.clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
    if (mode === "counting") {
      mode = "idle";
      deps.session.dispatch({ type: "goto", screen: "6" });
    }
    errorMessage = null;
    // An auto-start path must not re-fire behind the report: the rider has
    // answered the only question this screen had.
    autoStartSettled = true;
    reportingFailedStart = true;
    render();

    const doc = deps.session.current();
    const device = doc ? selectedDevice(doc.device) : null;
    const pos = deps.locate.current();
    const result = await reportFailedStart(
      {
        vehicleIdentifier: device?.vehicleIdentifier ?? null,
        lat: pos?.lat,
        lng: pos?.lng,
      },
      deps.submitDeviceReport ?? defaultSubmitDeviceReport,
    );
    if (destroyed) return;
    reportingFailedStart = false;
    failedStart = result;
    if (failedStartCounted(result.outcome)) {
      emitFailedStartTrack(result.outcome);
    }
    render();
  }

  function onCancelCountdown(): void {
    if (countdownTimer !== undefined) {
      window.clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
    mode = "idle";
    // The only legal way back off an un-started countdown (ride-session.ts:
    // "Cancelling an un-started countdown is the only way back off Screen 6").
    deps.session.dispatch({ type: "goto", screen: "6" });
    render();
  }

  async function finishStart(): Promise<void> {
    if (destroyed) return;
    const doc = deps.session.current();
    const device = doc ? selectedDevice(doc.device) : null;
    const own = doc ? isOwnDevice(doc.device) : false;
    const fixNow = deps.locate.current();
    if (!doc || (!device && !own) || !fixNow) {
      mode = "idle";
      // An auto-start that cannot proceed hands the screen back to the
      // rider rather than retrying invisibly — see `autoStartSettled`.
      autoStartSettled = true;
      errorMessage = "We lost your location or scooter selection — try again.";
      deps.session.dispatch({ type: "goto", screen: "6" });
      render();
      return;
    }

    // Guest / private ride (see the module FIX note): never attempt the
    // authed-only `POST /tracked-rides` — it would throw NO_AUTH for a
    // signed-out rider every time. An own-device ride is ALWAYS private
    // (`RideSessionOwnDevice`'s own doc comment: "never points-eligible") and
    // takes this same branch. Start locally instead: no `rideId`, a freshly
    // generated local `trackKeyId`, `private: true`. The Veo app start itself
    // already happened (the countdown / "I already started" tap that got us
    // here, for a real device) — this only decides whether a `tracked_rides`
    // row exists server-side to track it against. `onPrivateRideStarted`
    // fires with the SAME `trackKeyId` just dispatched, so the caller can
    // attach a local `TrackRecorder` under that exact id
    // (`track-store.ts`'s `resumeRide(trackId, {isPrivate: true})` mints a
    // brand-new private ride keyed on a caller-supplied id when no local
    // record exists yet) instead of the two modules independently generating
    // two unrelated ids.
    // Self-heal the persisted screen before starting: the reducer only
    // accepts `rideStarted` from `wizard:6`, but the shell persists this
    // screen (main.ts's `onScreenChange` → `goto 6`) only AFTER the factory
    // returns, so a start that fires early sees a doc still reading the
    // previous screen. Legal (and a no-op) from any wizard screen; skipped
    // from `countdown`, where a `goto` would un-start the countdown.
    if (doc.state === "wizard" && doc.screen !== "6") {
      deps.session.dispatch({ type: "goto", screen: "6" });
    }

    if (doc.private) {
      const nowFn = deps.now ?? (() => Date.now());
      const randomBytesFn = deps.randomBytes ?? defaultRandomBytes;
      const trackKeyId = randomPrivateTrackId(randomBytesFn);
      // Same §11.2 rule on the private path, where there is no server row to
      // compare against: the scan is the only observation there is.
      const nowMs = nowFn();
      const started = deps.session.dispatch({
        type: "rideStarted",
        rideId: null,
        startedAtMs: usableScanStart(ctx.entry.scannedAtMs, nowMs) ?? nowMs,
        trackKeyId,
        private: true,
      });
      // A rejected transition means the session doc is NOT riding — closing
      // the wizard anyway (the pre-fix behavior) stranded the rider with no
      // HUD and no error. Fall back to the interactive screen instead.
      if (started?.accepted !== true) {
        mode = "idle";
        autoStartSettled = true;
        errorMessage = "Couldn't start the ride — please try again.";
        render();
        return;
      }
      deps.onPrivateRideStarted?.(trackKeyId);
      ctx.next();
      return;
    }

    // Non-private: a server-tracked ride, which requires a real device — an
    // own-device ride is always private (see above) and never reaches here.
    // Defensive only; the guard above and `startScreenSkip` already ensure
    // this in practice.
    if (!device) {
      mode = "idle";
      autoStartSettled = true;
      errorMessage = "We lost your location or scooter selection — try again.";
      deps.session.dispatch({ type: "goto", screen: "6" });
      render();
      return;
    }

    busy = true;
    render();
    abortController = new AbortController();
    const body: StartTrackedRideIn = {
      vehicle_identifier: device.vehicleIdentifier,
      start_lat: fixNow.lat,
      start_lon: fixNow.lng,
      ride_options: doc.options,
    };
    if (device.batteryConfirmed !== null) {
      body.reported_start_battery_percent = device.batteryConfirmed;
    }

    try {
      const started = await (
        deps.startTrackedRide ?? defaultStartTrackedRide
      )(body, abortController.signal);
      if (destroyed) return;
      const nowFn = deps.now ?? (() => Date.now());
      const transition = deps.session.dispatch({
        type: "rideStarted",
        rideId: started.id,
        startedAtMs: resolveStartedAtMs(started, nowFn, ctx.entry.scannedAtMs),
        trackKeyId: started.id,
        private: false,
      });
      // Same guard as the private branch: never hand off on a doc that is
      // not actually riding. The server row exists — a retry's 409 routes
      // into the resume-or-end prompt, which can adopt it.
      if (transition?.accepted !== true) {
        busy = false;
        mode = "idle";
        autoStartSettled = true;
        errorMessage = "Couldn't start the ride — please try again.";
        render();
        return;
      }
      deps.onRideStarted?.(started);
      ctx.next();
    } catch (err) {
      if (destroyed) return;
      busy = false;
      mode = "idle";
      // Whatever went wrong, the rider gets the interactive screen back —
      // including on the 409 path, where `errorMessage` is deliberately left
      // null because the resume-or-end prompt is telling the story instead.
      autoStartSettled = true;
      if (err instanceof ApiError && err.status === 409 && deps.onServerConflict) {
        // The resume-or-end prompt's trigger (see `startTrackedRide`'s own
        // doc comment) — hand off to the caller instead of a dead-end
        // static message; it fetches the conflicting ride and shows the
        // shared prompt (`ride-resume-prompt.ts`).
        errorMessage = null;
        deps.onServerConflict();
      } else {
        errorMessage = describeStartError(err);
      }
      // `goto` back to Screen 6 is a no-op from `wizard:6` and the sanctioned
      // un-start from `countdown` — legal from both paths that lead here.
      deps.session.dispatch({ type: "goto", screen: "6" });
      render();
    }
  }

  // ---------------- mount ----------------

  render();
  // Deferred out of the factory's own call stack: the shell is still
  // mid-render when this factory runs, and the integrator persists this
  // screen onto the session doc (`onScreenChange` → `goto 6`) only AFTER
  // the factory returns. A synchronous auto-start here dispatched
  // `rideStarted` against a doc still reading the PREVIOUS screen, which
  // the reducer rejects — the flow then ran off the end with no ride
  // started and no HUD (the 2026-08 field failure). One microtask is
  // enough: the shell's render (onScreenChange included) is synchronous.
  // The `goto 6` self-heal in `finishStart` covers any other early caller.
  queueMicrotask(() => maybeAutoStart());
  const unFix = deps.locate.onFix((pos) => {
    if (destroyed) return;
    fix = pos;
    if (mode === "idle" && !busy) render();
    // A late first fix is the common auto-start path: Screen 1 primed the
    // permission, but the reading itself usually lands after this screen
    // has already mounted.
    maybeAutoStart();
  });
  ctx.onCleanup(unFix);
  ctx.onCleanup(() => {
    if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
    abortController?.abort();
  });

  return {
    // "Open in Veo" would be a lie over an own-device ride — no Veo app is
    // involved anywhere in it.
    title: own0 ? "Starting ride" : "Open in Veo",
    primary: root,
    destroy() {
      destroyed = true;
      // The panel owns a draft and a pending submit; leaving it mounted under
      // a torn-down screen would let a late response write into a dead DOM.
      storyPanel?.destroy();
      storyPanel = null;
    },
  };
}

// ---------------------------------------------------------------------------
// DOM helper (the repo's own `el()`, verbatim in spirit)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
