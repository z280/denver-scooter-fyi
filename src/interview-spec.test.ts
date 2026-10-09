// The assertion that matters most here is that the answer ARRIVES. The bug
// being fixed was not a bad ranking — it was an answer that reached
// `recommend.ts` and never reached the planner, so a rider asked for a Cosmo
// and got plans built as if they had said nothing.
import { describe, expect, it } from "vitest";

import {
  GOOD_SHAPE_QUALITY,
  NEAREST_WALK_MINUTES,
  applyInterview,
  interviewNote,
} from "./interview-spec.ts";
import { defaultSpec, type RideSpec } from "./ride-spec.ts";

const label = (k: string): string => k.toUpperCase();

const spec = (over: Partial<RideSpec> = {}): RideSpec => ({
  ...defaultSpec(),
  ...over,
});

describe("the answer reaches the search", () => {
  it("narrows the model when the rider asked for a type", () => {
    const out = applyInterview(spec(), { priority: "type", typeChoice: "cosmo" });
    expect(out.models).toEqual(["cosmo"]);
  });

  it("tightens the quality floor when the rider asked for condition", () => {
    const out = applyInterview(spec(), { priority: "quality", typeChoice: "cosmo" });
    expect(out.minQuality).toBe(GOOD_SHAPE_QUALITY);
  });

  it("shortens the walk when the rider asked for the nearest", () => {
    const out = applyInterview(spec(), { priority: "distance", typeChoice: "cosmo" });
    expect(out.maxWalkMinutes).toBe(NEAREST_WALK_MINUTES);
  });

  it("is a no-op with no answer, so a caller can apply it unconditionally", () => {
    const base = spec({ minBattery: 40 });
    expect(applyInterview(base, null)).toBe(base);
  });
});

describe("it narrows and never widens", () => {
  it("keeps a battery floor the rider set themselves", () => {
    // The interview is one question asked in a hurry; "My ideal scooter" is a
    // sheet they sat down and filled in. The hurried answer must not throw the
    // considered one away.
    const out = applyInterview(spec({ minBattery: 40 }), {
      priority: "distance",
      typeChoice: "cosmo",
    });
    expect(out.minBattery).toBe(40);
  });

  it("does not talk a stricter quality floor back down", () => {
    const out = applyInterview(spec({ minQuality: "ok-only" }), {
      priority: "quality",
      typeChoice: "cosmo",
    });
    expect(out.minQuality).toBe("ok-only");
  });

  it("does not lengthen a walk cap the rider had already shortened", () => {
    const out = applyInterview(spec({ maxWalkMinutes: 3 }), {
      priority: "distance",
      typeChoice: "cosmo",
    });
    expect(out.maxWalkMinutes).toBe(3);
  });

  it("intersects with a saved model list rather than replacing it", () => {
    const out = applyInterview(spec({ models: ["astro", "cosmo"] }), {
      priority: "type",
      typeChoice: "cosmo",
    });
    expect(out.models).toEqual(["cosmo"]);
  });

  it("treats a null model list as any, not as all four", () => {
    // `null` admits a model that joins the fleet later, so intersecting with it
    // is the wanted model alone — not a filter over a list that does not exist.
    const out = applyInterview(spec({ models: null }), {
      priority: "type",
      typeChoice: "trike",
    });
    expect(out.models).toEqual(["trike"]);
  });

  it("keeps an impossible intersection rather than picking a side", () => {
    // Asked for two things at once. Dropping either side hands the rider a
    // vehicle failing a requirement they stated — and because this is a
    // PREFERENCE, the relaxation ladder still finds them plans.
    const out = applyInterview(spec({ models: ["astro"] }), {
      priority: "type",
      typeChoice: "cosmo",
    });
    expect(out.models).toEqual([]);
  });

  it("never adds a hard requirement", () => {
    // The interview has no way to say "or else show me nothing". Everything it
    // produces must be relaxable, or a hurried answer could empty the list.
    for (const priority of ["type", "quality", "distance"] as const) {
      const out = applyInterview(spec(), { priority, typeChoice: "cosmo" });
      expect(out.must).toEqual([]);
      expect(out.everyLeg ?? []).toEqual([]);
    }
  });

  it("carries the rider's own hard requirements through untouched", () => {
    const base = spec({ models: ["cosmo"], must: ["models"] });
    const out = applyInterview(base, { priority: "quality", typeChoice: "cosmo" });
    expect(out.must).toEqual(["models"]);
  });
});

describe("it does not claim an answer the search gave up", () => {
  it("says the model was not found rather than that it is being shown", () => {
    // These answers are PREFERENCES, so the relaxation ladder can drop them to
    // find anything at all. When it does, "showing Cosmos first" sits directly
    // under the panel's own "we had to give up: Model" and contradicts it — and
    // a rider who reads both learns the app is not keeping track.
    const note = interviewNote(
      spec(),
      { priority: "type", typeChoice: "cosmo" },
      label,
      ["models"],
    );
    expect(note).toContain("No COSMO was close enough");
    expect(note).not.toMatch(/which is what you asked for/);
  });

  it("says the same for a relaxed quality floor", () => {
    const note = interviewNote(
      spec(),
      { priority: "quality", typeChoice: "cosmo" },
      label,
      ["min_quality"],
    );
    expect(note).toContain("next best");
  });

  it("still credits an answer the search kept", () => {
    // Something else was relaxed, not the thing the rider asked for.
    const note = interviewNote(
      spec(),
      { priority: "type", typeChoice: "cosmo" },
      label,
      ["min_battery"],
    );
    expect(note).toContain("which is what you asked for");
  });
});

describe("saying so out loud", () => {
  it("names what the answer did, because the complaint was that it vanished", () => {
    const note = interviewNote(spec(), { priority: "type", typeChoice: "cosmo" }, label);
    expect(note).toContain("COSMO");
  });

  it("says nothing when the answer changed nothing", () => {
    // Claiming credit for a narrowing that did not happen is worse than
    // silence: it tells the rider their input mattered when it did not.
    expect(
      interviewNote(spec({ maxWalkMinutes: 3 }), { priority: "distance", typeChoice: "cosmo" }, label),
    ).toBeNull();
    expect(
      interviewNote(spec({ minQuality: "ok-only" }), { priority: "quality", typeChoice: "cosmo" }, label),
    ).toBeNull();
    expect(interviewNote(spec(), null, label)).toBeNull();
  });

  it("is honest when the answer contradicts the saved spec", () => {
    const note = interviewNote(
      spec({ models: ["astro"] }),
      { priority: "type", typeChoice: "cosmo" },
      label,
    );
    expect(note).toContain("rules out");
  });

  it("reports the walk figure it actually applied", () => {
    const note = interviewNote(spec(), { priority: "distance", typeChoice: "cosmo" }, label);
    expect(note).toContain(String(NEAREST_WALK_MINUTES));
  });
});
