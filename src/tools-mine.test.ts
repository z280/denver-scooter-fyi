// @vitest-environment happy-dom
//
// The top of the Tools drawer: every dib and every watch, one row per scooter,
// and the admin-only add-by-plate form. The watch POLICY is pinned in
// device-notify.test.ts; this pins what the rider sees and presses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, NoDataError } from "./api.ts";
import { WATCH_RULES, type WatchedDevice } from "./device-notify.ts";
import type { Dibs } from "./dibs.ts";
import {
  DIBS_ICON,
  WATCH_ICON,
  buildRows,
  formatWatchLeft,
  lookupPlate,
  wireToolsMine,
  type PlateLookup,
  type ToolsMineDeps,
  type ToolsMineHandle,
} from "./tools-mine.ts";

const T0 = 1_800_000_000_000;
const VID_A = "aaaa1111bbbb2222";
const VID_B = "cccc3333dddd4444";
const VID_C = "eeee5555ffff6666";

function claim(over: Partial<Dibs> = {}): Dibs {
  return {
    vehicleIdentifier: VID_A,
    vehicleName: "Lunar 🐸 928",
    plate: "1234928",
    claimedBy: "Resourceful 🌈",
    claimedAt: T0,
    startedWalkingAt: null,
    registration: { id: "reg-1", verifyUrl: "https://v", qrUrl: "https://q" },
    lat: 39.7392,
    lon: -104.9903,
    startMeters: 300,
    bestMeters: 300,
    ...over,
  };
}

function watch(over: Partial<WatchedDevice> = {}): WatchedDevice {
  return {
    vehicleIdentifier: VID_C,
    name: "Cosmo 🦊 417",
    lat: 39.74,
    lon: -104.99,
    since: T0,
    origin: "ride_end",
    expiresAt: T0 + 2 * 60 * 60_000,
    ...over,
  };
}

let section: HTMLElement;
let list: HTMLElement;
let status: HTMLElement;
let adminHost: HTMLElement;
let handle: ToolsMineHandle | null = null;

function mount(
  state: { dibs: Dibs[]; watches: WatchedDevice[] },
  over: Partial<ToolsMineDeps> = {},
) {
  const deps = {
    onOpenCertificate: vi.fn(),
    onShowOnMap: vi.fn(),
    onDibsChanged: vi.fn(),
    onWatchStopped: vi.fn(),
    onWatchAdded: vi.fn(),
    releaseDibs: vi.fn((vid: string) => {
      state.dibs = state.dibs.filter((d) => d.vehicleIdentifier !== vid);
    }),
    stopWatch: vi.fn((vid: string) => {
      state.watches = state.watches.filter((w) => w.vehicleIdentifier !== vid);
    }),
    addWatch: vi.fn((w: WatchedDevice) => {
      state.watches = [w, ...state.watches.filter((x) => x.vehicleIdentifier !== w.vehicleIdentifier)];
    }),
    findVehicle: vi.fn(() => ({ name: "Nova 🐢 555", lat: 39.75, lon: -104.98 })),
    lookup: vi.fn(async (): Promise<PlateLookup> => ({ kind: "hit", vehicleIdentifier: VID_B })),
    ...over,
  };
  handle = wireToolsMine({
    section,
    list,
    status,
    adminHost,
    locate: { current: () => null },
    now: () => T0 + 60_000,
    readDibs: () => state.dibs,
    readWatches: () => state.watches,
    ...deps,
  });
  return { handle, deps, state };
}

const rows = () => [...list.querySelectorAll<HTMLElement>(".tools-mine__row")];

beforeEach(() => {
  document.body.replaceChildren();
  section = document.createElement("section");
  list = document.createElement("ul");
  status = document.createElement("p");
  adminHost = document.createElement("div");
  adminHost.hidden = true;
  section.append(list, status, adminHost);
  document.body.append(section);
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.replaceChildren();
});

