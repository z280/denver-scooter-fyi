# The State of Veo — Frontend Plan (denver-scooter-fyi)

A fifth drawer, behind a chart icon, that tells Denver how Veo is doing: day by
day, week by week, in one number a person can repeat to a council member.

This is the app's thesis made legible. The map answers *which scooter should I
take right now*. This answers *is this service actually working*, and it is the
half a rider cannot see from one trip.

---

## 0. The one number

**Of every rental Denver started, how many actually went somewhere.**

Everything else on this screen is that number cut by time, place, or model.
Pick one sentence and build the drawer around it:

> **9 in every 100 Veo rentals never get more than 50 metres from the kerb.**

That is not an estimate and it is not a survey. It is counted, at the source,
every two minutes, over the whole fleet.

### 0.1 It already exists, and it is already validated

`sql/072_vehicle_rental_outcomes.sql` added `device_state.rentals_observed` and
`rentals_no_go` — a per-vehicle ledger written by `device_state.py` at the
moment each rental completes. Its own migration note records the validation,
and this plan rests on it:

* measured over **214,846 reservation episodes** across 8 days of archive,
  **9.1%** never left the kerb;
* it **persists** per vehicle — one week's no-go rate predicts the next at
  r=+0.275 over 7,534 vehicles (best quartile 6.9%, worst 11.0%);
* it is **concentrated** — the worst 10% of vehicles account for 32.4% of all
  no-gos, and 123 vehicles fail 40%+ of the time;
* the shipped `reliability_tier` separates it: ok 7.4%, unknown 13.1%,
  high_risk 50.0%.

`is_reserved` on this feed means IN USE, not a held booking (`ride_watch.py`'s
measurement), so these are **attempts**, not changes of mind. That distinction
is the whole reason the number is worth publishing: a no-go is a person who
paid an unlock fee and walked.

### 0.2 THE RADIUS HAS TO BE DECIDED BEFORE ANY OF THIS SHIPS

There are three circles in the codebase today and they do not agree:

| | value | where |
|---|---|---|
| `stationary_threshold_meters` | **16 m** | `config.json`; what `rentals_no_go` actually counts |
| the prose in sql/072 | **25 m** | that migration's own header — it disagrees with its own column comment |
| `IN_PLACE_RADIUS_M` | **50 m** | `device_state.py`'s failed-start rule, the one with the 37.1% repeat-rate validation |

A public headline cannot sit on that. **Recommendation: 50 m**, because it is
the radius the published validation was computed at, it is the one `ride_watch`
measured GPS jitter against (0.2% of parked-fleet steps exceed it), and it is
the number a rider recognises — half a block, not a parking space.

Doing that means **`rentals_no_go` is recounted at 50 m**, which changes the
baseline from 9.1% to something larger and is a real decision, not a migration.
Until it is made, every figure below is provisional. Fixing sql/072's prose to
match whatever is chosen is part of the same change.

---

## 1. What ships from data we already have

Three tiers, and the drawer should launch with tier 1 alone rather than wait.

### Tier 1 — today, no new storage

| Panel | Source | Note |
|---|---|---|
| Fleet size, now | `/api/v1/devices/current` | already live |
| Available / reserved / out-of-service, hourly, 14 days | `device_status_snapshots` (sql/069) | already stored per cycle, **per model too** |
| Trips per day, 30+ days | `daily_trip_summary` (sql/018) | already rolled up at 09:00 Denver |
| Trips per hour, 48 h | `trip_events.detected_at` | one `date_trunc` away |
| Vehicles that did ≥1 trip, per day | `daily_vehicle_trip_counts` | already rolled up |
| Trips per hexagon | `trip_events.to_lat/to_lon` → h3 | `api_h3.py` already does this shape |
| Fleet-wide no-go rate, **cumulative** | `SUM(rentals_no_go)/SUM(rentals_observed)` | one query; no time series yet |
| No-go rate **by model** | same, grouped by `vehicle_model_name` | the most actionable cut a rider gets |

