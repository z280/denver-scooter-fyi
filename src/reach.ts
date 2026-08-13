// "Will this one actually get me there?"
//
// The question a rider asks standing on a pavement with a destination in
// mind, and the one the map could never answer: it showed battery percentages
// and left the arithmetic — how far is that in metres, how far is my
// destination, is the road longer than the crow flies — to somebody who is
// late.
//
// TWO TIERS, AND THIS IS THE CHEAP ONE. `/route/options` already returns
// `will_make_it` from the pessimistic end of the battery model's band, but it
// costs a routing call per scooter, and a filter that has to route the whole
// visible fleet is not a filter. Every device already carries
// `current_range_meters` — Veo's own estimate of how far THIS vehicle can go
// on the charge it has — so a usable answer needs no network at all.
//
// IT IS AN ESTIMATE AND MUST BE LABELLED ONE. Two approximations sit in here:
// a straight line stands in for a road, and the operator's range figure
// stands in for the model's. Both are honest enough to filter with and not
// honest enough to promise with, which is why the chip says "can probably
// reach" and the real verdict waits until a scooter is chosen.

/** Roads are longer than the line between their ends.
 *
 *  1.35 is the ratio this codebase has already been living with: rides
 *  recorded as straight lines against the same rides measured from their
 *  donated tracks came out 2,924 m against 3,901 m (1.33) and 2,903 m against
 *  3,425 m (1.18) — and those are Denver's grid, which is kinder than most.
 *  Rounded up rather than averaged: under-estimating the road strands
 *  somebody, over-estimating only hides a scooter that might have made it. */
export const DETOUR_FACTOR = 1.35;

/** Charge that must still be there on arrival, as a fraction of range.
 *
 *  Mirrors the backend's `ARRIVAL_RESERVE_PERCENT = 10.0` deliberately: two
 *  tiers of the same question should not disagree about what "made it" means,
 *  and a map chip that says yes where the route screen says no is worse than
 *  no chip. */
export const RESERVE_FRACTION = 0.10;

export interface ReachInput {
  /** Veo's own range estimate for this vehicle, in metres. */
  rangeMeters: number | null | undefined;
  /** Where the scooter is. */
  scooter: { lat: number; lng: number };
  /** Where the rider is going. */
  dest: { lat: number; lon: number };
}

export type ReachVerdict = "yes" | "no" | "unknown";

const METERS_PER_DEG_LAT = 111_320;

/** Flat-earth metres between two points — the same approximation the rest of
 *  this codebase uses at Denver scales, kept rather than introducing a second
 *  distance primitive that could disagree with the first at the margins. */
export function straightLineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lon: number },
): number {
  const dLat = (a.lat - b.lat) * METERS_PER_DEG_LAT;
  const dLon =
    (a.lng - b.lon) * METERS_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** Estimated road distance from a scooter to a destination. Exported because
 *  the chip's tooltip quotes it, and a number a rider is shown should come
 *  from the same place the verdict did. */
export function estimatedRideMeters(input: ReachInput): number {
  return straightLineMeters(input.scooter, input.dest) * DETOUR_FACTOR;
}

/** Can this scooter probably get the rider to their destination?
 *
 *  "unknown" is a real answer and not a failure: a vehicle the feed has given
 *  no range for is not a vehicle that cannot make it, and quietly filtering
 *  those out would hide working scooters on the strength of a missing field.
 *  The caller shows them plainly rather than guessing.
 */
export function canReach(input: ReachInput): ReachVerdict {
  const range = input.rangeMeters;
  if (range === null || range === undefined || !Number.isFinite(range)) {
    return "unknown";
  }
  const needed = estimatedRideMeters(input);
  return range * (1 - RESERVE_FRACTION) >= needed ? "yes" : "no";
}


/** Roughly what charge would be left on arrival, as a percentage.
 *
 *  Proportional, not modelled: if the trip eats a third of the vehicle's
 *  remaining range, it eats about a third of its remaining charge. That holds
 *  because `current_range_meters` is Veo's own projection FROM the current
 *  charge — the two move together by construction.
 *
 *  What it deliberately is NOT is the battery model's answer. That one is
 *  fitted from real observations, accounts for elevation and temperature, and
 *  comes back with a band; it lives behind `/route/options` and arrives once
 *  a scooter is chosen. This exists so the card can say something useful
 *  before that call has been paid for, and it rounds to the nearest 5 so it
 *  cannot masquerade as precision it does not have.
 */
export function estimatedArrivalPercent(
  input: ReachInput & { batteryPercent: number | null | undefined },
): number | null {
  const { rangeMeters, batteryPercent } = input;
  if (
    rangeMeters === null || rangeMeters === undefined || !Number.isFinite(rangeMeters) ||
    rangeMeters <= 0 ||
    batteryPercent === null || batteryPercent === undefined || !Number.isFinite(batteryPercent)
  ) {
    return null;
  }
  const spentFraction = Math.min(1, estimatedRideMeters(input) / rangeMeters);
  const left = batteryPercent * (1 - spentFraction);
  return Math.max(0, Math.round(left / 5) * 5);
}
