# UI overhaul — implementation plan

Scope: top bar + collapsible left ribbon, relocated GPS / theme / profile
controls, a right-side account drawer, saved map-filter sets, saved
Find-a-ride preferences (including a "use my map filters" survey option),
touch-aware hover options, popup cleanup on mode switch, and a restyled
mode bar.

**Base: `main` @ `e771783`**, which already includes the decommercialization
work (PR #32) and the README / map-auth follow-up (PR #34). Every line
reference below is against that tree.

Still open and *not* assumed by this plan: PR #33
(`chore/rename-to-scooter-fyi-api`), which is gated on renaming the GitHub
repo. It only rewrites backend URL strings and doc references — nothing here
depends on it, so this plan can land before or after it.

No test runner exists; `npm run build` (`tsc --noEmit && vite build`) is the
only gate.

---

## 0. What the code looks like today

Vanilla TS + Vite, no framework. Three files carry the UI:

- **`index.html`** — all static markup. The left activity bar is
  `<nav id="drawer-tabs">` (7 icon buttons: Filters/`devices`, Iconography,
  Recommended, Areas, Tools, Compliance, Account/`person`), each with a
  sibling `<aside class="drawer" id="drawer-*">`. The mode bar is
  `<div id="mode-switch">` with three buttons — two `[data-mode]` (`ride`,
  `analysis`) plus `#ride-open` (🧭 Ride), which opens the full-screen HUD.
  The markup treats that third button as an action rather than a mode; §7.1
  argues the markup is wrong.
- **`src/main.ts`** (1.8k lines) — `need(id)` lookups plus a `wire*()`
  function per control group. Filter state lives in module-scope variables
  (`rideTypesOn`, `modelsOn`, `minBatteryPct`, `qualityOn`, `lastAreaState`)
  mirrored by the DOM; each `wire*` publishes a `clear*` hook and `wireSeg`
  returns a programmatic setter.
- **`src/style.css`** (3.3k lines) — one sheet, CSS custom-property theme
  tokens under `[data-theme]`.

Facts that shape the work:

| Thing | Where it lives now |
|---|---|
| GPS control | `maplibregl.GeolocateControl`, added `"top-right"` in `map.ts:createMap` |
| Day/Night | `ThemeControl implements maplibregl.IControl`, added `"top-right"` in `main.ts:80` |
| Profile | `person` drawer tab + `#drawer-person`, body rendered by `wireAccount()` |
| Mode context-sensitivity | pure CSS: `body.mode-ride` hides `areas`/`tools`/`compliance` tabs, shows `recommended` |
| Persistence precedent | `localStorage` with `try/catch` guards (`theme.ts`, `equity.ts`, `ride-cost.ts`) |
| Open surfaces | `Devices.popup`, `Clusters.popup`, `.ranks-modal`, `.icon-lightbox`, `.map-tooltip` |

### 0.1 Recent changes on `main` this plan already assumes

The decommercialization work (PR #32) landed before this plan. Three of its
effects matter here — the supporter UI is **already fully removed**
(`3449c37` took the last of it out of `index.html`), so there is no cleanup
left to fold in:

- **`wireAccount()` is ~120 lines lighter.** The Account body is now just
  status + expiry countdown + admin badge + sign-out, or the signed-out
  Google/email/code forms. That is what §3 promotes to the Profile pane.
- **`setSessionPerks(admin)` takes one argument**, not two.
- **`.ranks-modal` is misnamed.** The Battery Rankings entry point is gone;
  the class now backs the popup's `ℹ️ Details` modal. §7's popup-close list
  is still correct — just don't read the name as "rankings". This is also
  why §9 treats "Rankings" as the points leaderboard.

Report types were renamed `failed_unlock` → `not_rideable` ("🚫 Not
Rideable"); §3's Contributions pane should use the new labels.

---

## 1. Top bar + collapsible left ribbon

**Goal.** A fixed top bar: hamburger left, Scooter.fyi logo centered,
profile avatar right.

**The left menu keeps its current style.** This is not a new nav bar
replacing the icon strip — it is the *existing* `#drawer-tabs` strip given a
formal place to roll into and out of, on the hamburger. Today that strip is
permanently parked over the map; after this it can leave. **The net effect
is more horizontal map space, not less**: with both the ribbon and the right
profile drawer closed, the map runs edge to edge. The top bar is the only
chrome this plan adds permanently — everything else should be space-neutral
or better.

At large widths the icons gain word labels (§1.2). That widens the ribbon
while it is *open*; closing still reclaims all of it. Below that breakpoint
the strip stays icon-only, exactly as it looks today.

**Build.**

1. New `<header id="topbar" class="topbar">` in `index.html`, before
   `#drawer-tabs`. Three slots: `.topbar__left` (hamburger + GPS + theme —
   see §2), `.topbar__brand` (logo, absolutely centered so it stays centred
   regardless of unequal side clusters), `.topbar__right` (profile button).
2. Reuse `#drawer-tabs` as the ribbon rather than rebuilding it — every
   `data-drawer` value, the `wireDrawers()` wiring, and the `body.mode-ride`
   context rules keep working. Add a `<span class="drawer-tab__label">` per
   button (the `sr-only` span already carries the right word — promote it
   to a visible label at `≥900px` and keep it `sr-only` below).
3. Ribbon open/closed = `body.ribbon-open` toggled by the hamburger.
   Default open on desktop, closed on mobile; persist in `localStorage`
   (`scooter-fyi-ribbon`), matching the `theme.ts` try/catch pattern.
4. New `src/chrome.ts` for the top bar, ribbon toggle, and right drawer.
   `main.ts` and `devices.ts` are already flagged as oversized in
   `docs/API_INTEGRATION_PLAN.md` — do not grow them.
5. **The top bar auto-hides on short viewports (decided).** A fixed top bar
   plus the enlarged mode bar would sandwich the map to roughly 300px on a
   landscape phone. Below the existing `@media (max-height: 480px)`
   threshold — the same one the mode bar already uses — hide the bar and
   float just the hamburger and profile buttons over the map.

   The logo goes with it, so the brand only appears where there is room for
   it. Three things this must not break:

   - `--topbar-h` becomes `0` in that state. Everything offsetting from it
     (`#drawer-tabs`, `.drawer`, `.filter-chips`) has to resolve correctly
     at zero rather than assuming a positive bar height.
   - The floating buttons need the same `env(safe-area-inset-*)` clearance
     the bar had — landscape is exactly where the notch becomes a *side*
     inset, which is why `viewport-fit=cover` is set in the first place.
   - The skip-link target (below) must still resolve to something visible.
   - **Crossing the threshold changes the map container's height, so it
     needs `map.resize()`.** Rotating a phone crosses it constantly. This
     codebase already carries a defensive rAF polling guard in
     `map.ts:createMap` because MapLibre's own `ResizeObserver` has been
     unreliable for exactly this class of layout-driven resize — don't
     assume it will catch this one. Hook the media-query `change` listener
     that toggles the bar, and resize from there.

**Gotchas — these break silently:**

- `main.ts:positionLegend()` sets the icon legend's `top` from
  `#drawer-tabs.getBoundingClientRect().bottom`. A collapsed ribbon makes
  that rect meaningless. Re-anchor the legend to the top bar's bottom edge,
  or skip positioning while collapsed.
- `index.html:65` — `<a class="skip-link" href="#drawer-tabs">` points at
  an element that can now be hidden. Repoint it at the hamburger.
- Everything currently pinned to `top: max(12px, env(safe-area-inset-top))`
  must shift below the bar: `#drawer-tabs`, `.drawer`, `.filter-chips`.
  Introduce `--topbar-h` and offset from it in one place.
- `.filter-chips` is top-centre and will collide with the logo. Move it
  below the top bar (it already has a `≤640px` branch that left-aligns it).
- The hamburger needs `aria-expanded` + `aria-controls="drawer-tabs"`, and
  collapsing the ribbon while a drawer is open should close the drawer.
- **Four rules hardcode the strip's width and all four break.** The current
  `~52px` strip is baked in as literals:

  | Line | Rule | Encodes |
  |---|---|---|
  | `style.css:209` | `.drawer { left: calc(72px + …) }` | 12px gap + 52px strip |
  | `style.css:220` | `.drawer { transform: translateX(calc(-100% - 84px)) }` | off-screen park distance |
  | `style.css:2286` | `.drawer { width: calc(100vw - 84px) }` (≤640px) | leftover width |
  | `style.css:2295` | `.filter-chips { left: calc(72px + …) }` (≤640px) | same offset |

  A ribbon that both collapses to zero *and* widens for labels has three
  widths, not one. Replace the literals with a `--ribbon-w` custom property
  set per state, and derive all four from it. Miss this and a closed ribbon
  still leaves a 72px gutter — the exact horizontal space this is meant to
  reclaim.
- **`setDrawer()` (`main.ts:1138`) drives drawers by synthesising
  `tab.click()` on `.drawer-tab` elements**, and `applyAnalysis()` calls it.
  `HTMLElement.click()` fires happily on a hidden element, so with the
  ribbon collapsed (the mobile default in §1.3) tapping **Analysis** opens
  the Compliance drawer while its tab strip is invisible — a panel with no
  visible origin. Either auto-open the ribbon whenever `setDrawer()` opens
  something, or make it a no-op while collapsed.

---

## 2. Relocate GPS, Day/Night, and Profile

**GPS + Day/Night → left.** Both are MapLibre controls in the `top-right`
corner. Do **not** reparent their DOM by hand (that desyncs
`map.removeControl` bookkeeping). Instead register them at `"top-left"` and
CSS-position `.maplibregl-ctrl-top-left` into the top bar's left cluster,
directly right of the hamburger.

**Move `src/style.css:1146–1222`, but skip `1151–1161`.** That range holds
20 `.maplibregl-ctrl-top-right` selectors (geolocate icon recolouring, the
`::after` state dot, the theme button chrome) — about 66 lines once the
exclusion is taken out. All of them must move with the controls or the
controls arrive unstyled.

The exclusion matters: `style.css:1158` is
`.maplibregl-ctrl-bottom-left { bottom: env(safe-area-inset-bottom); … }`,
which governs the zoom buttons and attribution, **not** the controls being
moved. Carrying it along breaks the safe-area fix under a notch — the exact
regression the comment above it exists to prevent.

**Profile → top right.** The `person` tab leaves the left ribbon and
becomes the top bar's right-hand button. Keep `#drawer-person`'s existing
markup and `wireAccount()` intact — the drawer moves to the right side (§3)
and its contents do not change at all.

---

## 3. Right-side account drawer

**Goal.** Tapping the profile button opens a right-side drawer. **It ships
with the account panel only — no nav list.** The five-item menu from the
original brief is deferred; see §3.1 for why and for what re-opens it.

**Build.** New `<aside id="drawer-account" class="drawer drawer--right">`,
reusing `.drawer` styling with a `--right` modifier that flips the
transform (`translateX(calc(100% + 84px))`, and see §1's `--ribbon-w` note
— the right side needs its own width variable, not the left's). Move
`#drawer-person`'s existing markup in wholesale and leave `wireAccount()`
untouched: this is a relocation, not a rewrite. Mirror `wireDrawers()`'s
Escape handling and focus-return-to-trigger behaviour rather than inventing
a second pattern.

Signed-out state is whatever `wireAccount()` already renders (the Google
button and email/code forms). No new empty states to write.

### 3.1 Why the five-pane menu is deferred

> **Verify backend claims against the backend.** The rows below were
> checked against the API repo at `scooter-fyi-api` (route table, endpoint
> docstrings), **not** against `docs/API_INTEGRATION_PLAN.md` — that file is
> a frontend work plan and describes what *this* repo has yet to consume,
> which is not the same as what the API serves. An earlier draft of this
> table got three rows wrong by conflating the two.

| Pane | What the API actually serves | Verdict |
|---|---|---|
| **Profile** | `GET/PUT /api/v1/profile` (incl. server-computed badges from `src/badges.py`), `/profile/username`, `/username/regenerate`, `/adjectives`, `/emoji-nouns`, `GET /api/v1/points`. **All live and unconsumed** | Ships — and can be far richer than today's sign-in panel |
| **Rides** | `GET /api/v1/rides` (paginated, caller-scoped), `/rides/active`, `/rides/export`, full write lifecycle, plus the `/tracked-rides/*` family. Read path is live | Defer — the list will be **empty** until the HUD writes rides (Phase C) |
| **Rankings** | `GET /api/v1/points` is the **caller's own** ledger; badges likewise. No cross-rider leaderboard route exists — though the account model already carries a `leaderboards` visibility toggle anticipating one (`src/api_meta.py:79`) | **Dropped** — see below |
| **Contributions** | `GET /api/v1/photos/mine` — purpose-built, "Review all photos I have uploaded (requirement #17)", device photos + ride screenshots, caller-scoped. Plus `/reports/summary` | **Reconsider** — buildable today |
| **Favorites** | `favorites` is a stored profile field, but nothing implements a favourites sort or highlight, and `UX_PLAN` §5.2 leaves the shape TBD | Defer — needs a spec, not an endpoint |

**The backend is well ahead of the frontend.** The blocker for most of these
is frontend consumption, not missing API surface.

Reasons the deferral still holds where it does:

1. **Phase B's content lands in Profile, not in new panes.** Username,
   privacy toggles, home/work coords, badges, theming — `UX_PLAN` §5.2 puts
   all of it "in the Account drawer". So the next wave makes Profile
   *richer*; it does not populate the other four.
2. **A nav list is itself chrome.** With one destination there is nothing to
   navigate between.

**Rankings is dropped because its content is Profile's, not because nothing
backs it.** Points and badges are live — but both are self-scoped, and
`UX_PLAN` §5.2 already places badges in the Account drawer. What does *not*
exist is a cross-rider leaderboard, which is the only thing "Rankings" would
mean as a distinct pane. If a leaderboard is ever specified, the account
model's `leaderboards` consent toggle is already there for it.

**What re-opens the nav:** a second destination with real content. On the
evidence above that is **Contributions** (live endpoint, data already
accumulating from the popup's report flow) sooner than Rides (live endpoint,
no data until Phase C writes).

---

## 4. Saved map filters

**Goal.** Two buttons in the Filters drawer — *Save map filter* and
*Load map filter* — with an auto-suggested name.

**Build.** New `src/filter-presets.ts`.

1. **Serialize.** A `FilterPreset` covering exactly what the Filters drawer
   owns — nothing else:
   ```ts
   interface FilterPreset {
     name: string;
     rideTypes: RideType[];
     models: ModelKey[];
     hideUnavailable: boolean;
     minBattery: number;
     quality: QualityFilter;
     area: { layer: BoundaryLayer; subset: string[] | null } | null;
   }
   ```
   Version the stored blob (`v: 1`) so a later schema change can migrate
   rather than throw.
2. **Name suggestion — reuse `refreshChips()`.** It already renders a human
   label for every live constraint ("🔋 ≥ 50%", "✓ Reliable only",
   "📍 3 × Neighborhood"). Derive the suggested name by joining those chip
   labels with " · ", stripped of emoji; fall back to "All devices" when
   nothing is active. Extract the label-building half of `refreshChips()`
   so both callers share it.
3. **Apply.** Set each control and dispatch its normal event so the whole
   existing sync path (map filter → clusters → chips) runs — the same
   technique `wireModes()`'s presets already use.
4. **Store.** `localStorage` under `scooter-fyi-filter-presets`, guarded.
   Server sync is a follow-up once a preferences endpoint exists.

**Gotchas:**

- **Restoring the area filter is async.** `AreaFilter` fetches boundary
  polygons before it can select a subset. `applyPreset` must be a promise
  and disable the Load control while it settles, or the area selection
  lands after the rest and looks like a bug.
- **`lastAreaState` is not a serializable snapshot** — it carries computed
  polygons. Serialize `state.display` (`layer` + `subset`) only, and
  re-resolve polygons on load.
- **The `toCustom` capture-phase listener** (`main.ts:1273`) drops the mode
  indicator to "custom" on *any* click inside `.drawer`. Loading a preset
  will null the active mode. Its `applying` guard is local to `wireModes()`
  — export a small `withPresetGuard(fn)` hook and route preset application
  through it.

---

## 5. Find-a-ride preferences + "use existing map filters"

**Goal.** (a) A default-unchecked "Save this as my default search
preference" checkbox in the interview, restored next time. (b) A 4th
option on question 1: *"4. Use existing map filters."*

**Build.**

1. **Add the 4th option to the question, but do *not* add it to
   `RidePriority`.** Two reasons, both load-bearing:

   - `RidePriority` (`recommend.ts:24`) feeds an exhaustive
     `Record<RidePriority, number>` at `:72` whose weights are then summed
     by name (`weights.type + weights.quality + weights.distance`). A
     `"filters"` member is a compile error plus a hand-edit of that sum.
   - It would not *do* anything. `RecommendedDevices` already ranks over
     `this.devices.visibleFeatures()` (`recommend.ts:183`), which is
     already filter-constrained. Map filters therefore bound *every*
     priority, so "use existing map filters" as a priority is
     behaviourally identical to "least walking distance".

   Model it instead as a separate `carryOverFilters: boolean` on the wizard,
   with the priority defaulting to `"distance"` when it is set. The rider
   still sees the 4th option they were promised; it just selects a filter
   *source*, not a ranking weight. Hide the model sub-picker (`typeRow`)
   when it is chosen.

   **Source: the live map filters, not a saved-set picker (decided).**
   Option 4 carries whatever was active when the rider entered the mode —
   so it works for someone who has never saved a set, and §5 does not
   depend on §4 shipping first. Render a read-only one-line summary of what
   is being carried beneath the option, built from **the same chip-label
   helper §4 extracts** ("Astro · ≥50% · Reliable only"). Three consumers,
   one label source. When nothing is filtered, say so plainly rather than
   showing an empty line.
2. Checkbox below the choices; on "Find my ride", persist
   `{ priority, typeChoice }` to `scooter-fyi-ride-prefs` when checked.
   `RideWizard.start()` seeds `this.priority` / `this.typeChoice` from it.
   Ordering note: `start()` can skip straight to `renderInterview()` when a
   fix already exists, so load prefs in the constructor, not in a step.
3. `rankDevices()` needs no change at all — it already ranks over the
   filtered set. All the 4th option has to do is restore the snapshot from
   §4's serializer before the ranking runs (see the ordering bug below).

**The ordering bug this feature walks into.** The wizard's steps are
consent (1) → awaiting (2) → interview (3). `onConsentGranted` fires at
step 1 and runs `applyRide()`, which calls `resetAllFilters()`. By the time
the rider picks option 4 at step 3, their analysis-mode filters are
**already gone**. Fix by snapshotting the filter state in `enterRide()`
*before* `wizard.start()`, and re-applying it (via §4's serializer) when
option 4 is chosen.

Related: `exitRide()` runs `applyNormal()`, which wipes everything. If the
rider carried filters in via option 4, restore the snapshot on exit instead
of clearing — otherwise Find-a-ride silently destroys the analysis setup
they deliberately built.

---

## 6. Touch-aware hover options

**Goal.** No hover-dependent options on a touch device.

Two controls are affected: the *On Hover* button in `#gauge-display-seg`,
and the whole "✨ Hover tooltip" section (`#tooltip-toggle`).

**Build.** `const canHover = matchMedia("(hover: hover) and (pointer: fine)")`.
Hide both when it does not match.

Two things that must not be missed:

- **Make it reactive, not one-shot.** Add a `change` listener. A 2-in-1
  laptop detaching its keyboard, or a desktop window narrowing, flips this
  live.
- **Coerce stale state.** If `gaugeDisplay` is already `"hover"` when the
  query stops matching, force it back to `"always"` — otherwise the gauges
  vanish with no visible control to bring them back. `resetIconography()`
  must respect the same rule.

---

## 7. Close popups on mode switch + mode bar restyle

**Popups.** Add `closeAllPopups()` in `chrome.ts`, called at the top of
`enterRide()`, `exitRide()`, and the analysis branch of the mode buttons.
It must cover five surfaces:

- `Devices.popup` — `hasOpenPopup()` exists (`devices.ts:610`) but there is
  **no public close**; add `closePopup()`.
- `Clusters.popup` — private; add a public close.
- `.ranks-modal`, `.icon-lightbox` — `document.querySelector(...)?.remove()`.
- `.map-tooltip` — the hover tooltip element.

**Mode bar.** Bigger and more prominent on large screens, near current size
on small; stainless silver gradient; clear border on the selected item.

**The `MODE:` folder-tab notch is cut (decided).** It labelled the UI rather
than the content — three buttons reading "Find wheels / Analysis / Ride"
already say what they are. It also cost vertical space above a bar that has
to stay compact on phones, and it could not survive the ≤480px `flex-wrap`,
so it would have shipped as a desktop-only ornament with a suppression rule.
Dropping it also removes the reason to fight `border-radius: 999px`, so the
bar keeps its pill shape.

- **The gradient is the one surface that can't theme by variable.** Every
  other panel derives from `[data-theme]` tokens; a metal gradient needs
  hand-tuned stops, and a second hand-tuned set for dark (gunmetal). Define
  both inside the existing token blocks so the exception is visible in one
  place rather than scattered. Keep the selected border at ≥3:1 against the
  gradient in both themes.
- **`#ride-open` carries `.mode-btn` but has no `data-mode`.** Do not paper
  over that with a `[data-mode]`-scoped selector — fix the model instead.
  See §7.1.
- **`@media (max-width: 480px)` sets `flex-wrap: wrap`.** With the notch
  cut this is no longer a conflict, but the gradient still has to survive
  wrapping — a linear gradient on a two-row flex container paints across
  the whole box, so the seam lands mid-bar. Check it at that breakpoint.
- **`--freshness-lift`** is computed in `wireFreshnessCollapse()` from the
  freshness pill's live rect and applied as a `translate` on `#mode-switch`.
  The bar is getting taller on large screens; re-verify the lift still
  clears the expanded pill.
- **"Find wheels" is wider than "Find a ride" is narrow.** The rename (§7.1)
  changes the bar's `max-content` width, which is what the ≤480px wrap rule
  is tuned against. Re-check the wrap threshold after the copy change, not
  before.

### 7.1 There are three modes, not two

The current markup says the mode bar holds two modes plus an action button.
That is an implementation detail leaking into the product. What the 🧭 Ride
button actually does:

- opens `.ride-hud` — `position: fixed; inset: 0; z-index: 50`, which
  covers the mode bar itself (z-33) and every other piece of chrome;
- requests genuine fullscreen (`exitImmersive()` → `document.exitFullscreen`);
- paints its own solid background and runs its own ☀/☾ theme control;
- guards its exit behind a confirmation dialog — "Leave the ride view?"
  with End Ride / BRB / Cancel.

By every test a user can apply, that is a bigger mode change than
Find-a-ride → Analysis, which at least share one map. Putting a `MODE:`
label on the bar and then styling one of its three buttons as not-a-mode
would be the wrong lesson to draw from the markup. **Treat all three
uniformly.**

**Give `#ride-open` a real `data-mode`** (`riding`). Then:

1. **Watch for a double listener.** `wireRideHud()` (top-level, main.ts:286)
   already binds a click handler to `#ride-open`, while `wireModes()`
   (inside `map.on("load")`) binds to `#mode-switch .mode-btn[data-mode]`.
   Adding the attribute makes the second query match it, so one tap runs
   both handlers. Which branch it falls into depends on state, and **both
   are wrong**:

   - From Analysis, the `else` branch (`main.ts:1262`) runs
     `applyPreset(applyAnalysis)` — resetting the map behind the HUD.
   - From ride mode, `else if (rideActive)` (`main.ts:1260`) runs
     `exitRide()` — so opening the HUD *while riding* simultaneously tears
     ride mode down, resets every filter via `applyNormal()`, and drops the
     recommendations.

   Move the HUD's binding into `wireModes()` as an explicit third branch
   and pass the `RideHud` handle in. Do not just add the attribute.
2. **Restore the prior mode on exit.** The HUD hides the bar while it's up,
   so a "selected" HUD button is never actually seen; what matters is that
   closing the HUD returns the bar to whichever mode was active before.
   `RideHud` exposes no close hook today — add one.
3. **Relabel — "Find a ride" becomes "Find wheels" (decided).** The
   collision is resolved from the first mode's end, not the third's, so
   🧭 Ride keeps its name. The bar reads **Find wheels / Analysis / Ride**.

   This is a wider copy change than it looks — 13 occurrences, 8 of them
   user-visible:

   | File | Lines | Visible? |
   |---|---|---|
   | `index.html` | 581 (button), 577 (comment) | button only |
   | `ride-wizard.ts` | 109 (aria-label), 131 (consent copy), 151/172/195/315 (`shell()` titles), 304 ("Find my ride") | all |
   | `recommend.ts` | 176 (empty state) | yes |
   | `ride-hud.ts` | 354 (BRB copy), 366 (comment) | 354 only |
   | `main.ts` | 1105 (comment) | no |

   `ride-wizard.ts:304`'s button is "Find my ride" — decide whether that
   becomes "Find my wheels" or stays; it reads as a sentence, not a label.
   Leave `data-mode="ride"`, `body.mode-ride`, and the `RideWizard` class
   name alone: renaming internals alongside copy turns a one-line change
   into a refactor with no user-visible benefit.

This also settles the stale comment at main.ts:1108, which claims the Ride
button "appears" in ride mode; no CSS implements that. Under a three-mode
model, always-visible is correct and the comment is what is wrong.

---

## 8. Sequencing

**One phase per PR. This is a rule, not a suggestion.** Phase 1 alone
rewrites the highest-traffic CSS in the app and will regress something; the
value of separate PRs is the revert boundary, and that value disappears if
two phases share one. Do not batch them because they feel small.

1. **Chrome** (§1, §2) — top bar, ribbon, control relocation. Largest CSS
   blast radius; land it first and alone so regressions are attributable.
2. **Right drawer** (§3) — relocate the account panel. Small, once §1's
   drawer variables exist.
3. **Filter presets** (§4) — includes extracting the chip-label builder.
4. **Ride prefs** (§5) — needs §4's serializer and its chip-label helper.
5. **Mode model + rename** (§7.1) — `data-mode` on `#ride-open`, the
   consolidated click handler, and the "Find wheels" copy change. Behaviour,
   not looks; keep it away from the restyle so a regression is unambiguous.
6. **Polish** (§6, §7) — hover gating, popup cleanup, mode bar restyle.

§5 is the only hard dependency (on §4). Everything else can reorder.

## 9. Decisions and open questions

### 9.1 Decided

| Question | Decision | Lands in |
|---|---|---|
| Option 4's filter source | The live map filters, with a read-only summary line — not a saved-set picker | §5 |
| Right drawer scope | **Account panel only, no nav.** Rides/Contributions/Favorites deferred; **Rankings dropped** | §3, §3.1 |
| "Find a ride" vs "Ride" collision | Rename the **first** mode to **"Find wheels"**; 🧭 Ride keeps its name | §7.1 |
| Top bar on short viewports | Auto-hide below `max-height: 480px`; float hamburger + profile | §1.5 |
| `MODE:` folder-tab notch | **Cut.** Labels the UI, not the content; bar keeps its pill shape | §7 |
| PR granularity | One phase per PR, enforced | §8 |

### 9.2 Still open

- **Favorites needs a schema before it needs UI.** `docs/UX_PLAN.md:495-501`
  (§5.2) names the subject — favouriting vehicle **models/plates**, with a
  "favorites first" sort and a map highlight, and models/plates being stable
  identifiers answers the obvious objection that device ids churn. But that
  passage calls itself "a placeholder pending the fuller spec" and
  `:559-560` leaves `favorites: []` as "shape TBD".
- **Contributions: ship now or hold?** `GET /api/v1/photos/mine` is live and
  purpose-built for this pane, and the data is already accumulating from the
  popup's report flow. It is the one deferred pane with no technical blocker
  — so the deferral is a scope choice, not a dependency. Shipping it also
  gives the nav its second destination, which is what justifies having a nav
  at all.
- **Ribbon default state on desktop** — assumed open. Persisted either way.
- **Saved filters are device-local** until a preferences endpoint exists.
  The wizard's existing "Log in to save your preferences" hint will still
  overpromise; either soften the copy or gate saving behind sign-in.
