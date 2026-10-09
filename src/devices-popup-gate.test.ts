// @vitest-environment happy-dom
//
// The gates on the device popup's action row.
//
// Two primary rows — ▶️ Open in Veo and 🧭 Use in Ride Mode — are gated
// GEOGRAPHICALLY: both commit the rider to THIS scooter, so both are only
// actionable within UNLOCK_PROXIMITY_M of it, with the admin bypass so the
// flows stay reachable from a desk. Start already carried this gate (issue
// #18); these tests exist because Ride Mode joined it, and the pairing is the
// kind of thing a later refactor silently drops.
//
// The final row — 📷 Take Photo / 🖼️ Show Photos — is gated on SESSION and on
// the vehicle_identifier's shape: both endpoints need a bearer token (listing
// included), and the API's path pattern is exactly 16 lowercase hex.
//
// PHASE 12 §12.2 THEN SPLIT THE TWO APART on proximity. Both were ungated by
// distance, which meant a photo of anything could be filed against any scooter
// in the city from anywhere on earth. Uploading is now `at_the_vehicle` —
// evidence about a scooter you can see — and LOOKING stays `anywhere`, because
// an old photo is worth seeing from anywhere and that is much of the point of
// having them.
//
// The only mock that matters is `maplibregl.Popup`: the real one needs a live
// map/GL context. The fake captures the HTML the popup is built from and
// hands back a real happy-dom element, so the assertions run against the
// actual rendered markup and the actual click wiring — not a re-implementation
// of the gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Signed in by default: the ride gate must not quietly ride on the session
// check that belongs to Start. The photo row flips this to prove its own
// session gate.
let signedIn = true;
vi.mock("./map-auth.js", () => ({
  isAuthenticated: () => signedIn,
  getAuth: () => (signedIn ? { token: "tok-1" } : null),
}));
// Best-effort address upgrade in the Report block — no network in tests.
vi.mock("./geocode.ts", () => ({ reverseGeocode: () => Promise.resolve(null) }));

import { Devices } from "./devices.ts";
import { _resetTelemetryForTests } from "./telemetry.ts";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import type { Map as MLMap } from "maplibre-gl";
import type { Locate, LngLat } from "./locate.ts";

const DEVICE: [number, number] = [-104.99, 39.74];
// ~0.0002° of longitude at Denver's latitude ≈ 17 m — inside the 75 m gate.
const NEAR: LngLat = { lng: DEVICE[0] + 0.0002, lat: DEVICE[1] };
// ~0.01° ≈ 855 m — comfortably outside it.
/** ~850 m: too far to UNLOCK (that needs you at the scooter) but well within
 *  walking, which is what "I'll ride this one" now starts. */
const WALKABLE: LngLat = { lng: DEVICE[0] + 0.01, lat: DEVICE[1] };
/** ~2.6 km: past the fifteen-minute walk a claim is allowed to be. */
const FAR: LngLat = { lng: DEVICE[0] + 0.03, lat: DEVICE[1] };

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
      // A plate up front keeps the popup off the async plate-lookup path.
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
  signedIn = true;
  // THE TELEMETRY QUEUE IS MODULE STATE AND IT FLUSHES AT 20 EVENTS. Opening a
  // popup records one, so the queue fills across this file and the flush lands
  // inside whichever test happens to be running when the twentieth arrives —
  // consuming the first response of that test's `mockResolvedValueOnce` queue
  // and shifting every later one by one.
  //
  // That made the file's passing state depend on how many tests precede each
  // other: adding three photo-gate tests above made the points assertion in
  // "shows what the ledger actually granted" read the NEXT response's body and
  // fail with a wrong figure, with nothing in that test to explain why. Reset
  // here so no test inherits another's queue.
  _resetTelemetryForTests();
});

