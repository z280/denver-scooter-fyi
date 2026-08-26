// @vitest-environment happy-dom
//
// The wiring between a destination, the reach filter, and the device card.
//
// `reach.test.ts` covers the arithmetic — the detour factor, the reserve, the
// unknown case. This file exists because that was the ONLY thing covered:
// nothing touched `setTripDest`, `setReachFilter`, or the card's arrival line,
// and all three defects this file pins lived in exactly that gap.
//
// They shared one root cause. A single `reachDest` field meant both "there is
// somewhere to arrive" and "the rider ticked the filter", and the card keyed
// off it, so:
//
//   1. a rider with a destination saw NOTHING on the card unless they had also
//      found and ticked a filter;
//   2. toggling the filter with a card open left the card stale, because
//      `apply` repaints the map and does not rebuild an open popup;
//   3. "probably won't reach" could never render, because by the time the
//      field was set every such scooter had been filtered off the map.
//
// The Popup mock is the one from devices-popup-gate.test.ts, and for the same
// reason: the real one needs a live GL context, and the assertions should run
// against the markup the popup is actually built from.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("./map-auth.js", () => ({
  isAuthenticated: () => true,
  getAuth: () => ({ token: "tok-1" }),
}));
vi.mock("./geocode.ts", () => ({ reverseGeocode: () => Promise.resolve(null) }));

import { Devices } from "./devices.ts";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import type { Map as MLMap } from "maplibre-gl";
import type { Locate, LngLat } from "./locate.ts";

const SCOOTER: [number, number] = [-104.9903, 39.7392];
/** ~2 km due north — far enough that a nearly-flat vehicle cannot make it. */
const DEST = { lat: 39.7572, lon: -104.9903 };
const AT_SCOOTER: LngLat = { lng: SCOOTER[0], lat: SCOOTER[1] };

let lastSetData: DevicesResponse | null = null;

function fakeMap() {
  return {
    getSource: () => ({
      setData: (d: DevicesResponse) => {
        lastSetData = d;
      },
    }),
    hasImage: () => true,
    addImage: () => {},
    easeTo: () => {},
    getZoom: () => 16,
  };
}

function fakeLocate(): Locate {
  return {
    onFix: () => () => {},
    current: () => AT_SCOOTER,
    showLineTo: () => {},
    clearLine: () => {},
  } as unknown as Locate;
}

function feature(
  id: string,
  rangeMeters: number | null,
  batteryPercent: number,
): GeoJSON.Feature<GeoJSON.Point, DeviceProperties> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: SCOOTER },
    properties: {
      device_id: id,
      form_factor: "scooter",
      spatial_status: "available",
      vehicle_plate: "12345",
      current_range_meters: rangeMeters,
      battery_percent: batteryPercent,
    } as unknown as DeviceProperties,
  };
}

function response(
  features: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
): DevicesResponse {
  return {
    type: "FeatureCollection",
    metadata: {
      cycle_id: "c1",
      snapshot_time: "2026-07-30T00:00:00Z",
      device_count: features.length,
      filters: {},
    },
    features,
  };
}

/** Plenty of range for a 2 km trip, and nowhere near enough. */
const PLENTY = () => feature("far", 20_000, 90);
const NEARLY_FLAT = () => feature("flat", 900, 8);

function makeDevices(
  feats: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
) {
  const d = new Devices(fakeMap() as unknown as MLMap, fakeLocate());
  d.setData(response(feats));
  return d;
}

const shownIds = (): string[] =>
  (lastSetData?.features ?? []).map((f) => String(f.properties.device_id));

beforeEach(() => {
  lastPopupHtml = "";
  lastSetData = null;
});

