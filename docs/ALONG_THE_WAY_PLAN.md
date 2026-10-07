# Along the Way — Frontend Plan (denver-scooter-fyi)

Companion to `scooter-fyi-api/ALONG_THE_WAY_PLAN.md` (the **master** program
plan — read it first; the vision, decisions, equity arithmetic and risks live
there). This document is the actionable frontend lane: which modules exist,
what each owns, what it may not do, and what the tests have to prove.

**Phase numbers and names are the master's.** Two titles read shorter here
than there — Phase 1 ("My ideal scooter" vs "The ideal scooter", the
rider-facing wording) and Phase 5 ("Equity Area savings" vs "Cost-aware
routing through Equity Areas") — and that is deliberate rather than drift. Any
*other* divergence is a bug in one of the two documents.

Planned 2026-08-29 against `main` (13e2215). Branch:
`claude/along-way-upgrades-feature-piml2p`.
**Revision 2** — the spec is now rider-facing ("my ideal scooter") and applies
to the map in one tap (§1.3, a **reversal** of revision 1's decision), and
**Favorite Scooters** — favouriting individual vehicles behind a QR scan — joins as
Phase 4 (§4).
**Revision 3c** — **Phase 9, reaching the rider** (§9): an opt-in for trip
alert SMS, a resume link that carries a plan reference and never a session, and
a rapid check that is **narrow rather than fast** — the global 90-second poll
is already faster than the 2-minute ingest behind it, so only the 1–5
plan-critical vehicles are checked at 20s. **Phase 10, advocacy** (§10) is one
control in this repo (the CC tick); its pipeline already exists in
`zNeill/keepdenverfair`.
**Revision 3b** — **Phase 8, the receipt** (§8): check whether a trip was
charged per Exhibit C, **prepare a ready-to-send complaint**, and — consented — contribute to an
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
| `along-the-way.ts` | 2 | The **client-cheap plan search**. `rankPlans(features, ctx)` → `TripPlan[]` + backups: multi-leg (`walk → [ride → [hand-off → ride]*]? → walk`, the walk-only plan being the degenerate case), ranked by generalised cost (seconds **plus money** plus penalties), straight-line, no network. Pure. |
| `receipt-read.ts` | 8 | On-device extraction: screenshot → the receipt's fields. **Pure given a bitmap.** Owns the format quirks and nothing else. |
| `receipt-verdict.ts` | 8 | The three-part bar → `overcharged` \| `correct` \| `cannot_tell`, plus the reason. **Pure**, no DOM, and it never phrases an accusation. |
| `receipt-panel.ts` | 8 | Drop zone, the confirm-what-we-read step, the verdict, the complaint action, the contribute toggle. Renders; decides nothing. |
| `account-confirm.ts` | 8 | Profile screenshot **or** typing, yielding the account identifier and **nothing else** — there is no field for a card fragment to land in. |
| `trip-alerts.ts` | 9 | The trip-alert opt-in's state and the rules about what earns a text. **Pure** — the decision is testable without a network. |
| `plan-resume.ts` | 9 | Reads a resume link, carries the plan reference across a sign-in, re-enters the plan. **Pure** given a URL and a store. Holds no credential, ever. |
| `free-minutes.ts` | 2 | The Access tier's free-minute budget: estimate today's used minutes from tracked rides, state which way the error runs, and hold the rider's own correction. Pure; the control that renders it lives with the plan list. |
| `ride-cost.ts` *(existing)* | 2 | **Untouched in behaviour**, newly load-bearing: its `RATE_PLANS` and `unlockCents` are what let the plan search price a hand-off per tier, and its `billableMinutes` is what the free-minute estimate sums. |
| `trip-plan.ts` | 3 | The state machine, the remaining legs, the current claim, the backups, the permanent `exclude` list. Pure reducer plus an injected effects interface. **The owner of "what am I riding, what am I heading for, and why".** |
| `backups-sheet.ts` | 3 | The *overrule* face: the plans the search already computed, offered after an automatic re-solve. There is no "do you accept this swap?" card any more — every re-solve is applied and reversible (§3.1), and **announced only when it changes something actionable** — §3.4's two cases, which this row used to flatten into "announced". |
| ~~`my-scooters.ts`~~ | 4 | **Built, then deleted.** Favourite vehicles — `locationOf` keyed off the `position_withheld` FLAG, the title, the sentence for every refusal. It worked, and it was the wrong feature: a sign-in, a QR scan and a fix within 75 m, in exchange for telling the rider where a scooter was parked, which the map already does for every scooter to anybody. §4.1's reasoning about why it is not `favorites.ts` still stands and is still worth reading; its payoff did not. Replaced by `device-notify.ts` below. |
| ~~`my-scooters-panel.ts`~~ | 4 | **Built, then deleted** with the module above. Its Tools-drawer slot is now the watch list. |
| `device-notify.ts` | 4, 9 | The gated move-watch — what replaced keeping a scooter, twice over. The local watch store, the two permitted origins and their caps and expiries (`WATCH_RULES`), the moved / in-use / gone verdict against a 50 m anchor (§9.7.4), the message, and the one-alert-per-scooter rule. **Pure apart from its `localStorage` adapter.** Its header is the normative statement of why this capability is gated; read it before adding an entry point. |
| `device-notify-panel.ts` | 4, 9 | The Tools-drawer list and the in-app toast. Renders; decides nothing; **starts nothing** — it exists to show what is watched and to stop it. §9.7.6: rows learn a tier, because "while the app is open" is the wrong promise for a row that will text. |
| `qr-utility.ts` | 4, 6 | The ribbon's QR tool: one scanner behind a two-position segmented mode switch (Confirm features, Ride mode). A third job would be a third segment, not a third camera flow — but see §9.7.2 for the one that was planned and deliberately dropped. |
| `qr-ride-scan.ts` | 4 | What a scanned sticker MEANS to a ride — start, resume, associate, or already-tied — and the two ways a scan names nothing. **Pure.** It exists because tying a scooter to a ride used to depend on which of five doors the rider came through, and none of them worked once the ride was running. |
| `equity-savings.ts` | 5 | Cost terms, not a second optimizer: the start-in-area bonus and `equityLegRate` for the Phase 2 planner's money term. Pure; imports `ride-cost.ts` for money and `equity-areas.ts` for geometry, and owns neither. |
| `arrival-panel.ts` *(existing)* | 3 | Gains a **re-solved** face and a `reportResolve()` beside its `reportGone()`. |
| `dibs-notify.ts` *(existing)* | 3 | Gains a `resolved` alert that **replaces** `taken`, and the rule that a re-solve changing nothing actionable is not announced at all. |
| `device-watch.ts` *(existing)* | 3 | Unchanged in behaviour. Its `onGone` callback stops being a dead end. |
| `filter-presets.ts` *(existing)* | 1 | **Untouched.** Saved filter presets and saved specs coexist; §1.3 says why. |
| `favorites.ts` *(existing)* | 4 | **Untouched.** Saved *places*, not vehicles; §4.1 says why they must not be merged. |
| `qr-scan.ts` *(existing)* | 4 | **Almost untouched.** Still opens the camera, decodes, and hands back the raw payload with no opinion about what it means. Gained one export, `isQrScannerOpen()`: it is always opened FROM something, every host listens for Escape on `document`, and one press was closing both — losing whatever the host had collected. The topmost layer owns Escape. |
| `api.ts` *(existing)* | 1–5, 8, 9 | `fetchTripPlans`, the ride-spec CRUD, the favourite-device CRUD, `replaces` on `registerDibs`; **Phase 8's** receipt submit / list / withdraw (§8.6 — withdrawal has to really delete); **Phase 9's** `fetchPlanCriticalState(ids, signal)`, the trip-alert opt-in's read/write, and the live-plan lifecycle `createPlan` / `updatePlan` / `finishPlan` (§9.1, master §13.6 — a stored plan with no finish call is a watcher texting about a finished trip). Phase 10 adds nothing here — its CC is a `mailto:` parameter, not a request. **This row grows with every phase that touches the network**, because the house rule above is that the calls live here; a client that ends up in its feature module instead is the same defect each time, and it has already been caught once (§9.2). |
| `onboarding.ts` *(existing)* | 7 | The seven-screen tour. Rewritten against the UI Phase 6 leaves behind, and switched back on. `ONBOARDING_SCREENS` stays exported — it is what the audit test reads. |
| `home-bar.ts` *(existing)* | 6 | Gains the two named entry functions that replace clicking `#mode-switch`. Its no-default rule on the wheels question is untouchable — and survived that question growing a **third** answer, "I've already started one" (§6.7). `onPlanTrip` may now be **refused**: the bar stays put, with the destination intact, when the host declines to take the trip. |
| `ride-hud.ts` *(existing)* | 6 | `rideModelFilterFor()` learns about the attached spec, and the pills stop being a second filter vocabulary. |
| `main.ts` *(existing)* | 1–5, 8, 9 | Two `wireX()` calls (`wireTripPlan`, `wireMyScooters`), the `onGone` handler at `main.ts:3257` re-pointed at `trip-plan.ts`, the spec bridge on the existing `snapshotFilters` / `applyFilterSnapshot` pair (`main.ts:1011`), and `devices.allFeatures()` fed to the plan search. **Phase 8** adds `wireReceipts()` — the panel's host and its entry point; **Phase 9** adds `wireTripAlerts()` and the **resume entry point**, which must run on load before anything else reads the URL, because a resume link arrives as a cold start. **This row grows with every phase that adds a surface**: the house rule above is that a surface is wired from here through one `wireX()`, so a phase with a surface and no row here is a phase whose UI has no host. |

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
         rate: RatePlan;
         /** RESOLVED BY THE CALLER, never `null`. This function has no
          *  tracked-ride input, so it could not estimate a `null` even in
          *  principle — §2.2's control owns the estimate (or the pessimistic
          *  0 for a signed-out rider) and hands down a number, so the
          *  free-minute state has exactly one meaning inside the search. */
         freeMinutesLeft: number;
         /** §6.2's bounded selection: the best `W` first hops and `H`
          *  pickups. Inputs, not constants — see §2.1's note; they arrive on
          *  the candidates response and fall back to the documented
          *  cold-start default. */
         bounds: { firstHops: number; pickups: number };
         /** `ride-cost.ts` holds the tax rate as MUTABLE module state. A pure
          *  search that reads it ranks against whatever the module happens to
          *  say, and a client pricing pre-tax against a server pricing with
          *  tax breaks §2.3's rule 3 with neither side being wrong. Injected,
          *  and the same figure the server uses. */
         taxRate: number;
         favorites?: ReadonlySet<string>; exclude?: ReadonlySet<string>;
         /** Null on an initial search; set on every re-solve (§3.2).
          *  Mirrors master plan §6.4's `in_ride`. */
         inRide?: {
           vehicleIdentifier: string;
           rangeMeters: number;        // what the CURRENT vehicle can still do
           unlockPaid: true;           // so continuing costs no unlock
           /** Minutes of today's free hour spent BEFORE this rental began —
            *  a BASELINE, not a running total, so it cannot go stale. Usage now
            *  is
            *
            *    freeMinutesUsedBeforeRide
            *      + billableMinutes(ctx.now − Date.parse(rideStartedAt))
            *
            *  — through `billableMinutes`, never raw subtraction. Two reasons:
            *  `ctx.now` is epoch MILLISECONDS and the baseline is MINUTES, so
            *  the bare difference is a unit error; and Veo bills the STARTED
            *  minute (`ride-cost.ts`: `max(1, ceil(ms/60_000))`), so a rider
            *  61 seconds in has spent 2 free minutes, not 1. Rounding down
            *  would rank them with free minutes they do not have and price a
            *  paid minute as free — the one direction §2.2 forbids, since its
            *  whole promise is a FLOOR on minutes used.
            *
            *  This replaces `freeMinutesUsedThisRide`, which was a snapshot of
            *  minutes used DURING the ride: ageing that by the elapsed time
            *  DOUBLE-COUNTS everything already in it — 6 minutes measured six
            *  minutes in becomes 12. The zero case passes either way, which is
            *  how it survived; §2.5 has the nonzero regression. */
           freeMinutesUsedBeforeRide: number;
           /** Master §6.4's `started_at`, the other half of that sum. */
           rideStartedAt: string;      // ISO 8601
         } | null },
         /** The evaluation instant. Required, and never defaulted to
          *  `Date.now()` inside: `inRide.rideStartedAt` is only useful against
          *  a "now", so reading the clock internally would make identical
          *  inputs rank differently run to run — breaking the purity claimed
          *  two paragraphs below. Injected, so the cliff-crossing and
          *  continuation tests can pin it. */
         now: number },
): { plans: TripPlan[]; backups: TripPlan[]; relaxed: SpecField[];
     /** Rule 1's fallback fired: some offered plan has a `risk`-tier FIRST
      *  HOP because nothing non-risky was within a 5-minute walk. The UI's
      *  warning and §2.5's test both condition on it, so it has to be
      *  readable from the result rather than inferred by re-scanning legs. */
     riskTierOffered: boolean };
