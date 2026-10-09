// The claim clocks, shared by the Tools drawer's dibs rows (`tools-mine.ts`).
//
// This file used to own the "My dibs" section itself. That list merged with
// Watched scooters into one row-per-scooter list on 2026-10-09 (see
// `tools-mine.ts`), and what is left here is the part both surfaces of a claim
// agree on: how its countdown reads, and which deadline it counts down to.

import { dibsMsLeft, DIBS_START_GRACE_MS, type Dibs } from "./dibs.ts";

/** "4:07", or "0:09" — mm:ss, because a countdown a rider is racing is read
 *  as a clock and not as a quantity. Never negative: an expired claim is
 *  removed rather than shown counting down past zero. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** What the clock on this row is counting DOWN to.
 *
 *  Two different deadlines, and which one matters changes as the rider walks:
 *  before they set off it is the ten-minute grace (the one they can still
 *  lose the claim to), and after it is the claim's own expiry. Showing both
 *  would be two countdowns competing for one glance — the same call the
 *  arrival panel already makes. */
export function countdownFor(
  d: Dibs,
  now: number,
): { ms: number; label: string; urgent: boolean } {
  if (d.startedWalkingAt === null) {
    const ms = Math.max(0, d.claimedAt + DIBS_START_GRACE_MS - now);
    return { ms, label: "to set off", urgent: ms <= 3 * 60_000 };
  }
  const ms = dibsMsLeft(d, now);
  return { ms, label: "left", urgent: ms <= 5 * 60_000 };
}
