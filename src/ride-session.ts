// The single owner of "what ride am I in". A pure reducer over the persisted
// session doc plus a storage adapter and the reload-recovery decision table —
// no DOM, no network, no imports of `main.ts` state. Every screen module and
// the HUD read the doc from here rather than keeping their own copy.
//
// Spec: `docs/PLAN_RIDE_MODE_FRONTEND.md` § "Ride session state machine". The
// doc shape, the storage key, the state names and every non-linear transition
// below are quoted from it.
//
// ── THE END-REPORT INVARIANT ─────────────────────────────────────────────────
// The ride's single `PATCH /tracked-rides/{id}/end` fires from the SCREEN 8
// BUTTONS — [Rush Quit] and [I ended my ride in Veo] — and never on merely
// entering `ending(8)`. That is what makes the New Destination loop
// (`ending(8) → wizard:3 → wizard:4 → riding`, same rideId, same chain, no new
// countdown) legal: Screen 8 is a fork, not an ending. Reporting the end on
// entry would end a ride the rider is still on, and the real `/end` later
// would 409 (it is single-shot).
//
// One interim exception, scoped to the F3 window: before `ride-post.ts` exists
// there is no Screen 8, and the legacy HUD summary sends the minimal `/end`
// itself. `RideReducerOptions.legacyEndRide` selects that behaviour and sends
// `riding → done` directly. Flip it off when F4 lands Screen 8.
//
// `endReportOwner()` is the machine-readable form of all of the above, and
// `reduceRideSession` derives its `end_reported` effect from the same function
// so the two can never drift.

import type {
  RideOptions,
  RouteManeuver,
  TrackSigning,
  TrackedRide,
} from "./api.ts";
import type { TrackTip } from "./track-store.ts";

export const RIDE_SESSION_KEY = "scooter_fyi.ride_session";
export const RIDE_SESSION_VERSION = 1;

// ---------------------------------------------------------------------------
// States and screens
// ---------------------------------------------------------------------------

/** Owner numbering, preserved verbatim: there is no Screen 5, and 2.5 is the
 *  Usuals picker. Never renumber. */
export type WizardScreenId = "1" | "2" | "2.5" | "3" | "4" | "6";
export type PostScreenId = "8" | "9" | "10";
export type RideScreenId = WizardScreenId | PostScreenId;

export type RideState =
  | "idle"
  | "wizard"
  | "countdown"
  | "riding"
  | "ending"
  | "survey"
  | "eligibility"
  | "done";

/** The composite the spec names its states by — `wizard:2.5`, `ending(8)` — so
 *  transition tables and test names can quote it literally. */
export type RidePhase =
  | "idle"
  | `wizard:${WizardScreenId}`
  | "countdown"
  | "riding"
  | "ending(8)"
  | "survey(9)"
  | "eligibility(10)"
  | "done";

const WIZARD_SCREENS: readonly WizardScreenId[] = [
  "1",
  "2",
  "2.5",
  "3",
  "4",
  "6",
];

export function isWizardScreen(value: unknown): value is WizardScreenId {
  return (
    typeof value === "string" &&
    (WIZARD_SCREENS as readonly string[]).includes(value)
  );
}

/** The screen each non-wizard state renders on, so `screen` is never a lie.
 *  `countdown` stays on Screen 6 (that is where the 10 s countdown lives), and
 *  the recovery table's "countdown with a null rideId reopens at wizard:6"
 *  reads directly off it. */
const SCREEN_FOR_STATE: Record<RideState, RideScreenId | null> = {
  idle: null,
  wizard: null, // carried by the doc
  countdown: "6",
  riding: null,
  ending: "8",
  survey: "9",
  eligibility: "10",
  done: null,
};

// ---------------------------------------------------------------------------
// The session doc (persisted verbatim to localStorage on EVERY transition)
// ---------------------------------------------------------------------------

export interface RideSessionSelectedDevice {
  /** 16 lowercase hex — the GBFS vehicle identifier. */
  vehicleIdentifier: string;
  plate: string | null;
  model: string | null;
  /** Screen 2's Battery% confirm field. Doubles as `POST /tracked-rides`'
   *  `reported_start_battery_percent` — this is the only place the flow
   *  collects it. */
  batteryConfirmed: number | null;
}

/** "My own Device" — a private ride: local-only, never points-eligible. */
export interface RideSessionOwnDevice {
  own: true;
}

export type RideSessionDevice =
  | RideSessionSelectedDevice
  | RideSessionOwnDevice;

export function isOwnDevice(
  device: RideSessionDevice | null,
): device is RideSessionOwnDevice {
  return device !== null && "own" in device && device.own === true;
}

export function selectedDevice(
  device: RideSessionDevice | null,
): RideSessionSelectedDevice | null {
  return device !== null && !isOwnDevice(device) ? device : null;
}

export interface RideSessionDest {
  label: string;
  lat: number;
  lon: number;
}

export interface RideSessionRoute {
  /** A live `/route/profiles` key: safe | range | shade | express. */
  profile: string;
  /** The row `POST /ride-routes` stored, when nav improvement is on. Screen 9's
   *  route feedback and the nav distance bonus both key off it; null means the
   *  route was chosen but never persisted (nav improvement off, or A3 not
   *  deployed yet — a tolerated 404). */
  rideRouteId: string | null;
  distanceM: number;
  durationS: number;
  /** Precision-5 encoded polyline of the chosen shape. */
  polyline: string;
  maneuvers: RouteManeuver[];
}

