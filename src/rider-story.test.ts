// The rules that govern a rider's story.
//
// These are not tests of a form. Each one pins a promise the app makes to the
// person typing: that their words are theirs, that anonymous means anonymous,
// that nothing goes to a third party they did not send it to, and that the
// disclosure they read is the thing that actually gets sent. A regression in
// any of them is a broken promise rather than a bug.

import { describe, expect, it } from "vitest";

import {
  STORY_MAX_LENGTH,
  STORY_PLACEHOLDER,
  buildStoryPayload,
  newStoryDraft,
  storyBlockedReason,
  storyLede,
  storyPrompt,
  wsyvDisclosure,
  type StoryContext,
  type StoryDraft,
  type StoryOrigin,
} from "./rider-story.ts";

const CONTEXT: StoryContext = {
  happenedAt: "2026-10-06T14:02:00.000Z",
  vehicleModel: "Cosmo",
  appAssessment: "ok",
};

const ORIGINS: StoryOrigin[] = ["failed_start", "ride_end", "stats"];

function draft(over: Partial<StoryDraft> = {}): StoryDraft {
  return {
    ...newStoryDraft("story-1", "failed_start", CONTEXT, "2026-10-06T14:03:00.000Z"),
    ...over,
  };
}

describe("a fresh draft", () => {
  it("consents to nothing and says nothing", () => {
    const d = newStoryDraft("x", "failed_start", CONTEXT);
    expect(d.text).toBe("");
    expect(d.sendToWsyv).toBe(false);
    expect(d.anonymous).toBe(true);
    expect(d.contactEmail).toBe("");
  });

  it("defaults the third-party tick off on EVERY story, not just the first", () => {
    // A rider who sent one last week has not volunteered for every future
    // one. There is deliberately no persisted preference to read here.
    for (const origin of ORIGINS) {
      expect(newStoryDraft(origin, origin, CONTEXT).sendToWsyv).toBe(false);
    }
  });
});

describe("we never draft somebody's words", () => {
  it("starts the text empty whatever context we hold", () => {
    expect(newStoryDraft("x", "failed_start", CONTEXT).text).toBe("");
    expect(
      newStoryDraft("x", "failed_start", {
        happenedAt: CONTEXT.happenedAt,
        vehicleModel: "Rover",
        appAssessment: "high_risk",
      }).text,
    ).toBe("");
  });

  it("offers a placeholder that is a shape, not a sentence to accept", () => {
    // If the placeholder were submittable prose, a rider could send words the
    // app wrote and believe they were their own.
    expect(STORY_PLACEHOLDER).toContain("…");
    expect(STORY_PLACEHOLDER).toContain("/");
  });

  it("refuses to send an empty story, and says why", () => {
    expect(storyBlockedReason(draft({ sendToWsyv: true }))).toMatch(/write a sentence/i);
    expect(storyBlockedReason(draft({ text: "   " }))).not.toBeNull();
  });
});

describe("the prompt is the design", () => {
  it("asks a question a person can answer in a sentence, at every moment", () => {
    for (const origin of ORIGINS) {
      const prompt = storyPrompt(origin);
      expect(prompt.endsWith("?"), origin).toBe(true);
      expect(prompt.length, origin).toBeLessThan(60);
      expect(storyLede(origin).length, origin).toBeGreaterThan(40);
    }
  });

  it("never asks for a rating — the faces already do that", () => {
    for (const origin of ORIGINS) {
      expect(`${storyPrompt(origin)} ${storyLede(origin)}`).not.toMatch(
        /\brate\b|\brating\b|out of (five|ten|5|10)|stars?\b/i,
      );
    }
  });
});

describe("nothing leaves without the tick", () => {
  it("builds no payload at all when the rider did not send it", () => {
    // The guard is here, in the builder, and not only in the sheet: a caller
    // must not be able to transmit a draft by forgetting to check a flag.
    expect(buildStoryPayload(draft({ text: "It wouldn't start." }), "sess-1")).toBeNull();
  });

  it("builds no payload from an unsendable draft", () => {
    expect(
      buildStoryPayload(draft({ sendToWsyv: true, text: "" }), "sess-1"),
    ).toBeNull();
    expect(
      buildStoryPayload(
        draft({ sendToWsyv: true, text: "x", neighborhood: "" }),
        "sess-1",
      ),
    ).toBeNull();
  });
});

