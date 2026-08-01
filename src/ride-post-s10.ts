// Screen 10 — contribution eligibility copy, the donation upload, points
// display, and "See recent trips" (frontend plan, `ride-post.ts` row's S10
// slice; master `docs/RIDE_MODE_OVERHAUL_PLAN.md` Part 0 "Screen 10"). Owner's
// generated-text skeleton, verbatim:
//
//   Your ride {may be | is} {eligible | ineligible} for community
//   contribution points
//   [ because {the start location did not align with the veo feed record |
//     the end location did not align with the veo feed record | you did not
//     opt to track your route | your device did not collect the requisite
//     number of waypoints successfully | your trip was too short | your
//     saved track failed integrity verification | there was an internal
//     error} ]
//   ‖ [ but we're waiting on validation from the live feed[, and] you'll
//     need to donate your trip data to earn these points. ]
//   Buttons: [Donate This Trip's Data] [See recent trips] [Return to Main App]
//
// The "your saved track failed integrity verification" clause is the
// program's addition covering `chain_invalid` (master Part 0 footnote — the
// owner's original six-clause skeleton lacked a phrase for it).
//
// ---------------------------------------------------------------------------
// READING THE SKELETON'S BRACKET NOTATION — this drives `buildEligibilityCopy`
// below, so the reasoning is worth spelling out once.
//
// The two top-level alternatives separated by `‖` are mutually exclusive:
//   (A) "because {reason}" — a DECIDED ineligible verdict with a known cause.
//   (B) "but we're waiting on validation from the live feed[, and] you'll
//       need to donate your trip data to earn these points." — an UNDECIDED
//       verdict.
// Neither applies to a decided ELIGIBLE verdict, which renders bare.
//
// Inside (B), the nested `[, and]` is not just an optional comma+word — read
// literally it would leave "...live feed you'll need..." ungrammatical, so
// the sensible reading (confirmed by `PLAN_RIDE_MODE_API.md`, which labels
// the *whole* live-feed clause "Screen 10's 'waiting on validation from the
// live feed' branch" — a `pending_feed`-only annotation) is that the
// "we're waiting on validation from the live feed" clause is ITSELF optional,
// present only for `pending_feed` and absent for the plain `pending` status
// (nothing decided yet, no feed-specific reason to cite):
//   pending_feed → "...but we're waiting on validation from the live feed,
//                   and you'll need to donate your trip data to earn these
//                   points."
//   pending      → "...but you'll need to donate your trip data to earn
//                   these points."
//
// `status: "error"` and any future/unrecognized status are not in the
// owner's literal skeleton at all — a defensive fallback, worded distinctly
// so it is never mistaken for one of the owner's four prescribed branches;
// flagged in this lane's `deviations_from_spec`.
//
// ---------------------------------------------------------------------------
// ARCHITECTURE — self-contained, mirroring `ride-post-s8.ts`'s working
// pattern rather than `ride-post-s9.ts`'s host-deferring one.
//
// `ride-modal.ts`'s `ScreenId` (`"1"|"2"|"2.5"|"3"|"4"|"6"`) has no `"10"`
// slot and `RideModal` is never exported, so — same as Screens 8 and 9 —
// Screen 10 cannot `registerRideScreen` into the wizard shell; `ride-modal.ts`
// is a SHARED file this lane does not own.
//
// The two sibling F4 lanes disagree on what happens next: `ride-post-s8.ts`
// is fully self-sufficient — its own floating `.ride-post-modal` overlay,
// wired directly off `ride-session.ts`'s `phaseOf(doc)` via an exported
// `wireRideScreen8()`, no external host required. `ride-post-s9.ts` instead
// exports a bare `buildRidePostS9Screen()` builder (no backdrop, no wiring)
// and explicitly defers mounting to a "`ride-post.ts` … this screen's actual
// caller" that does not exist anywhere in this repo (verified: no
// `ride-post.ts` file). That is a real gap between the two sibling lanes,
// flagged for the integrator rather than silently resolved here.
//
// This module follows Screen 8's pattern — it is the one proven to work
// standalone today — as the PRIMARY, tested path: `wireRidePostS10()` builds
// its own dialog chrome and mounts/unmounts purely off
// `phaseOf(doc) === "eligibility(10)"` (the reducer's `nextAfterEnd` /
// `surveyDone` cases already gate entry into that state on
// `shouldShowEligibility`, so no additional gate is needed at mount time —
// see `shouldShowRidePostS10` below for a host-facing pre-check exported for
// symmetry with Screen 9's convention, in case a future unifying host wants
// it). Deliberately NOT imported: `ride-hud.ts`, `ride-modal.ts`,
// `ride-post-s8.ts`, `ride-post-s9.ts` — no dependency on any sibling lane's
// file, per the file-separation brief.
//
// ---------------------------------------------------------------------------
// READBACK — why `store.storage.getBatches(trackId)` and not
// `resumeRide()` + `TrackRecorder.buildDonation()`.
//
// `track-store.ts`'s `TrackStore` interface exposes `readonly storage:
// TrackStorage`, and `TrackStorage.getBatches(trackId)` returns every sealed
// batch for a track, already seq-ordered (both `MemoryTrackStorage` and
// `IdbTrackStorage` sort before returning). That is everything a donation
// body needs — this module rebuilds `TrackRecorder.buildDonation()`'s exact
// two-line logic (`batches.map(b => b.jws)`, `chain_root_hash` from the last
// batch's `chainHash`) directly against that read, rather than going through
// `store.resumeRide(trackId, opts)`. `resumeRide` is the wrong tool here: it
// requires `TrackSigning` (or `isPrivate`) to reconstruct a chain when the
// local record is missing, it can WRITE (`putRide`) and even wipe a
// nonce-mismatched "stale" chain — none of which Screen 10 wants, since by
// construction it only ever reads a chain that is already fully sealed (ride
// end already sealed the final partial batch) and never seals or continues
// recording. A plain, side-effect-free storage read is the honest tool for
// "just show me what's already there."
//
// ---------------------------------------------------------------------------
// DEVIATION — `listTrackedRides` is not in `api.ts` yet.
//
// `api.ts` (checked: no `listTrackedRides` export, no reference to
// `GET /api/v1/tracked-rides` without an id) has no client for "See recent
// trips". `scooter-fyi-api`'s `API.md` documents the endpoint as already
// live: `GET /api/v1/tracked-rides?limit=&before=&status=` → `{ count,
// rides }`, owner-only, newest first, never carrying `track_signing`. Per
// this lane's brief ("a trivial GET wrapper"), it is added HERE rather than
// touching the shared `api.ts` file — built on `api.ts`'s already-exported
// `authedFetchJSON`, so it shares that module's auth/error/429 handling
// byte-for-byte. Flagged in `shared_file_edits` for the integrator to fold
// into `api.ts` properly (alongside the rest of the module map's `api.ts`
// additions) whenever that file next gets touched.