export interface RideSessionDoc {
  v: typeof RIDE_SESSION_VERSION;
  state: RideState;
  screen: RideScreenId | null;
  rideId: string | null;
  /** A private ride: "My own Device" or a guest. No `tracked_rides` row, no
   *  points, no Screen 8/9/10 — `riding → done` directly. */
  private: boolean;
  device: RideSessionDevice | null;
  options: RideOptions;
  dest: RideSessionDest | null;
  route: RideSessionRoute | null;
  startedAtMs: number | null;
  /** The `track-store` record key. Equals `rideId` for a server ride; a
   *  `private-<hex>` local id for a private one. The KEY ITSELF never lands
   *  here — it lives only in IndexedDB as a non-extractable CryptoKey. */
  trackKeyId: string | null;
}

export function phaseOf(doc: RideSessionDoc): RidePhase {
  switch (doc.state) {
    case "wizard":
      return isWizardScreen(doc.screen) ? `wizard:${doc.screen}` : "wizard:1";
    case "ending":
      return "ending(8)";
    case "survey":
      return "survey(9)";
    case "eligibility":
      return "eligibility(10)";
    default:
      return doc.state;
  }
}

/** A doc with a live ride: the HUD is (or should be) up and the chain is open.
 *  Includes the wizard screens the S8 New Destination loop passes through. */
export function isRideLive(doc: RideSessionDoc): boolean {
  if (doc.state === "riding" || doc.state === "countdown") return true;
  return (
    doc.state === "wizard" &&
    (doc.screen === "3" || doc.screen === "4") &&
    doc.rideId !== null
  );
}

export function isPostRide(doc: RideSessionDoc): boolean {
  return (
    doc.state === "ending" ||
    doc.state === "survey" ||
    doc.state === "eligibility"
  );
}

/** A blank doc. `options` is a REQUIRED argument on purpose: defaults for the
 *  `RideOptions` blob belong to `ride-settings.ts`, and duplicating them here
 *  is exactly the drift that module exists to prevent. */
export function blankRideSession(options: RideOptions): RideSessionDoc {
  return {
    v: RIDE_SESSION_VERSION,
    state: "idle",
    screen: null,
    rideId: null,
    private: false,
    device: null,
    options,
    dest: null,
    route: null,
    startedAtMs: null,
    trackKeyId: null,
  };
}

// ---------------------------------------------------------------------------
// Gates: which post-ride screens apply
// ---------------------------------------------------------------------------

/** Facts the reducer cannot know because they live in `track-store`, injected
 *  by the caller with the action that needs them. */
export interface RideGateFacts {
  /** At least one sealed waypoint exists locally for this ride. */
  hasWaypoints: boolean;
}

export interface SurveyPaneGates {
  /** Screen 9 left — scooter feedback (+4 pts). */
  scooter: boolean;
  /** Screen 9 right — navigation feedback. */
  navigation: boolean;
}

/** Master Risk 16: Screen 9 as a whole needs a tracked Veo ride, then the two
 *  panes gate individually. Left = the Screen 2 "End ride survey" toggle, which
 *  exists to control exactly this pane (and is meaningless on own device, which
 *  has no GBFS ground truth). Right = a selected route, without which
 *  "How was the ${selectedRoute}?" is unanswerable. */
export function surveyPanes(doc: RideSessionDoc): SurveyPaneGates {
  const tracked = !doc.private && doc.rideId !== null;
  return {
    scooter: tracked && doc.options.end_survey && !doc.options.own_device,
    navigation: tracked && doc.route !== null,
  };
}

/** Both panes gated off → Screen 9 is skipped entirely. */
export function shouldShowSurvey(doc: RideSessionDoc): boolean {
  const panes = surveyPanes(doc);
  return panes.scooter || panes.navigation;
}

/** Screen 10 only when waypoints were tracked — and only for a ride there is
 *  something to donate against. */
export function shouldShowEligibility(
  doc: RideSessionDoc,
  facts: RideGateFacts,
): boolean {
  return !doc.private && doc.rideId !== null && facts.hasWaypoints;
}

// ---------------------------------------------------------------------------
// Actions, effects, transitions
// ---------------------------------------------------------------------------