describe("device popup — geographic gate on the two primary rows", () => {
  it("blocks both rows with no location fix", () => {
    const html = openPopup({ fix: null });
    expect(rideBlocked(html)).toBe(true);
    expect(rideEnabled(html)).toBe(false);
    expect(startEnabled(html)).toBe(false);
  });

  it("blocks the ride row only once it is beyond a sane walk", () => {
    // The threshold is the fifteen-minute walk dibs allows, at the pace the
    // walk router quotes — past that a claim is speculation and the walk is
    // a hike.
    const html = openPopup({ fix: FAR });
    expect(rideBlocked(html)).toBe(true);
    expect(startEnabled(html)).toBe(false);
  });

  it("does NOT block the ride row for a scooter you can walk to", () => {
    // The regression this pins: "I'll ride this one" used to share Open in
    // Veo's 75 m unlock proximity, from when it meant "I am standing at this
    // scooter". It starts a WALK now, so that gate made the walk feature
    // unreachable from anywhere you would actually need it.
    const html = openPopup({ fix: WALKABLE });
    expect(rideEnabled(html)).toBe(true);
    // Unlocking still needs you at the vehicle, which is a different claim.
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
    // Says HOW far, not just "too far" — a rider deciding whether to walk it
    // needs the number, and the app already knows it.
    expect(hint?.textContent).toContain("Too far to walk");
    expect(hint?.textContent).toMatch(/\d/);
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

// 16 lowercase hex — the shape the photo endpoints' path pattern requires.
const PHOTO_VID = "0123456789abcdef";

describe("device popup — a late admin flag", () => {
  // /auth/session resolves asynchronously after load, and the flag is pushed
  // once per token. A popup opened in that window captured adminSession =
  // false, so without a rebuild it sits there telling an admin they're too
  // far away with nothing left to correct it.
  const openFar = () => {
    const devices = new Devices(
      fakeMap() as unknown as MLMap,
      fakeLocate(FAR),
    );
    devices.setData(response([feature()]));
    devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
    return devices;
  };

  it("rebuilds an OPEN popup so the gates pick up the bypass", () => {
    const devices = openFar();
    expect(rideBlocked(lastPopupHtml)).toBe(true);
    expect(startEnabled(lastPopupHtml)).toBe(false);

    devices.setAdminSession(true); // /auth/session lands, popup still open

    expect(rideEnabled(lastPopupHtml)).toBe(true);
    expect(startEnabled(lastPopupHtml)).toBe(true);
  });

  it("does nothing when the value hasn't changed", () => {
    const devices = openFar();
    const before = lastPopupHtml;
    lastPopupHtml = "";
    devices.setAdminSession(false); // already false — no rebuild
    expect(lastPopupHtml).toBe("");
    expect(before).toContain("device-popup");
  });

  it("re-gates an open popup when admin is revoked", () => {
    const devices = openFar();
    devices.setAdminSession(true);
    expect(rideEnabled(lastPopupHtml)).toBe(true);
    devices.setAdminSession(false);
    expect(rideBlocked(lastPopupHtml)).toBe(true);
  });
});

describe("device popup — blocked is a sentence, in the rendered card (§12.4)", () => {
  // Over the RENDERED popup rather than over the source: the claim is about what
  // a rider's thumb reaches, and `title` alone was the whole bug — a phone never
  // shows a tooltip, so the rider got a dead grey button and no reason, on the
  // primary CTA.
  const worstCase = () => {
    signedIn = false;
    openPopup({ fix: null, props: { vehicle_identifier: PHOTO_VID } });
    return lastPopupEl!;
  };

  it("gives every blocked action button a reason a tap can deliver", () => {
    const el = worstCase();
    const blocked = [...el.querySelectorAll<HTMLElement>(".device-popup__actbtn.is-blocked")];
    expect(blocked.length).toBeGreaterThan(0);
    for (const btn of blocked) {
      expect(btn.dataset.blocked, btn.outerHTML).toBeTruthy();
      expect(btn.getAttribute("aria-disabled"), btn.outerHTML).toBe("true");
      // `disabled` would make the button untappable, so the reason could never
      // be delivered at all. This is the rule the rest of §12.4 rests on.
      expect(btn.hasAttribute("disabled"), btn.outerHTML).toBe(false);
      // `title` stays for pointer users, and stops being the only channel.
      expect(btn.getAttribute("title"), btn.outerHTML).toBe(btn.dataset.blocked!);
    }
  });

  it("writes that reason into the live region when it is tapped", () => {
    const el = worstCase();
    const hint = el.querySelector<HTMLElement>(".device-popup__actionhint")!;
    expect(hint.hidden).toBe(true);
    for (const btn of el.querySelectorAll<HTMLElement>(".device-popup__actbtn.is-blocked")) {
      btn.click();
      expect(hint.hidden).toBe(false);
      expect(hint.textContent).toBe(btn.dataset.blocked);
    }
  });

  it("announces politely, so a blocked tap does not interrupt", () => {
    const hint = worstCase().querySelector<HTMLElement>(".device-popup__actionhint")!;
    expect(hint.getAttribute("role")).toBe("status");
    expect(hint.getAttribute("aria-live")).toBe("polite");
  });

  it("says the right thing per button, not one shared sentence", () => {
    // The handler this replaced wired three buttons by hand, each with a
    // CAPTURED string — which is how 📷 Take Photo announced a sign-in hint to a
    // rider who was signed in and merely far away.
    signedIn = true;
    openPopup({ fix: FAR, props: { vehicle_identifier: PHOTO_VID } });
    const reasons = [
      ...lastPopupEl!.querySelectorAll<HTMLElement>(".device-popup__actbtn.is-blocked"),
    ].map((b) => b.dataset.blocked);
    expect(reasons.length).toBeGreaterThan(1);
    expect(new Set(reasons).size).toBeGreaterThan(1);
    // Nobody signed-in is told to sign in.
    for (const r of reasons) expect(r).not.toContain("Sign in");
  });
});

describe("device popup — the photo row", () => {
  it("offers both photo actions to a signed-in rider", () => {
    const html = openPopup({
      fix: NEAR,
      props: { vehicle_identifier: PHOTO_VID },
    });
    expect(html).toContain('data-action="take-photo"');
    expect(html).toContain('data-action="show-photos"');
    expect(html).not.toContain('data-action="photos-blocked"');
  });

  // PHASE 12 §12.2 SPLIT THESE TWO APART. This test used to assert that NEITHER
  // photo action was proximity-gated, on the reasoning that "an old photo is
  // worth seeing from anywhere" — which is true, and is true only of LOOKING.
  // Uploading was ungated by the same stroke, so a photo of anything could be
  // filed against any scooter in the city from anywhere on earth. The reading
  // half of the old rule survives below, unchanged; the writing half does not.
  it("keeps 🖼️ Show Photos ungated — an old photo is worth seeing from anywhere", () => {
    const html = openPopup({
      fix: FAR,
      props: { vehicle_identifier: PHOTO_VID },
    });
    expect(html).toContain('data-action="show-photos"');
  });

  it("gates 📷 Take Photo at the vehicle — a photo is evidence about a scooter you can see", () => {
    const html = openPopup({
      fix: FAR,
      props: { vehicle_identifier: PHOTO_VID },
    });
    expect(html).not.toContain('data-action="take-photo"');
    expect(html).toContain('data-action="photos-blocked"');
    // Blocked, never `disabled`: it has to stay tappable to deliver its reason,
    // and on a phone the tap is the only channel.
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(" disabled");
  });

  it("exempts an admin from the photo gate, as it does from every proximity gate", () => {
    // The gate is a credibility check, not a data dependency: the upload is
    // keyed on the DEVICE, so a distant admin files exactly the same photo.
    const html = openPopup({
      fix: FAR,
      admin: true,
      props: { vehicle_identifier: PHOTO_VID },
    });
    expect(html).toContain('data-action="take-photo"');
  });

  it("blocks both when signed out — listing needs a bearer token too", () => {
    signedIn = false;
    const html = openPopup({
      fix: NEAR,
      props: { vehicle_identifier: PHOTO_VID },
    });
    expect(html).not.toContain('data-action="take-photo"');
    expect(html).not.toContain('data-action="show-photos"');
    expect(
      lastPopupEl?.querySelectorAll('[data-action="photos-blocked"]'),
    ).toHaveLength(2);
  });

  it("sends a signed-out tap to the Account tab via the hint line", () => {
    signedIn = false;
    openPopup({ fix: NEAR, props: { vehicle_identifier: PHOTO_VID } });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="photos-blocked"]')
      ?.click();
    const hint = lastPopupEl?.querySelector<HTMLElement>(
      ".device-popup__actionhint",
    );
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain("Sign in");
  });

  it("omits the row entirely when the identifier can't address the endpoint", () => {
    // No vehicle_identifier at all, and one that is the wrong shape: neither
    // could produce anything but a 422, so there is nothing to offer.
    for (const props of [{}, { vehicle_identifier: "NOT-HEX-16-CHARS" }]) {
      const html = openPopup({ fix: NEAR, props });
      expect(html).not.toContain('data-action="take-photo"');
      expect(html).not.toContain('data-action="photos-blocked"');
    }
  });

  it("puts the photo row last in the action stack", () => {
    const html = openPopup({
      fix: NEAR,
      props: { vehicle_identifier: PHOTO_VID },
    });
    // Ride → [Start · Features] → Report/Details → Photos.
    //
    // Confirm Features moved UP, out of its own full-width bar and into a
    // shared row with Open in Veo — the card had five stacked full-width
    // bars before a rider reached anything they came for. The photo row is
    // still last, which is what this test is actually about.
    const order = [
      'data-action="use-in-ride-mode"',
      "device-popup__actbtn--start",
      'data-action="confirm-features"',
      'data-action="open-report"',
      'data-action="full-details"',
      'data-action="take-photo"',
      'data-action="show-photos"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("device popup — the photo gallery modal", () => {
  const photo = (id: number, by: string | null = "Turbo 🦔") => ({
    id,
    photo_url: `https://cdn.example/${id}.jpg`,
    created_at: "2026-07-20T10:00:00+00:00",
    uploaded_by: by,
  });
  const listing = (photos: unknown[]) =>
    new Response(
      JSON.stringify({
        vehicle_identifier: PHOTO_VID,
        count: photos.length,
        photos,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const openGallery = async (photos: unknown[]): Promise<HTMLElement> => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listing(photos)));
    openPopup({ fix: NEAR, props: { vehicle_identifier: PHOTO_VID } });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="show-photos"]')
      ?.click();
    const card = document.querySelector<HTMLElement>(".ranks-modal__card");
    expect(card).not.toBeNull();
    await vi.waitFor(() =>
      expect(card?.querySelector(".device-photos__grid")?.innerHTML).not.toContain(
        "Loading",
      ),
    );
    return card as HTMLElement;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelector(".ranks-modal")?.remove();
  });

  it("renders each photo with its attribution", async () => {
    const card = await openGallery([photo(1), photo(2, null)]);
    const imgs = card.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute("src")).toBe("https://cdn.example/1.jpg");
    const captions = [...card.querySelectorAll("figcaption")].map(
      (c) => c.textContent ?? "",
    );
    expect(captions[0]).toContain("Turbo 🦔");
    // A private uploader is credited generically, never left blank or "null".
    expect(captions[1]).toContain("a rider");
    expect(captions[1]).not.toContain("null");
  });

  it("invites the first photo when the scooter has none", async () => {
    const card = await openGallery([]);
    expect(card.querySelector(".device-photos__grid")?.textContent).toContain(
      "first",
    );
    expect(
      card.querySelector<HTMLElement>(".device-photos__add")?.hidden,
    ).toBe(false);
  });

  it("hides the add control at the 3-photo cap instead of uploading into a 409", async () => {
    const card = await openGallery([photo(1), photo(2), photo(3)]);
    expect(card.querySelector<HTMLElement>(".device-photos__add")?.hidden).toBe(
      true,
    );
    expect(card.querySelector(".device-photos__status")?.textContent).toContain(
      "all 3 photos",
    );
  });

  it("refuses to render a photo_url that isn't http(s)", async () => {
    const card = await openGallery([
      { ...photo(1), photo_url: "javascript:alert(1)" },
      photo(2),
    ]);
    const imgs = [...card.querySelectorAll("img")].map((i) =>
      i.getAttribute("src"),
    );
    expect(imgs).toEqual(["https://cdn.example/2.jpg"]);
  });

  it("distinguishes 'nothing uploaded' from 'uploaded but not displayable'", async () => {
    // The mixed case above passes even if the scheme filter runs after the
    // is-it-empty branch; only an all-rejected listing catches that ordering.
    // And the message matters: telling a rider "no photos yet" when the
    // server holds two would invite them to re-take one that already exists.
    const card = await openGallery([
      { ...photo(1), photo_url: "javascript:alert(1)" },
      { ...photo(2), photo_url: "" },
    ]);
    expect(card.querySelectorAll("img")).toHaveLength(0);
    const note = card.querySelector(".device-photos__grid")?.textContent ?? "";
    expect(note).toContain("couldn't be displayed safely");
    expect(note).not.toContain("No photos");
  });

  it("uploads a chosen photo and re-lists so the new one appears with attribution", async () => {
    // GET (empty) → POST (upload) → GET (now holds the photo). Re-listing
    // rather than appending is what carries attribution and settles the cap.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(listing([]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 9,
            vehicle_identifier: PHOTO_VID,
            photo_url: "https://cdn.example/9.jpg",
            created_at: "2026-08-01T12:00:00+00:00",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(listing([photo(9)]));
    vi.stubGlobal("fetch", fetchMock);
    openPopup({ fix: NEAR, props: { vehicle_identifier: PHOTO_VID } });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="show-photos"]')
      ?.click();
    const card = document.querySelector<HTMLElement>(".ranks-modal__card");
    const input = card?.querySelector<HTMLInputElement>(
      ".device-photos__add input",
    );
    expect(input).not.toBeNull();
    const file = new File([new Uint8Array(16)], "scooter.jpg", {
      type: "image/jpeg",
    });
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input?.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(card?.querySelector(".device-photos__status")?.textContent).toContain(
        "Thanks",
      ),
    );
    expect(card?.querySelectorAll("img")).toHaveLength(1);
    const upload = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(upload[1].method).toBe("POST");
    expect(upload[1].body).toBeInstanceOf(FormData);
    // Cleared so re-picking the same file still fires `change`.
    expect(input?.value).toBe("");
  });

  it("keeps the confirmation when the rider's own photo is the one that fills the device", async () => {
    // The 3rd uploader does the most work and was the only one never told it
    // worked: the re-list saw a full device and overwrote "Thanks" with the
    // cap notice.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(listing([photo(1), photo(2)]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 3, photo_url: "https://cdn.example/3.jpg" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)]));
    vi.stubGlobal("fetch", fetchMock);
    openPopup({ fix: NEAR, props: { vehicle_identifier: PHOTO_VID } });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="show-photos"]')
      ?.click();
    const card = document.querySelector<HTMLElement>(".ranks-modal__card");
    const input = card?.querySelector<HTMLInputElement>(
      ".device-photos__add input",
    );
    Object.defineProperty(input, "files", {
      value: [new File([new Uint8Array(4)], "s.jpg", { type: "image/jpeg" })],
      writable: true,
    });
    input?.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(card?.querySelectorAll("img")).toHaveLength(3),
    );
    expect(card?.querySelector(".device-photos__status")?.textContent).toContain(
      "Thanks",
    );
    // The cap still takes the control away — only the message is preserved.
    expect(card?.querySelector<HTMLElement>(".device-photos__add")?.hidden).toBe(
      true,
    );
  });

  it("shows what the ledger actually granted, and stays quiet when it granted nothing", async () => {
    for (const [awarded, expected] of [
      [6, "+6 pts"],
      [0, ""],
    ] as const) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(listing([]))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 4,
              photo_url: "https://cdn.example/4.jpg",
              points_awarded: awarded,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(listing([photo(4)]));
      vi.stubGlobal("fetch", fetchMock);
      openPopup({ fix: NEAR, props: { vehicle_identifier: PHOTO_VID } });
      lastPopupEl
        ?.querySelector<HTMLButtonElement>('[data-action="show-photos"]')
        ?.click();
      const card = document.querySelector<HTMLElement>(".ranks-modal__card");
      const input = card?.querySelector<HTMLInputElement>(
        ".device-photos__add input",
      );
      Object.defineProperty(input, "files", {
        value: [new File([new Uint8Array(4)], "s.jpg", { type: "image/jpeg" })],
        writable: true,
      });
      input?.dispatchEvent(new Event("change"));
      await vi.waitFor(() =>
        expect(
          card?.querySelector(".device-photos__status")?.textContent,
        ).toContain("Thanks"),
      );
      const status = card?.querySelector(".device-photos__status")?.textContent ?? "";
      if (expected) expect(status).toContain(expected);
      else expect(status).not.toContain("pts");
      document.querySelector(".ranks-modal")?.remove();
    }
  });

  it("sends the device's coordinates with the upload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(listing([]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 5, photo_url: "https://x/5.jpg" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(listing([]));
    vi.stubGlobal("fetch", fetchMock);
    openPopup({ fix: NEAR, props: { vehicle_identifier: PHOTO_VID } });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="show-photos"]')
      ?.click();
    const card = document.querySelector<HTMLElement>(".ranks-modal__card");
    const input = card?.querySelector<HTMLInputElement>(
      ".device-photos__add input",
    );
    Object.defineProperty(input, "files", {
      value: [new File([new Uint8Array(4)], "s.jpg", { type: "image/jpeg" })],
      writable: true,
    });
    input?.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const body = (fetchMock.mock.calls[1] as [string, RequestInit])[1]
      .body as FormData;
    // The DEVICE's position, not the rider's fix — the photo is of the scooter.
    expect(body.get("lng")).toBe(String(DEVICE[0]));
    expect(body.get("lat")).toBe(String(DEVICE[1]));
  });

  it("reports an upload failure and puts the control back for another try", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(listing([]))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    openPopup({ fix: NEAR, props: { vehicle_identifier: PHOTO_VID } });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="show-photos"]')
      ?.click();
    const card = document.querySelector<HTMLElement>(".ranks-modal__card");
    const input = card?.querySelector<HTMLInputElement>(
      ".device-photos__add input",
    );
    Object.defineProperty(input, "files", {
      value: [new File([new Uint8Array(4)], "s.jpg", { type: "image/jpeg" })],
      writable: true,
    });
    input?.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(card?.querySelector(".device-photos__status")?.textContent).toContain(
        "Upload failed",
      ),
    );
    expect(
      card?.querySelector<HTMLElement>(".device-photos__add")?.hidden,
    ).toBe(false);
  });

  it("explains a failed listing rather than showing an empty gallery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 })),
    );
    openPopup({ fix: NEAR, props: { vehicle_identifier: PHOTO_VID } });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="show-photos"]')
      ?.click();
    const grid = document.querySelector<HTMLElement>(".device-photos__grid");
    await vi.waitFor(() =>
      expect(grid?.textContent).toContain("Couldn't load photos"),
    );
  });
});

