# Atlanta — the frontend half

Status: **assessment**, nothing here is built. Companion to
`scooter-fyi-api/ATLANTA_PLAN.md`, which carries the live feed probes, the
identity measurements, and the API-side work. Read that first — this doc
only covers what changes in this repo, and it assumes that doc's measured
finding that **neither Atlanta operator publishes a usable stable vehicle
id** — Bird re-mints every `bike_id` each ~60 s, and Lime, despite ~99%
cycle-to-cycle persistence, periodically re-mints its entire namespace at
once. Both are `stable_vehicle_id: false`.

`MULTI_TENANCY_PLAN.md` names a companion `docs/MULTI_CITY_FRONTEND_PLAN.md`
for the general de-Denverization. That doc does not exist. This one is not
it: this is Atlanta-specific and narrower.

---

## 1. The size of it

101 non-test modules in `src/`. **37 of them** are in the family that a
false `stable_vehicle_id` capability turns off:

```
ride-* (22)  dibs* (4)  qr-* (2)  device-* (3)  track-* (3)
reports  recommend  arrival-panel
```

That is the honest headline. It is not "add a city dropdown" — it is a
per-surface decision, 37 times, about whether a screen hides, degrades, or
explains itself. Some of those 37 survive: `ride-cost` never touches `vehicle_identifier`
at all, and most of the `ride-*` family lives on through the off-feed path
(§3). So the true kill list is well short of 37 — but every one of the 37
needs looking at, and only 12 of them name `vehicle_identifier` directly,
which means the dependency is mostly implicit and will not fall out of a
grep.

---

## 2. Hard-coded Denver, by file

The city axis in this repo is small and mechanical. It is the identity axis
(§3) that costs.

| Where | What | Fix |
|---|---|---|
| `config.ts:6` | `DENVER_BOUNDS` — the fit/max bbox | per-city bounds |
| `config.ts:15` | `BASEMAP_PMTILES_URL` → `denver.pmtiles` on R2 | per-city archive |
| `config.ts:25` | `COMPLIANCE_THRESHOLD = 30` (RFP §3.0) | **must not exist for Atlanta** — see §4 |
| `config.ts:51,82,88,99` | `OVERLAYS`, `EQUITY_AREA_OVERLAY`, `RETIRED_OVERLAYS`, `EQUITY_RANK_NUMBERS` | per-city overlay set; Atlanta has no `er1..er6` analogue |
| `config.ts:150,159,164,233,274` | `VEO_ADJUST_TOKEN`, `VEO_GBFS_FREE_BIKE_STATUS_URL`, `veoDeepLink`, `VEO_ZENDESK_PARKING`, `veoParkingReportUrl` | per-provider; **none has a Bird or Lime equivalent** (§5) |
| `config.ts:352,392,414` | `RATE_PLANS`, `EQUITY_AREA_RATE`, `COMPARATOR` | server-side per parent §7e; Atlanta has **no citable prices at all** |
| `theme.ts:21-23` | `DENVER_LAT/LNG/TZ`, used for sun-sync sunrise/sunset and for "today" | per-city lat/lng/tz |
| `map.ts:104,120` | `bounds` / `maxBounds` from `DENVER_BOUNDS` | follows config |
| `api.ts:11` | `API_BASE = https://data.scooter.fyi` | unchanged — one API, `?city=` per parent §2 |
| `scripts/build-basemap.sh` | `BBOX`, output filename | already parameterised; a 2-line change |

`theme.ts` is worth calling out because it is the least obvious: the
light/dark sun-sync toggle fetches sunrise/sunset for Denver's coordinates
and the "is the cache stale" check formats today's date in
`America/Denver`. An Atlanta build inheriting it would flip to dark mode on
Denver's schedule, two hours late, and cache-bust at the wrong midnight.

