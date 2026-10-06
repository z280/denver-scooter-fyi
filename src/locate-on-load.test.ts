// @vitest-environment happy-dom
//
// Asking for location at load. The whole value of this module is the three
// cases where it does NOT ask, so those are what is pinned: a rider who
// already declined, a fix already in hand, and a browser with no geolocation
// at all. See `locate-on-load.ts` for why the default flipped.

import { describe, expect, it, vi } from "vitest";

import { requestLocationOnLoad } from "./locate-on-load.ts";

function deps(
  over: Partial<Parameters<typeof requestLocationOnLoad>[0]> = {},
) {
  const trigger = vi.fn();
  return {
    trigger,
    all: {
      trigger,
      hasFix: () => false,
      supported: () => true,
      permission: () => Promise.resolve<PermissionState | null>("prompt"),
      ...over,
    },
  };
}

describe("requestLocationOnLoad", () => {
  it("asks when the rider has not been asked before", async () => {
    const { trigger, all } = deps();
    await expect(requestLocationOnLoad(all)).resolves.toBe("prompted");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("starts silently when permission is already granted", async () => {
    // The payoff for asking early: the second visit opens centred on the
    // rider with no prompt at all.
    const { trigger, all } = deps({
      permission: () => Promise.resolve<PermissionState | null>("granted"),
    });
    await expect(requestLocationOnLoad(all)).resolves.toBe("granted");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a rider who already said no", async () => {
    // The browser will not re-prompt, so triggering here buys nothing and
    // costs an error flash in the UI on every single page load.
    const { trigger, all } = deps({
      permission: () => Promise.resolve<PermissionState | null>("denied"),
    });
    await expect(requestLocationOnLoad(all)).resolves.toBe("denied");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("does nothing when a fix is already in hand", async () => {
    // `?ride=` resumes a live ride with a watch already running, and
    // ride-resume-prompt.ts can trigger before the map finishes loading.
    const { trigger, all } = deps({ hasFix: () => true });
    await expect(requestLocationOnLoad(all)).resolves.toBe("already");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("re-checks for a fix after the permission round trip", async () => {
    // The Permissions API is a real await. A rider who tapped the geolocate
    // button during it has answered the question already, and triggering a
    // second time would restart a watch that is working.
    let fix = false;
    const { trigger, all } = deps({
      hasFix: () => fix,
      permission: () => {
        fix = true;
        return Promise.resolve<PermissionState | null>("prompt");
      },
    });
    await expect(requestLocationOnLoad(all)).resolves.toBe("already");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("asks anyway when the browser cannot report permission state", async () => {
    // Older Safari has no geolocation entry in the Permissions API. Falling
    // back to asking is what a browser without it does regardless.
    const { trigger, all } = deps({ permission: () => Promise.resolve(null) });
    await expect(requestLocationOnLoad(all)).resolves.toBe("prompted");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("says unsupported, and asks nothing, with no geolocation at all", async () => {
    const { trigger, all } = deps({ supported: () => false });
    await expect(requestLocationOnLoad(all)).resolves.toBe("unsupported");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("never rejects, whatever the platform does", async () => {
    // A page that failed to load because the location courtesy call threw
    // would be a far worse bug than this feature is a benefit.
    const { all } = deps({
      permission: () => Promise.reject(new Error("nope")),
    });
    await expect(requestLocationOnLoad(all)).resolves.toBe("unsupported");

    const throwing = deps({
      hasFix: () => {
        throw new Error("boom");
      },
    });
    await expect(requestLocationOnLoad(throwing.all)).resolves.toBe(
      "unsupported",
    );
  });
});
