// What to call a scooter, and what not to call it twice.
import { describe, expect, it } from "vitest";

import { bareModelName, plateSuffix, vehicleDisplayName } from "./vehicle-name.ts";

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
