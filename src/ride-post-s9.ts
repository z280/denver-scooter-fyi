// Screen 9 — the dual survey panes (frontend plan, `ride-post.ts` row's S9
// portion; master `docs/RIDE_MODE_OVERHAUL_PLAN.md` Part 0 "Screen 9" +
// Risk/Reconciliation 16 "Screen 9 pane gates"). 50/50 split: LEFT is
// Scooter Feedback (+survey pts), RIGHT is Navigation Feedback (route rating
// + qualitative + NPS, up to N pts + a distance bonus donation earns later).
//
// ---------------------------------------------------------------------------
// PANE GATING — spec-corrected, per master Risk 16. Read this before touching
// anything below.
//
// A literal reading of the vision's header ("on a Veo scooter + tracked ride,
// regardless of navigation") could suggest the left pane always renders on a
// tracked ride. Risk 16 corrects that: the two panes gate INDIVIDUALLY —
//   - LEFT renders only when `RideOptions.end_survey` is on (the Screen 2
//     toggle that exists to control exactly this pane, and the API's
//     `ride_survey` award gates on the same option).
//   - RIGHT renders only when the session doc holds a selected route
//     (`doc.route !== null` — "How was the `${selectedRoute}`?" presupposes
//     one). It does NOT additionally require `route.rideRouteId` to be
//     non-null: a route can be chosen and still unpersisted server-side (nav
//     improvement off, or API phase A3 not deployed yet — F2's tolerated
//     404), and the rating question is answerable either way; the payload
//     just omits `ride_route_id` in that case, forfeiting only the
//     ride-linked awards (nav_route_feedback / the distance bonus), never the
//     ability to answer.
//   - Both gated off → Screen 9 is skipped ENTIRELY, not rendered empty.
//
// `ride-session.ts` already implements this exact gate — `surveyPanes()` /
// `shouldShowSurvey()` — so this module consumes those functions rather than
// re-deriving the logic a second time (the drift Risk 16 exists to prevent).
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE TAKES NO DEPENDENCY ON `ride-modal.ts`
//
// `ride-modal.ts`'s `ScreenId`/`RIDE_SCREEN_FLOW` are `"1"|"2"|"2.5"|"3"|"4"|
// "6"` — Screens 8/9/10 are `ride-session.ts` STATES (`ending`/`survey`/
// `eligibility`), not wizard screens, and structurally cannot be
// `registerRideScreen`'d there. `ride-post.ts` (the S8 lane's module, owning
// the post-ride host/router) is this screen's actual caller. Per this lane's
// file-separation brief this module is self-contained: it builds its own DOM
// root (a single element, not a `primary`/`secondary` pane pair — the shared
// [Skip]/[Submit] footer sits below BOTH panes, which the wizard shell's
// two-slot contract has no room for) and transitions the ride session
// directly via `session.dispatch({ type: "surveyDone", ... })`, exactly like
// every other screen module dispatches its own action (`ride-screen-dest.ts`
// → `setDest`, Screen 8's buttons → `rushQuit`/`endReported`) rather than
// calling a `ctx.next()` this screen was never handed.
//
// `RidePostS9Screen` below mirrors `ride-modal.ts`'s `RideScreen` shape
// field-for-field (title/primary/destroy) purely by convention, for whatever
// mini host `ride-post.ts` builds — but it is declared locally, not imported,
// so this file compiles and tests standalone regardless of what shape that
// sibling lane's module ends up taking.

import {
  ApiError,
  postSurvey as apiPostSurvey,
  type RideSurveyIn,
  type RideSurveyResponse,
  type SurveyIssue,
  type SurveyModelBonus,
} from "./api.ts";
import {
  FALLBACK_RIDE_MODE_POINTS,
  RIDE_PROVIDER_NAME,
  type ResolvedRideModePoints,
} from "./ride-settings.ts";
import {
  selectedDevice,
  shouldShowSurvey,
  surveyPanes,
  type RideGateFacts,
  type RideSessionDoc,
  type RideSessionStore,
  type SurveyPaneGates,
} from "./ride-session.ts";

