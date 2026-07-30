// @vitest-environment happy-dom
//
// The wizard shell: screen registry + back/next routing, deep-link
// fast-forward, the orientation class flip (panes re-slot, screens are NOT
// rebuilt), the focus trap, and the cleanup discipline — every listener the
// modal adds must come off on close.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RIDE_SCREEN_FLOW,
  closeRideModal,
  currentRideScreen,
  isRideModalEnabled,
  isRideModalOpen,
  nextFlowScreen,
  openRideModal,
  registerRideScreen,
  registeredRideScreens,
  resetRideModal,
  resolveStartScreen,
  rideModalRoot,
  wireRideModal,
  type RideModalEntry,
  type RideScreen,
  type RideScreenContext,
  type ScreenId,
} from "./ride-modal.ts";

// ---------- helpers ----------

interface FakeMediaQuery {
  matches: boolean;
  set(matches: boolean): void;
  listenerCount(): number;
}

function stubOrientation(landscape: boolean): FakeMediaQuery {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: landscape,
    media: "(orientation: landscape)",
    onchange: null,
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (
      _type: string,
      cb: (e: MediaQueryListEvent) => void,
    ) => {
      listeners.delete(cb);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  vi.stubGlobal("matchMedia", () => mql as unknown as MediaQueryList);
  return {
    get matches() {
      return mql.matches;
    },
    set(matches: boolean) {
      mql.matches = matches;
      for (const cb of [...listeners]) {
        cb({ matches } as MediaQueryListEvent);
      }
    },
    listenerCount: () => listeners.size,
  };
}

/** A screen whose panes and lifecycle calls the test can inspect. */
function fakeScreen(
  id: ScreenId,
  opts: {
    log?: string[];
    split?: RideScreen["split"];
    secondary?: boolean;
    buttons?: number;
  } = {},
) {
  const log = opts.log ?? [];
  let builds = 0;
  let ctx: RideScreenContext | null = null;
  const primaries: HTMLElement[] = [];
  const factory = (c: RideScreenContext): RideScreen => {
    builds += 1;
    ctx = c;
    const primary = document.createElement("div");
    primary.dataset.pane = `primary-${id}`;
    for (let i = 0; i < (opts.buttons ?? 1); i += 1) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${id}-${i}`;
      primary.append(btn);
    }
    primaries.push(primary);
    const secondary = opts.secondary
      ? document.createElement("div")
      : undefined;
    if (secondary) secondary.dataset.pane = `secondary-${id}`;
    c.onCleanup(() => log.push(`cleanup:${id}`));
    return {
      title: `Screen ${id}`,
      primary,
      secondary,
      split: opts.split,
      onOrientationChange: (o) => log.push(`orient:${id}:${o}`),
      destroy: () => log.push(`destroy:${id}`),
    };
  };
  return {
    factory,
    builds: () => builds,
    ctx: () => ctx,
    primaries,
  };
}

function screenButtons(): HTMLButtonElement[] {
  const root = rideModalRoot();
  if (!root) return [];
  return [
    ...root.querySelectorAll<HTMLButtonElement>(".ride-modal__pane button"),
  ];
}

function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

beforeEach(() => {
  document.body.replaceChildren();
  stubOrientation(false);
});

afterEach(() => {
  resetRideModal();
  document.body.replaceChildren();
});

// ---------- shell ----------

describe("modal shell", () => {
  it("builds one dialog with a two-pane grid and an orientation class", () => {
    const mq = stubOrientation(true);
    const s2 = fakeScreen("2", { secondary: true });
    registerRideScreen("2", s2.factory);
    openRideModal({ fastForwardTo: "2" });

    const root = rideModalRoot();
    expect(root).not.toBeNull();
    expect(root?.getAttribute("role")).toBe("dialog");
    expect(root?.getAttribute("aria-modal")).toBe("true");
    expect(root?.classList.contains("is-landscape")).toBe(true);
    expect(root?.classList.contains("is-portrait")).toBe(false);
    expect(root?.dataset.screen).toBe("2");
    const grid = root?.querySelector<HTMLElement>(".ride-modal__grid");
    expect(grid?.dataset.panes).toBe("2");
    expect(grid?.dataset.split).toBe("even");
    expect(
      root?.querySelector(".ride-modal__pane--primary")?.firstElementChild
        ?.getAttribute("data-pane"),
    ).toBe("primary-2");
    expect(document.querySelectorAll(".ride-modal")).toHaveLength(1);
    expect(mq.listenerCount()).toBe(1);
  });

  it("collapses to one pane for a single-pane screen and honours the 40/60 split", () => {
    const s4 = fakeScreen("4", { secondary: true, split: "40-60" });
    const s2 = fakeScreen("2");
    registerRideScreen("2", s2.factory);
    registerRideScreen("4", s4.factory);
    openRideModal({ fastForwardTo: "2" });
    let grid = rideModalRoot()?.querySelector<HTMLElement>(".ride-modal__grid");
    expect(grid?.dataset.panes).toBe("1");
    expect(grid?.dataset.split).toBe("even");

    s2.ctx()?.go("4");
    grid = rideModalRoot()?.querySelector<HTMLElement>(".ride-modal__grid");
    expect(grid?.dataset.panes).toBe("2");
    expect(grid?.dataset.split).toBe("40-60");
  });

  it("uses a placeholder for an unregistered screen instead of throwing", () => {
    openRideModal();
    expect(currentRideScreen()).toBe("1");
    expect(
      rideModalRoot()?.querySelector(".ride-modal__placeholder"),
    ).not.toBeNull();
  });

  it("reports the wired screens in flow order", () => {
    registerRideScreen("3", fakeScreen("3").factory);
    registerRideScreen("1", fakeScreen("1").factory);
    registerRideScreen("2.5", fakeScreen("2.5").factory);
    expect(registeredRideScreens()).toEqual(["1", "2.5", "3"]);
  });

  it("re-entering while open replaces the live modal", () => {
    const closes: string[] = [];
    wireRideModal({ onClose: (r) => closes.push(r) });
    registerRideScreen("2", fakeScreen("2").factory);
    openRideModal({ fastForwardTo: "2" });
    openRideModal({ fastForwardTo: "2" });
    expect(closes).toEqual(["reopen"]);
    expect(document.querySelectorAll(".ride-modal")).toHaveLength(1);
  });
});

// ---------- routing ----------

describe("routing", () => {
  it("walks the flow with next(), skipping screens that ask to be skipped", () => {
    const log: string[] = [];
    const s1 = fakeScreen("1", { log });
    const s2 = fakeScreen("2", { log });
    const s3 = fakeScreen("3", { log });
    const s6 = fakeScreen("6", { log });
    registerRideScreen("1", s1.factory);
    registerRideScreen("2", s2.factory);
    // Navigation off → Screens 3 and 4 skip.
    registerRideScreen("3", { factory: s3.factory, skip: () => true });
    registerRideScreen("4", { factory: fakeScreen("4").factory, skip: () => true });
    registerRideScreen("6", s6.factory);

    openRideModal();
    expect(currentRideScreen()).toBe("1");
    s1.ctx()?.next();
    expect(currentRideScreen()).toBe("2");
    s2.ctx()?.next();
    expect(currentRideScreen()).toBe("6");
    expect(s3.builds()).toBe(0);
  });

  it("closes with a handoff (after onComplete) past the last screen", () => {
    const events: string[] = [];
    wireRideModal({
      onComplete: () => events.push("complete"),
      onClose: (r) => events.push(`close:${r}`),
    });
    const s6 = fakeScreen("6");
    registerRideScreen("6", s6.factory);
    openRideModal({ fastForwardTo: "6" });
    s6.ctx()?.next();
    expect(events).toEqual(["complete", "close:handoff"]);
    expect(isRideModalOpen()).toBe(false);
  });

  it("back() returns to the previous screen and hides its button at the root", () => {
    const s2 = fakeScreen("2");
    const s25 = fakeScreen("2.5");
    registerRideScreen("2", s2.factory);
    registerRideScreen("2.5", s25.factory);
    openRideModal({ fastForwardTo: "2" });
    const back = (): HTMLButtonElement | null =>
      rideModalRoot()?.querySelector<HTMLButtonElement>(".ride-modal__back") ??
      null;
    expect(back()?.hidden).toBe(true);

    s2.ctx()?.go("2.5");
    expect(currentRideScreen()).toBe("2.5");
    expect(back()?.hidden).toBe(false);
    back()?.click();
    expect(currentRideScreen()).toBe("2");
    expect(back()?.hidden).toBe(true);
    // At the root, back() is a no-op — it must not close the wizard.
    back()?.click();
    expect(isRideModalOpen()).toBe(true);
  });

  it("next() from the 2.5 detour goes back, since a detour has no successor", () => {
    const s2 = fakeScreen("2");
    const s25 = fakeScreen("2.5");
    registerRideScreen("2", s2.factory);
    registerRideScreen("2.5", s25.factory);
    registerRideScreen("3", fakeScreen("3").factory);
    openRideModal({ fastForwardTo: "2" });
    s2.ctx()?.go("2.5");
    s25.ctx()?.next();
    expect(currentRideScreen()).toBe("2");
    expect(RIDE_SCREEN_FLOW.includes("2.5" as ScreenId)).toBe(false);
  });

  it("a stale context cannot navigate after its screen was replaced", () => {
    const s2 = fakeScreen("2");
    registerRideScreen("2", s2.factory);
    registerRideScreen("3", fakeScreen("3").factory);
    openRideModal({ fastForwardTo: "2" });
    const stale = s2.ctx();
    stale?.go("3");
    expect(currentRideScreen()).toBe("3");
    stale?.go("2");
    expect(currentRideScreen()).toBe("3");
    stale?.close();
    expect(isRideModalOpen()).toBe(true);
  });

  it("reports every screen change, including the first", () => {
    const seen: ScreenId[] = [];
    wireRideModal({ onScreenChange: (id) => seen.push(id) });
    const s2 = fakeScreen("2");
    registerRideScreen("2", s2.factory);
    registerRideScreen("3", fakeScreen("3").factory);
    openRideModal({ fastForwardTo: "2" });
    s2.ctx()?.next();
    expect(seen).toEqual(["2", "3"]);
  });

  it("a screen factory that throws renders an honest error, not a broken dialog", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerRideScreen("2", () => {
      throw new Error("screen exploded");
    });
    openRideModal({ fastForwardTo: "2" });
    expect(isRideModalOpen()).toBe(true);
    expect(currentRideScreen()).toBe("2");
    expect(rideModalRoot()?.textContent).toContain("Something went wrong");
    // The exit is still reachable.
    rideModalRoot()
      ?.querySelector<HTMLButtonElement>(".ride-modal__close")
      ?.click();
    expect(isRideModalOpen()).toBe(false);
    err.mockRestore();
  });

  it("a throwing skip predicate shows the screen rather than stranding the rider", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerRideScreen("1", {
      factory: fakeScreen("1").factory,
      skip: () => {
        throw new Error("gate exploded");
      },
    });
    openRideModal();
    expect(currentRideScreen()).toBe("1");
    err.mockRestore();
  });
});

// ---------- deep-link fast-forward ----------

describe("deep-link fast-forward", () => {
  const entry: RideModalEntry = { vehicleIdentifier: "a1b2c3d4e5f60718" };

  it("lands on Screen 2 when Screen 1 is not wired yet", () => {
    expect(resolveStartScreen(entry, {})).toBe("2");
    openRideModal(entry);
    expect(currentRideScreen()).toBe("2");
  });

  it("still shows Screen 1 when its gates are unmet — a deep link is not a bypass", () => {
    registerRideScreen("1", {
      factory: fakeScreen("1").factory,
      skip: () => false,
    });
    expect(resolveStartScreen(entry, {})).toBe("1");
    openRideModal(entry);
    expect(currentRideScreen()).toBe("1");
  });

  it("skips Screen 1 when it says the rider is already authed with GPS", () => {
    registerRideScreen("1", {
      factory: fakeScreen("1").factory,
      skip: (ctx) => ctx.entry.vehicleIdentifier !== undefined,
    });
    expect(resolveStartScreen(entry, {})).toBe("2");
  });

  it("a plain entry starts at Screen 1", () => {
    expect(resolveStartScreen({}, {})).toBe("1");
  });

  // Regression: the target screen used to short-circuit the walk BEFORE its own
  // `skip` predicate ran, so the ordinary (deep-link-free) entry — whose target
  // IS Screen 1 — always landed on Screen 1 and the module map's "skipped
  // entirely when isAuthenticated() and geolocation permission is already
  // granted" could never fire.
  it("skips Screen 1 on a PLAIN entry too when its gates are already met", () => {
    registerRideScreen("1", {
      factory: fakeScreen("1").factory,
      skip: () => true,
    });
    registerRideScreen("2", fakeScreen("2").factory);
    expect(resolveStartScreen({}, {})).toBe("2");
    openRideModal({});
    expect(currentRideScreen()).toBe("2");
  });

  it("shows Screen 1 on a plain entry when its gates are unmet", () => {
    registerRideScreen("1", {
      factory: fakeScreen("1").factory,
      skip: () => false,
    });
    registerRideScreen("2", fakeScreen("2").factory);
    expect(resolveStartScreen({}, {})).toBe("1");
  });

  // Same root cause past the target: a fast-forward must not park the rider on
  // a screen whose registration just said to skip it (Screens 3/4 with
  // navigation off).
  it("never lands on a fast-forward target that asked to be skipped", () => {
    registerRideScreen("3", {
      factory: fakeScreen("3").factory,
      skip: () => true,
    });
    registerRideScreen("4", fakeScreen("4").factory);
    expect(resolveStartScreen({ fastForwardTo: "3" }, {})).toBe("4");
  });

  it("still steps over unwired screens before the target", () => {
    // F1 registers nothing: a `?ride=` link must reach Screen 2's placeholder,
    // not stop at an unwired Screen 1.
    expect(resolveStartScreen({ fastForwardTo: "2" }, {})).toBe("2");
    expect(resolveStartScreen({ fastForwardTo: "6" }, {})).toBe("6");
    // 2.5 is a detour, not a flow step: it sits past every flow screen, so an
    // unwired flow is stepped over entirely rather than stopping at Screen 1.
    expect(resolveStartScreen({ fastForwardTo: "2.5" }, {})).toBe("2.5");
    registerRideScreen("1", {
      factory: fakeScreen("1").factory,
      skip: () => false,
    });
    expect(resolveStartScreen({ fastForwardTo: "2.5" }, {})).toBe("1");
  });

  it("jumps the map to the deep-linked device exactly once", () => {
    const jumpToDevice = vi.fn();
    wireRideModal({ jumpToDevice });
    openRideModal(entry);
    expect(jumpToDevice).toHaveBeenCalledTimes(1);
    expect(jumpToDevice).toHaveBeenCalledWith("a1b2c3d4e5f60718");
  });

  it("survives a throwing jumpToDevice", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    wireRideModal({
      jumpToDevice: () => {
        throw new Error("map not loaded");
      },
    });
    openRideModal(entry);
    expect(isRideModalOpen()).toBe(true);
    err.mockRestore();
  });

  it("hands the entry through to the screen, plate and all", () => {
    const s2 = fakeScreen("2");
    registerRideScreen("2", s2.factory);
    openRideModal({ plate: "1025543" });
    expect(currentRideScreen()).toBe("2");
    expect(s2.ctx()?.entry).toEqual({ plate: "1025543" });
  });

  it("nextFlowScreen is the pure routing rule", () => {
    expect(nextFlowScreen("2", {}, {})).toBe("3");
    expect(nextFlowScreen("6", {}, {})).toBeNull();
    expect(nextFlowScreen("2.5", {}, {})).toBeNull();
    registerRideScreen("3", { factory: fakeScreen("3").factory, skip: () => true });
    expect(nextFlowScreen("2", {}, {})).toBe("4");
  });
});

// ---------- orientation ----------

describe("orientation", () => {
  it("flips the root class and notifies the screen without rebuilding it", () => {
    const mq = stubOrientation(false);
    const log: string[] = [];
    const s2 = fakeScreen("2", { log, secondary: true });
    registerRideScreen("2", s2.factory);
    openRideModal({ fastForwardTo: "2" });
    const paneBefore = rideModalRoot()?.querySelector(
      '[data-pane="primary-2"]',
    );

    mq.set(true);
    expect(rideModalRoot()?.classList.contains("is-landscape")).toBe(true);
    expect(log).toContain("orient:2:landscape");
    mq.set(false);
    expect(rideModalRoot()?.classList.contains("is-portrait")).toBe(true);
    expect(log).toContain("orient:2:portrait");

    // One build, same pane element: state survives the turn.
    expect(s2.builds()).toBe(1);
    expect(rideModalRoot()?.querySelector('[data-pane="primary-2"]')).toBe(
      paneBefore,
    );
    expect(s2.ctx()?.orientation()).toBe("portrait");
  });

  it("re-slots panes on demand without a rebuild (the keypad swap)", () => {
    const mq = stubOrientation(false);
    const keypad = document.createElement("div");
    keypad.dataset.pane = "keypad";
    let builds = 0;
    registerRideScreen("2", (ctx) => {
      builds += 1;
      const primary = document.createElement("div");
      primary.dataset.pane = "primary";
      return {
        title: "Screen 2",
        primary,
        secondary: ctx.orientation() === "landscape" ? keypad : null,
        onOrientationChange: (o) => {
          ctx.setPanes(primary, o === "landscape" ? keypad : null);
        },
      };
    });
    openRideModal({ fastForwardTo: "2" });
    const grid = (): HTMLElement | null =>
      rideModalRoot()?.querySelector<HTMLElement>(".ride-modal__grid") ?? null;
    expect(grid()?.dataset.panes).toBe("1");

    mq.set(true);
    expect(grid()?.dataset.panes).toBe("2");
    expect(rideModalRoot()?.querySelector('[data-pane="keypad"]')).toBe(keypad);

    mq.set(false);
    expect(grid()?.dataset.panes).toBe("1");
    expect(builds).toBe(1);
  });

  it("assumes portrait when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    openRideModal();
    expect(rideModalRoot()?.classList.contains("is-portrait")).toBe(true);
  });

  it("a throwing orientation handler does not break the flip", () => {
    const mq = stubOrientation(false);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerRideScreen("2", () => ({
      title: "Screen 2",
      primary: document.createElement("div"),
      onOrientationChange: () => {
        throw new Error("boom");
      },
    }));
    openRideModal({ fastForwardTo: "2" });
    mq.set(true);
    expect(rideModalRoot()?.classList.contains("is-landscape")).toBe(true);
    err.mockRestore();
  });
});

// ---------- focus trap ----------

describe("focus trap", () => {
  it("focuses the screen's content, not the header ✕", () => {
    const s2 = fakeScreen("2", { buttons: 2 });
    registerRideScreen("2", s2.factory);
    openRideModal({ fastForwardTo: "2" });
    expect(document.activeElement).toBe(screenButtons()[0]);
  });

  it("skips text fields so mounting a screen never pops the keyboard", () => {
    const field = document.createElement("input");
    field.type = "text";
    registerRideScreen("2", () => {
      const primary = document.createElement("div");
      primary.append(field);
      return { title: "Screen 2", primary };
    });
    openRideModal({ fastForwardTo: "2" });
    expect(document.activeElement).not.toBe(field);
    expect(document.activeElement).toBe(
      rideModalRoot()?.querySelector(".ride-modal__card"),
    );
  });

  it("honours an explicit initialFocus", () => {
    const target = document.createElement("input");
    registerRideScreen("2", () => {
      const primary = document.createElement("div");
      primary.append(document.createElement("button"), target);
      return { title: "Screen 2", primary, initialFocus: target };
    });
    openRideModal({ fastForwardTo: "2" });
    expect(document.activeElement).toBe(target);
  });

  it("wraps Tab at both ends of the dialog", () => {
    const s2 = fakeScreen("2", { buttons: 2 });
    registerRideScreen("2", s2.factory);
    openRideModal({ fastForwardTo: "2" });
    const root = rideModalRoot();
    if (!root) throw new Error("no modal");
    const close = root.querySelector<HTMLButtonElement>(".ride-modal__close");
    const buttons = screenButtons();
    const last = buttons[buttons.length - 1];

    // The hidden Back button is not in the tab ring, so ✕ is first.
    last.focus();
    const fwd = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(fwd);
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);

    const back = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    close?.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("pulls focus back when something outside steals it", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const s2 = fakeScreen("2");
    registerRideScreen("2", s2.factory);
    openRideModal({ fastForwardTo: "2" });
    outside.focus();
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(rideModalRoot()?.contains(document.activeElement)).toBe(true);
    // Recovered onto the dialog card, not onto a control that could fire.
    expect(document.activeElement).toBe(
      rideModalRoot()?.querySelector(".ride-modal__card"),
    );
  });

  it("restores focus to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    registerRideScreen("2", fakeScreen("2").factory);
    openRideModal({ fastForwardTo: "2" });
    expect(document.activeElement).not.toBe(opener);
    closeRideModal();
    expect(document.activeElement).toBe(opener);
  });
});

// ---------- Escape + cleanup discipline ----------

describe("teardown", () => {
  it("Escape closes the wizard", () => {
    const closes: string[] = [];
    wireRideModal({ onClose: (r) => closes.push(r) });
    registerRideScreen("2", fakeScreen("2").factory);
    openRideModal({ fastForwardTo: "2" });
    pressEscape();
    expect(closes).toEqual(["escape"]);
    expect(isRideModalOpen()).toBe(false);
    expect(document.querySelector(".ride-modal")).toBeNull();
  });

  it("leaves Escape to a floating ℹ modal while one is open", () => {
    registerRideScreen("2", fakeScreen("2").factory);
    openRideModal({ fastForwardTo: "2" });
    const info = document.createElement("div");
    info.className = "ranks-modal";
    document.body.append(info);
    pressEscape();
    expect(isRideModalOpen()).toBe(true);
    info.remove();
    pressEscape();
    expect(isRideModalOpen()).toBe(false);
  });

  it("runs destroy then cleanups on every screen change and on close", () => {
    const log: string[] = [];
    const s2 = fakeScreen("2", { log });
    registerRideScreen("2", s2.factory);
    registerRideScreen("3", fakeScreen("3", { log }).factory);
    openRideModal({ fastForwardTo: "2" });
    s2.ctx()?.next();
    expect(log).toEqual(["destroy:2", "cleanup:2"]);
    closeRideModal();
    expect(log).toEqual(["destroy:2", "cleanup:2", "destroy:3", "cleanup:3"]);
  });

  it("runs a cleanup registered by an already-replaced screen immediately", () => {
    const log: string[] = [];
    const s2 = fakeScreen("2", { log });
    registerRideScreen("2", s2.factory);
    registerRideScreen("3", fakeScreen("3").factory);
    openRideModal({ fastForwardTo: "2" });
    const stale = s2.ctx();
    stale?.next();
    log.length = 0;
    stale?.onCleanup(() => log.push("late"));
    expect(log).toEqual(["late"]);
  });

  it("a throwing cleanup does not block the rest of teardown", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log: string[] = [];
    registerRideScreen("2", (ctx) => {
      ctx.onCleanup(() => {
        throw new Error("bad cleanup");
      });
      ctx.onCleanup(() => log.push("second"));
      return { title: "Screen 2", primary: document.createElement("div") };
    });
    openRideModal({ fastForwardTo: "2" });
    closeRideModal();
    expect(log).toEqual(["second"]);
    expect(isRideModalOpen()).toBe(false);
    err.mockRestore();
  });

  it("detaches every document and media-query listener it added", () => {
    const mq = stubOrientation(false);
    const added = new Map<string, number>();
    const bump = (map: Map<string, number>, k: string, by: number): void => {
      map.set(k, (map.get(k) ?? 0) + by);
    };
    const addSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation(((type: string, ...rest: unknown[]) => {
        bump(added, type, 1);
        return EventTarget.prototype.addEventListener.call(
          document,
          type,
          ...(rest as [EventListenerOrEventListenerObject]),
        );
      }) as typeof document.addEventListener);
    const removeSpy = vi
      .spyOn(document, "removeEventListener")
      .mockImplementation(((type: string, ...rest: unknown[]) => {
        bump(added, type, -1);
        return EventTarget.prototype.removeEventListener.call(
          document,
          type,
          ...(rest as [EventListenerOrEventListenerObject]),
        );
      }) as typeof document.removeEventListener);

    registerRideScreen("2", fakeScreen("2").factory);
    openRideModal({ fastForwardTo: "2" });
    expect(added.get("keydown")).toBe(1);
    expect(added.get("focusin")).toBe(1);
    expect(mq.listenerCount()).toBe(1);

    closeRideModal();
    expect(added.get("keydown")).toBe(0);
    expect(added.get("focusin")).toBe(0);
    expect(mq.listenerCount()).toBe(0);
    addSpy.mockRestore();
    removeSpy.mockRestore();

    // And the detached listeners really are inert.
    const closes: string[] = [];
    wireRideModal({ onClose: (r) => closes.push(r) });
    pressEscape();
    document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(closes).toEqual([]);
  });

  it("close is idempotent", () => {
    const closes: string[] = [];
    wireRideModal({ onClose: (r) => closes.push(r) });
    registerRideScreen("2", fakeScreen("2").factory);
    openRideModal({ fastForwardTo: "2" });
    closeRideModal("programmatic");
    closeRideModal("programmatic");
    expect(closes).toEqual(["programmatic"]);
  });

  it("resetRideModal empties the registry and closes anything open", () => {
    registerRideScreen("2", fakeScreen("2").factory);
    openRideModal({ fastForwardTo: "2" });
    resetRideModal();
    expect(isRideModalOpen()).toBe(false);
    expect(registeredRideScreens()).toEqual([]);
    expect(currentRideScreen()).toBeNull();
  });
});

// ---------- wiring ----------

describe("wireRideModal", () => {
  it("runs the recovery seat once, before any render", () => {
    const order: string[] = [];
    wireRideModal({
      onWired: () => order.push("wired"),
      onOpen: () => order.push("open"),
    });
    registerRideScreen("2", fakeScreen("2").factory);
    openRideModal({ fastForwardTo: "2" });
    expect(order).toEqual(["wired", "open"]);
  });

  it("reads the dev flag defensively", () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    expect(isRideModalEnabled()).toBe(false);
    store["scooter-fyi-ride-modal"] = "1";
    expect(isRideModalEnabled()).toBe(true);
    store["scooter-fyi-ride-modal"] = "off";
    expect(isRideModalEnabled()).toBe(false);

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("private mode");
      },
    });
    expect(isRideModalEnabled()).toBe(false);
  });
});
