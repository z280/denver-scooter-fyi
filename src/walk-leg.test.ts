// @vitest-environment happy-dom
//
// The walk to the scooter. What is pinned here is mostly about the two
// distances not being the same thing, and about the walk never becoming a
// dead end — the rider can see the scooter on the map, so a routing failure
// is a note, not a blocker.
import { describe, expect, it } from "vitest";

import { ARRIVAL_METERS, formatWalkLeg, startWalkLeg, type WalkState } from "./walk-leg.ts";
import type { LngLat } from "./locate.ts";

function fakeLocate(first: LngLat | null = null) {
  const cbs = new Set<(p: LngLat) => void>();
  return {
    current: () => first,
    onFix(cb: (p: LngLat) => void) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    emit(p: LngLat) {
      for (const cb of cbs) cb(p);
    },
    get listeners() {
      return cbs.size;
    },
  };
}

const TARGET = { lat: 39.7400, lng: -104.9900, label: "Lunar 🐸 928" };

function route(meters: number, seconds: number) {
  return Promise.resolve({
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: [[-104.99, 39.74]] as [number, number][] },
    properties: { mode: "walk" as const, distance_meters: meters, duration_seconds: seconds },
  });
}

function harness(over: { fetchRoute?: any; first?: LngLat | null } = {}) {
  const locate = fakeLocate(over.first ?? null);
  const states: WalkState[] = [];
  const drawn: ([number, number][] | null)[] = [];
  const handle = startWalkLeg(TARGET, {
    locate,
    drawRoute: (c) => void drawn.push(c),
    onChange: (s) => void states.push(s),
    fetchRoute: over.fetchRoute ?? (() => route(240, 190)),
  });
  return { locate, states, drawn, handle, last: () => states[states.length - 1] };
}

describe("walking to the scooter", () => {
  it("routes from the rider's position, not a straight line", async () => {
    const seen: any[] = [];
    const h = harness({
      first: { lat: 39.7450, lng: -104.9900 },
      fetchRoute: (from: any, to: any) => {
        seen.push({ from, to });
        return route(600, 480);
      },
    });
    await Promise.resolve();
    expect(seen[0].from).toEqual([39.745, -104.99]);
    expect(seen[0].to).toEqual([39.74, -104.99]);
    h.handle.stop();
  });

  it("keeps the routed distance and the straight-line distance apart", async () => {
    // Arrival is judged on how far the rider actually is from the scooter;
    // the number SHOWN is how far they must walk. Conflating them either
    // strands the rider or arrives them a block early.
    const h = harness({ first: { lat: 39.7450, lng: -104.9900 } });
    await Promise.resolve();
    await Promise.resolve();
    const s = h.last();
    expect(s.routeMeters).toBe(240);
    expect(s.remainingMeters).toBeGreaterThan(500); // ~555 m straight line
    h.handle.stop();
  });

  it("arrives once the rider is close, and stops drawing a line to where they stand", async () => {
    const h = harness({ first: { lat: 39.7450, lng: -104.99 } });
    await Promise.resolve();
    h.locate.emit({ lat: 39.74005, lng: -104.99 }); // ~6 m away
    expect(h.last().arrived).toBe(true);
    expect(h.drawn[h.drawn.length - 1]).toBeNull();
    h.handle.stop();
  });

  it("lets the rider say they are there before GPS agrees", async () => {
    // Consumer GPS in a street canyon is routinely 20-30 m out and the
    // scooter's own position is a GBFS sample. Their eyes beat our radius.
    const h = harness({ first: { lat: 39.7450, lng: -104.99 } });
    await Promise.resolve();
    h.handle.markArrived();
    expect(h.last().arrived).toBe(true);
    h.handle.stop();
  });

  it("has a forgiving arrival radius", () => {
    // Tight enough and a rider with a hand on the handlebar never sees the
    // arrival panel. Loose enough and it appears a few seconds early, while
    // they can see the scooter. The second failure is the cheaper one.
    expect(ARRIVAL_METERS).toBeGreaterThanOrEqual(25);
  });

  it("does not re-route on every GPS twitch", async () => {
    let calls = 0;
    const h = harness({
      first: { lat: 39.7450, lng: -104.99 },
      fetchRoute: () => {
        calls += 1;
        return route(600, 480);
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    h.locate.emit({ lat: 39.74501, lng: -104.99 }); // ~1 m
    h.locate.emit({ lat: 39.74502, lng: -104.99 });
    expect(calls).toBe(1);
    h.handle.stop();
  });

  it("a routing failure is a note, not a dead end", async () => {
    const h = harness({
      first: { lat: 39.7450, lng: -104.99 },
      fetchRoute: () => Promise.reject(new Error("502")),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const s = h.last();
    expect(s.error).toBe(true);
    // Still knows how far away it is, so the panel can still say something true.
    expect(s.remainingMeters).toBeGreaterThan(0);
    h.handle.stop();
  });

  it("stops listening when stopped", () => {
    const h = harness({ first: { lat: 39.745, lng: -104.99 } });
    expect(h.locate.listeners).toBe(1);
    h.handle.stop();
    expect(h.locate.listeners).toBe(0);
  });
});

describe("formatWalkLeg", () => {
  const base: WalkState = {
    remainingMeters: null, routeMeters: null, routeSeconds: null,
    arrived: false, loading: false, error: false,
  };

  it("leads with time, because that is the decision it feeds", () => {
    expect(formatWalkLeg({ ...base, routeMeters: 240, routeSeconds: 190 }))
      .toBe("3 min · 240 m");
  });

  it("never says zero minutes", () => {
    expect(formatWalkLeg({ ...base, routeMeters: 20, routeSeconds: 12 }))
      .toBe("1 min · 20 m");
  });

  it("switches to km when metres stop being readable", () => {
    expect(formatWalkLeg({ ...base, routeMeters: 1400, routeSeconds: 1100 }))
      .toContain("1.4 km");
  });

  it("falls back to the straight-line distance when routing failed", () => {
    expect(formatWalkLeg({ ...base, remainingMeters: 312, error: true }))
      .toBe("310 m");
  });

  it("says it is working rather than showing a confident blank", () => {
    expect(formatWalkLeg(base)).toBe("Working out the walk…");
  });
});
