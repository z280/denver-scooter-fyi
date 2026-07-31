// Tests for the ride-mode F1 auth-storage migration: the session blob moving
// from sessionStorage to localStorage under the SAME key with a one-time
// promote, the guarded silent refresh, and the 401 re-read guard that keeps a
// multi-tab rotation race from signing out a tab holding a valid token.
//
// Everything is offline. `fetch` and both web storages are stubbed per test —
// no test may depend on a deployed API, since the API side of this program is
// being built in parallel.
//
// Each test loads a FRESH module registry (`vi.resetModules()` + dynamic
// import) because two pieces of per-page-load state are exactly what is under
// test: auth-storage's "the promote already ran" flag, and auth-session's
// memoized single refresh per load.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredSession } from "./auth-storage.ts";

const KEY = "scooter_fyi.map_auth";
const DAY = 86_400_000;
const HOUR = 3_600_000;

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** "ok" behaves; "no-write" rejects setItem (private-mode quota of zero);
 *  "hostile" throws on every access (storage disabled entirely). */
type StorageMode = "ok" | "no-write" | "hostile";

interface Fake {
  /** The backing map, so a test can assert on what landed where. */
  store: Map<string, string>;
  api: Storage;
}

function fakeStorage(mode: StorageMode = "ok", initial?: string): Fake {
  const store = new Map<string, string>(initial ? [[KEY, initial]] : []);
  const guard = <T>(fn: () => T): T => {
    if (mode === "hostile") throw new Error("storage disabled");
    return fn();
  };
  const api: Storage = {
    get length(): number {
      return guard(() => store.size);
    },
    clear: () => guard(() => store.clear()),
    getItem: (k: string) => guard(() => store.get(k) ?? null),
    key: (i: number) => guard(() => [...store.keys()][i] ?? null),
    removeItem: (k: string) =>
      guard(() => {
        store.delete(k);
      }),
    setItem: (k: string, v: string) => {
      if (mode !== "ok") throw new Error("quota exceeded");
      store.set(k, v);
    },
  };
  return { store, api };
}

interface Storages {
  local: Fake;
  session: Fake;
}

/** Install both web storages. `absent` stubs the global as undefined, which is
 *  how a non-DOM/blocked environment presents. */
function installStorages(opts: {
  local?: StorageMode | "absent";
  localBlob?: string;
  session?: StorageMode | "absent";
  sessionBlob?: string;
}): Storages {
  const local = fakeStorage(
    opts.local === "absent" ? "ok" : (opts.local ?? "ok"),
    opts.localBlob,
  );
  const session = fakeStorage(
    opts.session === "absent" ? "ok" : (opts.session ?? "ok"),
    opts.sessionBlob,
  );
  vi.stubGlobal("localStorage", opts.local === "absent" ? undefined : local.api);
  vi.stubGlobal(
    "sessionStorage",
    opts.session === "absent" ? undefined : session.api,
  );
  return { local, session };
}

interface FetchCall {
  url: string;
  method: string;
  authorization: string | undefined;
}

/** Replace global fetch with a canned responder, recording every call. The
 *  responder may mutate storage first — that is how "another tab rotated the
 *  token while our request was in flight" is simulated. */