export type RideAction =
  /** The 🧭 Ride button or a `?ride=` deep link. `screen` fast-forwards.
   *  RESETS the wizard: to resume an in-progress one (recovery's
   *  `reopen_wizard` outcome), call `replace(doc)` instead. */
  | {
      type: "open";
      options: RideOptions;
      screen?: WizardScreenId;
      device?: RideSessionDevice | null;
      /** Guest baseline — a guest ride is private from the start. */
      private?: boolean;
    }
  /** Back/next inside the wizard (the modal's screen router). */
  | { type: "goto"; screen: WizardScreenId }
  | { type: "setOptions"; options: RideOptions }
  | {
      type: "setDevice";
      device: RideSessionDevice | null;
      /** Defaults to "own device or already private". Screen 2 passes it
       *  explicitly when a guest signs in mid-wizard, or when switching off
       *  own-device should make the ride points-eligible again. */
      private?: boolean;
    }
  | { type: "setDest"; dest: RideSessionDest | null }
  | { type: "setRoute"; route: RideSessionRoute | null }
  /** Screen 6's "Start in Veo" — the default 10 s countdown. */
  | { type: "startCountdown" }
  /** The ride is live. From `countdown`, or straight from `wizard:6` when the
   *  rider taps "I already started" and skips the countdown. */
  | {
      type: "rideStarted";
      rideId: string | null;
      startedAtMs: number;
      trackKeyId: string | null;
      private?: boolean;
    }
  /** The resume-or-end prompt's [Resume] — a 409 on start, or a reload that
   *  found a server ride this device knew nothing about. */
  | {
      type: "adoptServerRide";
      rideId: string;
      startedAtMs: number;
      trackKeyId: string | null;
      options?: RideOptions;
    }
  /** Screen 7's End Ride. Tracked → `ending(8)`; private → `done`. */
  | { type: "endRide" }
  /** Screen 8's [New Destination] — loops to Screen 3 keeping the session. */
  | { type: "newDestination" }
  /** Back to riding from the New Destination loop: same rideId, same chain, no
   *  new countdown. */
  | { type: "resumeRiding" }
  /** Screen 8's [Rush Quit] — its minimal `PATCH /end` already sent. */
  | { type: "rushQuit" }
  /** Screen 8's [I ended my ride in Veo] — its full `PATCH /end` already
   *  sent (§10 fields included). */
  | { type: "endReported"; facts: RideGateFacts }
  /** Screen 9's [Skip] or [Submit] — both proceed. */
  | { type: "surveyDone"; facts: RideGateFacts }
  /** Screen 10 done (donated, declined, or "Return to Main App"). */
  | { type: "eligibilityDone" }
  /** The resume-or-end prompt's [End it] — that ride's `PATCH /end` already
   *  sent. Nothing further to collect on a ride we never rode in this tab. */
  | { type: "abandon" }
  /** Drop the session entirely (modal dismissed before a ride started). */
  | { type: "reset" };

export type RideActionType = RideAction["type"];

export type RideEffect =
  /** Ride recording is over: seal the final partial batch (a `track-store`
   *  duty, which is why it fires for private rides too). */
  | { kind: "seal_final_batch" }
  /** The New Destination loop re-entered `riding`: resume recording into the
   *  SAME chain — no new key, no restarted seq. */
  | { kind: "resume_recording" }
  /** This transition presupposes the ride's single `PATCH /end` — see the
   *  end-report invariant at the top of this file. `minimal` is [Rush Quit]'s
   *  required-fields-only call, `full` is Screen 8's with the rider-entered
   *  battery/cost and the §10 fields. */
  | { kind: "end_reported"; fields: "minimal" | "full" }
  /** Terminal: drop the persisted doc. */
  | { kind: "clear_session" };

export interface RideReducerOptions {
  /** F3 interim: no Screen 8 exists yet, so the legacy HUD summary owns the
   *  minimal `PATCH /end` and `endRide` goes `riding → done`. Turn off with F4. */
  legacyEndRide?: boolean;
}

export interface RideTransition {
  doc: RideSessionDoc;
  effects: RideEffect[];
  /** False when the action is illegal from the current phase; `doc` is then the
   *  unchanged input, so a stray dispatch can never corrupt a live ride. */
  accepted: boolean;
  rejected: string | null;
  from: RidePhase;
  to: RidePhase;
}

/** Which `PATCH /end` this action owns, or null when it owns none. The
 *  machine-readable form of the end-report invariant: exactly the two Screen 8
 *  buttons, plus `abandon` (the resume-or-end prompt's end), plus — only while
 *  `legacyEndRide` is set and the ride is a tracked one — the F3 legacy End
 *  Ride. `endRide` into `ending(8)` owns nothing. */
export function endReportOwner(
  doc: RideSessionDoc,
  action: RideAction,
  opts: RideReducerOptions = {},
): "minimal" | "full" | null {
  switch (action.type) {
    case "rushQuit":
      return "minimal";
    case "endReported":
      return "full";
    case "abandon":
      return doc.rideId !== null ? "minimal" : null;
    case "endRide":
      return opts.legacyEndRide === true && !doc.private && doc.rideId !== null
        ? "minimal"
        : null;
    default:
      return null;
  }
}

function withPhase(
  doc: RideSessionDoc,
  state: RideState,
  screen?: RideScreenId | null,
): RideSessionDoc {
  return {
    ...doc,
    state,
    screen: screen !== undefined ? screen : SCREEN_FOR_STATE[state],
  };
}

function reject(
  doc: RideSessionDoc,
  reason: string,
): RideTransition {
  const phase = phaseOf(doc);
  return {
    doc,
    effects: [],
    accepted: false,
    rejected: reason,
    from: phase,
    to: phase,
  };
}

function accept(
  from: RideSessionDoc,
  doc: RideSessionDoc,
  effects: RideEffect[] = [],
): RideTransition {
  return {
    doc,
    effects,
    accepted: true,
    rejected: null,
    from: phaseOf(from),
    to: phaseOf(doc),
  };
}

/** The post-`/end` fan-out shared by Screen 8's [I ended my ride in Veo] and
 *  the recovery path that finds the end already reported: `survey(9)` when a
 *  pane gates on, else `eligibility(10)` when waypoints exist, else `done`. */
export function nextAfterEnd(
  doc: RideSessionDoc,
  facts: RideGateFacts,
): RideSessionDoc {
  if (shouldShowSurvey(doc)) return withPhase(doc, "survey");
  if (shouldShowEligibility(doc, facts)) return withPhase(doc, "eligibility");
  return withPhase(doc, "done");
}

