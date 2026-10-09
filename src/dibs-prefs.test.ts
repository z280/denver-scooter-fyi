import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_DIBS_KEY,
  DIBS_SMS_KEY,
  autoDibs,
  dibsSmsAlerts,
  setAutoDibs,
  setDibsSmsAlerts,
} from "./dibs-prefs.ts";

const fakeStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
});

describe("the defaults, which are the whole design", () => {
  it("claims dibs automatically until told not to", () => {
    // A rider who picked a scooter off a plan and started walking has already
    // expressed the intent dibs records. Asking again is asking twice.
    expect(autoDibs()).toBe(true);
  });

  it("never texts anybody who has not asked for it", () => {
    // An SMS reaches a rider who has put the phone away — the point of it, and
    // the reason it cannot be assumed.
    expect(dibsSmsAlerts()).toBe(false);
  });
});

describe("round trips", () => {
  it("remembers both answers", () => {
    expect(setAutoDibs(false)).toBe(true);
    expect(autoDibs()).toBe(false);
    expect(setDibsSmsAlerts(true)).toBe(true);
    expect(dibsSmsAlerts()).toBe(true);
  });

  it("keeps the two independent", () => {
    setAutoDibs(false);
    expect(dibsSmsAlerts()).toBe(false);
    setDibsSmsAlerts(true);
    expect(autoDibs()).toBe(false);
  });
});

describe("degrading rather than throwing", () => {
  it("falls back to the default on a corrupt value", () => {
    localStorage.setItem(AUTO_DIBS_KEY, "yes please");
    localStorage.setItem(DIBS_SMS_KEY, "{}");
    expect(autoDibs()).toBe(true);
    expect(dibsSmsAlerts()).toBe(false);
  });

  it("reads the default when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    expect(autoDibs()).toBe(true);
    expect(dibsSmsAlerts()).toBe(false);
  });

  it("reports a refused write rather than claiming it saved", () => {
    // A preference that did not persist will be gone next visit, and a rider
    // told "Saved." has been lied to.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
      clear: () => {},
    });
    expect(setAutoDibs(false)).toBe(false);
    expect(setDibsSmsAlerts(true)).toBe(false);
  });
});