```

**`inRide` changes the graph, not just the pricing**, exactly as master plan
§6.4 requires: on an initial search the only edges leaving the origin are
walks, but on a re-solve the rider is *on* a vehicle, so the origin also gets a
**continuation edge** — keep riding what you have — priced with **no unlock**
because it is already paid, and bounded by that vehicle's remaining range.

Without it the client fallback cannot offer "keep riding" at all, so it would
systematically prefer handing off, and could charge a second unlock after a
server-tier failure. The continuation edge needs its own test.

A `TripPlan` is a sequence of legs — `walk → ride → [hand-off → ride]* →
walk`. A single-vehicle trip is a plan with one ride leg and competes in the
same list; there is no separate "direct" concept to keep in sync.

**The `*` is a binding rule, not notation: chaining is unbounded, and must
never be limited by a hop counter** (master plan rule 3). The money term bounds
it correctly and per tier — a `resident` pays $1 a hop and will rarely see two,
while three of the five tiers pay nothing and should not be stopped at an
arbitrary number. A hop cap would constrain **exactly the riders it shouldn't**,
and it would pass every other test in §2.5, which is why §2.5 carries a case
whose optimum needs more hand-offs than any cap anyone would pick.

**Walking the whole way is a plan too** — one walk leg, no ride legs, nothing
to unlock. That is master plan §6.2's `P → D` edge, and it is ranked in this
same list by this same scalar. A planner that cannot *represent* walking cannot
choose it when it is genuinely best, and §2.5's headline test compares a
hand-off plan *against the direct walk*, which needs both of them in one list
to compare at all. So the general shape is `walk → [ride → [hand-off →
ride]*]? → walk`, the two walks collapsing into one when no ride sits between
them.

**Every leg carries its own seconds AND its own money**, not just the plan
total:

```ts
interface TripLeg {
  mode: "walk" | "ride";
  seconds: number;
  meters: number;
  vehicle?: DeviceProperties;   // ride legs only
  unlockCents: number;          // 0 on a walk leg, and on a free-unlock tier
  minuteCents: number;          // the leg's minutes at its own rate (§5.1)
  taxCents: number;             // `ctx.taxRate` on this leg's unlock + minutes
  freeMinutesUsed: number;      // Access only; 0 otherwise
}
```

Plan totals (`totalSeconds`, `estimatedCents`, `handOffs`) are **derived from
the legs**, never stored alongside them, so they cannot drift.

**`taxCents` is its own component for the same reason the unlock is.** Ranking
and the rider-facing price both include tax (§2.1's `ctx.taxRate`), and totals
are derived **solely** from the legs — so with nowhere to put it an
implementation must either drop tax or fold it into `unlockCents` /
`minuteCents`. Folding it in defeats both things the breakdown exists for: the
rider can no longer see *which* leg costs the extra unlock, and the server
tier's figures can no longer be reconciled against ours component by component.
Master plan §6.4's response carries the same component per leg.

Per-leg figures are not a nicety: master plan rule 2 is *cost and time on
every plan, including startup costs*, and a plan showing only a total hides
**which** leg costs the extra unlock — which is the one number a rider needs
to judge whether the hand-off is worth it. A card that renders only totals
cannot make that case.

**Pure.** No DOM, no network, no map. It runs on every device refresh, so it
has to be cheap, and it has to be testable without booting MapLibre.

**The scalar is generalised cost**, not seconds: every leg's seconds, plus
money converted to seconds, plus preference penalties. Money is genuinely in
it — an unlock fee is the reason a hand-off might not be worth taking, and
three of the five tiers pay nothing for one (master plan §6.3).

**`SECONDS_PER_CENT = 8`, and it is the same constant the server uses** (master
plan §6.3.0). "Money converted to seconds" is not implementable until the
conversion is a number, and a client that degrades to a *different* rate
degrades to a different **answer**, not a rougher one — which would break
§2.3's rule 3 silently, since the two tiers would disagree about price without
either being wrong. So it is imported, never re-chosen here, and the two
rider-facing consequences travel with it: a $1 unlock is worth **13 min 20 s**,
and one preserved free Access minute is worth **2 minutes** of extra travel.

**The free-minute balance is part of the search STATE, not just an input.**
`freeMinutesLeft` arrives as a number, and the cheap thing to do with it is
price the whole plan under one regime. Master plan §6.3 shows why that is
unsound with a counterexample: pricing every minute free and pricing every
minute paid each pick a plan, and the optimum can be neither, because uniform
pricing destroys the exact trade-off the cliff creates — spend more total
minutes to stay inside the free hour. So a node is `(location, free minutes
consumed)`, or equivalently nondominated `(time, free-minutes-consumed)` labels
per node, and an edge's money term is computed from the balance **on arrival**.

The budget is 60 whole minutes, so that is at most 61 layers over the same
small node set, and it **collapses to a single layer** for every rider without
a free balance — which is four of the five tiers, and Access riders who have
spent the hour. The cheap tier can afford the exact answer; it does not need
the shortcut that does not work.

**`X` collapses to `to` in this tier, and the consequence is one-directional.**
Master plan §6.2 ends the last ride leg at a **drop-off node `X`** near `D`,
with a short walk after it — but that needs legal-parking geometry, which this
repo does not have. So the cheap tier ends the last ride leg **at `to`** and
evaluates `mustReach` for that leg against `to` as well. It therefore **omits the final walk**.

**That does not make the client's figure a lower bound, and an earlier draft of
this section claimed it did.** The omitted walk pushes the estimate *down*, but
two other approximations push it *up*, and nothing makes them cancel in a known
direction:

| Approximation | Direction |
|---|---|
| the omitted final walk | **under** |
| `DETOUR_FACTOR = 1.35`, **rounded up** rather than averaged (`reach.ts` records 1.33 and 1.18 observed) | **over** |
| a fixed 18 km/h riding pace | either |

So a routed leg can legitimately come back **shorter** than the client's, and
any `client ≤ routed` assertion would be a flaky test of a false claim. The
honest statement is `reach.ts`'s own: *it is an estimate and must be labelled
one*. §2.3's rule 3 replaces it with the routed figure at the moment a decision
is made, and §2.5 asserts **the label and the replacement**, never a direction.

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

**Feed it the unfiltered fleet, then bound it.** `devices.allFeatures()`,
never `visibleFeatures()` — a rider's leftover map filters are a view, not a
statement of what they will ride, and `main.ts:1458` already carries a note
about this exact trap.

**Unfiltered is not unbounded, and the two get conflated.** The fleet goes in;
what enters the graph is master plan §6.2's explicit selection — the best `W`
non-`risk` vehicles by walk seconds inside the walk cap as **first hops**, the
best `H` non-`risk` vehicles as **pickups**, and `N = |W ∪ H|`.

**`W` refills from `risk`-tier vehicles when — and only when — there is no
non-`risk` vehicle within a FIXED five-minute walk**, setting
`riskTierOffered`. The test is five minutes, **not the rider's
`maxWalkMinutes`**, which ranges 1–15: with a 3-minute cap and a non-risky
vehicle 4 minutes away, testing against the cap would admit a risky vehicle
where rule 1 says it must not. Rule 1 is a **platform** rule and the walk cap is
a **rider preference**; they cannot share a radius.

**What happens in that gap is the interesting part, and §5.2 already answers
it**: when the only non-risky vehicles sit beyond the rider's cap but inside
five minutes, **relax the cap** — it is on the relaxation ladder and is
disclosed like any other relaxation — and offer the 4-minute non-risky vehicle.
Never relax rule 1 to stay inside a walking preference. *"You will walk a minute
longer than you asked"* is a better answer than *"here is a scooter that
probably will not start"*, and far better than an empty list. Any offered first
hop is shown with its **real** walk time, cap or no cap. Without the
refill this step is where rule 1's exception quietly dies: the fallback is
documented four paragraphs below, and a vehicle that never enters the graph can
never be offered, so a rider with nothing but risky vehicles nearby would get
an **empty list** rather than one honest option with a warning on it. Pickups
never refill (master plan §6.2 step 3) — so this step is the only place in the
entire search that admits a `risk` vehicle at all, which is what makes the
asymmetry enforceable instead of a convention. The bbox and
the walk cap bound the *first* hop only; they say nothing about downstream
nodes, so without this step a multi-hop search over the whole fleet does
fleet-scale work **on every 90-second refresh**, on a phone. **`W` and `H` reach this tier as `ctx` inputs — they cannot be "imported".**
The two repos share no runtime module, and master §6.2 deliberately does not
fix their values until the deployed matrix's own limits have been measured, so
there is nothing to import yet and no import path if there were. They arrive on the candidates
response as `bounds: { first_hops, pickups }`, are cached for the session, and
reach this tier as **`ctx.bounds`** (§2.1) — a typed input in both contracts,
because prose saying they "arrive" is not a route.

**The cold-start default is `firstHops: 8, pickups: 12`** — `N ≤ 20` — used
when the client has never had a response or the call failed. It is
**provisional and labelled so in both plans**: master §6.2 fixes the real
values against the deployed matrix's own limits, and at `N = 20` the server's
second call is `20 × 21 = 420` pairs, which is the figure to measure against.
When the measured values land they replace this default **in both documents at
once**, because a default that drifts apart is two tiers disagreeing about what
was *considered*.

The reason they have to match the server's at all is §2.3's rule 2: two tiers
disagreeing about which vehicles were *considered* disagree about
**disqualification**, which that rule forbids outright. Rule 1 (they may
disagree on order) does not cover it.

**WHICH SCOOTER MUST MATCH THE SPEC — the second one, if the first cannot.**
Only the **first ride leg's vehicle** may fail the spec, and only because it is
a *starter*: something ordinary you ride to get to what you asked for.
Everything downstream of it is the vehicle the rider wanted, so **a plan can
never hand off FROM a matching scooter TO a non-matching one**, and the vehicle
they arrive on always matches.

Revision 3 left this unstated and it is load-bearing in both directions. Read
the other way — every vehicle must satisfy every requirement — the feature
deletes itself: if the Astro you walk to needs the basket too, there is nothing
to hand off *from*, and the plan collapses back to "walk to the matching
scooter", which is the misreading this whole revision exists to correct.

**Three checks enforce it and none is sufficient alone**, so a change to any
one breaks the rule silently — which is why they are listed together, and why
§2.5 tests the invariant rather than the checks:

| | Enforces |
|---|---|
| the **pickup pool** is screened on `ideal` | any vehicle reached by a hand-off matches |
| the **final ride leg** must be `ideal` | a single-vehicle plan cannot quietly offer a non-matching scooter |
| the **continuation edge** obeys both | a re-solve cannot answer *"keep riding the basket-less starter to the door"* — the rider's requirement does not evaporate because their pickup was taken |

`ideal` and not `qualifies`, and the difference is the whole mechanism:
`qualifies` enforces only the rider's `must` fields, so with no musts set it is
true of every available vehicle — nothing is ever "not found", nothing is ever
given up, and the relaxation ladder below could never run. The ladder exists to
trade **preferences** away one rung at a time, so the pool has to begin by
demanding them.

**`mustReach` is evaluated per leg, against that leg's own endpoint.**
`matches()` checks whichever `dest` it is handed (`src/ride-spec.ts:214`), so
handing it the final destination for every candidate disqualifies precisely the
vehicles this revision exists to use: a scruffy Astro with 1.5 km of range is a
fine *starter* when its hand-off is 1.2 km away, and useless only as a vehicle
for the whole trip. Master plan §5.2 calls this correction load-bearing; this
tier's share of it is passing the right `dest` — the hand-off point for a first
hop, the drop-off node for the last ride leg — never `to` for all of them.

**Rule 1 is a filter, not a penalty.** `risk`-tier vehicles are excluded from
every leg of every plan. Only if no non-`risk` vehicle is within a 5-minute
walk may one appear, and then the result says so (`riskTierOffered`) and the
UI must too. This is the platform's selling point; it does not get traded for
four minutes.

**`favorites` is a bonus, never a filter.** A favourite that fails a `must` is
disqualified like anything else.

### 2.2 The free-minutes control

**Shipped**, as `free-minutes-control.ts` (the copy and the correction store)
plus the readout above the plan list. The arithmetic stayed in
`free-minutes.ts`, where it already was.

Three things the section did not say and the build had to settle:

- **There are THREE states, not two.** "We have not looked" (the fetch has not
  landed — the pessimistic hour), "we looked and you have taken none today", and
  "signed out, so we cannot look" are three different sentences. Conflating the
  middle two tells a rider with a full hour that we cannot see their rides, and
  they then correct a figure that was already right.
- **The correction is scoped to the Denver billing day.** A figure from
  yesterday is worse than none: it is stated with confidence, it WINS over the
  estimate by design, and it is certainly wrong. A stated `0` is kept, because
  "I have none left" is an answer and "I did not say" is not — so an empty box
  clears the correction rather than becoming a zero.
- **Correcting re-prices, it does not just re-label.** The balance is search
  state (`searchOnce` makes a node `(location, free minutes consumed)` precisely
  because one regime for a whole plan is unsound), so a corrected figure can
  change which plans exist and in what order.

The fetch happens AFTER the list is on screen, per §2.3's rule for the routed
tier and for the same reason: a rider who asked for plans gets plans, and the
figure re-prices them upward when it arrives. A failed fetch stays `null` — the
pessimistic figure — and never becomes an empty day, which would hand the rider
a full hour on the strength of a network error.

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

**Shipped, and it was the missing half of Phase 2.** That phase landed
engine-first: `rankPlans` was tested, priced, bounded — and wholly unreachable.
Nothing in the app called it, and no behavioural test could say so, because
every test it had passed. `wheels: "need"` went to the map chooser, which
predates this program.

Four modules, split so each decision is assertable: `plan-list.ts` (pure
derivation), `plan-search.ts` (the `RankPlansContext` assembly), and
`plan-list-panel.ts` (DOM), with one branch in `main.ts`.

`plan-search.ts` is its own module rather than a block in `main.ts` because
every field of that context has a documented wrong answer and **none of them
changes anything visible when it is wrong** — the list still renders four
plausible plans. The fleet must be unfiltered, free minutes must be resolved
before the call and only exist for one tier, the tax rate must be the server's,
`now` must be passed in.

Three decisions taken while building it:

- **The walk-only row is shown and cannot be chosen.** It earns its place as
  the thing riding is compared against, and there is no walk-to-destination
  flow in this app to hand the rider to — the arrival panel walks them to a
  SCOOTER. A button that goes nowhere is worse than none.
- **Only the first leg is acted on.** Honouring a hand-off end to end needs
  Phase 3's living plan. A walk flow that silently forgot legs two and three
  would be worse than one that never claimed to have them.
- **No GPS fix means no list.** A plan list from a guessed origin is four wrong
  answers, and walking a rider to a scooter that is not near them is the one
  failure this surface can cause by itself. They get the map chooser, which
  needs no fix to be useful.

**`FAVORITE_BONUS_SECONDS` HAS NO LIVE INPUT, and this is where that became
visible.** The planner's favourite bonus wants vehicle keys; there is no
favourite-vehicle store in the app, because `my-scooters.ts` was built and then
deleted (see the module map). `favorites.ts` holds saved PLACES, so wiring it
would pass place ids as vehicle keys, match nothing, and silently disable the
term — a dead ranking input that looks wired. Nothing is passed, deliberately.
The watch list is not a substitute: "tell me when this moves" is not "I prefer
this one".

The home bar already asks the two questions this needs — *where are you going*
and *need wheels or got your own* — and hands the answer to `pending-trip.ts`,
whose contract is unchanged. `wheels: "need"` opens the **plan list**: **one to four**
plans, each showing its legs, its total time and **its cost including every
unlock**, with the hand-off drawn on the map.

**One, not two, is the floor.** Master §6.4's `limit: 4` is a cap, never a
quota, and a valid result can hold **only** the walk-only plan — an empty
fleet, or a fleet whose every vehicle fails a `must`. A UI promising two
options either fabricates the second or implies one exists, which is the same
dishonesty as a risky vehicle shown without its warning.

### 2.5 Tests

- A spec-matching vehicle 14 minutes' walk away but on the route produces a
  hand-off plan that beats the direct walk — the headline case, and the one
  revision 2 could not express at all.
- No plan contains a `risk`-tier vehicle while a non-`risk` one is within a
  5-minute walk. When none is, a `risk`-tier vehicle may appear **only as a
  first hop** — never as a pickup, on any plan, ever — and `riskTierOffered` is
  set. Asserted on the **leg's role and the fallback condition**, not on a
  count: the bounded first-hop set may legitimately contain several, so
  "exactly one appears" over-constrains the planner *and* passes while a risky
  **pickup** slips through, which is the half of the rule that has no
  exception.
- A starter vehicle that can reach the hand-off but **not** the final
  destination is offered as a first hop — the per-leg `mustReach` regression,
  and the one a single-vehicle reading silently fails.
- A `resident` rider (1 unlock = $1) and an `equity` rider get **different
  plan orders over the same fleet** — the money term is real, not decorative.
- An `equity` rider with 5 free minutes left and one with 55 get different
  orders: the cliff is priced, not smoothed.
- **Master plan §6.3's crossing-trip case**, with its three plans: the plan
  whose total is longest but which stays inside the free balance wins, and
  neither single-regime pricing finds it. This is the regression that fails if
  anyone replaces the state augmentation with a cheaper shortcut — and it is
  the one test that cannot be written without the state in the search.
- **The exchange rate's crossover**: a plan one unlock cheaper and 13 minutes
  slower wins; the same plan 14 minutes slower loses. A scalar with no pinned
  rate passes whatever test you write for it, so the rate is asserted at its
  boundary rather than implied.
- **The favourite bonus is 90 seconds** (master plan §8.6): an otherwise
  identical favourite wins, and a favourite loses to a plan more than 90
  seconds better. Both halves, because a bonus with only the first half tested
  can drift upwards into a filter — and §2.1 says a favourite is a bonus and
  never a filter.
- Plans are ranked by generalised cost, and `estimatedCents` on every plan
  includes every unlock in it.
- A fleet whose optimum is a **three-hand-off** plan for a zero-unlock tier
  returns it, with no hop limit anywhere in the search. A cap-shaped bug passes
  every other test in this list, which is why this one is a count larger than
  any plausible cap rather than "more than one".
- **A re-solve with a NONZERO `freeMinutesUsedBeforeRide`** prices today's
  usage as `baseline + billableMinutes(elapsed)`, not
  `baseline + baseline + elapsed`. The zero case passes under either
  arithmetic, which is exactly why this one is written with a nonzero baseline.
- **61 seconds into a ride counts as 2 free minutes used, not 1** — the
  started-minute rounding, asserted at the boundary. A raw
  `(now − rideStartedAt)` passes the nonzero test above and still fails this
  one, which is why both exist: one catches the double-count, the other catches
  the unit error and the rounding.
- Every client-tier plan is **labelled an estimate**, and the routed figure
  **replaces** it (never averages with it) when the server tier answers — which
  is §2.3 rule 3, asserted. **Not** a `client ≤ routed` inequality: §2.1 explains
  why no direction is guaranteed, and a test enforcing one would be flaky in
  service of a false claim.
- A **120-second** improvement triggers a re-solve and a **119-second** one
  does not; two qualifying improvements inside 3 minutes produce **one**
  re-solve. Boundaries, because a threshold with no boundary test is a number
  in prose.
- Monotonic relaxation still holds over plans, not just vehicles.

---

## Phase 3 — The living plan

### 3.1 One rule, replacing the auto-accept envelope

Revision 2 claimed automatically inside a defined envelope and asked outside
it. **Withdrawn.** The rider is on a moving scooter; a question they cannot
safely read is never the safer default, so there is no bound at which asking
becomes right. Instead, on every disruption:

1. **Resolve it automatically** — re-solve the remaining legs from where the
   rider is now, and **move the claim in one atomic call** (§3.3; "claim the
   new, release the old" is the non-atomic path that section forbids).
2. **Say so, once — when something actionable changed.** A re-solve the rider
   would not act on says nothing (§3.4).
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
- a materially better plan appears (revision 2's Phase 3b, no longer separate).
  **120 seconds of generalised cost, at most once every 3 minutes** (master
  plan §7.2). Unqualified, this trigger fires on estimate noise, because the
  search reruns on every refresh and a one-second gain is a "better plan" by
  this list's own wording. 120 s sits **above `bonus_favorite`'s 90 s
  deliberately** — a favourite coming into range must not rearrange a trip in
  progress by itself. Ties and sub-threshold gains change nothing: no re-solve,
  no claim movement, no notification. **The other four triggers have no
  threshold and no interval**;
- the battery will not reach the next hand-off;
- the rider is far enough behind that the claim will expire;
- the rider has gone somewhere the remaining legs no longer fit.

Each re-solves the **remaining route**, never just the next vehicle.
Re-solving only the next vehicle is what leaves a rider on a route that
stopped making sense: a replacement pickup can be the best vehicle for a plan
nobody should still be following.

### 3.3 Dibs, while riding

Dibs goes on the **next** vehicle, claimed while riding toward it.

**It does not hold the vehicle, and no surface here may imply it does.**
`src/dibs.ts` says so in its first lines, and master plan §7.3 and §7.4 bind
this lane to it: Veo has no reservation system and this app cannot stop a
vehicle unlocking. What a claim buys a hand-off is **recorded intent** (our own
buttons grey out for anyone else in this app) and **a watched vehicle** (the
plan re-solves the moment it goes). So the honest phrasing — in the UI as much
as here — is *the pickup is monitored, and if somebody takes it you will be
moved before you get there*, never *it will be waiting*.

- **`DIBS_MAX_WALK_MINUTES = 15` is the wrong bound for a ridden approach.** It
  exists so nobody claims what they cannot reach in time; riding reaches much
  further inside the same 25-minute window. It must become a
  **time-to-arrival** check computed from the actual leg.
- **One claim at a time, always — and the server keeps that invariant, not
  the client.** A chained plan does not hold three scooters hostage.

  **It does NOT release and then claim.** Revision 2's rule was "release
  precedes claim", which this document's own sequencing table calls the
  *non-atomic* fallback: two calls, with a window holding no claim at all,
  and a failed second call losing the first one permanently — for nothing,
  since the rider is still riding toward a pickup they no longer have.

  So a re-solve moves the claim in **one** `registerDibs(…, { replaces })`
  call. The server expires the old row and writes the new one in a single
  transaction, which is what makes "at most one" an invariant rather than a
  convention the client is trusted to follow.

  **There is no two-call fallback, and the one revision 3 wrote here could not
  have worked.** It said to treat a failed second call as "a re-solve that did
  not happen, keeping the old claim" — but the first call already released that
  claim, so there is nothing left to keep, and claim-before-release is refused
  by the very server-side invariant above. A claim-moving re-solve is therefore
  a **hard dependency on `replaces`**, not something to ship around.

  **What ships before `replaces` lands**, since Phase 3 is not blocked
  wholesale: a re-solve still re-solves — the route changes, the plan updates,
  the rider is told — but **the claim does not follow it**. The old claim is
  released and the new pickup is **unclaimed**, said plainly on the surface.
  That costs only the recorded intent (our own buttons greying out for other
  riders of this app); **monitoring survives**, because the watcher reads the
  stored plan, not the claim (§9.4). What must never happen is a surface
  implying the claim moved when it did not.

### 3.4 Tests

- A re-solve moves the claim in a **single** `registerDibs` call carrying
  `replaces` — asserted on the call shape, not on an ordering of two calls.
- A failed `replaces` call leaves the **old** claim intact and never leaves the
  plan holding none — the atomic call either moves the claim or changes nothing.
- Before `replaces` exists, a claim-moving re-solve leaves the new pickup
  **unclaimed and says so**, and no surface reports a claim it does not hold.
- A re-solve recomputes **all** remaining legs, not only the next vehicle.
- A lost vehicle never returns as a candidate.
- A re-solve that changes something the rider would act on produces **exactly
  one** notification; a re-solve that changes nothing actionable produces
  **none**. (Stated as two cases on purpose: "every re-solve produces exactly
  one" would include the no-change case and contradict the second half.)
- The backups offered after a re-solve exclude the vehicle just lost.
- Overruling a re-solve applies the chosen backup and re-claims correctly.
- A plan never holds two claims, at any point in any chain.

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

**Shipped, minus one of its three entry points — and that omission is the
finding.** `equityLegRate` was not built, because it already existed:
`along-the-way.ts`'s exported `legRate(rate, from, to)` is the same function
under another name, with the same inputs this section reasons its way to (the
leg's own endpoints and the rider's `RatePlan`), the same worse-reading view of
the area's $1, and the same "unknown polygons count as outside" rule. It is
what Phase 2's `priceRide` already calls on every ride edge.

Building a second copy here would have been the Phase 6 seam-2 mistake moved
into the money layer — and worse than the general case, because this copy would
be the one the DISCLOSURE reads while the planner kept using its own. That is
precisely the "planner and disclosure disagree about the same leg, with the
planner on the optimistic side" failure the paragraphs below spend three
paragraphs forbidding. So the rate rule has one home and it is the planner's.

**`startInAreaSaving`'s signature changed, because the one below cannot work.**
`(candidate, spec, plan)` carries nothing to compare against, and both halves of
the chip are comparatives: "saves $1.80" against what, and "2 min more walking"
than what? A spec does not bear on money at all. The sketch predates revision
3b, which made the PLAN the unit the rider chooses between (§2.4's list); with
two plans in hand the comparison is plan-to-plan and needs nothing else. It
ships as `startInAreaSaving(plan, baseline, rate)`, where the caller picks the
baseline because the caller holds the ranked list.

**`TripLeg` gained `equityArea`.** `priceRide` had `legRate`'s answer in hand
and discarded it, which left the UI no way to name the discounted leg except by
re-testing the polygons itself — the second copy again, arriving by the back
door.

**A test here proved nothing, and it is worth recording how.** The existing
"prices an equity-area leg at the area rate" case guarded its assertions behind
`if (r.equityArea)` and never loaded the polygons, so `isInEquityArea` answered
`null`, `legRate` took its outside path, and the guard never opened. Its
coordinate was also outside every area in the city's map, so loading them alone
would not have saved it. Verified by mutation: with the area rate replaced by
999¢/min it still passed.

Pure. Imports `equityAreaEstimateWithTax` / `estimateWithTax` from
`ride-cost.ts` for money, and `isInEquityArea` from `equity-areas.ts` for
geometry — and owns neither. Three answers:

- `startsOrEndsInArea(from, to)` — if either end is already inside, there is
  nothing to advise and the optimizer stays quiet.
- `startInAreaSaving(candidate, spec, plan)` — the Phase 5a win: this vehicle
  is inside the polygon, so the whole trip is discounted for one unlock. In
  dollars, next to the extra walking minutes it costs.
- `equityLegRate(leg, { from, to, rate })` — Phase 5b, **and it is no longer
  a search**. The leg alone cannot answer this: `TripLeg` (§2.1) carries
  seconds, metres and money, and **neither endpoint coordinates nor the
  rider's rate plan** — so without both it can neither test the polygon nor
  return `null` for an Access rider, which are its only two jobs. Pass the
  ride leg's own endpoints (per-leg, like `mustReach`: a hand-off's pickup
  point, not the trip's destination) and the `RatePlan`. Revision
  3b deleted `stopoverSaving`: an Equity Area stopover is just a hand-off
  (§2) whose pickup happens to sit inside a polygon, so this feeds the Phase 2
  planner's money term instead of ranking anything itself. Equity hand-offs
  then appear in the ordinary plan list, ranked against everything else,
  rather than on a card of their own.

  **It returns the PER-MINUTE rate only — 13¢ — and never the unlock.** The
  Equity Area rate is `$1 + 13¢/min`, and those are two different terms: the
  13¢ scales with the leg's minutes, the $1 is a one-off charged when the leg
  starts. Returning them as one number is how a planner either double-counts
  the dollar or loses it. The unlock belongs to the leg's own
  `unlockCents` (§2.1) — and for an Equity Area leg it comes from
  **`EQUITY_AREA_RATE.unlockCents`, not from the rider's tier.**

  **"Priced per tier" was wrong here, and it broke a rule two sections
  down.** The Equity Area rate is `$1 + 13¢/min` **as a rate**, so a tier whose
  ordinary unlock is $0 does not get an equity leg for free — whether the Pass
  waives *this* dollar is exactly what Exhibit C does not say. §5.2 already
  requires the **worse VeoPlus reading (charged)** for the second unlock and
  §5.3 tests for it, so pricing the same dollar per tier here would have made
  the planner and the disclosure disagree about the same leg, with the planner
  taking the optimistic side — the direction this phase never takes.

  **Eligibility is the leg's own endpoints, not route geometry.** With a leg,
  two endpoints and a rate plan this function has exactly what the question
  needs: `isInEquityArea(from) || isInEquityArea(to)`. That is also the
  **correct** rule and not merely the implementable one — Exhibit A §5.2
  discounts a trip that *starts or ends* inside a polygon, so a leg which
  merely **passes through** one earns nothing, and sampling the route would
  price a discount the rider will never receive. Master plan §12.5 draws the
  same line for receipts.

  **Route crossing is still useful — as a hint about where to look, never as a
  rate.** If the direct route already passes through a polygon there are
  probably pickups inside it worth including in §2.1's bounded selection. That
  is candidate selection; answering it here would rebuild the second search
  revision 3b deleted.

`RatePlanKey === "equity"` returns `null` from every one of them. The Access
tier is 60 free min/day then 15¢/min with no unlock; the Equity Area rate is
$1 + 13¢/min; whether they interact is stated nowhere in the contract we have,
and `config.ts` deliberately declines to infer it. Advice we cannot price is
advice we do not give.

### 5.2 Where it surfaces

**Shipped on the plan list (§2.4), which is the surface this section was
waiting for.** "A chip on a candidate row" reads, after revision 3b, as a chip
on a PLAN row — the plan is what the rider chooses between, and the
disambiguation screen (`ride-screen-select.ts`) is explicitly not a discovery
surface, so a cost chip has no business there.

The four disclosures ship as `equityDisclosures()`, in a `<details>` on the
plan's own row. Collapsed, not hidden: a `<details>` is still in the document
and still findable, which an off-screen drawer is not.

Phase 5a is a **chip on a candidate row** — *"starts in an Equity Area · saves
$1.80 · 2 min more walking"* — because that is where the rider is choosing.

**Phase 5b has no surface of its own, and that is the whole point of revision
3b.** An equity hand-off is a plan in the ordinary plan list, with a chip
naming why it is cheap. There is no route-screen stopover card; rebuilding one
recreates the second mechanism this revision deleted.

So the four disclosures that card used to carry go into **the plan's own
details**, where a rider opens any plan they are considering:

- the saving, with the tier it is computed for;
- the second unlock, priced at the **worse** VeoPlus reading (charged);
- the re-rent risk, in words, plus whether another vehicle meeting the spec is
  currently standing in that area;
- the screenshot caveat, in spirit with `EQUITY_DISCOUNT_NOTICE` — *this
  should cost $X; if Veo bills you the base rate, screenshot it.*

They are **not** optional extras to be shown on a special card when the saving
is large: they are what makes an equity plan honest, so they travel with it.
And a plan whose only advantage is a saving under **$0.50** is not offered at
all.

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

**Shipped.** `#mode-switch` is gone from `index.html`, its CSS with it, and a
source-level test asserts that no module queries it — the trap here is somebody
reintroducing the selector, which no behavioural test can express.