// ---------------------------------------------------------------------------
// The 16-item issue vocabulary (master Part 0 Screen 9 "IF no — what
// wasn't?"), mapped to the API's snake_case tokens (`api.ts`'s `SurveyIssue`
// union — API phase A3's vocabulary). One array is the single source for
// both display order and both lookup directions, so the two can never drift
// apart.
// ---------------------------------------------------------------------------

export interface SurveyIssueOption {
  token: SurveyIssue;
  label: string;
}

/** Display order matches the owner's copy verbatim. */
export const SURVEY_ISSUE_OPTIONS: readonly SurveyIssueOption[] = [
  { token: "app_veo", label: "App (Veo)" },
  { token: "acceleration", label: "Acceleration" },
  { token: "basket", label: "Basket" },
  { token: "battery", label: "Battery" },
  { token: "bell", label: "Bell" },
  { token: "brakes", label: "Brakes" },
  { token: "connectivity", label: "Connectivity" },
  { token: "customer_service", label: "Customer Service Experience" },
  { token: "dirty", label: "Dirty device" },
  { token: "kickstand", label: "Kickstand" },
  { token: "pedals", label: "Pedals" },
  { token: "phone_holder", label: "Phone Holder" },
  { token: "price", label: "Price" },
  { token: "speedometer", label: "Speedometer" },
  { token: "scooterfyi_issue", label: "Scooter.fyi issue" },
  { token: "vandalized", label: "Vandalized" },
];

const ISSUE_LABEL_BY_TOKEN: ReadonlyMap<SurveyIssue, string> = new Map(
  SURVEY_ISSUE_OPTIONS.map((o) => [o.token, o.label]),
);
const ISSUE_TOKEN_BY_LABEL: ReadonlyMap<string, SurveyIssue> = new Map(
  SURVEY_ISSUE_OPTIONS.map((o) => [o.label, o.token]),
);

/** Display label for an API token. Falls back to the raw token for a future
 *  vocabulary addition this module doesn't know about yet, rather than
 *  throwing or hiding it. */
export function issueLabel(token: SurveyIssue): string {
  return ISSUE_LABEL_BY_TOKEN.get(token) ?? token;
}

/** API token for a display label, or null when the label isn't one of the
 *  16 (e.g. a stale/hand-typed value). */
export function issueToken(label: string): SurveyIssue | null {
  return ISSUE_TOKEN_BY_LABEL.get(label) ?? null;
}

// ---------------------------------------------------------------------------
// Per-model bonus questions (master Part 0 Screen 9 "Bonus `${deviceType}`
// questions"; API vocabulary from `api.ts`'s `SurveyModelBonus`). Keyed off
// the ride's stamped device model — `ride-screen-select.ts` stores it
// lowercased on `RideSessionSelectedDevice.model` via `devices.ts`'s
// `modelKeyOf`, but this module normalizes independently (trim + lowercase)
// so it degrades gracefully against any other casing a future caller hands
// it, rather than silently matching nothing.
// ---------------------------------------------------------------------------

export type ModelBonusKey = "cosmo" | "apollo" | "astro";

export interface ModelBonusQuestion {
  model: ModelBonusKey;
  prompt: string;
  kind: "yesno" | "numeric";
  /** Numeric bounds; only meaningful when `kind === "numeric"`. */
  min?: number;
  max?: number;
  /** The `SurveyModelBonus` field this question's answer submits as — kept
   *  here for documentation/tests; `modelBonusPayload` below is the actual
   *  (switch-based, cast-free) builder. */
  apiField: keyof SurveyModelBonus;
}

export const MODEL_BONUS_QUESTIONS: Record<ModelBonusKey, ModelBonusQuestion> = {
  cosmo: {
    model: "cosmo",
    prompt: "Does it have a front basket?",
    kind: "yesno",
    apiField: "cosmo_front_basket",
  },
  apollo: {
    model: "apollo",
    prompt: "What was your top speed?",
    kind: "numeric",
    min: 0,
    max: 40,
    apiField: "apollo_top_speed_mph",
  },
  astro: {
    model: "astro",
    prompt: "Is there a landscape phone holder that works?",
    kind: "yesno",
    apiField: "astro_landscape_holder",
  },
};

