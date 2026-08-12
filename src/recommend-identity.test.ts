// The ranked list has to carry each scooter's IDENTITY, not just its
// position.
//
// `rankDevices` had no test file at all, which is how a `vehicleIdentifier:
// null` handed straight into the walk flow survived: a scooter picked off the
// Recommended list reached the arrival panel anonymous, so dibs — which is
// keyed on the 16-hex identifier — could neither be shown nor claimed on it.
// Everything else about the pick worked, so nothing looked broken until you
// went looking for the dibs affordances that had quietly stopped appearing.

import { describe, expect, it } from "vitest";

import { rankDevices, type RecommendContext } from "./recommend.ts";
import type { DeviceProperties } from "./api.ts";

const FROM = { lng: -104.9903, lat: 39.7392 };
const CTX: RecommendContext = {
  from: FROM,
  priority: "distance",
  // `RideTypeChoice` is a ModelKey — there is no "any". The priority is
  // "distance" here, so the type score is the mild has-a-known-model nudge
  // rather than a match test, and this value does not steer the result.
  typeChoice: "astro",
};

function device(
  over: Partial<DeviceProperties> = {},
  offset = 0.001,
): GeoJSON.Feature<GeoJSON.Point, DeviceProperties> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [FROM.lng + offset, FROM.lat] },
    properties: {
      device_id: "dev1",
      form_factor: "scooter",
      vehicle_identifier: "8c4a1f0d2e9b7a35",
      vehicle_model_name: "Astro",
      battery_percent: 80,
      reliability_tier: "ok",
      is_disabled: false,
      is_reserved: false,
      ...over,
    } as DeviceProperties,
  };
}

describe("rankDevices carries vehicle identity", () => {
  it("passes the 16-hex identifier through to the ranked option", () => {
    const [opt] = rankDevices([device()], CTX);
    expect(opt.vehicleIdentifier).toBe("8c4a1f0d2e9b7a35");
  });

  it("keeps it DISTINCT from device_id", () => {
    // These are two different identifiers for two different purposes, and
    // dibs keys on the second. Reaching for `id` because it was the one
    // already on the row is the shape of the bug this file exists for.
    const [opt] = rankDevices(
      [device({ device_id: "abc-123", vehicle_identifier: "8c4a1f0d2e9b7a35" })],
      CTX,
    );
    expect(opt.id).toBe("abc-123");
    expect(opt.vehicleIdentifier).toBe("8c4a1f0d2e9b7a35");
  });

  it("is null, not undefined or empty, when the payload has none", () => {
    // A device the API has not issued an identifier for is a real case; the
    // walk flow's dibs lookup already guards on null, so this must BE null
    // rather than "" — which is falsy but would still be a string flowing
    // into a `Record<string, …>` lookup.
    const [opt] = rankDevices([device({ vehicle_identifier: null })], CTX);
    expect(opt.vehicleIdentifier).toBeNull();
  });

  it("stringifies an identifier that arrived flattened", () => {
    // MapLibre flattens feature properties, so anything can arrive as a
    // string — or, from a hand-built payload, as something else entirely.
    const [opt] = rankDevices(
      [device({ vehicle_identifier: 12345 as unknown as string })],
      CTX,
    );
    expect(opt.vehicleIdentifier).toBe("12345");
  });
});
