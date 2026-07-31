// Screen 2's OPTIONS PANEL (the right pane in landscape / bottom pane in
// portrait, when the rider isn't mid-plate-entry): the two Ride Mode Options
// controls, their cross-option cascades, the Usuals (Screen 2.5) CRUD, and
// their info modals — owner copy, verbatim, from
// `docs/RIDE_MODE_OVERHAUL_PLAN.md` Part 0 "Screen 2". This module owns no
// screen registration (`ride-screen-select.ts` registers Screens 2 / 2.5 and
// owns the device-disambiguation list, the plate confirm field, and the
// [NEXT >>] button); it exports a mountable panel plus the pure logic a
// consumer wires into the ride session.
//
// FRICTION-REDUCTION PASS — down from the original eight rows to two.
//
// No Theme row: the app already has two live, ambient theme fixtures that
// cover both surfaces this panel could ever reach — `theme.ts`'s ThemeControl
// map button (Analysis/regular interface) and `ride-hud.ts`'s `toggle-night`
// button (once ride mode is actually live). A THIRD "Theme" question here,
// asked before a rider has even picked a scooter, only ever fed the narrow
// `RideOptions.theme` field (`ride-screen-routes.ts`'s Screen 4 route-preview
// basemap flavor) — not the app's actual visible theme — so it looked like a
// live toggle (☀️/🌘/auto) without ever behaving like one. Removed rather than
// wired up for real: a redundant, confusing third theme control is worse than
// none.
//
// No Est. Veo Cost HUD / Speedometer rows either: both `RideOptions` fields
// were never actually read by `ride-hud.ts` — the live HUD's speedometer and
// cost display are unconditional, driven entirely by `ride-cost.ts`'s own
// always-on rate-plan preference, completely independent of either toggle.
// Turning "Est. Veo Cost HUD" off here did nothing; the live HUD showed cost
// regardless of the ride's private/guest status either way. Pre-ride display
// preferences that don't even do anything, asked before a rider has picked a
// scooter, are pure friction — removed rather than wired up, same call as
// Theme.
//
// No Improve battery modeling / Navigation Improvement / End ride survey
// rows: asking a rider to pre-commit to donating data they don't have yet is
// backwards. `RideOptions.battery_modeling`/`nav_improvement`/`end_survey`
// still exist and still default `true` (`defaultRideOptions` below) — the
// cross-option cascades in this same module still force them `false` for a
// disqualifying ride (own device, tracking off, guest/private) exactly as
// before — but nothing in Screen 2 asks about them anymore. Screens 9/10
// (`ride-post-s9.ts`/`ride-post-s10.ts`) already ask "you have this data, do
// you want to donate it?" at the END of the ride, which is the only point a
// rider can actually answer that question honestly; a pre-ride toggle for it
// was never anything but friction ahead of a decision nobody could make yet.
//
// Ownership boundary, spelled out because Screen 2's spec text runs both
// halves together:
//   - MINE: the 2 option rows + their (?) modals, the [Usuals] button
//     (visible only once the cached list is non-empty — the tap just calls
//     `onOpenUsuals`; actually navigating to Screen 2.5 needs
//     `RideScreenContext`, which only the registered screen module holds),
//     defaults, cascades, and the Usuals CRUD wrappers around `api.ts`. No
//     more "🏆 Earns points for leaderboards" footnote either — it annotated
//     the now-removed 🏆 rows specifically; Screens 9/10 carry their own
//     points copy where it's actually relevant (after the ride, with real
//     data to donate).
//   - NOT MINE: the device list, the plate confirm field (and its numeric
//     keypad wiring), [NEXT >>], and Screen 2.5's own list UI.
//
// State contract: `RideOptions` (the wire blob, defined in `api.ts`) is what
// this module reads and writes. The session doc's `options` field
// (`ride-session.ts`) is the single persisted copy; this module never touches
// storage or the session store directly. A consumer wires the two together
// with, roughly:
//
//   const panel = renderRideOptionsPanel({
//     options: store.current()!.options,
//     context: { private: store.current()!.private, authenticated: isAuthenticated() },
//     onChange: (options) => store.dispatch({ type: "setOptions", options }),
//     onOpenUsuals: () => ctx.go("2.5"),
//     usualsAvailable: (cachedRideUsuals()?.length ?? 0) > 0,
//   });
//   ctx.setPanes(devicePane, panel.element);
//   ctx.onCleanup(panel.destroy);
//
// `panel.update(options, context)` re-syncs the same DOM (no rebuild, so
// nothing loses focus) whenever the doc changes from elsewhere — a guest
// signing in mid-wizard, the New Destination loop, Screen 2.5 returning with
// an applied Usual.

