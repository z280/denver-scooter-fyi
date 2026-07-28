# UX/UI Improvement Plan

Distilled from an external UX review (Gemini, June 2026) and grounded in the
current codebase. Five phases, ordered so each is independently shippable.
Phases 1–2 are pure frontend plus read-only API field promotions; Phase 3
introduces rider accounts (the first new API surface) alongside the ride
HUD; Phase 4 adds the report write endpoints; Phase 5 adds personalization
(history, favorites, theming, badges) on top of both. An appendix
consolidates all API-repo work.

> **Retired, 2026-07-28: the supporter tier.** This plan originally put a
> paid supporter tier in Phase 5 (Stripe Payment Links,
> `POST /webhooks/stripe`, a `supporter: true` profile flag, and
> supporter-gated history/favorites/theming). **The app has since been
> decommercialized** — that code and UI is deleted from this repo, and the
> backend drops the supporter columns in `sql/036_decommercialize.sql`. No
> payments, no tiers, no donate buttons. Signed-in and admin are the only
> gates that exist. Phase 5 below has been rewritten accordingly: the
> personalization features survive as **free, account-gated** features; the
> payment machinery is gone. Anything in this document that still reads
> like a paid tier is a documentation bug — report it.

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

Decisions that keep running costs at (or near) zero, applied throughout:

- **No routing API.** Walk times are straight-line × 1.3 at 3 mph, computed
  client-side. Turn-by-turn walking/cycling directions hand off to the OS
  maps app via URL (no key, no quota). OSRM's public demo has no SLA and no
  foot/bike profile guarantee; OpenRouteService's free tier needs a key and
  a quota; hosted engines cost money. The long-term in-app answer is a
  **self-hosted static bike graph** routed client-side (see 3.6) — same
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
  unlock fee.** Which rate applies to *you* is a per-account choice (3.4).
- **Auth is two free doors.** Google Identity Services costs nothing at any
  scale, and magic links ride the already-paid-for Postmark transactional
  account. No hosted auth vendor, no MAU quota.
- **No payments at all.** *(Rule revised 2026-07-28; this used to describe
  a Stripe-backed supporter tier.)* The app takes no money: no Stripe, no
  payment links, no webhooks, no subscription, no donate button. Every
  feature is either free-for-everyone or free-and-account-gated. The
  running cost stays near zero the same way it always did — by not buying
  anything — so there is nothing to fund.
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
`quality_designation`, `has_negative_report`, and — pending the public
field promotion — `number_failed_starts` and dwell time from
`first_observed_at_location`.

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

**API dependencies, all read-only field promotions (see appendix):**

1. Expose `vehicle_plate` on the *public* devices endpoint (it's painted on
   every scooter in the street — not sensitive) so anonymous users get the
   unlock button. Verify on-device that the QR `number` param equals
   `vehicle_plate` (format matches: 7-digit vehicle number).
2. Expose `number_failed_starts` / `first_observed_at_location` (or a
   precomputed `reliability_tier`) publicly. Until then the tier degrades to
   `quality_designation` + `has_negative_report`.

**Files touched:** `src/main.ts`, `src/devices.ts`, `src/map.ts`,
`index.html`, `src/style.css`, `src/config.ts`. **New:**
`src/reliability.ts`, `src/modes.ts`, `src/locate.ts`, `src/qr.ts`.

---

## Phase 3 — Accounts + Ride Mode & trip planning

**Goal:** rider sign-in (the gate for the cost ticker), and the in-ride
companion — speedometer, live cost with clock-sync controls, destination
guidance, money-saving hacks, and the competition counterfactual. Not 3D:
big numerals and high contrast beat building extrusions for glanceability
at 15 mph.

### 3.1 Rider sign-in: two doors, one session

The map, filters, and speedometer stay 100% usable anonymously. Sign-in
unlocks the cost ticker (3.4), saved rate choice, and later the report
features (Phase 4). Two equally-first-class doors:

- **Sign in with Google** (Google Identity Services / One Tap). Free at any
  scale; One Tap renders as a single confirmation chip on Chrome/Android, a
  plain "Continue with Google" button elsewhere. Token verification is a
  local JWKS check on the API — no Google quota.
