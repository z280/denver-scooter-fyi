// @vitest-environment happy-dom
//
// F3 integration proof: the ONE shared watchPosition callback
// (`RideHud`'s private `onFix`, exercised here only through its real public
// entry points — `beginHandoff` + a captured `navigator.geolocation.
// watchPosition` success callback, never called directly) really does feed
// BOTH `track-store` (a real `TrackRecorder`, backed by `MemoryTrackStorage`)
// AND the Screen 7 nav overlay (a real `ride-nav-hud.ts` `NavHud`, mounted
// into the real HUD DOM) from every GPS fix — with ZERO network calls in
// between, matching `ride-tracking-integration.test.ts`'s §4 assertion but
// against the actual WIRED `RideHud` class instead of track-store alone.
//
// No lane could prove this end to end on its own: lane ① (ride-hud.ts) never
// imported ride-nav-hud.ts, lane ② (ride-nav-hud.ts) never imported
// ride-hud.ts, and lane ③ (tracking integration) tested the
// api.ts/ride-session.ts/track-store.ts seam without touching ride-hud.ts or
// ride-nav-hud.ts at all (see that file's own SCOPE comment). This file is
// the integrator's seam test for the wiring added on top of all three lanes'
// work: `ride-hud.ts`'s `mountNavHud`/`onFix` additions and `main.ts`'s
// `onComplete`/`onRideStarted`/`recoverActiveRide` glue (exercised here via
// `RideHud`'s own public surface, since `main.ts` itself needs a full
// `index.html` DOM + a real MapLibre map to boot and is not practically
// unit-testable).
//
// `RideHud` is otherwise deliberately NOT unit-tested directly
// (`ride-hud.test.ts`'s own header: "a thick DOM/MapLibre/geolocation object
// with no seam that doesn't ultimately touch `document`, a `maplibregl.Map`,
// or `navigator.geolocation.watchPosition`"). This file accepts that cost
// for exactly the one scenario that actually needs the real class: proving
// the shared callback really does fan out to both downstream systems. The
// only mock is `maplibregl.Marker` (real MapLibre marker DOM/GL wiring needs
// a live WebGL canvas, which happy-dom cannot provide) — the map itself is a
// minimal hand-written fake covering only the methods `RideHud` actually
// calls (verified by reading ride-hud.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => {
  class FakeMarker {
    element: HTMLElement;
    constructor(opts: { element: HTMLElement }) {
      this.element = opts.element;
    }
    setLngLat(): this {
      return this;
    }
    addTo(): this {
      return this;
    }
    remove(): this {
      return this;
    }
  }
  return { default: { Marker: FakeMarker } };
});

import { RideHud, type RideDeviceControl, type RideHudTrackControl } from "./ride-hud.ts";
import {
  MemoryTrackStorage,
  base64UrlEncode,
  bytesToHex,
  openTrackStore,
  type TrackRecorder,
} from "./track-store.ts";
import type { RideOptions, RouteManeuver, TrackSigning } from "./api.ts";
import type { RideSessionDoc, RideSessionRoute } from "./ride-session.ts";
import { encodePolyline } from "./polyline-encode.ts";

// ---------------------------------------------------------------------------
// A minimal, straight-line "on route" fixture: 6 points heading due east,
// ~8.5 m apart (0.0001° longitude at Denver's latitude), one maneuver
// spanning the whole thing. Every fed fix sits exactly ON this line, so
// nav-hud never has reason to consider a re-route — the zero-network
// assertion below is not merely "we didn't feed it a jump", it's "these are
// the fixes an ordinary in-lane ride actually produces".
// ---------------------------------------------------------------------------

const ROUTE_LAT = 39.7392;
const ROUTE_LNG0 = -104.9903;
const ROUTE_STEP_LNG = 0.0001;
const ROUTE_POINTS = 6;

function routeCoords(): [number, number][] {
  return Array.from({ length: ROUTE_POINTS }, (_, i) => [
    ROUTE_LNG0 + i * ROUTE_STEP_LNG,
    ROUTE_LAT,
  ]);
}

const MANEUVER: RouteManeuver = {
  instruction: "Head east on Main St",
  type: 1,
  street_names: ["Main St"],
  length_meters: 42,
  time_seconds: 12,
  begin_shape_index: 0,
  end_shape_index: ROUTE_POINTS - 1,
};

