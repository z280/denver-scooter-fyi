// @vitest-environment happy-dom
//
// §11.2's calibration. Most of these assert a REFUSAL: the feature's whole
// risk is that a bad sample quietly wrecks every estimate afterwards, and the
// rider would experience that as the app being broken rather than as a setting
// to clear.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CALIBRATION_KEY,
  MAX_PLAUSIBLE_GAP_MIN,
  MAX_SAMPLES,
  MIN_SAMPLES,
  calibrationOffsetMinutes,
  calibrationOffsetMs,
  calibrationSentence,
  clearCalibration,
  isPlausible,
  loadSamples,
  denverDay,
  learnFromReceipt,
  matchOurMinutes,
  ourBilledMinutes,
  recordSample,
} from "./cost-calibration.ts";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

/** Veo billed `veo` where we said `ours`. */
const sample = (ours: number, veo: number, atMs = 1) =>
  recordSample({ ourMinutes: ours, veoMinutes: veo, atMs });

describe("what counts as a sample at all", () => {
  it("takes an ordinary pair", () => {
    expect(sample(10, 12)).toHaveLength(1);
  });

  it("refuses a gap no human could produce", () => {
    // Beyond this the likelier explanations are all boring: a receipt matched
    // to the wrong ride, an OCR misread, a reload that lost a start time.
    expect(sample(10, 10 + MAX_PLAUSIBLE_GAP_MIN)).toHaveLength(1);
    localStorage.clear();
    expect(sample(10, 10 + MAX_PLAUSIBLE_GAP_MIN + 1)).toHaveLength(0);
    expect(sample(30, 2)).toHaveLength(0);
  });

  it("refuses figures that are not billed minutes", () => {
    // Veo bills the started minute, so one is the smallest real figure.
    for (const [ours, veo] of [
      [0, 5],
      [5, 0],
      [-3, 5],
      [Number.NaN, 5],
      [5, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(isPlausible(ours, veo)).toBe(false);
      expect(sample(ours, veo)).toHaveLength(0);
    }
  });

  it("keeps only the newest window", () => {
    for (let i = 0; i < MAX_SAMPLES + 3; i += 1) sample(10, 11, i);
    expect(loadSamples()).toHaveLength(MAX_SAMPLES);
    expect(loadSamples()[MAX_SAMPLES - 1].atMs).toBe(MAX_SAMPLES + 2);
  });
});

describe("the offset", () => {
  it("is zero on one sample, however extreme", () => {
    // One receipt is an anecdote, and a rider carrying it into every estimate
    // afterwards would have no idea why.
    sample(5, 14);
    expect(loadSamples()).toHaveLength(1);
    expect(MIN_SAMPLES).toBe(2);
    expect(calibrationOffsetMinutes()).toBe(0);
    expect(calibrationSentence()).toBeNull();
  });

  it("is the median, so one odd ride cannot carry", () => {
    // The ride where the rider got distracted between the scan and the unlock
    // is exactly the sample a mean would keep forever.
    sample(10, 11);
    sample(10, 11);
    sample(10, 21); // +10: plausible, but an outlier
    expect(calibrationOffsetMinutes()).toBe(1);
  });

  it("averages the middle two on an even window", () => {
    sample(10, 11);
    sample(10, 13);
    expect(calibrationOffsetMinutes()).toBe(2);
  });

  it("converts to milliseconds for the pricing call", () => {
    sample(10, 12);
    sample(10, 12);
    expect(calibrationOffsetMs()).toBe(2 * 60_000);
  });

  it("NEVER shortens an estimate, even when we have been running long", () => {
    // An offset that discounted would under-quote a rider against the bill
    // they are about to be charged. Learning we run long stops the figure
    // drifting further; it is never used to take money off.
    sample(12, 10);
    sample(12, 10);
    expect(calibrationOffsetMinutes()).toBe(-2);
    expect(calibrationOffsetMs()).toBe(0);
  });
});

describe("what the rider is told", () => {
  it("says nothing when the median is zero", () => {
    sample(10, 11);
    sample(10, 9);
    expect(calibrationOffsetMinutes()).toBe(0);
    expect(calibrationSentence()).toBeNull();
  });

  it("names the direction in the rider's terms, never ours", () => {
    sample(10, 12);
    sample(10, 12);
    const s = calibrationSentence()!;
    expect(s).toContain("running about 2 minutes short");
    expect(s).toContain("started them there");
    expect(s).not.toMatch(/calibrat|offset|median/i);
  });

  it("says it, but promises nothing, when we have been running long", () => {
    sample(12, 10);
    sample(12, 10);
    const s = calibrationSentence()!;
    expect(s).toContain("2 minutes long");
    expect(s).not.toContain("started them there");
  });

  it("gets the singular right, and a half-minute median", () => {
    sample(10, 11);
    sample(10, 11);
    expect(calibrationSentence()).toContain("about 1 minute short");
    localStorage.clear();
    sample(10, 11);
    sample(10, 12);
    expect(calibrationSentence()).toContain("about 1.5 minutes short");
  });
});

describe("the stored blob is never trusted", () => {
  const put = (raw: string) => localStorage.setItem(CALIBRATION_KEY, raw);

  it("reads garbage, a wrong version and a wrong shape as no samples", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"v":99,"samples":[{"ourMinutes":10,"veoMinutes":12,"atMs":1}]}',
      '{"v":1,"samples":"nope"}',
    ]) {
      put(raw);
      expect(loadSamples()).toEqual([]);
    }
  });

  it("drops an implausible stored sample rather than pricing against it", () => {
    // The gate runs on the way OUT as well as in, so a hand-edited blob
    // cannot put a twenty-minute 'calibration' into every estimate.
    put(
      '{"v":1,"samples":[{"ourMinutes":10,"veoMinutes":12,"atMs":1},' +
        '{"ourMinutes":10,"veoMinutes":90,"atMs":2},' +
        '{"ourMinutes":10,"veoMinutes":12,"atMs":3}]}',
    );
    expect(loadSamples()).toHaveLength(2);
    expect(calibrationOffsetMinutes()).toBe(2);
  });

  it("clears on request", () => {
    sample(10, 12);
    sample(10, 12);
    clearCalibration();
    expect(loadSamples()).toEqual([]);
    expect(calibrationOffsetMs()).toBe(0);
  });
});

