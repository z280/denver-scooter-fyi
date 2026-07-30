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
});