Three findings worth keeping:

- **The second trap needed no state at all.** `hudReturnMode` was captured by
  reading `is-active` off the hidden buttons and written back on the way out —
  the DOM used as storage for a selection that was never rendered. But closing
  the HUD reveals the map the rider already had (ONE MAP: entering a ride never
  rearranged it), so there is no mode to restore. The hook now only re-reads the
  top bar, which is §6.3.2's business.
- **One of the two branches had no caller.** `data-mode="riding"` lived on
  `#ride-open`, nothing referenced that id, and the one helper that clicked
  modes by name was only ever passed `"ride"`. Its behaviour is not lost —
  that is the `isLiveRideEntry` decision, which `beforeOpen` reaches via
  `isRideLive(doc)` — so it was deleted rather than lifted into a second named
  function with nothing to call it. `isLiveRideEntry` itself is now
  production-unreferenced and says so in its own doc comment, with what
  replaced it.
- **The first trap was left exactly as written.** `void resetIconography` and
  `void setSelect` stay, comment untouched. Untangling that knot is still its
  own change.

### 6.3 Seam 2 — ONE FILTER SYSTEM, not two that agree by coincidence

`devices.ts` holds `rideModelFilter` (HUD "Show" pills) alongside the Filters
drawer's `models`, and they disagree about the one gesture a rider is most
likely to make by accident — turning everything off.

**An earlier draft of this table was wrong**, and the correction is the reason
this seam is worth more than tidying. Read `filtered()`: the drawer's branch is
`if (this.models.size < ALL_MODELS.length)`, so an EMPTY set does not skip the
filter — it enters it, and keeps only what `key === null || has(key)` admits,
which with nothing selected is **unrecognized hardware alone**:

| Selection | drawer `models` | `rideModelFilter` |
|---|---|---|
| all | every model (branch skipped) | passed upstream as `null` — no filter |
| some | those **plus** unrecognized | those **plus** unrecognized |
| **none** | **only unrecognized hardware** | **nothing at all** |

So "some" agrees and "none" disagrees — and neither answer is what a rider
means by turning every toggle off. `wireToggleGroup` has no all-off guard, so
both states are reachable with ordinary taps.

**The decision: one filter system, one vocabulary, both surfaces driving the
same value.** The HUD is a *view onto* the map's filter, not a second filter
that happens to run on the same features. Concretely:

- the model selection becomes a **named three-state** — `all`, `only(models)`,
  `none` — so "show none" is a state somebody chose rather than an empty set
  whose meaning inverts one drawer away;
- unrecognized hardware stays visible under `all` and `only`, and is hidden
  under `none`, because `none` means none;
- a change in either surface is a change to the one filter, visible in the
  other when the rider gets there. No copy, no re-push.

