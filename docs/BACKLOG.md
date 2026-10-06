# Backlog — agreed, planned, not built

Everything discussed and deliberately deferred, with enough detail to pick up
cold. Each item says what it is, what blocks it, and where the work goes.

Two other branches carry their own scoped backlogs:
`claude/analytics-tier2` (scooter-fyi-api) and `claude/rider-reporting`
(this repo). This file is what is left over.

---

## 1. Equity cut of rental outcomes

**What:** the no-go rate inside vs outside Denver's equity areas, as a figure
the stats drawer can show and the civic voice can cite.

**Why it is worth doing first:** it is the one number a DOTI equity grant
actually wants, and it is the closest thing to "ready" on this list — the
pieces exist. `device_state` carries the counters; the API already computes
equity-area membership (`/api/v1/equity-estimate`, `equity_groups.py`,
`data/equity.geojson`); the h3 aggregates already join devices to cells.

**Where:** `scooter-fyi-api` — extend `src/fleet_outcomes.py` with an
equity-split variant, served off the same endpoint. Frontend renders it under
the headline in `src/fleet-stats.ts`.

**Watch for:** a device's equity membership is a property of where it is NOW,
and the counters are lifetime. Splitting a lifetime counter by a current
location is a real methodological hole — either attribute at increment time
(needs the tier-2 rollup, see the analytics branch) or publish it as
"vehicles currently in equity areas", which is a different and weaker claim.
Do not publish the weaker claim as the stronger one.

---

## 2. Grant-facing summary

**What:** a plain-language page for the DOTI micro-grant application — what
the app measures, how rider feedback is collected, how both serve riders in
the equity areas.

**Status:** deferred by the owner as premature. Do not start without being
asked. The framing, when it comes, is that the grant describes what the app
ALREADY does — quality reports, steering riders off bad scooters, getting
people to their destination — not features built to satisfy it.

---

## 3. Veo's actual Rover polygon

**What:** replace the street-derived Rover service area with the operator's
own boundary.

**Where:** `public/rover-zone.geojson` is the only artefact — edit `CORNERS`
in `scripts/build-rover-zone.mjs` and re-run. No code changes.

**Route:** a Colorado Open Records Act request to DOTI for Veo's permitted
Rover operating area, the same channel that produced
`public/micromobility-zones.geojson`. If the permit or contract defines the
service area it is a public record. Veo's own API will not give it up — every
non-GBFS path answers `No Token specified`, and that is an auth boundary, not
an obstacle to route around.

**When it lands:** shrink `UNCERTAIN_MARGIN_M` in `src/rover-zone.ts` (now
40 m, sized for "which side of the street"). Once the line is the operator's
own, the hedge is mostly noise.

---

## 4. Ride mode

`docs/RIDE_MODE_OVERHAUL_PLAN.md` is on main and is a plan, not a build. It
was delivered as a review of what ride mode is missing. Nothing in it has been
implemented beyond what shipped in PR #89 and #90.

---

## 5. Smaller things noted in passing

Everything previously listed here is done: the radius decision landed
(scooter-fyi-api #106), `src/fleet_outcomes.py`'s header was corrected with it,
`docs/ANALYTICS_PLAN.md` §0.2 now records the decision rather than demanding
one, and the basemap attribution fix — the licence condition that was rendering
empty — merged in #96 and is verified live.

One new item took their place, and it is the only one here that gates
publishing:

- **Measure the round-trip share of `rentals_no_go`.** It counts END
  displacement while the copy describes a maximum, so loop rides are counted as
  no-gos. `rental_max_distance_m` is tracked live during rentals, so sampling
  it at release answers how big the gap is. Then fix the copy, or add a second
  counter — do not quietly redefine `rentals_no_go`, because
  `smart_ride_grade` is calibrated on it. Full detail in the server-agent
  handoff, item 1b.
