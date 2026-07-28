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
magic link, or a typed email code; each mints a server-side bearer session.
See [src/auth-config.ts](src/auth-config.ts) and [src/auth-session.ts](src/auth-session.ts).

**On tracking:** the frontend loads no analytics, telemetry, ad tech, or
third-party scripts, and `localStorage` holds only your own settings (theme,
rate plan, equity ranks, install-prompt dismissal). That is not the same as
"no data is recorded": the API stores a reporter IP and user-agent on submitted
reports, and the issuing IP and user-agent on sessions. The authoritative,
machine-readable retention policy is `GET /api/v1/meta/privacy`.

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
- **Intent modes** (bottom center): one-tap presets — 🛴 *Find wheels*
  (available devices, reliability coloring, location offer) and 📊 *Analysis*
  (v1 choropleth + compliance gauge). Manual changes drop back to custom.
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
  cost — and prompts an equity-discount receipt check for rides touching a
  disadvantaged area.
- Controls grouped by attribute in a left activity bar:
  - **Devices** — type filter (All / Scooters / E-bikes), availability
    switch, a unified battery block: quartile filter buttons plus a
    "Color dots by range" toggle — **on by default**, so dots show battery
    percentage out of the box — and a "Color dots by reliability" toggle.
    Device popups open with a turquoise (Veo-brand) header naming the model
    — Veo Astro (standing), Cosmo (seated, no pedals), or Apollo (seated,
    pedals, 2-passenger) — and corrected rider posture (keyed off
    `vehicle_use_type`, since Veo mislabels `form_factor`). An unrecognized
    model shows "Veo Unknown — Tell us!" with a one-tap report form
    (description + optional camera photo) that POSTs to the audit API.
  - **Areas** — five toggleable boundary outlines (Disadvantaged Areas
    v1/v2, Neighborhoods, City Council Districts, City Regions), choropleth
    coloring by live device density, an **H3 hexagon** tool
    (Off/Large/Medium/Small, shaded by any of six server-computed per-cell
    metrics — device density, trips started, starts/hour peak, avg
    battery, high-risk share, avg dwell — via a "Shade by" dropdown;
    mutually exclusive with the choropleth), and an "Only show devices
    in…" area filter. With an area type chosen, clicking a region directly
    on the map adds or removes it from the filter.
  - **Tools** — dense-cluster finder.
  - **Equity Compliance** — daily gauge (avg % of devices in v1 areas vs.
    the 30% threshold), or PENDING before the daily window is computed. Also
    hosts the **equity-rank estimate**: the city ranked equity areas 1–6 but
    hasn't said which bind the SLA, so you pick a rank set (default 1 + 2)
    and get a live "% of the fleet inside the selected ranks" figure, plus an
    "Equity Ranking (Selected)" union overlay in the Areas drawer.
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
                   link / typed code, and the shared bearer-session store
  map-auth.js      the sessionStorage session store the auth doors write to
  config.ts        bounds, refresh cadence, colors, overlays, basemap URL
  map.ts           MapLibre map + Protomaps style
  devices.ts       device source, clustering, popups, type filter
  overlays.ts      boundary layers, choropleth, neighborhood highlight
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
