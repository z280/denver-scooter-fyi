# API Requirements — data.scooter.fyi backend

Requirements for the API repo (currently `veo-audit`, proposed rename
`scooter-fyi-api`) to unblock the frontend phases in
[UX_PLAN.md](./UX_PLAN.md). Written to be lifted into that repo verbatim.
Grouped by the frontend phase each item unblocks; items within a group are
ordered by dependency.

Conventions used below: all endpoints are JSON over HTTPS under `/api/v1/`;
authenticated endpoints take `Authorization: Bearer <token>`; errors follow
the existing `{detail}` shape; CORS allowlist stays production-origins-only
(`denver.scooter.fyi`, plus the Vite dev proxy path as today).

---

## 1. Field promotions (unblocks frontend Phase 2 — read-only)

### 1.1 Keep `vehicle_plate` authenticated-only (REVERSED — do NOT promote)

An earlier draft asked to expose `vehicle_plate` publicly for the "Unlock
in Veo" deep link. **That is withdrawn.** Publishing every live plate is a
gift to Veo: they could scrape our map and reconcile it against their own
GBFS feed, and it hands the whole audit's raw identifiers to the operator
we're auditing. Plates stay on the authenticated endpoint only.

Consequences, already reflected in the frontend:
- The unlock button is gated to signed-in users **and** requires an active
  location fix within ~75 m of the scooter. Unlocking is a
  standing-at-the-scooter action, so this loses nothing real while removing
  the couch-scraping vector entirely.
- No API change is needed here beyond *not* promoting the field.
- **Verification task (unchanged):** scan one scooter's QR on-device and
  confirm its `number` query param equals our stored `vehicle_plate`, so the
  authenticated unlock link resolves to the right vehicle.

### 1.2 Public reliability signal

> **Semantics confirmed with the API team (2026-07-06)** — the earlier
> "calibration bug" read was wrong. Quality and reliability answer
> different questions by design (veo-audit `src/quality.py`, locked by
> `tests/test_quality.py`):
>
> - `quality_designation` (`N/A → poor → acceptable → good → great`):
>   baseline from battery range, minus demerits (1 failed start −1;
>   dwell ≥24h −2, ≥12h −1, or ≥6 daylight hours −1); hard `poor` on a
>   live negative report or >1 failed start; `N/A` = disabled/reserved/
>   rangeless.
> - `reliability_tier` collapses only the FAILURE signals ("will it
>   unlock?"), first-match-wins: `high_risk` on a live negative report,
>   ≥2 failed starts, 1 failed start + ≥24h dwell, or ≥96h clean dwell
>   (ghost); `unknown` when never state-tracked or quality is N/A;
>   else `ok` — including a single fresh failed start (a lone bike_id
>   rotation could be a rebalancer scan).
>
> The frontend mirrors this formula exactly for its fallback tier and its
> human-readable reasons. The client's interim 48–96h caution band was
> removed once §1.4 shipped (2026-07-08): the server's recalibrated 72h
> ghost rule + peer-outlier demotion now cover that gap, so server and
> client agree again. Remaining ask: document the quality scale + tier
> formula in API.md so the contract is public.

Preferred: compute server-side and expose a single field on the public
devices endpoint:

- `reliability_tier: "ok" | "unknown" | "high_risk"` (or 0/1/2), derived
  from: `number_failed_starts` (recent window), dwell time from
  `first_observed_at_location`, `quality_designation`,
  `has_negative_report`, and (once §4 ships) crowdsourced reports.
- Also expose the raw inputs publicly if there's no objection:
  `number_failed_starts`, `first_observed_at_location`. The frontend can
  then explain the tier ("idle 4 days · 2 failed starts") instead of
  showing an opaque grade.
- Document the tier formula in the repo so the audit stays reproducible.

### 1.4 Dwell recalibration + peer-relative outliers (SHIPPED — veo-audit PR #19)

> **Status 2026-07-08:** live server-side, exactly as specified below —
> r9-kRing(1) peer set, ≥p90 + ≥3× median + 24h floor outlier rule, ghost
> tightened 96h → 72h, dwell-outlier + ≥48h → `high_risk`, and the public
> evidence fields `dwell_percentile_hood` / `dwell_peer_median_hours`. The
> frontend mirrors the recalibrated formula (src/reliability.ts) and has
> dropped its interim 48–96h caution band as promised.

Current dwell handling is too lenient. Production evidence (2026-07-06
snapshot, 8,449 devices): citywide dwell p50=7.2h, p90=48h, p95=76h — a
device idle 48h is a top-decile outlier, yet 520 devices idle ≥48h carried
`reliability_tier: ok` because the ghost rule waits for 96h (~p97).

1. **Peer set:** the device's h3 r9 cell plus its 6 neighbors
   (`gridDisk(r9, 1)`) — the same ~0.74 km² as an r8 cell but centered on
   the device, so edge-parked scooters aren't judged against the wrong
   side of a fixed hex. On today's data: 98% of devices get ≥5 peers (vs
   70% bare-r9 / 97% r8) and ~750 outliers flag, ~480 currently tier=ok.
   <5 peers → expand to `gridDisk(r9, 2)`, then citywide. Plain r8 is an
   acceptable fallback implementation (97% coverage, near-identical
   counts) — kRing just removes the grid-boundary lottery.
