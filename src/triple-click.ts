// The triple-click/triple-tap convention: on the map, three quick clicks on
// the SAME thing means "tell me exactly what this is".
//
// It exists because the obvious gestures were already taken. A single click
// on a hexagon must stay free — the region choropleth and the area filter
// both act on plain clicks, and hex fills sit under the device layers, so
// hijacking one click would fight them. A double-click is the map's zoom.
// Three deliberate clicks are unambiguous, and nothing else on the map wants
// them.
//
// This module owns only the recognizer, keyed and clock-injected so it can
// be tested as pure logic. Who reacts to a recognized triple — the territory
// leaderboard, the hex-metric readout — is `hexdensity.ts`'s business.

/** How long a click stays "part of the current run". Measured between
 *  CONSECUTIVE clicks, not from the first: a slow-but-steady triple still
 *  counts, and an idle pause ends the run rather than letting a click from a
 *  minute ago combine with two fresh ones. 600 ms is a shade more generous
 *  than the platform double-click default, since the third click of a triple
 *  is reliably the slowest. */
export const TRIPLE_CLICK_WINDOW_MS = 600;

/** How many clicks make a triple. Named rather than inlined because the
 *  copy that teaches the gesture reads it. */
export const TRIPLE_CLICK_COUNT = 3;

export interface TripleClickDetector<K> {
  /** Feed one click. Returns true exactly on the third consecutive click on
   *  the same `key` within the window, and resets, so a run of six clicks
   *  fires twice rather than firing on every click after the third. */
  register(key: K, now?: number): boolean;
  /** Forget the in-progress run — e.g. when the layer's data changed under
   *  the pointer and a half-finished run would resolve to a stale target. */
  reset(): void;
  /** Clicks recorded so far in the current run. Exposed for tests and for
   *  callers that want to suppress the map's own double-click zoom while a
   *  run is in progress. */
  count(): number;
}

/** `now` is injected (defaulting to `Date.now()`) rather than read from a
 *  timer so the window logic is testable without fake timers. */
export function createTripleClickDetector<K>(
  windowMs: number = TRIPLE_CLICK_WINDOW_MS,
  requiredCount: number = TRIPLE_CLICK_COUNT,
): TripleClickDetector<K> {
  let lastKey: K | null = null;
  let lastAt = 0;
  let count = 0;
  return {
    count: () => count,
    reset(): void {
      lastKey = null;
      count = 0;
    },
    register(key: K, now: number = Date.now()): boolean {
      const continues =
        count > 0 && lastKey === key && now - lastAt <= windowMs;
      count = continues ? count + 1 : 1;
      lastKey = key;
      lastAt = now;
      if (count < requiredCount) return false;
      // Reset rather than letting the count run on: six clicks should read
      // as two triples, and leaving `count` above the threshold would fire
      // on every subsequent click.
      count = 0;
      lastKey = null;
      return true;
    },
  };
}