That is a real drawer. The headline number is available on day one — as a
lifetime figure rather than a trend.

### Tier 2 — the time series, which is the actual ask

**`rentals_observed`/`rentals_no_go` count up from zero and never reset.** They
cannot answer "how was last Tuesday", which is the whole narrative. The fix is
small and belongs in the API lane:

> **`rental_outcomes_hourly`** — one row per (hour, h3_9 cell, model) with
> `rentals` and `no_gos`. Written by `device_state.py` at the same moment it
> already increments the per-vehicle counters, which sql/072's own note is
> explicit about: *"counted at the source, not by scanning"*. Deriving it later
> from `raw_telemetry_points` is impossible beyond ~48 h, since
> `archive_if_due` truncates that table.

Hourly rather than daily because the story has a shape within the day — a fleet
that works at 9am and fails at 6pm is a charging story, and a daily average
hides it. Rolling up hourly→daily→weekly is free; the reverse is not.

Cell + model in the key because those are the two cuts worth having and both
are known at write time. Keep the cell at **h3_9** (not 10): a no-go rate needs
a denominator, and r10 cells will be mostly single-digit.

**This is the one new table the plan needs.** Everything else is queries.

### Tier 3 — "how fast does a bad scooter get fixed"

The honest statement first: **we cannot see a repair.** We see a vehicle enter a
bad state and we see it leave one. What we can publish is the *effect* —
exactly the shape `parking_response.py` already uses for Veo's response to
parking complaints, and it should reuse that module's structure and its
vocabulary.

A vehicle enters a bad state at the first observation where `reliability_tier`
is `high_risk`. It leaves by one of three doors, and they are **not** the same
story:

| Exit | Means | Honest label |
|---|---|---|
| moved ≥ 500 m | rebalanced, or a rider got it going | *back in service* |
| battery returned to full | swapped or charged — a service visit | *serviced* |
| left the feed | pulled | *removed* |

Report them separately, with a median and a p90 per rolling 7/28 days, and
never collapse them into one "repair time". **And publish the control**, as the
parking panel does: the same distribution for vehicles that were never
high_risk. A median of 31 h means nothing without the comparison.

Needs: a `vehicle_condition_spells` table (vehicle, entered_at, exited_at,
exit_reason) written by the same cycle pass. Tier 3 waits until tier 2 has
proved the write path.

---

## 2. The drawer

A chart icon on the ribbon, beside Leaderboard. Four screens, in this order,
because it is an argument and arguments have an order:

1. **The headline.** One number, huge, with its 7-day direction and the
   sentence under it. *"9 in 100 rentals went nowhere this week — 1,840 people
   paid to unlock a scooter that didn't move."* The count matters more than the
   rate: a percentage is a statistic, a number of people is a story.
2. **Day by day.** The no-go rate over 30 days, with trips/day behind it as a
   second series — because a rate improving while usage collapses is not an
   improvement, and the chart has to be able to say so.
3. **Where.** The hex map, tinted by no-go rate rather than by device count,
   reusing `hexdensity.ts` entirely — this is one more `HexMetric`, not a new
   map. The equity-area overlay goes on top by default. **If the no-go rate is
   higher inside equity areas than outside, that is the single most important
   sentence this app can produce**, and the panel should compute that
   comparison explicitly rather than leaving it to the reader's eye.
4. **By model.** Four bars. The one cut a rider can act on tomorrow.

### 2.1 Rules the charts follow

- **A number with no denominator is not published.** Every rate carries its n,
  and a cell or model under a minimum sample renders as "not enough rides yet"
  rather than as a confident colour. Pick the floor once, in the API, and name
  it in the response.
- **Date everything.** Each panel says what window it covers and when the data
  was last computed, from the response, never from the client's clock.
- **No y-axis truncation on the headline series.** This is advocacy; the chart
  must survive being screenshotted by somebody hostile.
- **Greyscale-legible.** The `dataviz` skill's rules apply, and the existing
  reliability colours already encode shape as well as hue.

