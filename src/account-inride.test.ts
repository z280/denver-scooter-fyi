// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildInRidePanel } from "./account-inride.ts";
import { _resetFavoritesForTests } from "./favorites.ts";
import { savedRatePlan } from "./ride-cost.ts";
import { showsCostHud, speedometerStyle } from "./ride-display-prefs.ts";

const fakeStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

let host: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  _resetFavoritesForTests();
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.append(host);
});

const select = (label: string): HTMLSelectElement =>
  [...host.querySelectorAll<HTMLSelectElement>("select")].find(
    (s) => s.getAttribute("aria-label") === label,
  )!;

const change = (node: HTMLSelectElement | HTMLInputElement): void => {
  node.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("the speedometer control", () => {
  it("offers exactly Classic, Digital and Hidden", () => {
    buildInRidePanel(host);
    expect([...select("Speedometer").options].map((o) => o.textContent)).toEqual([
      "Classic",
      "Digital",
      "Hidden",
    ]);
  });

  it("opens on the stored style and saves a change", () => {
    buildInRidePanel(host);
    expect(select("Speedometer").value).toBe("classic");

    const s = select("Speedometer");
    s.value = "digital";
    change(s);
    expect(speedometerStyle()).toBe("digital");
  });

  it("explains that Classic means BOTH readouts, not just the dial", () => {
    // The names do not describe themselves: `ride-hud.ts` reads one field into
    // two flags, so "classic" lights the dial AND the digital mph. A rider
    // choosing between three words needs telling which.
    buildInRidePanel(host);
    const s = select("Speedometer");
    const hintOf = (): string =>
      s.parentElement?.querySelector(".account-hint")?.textContent ?? "";
    expect(hintOf()).toMatch(/analog/i);
    expect(hintOf()).toMatch(/digital/i);

    s.value = "none";
    change(s);
    expect(hintOf()).toMatch(/no speed/i);
  });
});

describe("the Veo cost toggle", () => {
  it("starts on and persists being switched off", () => {
    buildInRidePanel(host);
    const box = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0];
    expect(box.checked).toBe(true);

    box.checked = false;
    change(box);
    expect(showsCostHud()).toBe(false);
  });

  it("says where it does not apply, so an own-device ride is not a surprise", () => {
    buildInRidePanel(host);
    expect(host.textContent).toMatch(/own scooter or bike/i);
  });
});

describe("the rate plan control", () => {
  it("shows full-price visitor as the standing assumption, not a blank prompt", () => {
    // The app ALREADY prices against this default for a rider who has not
    // chosen (`DEFAULT_RATE_PLAN`), so a "choose one…" placeholder would hide
    // the assumption every estimate is already making.
    buildInRidePanel(host);
    expect(select("Rate plan").value).toBe("visitor");
    expect(host.textContent).toMatch(/until you pick/i);
  });

  it("offers the Pass variants in the same list, with no separate Pass control", () => {
    buildInRidePanel(host);
    const values = [...select("Rate plan").options].map((o) => o.value);
    expect(values).toContain("resident");
    expect(values).toContain("resident_plus");
    expect(values).toContain("equity");
  });

  it("writes a pick to the device cache the HUD reads", () => {
    buildInRidePanel(host);
    const s = select("Rate plan");
    s.value = "equity";
    change(s);
    // This is the value the HUD's cost ticker reads synchronously while a ride
    // starts; it cannot wait for a profile GET.
    expect(savedRatePlan()).toBe("equity");
  });

  it("works signed out — nothing here waits for an account", () => {
    // No deps, no token, no API. The whole reason this panel is its own module.
    const handle = buildInRidePanel(host);
    const s = select("Rate plan");
    s.value = "resident";
    change(s);
    expect(savedRatePlan()).toBe("resident");
    handle.dispose();
  });

  it("takes the account's answer without echoing a save back", () => {
    const handle = buildInRidePanel(host);
    const s = select("Rate plan");
    // Whatever the account resolved wins the display...
    handle.setRatePlan("equity");
    expect(s.value).toBe("equity");
    // ...but it must not look like a rider's pick: assigning `.value` fires no
    // `change`, so nothing was written to the device cache.
    expect(savedRatePlan()).toBeNull();
  });

  it("drops the assumption note once a plan is actually known", () => {
    const handle = buildInRidePanel(host);
    const note = [...host.querySelectorAll<HTMLElement>(".account-hint")].find((n) =>
      /until you pick/i.test(n.textContent ?? ""),
    )!;
    expect(note.hidden).toBe(false);
    handle.setRatePlan("resident");
    expect(note.hidden).toBe(true);
  });

  it("surfaces the account's sync outcome", () => {
    const handle = buildInRidePanel(host);
    handle.setRateStatus("Saved to your account.");
    expect(host.textContent).toContain("Saved to your account.");
    handle.setRateStatus("Couldn't sync.", true);
    expect(
      host.querySelector(".account-magic-status--error")?.textContent,
    ).toBe("Couldn't sync.");
  });
});


describe("refresh", () => {
  it("re-reads every control, since the HUD can change the plan mid-ride", () => {
    const handle = buildInRidePanel(host);
    // The wrench panel's Rate select writes the same cache this reads.
    localStorage.setItem("scooter_fyi.rate_plan", "equity");
    localStorage.setItem("scooter-fyi-speedometer", "none");
    localStorage.setItem("scooter-fyi-cost-hud", "0");

    handle.refresh();

    expect(select("Rate plan").value).toBe("equity");
    expect(select("Speedometer").value).toBe("none");
    expect(
      [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0].checked,
    ).toBe(false);
  });
});
