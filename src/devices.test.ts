// Devices.setLeaderboardActive — the ONE devices.ts addition the 🏆
// Leaderboard lane makes (frontend plan's `devices.ts` row: "the leaderboard
// gets a new setLeaderboardActive(on) — an internal flag that short-circuits
// filtered() to [] ... and calls hideMapTooltip()"). Scope is deliberately
// narrow: this file exists only to prove that flag composes correctly with
// the ride HUD's own hide reason (`setRideModelFilter`'s empty-set "show
// none") without either un-hiding the other — everything else `Devices` does
// is out of this lane's ownership and untested here.
//
// No `@vitest-environment happy-dom`: the fake `Map` below stubs `hasImage`
// to always return true, so `apply()` never reaches `addImage`/canvas code,
// and `setLeaderboardActive(true)`'s `hideMapTooltip()` call is a no-op when
// no tooltip was ever opened (its module-private `tooltipEl` starts `null`)
// — so nothing here touches `document`.
import { describe, expect, it, vi } from "vitest";

import { Devices, type ModelKey } from "./devices.ts";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import type { Map as MLMap } from "maplibre-gl";
import type { Locate } from "./locate.ts";

function fakeMap() {
  const setData = vi.fn();
  return {
    getSource: () => ({ setData }),
    hasImage: () => true,
    addImage: () => {},
    // setLayoutProperty/setPaintProperty intentionally absent: applyPaint()
    // wraps both in try/catch ("layer might not be added yet").
  };
}

function fakeLocate(): Locate {
  return { onFix: () => () => {} } as unknown as Locate;
}

function feature(id: string): GeoJSON.Feature<GeoJSON.Point, DeviceProperties> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-104.99, 39.74] },
    properties: {
      device_id: id,
      form_factor: "scooter",
      spatial_status: "available",
    },
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

function makeDevices(): Devices {
  const devices = new Devices(fakeMap() as unknown as MLMap, fakeLocate());
  devices.setData(response([feature("d1"), feature("d2")]));
  return devices;
}

describe("Devices.setLeaderboardActive", () => {
  it("hides every device (markers + clusters, via the same filtered()/apply() path) while active", () => {
    const devices = makeDevices();
    expect(devices.visibleFeatures()).toHaveLength(2);
    devices.setLeaderboardActive(true);
    expect(devices.visibleFeatures()).toHaveLength(0);
  });

  it("restores visibility on deactivation when no other filter is active", () => {
    const devices = makeDevices();
    devices.setLeaderboardActive(true);
    devices.setLeaderboardActive(false);
    expect(devices.visibleFeatures()).toHaveLength(2);
  });

  it("does not throw calling hideMapTooltip() on activation when no tooltip is open", () => {
    const devices = makeDevices();
    expect(() => devices.setLeaderboardActive(true)).not.toThrow();
  });

  it("composes with an active ride-mode hide: closing the leaderboard must NOT un-hide the ride HUD's scooters", () => {
    const devices = makeDevices();
    devices.setRideModelFilter(new Set<ModelKey>()); // ride HUD's empty-set "show none"
    devices.setLeaderboardActive(true);
    expect(devices.visibleFeatures()).toHaveLength(0);

    devices.setLeaderboardActive(false);
    // Still hidden — the ride-mode hide is a separate, still-active reason.
    expect(devices.visibleFeatures()).toHaveLength(0);

    devices.setRideModelFilter(null); // ride ends, clears its own hide
    expect(devices.visibleFeatures()).toHaveLength(2);
  });

  it("composes the other direction too: a ride-mode hide set WHILE the leaderboard is open takes effect after close", () => {
    const devices = makeDevices();
    devices.setLeaderboardActive(true);
    devices.setRideModelFilter(new Set<ModelKey>());
    expect(devices.visibleFeatures()).toHaveLength(0); // leaderboard forces it either way

    devices.setLeaderboardActive(false);
    // Ride hide is now the sole active reason — still hidden, not un-hidden
    // by the leaderboard closing.
    expect(devices.visibleFeatures()).toHaveLength(0);

    devices.setRideModelFilter(null);
    expect(devices.visibleFeatures()).toHaveLength(2);
  });

  it("a partial ride-model filter (not the ride HUD's empty-set hide) is unaffected by the leaderboard toggling", () => {
    const devices = makeDevices();
    devices.setRideModelFilter(new Set<ModelKey>(["astro"]));
    // Neither device has a recognized model, so the partial filter's
    // "unrecognized hardware always stays visible" rule keeps both shown —
    // this asserts the leaderboard flag alone is what zeroes it, not a
    // side effect of setRideModelFilter.
    expect(devices.visibleFeatures()).toHaveLength(2);
    devices.setLeaderboardActive(true);
    expect(devices.visibleFeatures()).toHaveLength(0);
    devices.setLeaderboardActive(false);
    expect(devices.visibleFeatures()).toHaveLength(2);
  });
});
