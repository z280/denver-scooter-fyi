// @vitest-environment happy-dom
//
// The Local Data tab. Everything is injected — a memory-backed track store, a
// fake route layer, a fake donate call — because the point of these tests is
// the rider-visible contract: what is listed, what can be donated, and that
// delete actually removes a ride that only exists on this device.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildLocalDataPanel,
  flattenTrackBatches,
  summarizeRide,
  type LocalDataDeps,
} from "./account-local-data.ts";
import {
  MemoryTrackStorage,
  openTrackStore,
  signTrackBatch,
  type StoredTrackBatch,
  type StoredTrackRide,
  type TrackStore,
} from "./track-store.ts";
import { ApiError } from "./api.ts";

// ---------- fixtures ----------

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

const T0 = Date.UTC(2026, 6, 27, 16, 0, 0);

function ride(over: Partial<StoredTrackRide> = {}): StoredTrackRide {
  return {
    trackId: "ride-a",
    rideId: "ride-a",
    private: false,
    nonce: "00".repeat(16),
    rid: "ride-a",
    kid: "ride-a",
    key: null as unknown as CryptoKey,
    createdAtMs: T0,
    nextSeq: 1,
    prevJwsHash: "",
    chainHash: "aa",
    batchCount: 1,
    waypointCount: 2,
    lastPointMs: T0 + 600_000,
    ...over,
  };
}

/** A real signed batch, so decodeTrackBatch has something genuine to read. */
async function batch(
  seq: number,
  pts: [number, number, number, number][],
  over: Partial<StoredTrackBatch> = {},
): Promise<StoredTrackBatch> {
  const key = await hmacKey();
  const t0 = T0 + seq * 60_000;
  const jws = await signTrackBatch(key, "ride-a", {
    v: 1,
    rid: "ride-a",
    non: "00".repeat(16),
    seq,
    prev: "",
    t0,
    t1: t0 + 30_000,
    pts,
    rec: false,
  });
  return {
    trackId: "ride-a",
    seq,
    jws,
    jwsHash: `hash-${seq}`,
    chainHash: `chain-${seq}`,
    t0,
    t1: t0 + 30_000,
    count: pts.length,
    rec: false,
    ...over,
  };
}

/** A store backed by memory, with the rides/batches the test wants. */
async function fakeStore(
  rides: StoredTrackRide[],
  batches: StoredTrackBatch[] = [],
  opts: { durable?: boolean } = {},
): Promise<TrackStore> {
  const storage = new MemoryTrackStorage();
  for (const r of rides) await storage.putRide(r);
  for (const b of batches) {
    await storage.commitSeal(b, rides.find((r) => r.trackId === b.trackId)!);
  }
  const store = await openTrackStore({ storage });
  if (opts.durable) {
    Object.defineProperty(storage, "durable", { value: true });
    Object.defineProperty(store, "durable", { value: true });
    Object.defineProperty(store, "warning", { value: null });
  }
  return store;
}

function fakeRoute() {
  return { show: vi.fn(), clear: vi.fn() };
}

let host: HTMLElement;

const mount = (over: Partial<LocalDataDeps> & { getTrackStore: LocalDataDeps["getTrackStore"] }) =>
  buildLocalDataPanel(host, {
    isSignedIn: () => true,
    confirm: () => true,
    now: () => T0 + 24 * 3600_000,
    ...over,
  });

const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".track-row")];

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  document.body.replaceChildren();
});

// ---------- flattening ----------

