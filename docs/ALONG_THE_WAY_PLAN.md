# Along the Way — Frontend Plan (denver-scooter-fyi)

Companion to `scooter-fyi-api/ALONG_THE_WAY_PLAN.md` (the **master** program
plan — read it first; the vision, vocabulary, decisions, phasing, equity
arithmetic and risks live there). This document is the actionable frontend
lane: which modules exist, what each owns, what it may not do, and what the
tests have to prove.

Planned 2026-08-29 against `main` (13e2215). Branch:
`claude/along-way-upgrades-feature-piml2p`.

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
  both repos in the same PR, carry no free text, and no coordinates.
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
| `ride-spec.ts` | 1 | The Spec type, its must/prefer split, the relaxation ladder, and `matches(device, spec)`. **Pure — no DOM, no network, no map.** The one place that answers "does this vehicle qualify?", imported by the panel, the client scorer, and the trip plan. |
| `ride-spec-panel.ts` | 1 | The spec sheet: model chips, required features, min battery, min quality, "must get me there", max walk. Seeds from the current map filters on first open ("use what I've got set"), then diverges — see §1.2. Save / load / delete against `/api/v1/profile/ride-specs`, syncing on the `setRatePlanSyncHook` pattern. |
| `along-the-way.ts` | 2 | The **client-cheap corridor scorer**. `rankCorridor(features, {from, to, spec})` → `CorridorCandidate[]`, straight-line, no network, using `reach.ts`'s `DETOUR_FACTOR` and `straightLineMeters`. Pure. |
| `trip-plan.ts` | 3 | The state machine (`SEARCHING → CLAIMED → LOST → RECLAIMING → …`), the swap budget, the permanent `exclude` list, the auto-accept envelope. Pure reducer plus an injected effects interface; no DOM, no direct `fetch`. **The owner of "what am I walking to and why".** |
| `swap-card.ts` | 3 | Only the *offer* face — the decision the rider has to make when a swap falls outside the auto-accept envelope. The accepted-swap case has no card; it re-renders the arrival panel. |
| `equity-savings.ts` | 4 | Cost optimizer: start-in-area bonus, stopover finder, break-even math. Pure; imports `ride-cost.ts` for money and `equity-areas.ts` for geometry, and owns neither. |
| `arrival-panel.ts` *(existing)* | 3 | Gains a **swapped** face and a `reportSwap()` beside its `reportGone()`. |
| `dibs-notify.ts` *(existing)* | 3 | Gains `swapped` and `swap_offer` alerts, and the rule that they **replace** `taken`. |
| `device-watch.ts` *(existing)* | 3 | Unchanged in behaviour. Its `onGone` callback stops being a dead end. |
| `api.ts` *(existing)* | 1–4 | `fetchTripCandidates`, `listRideSpecs` / `putRideSpec` / `deleteRideSpec`, `replaces` on `registerDibs`. |
| `main.ts` *(existing)* | 1–4 | One `wireTripPlan()` call and the `onGone` handler at `main.ts:3257` re-pointed at `trip-plan.ts`. Nothing else. |

---

## Phase 1 — The Spec

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

Two functions carry the whole module:

- `matches(props: DeviceProperties, spec: RideSpec): SpecMatch` — per-field
  verdicts, never a bare boolean, so a caller can say *what* failed.
- `relax(spec: RideSpec, rung: number): RideSpec` — the ladder from master
  plan §5.2, as data. Rung 0 is the spec as written.

**Unknown never satisfies a requirement.** `feature_payload()` on the API
serializes an unconfirmed feature as `null`, and its docstring already records
that a filter must read `null` and `false` identically. `matches` inherits
that reading, and the panel's copy must say **"confirmed to have a basket"**,
not "has a basket" — otherwise the spec quietly excludes most of the fleet and
the rider has no idea why.

Reuse, do not re-derive: `ALL_MODELS` from `model-catalog.ts`, the feature keys
from `device-features.ts`, `QualityFilter` from `devices.ts`. A second
hardcoded model list is the exact bug `filter-presets.ts`'s `knownModels` field
exists to have fixed once already.

### 1.2 Spec vs. filters — the line, and why it is where it is

The Filters drawer decides **what is drawn on the map**. A spec decides **what
you are willing to ride**. They overlap almost entirely in vocabulary and not
at all in consequence: a filter that hides something is a view; a spec that
excludes something sends you walking somewhere else.