import {
  ApiError,
  MAX_RIDE_USUALS,
  deleteRideUsual,
  fetchPointsSchedule,
  listRideUsuals,
  pointsScheduleEntry,
  putRideUsual,
  type PointsScheduleResponse,
  type RideModePointsAction,
  type RideOptions,
  type RideUsual,
  type RideUsualSettings,
} from "./api.ts";
import { rideModalRoot } from "./ride-modal.ts";

/** `${provider}` in the owner's copy — Veo today, written to be
 *  provider-parameterized (master plan, Part 0 preamble). Substituted only
 *  where the master text itself spells out `${provider}` (the Cost HUD
 *  entry); every other literal "Veo" in the owner's copy stays hardcoded,
 *  verbatim, exactly as written. */
export const RIDE_PROVIDER_NAME = "Veo";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Product defaults for a fresh `RideOptions` blob — Screen 1's "open"
 *  baseline. (`ride-session.ts`'s own fallback, in `parseOptions`, is
 *  explicitly a RECOVERY fallback for a corrupt/missing stored blob, not a
 *  product default — this module is the one place that decides those, per
 *  its header comment there.) Choices, since the master plan leaves them to
 *  this module:
 *   - `speedometer: "classic"` matches the existing HUD's default (both the
 *     analog gauge and digital mph shown) — the ℹ copy's "we provide ON by
 *     default both a classic and digital readout" describes exactly that.
 *   - `theme: "auto"` mirrors `ride-session.ts`'s own recovery fallback and
 *     the app's existing sun-sync-first resolution order.
 *   - `navigation: false` — turn-by-turn is new and heavier (two more wizard
 *     screens, a geocode call); opt-in keeps the default flow the shortest
 *     "grab a scooter and go".
 *   - the four data-donation options default `true` — least-resistance
 *     toward the app's community-data mission; cascades correctly suppress
 *     the 🏆 three wherever they don't apply.
 *   - `own_device: false` — most rides start from a nearby feed device. */
export function defaultRideOptions(): RideOptions {
  return {
    cost_hud: true,
    speedometer: "classic",
    theme: "auto",
    navigation: false,
    save_tracks: true,
    battery_modeling: true,
    nav_improvement: true,
    end_survey: true,
    own_device: false,
  };
}

/** `defaultRideOptions()` with cascades already applied for a known context —
 *  e.g. Screen 1's guest baseline, where the three 🏆 options must start
 *  disabled rather than start `true` and flicker off on first render. */
export function defaultRideOptionsFor(ctx: RideOptionsContext): RideOptions {
  return applyCascades(defaultRideOptions(), ctx);
}

// ---------------------------------------------------------------------------
// Cross-option cascades (master plan, Part 0 Screen 2 "Logic" + the
// `ride-settings.ts` module-map row)
// ---------------------------------------------------------------------------

/** What the reducer needs about the session that isn't in `RideOptions`
 *  itself. `private` is `RideSessionDoc.private` verbatim — true for both a
 *  guest ride and "My own Device" (the glossary's private-ride definition);
 *  `authenticated` only refines the disabled-state COPY (a signed-in rider on
 *  their own device doesn't need a "sign in" nudge — `own_device`'s own
 *  reason already explains that one). */
export interface RideOptionsContext {
  private: boolean;
  authenticated: boolean;
}

export type TrophyOptionKey = "battery_modeling" | "nav_improvement" | "end_survey";

export type DisableReason = "own_device" | "save_tracks_off" | "guest_or_private";

export interface OptionDisableState {
  disabled: boolean;
  /** In priority order — `own_device` first, then `save_tracks_off`, then
   *  `guest_or_private` — matching the order the master plan lists the three
   *  rules and the order `trophyDisabledMessage` picks copy from. */
  reasons: DisableReason[];
}

const NOT_DISABLED: OptionDisableState = { disabled: false, reasons: [] };

