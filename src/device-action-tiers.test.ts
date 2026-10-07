// §12.5. The point of this file is that the assertions are over a TABLE, not
// per button: §12.1(d)'s finding was not that any one gate was wrong, it was
// that four separately-reasonable gates added up to a pattern nobody chose —
// the cheap actions gated and the expensive ones not. A per-button test would
// have passed throughout.
import { describe, expect, it } from "vitest";

import {
  ACTION_RULES,
  AT_THE_VEHICLE_M,
  IN_REACH_M,
  actionsInTier,
  formatDistance,
  gate,
  radiusFor,
  type DeviceAction,
  type GateContext,
} from "./device-action-tiers.ts";

const ALL = Object.keys(ACTION_RULES) as DeviceAction[];

function ctx(over: Partial<GateContext> = {}): GateContext {
  return { distanceMeters: 10, signedIn: true, admin: false, ...over };
}

describe("every action declares a tier", () => {
  it("covers the whole card, with no action left undeclared", () => {
    // Exhaustive by construction — `Record<DeviceAction, ActionRule>` makes a
    // missing rule a type error. This asserts the set is not empty and that
    // nothing silently got a tier outside the three.
    expect(ALL.length).toBeGreaterThan(0);
    for (const a of ALL) {
      expect(["anywhere", "in_reach", "at_the_vehicle"]).toContain(
        ACTION_RULES[a].tier,
      );
    }
  });

  it("gives every sign-in-requiring action its own sentence", () => {
    // "Sign in to do this" is useless; the existing sentences are good and the
    // generic fallback must never be what a rider actually sees.
    for (const a of ALL) {
      if (ACTION_RULES[a].requiresSignIn) {
        expect(ACTION_RULES[a].signInHint, a).toBeTruthy();
      }
    }
  });
});

describe("there is exactly one at_the_vehicle radius", () => {
  it("and it is the unlock's own 75 m", () => {
    // Asserted against the constant so a second radius cannot be introduced
    // quietly — which is precisely what happened before: reports ran at 100 m
    // and the unlock at 75 m for the same "I can see this vehicle" claim.
    expect(AT_THE_VEHICLE_M).toBe(75);
    expect(radiusFor("at_the_vehicle")).toBe(AT_THE_VEHICLE_M);
    const radii = new Set(actionsInTier("at_the_vehicle").map(() => radiusFor("at_the_vehicle")));
    expect(radii.size).toBe(1);
  });

  it("puts every claim about this vehicle in that tier", () => {
    // The tier's definition: any claim about condition, position or equipment,
    // and the unlock. Named individually because each of these was its own
    // decision once, and two of them had no radius at all.
    expect(actionsInTier("at_the_vehicle").sort()).toEqual(
      [
        "confirm_features",
        "open_in_veo",
        "report_device",
        "report_parking",
        "take_photo",
      ].sort(),
    );
  });

  it("leaves reading and local acts ungated", () => {
    expect(actionsInTier("anywhere").sort()).toEqual(
      ["details", "dibs", "show_photos"].sort(),
    );
    expect(radiusFor("anywhere")).toBeNull();
  });

  it("keeps the walk's own looser radius, which is the whole point of in_reach", () => {
    // "I'll ride this one" starts a WALK. Under the tight radius the walk
    // feature was reachable only from the one place you would never need it.
    expect(actionsInTier("in_reach")).toEqual(["ride"]);
    expect(IN_REACH_M).toBe(1125);
    expect(IN_REACH_M).toBeGreaterThan(AT_THE_VEHICLE_M);
  });
});

describe("the two actions that used to be ungated", () => {
  it("refuses a photo beyond 75 m, with a sentence", () => {
    const far = gate("take_photo", ctx({ distanceMeters: 400 }));
    expect(far.allowed).toBe(false);
    if (far.allowed) return;
    expect(far.reason).toContain("too far away");
    // The distance is in the sentence: "too far away" with no figure leaves the
    // rider guessing whether to walk ten steps or ten minutes.
    expect(far.reason).toMatch(/\d/);
    expect(gate("take_photo", ctx({ distanceMeters: 74 })).allowed).toBe(true);
  });

  it("refuses a feature claim beyond 75 m", () => {
    // A rider could previously assert a basket onto a scooter in another
    // neighbourhood.
    expect(gate("confirm_features", ctx({ distanceMeters: 400 })).allowed).toBe(false);
    expect(gate("confirm_features", ctx({ distanceMeters: 10 })).allowed).toBe(true);
  });

  it("still lets anyone LOOK at photos from anywhere", () => {
    // Deliberately not symmetric with uploading.
    expect(gate("show_photos", ctx({ distanceMeters: 50_000 })).allowed).toBe(true);
  });
});

