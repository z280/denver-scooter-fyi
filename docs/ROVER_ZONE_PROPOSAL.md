# Rover service area — proposed WKT, for review

**Status: proposal. Not merged as authoritative.** The app currently ships this
same geometry, drawn dashed and labelled approximate everywhere it appears.
This document is the thing to argue with.

## What this is

Veo restricts the Rover (the three-wheeled seated trike) to a downtown service
area: a Rover trip can only **start or end** inside it. The rule is certain.
The line is not — Veo publishes no `geofencing_zones` feed (re-checked
2026-10-06: `system_information` 200, `geofencing_zones` 404, `system_regions`
404) and every non-GBFS path on their API answers `No Token specified`, so
their polygon sits behind a rider's own account.

So this is an **interpretation of the screenshot**, built from Denver's own
geometry rather than traced pixels: the official Central Business District and
Union Station neighbourhood polygons, dissolved into one ring. Those two
because their edges are the edges in Veo's app.

## The proposed polygon

Simplified from the 260-point city geometry to 12 vertices at a 35 m
tolerance, so it can be read and checked by hand. Area **2.24 km²**.
WGS84, lon/lat, right-hand rule.

```
POLYGON((
  -105.008186 39.754792,
  -105.007771 39.753446,
  -105.001206 39.748166,
  -105.000424 39.746563,
  -105.000254 39.743583,
  -104.998567 39.740194,
  -104.990077 39.740112,
  -104.988940 39.740640,
  -104.987389 39.740107,
  -104.987397 39.748913,
  -104.999548 39.758474,
  -105.003169 39.760406,
  -105.008186 39.754792
))
```

## Edge by edge — this is the part to review

Reviewing coordinates is hard; reviewing street names is easy. Each edge, and
how confident I am:

| Edge | Follows | Confidence |
|---|---|---|
| East | **Broadway**, from Colfax north | **High.** Unmistakable in the screenshot — a straight vertical band down Broadway, and it is also the city's own CBD boundary. |
| South | **Colfax Avenue** | **High.** The shape's bottom sits on Colfax, with Civic Center and the Art Museum outside it. |
| West / south-west | **Speer Blvd / the Platte** | **High.** The band's west side runs the Cherry Creek–Speer diagonal past Union Station. |
| North-east | the city's CBD/Union Station line (≈ **20th St**, then north-west along the rail corridor) | **Low — this is the one to check.** The screenshot's north edge is the hardest to read, and it is where our line and Veo's are most likely to differ. |

## Landmark check against the screenshot

Every landmark I can positively identify in the screenshot, and whether the
proposed polygon agrees. This is the strongest evidence the shape is right:

| Landmark | Proposed | Screenshot | |
|---|---|---|---|
| Union Station | in | in | ✓ |
| Larimer Square | in | in | ✓ |
| 16th & Champa (the mall) | in | in | ✓ |
| Colorado Convention Center | in | in | ✓ |
| Denver Performing Arts Complex | in | in | ✓ |
| Coors Field | out | out | ✓ |
| Ball Arena | out | out | ✓ |
| Civic Center Park | out | out | ✓ |
| Denver Art Museum | out | out | ✓ |
| State Capitol | out | out | ✓ |
| 20th & Blake | out | out | ✓ |
| RiNo (Larimer & 27th) | out | out | ✓ |

**12 of 12 agree.**

## Where I am most likely wrong

1. **The north-east edge.** Veo's band appears to reach further up Broadway —
   toward 23rd/24th or Park Avenue West — than the city's CBD boundary does,
   which stops around 20th. If so, this proposal is **too small** on that side.
2. **The Platte Valley panhandle.** Union Station's neighbourhood runs
   north-west along the river to 39.7604. I cannot tell from the screenshot
   whether Veo includes that strip. I tried cutting it along 20th Street and
   found the cut does almost nothing (2.24 → 2.17 km²), because 20th extended
   north-west follows the river rather than crossing the strip. Left in.
3. **Being too small is the safer error** and is the direction both of the
   above lean. A rider wrongly warned loses ten seconds; a rider wrongly
   reassured cannot end their trip.

## How this gets applied

`public/rover-zone.geojson` is the only thing that would change — no code.
Either re-run the build script against a different input, or drop a corrected
polygon straight in. The app reads one file.

The uncertainty margin in `src/rover-zone.ts` (currently 150 m either side of
the line, where the verdict becomes "check the Veo app") should shrink if this
is ever replaced with Veo's actual polygon — at that point the line would no
longer be a guess, and the hedge would just be noise.
