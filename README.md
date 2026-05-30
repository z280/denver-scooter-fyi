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
- Device-type filter: All / Scooters / Bicycles (recomputes clusters in place).
- Five boundary overlays, toggleable together (colored outline + faint fill):
  Disadvantaged Areas (v1), Disadvantaged Areas (v2), Neighborhoods,
  City Council Districts, City Regions.
- Choropleth coloring of any boundary layer by live device density.
- Neighborhood search that zooms to and highlights the selected polygon.
- Top-right compliance gauge (avg % of devices in v1 areas vs. the 30%
  threshold), or a PENDING state before the daily window is computed.
- Bottom-right freshness footer: `as of HH:MM · N devices`.
- Responsive: the control panel collapses to a bottom sheet on mobile.

## Tech stack

- [Vite](https://vite.dev/) 6 + vanilla TypeScript (strict). No framework.
- [MapLibre GL JS](https://maplibre.org/) 5 for rendering, clustering, and
  feature-state choropleths.
- [PMTiles](https://docs.protomaps.com/pmtiles/) + [@protomaps/basemaps](https://github.com/protomaps/basemaps)
  for a self-hosted vector basemap (archive, fonts, and sprites are vendored in
  `public/` — zero runtime third-party requests, no API key).

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

## Regenerating the basemap

`public/denver.pmtiles` (~21 MB) is a clipped extract of the Protomaps planet
build, committed to the repo as the source of truth. To refresh it:

```bash
scripts/build-basemap.sh            # uses the newest available daily build
scripts/build-basemap.sh 20260515   # or pin a specific build date
```

The script downloads the `pmtiles` CLI into `.tooling/` (gitignored) and clips
to the map's bounding box. Upstream daily builds rotate out after ~3 months,
which is exactly why the archive is committed rather than fetched at build time.

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
public/            vendored basemap: denver.pmtiles, fonts/, sprites/, _headers
src/
  api.ts           typed client for the data.scooter.fyi API
  config.ts        bounds, refresh cadence, colors, overlay definitions
  map.ts           MapLibre map + Protomaps style
  devices.ts       device source, clustering, popups, type filter
  overlays.ts      boundary layers, choropleth, neighborhood highlight
  compliance.ts    daily SLA gauge
  freshness.ts     "as of …" footer
  main.ts          wiring: load, controls, 90s refresh loop
  style.css        all styling
index.html         markup + control panel
vite.config.ts     build config + dev API proxy
wrangler.toml       Cloudflare Pages project config
```

## Out of scope

Accounts, historical playback, trip data, alerting, and any backend. This app
only visualizes the current public snapshot.
