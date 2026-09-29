# Along the Way — Frontend Plan (denver-scooter-fyi)

Companion to `scooter-fyi-api/ALONG_THE_WAY_PLAN.md` (the **master** program
plan — read it first; the vision, decisions, equity arithmetic and risks live
there). This document is the actionable frontend lane: which modules exist,
what each owns, what it may not do, and what the tests have to prove.

Planned 2026-08-29 against `main` (13e2215). Branch:
`claude/along-way-upgrades-feature-piml2p`.
**Revision 2** — the spec is now rider-facing ("my ideal scooter") and applies
to the map in one tap (§1.3, a **reversal** of revision 1's decision), and
**Favorite Scooters** — favouriting individual vehicles behind a QR scan — joins as
Phase 4 (§4).
**Revision 3b** — **Phase 8, the receipt** (§8): check whether a trip was
charged per Exhibit C, copy a complaint, and — consented — contribute to an
evidence pile that can say whether the Equity Area discount is applied at all.
The image never leaves the device. Phase 5b's separate "stopover" search is
**deleted**: an Equity Area stopover is just a hand-off whose pickup was
chosen for the discount, so it is a cost term in the Phase 2 planner rather
than a second mechanism.
**Revision 3a — Phases 2 and 3 were built on a misreading, and are rewritten.**
Revisions 1–2 had the rider *walking* to the scooter matching their spec; the
ask was always that they **ride** to it, handing off to it en route (§2, §3;
master plan §6.0). Three product rules arrive with it: likely-rideable always,
cost **and** time on every plan, and the Access Program's free-minute budget.
Optional Phase 3b is folded into the one re-solve path.
**Revision 3** — two cleanup phases at the end, both frontend-only: **Phase 6,
one app, one mode** (§6) closes the seams left by the mode teardown, and
**Phase 7, the walkthrough** (§7) rewrites the intro tour against the UI that
results and switches it back on. Revision 3 also retires the API's
`find_ride_pref` preference kind, which meant what a `ride_spec` means and had
no caller in this repo — see the vocabulary note below.

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
  the rider's behalf, that they should end one rental and start another, and
  every one of them has to be testable without a map.

---

## Module map

New unless marked. Phase numbers refer to the master plan §4.

| Module | Phase | Responsibility |
|---|---|---|
| `ride-spec.ts` | 1 | The Spec type, its must/prefer split, the relaxation ladder, `matches(device, spec)`, and **the projection to and from a `FilterSnapshot`**. **Pure — no DOM, no network, no map.** The one place that answers "does this vehicle qualify?". |
| `ride-spec-store.ts` | 1 | Where specs live (account when signed in, one localStorage slot when not, server wins) and — the part the presets have no equivalent of — **the attachment**: which spec is driving the map, and whether it still is. No DOM. Split out of the panel while building it, because attach/detach is a rule and rules belong somewhere a test can reach without one. |
| `ride-spec-panel.ts` | 1 | The "my ideal scooter" sheet: model chips, required features, min battery, min quality, "must get me there", max walk, the per-field must/prefer switch, and the relaxation ladder rendered live so a rider can see what they are agreeing to give up. Owns both ends of the map bridge's UI and holds no rule of its own. |
| `along-the-way.ts` | 2 | The **client-cheap plan search**. `rankPlans(features, ctx)` → `TripPlan[]` + backups: multi-leg (`walk → ride → [hand-off → ride]* → walk`), ranked by generalised cost (seconds **plus money** plus penalties), straight-line, no network. Pure. |
| `free-minutes.ts` | 2 | The Access tier's free-minute budget: estimate today's used minutes from tracked rides, state which way the error runs, and hold the rider's own correction. Pure; the control that renders it lives with the plan list. |
| `ride-cost.ts` *(existing)* | 2 | **Untouched in behaviour**, newly load-bearing: its `RATE_PLANS` and `unlockCents` are what let the plan search price a hand-off per tier, and its `billableMinutes` is what the free-minute estimate sums. |
| `trip-plan.ts` | 3 | The state machine, the remaining legs, the current claim, the backups, the permanent `exclude` list. Pure reducer plus an injected effects interface. **The owner of "what am I riding, what am I heading for, and why".** |
| `backups-sheet.ts` | 3 | The *overrule* face: the plans the search already computed, offered after an automatic re-solve. There is no "do you accept this swap?" card any more — every re-solve is applied, announced and reversible (§3.1). |
| `my-scooters.ts` | 4 | Favourite vehicles: the presentation rules — `locationOf` (which keys off the `position_withheld` FLAG, never the absence), the title, and the sentence for every refusal. **Pure.** Split from the panel so the withholding rule is testable without a DOM, including the cached-dot regression that would defeat it. |
| `my-scooters-panel.ts` | 4 | The Tools-drawer list and the one button that keeps a scooter. Renders; decides nothing. Every judgement it shows comes from `my-scooters.ts` or from the server — it does not check the 75 m, parse the payload, or work out which scooter was scanned. |
| `equity-savings.ts` | 5 | Cost terms, not a second optimizer: the start-in-area bonus and `equityLegRate` for the Phase 2 planner's money term. Pure; imports `ride-cost.ts` for money and `equity-areas.ts` for geometry, and owns neither. |
| `arrival-panel.ts` *(existing)* | 3 | Gains a **re-solved** face and a `reportResolve()` beside its `reportGone()`. |
| `dibs-notify.ts` *(existing)* | 3 | Gains a `resolved` alert that **replaces** `taken`, and the rule that a re-solve changing nothing actionable is not announced at all. |
| `device-watch.ts` *(existing)* | 3 | Unchanged in behaviour. Its `onGone` callback stops being a dead end. |
| `filter-presets.ts` *(existing)* | 1 | **Untouched.** Saved filter presets and saved specs coexist; §1.3 says why. |
| `favorites.ts` *(existing)* | 4 | **Untouched.** Saved *places*, not vehicles; §4.1 says why they must not be merged. |
| `qr-scan.ts` *(existing)* | 4 | **Untouched.** Reused as-is — it already opens the camera, decodes, and hands back the raw payload with no opinion about what it means. |
| `api.ts` *(existing)* | 1–5 | `fetchTripPlans`, the ride-spec CRUD, the favourite-device CRUD, `replaces` on `registerDibs`. |
| `onboarding.ts` *(existing)* | 7 | The seven-screen tour. Rewritten against the UI Phase 6 leaves behind, and switched back on. `ONBOARDING_SCREENS` stays exported — it is what the audit test reads. |
| `home-bar.ts` *(existing)* | 6 | Gains the two named entry functions that replace clicking `#mode-switch`. Its no-default rule on the wheels toggle is untouchable. |
| `ride-hud.ts` *(existing)* | 6 | `rideModelFilterFor()` learns about the attached spec, and the pills stop being a second filter vocabulary. |
| `main.ts` *(existing)* | 1–5 | Two `wireX()` calls (`wireTripPlan`, `wireMyScooters`), the `onGone` handler at `main.ts:3257` re-pointed at `trip-plan.ts`, the spec bridge on the existing `snapshotFilters` / `applyFilterSnapshot` pair (`main.ts:1011`), and `devices.allFeatures()` fed to the plan search. Nothing else. |

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

**Four things in this app sound alike. The question each answers is the only
reliable way to tell them apart:**

| | The question | Where it lives | Scope |
|---|---|---|---|
| **Filters** | what is drawn on the map *right now*? | the Filters drawer | this session |
| **Preset** (`filter-presets.ts`) | a filter set worth reusing | `localStorage` | this browser |
| **Spec** (`ride-spec.ts`) | what will I **ride**? | account, kind `ride_spec` | the account |
| **Usual** (`ride-settings.ts`) | how should the ride **screen** behave? | account, kind `ride_mode_usual` | the account |

A preset is **not** a small spec: it has no `must`, no relaxation order and no
opinion about whether a vehicle is acceptable — it is a remembered *view*, and
promoting one is the lossy bridge in §1.3. A Usual is **not** a spec for the
screen: it never mentions a vehicle. The spec picks the scooter; the Usual
dresses the screen you look at once you are on it.

There used to be a fifth. The API carried a `find_ride_pref` preference kind —
a single unnamed "what am I willing to ride" blob — which is what a spec is.
This repo never called it. It is retired in the API's `sql/082`, so there is
exactly one account-level answer to "what will I ride", and it is the spec.

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
preserving `area` and `rideTypes` from `current` because the spec has nothing
to say about geography or about a control whose work the model list already
does.

`hideUnavailable` is **forced ON** rather than carried through — a correction
to this document's first draft, made while building it. Availability is the
one requirement a spec never relaxes, so a view labelled "your ideal scooters"
that includes one somebody is riding is simply a false label.

The projection is **lossy in two directions**, and only the first of them is
worth putting in front of a rider:

1. The map has no way to draw "preferred", so **musts and prefers both become
   plain filters**. That is what the helper line above says, and it is the
   difference a rider would otherwise notice and not understand.
2. The result is a **superset** of what the spec accepts: a model filter keeps
   mystery hardware visible (`devices.ts`, deliberately — it is what the
   model-report flow feeds on), while the spec rejects an unnamed vehicle
   against a model requirement. So a scooter can be on the map under this
   toggle and still not be one the trip search would offer. Documented in
   `toFilterSnapshot`'s own doc comment rather than in the UI: the population
   it affects is small, and the sentence explaining it costs more attention
   than it saves.

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

## Phase 2 — The hand-off plan

**Revision 3 rewrites this phase and Phase 3.** See master plan §6.0 for the
correction; the short version is that revisions 1–2 had the rider *walking* to
the scooter that matched their spec, and the ask was always that they **ride**
to it:

```
      90 s walk         6 min ride            9 min ride      1 min walk
 you ───────────▶ ASTRO ─────────▶ COSMO (your spec) ─────────▶ door
                (nearest OK one)  (picked up EN ROUTE)
```

Walking appears twice and is short both times. The spec-matching vehicle is a
**waypoint**, not a walk target.

### 2.1 `along-the-way.ts` — the client tier

```ts
export function rankPlans(
  feats: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
  ctx: { from: LngLat; to: { lat: number; lon: number }; spec: RideSpec;
         rate: RatePlan; freeMinutesLeft: number | null;
         favorites?: ReadonlySet<string>; exclude?: ReadonlySet<string> },
): { plans: TripPlan[]; backups: TripPlan[]; relaxed: SpecField[] };
```

A `TripPlan` is a sequence of legs — `walk → ride → [hand-off → ride]* →
walk` — carrying `totalSeconds`, `estimatedCents` and `handOffs`. A
single-vehicle trip is a plan with one ride leg and competes in the same list;
there is no separate "direct" concept to keep in sync.

**Pure.** No DOM, no network, no map. It runs on every device refresh, so it
has to be cheap, and it has to be testable without booting MapLibre.

**The scalar is generalised cost**, not seconds: every leg's seconds, plus
money converted to seconds, plus preference penalties. Money is genuinely in
it — an unlock fee is the reason a hand-off might not be worth taking, and
three of the five tiers pay nothing for one (master plan §6.3).

**Geometry.** Straight lines through `reach.ts`'s `DETOUR_FACTOR = 1.35` — the
ratio measured against donated tracks. Walking pace from `locate.ts`'s
exported `WALK_METERS_PER_MIN`, in **seconds and unrounded**: `walkMinutes`
rounds to whole minutes with a floor of 1, which is right for a label and
fatal for a ranking. Riding pace is **Valhalla's Hybrid default (18 km/h)**,
because every rider-facing profile in the API's `config.json` routes with
`bicycle_type: "Hybrid"` and none sets `cycling_speed` — the cheap tier should
agree with the expensive one rather than be independently right about how fast
a Veo goes.

> **Known divergence, deliberately not fixed here.** `locate.ts` carries its
> own `DETOUR = 1.3`, used for the "~N min walk" labels. Two detour constants
> disagree. Unifying them changes every walk time shown in the app, which is a
> user-visible change and not Phase 2's business — but it should be somebody's.

**Feed it the unfiltered fleet.** `devices.allFeatures()`, never
`visibleFeatures()`. A rider's leftover map filters are a view, not a statement
of what they will ride, and `main.ts:1458` already carries a note about this
exact trap.

**Rule 1 is a filter, not a penalty.** `risk`-tier vehicles are excluded from
every leg of every plan. Only if no non-`risk` vehicle is within a 5-minute
walk may one appear, and then the result says so (`riskTierOffered`) and the
UI must too. This is the platform's selling point; it does not get traded for
four minutes.

**`favorites` is a bonus, never a filter.** A favourite that fails a `must` is
disqualified like anything else.

### 2.2 The free-minutes control

The one new piece of UI this phase owes, and it exists because of an honest
admission already in `config.ts`: the cost ticker *"can't know how much of
today's free hour is left, so it prices minutes beyond 60"*. Pessimism is
right for a live ticker and wrong for planning — it prices a free trip as a
paid one and argues the rider out of the hand-off they should take.

- **Estimate** today's used minutes from the rider's own tracked rides.
  `billableMinutes(elapsedMs)` already exists.
- **Say which way the error runs.** Rides taken outside this app are invisible
  to it, so the figure is a *floor* on minutes used and a *ceiling* on minutes
  left. Never authoritative.
- **Let the rider correct it** — *"I've got about N free minutes left"* — on
  the planning screen, overriding the estimate for this trip.

Shown only for the `equity` tier, because it is the only one with a free-minute
budget. Signed-out riders get the pessimistic figure and a note saying why.

### 2.3 The server tier

`api.ts` gains `fetchTripPlans(body, signal)` → `POST /api/v1/trip/candidates`
(shape in master plan §6.4). Called **at the moment a decision is made** — the
rider opens the plan list, or a re-solve fires — never on a refresh tick. The
reconciliation rules are unchanged from revision 2, because they were never
about walking:

1. They may disagree on **order**. That is what the correction is for.
2. They may not disagree on **disqualification**.
3. Where they disagree on a **duration or a price**, the routed figure is
   shown. Never an average; never the cheap one beside the expensive one.
4. A failure degrades to the client tier with a visible "estimated" label, and
   never blocks the list.

### 2.4 Where it appears

The home bar already asks the two questions this needs — *where are you going*
and *need wheels or got your own* — and hands the answer to `pending-trip.ts`,
whose contract is unchanged. `wheels: "need"` opens the **plan list**: two to
four plans, each showing its legs, its total time and **its cost including
every unlock**, with the hand-off drawn on the map.

### 2.5 Tests

- A spec-matching vehicle 14 minutes' walk away but on the route produces a
  hand-off plan that beats the direct walk — the headline case, and the one
  revision 2 could not express at all.
- No plan contains a `risk`-tier vehicle while a non-`risk` one is within a
  5-minute walk; when none is, exactly one appears and `riskTierOffered` is set.
- A `resident` rider (1 unlock = $1) and an `equity` rider get **different
  plan orders over the same fleet** — the money term is real, not decorative.
- An `equity` rider with 5 free minutes left and one with 55 get different
  orders: the cliff is priced, not smoothed.
- Plans are ranked by generalised cost, and `estimatedCents` on every plan
  includes every unlock in it.
- Monotonic relaxation still holds over plans, not just vehicles.

---

## Phase 3 — The living plan

### 3.1 One rule, replacing the auto-accept envelope

Revision 2 claimed automatically inside a defined envelope and asked outside
it. **Withdrawn.** The rider is on a moving scooter; a question they cannot
safely read is never the safer default, so there is no bound at which asking
becomes right. Instead, on every disruption:

1. **Resolve it automatically** — re-solve the remaining legs from where the
   rider is now, claim what the new plan needs, release what it does not.
2. **Say so, once.**
3. **Let them overrule it**, from the `backups` the search already returned.
   One tap to see them, one to take one.

No envelope, no branch, no "was this change big enough to ask about". The undo
is what makes it trustworthy, not the gate.

### 3.2 `trip-plan.ts`

The state machine and the owner of *"what am I riding, what am I heading for,
and why"*. Pure reducer plus an injected effects interface, as before. It now
holds the **remaining legs**, the **current claim**, and the **backups**.

Disruptions it re-solves on (master plan §7.2) — note that "somebody took it"
is one entry, not the headline:

- the next vehicle is taken, disabled, or gone from the feed;
- a materially better plan appears (revision 2's Phase 3b, no longer separate);
- the battery will not reach the next hand-off;
- the rider is far enough behind that the claim will expire;
- the rider has gone somewhere the remaining legs no longer fit.

Each re-solves the **remaining route**, never just the next vehicle — that is
what leaves somebody on a route that stopped making sense.

### 3.3 Dibs, while riding

Dibs goes on the **next** vehicle, claimed while riding toward it. That is what
makes a hand-off trustworthy.

- **`DIBS_MAX_WALK_MINUTES = 15` is the wrong bound for a ridden approach.** It
  exists so nobody claims what they cannot reach in time; riding reaches much
  further inside the same 25-minute window. It must become a
  **time-to-arrival** check computed from the actual leg.
- **One claim at a time, always.** Release precedes claim, however many hops
  the plan intends. A chained plan does not hold three scooters hostage.

### 3.4 Tests

- Release precedes claim (assert call order on the stubs), at every hop.
- A re-solve recomputes **all** remaining legs, not only the next vehicle.
- A lost vehicle never returns as a candidate.
- Every re-solve produces exactly one notification, and a re-solve that changes
  nothing the rider would act on produces none.
- The backups offered after a re-solve exclude the vehicle just lost.
- Overruling a re-solve applies the chosen backup and re-claims correctly.
- A plan never holds two claims, at any point in any chain.

---


## Phase 4 — Favorite Scooters

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

- the device popup's ⭐ action, beside ☑️ Confirm Features (shipped);
- the panel's own **⭐ Keep a scooter** button, for a scooter the rider never
  tapped on the map (shipped — and the reason `vehicle_identifier` is optional
  on the API);
- the end of a successful QR scan or features confirmation — *"Keep this
  one?"* (not yet).

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

- A "Favorite Scooters" filter chip beside the existing filter chips.
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
- `equityLegRate(leg)` — Phase 5b, **and it is no longer a search**. Revision
  3b deleted `stopoverSaving`: an Equity Area stopover is just a hand-off
  (§2) whose pickup happens to sit inside a polygon, so this returns the
  per-minute rate a leg is billed at — $1 + 13¢/min when it starts or ends
  inside one — and the Phase 2 planner's money term does the rest. Equity
  hand-offs then appear in the ordinary plan list, ranked against everything
  else, instead of on a card of their own.

  The cheap tier still applies: sample the route the app **already has**
  against the bundled polygons (the same `isInEquityArea` the on-screen
  indicator uses). A route already crossing one costs nothing extra to detect.

`RatePlanKey === "equity"` returns `null` from every one of them. The Access
tier is 60 free min/day then 15¢/min with no unlock; the Equity Area rate is
$1 + 13¢/min; whether they interact is stated nowhere in the contract we have,
and `config.ts` deliberately declines to infer it. Advice we cannot price is
advice we do not give.

### 5.2 Where it surfaces

Phase 5b has **no surface of its own** — an equity hand-off is a plan in the
plan list like any other, with a chip naming why it is cheap. Phase 5a is a
**chip on a candidate row** — *"starts in an Equity Area · saves
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

## Phase 6 — One app, one mode

Master plan §10. **This phase is entirely ours** — no endpoint, no migration,
no stored field. It is the only phase in the program with nothing to wait for.

### 6.1 The frame

Most of the mode teardown already happened in this repo, and `wireModes()` in
`main.ts` documents it: **ONE MAP** (entering a ride flow no longer wipes
filters, forces `hideUnavailable`, hides drawer tabs or fetches a lean
payload), **NO ANALYSIS MODE**, and a home bar that asks "where are you
going?" instead of asking the rider which of our surfaces they want. The
destination already rides along through `pending-trip.ts`, so Screen 3 opens
pre-filled rather than asking twice.

What is left is scaffolding, and scaffolding that still costs. Four seams.

### 6.2 Seam 1 — `#mode-switch`, the hidden bar we click

`index.html` still carries `#mode-switch` with two `hidden` buttons, and the
home bar enters a ride by synthetically clicking one of them. The markup
comment is honest about why: every mode preset was wired to those buttons, and
clicking them moved the entry point without re-deriving any behaviour. Right
for the move; wrong to leave.

Two files already have to know about the seam — `wireFreshnessCollapse()` was
corrected to lift `#home-bar` rather than `#mode-switch`, and
`install-prompt.ts` carries the same note. A third will get it wrong.

**The work:** lift what `wireModes()` does for `data-mode="ride"` and
`data-mode="riding"` into two named functions the home bar calls directly;
delete the element; delete the `setActive`/`aria-pressed` bookkeeping that has
displayed nothing since the bar went `hidden`.

**Two traps, both already written down in the source:**

- `resetIconography` and `setSelect` are kept alive by bare `void` statements
  because they are the only writers of the iconography state, and deleting
  them makes whole drawer branches unreachable. `wireModes()` says so. Either
  untangle that knot **as its own change**, or leave both `void`s and the
  comment exactly as they are. A tidier-looking diff is not a reason.
- Closing the HUD currently hands the bar back to "whichever mode was active
  before". With no bar, that has to become explicit state, or the rider lands
  nowhere.

### 6.3 Seam 2 — two model filters, opposite empty sets

`devices.ts` holds `rideModelFilter` (HUD "Show" pills) alongside the Filters
drawer's `models`:

| | `null` | empty set |
|---|---|---|
| drawer `models` | every model | **every model** |
| `rideModelFilter` | no ride filter | **none** |

Both are documented, both are right in isolation, one map applies both. Same
gesture — deselect everything — opposite outcome, with nothing in the UI to
tell them apart.

**The work:** one concept, one meaning for the empty set. If the HUD really
needs "show none" (it may — the pills are a live control, not a search), it
becomes a **named** state, not an empty selection that inverts its meaning one
drawer away.

### 6.4 Seam 3 — the spec stops at the ride

Phase 1 stores, syncs and attaches a spec. `rideModelFilterFor()` in
`ride-hud.ts` never reads it. A rider who has said "only Cosmos, must have a
basket" opens the HUD to everything and says it again in pills.

This is the same failure `ride-preflight.ts` exists to fix a screen earlier —
its header calls re-asking an answered question "the single loudest piece of
friction left in the flow" — and it takes the same fix: read the answer that
already exists.

**The work:** with a spec attached, the ride surface opens honouring it and
names which spec. Changing the pills **detaches**, exactly as §1.3's
attach/detach rule already specifies for the map — reuse
`ride-spec-store.ts`'s `noticeFilterChange`, do not invent a second notion of
"this no longer matches".

### 6.5 Seam 4 — one settings vocabulary across two entrances

Two ways in, correctly different: the wizard (`ride-modal.ts`, Screens 1–6)
for a rider with nothing in mind, the pre-flight (`ride-preflight.ts`) for one
already standing at a scooter. **This phase does not merge them** — collapsing
them recreates exactly the friction the pre-flight removes.

What it fixes is drift. `ride-preflight.ts` already holds the line ("this
module does not invent a parallel settings vocabulary"), and
`track-preference.ts` is the worked precedent in the other direction: "Save
Tracks to Local Device" was asked every ride until somebody noticed the answer
never changed, and it became one standing setting in Settings → Local Data.

**The work:** put every question either flow asks to that test — *per-ride, or
standing?* — and move the standing ones out. Rename `RideOptions.theme` while
here: it is the Screen 4 route-preview basemap flavour, not the app theme,
which is why `ride-settings.ts` deliberately has no Theme row and a paragraph
explaining the absence. A field that needs a paragraph is misnamed.

### 6.6 Tests

- `#mode-switch` is absent from `index.html`, and no module queries it.
- Entering and leaving a ride leaves every filter, drawer tab and iconography
  setting exactly as it was — the ONE MAP guarantee, now asserted rather than
  described.
- One property over both filter paths: an empty model selection produces the
  same visible set in the drawer and in the HUD, or the HUD's "none" is a
  distinct named state that the drawer has no way to express.
- With a spec attached, the HUD's initial pill state equals
  `toFilterSnapshot(spec).models`; changing a pill detaches, once.
- No `RideOptions` field is written by two surfaces meaning two things.

### 6.7 Out of bounds

- No new stored field, no new endpoint. Nothing here is a retention question.
- No preset comes back. Every seam closes by **deleting** mode machinery.
- **No default on the wheels toggle.** `home-bar.ts` states why neither option
  is preselected; "reducing friction" is precisely the argument that would
  undo it, and it is wrong for the same reason it was wrong the first time.

---

## Phase 7 — The walkthrough, restored

Master plan §11. Also entirely ours.

The seven-screen tour (`onboarding.ts`) still exists and is still replayable
from About, but `ONBOARDING_AUTOSHOW = false` in `main.ts`, with a comment
saying it is off "while the tour is rewritten". This is that rewrite, and it
is **last** because a tour is a description and the thing being described
should stop moving first (master plan §4).

### 7.1 What is broken

**Mechanically:** `onStartExploring` ends the tour by clicking
`#mode-switch .mode-btn[data-mode="ride"]` — `hidden` today, deleted by Phase
6. The tour's final promise is a click into the seam §6.2 removes. Its other
two effects (switch the legend on, fire the one-time "tap any scooter" nudge)
are still fine and stay.

**Editorially:** two of seven screens describe a UI that moved. `ride-mode`
sells "Ride Mode" as a place you go — the mode vocabulary this app has spent
several PRs removing. `models` promises "save your favorite combos and reuse
them in one tap", which is presets: true, but now sitting beside specs, and
the tour is where a new rider forms their idea of the difference. The other
five (`welcome`, `features`, `rideability`, `routing`, `contribute`,
`territory`) still describe things that exist.

### 7.2 The rule

**The tour describes the app; the app does not chase the tour.** If a screen
is wrong, the screen changes — never the other way round. No surface survives
in this app because the walkthrough mentions it.

### 7.3 What ships

- The CTA lands on the home bar's "where are you going?" instead of clicking
  a deleted element.
- `ride-mode` is rewritten around what the rider actually gets: a landscape
  dashboard while riding, with no claim that it is a mode they switch into.
- `models` separates a saved **view** from a saved **spec** in one sentence,
  in master plan §2's vocabulary, and points at the one-tap bridge.
- Phases 1 and 4 earn a screen or a sentence each. A rider who only discovers
  "my ideal scooter" or "My Scooters" by accident is a rider we did not tell.
- `ONBOARDING_AUTOSHOW` goes back to `true`. It was always one line — the
  point of it being one line is that turning it on is a decision, not a
  revert.
- Still once per browser, still replayable from About, still skippable on
  every screen.

### 7.4 Tests

`ONBOARDING_SCREENS` is already exported so a "what does the tour promise"
audit can read the copy without opening the overlay. This phase is the first
such audit, and it leaves the audit behind as a test:

- Every selector or control named in a screen's copy or CTA resolves in
  `index.html`. This is the test that would have caught the dead
  `#mode-switch` click, and it is the one that keeps the tour honest the next
  time a surface moves.
- No screen body contains the string "Ride Mode" as a destination.
- `ONBOARDING_AUTOSHOW` is `true`, and the once-per-browser latch still holds
  across a simulated second visit.

---

## Phase 8 — The receipt

Master plan §12. **The only phase in this program that adds a new stored data
category**, and the most sensitive one — so the house rules below are not
boilerplate.

### 8.1 The architecture decision, first, because everything follows from it

**The image never leaves the device.** OCR runs on-device, the rider confirms
what was read, and only the **confirmed fields** upload. The evidence pile
needs numbers, not photographs.

Say that to riders in those words. "We store photos of your account and your
receipts" and "we store figures you checked yourself" are different products,
and only the second is worth building.

If on-device OCR cannot be made accurate enough to ship, the fallback is
**manual entry** — never an upload.

### 8.2 Modules

| Module | Responsibility |
|---|---|
| `receipt-read.ts` | On-device extraction: screenshot → `{ start, end, minutes, unlockCents, perMinCents, totalCents, from?, to? }`. **Pure given a bitmap.** Owns the format quirks and nothing else. |
| `receipt-verdict.ts` | The three-part bar (§8.4) → `"overcharged" \| "correct" \| "cannot_tell"` plus the reason. **Pure.** Never touches the DOM and never phrases an accusation. |
| `receipt-panel.ts` | Drop zone, the confirm-what-we-read step, the verdict, the copy button, the contribute toggle. Renders; decides nothing. |
| `account-confirm.ts` | Profile screenshot **or** typing, yielding the account identifier and **nothing else**. |
| `equity-areas.ts` *(existing)* | **Untouched.** `isInEquityArea` already answers the geographic half. |
| `ride-cost.ts` *(existing)* | **Untouched.** `RATE_PLANS` and `EQUITY_AREA_RATE` are what "expected charge" means. |
| `config.ts` *(existing)* | Gains the support address, in one place beside the rate plans. |

### 8.3 Confirm what we read — the step that must not be skippable

The extracted figures are shown **over the rider's own screenshot**, field by
field, editable, before anything is copied or submitted. Not a toast, not a
summary line: the actual numbers, where they came from, waiting for a tap.

This is the whole defence against risk 15. Receipt layouts change without
notice, and a misread total is a rider sent to lose an argument in public.

### 8.4 The bar, and why "cannot tell" is a feature

All three, or no claim is made:

1. the trip **demonstrably** starts or ends inside an Equity Area polygon;
2. the charged rate **demonstrably** is not $1 + 13¢/min;
3. the rider has **confirmed** the figures.

**Many receipts show time and money but no geography**, and the question is
geographic. So: match by time to the rider's own tracked ride when one exists
and use its geometry; when none does, check the arithmetic only and return
`cannot_tell` with the reason. VeoPlus stays unmodelled per master plan
§9.2.3 — a receipt differing only by that unlock is `cannot_tell`, not an
overcharge.

### 8.5 The complaint

One tap copies a prefilled body. **The rider sends it**, from their own
address, to the support address in `config.ts`. The app never sends it, and
this is not a limitation to route around: sending it would mean this project
asserting a contract claim on somebody's behalf, from an address they do not
control.

Trip, charge, expected charge, then the Exhibit A §5.2 citation underneath.
Facts and a reference, no adjectives — at the single-receipt level an
overcharge is indistinguishable from a bug, and the body should read like the
billing query it is.

### 8.6 Contributing, and withdrawing

Checking your own receipt contributes **nothing** by default. Contributing is a
separate deliberate tap, and the panel must show what leaves the device: the
date, the area, the charged rate and the expected rate. Not coordinates, not
the account identifier, not the image.

Withdrawal is offered wherever the submissions are listed and must actually
delete — a consent you cannot withdraw is not one.

### 8.7 Tests

- A receipt with no locations and no matching tracked ride returns
  `cannot_tell`, never `overcharged` — the single most important assertion in
  this phase.
- A receipt differing from the expected charge only by the $1 unlock, for a
  VeoPlus rider, returns `cannot_tell`.
- A trip starting inside a polygon and charged at the base rate returns
  `overcharged`, and the copied body contains the trip, both figures and the
  citation.
- The copy button is unreachable until the rider has confirmed the figures.
- `account-confirm.ts` yields the identifier and no other field, from a
  fixture containing a name, phone and card fragment.
- The contribute payload contains no coordinates, no account identifier and
  no image, asserted field-by-field against an allowlist rather than by
  spot-check.

---

## Telemetry

Added to `TELEMETRY_EVENTS` here and `ALLOWED_EVENTS` in the API, same PR,
enumerated props only — no coordinates, no destination, no spec contents, and
**no `vehicle_identifier`**:

| Event | Props |
|---|---|
| `trip_plan_start` | `wheels`, `has_spec` |
| `trip_candidates` | `tier` (`client` \| `server`), `relaxed` (count), `hand_offs` (count on the plan shown first), `risk_offered` (bool) |
| `trip_plan_chosen` | `hand_offs`, `rank` (which of the offered plans), `rate_tier` |
| `trip_resolve` | `reason` (`taken` \| `better` \| `battery` \| `behind` \| `off_route`), `leg_index`, `overruled` (bool) |
| `trip_exhausted` | `resolves`, `relaxed` (count) |
| `free_minutes_corrected` | `direction` (`up` \| `down`) — whether riders find our estimate high or low, which is the only way to learn if it is any good |
| `spec_applied_to_map` | `source` (`drawer` \| `sheet`) |
| `spec_saved_from_map` | — |
| `favorite_added` | `entry` (`popup` \| `after_scan` \| `after_features`) |
| `favorite_removed` | `reason` (`rider` \| `gone`) |
| `favorite_available_alert` | `opened` (bool) |
| `equity_savings_shown` | `kind` (`start` \| `hand_off`) |
| `equity_savings_taken` | `kind` |
| `receipt_checked` | `source` (`screenshot` \| `manual`), `had_tracked_ride` (bool) |
| `receipt_verdict` | `verdict` (`overcharged` \| `correct` \| `cannot_tell`), `reason` — **no amounts, ever** |
| `receipt_complaint_copied` | — |
| `receipt_contributed` | `withdrawn` (bool) |

These are the only way to answer whether the feature works: whether riders
actually choose hand-off plans over direct ones, how often a pickup is lost
and whether the automatic resolution is overruled, whether our free-minute
estimate runs high or low, whether the map bridge gets used, and whether
anybody takes the money.

`trip_resolve.overruled` is the one that decides whether §3.1 was right. If
riders routinely overrule the automatic choice, "act and let them undo" was
the wrong call and the envelope should come back.

---

## Sequencing against the API lane

| Frontend | Needs from `scooter-fyi-api` | Can be built before it? |
|---|---|---|
| `ride-spec.ts` | — | yes |
| the map bridge | — | yes — it is entirely local |
| `ride-spec-panel.ts` | `sql/080` + `/profile/ride-specs` | yes, against localStorage only |
| `along-the-way.ts` (plan search) | — | yes — it is pure and local |
| `free-minutes.ts` | — (reads `/tracked-rides`, which exists) | yes |
| server tier in `api.ts` | `POST /trip/candidates` | mock the contract; it is master plan §6.4 |
| `trip-plan.ts` | `replaces` on `POST /dibs` | yes — without it a swap is a release then a claim, two calls, non-atomic; ship the atomic form when `sql/083` lands |
| `my-scooters.ts` | `sql/081` + `/profile/favorite-devices` | **no** — the gate and the withheld position are both server-side, and there is nothing honest to build against a stub |
| `equity-savings.ts` | nothing (geometry is bundled) | yes |
| Phase 6 (one app, one mode) | **nothing at all** | yes — it adds no endpoint, field or migration |
| Phase 7 (the walkthrough) | **nothing at all** | yes, but *after* Phase 6 — see below |

Phases 1, 2 and 5a have no hard API dependency and can land first. Phase 3
wants the atomic swap. **Phase 4 is the one phase that cannot start on this
side** — which is the correct shape, because both of its load-bearing rules
have to live where a client cannot route around them.

Phases 6 and 7 invert that shape: they need nothing from the API lane and
could be built at any time. They are last anyway, and in that order, because
Phase 6 changes the UI and Phase 7 describes it. Building 7 first means
building it twice, and shipping a walkthrough that is wrong on the day it
lands is worse than shipping none — it is the first thing a new rider sees.