**That last point deletes a whole dance.** `setState` currently clears the
ride-model filter on the way to `hidden` and `resumeRide` pushes the unchanged
selection back — a correctness patch that exists only because there are two
filters to keep in step. With one, there is nothing to re-push.

**AND IT OVERTURNS F3's RIDE-START RESET, which is a decision, not a tidy-up.**
`RideHud` emptied its pills at the start of every ride — *"F3: hide every
scooter by default"*. That was reachable only because the pills owned a second
filter: emptying a ride-scoped copy left the rider's real filter alone. Against
one shared value the same line is a **filter wipe**, and §6.1's ONE MAP
guarantee — "entering a ride flow no longer wipes filters" — forbids it. The
reset was the last surviving counterexample to a guarantee this plan states as
already true.

So it goes, and the intent behind it survives in a better form: a rider who
wants an uncluttered ride view picks **`none`**, which is now a named state
they chose and which persists, instead of one imposed on every ride and
silently discarded at the end of it. The hand-off program argues the same way
from the other side — Phase 2's whole point is the *next* scooter, and a ride
view that hides every scooter by default hides it.

**Shipped.** `model-filter.ts` holds the three-state and the one `admits()`
that decides what each means; `devices.ts` has one model branch and one field;
the HUD renders from it and writes to it; the clear/re-push pair and the F3
reset are gone. The Filters drawer re-reads the value when it opens, which is
what "visible in the other when the rider gets there" buys — a live listener
would re-enter `setToggleGroup`, whose synthetic clicks drive the very handler
that would fire it.

### 6.3.3 Seam 2d — the ride-type filter was a THIRD way to say it

Not in the original plan; added after §6.3 shipped and the question was put
directly: should sitting/standing stop being a filter, with posture simply
documented per model?

**Yes for the control, no for the concept.** Posture was never an independent
signal. The API's `ingest.py` maps one Veo vehicle-type id to **both** the model
name and the sitting/standing value (`_KNOWN_VEHICLE_TYPES`: `1` → Astro /
standing, `3` → Cosmo / sitting, `4` → Apollo / sitting, `5` → Rover /
sitting). For a recognized model the two cannot disagree, so "seated only" was
"Cosmo or Apollo or Rover" with extra steps — and `MODELS_BY_RIDE_TYPE` was
already the documented mapping the question asked for, as a local copy of that
table's posture column.

**There is no correlation win, and that was the hypothesis worth testing.**
Nothing correlates posture against model, because posture *is* the model
upstream. What the deletion buys is the removal of a redundancy that was
**load-bearing**: `syncModelsToRideTypes` existed only because the two controls
could combine into a filter that shows nothing ("Seated" plus an Astro-only
model pick), and it had to be careful about it — preserving a narrower model
pick that could still produce the enabled types, expanding only in the genuinely
dead case, one-directional so a model tap never rewrote the pills. That, the
chip, the device-layer branch and the preset field all go with the control.

**What stays, and why deleting it would have been a mistake:**

| Kept | Because |
|---|---|
| `vehicle_use_type` on the API | A `SplitDimension` in the equity-compliance metrics, generating stored columns per equity region. `ingest.py` calls it "the accessibility-relevant split" — a rider who cannot stand needs a seated vehicle, so its distribution is an advocacy question |
| `rideTypeOf` | The device icon picks `use-sitting`/`use-standing`, and must answer for hardware with **no recognized model** — the one case a model-only rule cannot cover |
| `MODELS_BY_RIDE_TYPE` | The ride spec's model-widening rung ("anything you'd sit on the same way") and the Quick Filters' "No Standing" preset, which now reads it directly instead of setting a ride type and relying on the sync |

**The repo had already made this argument once, in the other direction.**
`ingest.py` keeps `use_type` separate from `form_factor` with the note that
"every vehicle here happens to agree with its (corrected) form_factor today, but
the two are tracked separately since GBFS's vocabulary and the
compliance-relevant distinction aren't guaranteed to be the same axis forever."
That is exactly why the field survives while the control does not: two tracked
fields cost nothing, two **controls** cost a sync and a dead-filter state.

### 6.3.1 Seam 2b — the camera has exactly TWO framings

**The regular map is never tilted.** It is built today with no pitch or rotate
restrictions at all, so a two-finger drag tilts it — and the navigation control
is registered `showCompass: false`, so there is **no visible way to undo that**.
A rider who tilts the map by accident is stuck with a tilted map. That is a bug
today, and under this phase it stops being reachable:

| | Pitch | Bearing | Where |
|---|---|---|---|
| **2D map** | **0, always** | 0 | everywhere outside the ride view |
| **3D ride view** | `RIDE_PITCH` (60) | tracks direction of travel | `ride-hud.ts`'s follow-cam |

Nothing in between, and no rider-reachable gesture that produces an
in-between. The work is to disable the pitch gesture on the map and let the
follow-cam keep driving pitch programmatically, which it already does.

**This also simplifies the restore.** `enterFollowCam` saves `{center, zoom,
pitch, bearing}` and `exitFollowCam` puts all four back — which, once the map
cannot be tilted, is saving a pitch that is always 0 and a bearing that is
always 0. Restoring the framing becomes **centre and zoom**, and the pitch and
bearing go back to the only values the 2D map is allowed to have. One less pair
of fields that can disagree with reality.

### 6.3.2 Seam 2c — 3D is a VIEW, not a mode, and the toggle already exists

The one mode this app keeps is the 3D ride view (`wireModes()` says so in
those words). What it does not yet have is a way in and out that reads as a
**view toggle** rather than as leaving the ride.

**The mechanism is already built and already correct — it is BRB.**
`pauseRide()` tears the follow-cam down *without* stopping a tracked ride: the
clock stays anchored, the shared watcher and track-store recording keep
running, and only the HUD's visual display leaves, so the map chrome returns.
`resumeRide()` re-mounts it. The hard parts — not double-counting the clock,
not moving a map the rider is reading for something else (`onFix`'s
`following` gate), trail and route-line visibility, theme restore, immersive
fullscreen — are all solved and commented.

**BRB STAYS AS IT IS.** An earlier draft of this section proposed renaming it
to a 2D/3D toggle; that is withdrawn. BRB is a rider saying *"I am stepping
away from this ride for a moment"*, and it reads correctly as that. A view
toggle is a different intent that happens to share a mechanism, and collapsing
the two would cost the clearer of the two names.

**What is left is a way back IN, and it belongs in the top bar.** The gap is
not the leaving, it is the returning: once the HUD is down, a live session has
no persistent affordance anywhere on the map. The rider is still on a ride —
clock anchored, watcher running, track recording — and the app shows them
nothing that says so or takes them back.

- a **live session is visible in the top bar** whenever the HUD is not up, and
  tapping it returns to the ride exactly where it was;
- it is an **in-and-out** control, not a one-way door: leaving again is the
  same gesture, and neither direction touches the clock, the watcher or the
  recording — the guarantee `brbStrategyFor(...) === "continue_tracking"`
  already makes, and the reason this is cheap to build on;
- the 3D framing stays reachable **without** a tracked ride, so a rider can use
  the view the app is proudest of while they are deciding, not only after
  committing. The follow-cam needs a GPS fix, not a ride id.

**What must not happen** is a third framing or a second entry point. If this
grows a "tilt slider" or a map that remembers a 40° pitch, both tables above
are void and the seam is back.

**Shipped, and smaller than this section expected.** The control already
existed: the top bar's `#free-ride` button is labelled "Ride Mode", and
`main.ts`'s `beforeOpen` already deflects a live doc to `RideHud.open()`, which
resumes a BRB'd ride exactly where it paused. The way back in WORKED. What it
did not do was **say so** — it read "Ride Mode — start recording a free ride"
the entire time a ride was running, so a rider who stepped away had no way to
tell their ride was still going, let alone one tap away. A control nobody can
see is the same as no control, which is what "the gap is not the leaving, it is
the returning" turned out to mean in practice.

So `ride-reentry.ts` answers one question — *given the session doc, what is
this button right now?* — as four named intents, and the button renders and
acts from the same answer. A ride in flight lights it and changes its
accessible name; the fact lives in the name, not only in the colour.

**One correction to this section.** It asks for an "in-and-out control" where
"leaving again is the same gesture". A single control cannot do both halves:
`body.ride-active` sets `.topbar { display: none }`, so the top bar is not on
screen while the HUD is up. BRB stays the way out — as it should, per the
paragraph above — and the top bar is the way in. What holds, and what the tests
assert, is that the PAIR is repeatable and that neither direction touches the
clock, the watcher or the recording.

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

**Shipped, and seam 2 did most of it.** Honouring the spec needed no wiring in
the end: a spec projects onto the model filter, and after §6.3 the HUD's pills
ARE that filter, so a ride opens matching the attached spec by construction.
Detaching likewise — `main.ts` hangs the detach off `devices.onCountsChange`,
"the one signal that fires for all of them", and a pill tap now goes through
`setModelSelection`, which fires it.

**But seam 2 left a third copy of the filter, and this seam is where it would
have bitten.** `main.ts` held `modelsOn`, a module-level `Set` written only by
the Filters drawer's toggle handler, and `snapshotFilters` reads it — which is
what `noticeFilterChange` compares against its projection. So once the pills
began writing the shared selection, a pill tap changed the map and left the
snapshot stale: `sameFilters` saw no change, nothing detached, and the spec went
on claiming to show "only my ideal scooters" over a map it no longer matched.
`modelsOn` is now derived from `devices.modelSelection_()`. **Two copies were
visible in §6.3's table; the third was not, and unifying two of three is worse
than leaving all three, because the remaining disagreement is the silent one.**

What was left to build is the sentence: the Show row names the attached spec
and says that changing a pill detaches it. Rendered **live**, not baked into the
markup, because the attachment can end while the HUD is up — a note that
outlived its attachment would be the same staleness this seam removes.

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

**`theme` was not misnamed, it was INERT — so it is deleted, not renamed.**
`ride-screen-routes.ts` never mentioned it. Nothing read it on any screen: it
was defaulted, copied into `RideOptions`, validated on recovery, stored in
`tracked_rides.ride_options` and in Usuals, echoed back by the server, and
consumed by no one — the only references outside that chain were test fixtures.
Renaming it would have codified an intention nothing implements. The deletion is
client-only and needs no migration: the server's `_serialize_ride_options`
validates `if key in options`, so an absent key is simply not checked, and
`parseRideSession` is a version-skewed read that builds an explicit object, so
blobs already carrying `theme` still parse and drop it.

**The audit, which found a worse problem than the naming.** Every question
either flow asks, against the per-ride-or-standing test:

| Field | Asked where | Read? | Verdict |
|---|---|---|---|
| `save_tracks` | nowhere — Settings → Local Data | yes | **Correct, and the precedent.** A rider who wants their tracks wants them every ride |
| `navigation` | pre-flight | yes | Genuinely per-ride — turn-by-turn is a property of *this* trip |
| `cost_hud` | pre-flight only | **yes, now** | **Open question for the owner.** One entrance asks, the other dropped its row. Plausibly standing, like Save Tracks |
| `speedometer` | **nowhere** | **yes, now** | **A control that went missing.** Read, three meaningful values, pinned to `"classic"` for every rider forever |
| `battery_modeling`, `nav_improvement`, `end_survey` | Screens 9/10 | yes | Correct — asked once the data exists, not pre-committed |
| `theme` | nowhere | **no** | Deleted (above) |

**`ride-settings.ts`'s header had gone stale, and that is the drift this seam is
about.** It justified removing the Cost HUD and Speedometer rows on the grounds
that "both `RideOptions` fields were never actually read by `ride-hud.ts`" —
true when written, false now: that module says "`RideOptions.cost_hud` finally
being READ" and "`RideOptions.speedometer`, finally read", and applies both in
`renderRiding`. A reader trusting the old paragraph would have concluded the
fields were dead and deleted them, blanking the readouts. The paragraph now
records what expired and what each absence costs.

**Not done, because they are the owner's calls, not a refactor's:** whether
`cost_hud` becomes a standing setting, and where `speedometer` gets asked.

### 6.6 Tests

- `#mode-switch` is absent from `index.html`, and no module queries it.
- Entering and leaving a ride leaves every filter, drawer tab and iconography
  setting exactly as it was — the ONE MAP guarantee, now asserted rather than
  described.
- **One filter, asserted as one value**: a change made in the drawer is
  readable from the HUD and vice versa, with no copy step between them. The
  three-state selection round-trips — `all`, `only(models)`, `none` — and
  `none` hides unrecognized hardware too, which is the case the old empty set
  got wrong in two different directions.
- The `setState`/`resumeRide` re-push is **gone**, not merely working: nothing
  clears a filter on a state change, so nothing has to put it back.

**The camera, which is where this phase could do visible harm:**

- **The 2D map cannot be tilted by any gesture.** Drive the pitch gesture
  directly and assert `getPitch() === 0` after it. This is the test that would
  have caught today's bug, where the map tilts and `showCompass: false` leaves
  no way back.
- **The framing round-trips.** Entering the 3D view pitches to `RIDE_PITCH`;
  leaving restores the rider's centre and zoom and returns pitch and bearing
  to 0. Asserted as one gesture, because undoing one and not the others leaves
  the map somewhere nobody chose.
- **Popping out and back in does not touch the ride.** With a tracked ride
  live, 2D → 3D → 2D leaves the clock anchored, the watcher running and the
  track recording unbroken — the guarantee `pauseRide` already makes, now
  asserted because a view toggle will be used far more often than a pause was.
- **The 3D view opens without a ride id.** It needs a GPS fix, not a
  commitment.
- With a spec attached, the HUD's initial pill state equals
  `toFilterSnapshot(spec).models`; changing a pill detaches, once.
- No `RideOptions` field is written by two surfaces meaning two things.

### 6.7 The third answer — "I've already started one"

The home bar asks two questions, and the second one had two answers: *Need
wheels* and *Got my own*. There is a third kind of rider, and the two-answer
version had nowhere to put them: **somebody sitting on a Veo scooter they have
already unlocked.**

They used to pick "Got my own", because it is the one that skips the picker, and
every consequence of that was wrong. An own-device ride is `own_device: true` —
which means a private ride, no `tracked_rides` row, the cost readout forced OFF
(there is no Veo billing clock to picture), and no vehicle on the doc. So a
rider who had *just paid to unlock a scooter* got a trip priced at zero, no
meter on the screen at the exact moment a meter is worth most, and a record
saying they rode nothing in particular — no model-bonus question, nothing to
correlate against the fleet, nothing the post-ride survey could be about.

**Both answers skip the picker. That is the only thing they have in common**,
and reading it as "they already have wheels, same thing" is what made one answer
do two jobs badly.

| | Need wheels | **Already started one** | Got my own |
|---|---|---|---|
| Picker | the ranked list + walk flow | **skipped** | skipped |
| Vehicle on the doc | chosen on Screen 2 | **the scanned one** | `{ own: true }` |
| Veo rental running | not yet | **yes, billing now** | no |
| `own_device` | false | **false** | true |
| Cost readout | on | **on — the point** | off, forced |
| Ride record | tracked | **tracked** | private |

#### 6.7.1 It requires a scan, and that is not friction to be optimised away

The whole answer is "this one, the one I am sitting on", and the thing that
names a vehicle server-side is a salted hash no browser can compute. The sticker
on the handlebar stem is the only thing within the rider's reach that carries
it. So the scan is not a confirmation step bolted onto the answer — it *is* the
answer, and there is no cheaper version:

- A typed plate would be a claim about a vehicle the rider might not be on,
  which is the exact distinction master §13.8.1 turns on when it decides which
  watches may text.