import {
  ApiError,
  authedFetchJSON,
  donateTrack as apiDonateTrack,
  getTrackedRide as apiGetTrackedRide,
  type DonateTrackIn,
  type DonateTrackResponse,
  type PointsAward,
  type RideModePointsAction,
  type RideValidation,
  type TrackedRide,
  type TrackedRideStatus,
  type TrackVerification,
  type ValidationReason,
} from "./api.ts";
import { commas } from "./util.ts";
import {
  FALLBACK_RIDE_MODE_POINTS,
  type ResolvedRideModePoints,
} from "./ride-settings.ts";
import {
  phaseOf,
  shouldShowEligibility,
  type RideGateFacts,
  type RideSessionDoc,
  type RideSessionStore,
} from "./ride-session.ts";
import { openTrackStore, type TrackStore } from "./track-store.ts";
import { trapFocusWithin } from "./modal-focus-trap.ts";

// ---------------------------------------------------------------------------
// Eligibility copy table — pure, exported, directly unit-testable.
// ---------------------------------------------------------------------------

/** The seven reasons, in the owner's Part 0 order — matches `api.ts`'s
 *  `ValidationReason` union field-for-field. Render an unrecognized token
 *  (a future API addition) as the `internal_error` clause rather than
 *  crashing — the same discipline `api.ts`'s own doc comment on
 *  `ValidationReason` asks every consumer to follow. */
const REASON_CLAUSES: Record<ValidationReason, string> = {
  start_mismatch: "the start location did not align with the veo feed record",
  end_mismatch: "the end location did not align with the veo feed record",
  tracking_not_opted: "you did not opt to track your route",
  too_few_waypoints:
    "your device did not collect the requisite number of waypoints successfully",
  trip_too_short: "your trip was too short",
  chain_invalid: "your saved track failed integrity verification",
  internal_error: "there was an internal error",
};

/** The clause for one reason token. Exported for direct unit testing of the
 *  copy table without going through the full sentence builder. */
export function reasonClause(token: string): string {
  return (
    REASON_CLAUSES[token as ValidationReason] ?? REASON_CLAUSES.internal_error
  );
}

/** Join 1+ reason clauses into one English fragment ("A", "A and B", "A, B,
 *  and C"), de-duplicated. Null for an empty/missing list — the caller's
 *  signal that no "because" clause applies. */