describe("device popup — Open in Veo and Confirm Features share a row", () => {
  const pairClass = (html: string): string | null =>
    html.match(/device-popup__pair ([a-z-]+)/)?.[1] ?? null;

  it("pairs them when both are offered", () => {
    // Near enough for the unlock link, and a vehicle whose features are not
    // yet confirmed — so both buttons exist.
    // Confirm Features is gated on a 16-hex vehicle_identifier (it posts
    // against that id), NOT on feature_status — the button is how you change
    // the status, so gating it on the status would hide it exactly when it
    // is needed.
    const html = openPopup({
      fix: NEAR,
      props: { vehicle_identifier: PHOTO_VID },
    });
    expect(html).toContain("device-popup__actbtn--start");
    expect(html).toContain('data-action="confirm-features"');
    expect(pairClass(html)).toBe("is-pair");
  });

  it("NEVER leaves a lone half-width button — one alone takes the row", () => {
    // Features already confirmed, so only Open in Veo remains. Asserted on
    // the class the grid template keys off, because that is the only thing
    // deciding the width. Same rule as the pinned Home/Work row.
    // Short identifier: no Confirm Features, so Open in Veo stands alone.
    const html = openPopup({
      fix: NEAR,
      props: { vehicle_identifier: "abc" },
    });
    if (html.includes("device-popup__pair")) {
      expect(pairClass(html)).toBe("is-single");
    }
  });
});

