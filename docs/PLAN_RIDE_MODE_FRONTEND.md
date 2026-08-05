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
  `main.ts` state, Escape handling. (Focus trapping is required too but is **new** — neither
  `ride-wizard.ts` nor `openFloatingModal` has one to copy.)
- UI primitives to reuse: `wireSeg` (radio segmented groups), `wireToggleGroup`, `makeStatus`
  (status lines — there are no toasts), `openFloatingModal` (`.ranks-modal` shell), the
  `.ride-option` row CSS, `setRatePlanSyncHook` as the per-account-setting sync template. Of
  these only `setRatePlanSyncHook` is exported today — `wireSeg`/`wireToggleGroup` (`main.ts`),
  `makeStatus` (`account.ts`) and `openFloatingModal` (`devices.ts`) are module-private, so
  "reuse" starts with exporting them (or lifting the pure helpers into a small shared module),
  not importing what isn't there.
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
| `ride-screen-auth.ts` | Screen 1: Ride-as-Guest / Email link / Email code / Google, driven by `auth-config.ts` capability discovery (`google_enabled`/`magic_link_enabled`/`code_enabled`); GPS-enable prompt via `Locate.trigger()` fired inside the tap handler (the permission prompt requires a user gesture), with the async `navigator.permissions.query` leap-past exactly as in `ride-wizard.ts` `start()`. Skipped entirely when `isAuthenticated()` and geolocation permission is already granted; deep-link entry runs the **same** test — an unauthenticated deep link still shows this screen (Ride as Guest keeps it one tap), and an ungranted-GPS deep link still gets the GPS prompt (tracking needs it). |
| `ride-screen-select.ts` | Screens 2 + 2.5 — **disambiguation, not discovery**. Plain haversine distance sort from the resolved fix over the **unfiltered** device set — not `devices.visibleFeatures()`, which returns the *filtered* view (model / min-battery / quality / hide-unavailable / area filters all apply in `filtered()`), so a rider's leftover map filters could hide the very scooter they are standing next to; `devices.ts` needs a tiny read-only all-features accessor beside `visibleFeatures()` (no `rankDevices` — priority weights are meaningless at 4 m; `Locate` today keeps only lng/lat and drops `coords.accuracy`, so it must be extended to retain the fix accuracy the thresholds below need). Show the 6 nearest within 150 m, distances in **feet** (new tiny formatter — `formatWalk` speaks minutes/miles), nearest highlighted; auto-preselect the nearest when ≤8 m away and GPS accuracy ≤15 m. Re-rank via `devices.onCountsChange` **and** `Locate.onFix` (a first or refined fix must re-sort; a stale fix — `current()` nulls after 5 min — falls back to the no-fix path). Always-present row "None of these — enter plate manually" (primary path when accuracy >25 m or no fix) resolving via a new exact-match **reverse** lookup on `GbfsPlates` (plate → device_id; `cachedPlateFor` maps device_id → plate, the wrong direction for this path) — the screen calls `plates.prime()` itself and shows a pending state while the index loads, since `devices.ts` only primes it on the first GPS fix, which the poor-GPS path may never get. `[My own Device]` at list bottom. Bottom strip: Plate# + Battery% confirm fields — they verify the *physical* device matches the selection (and the Battery% doubles as `POST /tracked-rides`' `reported_start_battery_percent` — this field is the only place the flow collects it); a typed-plate mismatch warns and switches selection to the device the typed plate reverse-resolves to (when that device is in the feed; otherwise warn and stay on the manual-plate path — never silently keep a selection the rider's plate contradicts). Reuses `.ride-option` row CSS only. Find wheels / Recommended untouched. Screen 2.5 = Usuals picker. |
| `ride-settings.ts` | Defaults for the `RideOptions` blob (the wire **type** lives in `api.ts` — F1's ride-session tests need it before this module exists), cross-option rules (own-device disables battery modeling + end survey; save-tracks-off disables battery + nav improvement; guest/private sessions disable all **three 🏆 options** — the master glossary makes guest rides private and never points-eligible, there is no `tracked_rides` row to survey or donate against, and `POST /ride-routes` is session-authed — with the disabled state's copy pointing at sign-in), Usuals CRUD against `/profile/ride-usuals` (sync pattern copied from `setRatePlanSyncHook`), and the eight ℹ info modals — owner copy as exported constants with point values interpolated from `GET /points/schedule`, with the master plan's (all-even) values baked in as fallback (offline / pre-A1 deploys): A1 ships the **complete** schedule including the ride-mode actions — the constants are locked by Decision 6 and land in `src/points.py` in A1, ahead of the A2/A3 award machinery — so F2's ℹ copy renders live values from day one. |
| `ride-keypad.ts` | Custom numeric keypad for landscape; attach/detach handle bound to an input. Portrait uses the native keyboard — `inputmode="numeric"` on **both** confirm fields: the owner's copy shows a *numeric* keyboard for plate entry too, and every observed Veo plate is all-digit (the GBFS `&number=` param `gbfs.ts` parses); keep the plate field `type="text"` + pattern-filtered so an alphanumeric plate, if Veo ever ships one, still types (relax to a text keyboard then, not before). In landscape, inputs set `inputmode="none"` while the custom keypad is attached — the standard, reliable way to suppress the native keyboard on both iOS Safari (≥12.2) and Android Chrome. Not `readonly`: it has focus/caret quirks, suppresses `beforeinput`, and announces the field as read-only to assistive tech. |
| `ride-screen-dest.ts` | Screen 3: "Where to?" — debounced (300 ms) `/geocode/search` autocomplete passing the resolved fix as the API's optional `lat`/`lon` bias params (the endpoint is Denver-bboxed but proximity-biased results are the point of those params), `in_coverage` greying, recent destinations (`localStorage "scooter-fyi-recent-dests"`, max 5). |
| `ride-screen-routes.ts` | Screen 4: fire the four profile requests in parallel (`maneuvers=true`); tombstone loading cards with a CSS shimmer wipe; overview of source/destination; on load, 40/60 split — route toggle on the 40 side, all routes drawn colored by profile on the 60 side; selection → `POST /ride-routes` **only when nav-improvement is on** — the client encodes the chosen route's GeoJSON shape to the precision-5 polyline the endpoint stores (`/route` returns GeoJSON; `src/` has no polyline encoder today, so this lane adds a tiny one) — non-blocking with a tolerated 404: the endpoint ships in API **A3**, not F2's A1 dependency, so route choice must proceed (only nav points are forfeited) until A3 deploys. Non-blocking ≠ discard-the-response: on success the returned `ride_route_id` lands in the session doc's `rideRouteId` — S9's route feedback and the nav distance bonus both key off it. Out-of-coverage → graceful degrade (nav off, ride proceeds). |
| `ride-screen-start.ts` | Screen 6: plate-verified Veo deep link (`veoDeepLink` lives in `config.ts` — `gbfs.ts` only resolves plates), Android/Apple "Start in Veo" buttons — both open the **same** Adjust universal link (`veoDeepLink` returns one URL; the two buttons are per-platform labels, not different links, and Adjust does the app/store routing), default 10 s countdown (the current HUD's default delay), "I already started" skip (the `beginCountdown(0)` path), handoff to `RideHud`. |
| `track-store.ts` | IndexedDB (`sfyi-tracks` DB: `rides`, `batches`, `pending` stores) + WebCrypto HMAC: a non-extractable `CryptoKey` — `importKey`'d from the b64url-decoded `track_signing.key` for server rides, `generateKey`'d client-random for private/guest rides (master Part 2) — structured-cloned into IDB. Non-extractability is hygiene, not a security boundary: for server rides the raw key is re-fetchable via `GET active.track_signing` anyway; it simply keeps raw key bytes out of JS reach at rest. Batch sealing at 25 **waypoints** / 60 s, whichever first, plus a final partial batch at ride end (master Part 2); rolling chain hash `H_n` computed + stored per batch (forward-compatible with future live checkpoints); crash recovery (`rec:true` batches from the `pending` store); donation payload assembly; private-mode in-memory fallback with a user-facing warning. **No DOM. No network I/O during a ride.** |
| `ride-nav-hud.ts` | Screen 7 navigation overlay: route GeoJSON + maneuvers; center instruction card; corner arrow insignia — left press opens a step-by-step list panel on the left, right press on the right (compresses the HUD via a class on the ride root); press-and-hold (800 ms) dismisses guidance (deliberately longer than devices.ts's 450 ms `RIDE_LONGPRESS_MS` popup hold — dismissal should be harder to trigger than a peek); maneuver advance by **monotonic** shape-index progression — match the nearest shape point only within a forward window from the last matched index, never regressing, so out-and-back / self-crossing routes and a GPS jump landing across a switchback can't snap the instruction backward (the unconstrained nearest-point distance serves only the off-route test); off-route (>50 m from the line for 10 s) → re-route: a new `/route` call (≤1/min, the budget A1's `route_ip` 30/min limit explicitly reserves) from the current fix to the session doc's retained `dest`, requesting the **selected profile only** — a re-route never re-POSTs `/ride-routes` (the S4 choice pinned in `rideRouteId` stays the survey / nav-points subject; deviation is what S9's questions capture, not replacement rows). |
| `ride-post.ts` | Screens 8–10. **S8** end summary with tax line (`Unlock $ + Per Min $ + Tax $ = Total $`, "** The Veo app is your bill **") rendered from `estimateWithTax`'s `{unlock, perMin, tax, total}` breakdown, never recomputed from raw minutes — so the equity plan (0¢ unlock, 60 free min/day) and the `_plus` plans (0¢ unlock) show honest `$0.00` components and the line stays additive-true. Buttons: **[Rush Quit]** = end now, skip everything — immediate `PATCH /end` with only the required `EndRideIn` fields (`ended_at`, last-fix `end_lat`/`end_lon`; battery/cost omitted, no §10 fields), then straight to `done`, no S9/S10; the sealed track stays in IDB, undonated (nothing uploads; contribution points forfeited). **[New Destination]** loops to Screen 3 keeping the session — no `PATCH /end`, per the state machine. **[I ended my ride in Veo]** = `PATCH /end` with the existing fields — `reported_battery_percent` and `total_cost_cents` are **rider-entered on S8** (new inputs; the legacy HUD summary is client-only and never collected either — the vision's "Note the cost and battery %" is this entry, and A2's battery ingestion reads `soc_end_percent` straight from the battery field) — plus §10 `reported_minutes`/`reported_plan`: minutes prefilled from S8's ride clock (the vision's `Ride time: __:__ (stop)` line — the clock keeps running while the rider finishes in the Veo app, and (stop) freezes the value the prefill reads) via `billableMinutes` (per-started-minute ceil) but rider-editable — §10 stores what the Veo app *reported*, deliberately never reconciled (integer, ≤1440); plan passes through `toApiRatePlan` first — the API vocabulary is `resident`/`visitor`/`equity`, so a raw `_plus` key would 422. **S9**: left pane (scooter feedback; rendered only when `RideOptions.end_survey` is on — that Screen 2 toggle exists to control exactly this pane, and A3's `ride_survey` award gates on the same option) with per-model bonus questions keyed to A3's `model_bonus` vocabulary (`cosmo_front_basket` bool / `apollo_top_speed_mph` numeric / `astro_landscape_holder` bool); right pane (navigation feedback) renders **only when the session holds a selected route** — "How was the `${selectedRoute}`?" is unanswerable without one, and the API awards `nav_route_feedback` only when `ride_route_id` resolves; with both panes gated off S9 is skipped entirely (straight to S10's own waypoint gate); [Skip] and [Submit] both proceed to S10 when waypoints exist, else `done` (the vision's "proceed if there is collected trip data to manage"). **S10** eligibility copy generated from `validation.status/reasons` — the copy table covers the full reason vocabulary (`start_mismatch`, `end_mismatch`, `tracking_not_opted`, `too_few_waypoints`, `trip_too_short`, `chain_invalid`, `internal_error`) plus the `pending_feed` status, mapped onto the owner's Part 0 sentence skeleton; `chain_invalid` is the one reason the skeleton has no phrase for and needs a new clause in the owner's voice (e.g. "your saved track failed integrity verification"). Donation = one `POST /tracked-rides/{id}/track` carrying every sealed batch from IDB — single request, no chunking: the longest points-eligible ride is the 3 h watch window, ≤~432 batches ≈ 650 KB, well inside the API's 2 MB / 600-batch caps; points display renders the response `points` array (distance-dependent points show as held while `pending_feed`); "See recent trips" is backed by the existing `GET /tracked-rides` list endpoint. |
| `geocode-search.ts` | Thin typed client for `/geocode/search` (debounce, abort, small cache). |
| `leaderboard.ts` + `leaderboard-panel.ts` | 🏆 Territory control and the Leaderboard panel (spec below). `leaderboard.ts` is the pure half — payload → FeatureCollection, cell-detail HTML, the one fill-opacity constant — and `leaderboard-panel.ts` is the main-menu drawer. Depends on `GET /leaderboard/map`, `GET /leaderboard/regional/live` and `GET /points/schedule`, plus existing map/theme/h3-js. **Superseded the original shape:** there is no 🏆 topbar button and no leaderboard map mode; the choropleth is `hexdensity.ts`'s `territory_control` metric, and `devices.setLeaderboardActive` was removed with the mode it served. |
| `api.ts` (modified) | Typed additions: `TrackedRide`, `TrackSigning`, `RideOptions` (the wire blob type — F1's `ride-session` tests need it; `ride-settings.ts` owns defaults/rules), `startTrackedRide`, `getActiveRide`, `getTrackedRide` (GET `/{id}` — S10 reads `validation` from it, and recovery uses it to tell "ended" from "gone"), `endTrackedRide` (the `HttpMethod` union gains `"PATCH"` — today it's GET/PUT/POST/DELETE only), `donateTrack`, `postSurvey`, `postRideRoute`, `fetchRoute`, `fetchRouteProfiles`, `fetchPricing`, `fetchPointsSchedule`, `fetchLeaderboardMap` (plain `getJSON`; the ETag/304 reuse is the browser HTTP cache's — see the Leaderboard section — not new conditional-request code), geocode search, ride-usuals CRUD; shared 429 handler honoring `retryAfter` — extended to the **public** `getJSON` path too (geocode 20/min and route 30/min are IP-limited public endpoints; today only `authedFetchJSON` parses `Retry-After`). |
| `ride-hud.ts` (modified) | Corner re-layout — a relocation, not a swap. Today `renderRiding` puts ≈cost top-left, mph top-right, the ride clock bottom-left (sharing that corner with the exit/End/wrench round buttons), speedo bottom-right; after: the **ride clock moves BL → TL with ≈cost just below it**, the bottom-left keeps only the three round buttons, and the right corners are untouched (nothing moves into BL). Wrench panel gains a clock above the adjustment buttons and a "Stop tracking" button — behind a **confirm**: it seals the final partial batch and halts `track-store` recording while the ride and HUD continue, and the confirm copy must say contribution points are effectively forfeited (the chain's last waypoint won't correlate with the GBFS end — `end_mismatch` at A2 validation, an **ineligible** verdict paying zero awards, not shrunken ones; only a stop already inside the end check's 150 m / ±10 min of the actual drop stays eligible, and then only on the tracked distance; this is *not* `tracking_not_opted`, which means save-tracks was off from the start). On ride start hide all scooters — `startRide` initializes `rideModels` **empty** instead of `ALL_MODELS` **and pushes it** (today `startRide` never calls `applyRideModels()` — all-selected ≡ null filter made that omission invisible — and `resumeRide` needs the same re-push, since leaving the riding state clears the filter to null), taking `setRideModelFilter`'s documented empty-set "show none" path, so the existing Show pills re-show models on demand — and close popups/tooltips via `chrome.ts` `closeAllPopups()`. A single shared `watchPosition` (replacing `startSensors`' private watcher; `Locate`'s `GeolocateControl` watcher stays separate) feeds both the existing `onFix` speed-EMA/follow-cam path and `track-store`. The `summary` state is replaced by a handoff to `ride-post.ts` (lands in **F4** with that module — F3 keeps the legacy summary) — for **tracked** rides only: private/guest rides keep the legacy client-only summary permanently (the master gates S8 on a Veo device, and the state machine sends private rides `riding → done`), so the handoff branches on `session.private`. |
| `devices.ts` (modified, minimally) | `setRideActive(on)` has **no hide behavior to generalize** — today it only switches tap semantics (short tap flashes the essentials tooltip, long press opens the popup) and it stays exactly as is. Hiding is **new**, and split so the two features can't fight: the **ride** hide reuses the existing `setRideModelFilter` machinery (an empty set is the documented "show none"; the HUD passes it at ride start — zero devices.ts change); the **leaderboard** briefly got a `setLeaderboardActive(on)` flag that short-circuited `filtered()` to `[]`; it was removed along with the map mode it served, since territory control is now an ordinary hex metric that composes with the devices on top of it. Also exposes `jumpToDevice` (today `private`, ~line 1348) for the deep-link entry, and adds a read-only `allFeatures()` accessor beside `visibleFeatures()` — Screen 2's disambiguation list must ignore map display filters (see the `ride-screen-select.ts` row). |
| `ride-cost.ts` (modified) | `estimateWithTax(plan, elapsedMs, taxRate)` → `{unlock, perMin, tax, total}`, layered on the existing `rideCostCents(plan, elapsedMs)` so the equity plan's 60-free-minutes credit keeps applying (a raw `minutes` parameter would have to re-implement — and would silently bypass — that logic); tax default baked into `config.ts`, refreshed from `/meta/pricing`. Rate plans unchanged. |

`ride-wizard.ts` ("Find wheels") is untouched by this program; consolidation is a named follow-up.

## Ride session state machine (`ride-session.ts`)

States: `idle → wizard:{1, 2, 2.5, 3, 4, 6} → countdown → riding → ending(8) → survey(9) →
eligibility(10) → done`, plus the non-linear transitions the buttons imply — the reducer must
permit all of these: `wizard:6 → riding` ("I already started" skips the countdown);
`ending(8) → wizard:3` (S8's [New Destination] loops to Screen 3 keeping the session), then
`wizard:4 → riding` re-entry with the **same** `rideId` and chain, no new countdown — legal only
because `PATCH /end` fires from the S8 buttons ([Rush Quit] / [I ended my ride in Veo]), never on
merely *entering* `ending(8)` (interim exception: during the F3 window, before `ride-post.ts`
exists, the legacy End Ride sends the minimal `/end` — see Phase F3); `ending(8) → done`
([Rush Quit], after its `PATCH /end`); and
`survey(9)` / `eligibility(10)` are each skippable toward `done` (S9 only on tracked Veo rides,
and only when at least one pane's gate passes — see the `ride-post.ts` row;
S10 only when waypoints were tracked). Private rides go `riding → done` directly — the master's
Part 0 gates S8 itself on "a Veo device was selected, i.e. not a private ride", there is no
`PATCH /end` to send, and S9/S10 never apply; the final partial batch still seals at ride end
(a `track-store` duty, not an `ending(8)` one). The session doc is
persisted on **every** transition to `localStorage "scooter_fyi.ride_session"`:

```ts
{ v: 1, state, screen, rideId: string|null, private: boolean,
  device: {vehicleIdentifier, plate, model, batteryConfirmed} | {own: true} | null,
  options: RideOptions, dest: {label, lat, lon} | null,
  route: {profile, rideRouteId|null, distanceM, durationS, polyline, maneuvers} | null,
  startedAtMs, trackKeyId: string|null /* the key itself lives only in IDB as a CryptoKey */ }
```

Recovery on load (in `wireRideModal()`, before first render):

- doc.state = countdown with `rideId: null` (crash before `startTrackedRide` resolved) → no
  server ride is *known*; reopen the wizard at `wizard:6`, no reconcile — if the start had in
  fact committed server-side (crash with the response in flight), the re-press's 409 path below
  catches it.
- doc.state ∈ {countdown, riding} — or `wizard:{3,4}` with a non-null `rideId`, a crash inside
  the S8 New Destination loop while the ride and chain are live — reconcile with
  `GET /tracked-rides/active` (it returns `{active: null}` when none):
  - match → restore HUD (a New-Destination-loop doc restores its saved wizard screen instead,
    tracking resumed either way) + resume `track-store` (key from IDB, or re-imported from
    `active.track_signing` if IDB was evicted). An evicted IDB lost the **sealed batches** too,
    not just the key: resume records a *fresh* chain from `seq 0` / `prev: ""` — the eventual
    donation uploads what survives and server validation adjudicates (typically
    `start_mismatch`); never pretend the pre-eviction track is intact.
  - server-active but doc missing → resume-or-end prompt (the 409 UX). On resume, rehydrate the
    chain tip (last `seq`, `H_n`, predecessor-JWS hash) from the IDB `batches` store keyed by
    `rideId` before sealing anything new — a restarted seq would break chain verification. An
    empty store (IDB evicted as well) falls back to the fresh-chain-from-`seq 0` path above.
  - doc says countdown/riding but `active` is null → `getTrackedRide(rideId)` disambiguates
    three ways: end already reported (another tab's `PATCH /end`; it is single-shot — a second
    one 409s) → skip S8's end buttons, restore to `survey(9)`/`eligibility(10)`/`done` per their
    gates; ride exists but the end is unreported (watch elapsed / vehicle reappeared) → seal the
    final batch, jump to `ending(8)` with a "ride expired" note — **not** a local-only end:
    `PATCH /end` still works after expiry (its sole precondition is an unreported end) and
    donation requires it; true 404 (ride deleted) → local end, nothing left to report.
- doc.state ∈ {ending, survey, eligibility} → restore straight to that screen from the doc (no
  server reconcile needed; the chain is already sealed).
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
- **Deep link**: `?ride=<vehicle_identifier>` (16-hex) consumed at load in the same
  read/strip-via-`history.replaceState` shape as `?ml=` — but **no reload** (the `?ml=` success
  path ends in `location.reload()`; `?ride=` opens the modal directly), and `?ml=` is consumed
  first when both are present → `openRideModal({vehicleIdentifier})` —
  skips Screen 1 when authed **and** geolocation is already granted (Screen 1's own rules — a
  deep link changes the landing screen, not the auth/GPS gates), lands on Screen 2 preselected +
  `jumpToDevice` (today `private` in `devices.ts:~1348` — exposing it is part of that file's
  minimal changes). A `?ride=plate:<PLATE>` variant resolves through the `GbfsPlates` **reverse**
  lookup after an explicit awaited `prime()` — at page load no GPS fix has primed the index yet;
  a miss (`prime()` never rejects, but a down/CORS-closed feed leaves the index empty, and the
  plate may have left the feed) falls through to Screen 2's manual-plate path with the plate
  prefilled — never a dead end. Device popups gain a "Ride this" affordance calling the same
  entry directly.
- **Theme**: Screen 2's ☀️/🌘/auto writes `RideOptions.theme` and applies it **ride-scoped** via
  `applyTheme` — **not** `setManualTheme`, which persists the pick and turns sun-sync off: the
  HUD's ☀/☾ is documented "Deliberately ride-scoped: no persistence … must not steal the user's
  durable preference" (`ride-hud.ts` `toggle-night`), and its existing `restoreTheme()` (re-resolve
  sun-sync > stored > OS) stays the restore path on ride/wizard exit. `auto` follows the
  sunrise/sunset resolution for the ride — `theme.ts` exports a small resolver for its currently
  module-private sun-times logic — without flipping the durable sun-sync flag. The no-FOUC inline
  script in `index.html` is untouched.
- **Entry**: the existing 🧭 Ride button (`#ride-open`, `data-mode="riding"`) opens the modal
  instead of directly arming the HUD — behind a dev flag `localStorage "scooter-fyi-ride-modal"`
  until F3 completes, then default-on.

## Territory control + the Leaderboard panel

**Revised after the rough cut shipped.** The first version was a map *mode*: a 🏆 button in
`.topbar__right` that hid every device, paused hex density and the region choropleth, and painted
its own choropleth. That conflated two things riders want separately — "shade the map by who holds
what" and "show me the rankings" — and cost a `devices.setLeaderboardActive` hide plus a
pause/resume controller for each colliding layer to keep the two fills apart. Both are gone. The
shading is one more hex metric, so it shares the one fill layer and needs nothing paused; the
rankings are a panel, so the map keeps working while you read them.

- **Menu tab**: `Leaderboard` in `#drawer-tabs`, between Areas and Tools, with a monochrome trophy
  in the same stroke-only line art as every other tab (`fill="none" stroke="currentColor"`). It
  opens `#drawer-leaderboard` through the existing `wireDrawers()` machinery — no bespoke
  open/close code, and `setActive` calls the panel's `open()`/`close()` so the live tally refetches
  on every open.
- **Territory control as a hex metric** (`hexdensity.ts`): `territory_control` joins the six
  `H3CellMetrics` fields in the Areas drawer's "Shade by" select. It is the one metric that fetches
  a different endpoint (`/leaderboard/map`) and paints per-feature rather than off a ramp — fill
  `["get","fillColor"]`, line `["get","lineColor"]` — so `render()` branches and each branch
  restores the paint properties the other overrode. The report exists only at r8, so picking it
  snaps the size control to **Large** and disables Medium/Small (Off stays live); picking any other
  metric unlocks them. `setView(size, metric)` is the single entry point both setters go through,
  so that snap costs one fetch rather than two and never paints an empty intermediate frame.
- **Fill opacity is a constant** (`TERRITORY_FILL_OPACITY`, 0.55). It used to be per-rider
  (`ruling_alpha`, set by a slider beside the ruling colors), which made map legibility a personal
  setting and let a rider make their own hexes shout. The slider is gone from the profile, the
  field is no longer sent on save, and nothing in this app reads it. Neutral defaults are still a
  frontend decision (the API sends null): no leader → no fill + hairline `#8a8f98` @ 0.15 outline;
  leader with unclaimed colors → `#8a8f98` @ 0.22 fill + opaque border.
- **Triple-click** (`triple-click.ts`): three clicks on the same cell inside 600 ms — measured
  between consecutive clicks, so a steady-but-slow triple counts and an idle pause ends the run.
  One click stays free (the choropleth and area filter act on it) and two are the map's zoom, which
  is why the gesture is three. On a territory cell it opens that cell's rankings from the already
  fetched payload (no second request — `runners_up` exists for this); on any other metric it opens
  the H3 cell id, the metric's name, and the **exact** stored value, un-rounded, since seeing the
  number behind a color is the whole point. The map's double-click zoom is held for one window
  after a click lands on a hexagon and released as soon as the run finishes or lapses — narrow
  enough that normal navigation keeps it, wide enough that the second click of a triple can't yank
  the target away.
- **Panel contents** (`leaderboard-panel.ts`): a **Show Territory Control** switch (a second entry
  point to the same hex control — the panel asks `main.ts` via `setTerritory`, and `main.ts` pushes
  state back via `syncTerritory`, so the two controls can never disagree), then three native
  `<details>` accordions: **Total Regional Points (live)** from `GET /leaderboard/regional/live`
  (the request-time aggregate, not the nightly `regional_leaders` snapshot — that is what "(live)"
  buys), **What's this?**, and **Earning Points** rendered from `GET /points/schedule`. Not one
  point value is written in the frontend: the schedule endpoint exists precisely so this copy
  cannot promise a number the server does not pay, and an action this build has never heard of is
  humanized and rendered rather than dropped.
- **Cell detail**: the `openFloatingModal` panel (exported from `devices.ts`) — leader section with
  composed display name, points and a swatch, then runners-up rows, then the cell id, totals and
  window dates. `bodyHtml` is caller-escaped innerHTML, so every interpolated payload string is
  escaped.

## Vitest introduction

Added in F1 (the repo's own docs recommend adding a test runner with the ride state-machine work):
`vitest` with `node` environment + `happy-dom` for DOM-light tests; `node:crypto` `webcrypto` for
HMAC. CI gains a `test` script next to `tsc --noEmit`. Unit targets (no network):

- `ride-session` reducer + the recovery decision table;
- `track-store` chain seal/sign against **golden vectors byte-shared with the API's
  `test_track_verify.py`** — the vector scenarios (valid, flipped-bit, foreign-key-signed,
  reordered, teleport, out-of-bounds timestamps, recovered-batch `rec:true`) live in **one file,
  `tests/fixtures/track-chain-vectors.json`**, committed byte-identically at that same literal
  path in both repos — the program-wide canonical path (the API plan's A2 Tests names the same
  one); that single shared file is the contract;
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
  `sessionStorage → localStorage "scooter_fyi.map_auth"`, with a one-time promote of any existing
  sessionStorage blob so the deploy doesn't sign everyone out; update the three mirrors
  (`map-auth.js`, `auth-session.ts`, `api.ts`) together. Silent `POST /auth/refresh` on load —
  but the endpoint **rotates and revokes** the presented token (rider sessions get a fresh
  30-day sliding expiry; 60/h/account; response is the same `{token, expires}` blob), so an
  unconditional per-load refresh is a multi-tab race: tab B refreshing the token tab A just
  revoked gets a 401, and the 401 handler would clear the now-shared blob — signing out tab A's
  *valid* token too. Guard both ends: only refresh when the stored blob is stale (e.g. >24 h
  since the last rotation, stamped in the blob), and on a refresh 401 re-read storage before
  clearing (another tab may have already rotated).
- Vitest scaffold + CI script.
- `api.ts` typed additions compiled against the master-plan contract table (mockable before A1
  deploys) + the shared 429 handler.
- `ride-session.ts` + `track-store.ts` complete with tests and the shared golden vectors.
- `?ride=` deep-link plumbing: param consume/strip alongside `?ml=` — same
  read-act-`history.replaceState` shape, but where the `?ml=` success path ends in
  `location.reload()`, `?ride=` must **not** reload: it opens the modal directly. Consume `?ml=`
  first when both are present, so the post-redeem reload re-enters with `?ride=` intact and
  authed.
- `ride-modal.ts` shell + orientation grid + `ride-keypad.ts`.

**Acceptance:** simulated reload mid-ride restores the session doc and resumes the chain; chain
vectors verify byte-identical to the API fixtures; auth survives tab close; `tsc --noEmit` +
`vitest` green.

**Parallel lanes (4):** ① auth migration ② ride-session + track-store + vectors ③ modal shell
+ keypad + `?ride=` plumbing ④ Vitest scaffold + api.ts additions. Two known couplings, neither
blocking: ④ lands its scaffold commit first (small) so ②'s tests have a runner and the
`RideOptions` type they compile against (it lives in `api.ts`, ④'s file), and ① + ④ both
touch `api.ts` in disjoint regions.

## Phase F2 — Wizard Screens 1–4 + 6 (needs API A1 deployed)

**Scope:** `ride-screen-auth.ts`; `ride-screen-select.ts` (disambiguation list, plate/battery
confirm, manual-plate fallback, My-own-Device, Screen 2.5 Usuals picker); `ride-settings.ts`
(options model, cascades, Usuals CRUD, all eight ℹ modals with owner copy); `ride-screen-dest.ts`
+ `geocode-search.ts`; `ride-screen-routes.ts`; `ride-screen-start.ts`; `ride-cost.ts` tax.
Entry stays behind the `scooter-fyi-ride-modal` dev flag.

**Acceptance:** full wizard walkable to ride start on a real device in both orientations —
landscape exercising the custom keypad, with `inputmode="none"` verified to actually suppress the
native keyboard on at least one iOS Safari and one Samsung-IME Android device (the known
OEM-keyboard exception); standing at a scooter, the correct device is preselected and its plate
matches — with a leftover map filter active that would exclude it (the unfiltered-list rule);
the poor-GPS path reaches ride start via manual plate; Usuals round-trip against the API; an
out-of-coverage destination degrades gracefully (nav off, ride proceeds).

**Parallel lanes (5):** ① auth + select screens ② settings + Usuals + ℹ copy ③ dest + geocode
④ routes screen ⑤ start screen + cost/tax.

## Phase F3 — In-ride: HUD, nav, local tracking (needs API A1)

**Scope:** `ride-hud.ts` modifications (ride clock BL → TL with ≈cost just below it; wrench clock
+ confirmed Stop tracking; hide-scooters on start via the empty ride-model filter + close
popups/tooltips via `closeAllPopups()`; single shared `watchPosition` feeding HUD + track-store —
all per the module-map row); `ride-nav-hud.ts` (center card, side panels, press-hold dismiss,
monotonic maneuver advance, off-route re-route); live `track-store` integration — **local only,
zero mid-ride track network traffic**; the 409/reload resume UX end-to-end. Two legacy HUD
behaviors need tracked-ride adaptations: **BRB** — `pauseRide` today stops the watcher and freezes
the clock (`pausedElapsedMs`), but a tracked ride keeps running, so on a tracked ride BRB keeps
`startedAt` anchored (no resume shift) and keeps the shared watcher + `track-store` recording;
only the HUD display leaves. And **ride end** — F3 keeps the legacy summary, which never reports
the end: for a doc holding a `rideId`, End Ride must seal the final batch **and send the minimal
`PATCH /end`** (`endTrackedRide`; required `ended_at`/`end_lat`/`end_lon` only — the §10 fields are
S8's, in F4), marking the doc `done` — an unreported end keeps `GET /tracked-rides/active`
answering "still on a ride" until GBFS resolves or the 3 h watch expires, so the rider's next
back-to-back start would 409 into the resume-or-end prompt for a ride they already finished.
The legacy per-waypoint
`POST /tracked-rides/{id}/waypoints` has **no client callers to retire** — nothing in `src/` ever
wired it; F3's obligation is simply to not introduce one, which is what unblocks the API's A2
deprecation. The dev flag flips to default at F3 end: in `main.ts` `wireModes()`, the
`case "riding"` handler (the `#ride-open` button) swaps its `rideHud.open()` call for
`openRideModal(...)`; the surrounding `hudReturnMode` capture and `setOnHidden` handback stay,
since the wizard still ends in a `RideHud` handoff — and the swap must keep BRB's in-page resume
route: with a ride live (the HUD's `paused` flag / a session doc in `riding`), the button resumes
`rideHud.open()` — whose paused path is exactly this — instead of opening a fresh wizard over a
running ride.

**Acceptance:** a ~30-min real ride with airplane-mode **and BRB** interludes produces an unbroken
chain (recording continues through BRB, and the clock lands unshifted) that
verifies against the shared golden-vector rules (F3 depends only on A1 — the donation endpoint and
server-side `track_verify.py` are A2, so the server-side check of this same ride is F4's
acceptance, which donates it); the nav HUD advances correctly on a known route, including an
out-and-back segment (the monotonic-advance case); reload mid-ride restores HUD + tracking within
~3 s; the network inspector shows zero track requests mid-ride.

**Parallel lanes (3):** ① HUD changes ② nav-hud ③ tracking integration + resume UX.

## Phase F4 — Post-ride Screens 8–10, contribution funnel + Leaderboard view

(Screens 8–10 need API A2 + A3; the Leaderboard lane needs **only** A4.)

**Scope:** `ride-post.ts` — S8 cost summary with tax + Rush Quit / New Destination loop /
"I ended my ride in Veo" feeding §10 fields; S9 survey panes (right pane only with a selected
route, left pane only with the end-survey option on — module map) incl. model-bonus questions
(COSMO basket / APOLLO top speed / ASTRO landscape holder); S10 eligibility copy + donation upload
+ points display + recent trips. **`leaderboard.ts` + `leaderboard-panel.ts` + the `territory_control` hex metric**
(independent lane). Profile-pane trip-data explainer page (optional follow-up, per owner).

**Acceptance:** every `validation_reasons` combination — all seven reasons plus the `pending_feed`
status, `chain_invalid` included — renders owner-faithful Screen 10 copy;
donating the F3 acceptance ride awards exactly the master plan's points math (all values even;
battery + survey subset only — the F3-era ride predates A3, so no `ride_routes` row exists and
the nav awards are structurally absent);
declining donation leaves zero **waypoint/track** geometry server-side (trip metadata — the
start/end points `PATCH /end` carries — is server-kept by design, and a nav-improvement ride's
chosen route polyline was already stored at S4 with its own ≤28 h de-id clock); 🏆 open hides
every device and renders claimed cells in their owners' colors with opaque borders; cell click
shows leader + runners-up from the single cached payload.

**Parallel lanes (4):** ① S8 ② S9 ③ S10 + donation ④ Leaderboard view (fully decoupled —
assignable the day A4 deploys).
