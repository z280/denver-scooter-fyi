// @vitest-environment happy-dom
//
// Screens 2 + 2.5. Pure-function coverage for the distance sort, the
// auto-preselect boundary (exact 8.0 m / 15.0 m inclusive vs 8.01 m
// exclusive), the unfiltered-list property, feet formatting and the
// plate reverse-resolution / mismatch-switch / manual-fallback logic —
// plus a smaller set of DOM-level integration checks for selection,
// battery/plate sync onto the session doc, re-ranking triggers, and the
// Usuals apply-and-return round trip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceProperties, RideOptions, RideUsual } from "./api.ts";
import {
  closeRideModal,
  currentRideScreen,
  openRideModal,
  resetRideModal,
  resolveStartScreen,
  rideModalRoot,
} from "./ride-modal.ts";
import {
  candidatesById,
  checkTypedPlate,
  formatFeet,
  rankByDistance,
  shouldAutoPreselect,
  wireRideScreenSelect,
  type Candidate,
  type DevicesLike,
  type LocateLike,
  type PlatesLike,
} from "./ride-screen-select.ts";
import {
  createRideSessionStore,
  memoryRideSessionStorage,
} from "./ride-session.ts";
import type { LngLat } from "./locate.ts";

type Feature = GeoJSON.Feature<GeoJSON.Point, DeviceProperties>;

const AUTH_KEY = "scooter_fyi.map_auth";
const V1 = "a1b2c3d4e5f60701";
const V2 = "a1b2c3d4e5f60702";
const V3 = "a1b2c3d4e5f60703";

const OPTIONS: RideOptions = {
  cost_hud: true,
  speedometer: "classic",
  theme: "auto",
  navigation: false,
  save_tracks: true,
  battery_modeling: false,
  nav_improvement: false,
  end_survey: false,
  own_device: false,
};

const ORIGIN: LngLat = { lng: -104.9903, lat: 39.7392 };

/** Approximate a point `m` metres due north of ORIGIN — good enough for
 *  ordering/threshold tests (111 320 m per degree of latitude). */
function metersNorth(m: number): LngLat {
  return { lng: ORIGIN.lng, lat: ORIGIN.lat + m / 111_320 };
}

function feature(
  deviceId: string,
  vehicleIdentifier: string | null,
  at: LngLat,
  overrides: Partial<DeviceProperties> = {},
): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [at.lng, at.lat] },
    properties: {
      device_id: deviceId,
      form_factor: "scooter",
      spatial_status: "available",
      vehicle_identifier: vehicleIdentifier,
      vehicle_model_name: "Astro",
      ...overrides,
    },
  };
}

