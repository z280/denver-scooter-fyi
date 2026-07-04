# UX/UI Improvement Plan

Distilled from an external UX review (Gemini, June 2026) and grounded in the
current codebase. Four phases, ordered so each is independently shippable.
Phases 1–3 are pure frontend (zero new running cost, no backend); Phase 4
needs the first write endpoints in `veo-audit`. Phases 3 and 4 are
independent of each other and can proceed in parallel.

The review's core diagnosis, confirmed against the code:

- **Filtering vs. symbology are scattered.** Battery *filtering* (bucket
  buttons) lives in the Filters drawer while battery *coloring* ("Display as:
  Range") lives in Tools ([index.html](../index.html) `#battery-filter` vs.
  `#color-by-seg`). Geography is split across three drawers: area filter in
  Filters, boundary overlays + density choropleth in Overlays, neighborhood
  search in Tools.
- **No state visibility.** Once a drawer closes, the only trace of an active
  filter is the "x of y" count in the freshness pill. Users forget a filter is
  on and wonder why the map looks empty.
- **The app serves three intents with one screen** — civic/compliance
  analysis, find-a-ride, and in-ride companion — with no way to switch
  between them.

## Zero-cost ground rules

Decisions that keep running costs at zero, applied throughout:

- **No routing API.** Walk times are straight-line × 1.3 at 3 mph, computed
  client-side. Turn-by-turn walking/cycling directions hand off to the OS
  maps app via URL (no key, no quota). OSRM's public demo has no SLA and no
  foot/bike profile guarantee; OpenRouteService's free tier needs a key and
  a quota; hosted engines cost money. The long-term in-app answer is a
  **self-hosted static bike graph** routed client-side (see 3.4) — same
  philosophy as the self-hosted pmtiles basemap.
- **No paid geocoder.** Destinations are set by long-pressing the map or
  picking a saved place (`localStorage`). An optional search box can use
  Nominatim/Photon within their free usage policies (debounced, attributed)
  — but the map-press flow must work without it.
- **No push notifications, no background location.** All location use is
  foreground, opt-in, and session-scoped.
- **Pricing is static config, not an API.** Veo's Denver rates are locked in
  the city licensing agreement for the contract's duration, so constants in
  `src/config.ts` are safe: **$1.00 unlock + $0.25/min residents,
  $0.39/min visitors; equity program 60 free min/day then $0.15/min with no
  unlock fee.**
- **Deep links reuse Veo's own QR format.** No partnership or API needed —
  the QR sticker on every scooter encodes
  `https://gmjc.adj.st/?adj_t=622qh4&number=<vehicle number>`, an Adjust
  universal link we can construct per device.

---

## Phase 1 — Information architecture & state visibility (frontend only)

**Goal:** eliminate the filter/symbology confusion and make map state always
visible. No API changes, no new data.

### 1.1 Regroup controls by attribute, not by UI function

Restructure the drawers from *Filters / Overlays / Tools* into groups that
keep everything about one attribute in one place:

- **Devices drawer** (replaces Filters + the Tools color toggle):
  - *Device type* segmented control (unchanged).
  - *Availability* switch (unchanged).
  - **Battery & range block** — the four bucket filter buttons and a
    "Color dots by range" toggle side by side, with the red→green legend.
    When the user taps a battery bucket, auto-enable range coloring so the
    filter gives immediate visual feedback (one-way convenience; the user can
    still turn coloring off).
- **Areas drawer** (replaces Overlays + the geographic half of Filters/Tools):
  - *Boundary outlines* checkbox list (unchanged, from `buildLayerToggles()`).
  - *Color regions by device density* choropleth select + legend (unchanged).
  - *Only show devices in…* — the existing area filter
    ([src/area-filter.ts](../src/area-filter.ts)), renamed from the vague
    "Additional filters", with the redundant Tools "Find a neighborhood"
    field folded into its search input.
- **Tools drawer** keeps only the dense-cluster finder.
- **Compliance drawer** unchanged.

Labels follow the verb-noun rule: "Color dots by…", "Only show devices
with/in…". "Display as" and "Additional filters" go away.

### 1.2 Active-filter chips on the map

New small module (`src/filter-chips.ts`) rendering a chip row at the top of
the map, one chip per active constraint, each with a ✕ to clear it:

```
[ 🛴 Scooters ✕ ] [ ⚡ Top 25% battery ✕ ] [ 📍 5 neighborhoods ✕ ] [ Hide unavailable ✕ ]
```