describe("matching a receipt to a ride", () => {
  // 2026-07-15 18:00 Denver (UTC-6 in July).
  const JUL15_18 = Date.parse("2026-07-16T00:00:00Z");
  const span = (startMs: number, minutes: number | null) => ({
    startedAtMs: startMs,
    endedAtMs: minutes === null ? null : startMs + minutes * 60_000,
  });

  it("bills the started minute, with a floor of one", () => {
    expect(ourBilledMinutes(span(0, 10))).toBe(10);
    expect(ourBilledMinutes({ startedAtMs: 0, endedAtMs: 1 })).toBe(1);
    expect(ourBilledMinutes({ startedAtMs: 0, endedAtMs: 10 * 60_000 + 1 })).toBe(11);
  });

  it("has no minutes for a ride with no end", () => {
    // "Now minus started" for a row from last week is not a ride length.
    expect(ourBilledMinutes(span(JUL15_18, null))).toBeNull();
    expect(ourBilledMinutes({ startedAtMs: 100, endedAtMs: 0 })).toBeNull();
  });

  it("reads the day in Denver, which is the zone the receipt was printed in", () => {
    // 01:30 UTC on the 16th is still the evening of the 15th in Denver, and a
    // rider reading their receipt from another timezone must not be matched
    // against the wrong day.
    expect(denverDay(Date.parse("2026-07-16T01:30:00Z"))).toBe("2026-07-15");
    expect(denverDay(Date.parse("2026-07-16T07:30:00Z"))).toBe("2026-07-16");
    expect(denverDay(Number.NaN)).toBeNull();
  });

  it("matches the one ride on the receipt's day", () => {
    expect(
      matchOurMinutes(
        [span(JUL15_18, 11), span(JUL15_18 + 5 * 86_400_000, 30)],
        "2026-07-15",
      ),
    ).toBe(11);
  });

  it("REFUSES two rides on the same day rather than guessing", () => {
    // A wrong pairing is exactly the sample that would teach us a four-minute
    // offset from somebody else's trip. Learning nothing is free.
    expect(
      matchOurMinutes(
        [span(JUL15_18, 11), span(JUL15_18 + 3_600_000, 9)],
        "2026-07-15",
      ),
    ).toBeNull();
  });

  it("refuses when nothing was recorded that day", () => {
    expect(matchOurMinutes([span(JUL15_18, 11)], "2026-07-14")).toBeNull();
    expect(matchOurMinutes([], "2026-07-15")).toBeNull();
  });

  it("ignores an unfinished ride when deciding whether the day is ambiguous", () => {
    // A row with no end teaches nothing, so it cannot make the day ambiguous
    // either — otherwise one stuck ride would silence the feature for good.
    expect(
      matchOurMinutes(
        [span(JUL15_18, 11), span(JUL15_18 + 3_600_000, null)],
        "2026-07-15",
      ),
    ).toBe(11);
  });

  it("learns from a matched receipt and reports that it did", () => {
    const took = learnFromReceipt({
      spans: [span(JUL15_18, 11)],
      chargeDate: "2026-07-15",
      veoMinutes: 13,
      atMs: 1,
    });
    expect(took).toBe(true);
    expect(loadSamples()).toEqual([{ ourMinutes: 11, veoMinutes: 13, atMs: 1 }]);
  });

  it("reports honestly when it learned nothing", () => {
    expect(
      learnFromReceipt({
        spans: [span(JUL15_18, 11), span(JUL15_18 + 3_600_000, 9)],
        chargeDate: "2026-07-15",
        veoMinutes: 13,
      }),
    ).toBe(false);
    // An implausible pair is refused too, and says so — even once the window
    // is full, where counting the stored list would report nothing happened.
    for (let i = 0; i < MAX_SAMPLES; i += 1) sample(10, 11, i);
    expect(
      learnFromReceipt({
        spans: [span(JUL15_18, 11)],
        chargeDate: "2026-07-15",
        veoMinutes: 99,
      }),
    ).toBe(false);
    expect(
      learnFromReceipt({
        spans: [span(JUL15_18, 11)],
        chargeDate: "2026-07-15",
        veoMinutes: 12,
      }),
    ).toBe(true);
  });
});
