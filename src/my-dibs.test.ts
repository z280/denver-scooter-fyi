import { describe, expect, it } from "vitest";

import { countdownFor, formatCountdown } from "./my-dibs.ts";
import { DIBS_START_GRACE_MS, type Dibs } from "./dibs.ts";

const T0 = 1_770_000_000_000;

function claim(over: Partial<Dibs> = {}): Dibs {
  return {
    vehicleIdentifier: "aaaa1111bbbb2222",
    vehicleName: "Lunar 🐸 928",
    claimedBy: "Resourceful 🌈",
    claimedAt: T0,
    startedWalkingAt: null,
    // REGISTERED, which is the ordinary state of a claim this panel lists —
    // and the state the release hook needs, since a claim with no server row
    // has no id to release by (`registerClaim` covers that case instead).
    registration: { id: "reg-1", verifyUrl: "https://v", qrUrl: "https://q" },
    // `isValid` (dibs.ts) requires all four of these to be finite numbers —
    // a fixture without them is silently dropped by `loadDibs`, which is
    // exactly what the first version of this file discovered.
    lat: 39.7392,
    lon: -104.9903,
    startMeters: 300,
    bestMeters: 300,
    ...over,
  } as Dibs;
}

describe("the countdown", () => {
  it("reads as a clock, not a quantity", () => {
    expect(formatCountdown(247_000)).toBe("4:07");
    expect(formatCountdown(9_000)).toBe("0:09");
  });

  it("never counts past zero", () => {
    // An expired claim is removed, not shown running backwards.
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  it("counts the GRACE before the rider sets off", () => {
    // The deadline they can still lose the claim to is the ten minutes to
    // start moving — not the claim's own expiry, which is further away and
    // not the thing about to hurt them.
    const { label, ms } = countdownFor(claim(), T0 + 60_000);
    expect(label).toBe("to set off");
    expect(ms).toBe(DIBS_START_GRACE_MS - 60_000);
  });

  it("switches to the claim's own expiry once they are walking", () => {
    const { label } = countdownFor(
      claim({ startedWalkingAt: T0 + 30_000 }),
      T0 + 60_000,
    );
    expect(label).toBe("left");
  });

  it("marks the last three minutes of grace urgent", () => {
    const calm = countdownFor(claim(), T0 + 5 * 60_000);
    const late = countdownFor(claim(), T0 + 8 * 60_000);
    expect(calm.urgent).toBe(false);
    expect(late.urgent).toBe(true);
  });
});
