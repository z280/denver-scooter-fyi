// What to call a scooter, and what not to call it twice.
import { describe, expect, it } from "vitest";

import {
  bareModelName,
  plateSuffix,
  qualifiedVehicleName,
  vehicleDisplayName,
} from "./vehicle-name.ts";

describe("the name a rider says out loud", () => {
  it("is the identity, disambiguated by what's printed on the deck", () => {
    // "Cosmo" is what it IS; "Lunar 🐸 928" is WHICH one — and which one is
    // what gets shown on a certificate and argued about on a pavement.
    expect(vehicleDisplayName("Lunar 🐸", "1020928", "Veo Cosmo")).toBe("Lunar 🐸 928");
  });

  it("drops the suffix rather than inventing one", () => {
    // The public payload carries no plate; this app resolves its own, and
    // sometimes hasn't yet.
    expect(vehicleDisplayName("Lunar 🐸", null, "Veo Cosmo")).toBe("Lunar 🐸");
  });

  it("falls back to the model rather than naming something 'undefined'", () => {
    // An older payload carries no public_name at all.
    expect(vehicleDisplayName(null, "1020922", "Veo Cosmo")).toBe("Veo Cosmo");
    expect(vehicleDisplayName(null, null, null)).toBe("Veo Unknown");
  });

  it("takes the last three alphanumerics, as printed", () => {
    expect(plateSuffix("1020922")).toBe("922");
    expect(plateSuffix("AB-12")).toBe("B12");
    expect(plateSuffix("7")).toBe("7");
    expect(plateSuffix(null)).toBeNull();
  });
});

describe("not saying Veo three times", () => {
  it("strips the maker the catalogue's names already carry", () => {
    // The certificate prints provider + type + name. Handing it the prefixed
    // string produced "Veo Veo Cosmo Veo Cosmo".
    expect(bareModelName("Veo Cosmo")).toBe("Cosmo");
    expect(bareModelName("Veo Rover")).toBe("Rover");
  });

  it("leaves a name that never had the prefix alone", () => {
    expect(bareModelName("Cosmo")).toBe("Cosmo");
    expect(bareModelName(null)).toBe("");
  });
});

describe("the server's plate suffix", () => {
  it("is preferred over one derived from a locally-resolved plate", () => {
    // The payload's copy is present whenever the API knows the vehicle. The
    // GBFS-derived plate needs a GPS fix and a reachable feed, so it is the
    // fallback, not the source of truth.
    expect(vehicleDisplayName("Lunar 🐸", "1025111", "Veo Cosmo", "899")).toBe(
      "Lunar 🐸 899",
    );
  });

  it("still falls back to the local plate when the payload has none", () => {
    // An older payload, or a device whose plate we have never resolved
    // server-side. The client join is why this path exists at all.
    expect(vehicleDisplayName("Lunar 🐸", "1025899", "Veo Cosmo", null)).toBe(
      "Lunar 🐸 899",
    );
    expect(vehicleDisplayName("Lunar 🐸", "1025899", "Veo Cosmo")).toBe(
      "Lunar 🐸 899",
    );
  });

  it("names the scooter without digits when neither source has them", () => {
    // Honest: a name with no disambiguator beats a fabricated one.
    expect(vehicleDisplayName("Lunar 🐸", null, "Veo Cosmo", null)).toBe("Lunar 🐸");
  });

  it("treats an empty-string suffix as absent, not as a suffix", () => {
    expect(vehicleDisplayName("Lunar 🐸", "1025899", "Veo Cosmo", "")).toBe(
      "Lunar 🐸 899",
    );
  });
});

describe("qualifiedVehicleName — what it is, then which one", () => {
  it("puts the type before the name", () => {
    expect(
      qualifiedVehicleName({
        publicName: "Onward 🌳",
        modelName: "Cosmo",
        suffix: "500",
      }),
    ).toBe("Cosmo Onward 🌳 500");
  });

  it("strips the maker the catalogue carries, so an operator never doubles", () => {
    // The exact bug the dibs certificate hit: "Veo Veo Cosmo Veo Cosmo".
    expect(
      qualifiedVehicleName({
        publicName: "Onward 🌳",
        modelName: "Veo Cosmo",
        suffix: "500",
        operator: "Veo",
      }),
    ).toBe("Veo Cosmo Onward 🌳 500");
  });

  it("omits the operator where there is only one, which is Denver today", () => {
    expect(
      qualifiedVehicleName({ publicName: "Onward 🌳", modelName: "Veo Cosmo" }),
    ).toBe("Cosmo Onward 🌳");
  });

  it("degrades in the order the parts actually go missing", () => {
    // No public_name on an older payload: the bare type is still true and
    // still useful.
    expect(qualifiedVehicleName({ publicName: null, modelName: "Cosmo" })).toBe("Cosmo");
    // No recognised model: the name alone, which is what we always showed.
    expect(qualifiedVehicleName({ publicName: "Onward 🌳", modelName: null })).toBe(
      "Onward 🌳",
    );
    // A suffix with no name is not a name.
    expect(
      qualifiedVehicleName({ publicName: null, modelName: "Cosmo", suffix: "500" }),
    ).toBe("Cosmo");
  });

  it("never renders an empty segment or a bare blank", () => {
    // A blank where a vehicle should be reads as a rendering fault.
    expect(qualifiedVehicleName({ publicName: null, modelName: null })).toBe(
      "Unknown vehicle",
    );
    expect(
      qualifiedVehicleName({ publicName: "Onward 🌳", modelName: "", operator: "  " }),
    ).toBe("Onward 🌳");
  });
});
