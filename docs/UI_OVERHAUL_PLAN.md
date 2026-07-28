# UI overhaul — implementation plan

Scope: top bar + collapsible left ribbon, relocated GPS / theme / profile
controls, a right-side profile menu, saved map-filter sets, saved
Find-a-ride preferences (including a "use my map filters" survey option),
touch-aware hover options, popup cleanup on mode switch, and a restyled
mode bar.

**Base: `chore/rename-to-scooter-fyi-api`, not `main`.** The
decommercialization and backend-rename work merges first (§0.1), so every
line reference below is against the post-merge tree. They differ — e.g.
`hasOpenPopup()` is `devices.ts:610` post-merge and `:615` on `main`.

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

### 0.1 What the decomm + rename merge changes underneath this

Two local branches, stacked and not yet pushed:
`feat/decommercialize-and-not-rideable` (2b413d6), then
`chore/rename-to-scooter-fyi-api` (561606b) on top. The second is the
combined tip that lands. Five consequences for this plan:

**1. `index.html` is untouched by either branch — so the supporter *copy*
outlives the supporter *concept*.** The merge strips every mechanism:
`isSupporterOfRecord()`, `SessionInfo.supporter` / `supporter_until` /
`premium_user`, `Devices.supporterSession`, the ⭐ badge, both donate
buttons, `openBillingCheckout()`, and the popup's `⌛ History✨` action.
What survives, orphaned:

- `index.html:374` — "✨ Supporter bonus features — free for everyone right now."
- `index.html:343, 352, 360, 386` — ✨ on Gauge thickness, Gauge placement,
  Icon size, Hover tooltip
- `src/style.css:2903` — the `.design-upsell` rule

All six live in the Iconography drawer and its stylesheet — the exact
surface §1 relabels and §6 rewires. **Fold the cleanup into this work**
rather than leaving a dangling upsell for a tier that no longer exists.

**2. `wireAccount()` loses ~120 lines.** Post-merge the Account body is just
status + expiry countdown + admin badge + sign-out, or the signed-out
Google/email/code forms. That is what §3 promotes to the Profile pane —
smaller and cleaner than it looks on `main`.

**3. `setSessionPerks(admin, supporter)` → `setSessionPerks(admin)`.**
Anything §3 touches in `wireAccount()`'s session-resolution path uses the
one-argument form.

**4. `.ranks-modal` survives but is now misnamed.** The Battery Rankings
entry point is gone; the class is now the backing element for the popup's
`ℹ️ Details` modal (`devices.ts:1005, 1085, 1274`). §7's popup-close list
stays correct as written — just don't read the name as "rankings".

**5. Report types renamed** — `failed_unlock` → `not_rideable`, surfacing as
"🚫 Not Rideable". The Contributions pane in §3 should use the new labels.
The backend is now `scooter-fyi-api`, and `docs/API_REQUIREMENTS.md` is
retired in favour of `docs/API_INTEGRATION_PLAN.md` — which this plan cites
and which only exists post-merge.

---

## 1. Top bar + collapsible left ribbon

**Goal.** A fixed top bar: hamburger left, Scooter.fyi logo centered,
profile avatar right. The hamburger opens/closes the existing left menu as
a ribbon. Desktop shows icon + word; mobile shows icon only.

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

---

## 2. Relocate GPS, Day/Night, and Profile

**GPS + Day/Night → left.** Both are MapLibre controls in the `top-right`
corner. Do **not** reparent their DOM by hand (that desyncs
`map.removeControl` bookkeeping). Instead register them at `"top-left"` and
CSS-position `.maplibregl-ctrl-top-left` into the top bar's left cluster,
directly right of the hamburger.

`src/style.css:1146–1300` targets `.maplibregl-ctrl-top-right` extensively
(geolocate icon recolouring, the `::after` state dot, the theme button
chrome). Every one of those selectors has to move with the controls or the
controls arrive unstyled.

**Profile → top right.** The `person` tab leaves the left ribbon and
becomes the top bar's right-hand button. Keep `#drawer-person`'s existing
markup and `wireAccount()` intact — it becomes the *Profile* pane inside
the new right drawer (§3), not a separate surface.

---

## 3. Right-side profile menu

**Goal.** Tapping the profile button opens a right-side drawer mirroring
the left one: Profile, Rides, Rankings, Contributions, Favorites — each
with an icon in the existing 24×24 / `stroke-width: 2` feather style.

**Build.** New `<aside id="drawer-account" class="drawer drawer--right">`
with a nav list of 5 entries and a pane per entry. Reuse `.drawer` styling
with a `--right` modifier flipping the transform
(`translateX(calc(100% + 84px))`). Mirror `wireDrawers()`'s Escape handling
and focus-return-to-trigger behaviour — do not invent a second pattern.

**Backend reality (from `docs/API_INTEGRATION_PLAN.md`, reconciled
2026-07-28).** Only *Profile* has data today. The rest map onto phases that
have not shipped:

| Pane | Backing | Status |
|---|---|---|
| Profile | `wireAccount()` — sign-in, session, admin badge | ships now |
| Rides | ride history + `path_geojson` replay | Phase C, not built |
| Rankings | points ledger / badges | Phase B, not built |
| Contributions | reports + photo uploads (`/reports/model` is live) | partial |
| Favorites | no endpoint exists | undefined |

**Recommendation:** build the shell and all 5 panes now, wire Profile
fully, and give the other four honest empty states that name what unlocks
them ("Ride history arrives when tracked rides ship"). That gets the
navigation right without faking data. See §8 — Favorites in particular
needs a product decision.

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

1. `RidePriority` in `recommend.ts` gains `"filters"`. Add the 4th
   `ride-wizard.ts` option; when selected, hide the model sub-picker
   (`typeRow`) — it is meaningless in that branch.
2. Checkbox below the choices; on "Find my ride", persist
   `{ priority, typeChoice }` to `scooter-fyi-ride-prefs` when checked.
   `RideWizard.start()` seeds `this.priority` / `this.typeChoice` from it.
   Ordering note: `start()` can skip straight to `renderInterview()` when a
   fix already exists, so load prefs in the constructor, not in a step.
3. Wire the new priority through `rankDevices()` in `recommend.ts` — with
   `"filters"` the map's own filter set *is* the constraint, so rank by
   distance among whatever survives `devices.visibleFeatures()`.

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
on small; stainless silver gradient; clear border on the selected item; a
file-folder notch at the top-left reading `MODE:` in small caps.

- Notch: a `::before` on `#mode-switch` (or a real `<span>` for the text),
  positioned above the bar with only the top corners rounded.
- **`border-radius: 999px` fights a folder tab.** Drop the bar to ~14–16px
  so the notch reads as a tab rather than a bump on a pill.
- **`#ride-open` carries `.mode-btn` but has no `data-mode`.** Do not paper
  over that with a `[data-mode]`-scoped selector — fix the model instead.
  See §7.1.
- **`@media (max-width: 480px)` sets `flex-wrap: wrap`.** A notch anchored
  to the top-left of a two-row bar looks broken. Either suppress the notch
  at that breakpoint or stop the bar wrapping.
- **`--freshness-lift`** is computed in `wireFreshnessCollapse()` from the
  freshness pill's live rect and applied as a `translate` on `#mode-switch`.
  A notch adds height *above* the bar; verify the lift still clears the
  expanded pill on a narrow screen.
- Silver gradient needs a **dark-theme variant** (gunmetal) — define both
  under the existing `[data-theme]` token blocks, and keep the selected
  border at ≥3:1 contrast against the gradient in both themes.

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
   Adding the attribute makes the second query match it, so one tap would
   open the HUD *and* fall into the click handler's `else` branch —
   `applyPreset(applyAnalysis)` — resetting the map behind the HUD. Move
   the HUD's binding into `wireModes()` as an explicit third branch, and
   pass the `RideHud` handle in.
2. **Restore the prior mode on exit.** The HUD hides the bar while it's up,
   so a "selected" HUD button is never actually seen; what matters is that
   closing the HUD returns the bar to whichever mode was active before.
   `RideHud` exposes no close hook today — add one.
3. **Relabel.** "Find a ride" and "Ride" are tolerable as a mode and a
   button; as two sibling entries under `MODE:` they are actively
   confusing. "Riding" or "Live ride" for the third, and consider ordering
   the bar as the progression it is — Analysis → Find a ride → Riding —
   rather than the current arbitrary order.

This also settles the stale comment at main.ts:1108, which claims the Ride
button "appears" in ride mode; no CSS implements that. Under a three-mode
model, always-visible is correct and the comment is what is wrong.

---

## 8. Sequencing

Each phase builds and ships on its own.

1. **Chrome** (§1, §2) — top bar, ribbon, control relocation. Largest CSS
   blast radius; land it first and alone so regressions are attributable.
2. **Right drawer** (§3) — shell + Profile pane + honest empty states.
3. **Filter presets** (§4) — includes extracting the chip-label builder.
4. **Ride prefs** (§5) — depends on §4's serializer for option 4.
5. **Polish** (§6, §7) — hover gating, popup cleanup, mode bar.

## 9. Open questions

- **Favorites has no backend and no defined meaning.** Favorite *devices*
  (they churn — a device id is not stable enough to favorite), favorite
  *places* (`docs/UX_PLAN.md:37,348` describes localStorage saved places,
  which fits), or favorite *filter sets* (overlapping §4)? Saved places is
  the reading the existing docs support. Confirm before building.
- **Rankings** — user points leaderboard (Phase B), or the existing Battery
  Rankings device modal in `devices.ts`? The profile-menu context implies
  the former.
- **Ribbon default state on desktop** — assumed open. Persisted either way.
- **Saved filters are device-local** until a preferences endpoint exists.
  The wizard's existing "Log in to save your preferences" hint will still
  overpromise; either soften the copy or gate saving behind sign-in.
</content>
</invoke>