- The nearest device to a GPS fix is a guess, and two scooters racked side by
  side is the common case this app already refuses to guess at
  (`gbfs.ts`'s `cachedPlateFor`: "missing beats wrong").

The blurb on the button says so — *"I've unlocked a Veo — scan it"* — because a
rider who taps this expecting to just go would rather have known about the
camera one tap earlier.

#### 6.7.2 `onPlanTrip` can be refused

This is the first answer whose host needs something from the rider before it can
act, and therefore the first that can fail *after* the question is answered. A
rider who backs out of the camera has not changed their mind about where they are
going, and losing the destination they just typed would be the app punishing them
for looking.

So `onPlanTrip` may return `false` (or a promise of it): the bar stays exactly
where it is, destination and start point intact, and they can answer again —
including differently. Anything else, including the `void` every existing caller
returns, still means taken.

Two details that are rules rather than taste:

- **The bar does not know a scan is what happened.** It knows the host declined.
  Teaching it about cameras and vehicle resolution would put the flow's
  knowledge in the renderer, which is the thing this module's header is about.
- **A synchronous host still collapses in the same tick.** Routing every answer
  through a microtask would leave the bar sitting over a wizard that has already
  opened — a flicker nobody would be able to place six months later.

Every choice is held while one is pending, not just this one: two scanners
racing because a thumb bounced is a worse bug than a slow button.

#### 6.7.3 What it hands the wizard

Everything the wizard would otherwise ask is already answered — which scooter
(the scan), where to (the home bar), and whether it is unlocked (that is what
this answer *means*). So: `deviceConfirmed` skips Screen 2, the destination
skips Screen 3, and `autoStart` puts Screen 6 straight onto its "I already
started" branch — **the same branch the device card's own "I started the Veo
already" takes**, because it is the same claim arriving through a different door
and must not produce a different session.

Screen 4 still shows. The rider named a destination and route choice is what
they named it *for*; a running meter is a reason to make that screen quick, not
a reason to skip the thing they asked for.

**One honest imprecision**, recorded rather than hidden: the ride clock starts
when `POST /tracked-rides` does, and the unlock happened a minute or two
earlier, so the cost readout under-counts by that much. The HUD's ±15s/±1m
nudges and its reset exist for exactly this and are the right place to fix it.
Inventing an earlier start time on the rider's behalf would be guessing at the
number Veo is actually billing them on.

#### 6.7.4 Tests

- The three answers are offered in order, none preselected — the no-default rule
  re-asserted across all three, because a third option is when a rule like that
  quietly acquires a "sensible" default.
- `wheels: "started"` is handed over, and is **not** `"own"`.
- A refused trip keeps the destination, re-enables the buttons, and dispatches
  nothing.
- A refusal that arrives asynchronously does the same, and the pressed button is
  visibly held until it does.
- Three rapid taps start **one** hand-off.
- A host that throws is a host that did not take the trip.
- A synchronous host collapses the bar in the same tick.

### 6.8 Out of bounds

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

> **Already fixed by the time this phase ran.** Phase 6 replaced the click with
> `enterFindWheels()`, and `mode-bar-gone.test.ts` is why — it asserts that no
> code anywhere looks for `#mode-switch`. §7.3 moved the CTA once more, from a
> map STATE to the home bar's own question; the dead-click bug itself was
> already gone. The failure is still the one §7.4's audit test is built around,
> because it is the shape that recurs: a tour making a claim about a control
> that no longer resolves.

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

**Shipped.** The audit left behind as `onboarding-audit.test.ts`, per §7.4.

Two notes on what the list below turned out to mean:

- **"Phases 1 and 4 earn a screen or a sentence each" — Phase 4 is moot.**
  `my-scooters.ts` was built and deleted as the wrong feature, so there is no
  "My Scooters" to tell a rider about. What earned the sentence instead is
  **Phase 2's hand-off plan**, which is the largest thing the app does that no
  screen mentioned. It went on the `routing` screen rather than a ninth screen:
  a hand-off IS routing, and the tour's own success criterion is five ideas in
  under 60 seconds.
- **The `models` screen also had to drop a filter that no longer exists.** It
  offered "standing or seated", which §6.3.3 deleted — posture is a property of
  the model, so the model is the filter. The plan listed only the saved
  view/spec problem on that screen.

One more drift, recorded because it is the same class of error one layer out:
the module header described a **seven**-screen tour and there are eight.


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

Master plan §12. Phases 8, 9 and 10 **each** add a stored data category
(receipt submissions here, a live trip plan in §9, an advocacy mailbox in §10)
— three more than the rest of the program combined. This one is the most
sensitive of the three, so the house rules below are not boilerplate.

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
| `receipt-panel.ts` | Drop zone, the confirm-what-we-read step, the verdict, the **complaint action** (§8.5's `mailto:`, with the clipboard only as the overflow fallback), the contribute toggle. Renders; decides nothing. |
| `account-confirm.ts` | Profile screenshot **or** typing, yielding the account identifier and **nothing else**. |
| `equity-areas.ts` *(existing)* | **Untouched.** `isInEquityArea` already answers the geographic half. |
| `ride-cost.ts` *(existing)* | **Untouched.** `RATE_PLANS` and `EQUITY_AREA_RATE` are what "expected charge" means. |
| `config.ts` *(existing)* | Gains the support address, in one place beside the rate plans. |
| `api.ts` *(existing)* | Gains the receipt **submit / list / withdraw** clients (§8.6). Only those three touch the network — reading the screenshot, the verdict and the `mailto:` are entirely local — and they belong here rather than in `receipt-panel.ts`, per the house rule at the top of this document. |

### 8.3 Confirm what we read — the step that must not be skippable

The extracted figures are shown **over the rider's own screenshot**, field by
field, editable, **before either complaint path is reachable** and before
anything is submitted — wording chosen after §8.5 made the `mailto:` primary,
since "before anything is copied" gated only the fallback. Not a toast, not a
summary line: the actual numbers, where they came from, waiting for a tap.

This is the whole defence against risk 15. Receipt layouts change without
notice, and a misread total is a rider sent to lose an argument in public.

### 8.4 The bar, and why "cannot tell" is a feature

**Shipped as `receipt-verdict.ts`**, ahead of the rest of the phase: it is pure,
it is the part that decides whether this app sends a rider to argue with Veo,
and it does not depend on the OCR question §8.1 leaves open.

Three things the section did not settle, decided here and flagged as decisions:

- **Confirmation is enforced by a TYPE, not a boolean.** `receiptVerdict` takes
  a `ConfirmedReceipt`, and only `confirmRead()` produces one. §8.4's third
  condition then cannot be forgotten by a caller, and it is why the reason enum
  needs no code for "unconfirmed" — such a receipt never reaches the verdict.
- **`inside_margin` and `matches_expected` are different answers.** A charge a
  few cents OVER lands on `cannot_tell` / `inside_margin`; one at or below the
  expected figure is `correct` / `matches_expected`. The alternative — calling
  the whole margin "correct" — would have the verdict assert a charge is right
  when all we know is that we cannot prove otherwise.
- **`veoplus_unmodelled` is an interpretation, and the opposite reading is
  recorded beside it.** `expected` includes the area's $1 under the worse
  reading, so a Pass rider whose charge matches it may have paid a dollar they
  did not owe. We will not claim it (unprovable) and do not bless it either:
  `cannot_tell`, because "correct" would tell them to stop looking. A Pass rider
  a full unlock LIGHT is `correct` — that is the better reading having been
  applied, not an ambiguity.

**`config.ts`'s support address ships EMPTY, on purpose.** Every other Veo
endpoint in that file was verified against something Veo publishes; a
plausible-looking address is worse than none, because the complaint path's whole
value is that it reaches somebody. `complaintReady()` is what stops a blank
`mailto:` shipping as a working feature, and a test pins it.

**Still to build:** `receipt-read.ts` (§8.1's OCR decision is still open, and
manual entry is the stated fallback), `receipt-panel.ts`, `account-confirm.ts`,
and §8.6's three API clients.


All three, or no claim is made:

1. the trip **demonstrably** starts or ends inside an Equity Area polygon;
2. the confirmed charge **demonstrably EXCEEDS** the applicable expected
   charge — not merely differs from it;
3. the rider has **confirmed** the figures.

**"Differs" is the wrong test**, and master plan §12.5 corrected it for a
reason worth repeating here: a promotional rate, a credit or a free Access trip
all differ from $1 + 13¢/min while leaving the rider **better off**, and a tool
that writes to support about those is worse than useless to the people it is
for. So the comparison is one-sided, and it has to absorb the ways a correct
charge legitimately fails to equal the arithmetic — `billableMinutes` is `ceil`
with a floor of 1 (`ride-cost.ts`), `estimateWithTax` adds tax on top of
`unlock + perMin`, and a **10¢ margin** covers the remainder. Below the bar,
inside the margin, or unresolved: `cannot_tell`, never `overcharged`.

**10¢ has a real ceiling rather than being a matter of taste** (master plan
§12.5): one minute of the Equity Area discount is **12¢** — 25¢ base against 13¢
— so a margin at or above that makes the **shortest trips unprovable**, which is
the opposite of this phase's purpose. Below it, the only thing to clear is tax
rounding, a cent or two. If the figure is ever revisited, that upper bound is
the part to keep.

**Many receipts show time and money but no geography**, and the question is
geographic. So: match by time to the rider's own tracked ride when one exists
and use its geometry; when none does, check the arithmetic only and return
`cannot_tell` with the reason. VeoPlus stays unmodelled per master plan
§9.2.3 — a receipt differing only by that unlock is `cannot_tell`, not an
overcharge.

### 8.5 The complaint

**Shipped as `receipt-complaint.ts`** — the draft and the routing decision, pure.
The panel that renders it, and the clipboard write itself, are still to build.

Two notes:

- **The gate is a type, and it covers both paths at once.** §8.7 warns that
  "gating only one of them means an unconfirmed complaint can still be opened
  and sent", and a boolean checked in two places is the shape that gets checked
  in one. So both routes take an `OverchargeFinding`, only
  `overchargeFinding()` makes one, and it only accepts an `overcharged`
  verdict — which only a `ConfirmedReceipt` can produce. The chain is
  confirm → verdict → finding → complaint and no link is skippable.
- **The recipient is injected, not read from `config.ts`.** The module reached
  for `VEO_SUPPORT_EMAIL` first, and that made the length-threshold branch
  untestable: the address ships empty, so the route always took its no-address
  path and §8.7's "both sides of 1,800" could not be asserted at all. A hidden
  dependency that only one branch can be reached through is a hidden dependency
  that hides a branch.


**The rider sends it**, from their own address, to the support address in
`config.ts`. The app never sends it, and this is not a limitation to route
around: sending it would mean this project asserting a contract claim on
somebody's behalf, from an address they do not control.

**A `mailto:` link is the mechanism, not a clipboard copy**, and the reason is
§10's CC: **text in a body cannot set a recipient.** A copied body leaves the
rider to type the addresses themselves, which is exactly where an opted-in CC
silently fails to happen. So the primary action opens their own mail client
with `to`, `cc`, `subject` and `body` already populated — the rider still
reviews and sends, and the CC is a real header rather than a line of prose.

**The fallback, because `mailto:` has a length limit** that varies by client
and platform — and **"when the body would overflow" is not implementable**, so
it is not the condition:

- no client exposes a "this would overflow" signal, and a `mailto:` that is
  too long **opens a silently truncated draft** rather than failing, which is
  the worst available outcome: a complaint that looks sent and is missing its
  figures;
- the limit applies to the **fully percent-encoded URI**, not to the body — and
  encoding can more than double a body's length, so measuring the body
  measures the wrong string.

So: build the complete `mailto:` URI, **measure its encoded length**, and take
the clipboard route when it exceeds **1,800 characters** — a conservative
threshold chosen below the smallest limit in common circulation rather than
tuned to any one client. **And the clipboard route is always available anyway**,
as its own control, so the rider is never dependent on our estimate of a limit
we cannot query.

The clipboard route shows `To:` and any `Cc:` **as their own copyable fields**.
A fallback that drops the CC into prose is the bug this section exists to
prevent, so the CC must never degrade into body text. §8.7 covers the boundary
either side of 1,800.

The body carries: the **account identifier** (§8.3's only purpose — without it
the complaint cannot credibly say whose trip this was), the trip, the charge,
the expected charge, then the Exhibit A §5.2 citation underneath. Facts and a
reference, no adjectives — at the single-receipt level an overcharge is
indistinguishable from a bug, and it should read like the billing query it is.

### 8.6 Contributing, and withdrawing

Checking your own receipt contributes **nothing** by default. Contributing is a
separate deliberate tap, and the panel must show what leaves the device: the
date, the area, the charged rate and the expected rate. Not coordinates, not
the account identifier, not the image.

**The complaint body carries the account identifier and this payload does
not**, which looks inconsistent and is the point. The complaint is *about one
rider's trip* and goes to the operator who billed them, so it has to say whose
trip it was. The pile answers *"how often is the discount applied"*, which
needs no one's identity at all — and the cheapest way to keep a statistical
record from becoming a movement record is for it never to carry one.

Withdrawal is offered wherever the submissions are listed and must actually
delete — a consent you cannot withdraw is not one.

### 8.7 Tests

- A receipt with no locations and no matching tracked ride returns
  `cannot_tell`, never `overcharged` — the single most important assertion in
  this phase.
- A receipt charged **less** than the expected charge — a promotion, a credit,
  a free Access trip — returns `correct` or `cannot_tell` and **never**
  `overcharged`. The one-sided comparison has a test because "differs" is the
  natural way to write the condition and the way it was written first.
- A charge explained **entirely** by billable-minute rounding and tax returns
  `correct`: that is the expected figure computed properly rather than a near
  miss, and `correct` has to stay reachable or the evidence pile can never
  record the discount **being applied** — the question it exists to answer.
- A charge **exceeding** the expectation returns `cannot_tell` until it exceeds
  it by **more than** the 10¢ margin — never `correct`, never `overcharged`
  below that (master plan §12.5). **The comparison is strict, and the three
  verdicts are pinned so a test cannot pick its own operator:**

  | Excess over the expected charge | Verdict |
  |---|---|
  | 9¢ | `cannot_tell` |
  | **10¢ — the margin itself** | `cannot_tell` |
  | 11¢ | `overcharged` |

  The two sub-threshold cases read like the `correct` case above and are not:
  one is arithmetic we can account for, the other is a gap we cannot explain
  and will not accuse anybody over.
- A receipt differing from the expected charge only by the $1 unlock, for a
  VeoPlus rider, returns `cannot_tell`.
- A trip starting inside a polygon and charged at the base rate returns
  `overcharged`, and the **`mailto:`'s parsed `body` parameter** contains the
  account identifier, the trip, both figures and the citation. The clipboard
  fallback is asserted separately, on the same content — testing only the
  fallback would let the normal mail draft omit all of it (§8.5 made
  `mailto:` the primary path, and this assertion was left behind).
- A complaint whose encoded `mailto:` URI is **1,800 characters** opens the
  draft; **1,801** takes the clipboard route, with `To:` and `Cc:` as their own
  fields. Both sides of the boundary, because the failure being prevented is a
  silently truncated draft rather than an error.
- **Neither complaint path is reachable until the rider has confirmed the
  figures** — not the `mailto:` and not the fallback copy. Gating only one of
  them means an unconfirmed complaint can still be opened and sent, which is
  the failure §8.3 exists to prevent.
- `account-confirm.ts` yields the identifier and no other field, from a
  fixture containing a name, phone and card fragment.
- The contribute payload contains no coordinates, no account identifier and
  no image, asserted field-by-field against an allowlist rather than by
  spot-check.

---

## Phase 9 — Reaching the rider

Master plan §13. Formerly "Pocket-proof"; the name described the problem and
dodged the mechanism, and the mechanism is SMS.

### 9.1 What this lane owes, which is less than it looks

The API side already has outbound SMS with consent, quota and fallback
(`comms.py`), and verified phone numbers on the profile. So this lane is: an
opt-in control, a resume entry point, and bounding the rapid check.

| Module | Responsibility |
|---|---|
| `trip-alerts.ts` | The opt-in's state and the rules about *what* earns a text (§9.3). **Pure** — the decision is testable without a network. |
| `plan-resume.ts` | Reading a resume link, holding the plan reference across a sign-in, and re-entering the plan. **Pure** given a URL and a store. |
| `trip-plan.ts` *(Phase 3)* | Gains the targeted-check loop and its bounds (§9.4). It owns *when* to check and *when to stop*; it does not own the request. |
| `api.ts` *(existing)* | Gains `fetchPlanCriticalState(ids, signal)`, the typed client for the targeted check (§9.4), the trip-alert opt-in's read/write, and the **live-plan lifecycle** — `createPlan`, `updatePlan`, `finishPlan` (master plan §13.6). **The house rule at the top of this document is that API calls go through `api.ts`** — so the state machine must not reach the network itself, however small the call looks. |
| `trip-plan.ts` *(lifecycle)* | Calls `createPlan` **on the plan the rider chose**, `updatePlan` on each re-solve, `finishPlan` on arrival or abandonment. Not optional plumbing: without `create` the server watcher has nothing to watch and the resume link nothing to resume — `fetchPlanCriticalState` reads **vehicles**, and the server cannot infer which of the offered backups was taken. Without `finish` the watcher runs to its ceiling and texts about a trip that already ended. |
| `locate.ts` *(existing)* | **Not untouched** — it exports `WALK_METERS_PER_MIN` for Phase 2 (§2.1), the one code change in this PR. Nothing else about it moves. |

### 9.2 The opt-in, and the distinction that justifies it

A rider who typed their number to get a **sign-in code** has not agreed to be
texted about **scooters**. `comms.py` honours STOP across every app on the
shared number, which is the floor, not the duty.

So: a separate, revocable opt-in, asked **when a rider starts a hand-off
plan** — the moment it is obviously useful — and never as a wall in front of
the feature. The copy states what is sent, roughly how often, that message and
data rates apply, and how to stop.

**A plan never requires SMS.** Everything works with it off. If the opt-in ever
becomes load-bearing, that is a bug in this phase.

If the profile has no phone number, offer to add one *there*, through the
existing `POST /api/v1/profile/phone/{code,verify}` flow. Do not invent a
second place to put a phone number.

### 9.3 What earns a text

| Event | In-app | SMS |
|---|---|---|
| Your pickup is gone; you have been moved | yes | **yes** |
| The plan changed where you are going | yes | **yes** |
| A better option appeared and we took it | yes | no |
| Re-solved, nothing actionable changed | no | no |
| Plan complete | yes | no |
| A scooter you scanned and asked to watch has moved (§9.7) | yes | **yes, on opt-in** |

The watch row is **outside the per-trip ceiling below**, and has to be, because
a watch is not a trip: it is armed at a kerb, often with no trip in progress at
all, and it sends exactly once before ending itself (§9.7, master §13.8.4). Its
budget is one, enforced by the watch closing, which is a tighter cap than any
number a ceiling could name.

`dibs-notify.ts` caps itself at four alerts per claim *on purpose*, and **three
texts per trip** is the hard ceiling on top of that (master plan §13.3). Three,
because both SMS-worthy events above are "where you are going has changed", and
a trip producing a fourth is going wrong in a way a fourth text does not fix —
by then the app is the place to look, and a phone that has buzzed four times is
one whose next alert gets ignored. An unstated ceiling lets the "ceiling holds"
test pick its own number and pass, which is the safeguard defeating itself.

"We checked and it is fine" is never sent — that is not reassurance, it is
attrition.

### 9.4 The rapid check: narrow, not fast

**Do not raise the global poll.** `REFRESH_MS = 90_000` already polls faster
than the data behind it moves: the API's ingest runs every 2 minutes, so a
20-second global poll re-reads the same cycle six times — six times the load,
zero extra freshness.

What delivers 20-second news is reading the **1–5 vehicles the live plan
depends on** out of a snapshot the **API** refreshes — and the ownership
matters, because the master plan retracted the premise this paragraph used to
rest on.

**GBFS has no per-vehicle query.** `free_bike_status` is a whole-fleet feed,
so a *client-triggered* upstream check every 20 seconds would multiply
full-feed fetches by the number of riding riders. So:

| | Who | What |
|---|---|---|
| **One coalesced 20-second full-feed fetch** | the **API** | shared by every live plan — O(1) in riders |
| **Reading 1–5 IDs out of that snapshot** | this client | cheap, and never touches upstream itself |

This client therefore never reaches upstream and never triggers a fetch of its
own; it asks the API for the plan-critical subset of the snapshot the API is
already maintaining. Master plan §13.4 carries the arithmetic.

Bounds, all of them testable:

- only while a plan is live;
- only while the document is **foregrounded** (`visibilitychange` stops it);
- stopping on completion and abandonment;
- never touching `REFRESH_MS` or the fleet refresh.

**And that is only half the mechanism — the other half is not in this repo.**
Stopping on `visibilitychange` means this client detects nothing once the tab
is backgrounded, so on its own it could never trigger the SMS §9.3 promises.
Master plan §13.4.1 therefore requires a **bounded API-side watcher** over the
stored live plan, running regardless of the tab:

| | Runs where | While |
|---|---|---|
| This client's check | the browser | a plan is live **and foregrounded** |
| **The server watcher** | **the API** (not this lane) | the plan is live, **tab or no tab** — bounded by the plan's lifetime and a hard ceiling |

So this lane must **not** be built as though foreground checking were the whole
story, and the acceptance test that matters is the one it cannot satisfy
alone: **pickup loss detected while the app is backgrounded or closed.** It is
listed as a dependency in §Sequencing for that reason.

### 9.5 The resume link

**The link carries a plan reference. It does not carry a session.** An SMS
renders on a lock screen, persists in carrier logs, gets screenshotted and
lands on shared handsets.

- session alive → the plan resumes;
- session gone → the normal sign-in, **then** the plan resumes.

The `?ml=` magic-link flow is the precedent, including the question
`main.ts:636` already asks about whether a deep link belongs to whoever holds
it. The plan reference must survive the sign-in round trip, which is the one
fiddly part — and it is `plan-resume.ts`'s whole job.

### 9.6 Tests

- `phone_verified` without the trip-alert opt-in sends nothing.
- **The third eligible SMS sends and the fourth is suppressed**, across a plan
  that re-solves many times — and the suppressed event is **still visible
  in-app**, so the rider loses the text and not the information. Pinned at the
  boundary rather than "the ceiling holds", because a generic assertion picks
  its own ceiling and passes, which §9.3 names as the exact way this safeguard
  defeats itself.
- A re-solve with nothing actionable sends nothing on either channel.
- The targeted check stops on `visibilitychange`, completion and abandonment,
  and never changes the fleet refresh interval.
- A resume link with a dead session lands on sign-in and *then* the plan.
- **The resume link grants no access on its own** — asserted, because this is
  precisely what a later refactor "simplifies" into a token.

### 9.7 Texting a watched scooter's departure

Master plan §13.8. The in-app half of this ships — `device-notify.ts` and the
Tools-drawer list that replaced Favorite Scooters — and its copy is careful to
promise only "while the app is open", because a closed tab detects nothing.
This is the other half.

> **REVISED, AND THE REVISION IS THE IMPORTANT PART.** This section was first
> written against a version of the in-app watch that could be armed from the
> 🔔 bell on **any** device popup. That bell has been deleted. "Tell me when
> this vehicle leaves this address" is a tracking tool — the scooter parked
> outside a house is a proxy for the person inside it, and an ex's, a
> partner's or a shelter's address is the use case nobody writes in a feature
> request. The capability now requires a present, demonstrated connection to
> the specific vehicle, it expires with that connection, and there are exactly
> two origins: a **dibs claim** made while building a route (max 2, dies with
> the claim, so ≤25 minutes and within a 15-minute walk), and the **end of a
> ride** on that scooter (1, two hours, offered once). `device-notify.ts`'s
> header is the normative statement; everything below is downstream of it.

**One text, and its exact words:**

```
Astral Osprey 123 is no longer within 50m of where you scanned. This move was first observed at 2:32pm.
```

#### 9.7.1 Two origins, and proximity is NOT what separates them

This is the decision the rest of the section follows from, and it is the one
that changed.

| Armed from | Where it lives | In-app notice | SMS |
|---|---|---|---|
| a **dibs claim** while building a route (max 2) | `localStorage`, expiring with the claim | yes | **yes, on opt-in** |
| the **end of a ride** on that scooter (max 1, 2 h) | `localStorage` | yes | **yes, on opt-in** |
| anything else — a bell, a tap on the map, a bare scan | **nowhere. It cannot be armed.** | — | — |

**The first draft of this section got the line in the wrong place.** It
proposed that a QR scan — proof the rider stood within 75 m — was what earned
the SMS tier, with the map's bell staying local-only. Both halves of that are
wrong now:

* **A bell on the map had to go entirely**, not be held back from SMS. An
  in-app-only tracker is still a tracker; the rider watching an address does
  not mind opening the app.
* **A scan is not a meaningful barrier.** Standing beside a scooter for ten
  seconds is something anyone outside the building can do. Proof of presence
  at a VEHICLE is not proof of a relationship to it, and §8.4's rule — you
  may know where a vehicle is standing, you may not follow it — is not
  satisfied by having been there once.

What the two surviving origins have in common is not proximity but
**commitment that expires**: a claim is a vehicle this rider is walking to
right now, and a finished ride is one they were just on. Both are states the
rider cannot manufacture about a stranger's address, and both end on their own.
That, rather than metres, is what makes an SMS defensible — and it is why the
texted tier inherits exactly the same two doors and the same expiries.

#### 9.7.2 The dial does NOT gain a third position

`qr-utility.ts`'s header says a third job "is a third segment, not a third
flow", and this was going to be the first one to arrive: a 🔔 Notify-if-moved
position, scan a sticker, watch that scooter. **It is not being built**, for
§9.7.1's reason — a standalone scan is an arming path with no expiring
commitment behind it, which is the bell again with an extra step.

(The dial is also a segmented control now rather than a dial: two unordered
jobs, one applied to whatever the camera reads next. `modeAngle` and the
pointer geometry this section used to lean on are gone with it.)

So the texted tier is armed from the two origins in §9.7.1 and nowhere else:

* **With a claim.** `registerDibs` already posts the claim to the server with
  the vehicle, the position and the claimant. The move-watch is one more field
  on that request — `notify_sms: true` — not a second endpoint, and the
  server already holds everything the watch needs. It expires when the claim
  does, which the server also already computes.
* **At the end of a ride.** `PATCH /tracked-rides/{id}/end` is the one call
  Screen 8 makes. Same shape: one field, and the server has the vehicle and
  the end position in the request it is already handling.

**This deletes `POST /profile/device-move-watches` from the plan**, and with it
the `qr_raw_value` / 75 m-gate machinery master §13.8.7 specified for it. The
watch stops being a thing a rider can create directly and becomes a property of
a claim or a completed ride — which is a smaller API, a smaller table, and a
capability with no door that can be pointed at an address.

#### 9.7.3 The opt-in, asked once, at the moment it is useful

§9.2's rule, unchanged: a number typed for a sign-in code is not consent to be
texted about scooters. So the opt-in rides with whichever origin armed the
watch — the claim confirmation, or Screen 8's offer — using the same one grant
Phase 9's other texts use, not a second switch, asked at the moment the watch
is armed and never as a wall in front of it.

**Declining is a first-class answer.** The watch is still armed; it is simply
the local tier, with the in-app notice and no text. Nothing about this feature
requires SMS, and if it ever starts to, that is a bug in this phase.

No verified number on the profile → offer to add one in the Account drawer,
through the existing `POST /profile/phone/{code,verify}` flow. There is not a
second place to put a phone number.

#### 9.7.4 Fifty metres — and the number that has to change on this side

The threshold is 50 m, and master §13.8.2 has the production telemetry behind
it: against this fleet, 68% of consecutive samples of a *ridden* vehicle move
more than 50 m, against 0.2% of the parked fleet's GPS jitter.

`device-notify.ts` shipped at 25 m, picked before that measurement was
consulted. **It moves to 50**, and its comment should cite the measurement
rather than the reasoning it currently carries. Two thresholds for one question
is how the in-app notice and the text end up disagreeing in front of a rider who
received both — and that rider is the common case, because the text is for when
the app is shut and the notice fires the moment they open it again.

The local tier keeps measuring from the position the feed gave at arming time,
and the server tier measures from the scan anchor. Those are different points by
a few metres at most — a rider standing at a scooter — and the same 50 m.

#### 9.7.5 What this side must never render

Master §13.8.1's rule, restated here because this is the lane that would break
it: **the text says the scooter is gone, never where it went.** It is tempting,
and it is one line of code, to put the new position in the body so the rider does
not have to open the app. The app is allowed to show them — a parked scooter's
position is already public on the map — and the text is not, because a text
renders on a lock screen, persists in carrier logs, and gets screenshotted.

The place that temptation will surface on this side is the in-app toast and the
watch list, which both legitimately *do* show a position. Keeping the SMS body
server-composed (master §13.8.8) is deliberate for that reason: there is no
client-side string for someone to interpolate a coordinate into.

#### 9.7.6 Modules

| Module | Responsibility |
|---|---|
| `device-notify.ts` *(existing)* | Already carries the gated policy: `WatchOrigin`, `WATCH_RULES` (the per-origin caps and TTLs), `expiresAt` on every watch, and `liveWatches`/`watchSlotsLeft`. The texted tier adds a per-watch `sms` flag and nothing else — the verdict, the message and the one-alert rule stay pure and stay local. |
| `device-notify-panel.ts` *(existing)* | Rows learn a tier: a row that will text says so, because "we'll tell you while the app is open" is the wrong promise for one that will. The status line stops being one sentence for every row. It still STARTS nothing. |
| `dibs-certificate.ts` *(existing)* | The claim confirmation already discloses that a watch was armed; it gains the SMS opt-in when the rider has no grant yet. |
| `ride-post-s8.ts` *(existing)* | The post-ride offer already exists and already arms the local watch; it gains the same opt-in. |
| `api.ts` *(existing)* | `notify_sms` on `registerDibs` and on the ride-end `PATCH`. **No `device-move-watches` endpoints** — see §9.7.2 for why they are deleted rather than deferred. |
| `trip-alerts.ts` *(§9.1)* | Gains nothing. Its opt-in is the grant this reuses — which is the point of it being one grant. |
| `qr-utility.ts` *(existing)* | Gains nothing, and that is the change: the third segment is not being built. |
| `main.ts` *(existing)* | Gains nothing. Both arming paths already route through `armDibsWatch` / `armRideEndWatch`. |

#### 9.7.7 Tests

- **A watch cannot be created from any origin but the two.** Asserted at the
  store boundary, not just by the absence of a button: a stored watch whose
  `origin` is anything else is treated as corrupt and dropped.
- **Every watch has an expiry, and an expired one is invisible to every
  reader.** This is the half of the design that makes the feature not a
  standing subscription, so it is tested at the store rather than in the UI.
- A dibs watch inherits the CLAIM's expiry, not a duration of this feature's
  choosing — so releasing or losing the claim cannot leave a watch behind.
- The caps are per origin: a third claimed scooter cannot evict the watch on
  the one the rider just rode.
- The ride-end offer is made once and never returns, including after a refusal.
- Declining the SMS opt-in still arms the watch, locally, and says so.
- A watch row that will text says so; a local one promises only "while the app
  is open". The two rows do not share a sentence.
- `MOVED_METERS` is 50, asserted against the constant rather than a literal, so
  the in-app verdict and the server's cannot drift.
- **The device popup renders no arming control at all** — asserted on the
  popup HTML, because the button is cheap to re-add and the harm is not
  visible in the diff that adds it.

---

## Phase 10 — Advocacy

Master plan §14. **Almost none of this is in this repo**, and that is worth
stating plainly so nobody builds it here: the inbound mail, the inbox, the
reply endpoint and the admin UI all already exist in
`zNeill/keepdenverfair`.

This lane owns exactly one thing: **the CC tick on the Phase 8 complaint.**

- Defaulted **off**, its own control, per complaint.
- **It sets a real `cc` recipient**, via §8.5's `mailto:`. An address written
  into body text is not a CC and would simply never reach the mailbox — so
  the test asserts the `cc` field, never a substring of the body. On the
  clipboard fallback the CC is its own copyable field, never prose.
- It states what the CC sees — the rider's own words, their account
  identifier, their trip times, their email address — because this is a
  **disclosure to a third party**, and a different one from contributing to
  the evidence pile (§8.6), which takes de-identified figures. Consenting to
  one is not consenting to the other and the UI must not imply it is.
- A rider who wanted backup last week has not volunteered for it forever.

Everything else — routing (`advocacy@weseeyouveo.com` already arrives, because
routing keys off the domain), the portal, mention detection, the reply guard,
the operator alert — is the other repo's. The receipt checker works
identically with the CC off, and if it ever stops doing so, that is a bug.

### 10.1 Tests

- The CC is off unless ticked, and the ticked state does not persist to the
  next complaint.
- Ticked, the `mailto:`'s **`cc` parameter** carries the advocacy address —
  asserted on the parsed recipient field, **not** on body text, because body
  text is exactly the mistake this replaced.
- On the clipboard fallback the CC is exposed as its own field, and never
  appended to the body.
- Phase 8's verdict and complaint paths behave identically with the CC off.

---

## Phase 11 — Ride mode, for somebody actually on a scooter

Ride mode works. A rider can plan a trip, claim a scooter, walk to it, start a
tracked ride, watch a speedometer and a cost estimate, follow a route, end the
ride, file a report and answer a survey. What follows is not a list of bugs; it
is the gap between that and a thing a rider reaches for twice.

**The organising observation: almost all of it assumes you are looking at the
phone.** A scooter has no cradle, no speakers, and no safe moment to read a
card. Ride mode is a rich visual HUD for a situation in which looking at a
screen is the single most dangerous thing the rider can do. Nearly every item
below is downstream of that.

### 11.1 It cannot be used while riding, and that is one fix

`ride-nav-hud.ts` draws an instruction card, a directional arrow and a
step list. To use any of it the rider looks down — at the exact moment they are
moving, in traffic, on a vehicle with 8-inch wheels. The honest summary of
turn-by-turn today is that it works while stopped.

**Shipped**, as `ride-announce.ts` (pure: what to say and when) plus
`ride-voice.ts` (the speech engine, the haptic, the remembered mute), wired into
`ride-hud.ts`'s existing per-fix pass.

**Turn cues are wired too**, by widening `NavHud`'s contract with an
`onManeuver` report rather than by rebuilding the match. That overlay is the only
place that knows — the matched shape index, the monotonic advance and the
along-route distance all live there — and a second derivation would be a second
answer to "which turn is next", differing from the one on screen precisely when
they disagree. The report carries the SAME distance the instruction card shows,
and it is cleared when guidance is dismissed: otherwise the last reported
maneuver sits there and is spoken the moment the rider happens to come within
range of a turn they are no longer being guided to.

Three things the section did not settle:

- **The free-minute figure is resolved ONCE per ride, at start**, and comes from
  §2.2's own estimate rather than from the HUD's clock. The HUD cannot know what
  the rider spent before it opened, and a balance that refreshes mid-ride can
  cross a threshold backwards and announce it twice.
- **A signed-out Access rider hears nothing.** Their estimate is the pessimistic
  zero, which is right for PRICING and wrong to say aloud: "your free minutes are
  used up", on every ride, to somebody who may have a full hour, is a confident
  false statement that trains them to ignore the one warning that matters.
- **Silence means "say nothing", never "stop watching".** A muted rider, or one
  stopped at a light with a popup open, crosses boundaries like anybody else. The
  announcer updates its baseline while silent, so a crossing missed under a popup
  is not announced later at some arbitrary moment.

**Voice and haptics, and they are the highest-value thing in this phase.**

- `speechSynthesis`, local, free, no backend, no permission prompt. One
  utterance per maneuver, spoken at a distance scaled to current speed (a
  fixed 100 m is too late at 15 mph and absurd at walking pace), deduped by
  maneuver index so a re-route or a GPS wobble cannot repeat it.
- `navigator.vibrate` as the "something changed" cue, where it exists — the
  rider feels the phone in a pocket and knows to listen, which is what makes
  audio work without headphones.
- **Prime it inside the Start tap.** Safari will not speak unless
  `speechSynthesis` has been touched inside a user gesture; Screen 6's start
  button is the only gesture guaranteed to precede a ride. A silent
  `speak("")` there is the whole fix, and discovering this in the field is a
  feature that works for every tester on Android and for nobody on iOS.
- **A hard mute, in the display panel, remembered.** Some riders have
  headphones in and some have a passenger; a HUD that cannot be silenced gets
  closed.
- **Never speak over the device popup or a modal** — the same rule the
  follow-cam already follows via `hasOpenPopup()`.

Tests worth having: one utterance per maneuver across a re-route; nothing
spoken while muted; the distance threshold scaling with speed; nothing spoken
when the ride is not `riding`.

### 11.2 The clock is a guess, and the rider is doing the reconciling

The HUD offers ±15s/±1m nudges and a reset because we cannot see Veo's billing
clock. That is an honest workaround, and it has become the rider's job.

> **NOT BUILT, AND BOTH HALVES NEED THE OWNER.** This section rests on two
> premises, and each has been overtaken by a later decision in this same
> codebase. Recorded rather than worked around, because forcing either would
> reverse a change that was made deliberately and for good reasons.
>
> **"Screen 8 already collects the truth" is no longer true.** `ride-post-s8.ts`
> stopped asking for battery, cost and minutes entirely, in a documented
> friction-reduction rewrite whose reasoning is strong: the form yanked focus
> between fields, riders never reached [Submit], so `endTrackedRide` never
> fired, `endReported` never dispatched, and **the ride never reached Screens
> 9/10's donation flow at all**. [Rush Quit] skipped those by design, so even
> the riders who escaped the broken form never got asked to donate. Screen 8 is
> now one button.
>
> So the per-rider calibration has no input. Building it means reintroducing the
> form that was deleted — and the calibration's value (a cost estimate that is
> roughly right rather than trusted) is smaller than the value of every ride
> reaching the donation flow. **If the owner wants the calibration, the input has
> to come from somewhere other than a blocking form** — the receipt reader of
> Phase 8 is the obvious candidate, since it already extracts a real total and
> real minutes from a screenshot the rider was going to look at anyway, and asks
> for nothing at the moment they are trying to leave.
>
> **"The QR scan is the start moment" is in tension with §6.7.3**, which states
> the opposite rule for the neighbouring case: *"Inventing an earlier start time
> on the rider's behalf would be guessing at the number Veo is actually billing
> them on."* The two are reconcilable — §6.7.3 is about a rider saying "I already
> started", where the unlock time is genuinely unknown, while a scan is a real
> timestamped event — and the reconciliation is a judgement call about whose
> clock we claim to know, which is not one to make silently. Worth noting that the
> scan precedes the unlock, so a scan-time start makes our clock run LONG, which
> is the safe direction for a cost estimate.
>
> `qr-ride-scan.ts`'s `QrRideAction` carries no timestamp today, so either answer
> is a small change.

Two things already in hand would mostly retire it:

- **The QR scan is the start moment.** Ride mode's scan (`qr-ride-scan.ts`)
  happens within seconds of the unlock, and we timestamp it. When a ride is
  started that way, the scan time is a better `startedAt` than "when the
  countdown finished", and no nudging is needed.
- **Screen 8 already collects the truth.** The rider types the real cost from
  the Veo app. That number, against our estimate, is a per-rider calibration:
  if every ride comes in 1m20s over, the next estimate should start there.
  Store an offset, apply it, show it ("your estimates have been running ~1
  min short"), and let the rider clear it. This is the difference between a
  counter that is roughly right and one they trust.

### 11.3 Nothing happens at the two moments money changes

The cost readout crosses both of these silently:

- **The equity-area boundary.** `equityAreaCostCents` already prices a ride
  inside one at 13¢/min against 39¢. Crossing in or out is the most
  on-mission event this app can observe, and the rider is told by a number
  getting smaller, if they happen to look. This is the first thing voice
  should say after turn cues: *"you're in an equity area now — 13 cents a
  minute."*
- **The free-minutes cliff.** Pass-holders have an allowance. The HUD knows
  the plan (`RATE_PLANS`, `savedRatePlan`) and the elapsed time, and says
  nothing as the allowance runs out. "Two minutes of your free time left" is
  worth more than every other number on the screen combined.

### 11.4 A ride that ends badly has no path

Three endings, one of which corrupts data:

1. **The phone dies, or the tab is killed.** Handled —
   `ride-resume-prompt.ts` and the recovery table in `ride-session.ts`.
2. **The rider walks away without finishing Screen 8.** The ride stays open.
   Recovery exists but is framed as "resume"; what is missing is the other
   offer: *"did your ride end at 4:12pm?"*, using the last fix's timestamp,
   which is the honest answer and one tap. Today the rider has to reconstruct
   it themselves, and a ride ended hours late is worse data than no ride.

   > **Shipped** as `ride-end-recovery.ts` plus a third button on
   > `ride-resume-prompt.ts`. `TrackTip.lastPointMs` is the source — when this
   > device last recorded a position for that ride.
   >
   > **IT CANNOT RECOVER *WHERE*, and the offer says so.** `EndRideIn` requires
   > `end_lat`/`end_lon`, so something has to go in them, and the only position
   > available at recovery time is where the rider is standing now. Quietly
   > sending that under a recovered timestamp would trade one wrong field for
   > another and call it a fix — so the copy names the limit, and the `metadata`
   > marks both fields' sources so a consumer can tell a recovered end from a
   > witnessed one.
   >
   > Three guards, each a case where the offer would be a guess dressed as a
   > recollection: a gap under two minutes (where "now" is the same answer and a
   > third button is noise), a last point before the ride began or in the future
   > (a clock problem), and a non-finite figure (`Intl.DateTimeFormat` throws on
   > one, and a prompt that throws while rendering leaves the rider unable to end
   > their ride at all — the one outcome worse than a late timestamp).
   >
   > It reads the track store only when `outcome.resume` exists, which is both
   > correct and free: that field means this device HAS a local track, so without
   > it `readTip` answers null anyway. It also carries the right key — `trackId`
   > is `ride.id` for a server ride today, and reading the plan's own id is
   > correct by construction rather than by coincidence.
3. **Something went wrong — a crash, a fall, a stop.** Nothing. There is no
   detection and no check-in. This is worth stating as a deliberate decision
   rather than an omission: a false "are you OK?" is alarming, and a missed
   real one is worse than never having promised. The minimum honest version is
   not detection at all but **a share-my-ride link** — somebody else can see
   the live track — which needs the API lane and is §9's shape.

### 11.5 Battery anxiety is unaddressed in both directions

We know more about a scooter's battery than the rider does: the reported
percentage at pickup, `max_observed_range_meters`, and the API's own
`battery_model.py`. Ride mode never uses it to answer the one question a rider
asks before setting off — *will this reach where I am going?*

- **Before:** Screen 2/6 should refuse quietly rather than cheerfully. A 14%
  Astro and a 6 km destination is a walk home, and we can see it coming.
- **During:** one warning, once, when the remaining route exceeds the modelled
  remaining range. Not a gauge — a sentence.

This is the item most likely to produce a wrong claim, so it wants a
confidence floor: no warning at all unless the model has a range observation
for that vehicle class, because "you might not make it" said wrongly teaches
the rider to ignore it.

### 11.6 Out of the zone, and the data we do not have

The expensive ending is parking somewhere that costs a fee. The app cannot warn
about it, and the reason is worth recording: **Veo publishes no
`geofencing_zones` feed.** Checked 2026-10-06 against
`cluster-prod.veoride.com/api/shares/name/den/gbfs/` — `system_information`
returns 200, `geofencing_zones` and `gbfs` both 404. There is no authoritative
operating area, no no-park zone and no slow zone available to us.

So the honest options are, in order:

1. **Use the fleet as its own parking dataset.** Thousands of currently-parked
   vehicles are thousands of positions where parking was, in practice,
   accepted. "Nine scooters are parked within 50 m of here" is a true
   statement that answers the rider's real question without claiming a
   boundary we cannot see. This is buildable today from data already on the
   client.
2. **Ask the city.** The permit area is likely in the same Open Data Catalog
   the equity areas came from. If it exists, it is authoritative for the
   *city's* rule, which is not identical to Veo's fee rule — and the copy
   would have to say which one it is.
3. **Invent nothing.** A drawn boundary we cannot source is exactly the kind of
   confident wrong claim this codebase refuses elsewhere.

### 11.7 The HUD has eight controls and one question

During a ride there is one question — *how much is this costing me and where do
I turn* — and one action: end. The HUD currently offers exit, end, adjust,
display-panel, re-center, nudges ×4, reset, rate select, theme, four display
chips and model filters, across two sliding panels.

The fix is not deleting features, it is admitting a hierarchy: the glanceable
readout, one primary action, everything else behind a single control. And the
controls belong at the **bottom** — a phone on a handlebar mount is reached
with a thumb from below, and the current cluster is at the top.

### 11.8 The ride ends and nothing accumulates

Screen 10 awards points. The track lands in IndexedDB and is visible in the
Account drawer's Local Data tab, which is not a place anybody goes. What is
missing from the end of a ride is the sentence that brings somebody back:
*that was your 12th ride, 38 miles, and you've saved $47 against the
comparator.* `equity-savings.ts` (Phase 5) already computes most of it. The
asset exists and the ride flow does not use it.

### 11.9 Leg two is a new ride

Screen 8's [New Destination] loops back to the wizard, which is the hand-off
plan's visible edge, but the HUD has no concept of a trip with legs: the clock
restarts, the cost restarts, the trail is a new trail. Phases 2 and 3 own the
planning; what this phase owes is a HUD that can show "leg 2 of 3" and a
total. Until it can, "along the way" is a planning feature the ride itself
cannot represent.

### 11.10 What NOT to build

- **No crash detection.** See §11.4.
- **No live position sharing from this lane.** It is a server feature (§9) and
  a consent conversation, not a client one.
- **No speedometer precision work.** It is derived from GPS and it is already
  as good as that gets; a prettier dial is not what is missing.
- **No in-ride social.** The leaderboard is a reason to ride, not a thing to
  read while riding.

### 11.11 Order, and why

1. **Voice + haptics** (§11.1) — unblocks every other in-ride signal, because
   a signal nobody can receive is not a signal.
2. **The two money moments** (§11.3) — the first things worth saying out loud,
   and the most on-mission.
3. **"Did your ride end at …?"** (§11.4 case 2) — the data-integrity one.
4. **Scan-time start + the Screen 8 calibration** (§11.2) — retires the nudges
   for most rides.
5. **Battery reach** (§11.5) — highest risk of a wrong claim, so it goes after
   the signals that are certain.
6. **HUD hierarchy** (§11.7) and **the ride's closing sentence** (§11.8).
7. **Legs** (§11.9), with Phases 2–3.

---

## Phase 12 — The device card

The popup is the most-opened surface in the app and the one that has absorbed
every feature: it now carries a header, a verdict bar, an arrival block, up to
eight action buttons, a status badge row, a six-row definition list and a walk
estimate. Everything in it was a good idea. Together they answer the rider's
question fourth.

### 12.1 What is actually wrong, in the order it matters

**(a) The four things a rider chooses on are below the buttons.** Rideability
earned the verdict bar and is right at the top — that part works. Vehicle
type, battery and features sit in a `<dl>` underneath ~8 full-width actions,
at the same visual weight as `Vehicle ID` and `Parked for`. The rider scrolls
past the controls to reach the facts the controls depend on.

**(b) Features are rendered twice and labelled neither time.** Glyph-only
buttons in the header (`🔔 🧺 📱` with the explanation behind a tap) and a
prose summary in the stat list. Two renderings, no words on the prominent one.

> **Out of date on the second half.** The prose summary in the stat list IS a
> labelled rendering, so features are labelled once and glyph-only once — not
> "neither time". The duplication stands as a finding; "no words anywhere" does
> not. See §12.3 for why the labels were taken off the pills deliberately, and
> why this plan does not get to overturn that on its own.


**(c) Blocked actions explain themselves with `title`, which does not exist on
a phone.** `▶️ Open in Veo` greys out with `title="You're too far away,
sorry!"`. Touch devices never show a tooltip. The rider gets a dead grey
button and no reason — on the primary CTA. Some paths route through
`showHint` on tap, which works; the gated ones mostly do not.

**(d) The proximity rules are three different radii and two of them are
missing.** Measured, not guessed:

> **Re-measured at implementation time, and this table was out of date on one
> row.** The `Report a problem` chips are listed here as ungated; they were
> gated at 100 m — admin-exempt, with a sentence, blocked rather than hidden —
> some time after this was written. The two genuinely open ones were
> `📷 Take Photo` and `☑️ Confirm Features`. The row is left as written rather
> than quietly corrected, because the *shape* of the finding survives the
> correction intact: the cheap actions were gated and the expensive ones were
> not, and nobody chose that.


| Action | Sign-in | Proximity | Admin exempt |
|---|---|---|---|
| `▶️ Open in Veo` | yes | **75 m** (`UNLOCK_PROXIMITY_M`) | proximity only |
| `🛴 I'll ride this one` | no | **~1125 m** (`RIDE_MAX_WALK_M`, 15 min) | yes |
| `⚠️ Report bad parking` → Veo | no | **100 m** (`PARKING_REPORT_PROXIMITY_M`) | yes |
| `Report a problem` chips (not rideable / dead battery / damaged) | no | **none** | n/a |
| `📷 Take Photo` | yes | **none** | n/a |
| `☑️ Confirm Features` | no | none | n/a |
| `🖼️ Show Photos`, `ℹ️ Details` | yes / no | none | — |

Three radii is defensible — they answer different questions, and each one has
a comment explaining itself. **The two blanks are not.** The ungated
`Report a problem` chips flip `has_negative_report`, which overrides a
vehicle's reliability tier for 24 hours across the whole fleet: the single
most consequential thing a rider can do from this card, available from
anywhere in the world. And `📷 Take Photo` attaches rider evidence to a
specific vehicle from any distance. Meanwhile *reporting bad parking* — which
is a complaint about a thing you can see — is correctly gated at 100 m. The
cheap actions are gated and the expensive ones are not.

### 12.2 The rule to adopt

**Shipped** as `device-action-tiers.ts`. An action with no rule in
`ACTION_RULES` is a type error, which is §12.5's "no action may ship without
declaring a tier" enforced by the compiler rather than by a reviewer
remembering.

Two departures from the text below, both deliberate:

- **Each rule keeps its own sentence**, rather than one per tier. "This comes
  from riders at the scooter" is right for a report and wrong for the unlock,
  which is not a report about anything — and §12.4's own point is that the
  existing sentences are already good. They are kept verbatim where they
  existed, with the distance substituted in.
- **`🖼️ Show Photos` stays `anywhere` while `📷 Take Photo` becomes
  `at_the_vehicle`.** The asymmetry is the point: uploading is evidence about a
  scooter you can see, reading is not, and gating the read would be symmetry for
  its own sake at the cost of most of the feature's value.

**The 100 m → 75 m tightening is the one change here with a real argument
against it**, and it is recorded at the constant in `devices.ts` rather than
dropped: you can see a badly-parked scooter from across the street. The
counter-argument stands anyway, and it is this section's own.

**Three tiers, named, and every action declares which one it is in.**

| Tier | Means | Radius | Who is exempt |
|---|---|---|---|
| `anywhere` | reading public data, or a purely local act | — | — |
| `in_reach` | "I could walk to this": starts a journey | `RIDE_MAX_WALK_M` | admins |
| `at_the_vehicle` | "I am standing here and I can see it": any claim about this vehicle's condition, position, or equipment, and the unlock | one radius, **75 m** | admins |

So `Report a problem`, `Take Photo` and `Confirm Features` move into
`at_the_vehicle`, and the parking report's 100 m collapses into the same 75 m
— a second radius for the same claim-type is a distinction no rider can
perceive and nobody will maintain.

**Admins are exempt from proximity, never from sign-in**, which is already
how `startAllowed` behaves; the tier table makes it one rule instead of four
coincidences. The justification already written at the parking-report gate is
the general one and should move to the tier definition: the gate is a
*credibility* check, not a data dependency — the report is built from the
device's coordinates, never the reporter's, so a distant admin files exactly
the same report, and an admin working a compliance queue from a desk is doing
the job.

**One consequence to accept deliberately:** gating the failure-report chips
loses reports from riders browsing the map. That is the point. A reliability
signal that overrides a tier for 24 h should come from somebody who was there,
and §1's own argument for the arrival-panel and Screen 6 buttons —
*both moments of certainty rather than browsing* — is the same argument.

### 12.3 What the card should look like

Order by what the rider decides on, then what they can do:

```
┌────────────────────────────────────────────┐
│  🛴  Lunar 🐸 928            [Veo Cosmo]   │   ← name + model badge
│      Seated · two wheels                   │
├────────────────────────────────────────────┤
│  ✅ Likely rideable                         │   ← the verdict bar, unchanged
├────────────────────────────────────────────┤
│  🔋 82%   ·   ~6.2 mi left                  │   ← ONE facts strip, big
│  🧺 basket  📱 phone holder  🔔 bell (!)    │   ← features, WITH WORDS
├────────────────────────────────────────────┤
│  ~4 min walk (0.2 mi)                       │
├────────────────────────────────────────────┤
│  [ 🛴 I'll ride this one        ]           │   ← one primary
│  [ ▶️ Open in Veo ] [ ☑️ Features ]         │
│  ⚠️ Report   ℹ️ Details   📷 Photos          │   ← secondary, one row, small
└────────────────────────────────────────────┘
```

- **One facts strip** replaces the top half of the `<dl>`: battery (with the
  range estimate it already has), and features as labelled chips. `Vehicle ID`
  and `Parked for` move into `ℹ️ Details`, where the rest of the forensics
  already live — `Parked for` is an auditing fact, not a choosing fact.

  > **The move SHIPPED.** `Vehicle ID` and `Parked for` are in `ℹ️ Details`
  > now, beside `Device ID`, which is the same kind of fact and was already
  > there. `Parked for` keeps its peer-median context: the dwell figure is the
  > compliance signal this whole app exists to publish, so it is one tap
  > further from the decision and not gone.
  >
  > The **single facts strip** itself has not shipped — it depends on the
  > labelled-chips question above, and a strip built around glyph-only pills is
  > a different design from the one drawn here. Worth doing as one change once
  > that is settled, rather than half now.
- **Features get their words back**, and the broken ones keep the `(!)` they
  already have. A glyph is not a label (`emoji-scale.ts` had to learn the same
  thing).

  > **NOT DONE, AND DELIBERATELY LEFT FOR THE OWNER.** The labels were taken
  > off the pills *after* this section was written, as a considered change with
  > its reasoning recorded in `style.css`: *"The names were three words of
  > chrome on the busiest line of the card; the icon is the recognisable part
  > and the name is one tap away in the explanation, which says more than a
  > label could anyway. The full sentence is still the button's aria-label, so
  > nothing is lost to a screen reader."*
  >
  > That is a real argument and it answers this one: the `emoji-scale.ts`
  > precedent is about a glyph carrying meaning with no words available
  > anywhere, which is not this — the words are in the `aria-label`, in the
  > tapped explanation, and in the stat list's prose row. The pills are also in
  > the header, which is the one line on this card with the least room.
  >
  > So this is two documents disagreeing, the later one being the code, and the
  > question is a judgement call about a busy line rather than a correctness
  > bug. Flipping it back unilaterally would just be the newer document winning
  > on recency. **Owner's call.** Everything else in §12.3 that does not depend
  > on it has shipped.
- **The secondary row is text-sized**, not three more full-width bars.

### 12.4 Blocked is a sentence, in the card

**Shipped, and the mechanism matters more than the text predicted.** Every
blocked action button carries its reason in `data-blocked` and ONE handler
delivers it on tap. That is not tidiness: the three hand-wired handlers it
replaced each passed a **captured variable**, which is how `📷 Take Photo` came
to announce a sign-in hint to a rider who was signed in and merely 400 m away.
Reading the attribute makes the rendered reason and the spoken reason the same
string by construction.


Every gated action renders enabled-looking and, on tap, writes the reason into
the existing `.device-popup__actionhint` live region — which already exists,
already announces politely, and is already how the dibs and bell paths behave.
`title` stays for pointer users and stops being the only channel.

The sentences are already written and already good ("You're too far away,
sorry!", "Sign in (Account tab) to start rides here."). The bug is purely that
a phone never shows them.

**`aria-disabled` stays, `disabled` must not be used** — a `disabled` button
cannot be tapped, so the reason could never be delivered. This is the existing
`is-blocked` pattern; §12.4 just makes it universal.

### 12.5 Tests

- Every action in the card is covered by a tier assertion: no action may ship
  without declaring one, asserted over a table rather than per button.
- The failure-report chips and the photo button are refused beyond 75 m, with
  a sentence, and allowed for an admin at any distance.
- There is exactly one proximity radius for `at_the_vehicle` actions —
  asserted against the constant, so a second one cannot be introduced quietly.
- Tapping any blocked action writes its reason into the hint region. Asserted
  for every blocked variant, because `title`-only is the bug.
- The facts strip renders battery and features above the action row (order
  asserted on the DOM, since this is the whole complaint).
- Features render their words, not only glyphs.
- `Vehicle ID` and `Parked for` are NOT in the compact card.

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
| `receipt_verdict` | `verdict` (`overcharged` \| `correct` \| `cannot_tell`), `reason` (`exceeds_bar` \| `matches_expected` \| `no_geography` \| `inside_margin` \| `veoplus_unmodelled` \| `tier_unresolved`) — **enumerated, because this section's own rule is enumerated props only** and an unconstrained `reason` becomes free text from the verdict UI, which is how an amount or an address reaches telemetry. **No amounts, ever** |
| `receipt_complaint_prepared` | `mechanism` (`mailto` \| `clipboard`), `cc` (bool) — **not** `…_copied`: after §8.5 the primary path opens a draft and copies nothing, so the old name would either miss every normal complaint or report a thing that did not happen |
| `receipt_contributed` | `withdrawn` (bool) |
| `trip_alert_opt_in` | `enabled` (bool), `had_phone` (bool) |
| `trip_alert_sent` | `event` (`moved` \| `destination_changed`) |
| `resume_link_used` | `reauthed` (bool) |
| `advocacy_cc_added` | — |

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
| `trip-alerts.ts` | trip-alert consent storage + the send path | the opt-in UI, yes; the sending, no |
| `plan-resume.ts` | the server-side plan (master plan §13.6) | no — there is nothing to resume until the plan outlives the tab |
| the foreground check in `trip-plan.ts` | the API's **coalesced snapshot** (master plan §13.4) | yes, against a stub — it is a read |
| **background loss detection** | the API's **server-side watcher** (master plan §13.4.1), over the stored plan | **no, and it cannot be faked here**: a backgrounded tab detects nothing, so the "phone in a pocket" criterion is satisfied by that watcher or not at all |
| Phase 8: `receipt-read.ts`, `receipt-verdict.ts`, the complaint | nothing — OCR, the verdict and the `mailto:` are all local | **yes**, and this is most of the phase |
| Phase 8: contributing / listing / withdrawing | receipt submission + list + delete endpoints, and the consent record | **no** — withdrawal that cannot delete server-side is not withdrawal, so there is nothing honest to build against a stub |
| Phase 10's CC tick | Phase 8's complaint `mailto:`, which needs a real `cc` field (§8.5) | yes — but it is a recipient, not a line of body text |
| server tier in `api.ts` | `POST /trip/candidates` | mock the contract; it is master plan §6.4 |
| `trip-plan.ts` | `replaces` on `POST /dibs` | **no, for a claim-moving re-solve — hard dependency** (§3.3). Two calls cannot do it: release-then-claim can lose the claim with nothing to restore, and claim-then-release is refused by the server's one-claim invariant. What ships first is a re-solve that changes the route and leaves the new pickup **unclaimed**, said plainly. The migration is **the next free one** adding `replaces_dibs_id` — check `sql/` for its number rather than trusting one written here, as the master plan dropped its own for having already drifted. **Also on this row: the server-enforced time-to-arrival claim bound.** `registerDibs` sends no ETA today and the old gate is a walk-minute rule, so a *ridden* pickup — the thing this phase exists for — fails a gate written for walking. Without the bound, Phase 3 can look ready while every hand-off is refused |
| ~~`my-scooters.ts`~~ | ~~`sql/081` + `/profile/favorite-devices`~~ | **moot** — built, shipped, then deleted as the wrong feature (see the module map). The endpoints still exist and still work; nothing calls them |
| `device-notify.ts` (the local tier) | **nothing at all** | yes, and it shipped that way — a watch in `localStorage`, an in-app notice on the device refresh the map already does |
| **the texted tier** (§9.7) | a `notify_sms` flag on the dibs claim and on the ride-end PATCH, plus the per-cycle watcher (master §13.8.8). **Not** `device_move_watches` and its endpoints — §9.7.2 deletes those | **no, and it cannot be faked here** — same shape as background loss detection above: a closed tab detects nothing, so "it moved while my phone was in my pocket" is satisfied by that watcher or not at all. The opt-in UI can be built against a stub; the text cannot |
| `equity-savings.ts` | nothing (geometry is bundled) | yes |
| Phase 6 (one app, one mode) | **nothing at all** | yes — it adds no endpoint, field or migration |
| Phase 7 (the walkthrough) | **nothing at all** | yes, but *after* Phase 6 — see below |
| Phase 11 (ride mode) | **almost nothing.** Voice, haptics, the equity and free-minute callouts, the clock calibration, the HUD hierarchy and the ride's closing sentence are all local. Two exceptions: the battery-reach warning wants `battery_model.py`'s view of range rather than a client guess, and share-my-ride (§11.4) is a server feature or it is nothing | yes, for everything except those two |
| Phase 12 (the device card) | **nothing at all.** Every gate it moves is client-side, and the one data change — dropping `Vehicle ID` and `Parked for` from the compact card — is a render decision | yes |

Phases 1, 2 and 5a have no hard API dependency and can land first. Phase 3
wants the atomic swap. **Phase 4 is the one phase that cannot start on this
side** — which is the correct shape, because both of its load-bearing rules
have to live where a client cannot route around them.

Phases 6 and 7 invert that shape: they need nothing from the API lane and
could be built at any time. They are last anyway, and in that order, because
Phase 6 changes the UI and Phase 7 describes it. Building 7 first means
building it twice, and shipping a walkthrough that is wrong on the day it
lands is worse than shipping none — it is the first thing a new rider sees.
