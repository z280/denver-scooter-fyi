# Along the Way — Frontend Plan (denver-scooter-fyi)

Companion to `scooter-fyi-api/ALONG_THE_WAY_PLAN.md` (the **master** program
plan — read it first; the vision, decisions, equity arithmetic and risks live
there). This document is the actionable frontend lane: which modules exist,
what each owns, what it may not do, and what the tests have to prove.

Planned 2026-08-29 against `main` (13e2215). Branch:
`claude/along-way-upgrades-feature-piml2p`.
**Revision 2** — the spec is now rider-facing ("my ideal scooter") and applies
to the map in one tap (§1.3, a **reversal** of revision 1's decision), and
**My Scooters** — favouriting individual vehicles behind a QR scan — joins as
Phase 4 (§4).

## House rules that bind every phase

Inherited from `docs/PLAN_RIDE_MODE_FRONTEND.md` and the modules this program
touches:

- Vanilla TypeScript, no framework. New surfaces are **new modules**, wired
  from `main.ts` by a single `wireX()` call. `main.ts` (~3.8k lines) and
  `devices.ts` (~3.8k lines) do not grow.
- Anything modal copies the `ride-wizard.ts` / `device-features.ts`
  discipline: `document.createElement` only (never `innerHTML`), a
  `cleanupFns[]` teardown list, a real focus trap (`modal-focus-trap.ts`),
  Escape handling, a hooks interface instead of importing `main.ts` state.
- API calls go through `src/api.ts`.
- localStorage: dotted `scooter_fyi.*` for ride/auth state, hyphenated
  `scooter-fyi-*` for UI prefs; every read and write in a `try/catch`
  (private mode must degrade, never throw).
- Telemetry event names are a **fixed allowlist mirrored by hand** in
  `src/telemetry.ts` and the API's `src/api_telemetry.py`. New names land in
  both repos in the same PR, carry no free text, no coordinates, and **no
  `vehicle_identifier`** — attaching a device to a session in the one system
  built to hold no persistent identifier is exactly what it is built not to do.
- **The pure logic is a separate module from the DOM that renders it.** Every
  new decision rule below lives in a module with no DOM imports and its own
  `.test.ts`. This is not a style preference here: the swap rules decide, on
  the rider's behalf, that they should walk somewhere else, and every one of
  them has to be testable without a map.

---

## Module map

New unless marked. Phase numbers refer to the master plan §4.

| Module | Phase | Responsibility |
|---|---|---|
| `ride-spec.ts` | 1 | The Spec type, its must/prefer split, the relaxation ladder, `matches(device, spec)`, and **the projection to and from a `FilterSnapshot`**. **Pure — no DOM, no network, no map.** The one place that answers "does this vehicle qualify?". |
| `ride-spec-panel.ts` | 1 | The "my ideal scooter" sheet: model chips, required features, min battery, min quality, "must get me there", max walk, and the per-field must/prefer switch. Save / load / delete against `/api/v1/profile/ride-specs`, syncing on the `setRatePlanSyncHook` pattern. Owns both ends of the map bridge's UI. |
| `along-the-way.ts` | 2 | The **client-cheap corridor scorer**. `rankCorridor(features, {from, to, spec})` → `CorridorCandidate[]`, straight-line, no network, using `reach.ts`'s `DETOUR_FACTOR` and `straightLineMeters`. Pure. |
| `trip-plan.ts` | 3 | The state machine (`SEARCHING → CLAIMED → LOST → RECLAIMING → …`), the swap budget, the permanent `exclude` list, the auto-accept envelope. Pure reducer plus an injected effects interface. **The owner of "what am I walking to and why".** |
| `swap-card.ts` | 3 | Only the *offer* face — the decision the rider has to make when a swap falls outside the auto-accept envelope. An accepted swap has no card; it re-renders the arrival panel. |
| `my-scooters.ts` | 4 | Favourite vehicles: the list, the scan-gated add flow, nicknames, the per-favourite availability opt-in, and the live-state rendering **including the withheld-position case**. |
| `equity-savings.ts` | 5 | Cost optimizer: start-in-area bonus, stopover finder, break-even math. Pure; imports `ride-cost.ts` for money and `equity-areas.ts` for geometry, and owns neither. |
| `arrival-panel.ts` *(existing)* | 3 | Gains a **swapped** face and a `reportSwap()` beside its `reportGone()`. |
| `dibs-notify.ts` *(existing)* | 3 | Gains `swapped` and `swap_offer` alerts, and the rule that they **replace** `taken`. |
| `device-watch.ts` *(existing)* | 3 | Unchanged in behaviour. Its `onGone` callback stops being a dead end. |
| `filter-presets.ts` *(existing)* | 1 | **Untouched.** Saved filter presets and saved specs coexist; §1.3 says why. |
| `favorites.ts` *(existing)* | 4 | **Untouched.** Saved *places*, not vehicles; §4.1 says why they must not be merged. |
| `qr-scan.ts` *(existing)* | 4 | **Untouched.** Reused as-is — it already opens the camera, decodes, and hands back the raw payload with no opinion about what it means. |
| `api.ts` *(existing)* | 1–5 | `fetchTripCandidates`, the ride-spec CRUD, the favourite-device CRUD, `replaces` on `registerDibs`. |
| `main.ts` *(existing)* | 1–5 | Two `wireX()` calls (`wireTripPlan`, `wireMyScooters`), the `onGone` handler at `main.ts:3257` re-pointed at `trip-plan.ts`, and the spec bridge hooked to the existing `snapshotFilters` / `applyFilterSnapshot` pair (`main.ts:1011`). Nothing else. |

---

## Phase 1 — My ideal scooter

### 1.1 `ride-spec.ts`

```ts
export type SpecField = "models" | "features" | "min_battery" | "min_quality" | "must_reach";

export interface RideSpec {
  models: ModelKey[] | null;          // null = any
  features: FeatureFilterKey[];       // consensus must be TRUE
  minBattery: number;                 // percent
  minQuality: QualityFilter;          // "any" | "no-risk" | "ok-only"
  mustReach: boolean;
  maxWalkMinutes: number;
  /** Which of the above are HARD. Everything else is a preference. */
  must: SpecField[];
}
```

Four functions carry the whole module:

- `matches(props: DeviceProperties, spec: RideSpec): SpecMatch` — per-field
  verdicts, never a bare boolean, so a caller can say *what* failed.
- `relax(spec: RideSpec, rung: number): RideSpec` — the ladder from master
  plan §5.2, as data. Rung 0 is the spec as written.
- `toFilterSnapshot(spec, current): FilterSnapshot` — §1.3.
- `fromFilterSnapshot(snap): RideSpec` — §1.3.

**Unknown never satisfies a requirement.** `feature_payload()` on the API
serializes an unconfirmed feature as `null`, and its docstring already records
that a filter must read `null` and `false` identically. `matches` inherits
that reading, and the panel's copy must say **"confirmed to have a basket"**,
not "has a basket" — otherwise the spec quietly excludes most of the fleet and
the rider has no idea why.

Reuse, do not re-derive: `ALL_MODELS` from `model-catalog.ts`, the feature keys
from `device-features.ts`, `QualityFilter` from `devices.ts`. A second
hardcoded model list is the exact bug `filter-presets.ts`'s `knownModels` field
exists to have fixed once already — and `toFilterSnapshot` must set
`knownModels` for the same reason.

### 1.2 Storage

Signed in: `/api/v1/profile/ride-specs` (named, max 5). Signed out:
`localStorage["scooter_fyi.ride_spec"]`, single unnamed spec, same shape.
Server wins on conflict, following `applyServerRatePlan`'s precedent in
`ride-cost.ts`.

Dibs requires an account (`dibs.ts`'s `signed_out` verdict) and so does the QR
scan endpoint, so Phases 3 and 4 are signed-in regardless — but Phases 1, 2
and 5 all work anonymously and must keep working that way.

### 1.3 The map bridge — **"Show only my ideal scooters"**

*(This section reverses revision 1, which kept the spec and the map filters
strictly apart and thereby made the rider express the same thing twice.)*

They stay **two objects**. The reasons hold: a `FilterPreset` carries `area`,
`hideUnavailable` and `rideTypes` — map state with no meaning for a trip — is
localStorage-only so it cannot sync, and has nowhere to put must/prefer. And a
rider narrowing the map to look at something should not thereby change what the
app walks them to two minutes later.

But the bridge is **one tap in each direction**, and it is a first-class part
of the feature rather than an export button. The seam already exists:
`main.ts` supplies `snapshotFilters` / `applyFilterSnapshot` to
`wireFilterPresets` (`main.ts:1011`), and the bridge takes the same pair.

**Spec → map.** A toggle in the Filters drawer *and* on the spec sheet:

> ☑ **Show only my ideal scooters**
> *The map can only show or hide — your preferences are treated as
> requirements here.*

`toFilterSnapshot(spec, current)` projects onto the live filter state,
preserving the map-only fields (`area`, `rideTypes`, `hideUnavailable`) from
`current` because the spec has nothing to say about them. The projection is
**lossy in exactly one direction, and the helper line above is the whole
disclosure**: the map has no way to draw "preferred", so musts and prefers
both become plain filters. A rider who wanted the softer behaviour still has
it everywhere the ranking runs.

**Map → spec.** A button in the Filters drawer, beside Save preset:

> **Save these as my ideal scooter**

`fromFilterSnapshot(snap)` drops the map-only fields and opens the sheet with
**everything marked *prefer***. The rider then promotes what is actually
non-negotiable. Defaulting to `must` would put a hard requirement on the
rider's behalf that they never stated, and hard requirements are what make a
search come back empty.

**Attachment and detachment** — the standard preset pattern, and the one thing
here most likely to be got wrong:

- while the toggle is on, the drawer names the spec driving it;
- any manual filter change **detaches** — the toggle clears, a line says
  "changed from *Commuter*", and one tap reattaches;
- a filter set that still claims to be a spec it no longer matches is a lie
  the UI is telling, and `filter-presets.ts` has no such state to copy, so
  this is new code and needs its own test.

### 1.4 Tests

`ride-spec.test.ts`: `matches` treats `null` and `false` identically for a
required feature; a model that did not exist when the spec was saved is not
silently excluded (the `effectiveModels` lesson); the ladder never relaxes a
`must`; the ladder never drops `minQuality` below `no-risk`; `relax` is
monotonic (rung n+1 admits every device rung n admits); `toFilterSnapshot`
round-trips through `fromFilterSnapshot` for every field the spec owns and
preserves every field it does not; `toFilterSnapshot` sets `knownModels`.

Bridge tests (in the panel's file, with a stubbed snapshot/apply pair): a
manual filter change after applying detaches; reattaching restores exactly the
projection; turning the toggle off restores the filters as they were before it
went on.

---

## Phase 2 — Along the way

### 2.1 `along-the-way.ts` — the client tier

```ts
export function rankCorridor(
  feats: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
  ctx: { from: LngLat; to: { lat: number; lon: number }; spec: RideSpec;
         favorites?: Set<string> },
): { candidates: CorridorCandidate[]; relaxed: SpecField[] };
```

The ranking scalar is **seconds of whole trip** — `walkSeconds(from → vehicle)
+ rideSeconds(vehicle → dest)` — and nothing else is on a different scale.
Straight lines through `reach.ts`'s `DETOUR_FACTOR = 1.35` (the ratio measured
against donated tracks, already the number this codebase lives with), walking
pace from `locate.ts`'s `walkMinutes`, riding pace the fleet figure `reach.ts`
already assumes.

This is what makes "along the way" fall out rather than be bolted on: a
scooter 500 m further away but in the direction of travel has a shorter trip
total than one 300 m behind the rider, with no special case and no bearing
arithmetic.

It runs on every device refresh and every filter change, over the **unfiltered**
fleet — `devices.visibleFeatures()` is the filtered view, and a rider's
leftover map filters must not silently remove candidates the spec accepts.
(`ride-screen-select.ts` has this same requirement and the same note; if it has
already added the read-only all-features accessor to `devices.ts`, reuse it.)

`favorites` is a bonus, never a filter (master plan §8.6, 90 s). A favourite
that fails a `must` is still disqualified.

If the ladder had to be climbed to fill the list, `relaxed` says which rungs,
and the list header says it in words.

### 2.2 The server tier

`api.ts` gains `fetchTripCandidates(body, signal)` → `POST /api/v1/trip/candidates`
(shape in the master plan §6.1). It is called **at the moment a decision is
made** — the rider opens the trip list, or a swap fires — never on a refresh
tick. The client tier owns the interactive list; the server tier corrects it
with real routed legs before anyone walks anywhere.

Rules for reconciling the two:

1. They may disagree on **order**. That is what the correction is for.
2. They may not disagree on **disqualification**. A vehicle the client struck
   out never reappears from the server; if it does, that is a bug in
   `ride-spec.ts`'s mirror of the server's predicates, and the test suite
   should be the thing that catches it.
3. Where they disagree on a **duration**, the routed number is shown. Never
   average them, never show the cheap one next to the expensive one.
4. A failed or rate-limited call degrades to the client tier with a visible
   "estimated" label. It must never block the list.

### 2.3 Where it appears

The home bar already asks the two questions this needs — *where are you going*
and *need wheels or got your own* — and hands the answer to
`pending-trip.ts`. The corridor list is what `wheels: "need"` should open, in
place of today's hand-off. `pending-trip.ts` keeps its exact current contract
(ephemeral, one-shot, `takePendingTrip` consumes); what it hands over becomes
the seed of a `trip-plan.ts` document.

`recommend.ts` is **not** replaced in this phase. It answers "which of these is
best from here", a different question, and it is reachable from the Find-wheels
wizard which this program does not touch. Master plan risk #13 covers the case
for eventually folding it in; that is a later argument with data.

### 2.4 Tests

`along-the-way.test.ts`: a vehicle beyond the destination ranks below one at
half the walk in the right direction; a vehicle behind the rider ranks below a
further one ahead; a vehicle that cannot reach the destination is absent under
`mustReach` and merely penalized without it; a favourite outranks an identical
non-favourite and does **not** outrank one that is 3 minutes better; `relaxed`
is empty when the unrelaxed spec fills the list; changing only the destination
reorders the list (the regression that would prove the scorer had quietly
reverted to distance).

---

## Phase 3 — Claim and swap

### 3.1 `trip-plan.ts`

```
      ┌──────────┐  candidate chosen   ┌──────────┐   arrived
      │ SEARCHING├────────────────────►│ CLAIMED  ├──────────────► HANDED OFF
      └────▲─────┘   + dibs registered └────┬─────┘               (ride mode)
           │                                │ device-watch: gone
           │  replacement found             ▼
      ┌────┴─────┐                     ┌──────────┐
      │RECLAIMING│◄────────────────────┤   LOST   │
      └────┬─────┘                     └──────────┘
           │ nothing meets the spec, even relaxed
           ▼
       EXHAUSTED
```

A pure reducer over an event union (`chosen`, `claimed`, `gone`, `candidates`,
`accepted`, `declined`, `arrived`, `abandoned`) plus an injected effects
interface — `registerDibs`, `releaseDibs`, `fetchTripCandidates`, `notify` —
so the whole thing is testable with four stubs and no map.

**Not persisted**, for the reason `pending-trip.ts` records for itself: an
intent is worth seconds, not days, and a trip plan resurrected tomorrow is the
bug nobody reports and everybody feels. A page reload ends the plan; the claim
survives in `dibs.ts`'s own localStorage, which is what `my-dibs.ts` reads.

### 3.2 The swap, in order

On `onGone(reason)` — the callback wired at `main.ts:3257`, which today clears
the walk line and prints a sentence:

1. `exclude.add(lost)` — **permanently for this trip**, even if it reappears.
2. `releaseDibs(claimId)` **before** claiming anything. Order is load-bearing:
   `canCallDibs` counts the rider's other claims, and `DIBS_MAX_CONCURRENT = 3`
   can refuse a swap on behalf of the very claim it is replacing.
3. `fetchTripCandidates` from the rider's **current** fix, not the origin.
4. Auto-accept, or offer (§3.3).
5. `registerDibs(..., { replaces: claimId })` — one server transaction that
   expires the old claim and writes the new one.
6. **One** notification (§3.4).

`maxWalkMinutes` is clamped to `DIBS_MAX_WALK_MINUTES` (15) for every search
made while auto-dibs is on. A candidate further than that cannot legally be
claimed, and offering one is offering a plan the next step refuses.

### 3.3 The auto-accept envelope

Auto-claim only when **all** hold:

- every `must` met, nothing relaxed;
- `tripSeconds` no more than **5 minutes** worse than the plan it replaces;
- routed walk within `DIBS_MAX_WALK_MINUTES`;
- **at most the second swap** on this trip.

Otherwise `swap-card.ts` opens with the best candidate pre-selected, one tap to
take it, one to see the list. A third loss is not a fourth swap: the app says
the corridor is not cooperating and hands back the map with the search it
tried, rather than marching the rider to a fourth kerb.

Every auto-swap is undoable while it is on screen, and every swap names the
difference in plain words:

> **Cosmo → Astro.** No basket (you preferred one). 3 min further.

Two ceilings the tests must keep apart: `DIBS_MAX_TOTAL_MS` (25 min) is **per
claim**, and a swap makes a fresh claim with a fresh window. The **trip** has
no such ceiling — the two-swap budget is what bounds it, and it is a product
rule living here, not a consequence of the dibs rules.

### 3.4 Notifications — one message, never two

`dibs-notify.ts` fires four alerts, once each, and its own header records why
there are not five: *"a phone that buzzes five times in twenty-five minutes
about a scooter is a phone that gets its notifications turned off — which
costs the rider the one message that actually matters."*

The swap therefore **replaces** `taken` rather than following it:

| Outcome | Alert |
|---|---|
| Replacement found, auto-accepted | `swapped` — and `taken` never fires |
| Replacement found, needs a decision | `swap_offer` — and `taken` never fires |
| Nothing found | `taken`, exactly as today, then EXHAUSTED |

The loss and the replacement resolve on **different ticks** (the search is a
network call), so `taken` is held for **one tick** whenever a search is in
flight. One tick is invisible; two buzzes are not.

Draft copy, in the voice of the existing four:

- `swapped` — `🔁 Someone took Lunar 🐸 928. You're on Cosmic 🦊 214 now — 3 min from you, still gets you there.`
- `swap_offer` — `🔁 Lunar 🐸 928 is gone. Nearest match that fits: Cosmic 🦊 214, 6 min. Tap to take it.`

Vibration follows the existing urgency mapping: `swapped` a single buzz (it is
information), `swap_offer` a double (it is a question).

### 3.5 `arrival-panel.ts`

Gains `reportSwap(summary)` beside the existing `reportGone(message)`, and a
third face between WALKING and ARRIVED: the same panel, new vehicle name, new
ETA, one line saying what changed, and **Undo**. Not a new floating panel — a
second panel over the map during a walk is exactly the wrong answer, and this
one is already where the rider is looking.

### 3.6 What this must never claim

Dibs is not a reservation. Nothing in this program holds a vehicle, and no
copy anywhere in it may imply otherwise — not the spec panel, not the swap
card, not the notifications, and **not My Scooters**. `sql/076`'s header and
`dibs.ts`'s both spend their opening paragraphs on this point, and an
auto-claiming feature is exactly the one that would erode it. "We called it
for you" is true. "We're holding it" is not.

### 3.7 Tests

`trip-plan.test.ts`: release precedes claim (assert call order on the stubs);
a lost vehicle never returns as a candidate; the third loss offers rather than
auto-accepts; a replacement 6 minutes worse offers rather than auto-accepts; a
replacement that relaxes a `must` is never auto-accepted; `taken` does not fire
when a swap lands on the next tick; `taken` does fire when the search comes
back empty; EXHAUSTED reports what was tried.

`dibs-notify.test.ts` additions: `swapped` and `taken` are mutually exclusive
for one claim; the four-per-claim ceiling still holds with the new alerts.

### 3.8 Phase 3b — the "upgrade", off by default

The same corridor search on a slow cadence while walking, offering a swap
before anything is lost. Gated hard, or it is nagging: only when the current
target **fails a must** it previously met (battery dropped below the floor, a
negative report landed) **or** the alternative saves ≥ 5 minutes; at most once
per trip; never after arrival; never within 90 s of another card.

Ships last, off, behind telemetry that can answer whether anybody accepts it.

---

## Phase 4 — My Scooters

Independent of Phases 1–3 and cheap: the scanner, the decoder, the validation
endpoint and the points bonus all exist. This is a list, a gate, and one rule
that must not be got wrong.

### 4.1 `my-scooters.ts`, and why it is not `favorites.ts`

`favorites.ts` is saved **places** — "Home", "Work", "the gazebo" — local,
capped at 12, no account needed, and drawn as map pins. This is saved
**vehicles**: server-side (the point is finding them from any phone),
account-scoped, capped at 10, and gated on a physical scan. They share a word
and nothing else. Merging them would put two different cardinalities, two
different storage layers and two different privacy postures in one module.

`favorites.ts` is untouched.

### 4.2 The add flow

Entry points, all of them at moments the rider is already standing at the
scooter with the camera in reach:

- the device popup's ⭐ action, beside ☑️ Confirm Features;
- the end of a successful QR scan — *"Keep this one?"*;
- the end of a features confirmation — same prompt.

The flow is: `openQrScanner()` (existing, untouched) → raw payload →
`POST /api/v1/profile/favorite-devices` with the payload, the current fix, and
an optional nickname. The client **validates nothing** about the payload, for
the reason `qr-scan.ts`'s own header gives: a client-side rule is two deploys
away from disagreeing with the server's, and the raw payload is exactly what
the API wants.

Two failures need real copy, not a generic error:

- `too_far_from_device` (403) — *"You'll need to be standing at this one. It
  was last seen about 200 m from you."* The scan alone is not enough and the
  rider should be told why in a sentence, not left to guess.
- `favorite_limit_reached` (409) — names the cap and offers the list to prune.

`already_favorited` is not an error: it refreshes `verified_at` and says
*"Already yours."*

### 4.3 The list

A tab in the Account drawer plus a chip on the map. Per row: the vehicle's
name, the rider's nickname, battery, how far, and its state.

**The rendering rule that carries the privacy decision:**

| State | Row shows |
|---|---|
| `available` | position, battery, walk time, tap to plan a ride to it |
| `unavailable` | position, battery, and why it is not rentable |
| `in_use` | **"In use"** and nothing else — no position, no battery, no map marker |
| `gone` | "Not seen since <date>", with Remove |

The API withholds the position server-side (master plan §8.4) and sends
`position_withheld: true`. The client must render that as a **stated** thing —
*"In use — we'll show you where when it's parked"* — never as a blank, a
spinner, or a stale last-known dot. A rider who sees an empty space assumes a
bug and reloads; a rider who sees the sentence understands the product.

Do not cache the last known position across an `in_use` transition and keep
drawing it. That is the obvious "helpful" optimization and it defeats the
entire rule.

### 4.4 Availability alerts

Per-favourite opt-in, **off by default** — a favourite is a memory, and
turning one into a notification is a second decision. Delivered through the
same in-app + Notification API path `dibs-notify.ts` already uses, and subject
to caps the server enforces (one per favourite per 6 hours, none 22:00–07:00
Denver).

The alert carries **no location**: `🛴 My Rover is free again`. The rider opens
the app to see where, which they were going to do anyway.

### 4.5 On the map

- A "My Scooters" filter chip beside the existing filter chips.
- Favourites drawn with a distinct marker **whether or not the chip is on** —
  spotting yours is the whole point — but only when parked, per §4.3.
- The device popup shows the nickname where it has one.

### 4.6 Tests

`my-scooters.test.ts`: an `in_use` row renders no coordinates and no battery,
and renders the explanatory sentence; a row that transitions
`available → in_use` **drops** the previously rendered position rather than
retaining it; `position_withheld` with a `lat` present (a server bug) is still
rendered as withheld — the client trusts the flag, not the absence; the cap
error names the cap; `already_favorited` renders as success.

---

## Phase 5 — Equity Area savings

The arithmetic, the break-evens, the Access-tier exclusion and the four things
this must be honest about are all in the master plan §9. Read that first; this
section is only what the frontend builds.

### 5.1 `equity-savings.ts`

Pure. Imports `equityAreaEstimateWithTax` / `estimateWithTax` from
`ride-cost.ts` for money, and `isInEquityArea` from `equity-areas.ts` for
geometry — and owns neither. Three answers:

- `startsOrEndsInArea(from, to)` — if either end is already inside, there is
  nothing to advise and the optimizer stays quiet.
- `startInAreaSaving(candidate, spec, plan)` — the Phase 5a win: this vehicle
  is inside the polygon, so the whole trip is discounted for one unlock. In
  dollars, next to the extra walking minutes it costs.
- `stopoverSaving(routeGeometry, plan)` — Phase 5b. Two tiers: sample the
  route the app **already has** against the bundled polygons (the same
  `isInEquityArea` the on-screen indicator uses) and see whether it already
  crosses one — in which case the detour is zero and the only cost is the
  second unlock. Only if it does not is a second routing call worth spending.

`RatePlanKey === "equity"` returns `null` from every one of them. The Access
tier is 60 free min/day then 15¢/min with no unlock; the Equity Area rate is
$1 + 13¢/min; whether they interact is stated nowhere in the contract we have,
and `config.ts` deliberately declines to infer it. Advice we cannot price is
advice we do not give.

### 5.2 Where it surfaces

Phase 5a is a **chip on a candidate row** — *"starts in an Equity Area · saves
$1.80 · 2 min more walking"* — because that is where the rider is choosing.
Phase 5b is a **card on the route screen**, after a route exists, carrying all
four of these on the same card as the saving:

- the saving, with the tier it is computed for;
- the second unlock, priced at the **worse** VeoPlus reading (charged);
- the re-rent risk, in words, plus whether another vehicle meeting the spec is
  currently standing in that area;
- the screenshot caveat, in spirit with `EQUITY_DISCOUNT_NOTICE` — *this
  should cost $X; if Veo bills you the base rate, screenshot it.*

Never advise a split whose saving is under **$0.50**.

### 5.3 Tests

`equity-savings.test.ts`: the Access tier gets `null` from every entry point; a
trip already starting in an area advises nothing; the resident break-even sits
near 8.3 riding minutes and the visitor's near 3.9 (master plan §9.1); the
VeoPlus reading used is the charged-unlock one; a sub-$0.50 saving is
suppressed.

---

## Telemetry

Added to `TELEMETRY_EVENTS` here and `ALLOWED_EVENTS` in the API, same PR,
enumerated props only — no coordinates, no destination, no spec contents, and
**no `vehicle_identifier`**:

| Event | Props |
|---|---|
| `trip_plan_start` | `wheels`, `has_spec` |
| `trip_candidates` | `tier` (`client` \| `server`), `relaxed` (count) |
| `trip_swap` | `reason` (the `DeviceGoneReason`), `auto` (bool), `swap_index` |
| `trip_swap_offer` | `accepted` (bool) |
| `trip_exhausted` | `swaps`, `relaxed` (count) |
| `spec_applied_to_map` | `source` (`drawer` \| `sheet`) |
| `spec_saved_from_map` | — |
| `favorite_added` | `entry` (`popup` \| `after_scan` \| `after_features`) |
| `favorite_removed` | `reason` (`rider` \| `gone`) |
| `favorite_available_alert` | `opened` (bool) |
| `equity_savings_shown` | `kind` (`start` \| `stopover`) |
| `equity_savings_taken` | `kind` |

These are the only way to answer whether the feature works: how often a claim
is taken, how often a replacement is found, how much worse it was, whether the
map bridge gets used, and whether anybody takes the money.

---

## Sequencing against the API lane

| Frontend | Needs from `scooter-fyi-api` | Can be built before it? |
|---|---|---|
| `ride-spec.ts` | — | yes |
| the map bridge | — | yes — it is entirely local |
| `ride-spec-panel.ts` | `sql/080` + `/profile/ride-specs` | yes, against localStorage only |
| `along-the-way.ts` | — | yes |
| server tier in `api.ts` | `POST /trip/candidates` | mock the contract; it is master plan §6.1 |
| `trip-plan.ts` | `replaces` on `POST /dibs` | yes — without it a swap is a release then a claim, two calls, non-atomic; ship the atomic form when `sql/081` lands |
| `my-scooters.ts` | `sql/082` + `/profile/favorite-devices` | **no** — the gate and the withheld position are both server-side, and there is nothing honest to build against a stub |
| `equity-savings.ts` | nothing (geometry is bundled) | yes |

Phases 1, 2 and 5a have no hard API dependency and can land first. Phase 3
wants the atomic swap. **Phase 4 is the one phase that cannot start on this
side** — which is the correct shape, because both of its load-bearing rules
have to live where a client cannot route around them.
