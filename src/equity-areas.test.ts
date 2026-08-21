// The city's official Equity Area map — the one source of truth for
// "is this point in an equity area", and therefore for a claim about money.
//
// Two kinds of coverage here, and the second is the one that matters most:
//
//   * the module's own behaviour (load-once, retry-on-failure, the
//     three-valued in/out/don't-know answer), and
//   * the CONTENTS of the bundled asset. The app tells riders a ride here
//     should cost $0.13/min. If public/equity-areas.geojson ever drifts
//     from the map the compliance numbers are computed against, the app is
//     making a promise the audit cannot back — so the geometry is asserted
//     against real Denver coordinates and the file's own shape, not just
//     assumed to parse.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EQUITY_AREAS_URL,
  EQUITY_AREA_UNLOCK_NOTE,
  EQUITY_DISCOUNT_NOTICE,
  EQUITY_INDICATOR_LABEL,
  EQUITY_INDICATOR_MIN_ZOOM,
  __resetEquityAreasForTest,
  equityAreaAt,
  equityAreaFeatures,
  isInEquityArea,
  loadEquityAreas,
  prettyEquityArea,
  type EquityAreaCollection,
} from "./equity-areas.ts";

const ASSET = "public/equity-areas.geojson";
const MAP = JSON.parse(readFileSync(ASSET, "utf8")) as EquityAreaCollection;

// Verified against the city's export: the interior of the largest area, and
// a Denver point (Washington Park) that is inside the city but in no equity
// area — the case that must answer false, not "close enough".
const INSIDE: [number, number] = [-104.826320, 39.785137];
const OUTSIDE_IN_DENVER: [number, number] = [-104.97, 39.7];
// Well outside Denver entirely.
const FAR: [number, number] = [-106.0, 40.5];

function serveMap(body: unknown = MAP, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  __resetEquityAreasForTest();
});