function stubFetch(respond: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.Authorization,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A stored blob as the doors/refresh would write it. */
function blob(
  token: string,
  extra: Partial<StoredSession> & Record<string, unknown> = {},
): string {
  return JSON.stringify({
    token,
    expires: iso(Date.now() + 30 * DAY),
    ...extra,
  });
}

function storedToken(fake: Fake): string | null {
  const raw = fake.store.get(KEY);
  return raw ? (JSON.parse(raw) as StoredSession).token : null;
}

function storedSession(fake: Fake): StoredSession | null {
  const raw = fake.store.get(KEY);
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

// ---------------------------------------------------------------------------
// Fresh module registry per test
// ---------------------------------------------------------------------------

interface Modules {
  storage: typeof import("./auth-storage.ts");
  session: typeof import("./auth-session.ts");
  mapAuth: typeof import("./map-auth.js");
  api: typeof import("./api.ts");
}

async function load(): Promise<Modules> {
  vi.resetModules();
  const [storage, session, mapAuth, api] = await Promise.all([
    import("./auth-storage.ts"),
    import("./auth-session.ts"),
    import("./map-auth.js"),
    import("./api.ts"),
  ]);
  return { storage, session, mapAuth, api };
}

beforeEach(() => {
  // No test may reach the network by accident: any unstubbed call is a failure.
  stubFetch(() => {
    throw new Error("unexpected fetch");
  });
});

// ---------------------------------------------------------------------------

describe("one-time promote sessionStorage → localStorage", () => {
  it("promotes a pre-migration blob on the first read and drops the legacy copy", async () => {
    const stores = installStorages({ sessionBlob: blob("legacy-token") });
    const { mapAuth } = await load();

    expect(mapAuth.getAuth()?.token).toBe("legacy-token");
    // The deploy must not sign anyone out: the same key, now in localStorage.
    expect(storedToken(stores.local)).toBe("legacy-token");
    expect(stores.session.store.has(KEY)).toBe(false);
  });

  it("does not stamp the promoted blob, so the silent refresh rotates it once", async () => {
    const stores = installStorages({ sessionBlob: blob("legacy-token") });
    const { storage } = await load();

    const promoted = storage.readStoredSession();
    expect(promoted).not.toBeNull();
    expect(promoted?.rotated_at).toBeUndefined();
    // Unknown age reads as stale — one rotation turns a tab-lifetime session
    // into a 30-day sliding one.
    expect(storage.isSessionStale(promoted as StoredSession)).toBe(true);
    expect(storedSession(stores.local)?.rotated_at).toBeUndefined();
  });

  it("keeps an existing live localStorage session and discards the legacy copy", async () => {
    const stores = installStorages({
      localBlob: blob("current-token"),
      sessionBlob: blob("legacy-token"),
    });
    const { mapAuth } = await load();

    expect(mapAuth.getAuth()?.token).toBe("current-token");
    expect(stores.session.store.has(KEY)).toBe(false);
  });

  it("never promotes an expired legacy blob", async () => {
    const stores = installStorages({
      sessionBlob: blob("dead-token", { expires: iso(Date.now() - HOUR) }),
    });
    const { mapAuth } = await load();

    expect(mapAuth.getAuth()).toBeNull();
    expect(stores.local.store.has(KEY)).toBe(false);
    expect(stores.session.store.has(KEY)).toBe(false);
  });

  it("runs once per page load", async () => {
    const stores = installStorages({ sessionBlob: blob("legacy-token") });
    const { mapAuth } = await load();

    expect(mapAuth.getAuth()?.token).toBe("legacy-token");
    stores.local.store.delete(KEY);
    // A blob appearing in sessionStorage later in the same load is not a
    // migration candidate — pre-F1 code is not running anymore.
    stores.session.store.set(KEY, blob("second-legacy"));

    expect(mapAuth.getAuth()?.token).toBe("second-legacy");
    expect(stores.local.store.has(KEY)).toBe(false);
  });

  it("keeps the legacy copy readable when localStorage refuses the write", async () => {
    const stores = installStorages({
      local: "no-write",
      sessionBlob: blob("legacy-token"),
    });
    const { mapAuth } = await load();

    // Degraded exactly as before the migration: still signed in for this tab.
    expect(mapAuth.getAuth()?.token).toBe("legacy-token");
    expect(stores.session.store.has(KEY)).toBe(true);
    expect(stores.local.store.has(KEY)).toBe(false);
  });

  it("is inert when both globals alias one storage object", async () => {
    // Some environments (and api.test.ts's deliberately shared stub) hand back
    // the same object for both storages. The legacy copy is then the live one,
    // so the promote must not "tidy it up" out of existence.
    const shared = fakeStorage("ok", blob("shared-token"));
    vi.stubGlobal("localStorage", shared.api);
    vi.stubGlobal("sessionStorage", shared.api);
    const { mapAuth } = await load();

    expect(mapAuth.getAuth()?.token).toBe("shared-token");
    expect(shared.store.has(KEY)).toBe(true);
  });

  it("cannot resurrect a signed-out session from a stranded legacy copy", async () => {
    const stores = installStorages({
      local: "no-write",
      sessionBlob: blob("legacy-token"),
    });
    const { mapAuth, session } = await load();
    expect(mapAuth.isAuthenticated()).toBe(true);

    session.clearSession();

    expect(stores.session.store.has(KEY)).toBe(false);
    expect(mapAuth.isAuthenticated()).toBe(false);
  });
});

describe("getAuth expiry + shape semantics (unchanged contract)", () => {
  it("self-clears an expired blob and reports signed out", async () => {
    const stores = installStorages({
      localBlob: blob("stale", { expires: iso(Date.now() - 1000) }),
    });
    const { mapAuth } = await load();

    expect(mapAuth.getAuth()).toBeNull();
    expect(mapAuth.isAuthenticated()).toBe(false);
    expect(stores.local.store.has(KEY)).toBe(false);
  });

  it("treats an unparseable expiry as expired rather than immortal", async () => {
    const stores = installStorages({
      localBlob: JSON.stringify({ token: "x", expires: "whenever" }),
    });
    const { mapAuth } = await load();

    expect(mapAuth.getAuth()).toBeNull();
    expect(stores.local.store.has(KEY)).toBe(false);
  });

  it("reads corrupt or shapeless blobs as signed out without throwing", async () => {
    for (const raw of [
      "not json at all",
      "null",
      '"a string"',
      JSON.stringify({ token: "no-expiry" }),
      JSON.stringify({ expires: iso(Date.now() + DAY) }),
      JSON.stringify({ token: "", expires: iso(Date.now() + DAY) }),
    ]) {
      installStorages({ localBlob: raw });
      const { mapAuth } = await load();
      expect(mapAuth.getAuth()).toBeNull();
    }
  });

  it("preserves unknown fields across a rotation write", async () => {
    const stores = installStorages({});
    const { session } = await load();

    expect(
      session.persistSession({
        token: "t",
        expires: iso(Date.now() + DAY),
        // A field a future server might add; a rotation must not eat it.
        ...{ scopes: ["rider"] },
      }),
    ).toBe(true);

    const raw = stores.local.store.get(KEY) as string;
    expect((JSON.parse(raw) as { scopes?: string[] }).scopes).toEqual(["rider"]);
  });
});

describe("signOut", () => {
  it("revokes server-side and clears the migrated session", async () => {
    const stores = installStorages({
      localBlob: blob("A"),
      sessionBlob: blob("A"),
    });
    const calls = stubFetch(() => json({ revoked: true }));
    const { mapAuth } = await load();

    await mapAuth.signOut();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://data.scooter.fyi/api/v1/auth/signout");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].authorization).toBe("Bearer A");
    expect(stores.local.store.has(KEY)).toBe(false);
    expect(stores.session.store.has(KEY)).toBe(false);
    expect(mapAuth.isAuthenticated()).toBe(false);
  });
});

describe("staleness decision", () => {
  it("keys off the local rotation stamp, falling back to issued_at", async () => {
    installStorages({});
    const { storage } = await load();
    const now = Date.now();
    const expires = iso(now + 30 * DAY);
    const stale = (extra: Partial<StoredSession>): boolean =>
      storage.isSessionStale({ token: "t", expires, ...extra }, now);

    expect(storage.REFRESH_STALE_MS).toBe(24 * HOUR);
    expect(stale({ rotated_at: iso(now - 23 * HOUR) })).toBe(false);
    expect(stale({ rotated_at: iso(now - 25 * HOUR) })).toBe(true);
    // No stamp at all (pre-F1 blob, or promoted out of sessionStorage).
    expect(stale({})).toBe(true);
    expect(stale({ issued_at: iso(now - 25 * HOUR) })).toBe(true);
    expect(stale({ issued_at: iso(now - HOUR) })).toBe(false);
    // rotated_at wins over issued_at — it is the newer of the two facts.
    expect(
      stale({ rotated_at: iso(now - HOUR), issued_at: iso(now - 40 * HOUR) }),
    ).toBe(false);
    expect(stale({ rotated_at: "garbage" })).toBe(true);
    // A skewed clock must not turn every load into a refresh.
    expect(stale({ rotated_at: iso(now + 5 * HOUR) })).toBe(false);
  });

  it("stamps a freshly persisted session so a new sign-in is never refreshed", async () => {
    const stores = installStorages({});
    const { session, storage } = await load();

    session.persistSession({ token: "new", expires: iso(Date.now() + 30 * DAY) });

    const stored = storedSession(stores.local) as StoredSession;
    expect(stored.rotated_at).toBeTypeOf("string");
    expect(storage.isSessionStale(stored)).toBe(false);
  });
});

describe("silent refresh", () => {
  it("does nothing when there is no session", async () => {
    installStorages({});
    const calls = stubFetch(() => json({}));
    const { session } = await load();

    await expect(session.refreshSessionIfStale()).resolves.toBe("no_session");
    expect(calls).toHaveLength(0);
  });

  it("does nothing for a token younger than a day", async () => {
    installStorages({
      localBlob: blob("fresh", { rotated_at: iso(Date.now() - 6 * HOUR) }),
    });
    const calls = stubFetch(() => json({}));
    const { session } = await load();

    await expect(session.refreshSessionIfStale()).resolves.toBe("fresh");
    expect(calls).toHaveLength(0);
  });

  it("rotates a stale token and stores the new one, stamped", async () => {
    const stores = installStorages({
      localBlob: blob("old", { rotated_at: iso(Date.now() - 25 * HOUR) }),
    });
    const rotated = { token: "new", expires: iso(Date.now() + 30 * DAY) };
    const calls = stubFetch(() => json(rotated));
    const { session, mapAuth, storage } = await load();

    await expect(session.refreshSessionIfStale()).resolves.toBe("rotated");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/v1/auth/refresh");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].authorization).toBe("Bearer old");
    expect(mapAuth.getAuth()?.token).toBe("new");
    const stored = storedSession(stores.local) as StoredSession;
    expect(storage.isSessionStale(stored)).toBe(false);
  });

  it("refreshes a promoted legacy blob, completing the migration in one load", async () => {
    const stores = installStorages({ sessionBlob: blob("legacy") });
    const calls = stubFetch(() =>
      json({ token: "sliding", expires: iso(Date.now() + 30 * DAY) }),
    );
    const { session, mapAuth } = await load();

    await expect(session.refreshSessionIfStale()).resolves.toBe("rotated");

    expect(calls[0].authorization).toBe("Bearer legacy");
    expect(mapAuth.getAuth()?.token).toBe("sliding");
    expect(storedToken(stores.local)).toBe("sliding");
    expect(stores.session.store.has(KEY)).toBe(false);
  });

  it("keeps another tab's session on a 401 for a token we no longer hold", async () => {
    const stores = installStorages({
      localBlob: blob("A", { rotated_at: iso(Date.now() - 25 * HOUR) }),
    });
    // The other tab rotated A → C and stored C while our request was in flight;
    // ours then presents a revoked token and gets a 401.
    const calls = stubFetch(() => {
      stores.local.store.set(KEY, blob("C", { rotated_at: iso(Date.now()) }));
      return json({ detail: "Invalid token" }, 401);
    });
    const { session, mapAuth } = await load();

    await expect(session.refreshSessionIfStale()).resolves.toBe("raced");

    expect(calls[0].authorization).toBe("Bearer A");
    // The hazard this whole guard exists for: C is VALID and must survive.
    expect(storedToken(stores.local)).toBe("C");
    expect(mapAuth.isAuthenticated()).toBe(true);
  });

  it("signs out on a 401 for the token still in storage", async () => {
    const stores = installStorages({
      localBlob: blob("A", { rotated_at: iso(Date.now() - 25 * HOUR) }),
    });
    stubFetch(() => json({ detail: "Invalid token" }, 401));
    const { session, mapAuth } = await load();

    await expect(session.refreshSessionIfStale()).resolves.toBe("signed_out");

    expect(stores.local.store.has(KEY)).toBe(false);
    expect(mapAuth.isAuthenticated()).toBe(false);
  });

  it("discards its own rotated token when another session won the write", async () => {
    const stores = installStorages({
      localBlob: blob("A", { rotated_at: iso(Date.now() - 25 * HOUR) }),
    });
    // A magic-link redemption (or another tab) stored C mid-flight. Our B is
    // valid but is not the session the rider is on — drop it, keep C.
    const calls = stubFetch(() => {
      stores.local.store.set(KEY, blob("C", { rotated_at: iso(Date.now()) }));
      return json({ token: "B", expires: iso(Date.now() + 30 * DAY) });
    });
    const { session, mapAuth } = await load();

    await expect(session.refreshSessionIfStale()).resolves.toBe("raced");

    expect(calls).toHaveLength(1);
    expect(storedToken(stores.local)).toBe("C");
    expect(mapAuth.getAuth()?.token).toBe("C");
  });

  it("leaves the session untouched on a network error or a 5xx", async () => {
    for (const responder of [
      (): Response => {
        throw new TypeError("Failed to fetch");
      },
      (): Response => json({ detail: "boom" }, 500),
      (): Response => json({ nothing: "useful" }),
    ]) {
      const stores = installStorages({
        localBlob: blob("A", { rotated_at: iso(Date.now() - 25 * HOUR) }),
      });
      stubFetch(responder);
      const { session, mapAuth } = await load();

      await expect(session.refreshSessionIfStale()).resolves.toBe("error");
      expect(storedToken(stores.local)).toBe("A");
      expect(mapAuth.isAuthenticated()).toBe(true);
    }
  });

  it("spends at most one refresh per page load", async () => {
    installStorages({
      localBlob: blob("A", { rotated_at: iso(Date.now() - 25 * HOUR) }),
    });
    const calls = stubFetch(() =>
      json({ token: "B", expires: iso(Date.now() + 30 * DAY) }),
    );
    const { session } = await load();

    const [first, second] = await Promise.all([
      session.refreshSessionIfStale(),
      session.refreshSessionIfStale(),
    ]);
    await session.refreshSessionIfStale();

    expect(first).toBe("rotated");
    expect(second).toBe("rotated");
    expect(calls).toHaveLength(1);
  });
});

describe("api.ts 401 handling", () => {
  it("clears the stored session when the rejected token is still the stored one", async () => {
    const stores = installStorages({ localBlob: blob("A") });
    stubFetch(() => json({ detail: "Invalid token" }, 401));
    const { api, mapAuth } = await load();

    const err = await api.getActiveRide().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(api.ApiError);
    expect((err as InstanceType<typeof api.ApiError>).code).toBe(
      "TOKEN_REJECTED",
    );
    expect(stores.local.store.has(KEY)).toBe(false);
    expect(mapAuth.isAuthenticated()).toBe(false);
  });

  it("leaves a newer session in place on a stale token's 401", async () => {
    const stores = installStorages({ localBlob: blob("A") });
    stubFetch(() => {
      stores.local.store.set(KEY, blob("C"));
      return json({ detail: "Invalid token" }, 401);
    });
    const { api, mapAuth } = await load();

    await api.getActiveRide().catch(() => undefined);

    expect(storedToken(stores.local)).toBe("C");
    expect(mapAuth.isAuthenticated()).toBe(true);
  });
});

describe("private-mode degradation", () => {
  it("reads signed out and refuses to claim a write when storage throws", async () => {
    installStorages({ local: "hostile", session: "hostile" });
    const calls = stubFetch(() => json({}));
    const { mapAuth, session } = await load();

    expect(mapAuth.getAuth()).toBeNull();
    expect(mapAuth.isAuthenticated()).toBe(false);
    expect(
      session.persistSession({ token: "t", expires: iso(Date.now() + DAY) }),
    ).toBe(false);
    expect(() => session.clearSession()).not.toThrow();
    await expect(session.refreshSessionIfStale()).resolves.toBe("no_session");
    expect(calls).toHaveLength(0);
  });

  it("survives a signOut with no storage and no network", async () => {
    installStorages({ local: "hostile", session: "hostile" });
    const { mapAuth } = await load();

    await expect(mapAuth.signOut()).resolves.toBeUndefined();
  });

  it("falls back to sessionStorage when localStorage is unavailable", async () => {
    const stores = installStorages({ local: "absent" });
    const { session, mapAuth } = await load();

    expect(
      session.persistSession({ token: "t", expires: iso(Date.now() + DAY) }),
    ).toBe(true);
    expect(storedToken(stores.session)).toBe("t");
    // And it reads back — the fallback is a real session, not a write-only sink.
    expect(mapAuth.getAuth()?.token).toBe("t");
  });

  it("falls back to sessionStorage when localStorage rejects the write", async () => {
    const stores = installStorages({ local: "no-write" });
    const { session, mapAuth } = await load();

    expect(
      session.persistSession({ token: "t", expires: iso(Date.now() + DAY) }),
    ).toBe(true);
    expect(storedToken(stores.session)).toBe("t");
    expect(mapAuth.getAuth()?.token).toBe("t");
  });
});