`gbfs.ts` — the client-side plate resolver — is **deleted, not ported.** It
exists because Veo embeds the plate in `rental_uris`, and neither Atlanta
operator publishes `rental_uris` at all. There is no plate to resolve.
(Lime's feed is also CORS-closed, so even a different use of it would not
work from the browser; Bird's is open.)

---

## 3. Ride mode mostly survives — via the off-feed path

The API has two ride mechanisms and only one of them needs identity:
`tracked-rides` (server-detected against a GBFS vehicle) and `rides`
(off-feed, where the rider describes the vehicle). See
`ATLANTA_PLAN.md` §2b. Atlanta gets the second.

So destination search, route selection, the nav HUD, the trail, track
donation and verification, distance, and export all work. What changes is
the **entry point**: the ride wizard's vehicle-selection step
(`ride-screen-select.ts`, which is built around picking a device off the
map by `vehicle_identifier`) has to become the off-feed describe-your-
vehicle form instead. That is the single largest frontend change in this
doc that is not a deletion.

The gap to close is server-side and named in `ATLANTA_PLAN.md` §2b: off-feed
rides currently award **no points**. Until that lands, an Atlanta rider
finishes a ride and their ledger does not move, which makes the whole
progression/lexicon/royalty layer inert. That is an API change, not a
frontend one, but it is the thing that decides whether shipping Atlanta's
ride mode is worth doing at all.

---

## 4. The compliance surfaces must not ship to Atlanta

`COMPLIANCE_THRESHOLD = 30` is a term in Veo's Denver contract. Atlanta has
a genuine equity layer (Communities of Concern, Tier 1/2 — see
`ATLANTA_PLAN.md` §3c) but **no known operator obligation attached to it**,
and whether ATLDOT's shared-mobility permit imposes one is not answerable
from open data.

So Atlanta may render *distribution* — measured on 2026-08-29, 10.3% of
Lime's in-city fleet and 1.2% of Bird's sat in a Community of Concern,
against COCs being 16.6% of the city's land area (`ATLANTA_PLAN.md` §3c-i)
— and must not render a gauge against a threshold, a pass/fail, a
compliance calendar, or the word "compliance". Whatever denominator such a
screen uses has to be named on the screen. Concretely:
`compliance.ts`, `compliance-calendar.ts`, and the SLA gauge are Denver-only
surfaces, and `equity-areas.ts` / `equity-map.ts` need a mode that shows a
share without scoring it.

This is not caution for its own sake. Inventing a threshold so the gauge has
something to point at would put an uncitable number on the most
credibility-sensitive screen in the product — the same failure
`MULTI_TENANCY_PLAN.md` §8b documents for pricing.

---

## 4a. Dwell degrades per operator, not per city

`ATLANTA_PLAN.md` §2c revises the obvious reading: dwell is not lost with
the vehicle id. Lime supports a real per-vehicle dwell clock (epoch-scoped
`bike_id`, position-stitched across the rare boundary, 95.4% unambiguous at
2 m); Bird supports location-level dwell only, because it re-mints every
cycle.

The frontend consequence is that the dwell/freshness affordances must key
off a **per-operator** capability, not a per-city one. A single
`stable_vehicle_id` boolean hung on the city would either black out dwell
for Lime, which works, or promise it for Bird, which does not. This is the
one place in the Atlanta build where two operators in the same city
genuinely disagree about what the UI can show, and the components that
render dwell (`freshness.ts` and the device popups) need to take the
capability as an argument rather than reading it once at boot.

## 5. Things with no Atlanta equivalent, that will be missed

- **"Unlock in Veo"** (`veoDeepLink`) — Bird and Lime publish only
  app-level `rental_apps` deep links, nothing per-vehicle. The button can
  open the operator's app; it cannot open *that scooter*.
- **Parking reports to the operator** (`VEO_ZENDESK_PARKING`) — a Veo
  Zendesk form, with no counterpart. A rider can still report to us; we
  have nowhere to forward it.
- **The plate** — riders cannot self-identify the vehicle they are standing
  at, which also removes the reassurance step from every report flow.
- **Cost** — no prices exist in either feed (`ATLANTA_PLAN.md` §3d), so the
  cost HUD and ride-cost estimate render nothing.

Each is a capability flag in the parent plan's §7a table. The point of
declaring them is that the UI can say *why* something is missing instead of
rendering an empty box, and none of these should be inferred from a null
field.

---

## 6. What is genuinely easy

- **The basemap.** `scripts/build-basemap.sh` already takes a bbox and
  produces a 21 MiB PMTiles extract under the Pages 25 MiB limit. Atlanta
  is a bbox, a filename, and an R2 upload.
- **The Pages project.** Static, no Functions, no bindings —
  `wrangler.toml` is 4 lines.
- **The API client.** One API with `?city=` (parent §2 step A) means
  `api.ts` needs a scope parameter threaded through, not a rewrite. The
  `_denver`-suffixed response fields (`api.ts:171,194`) rename with the
  server's `_citywide` change.
- **Colors, clusters, freshness, the map shell.** Nothing city-specific.

---

## 7. Recommendation

Do not start this repo's Atlanta work until three things in
`ATLANTA_PLAN.md` §6 are settled — the Lime identity question, the ATLDOT
permit, and the routing-graph measurement. All three change what gets
built here, two of them are reading, and the third is a script.

The one piece worth doing early is unrelated to Atlanta: make the ride
wizard's off-feed path a first-class entry point rather than a fallback.
Denver riders on a competitor's scooter need it today, and it is the
mechanism Atlanta's entire ride mode would sit on.
