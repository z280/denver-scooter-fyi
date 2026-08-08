// @vitest-environment happy-dom
//
// Model-name → ModelKey mapping (devices.ts). Exists to pin one deliberate
// asymmetry: Veo's marketing name for the three-wheeler is "Rover", but the
// INTERNAL key stays "trike" — it's baked into saved filter presets, sprite
// ids, and the `vehicle_model` field the routing API receives. A feed row
// saying either name must resolve to the same key, and both must count as a
// seated ride.
import { describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => ({
  default: { Popup: class {}, Marker: class {} },
}));

import { modelKeyOf, rideTypeOf, veoModel } from "./devices.ts";

describe("modelKeyOf", () => {
  it("maps both feed spellings of the three-wheeler to the trike key", () => {
    expect(modelKeyOf({ vehicle_model_name: "trike" })).toBe("trike");
    expect(modelKeyOf({ vehicle_model_name: "Rover" })).toBe("trike");
    expect(modelKeyOf({ vehicle_model_name: " ROVER " })).toBe("trike");
  });

  it("passes the other models through and rejects mystery hardware", () => {
    expect(modelKeyOf({ vehicle_model_name: "Astro" })).toBe("astro");
    expect(modelKeyOf({ vehicle_model_name: "cosmo" })).toBe("cosmo");
    expect(modelKeyOf({ vehicle_model_name: "Apollo" })).toBe("apollo");
    expect(modelKeyOf({ vehicle_model_name: "hoverboard" })).toBeNull();
    expect(modelKeyOf({ vehicle_model_name: null })).toBeNull();
  });
});

describe("veoModel", () => {
  it('resolves the feed\'s "Rover" to the Veo Rover card — the "Veo Unknown" regression', () => {
    // The popup header map is keyed by the internal "trike" key; a raw
    // vehicle_model_name lookup missed the feed\'s marketing spelling and
    // every Rover popup fell through to "Veo Unknown / Tell us!".
    expect(veoModel("Rover")?.name).toBe("Veo Rover");
    expect(veoModel(" ROVER ")?.name).toBe("Veo Rover");
    expect(veoModel("trike")?.name).toBe("Veo Rover");
  });

  it("still recognizes the rest of the line-up and rejects mystery hardware", () => {
    expect(veoModel("Astro")?.name).toBe("Veo Astro");
    expect(veoModel("cosmo")?.name).toBe("Veo Cosmo");
    expect(veoModel("Apollo")?.name).toBe("Veo Apollo");
    expect(veoModel("hoverboard")).toBeNull();
    expect(veoModel(null)).toBeNull();
    expect(veoModel("")).toBeNull();
  });
});

describe("rideTypeOf", () => {
  it("counts a Rover as a seated ride under either name", () => {
    expect(rideTypeOf({ vehicle_model_name: "trike" })).toBe("sitting");
    expect(rideTypeOf({ vehicle_model_name: "Rover" })).toBe("sitting");
    expect(rideTypeOf({ vehicle_model_name: "Astro" })).toBe("standing");
  });
});