Wire it in [src/main.ts](../src/main.ts) where the filter handlers already
converge. Clicking a chip's ✕ dispatches the same events the drawer widgets
use, so drawer state stays in sync.

### 1.3 Direct manipulation: click a region to filter

When boundary polygons are visible, clicking a polygon toggles it in the
area filter — the map itself becomes the filter UI. Implementation: a click
handler on the overlay fill layers in [src/overlays.ts](../src/overlays.ts)
calling into `AreaFilter`; the existing `setOverlayChecked`/`setSubset`
plumbing in main.ts already handles overlay↔filter synchronization.

**Files touched:** `index.html`, `src/main.ts`, `src/area-filter.ts`,
`src/overlays.ts`, `src/style.css`, new `src/filter-chips.ts`.

---

## Phase 2 — Find a ride: location, reliability, walk economics, Veo handoff

**Goal:** the complete pre-ride funnel — find a good scooter, judge the
walk, get there, unlock it — with zero new infrastructure.

### 2.1 Location: opt-in, on demand, never on load

- The map gains a standard MapLibre `GeolocateControl`
  (`trackUserLocation: true`), but the browser permission prompt fires only
  from an explicit user tap — never on page load.
- Entering **Find-a-ride mode** (2.5) shows a one-line card: *"Show
  scooters near you? [Use my location]"*. Tapping it triggers the control;
  the choice is remembered in `localStorage` so returning users go straight
  to locating.
- **Graceful degrade:** if permission is denied or unavailable, distances
  and walk times are computed from the map-center crosshair instead, with a
  hint ("distances measured from map center").

### 2.2 Walk time & "worth the walk?"

With a location fix (or map center), each device popup and preview card
shows estimated walk time: straight-line × 1.3 detour factor at 3 mph
(`src/geo.ts` already has the distance math). Next to it, the reliability
tier (2.4) drives an intervention when warranted:

> 🚶 ~8 min walk · 🔴 idle 4 days, 2 failed starts —
> **a 🟢 scooter is 2 min further** *(tap to see it)*

The "better alternative" is a client-side nearest-neighbor scan over
`devices.visibleFeatures()` filtered to 🟢 tier — no API involved.

### 2.3 Walking directions: OS handoff, in-app straight line

- In-app: a dashed straight line from the user dot to the selected scooter
  (one GeoJSON line source), enough for orientation in a flat street grid.
- A **Directions** button on the popup opens the platform's maps app in
  walking mode:
  - iOS (detected via UA): `https://maps.apple.com/?daddr={lat},{lng}&dirflg=w`
  - Everything else: `https://www.google.com/maps/dir/?api=1&destination={lat},{lng}&travelmode=walking`
  Both open the native app when installed and cost nothing.

### 2.4 Reliability score & ghost-scooter styling

Derive a per-device 🟢/🟡/🔴 reliability tier client-side from fields that
already exist on `DeviceProperties` ([src/api.ts](../src/api.ts)):
`quality_designation`, `has_negative_report`, and — when signed in —
`number_failed_starts` and dwell time from `first_observed_at_location`.

