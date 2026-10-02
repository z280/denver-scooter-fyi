// @vitest-environment happy-dom
//
// Screen 9 — dual survey panes. Covers: pane gating (master Risk 16) across
// all four end_survey x route combinations including the spec-corrected
// "route selected but not yet persisted" case and the both-off skip; the
// 16-item issue vocabulary's display<->API-token round trip; per-model bonus
// question selection (COSMO/APOLLO/ASTRO, case-insensitive, unknown → none);
// the deviated/needs-improvement conditional reveal; the qualitative
// character-count hint at the 19/20-char boundary (a hint, never a block);
// Skip vs Submit both driving the real `ride-session.ts` reducer to the
// correct next phase; and the full `postSurvey` payload shape.
import { describe, expect, it, vi } from "vitest";

import { ApiError, type RideOptions, type RideSurveyResponse } from "./api.ts";
import {
  blankRideSession,
  createRideSessionStore,
  memoryRideSessionStorage,
  type RideSessionDevice,
  type RideSessionDoc,
  type RideSessionRoute,
  type RideSessionStore,
} from "./ride-session.ts";
import { RIDE_PROVIDER_NAME } from "./ride-settings.ts";
import {
  MODEL_BONUS_QUESTIONS,
  NAV_QUALITATIVE_MIN_CHARS,
  SURVEY_ISSUE_OPTIONS,
  blankSurveyFormState,
  buildRidePostS9Screen,
  buildRouteFeedbackPayload,
  buildSurveyPayload,
  describeQualitativeProgress,
  hasNavAnswers,
  issueLabel,
  issueToken,
  modelBonusQuestionFor,
  normalizeModelKey,
  routeProfileLabel,
  scooterRatingToFlags,
  shouldShowRidePostS9,
  type RidePostS9Deps,
  type SessionLike,
} from "./ride-post-s9.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function baseOptions(overrides: Partial<RideOptions> = {}): RideOptions {
  return {
    cost_hud: true,
    speedometer: "classic",
    theme: "auto",
    navigation: false,
    save_tracks: true,
    battery_modeling: false,
    nav_improvement: false,
    end_survey: false,
    own_device: false,
    ...overrides,
  };
}

const ROUTE: RideSessionRoute = {
  profile: "safe",
  rideRouteId: "rr-1",
  distanceM: 1200,
  durationS: 400,
  polyline: "xyz",
  maneuvers: [],
};

/** A doc parked directly in `survey(9)` for the pure pane-gating / rendering
 *  matrix — built by hand (not via the reducer) since only the doc's static
 *  shape matters for these assertions. */
function makeDoc(overrides: {
  endSurvey: boolean;
  route: RideSessionRoute | null;
  device?: RideSessionDevice | null;
}): RideSessionDoc {
  const doc = blankRideSession(baseOptions({ end_survey: overrides.endSurvey }));
  return {
    ...doc,
    state: "survey",
    screen: "9",
    rideId: "ride-1",
    private: false,
    device: overrides.device ?? null,
    route: overrides.route,
  };
}

function stubSession(doc: RideSessionDoc): SessionLike {
  return {
    current: () => doc,
    dispatch: () => null,
  };
}

/** Drives the REAL `ride-session.ts` reducer from a fresh session all the way
 *  to `survey(9)`, exactly the path Screens 1→2→…→8 walk in production —
 *  `wireRideModal → open → setDevice → setRoute → goto(6) → rideStarted →
 *  endRide → endReported`, so the Skip/Submit tests exercise this module's
 *  ACTUAL dispatch surface, not a mocked-out transition table. */
function driveToSurvey(opts: {
  options: RideOptions;
  device?: RideSessionDevice | null;
  route?: RideSessionRoute | null;
  rideId?: string;
}): RideSessionStore {
  const store = createRideSessionStore({ storage: memoryRideSessionStorage() });
  store.dispatch({ type: "open", options: opts.options, screen: "1" });
  if (opts.device) store.dispatch({ type: "setDevice", device: opts.device });
  if (opts.route) store.dispatch({ type: "setRoute", route: opts.route });
  store.dispatch({ type: "goto", screen: "6" });
  store.dispatch({
    type: "rideStarted",
    rideId: opts.rideId ?? "ride-1",
    startedAtMs: Date.now(),
    trackKeyId: opts.rideId ?? "ride-1",
    private: false,
  });
  store.dispatch({ type: "endRide" });
  store.dispatch({ type: "endReported", facts: { hasWaypoints: false } });
  return store;
}

/** Let a screen's internal promise chain (postSurvey → getGateFacts →
 *  dispatch) settle after a simulated click, same pattern as
 *  `ride-deeplink.test.ts`'s `flush()`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fieldByQuestion(root: HTMLElement, question: string): HTMLElement {
  const fields = Array.from(
    root.querySelectorAll<HTMLElement>(".ride-post-s9__field"),
  );
  const match = fields.find(
    (f) => f.querySelector(".ride-post-s9__question")?.textContent === question,
  );
  if (!match) throw new Error(`field not found: "${question}"`);
  return match;
}

function findFieldOrNull(root: HTMLElement, question: string): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>(".ride-post-s9__field")).find(
      (f) => f.querySelector(".ride-post-s9__question")?.textContent === question,
    ) ?? null
  );
}

function segBtn(field: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(field.querySelectorAll<HTMLButtonElement>(".seg-btn")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`button "${label}" not found in field: ${field.textContent}`);
  return btn;
}

function clickYesNo(root: HTMLElement, question: string, label: "Yes" | "No"): void {
  segBtn(fieldByQuestion(root, question), label).click();
}

/** Press one of the five faces (step 1-5, low to high) on an emoji scale. */
function clickEmoji(root: HTMLElement, question: string, step: number): void {
  const btn = fieldByQuestion(root, question).querySelector<HTMLButtonElement>(
    `.emoji-scale__btn[data-step="${step}"]`,
  );
  if (!btn) throw new Error(`emoji step ${step} not found in field: "${question}"`);
  btn.click();
}

