// @vitest-environment happy-dom
//
// Screen 1 — Auth & GPS. Covers: the skip gate (authed AND GPS-granted, in
// both its synchronous-fix and async-permission-leap-past forms), the GPS
// prompt's trigger/onFix/onError wiring, [Ride as Guest] advancing the flow
// without requiring auth, and the sign-in doors rendering per `AuthConfig`
// (including the fourth SMS door this lane added).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-google.ts", () => ({
  renderGoogleButton: vi.fn((container: HTMLElement) => {
    const btn = document.createElement("button");
    btn.textContent = "Continue with Google (stub)";
    container.append(btn);
    return Promise.resolve();
  }),
}));

import type { AuthConfig } from "./auth-config.ts";
import {
  currentRideScreen,
  openRideModal,
  resetRideModal,
  resolveStartScreen,
  rideModalRoot,
} from "./ride-modal.ts";
import {
  wireRideScreenAuth,
  type GeoPermissionState,
  type LocateLike,
  type RideScreenAuthDeps,
} from "./ride-screen-auth.ts";
import type { LngLat } from "./locate.ts";

const AUTH_KEY = "scooter_fyi.map_auth";

const SAFE_CFG: AuthConfig = {
  googleClientId: null,
  googleEnabled: false,
  magicLinkEnabled: true,
  codeEnabled: true,
  smsEnabled: false,
};

