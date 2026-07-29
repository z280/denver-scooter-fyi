# Ride Mode Overhaul — Frontend Plan (denver-scooter-fyi)

Companion to `docs/RIDE_MODE_OVERHAUL_PLAN.md` (the master program plan — read it first; the
vision, glossary, chain-format spec, sequencing graph, and risks live there). This document is the
actionable frontend plan: **four big phases (F1–F4)**, each shippable behind the mode-bar flag,
each divisible into parallel lanes for multiple implementing agents.

House rules that bind every phase:

- Vanilla TypeScript, no framework. New surfaces are **new modules** wired from `main.ts` via a
  single `wireX()` call — do not grow `main.ts` (~1.9k lines) or `devices.ts` (~2.5k lines).
- Copy the `ride-wizard.ts` discipline for anything modal: `createElement` (not innerHTML), a
  `shell()` rebuild helper, `cleanupFns[]` teardown, a hooks interface instead of importing
  `main.ts` state, Escape + focus handling.
- UI primitives to reuse: `wireSeg` (radio segmented groups), `wireToggleGroup`, `makeStatus`
  (status lines — there are no toasts), `openFloatingModal` (`.ranks-modal` shell), the
  `.ride-option` row CSS, `setRatePlanSyncHook` as the per-account-setting sync template.
- API calls go through `src/api.ts` (`getJSON` / `authedFetchJSON`, `ApiError`); it gains a shared
  429 handler honoring `retryAfter` as part of this program.
- localStorage keys: new keys use the dotted `scooter_fyi.*` convention for ride/auth state and
  hyphenated `scooter-fyi-*` for UI prefs, matching existing usage; every read/write wrapped in
  try/catch (private-mode degradation).
- API-phase dependencies refer to `PLAN_RIDE_MODE_API.md` in the `scooter-fyi-api` repo
  (A1–A4). The frontend compiles against the contract table in the master plan §1.5 and can mock
  it before the API deploys.

---

## Module map (new unless noted)

