// @vitest-environment happy-dom
//
// The device card and rider reports (fleet reports Phase 3): the verdict bar
// says High risk WITH the reason, the details tile shows the most recent
// report, and a scooter riders could check carries an invitation to.
//
// Same harness as devices-popup-gate.test.ts: only `maplibregl.Popup` is
// faked, so the assertions read the real markup and the real click wiring.
import { beforeEach, describe, expect, it, vi } from "vitest";

let lastPopupHtml = "";
let lastPopupEl: HTMLElement | null = null;

vi.mock("maplibre-gl", () => {
  class FakePopup {
    private el: HTMLElement | null = null;
    setLngLat(): this {
      return this;
    }
    setHTML(html: string): this {
      lastPopupHtml = html;
      const el = document.createElement("div");
      el.innerHTML = html;
      this.el = el;
      lastPopupEl = el;
      return this;
    }
    addTo(): this {
      return this;
    }
    getElement(): HTMLElement | null {
      return this.el;
    }
    remove(): this {
      return this;
    }
    on(): this {
      return this;
    }
  }
  return { default: { Popup: FakePopup } };
});

let signedIn = true;
vi.mock("./map-auth.js", () => ({
  isAuthenticated: () => signedIn,
  getAuth: () => (signedIn ? { token: "tok-1" } : null),
}));
vi.mock("./geocode.ts", () => ({ reverseGeocode: () => Promise.resolve(null) }));

import { Devices } from "./devices.ts";
import { _resetTelemetryForTests } from "./telemetry.ts";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import type { Map as MLMap } from "maplibre-gl";
import type { Locate, LngLat } from "./locate.ts";

const DEVICE: [number, number] = [-104.99, 39.74];
const NEAR: LngLat = { lng: DEVICE[0] + 0.0002, lat: DEVICE[1] };
const FAR: LngLat = { lng: DEVICE[0] + 0.03, lat: DEVICE[1] };
const VID = "8c4a1f0d2e9b7a35";

function fakeMap() {
  return {
    getSource: () => ({ setData: vi.fn() }),
    hasImage: () => true,
    addImage: () => {},
    easeTo: () => {},
    getZoom: () => 16,
  };
}

function fakeLocate(fix: LngLat | null): Locate {
  return {
    onFix: () => () => {},
    current: () => fix,
    showLineTo: () => {},
    clearLine: () => {},
  } as unknown as Locate;
}

const TRACKED: Partial<DeviceProperties> = {
  number_failed_starts: 0,
  first_observed_at_location: new Date(Date.now() - 3_600_000).toISOString(),
  quality_designation: "good",
};

function openPopup(props: Partial<DeviceProperties>, fix: LngLat | null = NEAR): string {
  const devices = new Devices(fakeMap() as unknown as MLMap, fakeLocate(fix));
  const resp: DevicesResponse = {
    type: "FeatureCollection",
    metadata: {
      cycle_id: "c1",
      snapshot_time: "2026-10-09T18:00:00Z",
      device_count: 1,
      filters: {},
    },
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: DEVICE },
        properties: {
          device_id: "d1",
          form_factor: "scooter",
          spatial_status: "denver_core",
          vehicle_plate: "12345",
          vehicle_identifier: VID,
          vehicle_model_name: "Apollo",
          ...TRACKED,
          ...props,
        } as DeviceProperties,
      },
    ],
  };
  devices.setData(resp);
  devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
  return lastPopupHtml;
}

const verdict = (): string =>
  lastPopupEl?.querySelector(".device-popup__verdict-text")?.textContent ?? "";

beforeEach(() => {
  lastPopupHtml = "";
  lastPopupEl = null;
  signedIn = true;
  document.body.replaceChildren();
  _resetTelemetryForTests();
});