So they are separate objects, and the panel **seeds** from the filters rather
than sharing state with them ("Start from my current filters"). Reasons a
shared object was rejected:

- `FilterPreset` carries `area`, `hideUnavailable` and `rideTypes` — map state
  with no meaning for a trip — and is localStorage-only, so it cannot sync.
- A rider narrowing the map to look at something should not thereby change
  what the app will walk them to two minutes later.
- The must/prefer split has no home in a filter, and it is the whole point.

`filter-presets.ts` is untouched by this program.

### 1.3 Storage

Signed in: `/api/v1/profile/ride-specs` (named, max 5). Signed out:
`localStorage["scooter_fyi.ride_spec"]`, single unnamed spec, same shape.
Server wins on conflict, following `applyServerRatePlan`'s precedent in
`ride-cost.ts`.

Dibs requires an account (`dibs.ts`'s `signed_out` verdict), so Phase 3 is
signed-in regardless — but Phases 1, 2 and 4 all work anonymously and must
keep working that way.

### 1.4 Tests

`ride-spec.test.ts`: `matches` treats `null` and `false` identically for a
required feature; a model that did not exist when the spec was saved is not
silently excluded (the `effectiveModels` lesson); the ladder never relaxes a
`must`; the ladder never drops `minQuality` below `no-risk`; `relax` is
monotonic (rung n+1 admits every device rung n admits).

---

## Phase 2 — Along the way

### 2.1 `along-the-way.ts` — the client tier

```ts
export function rankCorridor(
  feats: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
  ctx: { from: LngLat; to: { lat: number; lon: number }; spec: RideSpec },
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
best from here", which is a different question, and it is reachable from the
Find-wheels wizard which this program does not touch. Master plan risk #9
covers the case for eventually folding it in; that is a later argument with
data, not a Phase 2 change.

### 2.4 Tests

`along-the-way.test.ts`: a vehicle beyond the destination ranks below one at
half the walk in the right direction; a vehicle behind the rider ranks below a
further one ahead; a vehicle that cannot reach the destination is absent under
`mustReach` and merely penalized without it; `relaxed` is empty when the
unrelaxed spec fills the list; changing only the destination reorders the list
(the regression that would prove the scorer had quietly reverted to distance).

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
   They have been walking; the corridor moved with them.
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

Two ceilings that are easy to conflate, and which the tests must keep apart:
`DIBS_MAX_TOTAL_MS` (25 min) is **per claim**, and a swap makes a fresh claim
with a fresh window. The **trip** has no such ceiling — the two-swap budget is
what bounds it, and it is a product rule living here, not a consequence of the
dibs rules.

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

Vibration patterns follow the existing urgency mapping: `swapped` a single
buzz (it is information), `swap_offer` a double (it is a question).

### 3.5 `arrival-panel.ts`

Gains `reportSwap(summary)` beside the existing `reportGone(message)`, and a
third face between WALKING and ARRIVED: the same panel, new vehicle name, new
ETA, and one line saying what changed, with **Undo**. Not a new floating panel
— a second panel over the map during a walk is exactly the wrong answer, and
this one is already where the rider is looking.

### 3.6 What this must never claim

Dibs is not a reservation. Nothing in this program holds a vehicle, and no
copy anywhere in it may imply otherwise — not the spec panel, not the swap
card, not the notifications. `sql/076`'s header and `dibs.ts`'s both spend
their opening paragraphs on this point, and an auto-claiming feature is
exactly the one that would erode it. "We called it for you" is true. "We're
holding it" is not.

### 3.7 Tests

`trip-plan.test.ts`: release precedes claim (assert call order on the stubs);
a lost vehicle never returns as a candidate; the third loss offers rather than
auto-accepts; a replacement 6 minutes worse offers rather than auto-accepts; a
replacement that relaxes a `must` is never auto-accepted; `taken` does not fire
when a swap lands on the next tick; `taken` does fire when the search comes
back empty; EXHAUSTED reports what was tried.

`dibs-notify.test.ts` additions: `swapped` and `taken` are mutually exclusive
for one claim; the four-per-claim ceiling still holds with the new alerts in
play.

### 3.8 Phase 3b — the "upgrade", off by default

The same corridor search on a slow cadence while walking, offering a swap
before anything is lost. Gated hard, or it is nagging: only when the current
target **fails a must** it previously met (battery dropped below the floor, a
negative report landed) **or** the alternative saves ≥ 5 minutes; at most once
per trip; never after arrival; never within 90 s of another card.

This is the sub-feature the program is named for, and the one most likely to
be wrong. It ships last, off, behind telemetry that can answer whether anybody
accepts it.

---

## Phase 4 — Equity Area savings

The arithmetic, the break-evens, the Access-tier exclusion and the four things
this must be honest about are all in the master plan §8. Read that first; this
section is only what the frontend builds.

### 4.1 `equity-savings.ts`

Pure. Imports `equityAreaEstimateWithTax` / `estimateWithTax` from
`ride-cost.ts` for money, and `isInEquityArea` from `equity-areas.ts` for
geometry — and owns neither. Three answers:

- `startsOrEndsInArea(from, to)` — if either end is already inside, there is
  nothing to advise and the optimizer stays quiet.
- `startInAreaSaving(candidate, spec, plan)` — the Phase 4a win: this vehicle
  is inside the polygon, so the whole trip is discounted for one unlock. In
  dollars, next to the extra walking minutes it costs.
- `stopoverSaving(routeGeometry, plan)` — Phase 4b. Two tiers: sample the
  route the app **already has** against the bundled polygons (the same
  `isInEquityArea` the on-screen indicator uses) and see whether it already
  crosses one — in which case the detour is zero and the only cost is the
  second unlock. Only if it does not is a second routing call worth spending.

`RatePlanKey === "equity"` returns `null` from every one of them. The Access
tier is 60 free min/day then 15¢/min with no unlock; the Equity Area rate is
$1 + 13¢/min; whether they interact is stated nowhere in the contract we have,
and `config.ts` deliberately declines to infer it. Advice we cannot price is
advice we do not give.

### 4.2 Where it surfaces

Phase 4a is a **chip on a candidate row** — *"starts in an Equity Area · saves
$1.80 · 2 min more walking"* — because that is where the rider is choosing.
Phase 4b is a **card on the route screen**, after a route exists, carrying all
four of these on the same card as the saving:

- the saving, with the tier it is computed for;
- the second unlock, priced at the **worse** VeoPlus reading (charged), never
  the better one;
- the re-rent risk, in words, plus whether another vehicle meeting the spec is
  currently standing in that area;
- the screenshot caveat, verbatim in spirit with `EQUITY_DISCOUNT_NOTICE` —
  *this should cost $X; if Veo bills you the base rate, screenshot it.*

Never advise a split whose saving is under **$0.50**. Below that the advice
costs more in attention and risk than it returns.

### 4.3 Tests

`equity-savings.test.ts`: the Access tier gets `null` from every entry point; a
trip already starting in an area advises nothing; the resident break-even sits
near 8.3 riding minutes and the visitor's near 3.9 (master plan §8.1); the
VeoPlus reading used is the charged-unlock one; a sub-$0.50 saving is
suppressed.

---

## Telemetry

Added to `TELEMETRY_EVENTS` here and `ALLOWED_EVENTS` in the API, same PR,
enumerated props only — no coordinates, no destination, no spec contents:

| Event | Props |
|---|---|
| `trip_plan_start` | `wheels`, `has_spec` |
| `trip_candidates` | `tier` (`client` \| `server`), `relaxed` (count) |
| `trip_swap` | `reason` (the `DeviceGoneReason`), `auto` (bool), `swap_index` |
| `trip_swap_offer` | `accepted` (bool) |
| `trip_exhausted` | `swaps`, `relaxed` (count) |
| `equity_savings_shown` | `kind` (`start` \| `stopover`) |
| `equity_savings_taken` | `kind` |

These are the only way to answer whether the feature works: how often a claim
is taken, how often a replacement is found, how much worse it was, and whether
anybody takes the money.

---

## Sequencing against the API lane

| Frontend | Needs from `scooter-fyi-api` | Can be built before it? |
|---|---|---|
| `ride-spec.ts` | — | yes |
| `ride-spec-panel.ts` | `sql/080` + `/profile/ride-specs` | yes, against localStorage only |
| `along-the-way.ts` | — | yes |
| server tier in `api.ts` | `POST /trip/candidates` | mock the contract; it is the master plan §6.1 |
| `trip-plan.ts` | `replaces` on `POST /dibs` | yes — without it a swap is a release then a claim, two calls, non-atomic; ship the atomic form when `sql/081` lands |
| `equity-savings.ts` | nothing (geometry is bundled) | yes |

Phases 1, 2 and 4a have no hard API dependency and can land first. Phase 3 is
the one that wants the atomic swap.
