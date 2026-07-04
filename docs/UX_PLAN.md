# UX/UI Improvement Plan

Distilled from an external UX review (Gemini, June 2026) and grounded in the
current codebase. Three phases, ordered so each is independently shippable and
each unblocks the next. Phase 1 is pure frontend; Phase 2 needs small
additions to the `veo-audit` API; Phase 3 needs the first write endpoints.

The review's core diagnosis, confirmed against the code:

- **Filtering vs. symbology are scattered.** Battery *filtering* (bucket
  buttons) lives in the Filters drawer while battery *coloring* ("Display as:
  Range") lives in Tools ([index.html](../index.html) `#battery-filter` vs.
  `#color-by-seg`). Geography is split across three drawers: area filter in
  Filters, boundary overlays + density choropleth in Overlays, neighborhood
  search in Tools.
- **No state visibility.** Once a drawer closes, the only trace of an active
  filter is the "x of y" count in the freshness pill. Users forget a filter is
  on and wonder why the map looks empty.
- **The app serves three intents with one screen** — civic/compliance
  analysis, find-a-ride, and (eventually) in-ride companion — with no way to
  switch between them.

---

## Phase 1 — Information architecture & state visibility (frontend only)

**Goal:** eliminate the filter/symbology confusion and make map state always
visible. No API changes, no new data.

### 1.1 Regroup controls by attribute, not by UI function

Restructure the drawers from *Filters / Overlays / Tools* into groups that
keep everything about one attribute in one place:

- **Devices drawer** (replaces Filters + the Tools color toggle):
  - *Device type* segmented control (unchanged).
  - *Availability* switch (unchanged).
  - **Battery & range block** — the four bucket filter buttons and a
    "Color dots by range" toggle side by side, with the red→green legend.
    When the user taps a battery bucket, auto-enable range coloring so the
    filter gives immediate visual feedback (one-way convenience; the user can
    still turn coloring off).
- **Areas drawer** (replaces Overlays + the geographic half of Filters/Tools):
  - *Boundary outlines* checkbox list (unchanged, from `buildLayerToggles()`).
  - *Color regions by device density* choropleth select + legend (unchanged).
  - *Only show devices in…* — the existing area filter
    ([src/area-filter.ts](../src/area-filter.ts)), renamed from the vague
    "Additional filters", with the neighborhood search box folded into its
    search input (it already has one; the Tools "Find a neighborhood"
    field is redundant with area-filter's category=neighborhood mode plus
    zoom-to-selection).
- **Tools drawer** keeps only the dense-cluster finder.
- **Compliance drawer** unchanged.

Labels follow the verb-noun rule: "Color dots by…", "Only show devices
with/in…". "Display as" and "Additional filters" go away.

### 1.2 Active-filter chips on the map

New small module (`src/filter-chips.ts`) rendering a chip row at the top of
the map, one chip per active constraint, each with a ✕ to clear it:

```
[ 🛴 Scooters ✕ ] [ ⚡ Top 25% battery ✕ ] [ 📍 5 neighborhoods ✕ ] [ Hide unavailable ✕ ]
```

Wire it in [src/main.ts](../src/main.ts) where the filter handlers already
converge (every handler already calls `devices.*` + `clusters.update`). Chips
cover: device type ≠ All, hide-unavailable, battery buckets, area filter
selection. Clicking a chip's ✕ resets that control (dispatch the same events
the drawer widgets use, so drawer state stays in sync).

### 1.3 Direct manipulation: click a region to filter

When boundary polygons are visible (overlay or choropleth on), clicking a
polygon toggles it in the area filter — the map itself becomes the filter UI
instead of a drawer dropdown. Implementation: a click handler on the overlay
fill layers in [src/overlays.ts](../src/overlays.ts) that calls into
`AreaFilter` with the clicked `region_name`; the existing
`setOverlayChecked`/`setSubset` plumbing in main.ts already handles the
overlay↔filter synchronization.

**Files touched:** `index.html`, `src/main.ts`, `src/area-filter.ts`,
`src/overlays.ts`, `src/style.css`, new `src/filter-chips.ts`.
**Deleted:** the Tools neighborhood-search section, `#color-by-seg` (absorbed
into the battery block).

---

## Phase 2 — Reliability surface + intent modes (small API additions)

**Goal:** answer the rider's real question — "will this scooter actually
start after I walk to it?" — and give each audience a one-tap preset.

### 2.1 Reliability score & ghost-scooter styling

Derive a per-device 🟢/🟡/🔴 reliability tier client-side from fields that
already exist on `DeviceProperties` ([src/api.ts](../src/api.ts)):
`quality_designation`, `has_negative_report`, and — when signed in —
`number_failed_starts` and dwell time from `first_observed_at_location`.

- **Popup badge:** add the tier to the device popup with a plain-language
  reason ("Idle 4 days · 2 failed start attempts logged").
- **Ghost pins:** render 🔴 devices semi-transparent/desaturated on the map
  (a paint-expression change in [src/devices.ts](../src/devices.ts), same
  mechanism as the existing `FLAG_LAYER` negative-report flag).
