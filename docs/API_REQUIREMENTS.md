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

### 2.3 Magic-link sign-in (Postmark)

- `POST /api/v1/auth/magic-link` with `{ email }` → always returns 202
  (no account-existence oracle). Issues a single-use token, 15-minute TTL,
  stored hashed; sends via the existing Postmark transactional account
  with a link like `https://denver.scooter.fyi/auth?ml=<token>`.
- `POST /api/v1/auth/redeem` with `{ token }` → verifies single-use +
  TTL, upserts account by email, mints a session, burns the token.
- **Magic-link sessions never carry the `admin` scope**, even for
  allowlisted emails — admin requires the Google door. One trust decision,
  enforced server-side.
- Rate limits: 3 links/hour per email, 10/hour per IP. Postmark send
  failures surface as 502 with a friendly detail.

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

### 3.1 Device failure reports

- `POST /api/v1/reports/device` with
  `{ vehicle_identifier, report_type: "failed_unlock" | "dead_battery" | "damaged", observed_at?, lat?, lng? }`.
- Anonymous allowed (tight limits: 5/day per IP); authenticated reports
  are linked to the account and weighted higher in aggregates.
- Idempotency: dedupe identical (vehicle, type, reporter) within 30 min.
- **Feedback loop:** reports feed the §1.2 `reliability_tier` inputs and
  `has_negative_report`.

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

### 4.1 Stripe webhook

- `POST /webhooks/stripe` — verify the Stripe signature; handle
  `checkout.session.completed` (Payment Link, pay-what-you-want): read
  `client_reference_id` (account id), set `supporter: true`, store amount
  + timestamp. Handle refund events by clearing the flag only on full
  refund.
- No other Stripe surface needed — no products API, no customer portal in
  v1.

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
