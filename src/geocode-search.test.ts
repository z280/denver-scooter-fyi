// Debounce + AbortController cancellation + LRU-ish cache, in isolation from
// the real network. Node environment (no DOM needed) — see vitest.config.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeocodeResult, GeocodeSearchOptions } from "./api.ts";
import {
  GEOCODE_CACHE_MAX,
  GEOCODE_DEBOUNCE_MS,
  createGeocodeSearch,
  type GeocodeSearchFn,
} from "./geocode-search.ts";

interface Call {
  q: string;
  opts: GeocodeSearchOptions;
  signal: AbortSignal | undefined;
  resolve(results: GeocodeResult[]): void;
  reject(err: unknown): void;
}

function fakeSearch(): { fn: GeocodeSearchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: GeocodeSearchFn = (q, opts, signal) => {
    return new Promise<GeocodeResult[]>((resolve, reject) => {
      calls.push({ q, opts, signal, resolve, reject });
    });
  };
  return { fn, calls };
}

function result(label: string, inCoverage = true): GeocodeResult {
  return { label, lat: 39.74, lon: -104.99, kind: "street", in_coverage: inCoverage };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createGeocodeSearch — debounce", () => {
  it("rapid keystrokes (all within the debounce window) fire exactly one net request", () => {
    const { fn, calls } = fakeSearch();
    const onResults = vi.fn();
    const client = createGeocodeSearch({ onResults }, { search: fn });

    client.query("c");
    vi.advanceTimersByTime(100);
    client.query("co");
    vi.advanceTimersByTime(100);
    client.query("col");
    vi.advanceTimersByTime(100);
    client.query("colf");
    // Only now does a full 300ms pass without another keystroke.
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);

    expect(calls.length).toBe(1);
    expect(calls[0].q).toBe("colf");
  });

  it("waits the full debounce before firing at all", () => {
    const { fn, calls } = fakeSearch();
    const client = createGeocodeSearch({ onResults: vi.fn() }, { search: fn });
    client.query("colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS - 1);
    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.length).toBe(1);
  });

  it("an empty/whitespace query clears synchronously — no timer, no request", () => {
    const { fn, calls } = fakeSearch();
    const onResults = vi.fn();
    const client = createGeocodeSearch({ onResults }, { search: fn });
    client.query("   ");
    expect(calls.length).toBe(0);
    expect(onResults).toHaveBeenCalledWith([], "   ");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    expect(calls.length).toBe(0);
  });
});