- **Magic link via email**, using the existing Postmark transactional
  account: enter email → `POST /auth/magic-link` → Postmark sends a
  one-time 15-minute link → tapping it lands back on the site and redeems
  the token for a session. Covers everyone without a Google account, and
  Postmark's deliverability makes it genuinely one-tap-from-inbox.

Both doors mint the **same bearer session** the existing `map-auth` flow
already handles ([src/map-auth.js](../src/map-auth.js) storage/expiry/401
plumbing is reused, not rebuilt) — but rider sessions need to survive a
multi-week horizon, not a browser tab: move rider tokens to `localStorage`
with a silent refresh endpoint (API-side decision, see appendix). Nobody
should have to re-login on a street corner.

### 3.2 Admin gate: Google-exclusive email allowlist

Retire the GitHub OAuth gate entirely and fold admin into the same Google
door:

- The API keeps an `ADMIN_EMAILS` allowlist (initially
  `zneill@gmail.com`). When a Google sign-in verifies with
  `email_verified: true` and the email is on the list, the minted session
  carries an `admin` scope; the private device fields
  (`vehicle_plate`-history, `number_failed_starts`,
  `first_observed_at_location`, …) and any future admin endpoints key off
  that scope.
- **Admin requires the Google door specifically** — magic-link sessions
  never carry the scope, so a mistyped or spoofed allowlist email in the
  weaker flow can't escalate. One trust decision, enforced server-side.
- Frontend: the Account drawer simply shows an "Admin" section when the
  session has the scope. The hidden-tab + 9-tap unlock gesture retires with
  the GitHub gate — the Account tab becomes always visible because every
  rider now needs it to sign in. (The 9-tap gesture can live on as a pure
  easter egg if it sparks joy.)

### 3.3 Ride start: countdown, detection, and exit

- A **Start ride** button appears (a) in Find-a-ride mode after tapping
  "Unlock in Veo" — when the user switches back to the browser, the HUD is
  one tap away — and (b) as a persistent 🧭 tab.
- The start control offers three explicit modes, because the rider's hands
  are busy scanning a QR right at t=0:
  - `[ Start now ]`
  - `[ Start in 10s ▾ ]` — long-press or dropdown picks 5/10/15/30 s; a
    full-screen countdown with a giant cancel runs while they scan and
    mount the phone.
  - *Auto:* if sustained GPS speed > 6 mph for 10 s with no clock running,
    a one-tap "Riding? Start the clock" prompt appears.
- **End** is a huge bottom-of-screen button; auto-suggest ending after
  speed < 2 mph for 3 minutes.

### 3.4 The HUD: speed, cost, clock-sync

Full-screen overlay (`src/ride-hud.ts`) on top of a dimmed, simplified map:

- **Speedometer** (anonymous, no login): `watchPosition` with
  `enableHighAccuracy`; `coords.speed` (m/s → mph) where provided, else
  derived from successive fixes; EMA-smoothed; the dominant element (~30%
  of screen height).
- **Cost ticker (signed-in only):** `$1.00 + minutes × rate`. The first
  activation walks the user through sign-in (3.1) and a one-time **rate
  picker** — Resident $0.25 / Visitor $0.39 / Equity program — saved to
  their account profile (`PUT /profile`), so the choice follows them across
  devices and is changeable in the Account drawer. Anonymous riders see the
  ticker slot as a single `[ Sign in to track cost ]` chip, not a nag.
- **Clock-sync, adjustable mid-ride:** our clock will never exactly match
  Veo's billing clock, so make correction a first-class, glanceable
  control: tapping the cost/clock tile flips it into adjust mode with big
  `−15s / +15s` (and `−1m / +1m`) nudge buttons and a "reset to now" —
  usable with a thumb while the clock keeps counting. The summary screen
  also allows editing start/end times after the fact, so the saved estimate
  can be squared with the Veo receipt.
- **Equity-zone awareness:** the HUD knows the ride's start point; a
  client-side point-in-polygon against the v1/v2 boundaries
  ([src/geo.ts](../src/geo.ts)) sets an "equity ride" flag shown as
  🏷️ *"started in an equity zone — discount applies"*, feeding the Phase 4
  discount check.
