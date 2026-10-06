# Rover service area

Veo restricts the Rover — the three-wheeled seated trike — to a downtown
service area. A Rover trip can only **start or end** inside it.

## Where the boundary came from

Veo publishes no `geofencing_zones` feed (re-checked 2026-10-06:
`system_information` 200, `geofencing_zones` 404, `system_regions` 404) and
every non-GBFS path on their API answers `No Token specified`, so the polygon
cannot be read from them.

It was **specified as six street intersections**, read off Veo's own in-app map:

> Broadway & Blake → Broadway & Colfax → Colfax & 14th → 14th & Wynkoop →
> Wynkoop & 19th → 19th & Blake → close

Six streets: **Broadway** east, **Colfax** across the south, **14th** up the
south-west, **Wynkoop** along the north-west, a short hop down **19th**, and
**Blake** all the way north-east back to Broadway.

## The polygon

Area **1.67 km²**. WGS84, lon/lat.

```
POLYGON((-104.986392 39.759874,
         -104.986770 39.739946,
         -104.989670 39.739946,
         -105.003129 39.750510,
         -104.997414 39.754699,
         -104.995500 39.753197,
         -104.986392 39.759874))
```

| # | Corner | Lat, Lon |
|---|---|---|
| 1 | Broadway & Blake | 39.759874, -104.986392 |
| 2 | Broadway & Colfax | 39.739946, -104.986770 |
| 3 | Colfax & 14th | 39.739946, -104.989670 |
| 4 | 14th & Wynkoop | 39.750510, -105.003129 |
| 5 | Wynkoop & 19th | 39.754699, -104.997414 |
| 6 | 19th & Blake | 39.753197, -104.995500 |

## How the names became numbers

Each street was fitted as a line through intersection POIs from the app's own
geocoder, and the corners are where those lines cross:

| Street | Anchors |
|---|---|
| Blake | & 14th, & 19th, & 22nd, & Park Ave West |
| 14th | & Blake, & Court Place |
| Broadway | & Colfax, 1670 Broadway (& 17th Ave) |
| Wynkoop | & 15th, held parallel to Blake |
| 19th | & Blake, held parallel to 14th |
| Colfax | due east–west through Broadway & Colfax |

The two fitted bearings come out **89.4° apart**. That is the check that
matters: downtown Denver's grid is square, so a fit that was not would mean a
bad anchor. One anchor *was* bad and is not used — the geocoder's "Larimer
Street & 14th Street" POI sits about 20° off the line through the other two, so
it was discarded rather than averaged in.

## What this shape does that a freehand "downtown" would not

- **Coors Field is outside.** It sits north-west of Blake, in the notch that the
  Wynkoop → 19th → Blake sequence cuts out. An eyeballed downtown box includes
  it.
- **The Convention Center and the Denver Performing Arts Complex are outside.**
  Both sit south-west of 14th Street.
- **Union Station and Larimer Square sit *on* the line** — 8 m and 7 m from it,
  because the station fronts Wynkoop and the square fronts 14th. The app
  reports those as "check the Veo app" rather than claiming either side.

## What is still uncertain

The streets are named; **which side of each one Veo's line runs is not**, and a
street is 20–30 m wide. `src/rover-zone.ts` carries that as a 40 m margin:
within it, the app points at the Veo app instead of ruling. Measured against
this polygon, 40 m leaves 86% of the zone reading as a confident "inside" —
wide enough to cover the kerb, narrow enough that the caution still means
something.

Nothing in the app ever states that a trip may or may not end somewhere. The
route screen never disables Next. The app that charges somebody is not this one.

## Changing it

`public/rover-zone.geojson` is the only artefact — no code. Edit `CORNERS` in
`scripts/build-rover-zone.mjs` and re-run it:

```
node scripts/build-rover-zone.mjs
```

The build fails rather than ships if the ring self-intersects or the area falls
outside a sanity band, because a transposed corner still draws a
plausible-looking polygon somewhere else.
