// @vitest-environment happy-dom
//
// Denver's own rulebook, on the map.
//
// Two different things are tested here, and the first matters more. One is the
// layer plumbing. The other is THE DATA: this file is the only thing in the
// app that tells a rider where they may not ride, and it was built once by a
// script from an export whose semantics lived in its filenames. A silent
// misclassification — the private-school set inheriting the public label, say,
// which the first build actually did — is indistinguishable from correct
// behaviour at every other level of this app. So the shipped asset is read and
// checked, not mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  MicromobilityZones,
  ZONE_COLOR,
  ZONE_GROUPS,
  groupOf,
  loadZones,
  resetZonesForTest,
  zoneSentence,
  buildZoneInspectHtml,
  distinctZones,
  zoneInspectTitle,
  type ZoneCollection,
  type ZoneKind,
} from "./micromobility-zones.ts";

const ZONES = JSON.parse(
  readFileSync("public/micromobility-zones.geojson", "utf8"),
) as ZoneCollection;

beforeEach(() => {
  resetZonesForTest();
});

// ---------------------------------------------------------------------------
// The shipped rulebook
// ---------------------------------------------------------------------------

describe("the zone data as shipped", () => {
  it("carries its provenance in the file", () => {
    // So attribution cannot drift from the data it describes, and so a stale
    // build is visible rather than inferred.
    expect(ZONES.source?.agency).toContain("Denver");
    expect(ZONES.source?.obtained_via).toContain("Open Records");
    expect(ZONES.source?.received).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has every zone class the city gave us, and no stray ones", () => {
    const kinds = new Set(ZONES.features.map((f) => f.properties.zone_kind));
    expect([...kinds].sort()).toEqual([
      "no_parking",
      "no_ride",
      "outside_denver",
      "school",
      "slow",
      "slow_no_parking",
    ]);
  });

  it("keeps the public and private school sets apart", () => {
    // The first build did not: `non-public_school_land_area` contains
    // `public_school_land_area`, so a substring match claimed both files and
    // the private set silently inherited the public label.
    const schools = ZONES.features.filter(
      (f) => f.properties.zone_kind === "school",
    );
    expect(schools).toHaveLength(2);
    expect(schools.map((f) => f.properties.zone_venue).sort()).toEqual([
      "Private schools",
      "Public schools",
    ]);
  });

  it("names every venue-specific slow zone", () => {
    const venues = ZONES.features
      .filter((f) => f.properties.zone_kind === "slow")
      .map((f) => f.properties.zone_venue);
    expect(venues).toHaveLength(6);
    // A slow zone with no venue is one whose filename we failed to read.
    for (const v of venues) expect(v).toBeTruthy();
    expect(venues).toContain("Ball Arena");
    expect(venues).toContain("Empower Field");
  });

  it("says out loud where the rule is inferred rather than given", () => {
    // School land is a parcel set with no hours attached, and Glendale is a
    // jurisdiction. Both are drawn; neither may be presented as a stated rule.
    for (const f of ZONES.features) {
      if (f.properties.zone_kind === "school" || f.properties.zone_kind === "outside_denver") {
        expect(f.properties.zone_note).toBeTruthy();
      }
    }
  });

  it("is all closed polygons in Denver", () => {
    // A rulebook with an unclosed ring draws a shape that is not the rule.
    let rings = 0;
    for (const f of ZONES.features) {
      const geom = f.geometry as { type: string; coordinates: number[][][][] };
      expect(["Polygon", "MultiPolygon"]).toContain(geom.type);
      const polys =
        geom.type === "MultiPolygon"
          ? geom.coordinates
          : ([geom.coordinates] as unknown as number[][][][]);
      for (const poly of polys) {
        for (const ring of poly) {
          rings += 1;
          expect(ring.length).toBeGreaterThanOrEqual(4);
          expect(ring[0]).toEqual(ring[ring.length - 1]);
          for (const [lng, lat] of ring) {
            // Denver, generously bounded. Catches a CRS mix-up or a
            // swapped lat/lng, which would otherwise draw silently in the
            // Indian Ocean.
            expect(lng).toBeGreaterThan(-105.3);
            expect(lng).toBeLessThan(-104.5);
            expect(lat).toBeGreaterThan(39.4);
            expect(lat).toBeLessThan(40.0);
          }
        }
      }
    }
    expect(rings).toBeGreaterThan(300);
  });

  it("gives every class a colour, and every colour a class", () => {
    for (const f of ZONES.features) {
      expect(ZONE_COLOR[f.properties.zone_kind]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("files every class into exactly one rider-facing group", () => {
    for (const kind of Object.keys(ZONE_COLOR) as ZoneKind[]) {
      expect(groupOf(kind)).not.toBeNull();
    }
  });

  it("draws the two inferred classes in grey, and the rules in colour", () => {
    // A colour that reads as a rule, for a thing we cannot state as one,
    // would be the lie this module exists to avoid.
    expect(ZONE_COLOR.school).toBe(ZONE_COLOR.outside_denver);
    for (const ruled of ["no_ride", "no_parking", "slow"] as ZoneKind[]) {
      expect(ZONE_COLOR[ruled]).not.toBe(ZONE_COLOR.school);
    }
  });
});

describe("zoneSentence", () => {
  it("leads with the venue when there is one", () => {
    expect(
      zoneSentence({ zone_kind: "slow", zone_label: "Slow zone", zone_venue: "Coors Field" }),
    ).toBe("Coors Field · Slow zone");
  });

  it("carries the note when the rule needs qualifying", () => {
    const s = zoneSentence({
      zone_kind: "school",
      zone_label: "School land",
      zone_venue: "Public schools",
      zone_note: "Restrictions here are likely.",
    });
    expect(s).toContain("Public schools");
    expect(s).toContain("Restrictions here are likely.");
  });
});

// ---------------------------------------------------------------------------
// The layers
// ---------------------------------------------------------------------------

function fakeMap() {
  const paint = new Map<string, unknown>();
  const filters = new Map<string, unknown>();
  const layers: Record<string, unknown>[] = [];
  const addSource = vi.fn();
  return {
    addSource,
    addLayer: vi.fn((spec: Record<string, unknown>) => layers.push(spec)),
    setPaintProperty: vi.fn((id: string, prop: string, v: unknown) =>
      paint.set(`${id}.${prop}`, v),
    ),
    setFilter: vi.fn((id: string, f: unknown) => filters.set(id, f)),
    _paint: paint,
    _filters: filters,
    _layers: layers,
  };
}

function serve(data: unknown = ZONES) {
  return vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => data }),
  ) as unknown as typeof fetch;
}

/** The kinds the current filter lets through. */
function visibleKinds(map: ReturnType<typeof fakeMap>): string[] {
  const f = map._filters.get("micromobility-zones-fill") as unknown[];
  if (!Array.isArray(f) || f[0] !== "in") return [];
  return ((f[2] as unknown[])[1] as string[]) ?? [];
}

describe("MicromobilityZones", () => {
  it("starts with the rules on and the inferred layers off", () => {
    // The only overlay in the app that can stop somebody breaking a rule they
    // did not know about. The other two are land, not law.
    const z = new MicromobilityZones(fakeMap() as never, serve());
    expect(z.isVisible("rules")).toBe(true);
    expect(z.isVisible("schools")).toBe(false);
    expect(z.isVisible("outside")).toBe(false);
    expect(z.isMuted()).toBe(true);
  });

  it("draws every class from one source, coloured by the feature", () => {
    // Six sources and twelve layers would cost a draw pass each and let the
    // group toggles disagree with one another.
    const map = fakeMap();
    const z = new MicromobilityZones(map as never, serve());
    return z.setMuted(true).then(() => {
      expect(map.addSource).toHaveBeenCalledTimes(1);
      expect(map._layers).toHaveLength(2);
      const fill = map._layers.find((l) => l.id === "micromobility-zones-fill")!;
      expect((fill.paint as Record<string, unknown>)["fill-color"]).toEqual(
        expect.arrayContaining(["match", ["get", "zone_kind"]]),
      );
    });
  });

  it("shows only the groups that are on", async () => {
    const map = fakeMap();
    const z = new MicromobilityZones(map as never, serve());
    await z.setMuted(true);
    expect(visibleKinds(map).sort()).toEqual(
      [...ZONE_GROUPS.rules.kinds].sort(),
    );
    await z.setVisible("schools", true);
    expect(visibleKinds(map)).toContain("school");
    await z.setVisible("rules", false);
    expect(visibleKinds(map)).toEqual(["school"]);
  });

  it("hides everything rather than everything-matching when all are off", async () => {
    // An empty `in` list is an error in some MapLibre versions and a
    // match-everything in others — either would be the whole rulebook drawn
    // or a crash, from a rider switching three things off.
    const map = fakeMap();
    const z = new MicromobilityZones(map as never, serve());
    await z.setMuted(true);
    await z.setVisible("rules", false);
    const f = map._filters.get("micromobility-zones-fill") as unknown[];
    expect(f[0]).toBe("==");
    expect(f[1]).toEqual(["literal", 1]);
    expect(f[2]).toEqual(["literal", 0]);
  });

  it("mutes the fill and keeps the outline readable", async () => {
    const map = fakeMap();
    const z = new MicromobilityZones(map as never, serve());
    await z.setMuted(true);
    const fill = map._paint.get("micromobility-zones-fill.fill-opacity") as number;
    const line = map._paint.get("micromobility-zones-line.line-opacity") as number;
    expect(fill).toBeLessThan(0.12);
    expect(line).toBeGreaterThan(fill * 3);
    await z.setMuted(false);
    expect(
      map._paint.get("micromobility-zones-fill.fill-opacity") as number,
    ).toBeGreaterThan(fill);
  });

  it("adds its source once under concurrent callers", async () => {
    // Both can clear the `layersAdded` guard before either finishes its
    // await, and addSource throws on a duplicate id.
    const map = fakeMap();
    const z = new MicromobilityZones(map as never, serve());
    await Promise.all([
      z.setVisible("rules", true),
      z.setVisible("schools", true),
      z.setMuted(true),
    ]);
    expect(map.addSource).toHaveBeenCalledTimes(1);
  });

  it("fetches once however many callers ask", async () => {
    const f = serve();
    await Promise.all([loadZones(f), loadZones(f), loadZones(f)]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("lets a later attempt retry after a failed fetch", async () => {
    // Caching the rejection would leave the rulebook missing for the life of
    // the page because of one flaky request.
    const bad = vi.fn(() =>
      Promise.resolve({ ok: false, status: 503, json: async () => ({}) }),
    ) as unknown as typeof fetch;
    await expect(loadZones(bad)).rejects.toThrow();
    const good = serve();
    await expect(loadZones(good)).resolves.toBeTruthy();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("triple-tap: zone cards", () => {
  const slow = { zone_kind: "slow", zone_label: "Slow zone", zone_venue: "Coors Field" } as const;
  const noPark = {
    zone_kind: "no_parking",
    zone_label: "No parking",
    zone_note: "You may ride through, but not end a ride here.",
  } as const;
  const noRide = { zone_kind: "no_ride", zone_label: "No riding" } as const;

  it("orders overlapping zones worst first and collapses duplicates", () => {
    const z = distinctZones([slow, noPark, slow, noRide]);
    expect(z.map((p) => p.zone_kind)).toEqual(["no_ride", "no_parking", "slow"]);
  });

  it("titles the card generically, singular or plural; the rows carry the names", () => {
    expect(zoneInspectTitle(distinctZones([slow]))).toBe("Denver rule here");
    expect(zoneInspectTitle(distinctZones([slow, noRide]))).toBe("Denver rules here");
  });

  it("explains each zone, uses the city's own note when there is one, and credits the source", () => {
    const html = buildZoneInspectHtml(distinctZones([noPark, slow]));
    expect(html).toContain("You may ride through, but not end a ride here.");
    expect(html).toContain("Speed is limited here.");
    expect(html).toContain("Coors Field · Slow zone");
    expect(html).toContain("City of Denver");
    // The export names no limit; the card must not invent one.
    expect(html).not.toMatch(/\d+\s*mph/i);
  });

  it("escapes what it prints", () => {
    const html = buildZoneInspectHtml([{ zone_kind: "slow", zone_label: "<b>x</b>" }]);
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("hits carry a stable key, hold double-tap zoom, and open the card", () => {
    const openCard = vi.fn();
    const z = new MicromobilityZones(fakeMap() as never, serve(), openCard);
    const a = z.hitForZones([slow, noPark]);
    const b = z.hitForZones([noPark, slow, slow]);
    expect(a?.key).toBe(b?.key);
    expect(a?.holdsDoubleClickZoom).toBe(true);
    a!.open();
    expect(openCard).toHaveBeenCalledWith("Denver rules here", expect.stringContaining("zone-inspect"));
    expect(z.hitForZones([])).toBeNull();
  });

  it("answers nothing before its layers exist", () => {
    const z = new MicromobilityZones(fakeMap() as never, serve());
    expect(z.hitAt({ x: 1, y: 1 })).toBeNull();
  });
});
