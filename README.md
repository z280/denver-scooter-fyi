# denver.scooter.fyi

A live, full-screen map of every Veo shared scooter and e-bike in Denver. Dots
update on a 90-second loop, color-coded by vehicle type, with optional boundary
overlays, a per-region choropleth, address and place search, and a
daily-compliance gauge. On top of the map: a guided Ride Mode with walking and
riding directions, voice guidance and a live cost HUD; rider stats and a fleet
analytics page; dibs; points, leaderboards and Territory Control; and ways
for riders to report, photograph and tell their story about the fleet.

It is a static single-page app in the hosting sense — this repo builds to plain
files on Cloudflare Pages, with no server of its own. It is *not* self-contained:
almost everything comes from the public **data.scooter.fyi** API, and the
vector basemap is self-hosted on Cloudflare R2. The exceptions — all fetched
directly by the browser — are:

- **Google Identity Services** (`accounts.google.com/gsi/client`), the
  sign-in script, loaded for visitors who are not signed in
  ([src/auth-google.ts](src/auth-google.ts)).
- **OpenStreetMap Nominatim**, which turns the coordinates of a saved place
  or a parking report into a street address ([src/geocode.ts](src/geocode.ts)).
- **weseeyouveo.com**: its logo on the map page, the rider-story options when
  the story screen opens, and a story only if you tick the box to send it
  ([src/rider-story.ts](src/rider-story.ts)).
- **sunrise-sunset.org**, only with the sun-synced theme
  ([src/theme.ts](src/theme.ts)).
- **Cloudflare R2**, which serves the basemap tiles (`BASEMAP_PMTILES_URL`).

**The map works fully anonymously.** Everything that draws the map — the device
feed, boundaries, H3 aggregates, the compliance gauge, routing, and anonymous
device reports — is unauthenticated. Accounts are **optional** and exist only
for the features that have to be tied to a person: rider reports, ride tracking
and history, points, your profile, and plates for scooters near you, which come from
`/api/v1/vehicles/plates` and gate "Unlock in Veo"
([src/plates.ts](src/plates.ts)). Your browser never contacts Veo: going from
a plate you scanned or typed to a scooter uses the public, rate-limited
`/api/v1/vehicles/resolve`, which never returns a plate. Sign-in is Google, an emailed
magic link, a typed email code, or a code texted to a US mobile number; each
mints a server-side bearer session. Which doors appear is decided by the
backend, not by a frontend flag — see [src/auth-config.ts](src/auth-config.ts)
and [src/auth-session.ts](src/auth-session.ts).

**On texts:** the number you sign in with is only usable once you have
*proved* you answer it, by typing back a texted code. A number saved in your
profile is a contact detail, not proof, and cannot sign anyone in — including
somebody who typed in yours. You can stop texts at any time by replying STOP.
That blocks them at the gateway rather than at a setting we control, and the
gateway is **shared with other applications on the same phone number**, so a
STOP stops all of them, not only scooter.fyi — worth knowing before you send
it. The app will tell you plainly when that has happened, and only an UNSTOP
text undoes it.