/** The three independent rules from the master plan, verbatim:
 *   - own-device disables battery_modeling AND end_survey (not nav — a
 *     private own-device ride disables nav too, but via the THIRD rule below,
 *     since own-device rides are always private; own-device does not gate nav
 *     directly).
 *   - save_tracks off disables battery_modeling AND nav_improvement (not
 *     survey — the survey doesn't need a track, just a Veo device + a
 *     `tracked_rides` row).
 *   - guest/private sessions disable ALL THREE (no `tracked_rides` row to
 *     survey or donate against, and `POST /ride-routes` is session-authed).
 *  Each rule is evaluated independently of whether the others happen to be
 *  true in practice (own-device rides ARE private, via the reducer) — this is
 *  a pure function of the inputs given, not an assumption about how
 *  `ride-session.ts` produces them. */
export function trophyOptionDisableStates(
  options: RideOptions,
  ctx: RideOptionsContext,
): Record<TrophyOptionKey, OptionDisableState> {
  const battery: DisableReason[] = [];
  if (options.own_device) battery.push("own_device");
  if (!options.save_tracks) battery.push("save_tracks_off");
  if (ctx.private) battery.push("guest_or_private");

  const nav: DisableReason[] = [];
  if (!options.save_tracks) nav.push("save_tracks_off");
  if (ctx.private) nav.push("guest_or_private");

  const survey: DisableReason[] = [];
  if (options.own_device) survey.push("own_device");
  if (ctx.private) survey.push("guest_or_private");

  return {
    battery_modeling: { disabled: battery.length > 0, reasons: battery },
    nav_improvement: { disabled: nav.length > 0, reasons: nav },
    end_survey: { disabled: survey.length > 0, reasons: survey },
  };
}

/** Force every disabled 🏆 field to `false`, leaving everything else (and any
 *  enabled 🏆 field) untouched. Run this after any change that could affect a
 *  cascade — a device pick landing `own_device: true`, a guest signing in, a
 *  Usual applied wholesale (a Usual saved while signed in on a real device
 *  can carry 🏆 options a later guest/own-device context must still
 *  suppress). */
export function applyCascades(
  options: RideOptions,
  ctx: RideOptionsContext,
): RideOptions {
  const states = trophyOptionDisableStates(options, ctx);
  return {
    ...options,
    battery_modeling: states.battery_modeling.disabled
      ? false
      : options.battery_modeling,
    nav_improvement: states.nav_improvement.disabled
      ? false
      : options.nav_improvement,
    end_survey: states.end_survey.disabled ? false : options.end_survey,
  };
}

/** The disabled-state copy shown under a suppressed row. Reasons are checked
 *  in priority order so a row disabled for more than one reason at once shows
 *  its most specific explanation rather than the vaguest one. `null` = not
 *  disabled, nothing to show. */