- **New color mode:** "Color dots by reliability" joins type/range in the
  Phase 1 battery-block toggle group.

**API dependency (veo-audit):** expose `number_failed_starts` and
`first_observed_at_location` (or a precomputed `reliability_tier`) on the
*public* devices endpoint. Until then the tier degrades gracefully to
`quality_designation` + `has_negative_report` for anonymous users.

### 2.2 "Worth the walk?" in the popup

Using the browser geolocation the map control already supports, show
estimated walk time (straight-line × 1.3 at 3 mph) next to the reliability
tier: *"~8 min walk · high failure risk — a verified scooter is 2 min
further"*. The "nearest better alternative" is a client-side nearest-neighbor
scan over `devices.visibleFeatures()` filtered to 🟢 tier.

### 2.3 Intent modes: Find a ride / Audit

A two-position switch above the drawer tabs. **Not** separate apps — just
presets over existing state, so it's cheap and honest:

- **Find a ride:** overlays/choropleth off, hide-unavailable on, reliability
  coloring on, compliance gauge hidden.
- **Audit:** choropleth on (v1 areas), compliance drawer opened, all devices
  shown, ghost pins emphasized.

Manual control changes simply switch the mode indicator to "Custom". This is
the least-machinery version of the review's "strict mode switching" that
still resolves the persona conflict; the full Ride HUD stays out (see end).

**Files touched:** `src/devices.ts`, `src/api.ts` (types), `src/main.ts`,
`index.html`, `src/style.css`. **New:** `src/reliability.ts`, `src/modes.ts`.

---

## Phase 3 — Crowdsourced audit loop: failure & equity-discount reports (first write API)

**Goal:** turn riders into auditors. This is the phase that needs new
`veo-audit` backend surface (report ingestion + aggregates); the frontend
work is deliberately thin.

### 3.1 One-tap failure reports

In the device popup, a report row:
`[ 🚫 Failed to unlock ] [ 🪫 Dead battery ] [ 🛴 Damaged ]`
POSTs `{vehicle_identifier, report_type, snapshot_time}` to a new
`POST /api/v1/reports/device` endpoint. Anonymous, rate-limited server-side;
optimistic UI with a "Ghost scooter logged — you saved someone a walk"
confirmation. These reports feed the Phase 2 reliability tier, closing the
loop.

### 3.2 Equity-zone awareness & discount reports

- **Pre-ride priming:** the popup already knows the device's coordinates and
  [src/geo.ts](../src/geo.ts) already does point-in-polygon for the area
  filter; reuse it against the v1/v2 boundaries to show a badge:
  *"🏷️ Equity zone — rides starting or ending here are contractually
  discounted. Check your receipt."*
- **Report a missed discount:** a "Report" entry in the drawer tab bar with a
  three-step card — (1) Did Veo apply the discount? Yes / No / How do I
  check?, (2) on "No", optional receipt-screenshot upload
  (`POST /api/v1/reports/discount`, image to R2), (3) a pre-filled
  `mailto:` to Veo support cc'ing DOTI's shared-mobility inbox citing the
  contract clause. No push notifications, no background location — this is a
  static site; the drawer entry point plus the popup badge do the priming.

### 3.3 Public accountability layer

- **"Contract violations" choropleth mode:** a new option in the density
  select, colored by discount-denial report frequency per region
  (needs a `GET /api/v1/reports/summary?layer=` aggregate).
- **Ticker in the Compliance drawer:** *"Discount reports this month: N ·
  estimated overcharges: $X"* alongside the existing gauge, plus a
  `[ Download monthly report (CSV) ]` link straight to an API export URL.

**API dependencies (veo-audit):** `POST /reports/device`,
`POST /reports/discount` (+ R2 upload), `GET /reports/summary`, CSV export.
Frontend files: `src/api.ts`, `src/devices.ts` (popup), new
`src/reports.ts`, `index.html`, `src/style.css`.

---

## Explicitly deferred: the 3D Ride-Mode HUD

The review's own closing warning applies: 3D must earn its place with safety
value, not novelty. A static SPA without background location, wake locks, or
audio can't deliver a safe in-ride HUD; a half-measure would be a distraction
at 15 mph. Revisit after Phase 3 as a PWA effort. A cheap intermediate that
*is* worth doing then: a "follow me" toggle (MapLibre geolocate +
`easeTo({pitch: 60, bearing: heading})`) with the Phase 3 equity-zone
polygons painted on the ground plane — but only once the report loop proves
riders actually use the site mid-ride.

## Sequencing rationale

- Phase 1 fixes the confusion that makes every later feature harder to find,
  and touches no data contracts — lowest risk, ship first.
- Phase 2's reliability tier is the app's core differentiator and mostly
  reads data that already exists; its API asks are read-only field
  promotions.
- Phase 3 is last because write endpoints, abuse handling, and evidence
  storage are the largest new surface — and its reports are more credible
  displayed inside the reliability UI that Phase 2 establishes.