function buildRoute(): RideSessionRoute {
  return {
    profile: "safe",
    rideRouteId: null,
    distanceM: 42,
    durationS: 12,
    polyline: encodePolyline(routeCoords()),
    maneuvers: [MANEUVER],
  };
}

const OPTIONS: RideOptions = {
  cost_hud: true,
  speedometer: "digital",
  theme: "auto",
  navigation: true,
  save_tracks: true,
  battery_modeling: true,
  nav_improvement: false,
  end_survey: true,
  own_device: false,
};

function buildDoc(rideId: string, startedAtMs: number): RideSessionDoc {
  const [lng, lat] = routeCoords()[ROUTE_POINTS - 1];
  return {
    v: 1,
    state: "riding",
    screen: null,
    rideId,
    private: false,
    device: null,
    options: OPTIONS,
    dest: { label: "Union Station", lat, lon: lng },
    route: buildRoute(),
    startedAtMs,
    trackKeyId: rideId,
  };
}

async function genSigning(rideId: string): Promise<TrackSigning> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    alg: "HS256",
    key_id: rideId,
    key: base64UrlEncode(keyBytes),
    nonce: bytesToHex(nonceBytes),
    issued_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fakes: the map (methods RideHud actually calls, per its own source — no
// more), the device layer control, and a captured geolocation watcher.
// ---------------------------------------------------------------------------

function fakeMap() {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 600 });
  return {
    getCenter: () => ({ lng: ROUTE_LNG0, lat: ROUTE_LAT }),
    getZoom: () => 14,
    getPitch: () => 0,
    getBearing: () => 0,
    easeTo: () => {},
    getLayer: () => undefined,
    setPaintProperty: () => {},
    // No "buildings" source-layer → addBuildings3D() returns early and
    // addLayer() is never called; this fake doesn't need to implement it.
    getStyle: () => ({ layers: [] }),
    addLayer: () => {},
    removeLayer: () => {},
    getContainer: () => container,
  };
}

function fakeDeviceCtl(): RideDeviceControl {
  return {
    setRideActive: () => {},
    setRideModelFilter: () => {},
    hasOpenPopup: () => false,
  };
}

interface FakeGeo {
  watchPosition(
    success: (fix: GeolocationPosition) => void,
    error?: (err: GeolocationPositionError) => void,
    opts?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}

function stubGeolocation(): { geo: FakeGeo; captured: () => (fix: GeolocationPosition) => void } {
  let success: ((fix: GeolocationPosition) => void) | null = null;
  const geo: FakeGeo = {
    watchPosition: (onSuccess) => {
      success = onSuccess;
      return 1;
    },
    clearWatch: () => {},
  };
  return {
    geo,
    captured: () => {
      if (!success) throw new Error("test bug: watchPosition was never called");
      return success;
    },
  };
}

function fix(i: number, tMs: number): GeolocationPosition {
  const [lng, lat] = routeCoords()[i];
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy: 6,
      altitude: null,
      altitudeAccuracy: null,
      heading: 90,
      speed: 3,
      toJSON: () => ({}),
    },
    timestamp: tMs,
    toJSON: () => ({}),
  } as unknown as GeolocationPosition;
}

// ---------------------------------------------------------------------------

