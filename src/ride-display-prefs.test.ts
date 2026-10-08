import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COST_HUD,
  DEFAULT_SPEEDOMETER,
  SPEEDOMETER_STYLES,
  setShowsCostHud,
  setSpeedometerStyle,
  showsCostHud,
  speedometerStyle,
} from "./ride-display-prefs.ts";

const fakeStorage = () => {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speedometer style", () => {
  it("defaults to the style the HUD has always shipped", () => {
    expect(speedometerStyle()).toBe("classic");
    expect(DEFAULT_SPEEDOMETER).toBe("classic");
  });

  it("round-trips each of the three styles", () => {
    for (const style of SPEEDOMETER_STYLES) {
      expect(setSpeedometerStyle(style.value)).toBe(true);
      expect(speedometerStyle()).toBe(style.value);
    }
  });

  it("reads a value it does not recognise as no answer at all", () => {
    // Another tab, an older build, a hand-edited profile. Taking a string we
    // cannot parse as a choice would show the rider a screen nobody picked.
    localStorage.setItem("scooter-fyi-speedometer", "analog-only");
    expect(speedometerStyle()).toBe(DEFAULT_SPEEDOMETER);
  });

  it("refuses to store a style that is not one of the three", () => {
    expect(setSpeedometerStyle("hidden" as never)).toBe(false);
    expect(localStorage.getItem("scooter-fyi-speedometer")).toBeNull();
  });

  it("survives storage that throws, in both directions", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    });
    expect(speedometerStyle()).toBe(DEFAULT_SPEEDOMETER);
    // Reported, not swallowed: the caller tells the rider it won't be
    // remembered rather than claiming it saved.
    expect(setSpeedometerStyle("digital")).toBe(false);
  });

  it("describes what each value actually does, including the asymmetry", () => {
    // `ride-hud.ts` derives TWO flags from this one field —
    // `classic === "classic"` and `digital !== "none"` — so "classic" lights
    // both readouts. The labels alone would have a rider believe it is the
    // analog one only, which is why each carries a sentence.
    const byValue = Object.fromEntries(
      SPEEDOMETER_STYLES.map((s) => [s.value, s]),
    );
    expect(byValue.classic.hint).toMatch(/analog/i);
    expect(byValue.classic.hint).toMatch(/digital/i);
    expect(byValue.digital.hint).toMatch(/only/i);
    expect(byValue.none.label).toBe("Hidden");
    for (const style of SPEEDOMETER_STYLES) {
      expect(style.hint.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("cost HUD", () => {
  it("defaults on, matching what defaultRideOptions always shipped", () => {
    expect(showsCostHud()).toBe(true);
    expect(DEFAULT_COST_HUD).toBe(true);
  });

  it("round-trips off and back on", () => {
    expect(setShowsCostHud(false)).toBe(true);
    expect(showsCostHud()).toBe(false);
    expect(setShowsCostHud(true)).toBe(true);
    expect(showsCostHud()).toBe(true);
  });

  it("treats anything but an explicit off as on", () => {
    // Same rule as `savesTracks()`: never written and written-by-something-else
    // are the same state — we have no answer — so both take the default.
    // Reading garbage as "off" would silently hide the one number this app
    // exists to show.
    for (const junk of ["", "false", "no", "{}", "2"]) {
      localStorage.setItem("scooter-fyi-cost-hud", junk);
      expect(showsCostHud()).toBe(true);
    }
    localStorage.setItem("scooter-fyi-cost-hud", "0");
    expect(showsCostHud()).toBe(false);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    });
    expect(showsCostHud()).toBe(DEFAULT_COST_HUD);
    expect(setShowsCostHud(false)).toBe(false);
  });
});
