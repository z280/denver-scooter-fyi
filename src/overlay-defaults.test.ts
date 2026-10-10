// What the Areas drawer looks like before anybody touches a switch.
//
// THESE DEFAULTS LIVE IN TWO PLACES AND NEITHER ONE ENFORCES THE OTHER.
// `index.html` ships the checkboxes, and `main.ts` reads them at wire time —
// that markup is the real product default. But `MicromobilityZones` and
// `EquityAreaMap` each carry a `muted` field of their own, used by any caller
// that does not come through the markup, and nothing makes the two agree. A
// field saying "muted" under markup saying "not" is a second, quieter answer
// to the same question, and the only reason it has never bitten is that each
// class is constructed exactly once.
//
// So this file checks the pair against each other rather than either alone.
// The class defaults are asserted in their own files; what cannot be asserted
// there is that the HTML agrees.
import { describe, expect, it } from "vitest";

import { readSource } from "../tests/helpers/source-text.ts";
import { ROVER_ZONE_COLOR } from "./rover-zone.ts";
import { EQUITY_AREA_COLOR } from "./equity-areas.ts";

const html = readSource("index.html");

/** The `<input>` tag for an id, as written. */
function input(id: string): string {
  const at = html.indexOf(`id="${id}"`);
  expect(at, `no #${id} in index.html`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<input", at);
  return html.slice(open, html.indexOf(">", at) + 1);
}

const isChecked = (id: string): boolean => / checked\b/.test(input(id));

describe("the Areas drawer's shipped defaults", () => {
  // The owner, 2026-10-10: "I need the map rule zones and the equity zones to
  // NOT BE MUTED by DEFAULT, but the Rover Zone should be in a different
  // colour AND muted."
  it("draws the city's rule zones at full strength", () => {
    // A rule drawn so faintly that a rider scrolls past it has not warned
    // anybody, and these are the only overlay in the app that can stop
    // somebody breaking a rule they did not know about.
    expect(isChecked("zones-rules-toggle")).toBe(true);
    expect(isChecked("zones-muted-toggle")).toBe(false);
  });

  it("draws the Equity Areas at full strength", () => {
    // The discount written into the contract is the thing this app exists to
    // point at. Always-on AND muted was still half-invisible.
    expect(isChecked("equity-areas-toggle")).toBe(true);
    expect(isChecked("equity-areas-muted-toggle")).toBe(false);
  });

  it("leaves the inferred layers off, which this change does not touch", () => {
    // School grounds and Glendale are land, not law — the city states no rule
    // for them. Unmuting the rules must not quietly promote these too.
    expect(isChecked("zones-schools-toggle")).toBe(false);
    expect(isChecked("zones-outside-toggle")).toBe(false);
  });

  it("still shows the Rover area, which is muted in paint and not by a switch", () => {
    // That section has no "Muted display" control — the muting is in
    // `rover-zone.ts`'s PAINT, because the area is a fact about one vehicle
    // in a fleet of thousands and covers the whole of downtown.
    expect(isChecked("rover-zone-toggle")).toBe(true);
    expect(html).not.toContain("rover-zone-muted-toggle");
  });
});

describe("the Rover area's colour", () => {
  it("is not the Equity Area's", () => {
    // THE REGRESSION THIS EXISTS FOR. It was `#7e57c2`, a lighter shade of
    // the Equity Area's `#6a1b9a`: two purple washes over the same downtown
    // blocks. Unmuting the Equity Area made the collision worse, because the
    // one a rider is most likely to be reading is the one that lost.
    expect(ROVER_ZONE_COLOR).not.toBe(EQUITY_AREA_COLOR);
    expect(ROVER_ZONE_COLOR).not.toBe("#7e57c2");
  });

  it("is not one of the rule-zone warning colours either", () => {
    // Red, orange, yellow and grey are a warning ramp. The Rover area is not
    // a warning — it is where a thing is ALLOWED — so a colour inside that
    // ramp would read as one more restriction.
    const zones = readSource("src/micromobility-zones.ts");
    const warnings = [...zones.matchAll(/#[0-9a-f]{6}/gi)].map((m) =>
      m[0].toLowerCase(),
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings).not.toContain(ROVER_ZONE_COLOR.toLowerCase());
  });

  it("is the only colour the Rover layers are drawn in", () => {
    // Two hard-coded hexes is how the fill and the outline end up disagreeing
    // after somebody changes one of them.
    const src = readSource("src/rover-zone.ts");
    const hexes = new Set(
      [...src.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase()),
    );
    // The old purple may still be NAMED in the comment explaining the change;
    // what must not survive is a second colour in the paint.
    const paint = src.slice(src.indexOf("export async function ensureRoverZoneLayers"));
    expect([...paint.matchAll(/#[0-9a-f]{6}\b/gi)]).toHaveLength(0);
    expect(hexes.has(ROVER_ZONE_COLOR.toLowerCase())).toBe(true);
  });
});