describe("flattenTrackBatches", () => {
  it("rebuilds coordinates in GeoJSON order with absolute timestamps", async () => {
    const b0 = await batch(0, [
      [0, 39.75, -104.99, 5],
      [1000, 39.76, -104.98, 5],
    ]);
    const path = flattenTrackBatches([b0]);
    expect(path.coords).toEqual([
      [-104.99, 39.75],
      [-104.98, 39.76],
    ]);
    expect(path.times).toEqual([b0.t0, b0.t0 + 1000]);
    expect(path.meters).toBeGreaterThan(0);
    expect(path.skippedBatches).toBe(0);
  });

  it("orders by seq no matter what order it is handed", async () => {
    const b0 = await batch(0, [[0, 39.75, -104.99, 5]]);
    const b1 = await batch(1, [[0, 39.76, -104.98, 5]]);
    const path = flattenTrackBatches([b1, b0]);
    expect(path.coords).toEqual([
      [-104.99, 39.75],
      [-104.98, 39.76],
    ]);
  });

  it("skips a batch it cannot decode instead of losing the whole ride", async () => {
    const good = await batch(0, [[0, 39.75, -104.99, 5]]);
    const bad = { ...(await batch(1, [[0, 1, 1, 1]])), jws: "not-a-jws" };
    const path = flattenTrackBatches([good, bad]);
    expect(path.coords).toHaveLength(1);
    expect(path.skippedBatches).toBe(1);
  });

  it("drops non-finite coordinates", async () => {
    const b = await batch(0, [
      [0, Number.NaN, -104.99, 5],
      [10, 39.75, -104.99, 5],
    ]);
    expect(flattenTrackBatches([b]).coords).toEqual([[-104.99, 39.75]]);
  });

  it("handles an empty ride", () => {
    expect(flattenTrackBatches([])).toEqual({
      coords: [],
      times: [],
      meters: 0,
      skippedBatches: 0,
    });
  });
});

// ---------- summaries ----------

describe("summarizeRide", () => {
  it("marks a server ride with sealed batches as donatable", () => {
    expect(summarizeRide(ride()).donatable).toBe(true);
  });

  it("never marks a private ride donatable — the server has no key for it", () => {
    expect(summarizeRide(ride({ private: true, rideId: null })).donatable).toBe(
      false,
    );
  });

  it("does not offer to donate a ride with nothing sealed", () => {
    expect(summarizeRide(ride({ batchCount: 0 })).donatable).toBe(false);
  });
});

// ---------- listing ----------

describe("listing", () => {
  it("lists rides newest first, private ones included", async () => {
    const store = await fakeStore([
      ride({ trackId: "old", rideId: "old", createdAtMs: T0 - 86_400_000 }),
      ride({ trackId: "new", rideId: "new", createdAtMs: T0 }),
      ride({ trackId: "priv", rideId: null, private: true, createdAtMs: T0 - 3600_000 }),
    ]);
    const panel = mount({ getTrackStore: async () => store });
    await panel.refresh();

    expect(rows().map((r) => r.dataset.trackId)).toEqual(["new", "priv", "old"]);
    const priv = rows().find((r) => r.dataset.trackId === "priv")!;
    expect(priv.textContent).toContain("Private");
  });

  it("says so when there is nothing recorded", async () => {
    const store = await fakeStore([]);
    const panel = mount({ getTrackStore: async () => store });
    await panel.refresh();
    expect(host.textContent).toContain("No rides recorded on this device yet");
  });

  it("warns when this device cannot store tracks durably", async () => {
    const store = await fakeStore([]);
    const panel = mount({ getTrackStore: async () => store });
    await panel.refresh();
    const warn = host.querySelector<HTMLElement>(".track-warning")!;
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toContain("won't survive a reload");
  });
});

// ---------- drawing ----------