describe("the bundled map asset", () => {
  it("is a FeatureCollection of the city's 30 equity areas", () => {
    expect(MAP.type).toBe("FeatureCollection");
    expect(MAP.features).toHaveLength(30);
  });

  it("names every area EQ_001..EQ_030, uniquely", () => {
    const names = MAP.features.map((f) => f.properties.region_name);
    expect(new Set(names).size).toBe(30);
    expect(new Set(names)).toEqual(
      new Set(Array.from({ length: 30 }, (_, i) => `EQ_${String(i + 1).padStart(3, "0")}`)),
    );
  });

  it("carries only closed polygon rings", () => {
    for (const f of MAP.features) {
      expect(f.geometry.type).toBe("Polygon");
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
      expect(ring.length).toBeGreaterThan(3);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  it("sits inside Denver's bounding box", () => {
    // A coordinate-order slip (lat/lng swapped) or a projection left in
    // state-plane feet would sail past every other assertion here and then
    // silently place every rider outside every area.
    for (const f of MAP.features) {
      for (const [lng, lat] of (f.geometry as GeoJSON.Polygon).coordinates[0]) {
        expect(lng).toBeGreaterThan(-105.2);
        expect(lng).toBeLessThan(-104.5);
        expect(lat).toBeGreaterThan(39.5);
        expect(lat).toBeLessThan(40.0);
      }
    }
  });
});

describe("loading", () => {
  it("fetches the bundled asset once and reuses it", async () => {
    const f = serveMap();
    await loadEquityAreas();
    await loadEquityAreas();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(EQUITY_AREAS_URL);
  });

  it("retries after a failure instead of caching the rejection", async () => {
    // A rider whose first load died on a flaky connection should get the
    // indicator when they pan, not never.
    const f = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, status: 200, json: async () => MAP });
    vi.stubGlobal("fetch", f);

    await expect(loadEquityAreas()).rejects.toThrow("offline");
    await expect(loadEquityAreas()).resolves.toBeTruthy();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("treats a non-2xx as a failure rather than parsing the error body", async () => {
    serveMap({ detail: "nope" }, false);
    await expect(loadEquityAreas()).rejects.toThrow(/503/);
  });
});

describe("membership", () => {
  it("says 'don't know' — not 'no' — before the map has loaded", () => {
    // The whole reason this is three-valued. Telling a rider they are NOT
    // in an equity area because we have not looked yet is a wrong answer;
    // saying nothing is merely an absent one.
    expect(isInEquityArea(...INSIDE)).toBeNull();
    expect(equityAreaAt(...INSIDE)).toBeNull();
  });

  it("resolves points once the map is loaded", async () => {
    serveMap();
    await loadEquityAreas();
    expect(isInEquityArea(...INSIDE)).toBe(true);
    expect(isInEquityArea(...OUTSIDE_IN_DENVER)).toBe(false);
    expect(isInEquityArea(...FAR)).toBe(false);
  });

  it("names the area a point falls in", async () => {
    serveMap();
    await loadEquityAreas();
    const area = equityAreaAt(...INSIDE);
    expect(area?.region_name).toMatch(/^EQ_\d{3}$/);
    expect(area?.region_type).toBe("equity");
    expect(equityAreaAt(...OUTSIDE_IN_DENVER)).toBeNull();
  });

  it("hands the ride HUD indexed features to flag start and end", async () => {
    serveMap();
    const features = await equityAreaFeatures();
    expect(features).toHaveLength(30);
    // Indexed, i.e. carrying the memoized bbox that makes the per-fix
    // point-in-polygon cheap enough to run on a moving ride.
    expect(features[0].bbox).toHaveLength(4);
  });
});

describe("copy", () => {
  it("quotes the contract terms exactly as the city gave them", () => {
    // Verbatim, deliberately: this is the sentence a rider may end up
    // quoting at Veo support. A paraphrase is a different promise.
    expect(EQUITY_DISCOUNT_NOTICE).toBe(
      "Veo contract with City of Denver says rides that stop or start in " +
        "this area should cost $0.13/min, please screenshot your receipt if " +
        "you do not see this discount!",
    );
  });

  it("never quotes the per-minute rate without the unlock beside it", () => {
    // Exhibit C's Equity Area row is $1 + $0.13/min. A rider told only
    // "$0.13/min" reads the $1 line on their receipt as the discount having
    // been ignored — and either complains wrongly or drops a real claim.
    // Both halves travel together, everywhere the rate is stated.
    // The chip uses the app's compact "25¢/min" shorthand so it fits one
    // line on a phone; the modal spells the same figure out longhand.
    expect(EQUITY_INDICATOR_LABEL).toContain("$1");
    expect(EQUITY_INDICATOR_LABEL).toContain("13¢/min");
    expect(EQUITY_DISCOUNT_NOTICE).toContain("$0.13/min");
    expect(EQUITY_AREA_UNLOCK_NOTE).toContain("$1 unlock");
  });

  it("cites the contract's own worked example, not an invented one", () => {
    // $2.30 for 10 minutes against a $4.90 base fare, straight from
    // Exhibit C. ride-cost.test.ts asserts the arithmetic agrees.
    expect(EQUITY_AREA_UNLOCK_NOTE).toContain("$2.30");
    expect(EQUITY_AREA_UNLOCK_NOTE).toContain("$4.90");
  });

  it("labels an area the way the retired maps did", () => {
    // Riders saw "Equity Area 001" under v1/v2; the map changed underneath
    // them, the vocabulary should not.
    expect(prettyEquityArea("EQ_014")).toBe("Equity Area 014");
  });
});

describe("the indicator's zoom floor", () => {
  it("is tight enough that the chip is a claim about a place", () => {
    // Below roughly this, the viewport holds more city than neighborhood
    // and "you are in an equity area" stops being true of what is on
    // screen. Pinned so a casual tweak has to argue with this comment.
    expect(EQUITY_INDICATOR_MIN_ZOOM).toBeGreaterThanOrEqual(13);
    expect(EQUITY_INDICATOR_MIN_ZOOM).toBeLessThanOrEqual(15);
  });
});