2. **Outlier definition:** dwell percentile ≥ 0.90 among ≥5 peers AND
   dwell ≥ 3× peer median AND dwell ≥ 24h (absolute floor so
   high-turnover blocks can't flag healthy scooters).
3. **Use in both rankings:** quality −1 demerit for dwell-outliers;
   reliability ghost rule tightened 96h → 72h (flags 409 vs 234 today),
   plus dwell-outlier AND ≥48h → `high_risk`. Keep the report/
   failed-start rules and one-fresh-failed-start leniency unchanged.
4. **Expose the evidence:** `dwell_percentile_hood` (0–100, null when <5
   peers after fallbacks) and `dwell_peer_median_hours`, so the frontend
   can explain verdicts ("idle 31h — 5× its block's typical 6h").
5. Compute at query time, lock in tests (sparse fallback, 24h floor,
   busy-cell outlier, slow-cell non-flag, 72h boundary), document in
   API.md. The frontend mirrors the tier formula and will drop its
   interim 48–96h client-side caution band once this ships.

### 1.5 Payload diet — carry low-end phones (SHIPPED)

> **Status 2026-07-08:** live — server `battery_percent`, lean default
> payload with `?include=h3,ranks` opt-ins (unknown tokens 400). The
> frontend requests the includes only on the analysis surface and goes
> lean in ride mode. Additionally, veo-audit PR #19 replaces the retired
> `/api/v1/private/devices/current` with `GET /api/v1/user/devices/current`
> (any signed-in rider gets the public field set; ADMIN_EMAILS sessions —
> via either sign-in door — additionally get `vehicle_plate`,
> `first_ever_observed_at`, `max_observed_range_meters/_at`; same query
> params; `Cache-Control: private, max-age=30`). The map's authed fetch
> now targets it, falling back to the public endpoint until it deploys.

`/api/v1/devices/current` is ~8 MB of JSON every 90 s. Fine on a laptop;
hostile to budget Androids. The frontend also client-computes things the
server already knows. Requests:

1. **Server-computed `battery_percent`** (0–100 int, null when unknown),
   derived against per-type max range — replaces the frontend's
   derive-max-from-fleet approximation and is a step toward dropping
   `current_range_meters` + the rank fields from the default payload.
2. **Lean default field set** via `?include=` opt-ins: by default DROP the
   seven `range_rank_*` / `range_percentile_by_type` fields (analysis
   modal requests them with `?include=ranks`) and the three `h3_*_index`
   fields once §1.6 ships (`?include=h3`). Estimated ~35–40% payload cut
   before compression.
3. **Transport:** confirm brotli/gzip on the CDN for this route; serve an
   `ETag` per cycle_id so unchanged 90-s polls 304 out.
4. Optional, later: a server-side equity estimate endpoint
   (`GET /api/v1/equity-estimate?ranks=1,2` → % + counts) so low-end
   clients can skip the 8k-point point-in-polygon pass.

### 1.6 H3 aggregate layers (SHIPPED — frontend UI pending)

> **Status 2026-07-08:** `GET /api/v1/h3/aggregates?res=8|9|10` is live
> with the exact cell metrics below (string-keyed cells, 10-min CDN
> cache). The Areas-menu choropleth UI that consumes it is the next
> frontend work item.

`GET /api/v1/h3/aggregates?res=8|9|10` → per-occupied-cell metrics,
computed once per 10-minute cycle and CDN-cached (~10 min):

```
{ "res": 9, "cycle_id": "…", "snapshot_time": "…",
  "cells": { "<h3 index as string>": {
      "device_count": 14,
      "trips_started_24h": 31,        // bike_id rotation + movement = a start
      "starts_per_hour_peak": 4,      // max hourly rate in the window
      "avg_battery_percent": 62,
      "risk_share": 0.21,             // fraction high_risk
      "avg_dwell_hours": 9.4
  }, … } }
```

- Start counting: a successful start = the state tracker seeing a device
  leave its spot (the same movement that resets dwell); failed starts are
  already counted separately. Trailing-24h window, per cell.
- Cell ids as STRINGS (the raw-integer h3 indexes already force the
  frontend to re-quote them before JSON.parse — please string-encode here
  from day one).
- Frontend renders these as choropleth hex layers in the Areas menu
  (density / usage / battery / reliability at r8/r9/r10) and retires its
  client-side per-refresh hex aggregation over 8k points.

### 1.3 Equity-rank boundaries `er1`–`er6` (DONE — live & verified)

The city delivered a ranked equity map but did **not** say which ranks bind
the SLA. The API now serves `GET /api/v1/boundaries/er1` … `/er6` in the same
`BoundaryResponse` shape as the other layers — **live in production and
verified end-to-end** (er1: 34 features … er3: 157 … er6: 116; region names
`ER1_0803100…`). The frontend lets users pick which ranks to estimate against
(default 1 + 2), draws the selected union as an "Equity Ranking (Selected)"
overlay, and computes a live in-app "% of devices in selected ranks" figure
client-side (point-in-polygon over the current fleet). Sanity check against
live data: ranks 1+2 ≈ 21% of the fleet, all six ranks = 100% (they tile the
city). No further API work is required unless we later want a server-side
historical SLA-style average for a chosen rank set — deferred until the city
specifies the binding ranks.

---

## 2. Accounts & sessions (unblocks frontend Phase 3)

Two sign-in doors, one session model. The map stays fully usable
anonymously; accounts exist for the cost ticker's rate choice, report
attribution, and supporter features.

### 2.1 Session model

- Opaque bearer tokens (random ≥128-bit), stored **hashed** at rest, with
  scopes: `rider` (default), `admin`, `supporter` (derived, see §5).
- Rider sessions: long-lived — 30-day sliding expiry via
  `POST /api/v1/auth/refresh` (returns a rotated token + new expiry;
  invalidate the old token). Nobody re-logs-in on a street corner.
- Admin sessions: same mechanics, shorter fixed expiry (24 h, no sliding).
- Response shape stays compatible with what the frontend's `map-auth`
  plumbing already stores: `{ token, expires }` (ISO timestamp).
- `GET /api/v1/auth/session` → `{ email, scopes, supporter, expires }` for
  UI state; 401 when invalid/expired.
- `POST /api/v1/auth/signout` → revoke the presented token.

### 2.2 Google sign-in

- `POST /api/v1/auth/google` with `{ credential }` (a Google ID token from
  Google Identity Services / One Tap).
- Verify locally against Google's JWKS (cache keys; no per-request Google
  API call): signature, `aud` = our OAuth client id, `iss`, `exp`, and
  **require `email_verified: true`**.