- **Keep-awake & legibility:** Screen Wake Lock API (Chrome, iOS Safari
  16.4+), `requestFullscreen` where available, two fixed high-contrast
  palettes (day: black-on-white/yellow; night: luminescent green-on-black)
  switched by `prefers-color-scheme` with a manual toggle.
- **Follow-me map:** MapLibre geolocate follow with bearing-up rotation
  (`easeTo({bearing: coords.heading})`). Optional 45° pitch as a setting,
  off by default — no 3D buildings, no terrain.
- **The 2-second rule:** during the ride the HUD shows exactly three things
  — speed, elapsed cost, equity flag. Everything else waits for the
  summary.

### 3.5 Ride summary & the competition counterfactual

On End, a summary card:

- Duration (with editable start/end per 3.4), distance (integrated from GPS
  fixes), estimated Veo cost at the account's rate.
- **"If Veo had competition":** the same ride priced under config-driven
  comparator rates (`src/config.ts`:
  `COMPARATOR = { name: "Lime", unlock: 1.00, perMin: 0.30, weekPass: 4.99 }`
  — adjust to Lime's last-known Denver rates before shipping). Rendered as
  *"With Lime's typical pricing: $X.XX — you paid $Y.YY more because Denver
  has one operator."* Plus the break-even: *"a $4.99 weekly pass would have
  covered this in N rides."*
- Equity flags: *"This ride started in an equity zone — Veo owes you the
  contract discount. Check your receipt"* → links into the Phase 4 missed-
  discount report (until Phase 4 ships, the "how to check" helper text).
- The counterfactual lives in the summary, not the live HUD — it's
  advocacy, and advocacy can wait until the rider has stopped moving.

### 3.6 Destination & bike directions (optional, two tiers)

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

### 3.7 Money & time hacks: the discount-zone optimizer

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
- The savings math reuses the 3.4 cost model; the discount rate is a
  `src/config.ts` constant until confirmed from the contract text.

### 3.8 Ride IQ: contextual tips

A tiny content system (`public/tips.json` + `src/tips.ts`): each tip has a
context trigger and shows as a dismissible one-liner, never more than one
per screen, "don't show again" per tip in `localStorage`. Launch set:

- Pre-ride card: *"🎵 You can play music through the scooter's speaker —
  look for it in the Veo app."*
- Pre-ride, zone-adjacent: the 3.7 discount suggestions.
- Summary: pass break-even math, equity receipt check.

Tips are data, not code — adding more hacks later is a JSON edit.

**Files touched:** new `src/ride-hud.ts`, `src/ride-cost.ts`,
`src/destination.ts`, `src/tips.ts`, `src/auth.ts`, `public/tips.json`;
`src/config.ts`, `src/main.ts`, `src/api.ts`, `index.html`,
`src/style.css`. **API dependencies:** the auth + profile endpoints in the
appendix.

---

## Phase 4 — Crowdsourced audit loop: failure & equity-discount reports

**Goal:** turn riders into auditors, reusing the Phase 3 accounts. The
frontend work is deliberately thin; the backend gets its first
report-ingestion surface.

### 4.1 One-tap failure reports

In the device popup, a report row:
`[ 🚫 Failed to unlock ] [ 🪫 Dead battery ] [ 🛴 Damaged ]`
POSTs `{vehicle_identifier, report_type, snapshot_time}` to a new
`POST /api/v1/reports/device` endpoint. Anonymous reports are accepted but
heavily rate-limited; signed-in (3.1) reports carry more weight in the
aggregates — the first report prompt doubles as the sign-in moment, framed
as *"Sign in so your report counts."* Optimistic UI with a "Ghost scooter
logged — you saved someone a walk" confirmation. These reports feed the
Phase 2 reliability tier, closing the loop.

### 4.2 Equity-zone awareness & discount reports

- **Pre-ride priming:** reuse the point-in-polygon check to badge devices
  inside v1/v2 zones: *"🏷️ Equity zone — rides starting or ending here are
  contractually discounted. Check your receipt."*
- **Report a missed discount:** entered from the Phase 3 ride summary or a
  "Report" drawer tab — (1) Did Veo apply the discount? Yes / No / How do I
  check?, (2) on "No", optional receipt-screenshot upload
  (`POST /api/v1/reports/discount`, image to R2), (3) a pre-filled
  `mailto:` to Veo support cc'ing DOTI's shared-mobility inbox citing the
  contract clause.

### 4.3 Public accountability layer

- **"Contract violations" choropleth mode:** a new option in the density
  select, colored by discount-denial report frequency per region
  (needs `GET /api/v1/reports/summary?layer=`).
- **Ticker in the Compliance drawer:** *"Discount reports this month: N ·
  estimated overcharges: $X"*, plus `[ Download monthly report (CSV) ]`
  linking straight to an API export URL.

**Frontend files:** `src/api.ts`, `src/devices.ts` (popup), new
`src/reports.ts`, `index.html`, `src/style.css`.

---

## Phase 5 — Personalization: history, favorites, theming, badges (free)

**Goal:** make the app feel like *yours* once you have an account. Every
item below is free; the only gate is being signed in, and that gate exists
because these features are per-account data, not because they're a
privilege.

> **Removed:** the original 5.1 was "Payment: Stripe Payment Links,
> pay-what-you-want" — a supporter tier funded by a Stripe Payment Link
> with a `POST /webhooks/stripe` handler flipping `supporter: true` on the
> profile. **The app has been decommercialized**; there is no payment
> integration, no supporter flag, and nothing to buy. The sections below
> are what remains, ungated.

### 5.1 Ride history (opt-in, yours, deletable)

- The Phase 3 ride summary gains a `[ Save this ride ]` action for any
  signed-in rider: duration, cost estimate, start/end zone flags, and the
  route polyline POSTed to `POST /api/v1/rides`.
- A **History** section in the Account drawer: list + a personal map layer
  of past rides, running totals ("$142 spent · $38 more than under Lime
  pricing" — the counterfactual compounds beautifully over time), and
  personal records.
- Privacy is the feature: saving is per-ride opt-in (never automatic),
  history is visible only to the account, exportable as GeoJSON/CSV, and
  deletable one ride at a time or wholesale. Location traces are the most
  sensitive thing this app will ever hold; say so in the UI.
- *Status:* not built. The earlier ⌛ Ride history modal was a stub with no
  backend behind it and was removed; the real thing lands with the ride
  endpoints (see `API_INTEGRATION_PLAN.md` Phase C).

### 5.2 Favorites, theming, badges

- **Favorite device types:** a placeholder pending the fuller spec — at
  minimum, any signed-in rider can mark vehicle models/plates as favorites
  and get a "favorites first" sort + a map highlight. (Design note: the
  fleet has distinguishable generations/models worth preferring; wire the
  profile schema so `favorites: []` can hold whatever shape that discussion
  lands on.)
- **Theming:** additional UI themes (accent colors, dot styles, a high-vis
  HUD palette pack), available to everyone. Pure CSS-variable swaps keyed
  off the profile — no backend beyond storing the choice. (Light/dark
  already ships in `src/theme.ts` and needs no account at all; only
  cross-device persistence does.)
- **Badges:** computed server-side from existing data — reports filed
  (Phase 4), ghost scooters confirmed, equity reports that led to refunds,
  ride streaks, miles logged. Shown in the Account drawer. All of them are
  *earned*; there is no purchased badge, and contribution is never gated.

**Files touched:** `src/account.ts` (drawer sections), `src/ride-hud.ts`
(save action), `src/api.ts`, `src/style.css` (themes), `index.html`.
**API dependencies:** appendix.

---

## Appendix — API repo work plan (currently `veo-audit`)

Everything the backend needs, grouped by the frontend phase it unblocks.
This belongs in the API repo's own planning doc; it's consolidated here so
the two repos can be sequenced together.

**Unblocks Phase 2 (read-only field promotions):**
- Promote `vehicle_plate` to the public devices endpoint; confirm it equals
  the QR `number` param.
- Promote `number_failed_starts` + `first_observed_at_location` (or ship a
  computed `reliability_tier`) publicly.

**Unblocks Phase 3 (accounts):**
- `POST /api/v1/auth/google` — verify Google ID token (JWKS), mint session.
- `POST /api/v1/auth/magic-link` — issue one-time token, send via Postmark
  (existing account); `POST /api/v1/auth/redeem` — exchange for a session.
  Rate-limit issuance per email/IP.
- Session lifetime work: longer-lived rider tokens + a silent
  `POST /api/v1/auth/refresh`, so ride mode never demands a street-corner
  re-login. (The current short sessionStorage session stays fine for
  admin.)
- `GET/PUT /api/v1/profile` — stores the rate choice
  (`resident | visitor | equity`) and future preferences.
- `ADMIN_EMAILS` allowlist (initially `zneill@gmail.com`); Google-door
  sign-ins with a verified, allowlisted email get an `admin` scope that
  gates today's private fields and future admin endpoints. Retire the
  GitHub OAuth app once this lands.

**Unblocks Phase 4 (reports):**
- `POST /api/v1/reports/device` and `POST /api/v1/reports/discount`
  (+ receipt image to R2); abuse controls (rate limits, session weighting).
- `GET /api/v1/reports/summary?layer=` aggregates for the violations
  choropleth and ticker; monthly CSV export endpoint.

**Unblocks Phase 5 (personalization):**
- ~~`POST /webhooks/stripe`~~ — **retired.** The supporter tier is gone; the
  backend has no payment surface and `sql/036_decommercialize.sql` drops
  the supporter columns. Do not build this.
- `POST/GET/DELETE /api/v1/rides` — opt-in ride history (summary +
  polyline), owner-only, with export (GeoJSON/CSV) and hard delete.
- Profile schema: `theme`, `favorites: []` (shape TBD with the
  favorite-device-types spec), computed `badges` on the profile response.
  No `supporter` field.

**On renaming the repo:** `veo-audit` described the scraper; the repo is
becoming the platform behind scooter.fyi — auth, profiles, reports, *and*
the audit. Two considerations: (a) the name should match what it serves
(`data.scooter.fyi`), and (b) when journalists or DOTI cite the data
source, a neutral name reads as infrastructure while "veo-audit" reads as
a grudge. Suggested: **`scooter-fyi-api`** (clear, matches the domain), or
`scooter-fyi-platform` if it will also own cron/scraping/exports. GitHub
auto-redirects old clone URLs and links after a rename, so the cost is
near zero; keep "Veo Audit" as the public-facing *report/dataset* name
where the adversarial framing is the point.

---

## Still deferred (with reasons)

- **3D buildings/terrain in Ride Mode:** adds GPU load and visual noise
  without a safety payoff; the flat bearing-up view carries all the
  information.
- **Audio prompts & geofence speed-zone warnings:** worth doing, but they
  need the city's geofence polygons (not yet in the API) and careful
  autoplay-policy handling; revisit after Phase 3 proves mid-ride usage.
- **In-app turn-by-turn (3.6 Tier 2):** planned, not deferred forever —
  but the static Denver bike-graph build is real work, and the OS handoff
  covers the need until the HUD proves mid-ride usage.
- **Sign in with Apple:** requires the $99/yr Apple Developer Program; the
  magic-link door already covers Apple-only users at zero cost.

## Sequencing rationale

- Phase 1 fixes the confusion that makes every later feature harder to
  find, and touches no data contracts — lowest risk, ship first.
- Phase 2 completes the find-a-ride funnel and is the app's differentiator;
  its only API asks are read-only field promotions.
- Phase 3 carries accounts because the cost ticker is login-gated, and the
  rate choice is the natural first thing an account stores. The admin-gate
  migration rides along so auth is built once, with both trust tiers, and
  the GitHub app retires in the same stroke.
- Phase 4 comes after accounts because report ingestion, abuse handling,
  and evidence storage are the largest new surface — and its reports are
  more credible displayed inside the reliability UI that Phase 2
  establishes. Its sign-in moment ("sign in so your report counts") reuses
  Phase 3 auth verbatim.
- Phase 5 is last because it personalizes what the earlier phases make
  valuable: history needs the ride HUD, badges need the report loop, and
  favorites need enough of the fleet UI to be worth sorting. (It used to be
  last because it *monetized* those things — that rationale retired with
  the supporter tier.)