- **Popup badge** with a plain-language reason ("Idle 4 days · 2 failed
  start attempts logged").
- **Ghost pins:** 🔴 devices render semi-transparent/desaturated
  (paint-expression change in [src/devices.ts](../src/devices.ts), same
  mechanism as the existing negative-report flag layer).
- **New color mode:** "Color dots by reliability" joins type/range in the
  Phase 1 battery-block toggle group.

### 2.5 Intent modes: Find a ride / Audit

A two-position switch above the drawer tabs — presets over existing state,
not separate apps:

- **Find a ride:** overlays/choropleth off, hide-unavailable on, reliability
  coloring on, location card offered (2.1).
- **Audit:** choropleth on (v1 areas), compliance drawer opened, all devices
  shown, ghost pins emphasized.

Manual control changes flip the indicator to "Custom".

### 2.6 "Unlock in Veo" deep link

Every scooter's QR sticker encodes an Adjust universal link with the
vehicle number:

```
https://gmjc.adj.st/?adj_t=622qh4&number={vehicle_plate}
```

- **Mobile popup/preview card:** an `Unlock in Veo →` button navigating to
  that URL (must be a direct user-gesture navigation for the universal link
  to open the app). With the Veo app installed it deep-links to that
  vehicle; without it, Adjust falls back to the app store.
- **Desktop:** no app to open — render the same URL as an on-screen QR code
  (tiny dependency-free QR generator, ~1 KB) so the user scans it with
  their phone. Plus a "copy vehicle number" fallback.
- The Adjust tracker token (`622qh4`) is a `src/config.ts` constant — it's
  campaign-scoped and Veo could rotate it; one-line fix if so.

**API dependencies (veo-audit), all read-only field promotions:**

1. Expose `vehicle_plate` on the *public* devices endpoint (it's painted on
   every scooter in the street — not sensitive) so anonymous users get the
   unlock button. Verify on-device that the QR `number` param equals
   `vehicle_plate` (format matches: 7-digit vehicle number).
2. Expose `number_failed_starts` / `first_observed_at_location` (or a
   precomputed `reliability_tier`) publicly. Until then the tier degrades to
   `quality_designation` + `has_negative_report` for anonymous users.

**Files touched:** `src/main.ts`, `src/devices.ts`, `src/map.ts`,
`index.html`, `src/style.css`, `src/config.ts`. **New:**
`src/reliability.ts`, `src/modes.ts`, `src/locate.ts`, `src/qr.ts`.

---

## Phase 3 — Ride Mode & trip planning: a glanceable 2D HUD (client-only, zero backend)

**Goal:** the in-ride companion — speedometer, live cost, destination
guidance, money-saving hacks, and the competition counterfactual. Not 3D:
big numerals and high contrast beat building extrusions for glanceability
at 15 mph. Everything here is browser-API-only and free.

### 3.1 Entry, exit, and ride detection

- A **Start ride** button appears (a) in Find-a-ride mode after tapping
  "Unlock in Veo" — when the user switches back to the browser, the HUD is
  one tap away — and (b) as a persistent 🧭 tab.
- We can't know when the Veo app actually starts billing, so the ride clock
  is **manual-start**, with an assist: if sustained GPS speed > 6 mph for
  10 s while the site is open, show a one-tap "Riding? Start the
  ride clock" prompt. The estimate is labeled unofficial.
- **End** is a huge bottom-of-screen button; auto-suggest ending after
  speed < 2 mph for 3 minutes.

### 3.2 The HUD itself

Full-screen overlay (`src/ride-hud.ts`) on top of a dimmed, simplified map:

- **Speedometer:** `navigator.geolocation.watchPosition` with
  `enableHighAccuracy`; use `coords.speed` (m/s → mph) where the device
  provides it, else derive from successive fixes; smooth with an EMA so the
  needle doesn't jitter. Displayed as the dominant element (~30% of screen
  height).
- **Cost ticker:** `$1.00 + minutes × rate`, ticking per minute. Rate
  selector (Resident $0.25 / Visitor $0.39 / Equity program) chosen once and
  remembered in `localStorage`. Rates are contract-locked constants in
  `src/config.ts`.
- **Equity-zone awareness:** the HUD already knows the ride's start point;
  a client-side point-in-polygon against the v1/v2 boundaries
  ([src/geo.ts](../src/geo.ts)) sets an "equity ride" flag shown as
  🏷️ *"started in an equity zone — discount applies"*, feeding the Phase 4
  discount check.
- **Keep-awake & legibility:** Screen Wake Lock API
  (`navigator.wakeLock.request("screen")` — supported in Chrome and iOS
  Safari 16.4+), `requestFullscreen` where available, and two fixed
  high-contrast palettes (day: black-on-white/yellow; night: luminescent
  green-on-black) switched by `prefers-color-scheme` with a manual toggle.
- **Follow-me map:** MapLibre geolocate follow with bearing-up rotation
  (`easeTo({bearing: coords.heading})`). Optional 45° pitch as a setting,
  off by default — no 3D buildings, no terrain.
- **The 2-second rule:** during the ride the HUD shows exactly three things
  — speed, elapsed cost, equity flag. Everything else waits for the
  summary.

### 3.3 Ride summary & the competition counterfactual

On End, a summary card:

- Duration, distance (integrated from GPS fixes), estimated Veo cost.
- **"If Veo had competition":** the same ride priced under
  config-driven comparator rates (`src/config.ts`:
  `COMPARATOR = { name: "Lime", unlock: 1.00, perMin: 0.30, weekPass: 4.99 }`
  — Lime's typical mid-market US pricing; adjust to Lime's last-known Denver
  rates before shipping). Rendered as
  *"With Lime's typical pricing: $X.XX — you paid $Y.YY more because Denver
  has one operator."* Also show the break-even: *"a $4.99 weekly pass would
  have covered this in N rides."*
