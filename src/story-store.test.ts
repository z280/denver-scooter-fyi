// @vitest-environment happy-dom
//
// The unsent-story store.
//
// What is worth asserting here is not that a map round-trips. It is that
// somebody's unfinished words survive the bus ride home, do not survive a
// month of neglect, and are gone the instant they have been sent somewhere —
// this app has no business keeping a private copy of what a rider said to
// somebody else.

import { beforeEach, describe, expect, it } from "vitest";

import { newStoryDraft, type StoryDraft } from "./rider-story.ts";
import {
  MAX_STORY_DRAFTS,
  STORY_DRAFT_TTL_MS,
  __resetStoryStore,
  clearDraft,
  getDraft,
  liveDrafts,
  loadDrafts,
  saveDraft,
  upsertDraft,
} from "./story-store.ts";

const T0 = Date.parse("2026-10-06T14:00:00.000Z");

function draft(id: string, over: Partial<StoryDraft> = {}): StoryDraft {
  return {
    ...newStoryDraft(id, "failed_start", { happenedAt: "2026-10-06T13:59:00.000Z" },
      new Date(T0).toISOString()),
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  __resetStoryStore();
});

describe("keeping a draft", () => {
  it("survives a reload, which is the whole reason it is stored", () => {
    saveDraft(draft("a", { text: "It wouldn't start." }), T0);
    expect(getDraft("a", T0)?.text).toBe("It wouldn't start.");
  });

  it("edits in place rather than accumulating versions", () => {
    // Two rows for one story would resurrect a sentence the rider deleted.
    saveDraft(draft("a", { text: "first" }), T0);
    saveDraft(draft("a", { text: "second" }), T0 + 1000);
    const all = loadDrafts(T0 + 2000);
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe("second");
  });

  it("keeps only a handful, dropping the oldest", () => {
    for (let i = 0; i <= MAX_STORY_DRAFTS; i += 1) {
      saveDraft(draft(`d${i}`, { text: `story ${i}` }), T0 + i * 1000);
    }
    const ids = loadDrafts(T0 + 99_000).map((d) => d.id);
    expect(ids).toHaveLength(MAX_STORY_DRAFTS);
    expect(ids[0]).toBe(`d${MAX_STORY_DRAFTS}`); // newest first
    expect(ids).not.toContain("d0"); // oldest gone
  });
});

describe("forgetting a draft", () => {
  it("expires one nobody came back to", () => {
    saveDraft(draft("a", { text: "half a thought" }), T0);
    expect(getDraft("a", T0 + STORY_DRAFT_TTL_MS - 1000)).not.toBeNull();
    expect(getDraft("a", T0 + STORY_DRAFT_TTL_MS + 1000)).toBeNull();
  });

  it("measures the clock from the last edit, not from when it was started", () => {
    // Somebody still writing has not abandoned anything.
    const started = draft("a", { text: "..." });
    saveDraft(started, T0);
    saveDraft({ ...started, text: "more" }, T0 + STORY_DRAFT_TTL_MS - 1000);
    expect(getDraft("a", T0 + STORY_DRAFT_TTL_MS + 1000)).not.toBeNull();
  });

  it("deletes on send rather than marking it sent", () => {
    // Keeping a copy would mean this app holds a private record of what a
    // rider disclosed to somebody else.
    saveDraft(draft("a", { text: "sent words" }), T0);
    clearDraft("a", T0);
    expect(getDraft("a", T0)).toBeNull();
    expect(JSON.stringify(localStorage.getItem("scooter-fyi-story-drafts"))).not.toContain(
      "sent words",
    );
  });

  it("expires on read, so a phone that slept through it still wakes up clean", () => {
    const stale = draft("old", { updatedAt: new Date(T0 - STORY_DRAFT_TTL_MS - 1).toISOString() });
    expect(liveDrafts([stale], T0)).toEqual([]);
  });
});

describe("a store that cannot be trusted", () => {
  it("reads nothing out of a corrupt blob rather than throwing", () => {
    localStorage.setItem("scooter-fyi-story-drafts", "{not json");
    expect(loadDrafts(T0)).toEqual([]);
  });

  it("ignores a blob from a different version", () => {
    localStorage.setItem(
      "scooter-fyi-story-drafts",
      JSON.stringify({ v: 2, drafts: [draft("a")] }),
    );
    expect(loadDrafts(T0)).toEqual([]);
  });

  it("drops one malformed row without losing the good ones", () => {
    localStorage.setItem(
      "scooter-fyi-story-drafts",
      JSON.stringify({ v: 1, drafts: [{ id: "bad" }, draft("good", { text: "kept" })] }),
    );
    const out = loadDrafts(T0);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("kept");
  });

  it("validates, expires, then caps — in that order", () => {
    // A corrupt or stale row must not occupy a slot a real one needs.
    const rows = [
      { id: "bad" },
      draft("stale", { updatedAt: new Date(T0 - STORY_DRAFT_TTL_MS - 1).toISOString() }),
      ...Array.from({ length: MAX_STORY_DRAFTS }, (_, i) => draft(`ok${i}`, { text: `t${i}` })),
    ];
    localStorage.setItem("scooter-fyi-story-drafts", JSON.stringify({ v: 1, drafts: rows }));
    const out = loadDrafts(T0);
    expect(out).toHaveLength(MAX_STORY_DRAFTS);
    expect(out.map((d) => d.id)).toEqual(
      Array.from({ length: MAX_STORY_DRAFTS }, (_, i) => `ok${i}`),
    );
  });
});

describe("the pure list rule", () => {
  it("replaces by id and caps, without touching storage", () => {
    const a = draft("a", { text: "one" });
    const b = draft("b", { text: "two" });
    expect(upsertDraft([a], { ...a, text: "edited" })).toEqual([{ ...a, text: "edited" }]);
    expect(upsertDraft([a], b).map((d) => d.id)).toEqual(["b", "a"]);
  });
});