/** Normalize any casing/whitespace of a stored model string to the
 *  recognized bonus-question key, or null for anything else (unrecognized
 *  model, guest device, own device with no model on file). */
export function normalizeModelKey(
  model: string | null | undefined,
): ModelBonusKey | null {
  const m = (model ?? "").trim().toLowerCase();
  return m === "cosmo" || m === "apollo" || m === "astro" ? m : null;
}

/** The bonus question for this ride's device model, or null when the model
 *  is unrecognized (an unknown/mystery model shows NO bonus question). */
export function modelBonusQuestionFor(
  model: string | null | undefined,
): ModelBonusQuestion | null {
  const key = normalizeModelKey(model);
  return key ? MODEL_BONUS_QUESTIONS[key] : null;
}

function modelBonusPayload(
  q: ModelBonusQuestion,
  yesNo: boolean | null,
  numeric: number | null,
): SurveyModelBonus | null {
  switch (q.model) {
    case "cosmo":
      return yesNo === null ? null : { cosmo_front_basket: yesNo };
    case "astro":
      return yesNo === null ? null : { astro_landscape_holder: yesNo };
    case "apollo":
      return numeric === null ? null : { apollo_top_speed_mph: numeric };
  }
}

// ---------------------------------------------------------------------------
// Route profile display labels (master Part 0 Screen 4's copy, quoted here
// rather than imported from `ride-screen-routes.ts` — that module's own
// `FALLBACK_PROFILES` carries the same strings, but importing a sibling F4
// lane's file back into this one is exactly the coupling the file-separation
// brief asks this module to avoid; both copies trace to the same owner text,
// so there is nothing to drift toward). Unknown/future profile keys render
// as themselves rather than throwing.
// ---------------------------------------------------------------------------

const ROUTE_PROFILE_LABELS: Record<string, string> = {
  safe: "Safe & Protected",
  range: "The Range Maximizer",
  shade: "The Shaded Canopy",
  express: "Commuter Express",
};

export function routeProfileLabel(profile: string): string {
  return ROUTE_PROFILE_LABELS[profile] ?? profile;
}

// ---------------------------------------------------------------------------
// Qualitative feedback char-count hint. A HINT, never a hard block — Submit
// stays enabled at any length; this only tells the rider whether they've
// crossed the threshold that earns the qualitative award.
// ---------------------------------------------------------------------------

export const NAV_QUALITATIVE_MIN_CHARS = 20;

export interface QualitativeProgress {
  /** Trimmed length — leading/trailing whitespace never counts. */
  trimmedLength: number;
  /** 0 once the threshold is met. */
  remaining: number;
  earned: boolean;
  message: string;
}

export function describeQualitativeProgress(
  text: string,
  awardPoints: number = FALLBACK_RIDE_MODE_POINTS.navQualitativeFeedback,
  minChars: number = NAV_QUALITATIVE_MIN_CHARS,
): QualitativeProgress {
  const trimmedLength = text.trim().length;
  const remaining = Math.max(0, minChars - trimmedLength);
  const earned = trimmedLength >= minChars;
  const message = earned
    ? `${trimmedLength} characters — that earns the +${awardPoints} pt qualitative bonus.`
    : `${trimmedLength}/${minChars} characters — ${remaining} more to earn the +${awardPoints} pt qualitative bonus.`;
  return { trimmedLength, remaining, earned, message };
}

// ---------------------------------------------------------------------------
// Form state + payload builder — pure, DOM-free, so the submission shape is
// unit-testable without simulating clicks.
// ---------------------------------------------------------------------------

export interface RidePostS9FormState {
  wouldRideAgain: boolean | null;
  wasPerfect: boolean | null;
  /** Only meaningful (and only ever populated by the UI) when
   *  `wasPerfect === false`. */
  issues: readonly SurveyIssue[];
  /** For a `yesno`-kind model bonus question (Cosmo basket / Astro holder). */
  modelBonusYesNo: boolean | null;
  /** For the `numeric`-kind model bonus question (Apollo top speed). */
  modelBonusNumeric: number | null;
  navRouteRating: number | null;
  navDeviated: boolean | null;
  /** Only meaningful (and only ever populated by the UI) when
   *  `navDeviated === true`. */
  navDeviatedNeedsImprovement: boolean | null;
  navNps: number | null;
  navQualitative: string;
}

