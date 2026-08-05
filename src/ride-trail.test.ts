// @vitest-environment happy-dom
//
// The display half of Save Ride Tracks: the option's own copy promises the
// rider they can "trace where you've been on the map display" while they ride,
// and until `ride-trail.ts` landed only the recording half existed — every fix
// was sealed into IndexedDB and none of it was ever drawn.
//
// Two levels here, deliberately:
//
//   1. `ride-trail.ts` alone — the flatten, and the source/layer/setData
//      behavior against a fake map that records what it was handed.
//   2. The WIRING, through the real `RideHud` class and a real `TrackRecorder`
//      (`MemoryTrackStorage`-backed), driven only through public entry points
//      (`beginHandoff` / `attachTrackRecorder` + the geolocation callback the
//      HUD registers itself). That level is what actually proves the reported
//      bug is fixed: fixes reaching track-store was never in doubt
//      (`ride-hud-integration.test.ts` proves it) — reaching the MAP was.
//
// The maplibre mock and the geolocation stub follow
// `ride-hud-integration.test.ts`'s approach, and for its reasons: real marker
// wiring needs a live WebGL canvas happy-dom cannot provide.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => {
  class FakeMarker {
    constructor(readonly opts: { element: HTMLElement }) {}
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

import { createRideTrail, trailCoordsFromBatches } from "./ride-trail.ts";
import {
  RideHud,
  type RideDeviceControl,
  type RideHudTrackControl,
} from "./ride-hud.ts";
import {
  MemoryTrackStorage,
  base64UrlEncode,
  bytesToHex,
  openTrackStore,
  type StoredTrackBatch,
  type TrackRecorder,
} from "./track-store.ts";
import type { RideOptions, TrackSigning } from "./api.ts";
import type { RideSessionDoc } from "./ride-session.ts";

const LAT = 39.7392;
const LNG0 = -104.9903;
const STEP = 0.0002;

// ---------------------------------------------------------------------------
// A fake map that is a real (tiny) source/layer registry: the trail's whole
// job is "what did you hand MapLibre", so a fake that forgets is useless.
// ---------------------------------------------------------------------------

interface FakeSource {
  data: GeoJSON.FeatureCollection;
}

function fakeMap() {
  const sources = new Map<string, FakeSource>();
  const layers = new Map<string, { visibility: string }>();
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 600 });
  const map = {
    addSource(id: string, spec: { data: GeoJSON.FeatureCollection }) {
      sources.set(id, { data: spec.data });
    },
    getSource(id: string) {
      const src = sources.get(id);
      if (!src) return undefined;
      return {
        setData(data: GeoJSON.FeatureCollection) {
          src.data = data;
        },
      };
    },
    addLayer(spec: { id: string }) {
      layers.set(spec.id, { visibility: "visible" });
    },
    getLayer(id: string) {
      return layers.has(id) ? { id } : undefined;
    },
    removeLayer(id: string) {
      layers.delete(id);
    },
    setLayoutProperty(id: string, _prop: string, value: string) {
      const layer = layers.get(id);
      if (layer) layer.visibility = value;
    },
    // Everything below is what RideHud (not the trail) calls.
    getCenter: () => ({ lng: LNG0, lat: LAT }),
    getZoom: () => 14,
    getPitch: () => 0,
    getBearing: () => 0,
    easeTo: () => {},
    setPaintProperty: () => {},
    getStyle: () => ({ layers: [] }),
    getContainer: () => container,
  };
  return {
    map,
    /** The trail's drawn FeatureCollection, or null before it drew anything. */
    data: (): GeoJSON.FeatureCollection | null =>
      sources.get("ride-trail")?.data ?? null,
    /** The coordinates of the drawn LineString, or [] when there is none. */
    line: (): [number, number][] => {
      const fc = sources.get("ride-trail")?.data;
      const feat = fc?.features.find((f) => f.geometry.type === "LineString");
      return feat
        ? ((feat.geometry as GeoJSON.LineString).coordinates as [number, number][])
        : [];
    },
    visibility: (): string | null =>
      layers.get("ride-trail-line")?.visibility ?? null,
    layerIds: (): string[] => [...layers.keys()],
  };
}