describe("showing a ride on the map", () => {
  it("draws the selected ride and clears it when deselected", async () => {
    const r = ride();
    const b = await batch(0, [
      [0, 39.75, -104.99, 5],
      [1000, 39.76, -104.98, 5],
    ]);
    const store = await fakeStore([r], [b]);
    const route = fakeRoute();
    const panel = mount({ getTrackStore: async () => store, route });
    await panel.refresh();

    const head = rows()[0].querySelector<HTMLButtonElement>(".track-row__head")!;
    head.click();
    await vi.waitFor(() => expect(route.show).toHaveBeenCalled());
    expect(route.show.mock.calls[0][0]).toEqual([
      [-104.99, 39.75],
      [-104.98, 39.76],
    ]);
    expect(rows()[0].classList.contains("is-selected")).toBe(true);

    head.click();
    expect(route.clear).toHaveBeenCalled();
    expect(rows()[0].classList.contains("is-selected")).toBe(false);
  });

  it("fills in the distance only once the ride is drawn", async () => {
    const r = ride();
    const b = await batch(0, [
      [0, 39.75, -104.99, 5],
      [1000, 39.76, -104.98, 5],
    ]);
    const store = await fakeStore([r], [b]);
    const panel = mount({ getTrackStore: async () => store, route: fakeRoute() });
    await panel.refresh();

    const meta = rows()[0].querySelector<HTMLElement>(".track-row__meta")!;
    // "10 min · 2 waypoints" — a distance would read "0.8 mi".
    expect(meta.textContent).not.toMatch(/[\d.]+ mi\b/);
    rows()[0].querySelector<HTMLButtonElement>(".track-row__head")!.click();
    await vi.waitFor(() => expect(meta.textContent).toMatch(/[\d.]+ mi\b/));
  });

  it("says so when a ride recorded no waypoints", async () => {
    const store = await fakeStore([ride({ waypointCount: 0, batchCount: 0 })]);
    const route = fakeRoute();
    const panel = mount({ getTrackStore: async () => store, route });
    await panel.refresh();

    rows()[0].querySelector<HTMLButtonElement>(".track-row__head")!.click();
    await vi.waitFor(() =>
      expect(rows()[0].textContent).toContain("No waypoints were recorded"),
    );
  });

  it("clearSelection takes the line off the map", async () => {
    const store = await fakeStore([ride()]);
    const route = fakeRoute();
    const panel = mount({ getTrackStore: async () => store, route });
    await panel.refresh();
    panel.clearSelection();
    expect(route.clear).toHaveBeenCalled();
  });
});

// ---------- delete ----------