export function blankSurveyFormState(): RidePostS9FormState {
  return {
    wouldRideAgain: null,
    wasPerfect: null,
    issues: [],
    modelBonusYesNo: null,
    modelBonusNumeric: null,
    navRouteRating: null,
    navDeviated: null,
    navDeviatedNeedsImprovement: null,
    navNps: null,
    navQualitative: "",
  };
}

export interface SurveyPayloadContext {
  /** The ride's stamped device model (`RideSessionSelectedDevice.model`),
   *  raw — normalized internally. */
  model: string | null;
  /** `doc.route?.rideRouteId ?? null` — omitted from the payload entirely
   *  when null (see the module-doc note on the right-pane gate: "retry
   *  without it" is the API's own documented no-route signal, not an
   *  explicit `null`). */
  rideRouteId: string | null;
}

/** Build the `POST .../survey` payload from the form state, respecting the
 *  SAME pane gates the screen rendered with — a field belonging to a pane
 *  that never rendered is never sent, regardless of what garbage might be
 *  sitting in `state` for it. */
export function buildSurveyPayload(
  state: RidePostS9FormState,
  gates: SurveyPaneGates,
  ctx: SurveyPayloadContext,
): RideSurveyIn {
  const payload: RideSurveyIn = {};

  if (gates.scooter) {
    payload.would_ride_again = state.wouldRideAgain;
    payload.was_perfect = state.wasPerfect;
    if (state.wasPerfect === false && state.issues.length > 0) {
      payload.issues = [...state.issues];
    }
    const question = modelBonusQuestionFor(ctx.model);
    if (question) {
      const bonus = modelBonusPayload(
        question,
        state.modelBonusYesNo,
        state.modelBonusNumeric,
      );
      if (bonus) payload.model_bonus = bonus;
    }
  }

  if (gates.navigation) {
    payload.nav_route_rating = state.navRouteRating;
    payload.nav_deviated = state.navDeviated;
    payload.nav_deviated_needs_improvement =
      state.navDeviated === true ? state.navDeviatedNeedsImprovement : null;
    payload.nav_nps = state.navNps;
    const trimmed = state.navQualitative.trim();
    payload.nav_qualitative = trimmed.length > 0 ? trimmed : null;
    if (ctx.rideRouteId) payload.ride_route_id = ctx.rideRouteId;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Host-facing gate — call BEFORE building the screen. Both panes gated off
// means Screen 9 must be skipped entirely (master Risk 16), never rendered
// as an empty shell; this is the equivalent of the `skip()` predicate every
// `registerRideScreen` registration carries, just exported as a plain
// function since Screens 8–10 have no registry to hang one on.
// ---------------------------------------------------------------------------

export function shouldShowRidePostS9(doc: RideSessionDoc | null): boolean {
  return doc !== null && shouldShowSurvey(doc);
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/** Mirrors `ride-modal.ts`'s `RideScreen` shape (title/primary/destroy) by
 *  convention only — declared locally so this module has zero dependency on
 *  `ride-modal.ts`. See the file-header note. */
export interface RidePostS9Screen {
  title: string;
  primary: HTMLElement;
  destroy(): void;
}

export type SessionLike = Pick<RideSessionStore, "current" | "dispatch">;

export interface RidePostS9Deps {
  session: SessionLike;
  /** `track-store`'s local waypoint fact, which `surveyDone`'s Screen 10 gate
   *  needs (`shouldShowEligibility`). This module owns no track-store
   *  dependency, so the host supplies it — required, not defaulted: silently
   *  assuming "no waypoints" would strand a donatable track behind a
   *  wrongly-skipped Screen 10. May resolve synchronously or async. */
  getGateFacts(): RideGateFacts | Promise<RideGateFacts>;
  /** Injected for tests; defaults to `api.ts`'s `postSurvey`. */
  postSurvey?: typeof apiPostSurvey;
  /** Resolved point values for the pane headers, live from
   *  `GET /points/schedule` — same "copy can never drift" discipline as
   *  Screen 2's ℹ modals (`ride-settings.ts`'s `loadRideModePoints`). The
   *  host loads it once and passes the result; omitted, this screen falls
   *  back to the same offline default `ride-settings.ts` uses. */
  points?: ResolvedRideModePoints;
  onSubmitted?(response: RideSurveyResponse): void;
  onSkipped?(): void;
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

function makeSegBtn(
  label: string,
  active: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const btn = el("button", "seg-btn", label);
  btn.type = "button";
  btn.setAttribute("role", "radio");
  btn.setAttribute("aria-checked", String(active));
  btn.classList.toggle("is-active", active);
  btn.addEventListener("click", onClick);
  return btn;
}

function yesNoField(
  question: string,
  value: boolean | null,
  onSelect: (v: boolean) => void,
): HTMLElement {
  const wrap = el("div", "ride-post-s9__field");
  wrap.append(el("p", "ride-post-s9__question", question));
  const group = el("div", "segmented ride-post-s9__choice");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", question);
  group.append(
    makeSegBtn("Yes", value === true, () => onSelect(true)),
    makeSegBtn("No", value === false, () => onSelect(false)),
  );
  wrap.append(group);
  return wrap;
}

function scaleField(
  question: string,
  min: number,
  max: number,
  value: number | null,
  onSelect: (v: number) => void,
): HTMLElement {
  const wrap = el("div", "ride-post-s9__field");
  wrap.append(el("p", "ride-post-s9__question", question));
  const group = el("div", "segmented ride-post-s9__scale");
  group.style.flexWrap = "wrap";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", question);
  for (let n = min; n <= max; n += 1) {
    group.append(makeSegBtn(String(n), value === n, () => onSelect(n)));
  }
  wrap.append(group);
  return wrap;
}

/** Build Screen 9. Callers MUST check `shouldShowRidePostS9(doc)` first —
 *  see that function's doc — but this still degrades to a minimal, closable
 *  "nothing to survey" body rather than crashing if it's ever called with
 *  both panes gated off, per the house rule that a broken build must never
 *  strand the rider. */
export function buildRidePostS9Screen(deps: RidePostS9Deps): RidePostS9Screen {
  let destroyed = false;
  let submitting = false;
  const points = deps.points ?? FALLBACK_RIDE_MODE_POINTS;

  const doc = deps.session.current();
  const gates: SurveyPaneGates = doc
    ? surveyPanes(doc)
    : { scooter: false, navigation: false };
  const model = doc ? (selectedDevice(doc.device)?.model ?? null) : null;
  const routeProfile = doc?.route?.profile ?? null;
  const rideRouteId = doc?.route?.rideRouteId ?? null;

  const state: RidePostS9FormState = blankSurveyFormState();

  const root = el("div", "ride-post-s9");
  const panesWrap = el("div", "ride-post-s9__panes");
  // CSS-only responsive 50/50: two columns when there's room for both at
  // >=240px, else a single stacked column — no matchMedia/orientation
  // listener needed (unlike `ride-modal.ts`'s shell, which owns that
  // machinery for the wizard proper).
  panesWrap.style.display = "grid";
  panesWrap.style.gap = "16px";
  panesWrap.style.gridTemplateColumns = "repeat(auto-fit, minmax(240px, 1fr))";
  const leftSlot = el("div", "ride-post-s9__pane-slot");
  const rightSlot = el("div", "ride-post-s9__pane-slot");
  panesWrap.append(leftSlot, rightSlot);

  const statusEl = el("p", "ride-modal__hint");
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  statusEl.hidden = true;

  const footer = el("div", "ride-post-s9__footer");
  const skipBtn = el("button", "ride-post-s9__skip", "Skip");
  skipBtn.type = "button";
  const submitBtn = el("button", "ride-post-s9__submit", "Submit");
  submitBtn.type = "button";
  footer.append(skipBtn, submitBtn);

  root.append(panesWrap, statusEl, footer);

  if (!gates.scooter && !gates.navigation) {
    root.append(
      el(
        "p",
        "ride-modal__hint",
        "Nothing to survey for this ride — Skip continues on.",
      ),
    );
  }

  function renderLeft(): void {
    leftSlot.replaceChildren();
    if (!gates.scooter) return;
    const pane = el("div", "ride-post-s9__pane ride-post-s9__pane--scooter");
    pane.append(
      el(
        "h4",
        "ride-post-s9__pane-title",
        `Scooter Feedback (+${points.surveyPoints} pts)`,
      ),
    );
    pane.append(
      yesNoField(
        "Would you ride this device again?",
        state.wouldRideAgain,
        (v) => {
          state.wouldRideAgain = v;
          renderLeft();
        },
      ),
    );
    pane.append(
      yesNoField("Was it absolutely perfect?", state.wasPerfect, (v) => {
        state.wasPerfect = v;
        if (v) state.issues = [];
        renderLeft();
      }),
    );
    if (state.wasPerfect === false) {
      pane.append(issuesField());
    }
    const question = modelBonusQuestionFor(model);
    if (question) pane.append(modelBonusField(question));
    leftSlot.append(pane);
  }

  function issuesField(): HTMLElement {
    const wrap = el("div", "ride-post-s9__field");
    wrap.append(el("p", "ride-post-s9__question", "What wasn't? (choose any)"));
    const list = el("ul", "ride-options ride-post-s9__issues");
    for (const opt of SURVEY_ISSUE_OPTIONS) {
      const li = el("li");
      const btn = el("button", "ride-option", opt.label);
      btn.type = "button";
      const selected = state.issues.includes(opt.token);
      btn.classList.toggle("is-selected", selected);
      btn.setAttribute("aria-pressed", String(selected));
      btn.addEventListener("click", () => {
        state.issues = selected
          ? state.issues.filter((t) => t !== opt.token)
          : [...state.issues, opt.token];
        renderLeft();
      });
      li.append(btn);
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  function modelBonusField(q: ModelBonusQuestion): HTMLElement {
    const wrap = el("div", "ride-post-s9__field ride-post-s9__field--bonus");
    wrap.append(el("p", "ride-post-s9__question", q.prompt));
    if (q.kind === "yesno") {
      const group = el("div", "segmented ride-post-s9__choice");
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", q.prompt);
      group.append(
        makeSegBtn("Yes", state.modelBonusYesNo === true, () => {
          state.modelBonusYesNo = true;
          renderLeft();
        }),
        makeSegBtn("No", state.modelBonusYesNo === false, () => {
          state.modelBonusYesNo = false;
          renderLeft();
        }),
      );
      wrap.append(group);
    } else {
      const input = el("input") as HTMLInputElement;
      input.type = "number";
      input.inputMode = "decimal";
      input.min = String(q.min ?? 0);
      input.max = String(q.max ?? 40);
      input.setAttribute("aria-label", q.prompt);
      if (state.modelBonusNumeric !== null) {
        input.value = String(state.modelBonusNumeric);
      }
      input.addEventListener("change", () => {
        const n = Number(input.value);
        const lo = q.min ?? 0;
        const hi = q.max ?? 40;
        if (!Number.isFinite(n) || input.value.trim() === "") {
          state.modelBonusNumeric = null;
          return;
        }
        state.modelBonusNumeric = Math.min(Math.max(n, lo), hi);
        input.value = String(state.modelBonusNumeric);
      });
      wrap.append(input);
    }
    return wrap;
  }

  function renderRight(): void {
    rightSlot.replaceChildren();
    if (!gates.navigation) return;
    const pane = el("div", "ride-post-s9__pane ride-post-s9__pane--nav");
    const upToPts = points.navRouteFeedback + points.navQualitativeFeedback;
    pane.append(
      el(
        "h4",
        "ride-post-s9__pane-title",
        `Navigation Feedback (up to ${upToPts} pts + distance bonus)`,
      ),
    );
    const routeLabel = routeProfile ? routeProfileLabel(routeProfile) : "route";
    pane.append(
      scaleField(
        `How was the ${routeLabel}?`,
        1,
        10,
        state.navRouteRating,
        (v) => {
          state.navRouteRating = v;
          renderRight();
        },
      ),
    );
    pane.append(
      yesNoField(
        "Did you deviate from the proposed routing?",
        state.navDeviated,
        (v) => {
          state.navDeviated = v;
          if (!v) state.navDeviatedNeedsImprovement = null;
          renderRight();
        },
      ),
    );
    if (state.navDeviated === true) {
      pane.append(
        yesNoField(
          "Was that because the routing needs improvement?",
          state.navDeviatedNeedsImprovement,
          (v) => {
            state.navDeviatedNeedsImprovement = v;
            renderRight();
          },
        ),
      );
    }
    pane.append(
      scaleField(
        `How likely are you to recommend navigating via Scooter.fyi to other ${RIDE_PROVIDER_NAME} users?`,
        0,
        10,
        state.navNps,
        (v) => {
          state.navNps = v;
          renderRight();
        },
      ),
    );
    pane.append(qualitativeField());
    rightSlot.append(pane);
  }

  function qualitativeField(): HTMLElement {
    const wrap = el("div", "ride-post-s9__field");
    wrap.append(
      el(
        "p",
        "ride-post-s9__question",
        "Anything else you'd like to tell us about the route?",
      ),
    );
    const textarea = el("textarea", "ride-post-s9__qualitative") as HTMLTextAreaElement;
    textarea.rows = 4;
    textarea.maxLength = 2000;
    textarea.value = state.navQualitative;
    textarea.setAttribute("aria-label", "Qualitative navigation feedback");
    const hint = el("p", "ride-post-s9__char-hint ride-modal__hint");
    hint.setAttribute("aria-live", "polite");
    function syncHint(): void {
      hint.textContent = describeQualitativeProgress(
        state.navQualitative,
        points.navQualitativeFeedback,
      ).message;
    }
    textarea.addEventListener("input", () => {
      state.navQualitative = textarea.value;
      syncHint();
    });
    syncHint();
    wrap.append(textarea, hint);
    return wrap;
  }

  function setStatus(msg: string | null): void {
    statusEl.hidden = !msg;
    statusEl.textContent = msg ?? "";
  }

  function setBusy(busy: boolean): void {
    submitting = busy;
    skipBtn.disabled = busy;
    submitBtn.disabled = busy;
  }

  function finish(facts: RideGateFacts): void {
    const transition = deps.session.dispatch({ type: "surveyDone", facts });
    if (!transition || !transition.accepted) {
      console.error(
        "ride-post-s9: surveyDone was rejected",
        transition?.rejected,
      );
    }
  }

  async function handleSkip(): Promise<void> {
    if (submitting || destroyed) return;
    setBusy(true);
    try {
      const facts = await Promise.resolve(deps.getGateFacts());
      if (destroyed) return;
      finish(facts);
      deps.onSkipped?.();
    } finally {
      if (!destroyed) setBusy(false);
    }
  }

  async function handleSubmit(): Promise<void> {
    if (submitting || destroyed) return;
    const current = deps.session.current();
    if (!current || !current.rideId) {
      setStatus("No active ride to submit a survey for — try Skip instead.");
      return;
    }
    setBusy(true);
    setStatus("Submitting…");
    try {
      const payload = buildSurveyPayload(state, gates, {
        model,
        rideRouteId,
      });
      const post = deps.postSurvey ?? apiPostSurvey;
      const response = await post(current.rideId, payload);
      if (destroyed) return;
      const facts = await Promise.resolve(deps.getGateFacts());
      if (destroyed) return;
      finish(facts);
      setStatus(null);
      deps.onSubmitted?.(response);
    } catch (err) {
      if (destroyed) return;
      setStatus(describeSurveySubmitError(err));
      setBusy(false);
    }
  }

  skipBtn.addEventListener("click", () => {
    void handleSkip();
  });
  submitBtn.addEventListener("click", () => {
    void handleSubmit();
  });

  renderLeft();
  renderRight();

  return {
    title: "Surveys",
    primary: root,
    destroy() {
      destroyed = true;
    },
  };
}

/** Friendly copy for a failed `postSurvey` call — same discipline as
 *  `ride-settings.ts`'s `describeRideUsualsError`. */
export function describeSurveySubmitError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) {
      return "This ride's survey was already submitted.";
    }
    if (e.status === 422) {
      return "That ride isn't ended yet — finish Screen 8 first.";
    }
  }
  return "Couldn't submit right now — try again, or Skip.";
}
