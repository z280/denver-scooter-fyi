// Watching the scooter a rider has claimed, so they hear about losing it from
// us rather than from a bare patch of pavement.
//
// THE FAILURE THIS EXISTS FOR. A rider picks a scooter three blocks away and
// starts walking. Somebody standing next to it unlocks it. Today the app says
// nothing: the walk line keeps pointing at a scooter that is gone, the arrival
// panel keeps counting down to it, and the rider finds out on arrival. Every
// second between "it went" and "you know it went" is a second spent walking
// the wrong way.
//
// TWO WAYS A SCOOTER GOES, AND WE WATCH BOTH.
//
//   OFFICIALLY   Veo's own feed says so. On this operator that means the
//                vehicle turns up `is_reserved` — which on Veo means IN USE,
//                not held (see the GBFS notes) — or stops being rentable, or
//                drops out of the feed entirely.
//   UNOFFICIALLY   the feed still lists it and it is not really there: the
//                app's own signals say otherwise, and a rider walking to a
//                scooter deserves that hint as much as the official one.
//
// Both resolve to the same question — is this still worth walking to — so
// they resolve to the same alert, with the reason attached.

export type DeviceGoneReason =
  /** Veo says it is in use. */
  | "in_use"
  /** Veo still lists it but will not rent it. */
  | "not_rentable"
  /** It stopped appearing in the feed at all. */
  | "vanished"
  /** Our own signals, not Veo's — reports, failed starts, a reliability
   *  collapse. Named separately because the confidence is different and the
   *  wording a rider sees should be too. */
  | "unofficial";

export interface DeviceSnapshot {
  vehicleIdentifier: string;
  /** Veo's `is_reserved`: IN USE on this operator, not a held booking. */
  inUse: boolean;
  rentable: boolean;
  /** False when the app's own signals say this is not really rideable, even
   *  though the feed still offers it. */
  looksRideable: boolean;
}

export interface DeviceWatchDeps {
  /** The live feed, however the caller has it. Called on every refresh tick;
   *  returning undefined means "not in this response", which is only treated
   *  as gone after MISSING_TICKS_BEFORE_GONE — see below. */
  lookup(vehicleIdentifier: string): DeviceSnapshot | undefined;
  /** Subscribe to refresh ticks. Returns an unsubscribe function. */
  onRefresh(cb: () => void): () => void;
  onGone(reason: DeviceGoneReason): void;
}

export interface DeviceWatchHandle {
  stop(): void;
}

/** A vehicle missing from ONE response is not a vehicle that is gone.
 *
 *  GBFS feeds drop and re-add vehicles between polls for reasons that have
 *  nothing to do with anybody riding them — a partial upstream response, a
 *  vehicle at the edge of a bbox, a sampling gap. Alarming a rider off a
 *  single absence would cry wolf often enough that they stop believing the
 *  alert, which costs more than the seconds it saves. Two consecutive misses
 *  is roughly four minutes on a two-minute poll: fast enough to turn around,
 *  slow enough to be true. */
export const MISSING_TICKS_BEFORE_GONE = 2;

export function watchDevice(
  vehicleIdentifier: string,
  deps: DeviceWatchDeps,
): DeviceWatchHandle {
  let stopped = false;
  let fired = false;
  let missing = 0;

  const gone = (reason: DeviceGoneReason): void => {
    // Once only. The rider is told the scooter went; telling them again on
    // every subsequent tick is noise, and the decision it prompts has already
    // been put in front of them.
    if (fired || stopped) return;
    fired = true;
    deps.onGone(reason);
  };

  const check = (): void => {
    if (stopped || fired) return;
    const snap = deps.lookup(vehicleIdentifier);
    if (!snap) {
      missing += 1;
      if (missing >= MISSING_TICKS_BEFORE_GONE) gone("vanished");
      return;
    }
    missing = 0;
    // Order matters: the most specific, most confident reason wins, so the
    // rider is told what actually happened rather than the vaguest true thing.
    if (snap.inUse) return gone("in_use");
    if (!snap.rentable) return gone("not_rentable");
    if (!snap.looksRideable) return gone("unofficial");
  };

  const off = deps.onRefresh(check);
  // Check immediately: the scooter may already have gone between the rider
  // choosing it and this watcher starting.
  check();

  return {
    stop() {
      stopped = true;
      off();
    },
  };
}

/** What to tell the rider. Short, specific, and never blaming them.
 *
 *  The unofficial case is worded as doubt rather than fact, because that is
 *  what it is — our own signals, not the operator's. Overstating it would
 *  spend the trust the official cases need. */
export function goneMessage(name: string, reason: DeviceGoneReason): string {
  switch (reason) {
    case "in_use":
      return `Someone just took ${name}.`;
    case "not_rentable":
      return `${name} stopped accepting rentals.`;
    case "vanished":
      return `${name} dropped off the map.`;
    case "unofficial":
      return `${name} may not be rideable any more.`;
  }
}
