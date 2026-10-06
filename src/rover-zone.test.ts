// The Rover service area.
//
// The rule is certain — Rovers are downtown-only — and the line is not: Veo
// does not publish their geofence, so the app draws Denver's official downtown
// as a stand-in. Almost everything below exists to pin the consequences of
// that gap, because the failure mode is a rider stranded on a vehicle they
// cannot end a trip on.
//
// The geometry tests use a square, not the real polygon. A test against the
// shipped data would assert that Denver's CBD is where Denver says it is,
// which is not in doubt; what IS worth asserting is that a point two blocks
// outside reads as outside, that a point near the line reads as uncertain
// rather than confident, and that nothing here ever promises an outcome.

import { beforeEach, describe, expect, it } from "vitest";

import {
  UNCERTAIN_MARGIN_M,
  __setRoverZoneForTests,
  metersToZoneEdge,
  roverVerdict,
  roverZoneMessage,
  type RoverVerdict,
} from "./rover-zone.ts";

// A square roughly over downtown Denver. ~0.02° of longitude is ~1.7 km here,
// comfortably bigger than the margin so "inside" is reachable.
const SQUARE = [
  [
    [-105.005, 39.740],
    [-104.985, 39.740],
    [-104.985, 39.756],
    [-105.005, 39.756],
    [-105.005, 39.740],
  ],
];

const CENTRE = { lng: -104.995, lat: 39.748 };

beforeEach(() => {
  __setRoverZoneForTests([SQUARE]);
});

describe("where a point falls", () => {
  it("calls the middle of downtown inside", () => {
    expect(roverVerdict(CENTRE)).toBe("inside");
  });

  it("calls somewhere plainly out of downtown outside", () => {
    // Park Hill-ish: kilometres away, no ambiguity to preserve.
    expect(roverVerdict({ lng: -104.93, lat: 39.755 })).toBe("outside");
  });

  it("refuses to be confident near the line, on either side", () => {
    // The whole point. Our line and Veo's can differ by a block, so a point
    // this close gets "ask Veo" rather than a verdict — and it must behave
    // the same just inside as just outside, because we cannot tell which side
    // of VEO's line it is on either way.
    const justInside = { lng: -104.9852, lat: 39.748 };
    const justOutside = { lng: -104.9848, lat: 39.748 };
    expect(roverVerdict(justInside)).toBe("near_edge");
    expect(roverVerdict(justOutside)).toBe("near_edge");
  });

  it("leaves most of downtown a clean yes", () => {
    // The margin is a hedge against our line and Veo's disagreeing, and the
    // temptation is to make it wide. Measured against the shipped polygon, a
    // 250 m margin leaves only 39% of the zone reading as a confident
    // "inside" — a caution that fires over most of downtown is one riders
    // learn to swipe past. This pins the trade: the middle of the zone is
    // quiet, the edge is not.
    expect(UNCERTAIN_MARGIN_M).toBeLessThanOrEqual(150);
    expect(UNCERTAIN_MARGIN_M).toBeGreaterThanOrEqual(100);
  });

  it("measures the margin in real metres", () => {
    // ~0.001° of longitude is ~85 m at this latitude: inside the margin.
    expect(metersToZoneEdge({ lng: -104.986, lat: 39.748 })).toBeLessThan(
      UNCERTAIN_MARGIN_M,
    );
    // ~0.006° is ~510 m: outside it.
    expect(metersToZoneEdge({ lng: -104.979, lat: 39.748 })).toBeGreaterThan(
      UNCERTAIN_MARGIN_M,
    );
  });

  it("measures to the nearest corner, not past it", () => {
    // Diagonally off a corner. Without clamping the projection to the
    // segment, a point beyond an endpoint measures against the infinite line
    // and reads as nearer than it is — which near a corner is the case that
    // decides whether somebody gets warned.
    const offCorner = { lng: -104.9838, lat: 39.7573 };
    const d = metersToZoneEdge(offCorner);
    expect(d).toBeGreaterThan(130);
    expect(d).toBeLessThan(220);
  });
});

describe("when we have nothing to go on", () => {
  it("says so rather than guessing when the zone never loaded", () => {
    __setRoverZoneForTests(null);
    expect(roverVerdict(CENTRE)).toBe("unknown");
    // And still tells the rider the rule, which never depended on the file.
    expect(roverZoneMessage("unknown", "destination")).toMatch(/downtown/i);
  });

  it("says so when there is no location", () => {
    expect(roverVerdict(null)).toBe("unknown");
    expect(roverVerdict({ lng: Number.NaN, lat: 39.75 })).toBe("unknown");
  });
});

