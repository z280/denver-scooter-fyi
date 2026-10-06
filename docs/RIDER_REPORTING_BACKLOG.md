# Rider reporting — what is left to build

Scope: how riders tell us (and We See You Veo) what happened. The counting
side lives on `claude/analytics-tier2`.

## What already exists, and where

Built and **unmerged**, on `claude/scooter-app-sticky-usage-wqcq9z`:

- `src/rider-story.ts` — the rules, pure: prompts, consent, the WSYV v1
  payload, the disclosure built from the draft.
- `src/story-store.ts` — local drafts, deleted on send.
- `src/rider-story-sheet.ts` — the one-question sheet.
- Two asking moments wired: the failed start, and the stats drawer.
- In `keepdenverfair`: the v1 `story` section, the `source` field, scoped CORS,
  and `GET /api/survey-options` serving the neighbourhood list.

`docs/RIDER_VOICE_PLAN.md` (same branch) is the governing plan. **Start by
reading its §5 and §7** — the consent rules and the must-nots are not style
preferences and every item below inherits them.

---

## 1. The post-ride tail prompt (plan §3.2, sequencing step 5)

**What:** the story prompt after Screen 9's five faces, on
`survey-cadence.ts`'s existing rule (first ride, then every tenth) so it never
stands between a rider and their points.

**Why last:** it is the least motivated of the three moments and the easiest
to get wrong — a rider who has just finished a good ride has nothing to say
and will learn to dismiss it. The cadence rule is what keeps it from becoming
noise, so wire that first and verify it before the copy.

**Where:** `src/ride-post-s9.ts`, mounting `mountStoryPanel` with
`origin: "ride_end"`. The prompt copy already exists in `rider-story.ts`.

**Careful:** `ride-post-s9.ts` rebuilds its pane on selection, which has
already broken keyboard focus once (see `emoji-scale.ts`'s
`pendingKeyboardFocus`). A textarea that loses focus mid-sentence is worse
than no prompt.

---

## 2. The optional photo (plan §5.1)

**What:** let a story carry a photo, through the `device-photos.ts` path that
already strips EXIF server-side.

**The hard part is not the upload.** A photo of a badly-parked scooter is also
a photo of a street, a house number, a plate, a person — and this one is bound
for a third party. EXIF stripping does not fix a face in frame. The plan's
position: the only honest control is the sentence before they attach it, and
that sentence has to be written before the button.

**Blocked on:** WSYV's survey draft store has no attachment path. That is a
schema change in `keepdenverfair`, not a frontend change, and it needs the
same per-story consent the text already has.

---

## 3. Withdrawal (plan §5)

**What:** a rider who sent a story can have it deleted.

**Why it is listed:** the plan draws a hard line — "if it cannot be deleted at
WSYV, it cannot be called withdrawable here". Right now nothing in the UI
claims it can be withdrawn, which is correct, and that is the only reason this
is not already a broken promise. **Do not add withdrawal copy before the
delete path exists.**

**Where:** `keepdenverfair` — the survey draft store is keyed by `draftId`,
which the sending client knows, so the mechanism is there. What is missing is
a way for a rider to prove it was theirs without us keeping an identifier we
promised not to keep. That tension is the actual design problem.

---

## 4. The fleet figure attached to a story (plan §4)

**What:** "my scooter died" is an anecdote; "my scooter died in a
neighbourhood where 14% of rentals went nowhere that week" is a finding.

**Blocked on** `claude/analytics-tier2` — the per-place, per-week rollup is
what makes that line computable. Nothing to do here until it exists.

---

## Not to be built

From the plan's §7, restated because they are the things that look like
obvious next features:

- No rating of other riders, ever.
- No public story feed in this app — a moderation surface is a different
  product and an unbounded obligation.
- No story submitted without a person choosing to send it. Nothing derived
  from telemetry goes out as if a rider said it.
- No pre-filled free text. Facts may be pre-filled; words never.