- Upsert the account by email; mint a session.
- **Admin allowlist:** env `ADMIN_EMAILS` (comma-separated; initial value
  `zneill@gmail.com`). If the verified email is on the list, the session
  gets the `admin` scope. Admin gates everything the private GitHub gate
  gates today (plates history, failed-start details, future admin
  endpoints).

### 2.3 Email sign-in — magic link + verification code (Postmark)

Two **independent** doors on the same email, each with its own request and
its own email (this mirrors the implemented `z280/veo-audit` backend — see
its `API.md`). The frontend offers both from the Account drawer.

- `GET /api/v1/auth/config` → `{ google_client_id, google_enabled,
  magic_link_enabled, code_enabled }` (public, cacheable). The single source
  of truth for which doors to render and the GIS client id to init with.
- **Link door**
  - `POST /api/v1/auth/magic-link` with `{ email }` → always `202
    { sent: true }` (no account-existence oracle). Emails a single-use link
    `https://denver.scooter.fyi/auth?ml=<token>`, 15-minute TTL, stored
    hashed. `502` if the sender fails, `503` if Postmark is unconfigured.
  - `POST /api/v1/auth/redeem` with `{ token }` → `{ token, expires }`.
    Single-use; `401` if invalid/expired/already-used.
- **Code door** (separate email from the link)
  - `POST /api/v1/auth/code` with `{ email }` → always `202 { sent: true }`.
    Emails a short **`AA000AA`** code (2 letters, 3 digits, 2 letters;
    letters exclude I/O), 10-minute TTL, stored hashed. Only the newest code
    per email stays live.
  - `POST /api/v1/auth/code/verify` with `{ email, code }` → `{ token,
    expires }`. Case-insensitive; spaces/hyphens ignored. `401` if wrong,
    expired, used, or after too many wrong tries (5 — which burns the code).
    Verify attempts rate-limited 30/hour per IP.
