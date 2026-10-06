// Where an unsent story lives.
//
// LOCAL, AND THAT IS THE POINT. A story started over a dead scooter and
// finished on the bus home has to survive in between, and the only honest
// place for it is this browser: an unsent story is not in anybody's database,
// including ours. Nothing here is transmitted — `rider-story.ts` builds a
// payload only from a draft the rider has ticked and sent, and
// `clearStory` runs the moment it lands.
//
// Same discipline as `device-notify.ts`, for the same reasons: a versioned
// blob so a future shape change cannot be read as the current one, validation
// on read so a corrupt row costs one draft rather than the store, a session
// mirror for the private-mode case where writes throw, and expiry applied on
// READ rather than on a timer, because a phone that slept through an expiry
// still has to wake up to a clean list.
//
// THE CAP AND THE EXPIRY ARE THE PRIVACY POSTURE, not housekeeping. These are
// a person's unsent words about their own day. They should not accumulate on a
// device for months because nobody got round to deleting them, so a draft the
// rider never finished is gone in a week and there are never more than a
// handful.

import type { StoryDraft } from "./rider-story.ts";

const STORY_DRAFTS_KEY = "scooter-fyi-story-drafts";

/** A week. Long enough to finish a thought on the way home or the next day;
 *  short enough that an abandoned one does not sit on a phone indefinitely. */
export const STORY_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Few on purpose. Somebody with four unfinished stories has a problem this
 *  store cannot solve, and a longer list is just more unsent words to keep. */
export const MAX_STORY_DRAFTS = 4;

interface StoredDrafts {
  v: 1;
  drafts: StoryDraft[];
}

/** Used ONLY when storage refuses writes (private mode, quota). Without it a
 *  rider types a sentence, the write throws, the next read returns nothing and
 *  their words vanish mid-sentence — the bug `device-notify.ts` carries the
 *  same mirror for. Null while storage works, so there is one source of truth
 *  in the normal case. */
let sessionDrafts: StoryDraft[] | null = null;

function isValidDraft(value: unknown): value is StoryDraft {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    d.id.length > 0 &&
    typeof d.text === "string" &&
    typeof d.neighborhood === "string" &&
    typeof d.sendToWsyv === "boolean" &&
    typeof d.anonymous === "boolean" &&
    typeof d.contactEmail === "string" &&
    typeof d.createdAt === "string" &&
    typeof d.updatedAt === "string" &&
    typeof d.context === "object" &&
    d.context !== null &&
    typeof (d.context as Record<string, unknown>).happenedAt === "string"
  );
}

/** Drop what has run out, measured from when the draft was last touched —
 *  a rider still editing has not abandoned anything. */
export function liveDrafts(
  drafts: readonly StoryDraft[],
  now: number = Date.now(),
): StoryDraft[] {
  return drafts.filter((d) => {
    const touched = Date.parse(d.updatedAt);
    return Number.isFinite(touched) && now - touched < STORY_DRAFT_TTL_MS;
  });
}

export function loadDrafts(now: number = Date.now()): StoryDraft[] {
  if (sessionDrafts !== null) return liveDrafts(sessionDrafts, now);
  try {
    const raw = localStorage.getItem(STORY_DRAFTS_KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as StoredDrafts;
    if (blob?.v !== 1 || !Array.isArray(blob.drafts)) return [];
    // Validate, expire, then cap — in that order, so a corrupt or stale row
    // cannot occupy a slot a valid one needs.
    return liveDrafts(blob.drafts.filter(isValidDraft), now).slice(
      0,
      MAX_STORY_DRAFTS,
    );
  } catch {
    return [];
  }
}

function persist(drafts: StoryDraft[]): boolean {
  try {
    localStorage.setItem(
      STORY_DRAFTS_KEY,
      JSON.stringify({ v: 1, drafts } satisfies StoredDrafts),
    );
    sessionDrafts = null;
    return true;
  } catch {
    sessionDrafts = drafts.slice();
    return false;
  }
}

/** Pure list logic, exported so the replace-and-cap rule is testable without
 *  touching storage.
 *
 *  Saving the same id REPLACES rather than appends — this is an edit, and two
 *  rows for one story would resurrect a sentence the rider deleted. Newest
 *  first, and the oldest falls off the end: when something has to go, it is
 *  the thing least likely to still be on anybody's mind. */
export function upsertDraft(
  existing: readonly StoryDraft[],
  draft: StoryDraft,
): StoryDraft[] {
  const kept = existing.filter((d) => d.id !== draft.id);
  return [draft, ...kept].slice(0, MAX_STORY_DRAFTS);
}

export function saveDraft(draft: StoryDraft, now: number = Date.now()): void {
  const touched: StoryDraft = { ...draft, updatedAt: new Date(now).toISOString() };
  persist(upsertDraft(loadDrafts(now), touched));
}

export function getDraft(id: string, now: number = Date.now()): StoryDraft | null {
  return loadDrafts(now).find((d) => d.id === id) ?? null;
}

/** Forget it. Called when a story is sent, and when a rider dismisses one.
 *
 *  Sending DELETES rather than marking sent: keeping a copy of something the
 *  rider has already disclosed would mean this app holds a private record of
 *  what they said to somebody else, which nobody asked it to do. */
export function clearDraft(id: string, now: number = Date.now()): void {
  persist(loadDrafts(now).filter((d) => d.id !== id));
}

/** Reset the private-mode mirror. Tests only — each needs a clean slate, and
 *  a module-level fallback that survives between them is a false pass. */
export function __resetStoryStore(): void {
  sessionDrafts = null;
}