function setAuthed(on: boolean): void {
  if (on) {
    localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({
        token: "tok",
        expires: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
  } else {
    localStorage.removeItem(AUTH_KEY);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeLocate extends LocateLike {
  emitFix(pos: LngLat): void;
  emitError(): void;
  triggerCalls: number;
}

function fakeLocate(initial: LngLat | null = null): FakeLocate {
  let current = initial;
  const fixListeners = new Set<(pos: LngLat) => void>();
  const errorListeners = new Set<() => void>();
  const handle: FakeLocate = {
    current: () => current,
    trigger: () => {
      handle.triggerCalls += 1;
    },
    onFix: (cb) => {
      fixListeners.add(cb);
      return () => fixListeners.delete(cb);
    },
    onError: (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    emitFix(pos) {
      current = pos;
      for (const cb of [...fixListeners]) cb(pos);
    },
    emitError() {
      for (const cb of [...errorListeners]) cb();
    },
    triggerCalls: 0,
  };
  return handle;
}

function wire(
  overrides: Partial<RideScreenAuthDeps> & { locate: LocateLike },
): () => void {
  return wireRideScreenAuth({
    loadAuthConfig: () => Promise.resolve(SAFE_CFG),
    onSignedIn: () => {},
    queryGeoPermission: () => Promise.resolve<GeoPermissionState>("prompt"),
    ...overrides,
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  // No test may hit the real network (auth-config's fetch, GIS' script tag).
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

afterEach(() => {
  resetRideModal();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// skip()
// ---------------------------------------------------------------------------

describe("wireRideScreenAuth — skip gate", () => {
  it("shows the screen when signed out, even with GPS granted", () => {
    setAuthed(false);
    wire({ locate: fakeLocate({ lng: -104.99, lat: 39.74 }) });
    expect(resolveStartScreen({ fastForwardTo: "1" })).toBe("1");
  });

  it("shows the screen when signed in but GPS has no fix", () => {
    setAuthed(true);
    wire({ locate: fakeLocate(null) });
    expect(resolveStartScreen({ fastForwardTo: "1" })).toBe("1");
  });

  it("skips when signed in AND a live GPS fix already exists", () => {
    setAuthed(true);
    wire({ locate: fakeLocate({ lng: -104.99, lat: 39.74 }) });
    // Screen "2" is unregistered in this isolated test, so landing past
    // screen 1 (skipped) surfaces as the next flow id.
    expect(resolveStartScreen({ fastForwardTo: "1" })).toBe("2");
  });

  it("a device deep link still runs the gates (does not bypass screen 1)", () => {
    setAuthed(false);
    wire({ locate: fakeLocate({ lng: -104.99, lat: 39.74 }) });
    expect(
      resolveStartScreen({ vehicleIdentifier: "a1b2c3d4e5f60718" }),
    ).toBe("1");
  });

  it("leap-past: an async 'granted' permission (no live fix) eventually skips too", async () => {
    setAuthed(true);
    wire({
      locate: fakeLocate(null),
      queryGeoPermission: () => Promise.resolve<GeoPermissionState>("granted"),
    });
    // Before the microtask settles, the cache hasn't caught up yet.
    expect(resolveStartScreen({ fastForwardTo: "1" })).toBe("1");
    await flush();
    expect(resolveStartScreen({ fastForwardTo: "1" })).toBe("2");
  });

  it("a denied/unknown permission never flips the cache", async () => {
    setAuthed(true);
    wire({
      locate: fakeLocate(null),
      queryGeoPermission: () => Promise.resolve<GeoPermissionState>("denied"),
    });
    await flush();
    expect(resolveStartScreen({ fastForwardTo: "1" })).toBe("1");
  });

  // Review fix regression: the leap-past used to only flip the cached flag,
  // never actually request a fix — a rider with permission already granted
  // (but no live fix yet, e.g. a fresh tab) would then skip straight past
  // Screen 1 to Screen 6 and wait forever for a fix nothing ever asked for.
  it("authenticated + permission granted + no current fix: skips Screen 1 and calls trigger() exactly once", async () => {
    setAuthed(true);
    const locate = fakeLocate(null);
    wire({
      locate,
      queryGeoPermission: () => Promise.resolve<GeoPermissionState>("granted"),
    });
    await flush();
    expect(resolveStartScreen({ fastForwardTo: "1" })).toBe("2");
    expect(locate.triggerCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GPS prompt
// ---------------------------------------------------------------------------

describe("Screen 1 — GPS prompt", () => {
  it("renders an Enable GPS button that triggers Locate from inside the tap", () => {
    setAuthed(true); // isolate the GPS section from auth-door rendering
    const locate = fakeLocate(null);
    wire({ locate });
    openRideModal({ fastForwardTo: "1" });
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Enable GPS",
    );
    expect(btn).toBeTruthy();
    btn!.click();
    expect(locate.triggerCalls).toBe(1);
  });

  it("a fix hides the prompt and, once also authenticated, advances the flow", () => {
    setAuthed(true);
    const locate = fakeLocate(null);
    wire({ locate });
    openRideModal({ fastForwardTo: "1" });
    expect(currentRideScreen()).toBe("1");
    locate.emitFix({ lng: -104.99, lat: 39.74 });
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Enable GPS",
      ),
    ).toBe(false);
    expect(currentRideScreen()).toBe("2");
  });

  it("a fix does not auto-advance while still signed out", () => {
    setAuthed(false);
    const locate = fakeLocate(null);
    wire({ locate });
    openRideModal({ fastForwardTo: "1" });
    locate.emitFix({ lng: -104.99, lat: 39.74 });
    expect(currentRideScreen()).toBe("1");
  });

  it("an error re-enables the button with an explanation", () => {
    setAuthed(true);
    const locate = fakeLocate(null);
    wire({ locate });
    openRideModal({ fastForwardTo: "1" });
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Enable GPS",
    ) as HTMLButtonElement;
    btn.click();
    expect(btn.disabled).toBe(true);
    locate.emitError();
    expect(btn.disabled).toBe(false);
    expect(rideModalRoot()?.textContent).toContain("couldn't get your location");
  });

  it("the leap-past fetches a fix without a tap once permission resolves granted", async () => {
    setAuthed(true);
    const locate = fakeLocate(null);
    wire({
      locate,
      queryGeoPermission: () => Promise.resolve<GeoPermissionState>("granted"),
    });
    openRideModal({ fastForwardTo: "1" });
    await flush();
    expect(locate.triggerCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sign-in doors
// ---------------------------------------------------------------------------

describe("Screen 1 — sign-in doors", () => {
  it("shows Ride as Guest which advances the flow without signing in", () => {
    setAuthed(false);
    wire({ locate: fakeLocate({ lng: -104.99, lat: 39.74 }) });
    openRideModal({ fastForwardTo: "1" });
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Ride as Guest",
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(currentRideScreen()).toBe("2");
  });

  it("renders nothing auth-related once signed in", () => {
    setAuthed(true);
    wire({ locate: fakeLocate(null) }); // no fix, so the screen still renders
    openRideModal({ fastForwardTo: "1" });
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Ride as Guest",
      ),
    ).toBe(false);
  });

  it("renders the email code door by default", () => {
    setAuthed(false);
    wire({ locate: fakeLocate(null) });
    openRideModal({ fastForwardTo: "1" });
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Email me a sign-in code",
      ),
    ).toBe(true);
  });

  it("adds the fourth SMS door only when auth-config reports smsEnabled", async () => {
    setAuthed(false);
    wire({
      locate: fakeLocate(null),
      loadAuthConfig: () => Promise.resolve({ ...SAFE_CFG, smsEnabled: true }),
    });
    openRideModal({ fastForwardTo: "1" });
    // Not yet rendered — loadAuthConfig() hasn't resolved.
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Text me a sign-in code",
      ),
    ).toBe(false);
    await flush();
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Text me a sign-in code",
      ),
    ).toBe(true);
  });

  it("omits the SMS door when auth-config reports it disabled", async () => {
    setAuthed(false);
    wire({ locate: fakeLocate(null) }); // SAFE_CFG: smsEnabled false
    openRideModal({ fastForwardTo: "1" });
    await flush();
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Text me a sign-in code",
      ),
    ).toBe(false);
  });

  it("renders the Google button only when config supplies a client id", async () => {
    setAuthed(false);
    wire({
      locate: fakeLocate(null),
      loadAuthConfig: () =>
        Promise.resolve({
          ...SAFE_CFG,
          googleEnabled: true,
          googleClientId: "client-123",
        }),
    });
    openRideModal({ fastForwardTo: "1" });
    await flush();
    expect(document.querySelector(".account-google")).toBeTruthy();
  });
});
