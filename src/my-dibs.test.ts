// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { countdownFor, formatCountdown, wireMyDibs } from "./my-dibs.ts";
import { DIBS_START_GRACE_MS, type Dibs } from "./dibs.ts";

const T0 = 1_770_000_000_000;

function claim(over: Partial<Dibs> = {}): Dibs {
  return {
    vehicleIdentifier: "aaaa1111bbbb2222",
    vehicleName: "Lunar 🐸 928",
    claimedBy: "Resourceful 🌈",
    claimedAt: T0,
    startedWalkingAt: null,
    registration: null,
    // `isValid` (dibs.ts) requires all four of these to be finite numbers —
    // a fixture without them is silently dropped by `loadDibs`, which is
    // exactly what the first version of this file discovered.
    lat: 39.7392,
    lon: -104.9903,
    startMeters: 300,
    bestMeters: 300,
    ...over,
  } as Dibs;
}

describe("the countdown", () => {
  it("reads as a clock, not a quantity", () => {
    expect(formatCountdown(247_000)).toBe("4:07");
    expect(formatCountdown(9_000)).toBe("0:09");
  });

  it("never counts past zero", () => {
    // An expired claim is removed, not shown running backwards.
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  it("counts the GRACE before the rider sets off", () => {
    // The deadline they can still lose the claim to is the ten minutes to
    // start moving — not the claim's own expiry, which is further away and
    // not the thing about to hurt them.
    const { label, ms } = countdownFor(claim(), T0 + 60_000);
    expect(label).toBe("to set off");
    expect(ms).toBe(DIBS_START_GRACE_MS - 60_000);
  });

  it("switches to the claim's own expiry once they are walking", () => {
    const { label } = countdownFor(
      claim({ startedWalkingAt: T0 + 30_000 }),
      T0 + 60_000,
    );
    expect(label).toBe("left");
  });

  it("marks the last three minutes of grace urgent", () => {
    const calm = countdownFor(claim(), T0 + 5 * 60_000);
    const late = countdownFor(claim(), T0 + 8 * 60_000);
    expect(calm.urgent).toBe(false);
    expect(late.urgent).toBe(true);
  });
});

describe("the My dibs list", () => {
  let section: HTMLElement;
  let list: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    section = document.createElement("section");
    list = document.createElement("ul");
    section.append(list);
    document.body.append(section);
  });

  const mount = (over: Partial<Parameters<typeof wireMyDibs>[0]> = {}) =>
    wireMyDibs({
      section,
      list,
      onOpenCertificate: () => {},
      onRelease: () => {},
      onChanged: () => {},
      now: () => T0,
      ...over,
    });

  it("hides the whole section when nothing is held", () => {
    // An empty "My dibs" heading is a permanent reminder of a feature you
    // are not using.
    const h = mount();
    expect(section.hidden).toBe(true);
    h.destroy();
  });

  it("shows a row per held claim, with its clock", () => {
    localStorage.setItem(
      "scooter-fyi-dibs",
      JSON.stringify({ v: 1, dibs: [claim()] }),
    );
    const h = mount();
    expect(section.hidden).toBe(false);
    expect(list.querySelectorAll(".my-dibs__row")).toHaveLength(1);
    expect(list.textContent).toContain("Lunar 🐸 928");
    expect(list.querySelector(".my-dibs__clock")?.textContent).toContain("to set off");
    h.destroy();
  });

  it("releases LOCALLY and tells the server, in that order", () => {
    // Local first so the button answers instantly; the server call is what
    // every other rider's map reads, and skipping it would leave the claim
    // live for them — and reading as a stranger's to the person who just
    // released it.
    localStorage.setItem(
      "scooter-fyi-dibs",
      JSON.stringify({ v: 1, dibs: [claim()] }),
    );
    const onRelease = vi.fn();
    const onChanged = vi.fn();
    const h = mount({ onRelease, onChanged });

    list.querySelector<HTMLButtonElement>(".my-dibs__btn--release")!.click();

    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Gone from storage, and the section folds away with it.
    expect(localStorage.getItem("scooter-fyi-dibs")).not.toContain("aaaa1111bbbb2222");
    expect(section.hidden).toBe(true);
    h.destroy();
  });

  it("stops ticking once destroyed", () => {
    // The interval outliving the panel would repaint a detached list forever.
    const clear = vi.spyOn(window, "clearInterval");
    mount().destroy();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