export function reduceRideSession(
  doc: RideSessionDoc,
  action: RideAction,
  opts: RideReducerOptions = {},
): RideTransition {
  const phase = phaseOf(doc);
  const endFields = endReportOwner(doc, action, opts);
  const endEffect: RideEffect[] = endFields
    ? [{ kind: "end_reported", fields: endFields }]
    : [];

  switch (action.type) {
    case "open": {
      // Never open a fresh wizard over a live ride — the F3 button swap relies
      // on this (with a ride up, 🧭 resumes the HUD instead).
      if (isRideLive(doc) || isPostRide(doc)) {
        return reject(doc, `cannot open the wizard from ${phase}`);
      }
      const base: RideSessionDoc = {
        ...blankRideSession(action.options),
        private: action.private === true,
      };
      const device = action.device ?? null;
      return accept(
        doc,
        withPhase(
          {
            ...base,
            device,
            private: base.private || isOwnDevice(device),
          },
          "wizard",
          action.screen ?? "1",
        ),
      );
    }

    case "goto": {
      if (doc.state === "wizard") {
        return accept(doc, withPhase(doc, "wizard", action.screen));
      }
      // Cancelling an un-started countdown is the only way back off Screen 6.
      // With a rideId the ride is already live and this would be a lie.
      if (doc.state === "countdown" && doc.rideId === null) {
        return accept(doc, withPhase(doc, "wizard", action.screen));
      }
      return reject(doc, `goto is not legal from ${phase}`);
    }

    case "setOptions":
      if (doc.state === "idle" || doc.state === "done") {
        return reject(doc, `no session to configure from ${phase}`);
      }
      return accept(doc, { ...doc, options: action.options });

    case "setDevice": {
      if (doc.state !== "wizard") {
        return reject(doc, `the device is only selectable in the wizard`);
      }
      const isPrivate =
        action.private ?? (isOwnDevice(action.device) || doc.private);
      return accept(doc, {
        ...doc,
        device: action.device,
        private: isPrivate,
      });
    }

    case "setDest":
      if (doc.state !== "wizard") {
        return reject(doc, `the destination is only selectable in the wizard`);
      }
      return accept(doc, { ...doc, dest: action.dest });

    case "setRoute":
      // Screen 4 sets it, and an off-route re-route replaces the shape mid-ride.
      // A re-route MUST carry the existing `rideRouteId` over: the Screen 4
      // choice stays the survey's subject and the nav bonus's key, and
      // dismissing guidance (press-and-hold) must not null the route at all.
      if (doc.state !== "wizard" && doc.state !== "riding") {
        return reject(doc, `the route is not settable from ${phase}`);
      }
      return accept(doc, { ...doc, route: action.route });

    case "startCountdown":
      if (phase !== "wizard:6") {
        return reject(doc, `the countdown starts on Screen 6, not ${phase}`);
      }
      return accept(doc, withPhase(doc, "countdown"));

    case "rideStarted": {
      // `wizard:6 → riding` is the "I already started" skip; `countdown →
      // riding` is the normal path.
      if (phase !== "countdown" && phase !== "wizard:6") {
        return reject(doc, `a ride cannot start from ${phase}`);
      }
      return accept(
        doc,
        withPhase(
          {
            ...doc,
            rideId: action.rideId,
            startedAtMs: action.startedAtMs,
            trackKeyId: action.trackKeyId,
            private: action.private ?? doc.private,
          },
          "riding",
        ),
      );
    }

    case "adoptServerRide":
      if (isRideLive(doc) && doc.rideId !== null) {
        return reject(doc, `already on ride ${doc.rideId}`);
      }
      return accept(
        doc,
        withPhase(
          {
            ...doc,
            options: action.options ?? doc.options,
            rideId: action.rideId,
            startedAtMs: action.startedAtMs,
            trackKeyId: action.trackKeyId,
            private: false,
          },
          "riding",
        ),
      );

    case "endRide": {
      if (doc.state !== "riding") {
        return reject(doc, `nothing to end from ${phase}`);
      }
      // The final partial batch seals at ride end either way — a track-store
      // duty, not an `ending(8)` one, which is why private rides get it too.
      const effects: RideEffect[] = [
        { kind: "seal_final_batch" },
        ...endEffect,
      ];
      // Master Part 0 gates Screen 8 on "a Veo device was selected, i.e. not a
      // private ride"; there is no `PATCH /end` to send and S9/S10 never apply.
      if (doc.private || doc.rideId === null) {
        return accept(doc, withPhase(doc, "done"), effects);
      }
      if (opts.legacyEndRide === true) {
        return accept(doc, withPhase(doc, "done"), effects);
      }
      return accept(doc, withPhase(doc, "ending"), effects);
    }

    case "newDestination":
      if (phase !== "ending(8)") {
        return reject(doc, `[New Destination] is a Screen 8 button, not ${phase}`);
      }
      // No `PATCH /end` — that is the whole point of the invariant. A new
      // destination means a new choice, so the old dest/route go: the loop
      // re-runs Screen 3 and Screen 4, and Screen 4 re-POSTs `/ride-routes`
      // (with `tracked_ride_id` set this time).
      return accept(doc, withPhase({ ...doc, dest: null, route: null }, "wizard", "3"));

    case "resumeRiding":
      // Screen 4 → riding is the loop's re-entry. Screen 3 → riding is its
      // cancel path: a rider who backs out of picking a new destination must
      // land back on a ride that never stopped.
      if (phase !== "wizard:4" && phase !== "wizard:3") {
        return reject(doc, `cannot return to riding from ${phase}`);
      }
      if (doc.rideId === null && !doc.private) {
        return reject(doc, `no live ride to resume`);
      }
      // Same rideId, same chain, NO new countdown and no new signing key.
      return accept(doc, withPhase(doc, "riding"), [
        { kind: "resume_recording" },
      ]);

    case "rushQuit":
      if (phase !== "ending(8)") {
        return reject(doc, `[Rush Quit] is a Screen 8 button, not ${phase}`);
      }
      // End now, skip everything: no S9, no S10. The sealed track stays in IDB,
      // undonated — contribution points forfeited, nothing uploaded.
      return accept(doc, withPhase(doc, "done"), endEffect);

    case "endReported":
      if (phase !== "ending(8)") {
        return reject(doc, `the end is reported from Screen 8, not ${phase}`);
      }
      return accept(doc, nextAfterEnd(doc, action.facts), endEffect);

    case "surveyDone":
      if (phase !== "survey(9)") {
        return reject(doc, `no survey open at ${phase}`);
      }
      return accept(
        doc,
        shouldShowEligibility(doc, action.facts)
          ? withPhase(doc, "eligibility")
          : withPhase(doc, "done"),
      );

    case "eligibilityDone":
      if (phase !== "eligibility(10)") {
        return reject(doc, `no eligibility screen open at ${phase}`);
      }
      return accept(doc, withPhase(doc, "done"));

    case "abandon":
      return accept(doc, withPhase(doc, "done"), endEffect);

    case "reset":
      return accept(doc, withPhase(blankRideSession(doc.options), "idle"), [
        { kind: "clear_session" },
      ]);
  }
}

