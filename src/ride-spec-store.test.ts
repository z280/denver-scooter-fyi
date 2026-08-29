// @vitest-environment happy-dom
//
// Where a rider's specs live, and the attachment that decides whether the
// map is still showing one. localStorage is the reason for the DOM
// environment; nothing here touches an element.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LOCAL_SPEC_KEY,
  LOCAL_SPEC_NAME,
  SpecAttachment,
  clearLocalSpec,
  deleteSpec,
  listSpecs,
  loadLocalSpec,
  sameFilters,
  saveLocalSpec,
  saveSpec,
  type SpecStoreDeps,
} from "./ride-spec-store.ts";
import { defaultSpec, toFilterSnapshot, writeSpec, type RideSpec } from "./ride-spec.ts";
import type { FilterSnapshot } from "./filter-presets.ts";

const LIVE: FilterSnapshot = {
  rideTypes: ["sitting", "standing"],
  models: ["astro", "cosmo", "apollo", "trike"],
  knownModels: ["astro", "cosmo", "apollo", "trike"],
  features: [],
  hideUnavailable: false,
  minBattery: 0,
  quality: "any",
  area: null,
};

function spec(over: Partial<RideSpec> = {}): RideSpec {
  return { ...defaultSpec(), ...over };
}

const COMMUTER = spec({ models: ["cosmo"], features: ["basket"], minBattery: 40 });

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Local storage
// ---------------------------------------------------------------------------
describe("the local spec", () => {
  it("round-trips through storage", () => {
    expect(saveLocalSpec(COMMUTER)).toBe(true);
    expect(loadLocalSpec()).toEqual(COMMUTER);
  });

  it("is stored in the wire shape, not the local one", () => {
    // So a blob written by the anonymous path and one written by the account
    // mirror are the same bytes — otherwise signing in would silently change
    // a rider's spec.
    saveLocalSpec(COMMUTER);
    expect(JSON.parse(localStorage.getItem(LOCAL_SPEC_KEY)!)).toEqual(
      writeSpec(COMMUTER),
    );
  });

  it("reads nothing rather than throwing on a corrupt blob", () => {
    localStorage.setItem(LOCAL_SPEC_KEY, "{not json");
    expect(loadLocalSpec()).toBeNull();
  });

  it("survives storage being unavailable", () => {
    // Spied on the instance, not on Storage.prototype: happy-dom's
    // localStorage does not inherit from it, so a prototype spy silently
    // fails to intercept and the assertion passes for the wrong reason.
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    expect(saveLocalSpec(COMMUTER)).toBe(false);
    spy.mockRestore();
  });

  it("clears", () => {
    saveLocalSpec(COMMUTER);
    clearLocalSpec();
    expect(loadLocalSpec()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Account vs device
// ---------------------------------------------------------------------------
describe("listSpecs", () => {
  it("reads the account when signed in", async () => {
    const deps: SpecStoreDeps = {
      signedIn: () => true,
      list: async () => [
        {
          name: "Commuter",
          settings: writeSpec(COMMUTER),
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
        },
      ],
    };
    const got = await listSpecs(deps);
    expect(got).toEqual([
      { name: "Commuter", spec: COMMUTER, updatedAt: "2026-08-02T00:00:00Z" },
    ]);
  });

  it("drops a row whose blob will not read, rather than showing an empty spec", async () => {
    // An empty spec matches everything. Showing a rider "no requirements"
    // under a name they chose is worse than showing one row fewer.
    const deps: SpecStoreDeps = {
      signedIn: () => true,
      list: async () => [
        { name: "Broken", settings: null as never, created_at: "", updated_at: "" },
        {
          name: "Fine",
          settings: writeSpec(COMMUTER),
          created_at: "",
          updated_at: "",
        },
      ],
    };
    expect((await listSpecs(deps)).map((s) => s.name)).toEqual(["Fine"]);
  });

  it("falls back to the device copy when the request fails", async () => {
    saveLocalSpec(COMMUTER);
    const deps: SpecStoreDeps = {
      signedIn: () => true,
      list: async () => {
        throw new Error("offline");
      },
    };
    expect(await listSpecs(deps)).toEqual([
      { name: LOCAL_SPEC_NAME, spec: COMMUTER },
    ]);
  });

  it("never calls the API when signed out", async () => {
    const list = vi.fn();
    await listSpecs({ signedIn: () => false, list: list as never });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("saveSpec", () => {
  it("mirrors an account save onto the device", async () => {
    // The mirror is what a cold start reads before any request lands, and
    // what a rider keeps if they sign out or go offline.
    const put = vi.fn(async () => ({
      name: "Commuter",
      settings: {},
      created_at: "",
      updated_at: "",
    }));
    const where = await saveSpec(
      { signedIn: () => true, put: put as never },
      "Commuter",
      COMMUTER,
    );
    expect(where).toEqual({ where: "account" });
    expect(loadLocalSpec()).toEqual(COMMUTER);
  });

  it("falls back to the device when the account save fails", async () => {
    const where = await saveSpec(
      {
        signedIn: () => true,
        put: (async () => {
          throw new Error("409");
        }) as never,
      },
      "Commuter",
      COMMUTER,
    );
    expect(where).toEqual({ where: "device" });
    expect(loadLocalSpec()).toEqual(COMMUTER);
  });

  it("reports nowhere when both refuse", async () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    const where = await saveSpec({ signedIn: () => false }, "x", COMMUTER);
    expect(where).toEqual({ where: "nowhere" });
    spy.mockRestore();
  });
});

describe("deleteSpec", () => {
  it("clears the device copy when signed out", async () => {
    saveLocalSpec(COMMUTER);
    await deleteSpec({ signedIn: () => false }, LOCAL_SPEC_NAME);
    expect(loadLocalSpec()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sameFilters
// ---------------------------------------------------------------------------
describe("sameFilters", () => {
  it("ignores list order", () => {
    expect(
      sameFilters(LIVE, { ...LIVE, models: ["trike", "apollo", "cosmo", "astro"] }),
    ).toBe(true);
  });

  it("ignores knownModels", () => {
    // Provenance, not filter state. Comparing it would detach a spec the
    // moment a preset from an older lineup was loaded alongside.
    expect(sameFilters(LIVE, { ...LIVE, knownModels: ["astro"] })).toBe(true);
  });

  it("notices every field the map actually filters on", () => {
    const differences: Partial<FilterSnapshot>[] = [
      { rideTypes: ["sitting"] },
      { models: ["astro"] },
      { features: ["basket"] },
      { hideUnavailable: true },
      { minBattery: 20 },
      { quality: "ok-only" },
      { area: { layer: "neighborhood", subset: ["Baker"] } },
    ];
    for (const d of differences) {
      expect(sameFilters(LIVE, { ...LIVE, ...d }), JSON.stringify(d)).toBe(false);
    }
  });

  it("notices a change of subset within the same layer", () => {
    const a: FilterSnapshot = {
      ...LIVE,
      area: { layer: "neighborhood", subset: ["Baker"] },
    };
    const b: FilterSnapshot = {
      ...LIVE,
      area: { layer: "neighborhood", subset: ["Baker", "Highland"] },
    };
    expect(sameFilters(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attachment — the part the presets have no equivalent of
// ---------------------------------------------------------------------------
describe("SpecAttachment", () => {
  it("starts detached", () => {
    expect(new SpecAttachment().get()).toBeNull();
    expect(new SpecAttachment().attachedName).toBeNull();
  });

  it("projects the spec and remembers the name", () => {
    const a = new SpecAttachment();
    const projected = a.attach("Commuter", COMMUTER, LIVE);
    expect(projected).toEqual(toFilterSnapshot(COMMUTER, LIVE));
    expect(a.attachedName).toBe("Commuter");
  });

  it("stays attached when the map matches the projection", () => {
    const a = new SpecAttachment();
    const projected = a.attach("Commuter", COMMUTER, LIVE);
    expect(a.noticeFilterChange(projected)).toBe(false);
    expect(a.attachedName).toBe("Commuter");
  });

  it("stays attached when only the list order changed", () => {
    const a = new SpecAttachment();
    const projected = a.attach("Commuter", COMMUTER, LIVE);
    const reordered = { ...projected, models: [...projected.models].reverse() };
    expect(a.noticeFilterChange(reordered)).toBe(false);
  });

  it("detaches on the first rider edit, and says so once", () => {
    const a = new SpecAttachment();
    const projected = a.attach("Commuter", COMMUTER, LIVE);
    const edited = { ...projected, minBattery: 90 };
    expect(a.noticeFilterChange(edited)).toBe(true);
    expect(a.attachedName).toBeNull();
    // ...and does not keep announcing it on every later change.
    expect(a.noticeFilterChange({ ...edited, quality: "ok-only" })).toBe(false);
  });

  it("restores what the rider had before the toggle went on", () => {
    // Not a default, and not the projection: turning it off should leave the
    // map where it was, or the toggle is a one-way door.
    const a = new SpecAttachment();
    a.attach("Commuter", COMMUTER, LIVE);
    expect(a.detachAndRestore()).toEqual(LIVE);
    expect(a.attachedName).toBeNull();
  });

  it("restores nothing when nothing was attached", () => {
    expect(new SpecAttachment().detachAndRestore()).toBeNull();
  });

  it("reattaching after an edit projects onto the EDITED map, not the old one", () => {
    // "Back to Commuter" has to mean today's map with the spec applied. The
    // pre-toggle restore point is whatever the rider had a moment ago, which
    // after an edit is the edited state.
    const a = new SpecAttachment();
    const projected = a.attach("Commuter", COMMUTER, LIVE);
    const edited: FilterSnapshot = { ...projected, minBattery: 90 };
    a.noticeFilterChange(edited);
    const again = a.reattach("Commuter", COMMUTER, edited);
    expect(again).toEqual(toFilterSnapshot(COMMUTER, edited));
    expect(a.detachAndRestore()).toEqual(edited);
  });
});
