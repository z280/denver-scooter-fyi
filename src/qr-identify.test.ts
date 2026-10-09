// @vitest-environment happy-dom
//
// Scan-to-identify (fleet reports Phase 3, plan §2.7): every reason a scooter
// in front of you is or isn't on your map gets its own sentence — and none
// falls through to a generic "we don't know about this scooter".
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NoDataError } from "./api.ts";
import {
  identifyScan,
  identifyView,
  type IdentifyContext,
  type IdentifyResponse,
  type MapVisibility,
} from "./qr-identify.ts";
import { openQrUtility, QR_UTILITY_MODES, rotateMode, type QrIdentifyCard } from "./qr-utility.ts";

const STICKER = "https://veoride.com/ride?number=1025543";
const VID = "8c4a1f0d2e9b7a35";

function data(over: Partial<IdentifyResponse> = {}): IdentifyResponse {
  return {
    device_id: "a1b2c3",
    vehicle_identifier: VID,
    status: "on_map",
    negative_report_risk: null,
    negative_report_reason: null,
    negative_report_reason_detail: null,
    negative_report_since: null,
    open_reports: [],
    last_observed_at: "2026-10-09T16:40:00+00:00",
    hours_missing: null,
    last_seen: null,
    gone_acknowledged_at: null,
    public_name: "Lunar 🐸",
    vehicle_model_name: "Apollo",
    form_factor: "scooter",
    as_of: "2026-10-09T16:40:00+00:00",
    ...over,
  };
}

function ctx(vis: MapVisibility, summary = ""): IdentifyContext {
  return { visibility: () => vis, filterSummary: () => summary };
}

const found = (over: Partial<IdentifyResponse> = {}) => ({ kind: "found" as const, data: data(over) });

describe("identifyScan — the call", () => {
  it("asks for the raw QR with explain=true", async () => {
    const get = vi.fn(async () => data());
    const out = await identifyScan(STICKER, get);
    expect(get).toHaveBeenCalledWith(STICKER);
    expect(out).toEqual({ kind: "found", data: data() });
  });

  it("an unreadable payload never reaches the network", async () => {
    const get = vi.fn(async () => data());
    expect(await identifyScan("WIFI:S:MyNetwork;T:WPA;;", get)).toEqual({ kind: "unreadable" });
    expect(await identifyScan("https://example.com/menu", get)).toEqual({ kind: "unreadable" });
    expect(get).not.toHaveBeenCalled();
  });

  it("maps 404, 429, the server's 400 unreadable and a dead connection", async () => {
    expect(
      await identifyScan(STICKER, async () => { throw new NoDataError("x", 404); }),
    ).toEqual({ kind: "never_tracked" });
    expect(
      await identifyScan(STICKER, async () => {
        throw new ApiError("x", "HTTP_ERROR", { status: 429, retryAfter: 30 });
      }),
    ).toEqual({ kind: "rate_limited", retryAfter: 30 });
    expect(
      await identifyScan(STICKER, async () => {
        throw new ApiError("x", "HTTP_ERROR", { status: 400, detail: { error: "unreadable" }, errorKey: "unreadable" });
      }),
    ).toEqual({ kind: "unreadable" });
    expect(
      await identifyScan(STICKER, async () => { throw new TypeError("offline"); }),
    ).toEqual({ kind: "error" });
  });
});

