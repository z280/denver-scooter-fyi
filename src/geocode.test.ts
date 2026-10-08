// Reverse geocoding goes to OUR API (GET /api/v1/geocode/reverse), never to
// OpenStreetMap's Nominatim, keeps the label shape the callers display, caches,
// and fails soft.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_BASE } from "./api.ts";
import { clearReverseGeocodeCache, formatAddress, reverseGeocode } from "./geocode.ts";

const FULL = {
  address: "1234 Larimer St",
  name: null,
  housenumber: "1234",
  street: "Larimer St",
  locality: "Union Station",
  city: "Denver",
  postcode: "80202",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearReverseGeocodeCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reverseGeocode", () => {
  it("asks our API, and only our API", async () => {
    fetchMock.mockResolvedValue(json(200, FULL));
    await reverseGeocode(39.7533, -105.0002);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(String(fetchMock.mock.calls[0][0]).startsWith(`${API_BASE}/api/v1/geocode/reverse?`)).toBe(true);
    expect(url.searchParams.get("lat")).toBe("39.7533");
    expect(url.searchParams.get("lng")).toBe("-105.0002");
    for (const [u] of fetchMock.mock.calls) expect(String(u)).not.toMatch(/nominatim|openstreetmap/i);
  });

  it("keeps the label shape the callers displayed before", async () => {
    fetchMock.mockResolvedValue(json(200, FULL));
    expect(await reverseGeocode(39.75, -105)).toBe("1234 Larimer St, Union Station, Denver");
  });

  it("caches per point, and shares an in-flight lookup", async () => {
    fetchMock.mockResolvedValue(json(200, FULL));
    const [a, b] = await Promise.all([reverseGeocode(39.75, -105), reverseGeocode(39.75, -105)]);
    await reverseGeocode(39.75, -105);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("404 resolves null and is remembered", async () => {
    fetchMock.mockResolvedValue(json(404, { detail: "not found" }));
    expect(await reverseGeocode(39.7, -105.1)).toBeNull();
    expect(await reverseGeocode(39.7, -105.1)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("503 resolves null, then retries after a while", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.mockResolvedValueOnce(json(503, { detail: "upstream down" }));
    expect(await reverseGeocode(39.71, -105.1)).toBeNull();
    expect(await reverseGeocode(39.71, -105.1)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    fetchMock.mockResolvedValueOnce(json(200, FULL));
    expect(await reverseGeocode(39.71, -105.1)).toBe("1234 Larimer St, Union Station, Denver");
  });

  it("429 honours Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.mockResolvedValueOnce(json(429, { detail: "slow down" }, { "Retry-After": "5" }));
    expect(await reverseGeocode(39.72, -105.1)).toBeNull();
    vi.setSystemTime(Date.now() + 3_000);
    expect(await reverseGeocode(39.72, -105.1)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 3_000);
    fetchMock.mockResolvedValueOnce(json(200, FULL));
    expect(await reverseGeocode(39.72, -105.1)).not.toBeNull();
  });

  it("offline resolves null, never throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(reverseGeocode(39.73, -105.1)).resolves.toBeNull();
  });
});

describe("formatAddress", () => {
  it("falls back to the server's short label, then the name", () => {
    const empty = { ...FULL, housenumber: null, street: null, locality: null, city: null };
    expect(formatAddress({ ...empty, address: "Union Station" })).toBe("Union Station");
    expect(formatAddress({ ...empty, address: null, name: "Coors Field" })).toBe("Coors Field");
    expect(formatAddress({ ...empty, address: null })).toBeNull();
  });

  it("street without a number still reads", () => {
    expect(formatAddress({ ...FULL, housenumber: null })).toBe("Larimer St, Union Station, Denver");
  });
});
