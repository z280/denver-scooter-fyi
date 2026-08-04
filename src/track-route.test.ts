// The layer that draws a stored ride track on the main map. A fake map
// stands in for MapLibre — what matters here is the GeoJSON handed to it,
// because invalid source data is rejected silently rather than loudly.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTrackRoute } from "./track-route.ts";
import type { Map as MLMap } from "maplibre-gl";

interface FakeMap {
  map: MLMap;
  data(): GeoJSON.FeatureCollection | null;
  fitBounds: ReturnType<typeof vi.fn>;
  sources: string[];
  layers: string[];
}

function fakeMap(): FakeMap {
  const sources = new Map<string, { setData: (d: unknown) => void }>();
  const written = new Map<string, GeoJSON.FeatureCollection>();
  const layers: string[] = [];
  const fitBounds = vi.fn();

  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => {
      sources.set(id, {
        setData: (d: unknown) => {
          written.set(id, d as GeoJSON.FeatureCollection);
        },
      });
    },
    addLayer: (spec: { id: string }) => {
      layers.push(spec.id);
    },
    getLayer: () => undefined,
    fitBounds,
  } as unknown as MLMap;

  return {
    map,
    data: () => written.get("local-track-line") ?? null,
    fitBounds,
    sources: [...sources.keys()],
    layers,
  };
}

const geometries = (fc: GeoJSON.FeatureCollection | null): string[] =>
  (fc?.features ?? []).map((f) => f.geometry.type);

const marks = (fc: GeoJSON.FeatureCollection | null): unknown[] =>
  (fc?.features ?? [])
    .filter((f) => f.geometry.type === "Point")
    .map((f) => f.properties?.end);

let fake: FakeMap;

beforeEach(() => {
  fake = fakeMap();
});

// ---------- geometry validity ----------

describe("the drawn geometry", () => {
  it("draws a line plus start and finish for a real ride", () => {
    const route = createTrackRoute(fake.map);
    route.show([
      [-104.99, 39.75],
      [-104.98, 39.76],
      [-104.97, 39.77],
    ]);

    expect(geometries(fake.data())).toEqual(["LineString", "Point", "Point"]);
    expect(marks(fake.data())).toEqual(["start", "finish"]);
    const line = fake.data()!.features[0].geometry as GeoJSON.LineString;
    expect(line.coordinates).toHaveLength(3);
  });

  it("omits the line entirely for a single-fix ride", () => {
    const route = createTrackRoute(fake.map);
    route.show([[-104.99, 39.75]]);

    // RFC 7946 §3.1.4: a LineString needs two or more positions. Emitting a
    // one-position line is invalid source data, which MapLibre may reject —
    // taking the start marker down with it.
    expect(geometries(fake.data())).toEqual(["Point"]);
    expect(marks(fake.data())).toEqual(["start"]);
  });

  it("never emits a LineString shorter than two positions", () => {
    const route = createTrackRoute(fake.map);
    for (const coords of [
      [] as [number, number][],
      [[-104.99, 39.75]] as [number, number][],
      [
        [-104.99, 39.75],
        [-104.98, 39.76],
      ] as [number, number][],
    ]) {
      route.show(coords);
      for (const f of fake.data()?.features ?? []) {
        if (f.geometry.type === "LineString") {
          expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("clears to an empty collection for a ride with no points", () => {
    const route = createTrackRoute(fake.map);
    route.show([]);
    expect(fake.data()?.features).toEqual([]);
  });
});

// ---------- camera ----------

describe("framing", () => {
  it("frames the whole track, leaving room for the open drawer", () => {
    const route = createTrackRoute(fake.map);
    route.show([
      [-104.99, 39.75],
      [-104.97, 39.77],
    ]);

    expect(fake.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds, opts] = fake.fitBounds.mock.calls[0];
    expect(bounds).toEqual([
      [-104.99, 39.75],
      [-104.97, 39.77],
    ]);
    // Padding is asymmetric so the drawer does not sit on top of the route.
    expect(opts.padding.right).toBeGreaterThan(opts.padding.left);
  });

  it("still frames a single-fix ride, even with no line", () => {
    const route = createTrackRoute(fake.map);
    route.show([[-104.99, 39.75]]);
    expect(fake.fitBounds).toHaveBeenCalledTimes(1);
    expect(fake.fitBounds.mock.calls[0][0]).toEqual([
      [-104.99, 39.75],
      [-104.99, 39.75],
    ]);
  });

  it("leaves the camera alone when asked not to fit", () => {
    const route = createTrackRoute(fake.map);
    route.show(
      [
        [-104.99, 39.75],
        [-104.97, 39.77],
      ],
      { fit: false },
    );
    expect(fake.fitBounds).not.toHaveBeenCalled();
  });

  it("survives a map that refuses the bounds", () => {
    const route = createTrackRoute(fake.map);
    fake.fitBounds.mockImplementation(() => {
      throw new Error("degenerate extent");
    });
    // A camera that won't move is not a reason to lose the drawn track.
    expect(() => route.show([[-104.99, 39.75]])).not.toThrow();
    expect(geometries(fake.data())).toEqual(["Point"]);
  });
});

// ---------- lifecycle ----------

describe("lifecycle", () => {
  it("creates its source and layers once, however many rides are drawn", () => {
    const route = createTrackRoute(fake.map);
    route.show([[-104.99, 39.75]]);
    route.show([
      [-104.99, 39.75],
      [-104.98, 39.76],
    ]);
    route.clear();

    expect(fake.layers).toEqual(["local-track-line-draw", "local-track-ends"]);
  });

  it("clear() empties the source rather than removing the layer", () => {
    const route = createTrackRoute(fake.map);
    route.show([
      [-104.99, 39.75],
      [-104.98, 39.76],
    ]);
    route.clear();
    expect(fake.data()?.features).toEqual([]);
    // The layers outlive every panel that draws into them.
    expect(fake.layers).toHaveLength(2);
  });
});