- Equity flags: *"This ride started in an equity zone — Veo owes you the
  contract discount. Check your receipt"* → links into the Phase 4 missed-
  discount report (until Phase 4 ships, it links to the "how to check"
  helper text).
- The counterfactual lives in the summary, not the live HUD — it's
  advocacy, and advocacy can wait until the rider has stopped moving.

### 3.4 Destination & bike directions (optional, two tiers)

A destination is optional — the HUD works destination-free. Setting one:
long-press the map (or pick from `localStorage` saved places; optional
Nominatim search per the ground rules). With a destination set:

- **Tier 1 (ships with Phase 3):** the HUD gains a bearing arrow + "0.8 mi
  as the crow flies" readout toward the destination, and a **Bike
  directions** button that hands off to the OS maps app in cycling mode
  (`google.com/maps/dir/?api=1&…&travelmode=bicycling`; Apple Maps' cycling
  flag where supported). Handoff is offered *before* the ride starts —
  once moving, no menu diving.
- **Tier 2 (follow-up, still zero running cost):** true in-app bike routing
  via a **pre-built Denver cycling graph** — an OSM extract of the bike
  network (weighted toward protected lanes), compiled to a few-MB static
  file served from R2 exactly like the pmtiles basemap, routed client-side
  (A* over the graph). No quota, no key, works offline mid-ride. This is
  the piece that later enables "route me *through* good infrastructure"
  and richer zone-aware routing.

### 3.5 Money & time hacks: the discount-zone optimizer

The contract discounts rides that **start or end** inside disadvantaged
areas — that's a pure-geometry optimization, no routing engine needed:

- **Start-side:** in Find-a-ride mode, if a candidate scooter sits inside a
  v1/v2 zone (point-in-polygon, [src/geo.ts](../src/geo.ts)), badge it
  *"🏷️ discount ride"* and factor that into the "worth the walk"
  comparison — a 2-min-farther scooter that makes the whole ride discounted
  is usually the better pick, and the card should say so with dollars.
- **End-side:** with a destination set, if the destination is within ~2
  blocks of a zone boundary (nearest-edge distance to the v1/v2 polygons),
  suggest: *"End your ride just inside the zone at ⭐ and walk 1 block —
  saves ~$X."* The suggested endpoint renders as a distinct marker on the
  map and in the HUD's arrival view.
- The savings math reuses the Phase 3 cost model; the discount rate is a
  `src/config.ts` constant until confirmed from the contract text.

### 3.6 Ride IQ: contextual tips

A tiny content system (`public/tips.json` + `src/tips.ts`): each tip has a
context trigger and shows as a dismissible one-liner, never more than one
per screen, "don't show again" per tip in `localStorage`. Launch set:

- Pre-ride card: *"🎵 You can play music through the scooter's speaker —
  look for it in the Veo app."*
- Pre-ride, zone-adjacent: the 3.5 discount suggestions.
- Summary: pass break-even math, equity receipt check.

Tips are data, not code — adding "and more" hacks later is a JSON edit.

**Files touched:** new `src/ride-hud.ts`, `src/ride-cost.ts`,
`src/destination.ts`, `src/tips.ts`, `public/tips.json`; `src/config.ts`
(pricing + comparator + discount constants), `src/main.ts`, `index.html`,
`src/style.css`. **No API changes at all.**

---

## Phase 4 — Crowdsourced audit loop: failure & equity-discount reports (first write API)

**Goal:** turn riders into auditors. This is the only phase that needs new
`veo-audit` backend surface (report ingestion + aggregates); the frontend
work is deliberately thin.

### 4.1 Dead-simple rider sign-in (Google One Tap)

The map stays 100% usable anonymously — sign-in exists only to make
contributor features (reports, "my reports" history) trustworthy and
rate-limitable, and it must cost one tap:

- **Provider: Sign in with Google** (Google Identity Services / One Tap).
  Free at any scale, no vendor bill, and covers essentially every Denver
  rider's phone. One Tap renders as a single confirmation chip — no
  password, no form, no redirect dance on Chrome/Android; a plain
  "Continue with Google" button elsewhere.
- **Backend:** one small `veo-audit` endpoint (`POST /api/v1/auth/google`)
  verifies the Google ID token (a JWKS check, no Google API quota) and
  mints the same short-lived bearer session the existing `map-auth` flow
  already uses — the frontend session plumbing
  ([src/map-auth.js](../src/map-auth.js) storage/expiry/401 handling) is
  reused, not rebuilt.
