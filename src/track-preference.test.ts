// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { savesTracks, setSavesTracks } from "./track-preference.ts";

const KEY = "scooter-fyi-save-tracks";

describe("the standing save-tracks preference", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("defaults ON for a rider who has never touched it", () => {
    // This is the whole safety property of moving it out of the survey: the
    // behaviour a rider had before the move is the behaviour they keep.
    expect(savesTracks()).toBe(true);
  });

  it("round-trips both answers", () => {
    setSavesTracks(false);
    expect(savesTracks()).toBe(false);
    setSavesTracks(true);
    expect(savesTracks()).toBe(true);
  });

  it("persists OFF across a reload, which is the point of it", () => {
    setSavesTracks(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    // A fresh read, as a new page load would do.
    expect(savesTracks()).toBe(false);
  });

  it("treats a value it did not write as unset rather than as OFF", () => {
    // Another tab, a corrupted profile, a future format. Anything we cannot
    // read as a deliberate "off" is not one, and defaulting a data-collection
    // preference to ON on garbage is the wrong direction — but it matches
    // never-set, which is the honest reading of "we have no answer".
    localStorage.setItem(KEY, "yes-please");
    expect(savesTracks()).toBe(true);
  });

  it("survives storage that throws, in both directions", () => {
    // Safari private mode. A preference read must never be what breaks a ride.
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("denied");
      });
    expect(savesTracks()).toBe(true);
    get.mockRestore();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied");
    });
    expect(() => setSavesTracks(false)).not.toThrow();
  });
});