// ---------------------------------------------------------------------------
// Persistence. Every read and write is try/catch wrapped: private mode throws
// on both, and a ride must still work (in memory) when it does.
// ---------------------------------------------------------------------------

export interface RideSessionStorage {
  read(): string | null;
  /** False when the write was rejected — the UI can then say the session
   *  won't survive a reload instead of claiming it saved. */
  write(value: string): boolean;
  remove(): void;
}

export function localRideSessionStorage(
  key: string = RIDE_SESSION_KEY,
): RideSessionStorage {
  return {
    read() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    remove() {
      try {
        localStorage.removeItem(key);
      } catch {
        /* private mode — nothing was stored to remove */
      }
    },
  };
}

export function memoryRideSessionStorage(): RideSessionStorage {
  let value: string | null = null;
  return {
    read: () => value,
    write: (next) => {
      value = next;
      return true;
    },
    remove: () => {
      value = null;
    },
  };
}

const RIDE_STATES: readonly RideState[] = [
  "idle",
  "wizard",
  "countdown",
  "riding",
  "ending",
  "survey",
  "eligibility",
  "done",
];

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Coerce a stored options blob. These are RECOVERY fallbacks for a corrupt or
 *  version-skewed read, deliberately not product defaults — those belong to
 *  `ride-settings.ts`, which is the only module allowed to decide them. */
function parseOptions(raw: unknown): RideOptions | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const speedometer = o.speedometer;
  const theme = o.theme;
  return {
    cost_hud: o.cost_hud === true,
    speedometer:
      speedometer === "classic" ||
      speedometer === "digital" ||
      speedometer === "none"
        ? speedometer
        : "classic",
    theme:
      theme === "light" || theme === "dark" || theme === "auto"
        ? theme
        : "auto",
    navigation: o.navigation === true,
    save_tracks: o.save_tracks === true,
    battery_modeling: o.battery_modeling === true,
    nav_improvement: o.nav_improvement === true,
    end_survey: o.end_survey === true,
    own_device: o.own_device === true,
  };
}

function parseDevice(raw: unknown): RideSessionDevice | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.own === true) return { own: true };
  const vehicleIdentifier = str(d.vehicleIdentifier);
  if (!vehicleIdentifier) return null;
  return {
    vehicleIdentifier,
    plate: str(d.plate),
    model: str(d.model),
    batteryConfirmed: num(d.batteryConfirmed),
  };
}

function parseDest(raw: unknown): RideSessionDest | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const lat = num(d.lat);
  const lon = num(d.lon);
  if (lat === null || lon === null) return null;
  return { label: str(d.label) ?? "", lat, lon };
}

function parseRoute(raw: unknown): RideSessionRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const profile = str(r.profile);
  if (!profile) return null;
  return {
    profile,
    rideRouteId: str(r.rideRouteId),
    distanceM: num(r.distanceM) ?? 0,
    durationS: num(r.durationS) ?? 0,
    polyline: str(r.polyline) ?? "",
    maneuvers: Array.isArray(r.maneuvers)
      ? (r.maneuvers as RouteManeuver[])
      : [],
  };
}

/** Parse a stored doc. Returns null for anything unusable — a wrong `v`, an
 *  unknown state, a missing options blob — so a corrupt entry degrades to "no
 *  session" rather than to a half-restored ride. */
export function parseRideSession(raw: string | null): RideSessionDoc | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (d.v !== RIDE_SESSION_VERSION) return null;
  const state = d.state;
  if (
    typeof state !== "string" ||
    !(RIDE_STATES as readonly string[]).includes(state)
  ) {
    return null;
  }
  const options = parseOptions(d.options);
  if (!options) return null;
  const doc: RideSessionDoc = {
    v: RIDE_SESSION_VERSION,
    state: state as RideState,
    screen: null,
    rideId: str(d.rideId),
    private: d.private === true,
    device: parseDevice(d.device),
    options,
    dest: parseDest(d.dest),
    route: parseRoute(d.route),
    startedAtMs: num(d.startedAtMs),
    trackKeyId: str(d.trackKeyId),
  };
  // Re-derive `screen` so a doc can never claim a screen its state does not
  // have (and so a hand-edited entry cannot land the router on Screen 9 with
  // state `riding`).
  if (doc.state === "wizard") {
    doc.screen = isWizardScreen(d.screen) ? d.screen : "1";
  } else {
    doc.screen = SCREEN_FOR_STATE[doc.state];
  }
  return doc;
}