function clickIssue(root: HTMLElement, label: string): void {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>(".ride-option")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`issue option not found: "${label}"`);
  btn.click();
}

function setNumberInput(root: HTMLElement, question: string, value: string): void {
  const input = fieldByQuestion(root, question).querySelector<HTMLInputElement>(
    "input[type=number]",
  );
  if (!input) throw new Error(`number input not found in field: "${question}"`);
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setQualitative(root: HTMLElement, text: string): void {
  // The box is collapsed behind one line until asked for — a four-row textarea
  // standing open reads as a field that must be filled in, and on a phone it
  // pushes Submit off the screen.
  if (!root.querySelector(".ride-post-s9__qualitative")) {
    const open = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".ride-post-s9__disclosure"),
    ).find((b) => b.textContent?.includes("note about the route"));
    open?.click();
  }
  const textarea = root.querySelector<HTMLTextAreaElement>(".ride-post-s9__qualitative");
  if (!textarea) throw new Error("qualitative textarea not found");
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function baseDeps(session: SessionLike, extra: Partial<RidePostS9Deps> = {}): RidePostS9Deps {
  return {
    session,
    getGateFacts: () => ({ hasWaypoints: false }),
    // The recommendation question is on a cadence (`survey-cadence.ts`): first
    // survey, then every tenth. Pinned ON here and counted nowhere, so these
    // cases exercise the full pane without reading or writing `localStorage`;
    // the cadence itself has its own tests below.
    askNps: true,
    recordSubmitted: () => {},
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Pane gating (master Risk 16)
// ---------------------------------------------------------------------------

describe("Screen 9 pane gating", () => {
  it("end_survey ON + route present: both panes render", () => {
    const doc = makeDoc({ endSurvey: true, route: ROUTE });
    expect(shouldShowRidePostS9(doc)).toBe(true);
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    expect(screen.primary.querySelector(".ride-post-s9__pane--scooter")).not.toBeNull();
    expect(screen.primary.querySelector(".ride-post-s9__pane--nav")).not.toBeNull();
  });

  it("end_survey ON + no route: only the scooter pane renders", () => {
    const doc = makeDoc({ endSurvey: true, route: null });
    expect(shouldShowRidePostS9(doc)).toBe(true);
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    expect(screen.primary.querySelector(".ride-post-s9__pane--scooter")).not.toBeNull();
    expect(screen.primary.querySelector(".ride-post-s9__pane--nav")).toBeNull();
  });

  it("end_survey OFF + route present: only the navigation pane renders", () => {
    const doc = makeDoc({ endSurvey: false, route: ROUTE });
    expect(shouldShowRidePostS9(doc)).toBe(true);
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    expect(screen.primary.querySelector(".ride-post-s9__pane--scooter")).toBeNull();
    expect(screen.primary.querySelector(".ride-post-s9__pane--nav")).not.toBeNull();
  });

  it("end_survey OFF + no route: shouldShowRidePostS9 is false — the host must skip Screen 9 entirely", () => {
    const doc = makeDoc({ endSurvey: false, route: null });
    expect(shouldShowRidePostS9(doc)).toBe(false);
  });

  it("a private ride keeps the nav pane (never the scooter pane)", () => {
    // A private ride has no tracked ride to survey, but the rider still
    // rode the chosen route — the nav pane stays up and submits to
    // POST /route-feedback instead. Without a route there is nothing to
    // ask about at all, so Screen 9 is skipped entirely.
    const doc = { ...makeDoc({ endSurvey: true, route: ROUTE }), private: true };
    expect(shouldShowRidePostS9(doc)).toBe(true);
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    expect(screen.primary.querySelector(".ride-post-s9__pane--scooter")).toBeNull();
    expect(screen.primary.querySelector(".ride-post-s9__pane--nav")).not.toBeNull();
    const routeless = {
      ...makeDoc({ endSurvey: true, route: null }),
      private: true,
    };
    expect(shouldShowRidePostS9(routeless)).toBe(false);
  });

  it("spec correction: the nav pane gates on `route !== null`, not on `rideRouteId !== null` — an unpersisted route (A3 404-tolerated, or nav_improvement off) still renders the pane", () => {
    const unpersisted: RideSessionRoute = { ...ROUTE, rideRouteId: null };
    const doc = makeDoc({ endSurvey: false, route: unpersisted });
    expect(shouldShowRidePostS9(doc)).toBe(true);
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    expect(screen.primary.querySelector(".ride-post-s9__pane--nav")).not.toBeNull();
  });

  it("a defensive build with both gates off never crashes and stays closable", () => {
    const doc = makeDoc({ endSurvey: false, route: null });
    expect(() => buildRidePostS9Screen(baseDeps(stubSession(doc)))).not.toThrow();
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    expect(screen.primary.querySelector(".ride-post-s9__skip")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The 16-item issue vocabulary
// ---------------------------------------------------------------------------

describe("the 16-item issue vocabulary", () => {
  it("has exactly 16 entries", () => {
    expect(SURVEY_ISSUE_OPTIONS).toHaveLength(16);
  });

  it("matches the API's exact SurveyIssue token set", () => {
    const tokens = [...SURVEY_ISSUE_OPTIONS.map((o) => o.token)].sort();
    expect(tokens).toEqual(
      [
        "app_veo",
        "acceleration",
        "basket",
        "battery",
        "bell",
        "brakes",
        "connectivity",
        "customer_service",
        "dirty",
        "kickstand",
        "pedals",
        "phone_holder",
        "price",
        "speedometer",
        "scooterfyi_issue",
        "vandalized",
      ].sort(),
    );
  });

  it("matches the owner's exact display copy, in order", () => {
    expect(SURVEY_ISSUE_OPTIONS.map((o) => o.label)).toEqual([
      "App (Veo)",
      "Acceleration",
      "Basket",
      "Battery",
      "Bell",
      "Brakes",
      "Connectivity",
      "Customer Service Experience",
      "Dirty device",
      "Kickstand",
      "Pedals",
      "Phone Holder",
      "Price",
      "Speedometer",
      "Scooter.fyi issue",
      "Vandalized",
    ]);
  });

  it("round-trips every item both directions", () => {
    for (const opt of SURVEY_ISSUE_OPTIONS) {
      expect(issueToken(opt.label)).toBe(opt.token);
      expect(issueLabel(opt.token)).toBe(opt.label);
    }
  });

  it("issueToken returns null for an unknown label", () => {
    expect(issueToken("Not A Real Issue")).toBeNull();
  });

  it("issueLabel falls back to the raw token for an unrecognized future value", () => {
    expect(issueLabel("mystery_future_token" as never)).toBe("mystery_future_token");
  });
});

// ---------------------------------------------------------------------------
// Per-model bonus question selection
// ---------------------------------------------------------------------------

describe("per-model bonus question selection", () => {
  it.each([
    ["cosmo", "cosmo_front_basket", "yesno"],
    ["Cosmo", "cosmo_front_basket", "yesno"],
    ["COSMO", "cosmo_front_basket", "yesno"],
    ["apollo", "apollo_top_speed_mph", "numeric"],
    ["APOLLO", "apollo_top_speed_mph", "numeric"],
    ["astro", "astro_landscape_holder", "yesno"],
    [" Astro ", "astro_landscape_holder", "yesno"],
  ] as const)("model %s selects %s (%s)", (model, apiField, kind) => {
    const q = modelBonusQuestionFor(model);
    expect(q?.apiField).toBe(apiField);
    expect(q?.kind).toBe(kind);
  });

  it("an unrecognized model shows no bonus question", () => {
    expect(modelBonusQuestionFor("Vespa")).toBeNull();
    expect(modelBonusQuestionFor("scooter-9000")).toBeNull();
  });

  it("no model on file shows no bonus question", () => {
    expect(modelBonusQuestionFor(null)).toBeNull();
    expect(modelBonusQuestionFor(undefined)).toBeNull();
    expect(modelBonusQuestionFor("")).toBeNull();
  });

  it("normalizeModelKey agrees with modelBonusQuestionFor's gate", () => {
    for (const key of Object.keys(MODEL_BONUS_QUESTIONS) as (keyof typeof MODEL_BONUS_QUESTIONS)[]) {
      expect(normalizeModelKey(key.toUpperCase())).toBe(key);
    }
    expect(normalizeModelKey("vespa")).toBeNull();
  });

  it("the Apollo question renders NO bonus question when the device model is unknown, in the built screen", () => {
    const doc = makeDoc({ endSurvey: true, route: null, device: null });
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    expect(screen.primary.textContent).not.toContain("top speed");
    expect(screen.primary.textContent).not.toContain("front basket");
    expect(screen.primary.textContent).not.toContain("landscape phone holder");
  });

  it("renders the matching bonus question for a Cosmo device", () => {
    const doc = makeDoc({
      endSurvey: true,
      route: null,
      device: { vehicleIdentifier: "a".repeat(16), plate: null, model: "cosmo", batteryConfirmed: 50 },
    });
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    expect(findFieldOrNull(screen.primary, "Does it have a front basket?")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nav_deviated_needs_improvement conditional reveal
// ---------------------------------------------------------------------------

describe("the deviated/needs-improvement conditional reveal", () => {
  const NEEDS_IMPROVEMENT_Q = "Was that because the routing needs improvement?";

  it("stays hidden until deviated=Yes, and disappears again on deviated=No", () => {
    const doc = makeDoc({ endSurvey: false, route: ROUTE });
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    const root = screen.primary;

    expect(findFieldOrNull(root, NEEDS_IMPROVEMENT_Q)).toBeNull();

    clickYesNo(root, "Did you deviate from the proposed routing?", "Yes");
    expect(findFieldOrNull(root, NEEDS_IMPROVEMENT_Q)).not.toBeNull();

    clickYesNo(root, "Did you deviate from the proposed routing?", "No");
    expect(findFieldOrNull(root, NEEDS_IMPROVEMENT_Q)).toBeNull();
  });

  it("an answered needs-improvement value is cleared from the SUBMITTED payload once deviated flips back to No", async () => {
    const store = driveToSurvey({ options: baseOptions({ end_survey: false, navigation: true }), route: ROUTE });
    const fakePost = vi.fn().mockResolvedValue({ points: [] } as RideSurveyResponse);
    const screen = buildRidePostS9Screen(baseDeps(store, { postSurvey: fakePost }));
    const root = screen.primary;

    clickYesNo(root, "Did you deviate from the proposed routing?", "Yes");
    clickYesNo(root, NEEDS_IMPROVEMENT_Q, "Yes");
    // Flipping back to No hides AND clears the follow-up question — a stale
    // "Yes" must never survive to the submitted payload.
    clickYesNo(root, "Did you deviate from the proposed routing?", "No");

    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();

    expect(fakePost).toHaveBeenCalledOnce();
    const [, payload] = fakePost.mock.calls[0]!;
    expect(payload.nav_deviated).toBe(false);
    expect(payload.nav_deviated_needs_improvement).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Qualitative character-count hint — a HINT, never a hard block.
// ---------------------------------------------------------------------------

describe("qualitative character-count hint", () => {
  it(`at ${NAV_QUALITATIVE_MIN_CHARS - 1} chars: not yet earned, 1 remaining`, () => {
    const progress = describeQualitativeProgress("a".repeat(NAV_QUALITATIVE_MIN_CHARS - 1));
    expect(progress.earned).toBe(false);
    expect(progress.remaining).toBe(1);
  });

  it(`at exactly ${NAV_QUALITATIVE_MIN_CHARS} chars: earned, 0 remaining`, () => {
    const progress = describeQualitativeProgress("a".repeat(NAV_QUALITATIVE_MIN_CHARS));
    expect(progress.earned).toBe(true);
    expect(progress.remaining).toBe(0);
  });

  it("counts trimmed length only — surrounding whitespace never counts", () => {
    const padded = `  ${"a".repeat(NAV_QUALITATIVE_MIN_CHARS)}   `;
    const progress = describeQualitativeProgress(padded);
    expect(progress.trimmedLength).toBe(NAV_QUALITATIVE_MIN_CHARS);
    expect(progress.earned).toBe(true);
  });

  it("updates live in the DOM as the rider types, and never disables Submit", () => {
    const doc = makeDoc({ endSurvey: false, route: ROUTE });
    const screen = buildRidePostS9Screen(baseDeps(stubSession(doc)));
    const root = screen.primary;
    const submitBtn = root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!;
    // Re-queried after each edit rather than captured: the box lives behind a
    // disclosure now, so the hint does not exist until the rider opens it.
    const hint = () => root.querySelector(".ride-post-s9__char-hint");

    setQualitative(root, "a".repeat(NAV_QUALITATIVE_MIN_CHARS - 1));
    expect(hint()?.textContent).toContain(
      `${NAV_QUALITATIVE_MIN_CHARS - 1}/${NAV_QUALITATIVE_MIN_CHARS}`,
    );
    expect(submitBtn.disabled).toBe(false);

    setQualitative(root, "a".repeat(NAV_QUALITATIVE_MIN_CHARS));
    expect(hint()?.textContent).not.toContain(`/${NAV_QUALITATIVE_MIN_CHARS}`);
    expect(submitBtn.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Skip vs Submit — both drive the REAL ride-session.ts reducer.
// ---------------------------------------------------------------------------

describe("Skip and Submit transitions", () => {
  it("Skip issues no API call, dispatches surveyDone, and lands on `done` with no waypoints", async () => {
    const store = driveToSurvey({ options: baseOptions({ end_survey: true }) });
    expect(store.current()?.state).toBe("survey");

    const fakePost = vi.fn();
    const onSkipped = vi.fn();
    const screen = buildRidePostS9Screen(
      baseDeps(store, { postSurvey: fakePost, onSkipped }),
    );
    screen.primary.querySelector<HTMLButtonElement>(".ride-post-s9__skip")!.click();
    await flush();

    expect(fakePost).not.toHaveBeenCalled();
    expect(store.current()?.state).toBe("done");
    expect(onSkipped).toHaveBeenCalledOnce();
  });

  it("Skip lands on `eligibility(10)` when waypoints were tracked", async () => {
    const store = driveToSurvey({ options: baseOptions({ end_survey: true }) });
    const screen = buildRidePostS9Screen(
      baseDeps(store, { getGateFacts: () => ({ hasWaypoints: true }) }),
    );
    screen.primary.querySelector<HTMLButtonElement>(".ride-post-s9__skip")!.click();
    await flush();

    expect(store.current()?.state).toBe("eligibility");
  });

  it("Submit posts the survey, then transitions the SAME way Skip would", async () => {
    const store = driveToSurvey({ options: baseOptions({ end_survey: true }) });
    const response: RideSurveyResponse = { points: [{ action: "ride_survey", points: 4 }] };
    const fakePost = vi.fn().mockResolvedValue(response);
    const onSubmitted = vi.fn();
    const screen = buildRidePostS9Screen(
      baseDeps(store, {
        postSurvey: fakePost,
        onSubmitted,
        getGateFacts: () => ({ hasWaypoints: true }),
      }),
    );
    screen.primary.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();

    expect(fakePost).toHaveBeenCalledOnce();
    expect(store.current()?.state).toBe("eligibility");
    expect(onSubmitted).toHaveBeenCalledWith(response);
  });

  it("a failed Submit shows an inline error, does NOT transition, and re-enables the buttons for a retry or Skip", async () => {
    const store = driveToSurvey({ options: baseOptions({ end_survey: true }) });
    const fakePost = vi.fn().mockRejectedValue(new ApiError("boom", "HTTP_ERROR", { status: 500 }));
    const screen = buildRidePostS9Screen(baseDeps(store, { postSurvey: fakePost }));
    const root = screen.primary;
    const submitBtn = root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!;
    const skipBtn = root.querySelector<HTMLButtonElement>(".ride-post-s9__skip")!;

    submitBtn.click();
    await flush();

    expect(store.current()?.state).toBe("survey");
    expect(submitBtn.disabled).toBe(false);
    expect(skipBtn.disabled).toBe(false);
    const status = root.querySelector('[role="status"]') as HTMLElement;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/couldn't submit/i);
  });

  it("Submit with no active ride shows an error without calling the API", async () => {
    const doc = makeDoc({ endSurvey: true, route: null });
    const fakePost = vi.fn();
    const noRideDoc = { ...doc, rideId: null };
    const screen = buildRidePostS9Screen(
      baseDeps(stubSession(noRideDoc), { postSurvey: fakePost }),
    );
    screen.primary.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    expect(fakePost).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Full submission payload shape
// ---------------------------------------------------------------------------

describe("the postSurvey payload for a full submission", () => {
  it("carries every field, mapped and gated correctly", async () => {
    const store = driveToSurvey({
      options: baseOptions({ end_survey: true, navigation: true }),
      device: {
        vehicleIdentifier: "a".repeat(16),
        plate: null,
        model: "apollo",
        batteryConfirmed: 80,
      },
      route: ROUTE,
    });

    const response: RideSurveyResponse = { points: [] };
    const fakePost = vi.fn().mockResolvedValue(response);
    const screen = buildRidePostS9Screen(baseDeps(store, { postSurvey: fakePost }));
    const root = screen.primary;

    // One face replaces the old two yes/no questions — "Good" means they
    // would ride it again and that it was not absolutely perfect, which is
    // exactly the pair the API stores (`scooterRatingToFlags`).
    clickEmoji(root, "How was this scooter?", 4);
    // "Good" does not open the sixteen-item checklist by itself; the rider
    // asks for it.
    root
      .querySelector<HTMLButtonElement>(".ride-post-s9__disclosure")!
      .click();
    clickIssue(root, "Basket");
    clickIssue(root, "Battery");
    setNumberInput(root, "What was your top speed?", "23");

    const routeQuestion = `How was the ${routeProfileLabel(ROUTE.profile)}?`;
    clickEmoji(root, routeQuestion, 4); // 🙂 -> the API's 8
    clickYesNo(root, "Did you deviate from the proposed routing?", "Yes");
    clickYesNo(root, "Was that because the routing needs improvement?", "Yes");
    clickEmoji(
      root,
      `Would you recommend navigating via Scooter.fyi to other ${RIDE_PROVIDER_NAME} riders?`,
      5, // 😍 -> the API's 10, the only face inside NPS's promoter band
    );
    const qualitativeText = "The bike lane on Colfax was excellent and well protected.";
    setQualitative(root, qualitativeText);

    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();

    expect(fakePost).toHaveBeenCalledTimes(1);
    const [rideId, payload] = fakePost.mock.calls[0]!;
    expect(rideId).toBe("ride-1");
    expect(payload).toEqual({
      would_ride_again: true,
      was_perfect: false,
      issues: ["basket", "battery"],
      model_bonus: { apollo_top_speed_mph: 23 },
      nav_route_rating: 8,
      nav_deviated: true,
      nav_deviated_needs_improvement: true,
      nav_nps: 10,
      nav_qualitative: qualitativeText,
      ride_route_id: "rr-1",
    });
  });

  it("omits issues when 'was it perfect' is Yes, even if issues were picked earlier", () => {
    const payload = buildSurveyPayload(
      { ...blankSurveyFormState(), wasPerfect: true, issues: ["basket"] },
      { scooter: true, navigation: false },
      { model: null, rideRouteId: null },
    );
    expect(payload.issues).toBeUndefined();
  });

  it("omits model_bonus entirely when the question was never answered", () => {
    const payload = buildSurveyPayload(
      blankSurveyFormState(),
      { scooter: true, navigation: false },
      { model: "cosmo", rideRouteId: null },
    );
    expect(payload.model_bonus).toBeUndefined();
  });

  it("omits ride_route_id when the route was never persisted server-side", () => {
    const payload = buildSurveyPayload(
      blankSurveyFormState(),
      { scooter: false, navigation: true },
      { model: null, rideRouteId: null },
    );
    expect(payload.ride_route_id).toBeUndefined();
  });

  it("sends nav_qualitative trimmed, or null when empty", () => {
    const withText = buildSurveyPayload(
      { ...blankSurveyFormState(), navQualitative: "  hello there general  " },
      { scooter: false, navigation: true },
      { model: null, rideRouteId: null },
    );
    expect(withText.nav_qualitative).toBe("hello there general");

    const empty = buildSurveyPayload(
      { ...blankSurveyFormState(), navQualitative: "   " },
      { scooter: false, navigation: true },
      { model: null, rideRouteId: null },
    );
    expect(empty.nav_qualitative).toBeNull();
  });

  it("sends nothing from a gated-off pane regardless of stray form state", () => {
    const dirtyState = {
      ...blankSurveyFormState(),
      wouldRideAgain: true,
      wasPerfect: false,
      issues: ["battery"] as const,
      navRouteRating: 9,
      navQualitative: "x".repeat(30),
    };
    const scooterOnly = buildSurveyPayload(
      dirtyState,
      { scooter: true, navigation: false },
      { model: null, rideRouteId: "rr-9" },
    );
    expect(scooterOnly.nav_route_rating).toBeUndefined();
    expect(scooterOnly.nav_qualitative).toBeUndefined();
    expect(scooterOnly.ride_route_id).toBeUndefined();

    const navOnly = buildSurveyPayload(
      dirtyState,
      { scooter: false, navigation: true },
      { model: null, rideRouteId: "rr-9" },
    );
    expect(navOnly.would_ride_again).toBeUndefined();
    expect(navOnly.was_perfect).toBeUndefined();
    expect(navOnly.issues).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// route profile labels
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The private-ride path — "My own Device" / guest route feedback
// ---------------------------------------------------------------------------

describe("route feedback from a private ride", () => {
  function privateDoc(route: RideSessionRoute | null = ROUTE): RideSessionDoc {
    return {
      ...makeDoc({ endSurvey: true, route }),
      private: true,
      rideId: null,
    };
  }

  it("promises no points anywhere on the pane", () => {
    const screen = buildRidePostS9Screen(baseDeps(stubSession(privateDoc())));
    const title = screen.primary.querySelector(".ride-post-s9__pane-title")!;
    expect(title.textContent).toBe("Navigation Feedback");
    expect(title.textContent).not.toContain("pts");
    // The qualitative coaching hint exists to chase a bonus that will not be
    // paid here, so it stays empty — and the collapsed line that offers the box
    // must not promise the points either.
    const noteLine = Array.from(
      screen.primary.querySelectorAll<HTMLButtonElement>(".ride-post-s9__disclosure"),
    ).find((b) => b.textContent?.includes("note about the route"))!;
    expect(noteLine.textContent).not.toContain("pts");
    noteLine.click();
    expect(
      screen.primary.querySelector(".ride-post-s9__char-hint")?.textContent,
    ).toBe("");
  });

  it("submits the nav answers to POST /route-feedback with the route inline", async () => {
    const postRouteFeedback = vi
      .fn()
      .mockResolvedValue({ id: 1, created_at: "2026-08-10T00:00:00Z" });
    const postSurvey = vi.fn();
    const dispatch = vi.fn().mockReturnValue({ accepted: true });
    const session: SessionLike = { current: () => privateDoc(), dispatch };
    const onSubmitted = vi.fn();
    const screen = buildRidePostS9Screen(
      baseDeps(session, { postRouteFeedback, postSurvey, onSubmitted }),
    );
    clickEmoji(screen.primary, `How was the ${routeProfileLabel(ROUTE.profile)}?`, 4);
    clickYesNo(screen.primary, "Did you deviate from the proposed routing?", "No");
    screen.primary.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();

    expect(postSurvey).not.toHaveBeenCalled();
    expect(postRouteFeedback).toHaveBeenCalledExactlyOnceWith({
      route_profile: ROUTE.profile,
      distance_m: ROUTE.distanceM,
      duration_s: ROUTE.durationS,
      nav_route_rating: 8,
      nav_deviated: false,
      nav_deviated_needs_improvement: null,
      nav_nps: null,
      nav_qualitative: null,
    });
    // The screen still finishes the ride session like any survey…
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "surveyDone" }),
    );
    // …and echoes an honest empty award list.
    expect(onSubmitted).toHaveBeenCalledWith({ points: [] });
  });

  it("nudges instead of posting an empty body", async () => {
    const postRouteFeedback = vi.fn();
    const screen = buildRidePostS9Screen(
      baseDeps(stubSession(privateDoc()), { postRouteFeedback }),
    );
    screen.primary.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    expect(postRouteFeedback).not.toHaveBeenCalled();
    expect(screen.primary.textContent).toContain("answer a question, or Skip");
  });
});

describe("buildRouteFeedbackPayload", () => {
  const route = { profile: "shade", distanceM: 3200.5, durationS: 840 };

  it("drops the follow-up with a non-Yes deviation and nulls blank text", () => {
    const state = blankSurveyFormState();
    state.navDeviated = false;
    state.navDeviatedNeedsImprovement = true; // stale — must not survive
    state.navQualitative = "   ";
    const body = buildRouteFeedbackPayload(state, route);
    expect(body.nav_deviated_needs_improvement).toBeNull();
    expect(body.nav_qualitative).toBeNull();
    expect(body.route_profile).toBe("shade");
  });

  it("hasNavAnswers counts only substantive answers", () => {
    const state = blankSurveyFormState();
    expect(hasNavAnswers(state)).toBe(false);
    state.navQualitative = "   ";
    expect(hasNavAnswers(state)).toBe(false);
    state.navNps = 7;
    expect(hasNavAnswers(state)).toBe(true);
  });
});

describe("routeProfileLabel", () => {
  it("maps the four deployed Valhalla profiles to the owner's copy", () => {
    expect(routeProfileLabel("safe")).toBe("Safe & Protected");
    expect(routeProfileLabel("range")).toBe("The Range Maximizer");
    expect(routeProfileLabel("shade")).toBe("The Shaded Canopy");
    expect(routeProfileLabel("express")).toBe("Commuter Express");
  });

  it("renders an unrecognized future profile key verbatim rather than throwing", () => {
    expect(routeProfileLabel("mystery")).toBe("mystery");
  });
});

// ---------------------------------------------------------------------------
// The trim. What the survey used to ask after every single ride:
//
//   "Would you ride this device again?"  (yes/no)
//   "Was it absolutely perfect?"         (yes/no)
//   sixteen issue chips                  (whenever the answer was no)
//   a per-model bonus question
//   "How was the <route>?"               (ten buttons)
//   "Did you deviate?"                   (yes/no)
//   "...because the routing needs improvement?" (yes/no)
//   "How likely are you to recommend..." (ELEVEN buttons)
//   a four-row textarea, standing open
//
// Every one of those on screen at once, at the end of a ride, having already
// typed a battery percentage and a cost on the screen before. The first two
// questions are one opinion, the two long rows are untappable, the checklist is
// homework for a rider who liked the ride, and the recommendation question is
// about the product rather than the trip.
// ---------------------------------------------------------------------------

describe("the scooter rating replaces two yes/no questions", () => {
  it("derives both stored booleans from one face", () => {
    expect(scooterRatingToFlags(1)).toEqual({ wouldRideAgain: false, wasPerfect: false });
    expect(scooterRatingToFlags(2)).toEqual({ wouldRideAgain: false, wasPerfect: false });
    // "Okay" is a scooter you would get on again. "Poor" is not.
    expect(scooterRatingToFlags(3)).toEqual({ wouldRideAgain: true, wasPerfect: false });
    expect(scooterRatingToFlags(4)).toEqual({ wouldRideAgain: true, wasPerfect: false });
    // Only the top face is "absolutely perfect" — the issues checklist exists
    // for everything below it.
    expect(scooterRatingToFlags(5)).toEqual({ wouldRideAgain: true, wasPerfect: true });
  });

  it("answers nothing until the rider answers", () => {
    expect(scooterRatingToFlags(null)).toEqual({
      wouldRideAgain: null,
      wasPerfect: null,
    });
  });

  it("asks one question where there were two", () => {
    const doc = makeDoc({ endSurvey: true, route: null });
    const root = buildRidePostS9Screen(baseDeps(stubSession(doc))).primary;
    expect(findFieldOrNull(root, "How was this scooter?")).toBeTruthy();
    expect(findFieldOrNull(root, "Would you ride this device again?")).toBeNull();
    expect(findFieldOrNull(root, "Was it absolutely perfect?")).toBeNull();
  });

  it("submits the pair the API has always stored", async () => {
    const doc = makeDoc({ endSurvey: true, route: null });
    const postSurvey = vi.fn().mockResolvedValue({ points: [] });
    const root = buildRidePostS9Screen(
      baseDeps(stubSession(doc), { postSurvey }),
    ).primary;
    clickEmoji(root, "How was this scooter?", 5);
    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    expect(postSurvey.mock.calls[0]![1]).toMatchObject({
      would_ride_again: true,
      was_perfect: true,
    });
  });
});

describe("the issues checklist is a follow-up, not homework", () => {
  function leftPane(extra: Partial<RidePostS9Deps> = {}) {
    const doc = makeDoc({ endSurvey: true, route: null });
    return buildRidePostS9Screen(baseDeps(stubSession(doc), extra)).primary;
  }
  const issueChips = (root: HTMLElement) =>
    root.querySelectorAll(".ride-post-s9__issues .ride-option").length;
  const disclosure = (root: HTMLElement) =>
    Array.from(
      root.querySelectorAll<HTMLButtonElement>(".ride-post-s9__disclosure"),
    ).find((b) => b.textContent?.includes("Something was off"));

  it("shows nothing before the rider has rated the scooter", () => {
    const root = leftPane();
    expect(issueChips(root)).toBe(0);
    expect(disclosure(root)).toBeFalsy();
  });

  it("opens itself for a rider who said something went wrong", () => {
    for (const step of [1, 2, 3]) {
      const root = leftPane();
      clickEmoji(root, "How was this scooter?", step);
      expect(issueChips(root)).toBe(SURVEY_ISSUE_OPTIONS.length);
    }
  });

  it("offers one line instead, to a rider who liked the ride", () => {
    const root = leftPane();
    clickEmoji(root, "How was this scooter?", 4);
    expect(issueChips(root)).toBe(0);
    expect(disclosure(root)).toBeTruthy();
    disclosure(root)!.click();
    expect(issueChips(root)).toBe(SURVEY_ISSUE_OPTIONS.length);
  });

  it("is not offered at all on the top face — nothing was wrong", () => {
    const root = leftPane();
    clickEmoji(root, "How was this scooter?", 5);
    expect(issueChips(root)).toBe(0);
    expect(disclosure(root)).toBeFalsy();
  });

  it("drops ticked issues when the rider moves up to the top face", async () => {
    const postSurvey = vi.fn().mockResolvedValue({ points: [] });
    const root = leftPane({ postSurvey });
    clickEmoji(root, "How was this scooter?", 2);
    clickIssue(root, "Brakes");
    // Changing their mind to "nothing was wrong" must not submit a contradiction.
    clickEmoji(root, "How was this scooter?", 5);
    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    expect(postSurvey.mock.calls[0]![1].issues).toBeUndefined();
  });

  it("keeps a rider's ticked issues when they move between non-perfect faces", () => {
    const root = leftPane();
    clickEmoji(root, "How was this scooter?", 2);
    clickIssue(root, "Brakes");
    clickEmoji(root, "How was this scooter?", 4);
    // Still open, because they have something in it — moving UP must not throw
    // away an answer, and must not force the list open on a rider who never
    // opened it.
    expect(issueChips(root)).toBe(SURVEY_ISSUE_OPTIONS.length);
    expect(
      Array.from(root.querySelectorAll(".ride-post-s9__issues .is-selected")).map(
        (b) => b.textContent,
      ),
    ).toEqual(["Brakes"]);
  });
});

describe("the recommendation question is on a cadence", () => {
  const NPS_Q = `Would you recommend navigating via Scooter.fyi to other ${RIDE_PROVIDER_NAME} riders?`;

  function navPane(extra: Partial<RidePostS9Deps> = {}) {
    const doc = makeDoc({ endSurvey: false, route: ROUTE });
    return buildRidePostS9Screen(baseDeps(stubSession(doc), extra)).primary;
  }

  it("asks it when the cadence says to", () => {
    expect(findFieldOrNull(navPane({ askNps: true }), NPS_Q)).toBeTruthy();
  });

  it("leaves it out otherwise, and the rest of the pane is unaffected", () => {
    const root = navPane({ askNps: false });
    expect(findFieldOrNull(root, NPS_Q)).toBeNull();
    expect(
      findFieldOrNull(root, `How was the ${routeProfileLabel(ROUTE.profile)}?`),
    ).toBeTruthy();
    expect(
      findFieldOrNull(root, "Did you deviate from the proposed routing?"),
    ).toBeTruthy();
  });

  it("sends no nav_nps on a ride that never asked", async () => {
    const postSurvey = vi.fn().mockResolvedValue({ points: [] });
    const root = navPane({ askNps: false, postSurvey });
    clickEmoji(root, `How was the ${routeProfileLabel(ROUTE.profile)}?`, 4);
    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    // Null, not a fabricated score. The column has always been nullable and the
    // API awards nothing for it.
    expect(postSurvey.mock.calls[0]![1].nav_nps).toBeNull();
  });

  it("counts a submission", async () => {
    const recordSubmitted = vi.fn();
    const postSurvey = vi.fn().mockResolvedValue({ points: [] });
    const root = navPane({ recordSubmitted, postSurvey });
    clickEmoji(root, `How was the ${routeProfileLabel(ROUTE.profile)}?`, 3);
    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    expect(recordSubmitted).toHaveBeenCalledTimes(1);
  });

  it("never counts a skip", async () => {
    const recordSubmitted = vi.fn();
    const root = navPane({ recordSubmitted });
    root.querySelector<HTMLButtonElement>(".ride-post-s9__skip")!.click();
    await flush();
    // A skipped survey asked its questions and got nothing, so counting it
    // would spend the rider's turn in the cadence on an answer we never
    // received — and they would meet the long question ten rides later having
    // never answered one.
    expect(recordSubmitted).not.toHaveBeenCalled();
  });

  it("never counts a submission the server refused", async () => {
    const recordSubmitted = vi.fn();
    const postSurvey = vi.fn().mockRejectedValue(new Error("offline"));
    const root = navPane({ recordSubmitted, postSurvey });
    clickEmoji(root, `How was the ${routeProfileLabel(ROUTE.profile)}?`, 3);
    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    expect(recordSubmitted).not.toHaveBeenCalled();
  });

  it("does not let a storage failure lose a survey that succeeded", async () => {
    const postSurvey = vi.fn().mockResolvedValue({ points: [] });
    const onSubmitted = vi.fn();
    const root = navPane({
      postSurvey,
      onSubmitted,
      recordSubmitted: () => {
        throw new Error("quota");
      },
    });
    clickEmoji(root, `How was the ${routeProfileLabel(ROUTE.profile)}?`, 3);
    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });
});

describe("neither scale is a row of ten buttons any more", () => {
  it("renders five faces, each carrying its own word", () => {
    const doc = makeDoc({ endSurvey: true, route: ROUTE });
    const root = buildRidePostS9Screen(baseDeps(stubSession(doc))).primary;
    const scales = root.querySelectorAll(".emoji-scale");
    // Scooter, route, and the recommendation question (pinned on in baseDeps).
    expect(scales).toHaveLength(3);
    for (const scale of scales) {
      const faces = scale.querySelectorAll(".emoji-scale__btn");
      expect(faces).toHaveLength(5);
      for (const f of faces) {
        expect(f.getAttribute("aria-label")).toBeTruthy();
      }
    }
    // And no ten-button segmented scale survives anywhere on the screen.
    expect(root.querySelector(".ride-post-s9__scale")).toBeNull();
  });
});

describe("the free-text box stays out of the way until wanted", () => {
  function navPane() {
    const doc = makeDoc({ endSurvey: false, route: ROUTE });
    return buildRidePostS9Screen(baseDeps(stubSession(doc))).primary;
  }
  const noteLine = (root: HTMLElement) =>
    Array.from(
      root.querySelectorAll<HTMLButtonElement>(".ride-post-s9__disclosure"),
    ).find((b) => b.textContent?.includes("note about the route"));

  it("starts collapsed, as one line", () => {
    const root = navPane();
    expect(root.querySelector(".ride-post-s9__qualitative")).toBeNull();
    expect(noteLine(root)).toBeTruthy();
  });

  it("still advertises the bonus from that line", () => {
    expect(noteLine(navPane())!.textContent).toMatch(/\+\d+ pts/);
  });

  it("opens on a tap and stays open", () => {
    const root = navPane();
    noteLine(root)!.click();
    expect(root.querySelector(".ride-post-s9__qualitative")).toBeTruthy();
    // A later re-render (another answer changing) must not re-collapse it under
    // text the rider is in the middle of typing.
    clickEmoji(root, `How was the ${routeProfileLabel(ROUTE.profile)}?`, 2);
    expect(root.querySelector(".ride-post-s9__qualitative")).toBeTruthy();
  });

  it("submits nothing extra when it was never opened", async () => {
    const postSurvey = vi.fn().mockResolvedValue({ points: [] });
    const doc = makeDoc({ endSurvey: false, route: ROUTE });
    const root = buildRidePostS9Screen(
      baseDeps(stubSession(doc), { postSurvey }),
    ).primary;
    clickEmoji(root, `How was the ${routeProfileLabel(ROUTE.profile)}?`, 3);
    root.querySelector<HTMLButtonElement>(".ride-post-s9__submit")!.click();
    await flush();
    expect(postSurvey.mock.calls[0]![1].nav_qualitative).toBeNull();
  });
});
