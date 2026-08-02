# Multi-city frontend plan

Status: **proposal**, nothing here is built. Companion doc:
`scooter-fyi-api/MULTI_TENANCY_PLAN.md`, which covers the API side and the
provider-adapter model.

This answers one question: how do we run `denver.scooter.fyi`,
`<somewhere-else>.scooter.fyi`, and possibly a differently-branded site,
without three copies of 45k lines of TypeScript drifting apart?

---

## 1. Recommendation up front: don't fork

The stated plan is one frontend instance per city, forked from this repo,
pulling upstream changes regularly. I'd push back on the *fork* half while
keeping the *instance* half.

**One repo, N deploys.** Cloudflare Pages Direct Upload already happens in
CI (`.github/workflows/deploy.yml`), and turning it into a per-city matrix
is about twenty lines of YAML:

```yaml
strategy:
  matrix:
    city: [denver, boulder]
steps:
  - run: npm run build
    env:
      VITE_CITY: ${{ matrix.city }}
      VITE_GOOGLE_CLIENT_ID: ${{ secrets.VITE_GOOGLE_CLIENT_ID }}
  - uses: cloudflare/wrangler-action@v3
    with:
      command: pages deploy dist --project-name=${{ matrix.city }}-scooter-fyi
```

You still get one Pages project, one domain, one deploy pipeline and one
rollback story *per city* — which is what "different frontend instances"
actually buys. What you don't get is N repos to patch when a bug lands.

**Why forking is worse here specifically:**

- The files a city needs to customize (`config.ts`, `theme.ts`, `index.html`,
  `map.ts`) are exactly the files that also receive ordinary feature work. A
  fork's merges conflict in precisely those files, every time, forever.
- `npm test` is ~50% of `src/` by line count. A fork inherits and must
  maintain all of it, or it silently rots.
- Security and API-contract fixes have to land N times. `api.ts` is 1,524
  lines tracking a 3,194-line contract that will change during this project.
- Merge debt is invisible until it isn't. Three months of "we'll rebase
  later" and the fork is a rewrite.

**The one legitimate reason to fork** is product divergence, not code
reuse: a site with a different name, a different campaign, and a different
audience — `keepdenverfair.com` is the existing example. That's a
deliberate product decision. Even then, do the extraction in §3 *first*, so
the fork's delta is a config file and some copy, not a diff across 90 files.

If you fork anyway, §6 has the discipline that makes it survivable.

---

## 2. Where Denver and Veo are baked in

Measured against `main`:

| Kind | Count | Where |
|---|---|---|
| `Denver` refs in `src/*.ts` | ~70 across 23 files | mostly `theme.ts` (16), `config.ts` (7), `api.ts` (7), `util.ts` (5), `clusters.ts` (5) |
| `Veo` refs in `src/*.ts` | ~230 across 30 files | `devices.ts` (43), `config.ts` (42), then the whole `ride-*` family |
| `index.html` | 6 Denver / 8 Veo | title, meta, OG tags, no-FOUC script, visible copy |

Concretely, the hardcoded things:

**Geography**
- `config.ts:DENVER_BOUNDS` — the fit-on-load box
- `config.ts:BASEMAP_PMTILES_URL` — a Denver-only pmtiles archive on R2
- `map.ts:106` — `[-105.6, 39.25]` max-bounds corner
- `clusters.ts:16` — `DENVER_LAT_RAD`, used for the lat-scaled cluster radius
- `theme.ts` — `DENVER_LAT/LNG/TZ`, the sun-sync sunrise/sunset source
- `ride-screen-routes.ts:903` — `[-104.9903, 39.7392]` map center

**Denver policy/taxonomy**
- `config.ts:OVERLAYS` — the five boundary overlays with their exact labels
  ("Disadvantaged Areas (v1)", "City Council Districts", …). Denver's DOTI
  taxonomy, meaningless elsewhere.
- `config.ts:EQUITY_RANK_*` — er1..er6, likewise
- `config.ts:COMPLIANCE_THRESHOLD = 30` — Denver RFP §3.0
- `api.ts:BoundaryLayer` — a closed union type of Denver's layer names

**Veo**
- `config.ts:VEO_ADJUST_TOKEN`, `veoDeepLink()` — the app deep link
- `config.ts:VEO_GBFS_FREE_BIKE_STATUS_URL`, `gbfs.ts` — client-side plate
  resolution straight from Veo's CORS-open feed
- `config.ts:VEO_ZENDESK_PARKING`, `veoParkingReportUrl()` — Veo's
  improperly-parked ticket form, with instance-specific field ids
- `config.ts:RATE_PLANS`, `COMPARATOR` — Veo Denver pricing, in the client
- the entire `ride-*` screen family's copy

**Deployment**
- `wrangler.toml:name`, `vite.config.ts`'s dev-proxy Origin header,
  `API_BASE`, `ADMIN_EMAILS`

---

## 3. The extraction

### 3a. `src/city/` — build-time config

```ts
// src/city/types.ts
export interface CityConfig {
  slug: string;                    // 'denver' — the API's ?city= value
  displayName: string;             // 'Denver'
  timezone: string;                // 'America/Denver'
  bounds: LngLatBoundsLike;        // fit-on-load
  maxBounds: LngLatBoundsLike;
  center: [number, number];
  basemapPmtilesUrl: string;
  origin: string;                  // 'https://denver.scooter.fyi'
  /** Optional per-city compliance framing; absent = no compliance UI. */
  compliance?: { threshold: number; label: string };
}
```