describe("delete", () => {
  it("does nothing when the rider backs out of the confirm", async () => {
    const store = await fakeStore([ride()]);
    const spy = vi.spyOn(store, "deleteRide");
    const panel = mount({ getTrackStore: async () => store, confirm: () => false });
    await panel.refresh();

    rows()[0].querySelector<HTMLButtonElement>(".track-row__delete")!.click();
    expect(spy).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it("removes the ride and takes its line off the map", async () => {
    const r = ride();
    const b = await batch(0, [[0, 39.75, -104.99, 5]]);
    const store = await fakeStore([r], [b]);
    const route = fakeRoute();
    const panel = mount({ getTrackStore: async () => store, route });
    await panel.refresh();

    rows()[0].querySelector<HTMLButtonElement>(".track-row__head")!.click();
    await vi.waitFor(() => expect(route.show).toHaveBeenCalled());

    route.clear.mockClear();
    rows()[0].querySelector<HTMLButtonElement>(".track-row__delete")!.click();
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(route.clear).toHaveBeenCalled();
    expect(await store.storage.getRide("ride-a")).toBeNull();
  });
});

// ---------- donate ----------

describe("donate", () => {
  const donatableStore = async () => {
    const r = ride();
    const b = await batch(0, [[0, 39.75, -104.99, 5]]);
    return fakeStore([r], [b]);
  };

  const openConsent = (): void => {
    rows()[0]
      .querySelectorAll<HTMLButtonElement>(".track-row__actions button")
      .forEach((b) => {
        if (b.textContent === "Donate") b.click();
      });
  };
  const confirmDonate = (): void => {
    rows()[0]
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => {
        if (b.textContent === "Donate this ride") b.click();
      });
  };

  it("is not offered for a private ride, and says why", async () => {
    const store = await fakeStore([
      ride({ trackId: "p", rideId: null, private: true }),
    ]);
    const panel = mount({ getTrackStore: async () => store });
    await panel.refresh();

    const labels = [...rows()[0].querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Donate");
    expect(rows()[0].textContent).toContain("stays on this device");
  });

  it("is not offered while signed out", async () => {
    const store = await donatableStore();
    const panel = mount({
      getTrackStore: async () => store,
      isSignedIn: () => false,
    });
    await panel.refresh();
    const labels = [...rows()[0].querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Donate");
  });

  it("shows the disclosure before uploading anything", async () => {
    const donateTrack = vi.fn();
    const store = await donatableStore();
    const panel = mount({ getTrackStore: async () => store, donateTrack });
    await panel.refresh();

    openConsent();
    expect(rows()[0].textContent).toContain("Donating uploads");
    expect(donateTrack).not.toHaveBeenCalled();
  });

  it("uploads the sealed chain and its root hash", async () => {
    const donateTrack = vi.fn().mockResolvedValue({});
    const store = await donatableStore();
    const batches = await store.storage.getBatches("ride-a");
    const panel = mount({ getTrackStore: async () => store, donateTrack });
    await panel.refresh();

    openConsent();
    confirmDonate();
    await vi.waitFor(() => expect(donateTrack).toHaveBeenCalled());

    const [rideId, body] = donateTrack.mock.calls[0];
    expect(rideId).toBe("ride-a");
    expect(body).toEqual({ batches: batches.map((b) => b.jws) });
    await vi.waitFor(() => expect(rows()[0].textContent).toContain("thank you"));
  });

  it("treats already_donated as the outcome the rider wanted", async () => {
    const donateTrack = vi
      .fn()
      .mockRejectedValue(
        new ApiError("already donated", "HTTP_ERROR", {
          status: 409,
          errorKey: "already_donated",
        }),
      );
    const store = await donatableStore();
    const panel = mount({ getTrackStore: async () => store, donateTrack });
    await panel.refresh();

    openConsent();
    confirmDonate();
    await vi.waitFor(() =>
      expect(rows()[0].textContent).toContain("Already donated"),
    );
  });

  it("leaves a throttled upload retryable", async () => {
    const donateTrack = vi
      .fn()
      .mockRejectedValue(
        new ApiError("slow down", "HTTP_ERROR", { status: 429, retryAfter: 60 }),
      );
    const store = await donatableStore();
    const panel = mount({ getTrackStore: async () => store, donateTrack });
    await panel.refresh();

    openConsent();
    confirmDonate();
    // Wait for the failure itself, not the "Uploading…" that precedes it.
    await vi.waitFor(() =>
      expect(
        rows()[0].querySelector(".account-magic-status--error")?.textContent,
      ).toBeTruthy(),
    );
    const confirmBtn = [...rows()[0].querySelectorAll("button")].find(
      (b) => b.textContent === "Donate this ride",
    )!;
    expect(confirmBtn.disabled).toBe(false);
  });
});

// ---------- export ----------

describe("GeoJSON export", () => {
  it("downloads the ride as a FeatureCollection with parallel times", async () => {
    const b0 = await batch(0, [
      [0, 39.75, -104.99, 5],
      [1000, 39.76, -104.98, 5],
    ]);
    const store = await fakeStore([ride()], [b0]);
    const download = vi.fn();
    const panel = mount({ getTrackStore: async () => store, download });
    await panel.refresh();

    rows()[0].querySelector<HTMLButtonElement>(".track-row__export")!.click();
    await vi.waitFor(() => expect(download).toHaveBeenCalled());

    const [filename, text] = download.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^scooter-fyi-ride-\d{4}-\d{2}-\d{2}-\d{4}\.geojson$/);
    const doc = JSON.parse(text);
    expect(doc.type).toBe("FeatureCollection");
    const feature = doc.features[0];
    expect(feature.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [-104.99, 39.75],
        [-104.98, 39.76],
      ],
    });
    expect(feature.properties.track_id).toBe("ride-a");
    expect(feature.properties.waypoint_count).toBe(2);
    expect(feature.properties.coordinate_times).toEqual([
      new Date(b0.t0).toISOString(),
      new Date(b0.t0 + 1000).toISOString(),
    ]);
    expect(rows()[0].textContent).toContain("Exported.");
  });

  it("exports a single surviving waypoint as a Point", async () => {
    // RFC 7946 requires two positions for a LineString; a one-fix ride is
    // still the rider's data and still exports.
    const b0 = await batch(0, [[0, 39.75, -104.99, 5]]);
    const store = await fakeStore([ride()], [b0]);
    const download = vi.fn();
    const panel = mount({ getTrackStore: async () => store, download });
    await panel.refresh();

    rows()[0].querySelector<HTMLButtonElement>(".track-row__export")!.click();
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    const doc = JSON.parse(download.mock.calls[0][1] as string);
    expect(doc.features[0].geometry).toEqual({
      type: "Point",
      coordinates: [-104.99, 39.75],
    });
  });

  it("refuses to download an empty file for a ride with no waypoints", async () => {
    const store = await fakeStore([ride()]);
    const download = vi.fn();
    const panel = mount({ getTrackStore: async () => store, download });
    await panel.refresh();

    rows()[0].querySelector<HTMLButtonElement>(".track-row__export")!.click();
    await vi.waitFor(() => {
      expect(rows()[0].textContent).toContain("No waypoints were recorded");
    });
    expect(download).not.toHaveBeenCalled();
  });

  it("says when damaged segments were left out of the file", async () => {
    const good = await batch(0, [[0, 39.75, -104.99, 5], [1000, 39.76, -104.98, 5]]);
    const bad = { ...(await batch(1, [[0, 1, 1, 1]])), jws: "not-a-jws" };
    const store = await fakeStore([ride()], [good, bad]);
    const download = vi.fn();
    const panel = mount({ getTrackStore: async () => store, download });
    await panel.refresh();

    rows()[0].querySelector<HTMLButtonElement>(".track-row__export")!.click();
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    expect(rows()[0].textContent).toContain("1 damaged segment(s) skipped");
    const doc = JSON.parse(download.mock.calls[0][1] as string);
    expect(doc.features[0].properties.skipped_batches).toBe(1);
  });
});

