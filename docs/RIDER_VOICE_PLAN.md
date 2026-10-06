# Rider Voice — Frontend Plan (denver-scooter-fyi)

What we ask riders, when we ask it, and how an answer gets from here to
We See You Veo.

Separate from `ANALYTICS_PLAN.md` on purpose: that one counts what the fleet
did, this one collects what it was like. They meet in one place — the foot of
the headline panel — and nowhere else.

---

## 0. What is wrong with what we ask now

Screen 9 asks five faces and sixteen chips, and §5 of the along-the-way plan
already trimmed it hard. What survives is good at one question — *was this
scooter any good* — and cannot ask the other one at all: **what is it like to
get around this city on these things.**

Three specific gaps:

1. **We only hear from completed rides.** The rider whose scooter would not
   start never reaches Screen 9. `ride-failed-start.ts` catches the fact, but
   nobody is ever asked what happened. That is the most motivated person we
   will ever have, and we take one enum from them.
2. **We never ask anybody who did not ride.** Walked to three dead scooters
   and gave up, got a fine, could not find one in Montbello at 7am: all
   invisible, and all exactly the story the city needs.
3. **There is no free text that goes anywhere.** Screen 9's textarea feeds our
   own survey table. It is not what WSYV collects and it is not what gets read
   out at a council meeting.

---

## 1. What WSYV already asks, and why we do not reinvent it

`keepdenverfair/packages/shared/src/survey.ts` is the v1 instrument: a `start`
section (neighbourhood, anonymity, consent to contact) plus six optional
sections — `usage`, `comparison`, `equipment`, `cost`, `availability`, `app` —
with validated value sets, a draft store that upserts by `draftId` and
`siteKey`, and admin endpoints for contacts and aggregate stats.

**It is versioned and it is validated server-side.** So:

- We **do not** fork the question set. We submit v1 answers against the
  existing validator, as another `siteKey`. A second instrument means two
  incompatible datasets and an argument about which one is real.
- We **do** change how it is asked. A 7-section web form is a 4% completion
  rate. Everything below is about delivery, not content.

The one place we may legitimately extend is a `source` field saying the answer
came from scooter.fyi with a ride attached — because that provenance is worth
more than any extra question.

---

## 2. Why asking here is better

We know things the WSYV form has to ask for, and every question we can skip is
completion rate we keep:

| WSYV asks | We already know |
|---|---|
| neighbourhood | the ride's start cell → the neighbourhood overlay |
| ride frequency | this device's local ride count |
| had a malfunction | `ride_failed_start` fired, with the outcome |
| scooter condition | the model, the battery at pickup, the reliability tier |
| availability | how many rideable vehicles were within walking distance when they looked |
| cost | the ride's own cost estimate and rate plan |

A rider who answers three questions here produces a richer record than one who
answers twenty there. **Pre-fill, show what was pre-filled, and let them
correct it** — never submit a derived answer the rider has not seen.

---

## 3. The three moments

Asking at the right moment matters more than the questions.

### 3.1 The failure, at the moment it happens

`ride-failed-start.ts` already fires when a rider tells us a scooter would not
start. Today that produces one enum. It should offer one line:

> *"That's the third one this week in Five Points. Want to say what happened?"*

One optional sentence, a photo, and the vehicle + place + time we already have.
No form, no sections, no account. This is the single highest-value capture in
the app and it currently does not exist.

### 3.2 The end of a ride, occasionally

Screen 9 stays as it is — five faces, trimmed. The story prompt rides **after**
the survey, on the same cadence rule the NPS question uses
(`survey-cadence.ts`: first, then every tenth), so it is never the thing
standing between a rider and their points.

### 3.3 The analytics drawer

A reader who has just seen the city-wide number is primed. §4 of
`ANALYTICS_PLAN.md` is the entry point, and it is the only one that can ask the
full instrument, because it is the only one where the rider came to read rather
than to ride.

---

## 4. What a story is

The smallest thing worth collecting:

- **One free-text answer.** Not a textarea on a form — a prompt a person can
  answer in a sentence: *"What happened?"* The prompt is the design.
- **Optional photo**, through the device-photos path that already exists.
- **The context we already hold**, shown and editable: when, where (the
  neighbourhood, not the coordinate), which model, what the app thought of that
  scooter at the time.
- **Optional contact**, defaulted off, with WSYV's own `consentToContact`
  semantics rather than a second meaning of the word.

