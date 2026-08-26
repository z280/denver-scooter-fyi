// The trip a rider described on the home bar, handed to whichever flow they
// chose — held here rather than threaded through six call sites.
//
// WHY NOT THE RIDE SESSION. `ride-session.ts` is the persisted document for a
// ride that is actually happening. This is the intent BEFORE one exists: a
// destination and an answer to "need wheels or got my own", captured while
// the rider is still looking at the map. Writing it into the session would
// mean opening a ride to record that someone typed an address.
//
// DELIBERATELY NOT PERSISTED. An intent is worth seconds, not days. A
// destination typed yesterday silently steering today's ride is the kind of
// bug nobody reports and everybody feels — favorites are how a place gets
// remembered on purpose (`favorites.ts`), and this is not that.

export type TripWheels = "need" | "own";

export interface TripPlace {
  label: string;
  lat: number;
  lon: number;
}

export interface PendingTrip {
  dest: TripPlace;
  /** "need" = find me a vehicle; "own" = I have my own wheels. There is no
   *  third value and no default — the home bar will not hand over a trip
   *  until the rider has said which, because guessing wrong sends an NIU
   *  owner shopping for a scooter, or a scooter-less rider straight to
   *  turn-by-turn from nowhere. */
  wheels: TripWheels;
  /** Where the ride starts, when the rider named it rather than letting GPS
   *  answer. Null means "wherever I am", which is the normal case. */
  start: TripPlace | null;
}

let pending: PendingTrip | null = null;

/** Announced on every change, so surfaces that depend on there BEING a trip
 *  can re-read rather than be told by each writer individually.
 *
 *  The "can get me there" filter is the first such surface: it is a claim
 *  about a specific destination, so its control has to appear and disappear
 *  with one. Three functions here set `pending`, and wiring each of them to
 *  each listener is how one of them eventually gets missed. */
function announce(): void {
  try {
    window.dispatchEvent(new Event("scooter:trip-changed"));
  } catch {
    /* no window (tests, SSR) — the value is still correct for a direct read */
  }
}

export function setPendingTrip(trip: PendingTrip): void {
  pending = trip;
  announce();
}

/** Read WITHOUT consuming — for a caller that needs to know a trip is waiting
 *  but is not the one about to act on it. */
export function peekPendingTrip(): PendingTrip | null {
  return pending;
}

/** Read and consume. One-shot on purpose: the flow that picks this up owns
 *  it, and a leftover intent quietly steering some later, unrelated ride is
 *  exactly the failure this clearing prevents. */
export function takePendingTrip(): PendingTrip | null {
  const trip = pending;
  pending = null;
  announce();
  return trip;
}

export function clearPendingTrip(): void {
  pending = null;
  announce();
}
