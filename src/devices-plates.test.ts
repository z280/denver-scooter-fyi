// @vitest-environment happy-dom
//
// The device popup's plate, now from OUR API (`/vehicles/plates`, plates.ts)
// instead of Veo's feed fetched by the browser. Signed in: the popup asks for
// its own device when the nearby batch hasn't covered it, and re-renders with
// the Open-in-Veo link once the plate lands. Signed out: nothing is asked at
// all, and the sign-in gate (not a "looking up" hint) is what the rider sees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let lastPopupHtml = "";

vi.mock("maplibre-gl", () => {
  class FakePopup {
    private el: HTMLElement | null = null;
    setLngLat(): this {
      return this;
    }
    setHTML(html: string): this {
      lastPopupHtml = html;
      const el = document.createElement("div");
      el.innerHTML = html;
      this.el = el;
      return this;
    }
    addTo(): this {
      return this;
    }
    getElement(): HTMLElement | null {
      return this.el;
    }
    remove(): this {
      return this;
    }
    on(): this {
      return this;
    }
  }
  return { default: { Popup: FakePopup } };
});

let signedIn = true;
vi.mock("./map-auth.js", () => ({
  isAuthenticated: () => signedIn,
  getAuth: () => (signedIn ? { token: "tok-1" } : null),
}));
vi.mock("./geocode.ts", () => ({ reverseGeocode: () => Promise.resolve(null) }));

import { Devices } from "./devices.ts";
import { resetSharedPlateIndex } from "./plates.ts";
import { _resetTelemetryForTests } from "./telemetry.ts";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import type { Map as MLMap } from "maplibre-gl";
import type { Locate, LngLat } from "./locate.ts";

const DEVICE: [number, number] = [-104.99, 39.74];
const NEAR: LngLat = { lng: DEVICE[0] + 0.0002, lat: DEVICE[1] };

function fakeMap() {
  const setData = vi.fn();
  return {
    getSource: () => ({ setData }),
    hasImage: () => true,
    addImage: () => {},
    easeTo: () => {},
    getZoom: () => 16,
  };
}

function fakeLocate(fix: LngLat | null) {
  const listeners: ((p: LngLat) => void)[] = [];
  const locate = {
    onFix: (cb: (p: LngLat) => void) => {
      listeners.push(cb);
      return () => {};
    },
    current: () => fix,
    showLineTo: () => {},
    clearLine: () => {},
  } as unknown as Locate;
  return { locate, emit: (p: LngLat) => listeners.forEach((cb) => cb(p)) };
}

function feature(
  id: string,
  coords: [number, number] = DEVICE,
): GeoJSON.Feature<GeoJSON.Point, DeviceProperties> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: coords },
    properties: {
      device_id: id,
      form_factor: "scooter",
      spatial_status: "available",
      vehicle_identifier: "a1b2c3d4e5f60701",
    } as DeviceProperties,
  };
}

function response(
  features: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
): DevicesResponse {
  return {
    type: "FeatureCollection",
    metadata: {
      cycle_id: "c1",
      snapshot_time: "2026-10-08T00:00:00Z",
      device_count: features.length,
      filters: {},
    },
    features,
  };
}

function platesFetch(plates: Record<string, string>) {
  return vi.fn((url: string, _init?: RequestInit) => {
    if (String(url).includes("/api/v1/vehicles/plates")) {
      return Promise.resolve(
        new Response(JSON.stringify({ plates, as_of: "2026-10-08T00:00:00Z" }), {
          status: 200,
        }),
      );
    }
    // Everything else the popup may ask for (dibs, photos, telemetry).
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

const plateCalls = (spy: ReturnType<typeof platesFetch>) =>
  spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/vehicles/plates"));

beforeEach(() => {
  lastPopupHtml = "";
  signedIn = true;
  resetSharedPlateIndex();
  _resetTelemetryForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("device popup plates via /vehicles/plates", () => {
  it("signed in: asks for this device, then fills Open in Veo with the plate", async () => {
    const spy = platesFetch({ d1: "1025543" });
    vi.stubGlobal("fetch", spy);
    const { locate } = fakeLocate(NEAR);
    const devices = new Devices(fakeMap() as unknown as MLMap, locate);
    devices.setData(response([feature("d1")]));
    devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
    expect(lastPopupHtml).toContain("Looking up this scooter");
    await vi.waitFor(() => expect(lastPopupHtml).toContain("number=1025543"));
    const calls = plateCalls(spy);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("device_ids=d1");
    expect(calls.join(" ")).not.toMatch(/veoride/i);
  });

  it("signed in, API has no plate: says so instead of 'try again'", async () => {
    vi.stubGlobal("fetch", platesFetch({}));
    const { locate } = fakeLocate(NEAR);
    const devices = new Devices(fakeMap() as unknown as MLMap, locate);
    devices.setData(response([feature("d1")]));
    devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
    await settle();
    await settle();
    // Re-open: the answer ("none") is cached now.
    devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
    expect(lastPopupHtml).toContain("We don&#39;t have this scooter");
  });

  it("signed out: never calls the forward endpoint; the sign-in gate is the hint", async () => {
    signedIn = false;
    const spy = platesFetch({ d1: "1025543" });
    vi.stubGlobal("fetch", spy);
    const { locate, emit } = fakeLocate(NEAR);
    const devices = new Devices(fakeMap() as unknown as MLMap, locate);
    devices.setData(response([feature("d1")]));
    emit(NEAR);
    devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
    await settle();
    expect(plateCalls(spy)).toEqual([]);
    expect(lastPopupHtml).not.toContain("Looking up this scooter");
    expect(lastPopupHtml).toContain("Sign in");
    expect(lastPopupHtml).not.toContain("number=");
  });

  it("first fix primes the ≤50 nearest; small moves don't re-ask", async () => {
    const spy = platesFetch({});
    vi.stubGlobal("fetch", spy);
    const { locate, emit } = fakeLocate(NEAR);
    const devices = new Devices(fakeMap() as unknown as MLMap, locate);
    const feats = Array.from({ length: 70 }, (_, i) =>
      feature(`d${i}`, [DEVICE[0] + i * 0.0005, DEVICE[1]]),
    );
    devices.setData(response(feats));
    emit({ lng: DEVICE[0], lat: DEVICE[1] });
    await vi.waitFor(() => expect(plateCalls(spy)).toHaveLength(1));
    const ids = decodeURIComponent(plateCalls(spy)[0].split("device_ids=")[1]).split(",");
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("d0");
    expect(ids).not.toContain("d60");
    // A few metres of GPS jitter, many times: no further requests.
    for (let i = 0; i < 20; i++) emit({ lng: DEVICE[0] + 0.00001 * i, lat: DEVICE[1] });
    await settle();
    expect(plateCalls(spy)).toHaveLength(1);
  });
});