| Module | Responsibility |
|---|---|
| `ride-modal.ts` | Wizard shell + screen router: modal build, orientation-adaptive 2-pane grid, screen registry `Map<ScreenId, ScreenFactory>`, back/next, deep-link fast-forward. Exposes `openRideModal(entry?: {vehicleIdentifier?: string})`. |
| `ride-session.ts` | Ride state machine + persistence (below). Pure reducer + storage adapter; no DOM. The single owner of "what ride am I in". |
| `ride-screen-auth.ts` | Screen 1: Ride-as-Guest / Email link / Email code / Google, driven by `auth-config.ts` capability discovery; GPS-enable prompt via `Locate`. Skipped entirely when `isAuthenticated()` and GPS are already granted, or on deep-link entry. |
| `ride-screen-select.ts` | Screens 2 + 2.5 — **disambiguation, not discovery**. Plain haversine distance sort of `devices.visibleFeatures()` from the resolved fix (no `rankDevices` — priority weights are meaningless at 4 m). Show the 6 nearest within 150 m, distances in **feet**, nearest highlighted; auto-preselect the nearest when ≤8 m away and GPS accuracy ≤15 m. Re-rank via `devices.onCountsChange`. Always-present row "None of these — enter plate manually" (primary path when accuracy >25 m or no fix) resolving via `GbfsPlates.cachedPlateFor` exact match. `[My own Device]` at list bottom. Bottom strip: Plate# + Battery% confirm fields — they verify the *physical* device matches the selection; a typed-plate mismatch warns and switches selection. Reuses `.ride-option` row CSS only. Find wheels / Recommended untouched. Screen 2.5 = Usuals picker. |
| `ride-settings.ts` | The `RideOptions` model (mirrors the API blob), defaults, cross-option rules (own-device disables battery modeling + end survey; save-tracks-off disables battery + nav improvement), Usuals CRUD against `/profile/ride-usuals` (sync pattern copied from `setRatePlanSyncHook`), and the eight ℹ info modals — owner copy as exported constants with point values interpolated from `GET /points/schedule`. |
| `ride-keypad.ts` | Custom numeric keypad for landscape; attach/detach handle bound to an input. Portrait uses the native keyboard (`inputmode="numeric"`; plate field `text` + `autocapitalize=characters`, pattern-filtered). In landscape, inputs are `readonly` to suppress the native keyboard while the custom keypad is attached. |
| `ride-screen-dest.ts` | Screen 3: "Where to?" — debounced (300 ms) `/geocode/search` autocomplete, `in_coverage` greying, recent destinations (`localStorage "scooter-fyi-recent-dests"`, max 5). |
| `ride-screen-routes.ts` | Screen 4: fire the four profile requests in parallel (`maneuvers=true`); tombstone loading cards with a CSS shimmer wipe; overview of source/destination; on load, 40/60 split — route toggle on the 40 side, all routes drawn colored by profile on the 60 side; selection → `POST /ride-routes` **only when nav-improvement is on**. Out-of-coverage → graceful degrade (nav off, ride proceeds). |
| `ride-screen-start.ts` | Screen 6: plate-verified Veo deep link (`veoDeepLink` from `config.ts`/`gbfs.ts`), Android/Apple "Start in Veo" buttons, default 10 s countdown, "I already started" skip, handoff to `RideHud`. |
| `track-store.ts` | IndexedDB (`sfyi-tracks` DB: `rides`, `batches`, `pending` stores) + WebCrypto HMAC (non-extractable `CryptoKey` imported from `track_signing.key`, structured-cloned into IDB); batch sealing (25 pts / 60 s); rolling chain hash `H_n` computed + stored per batch (forward-compatible with future live checkpoints); crash recovery (`rec:true` batches from the `pending` store); donation payload assembly; private-mode in-memory fallback with a user-facing warning. **No DOM. No network I/O during a ride.** |
| `ride-nav-hud.ts` | Screen 7 navigation overlay: route GeoJSON + maneuvers; center instruction card; corner arrow insignia — left press opens a step-by-step list panel on the left, right press on the right (compresses the HUD via a class on the ride root); press-and-hold (800 ms) dismisses guidance; maneuver advance by nearest-shape-index progression; off-route (>50 m from the line for 10 s) → re-route (new `/route` call, ≤1/min). |
| `ride-post.ts` | Screens 8–10: S8 end summary with tax line (`Unlock $ + Per Min $ + Tax $ = Total $`, "** The Veo app is your bill **") + [Rush Quit] [New Destination (loops to Screen 3 keeping the session)] [I ended my ride in Veo (feeds §10 `reported_minutes`/`reported_plan` into PATCH /end)]; S9 dual survey panes incl. per-model bonus questions; S10 eligibility copy generated from `validation.status/reasons` (copy table keyed to the master plan's reason vocabulary) + donate + points display + "See recent trips". |
| `geocode-search.ts` | Thin typed client for `/geocode/search` (debounce, abort, small cache). |
| `leaderboard.ts` | The 🏆 Leaderboard view (spec below). Depends only on `GET /leaderboard/map` + existing map/theme/h3-js — zero coupling to ride-session work. |
| `api.ts` (modified) | Typed additions: `TrackedRide`, `TrackSigning`, `startTrackedRide`, `getActiveRide`, `endTrackedRide`, `donateTrack`, `postSurvey`, `postRideRoute`, `fetchRoute`, `fetchRouteProfiles`, `fetchPricing`, `fetchPointsSchedule`, `fetchLeaderboardMap` (ETag-aware), geocode search, ride-usuals CRUD; shared 429 handler honoring `retryAfter`. |
| `ride-hud.ts` (modified) | Timer moves top-left with ≈cost just below it (corner swap); wrench panel gains a clock above the adjustment buttons and a "Stop tracking" button; on ride start hide all scooters + close all tooltips; a single shared `watchPosition` feeds both HUD speed and `track-store`; the `summary` state is replaced by a handoff to `ride-post.ts`. |
| `devices.ts` (modified, minimally) | Generalize `setRideActive(on)`'s hide behavior into an internal **hide-reasons set** (`"ride"` \| `"leaderboard"`): `setRideActive` keeps its exact signature/behavior; new `setLeaderboardActive(on)` shares the implementation. The map is device-free whenever either reason is active, and the two features can't fight over one boolean. |
| `ride-cost.ts` (modified) | `estimateWithTax(plan, minutes, taxRate)` → `{unlock, perMin, tax, total}`; tax default baked into `config.ts`, refreshed from `/meta/pricing`. Rate plans unchanged. |

`ride-wizard.ts` ("Find wheels") is untouched by this program; consolidation is a named follow-up.

## Ride session state machine (`ride-session.ts`)

States: `idle → wizard:{1, 2, 2.5, 3, 4, 6} → countdown → riding → ending(8) → survey(9) →
eligibility(10) → done`. The session doc is persisted on **every** transition to
`localStorage "scooter_fyi.ride_session"`:

```ts
{ v: 1, state, screen, rideId: string|null, private: boolean,
  device: {vehicleIdentifier, plate, model, batteryConfirmed} | {own: true} | null,
  options: RideOptions, dest: {label, lat, lon} | null,
  route: {profile, rideRouteId|null, distanceM, durationS, polyline, maneuvers} | null,
  startedAtMs, trackKeyId: string|null /* the key itself lives only in IDB as a CryptoKey */ }
```

Recovery on load (in `wireRideModal()`, before first render):

- doc.state ∈ {countdown, riding} → reconcile with `GET /tracked-rides/active`:
  - match → restore HUD + resume `track-store` (key from IDB, or re-imported from
    `active.track_signing` if IDB was evicted);
  - server-active but doc missing → resume-or-end prompt (the 409 UX);
  - doc riding but server says ended → jump to `ending(8)`.
- `startTrackedRide` returning 409 → the same resume-or-end prompt.
- Private rides reconcile against IDB only.
- Crash mid-batch: the `pending` store is replayed and sealed as a `rec:true` batch.

## Layout, keyboard, deep link, theme, entry

- **Orientation**: `.ride-modal` is a 2-pane CSS grid; `@media (orientation: landscape)` → columns
  (`2fr 3fr` on Screen 4 for the 40/60 split); portrait → stacked rows. A
  `matchMedia("(orientation: landscape)")` listener flips a root class; screens re-slot panes,
  never rebuild state.
- **Keyboard**: portrait native (`inputmode`), landscape custom (`ride-keypad.ts`), per the module
  map above.
- **Deep link**: `?ride=<vehicle_identifier>` (16-hex) consumed at load exactly like `?ml=`
  (read, acted on, stripped via `history.replaceState`) → `openRideModal({vehicleIdentifier})` —
  skips Screen 1 when authed, lands on Screen 2 preselected + `jumpToDevice`. A
  `?ride=plate:<PLATE>` variant resolves through `GbfsPlates`. Device popups gain a "Ride this"
  affordance calling the same entry directly.
- **Theme**: Screen 2's ☀️/🌘/auto binds `setManualTheme`/sun-sync from `theme.ts` (all three modes
  already exist). The no-FOUC inline script in `index.html` is untouched.
