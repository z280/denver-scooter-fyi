// @vitest-environment happy-dom
//
// The My Scooters panel, through the DOM.
//
// `my-scooters.ts` holds the rules and is tested there. What is only testable
// here is that the rendered row obeys them — in particular the one that
// matters, which is a claim about pixels and not about a function: an in-use
// scooter's position must not be ON SCREEN, however it got there.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./map-auth.js", () => ({ isAuthenticated: () => true }));

import { wireMyScooters, type MyScootersHandle } from "./my-scooters-panel.ts";
import type { FavoriteDevice } from "./api.ts";
import { ApiError } from "./api.ts";

const AT = { lat: 39.7392, lng: -104.9903 };

function fav(over: Partial<FavoriteDevice> = {}): FavoriteDevice {
  return {
    vehicle_identifier: "8c4a1f0d2e9b7a35",
    nickname: "My Rover",
    state: "available",
    position_withheld: false,
    notify_on_available: false,
    verified_at: null,
    created_at: null,
    last_seen_at: null,
    vehicle_model_name: "Cosmo",
    vehicle_use_type: "sitting",
    lat: 39.7501,
    lon: -104.9987,
    battery_percent: 71,
    current_range_meters: 12000,
    ...over,
  };
}

function markup(): void {
  document.body.replaceChildren();
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <section id="tools-my-scooters" hidden>
      <ul id="my-scooters-list"></ul>
      <button id="my-scooters-keep" type="button"></button>
      <p id="my-scooters-status" hidden></p>
    </section>`;
  document.body.append(wrap);
}

const section = () => document.getElementById("tools-my-scooters")!;
const list = () => document.getElementById("my-scooters-list")!;
const status = () => document.getElementById("my-scooters-status")!;
const keepBtn = () =>
  document.getElementById("my-scooters-keep") as HTMLButtonElement;

const flush = () => new Promise((r) => setTimeout(r, 0));

interface HarnessOpts {
  favorites?: FavoriteDevice[];
  fix?: { lat: number; lng: number } | null;
  signedIn?: boolean;
  keep?: ReturnType<typeof vi.fn>;
  scanPayload?: string | null;
}

function harness(opts: HarnessOpts = {}) {
  let favorites = opts.favorites ?? [];
  const listFn = vi.fn(async () => ({
    favorite_devices: favorites,
    max_favorites: 10,
  }));
  const keepFn =
    opts.keep ??
    vi.fn(async () => ({
      favorite: favorites[0] ?? fav(),
      already_favorited: false,
      points_awarded: 100,
    }));
  const updateFn = vi.fn(async () => ({ favorite: null }));
  const forgetFn = vi.fn(async () => undefined);
  const scan = vi.fn((o: { onScan(raw: string): void; onClose?(): void }) => {
    if (opts.scanPayload === null) o.onClose?.();
    else o.onScan(opts.scanPayload ?? "https://veoride.com/x?number=10-25 543");
    return () => {};
  });

  const handle: MyScootersHandle = wireMyScooters({
    section: section(),
    list: list(),
    keepButton: keepBtn(),
    status: status(),
    locate: { current: () => (opts.fix === undefined ? AT : opts.fix) },
    signedIn: () => opts.signedIn ?? true,
    scan: scan as never,
    api: { list: listFn as never, keep: keepFn as never,
           update: updateFn as never, forget: forgetFn as never },
  });

  return {
    handle,
    listFn,
    keepFn,
    updateFn,
    forgetFn,
    scan,
    setFavorites(next: FavoriteDevice[]) {
      favorites = next;
    },
  };
}

beforeEach(() => markup());

// ---------------------------------------------------------------------------
// The withholding, as pixels
// ---------------------------------------------------------------------------
describe("an in-use scooter's position never reaches the screen", () => {
  it("renders the explanation instead of a position", async () => {
    harness({
      favorites: [
        fav({
          state: "in_use",
          position_withheld: true,
          lat: undefined,
          lon: undefined,
          battery_percent: undefined,
        }),
      ],
    });
    await flush();
    const text = list().textContent ?? "";
    expect(text).toContain("In use");
    expect(text).toContain("when it's parked");
    expect(text).not.toContain("39.75");
    expect(text).not.toContain("71%");
  });

  it("DROPS a position it had already rendered when the scooter is taken", async () => {
    // The regression this whole feature turns on. A panel that kept the last
    // known dot around — as a cache, as a stale DOM node, as anything — would
    // let a rider watch a scooter leave. Re-rendering from the new payload
    // and holding nothing between renders is what prevents it.
    const h = harness({ favorites: [fav()] });
    await flush();
    expect(list().textContent).toContain("min walk");

    h.setFavorites([
      fav({
        state: "in_use",
        position_withheld: true,
        lat: undefined,
        lon: undefined,
        battery_percent: undefined,
      }),
    ]);
    await h.handle.refresh();

    const text = list().textContent ?? "";
    expect(text).toContain("In use");
    expect(text).not.toContain("min walk");
    expect(text).not.toContain("71%");
  });

  it("withholds on the flag even when the server also sent a position", async () => {
    harness({ favorites: [fav({ state: "in_use", position_withheld: true })] });
    await flush();
    expect(list().textContent).not.toContain("min walk");
  });

  it("offers no Show on map for a withheld row", async () => {
    harness({
      favorites: [fav({ state: "in_use", position_withheld: true, lat: undefined })],
    });
    await flush();
    expect(list().querySelector("button")?.textContent).not.toBe("Show on map");
  });
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
describe("the list", () => {
  it("shows a parked scooter's walk and charge", async () => {
    harness({ favorites: [fav()] });
    await flush();
    const text = list().textContent ?? "";
    expect(text).toContain("My Rover");
    expect(text).toContain("min walk");
    expect(text).toContain("71% charge");
  });

  it("omits the walk when location is off, without hiding the row", async () => {
    harness({ favorites: [fav()], fix: null });
    await flush();
    expect(list().textContent).toContain("My Rover");
    expect(list().textContent).not.toContain("min walk");
  });

  it("stays hidden while signed out", async () => {
    harness({ favorites: [fav()], signedIn: false });
    await flush();
    expect(section().hidden).toBe(true);
    expect(list().children).toHaveLength(0);
  });

  it("keeps what was on screen when a refresh fails", async () => {
    // A dropped request must not read as "your scooters are gone".
    const h = harness({ favorites: [fav()] });
    await flush();
    h.listFn.mockRejectedValueOnce(new Error("offline"));
    await h.handle.refresh();
    expect(list().textContent).toContain("My Rover");
    expect(status().textContent).toContain("last had");
  });
});

// ---------------------------------------------------------------------------
// Keeping one
// ---------------------------------------------------------------------------
describe("keeping a scooter", () => {
  it("sends the raw payload and the current fix, and nothing else", async () => {
    const h = harness();
    keepBtn().click();
    await flush();
    expect(h.keepFn).toHaveBeenCalledWith({
      qr_raw_value: "https://veoride.com/x?number=10-25 543",
      lat: AT.lat,
      lng: AT.lng,
    });
  });

  it("passes the popup's vehicle through when the star started it", async () => {
    const h = harness();
    await h.handle.keep({ vehicleIdentifier: "8c4a1f0d2e9b7a35" });
    expect(h.keepFn.mock.calls[0][0]).toMatchObject({
      vehicle_identifier: "8c4a1f0d2e9b7a35",
    });
  });

  it("refuses without a fix, and does not spend a request finding out", async () => {
    const h = harness({ fix: null });
    keepBtn().click();
    await flush();
    expect(h.keepFn).not.toHaveBeenCalled();
    expect(status().textContent).toContain("location on");
  });

  it("renders the server's refusal rather than a code", async () => {
    const keep = vi.fn().mockRejectedValue(
      new ApiError("x", "HTTP_ERROR", {
        status: 403,
        detail: { error: "too_far_from_device", meters_away: 212 },
        errorKey: "too_far_from_device",
      }),
    );
    harness({ keep });
    keepBtn().click();
    await flush();
    expect(status().textContent).toContain("standing at this one");
    expect(status().textContent).toContain("212");
  });

  it("says nothing and calls nothing when the camera is dismissed", async () => {
    const h = harness({ scanPayload: null });
    keepBtn().click();
    await flush();
    expect(h.keepFn).not.toHaveBeenCalled();
    expect(status().hidden).toBe(true);
  });

  it("credits the first scan's points in the confirmation", async () => {
    harness();
    keepBtn().click();
    await flush();
    expect(status().textContent).toContain("100 points");
  });

  it("does not claim points for one already kept", async () => {
    const keep = vi.fn(async () => ({
      favorite: fav(),
      already_favorited: true,
      points_awarded: 0,
    }));
    harness({ keep });
    keepBtn().click();
    await flush();
    expect(status().textContent).toContain("already yours");
    expect(status().textContent).not.toContain("points");
  });

  it("sends a signed-out rider to sign in without opening the camera", async () => {
    const h = harness({ signedIn: false });
    keepBtn().click();
    await flush();
    expect(h.scan).not.toHaveBeenCalled();
    expect(status().textContent).toContain("Sign in");
  });
});

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------
describe("row actions", () => {
  it("lets go and reloads", async () => {
    const h = harness({ favorites: [fav()] });
    await flush();
    const letGo = [...list().querySelectorAll("button")].find(
      (b) => b.textContent === "Let go",
    )!;
    letGo.click();
    await flush();
    expect(h.forgetFn).toHaveBeenCalledWith("8c4a1f0d2e9b7a35");
    expect(status().textContent).toContain("Let go of My Rover");
  });

  it("puts the notify switch back when the save fails", async () => {
    const h = harness({ favorites: [fav()] });
    await flush();
    h.updateFn.mockRejectedValueOnce(new Error("offline"));
    const box = list().querySelector("input[type=checkbox]") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();
    expect(box.checked).toBe(false);
    expect(status().textContent).toContain("Couldn't save");
  });
});
