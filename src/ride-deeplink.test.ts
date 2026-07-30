// @vitest-environment happy-dom
//
// `?ride=` deep-link plumbing. The load-bearing behaviours, all from the
// frontend plan's F1 scope: parse the two param forms, strip via
// `history.replaceState` and NEVER reload, let `?ml=` go first when both params
// are present, and fall through to Screen 2's manual-plate path (prefilled)
// when a `plate:` link can't be reverse-resolved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAGIC_LINK_PARAM,
  RIDE_PARAM,
  consumeRideDeepLink,
  hasPendingMagicLink,
  normalizePlate,
  parseRideParam,
  readRideDeepLink,
  resetRideDeepLinkPlates,
  reversePlateLookup,
  stripRideParam,
  wireRideDeepLink,
} from "./ride-deeplink.ts";
import type { RideModalEntry } from "./ride-modal.ts";

const HEX = "a1b2c3d4e5f60718";

function setUrl(search: string, hash = ""): void {
  history.replaceState(null, "", `/${search}${hash}`);
}

/** Let the module's promise chain settle (it awaits `primePlates`). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let opened: RideModalEntry[];

beforeEach(() => {
  opened = [];
  setUrl("");
  // The built-in plate index is a lazy module singleton with a TTL and a
  // failure cooldown — reset it so one case's stubbed feed can't silence the
  // next case's prime().
  resetRideDeepLinkPlates();
  // No test may touch the real GBFS feed: the default plate path fetches it,
  // and `unstubGlobals` puts the real one back after each case.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

afterEach(() => {
  setUrl("");
  vi.useRealTimers();
});

const capture = (entry: RideModalEntry): void => {
  opened.push(entry);
};

describe("parseRideParam", () => {
  it("accepts a 16-hex vehicle identifier and lowercases it", () => {
    expect(parseRideParam(HEX)).toEqual({
      kind: "vehicle",
      vehicleIdentifier: HEX,
    });
    expect(parseRideParam(HEX.toUpperCase())).toEqual({
      kind: "vehicle",
      vehicleIdentifier: HEX,
    });
    expect(parseRideParam(` ${HEX} `)).toEqual({
      kind: "vehicle",
      vehicleIdentifier: HEX,
    });
  });

  it("rejects anything that is not 16 hex chars", () => {
    expect(parseRideParam(HEX.slice(0, 15))).toBeNull();
    expect(parseRideParam(`${HEX}0`)).toBeNull();
    expect(parseRideParam("z1b2c3d4e5f60718")).toBeNull();
    expect(parseRideParam("")).toBeNull();
    expect(parseRideParam("   ")).toBeNull();
    expect(parseRideParam(null)).toBeNull();
    expect(parseRideParam(undefined)).toBeNull();
  });

  it("accepts the plate: variant case-insensitively and normalizes the plate", () => {
    expect(parseRideParam("plate:1025543")).toEqual({
      kind: "plate",
      plate: "1025543",
    });
    expect(parseRideParam("PLATE:10-255 43")).toEqual({
      kind: "plate",
      plate: "1025543",
    });
    expect(parseRideParam("plate:")).toBeNull();
    expect(parseRideParam("plate:   ")).toBeNull();
  });

  it("normalizePlate is the shared comparison form", () => {
    expect(normalizePlate(" 10-25 543 ")).toBe("1025543");
    expect(normalizePlate("ab12")).toBe("AB12");
    expect(normalizePlate("")).toBe("");
  });
});

describe("read / strip / consume", () => {
  it("reads the param without touching the URL", () => {
    setUrl(`?${RIDE_PARAM}=${HEX}&foo=1`, "#deck");
    const before = location.href;
    expect(readRideDeepLink()).toEqual({
      kind: "vehicle",
      vehicleIdentifier: HEX,
    });
    expect(location.href).toBe(before);
  });

  it("strips only the ride param, keeping other params and the hash", () => {
    setUrl(`?foo=1&${RIDE_PARAM}=${HEX}&bar=2`, "#deck");
    stripRideParam();
    expect(location.search).toBe("?foo=1&bar=2");
    expect(location.hash).toBe("#deck");
  });

  it("does not touch history when there is no ride param", () => {
    setUrl("?foo=1");
    const spy = vi.spyOn(history, "replaceState");
    stripRideParam();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("consume reads and strips in one step, and never reloads", () => {
    setUrl(`?${RIDE_PARAM}=plate:1025543`);
    const reload = vi.spyOn(location, "reload").mockImplementation(() => {});
    expect(consumeRideDeepLink()).toEqual({ kind: "plate", plate: "1025543" });
    expect(location.search).toBe("");
    expect(readRideDeepLink()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    reload.mockRestore();
  });
});

describe("wireRideDeepLink — vehicle form", () => {
  it("opens the modal with the identifier and strips the param, without reloading", () => {
    setUrl(`?${RIDE_PARAM}=${HEX}`);
    const reload = vi.spyOn(location, "reload").mockImplementation(() => {});
    wireRideDeepLink({ openRideModal: capture });
    expect(opened).toEqual([{ vehicleIdentifier: HEX }]);
    expect(location.search).toBe("");
    expect(reload).not.toHaveBeenCalled();
    reload.mockRestore();
  });

  it("is inert with no param, and leaves the URL alone", () => {
    setUrl("?foo=1");
    const spy = vi.spyOn(history, "replaceState");
    wireRideDeepLink({ openRideModal: capture });
    expect(opened).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores a malformed value (no open, no strip loop)", () => {
    setUrl(`?${RIDE_PARAM}=nope`);
    wireRideDeepLink({ openRideModal: capture });
    expect(opened).toEqual([]);
    // Left in place: nothing consumed it, so nothing pretended to.
    expect(location.search).toBe(`?${RIDE_PARAM}=nope`);
  });
});

describe("wireRideDeepLink — ?ml= goes first", () => {
  it("stands down while the magic link is redeeming, keeping ?ride= for the reload", async () => {
    setUrl(`?${MAGIC_LINK_PARAM}=tok&${RIDE_PARAM}=${HEX}`);
    wireRideDeepLink({
      openRideModal: capture,
      magicLinkSettled: Promise.resolve(true),
    });
    await flush();
    expect(opened).toEqual([]);
    // Untouched — the reload re-enters authed with the deep link intact.
    expect(hasPendingMagicLink()).toBe(true);
    expect(readRideDeepLink()).toEqual({
      kind: "vehicle",
      vehicleIdentifier: HEX,
    });
  });

  it("handles ?ride= itself once redemption fails (no reload is coming)", async () => {
    setUrl(`?${MAGIC_LINK_PARAM}=tok&${RIDE_PARAM}=${HEX}`);
    wireRideDeepLink({
      openRideModal: capture,
      magicLinkSettled: Promise.resolve(false),
    });
    await flush();
    expect(opened).toEqual([{ vehicleIdentifier: HEX }]);
    expect(readRideDeepLink()).toBeNull();
  });

  it("treats a rejected redemption as 'no reload coming'", async () => {
    setUrl(`?${MAGIC_LINK_PARAM}=tok&${RIDE_PARAM}=${HEX}`);
    wireRideDeepLink({
      openRideModal: capture,
      magicLinkSettled: Promise.reject(new Error("network")),
    });
    await flush();
    expect(opened).toEqual([{ vehicleIdentifier: HEX }]);
  });

  it("falls back to watching for the param when no promise is handed in", async () => {
    vi.useFakeTimers();
    setUrl(`?${MAGIC_LINK_PARAM}=tok&${RIDE_PARAM}=${HEX}`);
    wireRideDeepLink({ openRideModal: capture });
    await vi.advanceTimersByTimeAsync(300);
    expect(opened).toEqual([]);

    // auth-magic-link.ts strips ?ml= in a `finally`, success or failure.
    setUrl(`?${RIDE_PARAM}=${HEX}`);
    await vi.advanceTimersByTimeAsync(300);
    expect(opened).toEqual([{ vehicleIdentifier: HEX }]);
    expect(readRideDeepLink()).toBeNull();
  });
});

describe("wireRideDeepLink — plate variant", () => {
  it("primes the index before the reverse lookup and preselects on a hit", async () => {
    setUrl(`?${RIDE_PARAM}=plate:1025543`);
    const order: string[] = [];
    wireRideDeepLink({
      openRideModal: capture,
      primePlates: async () => {
        order.push("prime");
        await Promise.resolve();
      },
      resolvePlate: (plate) => {
        order.push(`resolve:${plate}`);
        return HEX;
      },
    });
    await flush();
    expect(order).toEqual(["prime", "resolve:1025543"]);
    expect(opened).toEqual([{ vehicleIdentifier: HEX, plate: "1025543" }]);
    expect(readRideDeepLink()).toBeNull();
  });

  it("falls through to the manual-plate path (prefilled) on a miss", async () => {
    setUrl(`?${RIDE_PARAM}=plate:1025543`);
    wireRideDeepLink({
      openRideModal: capture,
      primePlates: () => Promise.resolve(),
      resolvePlate: () => null,
    });
    await flush();
    expect(opened).toEqual([{ plate: "1025543" }]);
  });

  it("still opens when no device list is available to resolve against", async () => {
    // The built-in path would prime its own index; no fetch should be needed
    // because there is nothing to resolve against.
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetchSpy);
    setUrl(`?${RIDE_PARAM}=plate:1025543`);
    wireRideDeepLink({ openRideModal: capture });
    await flush();
    expect(opened).toEqual([{ plate: "1025543" }]);
  });

  it("resolves through its own primed GbfsPlates index by default", async () => {
    // The public feed's shape: the plate lives in the rental_uris `&number=`.
    const body = {
      data: {
        bikes: [
          {
            bike_id: "dead00000000beef",
            rental_uris: { android: "https://veo/x?adj_t=1&number=1025543" },
          },
          {
            bike_id: HEX,
            rental_uris: { android: "https://veo/x?adj_t=1&number=1099001" },
          },
        ],
      },
    };
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);
    setUrl(`?${RIDE_PARAM}=plate:1099001`);
    wireRideDeepLink({
      openRideModal: capture,
      deviceIds: () => ["dead00000000beef", HEX],
    });
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([{ vehicleIdentifier: HEX, plate: "1099001" }]);
  });

  it("falls through when the feed is down (empty index), never a dead end", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("CORS")));
    vi.stubGlobal("fetch", fetchSpy);
    setUrl(`?${RIDE_PARAM}=plate:1099001`);
    wireRideDeepLink({
      openRideModal: capture,
      deviceIds: () => [HEX],
    });
    await flush();
    expect(opened).toEqual([{ plate: "1099001" }]);
  });

  it("an explicit resolvePlate is authoritative — a null is a miss, not a fallback", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              bikes: [
                {
                  bike_id: HEX,
                  rental_uris: { android: "https://veo/x?number=1099001" },
                },
              ],
            },
          }),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);
    setUrl(`?${RIDE_PARAM}=plate:1099001`);
    wireRideDeepLink({
      openRideModal: capture,
      deviceIds: () => [HEX],
      primePlates: () => Promise.resolve(),
      resolvePlate: () => null,
    });
    await flush();
    expect(opened).toEqual([{ plate: "1099001" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never dead-ends when prime() rejects", async () => {
    setUrl(`?${RIDE_PARAM}=plate:1025543`);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    wireRideDeepLink({
      openRideModal: capture,
      primePlates: () => Promise.reject(new Error("feed down")),
      resolvePlate: () => null,
    });
    await flush();
    expect(opened).toEqual([{ plate: "1025543" }]);
    err.mockRestore();
  });

  it("never dead-ends when the lookup throws", async () => {
    setUrl(`?${RIDE_PARAM}=plate:1025543`);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    wireRideDeepLink({
      openRideModal: capture,
      resolvePlate: () => {
        throw new Error("boom");
      },
    });
    await flush();
    expect(opened).toEqual([{ plate: "1025543" }]);
    err.mockRestore();
  });
});

describe("reversePlateLookup", () => {
  const index: Record<string, string> = {
    dead00000000beef: "1025543",
    feed00000000face: "1099001",
  };
  const plateFor = (id: string): string | null => index[id] ?? null;

  it("matches exactly, tolerating case and separators in the query", () => {
    expect(reversePlateLookup("1025543", Object.keys(index), plateFor)).toBe(
      "dead00000000beef",
    );
    expect(reversePlateLookup(" 10-25 543 ", Object.keys(index), plateFor)).toBe(
      "dead00000000beef",
    );
  });

  it("returns null on a miss, an empty query, or an empty index", () => {
    expect(reversePlateLookup("7777777", Object.keys(index), plateFor)).toBeNull();
    expect(reversePlateLookup("", Object.keys(index), plateFor)).toBeNull();
    expect(reversePlateLookup("1025543", [], plateFor)).toBeNull();
  });

  it("skips devices whose plate lookup throws instead of aborting the scan", () => {
    const ids = ["boom", "dead00000000beef"];
    const thrower = (id: string): string | null => {
      if (id === "boom") throw new Error("nope");
      return plateFor(id);
    };
    expect(reversePlateLookup("1025543", ids, thrower)).toBe("dead00000000beef");
  });
});
