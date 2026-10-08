// @vitest-environment happy-dom
// PlateIndex (forward, signed-in only) and resolvePlate (reverse, public):
// the budget rules are the point — batching ≤50, TTL, one request in flight,
// spacing, failure cooldown, 429 Retry-After — plus the privacy rules: signed
// out never asks, and sign-out drops every plate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_BASE, ApiError } from "./api.ts";
import {
  FAILURE_COOLDOWN_MS,
  MAX_PLATE_BATCH,
  MIN_REQUEST_SPACING_MS,
  PLATE_TTL_MS,
  PlateIndex,
  nearestDeviceIds,
  normalizePlate,
  resetResolveCache,
  resolvePlate,
} from "./plates.ts";

type Plates = Record<string, string>;

function harness(answer: (ids: readonly string[]) => Plates | Promise<Plates> = () => ({})) {
  let token: string | null = "tok-A";
  const calls: string[][] = [];
  const fetchPlates = vi.fn(async (ids: readonly string[]) => {
    calls.push([...ids]);
    return { plates: await answer(ids), as_of: "2026-10-08T00:00:00Z" };
  });
  const index = new PlateIndex({ fetchPlates, currentToken: () => token });
  return {
    index,
    calls,
    fetchPlates,
    setToken: (t: string | null) => {
      token = t;
    },
  };
}

