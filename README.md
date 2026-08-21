# denver.scooter.fyi

A live, full-screen map of every Veo shared scooter and e-bike in Denver. Dots
update on a 90-second loop, color-coded by vehicle type, with optional boundary
overlays, a per-region choropleth, neighborhood search, and a daily-compliance
gauge.

It is a static single-page app in the hosting sense — this repo builds to plain
files on Cloudflare Pages, with no server of its own. It is *not* self-contained:
the browser talks directly to the public **data.scooter.fyi** API for every bit
of data, and renders a self-hosted vector basemap.

**The map works fully anonymously.** Everything that draws the map — the device
feed, boundaries, H3 aggregates, the compliance gauge, routing, and anonymous
device reports — is unauthenticated. Accounts are **optional** and exist only
for the features that have to be tied to a person: rider reports, ride tracking
and history, points, your profile, and the signed-in device feed that exposes
plates (which is what gates "Unlock in Veo"). Sign-in is Google, an emailed
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

**On tracking:** the frontend loads no ad tech and no third-party scripts.
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
Global Privacy Control is honored automatically. `localStorage` otherwise
holds only your own settings (theme, rate plan, install-prompt
dismissal, the analytics opt-out, and a same-day-visit date stamp). Recorded ride tracks live in IndexedDB on your own device and are
uploaded only if you choose to donate one; the **Local Data** tab in the
Account drawer is where you can look at them, hand one over, or delete it.
That is not the same as "no data is recorded": the API stores a reporter IP
and user-agent on submitted reports, and the issuing IP and user-agent on
sessions. The authoritative, machine-readable retention policy is
`GET /api/v1/meta/privacy`.

- **Live site:** https://denver.scooter.fyi
- **Data API contract:** https://github.com/z280/scooter-fyi-api/blob/main/API.md

## Features

- Full-viewport MapLibre map, fit to Denver on load.
- Device markers clustered at low zoom; click a dot for a full detail popup.
- **Reliability tiers**: every device is scored likely-rideable / unknown /
  high-risk from quality flags, negative reports, failed starts, and dwell
  time. High-risk "ghost" devices render faded; the popup explains the
  verdict in plain language and, when it's risky, points at the nearest
  likely-rideable alternative with a one-tap jump.
- **Walk economics** (opt-in location): straight-line walk time to any
  device, a dashed guide line on the map, and a Directions handoff to
  Apple/Google Maps in walking mode.
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
- **Intent modes** (bottom center): one-tap presets — 🛴 *Find wheels*
  (available devices, reliability coloring, location offer) and 📊 *Analysis*
  (v1 choropleth + compliance gauge). The bar always shows the current
  mode; tweaking filters or iconography doesn't clear it.
- **🧭 Ride companion**: a landscape-first HUD (the Veo app has none) where
  the live, pitched follow-cam map fills the whole screen — your position
  marker recenters it as you move, with 3D building extrusions where the
  basemap carries them — and only tiny corner cutouts float on top:
  - top-left: live cost at your chosen rate (contract-locked Denver pricing),
  - top-right: a digital mph readout,
  - bottom-left: the ride clock with a red stop button (end ride) and a
    wrench button (a panel for the countdown-start clock ±15s/±1m nudges,
    rate, and day/night theme),
  - bottom-right: a car-style analog speedometer with an animated needle,
    0–18 mph and a caution band past Denver's ~15 mph cap.

  Ride start goes fullscreen with a best-effort landscape lock; the summary
  prices the trip under Lime's typical rates — what competition would have
  cost — and, for a ride that started or ended in an official Equity Area,
  quotes the contract's $0.13/min term and asks you to check your receipt.
- Controls grouped by attribute in a left activity bar:
  - **Devices** — type filter (All / Scooters / E-bikes), availability
    switch, a unified battery block: quartile filter buttons plus a
    "Color dots by range" toggle — **on by default**, so dots show battery
    percentage out of the box — and a "Color dots by reliability" toggle.
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
    mutually exclusive with the choropleth), and an "Only show devices
    in…" area filter. With an area type chosen, clicking a region directly
    on the map adds or removes it from the filter.
  - **Tools** — dense-cluster finder, the compliance calendar, and
    devices-over-time.
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
npm run dev      # http://localhost:5173
```

The production API's CORS allowlist only includes production origins, so in dev
all `/api` requests are proxied through Vite to `https://data.scooter.fyi` with a
production `Origin` header (see [vite.config.ts](vite.config.ts)). In a
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
[docs/API_INTEGRATION_PLAN.md](docs/API_INTEGRATION_PLAN.md) for the current
cross-repo dependencies before merging anything that talks to a new
endpoint.

The workflow runs `npm ci && npm run build`, then uploads `dist/` with
`wrangler pages deploy` (Direct Upload). It needs two repository secrets:

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
  map-auth.js      the sessionStorage session store the auth doors write to
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
                   number the server does not pay
  triple-click.ts  the "three clicks means tell me exactly what this is" map
                   gesture, on its own so the timing is testable
  compliance.ts    daily SLA gauge
  freshness.ts     "as of …" footer
  main.ts          wiring: load, controls, 90s refresh loop
  style.css        all styling
index.html         markup + control panel
vite.config.ts     build config + dev API proxy
wrangler.toml      Cloudflare Pages project config
r2-cors.json       R2 bucket CORS policy for the basemap
scripts/           build-basemap.sh (regenerate + republish the pmtiles)
```

## Out of scope

Historical playback and alerting. Everything stateful — accounts, reports,
rides, points, profiles — lives in the **data.scooter.fyi** backend
([scooter-fyi-api](https://github.com/z280/scooter-fyi-api)); this repo is only its
frontend and contains no server code.