export function serializeRideSession(doc: RideSessionDoc): string {
  return JSON.stringify(doc);
}

// ---------------------------------------------------------------------------
// The store: reducer + persistence on every transition
// ---------------------------------------------------------------------------

export type RideSessionListener = (
  doc: RideSessionDoc | null,
  transition: RideTransition | null,
) => void;

export interface RideSessionStore {
  /** The live doc, or null when there is no session. */
  current(): RideSessionDoc | null;
  /** Reduce + persist. Rejected actions leave the doc and storage untouched. */
  dispatch(action: RideAction): RideTransition | null;
  /** Install a doc wholesale — recovery's restore step, and nothing else. */
  replace(doc: RideSessionDoc | null): void;
  /** Patch fields without a phase change (rideRouteId landing late, a refined
   *  battery confirm). Persists like any transition. */
  patch(fields: Partial<Omit<RideSessionDoc, "v" | "state" | "screen">>): RideSessionDoc | null;
  subscribe(listener: RideSessionListener): () => void;
  /** False once a write has been rejected (private mode): the session is live
   *  but will not survive a reload. */
  readonly persisted: boolean;
}

export interface RideSessionStoreOptions extends RideReducerOptions {
  storage?: RideSessionStorage;
  /** Seed the store (recovery hands its restored doc straight in). */
  initial?: RideSessionDoc | null;
}