const ids = (n: number, prefix = "d") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlateIndex", () => {
  it("fetches only the requested ids and answers synchronously afterwards", async () => {
    const h = harness(() => ({ a: "1025543" }));
    expect(h.index.cachedPlateFor("a")).toBeNull();
    await h.index.prime(["a", "b"]);
    expect(h.calls).toEqual([["a", "b"]]);
    expect(h.index.cachedPlateFor("a")).toBe("1025543");
    // Omitted = no plate; remembered as such so it isn't re-asked.
    expect(h.index.cachedPlateFor("b")).toBeNull();
    expect(h.index.lookupState("a")).toBe("known");
    expect(h.index.lookupState("b")).toBe("none");
    expect(h.index.lookupState("c")).toBe("unknown");
  });

  it("never sends more than 50 ids, and dedupes / drops invalid ones", async () => {
    const h = harness();
    await h.index.prime(["x", "x", "", "y".repeat(65), ...ids(80)]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toHaveLength(MAX_PLATE_BATCH);
    expect(h.calls[0][0]).toBe("x");
    expect(new Set(h.calls[0]).size).toBe(MAX_PLATE_BATCH);
    expect(h.calls[0].every((id) => id.length > 0 && id.length <= 64)).toBe(true);
  });

  it("does not re-ask ids answered within the TTL; does after it", async () => {
    const h = harness(() => ({ a: "1" }));
    await h.index.prime(["a", "b"]);
    await vi.advanceTimersByTimeAsync(MIN_REQUEST_SPACING_MS);
    await h.index.prime(["a", "b"]);
    expect(h.calls).toHaveLength(1);
    // A new id alongside fresh ones: only the new one is sent.
    const p = h.index.prime(["a", "b", "c"]);
    await vi.runAllTimersAsync();
    await p;
    expect(h.calls[1]).toEqual(["c"]);
    vi.setSystemTime(Date.now() + PLATE_TTL_MS + 1);
    const q = h.index.prime(["a"]);
    await vi.runAllTimersAsync();
    await q;
    expect(h.calls[2]).toEqual(["a"]);
  });

  it("keeps at most one request in flight and coalesces wants into the next batch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async (batch) => {
      if (batch.includes("a")) await gate;
      return {};
    });
    const p1 = h.index.prime(["a"]);
    await Promise.resolve();
    const p2 = h.index.prime(["b"]);
    const p3 = h.index.prime(["c"]);
    expect(p2).toBe(p3); // same queued send
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toEqual([["a"]]); // b, c wait for a
    release();
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2, p3]);
    expect(h.calls).toHaveLength(2);
    // Newest want first.
    expect(h.calls[1]).toEqual(["c", "b"]);
  });

  it("spaces request starts at least MIN_REQUEST_SPACING_MS apart", async () => {
    const h = harness();
    await h.index.prime(["a"]);
    const t0 = Date.now();
    const p = h.index.prime(["b"]);
    await vi.advanceTimersByTimeAsync(MIN_REQUEST_SPACING_MS - 100);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(h.calls).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(MIN_REQUEST_SPACING_MS - 1);
  });

  it("a stationary rider re-priming every second makes ~1 request per TTL", async () => {
    const h = harness();
    const near = ids(50);
    for (let s = 0; s < 600; s++) {
      void h.index.prime(near);
      await vi.advanceTimersByTimeAsync(1000);
    }
    // 10 minutes, 2-minute TTL → 5 (±1) requests, far under 60/min.
    expect(h.calls.length).toBeGreaterThanOrEqual(4);
    expect(h.calls.length).toBeLessThanOrEqual(6);
  });

  it("can never exceed 12 requests a minute however ids churn", async () => {
    const h = harness();
    for (let s = 0; s < 60; s++) {
      void h.index.prime([`new-${s}`]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(h.calls.length).toBeLessThanOrEqual(60_000 / MIN_REQUEST_SPACING_MS + 1);
  });

  it("backs off for FAILURE_COOLDOWN_MS after a failure, dropping wants meanwhile", async () => {
    let fail = true;
    const h = harness(() => {
      if (fail) throw new ApiError("HTTP 503", "HTTP_ERROR", { status: 503 });
      return { a: "9" };
    });
    await h.index.prime(["a"]);
    expect(h.calls).toHaveLength(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(FAILURE_COOLDOWN_MS - 1000);
    await h.index.prime(["a"]);
    expect(h.calls).toHaveLength(1);
    expect(h.index.cachedPlateFor("a")).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    await h.index.prime(["a"]);
    expect(h.calls).toHaveLength(2);
    expect(h.index.cachedPlateFor("a")).toBe("9");
  });

  it("respects a 429's Retry-After", async () => {
    let limited = true;
    const h = harness(() => {
      if (limited) {
        throw new ApiError("slow down", "HTTP_ERROR", { status: 429, retryAfter: 90 });
      }
      return {};
    });
    await h.index.prime(["a"]);
    limited = false;
    await vi.advanceTimersByTimeAsync(60_000); // past the generic cooldown
    await h.index.prime(["a"]);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    await h.index.prime(["a"]);
    expect(h.calls).toHaveLength(2);
  });

  it("signed out: never calls the forward endpoint and reads null", async () => {
    const h = harness(() => ({ a: "1" }));
    h.setToken(null);
    await h.index.prime(["a", "b"]);
    await vi.runAllTimersAsync();
    expect(h.fetchPlates).not.toHaveBeenCalled();
    expect(h.index.cachedPlateFor("a")).toBeNull();
    expect(h.index.lookupState("a")).toBe("unknown");
  });

  it("sign-out clears cached plates; signing back in asks again", async () => {
    const h = harness(() => ({ a: "1025543" }));
    await h.index.prime(["a"]);
    expect(h.index.cachedPlateFor("a")).toBe("1025543");
    h.setToken(null);
    expect(h.index.cachedPlateFor("a")).toBeNull();
    h.setToken("tok-A");
    // Same token again, but the cache was dropped at sign-out.
    expect(h.index.cachedPlateFor("a")).toBeNull();
    const p = h.index.prime(["a"]);
    await vi.runAllTimersAsync();
    await p;
    expect(h.calls).toHaveLength(2);
  });

  it("a different account's session never sees the previous one's plates", async () => {
    const h = harness(() => ({ a: "1025543" }));
    await h.index.prime(["a"]);
    h.setToken("tok-B");
    expect(h.index.cachedPlateFor("a")).toBeNull();
  });

  it("discards an answer that lands after sign-out", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async () => {
      await gate;
      return { a: "1025543" };
    });
    const p = h.index.prime(["a"]);
    await Promise.resolve();
    h.setToken(null);
    release();
    await p;
    h.setToken("tok-A");
    expect(h.index.cachedPlateFor("a")).toBeNull();
  });

  it("clear() drops everything (account sign-out button)", async () => {
    const h = harness(() => ({ a: "1" }));
    await h.index.prime(["a"]);
    h.index.clear();
    expect(h.index.cachedPlateFor("a")).toBeNull();
  });

  it("default transport: bearer GET to our /vehicles/plates, never Veo", async () => {
    vi.useRealTimers();
    localStorage.setItem(
      "scooter_fyi.map_auth",
      JSON.stringify({
        token: "tok-real",
        expires: new Date(Date.now() + 3_600_000).toISOString(),
        rotated_at: new Date().toISOString(),
      }),
    );
    const fetchSpy = vi.fn((_u: string, _i?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ plates: { "dev 1": "1025543" }, as_of: "x" }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const index = new PlateIndex();
      await index.prime(["dev 1", "dev2"]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        `${API_BASE}/api/v1/vehicles/plates?device_ids=dev%201,dev2`,
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer tok-real",
      );
      expect(index.cachedPlateFor("dev 1")).toBe("1025543");
    } finally {
      localStorage.clear();
    }
  });
});