describe("admins", () => {
  it("are exempt from proximity, because the gate is a credibility check", () => {
    // Every report is built from the DEVICE's coordinates, never the
    // reporter's, so a distant admin files exactly the same report.
    for (const a of actionsInTier("at_the_vehicle")) {
      expect(gate(a, ctx({ distanceMeters: 50_000, admin: true })).allowed, a).toBe(true);
    }
    expect(gate("ride", ctx({ distanceMeters: 50_000, admin: true })).allowed).toBe(true);
  });

  it("are exempt from proximity with no fix at all", () => {
    for (const a of actionsInTier("at_the_vehicle")) {
      expect(gate(a, ctx({ distanceMeters: null, admin: true })).allowed, a).toBe(true);
    }
  });

  it("are NEVER exempt from sign-in, which the endpoint enforces anyway", () => {
    // Checked before proximity on purpose: letting a signed-out admin past
    // would have them learn the rule from a 401 instead of from a sentence.
    const g = gate("take_photo", ctx({ signedIn: false, admin: true, distanceMeters: 1 }));
    expect(g.allowed).toBe(false);
    if (g.allowed) return;
    expect(g.reason).toContain("Sign in");
  });
});

describe("no fix is its own answer, not 'too far'", () => {
  it("says to turn location on rather than asserting a distance we cannot see", () => {
    const g = gate("report_device", ctx({ distanceMeters: null }));
    expect(g.allowed).toBe(false);
    if (g.allowed) return;
    expect(g.reason).toContain("location");
    expect(g.reason).not.toContain("too far");
  });

  it("gives the walk tier its own wording, since 'somebody who was there' is not its reason", () => {
    const g = gate("ride", ctx({ distanceMeters: null }));
    expect(g.allowed).toBe(false);
    if (g.allowed) return;
    expect(g.reason).toContain("location");
    expect(g.reason).not.toContain("was there");
  });

  it("never blocks an anywhere action for want of a fix", () => {
    for (const a of actionsInTier("anywhere")) {
      expect(gate(a, ctx({ distanceMeters: null })).allowed, a).toBe(true);
    }
  });
});

describe("every blocked gate carries a sentence", () => {
  it("across every action and every way of being blocked", () => {
    // §12.4's rule: blocked is a sentence, never a dead grey button. A gate
    // that returns `allowed: false` with nothing to say cannot satisfy it.
    const situations: GateContext[] = [
      ctx({ distanceMeters: null, signedIn: false }),
      ctx({ distanceMeters: null, signedIn: true }),
      ctx({ distanceMeters: 50_000, signedIn: false }),
      ctx({ distanceMeters: 50_000, signedIn: true }),
      ctx({ distanceMeters: 0, signedIn: false }),
    ];
    for (const a of ALL) {
      for (const where of situations) {
        const g = gate(a, where);
        if (!g.allowed) {
          expect(g.reason.trim().length, `${a} / ${JSON.stringify(where)}`).toBeGreaterThan(10);
        }
      }
    }
  });
});

describe("the sentences §12.4 says are already good are kept", () => {
  it("substitutes the distance into every tooFarHint rather than leaving a token", () => {
    // A template that never gets substituted renders "{distance}" to the rider,
    // which is worse than no figure at all.
    for (const a of ALL) {
      const g = gate(a, ctx({ distanceMeters: 50_000 }));
      if (!g.allowed) expect(g.reason, a).not.toContain("{distance}");
    }
  });

  it("every at_the_vehicle action's refusal names the distance", () => {
    for (const a of actionsInTier("at_the_vehicle")) {
      const g = gate(a, ctx({ distanceMeters: 50_000 }));
      expect(g.allowed, a).toBe(false);
      if (g.allowed) continue;
      expect(g.reason, a).toMatch(/\d/);
    }
  });

  it("keeps the unlock's own words, which are not a report's", () => {
    const g = gate("open_in_veo", ctx({ distanceMeters: 400 }));
    if (g.allowed) throw new Error("expected blocked");
    expect(g.reason).toContain("too far away, sorry");
    // It is not a claim about the scooter, so it must not borrow that wording.
    expect(g.reason).not.toContain("riders at the scooter");
  });
});

describe("formatDistance", () => {
  it("uses feet up close and miles far away, like the rest of the card", () => {
    expect(formatDistance(30)).toBe("100 ft");
    expect(formatDistance(1609.344)).toBe("1.0 mi");
  });

  it("switches at a quarter mile", () => {
    expect(formatDistance(401)).toMatch(/ft$/);
    expect(formatDistance(403)).toMatch(/mi$/);
  });
});