type MapRig = ReturnType<typeof fakeMap>;

function asMap(rig: MapRig): ConstructorParameters<typeof RideHud>[2] {
  return rig.map as unknown as ConstructorParameters<typeof RideHud>[2];
}

// ---------------------------------------------------------------------------
// Track-store helpers: a real recorder, so "what the store accepted" is the
// store's own answer rather than this file's opinion of it.
// ---------------------------------------------------------------------------

async function genSigning(rideId: string): Promise<TrackSigning> {
  return {
    alg: "HS256",
    key_id: rideId,
    key: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
    nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    issued_at: new Date().toISOString(),
  };
}

async function freshRecorder(rideId: string): Promise<TrackRecorder> {
  const store = await openTrackStore({ storage: new MemoryTrackStorage() });
  return store.startServerRide(await genSigning(rideId));
}

const OPTIONS: RideOptions = {
  cost_hud: true,
  speedometer: "digital",
  theme: "auto",
  navigation: false,
  save_tracks: true,
  battery_modeling: true,
  nav_improvement: false,
  end_survey: true,
  own_device: false,
};

function buildDoc(
  rideId: string,
  startedAtMs: number,
  options: RideOptions = OPTIONS,
): RideSessionDoc {
  return {
    v: 1,
    state: "riding",
    screen: null,
    rideId,
    private: false,
    device: null,
    options,
    dest: null,
    route: null,
    startedAtMs,
    trackKeyId: rideId,
  };
}

function fakeDeviceCtl(): RideDeviceControl {
  return {
    setRideActive: () => {},
    setRideModelFilter: () => {},
    hasOpenPopup: () => false,
  };
}

function stubGeolocation(): {
  geo: { watchPosition(cb: (f: GeolocationPosition) => void): number; clearWatch(id: number): void };
  captured: () => (fix: GeolocationPosition) => void;
} {
  let success: ((fix: GeolocationPosition) => void) | null = null;
  return {
    geo: {
      watchPosition: (cb) => {
        success = cb;
        return 1;
      },
      clearWatch: () => {},
    },
    captured: () => {
      if (!success) throw new Error("test bug: watchPosition was never called");
      return success;
    },
  };
}