One file per city, selected at build time:

```ts
// src/city/index.ts
import denver from "./denver.ts";
import boulder from "./boulder.ts";
const CITIES = { denver, boulder } as const;
export const CITY: CityConfig = CITIES[import.meta.env.VITE_CITY ?? "denver"];
```

Vite tree-shakes the unselected cities out of the bundle, so this costs
nothing at runtime. Everything in §2's "Geography" list becomes `CITY.*`.

### 3b. What should come from the API instead

Some of it shouldn't be in the frontend at all, because two sources of truth
is how Denver's pricing and the server's pricing drift apart:

| Today | Should be |
|---|---|
| `OVERLAYS` hardcoded | derived from `GET /api/v1/boundaries?city=` (already returns layers + feature counts + bbox); city config supplies only the colors |
| `BoundaryLayer` closed union | `string`, validated against the boundaries response |
| `RATE_PLANS` / `COMPARATOR` | `GET /api/v1/meta/pricing?city=&provider=` (see the API plan §7c) |
| `COMPLIANCE_THRESHOLD` | the compliance payload, or omitted entirely for cities with no SLA |
| Veo deep link / QR / parking-report URL | a provider descriptor from the API, so a new provider is a server-side row |

This is the part that makes the fork question moot: once overlays, pricing
and provider behavior arrive over the wire, a "city" is a config file and a
domain.

### 3c. Provider capabilities drive the UI

The API plan proposes `GET /api/v1/meta/capabilities?city=&provider=`
(§7a there). The frontend's job is to render against it rather than assume
Veo:

- no `stable_vehicle_id` → hide reliability tiers, dwell text, ride
  tracking, per-device photos/reports/QR. This is most of `devices.ts`'s
  popup and the whole `ride-*` flow.
- no `deep_link` → hide "Unlock in <provider>"
- no `known_pricing` → hide the cost HUD and the ride-cost estimate
- no `plate_visible` → skip the `gbfs.ts` plate index entirely

Practically: introduce a `Provider` object threaded through the device popup
and ride wizard, and replace literal "Veo" strings with
`provider.displayName`. `RIDE_MODE_OVERHAUL_PLAN.md` already writes its copy
as `${provider}` — that intent just needs following through into the code.

`gbfs.ts` deserves its own decision. It works only because Veo's feed is
CORS-open; other providers likely aren't, and routing it through our API
would put plates back into our own responses, which is exactly what
`identity.py`'s privacy model avoids. Treat "client-side plate resolution"
as a per-provider capability that is off by default.

### 3d. `index.html`

Title, meta description, OG tags, the no-FOUC theme script (which mirrors
`theme.ts` and must stay identical), and visible copy all name Denver and
Veo. Use Vite's `transformIndexHtml` hook to substitute from `CITY` at build
time rather than maintaining N HTML files.

---

## 4. What Denver's build must prove

Phase 3 of the API plan is "frontend de-Denverization", and its acceptance
test is simple: **`VITE_CITY=denver npm run build` produces a
byte-comparable bundle to today's**, modulo the config indirection. If
Denver's output changes, the extraction changed behavior, and that should be
caught before a second city exists to hide it.

Keep `npm test` green throughout — the suites stub `fetch` and web storage,
so they're unaffected by city config as long as it's injected rather than
imported at module scope in test-visible paths.

`npm run vectors:check` guards `tests/fixtures/track-chain-vectors.json`, a
byte-identical cross-repo contract with the API's `track_verify` tests.
Nothing here touches it — don't let a refactor drift it.

---

## 5. Sequencing

| Phase | Work | Depends on |
|---|---|---|
| **F1** | `src/city/` + `CityConfig`; move geography out of `config.ts`/`theme.ts`/`map.ts`/`clusters.ts`; templated `index.html`. Denver-only, byte-comparable output. | — |
| **F2** | Overlays from `/api/v1/boundaries`; `BoundaryLayer` opened up; compliance UI made optional | API phase 1 (`?city=`) |
| **F3** | `Provider` descriptor + capability gating; pricing from the API; `${provider}` copy throughout; `gbfs.ts` behind a capability | API phase 2 |
| **F4** | CI matrix over cities; per-city Pages project + domain; per-city CORS + magic-link origin | API phases 1–2 |
| **F5** | City #2 assets: pmtiles basemap archive on R2, boundary data, verification pass | API phase 4 |

F1 is worth doing on its own even if the whole multi-city idea stalls — it
removes the hardcoded geography that makes every other change awkward.

---

## 6. If you fork anyway

Do §3 first regardless — a fork whose delta spans 90 files is not
maintainable no matter how disciplined you are. Once the delta is
`src/city/<city>.ts` + assets + `wrangler.toml`:

```bash
git remote add upstream https://github.com/z280/denver-scooter-fyi
git fetch upstream && git merge upstream/main     # should be conflict-free
```

Rules that keep it that way:

1. **Never edit a shared file in the fork.** If a change is needed in
   `devices.ts`, make it upstream (behind a capability or config flag) and
   merge it down. A one-line local patch is how the drift starts.
2. **Merge on a schedule**, weekly, not "when we need something". Small
   merges stay conflict-free; three-month merges don't.
3. **Fix forward in upstream only.** The fork has no independent history
   worth preserving.
4. **CI on the fork runs the full upstream suite.** If a merge breaks
   Denver's tests in the fork, that's the signal.

At which point, note, the fork is doing nothing the CI matrix wouldn't —
which is the argument for §1.