describe("the merge", () => {
  it("puts a claim's own watch on the claim's row, not a second one", () => {
    const r = buildRows([claim()], [watch({ vehicleIdentifier: VID_A, origin: "dibs" })]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "dibs" });
  });

  it("lists dibs first, then loose watches soonest-expiring first", () => {
    const r = buildRows(
      [claim(), claim({ vehicleIdentifier: VID_B, vehicleName: "Two" })],
      [watch({ expiresAt: T0 + 9e6 }), watch({ vehicleIdentifier: "9".repeat(16), expiresAt: T0 + 1e6 })],
    );
    expect(r.map((x) => x.kind)).toEqual(["dibs", "dibs", "watch", "watch"]);
    expect(r[2].kind === "watch" && r[2].watch.vehicleIdentifier).toBe("9".repeat(16));
  });
});

describe("the list", () => {
  it("has one short line when there is nothing", () => {
    mount({ dibs: [], watches: [] });
    expect(section.hidden).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(list.textContent).toBe("No dibs or watches right now.");
    expect(status.hidden).toBe(true);
  });

  it("shows 2 dibs and 1 watch, each with its own icon, name, time and status", () => {
    mount({
      dibs: [claim(), claim({ vehicleIdentifier: VID_B, vehicleName: "Nova 🐢 555", startedWalkingAt: T0 + 30_000 })],
      watches: [watch(), watch({ vehicleIdentifier: VID_A, origin: "dibs" })],
    });
    const r = rows();
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.querySelector(".tools-mine__icon")?.textContent)).toEqual([
      DIBS_ICON,
      DIBS_ICON,
      WATCH_ICON,
    ]);
    expect(DIBS_ICON).toBe("✋");
    expect(r[0].textContent).toContain("Lunar 🐸 928");
    expect(r[0].textContent).toContain("9:00 to set off");
    expect(r[0].textContent).toContain("Not set off yet · watching for moves");
    expect(r[1].textContent).toContain("left");
    expect(r[1].textContent).toContain("On your way");
    expect(r[2].textContent).toContain("Cosmo 🦊 417");
    expect(r[2].textContent).toContain("1 h 59 min left");
    expect(r[2].textContent).toContain("Your last ride");
  });

  it("opens the certificate when a dib is tapped", () => {
    const { deps } = mount({ dibs: [claim()], watches: [] });
    rows()[0].querySelector<HTMLButtonElement>(".tools-mine__open")!.click();
    expect(deps.onOpenCertificate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.onOpenCertificate).mock.calls[0][0].vehicleIdentifier).toBe(VID_A);
    expect(deps.onShowOnMap).not.toHaveBeenCalled();
  });

  it("centres the map when a watch is tapped", () => {
    const { deps } = mount({ dibs: [], watches: [watch()] });
    rows()[0].querySelector<HTMLButtonElement>(".tools-mine__open")!.click();
    expect(deps.onShowOnMap).toHaveBeenCalledTimes(1);
    expect(deps.onOpenCertificate).not.toHaveBeenCalled();
  });

  it("releasing a dib also stops the watch that came with it", () => {
    const { deps, state } = mount({
      dibs: [claim()],
      watches: [watch({ vehicleIdentifier: VID_A, origin: "dibs" })],
    });
    rows()[0].querySelector<HTMLButtonElement>(".tools-mine__act")!.click();
    expect(deps.releaseDibs).toHaveBeenCalledWith(VID_A, T0 + 60_000);
    expect(deps.stopWatch).toHaveBeenCalledWith(VID_A);
    expect(deps.onDibsChanged).toHaveBeenCalledTimes(1);
    expect(state.watches).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("releasing a dib leaves a ride or admin watch on that scooter alone", () => {
    const { deps } = mount({
      dibs: [claim()],
      watches: [watch({ vehicleIdentifier: VID_A, origin: "ride_end" })],
    });
    rows()[0].querySelector<HTMLButtonElement>(".tools-mine__act")!.click();
    expect(deps.stopWatch).not.toHaveBeenCalled();
    // The watch now stands on its own row.
    expect(rows()[0].dataset.kind).toBe("watch");
  });

  it("stops a watch from its row", () => {
    const { deps } = mount({ dibs: [], watches: [watch()] });
    const stop = rows()[0].querySelector<HTMLButtonElement>(".tools-mine__act")!;
    expect(stop.getAttribute("aria-label")).toBe("Stop watching Cosmo 🦊 417");
    stop.click();
    expect(deps.stopWatch).toHaveBeenCalledWith(VID_C);
    expect(deps.onWatchStopped).toHaveBeenCalledWith(VID_C);
    expect(list.textContent).toBe("No dibs or watches right now.");
  });

  it("ticks the clock in place without rebuilding rows (keeps focus)", () => {
    vi.useFakeTimers();
    let t = T0 + 60_000;
    const state = { dibs: [claim()], watches: [] as WatchedDevice[] };
    handle = wireToolsMine({
      section, list, status, adminHost,
      locate: { current: () => null },
      now: () => t,
      readDibs: () => state.dibs,
      readWatches: () => state.watches,
      onOpenCertificate: () => {},
      onShowOnMap: () => {},
      findVehicle: () => null,
    });
    const before = rows()[0];
    t += 5_000;
    vi.advanceTimersByTime(1_000);
    expect(rows()[0]).toBe(before);
    expect(before.textContent).toContain("8:55 to set off");
    vi.useRealTimers();
  });
});