// ---------- teardown ----------

describe("teardown", () => {
  it("clears the map and stops touching the DOM", async () => {
    const store = await fakeStore([ride()]);
    const route = fakeRoute();
    const panel = mount({ getTrackStore: async () => store, route });
    await panel.refresh();

    panel.dispose();
    expect(route.clear).toHaveBeenCalled();

    const before = rows().length;
    await panel.refresh();
    expect(rows()).toHaveLength(before);
  });
});

describe("the standing save-tracks preference lives here", () => {
  beforeEach(() => {
    localStorage.removeItem("scooter-fyi-save-tracks");
  });

  it("renders above the ride list, since it governs it", () => {
    mount({ getTrackStore: async () => fakeStore([]) });
    const row = host.querySelector(".track-pref");
    expect(row).toBeTruthy();
    const list = host.querySelector(".track-list")!;
    // DOCUMENT_POSITION_FOLLOWING: the list comes after the preference.
    expect(row!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it("reflects the stored answer rather than always starting checked", () => {
    localStorage.setItem("scooter-fyi-save-tracks", "0");
    mount({ getTrackStore: async () => fakeStore([]) });
    expect(host.querySelector<HTMLInputElement>(".track-pref__box")!.checked).toBe(false);
  });

  it("writes the rider's choice and says what it did", () => {
    mount({ getTrackStore: async () => fakeStore([]) });
    const box = host.querySelector<HTMLInputElement>(".track-pref__box")!;
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("scooter-fyi-save-tracks")).toBe("0");
    // And is explicit that turning it off is not retroactive — the rides
    // already on the device are still there, one row below.
    expect(host.querySelector(".account-magic-status")?.textContent)
      .toMatch(/no longer be saved.*kept/i);
  });
});
