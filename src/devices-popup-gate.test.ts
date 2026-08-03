// @vitest-environment happy-dom
//
// The device popup's geographic gate on its two primary rows: ▶️ Start in Veo
// and 🧭 Use in Ride Mode. Both commit the rider to THIS scooter, so both are
// only actionable within UNLOCK_PROXIMITY_M of it — with the admin bypass so
// the flows stay reachable from a desk. Start already carried this gate
// (issue #18); these tests exist because Ride Mode joined it, and the pairing
// is the kind of thing a later refactor silently drops.
//
// The only mock that matters is `maplibregl.Popup`: the real one needs a live
// map/GL context. The fake captures the HTML the popup is built from and
// hands back a real happy-dom element, so the assertions run against the
// actual rendered markup and the actual click wiring — not a re-implementation
// of the gate.
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

// Signed in throughout: the ride gate must not quietly ride on the session
// check that belongs to Start.
vi.mock("./map-auth.js", () => ({ isAuthenticated: () => true }));
// Best-effort address upgrade in the Report block — no network in tests.
vi.mock("./geocode.ts", () => ({ reverseGeocode: () => Promise.resolve(null) }));

import { Devices } from "./devices.ts";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import type { Map as MLMap } from "maplibre-gl";
import type { Locate, LngLat } from "./locate.ts";

const DEVICE: [number, number] = [-104.99, 39.74];
// ~0.0002° of longitude at Denver's latitude ≈ 17 m — inside the 75 m gate.
const NEAR: LngLat = { lng: DEVICE[0] + 0.0002, lat: DEVICE[1] };
// ~0.01° ≈ 855 m — comfortably outside it.
const FAR: LngLat = { lng: DEVICE[0] + 0.01, lat: DEVICE[1] };

function fakeMap() {
  const setData = vi.fn();
  return {
    getSource: () => ({ setData }),
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

function feature(
  extra: Partial<DeviceProperties> = {},
): GeoJSON.Feature<GeoJSON.Point, DeviceProperties> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: DEVICE },
    properties: {
      device_id: "d1",
      form_factor: "scooter",
      spatial_status: "available",
      // A plate up front keeps the popup off the async GBFS hydration path.
      vehicle_plate: "12345",
      ...extra,
    } as DeviceProperties,
  };
}

function response(
  features: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
): DevicesResponse {
  return {
    type: "FeatureCollection",
    metadata: {
      cycle_id: "c1",
      snapshot_time: "2026-07-30T00:00:00Z",
      device_count: features.length,
      filters: {},
    },
    features,
  };
}

/** Render one device's popup and return its markup. */
function openPopup(opts: {
  fix: LngLat | null;
  admin?: boolean;
  props?: Partial<DeviceProperties>;
}): string {
  const devices = new Devices(
    fakeMap() as unknown as MLMap,
    fakeLocate(opts.fix),
  );
  devices.setData(response([feature(opts.props)]));
  devices.setAdminSession(opts.admin ?? false);
  devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
  return lastPopupHtml;
}

const rideEnabled = (html: string): boolean =>
  html.includes('data-action="use-in-ride-mode"');
const rideBlocked = (html: string): boolean =>
  html.includes('data-action="ride-blocked"');
const startEnabled = (html: string): boolean =>
  html.includes("device-popup__actbtn--start") &&
  !html.includes('data-action="start-blocked"');

beforeEach(() => {
  lastPopupHtml = "";
  lastPopupEl = null;
});

describe("device popup — geographic gate on the two primary rows", () => {
  it("blocks both rows with no location fix", () => {
    const html = openPopup({ fix: null });
    expect(rideBlocked(html)).toBe(true);
    expect(rideEnabled(html)).toBe(false);
    expect(startEnabled(html)).toBe(false);
  });

  it("blocks both rows when the rider is too far away", () => {
    const html = openPopup({ fix: FAR });
    expect(rideBlocked(html)).toBe(true);
    expect(startEnabled(html)).toBe(false);
  });

  it("enables both rows within the proximity radius", () => {
    const html = openPopup({ fix: NEAR });
    expect(rideEnabled(html)).toBe(true);
    expect(rideBlocked(html)).toBe(false);
    expect(startEnabled(html)).toBe(true);
  });

  it("bypasses proximity for an admin session with no fix at all", () => {
    const html = openPopup({ fix: null, admin: true });
    expect(rideEnabled(html)).toBe(true);
    expect(startEnabled(html)).toBe(true);
  });

  it("still blocks a nearby scooter that is out of service or reserved", () => {
    const oos = openPopup({ fix: NEAR, props: { is_disabled: true } });
    expect(rideBlocked(oos)).toBe(true);
    expect(startEnabled(oos)).toBe(false);

    const held = openPopup({ fix: NEAR, props: { is_reserved: true } });
    expect(rideBlocked(held)).toBe(true);
    expect(startEnabled(held)).toBe(false);
  });

  it("blocks vehicle-status cases for admins too — the bypass is proximity only", () => {
    const html = openPopup({
      fix: null,
      admin: true,
      props: { is_disabled: true },
    });
    expect(rideBlocked(html)).toBe(true);
    expect(startEnabled(html)).toBe(false);
  });

  it("keeps the blocked Ride Mode button visible and explains itself on tap", () => {
    openPopup({ fix: FAR });
    const el = lastPopupEl;
    expect(el).not.toBeNull();
    const btn = el?.querySelector<HTMLButtonElement>(
      '[data-action="ride-blocked"]',
    );
    // Visible, not hidden — the gate informs, it does not disappear.
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-disabled")).toBe("true");
    const hint = el?.querySelector<HTMLElement>(".device-popup__actionhint");
    expect(hint?.hidden).toBe(true);
    btn?.click();
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain("too far away");
  });

  it("tells a fix-less rider to turn on location rather than to walk closer", () => {
    openPopup({ fix: null });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="ride-blocked"]')
      ?.click();
    const hint = lastPopupEl?.querySelector<HTMLElement>(
      ".device-popup__actionhint",
    );
    expect(hint?.textContent).toContain("Turn on your location");
  });
});