describe("formatWatchLeft", () => {
  it("reads in hours and minutes", () => {
    expect(formatWatchLeft(24 * 60 * 60_000)).toBe("24 h");
    expect(formatWatchLeft(112 * 60_000)).toBe("1 h 52 min");
    expect(formatWatchLeft(38 * 60_000 + 5_000)).toBe("38 min");
    expect(formatWatchLeft(20_000)).toBe("under a minute");
  });
});

describe("admin: add a scooter to watches by plate", () => {
  const form = () => adminHost.querySelector<HTMLFormElement>("#tools-admin-watch");
  const input = () => adminHost.querySelector<HTMLInputElement>("#tools-admin-watch-plate")!;
  const statusText = () => adminHost.querySelector(".tools-mine__admin-status")?.textContent ?? "";
  const submit = async (plate: string) => {
    input().value = plate;
    form()!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(statusText()).not.toMatch(/^Looking up/));
  };

  it("is not rendered for a non-admin", () => {
    mount({ dibs: [], watches: [] });
    expect(form()).toBeNull();
    expect(document.querySelector("#tools-admin-watch-plate")).toBeNull();
    expect(adminHost.hidden).toBe(true);
    expect(adminHost.childElementCount).toBe(0);
  });

  it("marks the plate field undo-free, so typing never arms iOS shake-to-undo", () => {
    const { handle: h } = mount({ dibs: [], watches: [] });
    h.setAdmin(true);
    // ios-shake-undo.ts: a field without this leaves WebKit's undo queue
    // non-empty, and iOS then offers "Undo Typing" on every bump of a ride.
    expect(input().getAttribute("data-undo-free")).toBe("on");
  });

  it("is built for an admin, and torn down again when that ends", () => {
    const { handle: h } = mount({ dibs: [], watches: [] });
    h.setAdmin(true);
    expect(form()).not.toBeNull();
    expect(adminHost.hidden).toBe(false);
    expect(adminHost.textContent).toContain("Plate number");
    h.setAdmin(false);
    expect(form()).toBeNull();
    expect(adminHost.hidden).toBe(true);
  });

  it("resolves the plate and adds an admin watch for 24 h", async () => {
    const { handle: h, deps, state } = mount({ dibs: [], watches: [] });
    h.setAdmin(true);
    await submit(" ab-12 3 ");
    expect(deps.lookup).toHaveBeenCalledWith("AB123");
    expect(deps.findVehicle).toHaveBeenCalledWith(VID_B, "AB123");
    expect(deps.addWatch).toHaveBeenCalledTimes(1);
    const added = vi.mocked(deps.addWatch!).mock.calls[0][0] as WatchedDevice;
    expect(added).toMatchObject({
      vehicleIdentifier: VID_B,
      name: "Nova 🐢 555",
      origin: "admin",
      since: T0 + 60_000,
      expiresAt: T0 + 60_000 + WATCH_RULES.admin.ttlMs,
    });
    expect(deps.onWatchAdded).toHaveBeenCalledWith(VID_B);
    expect(statusText()).toBe("Watching Nova 🐢 555 for 24 h — it's in Tools.");
    expect(input().value).toBe("");
    // ...and it is in the list, with the bell and its reason.
    expect(state.watches).toHaveLength(1);
    expect(rows()[0].querySelector(".tools-mine__icon")?.textContent).toBe(WATCH_ICON);
    expect(rows()[0].textContent).toContain("Admin watch");
  });

  it("says so plainly on a 404 (no such plate, or more than one)", async () => {
    const { handle: h, deps } = mount({ dibs: [], watches: [] }, {
      lookup: vi.fn(async (): Promise<PlateLookup> => ({ kind: "not_found" })),
    });
    h.setAdmin(true);
    await submit("ZZZ999");
    expect(statusText()).toContain("No scooter on the map has plate ZZZ999, or more than one does");
    expect(adminHost.querySelector(".tools-mine__admin-status")?.classList.contains("is-error")).toBe(true);
    expect(deps.addWatch).not.toHaveBeenCalled();
  });

  it("asks for a plate rather than looking up nothing", async () => {
    const { handle: h, deps } = mount({ dibs: [], watches: [] });
    h.setAdmin(true);
    input().value = "   ";
    form()!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(statusText()).toBe("Type a plate number."));
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  it("explains a rate limit and a scooter missing from this map", async () => {
    const m = mount({ dibs: [], watches: [] }, {
      lookup: vi.fn(async (): Promise<PlateLookup> => ({ kind: "rate_limited", retryAfter: 42 })),
    });
    m.handle.setAdmin(true);
    await submit("AB123");
    expect(statusText()).toBe("Too many lookups — try again in 42 seconds.");
    m.handle.destroy();
    adminHost.hidden = true;

    const n = mount({ dibs: [], watches: [] }, { findVehicle: vi.fn(() => null) });
    n.handle.setAdmin(true);
    await submit("AB123");
    expect(statusText()).toContain("isn't on this map right now");
    expect(n.deps.addWatch).not.toHaveBeenCalled();
  });

  it("does not add a scooter that is already watched", async () => {
    const { handle: h, deps } = mount({ dibs: [], watches: [watch({ vehicleIdentifier: VID_B, name: "Nova 🐢 555" })] });
    h.setAdmin(true);
    await submit("AB123");
    expect(statusText()).toBe("Already watching Nova 🐢 555.");
    expect(deps.addWatch).not.toHaveBeenCalled();
  });

  it("says which watch it stopped when the admin list is full", async () => {
    const full = Array.from({ length: WATCH_RULES.admin.max }, (_, i) =>
      watch({
        vehicleIdentifier: (i + 1).toString(16).padStart(16, "0"),
        name: `Old ${i}`,
        origin: "admin",
        since: T0 - (100 - i),
        expiresAt: T0 + 1e7,
      }),
    );
    const { handle: h } = mount({ dibs: [], watches: full });
    h.setAdmin(true);
    await submit("AB123");
    expect(statusText()).toBe("Watching Nova 🐢 555 for 24 h — it's in Tools. Stopped Old 0 to stay at 10.");
  });
});