describe("what we are willing to say", () => {
  const ALL: RoverVerdict[] = ["inside", "outside", "near_edge", "unknown"];

  it("stays quiet when the answer is a comfortable yes", () => {
    // The one case where this feature should be invisible.
    expect(roverZoneMessage("inside", "destination")).toBeNull();
    expect(roverZoneMessage("inside", "vehicle")).toBeNull();
  });

  it("never promises an outcome it cannot deliver", () => {
    // The app that charges somebody is not this one. No message may state as
    // fact that a trip will or will not be allowed to end.
    for (const v of ALL) {
      for (const where of ["destination", "vehicle"] as const) {
        const msg = roverZoneMessage(v, where);
        if (msg === null) continue;
        expect(msg, `${v}/${where}`).not.toMatch(
          /\byou can end\b|\bwill be allowed\b|\byou cannot end\b|\bwill be charged\b|\bguarantee/i,
        );
      }
    }
  });

  it("sends the rider to the authority whenever we are not sure", () => {
    for (const v of ["outside", "near_edge", "unknown"] as RoverVerdict[]) {
      expect(roverZoneMessage(v, "destination"), v).toMatch(/veo/i);
    }
  });

  it("admits the outline is ours and approximate at the edge", () => {
    expect(roverZoneMessage("near_edge", "destination")).toMatch(/approximate/i);
    expect(roverZoneMessage("near_edge", "vehicle")).toMatch(/approximate/i);
  });

  it("hedges the outside case rather than asserting it", () => {
    // "probably" is doing real work: our line is not Veo's, so even a point
    // well outside OUR polygon is a strong hint and not a ruling.
    expect(roverZoneMessage("outside", "destination")).toMatch(/probably|looks/i);
  });
});

// ---------------------------------------------------------------------------
// The shipped file
// ---------------------------------------------------------------------------
//
// Guards two things a geometry unit test cannot: that the two neighbourhoods
// stay DISSOLVED, and that the caveat travels with the coordinates.

import { readFileSync } from "node:fs";

describe("public/rover-zone.geojson", () => {
  const gj = JSON.parse(readFileSync("public/rover-zone.geojson", "utf8")) as {
    note?: string;
    features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: number[][][] } }[];
  };

  it("is one dissolved polygon, not two neighbourhoods", () => {
    // Drawn as two, the shared border down Market St rendered as a dashed
    // line through the middle of the zone — which reads as two areas with a
    // boundary between them, when it is one area a Rover moves around inside.
    // Found by looking at the map; both polygons were individually correct.
    expect(gj.features).toHaveLength(1);
    expect(gj.features[0].geometry.type).toBe("Polygon");
    expect(gj.features[0].geometry.coordinates).toHaveLength(1); // no holes
  });

  it("carries its own caveat, for anyone who opens it standalone", () => {
    // A reviewer, a contributor, somebody who found it in a network tab: the
    // file says what it is before it says where it is.
    expect(gj.note).toMatch(/approximate/i);
    expect(gj.note).toMatch(/not veo's geofence/i);
    expect(gj.features[0].properties.approximate).toBe(true);
  });

  it("covers downtown and stops at Broadway and Colfax", () => {
    // The two edges that are Veo's too, and the reason these neighbourhoods
    // were chosen as the stand-in. Loose bounds — this asserts the zone is
    // where downtown is, not that Denver's survey is correct.
    const ring = gj.features[0].geometry.coordinates[0];
    const lngs = ring.map((c) => c[0]);
    const lats = ring.map((c) => c[1]);
    expect(Math.max(...lngs)).toBeGreaterThan(-104.99); // east to Broadway
    expect(Math.max(...lngs)).toBeLessThan(-104.98);
    expect(Math.min(...lats)).toBeGreaterThan(39.735); // south to Colfax
    expect(Math.min(...lats)).toBeLessThan(39.745);
    expect(Math.max(...lats)).toBeGreaterThan(39.755); // north past Union Station
  });

  it("agrees with the module about where downtown is", () => {
    // End to end: the shipped ring, through the real point-in-polygon.
    __setRoverZoneForTests([gj.features[0].geometry.coordinates]);
    // 16th & Champa — the middle of the mall, unambiguously downtown.
    expect(roverVerdict({ lng: -104.9903, lat: 39.7446 })).toBe("inside");
    // Park Hill, kilometres out.
    expect(roverVerdict({ lng: -104.93, lat: 39.755 })).toBe("outside");
  });
});