**On tracking:** the frontend loads no ad tech and no analytics SDKs. The one
third-party script is Google Identity Services, loaded for visitors who are
not signed in (above).
The only measurement is **private, first-party analytics** we run ourselves
([src/telemetry.ts](src/telemetry.ts) → the API's `/api/v1/telemetry/events`):
cookieless, with **no persistent identifier of any kind** — events carry a
per-tab session id (`sessionStorage`, dies with the tab), and daily-unique
counting happens server-side with a salted hash whose salt is destroyed
after two days. Event names come from a fixed allowlist; no free text,
search queries, coordinates, ride content, or preference values are ever
sent, and no account id is ever attached (only a signed-in yes/no flag).
The **About** drawer has an "Allow private analytics" switch that turns the
whole thing off for your browser (stored locally, works signed out), and
Global Privacy Control and Do Not Track are honored automatically.

**On your device:** `localStorage` holds your sign-in session token, your
settings (theme, rate plan, ride preferences, the analytics opt-out and the
like), saved and recent places, your dibs, watched scooters, the live ride
(so a reload can pick it up), and unsent story drafts. Recorded ride tracks
live in IndexedDB on your own device and leave it only if you choose to
donate one; the **Local Data** tab in the Account drawer is where you can
look at them, hand one over, or delete it.

That is not the same as "no data is recorded". Signed in, a ride started in
Ride Mode records where it started and ended in your ride history on the
API; routing, walking-route and place-search requests send the from/to
points (and what you typed) to the API; and the API stores a reporter IP and
user-agent on submitted reports, and the issuing IP and user-agent on
sessions. The [Privacy Policy](https://data.scooter.fyi/legal/privacy-policy)
is the rider-facing statement, and the machine-readable retention policy is
`GET /api/v1/meta/privacy`.

- **Live site:** https://denver.scooter.fyi
- **Data API contract:** https://github.com/z280/scooter-fyi-api/blob/main/docs/reference/API.md
- **Privacy Policy / Terms of Service:** https://data.scooter.fyi/legal/privacy-policy ·
  https://data.scooter.fyi/legal/terms-of-service
- **Plans and reference:** [docs/README.md](docs/README.md)

## Features

- Full-viewport MapLibre map, fit to Denver on load.
- Device markers clustered at low zoom; click a dot for a full detail popup.
- **Reliability tiers**: every device is scored likely-rideable / unknown /
  high-risk from quality flags, negative reports, failed starts, and dwell
  time. A charge under 10% also drops a device out of likely-rideable —
  riders report near-empty scooters often refuse to start or get pulled for
  a swap mid-walk. High-risk "ghost" devices render faded; the popup explains the
  verdict in plain language and, when it's risky, points at the nearest
  likely-rideable alternative with a one-tap jump.
- **🚫 It won't start**, at the moment it happens. The failed-start count on
  the feed is *inferred*, never reported: the API's ingest reads it off a GBFS
  id rotation with no movement, which needs Veo to rotate the id at all and
  needs two of them before a device is downgraded. A rider standing over a
  scooter that will not turn on knows more than that inference ever will, so
  the ride flow now has somewhere for them to say it — on the Open-in-Veo
  screen, mid-countdown (the second they find out), and on the walk flow's
  arrival panel. One tap files a `not_rideable` report, which overrides the
  reliability tier outright for 24 hours, and sends the rider to the picker
  rather than offering another go at a scooter they have just told us is dead.
- **🔔 Notify me if moved**: hear about it when somebody rides away a scooter
  you are connected to. A watch comes from exactly two places
  ([src/device-notify.ts](src/device-notify.ts) `WATCH_RULES`): a scooter you
  have called **dibs** on (which needs an account; at most two, and the watch
  ends when the dibs does), or the scooter you just finished riding (one,
  offered at the end of the ride, for two hours). A watch is kept locally in
  your browser, and the alert carries no location: it says the scooter went,
  and you open the app to see where. In-app always, plus a lock-screen
  notification where you have allowed one (asked for when a watch starts,
  never at page load). Listed in the Tools drawer under **Watched scooters**;
  the watch ends with the answer. It works while the app is open; the
  backgrounded half needs a server-side watcher that does not exist yet, and
  the copy says so.

  This **replaced "Keep this one"** (the ⭐). That feature cost a sign-in, a QR
  scan and a fix within 75 m, and in exchange told you where a scooter you
  liked was parked — which this map already does, for every scooter, to
  anybody. The question a map cannot answer by sitting there is whether it has
  gone.
- **Walking to the scooter** (opt-in location): an in-app walking route on
  the map from the API's router (`GET /api/v1/route/walk`,
  [src/walk-leg.ts](src/walk-leg.ts)), re-routed as you walk, with an arrival
  panel that flips to "you're here" off your GPS fix.
- **Unlock in Veo**: the device popup deep-links into the Veo app using the
  same Adjust URL printed on the scooter's QR sticker. Deliberately gated —
  it appears only for a signed-in user with location on who is physically at
  the scooter (~75 m). Plates are never exposed to anonymous users, so the
  map can't be scraped back into a competing feed.
- **🧭 Use in Ride Mode** (device popup): a one-screen pre-ride survey —
  navigation directions (off by default), save tracks to this device (on),
  Veo cost HUD (on), and, while the cost HUD is on, "I started the Veo
  already" vs "Give me a link to Start". A rider standing at a scooter has
  already answered "which one?" by opening the popup, so the survey skips
  every wizard screen its answers make unnecessary and visits every screen
  they make necessary: navigation on lands on the destination picker, "give
  me a link" lands on Start-in-Veo, and anything else goes straight into
  ride mode. Cost HUD off is a real branch — the Veo question disappears
  entirely, the rate plan is not re-confirmed (that lives in your profile),
  and ride mode starts with the cost readout hidden.
- **📷 Scan** (the ribbon's QR tool): one scanner with a rotatable dial in
  front of it choosing what the scan does — **Confirm features**, or **Ride
  mode**, which starts a ride on the scanned scooter, picks up a ride you were
  half-way through setting up, or tells a ride you already started which
  scooter it is on. That last one is the gap: a ride recorded without a vehicle
  (the free-ride path) had no way to gain one, so it went into the record as
  having been on nothing in particular. A ride whose vehicle the server already
  stamped is left alone, and says so — that was settled when it started.
- **☑️ Confirm Features**: Veo's feed says nothing about what is bolted to a
  given scooter, so riders standing next to one tell us — a bell, a cup
  holder, a phone holder, a basket, and whether they're all in good
  condition. Every device is asked all four, including the models that
  rarely carry a basket: a confirmed "no" is what makes the fleet
  filterable, and the Rover's cargo basket is standard equipment that can
  still be bent. The presence questions ask only what is bolted on; whether
  it *works* is what the condition question right underneath asks.
  Neither Yes nor No is pressed by default, because a pre-pressed answer is
  an answer nobody gave. Confirming needs the plate under the scooter's QR
  code (you can't do it from your sofa); a wrong plate is still accepted and
  still recorded, it just earns nothing. Every device starts out labelled
  "Needs features confirmed"; a later report that disagrees flips it to
  "Needs review", and three reports settle it by 2/3 consensus. Worth 12
  points first time, 14 for clearing a review, 6 to reconfirm.
- **Home bar** (bottom center): "Where are you going?" — search for a
  destination (or pick a saved or recent place, or tap the map), then say
  whether you want a Veo or have your own wheels. That is the way into a
  planned trip and Ride Mode. It replaced the old three-way mode bar
  (Find wheels / Analysis / Ride), which is gone for good
  (`src/mode-bar-gone.test.ts`); the analysis surfaces live in the left
  activity bar.
- **🗺️ Navigation with voice guidance**: Ride Mode can route you to a
  destination and show turn-by-turn instructions on the HUD, with spoken
  prompts (with a mute) via the browser's own speech synthesis
  ([src/ride-voice.ts](src/ride-voice.ts)).
- **✋ Dibs**: a timestamped public claim on a scooter you are walking to
  (signed in; it expires), with a shareable certificate that settles who
  called it first. Veo has no reservations; this is the honest substitute
  ([src/dibs.ts](src/dibs.ts)).
- **📣 Rider stories**: after a ride you can write a short story and, only if
  you tick the box, send it to the rider-advocacy site We See You Veo
  ([src/rider-story.ts](src/rider-story.ts)).
- **🧾 Equity receipt claims**: "Didn't get the discount?" — a signed-in
  form for a Veo receipt that should have been billed at the Equity Area
  rate; matching it to a ride happens server-side
  ([src/equity-receipt-form.ts](src/equity-receipt-form.ts)).
- **🏆 Points, leaderboards and Territory Control**: confirmed reports,
  scans, photos and rides earn points; the Leaderboard drawer shows the
  regional tally and can shade each H3 hexagon by who leads it.
- **📊 Rider stats and fleet analytics**: the Stats drawer shows rental
  outcome statistics from Veo's feed and links to the full **/analytics**
  page (rides, failed starts, fleet status, equity-area share and dwell, by
  hour, day, week or month). The same stats panel is published standalone at
  `embed/stats.html` for framing on weseeyouveo.com.
- **🧭 Ride companion**: a landscape-first HUD (the Veo app has none) where
  the live, pitched follow-cam map fills the whole screen — your position
  marker recenters it as you move, with 3D building extrusions where the
  basemap carries them — and only tiny corner cutouts float on top:
  - top-left: live cost at your chosen rate (contract-locked Denver pricing),
  - top-right: a digital mph readout,
  - bottom-left: the ride clock with a red stop button (end ride), a
    wrench button (a panel for the countdown-start clock ±15s/±1m nudges,
    rate, which models the map draws, and day/night theme), an **On screen**
    button (per-readout toggles for the clock, the cost and either
    speedometer — these used to be buried inside the wrench panel, filed
    under the controls for time and rate), and a **re-center** button,
  - bottom-right: a car-style analog speedometer with an animated needle,
    0–18 mph and a caution band past Denver's ~15 mph cap.

  **The map is yours to move.** A deliberate pan, pinch or rotate stops the
  follow-cam chasing you — the camera holds still so you can look at what is
  coming, and the re-center button lights up to say why the map went quiet.
  Your position marker keeps tracking throughout. Re-center is also the
  reset: one tap restores position, zoom, pitch and bearing together, because
  a rider who has pinched the map flat and spun it round wants one thing
  undone, not three.

  Ride start goes fullscreen with a best-effort landscape lock; the summary
  prices the trip under Lime's typical rates — what competition would have
  cost — and, for a ride that started or ended in an official Equity Area,
  quotes the contract's $0.13/min term and asks you to check your receipt.
- Controls grouped in a left activity bar (Filters, Iconography,
  Recommended, Areas, Leaderboard, Stats, Scan, Your trip, Tools, About,
  Compliance):
  - **Filters** — accordion sections: **Quick & Saved Filters** (one-tap
    presets such as ⚡ Charged & Ridable, 👍 Decent Rides and 🚫🛴 No
    Standing; save/load a map filter on this device; "My ideal scooter"),
    **Model** (Astro, Cosmo, Apollo, Rover toggle cards, all on by default),
    **Features** (require a confirmed bell, basket or cup holder, or show
    scooters with missing data), **Rideability & Battery** (Any / Hide
    high-risk / Likely rideable, a minimum battery percentage, hide Reserved
    & Out of Service, "Only ones that can get me there", and an opt-out from
    respecting other riders' dibs), and **Geographic Filters** (below), plus
    Reset Filters. What the dots show — Data / Model / Ride type icons,
    battery or reliability data, gauge rings, hover tooltip and legend — is
    in the **Iconography** drawer.
    Device popups open with a turquoise (Veo-brand) header naming the model
    — Veo Astro (standing), Cosmo (seated, no pedals), Apollo (seated,
    pedals, 2-passenger), or Rover (seated, three wheels, cargo basket) —
    and corrected rider posture (keyed off
    `vehicle_use_type`, since Veo mislabels `form_factor`). An unrecognized
    model shows "Veo Unknown — Tell us!" with a one-tap report form
    (description + optional camera photo) that POSTs to the audit API.
  - **Areas** — an **Equity areas** switch (off by default) drawing the
    city's official Equity Area map, three toggleable boundary outlines
    (Neighborhoods, City Council Districts, City Regions), choropleth
    coloring by live device density, an **H3 hexagon** tool
    (Off/Large/Medium/Small, shaded by any of six server-computed per-cell
    metrics — device density, trips started, starts/hour peak, avg
    battery, high-risk share, avg dwell — via a "Shade by" dropdown;
    mutually exclusive with the choropleth). The city's scooter rules
    zones and the Rover service area are drawn from here too.
  - **Geographic Filters** (in Filters) — "Filter devices by area": choose
    an area type (City Region, Equity Areas, Council District, Neighborhood)
    and pick areas from a searchable list. With an area type chosen,
    clicking a region directly on the map adds or removes it from the
    filter.
  - **Tools** — My dibs, Watched scooters, the dense-cluster finder,
    Confirm features by QR, Equity Compliance, devices over time, and (for
    admins) admin tools.
  - **About Scooter.fyi** — who runs this and why, the beta disclaimer,
    the non-commercial and pro-consumer commitments, links to the privacy
    policy and terms, and the "Allow private analytics" switch.
  - **Equity Compliance** — daily gauge (avg % of devices in the city's
    official Equity Areas vs. the 30% threshold), or PENDING before the
    daily window is computed. Also opens the **compliance calendar**: every
    day of this month and last, green where Veo met the target and red
    where it missed — with unmeasured days drawn as unmeasured rather than
    as failures.

    The **equity-rank estimate** that lived here is gone. It let you pick
    which of the city's six ranked tiers to estimate against, because the
    city had not said which bound the SLA. In August 2026 it did, and named
    a single official map; a control whose whole purpose was to hedge an
    open question does not survive the question being answered. The
    superseded maps (Disadvantaged Areas v1/v2, ranks er1–er6) are still
    computed and served by the API — the compliance history runs through
    them — they are simply no longer drawn. See `src/config.ts`'s
    `RETIRED_OVERLAYS`.
- **Equity-area indicator.** Zoom into one of the city's official Equity
  Areas and a chip appears over the map: *Equity Area · $0.13/min*. Tapping
  it quotes the contract term verbatim — rides that stop or start in the
  area should be billed at that rate — and asks you to screenshot your
  receipt if the discount is missing. It is deliberately NOT gated on the
  Areas overlay being switched on: a discount you only learn about by going
  looking for it is the exact asymmetry this app exists to correct.
- Active-filter chips float over the map — one per live constraint, each
  with a ✕ to clear it — so closed drawers never hide the map's state.
- Bottom-right freshness footer: `as of HH:MM · Displaying x out of y`.
- Responsive: drawers fill the remaining width on mobile.
- **Install prompt**: mobile visitors get an on-load Home Screen suggestion
  (app icon + one-tap Install); tapping it shows Add-to-Home-Screen steps
  tailored to iOS Safari's Share sheet or Android's browser menu. Skipped
  entirely once already installed (standalone display mode) or dismissed.

## Tech stack

- [Vite](https://vite.dev/) 6 + vanilla TypeScript (strict). No framework.
- [MapLibre GL JS](https://maplibre.org/) 5 for rendering, clustering, and
  feature-state choropleths.
- [PMTiles](https://docs.protomaps.com/pmtiles/) + [@protomaps/basemaps](https://github.com/protomaps/basemaps)
  for a self-hosted vector basemap. Glyphs and sprites are vendored in
  `public/`; the `.pmtiles` archive is served from Cloudflare R2 (see below).
  No third-party tile API, no API key.

## Local development

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # vitest run (offline; every suite stubs fetch and storage)
npm run smoke          # boot the BUILT site in headless Chromium; fail on any uncaught error
npm run vectors:check  # tests/fixtures/track-chain-vectors.json still matches its generator
npm run simulate:ride  # fake a GPS ride in a real browser to test Ride Mode (needs Playwright)
```

The production API's CORS allowlist only includes production origins, so in dev
all `/api` requests are proxied through Vite to `https://data.scooter.fyi` with a
production `Origin` header, and `/wsyv` is proxied to `https://weseeyouveo.com`
for the rider-story calls (see [vite.config.ts](vite.config.ts)). In a
production build the browser calls the API directly. This split lives in
[src/api.ts](src/api.ts):

```ts
export const API_BASE = import.meta.env.DEV ? "" : "https://data.scooter.fyi";
```

### Build

```bash
npm run build    # tsc --noEmit + vite build  ->  dist/
npm run preview  # serve the production build locally
```

## The basemap (R2-hosted)

`basemap/denver.pmtiles` (~21 MB) is a clipped extract of the Protomaps planet
build, committed to the repo as the source of truth. The app does **not** load
it from Pages — Cloudflare Pages does not serve HTTP Range requests, and the
pmtiles client requires them (it throws when the server returns the whole file
instead of a `206`). So the archive is hosted on **Cloudflare R2**, which serves
`206 Partial Content`, and the app fetches it directly from the bucket's public
URL (`BASEMAP_PMTILES_URL` in [src/config.ts](src/config.ts)). Glyphs and sprites
do not need Range requests and stay vendored under `public/`.

R2 bucket: `denver-scooter-fyi-basemap`. CORS lives in
[r2-cors.json](r2-cors.json) (allows cross-origin GET + `Range`). Apply it with:

```bash
npx wrangler r2 bucket cors set denver-scooter-fyi-basemap --file=r2-cors.json
```

To regenerate and republish the archive:

```bash
scripts/build-basemap.sh            # newest available daily build -> basemap/denver.pmtiles
scripts/build-basemap.sh 20260515   # or pin a specific build date
# the script prints the exact `wrangler r2 object put ... --remote` upload command
```

The script downloads the `pmtiles` CLI into `.tooling/` (gitignored) and clips
to the map's bounding box. Upstream daily builds rotate out after ~3 months,
which is why the archive is committed rather than fetched at build time.

## Deployment

Pushed to **Cloudflare Pages** via GitHub Actions
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)):

- Push to `main` → production deploy to denver.scooter.fyi.
- Open a PR → a per-PR preview deploy at a `pr-<number>` URL.

Because `main` deploys itself, a frontend feature that depends on unshipped
backend work reaches production the moment it merges — there is no separate
"deploy" step in which to notice. Check
[docs/implemented/API_INTEGRATION_PLAN.md](docs/implemented/API_INTEGRATION_PLAN.md) for the current
cross-repo dependencies before merging anything that talks to a new
endpoint.

The workflow runs `npm ci`, `npm run build` (tsc + vite), `npm test`
(vitest), `npm run vectors:check` and `npm run smoke` (with
`SMOKE_CHANNEL=chrome`, the runner's preinstalled Chrome), and only then
uploads `dist/` with `wrangler pages deploy --branch=main` (production) or
`--branch=pr-<number>` (preview) — Direct Upload. The build step injects
`VITE_GOOGLE_CLIENT_ID`, but nothing in `src/` reads it: the Google client id
comes from the API's `/auth/config` at runtime. It needs two repository
secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token with the **Cloudflare Pages: Edit** permission. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID. |

One-time setup (see the deploy notes printed after the initial push for the
exact commands):

1. Create the Pages project named `denver-scooter-fyi`.
2. Add the two secrets above to the GitHub repo.
3. Map the custom domain `denver.scooter.fyi` to the Pages project (HTTPS via
   Cloudflare universal SSL).

## Project structure

```
basemap/           denver.pmtiles source of truth (uploaded to R2, not to Pages)
public/            vendored glyphs + sprites + _headers (deployed to Pages)
src/
  api.ts           typed client for the data.scooter.fyi API
  auth-*.ts        optional sign-in: capability discovery, Google, magic
                   link / typed code, texted code, and the shared
                   bearer-session store
  sms-door.ts      the "text me a code" sign-in forms (its own module: it is
                   the only door whose failure mode is a deliberate choice
                   rather than an error)
  map-auth.js      getAuth / isAuthenticated / signOut over the session blob
  auth-storage.ts  owns that blob, in localStorage (sessionStorage fallback)
  account-tabs.ts  the Account drawer's tab shell (Login / Profile /
                   Community / Local Data) — outlives every panel rebuild
  account-login.ts the signed-out sign-in doors (Google, email, text)
  account.ts       signed-in Account panel: contact details and rate plan on
                   Profile; username + royalty title + ruling colors +
                   privacy, badges and points on Community
  account-local-data.ts  rides recorded on this device: draw one on the map,
                   donate it, or delete it
  map-pick.ts      one-shot "tap the map" point picker (home/work addresses)
  home-work-pins.ts / track-route.ts   the map layers those two draw into
  config.ts        bounds, refresh cadence, colors, overlays, basemap URL
  map.ts           MapLibre map + Protomaps style
  devices.ts       device source, clustering, popups, type filter
  ride-preflight.ts  the device popup's "Use in Ride Mode" quick survey —
                   three toggles, then straight into ride mode past every
                   wizard screen the answers make unnecessary
  ios-shake-undo.ts  keeps iOS's "shake to undo" alert off the HUD: WebKit's
                   undo queue is page-wide and survives a blurred, deleted
                   field, so anything typed before a ride would otherwise get
                   an "Undo Typing" prompt on every bump in the road. The
                   ride flow's fields apply their own edits (which registers
                   nothing to undo), and entering the riding view empties the
                   queue for whatever was typed elsewhere
  qr-utility.ts    the ribbon's QR tool: one camera, a mode dial in front of
                   it, and the two jobs a scanned sticker can do
  qr-ride-scan.ts  what a scan MEANS to a ride — start, resume, associate, or
                   already-tied — kept pure and apart from the doing
  ride-failed-start.ts  "it won't start": the report, its four outcomes and
                   their words, plus why the fleet cannot infer this one
  device-notify.ts  "Notify me if moved": the local watch store, the
                   moved/in-use/gone verdict, and the one alert per scooter
  device-notify-panel.ts  its Tools-drawer list and the in-app toast
  emoji-scale.ts   the five-face rating control, and the two mappings that keep
                   the API's 1-10 and 0-10 columns unchanged
  survey-cadence.ts  how often the post-ride survey may ask the long question
  device-features.ts crowdsourced equipment: the "Confirm Features" survey,
                   the three-status vocabulary, and reading the map
                   payload's device_features object
  overlays.ts      boundary layers, choropleth, neighborhood highlight
  hexdensity.ts    the Areas drawer's H3 hexagon shading: six live per-cell
                   metrics off one aggregates fetch, plus Territory Control
                   (who leads each hexagon), which is pinned to r8 because
                   that is the only resolution the area-leader report exists
                   at. Triple-click any shaded hexagon for its cell id and
                   exact value
  leaderboard.ts   the pure half of territory control — payload to GeoJSON,
                   the cell-detail panel, and the one fill opacity every
                   claimed hexagon renders at (it is deliberately NOT a
                   per-rider setting; see the constant's comment)
  leaderboard-panel.ts  the Leaderboard menu drawer: the Show Territory
                   Control switch, the live regional tally, and the points
                   ledger read from the API so the copy cannot promise a
                   number the server does not pay. Deliberately a drawer
                   (#drawer-leaderboard), not the modal the original brief
                   named: the owner chose to keep it, and the map stays
                   usable while the board is open
  triple-click.ts  the "three clicks means tell me exactly what this is" map
                   gesture, on its own so the timing is testable
  compliance.ts    daily SLA gauge
  freshness.ts     "as of …" footer
  main.ts          wiring: load, controls, 90s refresh loop
  style.css        all styling
index.html         markup + control panel
analytics.html     the /analytics fleet analytics page (src/analytics-page.ts)
embed/stats.html   the standalone stats panel, for framing (src/embed-stats.ts)
vite.config.ts     build config + dev API and /wsyv proxies
wrangler.toml      Cloudflare Pages project config
r2-cors.json       R2 bucket CORS policy for the basemap
tests/             shared test setup, helpers and fixtures (most tests sit
                   beside their module as src/*.test.ts)
docs/              plans and reference — see docs/README.md
scripts/
  build-basemap.sh      regenerate + republish the pmtiles
  build-zones.mjs       public/micromobility-zones.geojson from the city's zone files
  build-rover-zone.mjs  the Rover service-area polygon (docs/reference/ROVER_ZONE.md)
  gen-track-vectors.mjs track-chain test vectors (npm run vectors:check)
  simulate-gps-ride.mjs fakes a GPS ride in a browser (npm run simulate:ride)
  smoke.mjs             headless boot check of the built site (npm run smoke)
```

## Out of scope

Historical map playback, and server-side (push) alerting — "Notify me if
moved" alerts are local and need the app open, and historical charts live on
the /analytics page rather than on the map. Everything stateful — accounts, reports,
rides, points, profiles — lives in the **data.scooter.fyi** backend
([scooter-fyi-api](https://github.com/z280/scooter-fyi-api)); this repo is only its
frontend and contains no server code.