And the thing that makes it evidence rather than a complaint: **the fleet
figure for that place and week**, attached automatically. "My scooter died" is
an anecdote; "my scooter died, in a neighbourhood where 14% of rentals went
nowhere that week" is a finding. `ANALYTICS_PLAN.md`'s tier-2 table is what
makes that line computable.

---

## 5. Consent, which is the hard part

Phase 10 of the along-the-way plan already settled the shape for the complaint
CC, and the same reasoning governs here. Restated because this is where it will
be got wrong:

- **Submitting to WSYV is a disclosure to a third party.** It is a different
  act from answering our own survey, and the UI must never let one imply the
  other. Its own tick, defaulted off, per story.
- **It says what the recipient sees** — the words, the photo, the
  neighbourhood, the time, and the contact details if given. Not "your
  response may be shared".
- **Anonymous is first-class.** WSYV v1 has an `anonymous` flag; a story
  submitted anonymously must carry no account identifier at all, not an
  identifier the server promises not to look at.
- **Per story, never a standing permission.** A rider who sent one last week
  has not volunteered for every future one.
- **Withdrawal has to work.** If it cannot be deleted at WSYV, it cannot be
  called withdrawable here — the same line Phase 8 draws for the evidence pile.

### 5.1 The photo is the sharpest edge

A photo of a badly-parked scooter is also a photo of a street, a house number,
a licence plate, a person. The device-photos path already strips EXIF
server-side; a story photo bound for a third party needs that **and** a line
telling the rider what is in frame is their choice. Nothing automated can fix
a face in a photo, so the only honest control is the sentence before they
attach it.

---

## 6. The submission path

`surveyDraftStore.upsert(draftId, siteKey, sessionId, validated)` already takes
a `siteKey`, which is the seam: scooter.fyi becomes one.

Two decisions for that lane, flagged here rather than assumed:

1. **Who holds the draft.** A story started on the failure screen and finished
   two days later has to live somewhere. Local, like the ride session, until it
   is submitted — which keeps an unsent story out of anybody's database.
2. **Whether we post directly or hand off.** Direct keeps the rider in one app
   and makes us responsible for their words in transit. A hand-off with the
   answers pre-filled is more honest about whose system it is. **Recommend
   direct**, with the disclosure in §5 doing the work, because a hand-off at
   the moment of submission is where completion rates go to die — but this is
   the user's call and it is a one-way door.

---

## 7. What we must not build

- **No rating of other riders**, ever.
- **No public story feed in this app.** We are a map with an argument; a
  moderation surface is a different product and an unbounded obligation.
- **No story without a person choosing to send it.** Nothing derived from
  telemetry gets submitted as if a rider said it.
- **No pre-filled free text.** We may pre-fill facts; we never draft somebody's
  words for them.

---

## 8. Modules

| Module | Responsibility |
|---|---|
| `rider-story.ts` *(new)* | Pure: the prompt set, the pre-fill derivation, the WSYV v1 payload shape, and the validation mirror of `survey.ts`'s value sets. |
| `rider-story-sheet.ts` *(new)* | The one-question sheet. Opens from the failure screen, Screen 9's tail, and the analytics drawer. |
| `story-store.ts` *(new)* | Local drafts, versioned blob, same discipline as `device-notify.ts`. |
| `ride-screen-start.ts` *(existing)* | The failure prompt, after the report lands. |
| `ride-post-s9.ts` *(existing)* | The tail prompt, on the existing cadence. |
| `api.ts` *(existing)* | `submitRiderStory`. |

---

## 9. Tests

- The pre-fill is shown and editable; a submission never contains a derived
  answer the rider was not shown.
- Anonymous submits no account identifier — asserted on the payload, not on
  the UI.
- The WSYV consent tick is off by default and does not persist to the next story.
- A payload validates against `survey.ts` v1's value sets. If the two drift,
  this test is what says so — mirrored validation, same hazard the telemetry
  allowlist carries.
- A story drafted and abandoned is never transmitted.
- The failure prompt appears after the report resolves, never before: the
  report is the useful artefact and must not be held hostage to a sentence.
- The cadence rule holds — the tail prompt does not appear on every ride.

---

## 10. Sequencing

1. **The failure prompt** (§3.1). Smallest, highest value, needs no account and
   no WSYV integration — it can land as a local story draft on day one.
2. **The local store and the pre-fill derivation.**
3. **The WSYV decision** (§6.2), then the submission path and its consent UI.
4. **The analytics entry point**, once `ANALYTICS_PLAN.md` tier 1 is up.
5. **Screen 9's tail prompt** last — it is the least motivated moment of the
   three and the easiest to get wrong.
