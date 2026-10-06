// @vitest-environment happy-dom
//
// How often the survey is allowed to ask the long question. See
// `survey-cadence.ts` for why asking it every ride costs more than it collects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SURVEY_COUNT_KEY,
  recordSurveySubmitted,
  resetSurveyCadence,
  shouldAskNps,
  surveysSubmitted,
} from "./survey-cadence.ts";

beforeEach(() => {
  localStorage.clear();
  resetSurveyCadence();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  resetSurveyCadence();
});

describe("shouldAskNps", () => {
  it("asks the first time, then every tenth", () => {
    expect(shouldAskNps(0)).toBe(true);
    for (let n = 1; n < 10; n += 1) expect(shouldAskNps(n)).toBe(false);
    expect(shouldAskNps(10)).toBe(true);
    for (let n = 11; n < 20; n += 1) expect(shouldAskNps(n)).toBe(false);
    expect(shouldAskNps(20)).toBe(true);
  });

  it("asks over the long run about a tenth of the time", () => {
    const asked = Array.from({ length: 100 }, (_, n) => shouldAskNps(n)).filter(
      Boolean,
    ).length;
    expect(asked).toBe(10);
  });

  it("falls toward asking on a nonsense count", () => {
    // A rider who sees one extra question after clearing their site data has
    // lost nothing; a rider silently never asked would cost us the answer.
    expect(shouldAskNps(-1)).toBe(true);
    expect(shouldAskNps(Number.NaN)).toBe(true);
    expect(shouldAskNps(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("the stored count", () => {
  it("starts at zero and counts up", () => {
    expect(surveysSubmitted()).toBe(0);
    expect(recordSurveySubmitted()).toBe(1);
    expect(surveysSubmitted()).toBe(1);
    expect(recordSurveySubmitted()).toBe(2);
    expect(surveysSubmitted()).toBe(2);
  });

  it("persists across a reload", () => {
    recordSurveySubmitted();
    recordSurveySubmitted();
    resetSurveyCadence(); // the session mirror is not what is being tested
    expect(surveysSubmitted()).toBe(2);
  });

  it("reads a corrupt or version-skewed blob as zero rather than throwing", () => {
    for (const raw of [
      "not json",
      "{}",
      '{"v":2,"n":5}',
      '{"v":1}',
      '{"v":1,"n":"many"}',
      '{"v":1,"n":null}',
    ]) {
      localStorage.setItem(SURVEY_COUNT_KEY, raw);
      resetSurveyCadence();
      expect(surveysSubmitted()).toBe(0);
    }
  });

  it("survives storage that throws on every access", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
      removeItem: () => {},
      clear: () => {},
    });
    resetSurveyCadence();
    expect(surveysSubmitted()).toBe(0);
    expect(() => recordSurveySubmitted()).not.toThrow();
  });

  it("keeps counting in memory when writes are refused", () => {
    // Without the mirror a rider in a private window would be stuck at zero and
    // asked the long question after every single ride — exactly what this module
    // exists to stop.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
      clear: () => {},
    });
    resetSurveyCadence();
    expect(recordSurveySubmitted()).toBe(1);
    expect(surveysSubmitted()).toBe(1);
    expect(recordSurveySubmitted()).toBe(2);
    expect(shouldAskNps(surveysSubmitted())).toBe(false);
  });
});
