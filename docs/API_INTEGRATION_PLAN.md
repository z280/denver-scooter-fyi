# Frontend work plan — consuming the veo-audit API

**The backend's [API.md](https://github.com/z280/veo-audit/blob/main/API.md)
is the source of truth for every endpoint, payload, error code, and rate
limit.** This file is only a work plan: what to build here, in what order,
and the handful of design constraints that shape the UI. It deliberately
does not restate request/response shapes — that duplication is what the
retired `API_REQUIREMENTS.md` turned into.

Last reconciled against the backend on 2026-07-28.

---

## Where things stand

Both repos are in sync as of 2026-07-28. Everything the frontend calls
exists on the backend, and everything below is verified live, not assumed:

- **`/api/v1/reports/model` now exists.** The "Veo Unknown → Tell us!"
  form in the device popup is live rather than posting into the void.
- **The app is fully decommercialized.** No supporter status, no Stripe,
  no donate buttons, no paid tier. Signed-in and admin are the only gates.
- **`failed_unlock` → `not_rideable`.** The report chip reads
  "🚫 Not Rideable", matching the "Likely rideable" tier language.
- **Routing is deployed** (`/api/v1/route`, `graph_bbox`
  `[-105.06, 39.65, -104.88, 39.79]`), but `battery_percent_estimate` is
  `null` on every request until the regression model has enough
  observations to fit. Treat the battery number as optional garnish.

## Constraints that actually shape the UI

Four things in the API are not obvious from the endpoint list and will
produce wrong-looking UI if missed.

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

## Sequencing

**Phase A — typed clients and session plumbing.** Extend `src/api.ts` with
typed wrappers for the endpoints below, plus a shared 429/`Retry-After`
path. `api.ts` is already the single place bearer tokens are attached; keep
it that way. Ships in isolation.

**Phase B — points and public identity.** Points ledger, username picker
(regenerate + adjective/emoji search), privacy toggles, home/work
coordinates, badges row. Self-contained and no dependency on rides — but
note `miles_10` / `miles_100` / `streak_7` only start moving once Phase C
ships, and the points ledger stays thin until C–E land. Consider shipping
B and C together if the empty state reads badly.

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