function fix(i: number, tMs: number): GeolocationPosition {
  return {
    coords: {
      latitude: LAT,
      longitude: LNG0 + i * STEP,
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

/** Let the HUD's fire-and-forget `addFix(...).then(draw)` chain settle. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------

describe("trailCoordsFromBatches", () => {
  it("flattens sealed batches in seq order, flipped into GeoJSON [lng, lat]", async () => {
    const recorder = await freshRecorder("ride-flatten");
    for (let i = 0; i < 30; i += 1) {
      await recorder.addFix({ tMs: 1000 + i * 1000, lat: LAT, lon: LNG0 + i * STEP });
    }
    // 30 fixes at the 25-waypoint seal bound: batch 0 is sealed, 5 are still
    // open — so this is also a check that a seed only ever claims what is
    // actually sealed.
    const batches = await recorder.batches();
    expect(batches.length).toBe(1);

    const coords = trailCoordsFromBatches(batches);
    expect(coords.length).toBe(25);
    expect(coords[0]).toEqual([Number(LNG0.toFixed(6)), LAT]);
    expect(coords[24]).toEqual([Number((LNG0 + 24 * STEP).toFixed(6)), LAT]);
  });

  it("orders by seq, not by array position", async () => {
    const recorder = await freshRecorder("ride-order");
    for (let i = 0; i < 50; i += 1) {
      await recorder.addFix({ tMs: 1000 + i * 1000, lat: LAT, lon: LNG0 + i * STEP });
    }
    const [b0, b1] = await recorder.batches();
    expect(trailCoordsFromBatches([b1, b0])).toEqual(
      trailCoordsFromBatches([b0, b1]),
    );
  });

  it("skips an undecodable batch instead of losing the whole trail", async () => {
    const recorder = await freshRecorder("ride-bad-batch");
    for (let i = 0; i < 25; i += 1) {
      await recorder.addFix({ tMs: 1000 + i * 1000, lat: LAT, lon: LNG0 + i * STEP });
    }
    const [good] = await recorder.batches();
    const bad: StoredTrackBatch = { ...good, seq: 1, jws: "not-a-jws" };
    expect(trailCoordsFromBatches([good, bad]).length).toBe(25);
  });

  it("has nothing to draw for no batches", () => {
    expect(trailCoordsFromBatches([])).toEqual([]);
  });
});

describe("createRideTrail", () => {
  it("creates its layers lazily — a map that never sees a ride never gains them", () => {
    const rig = fakeMap();
    createRideTrail(rig.map as never);
    expect(rig.layerIds()).toEqual([]);
  });

  it("draws a start point but no LineString for a single waypoint", () => {
    const rig = fakeMap();
    const trail = createRideTrail(rig.map as never);
    trail.push([LNG0, LAT]);
    const fc = rig.data();
    expect(fc?.features.map((f) => f.geometry.type)).toEqual(["Point"]);
    expect(rig.line()).toEqual([]);
  });

  it("extends the LineString fix by fix, keeping the start where the ride began", () => {
    const rig = fakeMap();
    const trail = createRideTrail(rig.map as never);
    trail.push([LNG0, LAT]);
    trail.push([LNG0 + STEP, LAT]);
    trail.push([LNG0 + 2 * STEP, LAT]);
    expect(rig.line()).toEqual([
      [LNG0, LAT],
      [LNG0 + STEP, LAT],
      [LNG0 + 2 * STEP, LAT],
    ]);
    const start = rig.data()?.features.find((f) => f.geometry.type === "Point");
    expect((start?.geometry as GeoJSON.Point).coordinates).toEqual([LNG0, LAT]);
  });

  it("prepend puts a resumed ride's recorded history BEFORE what it has drawn live", () => {
    const rig = fakeMap();
    const trail = createRideTrail(rig.map as never);
    // A live fix beat the (async) seed read to the draw call.
    trail.push([LNG0 + 2 * STEP, LAT]);
    trail.prepend([
      [LNG0, LAT],
      [LNG0 + STEP, LAT],
    ]);
    expect(rig.line()).toEqual([
      [LNG0, LAT],
      [LNG0 + STEP, LAT],
      [LNG0 + 2 * STEP, LAT],
    ]);
  });

  it("setVisible hides the drawn line without forgetting it; clear forgets it", () => {
    const rig = fakeMap();
    const trail = createRideTrail(rig.map as never);
    trail.push([LNG0, LAT]);
    trail.push([LNG0 + STEP, LAT]);

    trail.setVisible(false);
    expect(rig.visibility()).toBe("none");
    expect(trail.coords().length).toBe(2);
    // `coords()` hands out a copy, not the live array the next push extends.
    trail.coords().push([0, 0]);
    expect(trail.coords().length).toBe(2);
    expect(rig.line().length).toBe(2);

    trail.setVisible(true);
    expect(rig.visibility()).toBe("visible");

    trail.clear();
    expect(trail.coords()).toEqual([]);
    expect(rig.data()?.features).toEqual([]);
  });

  it("reset replaces the trail — a new ride never inherits the last one's line", () => {
    const rig = fakeMap();
    const trail = createRideTrail(rig.map as never);
    trail.push([LNG0, LAT]);
    trail.push([LNG0 + STEP, LAT]);
    trail.reset();
    expect(trail.coords()).toEqual([]);
    trail.reset([
      [LNG0, LAT],
      [LNG0 + STEP, LAT],
      [LNG0 + 2 * STEP, LAT],
    ]);
    expect(rig.line().length).toBe(3);
  });
});

describe("RideHud draws the track it is recording (the reported bug)", () => {
  let rig: MapRig;

  beforeEach(() => {
    rig = fakeMap();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mountHud(opts: {
    doc: RideSessionDoc | null;
    recorder: RideHudTrackControl | null;
  }): {
    hud: RideHud;
    container: HTMLElement;
    onFix: () => (fix: GeolocationPosition) => void;
  } {
    const { geo, captured } = stubGeolocation();
    vi.stubGlobal("navigator", { ...globalThis.navigator, geolocation: geo });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const trail = createRideTrail(rig.map as never);
    const hud = new RideHud(container, async () => [], asMap(rig), fakeDeviceCtl(), {
      session: opts.doc
        ? { current: () => opts.doc, dispatch: vi.fn() }
        : undefined,
      trail,
    });
    hud.beginHandoff({
      rideId: opts.doc?.rideId ?? null,
      startedAtMs: opts.doc?.startedAtMs ?? Date.now(),
      recorder: opts.recorder,
    });
    return { hud, container, onFix: captured };
  }

  it("every fix track-store accepts also lands on the map", async () => {
    const startedAtMs = Date.parse("2026-08-05T18:00:00.000Z");
    const recorder = await freshRecorder("ride-draw");
    const { onFix } = mountHud({
      doc: buildDoc("ride-draw", startedAtMs),
      recorder,
    });

    for (let i = 0; i < 4; i += 1) onFix()(fix(i, startedAtMs + 1000 + i * 3000));
    await flush();

    // The store's own count and the drawn line agree — the point of the fix.
    const info = recorder.info();
    expect(info.waypointCount + info.pendingCount).toBe(4);
    expect(rig.line().length).toBe(4);
    expect(rig.line()[0]).toEqual([LNG0, LAT]);
    expect(rig.line()[3]).toEqual([LNG0 + 3 * STEP, LAT]);
  });

  it("a fix track-store REJECTS is not drawn — the line is the saved track, not the raw GPS feed", async () => {
    const startedAtMs = Date.parse("2026-08-05T18:00:00.000Z");
    const recorder = await freshRecorder("ride-reject");
    const { onFix } = mountHud({
      doc: buildDoc("ride-reject", startedAtMs),
      recorder,
    });

    onFix()(fix(0, startedAtMs + 1000));
    await flush();
    // Same timestamp again: the recorder rejects it as non-monotonic (the
    // API's strict-increase check), so it is not saved and must not be drawn.
    onFix()(fix(9, startedAtMs + 1000));
    await flush();

    expect(recorder.info().pendingCount).toBe(1);
    expect(rig.line()).toEqual([]); // one waypoint = a start point, no line
    expect(rig.data()?.features.length).toBe(1);

    onFix()(fix(1, startedAtMs + 4000));
    await flush();
    expect(rig.line()).toEqual([
      [LNG0, LAT],
      [LNG0 + STEP, LAT],
    ]);
  });

  it("seeds a resumed ride with what it already recorded, under the fixes that arrive next", async () => {
    // The reload-mid-ride path: `main.ts`'s `recoverActiveRide` resumes a
    // recorder out of IndexedDB and hands it to `beginHandoff`. Without the
    // seed the rider's trail would silently restart from wherever they
    // happened to be standing when the page came back.
    const startedAtMs = Date.parse("2026-08-05T18:00:00.000Z");
    const storage = new MemoryTrackStorage();
    const before = await openTrackStore({ storage });
    const first = await before.startServerRide(await genSigning("ride-resume"));
    for (let i = 0; i < 25; i += 1) {
      await first.addFix({
        tMs: startedAtMs + 1000 + i * 1000,
        lat: LAT,
        lon: LNG0 + i * STEP,
      });
    }
    expect((await first.batches()).length).toBe(1);

    // "Reload": a fresh store over the SAME storage, as ride-reload.test.ts
    // models it.
    const after = await openTrackStore({ storage });
    const resumed = await after.resumeRide("ride-resume");
    expect(resumed.continued).toBe(true);

    const { onFix } = mountHud({
      doc: buildDoc("ride-resume", startedAtMs),
      recorder: resumed.recorder,
    });
    // A live fix arrives before the (async) seed read lands — it must end up
    // AFTER the recovered history, not instead of it.
    onFix()(fix(25, startedAtMs + 60_000));
    await flush();

    expect(rig.line().length).toBe(26);
    expect(rig.line()[0]).toEqual([Number(LNG0.toFixed(6)), LAT]);
    expect(rig.line()[25]).toEqual([LNG0 + 25 * STEP, LAT]);
  });

  it("a resume seed that lands AFTER End Ride does not repaint the trail", async () => {
    // Review catch: the seed read is async, and guarding it on "has another
    // ride started?" alone left the window where THIS ride ends first — the
    // late `prepend` would then paint a finished ride's history back onto a
    // map with no ride on it.
    const startedAtMs = Date.parse("2026-08-05T18:00:00.000Z");
    const storage = new MemoryTrackStorage();
    const before = await openTrackStore({ storage });
    const first = await before.startServerRide(await genSigning("ride-late-seed"));
    for (let i = 0; i < 25; i += 1) {
      await first.addFix({
        tMs: startedAtMs + 1000 + i * 1000,
        lat: LAT,
        lon: LNG0 + i * STEP,
      });
    }
    const after = await openTrackStore({ storage });
    const resumed = await after.resumeRide("ride-late-seed");

    // Hold the seed read open until the ride is over.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowRecorder: RideHudTrackControl = {
      addFix: (f) => resumed.recorder.addFix(f),
      finish: () => resumed.recorder.finish(),
      batches: async () => {
        await gate;
        return resumed.recorder.batches();
      },
    };

    const { container } = mountHud({
      doc: buildDoc("ride-late-seed", startedAtMs),
      recorder: slowRecorder,
    });

    container.querySelector<HTMLButtonElement>('[data-hud="exit"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-hud="end"]')?.click();
    await flush();
    expect(rig.data()?.features).toEqual([]);

    release();
    await flush();
    expect(rig.data()?.features).toEqual([]);
  });

  it("draws nothing when the rider turned Save Ride Tracks off", async () => {
    const startedAtMs = Date.parse("2026-08-05T18:00:00.000Z");
    const recorder = await freshRecorder("ride-notracks");
    const { onFix } = mountHud({
      doc: buildDoc("ride-notracks", startedAtMs, {
        ...OPTIONS,
        save_tracks: false,
        battery_modeling: false,
      }),
      recorder,
    });

    for (let i = 0; i < 3; i += 1) onFix()(fix(i, startedAtMs + 1000 + i * 3000));
    await flush();

    expect(rig.data()?.features ?? []).toEqual([]);
  });

  it("BRB hides the trail without forgetting it, and resuming brings it back whole", async () => {
    const startedAtMs = Date.parse("2026-08-05T18:00:00.000Z");
    const recorder = await freshRecorder("ride-brb");
    const { hud, container, onFix } = mountHud({
      doc: buildDoc("ride-brb", startedAtMs),
      recorder,
    });

    for (let i = 0; i < 3; i += 1) onFix()(fix(i, startedAtMs + 1000 + i * 3000));
    await flush();
    expect(rig.line().length).toBe(3);

    // BRB: the ride keeps going (and a tracked ride keeps recording), but the
    // map goes back to Analysis / Find wheels, where this line doesn't belong.
    container.querySelector<HTMLButtonElement>('[data-hud="exit"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-hud="brb"]')?.click();
    expect(hud.isPaused()).toBe(true);
    expect(rig.visibility()).toBe("none");
    expect(rig.line().length).toBe(3);

    // A tracked ride keeps its watcher through BRB, so the recording that
    // happened while backgrounded is on the map the moment the HUD returns.
    onFix()(fix(3, startedAtMs + 20_000));
    await flush();

    hud.open(); // the `paused` branch: resume, don't re-arm
    expect(rig.visibility()).toBe("visible");
    expect(rig.line().length).toBe(4);
  });

  it("End Ride wipes the live trail off the map", async () => {
    const startedAtMs = Date.parse("2026-08-05T18:00:00.000Z");
    const recorder = await freshRecorder("ride-end");
    const { container, onFix } = mountHud({
      doc: buildDoc("ride-end", startedAtMs),
      recorder,
    });

    for (let i = 0; i < 3; i += 1) onFix()(fix(i, startedAtMs + 1000 + i * 3000));
    await flush();
    expect(rig.line().length).toBe(3);

    container.querySelector<HTMLButtonElement>('[data-hud="exit"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-hud="end"]')?.click();
    await flush();

    expect(rig.data()?.features).toEqual([]);
  });
});