export function trophyDisabledMessage(
  reasons: DisableReason[],
  authenticated: boolean,
): string | null {
  if (reasons.includes("own_device")) {
    return "Not available on your own device — this needs a specific Veo scooter's trip record.";
  }
  if (reasons.includes("save_tracks_off")) {
    return 'Turn on "Save ride tracks locally" to unlock this.';
  }
  if (reasons.includes("guest_or_private")) {
    return authenticated
      ? "Not available on a private ride — there's no trip record to earn points against."
      : "Sign in to earn points for this option.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Points schedule — `GET /points/schedule` interpolated into the 🏆 ℹ copy,
// with the master plan's baked-in even values as the offline/pre-A1 fallback.
// ---------------------------------------------------------------------------

export interface ResolvedRideModePoints {
  batteryBase: number;
  batteryPerStep: number;
  batteryStepKm: number;
  navRouteFeedback: number;
  navQualitativeFeedback: number;
  navDistancePerStep: number;
  navDistanceStepKm: number;
  surveyPoints: number;
}

/** Master plan Decision 6 (even-points rule) + the itemization in Part 0's
 *  Screen 2 ℹ copy and Risk/Reconciliation 6 (qualitative feedback corrected
 *  5 → 6 pts). These are the numbers `RIDE_INFO_MODAL_COPY` renders when the
 *  live schedule is unavailable. */
export const FALLBACK_RIDE_MODE_POINTS: ResolvedRideModePoints = {
  batteryBase: 8,
  batteryPerStep: 2,
  batteryStepKm: 2,
  navRouteFeedback: 4,
  navQualitativeFeedback: 6,
  navDistancePerStep: 2,
  navDistanceStepKm: 3,
  surveyPoints: 4,
};

const BATTERY_ACTION: RideModePointsAction = "battery_contribution";
const NAV_ROUTE_ACTION: RideModePointsAction = "nav_route_feedback";
const NAV_QUAL_ACTION: RideModePointsAction = "nav_qualitative_feedback";
const NAV_DISTANCE_ACTION: RideModePointsAction = "nav_distance_bonus";
const SURVEY_ACTION: RideModePointsAction = "ride_survey";

/** Normalize a `GET /points/schedule` response into the ℹ copy's shape,
 *  falling back field-by-field to the baked-in values — so a schedule that
 *  ships four of the five ride-mode actions still renders live numbers for
 *  those four and only falls back on the fifth. Never throws. */
export function resolveRideModePoints(
  schedule: PointsScheduleResponse | null | undefined,
): ResolvedRideModePoints {
  const battery = pointsScheduleEntry(schedule, BATTERY_ACTION);
  const navRoute = pointsScheduleEntry(schedule, NAV_ROUTE_ACTION);
  const navQual = pointsScheduleEntry(schedule, NAV_QUAL_ACTION);
  const navDistance = pointsScheduleEntry(schedule, NAV_DISTANCE_ACTION);
  const survey = pointsScheduleEntry(schedule, SURVEY_ACTION);
  return {
    batteryBase: battery?.base ?? FALLBACK_RIDE_MODE_POINTS.batteryBase,
    batteryPerStep: battery?.per_step ?? FALLBACK_RIDE_MODE_POINTS.batteryPerStep,
    batteryStepKm: battery?.step_km ?? FALLBACK_RIDE_MODE_POINTS.batteryStepKm,
    navRouteFeedback: navRoute?.points ?? FALLBACK_RIDE_MODE_POINTS.navRouteFeedback,
    navQualitativeFeedback:
      navQual?.points ?? FALLBACK_RIDE_MODE_POINTS.navQualitativeFeedback,
    navDistancePerStep:
      navDistance?.per_step ?? FALLBACK_RIDE_MODE_POINTS.navDistancePerStep,
    navDistanceStepKm:
      navDistance?.step_km ?? FALLBACK_RIDE_MODE_POINTS.navDistanceStepKm,
    surveyPoints: survey?.points ?? FALLBACK_RIDE_MODE_POINTS.surveyPoints,
  };
}

/** Fetch + resolve in one call. Never throws — offline, a pre-A1 deploy, or
 *  any network error all degrade to the fully-baked-in fallback so the ℹ
 *  copy always renders sane numbers. Screen 2 calls this once (per wizard
 *  open) and feeds the result into `renderRideOptionsPanel`'s `points`. */
export async function loadRideModePoints(
  signal?: AbortSignal,
): Promise<ResolvedRideModePoints> {
  try {
    return resolveRideModePoints(await fetchPointsSchedule(signal));
  } catch {
    return { ...FALLBACK_RIDE_MODE_POINTS };
  }
}

// ---------------------------------------------------------------------------
// The seven ℹ info modals — owner copy, verbatim, from the master plan's
// Part 0 "Screen 2" ℹ info-modal section. Markdown-style `*italic*`/
// `**bold**` markers are kept in the source strings on purpose (so this
// section can be diffed word-for-word against the master doc) and parsed
// into real `<em>`/`<strong>` elements at render time by `appendRichText`
// below — never innerHTML.
// ---------------------------------------------------------------------------

export type InfoModalId = "navigation" | "save_tracks";

export interface RideOptionRowMeta {
  id: InfoModalId;
  /** Screen 2's row label — the table copy, which is NOT always the same
   *  string as the ℹ modal's heading below (e.g. "Navigation Improvement" the
   *  row vs. "Improve Navigation" the modal heading) — both are transcribed
   *  verbatim from their own place in the master doc, independently. */
  label: string;
  trophy: boolean;
}

/** Screen 2's option rows, in the owner's table order. Single source for the
 *  panel's row order/labels/trophy flags AND for the copy-fidelity tests. */
export const RIDE_OPTION_ROWS: readonly RideOptionRowMeta[] = [
  { id: "navigation", label: "Destination Navigation", trophy: false },
  { id: "save_tracks", label: "Save ride tracks locally", trophy: false },
];

export interface InfoModalCopy {
  /** The ℹ modal's own heading — see the `RideOptionRowMeta.label` doc above
   *  for why this can differ from the row label. */
  title: string;
  /** Neither remaining modal reads this — kept on the shape for parity with
   *  `openRideInfoModal`'s call sites (`ride-post-s9.ts`/`ride-post-s10.ts`
   *  style "points" params elsewhere in the app), and so a future 🏆 row
   *  doesn't need the signature to change again. */
  body(points: ResolvedRideModePoints): string;
}

export const RIDE_INFO_MODAL_COPY: Record<InfoModalId, InfoModalCopy> = {
  navigation: {
    title: "Destination Navigation",
    body: () =>
      "We're trying to make not just 'good' directions, but, THE BEST directions for scooters and eBikes in Denver! Unlike the big name providers, we specifically AVOID paths that City of Denver reports as High Injury Network (HIN) roads. Our primary route type provides a direct safe route using safe infrastructure as much as possible, and we also give you options to avoid hills and save battery, stay out of the sun as much as possible, and just take the most direct route.",
  },
  save_tracks: {
    title: "Save Ride Tracks",
    body: () =>
      "This option allows you to trace where you've been on the map display, and also save waypoints of your location to your local device. Tracking information is not persisted to Scooter.fyi unless you opt to share. You may have the opportunity to donate your ride data for leaderboard points at the end of the trip IF you save ride tracks now.",
  },
};

// ---------------------------------------------------------------------------
// Ride Usuals (Screen 2.5) — list/apply/save-as-new/delete against api.ts.
// Sync pattern mirroring ride-cost.ts's `setRatePlanSyncHook` idea: a small
// local cache plus a registrable change hook, so Screen 2's [Usuals] button
// visibility and Screen 2.5's own list can both stay in sync with the last
// successful fetch without either owning the network call. (Not the literal
// hook — that one is rate-plan-specific and pushes local→account; this one
// just mirrors "cache + notify on change" for a list instead of a scalar.)
// ---------------------------------------------------------------------------

let cachedUsuals: RideUsual[] | null = null;
let usualsChangeHook: ((usuals: RideUsual[]) => void) | null = null;

/** Register (or clear) the hook fired whenever the cached list changes —
 *  Screen 2's [Usuals] button visibility and Screen 2.5's list both listen
 *  through this rather than polling `cachedRideUsuals()`. */
export function setRideUsualsChangeHook(
  fn: ((usuals: RideUsual[]) => void) | null,
): void {
  usualsChangeHook = fn;
}

function setUsualsCache(list: RideUsual[]): RideUsual[] {
  cachedUsuals = list;
  usualsChangeHook?.(list);
  return list;
}

/** The last successfully loaded list, or `null` before the first load this
 *  page session. Usuals are an authed-only feature — callers gate the fetch
 *  on `isAuthenticated()` themselves, this module has no opinion on auth. */
export function cachedRideUsuals(): RideUsual[] | null {
  return cachedUsuals;
}

/** Fetch + cache. Most-recently-updated first, per the API contract. */
export async function loadRideUsuals(
  signal?: AbortSignal,
): Promise<RideUsual[]> {
  return setUsualsCache(await listRideUsuals(signal));
}

/** 1–64 chars after trimming, matching the API's own name constraint — a
 *  client-side check so a rider gets instant feedback instead of a round
 *  trip for an obviously-bad name. */
export function isValidRideUsualName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 64;
}

/** Save the current options as a new Usual (or overwrite one by the same
 *  name — the API's `PUT` replaces wholesale, there is no separate "rename"
 *  verb). `settings.label` mirrors `name`: the API stores the settings blob
 *  opaquely, so `label` is the only field inside it that could ever diverge
 *  from the lookup key for a friendlier display string — today they're kept
 *  identical. */
export async function saveRideUsualAsNew(
  name: string,
  options: RideOptions,
  signal?: AbortSignal,
): Promise<RideUsual> {
  const trimmed = name.trim();
  const settings: RideUsualSettings = { ...options, label: trimmed };
  const saved = await putRideUsual(trimmed, settings, signal);
  const next = cachedUsuals ? [...cachedUsuals] : [];
  const i = next.findIndex((u) => u.name === saved.name);
  if (i >= 0) next[i] = saved;
  else next.unshift(saved);
  setUsualsCache(next);
  return saved;
}

export async function deleteRideUsualByName(
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  await deleteRideUsual(name, signal);
  setUsualsCache((cachedUsuals ?? []).filter((u) => u.name !== name));
}

/** Screen 2.5's [Apply] — the full options blob a Usual carries, its label
 *  dropped. Cascades still need to run afterward (`applyCascades`) — a Usual
 *  saved while signed in on a real device can carry 🏆 options a later
 *  guest/own-device context must still suppress. */
export function optionsFromRideUsual(usual: RideUsual): RideOptions {
  const s = usual.settings;
  return {
    cost_hud: s.cost_hud,
    speedometer: s.speedometer,
    theme: s.theme,
    navigation: s.navigation,
    save_tracks: s.save_tracks,
    battery_modeling: s.battery_modeling,
    nav_improvement: s.nav_improvement,
    end_survey: s.end_survey,
    own_device: s.own_device,
  };
}

/** Friendly copy for a failed Usuals CRUD call. The 409 cap and 413 size
 *  limit are worth explaining specifically; everything else degrades to a
 *  generic retry prompt. */
export function describeRideUsualsError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) {
      return `You've saved the max of ${MAX_RIDE_USUALS} Usuals — delete one first, or save over an existing name.`;
    }
    if (e.status === 413) {
      return "That Usual is too large to save.";
    }
    if (e.status === 404) {
      return "That Usual no longer exists.";
    }
  }
  return "Couldn't reach the server — try again.";
}