describe("device popup — reporting bad parking from a distance", () => {
  /** The parking block lives inside the ⚠️ Report modal, not the popup body,
   *  so the popup HTML alone never carries it — open the modal and read
   *  THAT. Discovered by the first version of these tests failing on the
   *  case that should obviously have passed. */
  const openReportModal = (opts: Parameters<typeof openPopup>[0]): string => {
    openPopup(opts);
    // Through the popup ELEMENT the harness captured — the report button's
    // listener is bound to that node, which is not in the document.
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="open-report"]')
      ?.click();
    return document.body.innerHTML;
  };
  const canReport = (html: string): boolean =>
    html.includes('data-action="report-parking"');

  it("is offered to a rider standing at the scooter", () => {
    expect(canReport(openReportModal({ fix: NEAR }))).toBe(true);
  });

  it("is refused to a rider across town, with a reason", () => {
    const html = openReportModal({ fix: FAR });
    expect(canReport(html)).toBe(false);
    expect(html).toContain("Walk within sight");
  });

  it("IS offered to an admin across town", () => {
    // The gate is a credibility check, not a data dependency — the report is
    // built from the DEVICE's coordinates, never the reporter's, so a distant
    // admin files exactly the report a nearby rider would. An admin working a
    // compliance queue reviews parking city-wide from a desk.
    expect(canReport(openReportModal({ fix: FAR, admin: true }))).toBe(true);
  });

  it("IS offered to an admin with no location fix at all", () => {
    // Both halves of the gate are waived, not just the distance one.
    expect(canReport(openReportModal({ fix: null, admin: true }))).toBe(true);
  });

  it("is still refused to a signed-out rider with no fix", () => {
    const html = openReportModal({ fix: null });
    expect(canReport(html)).toBe(false);
    expect(html).toContain("Turn on your location");
  });
});