- **Email-sign-in sessions never carry the `admin` scope** (neither door),
  even for allowlisted emails — the `admin` scope is a Google-only signal,
  set server-side in `session_scopes()`.
- Rate limits (each door): 3 sends/hour per email, 10/hour per IP. Postmark
  send failures surface as 502 with a friendly detail.

> **Frontend status:** The Google door is driven entirely by `GET
> /api/v1/auth/config` (`auth-config.ts`) — the single source of truth. It
> renders only when the backend reports `google_enabled: true` with a client
> id, and initializes GIS from that id; there is no frontend Google flag to
> drift from the server. Today the backend keeps Google off
> (`GOOGLE_AUTH_ENABLED=false` on veo-audit), so email sign-in (typed code by
> default, magic link as the alternate) is the only offered path. Re-enabling
> Google is a backend-only change.

### 2.4 Profile

- `GET /api/v1/profile` / `PUT /api/v1/profile` (scope: `rider`).
- Fields (client-writable): `rate_plan: "resident" | "visitor" | "equity"`,
  `theme: string | null`, `favorites: []` (opaque JSON array for now —
  shape lands with the favorite-device-types spec).
- Fields (server-computed, read-only): `supporter: boolean`,
  `badges: [{ id, label, earned_at }]` (see §5.3).

### 2.5 Retirements

- Once Google + magic links are live and the admin allowlist works,
  retire the GitHub OAuth app and its callback route. The frontend removes
  its hidden-tab gate in the same release.

---

## 3. Report ingestion (unblocks frontend Phase 4)

### 3.1 Device failure reports (DONE — live & wired)

- `POST /api/v1/reports/device` — **live**. Body:
  `{ vehicle_identifier (≥16 chars), report_type: "failed_unlock" | "dead_battery" | "damaged", report_lat?, report_lon? }`
  → `200 { id, reported_at, deduped }`. The frontend surfaces one-tap chips
  in the device popup (shown when `vehicle_identifier` is present) and posts
  here with the device coordinates; a bearer token rides along when signed in.
- **Deprecated:** the bare `POST /api/v1/reports` (the old
  `report_lat`/`report_lon` generic form) is no longer used by the frontend —
  everything goes through the typed `/reports/device`.
- **Feedback loop:** reports feed the §1.2 `reliability_tier` inputs and
  `has_negative_report`.

### 3.1a Model reports (consumed by frontend now)

- `POST /api/v1/reports/model` — multipart form: `device_id`,
  `vehicle_identifier?`, `description`, optional `photo` (image), `lng?`,
  `lat?`. Fired from the device popup when the vehicle's `vehicle_model_name`
  isn't one we recognize ("Veo Unknown → Tell us!"). Anonymous allowed
  (rate-limited); bearer token attached when the user is signed in.
- Store the photo in R2 (strip EXIF); the description + coordinates feed a
  review queue so unrecognized models can be named / the model catalog
  corrected. The frontend already posts here and shows an inline
  success/error state, so it activates the moment this lands.

### 3.2 Missed-discount reports

- `POST /api/v1/reports/discount` with
  `{ ride_ended_at, zone_version: "v1" | "v2", end_lat?, end_lng?, amount_charged_cents? }`
  plus optional multipart `receipt` image.
- Receipt images → R2, private bucket; **strip EXIF** on ingest; retention
  policy documented (suggest 18 months); requires a signed-in session
  (evidence needs provenance).

### 3.3 Aggregates & export

- `GET /api/v1/reports/summary?layer=<boundary>` →
  `{ regions: { [region_name]: { device_reports, discount_reports, est_overcharge_cents } } }`
  — powers the "Contract violations" choropleth and the ticker. Public,
  CDN-cacheable (~10 min).
- `GET /api/v1/reports/export/monthly.csv?month=YYYY-MM` — public CSV for
  DOTI/journalists. No auth, rate-limited.

---

## 4. Supporter tier (unblocks frontend Phase 5)

### 4.1 Stripe (UPDATED 2026-07-21: decommercialized — donations only, 90-day supporter of record)

The tiered premium/subscription framing is retired. There is ONE status:

- **⭐ `supporter`** — "supporter of record": true for **90 days from the
  last received donation**, whether that donation was one-time or a
  recurring donation's payment. Another donation of either kind extends
  the window (last_donation_at + 90d). Bonus features are a thank-you;
  nothing in the app is paywalled.

