// "What happened?" — one question, asked at the moment it can be answered.
//
// WHY THIS EXISTS. The app already catches the fact that a scooter would not
// start (`ride-failed-start.ts`) and turns it into one enum. That rider is the
// most motivated person this app will ever have — standing over a dead
// scooter, certain, with nothing else to do — and until now we took a single
// bit from them and sent them away. Meanwhile We See You Veo collects rider
// experience through a seven-section web form, which the person whose scooter
// would not start never opens, because they are not at a desk and they are not
// looking for a survey.
//
// So the question moves to the moment. One sentence, optional, after the
// report has already landed.
//
// WHAT THIS MODULE IS. The decision and the words, kept pure and apart from
// the sheet that renders them — the same split `ride-failed-start.ts` makes,
// and for the same reason: the consent rules and the payload shape are worth
// asserting on directly rather than through a DOM.
//
// THE RULES, which are not style preferences:
//
//   * **We never draft somebody's words.** Facts may be pre-filled. Free text
//     never is. A story the app wrote and the rider merely approved is not a
//     rider's story, and submitting one as if it were is the single way this
//     feature could do real harm to the thing it is for.
//   * **Sending to WSYV is a disclosure to a third party**, separate from
//     telling us. Its own tick, off by default, per story — a rider who sent
//     one last week has not volunteered for every future one.
//   * **Anonymous means anonymous.** Not an identifier the server promises
//     not to look at: no identifier at all, asserted on the payload.
//   * **The disclosure says what the recipient sees** — the words, the
//     neighbourhood, the time, the vehicle, and the contact details if given.
//     Never "your response may be shared".
//
// WHERE IT GOES. We See You Veo's v1 instrument gained an optional `story`
// section for exactly this (`keepdenverfair/packages/shared/src/survey.ts`),
// and a `source` field recording that the answer was collected here. We do not
// fork the question set: two instruments would mean two datasets and an
// argument about which one is real, and these answers are meant to be
// evidence.

/** Which moment produced this story. The prompt is the design, so the moment
 *  has to be a value rather than a string passed in by a caller. */
export type StoryOrigin =
  /** A scooter that would not start, right after the report landed. */
  | "failed_start"
  /** The tail of the post-ride survey, on the existing cadence. */
  | "ride_end"
  /** The stats drawer, where a reader came to read rather than to ride. */
  | "stats";

/** What the app already knew. Everything here is shown to the rider before
 *  anything is sent — a derived answer they have not seen never goes out. */
export interface StoryContext {
  /** ISO-8601. When the thing happened, not when they got round to typing. */
  happenedAt: string;
  /** Veo's own model name (Cosmo, Rover, …), when we know it. */
  vehicleModel?: string | null;
  /** What the app thought of that vehicle at the time. Its own finding:
   *  "the app said it was fine" is a different complaint from "it was
   *  broken". */
  appAssessment?: "ok" | "unknown" | "high_risk" | null;
}

export interface StoryDraft {
  /** Stable id, so a story started on the failure screen and finished later
   *  is the same story rather than a second one. */
  id: string;
  origin: StoryOrigin;
  /** The rider's own words. Empty until they type. */
  text: string;
  /** From the picker, which is populated by the instrument's own list. */
  neighborhood: string;
  context: StoryContext;
  /** The third-party disclosure. Off by default, every time. */
  sendToWsyv: boolean;
  /** Default TRUE: the quiet option is the safe one, and a rider who wants
   *  to be reachable can say so. */
  anonymous: boolean;
  /** Only meaningful when not anonymous. */
  contactEmail: string;
  createdAt: string;
  updatedAt: string;
}

/** The prompt. One question, in the words of the moment it is asked in.
 *
 *  Each is a question a person can answer in a sentence, and none of them
 *  asks the rider to rate anything — the five faces already do that, and a
 *  story is the thing a rating cannot hold. */