export function createRideSessionStore(
  opts: RideSessionStoreOptions = {},
): RideSessionStore {
  const storage = opts.storage ?? localRideSessionStorage();
  const reducerOpts: RideReducerOptions = {
    legacyEndRide: opts.legacyEndRide,
  };
  let doc: RideSessionDoc | null =
    opts.initial !== undefined ? opts.initial : parseRideSession(storage.read());
  let persisted = true;
  const listeners = new Set<RideSessionListener>();

  function commit(next: RideSessionDoc | null, transition: RideTransition | null) {
    doc = next;
    if (next === null) {
      storage.remove();
    } else if (!storage.write(serializeRideSession(next))) {
      persisted = false;
    }
    for (const listener of listeners) listener(doc, transition);
  }

  return {
    current: () => doc,
    dispatch(action) {
      if (!doc) {
        // Two actions can create a session from nothing, and both need an
        // options blob to start from: `open` (the wizard) and
        // `adoptServerRide` (the resume-or-end prompt reached with no local
        // doc — pass the server ride's own `ride_options`).
        const seed =
          action.type === "open"
            ? action.options
            : action.type === "adoptServerRide"
              ? action.options
              : undefined;
        if (!seed) return null;
        const transition = reduceRideSession(
          blankRideSession(seed),
          action,
          reducerOpts,
        );
        if (transition.accepted) commit(transition.doc, transition);
        return transition;
      }
      const transition = reduceRideSession(doc, action, reducerOpts);
      if (!transition.accepted) return transition;
      const clears = transition.effects.some((e) => e.kind === "clear_session");
      commit(clears ? null : transition.doc, transition);
      return transition;
    },
    replace(next) {
      commit(next, null);
    },
    patch(fields) {
      if (!doc) return null;
      commit({ ...doc, ...fields }, null);
      return doc;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get persisted() {
      return persisted;
    },
  };
}

// ---------------------------------------------------------------------------
// Recovery on load — the decision table from the spec, verbatim.
//
// Runs in `wireRideModal()` before the first render. Every server and IDB read
// is injected so the whole table is unit-testable with plain fakes.
// ---------------------------------------------------------------------------

export type RideRecoveryAction =
  /** Nothing to restore. */
  | "none"
  /** Reopen the wizard at `screen`; no ride exists. */
  | "reopen_wizard"
  /** Bring the HUD back up and resume recording. */
  | "restore_riding"
  /** A New-Destination-loop doc: restore its wizard screen, tracking resumed. */
  | "restore_wizard"
  /** The 409 UX: a server ride this doc does not account for. */
  | "prompt_resume_or_end"
  /** ending(8) / survey(9) / eligibility(10) straight from the doc. */
  | "restore_screen"
  /** The watch expired or the vehicle reappeared: seal the final batch and go
   *  to Screen 8 with a note. `PATCH /end` still works, and donation needs it. */
  | "seal_and_end"
  /** The ride row is gone (404): end locally, nothing left to report. */
  | "local_end";

export type RideRecoveryReason =
  | "no_doc"
  | "doc_idle"
  | "doc_done"
  | "doc_corrupt"
  | "wizard_in_progress"
  | "pre_start_crash"
  | "active_match"
  | "active_match_wizard"
  | "active_conflict"
  | "end_already_reported"
  | "ride_expired"
  | "ride_deleted"
  | "post_ride_doc"
  | "private_ride"
  | "unauthenticated"
  | "offline";

export type RideRecoveryNote =
  /** "Your ride expired" — Screen 8 shows it. */
  | "ride_expired"
  /** IndexedDB was evicted: recording restarts at seq 0 and the pre-eviction
   *  track is gone. Never claim it is intact. */
  | "chain_restarted"
  /** A private ride whose local track is gone entirely — nothing to recover
   *  and no server copy by design. */
  | "track_lost"
  /** The reconcile call failed; the doc was restored unverified. */
  | "offline";

export interface TrackResumePlan {
  /** The `track-store` record key (`rideId` for a server ride). */
  trackId: string;
  keySource: "idb" | "server" | "none";
  /** True when nothing survived locally: record a FRESH chain from `seq 0` /
   *  `prev: ""`. Donation then uploads what survives and server validation
   *  adjudicates (typically `start_mismatch`). */
  freshChain: boolean;
  signing: TrackSigning | null;
  tip: TrackTip | null;
}

export interface RideRecoveryOutcome {
  action: RideRecoveryAction;
  reason: RideRecoveryReason;
  /** The doc to persist and render from, already in its restored phase. */
  doc: RideSessionDoc | null;
  /** How `track-store` should be re-attached, when tracking continues. */
  resume: TrackResumePlan | null;
  /** The server ride the outcome is about, when one was fetched. */
  ride: TrackedRide | null;
  /** True when the outcome was confirmed against the server. */
  reconciled: boolean;
  note: RideRecoveryNote | null;
}

export interface RideRecoveryDeps {
  /** The stored doc (`parseRideSession(storage.read())`). */
  doc: RideSessionDoc | null;
  /** `GET /tracked-rides/active` — resolves null when there is none. */
  getActiveRide: () => Promise<TrackedRide | null>;
  /** `GET /tracked-rides/{id}` — must reject with a `.status` of 404 when the
   *  ride is gone (both `NoDataError` and `ApiError` carry one). */
  getTrackedRide: (rideId: string) => Promise<TrackedRide>;
  /** `trackStore.readTip(trackId)` — null when this device knows nothing. */
  readTrackTip: (trackId: string) => Promise<TrackTip | null>;
  /** Signed out → there is no server ride to reconcile against. */
  isAuthenticated?: () => boolean;
  /** Probe for a server-side active ride even when the doc knows nothing —
   *  the table's "server-active but doc missing" row. */
  probeWhenNoDoc?: boolean;
}

function errorStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

function trackIdOf(doc: RideSessionDoc): string | null {
  return doc.trackKeyId ?? doc.rideId;
}

function outcome(
  fields: Partial<RideRecoveryOutcome> & {
    action: RideRecoveryAction;
    reason: RideRecoveryReason;
  },
): RideRecoveryOutcome {
  return {
    doc: null,
    resume: null,
    ride: null,
    reconciled: false,
    note: null,
    ...fields,
  };
}

async function resumePlanFor(
  deps: RideRecoveryDeps,
  trackId: string | null,
  signing: TrackSigning | null,
): Promise<TrackResumePlan | null> {
  if (!trackId) return null;
  const tip = await deps.readTrackTip(trackId);
  if (tip && tip.batchCount > 0) {
    return { trackId, keySource: "idb", freshChain: false, signing, tip };
  }
  if (tip) {
    // The record survived but nothing is sealed yet: the same key, a chain
    // still at seq 0.
    return { trackId, keySource: "idb", freshChain: true, signing, tip };
  }
  return {
    trackId,
    keySource: signing ? "server" : "none",
    freshChain: true,
    signing,
    tip: null,
  };
}

function noteForResume(
  doc: RideSessionDoc,
  plan: TrackResumePlan | null,
): RideRecoveryNote | null {
  if (!plan || !plan.freshChain) return null;
  if (plan.keySource === "none") return "track_lost";
  // `chain_restarted` means "IndexedDB was evicted and the pre-eviction track is
  // gone" — so it is keyed on the local record being GONE (`tip === null`), not
  // merely on the chain still sitting at seq 0. A rider who reloads in the first
  // minute of a ride has a tip with zero sealed batches and nothing lost; warning
  // them that their track was discarded would be a lie in the alarming direction.
  if (plan.tip !== null) return null;
  return doc.startedAtMs !== null ? "chain_restarted" : null;
}

/** The resume-or-end prompt, shared by the reload path and `startTrackedRide`'s
 *  409. Exported so the 409 handler produces a byte-identical outcome instead
 *  of a second, drifting copy of the same prompt. */
export async function recoveryForServerConflict(
  deps: RideRecoveryDeps,
  ride: TrackedRide,
  doc: RideSessionDoc | null,
): Promise<RideRecoveryOutcome> {
  // On resume, the chain tip must be rehydrated from the `batches` store keyed
  // by rideId BEFORE anything new is sealed — a restarted seq would break
  // chain verification. An empty store falls back to a fresh chain from seq 0.
  const resume = await resumePlanFor(
    deps,
    ride.id,
    ride.track_signing ?? null,
  );
  return outcome({
    action: "prompt_resume_or_end",
    reason: "active_conflict",
    doc,
    resume,
    ride,
    reconciled: true,
    // Same honesty rule as `noteForResume`: only a vanished local record means
    // the pre-eviction track is gone.
    note: resume && resume.freshChain && resume.tip === null
      ? "chain_restarted"
      : null,
  });
}

export async function recoverRideSession(
  deps: RideRecoveryDeps,
): Promise<RideRecoveryOutcome> {
  const doc = deps.doc;
  const authed = deps.isAuthenticated ? deps.isAuthenticated() : true;

  // --- No doc (or an idle/finished one). Optionally probe for a server ride
  // this device knows nothing about — the 409 UX, reached by reload.
  if (!doc || doc.state === "idle" || doc.state === "done") {
    const reason: RideRecoveryReason = !doc
      ? "no_doc"
      : doc.state === "idle"
        ? "doc_idle"
        : "doc_done";
    if (deps.probeWhenNoDoc && authed) {
      try {
        const active = await deps.getActiveRide();
        if (active) return recoveryForServerConflict(deps, active, null);
      } catch {
        return outcome({ action: "none", reason, note: "offline" });
      }
    }
    return outcome({ action: "none", reason });
  }

  // --- Post-ride states restore straight to their screen: no server reconcile
  // is needed, because the chain is already sealed.
  if (isPostRide(doc)) {
    return outcome({
      action: "restore_screen",
      reason: "post_ride_doc",
      doc,
      resume: null,
    });
  }

  // --- Crash before `startTrackedRide` resolved: no server ride is KNOWN, so
  // reopen the wizard at Screen 6 and do not reconcile. If the start had in
  // fact committed (the response was in flight), the re-press's 409 catches it.
  if (doc.state === "countdown" && doc.rideId === null) {
    return outcome({
      action: "reopen_wizard",
      reason: "pre_start_crash",
      doc: withPhase(doc, "wizard", "6"),
    });
  }

  // --- A plain wizard doc with no ride: just reopen where the rider left off.
  if (!isRideLive(doc)) {
    return outcome({
      action: "reopen_wizard",
      reason: "wizard_in_progress",
      doc,
    });
  }

  const inNewDestinationLoop = doc.state === "wizard";

  // --- Private rides reconcile against IndexedDB only. There is no server ride
  // and never was one.
  if (doc.private || doc.rideId === null) {
    const resume = await resumePlanFor(deps, trackIdOf(doc), null);
    return outcome({
      action: inNewDestinationLoop ? "restore_wizard" : "restore_riding",
      reason: "private_ride",
      doc: inNewDestinationLoop ? doc : withPhase(doc, "riding"),
      resume,
      note: noteForResume(doc, resume),
    });
  }

  // --- Signed out mid-ride: nothing to reconcile against. Restore locally and
  // say so rather than declaring the ride over.
  if (!authed) {
    const resume = await resumePlanFor(deps, trackIdOf(doc), null);
    return outcome({
      action: inNewDestinationLoop ? "restore_wizard" : "restore_riding",
      reason: "unauthenticated",
      doc,
      resume,
      note: "offline",
    });
  }

  let active: TrackedRide | null;
  try {
    active = await deps.getActiveRide();
  } catch {
    // Reload in airplane mode is a real F3 acceptance case: keep the ride,
    // keep recording, flag that nothing was verified.
    const resume = await resumePlanFor(deps, trackIdOf(doc), null);
    return outcome({
      action: inNewDestinationLoop ? "restore_wizard" : "restore_riding",
      reason: "offline",
      doc,
      resume,
      note: "offline",
    });
  }

  if (active && active.id === doc.rideId) {
    // Match → restore the HUD (or the saved wizard screen, for a
    // New-Destination-loop doc) and resume `track-store`: the key from IDB, or
    // re-imported from `active.track_signing` when IDB was evicted.
    const resume = await resumePlanFor(
      deps,
      trackIdOf(doc),
      active.track_signing ?? null,
    );
    return outcome({
      action: inNewDestinationLoop ? "restore_wizard" : "restore_riding",
      reason: inNewDestinationLoop ? "active_match_wizard" : "active_match",
      doc: inNewDestinationLoop ? doc : withPhase(doc, "riding"),
      resume,
      ride: active,
      reconciled: true,
      note: noteForResume(doc, resume),
    });
  }

  if (active) {
    // A different server ride is live than the doc claims — same prompt as the
    // 409, about the ride the SERVER says we are on.
    return recoveryForServerConflict(deps, active, doc);
  }

  // --- The doc says countdown/riding but `active` is null. Three ways to land
  // here, and the detail endpoint disambiguates.
  let ride: TrackedRide;
  try {
    ride = await deps.getTrackedRide(doc.rideId);
  } catch (err) {
    if (errorStatus(err) === 404) {
      // True 404: the ride was deleted. Local end, nothing left to report.
      return outcome({
        action: "local_end",
        reason: "ride_deleted",
        doc: withPhase(doc, "done"),
        reconciled: true,
      });
    }
    const resume = await resumePlanFor(deps, trackIdOf(doc), null);
    return outcome({
      action: inNewDestinationLoop ? "restore_wizard" : "restore_riding",
      reason: "offline",
      doc,
      resume,
      note: "offline",
    });
  }

  const tip = await deps.readTrackTip(trackIdOf(doc) ?? doc.rideId);
  // Unsealed pending points count: they become a `rec:true` batch the moment
  // anything resumes, so a Screen 10 gate that ignored them would strand a
  // donatable track.
  const facts: RideGateFacts = {
    hasWaypoints: (tip?.waypointCount ?? 0) + (tip?.pendingCount ?? 0) > 0,
  };

  if (ride.user_reported_ended_at) {
    // Another tab already reported the end. It is single-shot — a second call
    // 409s — so skip Screen 8's end buttons entirely and restore to whichever
    // post-ride screen still applies.
    return outcome({
      action: "restore_screen",
      reason: "end_already_reported",
      doc: nextAfterEnd(doc, facts),
      ride,
      reconciled: true,
    });
  }

  // The ride exists and the end is unreported: the watch elapsed or the vehicle
  // reappeared. Seal the final batch and jump to Screen 8 with a note — NOT a
  // local-only end: `PATCH /end` still works after expiry (its sole
  // precondition is an unreported end) and donation requires it.
  return outcome({
    action: "seal_and_end",
    reason: "ride_expired",
    doc: withPhase(doc, "ending"),
    ride,
    reconciled: true,
    note: "ride_expired",
  });
}