Endpoints (auth: any signed-in session; both → `{ url }`; both are
framed to the user as DONATIONS):

- `POST /api/v1/billing/donate` — Checkout Session `mode=payment` against
  the one-time price (dashboard: enable "customer chooses amount"),
  `client_reference_id` = account id, success/cancel URLs back to
  `https://denver.scooter.fyi/`.
- `POST /api/v1/billing/checkout` — Checkout Session `mode=subscription`
  against the recurring monthly-donation price, same reference + return
  URLs. Drop any trial framing — a trial period would delay the first
  *received* donation and therefore supporter status.
- **The frontend Account drawer already calls both** ("💛 Donate once" /
  "🔁 Donate monthly") and degrades each to a friendly "not live yet"
  note until it ships. Both doors stay visible to current supporters —
  donating again extends the window.

Webhook `POST /webhooks/stripe` — verify the signature. A "received
donation" is:

- `checkout.session.completed` with `mode=payment` (one-time), or
- `invoice.paid` for the recurring donation (each billing cycle's payment
  counts as a fresh donation).

On either event set `last_donation_at = now`; `supporter` is derived as
`now < last_donation_at + 90d`. No revocation handling needed beyond the
window lapsing — cancel/unpaid on the recurring donation simply stops new
donations from arriving.

`GET /api/v1/auth/session` exposes:

- `supporter: boolean` (derived from the 90-day window), and
- `supporter_until: string` (ISO, last_donation_at + 90d) — the frontend
  shows "supporter through <date>" on the badge.
- `premium_user` is DEPRECATED: serve it as an alias of `supporter` for a
  release or two (the frontend already treats either flag as
  supporter-of-record), then drop it.

- Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`
  (recurring monthly-donation price) and `STRIPE_DONATION_PRICE_ID`
  (one-time price); register the webhook endpoint in the Stripe
  dashboard.
- No customer portal in v1 (add `POST /api/v1/billing/portal` later so
  recurring donors can self-serve cancel).

### 4.2 Ride history

- `POST /api/v1/rides` (scope `rider`, supporter required) with
  `{ started_at, ended_at, duration_s, distance_m, est_cost_cents, rate_plan, started_in_zone: bool, ended_in_zone: bool, polyline }`
  (polyline = encoded lat/lng string).
- `GET /api/v1/rides` — owner-only list, paginated.
- `GET /api/v1/rides/export?format=geojson|csv` — owner-only.
- `DELETE /api/v1/rides/:id` and `DELETE /api/v1/rides` — **hard delete**,
  immediate. Route polylines are the most sensitive data this system will
  hold; no soft-delete, no analytics reuse, and say both in the privacy
  note.

### 4.3 Badges

- Server-computed on profile read (no separate endpoint): reports filed,
  ghost scooters confirmed (report later corroborated by another user or
  API inference), discount reports, miles logged, ride streaks. Earned
  badges are available to every account — only the `supporter` badge is
  tied to payment.

---

## 5. Cross-cutting

- **Rate limiting:** per-IP and per-account buckets on all POST endpoints;
  429 with `Retry-After`.
- **Secrets/env:** `ADMIN_EMAILS`, `GOOGLE_OAUTH_CLIENT_ID`,
  `POSTMARK_TOKEN`, `STRIPE_WEBHOOK_SECRET`, R2 credentials.
- **Privacy page data:** the API should serve
  `GET /api/v1/meta/privacy` (or a static doc) enumerating retention:
  sessions (30 d idle), magic-link tokens (15 min), receipts (18 mo),
  rides (until user deletes), reports (indefinite, aggregated).
- **Repo rename:** `veo-audit` → `scooter-fyi-api` (GitHub auto-redirects
  old URLs). Keep "Veo Audit" as the public dataset/report brand.

## 6. Sequencing

| Order | Item | Unblocks frontend |
|---|---|---|
| 1 | §1.1 keep plates authed-only (no work; verify QR↔plate) | Phase 2 unlock |
| 2 | §1.2 reliability tier / raw fields | Phase 2 reliability UI |
| — | §1.3 `er1`–`er6` boundaries (already shipped) | Phase 2 equity ranks |
| 3 | §2 accounts (Google → sessions → magic link → profile) | Phase 3 cost ticker |
| 4 | §2.5 GitHub retirement | Phase 3 admin migration |
| 5 | §3 reports + aggregates | Phase 4 |
| 6 | §4 Stripe + rides + badges | Phase 5 |

Items 1–2 are read-only and deployable independently of everything else;
start there.
