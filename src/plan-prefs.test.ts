// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HAND_OFF_CAP,
  HAND_OFF_CAP_OPTIONS,
  MAX_HAND_OFFS_KEY,
  allowsPlan,
  capNote,
  capPlans,
  handOffCap,
  setHandOffCap,
} from "./plan-prefs.ts";

const row = (handOffs: number) => ({ plan: { handOffs } });

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("the stored cap", () => {
  it("defaults to no cap — nobody opens this setting to turn hand-offs ON", () => {
    expect(handOffCap()).toBe(DEFAULT_HAND_OFF_CAP);
    expect(DEFAULT_HAND_OFF_CAP).toBeNull();
  });

  it("round-trips every answer the ladder offers", () => {
    for (const option of HAND_OFF_CAP_OPTIONS) {
      expect(setHandOffCap(option.value)).toBe(true);
      expect(handOffCap()).toBe(option.value);
    }
  });

  it("falls back to the default for anything it does not recognise", () => {
    // Including a value written by a build that offered a different ladder.
    for (const raw of ["", "2", "yes", "null", "{}"]) {
      localStorage.setItem(MAX_HAND_OFFS_KEY, raw);
      expect(handOffCap()).toBe(DEFAULT_HAND_OFF_CAP);
    }
  });
});

describe("applying the cap", () => {
  it("keeps everything when there is no cap", () => {
    const rows = [row(0), row(1), row(2)];
    expect(capPlans(rows, null)).toEqual({ kept: rows, hidden: 0 });
  });

  it("'one scooter only' leaves the hand-off plans out and counts them", () => {
    const { kept, hidden } = capPlans([row(0), row(1), row(2)], 0);
    expect(kept).toEqual([row(0)]);
    expect(hidden).toBe(2);
  });

  it("'at most one switch' admits one and refuses two", () => {
    const { kept, hidden } = capPlans([row(0), row(1), row(2)], 1);
    expect(kept).toEqual([row(0), row(1)]);
    expect(hidden).toBe(1);
  });

  it("keeps the planner's order", () => {
    const a = row(1);
    const b = row(0);
    const c = row(1);
    expect(capPlans([a, b, c], 1).kept).toEqual([a, b, c]);
  });

  it("never filters a plan with no hand-offs, whatever the cap", () => {
    // The walk-only row has none by construction: a rider who will not switch
    // scooters still gets told they could walk it.
    expect(allowsPlan({ handOffs: 0 }, 0)).toBe(true);
  });
});

describe("what the rider is told", () => {
  it("names the setting, not just the count", () => {
    // The complaint it answers is "why am I not being shown the cheap one",
    // and "2 plans hidden" alone does not answer it.
    expect(capNote(2, 0)).toBe(
      "2 plans hidden: you've asked us not to plan trips with switching scooters.",
    );
    expect(capNote(1, 1)).toBe(
      "1 plan hidden: you've asked us not to plan trips with more than one scooter switch.",
    );
  });

  it("says nothing when nothing was hidden, or when there is no cap", () => {
    expect(capNote(0, 0)).toBeNull();
    expect(capNote(3, null)).toBeNull();
  });
});