function setAuthed(on: boolean): void {
  if (on) {
    localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({
        token: "tok",
        expires: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
  } else {
    localStorage.removeItem(AUTH_KEY);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeDevices extends DevicesLike {
  setFeatures(f: Feature[]): void;
  emitCounts(): void;
}
function fakeDevices(features: Feature[]): FakeDevices {
  let current = features;
  const listeners = new Set<(visible: number, total: number) => void>();
  return {
    allFeatures: () => current,
    onCountsChange: (cb) => {
      listeners.add(cb);
      cb(current.length, current.length);
      return () => listeners.delete(cb);
    },
    setFeatures(f) {
      current = f;
    },
    emitCounts() {
      for (const cb of [...listeners]) cb(current.length, current.length);
    },
  };
}

interface FakeLocate extends LocateLike {
  emitFix(pos: LngLat): void;
}
function fakeLocate(initial: LngLat | null): FakeLocate {
  let current = initial;
  const listeners = new Set<(pos: LngLat) => void>();
  return {
    current: () => current,
    onFix: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emitFix(pos) {
      current = pos;
      for (const cb of [...listeners]) cb(pos);
    },
  };
}

function fakePlates(index: Record<string, string> = {}): PlatesLike {
  return {
    prime: () => Promise.resolve(),
    cachedPlateFor: (id) => index[id] ?? null,
  };
}

function newSession() {
  const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
  session.dispatch({ type: "open", options: OPTIONS, screen: "2" });
  return session;
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

afterEach(() => {
  resetRideModal();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// formatFeet
// ---------------------------------------------------------------------------

describe("formatFeet", () => {
  it("converts metres to rounded feet", () => {
    expect(formatFeet(1)).toBe("3 ft");
    expect(formatFeet(8)).toBe("26 ft");
    expect(formatFeet(15)).toBe("49 ft");
    expect(formatFeet(150)).toBe("492 ft");
    expect(formatFeet(0)).toBe("0 ft");
  });
});

// ---------------------------------------------------------------------------
// candidatesById / rankByDistance
// ---------------------------------------------------------------------------

describe("candidatesById + rankByDistance", () => {
  it("sorts nearest-first and drops anything past 150 m", () => {
    const near = feature("near", V1, metersNorth(5));
    const mid = feature("mid", V2, metersNorth(90));
    const far = feature("far", V3, metersNorth(300));
    const all = candidatesById([far, near, mid], ORIGIN, () => null);
    expect(rankByDistance(all).map((c) => c.deviceId)).toEqual(["near", "mid"]);
  });

  it("caps the ranked list at 6 even with more devices in range", () => {
    const feats = Array.from({ length: 8 }, (_, i) =>
      feature(`d${i}`, `a1b2c3d4e5f6070${i}`, metersNorth(i + 1)),
    );
    const all = candidatesById(feats, ORIGIN, () => null);
    expect(rankByDistance(all)).toHaveLength(6);
  });

  it("excludes devices with no usable 16-hex vehicle_identifier", () => {
    const noId = feature("no-id", null, metersNorth(1));
    const shortId = feature("short-id", "abc123", metersNorth(2));
    const all = candidatesById([noId, shortId], ORIGIN, () => null);
    expect(all.size).toBe(0);
  });

  it("with no fix, every candidate reads Infinity meters and ranks empty", () => {
    const near = feature("near", V1, metersNorth(5));
    const all = candidatesById([near], null, () => null);
    expect(all.get("near")?.meters).toBe(Number.POSITIVE_INFINITY);
    expect(rankByDistance(all)).toEqual([]);
  });

  it("the unfiltered-list property: DevicesLike exposes only allFeatures(), never visibleFeatures — a device a map filter would hide still ranks", () => {
    const excluded = feature("excluded-by-a-map-filter", V1, metersNorth(3));
    // This object structurally has no `visibleFeatures` at all — a call site
    // that reached for it wouldn't compile against `DevicesLike`, and this
    // fake proves the ranking pipeline only ever calls `allFeatures()`.
    const devicesLike: DevicesLike = {
      allFeatures: () => [excluded],
      onCountsChange: () => () => {},
    };
    const all = candidatesById(devicesLike.allFeatures(), ORIGIN, () => null);
    expect(rankByDistance(all).map((c) => c.deviceId)).toContain(
      "excluded-by-a-map-filter",
    );
  });
});

// ---------------------------------------------------------------------------
// shouldAutoPreselect
// ---------------------------------------------------------------------------

describe("shouldAutoPreselect", () => {
  const cand = (meters: number): Candidate => ({
    deviceId: "d",
    vehicleIdentifier: V1,
    model: null,
    lng: 0,
    lat: 0,
    meters,
    plate: null,
  });

  it("preselects at the exact 8.0 m / 15.0 m boundary (both inclusive)", () => {
    expect(shouldAutoPreselect(cand(8.0), 15.0)).toBe(true);
  });

  it("does not preselect at 8.01 m", () => {
    expect(shouldAutoPreselect(cand(8.01), 15.0)).toBe(false);
  });

  it("does not preselect at 15.01 m accuracy", () => {
    expect(shouldAutoPreselect(cand(8.0), 15.01)).toBe(false);
  });

  it("well within both thresholds preselects", () => {
    expect(shouldAutoPreselect(cand(2), 5)).toBe(true);
  });

  it("never preselects with unknown accuracy", () => {
    expect(shouldAutoPreselect(cand(2), null)).toBe(false);
    expect(shouldAutoPreselect(cand(2), undefined)).toBe(false);
  });

  it("never preselects with no nearest candidate", () => {
    expect(shouldAutoPreselect(undefined, 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkTypedPlate — reverse resolution, mismatch-switch, manual fallback
// ---------------------------------------------------------------------------

describe("checkTypedPlate", () => {
  const candA: Candidate = {
    deviceId: "devA",
    vehicleIdentifier: V1,
    model: "astro",
    lng: 0,
    lat: 0,
    meters: 5,
    plate: "1025543",
  };
  const candB: Candidate = {
    deviceId: "devB",
    vehicleIdentifier: V2,
    model: "cosmo",
    lng: 0,
    lat: 0,
    meters: 40,
    plate: "1099001",
  };
  const all = new Map([
    [candA.deviceId, candA],
    [candB.deviceId, candB],
  ]);
  const plateFor = (id: string): string | null =>
    id === "devA" ? "1025543" : id === "devB" ? "1099001" : null;
  const ids = ["devA", "devB"];

  it("is empty on a blank or whitespace-only typed value", () => {
    expect(checkTypedPlate("", null, ids, plateFor, all)).toEqual({ kind: "empty" });
    expect(checkTypedPlate("   ", "devA", ids, plateFor, all)).toEqual({
      kind: "empty",
    });
  });

  it("matches the already-selected device silently, tolerant of case/separators", () => {
    expect(checkTypedPlate("1025543", "devA", ids, plateFor, all)).toEqual({
      kind: "already_selected",
    });
    expect(checkTypedPlate("10-25 543", "devA", ids, plateFor, all)).toEqual({
      kind: "already_selected",
    });
  });

  it("switches to the reverse-resolved device on a mismatch", () => {
    expect(checkTypedPlate("1099001", "devA", ids, plateFor, all)).toEqual({
      kind: "switch",
      candidate: candB,
    });
  });

  it("resolves even with no prior selection", () => {
    expect(checkTypedPlate("1099001", null, ids, plateFor, all)).toEqual({
      kind: "switch",
      candidate: candB,
    });
  });

  it("stays on the manual-plate path when the plate matches nothing", () => {
    expect(checkTypedPlate("7777777", "devA", ids, plateFor, all)).toEqual({
      kind: "unresolved",
    });
  });

  it("stays on the manual-plate path when the plate resolves but the device isn't in the current feed snapshot", () => {
    const staleFor = (id: string): string | null =>
      id === "devC" ? "5551212" : plateFor(id);
    const result = checkTypedPlate(
      "5551212",
      "devA",
      [...ids, "devC"],
      staleFor,
      all,
    );
    expect(result).toEqual({ kind: "unresolved" });
  });
});

// ---------------------------------------------------------------------------
// DOM — selection, session sync, re-ranking, Usuals
// ---------------------------------------------------------------------------

describe("Screen 2 — selection and session sync", () => {
  it('always renders "My Scooter/Bike" as the FIRST option, above the ranked fleet', () => {
    // Non-Veo riders are first-class: riding your own device leads the list
    // instead of trailing it, whatever the fleet around you looks like.
    const near = feature("near", V1, ORIGIN);
    const devices = fakeDevices([near]);
    const locate = fakeLocate(ORIGIN);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    const rows = [...document.querySelectorAll("button.ride-option")];
    expect(rows[0]?.textContent).toContain("My Scooter/Bike");
    expect(document.body.textContent).not.toContain("My own Device");
  });

  it('shows a Rover candidate as "Rover", never "Trike" or unknown', () => {
    const near = feature("near", V1, ORIGIN, { vehicle_model_name: "Rover" });
    const devices = fakeDevices([near]);
    const locate = fakeLocate(ORIGIN);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    const titles = [...document.querySelectorAll(".ride-option__title strong")].map(
      (n) => n.textContent,
    );
    expect(titles).toContain("Rover");
    expect(titles).not.toContain("Trike");
    // The internal key is still the wire-format "trike".
    expect(session.current()?.device).toBeNull(); // 0 m away but plates not primed ≠ no preselect
  });

  it("auto-preselects the nearest candidate and stores it as the session device", () => {
    const near = feature("near", V1, metersNorth(5));
    const devices = fakeDevices([near]);
    const locate = fakeLocate({ ...ORIGIN, accuracy: 10 });
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    expect(document.querySelector(".ride-option.is-selected")?.textContent).toContain(
      "Astro",
    );
    expect(session.current()?.device).toEqual({
      vehicleIdentifier: V1,
      plate: null,
      model: "astro",
      batteryConfirmed: null,
    });
  });

  it("does not auto-preselect beyond the thresholds, but a tap selects", () => {
    const mid = feature("mid", V1, metersNorth(50));
    const devices = fakeDevices([mid]);
    const locate = fakeLocate({ ...ORIGIN, accuracy: 10 });
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    expect(document.querySelector(".ride-option.is-selected")).toBeNull();
    expect(session.current()?.device).toBeNull();

    // "My Scooter/Bike" always renders first now, so target the ranked
    // candidate by name rather than by position.
    const row = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("Astro"),
    ) as HTMLButtonElement;
    row.click();
    // renderList() rebuilds the row elements on every selection change, so
    // re-query rather than trust the pre-click reference.
    expect(document.querySelector("button.ride-option.is-selected")).toBeTruthy();
    expect(session.current()?.device).toMatchObject({ vehicleIdentifier: V1 });
  });

  it("selecting My own Device marks the ride private with no plate/battery", () => {
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    const ownBtn = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("My Scooter/Bike"),
    ) as HTMLButtonElement;
    expect(ownBtn).toBeTruthy();
    ownBtn.click();
    expect(session.current()?.device).toEqual({ own: true });
    expect(session.current()?.private).toBe(true);
  });

  it("selecting a real device as a guest (signed out) still marks the ride private", () => {
    // Regression: a guest's real-device pick must be private too — there's no
    // account for `POST /tracked-rides` (session-authed) to attribute a
    // `tracked_rides` row to, so Screen 6 must never attempt that call for a
    // guest (see ride-screen-start.ts's FIX note). Before this fix,
    // `syncSessionDevice` never passed `private` explicitly for a non-"own"
    // device, so it silently stayed `false` for a guest.
    setAuthed(false);
    const near = feature("near", V1, ORIGIN);
    const devices = fakeDevices([near]);
    const locate = fakeLocate(ORIGIN);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    // "My Scooter/Bike" always renders first now, so target the ranked
    // candidate by name rather than by position.
    const row = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("Astro"),
    ) as HTMLButtonElement;
    row.click();
    expect(session.current()?.device).toMatchObject({ vehicleIdentifier: V1 });
    expect(session.current()?.private).toBe(true);
  });

  it("selecting a real device while signed in keeps the ride points-eligible, even switching off a prior own-device pick", () => {
    // ride-session.ts's `setDevice` doc: "or when switching off own-device
    // should make the ride points-eligible again."
    setAuthed(true);
    const near = feature("near", V1, ORIGIN);
    const devices = fakeDevices([near]);
    const locate = fakeLocate(ORIGIN);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    const ownBtn = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("My Scooter/Bike"),
    ) as HTMLButtonElement;
    ownBtn.click();
    expect(session.current()?.private).toBe(true);

    const row = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("Astro"),
    ) as HTMLButtonElement;
    row.click();
    expect(session.current()?.device).toMatchObject({ vehicleIdentifier: V1 });
    expect(session.current()?.private).toBe(false);
  });

  // FRICTION-REDUCTION PASS: no Battery % field anywhere on this screen
  // anymore — the server derives its own reading from the GBFS feed
  // independently, so nothing here ever collects one. `batteryConfirmed`
  // always dispatches `null`.
  it("never renders a Battery % field, and always dispatches batteryConfirmed: null", () => {
    const near = feature("near", V1, ORIGIN);
    const devices = fakeDevices([near]);
    const locate = fakeLocate(ORIGIN);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    expect(document.querySelector('input[aria-label^="Battery"]')).toBeNull();

    // "My Scooter/Bike" always renders first now, so target the ranked
    // candidate by name rather than by position.
    const row = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("Astro"),
    ) as HTMLButtonElement;
    row.click();
    expect(session.current()?.device).toMatchObject({ batteryConfirmed: null });
  });

  // FRICTION-REDUCTION PASS: the plate confirm field used to always show,
  // even for an already-resolved list/auto-selected candidate (whose plate
  // the GBFS match already knows). It now only shows for manual entry.
  describe("the plate confirm field only shows for manual entry", () => {
    function confirmStripHidden(): boolean {
      const strip = document.querySelector(".ride-screen-select__confirm") as HTMLElement;
      return strip.hidden;
    }

    it("is hidden when a ranked candidate is auto/list-selected", () => {
      const near = feature("near", V1, ORIGIN);
      const devices = fakeDevices([near]);
      const locate = fakeLocate({ ...ORIGIN, accuracy: 10 }); // close + accurate enough to auto-preselect
      const session = newSession();
      wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
      openRideModal({ fastForwardTo: "2" });

      expect(session.current()?.device).toMatchObject({ vehicleIdentifier: V1 });
      expect(confirmStripHidden()).toBe(true);
    });

    it("is hidden for My own Device", () => {
      const devices = fakeDevices([]);
      const locate = fakeLocate(null);
      const session = newSession();
      wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
      openRideModal({ fastForwardTo: "2" });

      const ownBtn = [...document.querySelectorAll("button.ride-option")].find((b) =>
        b.textContent?.includes("My Scooter/Bike"),
      ) as HTMLButtonElement;
      ownBtn.click();
      expect(confirmStripHidden()).toBe(true);
    });

    it("shows once \"None of these — enter plate manually\" is selected", () => {
      const devices = fakeDevices([]);
      const locate = fakeLocate(null);
      const session = newSession();
      wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
      openRideModal({ fastForwardTo: "2" });

      expect(confirmStripHidden()).toBe(true);
      const manualBtn = [...document.querySelectorAll("button.ride-option")].find((b) =>
        b.textContent?.includes("enter plate manually"),
      ) as HTMLButtonElement;
      manualBtn.click();
      expect(confirmStripHidden()).toBe(false);
    });
  });

  it("a typed plate mismatch switches selection to the resolved device", async () => {
    const a = feature("devA", V1, metersNorth(2));
    const b = feature("devB", V2, metersNorth(40));
    const devices = fakeDevices([a, b]);
    const locate = fakeLocate({ ...ORIGIN, accuracy: 10 }); // auto-preselects devA
    const session = newSession();
    const plates = fakePlates({ devA: "1025543", devB: "1099001" });
    wireRideScreenSelect({ devices, locate, session, plates });
    openRideModal({ fastForwardTo: "2" });
    await flush(); // let prime() settle

    expect(session.current()?.device).toMatchObject({ vehicleIdentifier: V1 });
    const plateInput = document.querySelector(
      'input[aria-label^="Plate"]',
    ) as HTMLInputElement;
    plateInput.value = "1099001";
    plateInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(session.current()?.device).toMatchObject({ vehicleIdentifier: V2 });
    expect(rideModalRoot()?.textContent).toContain("switched to");
  });

  it("stays on the manual-plate path when the typed plate is unknown", async () => {
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });
    await flush();

    const plateInput = document.querySelector(
      'input[aria-label^="Plate"]',
    ) as HTMLInputElement;
    plateInput.value = "9999999";
    plateInput.dispatchEvent(new Event("input", { bubbles: true }));

    const manualRow = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("enter plate manually"),
    );
    expect(manualRow?.classList.contains("is-selected")).toBe(true);
    // Nothing resolved — the session's device stays untouched (no false start).
    expect(session.current()?.device).toBeNull();
  });

  it("re-ranks when devices.onCountsChange fires", () => {
    const devices = fakeDevices([]);
    const locate = fakeLocate(ORIGIN);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    expect(
      [...document.querySelectorAll(".ride-option__title strong")].some(
        (s) => s.textContent === "Astro",
      ),
    ).toBe(false);

    devices.setFeatures([feature("near", V1, ORIGIN)]);
    devices.emitCounts();

    expect(
      [...document.querySelectorAll(".ride-option__title strong")].some(
        (s) => s.textContent === "Astro",
      ),
    ).toBe(true);
  });

  it("re-ranks when Locate.onFix delivers a fix", () => {
    const near = feature("near", V1, metersNorth(5));
    const devices = fakeDevices([near]);
    const locate = fakeLocate(null);
    const session = newSession();
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });
    openRideModal({ fastForwardTo: "2" });

    expect(rideModalRoot()?.textContent).toContain("No GPS fix yet");

    locate.emitFix(ORIGIN);

    expect(
      [...document.querySelectorAll(".ride-option__title strong")].some(
        (s) => s.textContent === "Astro",
      ),
    ).toBe(true);
  });

  it("disposes the injected options-panel handle on a real rebuild and on screen teardown", () => {
    // `RideOptionsPanelHandle.destroy()`'s own doc (ride-settings.ts) requires
    // its caller to invoke it from screen-teardown; this screen also rebuilds
    // the panel when one of the panel's inputs (canProceed / hasUsuals)
    // changes, and the PREVIOUS handle must be disposed before each such
    // rebuild — otherwise an open ℹ modal from a stale panel is never told
    // to close.
    const disposes: ReturnType<typeof vi.fn>[] = [];
    const buildOptionsPanel = vi.fn(() => {
      const dispose = vi.fn();
      disposes.push(dispose);
      return { dispose };
    });
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = newSession();
    wireRideScreenSelect({
      devices,
      locate,
      session,
      plates: fakePlates(),
      buildOptionsPanel,
    });
    openRideModal({ fastForwardTo: "2" });

    // Mount builds exactly once: the initial render plus
    // `devices.onCountsChange`'s synchronous callback both run, but the
    // second is memoized away (nothing the panel renders from changed).
    expect(disposes.length).toBe(1);
    expect(disposes[0]).not.toHaveBeenCalled();

    const ownBtn = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("My Scooter/Bike"),
    ) as HTMLButtonElement;
    ownBtn.click();

    // Selecting "My Scooter/Bike" flips canProceed — a REAL input change —
    // so the panel rebuilds, disposing the previous handle first.
    expect(disposes.length).toBe(2);
    expect(disposes[0]).toHaveBeenCalledTimes(1);
    expect(disposes[1]).not.toHaveBeenCalled();

    closeRideModal();

    expect(disposes[1]).toHaveBeenCalledTimes(1);
  });

  it("flipping device ⇄ My Scooter/Bike rebuilds the panel — doc.private is a panel input", () => {
    // canProceed stays true across this switch, but the production panel
    // builder captures doc.private into its cascade context at build time —
    // a memo key without it left the panel cascading against a stale
    // privacy state (trophy options forced off on a tracked ride, or left
    // on for a private one).
    const buildOptionsPanel = vi.fn(() => ({ dispose: vi.fn() }));
    // Signed in — a guest's ride is private whichever device they pick,
    // which would hide exactly the flip this test exists to observe.
    setAuthed(true);
    // A device 3 m away + an accurate fix → auto-preselect on mount, so the
    // panel is already in the canProceed=true, private=false state.
    const devices = fakeDevices([feature("near", V1, metersNorth(3))]);
    const locate = fakeLocate({ ...metersNorth(0), accuracy: 5 } as LngLat);
    const session = newSession();
    wireRideScreenSelect({
      devices,
      locate,
      session,
      plates: fakePlates(),
      buildOptionsPanel,
    });
    openRideModal({ fastForwardTo: "2" });
    expect(session.current()?.private).toBe(false);
    const before = buildOptionsPanel.mock.calls.length;

    const ownBtn = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("My Scooter/Bike"),
    ) as HTMLButtonElement;
    ownBtn.click();

    expect(session.current()?.private).toBe(true);
    expect(buildOptionsPanel.mock.calls.length).toBe(before + 1);
  });

  it("a GPS fix or feed refresh never rebuilds the panel — an open ℹ modal survives", () => {
    // The field bug this pins: with the wizard up, fixes arrive ~1/second,
    // and every one used to dispose-and-rebuild the options panel — whose
    // destroy() closes any open ℹ info modal. Riders saw the modal close
    // by itself moments after opening it.
    const disposes: ReturnType<typeof vi.fn>[] = [];
    const buildOptionsPanel = vi.fn(() => {
      const dispose = vi.fn();
      disposes.push(dispose);
      return { dispose };
    });
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = newSession();
    wireRideScreenSelect({
      devices,
      locate,
      session,
      plates: fakePlates(),
      buildOptionsPanel,
    });
    openRideModal({ fastForwardTo: "2" });
    const builds = buildOptionsPanel.mock.calls.length;

    locate.emitFix({ lng: -104.99, lat: 39.74, accuracy: 5 });
    locate.emitFix({ lng: -104.98, lat: 39.75, accuracy: 5 });
    devices.emitCounts();

    expect(buildOptionsPanel.mock.calls.length).toBe(builds);
    for (const d of disposes) expect(d).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Screen 2's skip gate — the F4 [New Destination] loop fix.
// ---------------------------------------------------------------------------

describe("Screen 2 — skip gate for the S8 [New Destination] loop", () => {
  it("is NOT skipped on a fresh wizard entry (rideId is null)", () => {
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = newSession(); // open()'d fresh — state "wizard", rideId null
    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });

    expect(resolveStartScreen({ fastForwardTo: "3" })).toBe("2");
  });

  it("IS skipped when a New-Destination-loop doc (wizard state, live rideId) fast-forwards to Screen 3", () => {
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = createRideSessionStore({ storage: memoryRideSessionStorage() });
    // Drive the real reducer through Screen 8's [New Destination] path
    // (`ending(8) → wizard:3`) rather than hand-building a doc, so this test
    // proves the fix against ride-session.ts's actual transitions.
    session.dispatch({ type: "open", options: OPTIONS });
    session.dispatch({
      type: "setDevice",
      device: { vehicleIdentifier: V1, plate: null, model: null, batteryConfirmed: 80 },
    });
    session.dispatch({ type: "goto", screen: "6" });
    session.dispatch({
      type: "rideStarted",
      rideId: "ride-loop-1",
      startedAtMs: Date.now(),
      trackKeyId: "ride-loop-1",
    });
    session.dispatch({ type: "endRide" }); // riding -> ending(8)
    const nd = session.dispatch({ type: "newDestination" }); // -> wizard:3, same rideId
    expect(nd?.accepted).toBe(true);
    expect(session.current()).toMatchObject({ state: "wizard", screen: "3", rideId: "ride-loop-1" });

    wireRideScreenSelect({ devices, locate, session, plates: fakePlates() });

    // Screen 3 itself isn't registered in this isolated test, so a correct
    // skip steps past Screen 2 and returns the (unregistered) fast-forward
    // target itself — landing anywhere else (in particular "2", the
    // regression this test guards) would mean the loop dead-ends back on
    // device disambiguation instead of "Where to?".
    expect(resolveStartScreen({ fastForwardTo: "3" })).toBe("3");
  });
});

describe("Screen 2.5 — Usuals", () => {
  it("appears only once authenticated AND a saved Usual exists, applies it, and returns to Screen 2", async () => {
    setAuthed(true);
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = newSession();
    const usual: RideUsual = {
      name: "Commute",
      settings: { ...OPTIONS, navigation: true, label: "Commute settings" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    wireRideScreenSelect({
      devices,
      locate,
      session,
      plates: fakePlates(),
      listRideUsuals: () => Promise.resolve([usual]),
    });
    openRideModal({ fastForwardTo: "2" });
    await flush();

    const usualsBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Usuals",
    ) as HTMLButtonElement;
    expect(usualsBtn).toBeTruthy();
    usualsBtn.click();
    expect(currentRideScreen()).toBe("2.5");

    await flush();
    const applyBtn = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("Commute"),
    ) as HTMLButtonElement;
    expect(applyBtn).toBeTruthy();
    applyBtn.click();

    expect(currentRideScreen()).toBe("2");
    expect(session.current()?.options.navigation).toBe(true);
  });

  it("applies cascades to a Usual that carries suppressed 🏆 options into a private session", async () => {
    setAuthed(true);
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = createRideSessionStore({
      storage: memoryRideSessionStorage(),
    });
    // A private ride (e.g. "My Scooter/Bike") — the three 🏆 options must be
    // forced off even though this Usual was saved on a real device with
    // them on.
    session.dispatch({ type: "open", options: OPTIONS, screen: "2", private: true });
    const usual: RideUsual = {
      name: "Commute",
      settings: {
        ...OPTIONS,
        battery_modeling: true,
        nav_improvement: true,
        end_survey: true,
        label: "Commute settings",
      },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    wireRideScreenSelect({
      devices,
      locate,
      session,
      plates: fakePlates(),
      listRideUsuals: () => Promise.resolve([usual]),
    });
    openRideModal({ fastForwardTo: "2" });
    await flush();

    const usualsBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Usuals",
    ) as HTMLButtonElement;
    usualsBtn.click();
    await flush();
    const applyBtn = [...document.querySelectorAll("button.ride-option")].find((b) =>
      b.textContent?.includes("Commute"),
    ) as HTMLButtonElement;
    applyBtn.click();

    const applied = session.current()?.options;
    expect(applied?.battery_modeling).toBe(false);
    expect(applied?.nav_improvement).toBe(false);
    expect(applied?.end_survey).toBe(false);
  });

  it("omits the Usuals button when signed out", async () => {
    setAuthed(false);
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = newSession();
    wireRideScreenSelect({
      devices,
      locate,
      session,
      plates: fakePlates(),
      listRideUsuals: () =>
        Promise.reject(new Error("must not be called while signed out")),
    });
    openRideModal({ fastForwardTo: "2" });
    await flush();
    expect(
      [...document.querySelectorAll("button")].some((b) => b.textContent === "Usuals"),
    ).toBe(false);
  });

  it("omits the Usuals button when signed in with zero saved presets", async () => {
    setAuthed(true);
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    const session = newSession();
    wireRideScreenSelect({
      devices,
      locate,
      session,
      plates: fakePlates(),
      listRideUsuals: () => Promise.resolve([]),
    });
    openRideModal({ fastForwardTo: "2" });
    await flush();
    expect(
      [...document.querySelectorAll("button")].some((b) => b.textContent === "Usuals"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Screen 2's skip gate — the device-card "Use in Ride Mode" survey path.
//
// The survey's whole premise is that the rider already answered "which
// scooter?" by opening that scooter's popup, so Screen 2 must step aside for
// it. But stepping aside is only safe once `doc.device` is actually set (the
// integrator dispatches `setDevice` from the entry in main.ts's `onOpen`):
// with nothing selected, skipping here would let the flow reach Screen 6,
// find no device, skip THAT too, and run off the end of the flow without
// ever dispatching `rideStarted` — a wizard that closes having silently done
// nothing. These tests pin both halves.
// ---------------------------------------------------------------------------

describe("Screen 2 — skip gate for the pre-ride survey", () => {
  function selectedSession() {
    const session = newSession();
    session.dispatch({
      type: "setDevice",
      device: {
        vehicleIdentifier: V1,
        plate: "1234567",
        model: "astro",
        batteryConfirmed: null,
      },
    });
    return session;
  }

  const PREFLIGHT = { navigation: false, save_tracks: true, cost_hud: true };

  it("IS skipped once the survey's device pick has landed", () => {
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    wireRideScreenSelect({
      devices, locate, session: selectedSession(), plates: fakePlates(),
    });

    // Lands on the survey's own target — Screens 3/4 aren't registered in
    // this harness, so the walk steps over them to the fast-forward floor.
    expect(
      resolveStartScreen({ fastForwardTo: "6", preflight: PREFLIGHT }),
    ).toBe("6");
  });

  it("is NOT skipped when the device pick somehow didn't land", () => {
    // Fail safe rather than fail silent: showing the rider a device picker
    // they didn't need is a small annoyance; running the whole flow with no
    // device and starting no ride is a broken feature.
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    wireRideScreenSelect({
      devices, locate, session: newSession(), plates: fakePlates(),
    });

    expect(
      resolveStartScreen({ fastForwardTo: "6", preflight: PREFLIGHT }),
    ).toBe("2");
  });

  it("is NOT skipped for an ordinary deep link that carries no survey answers", () => {
    // `?ride=<hex>` still lands on Screen 2 to confirm the scooter — only the
    // survey path has already asked.
    const devices = fakeDevices([]);
    const locate = fakeLocate(null);
    wireRideScreenSelect({
      devices, locate, session: selectedSession(), plates: fakePlates(),
    });

    expect(resolveStartScreen({ vehicleIdentifier: V1 })).toBe("2");
  });
});
