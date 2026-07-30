// Tests for the api.ts client contract added in ride-mode phase F1: the
// shared 429 / error handler (now on the PUBLIC path too — geocode 20/min and
// route 30/min are IP-limited public endpoints), the PATCH method the ride-end
// report needs, and the small amount of shape-massaging the ride-mode helpers
// do (envelope unwrapping, query building, points-schedule normalization).
//
// Everything here is offline: `fetch` is stubbed per test, so no test can
// depend on a deployed API. That matters because the API side of this program
// (phases A1–A4) is being built in parallel — the frontend compiles and tests
// against the contract, not a server.
import { describe, expect, it, vi } from "vitest";

import {
  ApiError,
  NoDataError,
  endTrackedRide,
  fetchPricing,
  geocodeSearch,
  getActiveRide,
  pointsScheduleEntry,
} from "./api.ts";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Replace global fetch with a canned responder, recording every call. */
function stubFetch(respond: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string })?.url ?? input);
    const call: FetchCall = { url, init };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  return calls;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Put a live token where map-auth.js looks for it. Both web storages are
 *  stubbed on purpose: the F1 auth lane migrates that blob from sessionStorage
 *  to localStorage, and these tests must pass on either side of that move. */
function stubAuth(token = "test-token"): void {
  const store = new Map<string, string>([
    [
      "scooter_fyi.map_auth",
      JSON.stringify({
        token,
        expires: new Date(Date.now() + 3_600_000).toISOString(),
        issued_at: new Date().toISOString(),
      }),
    ],
  ]);
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("sessionStorage", fake);
  vi.stubGlobal("localStorage", fake);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected the request to reject");
    },
    (e: unknown) => e,
  );
}

describe("shared 429 handling", () => {
  it("surfaces Retry-After from a public (unauthenticated) endpoint", async () => {
    stubFetch(() =>
      jsonResponse({ detail: { error: "rate_limited" } }, 429, {
        "Retry-After": "37",
      }),
    );

    const err = await rejection(fetchPricing());

    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.code).toBe("HTTP_ERROR");
    expect(api.status).toBe(429);
    expect(api.retryAfter).toBe(37);
    expect(api.errorKey).toBe("rate_limited");
    expect(api.message).toBe("rate_limited");
  });

  it("leaves retryAfter unset when Retry-After is not integer seconds", async () => {
    stubFetch(() =>
      jsonResponse({ detail: "slow down" }, 429, {
        "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT",
      }),
    );

    const err = (await rejection(geocodeSearch("champa"))) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBeUndefined();
    expect(err.message).toBe("slow down");
  });

  it("parses Retry-After identically on the authenticated path", async () => {
    stubAuth();
    stubFetch(() =>
      jsonResponse({ detail: { error: "rate_limited" } }, 429, {
        "Retry-After": "12",
      }),
    );

    const err = (await rejection(
      endTrackedRide("ride-1", {
        ended_at: "2026-07-29T18:00:00+00:00",
        end_lat: 39.75,
        end_lon: -104.99,
      }),
    )) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(12);
  });
});

describe("public error mapping", () => {
  it("keeps a structured 503 as a NoDataError carrying its error key", async () => {
    stubFetch(() =>
      jsonResponse({ detail: { error: "geocoder_unavailable" } }, 503),
    );

    const err = (await rejection(geocodeSearch("union station"))) as NoDataError;

    expect(err).toBeInstanceOf(NoDataError);
    expect(err.status).toBe(503);
    expect(err.errorKey).toBe("geocoder_unavailable");
  });

  it("preserves the legacy message for a failure with no body", async () => {
    stubFetch(() => new Response(null, { status: 500 }));

    const err = (await rejection(fetchPricing())) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toBe("Request to /api/v1/meta/pricing failed: 500");
  });
});

describe("ride-end report", () => {
  it("sends PATCH with a bearer token and the §10 fields", async () => {
    stubAuth("tok-42");
    const calls = stubFetch(() => jsonResponse({ id: "ride-1" }));

    await endTrackedRide("ride 1/x", {
      ended_at: "2026-07-29T18:00:00+00:00",
      end_lat: 39.75,
      end_lon: -104.99,
      reported_minutes: 14,
      reported_plan: "resident",
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("/api/v1/tracked-rides/ride%201%2Fx/end");
    expect(call.init?.method).toBe("PATCH");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-42");
    expect(JSON.parse(String(call.init?.body))).toMatchObject({
      ended_at: "2026-07-29T18:00:00+00:00",
      reported_minutes: 14,
      reported_plan: "resident",
    });
  });
});

describe("response shape helpers", () => {
  it("unwraps the active-ride envelope, including the no-ride case", async () => {
    stubAuth();
    stubFetch(() => jsonResponse({ active: null }));
    expect(await getActiveRide()).toBeNull();

    stubAuth();
    stubFetch(() => jsonResponse({ active: { id: "ride-9" } }));
    expect(await getActiveRide()).toMatchObject({ id: "ride-9" });
  });

  it("passes the proximity bias params and unwraps geocode results", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        results: [
          {
            label: "1701 Champa St, Denver",
            lat: 39.747,
            lon: -104.992,
            kind: "house",
            in_coverage: true,
          },
        ],
      }),
    );

    const results = await geocodeSearch(
      "1701 champa",
      { lat: 39.7392, lon: -104.9876, limit: 6 },
      undefined,
    );

    expect(results).toHaveLength(1);
    expect(results[0].in_coverage).toBe(true);
    const url = new URL(calls[0].url, "https://data.scooter.fyi");
    expect(url.pathname).toBe("/api/v1/geocode/search");
    expect(url.searchParams.get("q")).toBe("1701 champa");
    expect(url.searchParams.get("lat")).toBe("39.7392");
    expect(url.searchParams.get("lon")).toBe("-104.9876");
    expect(url.searchParams.get("limit")).toBe("6");
  });

  it("normalizes both points-schedule encodings and reports absence", () => {
    const schedule = {
      battery_contribution: { base: 8, per_step: 2, step_km: 2 },
      ride_survey: 4,
    };

    expect(pointsScheduleEntry(schedule, "battery_contribution")).toEqual({
      base: 8,
      per_step: 2,
      step_km: 2,
    });
    expect(pointsScheduleEntry(schedule, "ride_survey")).toEqual({ points: 4 });
    expect(pointsScheduleEntry(schedule, "nav_distance_bonus")).toBeNull();
    expect(pointsScheduleEntry(null, "ride_survey")).toBeNull();
  });
});