- **Entry**: the existing 🧭 Ride button (`#ride-open`, `data-mode="riding"`) opens the modal
  instead of directly arming the HUD — behind a dev flag `localStorage "scooter-fyi-ride-modal"`
  until F3 completes, then default-on.

## Leaderboard view (`leaderboard.ts`) — rough-cut scope, owner-approved

- **Topbar button**: a 🏆 `.topbar__btn` inserted immediately **left of the Person/profile
  button**, same adopted-control style as the GPS/theme icons (`chrome.ts` adoption approach).
  `wireLeaderboard()` from `main.ts` receives the map + the profile button element to anchor
  insertion. Toggles the view; `aria-pressed` tracks state.
- **Open**: `devices.setLeaderboardActive(true)` — **zero devices**: markers, clusters, tooltips
  all hidden; hexdensity layers turned off while active; everything restored exactly on close.
- **Choropleth**: fetch `/leaderboard/map` (ETag-aware; refetch on open if >10 min stale, matching
  `max-age=600`). Build one GeoJSON FeatureCollection: per cell `cellToBoundary(h3String)` —
  h3-js already ships; flip `[lat,lng]→[lng,lat]` and close the ring, copying the exact pattern in
  `hexdensity.ts` (~line 247). Two layers: fill = leader's `ruling_color` at `ruling_alpha`; line =
  `ruling_border_color` at **opacity 1.0** — the documented convention at `account.ts:794` ("the
  border always renders opaque, matching the leaderboard map"). **Neutral defaults are a frontend
  decision** (the API sends null): no leader → no fill + hairline `#8a8f98` @ 0.15 outline; leader
  with unclaimed colors → `#8a8f98` @ 0.22 fill + opaque `#8a8f98` border. Theme-safe as chosen.
- **Cell click → detail**: `openFloatingModal`-pattern panel fed entirely from the already-fetched
  payload (no second request — the `runners_up` response extension exists precisely for this): a
  **generous leader section** — composed display name incl. `royalty_title`, points, a swatch of
  their ruling colors — then runners-up rows (name, points), then cell totals
  (`total_points`, `distinct_earners`) and the window dates. Empty cell → "Unclaimed territory" +
  (signed-in) a "claim your colors" hint pointing at the profile ruling-colors section.
- **Independence**: touches no ride-session/track/wizard code; its only API dependency is phase A4.
  Scheduled inside F4 for bookkeeping but assignable the day A4 deploys — even while F2/F3 are
  mid-flight. The ideal parallel-agent work item.

## Vitest introduction

Added in F1 (the repo's own docs recommend adding a test runner with the ride state-machine work):
`vitest` with `node` environment + `happy-dom` for DOM-light tests; `node:crypto` `webcrypto` for
HMAC. CI gains a `test` script next to `tsc --noEmit`. Unit targets (no network):

- `ride-session` reducer + the recovery decision table;
- `track-store` chain seal/sign against **golden vectors byte-shared with the API's
  `test_track_verify.py`** (same JSON fixtures committed to both repos);
- `ride-cost` tax math;
- `ride-settings` disable-cascades;
- Screen 10 eligibility-copy generation (every `validation_reasons` combination);
- Screen 2 distance sort + auto-preselect thresholds;
- leaderboard payload → FeatureCollection transform incl. null-color defaulting and ring closure.

No E2E in scope.

---

## Phase F1 — Foundations (no API dependency; runs in parallel with API A1)

**Scope:**
- **Auth storage migration first** (everything in-ride depends on sessions surviving tab churn):
  `sessionStorage → localStorage "scooter_fyi.map_auth"` with silent `POST /auth/refresh` on load;
  update the three mirrors (`map-auth.js`, `auth-session.ts`, `api.ts`) together.
- Vitest scaffold + CI script.
- `api.ts` typed additions compiled against the master-plan contract table (mockable before A1
  deploys) + the shared 429 handler.
- `ride-session.ts` + `track-store.ts` complete with tests and the shared golden vectors.
- `?ride=` deep-link plumbing (param consume/strip alongside `?ml=`).
- `ride-modal.ts` shell + orientation grid + `ride-keypad.ts`.

**Acceptance:** simulated reload mid-ride restores the session doc and resumes the chain; chain
vectors verify byte-identical to the API fixtures; auth survives tab close; `tsc --noEmit` +
`vitest` green.

**Parallel lanes (4):** ① auth migration ② track-store + vectors ③ modal shell + keypad
④ Vitest scaffold + api.ts additions.

## Phase F2 — Wizard Screens 1–4 + 6 (needs API A1 deployed)

**Scope:** `ride-screen-auth.ts`; `ride-screen-select.ts` (disambiguation list, plate/battery
confirm, manual-plate fallback, My-own-Device, Screen 2.5 Usuals picker); `ride-settings.ts`
(options model, cascades, Usuals CRUD, all eight ℹ modals with owner copy); `ride-screen-dest.ts`
+ `geocode-search.ts`; `ride-screen-routes.ts`; `ride-screen-start.ts`; `ride-cost.ts` tax.
Entry stays behind the `scooter-fyi-ride-modal` dev flag.

**Acceptance:** full wizard walkable to ride start on a real device in both orientations; standing
at a scooter, the correct device is preselected and its plate matches; the poor-GPS path reaches
ride start via manual plate; Usuals round-trip against the API; an out-of-coverage destination
degrades gracefully (nav off, ride proceeds).

**Parallel lanes (5):** ① auth + select screens ② settings + Usuals + ℹ copy ③ dest + geocode
④ routes screen ⑤ start screen + cost/tax.

## Phase F3 — In-ride: HUD, nav, local tracking (needs API A1)

**Scope:** `ride-hud.ts` modifications (timer/cost corner swap; wrench clock + Stop tracking;
hide-scooters + close-tooltips on start via the hide-reasons mechanism; single shared
`watchPosition` feeding HUD + track-store); `ride-nav-hud.ts` (center card, side panels, press-hold
dismiss, off-route re-route); live `track-store` integration — **local only, zero mid-ride track
network traffic**; the 409/reload resume UX end-to-end; retire client calls to the per-waypoint
POST. The dev flag flips to default at F3 end.

**Acceptance:** a ~30-min real ride with airplane-mode interludes produces an unbroken chain that
later verifies server-side; the nav HUD advances correctly on a known route; reload mid-ride
restores HUD + tracking within ~3 s; the network inspector shows zero track requests mid-ride.

**Parallel lanes (3):** ① HUD changes ② nav-hud ③ tracking integration + resume UX.

## Phase F4 — Post-ride Screens 8–10, contribution funnel + Leaderboard view

(Screens 8–10 need API A2 + A3; the Leaderboard lane needs **only** A4.)

**Scope:** `ride-post.ts` — S8 cost summary with tax + Rush Quit / New Destination loop /
"I ended my ride in Veo" feeding §10 fields; S9 both survey panes incl. model-bonus questions
(COSMO basket / APOLLO top speed / ASTRO landscape holder); S10 eligibility copy + donation upload
+ points display + recent trips. **`leaderboard.ts` + topbar wiring + `devices.setLeaderboardActive`**
(independent lane). Profile-pane trip-data explainer page (optional follow-up, per owner).

**Acceptance:** every `validation_reasons` combination renders owner-faithful Screen 10 copy;
donating the F3 acceptance ride awards exactly the master plan's points math (all values even);
declining donation leaves zero geometry server-side; 🏆 open hides every device and renders claimed
cells in their owners' colors with opaque borders; cell click shows leader + runners-up from the
single cached payload.

**Parallel lanes (4):** ① S8 ② S9 ③ S10 + donation ④ Leaderboard view (fully decoupled —
assignable the day A4 deploys).