describe("lookupPlate", () => {
  it("passes a hit through, lower-cased", async () => {
    const r = await lookupPlate("AB123", async () => ({ device_id: "x", vehicle_identifier: "AAAA1111BBBB2222" }));
    expect(r).toEqual({ kind: "hit", vehicleIdentifier: VID_A });
  });

  it("maps 404 to not_found, 429 to rate_limited, 400 to invalid, else error", async () => {
    expect(await lookupPlate("X", async () => { throw new NoDataError("nope", 404); })).toEqual({ kind: "not_found" });
    expect(
      await lookupPlate("X", async () => {
        throw new ApiError("slow down", "HTTP_ERROR", { status: 429, retryAfter: 30 });
      }),
    ).toEqual({ kind: "rate_limited", retryAfter: 30 });
    expect(
      await lookupPlate("X", async () => {
        throw new ApiError("bad", "HTTP_ERROR", { status: 400 });
      }),
    ).toEqual({ kind: "invalid" });
    expect(await lookupPlate("X", async () => { throw new Error("offline"); })).toEqual({ kind: "error" });
  });

  it("treats a malformed identifier as not found", async () => {
    expect(await lookupPlate("X", async () => ({ vehicle_identifier: "nope" }))).toEqual({ kind: "not_found" });
  });
});