/** Test/HMR seam only — production never needs to reset the module-level
 *  cache. */
export function resetRideUsualsCache(): void {
  cachedUsuals = null;
}

// ---------------------------------------------------------------------------
// DOM: the options panel + the ℹ info modal shell.
//
// Discipline per the house rules / `ride-wizard.ts`: `document.createElement`
// only, never innerHTML — every string rendered here is either a static
// owner-authored constant above or a number, never server- or user-supplied,
// but the rule is followed regardless. `el()` is the same tiny helper
// `ride-modal.ts`/`ride-keypad.ts` each carry their own copy of.
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

/** Splits `**bold**` / `*italic*` markers out of an owner-copy string into
 *  real `<strong>`/`<em>` elements inside one `<p>`, via plain string
 *  indexing — no innerHTML, so this is safe regardless of the string's
 *  origin even though every caller today passes a static constant. */
function appendRichParagraph(container: HTMLElement, text: string): void {
  const p = el("p");
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) {
      p.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    if (match[1] !== undefined) {
      p.append(el("strong", undefined, match[1]));
    } else if (match[2] !== undefined) {
      p.append(el("em", undefined, match[2]));
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    p.append(document.createTextNode(text.slice(lastIndex)));
  }
  container.append(p);
}

/** Open one of the seven ℹ modals, reusing the `.ranks-modal` shell that
 *  `devices.ts`'s `openFloatingModal` (module-private there) and
 *  `ride-modal.ts`'s Escape handling both already know about — the wizard's
 *  own Escape listener explicitly defers to any open `.ranks-modal`, which is
 *  why this MUST use that exact class rather than a bespoke one. Appended
 *  into `rideModalRoot()` rather than `document.body`: the wizard's focus
 *  trap only tolerates focus inside its own root, and a `document.body`
 *  sibling would get yanked straight back out the instant this modal's close
 *  button is focused. Falls back to `document.body` when there is no live
 *  wizard (a standalone render, or a test). Returns a `close()` the caller
 *  can invoke early (e.g. on panel teardown while the modal is still open);
 *  it's a no-op if already closed. */
