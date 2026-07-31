# Frontend work plan — consuming the `scooter-fyi-api` backend

**The backend's [API.md](https://github.com/z280/scooter-fyi-api/blob/main/API.md)
is the source of truth for every endpoint, payload, error code, and rate
limit.** This file is only a work plan: what to build here, in what order,
and the handful of design constraints that shape the UI. It deliberately
does not restate request/response shapes — that duplication is what the
retired `API_REQUIREMENTS.md` turned into.

Last reconciled against the backend on 2026-07-29.

---

## ⚠️ The verification row is not gated on `sms_enabled`

Both halves of SMS shipped on 2026-07-29 — the frontend in
[#40](https://github.com/z280/denver-scooter-fyi/pull/40) (17:30 UTC) and
the backend in
[scooter-fyi-api#32](https://github.com/z280/scooter-fyi-api/pull/32)
(17:36 UTC). Both auto-deploy on merge, so both are in production.

What is *not* in production is a working SMS door, and the reason is worth
knowing because it is a supported steady state rather than a transient:

```
$ curl https://data.scooter.fyi/api/v1/auth/config
{… "code_enabled":true, "sms_enabled":false}
```

`COMMS_TOKEN` is unset on the server, and a blank token is a **documented,
supported configuration** — the backend 503s the SMS endpoints and reports
`sms_enabled:false` rather than failing. SMS can legitimately be off at any
time, for the same reason Postmark can be.

| Frontend surface | With `sms_enabled:false` | Why |
| --- | --- | --- |
| "Text me a sign-in code" door | **Hidden. Correct.** | `main.ts` renders it only under `authCfg?.smsEnabled`. |
| Account → Phone → "Verify by text" | **Shown, and 503s on press.** | The row is gated on the `phone_verified` *data field*, never on `smsEnabled`, so it offers verification whether or not the server can send anything. |

This is a live defect, not a deploy-ordering artifact: it recurs any time
SMS is switched off. The fix is one condition — gate the verification row
on `smsEnabled` as well, exactly as the sign-in door already is.

**The general rule it illustrates.** One surface is gated on a *capability
flag* and the other on a *data field*. A missing or false flag is
unambiguous ("the server can't do this"), but a `false` boolean field
describes the *record*, not the server's ability to act on it — and here
`false` is precisely the state that prompts the rider to act. Gate on the
capability; use the data field only to decide what to say once the
capability is present.

### Still to land

- **[scooter-fyi-api#33](https://github.com/z280/scooter-fyi-api/pull/33)**
  wires `COMMS_TOKEN` / `COMMS_BASE_URL` through the deploy workflow into
  the container's `.env`. Until it merges, `sms_enabled` stays false.
- **Reachability.** comms binds `127.0.0.1:8090` on the host while the API
  runs in bridge containers, so the API cannot currently reach it — verified
  by `ConnectTimeout` from `pipeline_worker` to both the tailnet URL and the
  bridge gateway. Merging #33 before that is fixed would flip
  `sms_enabled` true and turn a hidden door into a visible broken one.

## Where things stand

Verified against `scooter-fyi-api` `origin/main` and its open PRs on
2026-07-29.

**Already merged and live on the backend:**

- **Routing is deployed** (`/api/v1/route`, `graph_bbox`
  `[-105.06, 39.65, -104.88, 39.79]`), but `battery_percent_estimate` is
  `null` on every request until the regression model has enough
  observations to fit. Treat the battery number as optional garnish.
- Auth, profiles, and the report surfaces (`POST /api/v1/reports/device`,
  `/reports/summary`).
- **`POST /api/v1/reports/model` and the `not_rideable` report type.**
  Both shipped with scooter-fyi-api#27; this doc previously warned they
  were missing, and that warning is retired. The "Veo Unknown → Tell us!"
  form and the "🚫 Not rideable" chip work against `main`.

- **SMS sign-in and phone verification** (scooter-fyi-api#32, merged and
  deployed 2026-07-29): `/api/v1/auth/sms/code`, `/api/v1/auth/sms/code/verify`,
  `/api/v1/profile/phone/code`, `/api/v1/profile/phone/verify`, plus
  `sms_enabled` on `/auth/config` and `phone_verified` / `sms_opted_out` on
  the profile. Deployed but **inert** — see above.

**Frontend-only, no backend dependency:**

- **The app is fully decommercialized.** No supporter status, no Stripe,
  no donate buttons, no paid tier. Signed-in and admin are the only gates.

**Already done:** the backend repo has been renamed `veo-audit` →
`scooter-fyi-api`, so this doc and the rest of this repo name it that way.
GitHub redirects the old URLs, so any link that still says `veo-audit`
resolves — it is just wrong, not broken.

## Constraints that actually shape the UI

These are not obvious from the endpoint list and will produce
wrong-looking UI if missed.

**Tracked rides redact their `gbfs_*` fields until you report your own
end.** The rider must commit to their own numbers before seeing the
server's. So the ride summary has two distinct states, and the "what the
data says vs. what you said" reveal only exists after the end report. A
summary built assuming GBFS data is present at ride end renders nulls.

**Distance carries a `distance_source`, and the sources aren't equal.**
`waypoints` is measured; `straight_line` (no waypoints uploaded)
undercounts badly; `client` is unverified. If you show the number, mark
the weak ones as estimates. This is also the honest in-product argument
for letting the HUD upload waypoints.

**Photo uploads require a session, everywhere.** Model reports accept
anonymous *text* but reject an anonymous *photo* with 401 — the popup
already swaps the picker for a sign-in note. Device photos and ride
screenshots require a session outright.

**Rate limits are tight and per-account.** Most write paths are 10–30/hour;
tracked-ride and off-feed waypoints are 600/hour (≈1 per 6 s sustained, so
buffer and flush). There is still no shared 429 handler in `api.ts` —
adding one is part of Phase A, not polish.

### SMS: six things the endpoint list doesn't tell you

Texts go through [z280-comms](https://github.com/z280/comms), a shared
service, not straight to a handset. That single fact is behind all of
these, and none of them are visible in the request shapes.

**A saved number is a contact detail; only a texted code is proof.** The
profile PUT will happily store any number — anyone can type anyone's.
Signing in requires `phone_verified`, which only the verify endpoint sets.
So the Account panel has to distinguish "we have a number for you" from
"you have proved you answer it", and an unverified claim *loses* the number
to whoever proves it. Never present a saved number as though it were a
working sign-in method.

**Consent is global, and enforced upstream.** One phone number serves
several applications, so a STOP texted to any of them blocks all of them —
including us, for people we have never messaged. Expect `409` for
strangers. Two consequences for copy: show the server's sentence
**verbatim** (it names the exact keyword and number that unblock, and a
paraphrase names ones that don't), and never imply the block is
scooter.fyi-only, because it isn't.

**Opting out is not an error state.** The rider did it on purpose. Style it
as a standing notice, not a failure, and don't invite a retry that cannot
work — but do scope the "don't retry" to *that number*, since correcting a
mistyped digit is the most likely next action.

**Both doors draw on one send budget.** Sign-in and profile verification
share the same physical handset, so a `429` in the Account panel can be
caused by sign-in traffic the rider never generated. A number that is
already verified skips the global daily ceiling — a returning owner whose
only door is SMS can't be locked out by other people's traffic — but
per-number limits still apply.

**A refused send never invalidates a code the rider already holds.** A
`429` is raised before a new code is even issued, and every other failure
burns the *new* code server-side and leaves the previous one live. So a
failed resend must not hide the code entry box; doing so pushes the rider
to spend another of three hourly texts to get back a code they already
have.

**Nothing is guaranteed delivered.** A `202` means accepted, not delivered,
and there is no delivery receipt to wait for. Sign-in codes are safe under
this — the rider just asks for another — but do not build any flow that
assumes the text arrived.

## Sequencing

**Phase A — typed clients and session plumbing.** ✅ Shipped (profile
branch): `src/api.ts` gained `ApiError` (code/status/Retry-After/detail),
a shared bearer `authedFetchJSON`, and typed wrappers for profile,
username + lexicons, ruling colors, and points. `api.ts` remains the
single place bearer tokens are attached. The session-lifetime work
(localStorage + `/auth/refresh`) is still open.

**Landed outside these phases: SMS sign-in.** The phone door and the
Account panel's verification row shipped in #40, ahead of Phase A's shared
429 handler — so they do their own `Retry-After` handling inline. Fold them
into the shared path when Phase A lands rather than leaving two
conventions.

**Phase B — points and public identity.** ✅ Shipped (profile branch), in
`src/account.ts` behind the signed-in Account panel: points ledger with
cursor pagination, username picker (regenerate + adjective/emoji combos
over the curated lexicons), royalty title, ruling-colors claim editor,
privacy toggles, email/phone, home/work coordinates, rate plan synced to
the account, badges row, and the profile-completion hint. Note
`miles_10` / `miles_100` / `streak_7` only start moving once Phase C
ships, and the points ledger stays thin until C–E land.

**Phase C — rides in the HUD (largest phase).** `src/ride-hud.ts` is
currently "all browser-API, zero backend." Give it a server side:

1. Start a ride on the HUD's `armed`→`riding` transition; handle 409 by
   offering to resume or end the existing active ride.
2. Restore state on load via the active-ride endpoint — a HUD that
   survives a reload or phone lock is currently a hard state loss.
3. Batch waypoint uploads from the existing GPS loop against the 600/hour
   budget.
4. Report the end with the HUD's own timing and `ride-cost.ts` estimate.
5. Build the two-stage summary described above. This is the feature.
6. Ride history list, `path_geojson` replay, hard-delete controls.

Two mechanisms exist and both are live: **tracked rides** (a Veo vehicle in
the GBFS feed) and **off-feed rides** (personal scooter, competitor
rental — no `vehicle_identifier`). Same lifecycle shape, so one client path
can drive both; pick by whether the rider selected a mapped scooter.

**Phase D — QR scan.** 100 points, the largest single award, and a scan
naturally initiates a ride start rather than standing alone. Needs a camera
decoder the repo doesn't have: no `BarcodeDetector`/`getUserMedia` usage
today, and `BarcodeDetector` is absent on iOS Safari — so this means the
first real dependency added to a deliberately lean four-package
`package.json`. Weigh that before committing.

**Phase E — device photos and recommendations.** Photo strip in the popup
with `uploaded_by` attribution; upload with distinct 409/413/503 handling;
"my uploads" in the account drawer. Put thumbs up/down on the **ride
summary**, not the popup — the 24 h completed-ride requirement means it
403s anywhere else. Depends on Phase C.

**Phase F — routing.** Replace the straight-line walking preview in
`recommend.ts` and destination handling in `ride-wizard.ts` with real
routed geometry: profile picker fed by `/route/profiles`, and structured
handling of `out_of_coverage` against `graph_bbox` (the routing graph is
narrower than the map's `maxBounds`, so this fires in normal use near the
edges).

## Housekeeping

- `devices.ts` is ~2.5k lines and `main.ts` ~1.9k. Phases B, C, and E all
  want to add to them — prefer new modules wired in from `main.ts`,
  matching how `recommend.ts` and `ride-hud.ts` are already split out.
- **No test runner exists** (`package.json` has `dev`/`build`/`preview`;
  `build` runs `tsc --noEmit`). Phase C's state machine — active ride,
  resume, single-shot end, 409 recovery — is the first thing here worth
  testing. Consider adding Vitest with that phase.