describe("RideHud + ride-nav-hud + track-store, fully wired: the shared watchPosition callback", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The hard zero-network assertion: any call at all fails the test
    // immediately, rather than merely being counted after the fact (same
    // technique as ride-tracking-integration.test.ts's FetchRig.forbid()).
    fetchSpy = vi.fn(async () => {
      throw new Error(
        "network call forbidden — every fed fix in this test sits ON the route",
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("one GPS fix reaches the real TrackRecorder AND the real NavHud, with zero network calls", async () => {
    const rideId = "ride-int-hud-1";
    const startedAtMs = Date.parse("2026-07-29T18:00:00.000Z");

    const doc = buildDoc(rideId, startedAtMs);
    const dispatch = vi.fn();
    const session = {
      current: () => doc,
      dispatch,
    };

    const signing = await genSigning(rideId);
    const trackStore = await openTrackStore({ storage: new MemoryTrackStorage() });
    const recorder: TrackRecorder = await trackStore.startServerRide(signing);
    const recorderControl: RideHudTrackControl = recorder;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const { geo, captured } = stubGeolocation();
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      geolocation: geo,
    });

    const rideHud = new RideHud(
      container,
      async () => [], // equityZones — irrelevant here
      fakeMap() as unknown as ConstructorParameters<typeof RideHud>[2],
      fakeDeviceCtl(),
      { session },
    );

    rideHud.beginHandoff({
      rideId,
      startedAtMs,
      recorder: recorderControl,
    });

    // The Screen 7 overlay mounted, straight from the session doc's route —
    // no network involved in construction (it only seeds from the polyline
    // it's handed).
    expect(container.querySelector(".nav-hud")).not.toBeNull();
    expect(container.querySelector(".nav-hud__instruction")?.textContent).toBe(
      MANEUVER.instruction,
    );

    const onFix = captured();
    const before = recorder.info();
    expect(before.waypointCount + before.pendingCount).toBe(0);

    // Feed several on-route fixes through the SAME callback RideHud registered
    // with navigator.geolocation.watchPosition — this is the real, private
    // `onFix` method; nothing here calls track-store or ride-nav-hud.ts
    // directly.
    for (let i = 0; i < ROUTE_POINTS; i += 1) {
      onFix(fix(i, startedAtMs + 1000 + i * 3000));
    }
    // addFix() is async (IndexedDB-shaped API even when memory-backed); let
    // the fire-and-forget calls ride-hud.ts issues actually settle.
    await new Promise((r) => setTimeout(r, 0));

    // 1. track-store really did receive every fix, through the real
    //    RideHud class, not a hand-rolled call.
    const after = recorder.info();
    expect(after.waypointCount + after.pendingCount).toBe(ROUTE_POINTS);

    // 2. ride-nav-hud.ts really did receive every fix too — its own
    //    internal `advanceMonotonic` matched forward along the line (the
    //    instruction stays the same single maneuver here, but the overlay
    //    is still live and un-torn-down, proving `feedFix` kept running
    //    rather than throwing/detaching after the first call).
    expect(container.querySelector(".nav-hud")).not.toBeNull();
    expect(container.querySelector(".nav-hud__instruction")?.textContent).toBe(
      MANEUVER.instruction,
    );

    // 3. Zero network calls throughout — the phase's real acceptance bar,
    //    now proven against the fully wired class, not track-store alone.
    expect(fetchSpy).not.toHaveBeenCalled();

    // Sealing on End Ride still works from here (not exercised by the
    // fixture above, so a quick sanity check that the recorder handed to
    // beginHandoff is the SAME one addFix landed on).
    const finished = await recorder.finish();
    expect(finished.waypointCount).toBe(ROUTE_POINTS);
  });

  it("a private/legacy ride (no session route) never mounts the nav overlay, and a STALE done-doc's route never leaks into it", async () => {
    // Regression coverage for the guard added alongside the wiring: the
    // legacy armed → countdown → startRide() path never touches
    // rideSession at all, so if a PRIOR wizard ride left a `done` doc with
    // route data still on it, mountNavHud() must not resurrect that old
    // ride's directions for an unrelated quick-start ride.
    const staleDoc = { ...buildDoc("old-ride", Date.now() - 60_000), state: "done" as const };
    const session = {
      current: () => staleDoc,
      dispatch: vi.fn(),
    };
    const { geo } = stubGeolocation();
    vi.stubGlobal("navigator", { ...globalThis.navigator, geolocation: geo });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const rideHud = new RideHud(
      container,
      async () => [],
      fakeMap() as unknown as ConstructorParameters<typeof RideHud>[2],
      fakeDeviceCtl(),
      { session },
    );

    // The legacy quick-start path: pick a rate (required before "Start now"
    // will proceed — `beginCountdown`'s own guard), then click it.
    rideHud.open();
    const rateSel = container.querySelector<HTMLSelectElement>("#hud-rate");
    if (rateSel) rateSel.value = "resident";
    container
      .querySelector<HTMLButtonElement>('[data-hud="start-now"]')
      ?.click();

    expect(container.querySelector(".nav-hud")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ending a PRIVATE ride via the round Stop button still closes the session doc out to `done`", async () => {
    // Regression test: `endRide()` used to dispatch `{type:"endRide"}` only
    // inside the TRACKED-ride branch (gated on `trackedRideId !== null`,
    // which is null for every private/guest ride by construction — see
    // `ride-screen-start.ts`'s `rideId: null` on the private path). That
    // left a private ride's session doc stranded on `riding` forever after
    // End Ride: `reduceRideSession`'s `open` guard rejects starting a new
    // ride while `isRideLive(doc)` is true, and `isLiveRideEntry` would keep
    // routing the next 🧭 tap back into `rideHud.open()`'s legacy armed
    // screen instead of a fresh wizard — a rider who ever finishes ONE
    // private ride through the wizard would be locked out of it permanently.
    // There is no `PATCH /end` for a private ride (master Part 0's Screen 8
    // gate), so `endRide()` must still dispatch `endRide` on this branch —
    // it just doesn't have a network call to make first.
    const doc: RideSessionDoc = {
      v: 1,
      state: "riding",
      screen: null,
      rideId: null,
      private: true,
      device: { own: true },
      options: OPTIONS,
      dest: null,
      route: null,
      startedAtMs: Date.now() - 5000,
      trackKeyId: "private-abc123",
    };
    const dispatch = vi.fn();
    const session = { current: () => doc, dispatch };
    const { geo } = stubGeolocation();
    vi.stubGlobal("navigator", { ...globalThis.navigator, geolocation: geo });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const rideHud = new RideHud(
      container,
      async () => [],
      fakeMap() as unknown as ConstructorParameters<typeof RideHud>[2],
      fakeDeviceCtl(),
      { session },
    );

    rideHud.beginHandoff({
      rideId: null,
      startedAtMs: doc.startedAtMs as number,
      recorder: null,
    });

    container.querySelector<HTMLButtonElement>('[data-hud="end"]')?.click();
    // endRide()'s private-ride branch is still async (it awaits a possible
    // recorder.finish() before dispatching, even with a null recorder here)
    // — flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(dispatch).toHaveBeenCalledWith({ type: "endRide" });
    // No PATCH /end for a private ride — nothing should have hit the network.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ending a TRACKED ride via the round Stop button hands off to Screen 8 instead of the legacy summary", async () => {
    // Regression test for the F4 integration fix: `endRide()` used to (F3
    // interim) send its own `PATCH /end` via `endTrackedRide` AND
    // unconditionally render the legacy client-only "Ride summary" card for
    // EVERY ride, tracked or not — which is exactly the double-render the
    // module map's ride-hud.ts row retires ("the summary state is replaced
    // by a handoff to ride-post.ts ... for tracked rides only"). A tracked
    // ride's End Ride must now: seal the final local batch, dispatch
    // `{type:"endRide"}` with NO network call of its own (the single
    // `PATCH /end` belongs to Screen 8's own buttons per
    // ride-session.ts's END-REPORT INVARIANT), hide the HUD's own view, and
    // never paint the legacy summary markup at all.
    const rideId = "ride-int-hud-end";
    const startedAtMs = Date.now() - 5000;
    const doc = buildDoc(rideId, startedAtMs);
    const dispatch = vi.fn();
    const session = { current: () => doc, dispatch };

    const signing = await genSigning(rideId);
    const trackStore = await openTrackStore({ storage: new MemoryTrackStorage() });
    const recorder: TrackRecorder = await trackStore.startServerRide(signing);
    // Give the recorder something to seal on `finish()`.
    await recorder.addFix({ tMs: startedAtMs + 1000, lat: ROUTE_LAT, lon: ROUTE_LNG0, accM: 5 });

    const { geo } = stubGeolocation();
    vi.stubGlobal("navigator", { ...globalThis.navigator, geolocation: geo });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const rideHud = new RideHud(
      container,
      async () => [],
      fakeMap() as unknown as ConstructorParameters<typeof RideHud>[2],
      fakeDeviceCtl(),
      { session },
    );

    rideHud.beginHandoff({ rideId, startedAtMs, recorder });

    container.querySelector<HTMLButtonElement>('[data-hud="end"]')?.click();
    // `handOffTrackedRideEnd` awaits `recorder.finish()` first — a REAL
    // WebCrypto sign+digest against MemoryTrackStorage, not just a promise
    // microtask, so its wall-clock time varies with machine/CPU load under
    // full-suite parallelism. Poll rather than a fixed-tick flush.
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ type: "endRide" });
    });
    // No PATCH /end from ride-hud.ts itself — Screen 8 owns that now.
    expect(fetchSpy).not.toHaveBeenCalled();
    // The HUD's own view is gone (no competing legacy card underneath
    // whatever `ride-post-s8.ts` mounts elsewhere in the document)...
    expect(container.hidden).toBe(true);
    // ...and specifically never rendered the retired legacy summary markup.
    expect(container.innerHTML).not.toContain("Ride summary");
    // The final batch actually sealed locally.
    const info = recorder.info();
    expect(info.batchCount).toBe(1);
    expect(info.waypointCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// `RideOptions.cost_hud`, finally applied.
//
// `ride-settings.ts`'s own header records that the pre-ride "Est. Veo Cost
// HUD" row was REMOVED because the field it wrote was dead — the live HUD's
// cost readout was unconditional, driven only by ride-cost.ts's always-on
// rate-plan preference. The device card's pre-ride survey (ride-preflight.ts)
// asks about it again and promises the ride "starts without visible HUD
// cost", so it has to actually do something now. These tests are the proof
// that it does, against the real RideHud with a real riding view mounted.
// ---------------------------------------------------------------------------

describe("RideHud cost readout (RideOptions.cost_hud)", () => {
  function mountRiding(): { hud: RideHud; container: HTMLElement } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { geo } = stubGeolocation();
    vi.stubGlobal("navigator", { ...globalThis.navigator, geolocation: geo });
    const hud = new RideHud(
      container,
      async () => [],
      fakeMap() as unknown as ConstructorParameters<typeof RideHud>[2],
      fakeDeviceCtl(),
    );
    return { hud, container };
  }

  const costEl = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector<HTMLElement>("#hud-cost");
    if (!el) throw new Error("the riding view has no #hud-cost readout");
    return el;
  };

  it("shows the readout by default", () => {
    // Every entry point that does not explicitly say otherwise must get
    // exactly what it got before this option was wired up.
    const { hud, container } = mountRiding();
    hud.beginHandoff({ rideId: "r1", startedAtMs: Date.now(), recorder: null });
    expect(costEl(container).hidden).toBe(false);
  });

  it("hides it when the rider turned the cost HUD off before the ride", () => {
    const { hud, container } = mountRiding();
    hud.setCostHudVisible(false);
    hud.beginHandoff({ rideId: "r2", startedAtMs: Date.now(), recorder: null });
    expect(costEl(container).hidden).toBe(true);
  });

  it("leaves the ride clock and speed alone", () => {
    // Only the cost readout is opted out of — a rider who hid the price
    // still wants to know how long they've been riding and how fast.
    const { hud, container } = mountRiding();
    hud.setCostHudVisible(false);
    hud.beginHandoff({ rideId: "r3", startedAtMs: Date.now(), recorder: null });
    expect(container.querySelector<HTMLElement>("#hud-clock")?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#hud-mph")?.hidden).toBe(false);
  });

  it("can be flipped back on mid-ride", () => {
    const { hud, container } = mountRiding();
    hud.setCostHudVisible(false);
    hud.beginHandoff({ rideId: "r4", startedAtMs: Date.now(), recorder: null });
    hud.setCostHudVisible(true);
    expect(costEl(container).hidden).toBe(false);
  });

  it("does not write a cost figure into a hidden readout", () => {
    // Belt and braces: the node is hidden, so a stale price cannot be read
    // by a screen reader or flash up if something else un-hides it.
    const { hud, container } = mountRiding();
    hud.setCostHudVisible(false);
    hud.beginHandoff({
      rideId: "r5",
      startedAtMs: Date.now() - 600_000,
      recorder: null,
    });
    expect(costEl(container).textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The own-device cost fix + the wrench panel's Display chips.
//
// Two related additions, tested together because they share the same seams:
//   1. The Veo cost counter used to apply to EVERY ride, including "My own
//      Device" — a ride Veo isn't billing, so the counter was a picture of a
//      transaction that never happened. `enterRiding` now forces it off for
//      an own-device ride (and the legacy summary drops its cost rows).
//   2. The wrench (adjust) panel gained a "Display" row: per-readout ON/OFF
//      chips for the Veo cost counter, the bottom-right classic (analog)
//      speedometer, and the top-right digital mph — with the initial state
//      finally seeded from `RideOptions.speedometer`, which ride-settings.ts's
//      own header records was never read by the HUD before.
// ---------------------------------------------------------------------------

describe("RideHud own-device cost fix + Display chips", () => {
  function docWith(
    over: Partial<RideSessionDoc>,
    options: Partial<RideOptions> = {},
  ): RideSessionDoc {
    return {
      ...buildDoc("ride-display-1", Date.now() - 5000),
      options: { ...OPTIONS, speedometer: "classic", ...options },
      ...over,
    };
  }

  function mountWith(doc: RideSessionDoc) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { geo } = stubGeolocation();
    vi.stubGlobal("navigator", { ...globalThis.navigator, geolocation: geo });
    const dispatch = vi.fn();
    const hud = new RideHud(
      container,
      async () => [],
      fakeMap() as unknown as ConstructorParameters<typeof RideHud>[2],
      fakeDeviceCtl(),
      { session: { current: () => doc, dispatch } },
    );
    hud.beginHandoff({
      rideId: doc.rideId,
      startedAtMs: doc.startedAtMs as number,
      recorder: null,
    });
    return { hud, container, dispatch };
  }

  const chipFor = (container: HTMLElement, key: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-hud="display"][data-display="${key}"]`,
    );

  function ownDeviceDoc(): RideSessionDoc {
    return docWith(
      {
        rideId: null,
        private: true,
        device: { own: true },
        dest: null,
        route: null,
        trackKeyId: "private-abc123",
      },
      { own_device: true, cost_hud: true },
    );
  }

  it("an own-device ride hides the Veo cost counter even with cost_hud ON, and offers no chip to re-enable it", () => {
    const { container } = mountWith(ownDeviceDoc());
    expect(container.querySelector<HTMLElement>("#hud-cost")?.hidden).toBe(true);
    expect(chipFor(container, "cost")).toBeNull();
    // The speedometer chips are still there — those readouts apply to any
    // ride, whoever owns the wheels.
    expect(chipFor(container, "classic")).not.toBeNull();
    expect(chipFor(container, "digital")).not.toBeNull();
  });

  it("an own-device ride's summary is exactly duration, distance, waypoints — no money copy at all", async () => {
    const { container, dispatch } = mountWith(ownDeviceDoc());
    container.querySelector<HTMLButtonElement>('[data-hud="end"]')?.click();
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ type: "endRide" });
    });
    expect(container.innerHTML).toContain("Ride summary");
    expect(container.innerHTML).toContain("Duration");
    expect(container.innerHTML).toContain("Distance");
    expect(container.innerHTML).toContain("Waypoints");
    // No cost estimate, no comparator, no operator commentary, no
    // Veo-receipt or equity-discount copy — nobody billed this ride.
    expect(container.innerHTML).not.toContain("Est. Veo cost");
    expect(container.innerHTML).not.toContain("Lime");
    expect(container.innerHTML).not.toContain("$");
    expect(container.innerHTML).not.toContain("receipt");
    expect(container.innerHTML).not.toContain("equity zone");
  });

  it("a guest ride on an actual Veo scooter compares against Lime PASS pricing (free unlocks), not per-minute metering", async () => {
    // Guest ride: private (no tracked_rides row → legacy summary), but NOT
    // own-device — a real Veo scooter someone is paying Veo for. A ~5s ride
    // bills 1 started minute → the $2.99 30-minute pass is the comparator.
    const doc = docWith(
      {
        rideId: null,
        private: true,
        device: null,
        dest: null,
        route: null,
        trackKeyId: "private-guest1",
      },
      { own_device: false, cost_hud: true },
    );
    const { container, dispatch } = mountWith(doc);
    container.querySelector<HTMLButtonElement>('[data-hud="end"]')?.click();
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ type: "endRide" });
    });
    expect(container.innerHTML).toContain("Est. Veo cost");
    expect(container.innerHTML).toContain("With a Lime pass");
    expect(container.innerHTML).toContain("$2.99");
    // The old per-minute+unlock comparator row is gone…
    expect(container.innerHTML).not.toContain("typical pricing");
    // …and the free-unlock promise is spelled out.
    expect(container.innerHTML).toContain("no $1 unlock charge");
  });

  it("when the pass beats Veo, the comparison says how many pass minutes the ride would have left over", async () => {
    // 31 billed minutes: Veo resident ≈ $8.75, vs the $4.99 60-minute pass —
    // the one-operator line shows, and the 60-minute pass has 29 minutes of
    // riding left after this ride's 31.
    const doc = docWith(
      {
        rideId: null,
        private: true,
        device: null,
        dest: null,
        route: null,
        // 5s shy of 31 minutes, so the wall-clock ms the test itself burns
        // can't tip billableMinutes' ceil() over into a 32nd minute.
        startedAtMs: Date.now() - (31 * 60_000 - 5000),
        trackKeyId: "private-guest2",
      },
      { own_device: false },
    );
    const { container, dispatch } = mountWith(doc);
    container.querySelector<HTMLButtonElement>('[data-hud="end"]')?.click();
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ type: "endRide" });
    });
    expect(container.innerHTML).toContain(
      "would have covered this ride, and you'd have 29 minutes left to use.",
    );
  });

  it("a tracked Veo-device ride keeps the counter and its chip, exactly as before", () => {
    const { container } = mountWith(docWith({}, { cost_hud: true }));
    expect(container.querySelector<HTMLElement>("#hud-cost")?.hidden).toBe(false);
    expect(chipFor(container, "cost")?.classList.contains("is-on")).toBe(true);
  });

  it("RideOptions.speedometer seeds the readouts: classic shows both, digital only the mph, none neither", () => {
    const corners = (container: HTMLElement) => ({
      digital: container.querySelector<HTMLElement>(".hud-corner--tr")?.hidden,
      classic: container.querySelector<HTMLElement>(".hud-corner--br")?.hidden,
    });
    expect(corners(mountWith(docWith({})).container)).toEqual({
      digital: false,
      classic: false,
    });
    expect(
      corners(mountWith(docWith({}, { speedometer: "digital" })).container),
    ).toEqual({ digital: false, classic: true });
    expect(
      corners(mountWith(docWith({}, { speedometer: "none" })).container),
    ).toEqual({ digital: true, classic: true });
  });

  it("the Display chips flip each readout live, and the choice survives a BRB resume's DOM rebuild", () => {
    const { hud, container } = mountWith(docWith({}, { cost_hud: true }));

    chipFor(container, "classic")?.click();
    expect(container.querySelector<HTMLElement>(".hud-corner--br")?.hidden).toBe(true);
    expect(chipFor(container, "classic")?.getAttribute("aria-pressed")).toBe("false");

    chipFor(container, "digital")?.click();
    expect(container.querySelector<HTMLElement>(".hud-corner--tr")?.hidden).toBe(true);

    chipFor(container, "cost")?.click();
    expect(container.querySelector<HTMLElement>("#hud-cost")?.hidden).toBe(true);

    // Flip the digital mph back on — independent of the other two.
    chipFor(container, "digital")?.click();
    expect(container.querySelector<HTMLElement>(".hud-corner--tr")?.hidden).toBe(false);

    // BRB and resume: renderRiding() rebuilds the whole riding DOM, which
    // comes back with every corner visible — the flags must be re-asserted,
    // and the chips must reflect them.
    container.querySelector<HTMLButtonElement>('[data-hud="exit"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-hud="brb"]')?.click();
    expect(hud.isPaused()).toBe(true);
    hud.open(); // resume
    expect(container.querySelector<HTMLElement>(".hud-corner--br")?.hidden).toBe(true);
    expect(container.querySelector<HTMLElement>(".hud-corner--tr")?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#hud-cost")?.hidden).toBe(true);
    expect(chipFor(container, "classic")?.getAttribute("aria-pressed")).toBe("false");
    expect(chipFor(container, "digital")?.getAttribute("aria-pressed")).toBe("true");
    expect(chipFor(container, "cost")?.getAttribute("aria-pressed")).toBe("false");
  });
});