export function openRideInfoModal(
  id: InfoModalId,
  points: ResolvedRideModePoints = FALLBACK_RIDE_MODE_POINTS,
): () => void {
  const copy = RIDE_INFO_MODAL_COPY[id];

  // One floating `.ranks-modal` at a time, app-wide — close whatever's open
  // through its own close button so its Escape listener detaches cleanly
  // instead of being orphaned (same pattern as devices.ts's shell).
  document
    .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")
    ?.click();
  document.querySelector(".ranks-modal")?.remove();

  const previouslyFocused = document.activeElement;

  const backdrop = el("div", "ranks-modal");
  const card = el("div", "ranks-modal__card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "ride-info-modal-title");

  const head = el("div", "ranks-modal__head");
  const heading = el("h3", undefined, copy.title);
  heading.id = "ride-info-modal-title";
  const closeBtn = el("button", "ranks-modal__close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(heading, closeBtn);

  const body = el("div", "ride-info-modal__body");
  appendRichParagraph(body, copy.body(points));

  card.append(head, body);
  backdrop.append(card);

  let closed = false;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    if (
      previouslyFocused instanceof HTMLElement &&
      previouslyFocused.isConnected
    ) {
      try {
        previouslyFocused.focus();
      } catch {
        /* the launching control went away — nothing to restore to */
      }
    }
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", onKey);

  (rideModalRoot() ?? document.body).append(backdrop);
  try {
    closeBtn.focus();
  } catch {
    /* not focusable yet — the modal still works, just not pre-focused */
  }
  return close;
}

// ---------- the options panel ----------

interface RowController {
  element: HTMLElement;
  sync(options: RideOptions, ctx: RideOptionsContext): void;
}

interface Choice<T extends string> {
  value: T;
  label: string;
  ariaLabel?: string;
}

/** One option row: label + (?) button + a `.segmented`/`.seg-btn` control —
 *  the repo's existing visual pattern for a single-select group (`main.ts`'s
 *  module-private `wireSeg` wires the identical DOM shape onto
 *  server-rendered buttons; this builds the same shape fresh, since this
 *  module isn't wired from `main.ts` and `wireSeg` isn't exported). */
function makeChoiceRow<T extends string>(
  meta: RideOptionRowMeta,
  choices: readonly Choice<T>[],
  getValue: (o: RideOptions) => T,
  onSelect: (value: T) => void,
  getDisable: (o: RideOptions, ctx: RideOptionsContext) => OptionDisableState,
  openInfo: () => void,
): RowController {
  const row = el("div", "ride-settings__row");
  row.dataset.option = meta.id;

  const labelWrap = el("div", "ride-settings__label");
  if (meta.trophy) labelWrap.append(el("span", "ride-settings__trophy", "🏆"));
  labelWrap.append(el("span", "ride-settings__label-text", meta.label));
  const infoBtn = el("button", "ride-settings__info", "ℹ");
  infoBtn.type = "button";
  infoBtn.setAttribute("aria-label", `About ${meta.label}`);
  infoBtn.addEventListener("click", openInfo);
  labelWrap.append(infoBtn);
  row.append(labelWrap);

  const group = el("div", "segmented ride-settings__control");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", meta.label);
  const buttons: HTMLButtonElement[] = choices.map((choice, i) => {
    const btn = el("button", "seg-btn", choice.label);
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.dataset.value = choice.value;
    if (choice.ariaLabel) btn.setAttribute("aria-label", choice.ariaLabel);
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      onSelect(choice.value);
    });
    btn.addEventListener("keydown", (e) => {
      if (btn.disabled) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = buttons[(i + 1) % buttons.length];
        if (!next.disabled) {
          next.focus();
          onSelect(choices[(i + 1) % buttons.length].value);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = buttons[(i - 1 + buttons.length) % buttons.length];
        if (!prev.disabled) {
          prev.focus();
          onSelect(choices[(i - 1 + buttons.length) % buttons.length].value);
        }
      }
    });
    group.append(btn);
    return btn;
  });
  row.append(group);

  const reason = el("p", "ride-settings__reason");
  reason.hidden = true;
  row.append(reason);

  function sync(options: RideOptions, ctx: RideOptionsContext): void {
    const value = getValue(options);
    buttons.forEach((btn, i) => {
      const on = choices[i].value === value;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", String(on));
    });
    const state = getDisable(options, ctx);
    row.classList.toggle("ride-settings__row--disabled", state.disabled);
    for (const btn of buttons) btn.disabled = state.disabled;
    const msg = state.disabled
      ? trophyDisabledMessage(state.reasons, ctx.authenticated)
      : null;
    reason.textContent = msg ?? "";
    reason.hidden = !msg;
  }

  return { element: row, sync };
}