describe("the verdict bar names the report", () => {
  it("High risk: reported not rideable (flat tire)", () => {
    openPopup({
      has_negative_report: true,
      negative_report_risk: "high_risk",
      negative_report_reason: "not_rideable",
      negative_report_reason_detail: "flat_tire",
      reliability_tier: "high_risk",
    });
    expect(verdict()).toBe("High risk: reported not rideable (flat tire)");
    expect(lastPopupHtml).toContain("device-popup__verdict--risk");
  });

  it("High risk: reported inaccessible — and says don't go in", () => {
    openPopup({
      has_negative_report: true,
      negative_report_risk: "high_risk",
      negative_report_reason: "inaccessible",
      reliability_tier: "high_risk",
    });
    expect(verdict()).toBe("High risk: reported inaccessible");
    expect(lastPopupEl?.textContent).toContain("don't go in");
  });

  it("Unknown risk for an anonymous report over 24 h, with the reason", () => {
    openPopup({
      has_negative_report: false,
      negative_report_risk: "unknown",
      negative_report_reason: "damaged",
      reliability_tier: "unknown",
    });
    expect(verdict()).toBe("Unknown risk: reported damaged");
    expect(lastPopupHtml).toContain("device-popup__verdict--unknown");
  });

  it("plain High risk when the report fields are null (detail query failed)", () => {
    openPopup({
      has_negative_report: true,
      negative_report_risk: null,
      negative_report_reason: null,
      reliability_tier: "high_risk",
    });
    expect(verdict()).toBe("High risk: reported by a rider");
  });

  it("no report, no report words", () => {
    openPopup({ has_negative_report: false, reliability_tier: "ok" });
    expect(verdict()).toBe("Likely rideable");
    expect(lastPopupHtml).not.toContain("reported");
  });
});

describe("the details tile shows the most recent report", () => {
  it("Last report: Inaccessible · Oct 8 (anonymous)", () => {
    openPopup({
      has_negative_report: true,
      negative_report_reason: "inaccessible",
      latest_report: {
        report_type: "inaccessible",
        reason: null,
        observed_at: "2026-10-08T17:00:00Z",
        reported_at: "2026-10-08T17:05:00Z",
        anonymous: true,
      },
    });
    expect(lastPopupEl?.querySelector(".device-popup__last-report")?.textContent).toBe(
      "Last report: Inaccessible · Oct 8 (anonymous)",
    );
  });

  it("with the not-rideable reason, from the MapLibre-flattened string", () => {
    openPopup({
      has_negative_report: true,
      negative_report_reason: "not_rideable",
      latest_report: JSON.stringify({
        report_type: "not_rideable",
        reason: "lighting",
        observed_at: "2026-10-07T17:00:00Z",
        reported_at: "2026-10-07T17:00:00Z",
        anonymous: false,
      }),
    });
    expect(lastPopupEl?.querySelector(".device-popup__last-report")?.textContent).toBe(
      "Last report: Not rideable (lights) · Oct 7",
    );
  });

  it("shows nothing when there is none", () => {
    openPopup({ latest_report: null });
    expect(lastPopupEl?.querySelector(".device-popup__last-report")).toBeNull();
    expect(lastPopupHtml).not.toContain("Last report");
  });
});

describe("the condition-check invitation", () => {
  const reported = {
    has_negative_report: true,
    negative_report_reason: "not_rideable",
    needs_condition_check: true,
  } as Partial<DeviceProperties>;

  it("invites a check, for up to 50 points", () => {
    openPopup(reported);
    const invite = lastPopupEl?.querySelector<HTMLButtonElement>(
      '[data-action="condition-invite"]',
    );
    expect(invite?.textContent).toContain(
      "Riders reported a problem — confirm its condition for up to 50 points",
    );
  });

  it("is absent when no check is needed, or the server could not say", () => {
    openPopup({ ...reported, needs_condition_check: false });
    expect(lastPopupHtml).not.toContain("condition-invite");
    openPopup({ ...reported, needs_condition_check: null });
    expect(lastPopupHtml).not.toContain("condition-invite");
  });

  it("leads into Confirm Features", () => {
    openPopup(reported);
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="condition-invite"]')
      ?.click();
    expect(document.querySelector(".device-features")).not.toBeNull();
    expect(document.body.textContent).toContain("Does this");
  });

  it("is drawn but blocked, with the reason, from across town", () => {
    openPopup(reported, FAR);
    const invite = lastPopupEl?.querySelector<HTMLButtonElement>(
      '[data-action="condition-invite-blocked"]',
    );
    expect(invite).not.toBeNull();
    expect(invite?.dataset.blocked).toBeTruthy();
    invite?.click();
    expect(
      lastPopupEl?.querySelector(".device-popup__actionhint")?.textContent,
    ).toBe(invite?.dataset.blocked);
  });
});