describe("device popup — there is no bell, and that is the feature", () => {
  // A "tell me when this one moves" button on every scooter on the map is an
  // "alert me when this address's occupant leaves" tool. `device-notify.ts`'s
  // header carries the argument; this pins the absence, because the button is
  // cheap to re-add and the harm is not visible from the diff that adds it.
  //
  // The capability is not gone. It has two doors, both requiring a connection
  // the rider already has to the specific vehicle: the dibs claim this popup's
  // own "I'll ride this one" makes (`setClaimWatchHook`), and the end of a
  // ride (`ride-post-s8.ts`). Those are tested where they live.

  function open(): Devices {
    const devices = new Devices(
      fakeMap() as unknown as MLMap,
      fakeLocate(NEAR),
    );
    devices.setData(response([feature({ vehicle_identifier: PHOTO_VID })]));
    devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
    return devices;
  }

  it("renders no notify-if-moved control, near or far", () => {
    open();
    expect(lastPopupHtml).not.toContain('data-action="notify-moved"');
    expect(lastPopupHtml).not.toContain("Notify me if moved");
    expect(lastPopupHtml).not.toContain("🔔");
  });

  it("offers no way to arm a watch even with the claim hook wired", () => {
    // The hook exists for the CLAIM path. Wiring it must not resurrect a
    // button here.
    const devices = new Devices(
      fakeMap() as unknown as MLMap,
      fakeLocate(NEAR),
    );
    const hook = vi.fn(() => "armed");
    devices.setClaimWatchHook(hook);
    devices.setData(response([feature({ vehicle_identifier: PHOTO_VID })]));
    devices.jumpToDevice("d1", DEVICE[0], DEVICE[1]);
    expect(lastPopupHtml).not.toContain('data-action="notify-moved"');
    expect(hook).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The failure-report chips: gated, but still drawn.
//
// This is the most consequential thing a rider can do from this card — a
// `not_rideable` report overrides the vehicle's reliability tier for everybody,
// and since the API's signed-in rule landed it holds until the scooter moves or
// comes back charged rather than expiring in 24 hours. It used to be filable
// from anywhere on earth while "report bad parking" was correctly gated at
// 100 m: the cheap action gated, the expensive one not.
//
// The fix is a gate, NOT a disappearance. Hiding the chips teaches a visitor
// nothing about what the app does, and a feature nobody knows exists is one
// nobody uses while standing in front of a broken scooter.
// ---------------------------------------------------------------------------

describe("device popup — reporting a problem needs you to be there", () => {
  // The chips only render for a 16-hex vehicle_identifier — the API refuses
  // anything else — so every case here has to carry one.
  const WITH_VID = { vehicle_identifier: PHOTO_VID };

  /** Same lesson as the parking block above, and the same helper: these chips
   *  live inside the ⚠️ Report modal, not the popup body. The first version of
   *  these tests read `lastPopupHtml` and found nothing at all. */
  const openReportModal = (
    opts: Omit<Parameters<typeof openPopup>[0], "props">,
  ): string => {
    openPopup({ ...opts, props: WITH_VID });
    lastPopupEl
      ?.querySelector<HTMLButtonElement>('[data-action="open-report"]')
      ?.click();
    return document.body.innerHTML;
  };

  const chips = (html: string): string[] =>
    [...html.matchAll(/<button[^>]*data-action="report-device"[^>]*>/g)].map(
      (m) => m[0],
    );
  const gateNote = (html: string): string | null => {
    const m = /<p class="device-popup__report-gate">([\s\S]*?)<\/p>/.exec(html);
    return m ? m[1] : null;
  };

  it("offers all four chips, ungated, to a rider standing at the scooter", () => {
    const html = openReportModal({ fix: NEAR });
    expect(chips(html)).toHaveLength(4);
    for (const c of chips(html)) expect(c).not.toContain("data-blocked");
    expect(gateNote(html)).toBeNull();
  });

  it("still draws all four from across town — the feature has to be visible", () => {
    // The whole point of gating rather than hiding, and the one place this
    // deliberately differs from the parking block directly above it (which
    // disappears): somebody who learns the button exists is somebody who uses
    // it while standing in front of a broken scooter.
    const html = openReportModal({ fix: FAR });
    expect(chips(html)).toHaveLength(4);
  });

  it("warns, in words and before the tap, when the rider is too far", () => {
    const html = openReportModal({ fix: FAR });
    expect(gateNote(html)).toContain("too far away");
    // How far, not just "too far": a refusal the rider cannot act on is a
    // refusal they will read as the app being broken.
    expect(gateNote(html)).toMatch(/mi\)/);
    for (const c of chips(html)) expect(c).toContain("data-blocked");
  });

  it("names the OTHER reason separately when there is no fix at all", () => {
    // "You're too far away" is wrong, and confusing, for somebody whose GPS
    // is simply off — they may be standing right next to it.
    const html = openReportModal({ fix: null });
    expect(gateNote(html)).toContain("Turn on your location");
    expect(gateNote(html)).not.toContain("too far");
  });

  it("keeps blocked chips tappable, so they can deliver their own reason", () => {
    // `aria-disabled`, never `disabled`: a button that cannot be pressed can
    // never explain itself, and on a phone there is no tooltip to fall back
    // on. Same rule the rest of the card's gated actions follow.
    const html = openReportModal({ fix: FAR });
    for (const c of chips(html)) {
      expect(c).toContain('aria-disabled="true"');
      expect(c).not.toMatch(/\sdisabled[\s>]/);
    }
  });

  it("refuses the tap, in the live region, rather than sending", () => {
    // The gate has to hold at the HANDLER too. A warning the rider can tap
    // straight through is decoration, and this report overrides a vehicle's
    // reliability tier for everybody.
    openReportModal({ fix: FAR });
    const chip = document.querySelector<HTMLButtonElement>(
      '[data-action="report-device"]',
    )!;
    chip.click();
    const status = document.querySelector<HTMLElement>(
      ".device-popup__report-device-status",
    );
    expect(status?.textContent).toContain("too far away");
  });

  it("exempts admins at any distance, and with no fix", () => {
    // The gate is a credibility check, not a data dependency: the report is
    // built from the DEVICE's coordinates, so a distant admin files exactly
    // the same report. Same exemption the parking report already grants.
    for (const fix of [FAR, null]) {
      const html = openReportModal({ fix });
      void html;
      const adminHtml = openReportModal({ fix, admin: true });
      expect(gateNote(adminHtml)).toBeNull();
      for (const c of chips(adminHtml)) expect(c).not.toContain("data-blocked");
    }
  });

  it("gates on the same distance as the parking report, not a second one", () => {
    // Both are the same kind of claim — "I can see this vehicle and here is
    // what is wrong with it". A second radius is a distinction no rider can
    // perceive and nobody will maintain. (They PRESENT differently on
    // purpose — parking disappears, these stay and explain — so this compares
    // the gate, not the rendering.)
    const far = openReportModal({ fix: FAR });
    expect(gateNote(far)).not.toBeNull();
    expect(far.includes('data-action="report-parking"')).toBe(false);

    const near = openReportModal({ fix: NEAR });
    expect(gateNote(near)).toBeNull();
    expect(near.includes('data-action="report-parking"')).toBe(true);
  });
});
