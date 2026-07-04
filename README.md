# denver.scooter.fyi

A live, full-screen map of every Veo shared scooter and e-bike in Denver. Dots
update on a 90-second loop, color-coded by vehicle type, with optional boundary
overlays, a per-region choropleth, neighborhood search, and a daily-compliance
gauge.

It is a static single-page app — no backend, no accounts, no tracking. The
browser talks directly to the public **data.scooter.fyi** API and renders a
self-hosted vector basemap.

- **Live site:** https://denver.scooter.fyi
- **Data API contract:** https://github.com/z280/veo-audit/blob/main/API.md

## Features

- Full-viewport MapLibre map, fit to Denver on load.
- Device markers clustered at low zoom; click a dot for `device_id` + type.
- Controls grouped by attribute in a left activity bar:
  - **Devices** — type filter (All / Scooters / E-bikes), availability
    switch, and a unified battery block: quartile filter buttons plus a
    "Color dots by range" toggle (auto-enabled when you filter by battery).
  - **Areas** — five toggleable boundary outlines (Disadvantaged Areas
    v1/v2, Neighborhoods, City Council Districts, City Regions), choropleth
    coloring by live device density, and an "Only show devices in…" area
    filter. With an area type chosen, clicking a region directly on the map
    adds or removes it from the filter.
  - **Tools** — dense-cluster finder.
  - **Equity Compliance** — daily gauge (avg % of devices in v1 areas vs.
    the 30% threshold), or PENDING before the daily window is computed.
- Active-filter chips float over the map — one per live constraint, each
  with a ✕ to clear it — so closed drawers never hide the map's state.
- Bottom-right freshness footer: `as of HH:MM · Displaying x out of y`.
- Responsive: drawers fill the remaining width on mobile.

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

Accounts, historical playback, trip data, alerting, and any backend. This app
only visualizes the current public snapshot.