describe("nearestDeviceIds", () => {
  const f = (id: string, lng: number, lat: number) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lng, lat] },
    properties: { device_id: id },
  });
  it("orders by distance and caps at the limit", () => {
    const feats = [f("far", -104.9, 39.8), f("near", -104.99, 39.75), f("mid", -104.95, 39.76)];
    expect(nearestDeviceIds(feats, { lng: -104.99, lat: 39.75 }, 2)).toEqual(["near", "mid"]);
    expect(nearestDeviceIds(feats, { lng: -104.99, lat: 39.75 })).toHaveLength(3);
  });
});

describe("resolvePlate (public)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetResolveCache();
  });

  const ok = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("normalizes like the server and sends no credentials", async () => {
    const fetchSpy = vi.fn((_u: string, _i?: RequestInit) =>
      ok({ device_id: "dev1", vehicle_identifier: "A1B2C3D4E5F60718" }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const r = await resolvePlate(" 10-25 543 ");
    expect(r).toEqual({ kind: "hit", deviceId: "dev1", vehicleIdentifier: "a1b2c3d4e5f60718" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/v1/vehicles/resolve?plate=1025543`);
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(normalizePlate(" ab-1 2 ")).toBe("AB12");
  });

  it("caches answers and shares concurrent asks", async () => {
    const fetchSpy = vi.fn(() => ok({ detail: "nope" }, 404));
    vi.stubGlobal("fetch", fetchSpy);
    const [a, b] = await Promise.all([resolvePlate("1025543"), resolvePlate("10-25543")]);
    expect(a).toEqual({ kind: "miss" });
    expect(b).toEqual({ kind: "miss" });
    await resolvePlate("1025543");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("empty or over-long plates never hit the network", async () => {
    const fetchSpy = vi.fn(() => ok({}));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolvePlate("  ")).toEqual({ kind: "miss" });
    expect(await resolvePlate("9".repeat(33))).toEqual({ kind: "miss" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a 429 pauses every resolve for Retry-After and reads as an error, not a miss", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response("{}", { status: 429, headers: { "Retry-After": "30" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolvePlate("1111111")).toEqual({ kind: "error" });
    expect(await resolvePlate("2222222")).toEqual({ kind: "error" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("503 / offline are errors (retryable), not misses", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({ detail: "down" }, 503)));
    expect(await resolvePlate("1111111")).toEqual({ kind: "error" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    expect(await resolvePlate("2222222")).toEqual({ kind: "error" });
  });
});