export function storyPrompt(origin: StoryOrigin): string {
  switch (origin) {
    case "failed_start":
      return "What happened?";
    case "ride_end":
      return "How was getting around today?";
    case "stats":
      return "What's it like riding in Denver?";
  }
}

/** The line above the prompt. Says why we are asking and what it is for,
 *  because a text box with no stated purpose reads as a complaint form. */
export function storyLede(origin: StoryOrigin): string {
  switch (origin) {
    case "failed_start":
      return "The report's sent. If you've got a second, say what happened in your own words — that part can't be counted, and it's the part that gets read.";
    case "ride_end":
      return "The numbers say whether a scooter moved. They can't say what the trip was actually like.";
    case "stats":
      return "You've just read what the fleet did. Riders' own accounts are the other half of it.";
  }
}

/** Placeholder text for the box.
 *
 *  Deliberately an EXAMPLE OF A SHAPE, never a sentence a rider could submit
 *  by accident — a placeholder is not a draft, and anything that reads as one
 *  would be the app putting words in somebody's mouth. */
export const STORY_PLACEHOLDER =
  "Third one this week… / It threw an error and charged me anyway… / I ended up walking.";

export const STORY_MAX_LENGTH = 4000;

/** Fresh draft. Nothing consented, nothing written, every switch at its safe
 *  default. */
export function newStoryDraft(
  id: string,
  origin: StoryOrigin,
  context: StoryContext,
  now: string = new Date().toISOString(),
): StoryDraft {
  return {
    id,
    origin,
    text: "",
    neighborhood: "",
    context,
    // Both defaults are the quiet ones, and both are re-asked every story.
    sendToWsyv: false,
    anonymous: true,
    contactEmail: "",
    createdAt: now,
    updatedAt: now,
  };
}

/** Why a draft cannot be sent yet, or null when it can.
 *
 *  A sentence rather than a boolean, because the sheet shows it: a disabled
 *  button that will not say what it wants is the most common way a form
 *  wastes somebody's time. */
export function storyBlockedReason(draft: StoryDraft): string | null {
  if (draft.text.trim().length === 0) {
    return "Write a sentence first — this one's yours to say.";
  }
  if (draft.text.length > STORY_MAX_LENGTH) {
    return `That's longer than we can send (${draft.text.length.toLocaleString("en-US")} of ${STORY_MAX_LENGTH.toLocaleString("en-US")} characters).`;
  }
  // Only WSYV needs the neighbourhood: its instrument requires one. A story
  // kept here does not, and demanding it anyway would be this app asking for
  // data it has no use for.
  if (draft.sendToWsyv && draft.neighborhood.trim().length === 0) {
    return "Pick your neighbourhood — We See You Veo's form needs one to file it under.";
  }
  if (draft.sendToWsyv && !draft.anonymous && !isPlausibleEmail(draft.contactEmail)) {
    return "Add an email they can reach you on, or switch back to anonymous.";
  }
  return null;
}

/** Deliberately permissive. This is the hint that catches a typo before a
 *  submission is wasted, not an authority on what an address is — the
 *  recipient decides that, and a regex that rejects a real address is worse
 *  than one that lets a fake through. */