- **The existing GitHub login stays** as the separate, hidden
  scooter-club/admin gate for the sensitive private fields
  (plates, per-device failure history). Rider SSO and admin auth are
  different trust tiers and never merge: Google identity attaches to
  *reports you submit*, not to private fleet data.
- **UX placement:** the sign-in prompt appears only at the moment it earns
  its keep — the first time the user submits a report (4.2/4.3), framed as
  *"Sign in so your report counts"* — never as a wall on app open.
- Skipped alternatives, for the record: Sign in with Apple needs the $99/yr
  developer program (not zero-cost); magic email links need a sending
  service and add more friction than One Tap; hosted auth vendors
  (Auth0/Clerk) add a dependency and MAU quota for something two endpoints
  cover.

### 4.2 One-tap failure reports

In the device popup, a report row:
`[ 🚫 Failed to unlock ] [ 🪫 Dead battery ] [ 🛴 Damaged ]`
POSTs `{vehicle_identifier, report_type, snapshot_time}` to a new
`POST /api/v1/reports/device` endpoint. Anonymous reports are accepted but
heavily rate-limited; signed-in (4.1) reports carry more weight in the
aggregates. Optimistic UI with a "Ghost scooter logged — you saved someone
a walk" confirmation. These reports feed the Phase 2 reliability tier,
closing the loop.

### 4.3 Equity-zone awareness & discount reports

- **Pre-ride priming:** reuse the Phase 3 point-in-polygon check to badge
  devices inside v1/v2 zones: *"🏷️ Equity zone — rides starting or ending
  here are contractually discounted. Check your receipt."*
- **Report a missed discount:** entered from the Phase 3 ride summary or a
  "Report" drawer tab — (1) Did Veo apply the discount? Yes / No / How do I
  check?, (2) on "No", optional receipt-screenshot upload
  (`POST /api/v1/reports/discount`, image to R2), (3) a pre-filled
  `mailto:` to Veo support cc'ing DOTI's shared-mobility inbox citing the
  contract clause.

### 4.4 Public accountability layer

- **"Contract violations" choropleth mode:** a new option in the density
  select, colored by discount-denial report frequency per region
  (needs `GET /api/v1/reports/summary?layer=`).
- **Ticker in the Compliance drawer:** *"Discount reports this month: N ·
  estimated overcharges: $X"*, plus `[ Download monthly report (CSV) ]`
  linking straight to an API export URL.

**API dependencies (veo-audit):** `POST /auth/google`,
`POST /reports/device`, `POST /reports/discount` (+ R2 upload),
`GET /reports/summary`, CSV export.
Frontend files: `src/api.ts`, `src/devices.ts` (popup), new
`src/reports.ts`, `src/auth-google.ts`, `index.html`, `src/style.css`.

---

## Still deferred (with reasons)

- **3D buildings/terrain in Ride Mode:** adds GPU load and visual noise
  without a safety payoff; the flat bearing-up view carries all the
  information.
- **Audio prompts & geofence speed-zone warnings:** worth doing, but they
  need the city's geofence polygons (not yet in the API) and careful
  autoplay-policy handling; revisit after Phase 3 proves mid-ride usage.
- **In-app turn-by-turn (3.4 Tier 2):** planned, not deferred forever —
  but the static Denver bike-graph build is real work, and the OS handoff
  covers the need until the HUD proves mid-ride usage.
- **Sign in with Apple:** requires the $99/yr Apple Developer Program;
  revisit only if Google One Tap measurably excludes iOS users (it works
  fine in Safari as a button, just without One Tap's single-chip flow).

## Sequencing rationale

- Phase 1 fixes the confusion that makes every later feature harder to
  find, and touches no data contracts — lowest risk, ship first.
- Phase 2 completes the find-a-ride funnel and is the app's differentiator;
  its only API asks are read-only field promotions (`vehicle_plate`,
  failed-starts fields).
- Phase 3 is pure client and can ship the moment Phase 2's location
  plumbing exists; it also creates the natural entry points (ride summary,
  discount-zone suggestions) for Phase 4's reports.
- Phase 4 is last because write endpoints, auth, abuse handling, and
  evidence storage are the largest new surface — and its reports are more
  credible displayed inside the reliability UI that Phase 2 establishes.
  Rider SSO lives here (not earlier) because nothing before Phase 4
  requires identity: the map, ride HUD, and hacks are all anonymous by
  design.