### 2.2 What this must never claim

- Not "Veo broke 1,840 scooters". A no-go is an attempt that went nowhere; the
  cause might be the vehicle, the app, or the rider giving up. Say what was
  counted.
- Not a repair time, when what was measured is a vehicle moving again (§1 tier 3).
- Not a comparison to other cities. We have one city's feed.
- Not Veo's own numbers. Everything here is derived from a public feed by a
  third party, and the drawer says so once, plainly, with a link to the method.

---

## 3. Sharing, because a chart nobody can send is not advocacy

Every panel gets a **share** action producing a PNG with the number, the
window, the date and `scooter.fyi` on it. A council member gets sent a picture,
not a URL with query parameters.

Deep links too: `?analytics=nogo&window=28d&cell=…` so a panel can be linked to
exactly as the map's `?ride=` does.

---

## 4. The hand-off to We See You Veo

The analytics drawer makes a reader angry on purpose. The next thing they see
must be somewhere to put it — this is the whole reason the two projects exist
beside each other.

At the foot of the headline panel: **"This is the fleet. What happened to
you?"** → the story capture in `docs/RIDER_VOICE_PLAN.md`.

The rule from Phase 10 applies unchanged and is restated here because this is
where it will be forgotten: **sending a story to WSYV is a disclosure to a
third party, and it is its own opt-in, per story, defaulted off, with a plain
statement of what the recipient sees.** Reading the charts discloses nothing.

---

## 5. Modules

| Module | Responsibility |
|---|---|
| `analytics-panel.ts` *(new)* | The drawer: four screens, the window control, the share action. Renders; decides nothing. |
| `analytics-figures.ts` *(new)* | Pure. Takes API rows, returns the sentences and the series. Every claim the drawer makes is a function here, so the wording is assertable without a DOM — the same discipline `ride-failed-start.ts` follows. |
| `hexdensity.ts` *(existing)* | Gains `no_go_rate` as a `HexMetric`. No new map. |
| `api.ts` *(existing)* | `fetchFleetOutcomes`, `fetchOutcomeSeries`, `fetchOutcomeCells`. |
| `main.ts` *(existing)* | One `wireAnalyticsPanel()` call. |

### API lane (scooter-fyi-api)

| | |
|---|---|
| **new table** | `rental_outcomes_hourly` (hour, h3_9, model, rentals, no_gos) — §1 tier 2 |
| **new table, later** | `vehicle_condition_spells` — §1 tier 3 |
| **endpoints** | `GET /api/v1/fleet/outcomes` (headline + by model), `GET /api/v1/fleet/outcomes/series?window=`, `GET /api/v1/fleet/outcomes/cells?window=` |
| **cache** | These are hourly figures. Cache like `/compliance/daily`, not like `/devices/current`. |
| **the radius decision** | §0.2. Blocks publication, not development. |

---

## 6. Tests

- Every published sentence is a pure function with a sample under the floor, at
  the floor, and a division by zero.
- A window with no data renders "not enough rides yet", never 0%.
- The equity-vs-rest comparison is computed, not eyeballed, and is suppressed
  when either side is under the floor.
- The share image carries the window and the date — asserted, because a
  screenshot that outlives its window is the failure mode.
- `no_go_rate` as a hex metric restores the ramp paint when switched away, the
  same regression `hexdensity.test.ts` already guards for territory.
- The headline count and the series agree for an overlapping window. Two
  renderings of one signal, as with `has_negative_report`.

---

## 7. Sequencing

1. **Decide the radius** (§0.2). Everything downstream quotes it.
2. **Tier 1 drawer** against existing tables — ship it; the lifetime figure is
   already worth reading.
3. **`rental_outcomes_hourly`** in the API lane, written at the source.
4. **Day-by-day and the hex map** light up from that table.
5. **Story hand-off** (`RIDER_VOICE_PLAN.md`).
6. **Tier 3 spells**, once the tier-2 write path has a month of data behind it.