export function isPlausibleEmail(value: string): boolean {
  const v = value.trim();
  return v.length >= 5 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Exactly what the recipient will see, in the order it will be read.
 *
 *  Built from the draft rather than written as prose, so it CANNOT drift from
 *  what the payload actually contains — a disclosure that lists something the
 *  payload omits is merely wrong, but one that omits something the payload
 *  sends is a lie. The test asserts the two against each other. */
export function wsyvDisclosure(draft: StoryDraft): string[] {
  const lines = [
    "What you wrote, word for word.",
    `The neighbourhood you picked${draft.neighborhood ? ` (${draft.neighborhood})` : ""}.`,
    "When it happened.",
  ];
  if (draft.context.vehicleModel) {
    lines.push(`Which model of scooter it was (${draft.context.vehicleModel}).`);
  }
  if (draft.context.appAssessment) {
    lines.push(
      `What this app thought of that scooter at the time (${describeAssessment(draft.context.appAssessment)}).`,
    );
  }
  lines.push(
    draft.anonymous
      ? "Nothing that identifies you — no name, no email, no account."
      : `Your email address (${draft.contactEmail.trim() || "once you add it"}), so they can follow up.`,
  );
  return lines;
}

/** The app's own verdict, in words a rider would recognise from the map. */
export function describeAssessment(
  assessment: NonNullable<StoryContext["appAssessment"]>,
): string {
  switch (assessment) {
    case "ok":
      return "we'd called it rideable";
    case "high_risk":
      return "we'd flagged it";
    case "unknown":
      return "we had no read on it";
  }
}

/** The payload shape We See You Veo's v1 validator accepts.
 *
 *  Mirrored from `keepdenverfair/packages/shared/src/survey.ts`. The VALUE
 *  SETS are not mirrored — the neighbourhood list is fetched from that same
 *  instrument at runtime precisely so this file cannot hold a stale copy of
 *  it. What is mirrored here is only the shape, which is additive-only by that
 *  module's own rule. */
export interface SurveyStoryPayload {
  version: "1";
  anonymous: boolean;
  consentToContact: boolean;
  enabledSections: string[];
  answers: {
    start: {
      anonymous: string;
      consentGranted: string;
      neighborhood: string;
      contactEmail?: string;
    };
    story: {
      storyText: string;
      happenedAt: string;
      neighborhood: string;
      vehicleModel?: string;
      appAssessment?: string;
    };
  };
  completedAt: string;
  source: "scooter.fyi";
  /** WSYV's own session field. EMPTY for an anonymous story — see below. */
  sessionId: string;
}

/** Build the submission.
 *
 *  ANONYMITY IS ENFORCED HERE, not in the UI. An anonymous story carries an
 *  empty `sessionId` and no `contactEmail`: not an identifier the recipient
 *  promises not to join on, but no identifier at all. The test asserts this
 *  against the serialised payload rather than against the sheet, because the
 *  sheet is not what gets sent.
 *
 *  Returns null when the draft is not sendable — callers must not have to
 *  remember to check, and a half-built payload must never reach the wire. */
export function buildStoryPayload(
  draft: StoryDraft,
  sessionId: string,
  now: string = new Date().toISOString(),
): SurveyStoryPayload | null {
  if (!draft.sendToWsyv) return null;
  if (storyBlockedReason(draft) !== null) return null;

  const anonymous = draft.anonymous;
  const email = anonymous ? "" : draft.contactEmail.trim();

  const payload: SurveyStoryPayload = {
    version: "1",
    anonymous,
    // Consent to be CONTACTED is a second thing, and it is exactly "they gave
    // an address". Ticking the send box is consent to disclose the story; it
    // is not an invitation to email anybody.
    consentToContact: !anonymous && email.length > 0,
    enabledSections: ["story"],
    answers: {
      start: {
        anonymous: anonymous ? "true" : "false",
        // The instrument requires this to be the string "true", and it is:
        // the rider ticked the box that says what is sent and to whom. A
        // payload is only ever built after `sendToWsyv`.
        consentGranted: "true",
        neighborhood: draft.neighborhood,
      },
      story: {
        storyText: draft.text.trim(),
        happenedAt: draft.context.happenedAt,
        neighborhood: draft.neighborhood,
      },
    },
    completedAt: now,
    source: "scooter.fyi",
    sessionId: anonymous ? "" : sessionId,
  };

  if (!anonymous && email) payload.answers.start.contactEmail = email;
  if (draft.context.vehicleModel) {
    payload.answers.story.vehicleModel = draft.context.vehicleModel;
  }
  if (draft.context.appAssessment) {
    payload.answers.story.appAssessment = draft.context.appAssessment;
  }
  return payload;
}