export function joinReasonClauses(
  reasons: readonly string[] | null | undefined,
): string | null {
  if (!reasons || reasons.length === 0) return null;
  const clauses = Array.from(new Set(reasons.map(reasonClause)));
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

const ELIGIBILITY_LEAD = "Your ride";

/** Generate Screen 10's eligibility sentence from a `validation.status` +
 *  `validation.reasons` object — the master's exact sentence skeleton (see
 *  the module header for how the bracket notation was resolved). Covers all
 *  five `ValidationStatus` values; `pending`/`eligible`/`error` are not in
 *  the owner's literal four-branch skeleton but must still render something
 *  sane rather than throw (see the module header's DEVIATION note). */
export function buildEligibilityCopy(validation: RideValidation): string {
  const { status, reasons } = validation;
  switch (status) {
    case "eligible":
      return `${ELIGIBILITY_LEAD} is eligible for community contribution points.`;

    case "ineligible": {
      const clause = joinReasonClauses(reasons);
      return clause
        ? `${ELIGIBILITY_LEAD} is ineligible for community contribution points because ${clause}.`
        : `${ELIGIBILITY_LEAD} is ineligible for community contribution points.`;
    }

    case "pending_feed":
      return (
        `${ELIGIBILITY_LEAD} may be eligible for community contribution points, ` +
        `but we're waiting on validation from the live feed, and you'll need ` +
        `to donate your trip data to earn these points.`
      );

    case "pending":
      return (
        `${ELIGIBILITY_LEAD} may be eligible for community contribution points, ` +
        `but you'll need to donate your trip data to earn these points.`
      );

    case "error":
    default:
      // Defensive fallback — not in the owner's literal skeleton. Worded
      // distinctly so it can never be mistaken for one of the four
      // prescribed branches above.
      return (
        `${ELIGIBILITY_LEAD}'s eligibility for community contribution points ` +
        `couldn't be determined because there was an internal error.`
      );
  }
}

// ---------------------------------------------------------------------------
// Points tease — an "up to N pts" estimate shown BEFORE donation, so a rider
// has a concrete reason to bother. Necessarily a client-side guess: the real
// award depends on server-side validation (chain integrity, GBFS start/end
// correlation, minimum trip length — the very "ineligible" reasons
// `buildEligibilityCopy` above renders) this function has no visibility
// into, so the caller always phrases it as "up to", never a promise, and
// never shows it once either the real per-action award list is available
// (after donating) or the ride is already a known "ineligible".
// ---------------------------------------------------------------------------

export interface DonationPointsEligibility {
  /** `doc.options.battery_modeling`. Screen 10 is unreachable at all for an
   *  own-device/private/untracked ride (`shouldShowEligibility`'s own gate
   *  above), so this reads `true` by construction in every real case that
   *  gets this far — still threaded through rather than assumed, the same
   *  way the real server-side award does. */
  battery: boolean;
  /** `doc.options.nav_improvement && doc.route !== null` — the distance
   *  bonus is the NAVIGATION option's own "points per km of valid trip
   *  data", which presupposes a route existed to navigate and validate
   *  against. */
  navDistance: boolean;
}

/** "Up to N pts" from donating this ride's track, using the same formula
 *  the (now-removed) Screen 2 ℹ copy for "Improve battery modeling" /
 *  "Navigation Improvement" described: `batteryBase + batteryPerStep` per
 *  `batteryStepKm`, plus `navDistancePerStep` per `navDistanceStepKm` — each
 *  bucket only when the rider's own options make it reachable at all.
 *  `null` when there is nothing to estimate (unknown distance, a
 *  non-positive one, or neither bucket applies) — the caller renders
 *  nothing rather than a hollow "up to 0 pts". */
/** Whole steps of `stepKm` in `km`, rounded up — 0 (not `Infinity`/`NaN`)
 *  for a non-positive `stepKm`, so a malformed points schedule degrades the
 *  tease to its flat base rather than a nonsense number. */
function wholeSteps(km: number, stepKm: number): number {
  return stepKm > 0 ? Math.ceil(km / stepKm) : 0;
}

export function estimateDonationPoints(
  distanceMeters: number | null,
  points: ResolvedRideModePoints,
  eligibility: DonationPointsEligibility,
): number | null {
  if (distanceMeters === null || !(distanceMeters > 0)) return null;
  if (!eligibility.battery && !eligibility.navDistance) return null;
  const km = distanceMeters / 1000;
  let total = 0;
  if (eligibility.battery) {
    total +=
      points.batteryBase +
      points.batteryPerStep * wholeSteps(km, points.batteryStepKm);
  }
  if (eligibility.navDistance) {
    total += points.navDistancePerStep * wholeSteps(km, points.navDistanceStepKm);
  }
  return total;
}

/** Screen 10's donation consent disclosure — master `RIDE_MODE_OVERHAUL_PLAN.md`
 *  Part 3 §1's resolution of "no route ever leaves its owner" against
 *  donation: explicit, per-ride, per-donation consent WITH disclosed
 *  de-identification, using that section's own required phrase verbatim
 *  ("anonymous and irrevocable after de-identification (≤28 h)") alongside
 *  the retention mechanics from `RIDE_MODE_OVERHAUL_PLAN.md`'s de-id
 *  definition (4 h after points settle, hard floor 28 h after donation).
 *  Exported for direct unit testing, same convention as `buildEligibilityCopy`. */
export const DONATION_DISCLOSURE_TEXT =
  "Donating uploads this ride's waypoints and route for verification and points. " +
  "Your account link is removed within 28 hours of donating (sooner once points " +
  "settle) — after that, the data is anonymous and irrevocable: it can no longer " +
  "be deleted or traced back to you. Until then, deleting this ride removes it entirely.";

function donationDisclosure(): HTMLElement {
  return el("p", "ride-post-s10__disclosure", DONATION_DISCLOSURE_TEXT);
}

// ---------------------------------------------------------------------------
// Points-award display
// ---------------------------------------------------------------------------

const POINTS_ACTION_LABELS: Record<RideModePointsAction, string> = {
  battery_contribution: "Battery contribution",
  nav_route_feedback: "Navigation route feedback",
  nav_qualitative_feedback: "Navigation qualitative feedback",
  nav_distance_bonus: "Navigation distance bonus",
  ride_survey: "End-ride survey",
};

function titleCaseAction(action: string): string {
  return action
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Human label for a `PointsAward.action` token. Falls back to a title-cased
 *  rendering of the raw token for a future award action this module doesn't
 *  know about yet, rather than hiding or throwing. */
export function pointsActionLabel(action: string): string {
  return (
    POINTS_ACTION_LABELS[action as RideModePointsAction] ??
    titleCaseAction(action)
  );
}

const VERIFICATION_LABELS: Record<keyof TrackVerification, string> = {
  chain: "Chain integrity",
  monotonic: "Timestamp order",
  speed: "Speed plausibility",
  gbfs_start: "Start correlation",
  gbfs_end: "End correlation",
  volume: "Volume",
};

export function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`;
}

// ---------------------------------------------------------------------------
// Donation error copy
// ---------------------------------------------------------------------------

/** True only for the specific 409 that means "nothing left to donate" — the
 *  endpoint's OTHER 409 (`ride_not_ended`) is a different, retryable-elsewhere
 *  condition and must not be treated the same way. */
export function isAlreadyDonatedError(e: unknown): boolean {
  return (
    e instanceof ApiError && e.status === 409 && e.errorKey === "already_donated"
  );
}

/** Friendly copy for a failed `donateTrack` call — same discipline as
 *  `ride-post-s8.ts`'s `describeEndReportError` / `ride-post-s9.ts`'s
 *  `describeSurveySubmitError`. Covers every documented error of
 *  `POST .../track` (`API.md`): 409 `ride_not_ended` / `already_donated`,
 *  422 `tracking_not_opted` / `chain_invalid`, 413, 404, 429. */
export function describeDonateError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.errorKey) {
      case "already_donated":
        return "This ride's track was already donated.";
      case "ride_not_ended":
        return "This ride hasn't been reported as ended yet — finish Screen 8 first.";
      case "tracking_not_opted":
        return "This ride didn't have track saving turned on, so there's nothing to donate.";
      case "chain_invalid":
        return "Your saved track failed integrity verification and couldn't be donated.";
    }
    if (e.status === 413) {
      return "Your trip data is too large to donate in one request.";
    }
    if (e.status === 404) {
      return "This ride is no longer on the server.";
    }
    if (e.status === 429) {
      return "Too many donation attempts — try again in a bit.";
    }
  }
  return "Couldn't donate right now — check your connection and try again.";
}

/** Friendly copy for a failed "See recent trips" fetch. */
export function describeRecentTripsError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) {
    return "No trip history found.";
  }
  return "Couldn't load recent trips right now — try again.";
}

// ---------------------------------------------------------------------------
// "See recent trips" — GET /api/v1/tracked-rides?limit=&before=&status=
// (see the module header's DEVIATION note: not yet in api.ts)
// ---------------------------------------------------------------------------

export interface ListTrackedRidesOptions {
  limit?: number;
  /** ISO timestamp; must carry a UTC offset per the API contract. */
  before?: string;
  status?: TrackedRideStatus;
}

export interface ListTrackedRidesResponse {
  count: number;
  /** List rows never carry `track_signing` (API.md, verbatim) — the type is
   *  the full `TrackedRide` shape only because that field (and the other
   *  owner-only extras) are already optional there. */
  rides: TrackedRide[];
}

function listTrackedRidesQuery(opts: ListTrackedRidesOptions): string {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before) params.set("before", opts.before);
  if (opts.status) params.set("status", opts.status);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Owner-only, newest first. See the module header's DEVIATION note. */
export function listTrackedRides(
  opts: ListTrackedRidesOptions = {},
  signal?: AbortSignal,
): Promise<ListTrackedRidesResponse> {
  return authedFetchJSON<ListTrackedRidesResponse>(
    `/api/v1/tracked-rides${listTrackedRidesQuery(opts)}`,
    { signal },
  );
}

const TRIP_STATUS_LABELS: Record<TrackedRideStatus, string> = {
  watching: "In progress",
  left_feed: "Left the feed",
  completed: "Completed",
  expired: "Expired",
};

export function tripStatusLabel(status: TrackedRideStatus): string {
  return TRIP_STATUS_LABELS[status] ?? status;
}

const tripDateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Denver",
});

/** ISO timestamp -> "Jul 29, 3:14 PM" in Denver local time. */
export function tripDateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : tripDateFmt.format(d);
}

// ---------------------------------------------------------------------------
// Donation body — reads every sealed batch from track-store (see the module
// header's READBACK note).
// ---------------------------------------------------------------------------

async function defaultReadDonationBody(
  trackId: string,
  getTrackStore: () => Promise<TrackStore>,
): Promise<DonateTrackIn> {
  const store = await getTrackStore();
  const batches = await store.storage.getBatches(trackId);
  const body: DonateTrackIn = { batches: batches.map((b) => b.jws) };
  const last = batches.length ? batches[batches.length - 1] : null;
  if (last) body.chain_root_hash = last.chainHash;
  return body;
}

// ---------------------------------------------------------------------------
// Host-facing gate — mirrors `ride-post-s9.ts`'s `shouldShowRidePostS9`.
// `wireRidePostS10` below does not call this itself (the reducer already
// gates entry into `eligibility(10)` on this exact check — see the module
// header's ARCHITECTURE note); it is exported for a future unifying host
// that wants a pre-check before mounting, same convention as Screen 9.
// ---------------------------------------------------------------------------

export function shouldShowRidePostS10(
  doc: RideSessionDoc | null,
  facts: RideGateFacts,
): boolean {
  return doc !== null && shouldShowEligibility(doc, facts);
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type SessionLike = Pick<RideSessionStore, "current" | "dispatch" | "subscribe">;

export interface RidePostS10Deps {
  session: SessionLike;
  /** Injected for tests; defaults to `getTrackedRide` from api.ts — the doc
   *  itself carries no `validation` field, so this is how the pre-donation
   *  sentence is populated. */
  getTrackedRide?(rideId: string, signal?: AbortSignal): Promise<TrackedRide>;
  /** Injected for tests; defaults to `donateTrack` from api.ts. The ONLY call
   *  in this module that sends waypoint/track geometry off the device, and it
   *  fires exclusively from the [Donate This Trip's Data] click handler —
   *  never on mount, never speculatively. */
  donateTrack?(
    rideId: string,
    body: DonateTrackIn,
    signal?: AbortSignal,
  ): Promise<DonateTrackResponse>;
  /** Reads every sealed batch for this ride from local track-store. Injected
   *  for tests; defaults to `defaultReadDonationBody` (see the module
   *  header's READBACK note). Also only ever called from the Donate click
   *  handler — reading local storage isn't a network leak, but keeping it
   *  behind the same explicit gesture as the upload keeps the "opt-in, one
   *  button" story simple to audit. */
  readDonationBody?(trackId: string): Promise<DonateTrackIn>;
  /** Shared TrackStore accessor (review fix): `openTrackStore()` degrades to
   *  a brand-new, empty in-memory adapter on every call when IndexedDB is
   *  unavailable, so a donation reader that opens its own store
   *  independently of the ride's actual recording instance sees no batches.
   *  `ride-post.ts`'s `wireRidePost` passes `main.ts`'s shared
   *  `getTrackStore()` singleton here. Defaults to a lazily-opened,
   *  module-private `openTrackStore()` (tests / no injected caller). */
  getTrackStore?(): Promise<TrackStore>;
  /** "See recent trips". Injected for tests; defaults to this module's own
   *  `listTrackedRides` (see the module header's DEVIATION note). */
  listTrackedRides?(
    opts: ListTrackedRidesOptions,
    signal?: AbortSignal,
  ): Promise<ListTrackedRidesResponse>;
  /** How many rows "See recent trips" asks for. Defaults to 5. */
  recentTripsLimit?: number;
  /** Called once this mount tears down (phase left `eligibility(10)`, or the
   *  wiring's own teardown ran). */
  onClosed?(): void;
  /** Where Screen 10 mounts; defaults to `document.body`. Tests inject a
   *  detached container. */
  mountRoot?: HTMLElement;
  /** Resolved point values for the pre-donation "up to N pts" tease — same
   *  "copy/numbers can never drift" discipline as Screen 9's pane headers
   *  and Screen 2's (removed) ℹ modals, all sourced from
   *  `ride-settings.ts`'s `loadRideModePoints()`. A GETTER, not a plain
   *  value, and read fresh inside `mountRidePostS10` rather than once in
   *  `resolveDeps` — unlike Screen 9 (freshly built by `ride-post.ts` on
   *  every mount), this module's own `resolveDeps()` runs once at wire
   *  time, so a plain captured value would freeze on whatever
   *  `loadRideModePoints()` had resolved (often still the fallback) at
   *  BOOT and never pick up the live schedule once it lands. Defaults to
   *  the offline fallback. */
  points?(): ResolvedRideModePoints | undefined;
}

interface ResolvedDeps {
  session: SessionLike;
  getTrackedRide(rideId: string, signal?: AbortSignal): Promise<TrackedRide>;
  donateTrack(
    rideId: string,
    body: DonateTrackIn,
    signal?: AbortSignal,
  ): Promise<DonateTrackResponse>;
  readDonationBody(trackId: string): Promise<DonateTrackIn>;
  listTrackedRides(
    opts: ListTrackedRidesOptions,
    signal?: AbortSignal,
  ): Promise<ListTrackedRidesResponse>;
  recentTripsLimit: number;
  onClosed(): void;
  mountRoot: HTMLElement;
  points(): ResolvedRideModePoints;
}

function resolveDeps(deps: RidePostS10Deps): ResolvedDeps {
  const getTrackStore = deps.getTrackStore ?? openTrackStore;
  return {
    session: deps.session,
    getTrackedRide: deps.getTrackedRide ?? apiGetTrackedRide,
    donateTrack: deps.donateTrack ?? apiDonateTrack,
    readDonationBody:
      deps.readDonationBody ??
      ((trackId: string) => defaultReadDonationBody(trackId, getTrackStore)),
    listTrackedRides: deps.listTrackedRides ?? listTrackedRides,
    recentTripsLimit: deps.recentTripsLimit ?? 5,
    onClosed: deps.onClosed ?? (() => {}),
    mountRoot: deps.mountRoot ?? document.body,
    points: () => deps.points?.() ?? FALLBACK_RIDE_MODE_POINTS,
  };
}

// ---------------------------------------------------------------------------
// Wiring — mount/unmount purely off `phaseOf(doc) === "eligibility(10)"`.
// No `main.ts` change needed beyond the single call this exports (see this
// lane's `shared_file_edits`): `wireRidePostS10({ session: rideSession })`
// once at startup, alongside `wireRideScreen8` and whatever wires Screen 9.
// ---------------------------------------------------------------------------

interface MountedRidePostS10 {
  destroy(): void;
}

export function wireRidePostS10(deps: RidePostS10Deps): () => void {
  const resolved = resolveDeps(deps);
  let mounted: MountedRidePostS10 | null = null;

  function syncToPhase(doc: RideSessionDoc | null): void {
    const inPhase = doc !== null && phaseOf(doc) === "eligibility(10)";
    if (inPhase && !mounted && doc) {
      mounted = mountRidePostS10(doc, resolved, () => {
        mounted = null;
      });
    } else if (!inPhase && mounted) {
      mounted.destroy();
      mounted = null;
    }
  }

  syncToPhase(resolved.session.current());
  const unsubscribe = resolved.session.subscribe((doc) => syncToPhase(doc));

  return () => {
    unsubscribe();
    mounted?.destroy();
    mounted = null;
  };
}

function mountRidePostS10(
  doc: RideSessionDoc,
  deps: ResolvedDeps,
  onClosed: () => void,
): MountedRidePostS10 {
  const rideId = doc.rideId;
  const trackId = doc.trackKeyId ?? doc.rideId;

  const backdrop = el("div", "ride-post-modal");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "ride-post-s10-title");
  const card = el("div", "ride-post-modal__card ride-post-s10");
  backdrop.append(card);

  let destroyed = false;
  let busy = false;
  let error: string | null = null;

  let validation: RideValidation = { status: "pending", reasons: [] };
  let validationLoaded = false;
  let validationNote: string | null = null;
  // For the pre-donation points tease below — populated alongside
  // `validation` from the same `getTrackedRide` response, so it needs no
  // fetch of its own.
  let rideDistanceMeters: number | null = null;

  let donation: DonateTrackResponse | null = null;
  let donated = false;

  let recentTripsVisible = false;
  let recentTripsLoading = false;
  let recentTripsError: string | null = null;
  let recentTrips: TrackedRide[] | null = null;

  // House rule: "anything modal" needs a focus trap — see
  // modal-focus-trap.ts's header for why this is a standalone copy rather
  // than ride-modal.ts's own private one.
  const untrapFocus = trapFocusWithin(backdrop, () => !destroyed);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    untrapFocus();
    backdrop.remove();
    onClosed();
  }

  function render(): void {
    card.replaceChildren();
    card.append(renderBody());
    const focusTarget = card.querySelector<HTMLElement>("button:not([disabled])");
    try {
      focusTarget?.focus();
    } catch {
      /* detached — nothing to focus yet */
    }
  }

  function renderBody(): HTMLElement {
    const wrap = el("div", "ride-post-s10__body");
    const title = el("h2", "ride-modal__lede", "Contribution eligibility");
    title.id = "ride-post-s10-title";
    wrap.append(title);

    const sentence = el(
      "p",
      "ride-post-s10__sentence",
      buildEligibilityCopy(validation),
    );
    sentence.setAttribute("role", "status");
    sentence.setAttribute("aria-live", "polite");
    wrap.append(sentence);

    if (!validationLoaded) {
      wrap.append(
        el("p", "ride-modal__hint", "Checking the latest status from the server…"),
      );
    } else if (validationNote) {
      wrap.append(el("p", "ride-modal__hint", validationNote));
    }

    if (donation) {
      wrap.append(renderDonationDetail(donation));
    } else if (donated) {
      wrap.append(
        el("p", "ride-modal__hint", "This ride's track has already been donated."),
      );
    }

    if (error) {
      const err = el("p", "ride-post-s10__error", error);
      err.setAttribute("role", "status");
      err.setAttribute("aria-live", "polite");
      wrap.append(err);
    }
    if (busy) {
      wrap.append(el("p", "ride-modal__hint", "Working…"));
    }

    // The pre-donation points tease: only while donating is still a live,
    // meaningful choice — gone once the real per-action award list is
    // showing (`donation`/`donated`), and never shown for an already-
    // decided "ineligible" ride, where a number here would contradict the
    // sentence above it. `estimateDonationPoints` itself returns `null`
    // (rendering nothing) whenever the distance isn't known yet or neither
    // points bucket applies to this rider's options.
    if (!donated && !donation && validation.status !== "ineligible") {
      const estimate = estimateDonationPoints(rideDistanceMeters, deps.points(), {
        battery: doc.options.battery_modeling,
        navDistance: doc.options.nav_improvement && doc.route !== null,
      });
      if (estimate !== null) {
        wrap.append(
          el(
            "p",
            "ride-post-s10__points-tease",
            `Donating could earn you up to ${commas(estimate)} pts (pending validation).`,
          ),
        );
      }
    }

    // Privacy/completeness review fix: the master plan resolves "no route
    // ever leaves its owner" against donation via explicit, per-ride,
    // per-donation consent WITH disclosed de-identification — Screen 10's
    // consent copy must say so immediately before the affirmative action,
    // not merely somewhere in the privacy policy. Shown whenever donation is
    // still an available action (not after it's already been used).
    if (!donated) wrap.append(donationDisclosure());

    const actions = el("div", "ride-wizard__actions ride-post-s10__actions");
    const donateBtn = actionButton(
      "Donate This Trip's Data",
      "",
      () => void onDonate(),
    );
    donateBtn.disabled = busy || donated || !rideId || !trackId;
    const recentBtn = actionButton(
      "See recent trips",
      "login-btn--secondary",
      () => void onSeeRecentTrips(),
    );
    recentBtn.disabled = busy;
    recentBtn.setAttribute("aria-expanded", String(recentTripsVisible));
    const returnBtn = actionButton(
      "Return to Main App",
      "login-btn--secondary",
      () => onReturnToMainApp(),
    );
    returnBtn.disabled = busy;
    actions.append(donateBtn, recentBtn, returnBtn);
    wrap.append(actions);

    if (recentTripsVisible) wrap.append(renderRecentTrips());

    return wrap;
  }

  function renderDonationDetail(d: DonateTrackResponse): HTMLElement {
    const wrap = el("div", "ride-post-s10__donation");
    wrap.append(el("h4", undefined, "Donation result"));
    wrap.append(row("Waypoints uploaded", commas(d.waypoint_count)));
    wrap.append(
      row(
        "Distance",
        d.distance_meters !== null ? formatKm(d.distance_meters) : "unknown",
      ),
    );
    wrap.append(verificationList(d.verification));
    wrap.append(pointsList(d.points));
    return wrap;
  }

  function verificationList(v: TrackVerification): HTMLElement {
    const list = el("ul", "ride-post-s10__verification");
    for (const key of Object.keys(VERIFICATION_LABELS) as (keyof TrackVerification)[]) {
      const value = v[key];
      if (value === undefined) continue;
      const li = el("li");
      li.append(
        el("strong", undefined, `${VERIFICATION_LABELS[key]}: `),
        // The API owns this vocabulary — render whatever it sends verbatim
        // (api.ts's own `TrackVerification` doc comment).
        document.createTextNode(value),
      );
      list.append(li);
    }
    return list;
  }

  function pointsList(points: readonly PointsAward[]): HTMLElement {
    if (points.length === 0) {
      return el(
        "p",
        "ride-modal__hint",
        "No points awarded yet — distance-dependent points show once validation settles.",
      );
    }
    const list = el("ul", "ride-post-s10__points");
    for (const p of points) {
      const li = el(
        "li",
        undefined,
        `${pointsActionLabel(p.action)}: +${p.points} pts`,
      );
      list.append(li);
    }
    return list;
  }

  function renderRecentTrips(): HTMLElement {
    const wrap = el("div", "ride-post-s10__recent-trips");
    wrap.append(el("h4", undefined, "Recent trips"));
    if (recentTripsLoading) {
      wrap.append(el("p", "ride-modal__hint", "Loading…"));
    } else if (recentTripsError) {
      wrap.append(el("p", "ride-modal__hint", recentTripsError));
    } else if (recentTrips && recentTrips.length === 0) {
      wrap.append(el("p", "ride-modal__hint", "No recent trips yet."));
    } else if (recentTrips) {
      const list = el("ul", "ride-post-s10__trip-list");
      for (const ride of recentTrips) {
        const li = el("li", "ride-post-s10__trip");
        li.append(el("strong", undefined, tripDateLabel(ride.started_at)));
        li.append(
          document.createTextNode(` — ${tripStatusLabel(ride.status)}`),
        );
        if (ride.distance_meters !== null) {
          li.append(document.createTextNode(`, ${formatKm(ride.distance_meters)}`));
        }
        list.append(li);
      }
      wrap.append(list);
    }
    return wrap;
  }

  // ---------------- initial validation load ----------------

  async function loadValidation(): Promise<void> {
    if (!rideId) {
      validationLoaded = true;
      render();
      return;
    }
    try {
      const ride = await deps.getTrackedRide(rideId);
      if (destroyed) return;
      validation = ride.validation ?? { status: "pending", reasons: [] };
      rideDistanceMeters = ride.distance_meters;
    } catch {
      if (destroyed) return;
      validationNote =
        "Couldn't check your ride's latest status — you can still donate below.";
    } finally {
      if (!destroyed) {
        validationLoaded = true;
        render();
      }
    }
  }

  // ---------------- Donate This Trip's Data ----------------

  async function onDonate(): Promise<void> {
    if (busy || donated || !rideId || !trackId) return;
    busy = true;
    error = null;
    render();
    try {
      const body = await deps.readDonationBody(trackId);
      if (destroyed) return;
      const response = await deps.donateTrack(rideId, body);
      if (destroyed) return;
      donation = response;
      validation = response.validation;
      validationNote = null;
      validationLoaded = true;
      donated = true;
      busy = false;
      render();
    } catch (e) {
      if (destroyed) return;
      busy = false;
      error = describeDonateError(e);
      if (isAlreadyDonatedError(e)) donated = true;
      render();
    }
  }

  // ---------------- See recent trips ----------------

  async function onSeeRecentTrips(): Promise<void> {
    if (busy) return;
    recentTripsVisible = !recentTripsVisible;
    if (!recentTripsVisible || recentTrips !== null || recentTripsLoading) {
      render();
      return;
    }
    recentTripsLoading = true;
    recentTripsError = null;
    render();
    try {
      const res = await deps.listTrackedRides({ limit: deps.recentTripsLimit });
      if (destroyed) return;
      recentTrips = res.rides;
    } catch (e) {
      if (destroyed) return;
      recentTripsError = describeRecentTripsError(e);
    } finally {
      if (!destroyed) {
        recentTripsLoading = false;
        render();
      }
    }
  }

  // ---------------- Return to Main App ----------------

  function onReturnToMainApp(): void {
    if (busy) return;
    const transition = deps.session.dispatch({ type: "eligibilityDone" });
    if (!transition || !transition.accepted) {
      console.error(
        "ride-post-s10: eligibilityDone was rejected",
        transition?.rejected,
      );
    }
    // No direct destroy() call: `wireRidePostS10`'s subscribe callback
    // unmounts this screen once the phase leaves `eligibility(10)` — same
    // pattern as `ride-post-s8.ts`'s [Rush Quit] handler.
  }

  render();
  void loadValidation();
  deps.mountRoot.append(backdrop);

  return {
    destroy(): void {
      destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Small DOM builders
// ---------------------------------------------------------------------------

function row(label: string, value: string): HTMLElement {
  const wrap = el("p", "ride-post-s10__row");
  wrap.append(el("strong", undefined, `${label}: `), document.createTextNode(value));
  return wrap;
}

function actionButton(
  label: string,
  extraClass: string,
  onClick: () => void,
): HTMLButtonElement {
  const cls = extraClass ? `login-btn ${extraClass}` : "login-btn";
  const btn = el("button", cls.trim(), label);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

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