describe("identifyView — which reason, in its own sentence", () => {
  it("on the map and clean: says so, and offers to show it", () => {
    const v = identifyView(found(), ctx("visible"));
    expect(v.title).toBe("Lunar 🐸 · Veo Apollo");
    expect(v.reason).toBe("on_map");
    expect(v.lines[0]).toBe("It's on the map, with no open reports.");
    expect(v.actions).toEqual(["show"]);
  });

  it("a reported scooter is ON THE MAP, labelled High risk — never hidden", () => {
    const v = identifyView(
      found({
        negative_report_risk: "high_risk",
        negative_report_reason: "inaccessible",
        negative_report_since: "2026-10-06T18:02:11+00:00",
        open_reports: [
          { report_type: "inaccessible", reason: null, reported_at: "2026-10-06T18:02:11+00:00", risk: "high_risk" },
          { report_type: "not_rideable", reason: "flat_tire", reported_at: "2026-10-08T18:00:00+00:00", risk: "unknown" },
        ],
      }),
      ctx("visible"),
    );
    expect(v.reason).toBe("on_map");
    expect(v.lines).toContain("It's on the map.");
    expect(v.lines).toContain("Labelled High risk: reported inaccessible (since Oct 6).");
    expect(v.lines.join(" ")).toMatch(/don't go in/);
    expect(v.lines.join(" ")).toContain(
      "Open reports: Inaccessible · Oct 6; Not rideable (flat tire) · Oct 8 (anonymous, unconfirmed).",
    );
    expect(v.lines.join(" ")).toMatch(/clear when the scooter is moved 100 m/);
    // There is no "hidden"/"suppressed" reason any more.
    expect(v.lines.join(" ")).not.toMatch(/hidden|suppress/i);
  });

  it("filtered: names the rider's own filters and offers to clear them", () => {
    const v = identifyView(found(), ctx("filtered", "Models: Cosmo · ≥ 50%"));
    expect(v.reason).toBe("filtered");
    expect(v.lines[0]).toBe("It's on the map, but your filters hide it (Models: Cosmo · ≥ 50%).");
    expect(v.actions).toEqual(["clear_filters"]);
  });

  it("unavailable: out of service or reserved, hidden by the default", () => {
    const v = identifyView(found(), ctx("unavailable"));
    expect(v.reason).toBe("unavailable");
    expect(v.lines[0]).toMatch(/out of service or reserved/);
  });

  it("a feed newer than the rider's map", () => {
    expect(identifyView(found(), ctx("absent")).lines[0]).toMatch(/next refresh/);
  });

  it("missing: when, and where to within ~100 m", () => {
    const v = identifyView(
      found({
        status: "missing",
        device_id: null,
        hours_missing: 77,
        last_observed_at: "2026-10-06T11:00:00+00:00",
        last_seen: { lat: 39.74, lon: -104.99 },
      }),
      ctx("absent"),
    );
    expect(v.reason).toBe("missing");
    expect(v.lines[0]).toBe(
      "Veo's feed stopped showing this scooter 3 days ago (last seen Oct 6). It may be in a van for charging or repair, or switched off.",
    );
    expect(v.actions).toEqual(["last_seen"]);
  });

  it("gone: said plainly", () => {
    const v = identifyView(
      found({ status: "gone", device_id: null, hours_missing: 400, gone_acknowledged_at: "2026-10-02T12:00:00Z" }),
      ctx("absent"),
    );
    expect(v.reason).toBe("gone");
    expect(v.lines[0]).toBe(
      "This scooter is permanently gone from the fleet (confirmed Oct 2). It won't be back on the map.",
    );
    expect(v.actions).toEqual([]);
  });

  it("the failures each have their own words", () => {
    const sentences = (["unreadable", "never_tracked", "rate_limited", "error"] as const).map(
      (kind) => identifyView({ kind } as never, ctx("visible")).lines[0],
    );
    expect(new Set(sentences).size).toBe(4);
    expect(sentences[0]).toMatch(/doesn't look like a scooter's QR code/);
    expect(sentences[1]).toMatch(/never tracked/);
  });
});

describe("the QR tool's Identify mode", () => {
  afterEach(() => document.body.replaceChildren());

  it("comes first on the dial, and rotateMode wraps over three", () => {
    expect(QR_UTILITY_MODES.map((m) => m.mode)).toEqual(["identify", "features", "ride"]);
    expect(rotateMode("ride", 1)).toBe("identify");
    expect(rotateMode("identify", -1)).toBe("ride");
    expect(rotateMode("features", 3)).toBe("features");
  });

  it("shows the card and runs an action, closing the tool", async () => {
    const run = vi.fn();
    const card: QrIdentifyCard = {
      title: "Lunar 🐸 · Veo Apollo",
      lines: ["It's on the map, but your filters hide it."],
      actions: [{ label: "Clear my filters and show it", run }],
    };
    const onIdentify = vi.fn(async () => card);
    openQrUtility({
      onConfirmFeatures: vi.fn(),
      onRideScan: vi.fn(async () => ""),
      onIdentify,
      scan: ((o: { onScan(v: string): void }) => {
        o.onScan(STICKER);
        return () => {};
      }) as never,
    });
    document.querySelector<HTMLButtonElement>(".qr-utility__scan")!.click();
    expect(onIdentify).toHaveBeenCalledWith(STICKER);
    await vi.waitFor(() =>
      expect(document.querySelector(".qr-utility__identify-title")?.textContent).toBe(
        "Lunar 🐸 · Veo Apollo",
      ),
    );
    expect(document.body.textContent).toContain("your filters hide it");
    document.querySelector<HTMLButtonElement>(".qr-utility__identify-actions button")!.click();
    expect(run).toHaveBeenCalled();
    expect(document.querySelector(".qr-utility")).toBeNull();
  });
});