const ON_OFF_CHOICES: readonly Choice<"on" | "off">[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

export interface RideOptionsPanelDeps {
  options: RideOptions;
  context: RideOptionsContext;
  /** Fired with the next options blob — already cascade-applied — on every
   *  control change. The caller owns persistence, typically
   *  `store.dispatch({ type: "setOptions", options })`. */
  onChange(options: RideOptions): void;
  /** [Usuals] tap. Omit to never show the button (e.g. Screen 2.5 isn't
   *  registered yet); the button is also hidden whenever the cached list is
   *  empty regardless of this being set. */
  onOpenUsuals?(): void;
  /** Whether the cached Usuals list is currently non-empty. Defaults false;
   *  update later via the returned handle's `setUsualsAvailable`. */
  usualsAvailable?: boolean;
  /** Resolved point values for the 🏆 ℹ modals. Defaults to the offline
   *  fallback; update later via `setPoints` once `loadRideModePoints()`
   *  settles. */
  points?: ResolvedRideModePoints;
}

export interface RideOptionsPanelHandle {
  readonly element: HTMLElement;
  /** Re-sync the same DOM for a new options/context snapshot — never
   *  rebuilds, so nothing loses focus. */
  update(options: RideOptions, context?: RideOptionsContext): void;
  setUsualsAvailable(available: boolean): void;
  setPoints(points: ResolvedRideModePoints): void;
  /** Closes an info modal this panel opened, if one is still open. Call from
   *  the consumer's screen-teardown (`ctx.onCleanup`). */
  destroy(): void;
}

/** Build Screen 2's options panel: the seven rows, the footnote, and the
 *  [Usuals] button. Does not touch the DOM outside its own returned
 *  `element` — the caller slots it into a pane via `ctx.setPanes`. */
export function renderRideOptionsPanel(
  deps: RideOptionsPanelDeps,
): RideOptionsPanelHandle {
  let current = deps.options;
  let context = deps.context;
  let points = deps.points ?? FALLBACK_RIDE_MODE_POINTS;
  let usualsAvailable = deps.usualsAvailable ?? false;
  let closeOpenModal: (() => void) | null = null;

  function openInfo(id: InfoModalId): void {
    closeOpenModal?.();
    closeOpenModal = openRideInfoModal(id, points);
  }

  function setField(next: RideOptions): void {
    current = applyCascades(next, context);
    deps.onChange(current);
    syncAll();
  }

  const root = el("div", "ride-settings");

  const rows: RowController[] = [
    makeChoiceRow<"on" | "off">(
      RIDE_OPTION_ROWS[0],
      ON_OFF_CHOICES,
      (o) => (o.navigation ? "on" : "off"),
      (v) => setField({ ...current, navigation: v === "on" }),
      () => NOT_DISABLED,
      () => openInfo("navigation"),
    ),
    makeChoiceRow<"on" | "off">(
      RIDE_OPTION_ROWS[1],
      ON_OFF_CHOICES,
      (o) => (o.save_tracks ? "on" : "off"),
      (v) => setField({ ...current, save_tracks: v === "on" }),
      () => NOT_DISABLED,
      () => openInfo("save_tracks"),
    ),
  ];
  for (const row of rows) root.append(row.element);

  const actions = el("div", "ride-settings__actions");
  const usualsBtn = el("button", "ride-settings__usuals-btn", "Usuals");
  usualsBtn.type = "button";
  usualsBtn.hidden = true;
  usualsBtn.addEventListener("click", () => deps.onOpenUsuals?.());
  actions.append(usualsBtn);
  root.append(actions);

  function syncAll(): void {
    for (const row of rows) row.sync(current, context);
    usualsBtn.hidden = !(usualsAvailable && typeof deps.onOpenUsuals === "function");
  }
  syncAll();

  return {
    element: root,
    update(nextOptions, nextContext) {
      current = nextOptions;
      if (nextContext) context = nextContext;
      syncAll();
    },
    setUsualsAvailable(available) {
      usualsAvailable = available;
      syncAll();
    },
    setPoints(nextPoints) {
      points = nextPoints;
    },
    destroy() {
      closeOpenModal?.();
      closeOpenModal = null;
    },
  };
}
