// @vitest-environment happy-dom
//
// The telemetry module's one hard rule is that it can never break the
// app: unknown names no-op, a throwing fetch is swallowed, opt-out and
// GPC short-circuit everything. Plus the queue mechanics — batch at 20,
// timer flush at 10 s, sendBeacon on pagehide — and the path normalizer
// that keeps device ids out of api_error props.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPT_OUT_KEY,
  _resetTelemetryForTests,
  initTelemetry,
  normalizePath,
  setAuthState,
  setTelemetryOptOut,
  telemetryEnabled,
  telemetryOptedOut,
  track,
  trackApiError,
} from "./telemetry.ts";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTelemetryForTests();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  _resetTelemetryForTests();
});

function fill(count: number): void {
  for (let i = 0; i < count; i++) track("drawer_open", { drawer: "filters" });
}

function sentBatch(call = 0): {
  v: number;
  page: Record<string, unknown>;
  events: Array<{ n: string; sid: string; p?: Record<string, unknown> }>;
} {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

describe("queue and flush", () => {
  it("flushes a batch once 20 events queue", () => {
    fill(19);
    expect(fetchMock).not.toHaveBeenCalled();
    fill(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const batch = sentBatch();
    expect(batch.v).toBe(1);
    expect(batch.events).toHaveLength(20);
    expect(batch.events[0].n).toBe("drawer_open");
  });

  it("flushes on the 10s timer without reaching the count", () => {
    vi.useFakeTimers();
    fill(2);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBatch().events).toHaveLength(2);
  });

  it("shares one session id across events and keeps it in sessionStorage", () => {
    fill(20);
    const sids = new Set(sentBatch().events.map((e) => e.sid));
    expect(sids.size).toBe(1);
    const [sid] = sids;
    expect(sid).toHaveLength(12);
    expect(sessionStorage.getItem("scooter_fyi.tsid")).toBe(sid);
  });

  it("reflects auth state as a boolean in batch context", () => {
    setAuthState(true);
    fill(20);
    expect(sentBatch().page.auth).toBe(true);
    expect(JSON.stringify(sentBatch())).not.toMatch(/account/i);
  });

  it("swallows a throwing fetch", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("network stack on fire");
      }),
    );
    expect(() => fill(20)).not.toThrow();
  });
});

describe("guards", () => {
  it("drops unknown event names", () => {
    // @ts-expect-error deliberately bad name
    track("totally_new_event", {});
    fill(19);
    expect(fetchMock).not.toHaveBeenCalled(); // 19 + dropped ≠ 20
  });

  it("opt-out short-circuits tracking and round-trips its accessor", () => {
    expect(telemetryOptedOut()).toBe(false);
    setTelemetryOptOut(true);
    expect(telemetryOptedOut()).toBe(true);
    expect(localStorage.getItem(OPT_OUT_KEY)).toBe("off");
    expect(telemetryEnabled()).toBe(false);
    fill(25);
    expect(fetchMock).not.toHaveBeenCalled();
    setTelemetryOptOut(false);
    expect(telemetryEnabled()).toBe(true);
  });

  it("honors Global Privacy Control", () => {
    (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl =
      true;
    try {
      expect(telemetryEnabled()).toBe(false);
      fill(25);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete (navigator as { globalPrivacyControl?: boolean })
        .globalPrivacyControl;
    }
  });

  it("truncates prop values and drops overflow keys", () => {
    const props: Record<string, string> = { long: "x".repeat(500) };
    for (let i = 0; i < 30; i++) props[`k${i}`] = "v";
    track("page_load", props);
    fill(19);
    const p = sentBatch().events[0].p!;
    expect((p.long as string).length).toBe(120);
    expect(Object.keys(p)).toHaveLength(12);
  });
});

describe("lifecycle", () => {
  it("initTelemetry emits page_load and beacons on pagehide", () => {
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent: navigator.userAgent,
      sendBeacon: beacon,
    });
    initTelemetry();
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it("initTelemetry is idempotent", () => {
    initTelemetry();
    initTelemetry();
    fill(19); // 1 page_load + 19 = 20 → exactly one flush
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      sentBatch().events.filter((e) => e.n === "page_load"),
    ).toHaveLength(1);
  });

  it("relays window scooter:track CustomEvents for known names only", () => {
    initTelemetry();
    window.dispatchEvent(
      new CustomEvent("scooter:track", {
        detail: { n: "ride_open", p: { entry: "popup" } },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("scooter:track", { detail: { n: "evil_event" } }),
    );
    fill(18); // 1 page_load + 1 ride_open + 18 = 20
    const names = sentBatch().events.map((e) => e.n);
    expect(names).toContain("ride_open");
    expect(names).not.toContain("evil_event");
  });
});

describe("api errors", () => {
  it("normalizes ids out of paths", () => {
    expect(normalizePath("/api/v1/devices/123456")).toBe(
      "/api/v1/devices/:id",
    );
    expect(normalizePath("/api/v1/devices/8c4a1f0d2e9b7a35/history?x=1")).toBe(
      "/api/v1/devices/:id/history",
    );
    expect(normalizePath("/api/v1/snapshots/latest")).toBe(
      "/api/v1/snapshots/latest",
    );
  });

  it("trackApiError queues a normalized api_error event", () => {
    trackApiError("/api/v1/devices/999999", 503, "upstream_down");
    fill(19);
    const event = sentBatch().events[0];
    expect(event.n).toBe("api_error");
    expect(event.p).toEqual({
      path: "/api/v1/devices/:id",
      status: 503,
      key: "upstream_down",
    });
  });
});