describe("anonymous means anonymous", () => {
  const anon = draft({
    sendToWsyv: true,
    anonymous: true,
    text: "Third dead one this week.",
    neighborhood: "Montbello",
    contactEmail: "rider@example.com", // left over from a toggle, must not ride along
  });

  it("carries no identifier anywhere in the payload", () => {
    const payload = buildStoryPayload(anon, "sess-abc123")!;
    const wire = JSON.stringify(payload);
    // Asserted on the serialised payload, not on the sheet — the sheet is not
    // what gets sent.
    expect(wire).not.toContain("sess-abc123");
    expect(wire).not.toContain("rider@example.com");
    expect(payload.sessionId).toBe("");
    expect(payload.answers.start.contactEmail).toBeUndefined();
    expect(payload.anonymous).toBe(true);
  });

  it("never claims consent to contact somebody it cannot reach", () => {
    expect(buildStoryPayload(anon, "s")!.consentToContact).toBe(false);
  });

  it("carries the session and the address only when the rider chose to", () => {
    const named = { ...anon, anonymous: false };
    const payload = buildStoryPayload(named, "sess-abc123")!;
    expect(payload.sessionId).toBe("sess-abc123");
    expect(payload.answers.start.contactEmail).toBe("rider@example.com");
    expect(payload.consentToContact).toBe(true);
    expect(payload.anonymous).toBe(false);
  });

  it("will not send a named story without a usable address", () => {
    expect(
      storyBlockedReason({ ...anon, anonymous: false, contactEmail: "nope" }),
    ).toMatch(/email/i);
  });
});

describe("the disclosure is the payload", () => {
  const d = draft({
    sendToWsyv: true,
    text: "It threw an error and charged me anyway.",
    neighborhood: "Five Points",
  });

  it("names every fact the payload actually carries", () => {
    // A disclosure that omits something the payload sends is a lie. This is
    // the test that keeps the two from drifting.
    const payload = buildStoryPayload(d, "s")!;
    const shown = wsyvDisclosure(d).join(" ");
    expect(shown).toMatch(/word for word/i); // storyText
    expect(shown).toContain(payload.answers.story.neighborhood);
    expect(shown).toMatch(/when it happened/i); // happenedAt
    expect(shown).toContain(payload.answers.story.vehicleModel!);
    expect(shown).toMatch(/what this app thought/i); // appAssessment
  });

  it("says plainly that an anonymous story identifies nobody", () => {
    expect(wsyvDisclosure(d).join(" ")).toMatch(/no name, no email, no account/i);
  });

  it("names the address when one will be sent", () => {
    const named = { ...d, anonymous: false, contactEmail: "rider@example.com" };
    expect(wsyvDisclosure(named).join(" ")).toContain("rider@example.com");
  });

  it("never hedges", () => {
    // "may be shared" is the phrasing that lets somebody discover later that
    // they did not know what they agreed to.
    for (const line of wsyvDisclosure(d)) {
      expect(line).not.toMatch(/\bmay be\b|\bcould be\b|\bsuch as\b|\betc\b/i);
    }
  });

  it("omits what it does not hold, rather than naming a blank", () => {
    const bare = draft({
      sendToWsyv: true,
      text: "x",
      neighborhood: "Baker",
      context: { happenedAt: CONTEXT.happenedAt },
    });
    const shown = wsyvDisclosure(bare).join(" ");
    expect(shown).not.toMatch(/which model/i);
    expect(shown).not.toMatch(/what this app thought/i);
  });
});

describe("the payload matches the instrument", () => {
  const d = draft({
    sendToWsyv: true,
    text: "  It wouldn't start.  ",
    neighborhood: "Montbello",
  });

  it("declares the story section and the source", () => {
    const payload = buildStoryPayload(d, "s")!;
    expect(payload.version).toBe("1");
    expect(payload.enabledSections).toEqual(["story"]);
    expect(payload.source).toBe("scooter.fyi");
    expect(payload.answers.start.consentGranted).toBe("true");
  });

  it("trims the rider's words without altering them", () => {
    expect(buildStoryPayload(d, "s")!.answers.story.storyText).toBe(
      "It wouldn't start.",
    );
  });

  it("files the story under the same neighbourhood as the start section", () => {
    // The two must agree: a story filed in one neighbourhood and a respondent
    // recorded in another cannot be counted together.
    const payload = buildStoryPayload(d, "s")!;
    expect(payload.answers.story.neighborhood).toBe(
      payload.answers.start.neighborhood,
    );
  });

  it("refuses a story longer than the instrument accepts, rather than cutting it", () => {
    // The server rejects over-length too. Catching it here means the rider is
    // told before they press send, instead of after.
    const long = draft({
      sendToWsyv: true,
      neighborhood: "Baker",
      text: "x".repeat(STORY_MAX_LENGTH + 1),
    });
    expect(storyBlockedReason(long)).toMatch(/longer than/i);
    expect(buildStoryPayload(long, "s")).toBeNull();
    const atLimit = { ...long, text: "x".repeat(STORY_MAX_LENGTH) };
    expect(buildStoryPayload(atLimit, "s")).not.toBeNull();
  });
});