describe("createGeocodeSearch — cancellation", () => {
  it("a keystroke that arrives while a request is already in flight aborts it", () => {
    const { fn, calls } = fakeSearch();
    const onResults = vi.fn();
    const client = createGeocodeSearch({ onResults }, { search: fn });

    client.query("colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    expect(calls.length).toBe(1);
    const first = calls[0];
    expect(first.signal?.aborted).toBe(false);

    // A new keystroke lands before "colfax"'s response resolves.
    client.query("colfax ave");
    expect(first.signal?.aborted).toBe(true);

    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    expect(calls.length).toBe(2);
    expect(calls[1].q).toBe("colfax ave");
    expect(calls[1].signal?.aborted).toBe(false);
  });

  it("only the winning (later) query's results reach onResults, even if the aborted one resolves after", async () => {
    const { fn, calls } = fakeSearch();
    const onResults = vi.fn();
    const client = createGeocodeSearch({ onResults }, { search: fn });

    client.query("colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    const first = calls[0];

    client.query("colfax ave");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    const second = calls[1];

    // The stale one resolves LAST, after the fresh one.
    second.resolve([result("Colfax Ave")]);
    await Promise.resolve();
    await Promise.resolve();
    first.resolve([result("Colfax")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenCalledWith([result("Colfax Ave")], "colfax ave");
  });

  it("a real error on a non-aborted request calls onError, not onResults", async () => {
    const { fn, calls } = fakeSearch();
    const onResults = vi.fn();
    const onError = vi.fn();
    const client = createGeocodeSearch({ onResults, onError }, { search: fn });

    client.query("colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    calls[0].reject(new Error("network down"));
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "colfax");
    expect(onResults).not.toHaveBeenCalled();
  });

  it("an aborted request's eventual rejection is swallowed, not reported as an error", async () => {
    const { fn, calls } = fakeSearch();
    const onError = vi.fn();
    const client = createGeocodeSearch({ onResults: vi.fn(), onError }, { search: fn });

    client.query("colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    const first = calls[0];
    client.query("colfax ave"); // aborts `first`
    // Simulate the underlying fetch rejecting with AbortError once cancelled.
    first.reject(new DOMException("aborted", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it("cancel() aborts in-flight work without emitting a cleared-results callback", () => {
    const { fn, calls } = fakeSearch();
    const onResults = vi.fn();
    const client = createGeocodeSearch({ onResults }, { search: fn });
    client.query("colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    const first = calls[0];
    client.cancel();
    expect(first.signal?.aborted).toBe(true);
    expect(onResults).not.toHaveBeenCalled();
  });

  it("dispose() aborts a pending debounce timer before it ever fires", () => {
    const { fn, calls } = fakeSearch();
    const client = createGeocodeSearch({ onResults: vi.fn() }, { search: fn });
    client.query("colfax");
    client.dispose();
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS * 2);
    expect(calls.length).toBe(0);
  });
});

describe("createGeocodeSearch — cache", () => {
  // Resolving a promise doesn't run its `.then()` synchronously — the cache
  // write happens in a microtask, so every test below flushes the microtask
  // queue (real, even under `vi.useFakeTimers()`, which only fakes
  // timer-based APIs) before making the assertion that depends on it.

  it("does not re-query identical recent input", async () => {
    const { fn, calls } = fakeSearch();
    const onResults = vi.fn();
    const client = createGeocodeSearch({ onResults }, { search: fn });

    client.query("colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    calls[0].resolve([result("Colfax Ave")]);
    await Promise.resolve();
    await Promise.resolve();

    client.query("colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);

    expect(calls.length).toBe(1); // no second network call
    expect(onResults).toHaveBeenLastCalledWith([result("Colfax Ave")], "colfax");
  });

  it("is case-insensitive and trims whitespace for the cache key", async () => {
    const { fn, calls } = fakeSearch();
    const client = createGeocodeSearch({ onResults: vi.fn() }, { search: fn });
    client.query("Colfax");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    calls[0].resolve([result("Colfax Ave")]);
    await Promise.resolve();
    await Promise.resolve();

    client.query("  colfax  ");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    expect(calls.length).toBe(1);
  });

  it("a materially different GPS bias is a cache miss", async () => {
    const { fn, calls } = fakeSearch();
    const client = createGeocodeSearch({ onResults: vi.fn() }, { search: fn });
    client.query("colfax", { lat: 39.74, lon: -104.99 });
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    calls[0].resolve([result("Colfax Ave")]);
    await Promise.resolve();
    await Promise.resolve();

    client.query("colfax", { lat: 39.8, lon: -105.05 });
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    expect(calls.length).toBe(2);
  });

  it("tiny GPS jitter between keystrokes still hits the same cache entry", async () => {
    const { fn, calls } = fakeSearch();
    const client = createGeocodeSearch({ onResults: vi.fn() }, { search: fn });
    client.query("colfax", { lat: 39.740001, lon: -104.990001 });
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    calls[0].resolve([result("Colfax Ave")]);
    await Promise.resolve();
    await Promise.resolve();

    client.query("colfax", { lat: 39.740002, lon: -104.990002 });
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    expect(calls.length).toBe(1);
  });

  it("evicts the least-recently-used entry past the cache cap", async () => {
    const { fn, calls } = fakeSearch();
    const client = createGeocodeSearch(
      { onResults: vi.fn() },
      { search: fn, cacheMax: 2 },
    );

    const run = async (q: string): Promise<void> => {
      client.query(q);
      vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
      calls[calls.length - 1].resolve([result(q)]);
      await Promise.resolve();
      await Promise.resolve();
    };
    await run("a");
    await run("b");
    await run("c"); // "a" is now the LRU entry and evicts

    client.query("a");
    vi.advanceTimersByTime(GEOCODE_DEBOUNCE_MS);
    expect(calls.length).toBe(4); // "a" re-queried — it was evicted
  });

  it("GEOCODE_CACHE_MAX is the documented default cap", () => {
    expect(GEOCODE_CACHE_MAX).toBeGreaterThan(0);
  });
});
