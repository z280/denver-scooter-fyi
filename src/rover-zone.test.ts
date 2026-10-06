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
    const justInside = { lng: -104.98503, lat: 39.748 };
    const justOutside = { lng: -104.98497, lat: 39.748 };
    expect(roverVerdict(justInside)).toBe("near_edge");
    expect(roverVerdict(justOutside)).toBe("near_edge");
  });

  it("leaves most of the zone a clean yes", () => {
    // The margin covers the one thing the street-name specification does not
    // pin down: which side of a 20-30 m wide street the line runs. The
    // temptation is to make it wide anyway. Measured against the shipped
    // polygon, 150 m leaves only 52% of the zone reading as a confident
    // "inside" and 40 m leaves 86% — a caution that fires over half of
    // downtown is one riders learn to swipe past. This pins the trade: the
    // middle of the zone is quiet, the kerb is not.
    expect(UNCERTAIN_MARGIN_M).toBeLessThanOrEqual(50);
    expect(UNCERTAIN_MARGIN_M).toBeGreaterThanOrEqual(25);
  });

  it("measures the margin in real metres", () => {
    // ~0.0003° of longitude is ~26 m at this latitude: inside the margin.
    expect(metersToZoneEdge({ lng: -104.9853, lat: 39.748 })).toBeLessThan(
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

  it("says plainly that the edge is the edge, and who settles it", () => {
    // The streets are named; which side of each one Veo's line runs is not,
    // and that is a question only their app can answer.
    for (const where of ["destination", "vehicle"] as const) {
      expect(roverZoneMessage("near_edge", where)).toMatch(/edge/i);
      expect(roverZoneMessage("near_edge", where)).toMatch(/veo/i);
    }
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
    features: {
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: number[][][] };
    }[];
  };
  const ring = gj.features[0].geometry.coordinates[0];

  it("is the six specified corners, closed", () => {
    expect(gj.features).toHaveLength(1);
    expect(gj.features[0].geometry.coordinates).toHaveLength(1); // no holes
    expect(ring).toHaveLength(7); // 6 corners + the closing repeat
    expect(ring[0]).toEqual(ring[6]);
  });

  it("names the streets it was specified from", () => {
    // The file says where the boundary came from before it says where it is —
    // for a reviewer, a contributor, or anybody who finds it in a network tab.
    expect(gj.note).toMatch(/Veo/i);
    expect(String(gj.features[0].properties.corners)).toContain("Broadway & Blake");
    expect(String(gj.features[0].properties.corners)).toContain("19th & Blake");
  });

  it("does not double back on itself", () => {
    // The ring genuinely doubles back at 19th — Wynkoop north-east, 19th
    // south-east, Blake north-east again. That notch is correct and is also
    // exactly what a transposed corner turns into a bow-tie, which would make
    // point-in-polygon answer at random.
    const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const orient = (p: number[], q: number[], r: number[]) =>
      sign((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]));
    const n = ring.length - 1;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 2; j < n; j += 1) {
        if (i === 0 && j === n - 1) continue;
        const crosses =
          orient(ring[i], ring[i + 1], ring[j]) !== orient(ring[i], ring[i + 1], ring[j + 1]) &&
          orient(ring[j], ring[j + 1], ring[i]) !== orient(ring[j], ring[j + 1], ring[i + 1]);
        expect(crosses, `edges ${i} and ${j}`).toBe(false);
      }
    }
  });

  it("puts the right landmarks on the right side", () => {
    // End to end, through the real point-in-polygon. Coors Field is the one
    // that matters: it sits north-west of Blake, in the notch 19th cuts out,
    // and it is what a freehand "downtown" would wrongly include.
    __setRoverZoneForTests([gj.features[0].geometry.coordinates]);
    // Picked well clear of the boundary on purpose. Union Station and Larimer
    // Square are NOT in this list: they sit 8 m and 7 m from the line, because
    // the station is on Wynkoop and the square is on 14th. Both come back
    // "near_edge", which is the right answer for a building straddling the
    // boundary and is asserted separately below.
    const inside = [
      ["16th & Champa", -104.9903, 39.7446],
      ["17th & Larimer", -104.9972, 39.7489],
      ["16th & Market", -104.997, 39.7495],
      ["Dairy Block, 18th & Wazee", -104.9988, 39.752],
    ] as const;
    const outside = [
      ["Coors Field", -104.9942, 39.7559],
      ["Ball Arena", -105.0077, 39.7487],
      ["Civic Center Park", -104.9886, 39.7392],
      ["State Capitol", -104.9848, 39.7393],
      ["RiNo", -104.9826, 39.7604],
    ] as const;
    for (const [name, lng, lat] of inside) {
      expect(roverVerdict({ lng, lat }), name).toBe("inside");
    }
    for (const [name, lng, lat] of outside) {
      expect(roverVerdict({ lng, lat }), name).toBe("outside");
    }
  });

  it("hedges on the landmarks that literally sit on the boundary", () => {
    // Union Station fronts Wynkoop and Larimer Square fronts 14th — both are
    // boundary streets. Claiming either is comfortably inside would be the
    // app being confident about the exact thing it cannot know: which side of
    // the kerb Veo drew the line.
    __setRoverZoneForTests([gj.features[0].geometry.coordinates]);
    expect(roverVerdict({ lng: -105.0, lat: 39.7527 })).toBe("near_edge");
    expect(roverVerdict({ lng: -104.9993, lat: 39.7476 })).toBe("near_edge");
  });
});