describe("the card answers whenever there is somewhere to arrive", () => {
  it("says what you would arrive with, WITHOUT the filter being on", () => {
    // THE DEFECT. The estimate used to require the rider to have ticked a
    // filter, so most riders never saw the number the feature exists to give.
    const d = makeDevices([PLENTY()]);
    d.setTripDest(DEST);
    d.jumpToDevice("far", SCOOTER[0], SCOOTER[1]);
    expect(lastPopupHtml).toContain("left when you arrive");
    expect(d.reachFilterOn()).toBe(false);
  });

  it("says PROBABLY NOT for a scooter that cannot make it", () => {
    // Unreachable before: this branch only rendered while the filter was on,
    // and the filter had already removed every scooter that would show it.
    const d = makeDevices([NEARLY_FLAT()]);
    d.setTripDest(DEST);
    d.jumpToDevice("flat", SCOOTER[0], SCOOTER[1]);
    expect(lastPopupHtml).toContain("won't reach your destination");
  });

  it("says nothing at all with no trip set", () => {
    // With nowhere to go it is an answer to no question.
    const d = makeDevices([PLENTY()]);
    d.jumpToDevice("far", SCOOTER[0], SCOOTER[1]);
    expect(lastPopupHtml).not.toContain("when you arrive");
    expect(lastPopupHtml).not.toContain("won't reach");
  });

  it("stops answering once the trip is cleared", () => {
    const d = makeDevices([PLENTY()]);
    d.setTripDest(DEST);
    d.setTripDest(null);
    d.jumpToDevice("far", SCOOTER[0], SCOOTER[1]);
    expect(lastPopupHtml).not.toContain("when you arrive");
  });
});

describe("an open card keeps up with the controls", () => {
  it("gains the arrival line when a destination is set behind it", () => {
    // `apply` repaints the map and leaves an open popup alone; the pairing
    // with `refreshOpenPopup` is what makes the card follow the controls.
    const d = makeDevices([PLENTY()]);
    d.jumpToDevice("far", SCOOTER[0], SCOOTER[1]);
    expect(lastPopupHtml).not.toContain("when you arrive");
    d.setTripDest(DEST);
    expect(lastPopupHtml).toContain("left when you arrive");
  });

  it("loses it again when the trip is cleared behind it", () => {
    const d = makeDevices([PLENTY()]);
    d.setTripDest(DEST);
    d.jumpToDevice("far", SCOOTER[0], SCOOTER[1]);
    expect(lastPopupHtml).toContain("when you arrive");
    d.setTripDest(null);
    expect(lastPopupHtml).not.toContain("when you arrive");
  });
});

describe("the filter thins the map, and only the map", () => {
  it("does nothing until BOTH a trip and the checkbox are set", () => {
    const d = makeDevices([PLENTY(), NEARLY_FLAT()]);
    d.setReachFilter(true);
    // A checkbox with nothing to reach is not a filter.
    expect(d.reachFilterOn()).toBe(false);
    expect(shownIds().sort()).toEqual(["far", "flat"]);
  });

  it("hides the ones that cannot make it once both are set", () => {
    const d = makeDevices([PLENTY(), NEARLY_FLAT()]);
    d.setTripDest(DEST);
    d.setReachFilter(true);
    expect(d.reachFilterOn()).toBe(true);
    expect(shownIds()).toEqual(["far"]);
  });

  it("keeps showing them while the filter is off, trip or no trip", () => {
    const d = makeDevices([PLENTY(), NEARLY_FLAT()]);
    d.setTripDest(DEST);
    expect(shownIds().sort()).toEqual(["far", "flat"]);
  });

  it("turns itself off when the trip goes, not just when the box is cleared", () => {
    const d = makeDevices([PLENTY(), NEARLY_FLAT()]);
    d.setTripDest(DEST);
    d.setReachFilter(true);
    expect(shownIds()).toEqual(["far"]);
    d.setTripDest(null);
    expect(d.reachFilterOn()).toBe(false);
    expect(shownIds().sort()).toEqual(["far", "flat"]);
  });

  it("keeps a vehicle whose range the feed never gave", () => {
    // `unknown` is not `no`. Hiding a working scooter on a missing field is
    // the worse error, and this is the filter's half of that rule.
    const d = makeDevices([feature("norange", null, 50)]);
    d.setTripDest(DEST);
    d.setReachFilter(true);
    expect(shownIds()).toEqual(["norange"]);
  });
});
