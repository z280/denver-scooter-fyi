// @vitest-environment happy-dom
//
// The signed-in account surface. These cover the mounting contract the tabbed
// drawer depends on — which sections land in which panel, and that the
// untabbed layout still renders everything in one body — rather than
// re-testing each editor, which the sections own.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchProfile: vi.fn(),
  updateProfile: vi.fn(),
  fetchAdjectives: vi.fn(),
  fetchEmojiNouns: vi.fn(),
  fetchRoyaltyTitles: vi.fn(),
  fetchRulingColors: vi.fn(),
  fetchPoints: vi.fn(),
  regenerateUsername: vi.fn(),
  setUsername: vi.fn(),
  requestPhoneCode: vi.fn(),
  verifyPhoneNumber: vi.fn(),
}));

vi.mock("./api.ts", async () => {
  const actual = await vi.importActual<typeof import("./api.ts")>("./api.ts");
  // ApiError is compared with instanceof, so the real class has to survive.
  return { ...actual, ...api };
});
vi.mock("./auth-session.ts", () => ({
  fetchSessionInfo: vi.fn().mockResolvedValue({ email: "rider@example.com" }),
  isAdminSession: vi.fn().mockReturnValue(false),
}));
vi.mock("./map-auth.js", () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./geocode.ts", () => ({ reverseGeocode: vi.fn().mockResolvedValue(null) }));

import { renderSignedInAccount, type AccountPanelMounts } from "./account.ts";
import type { Profile } from "./api.ts";

const PROFILE: Profile = {
  email: "rider@example.com",
  phone_number: "+13035550123",
  phone_verified: true,
  sms_opted_out: false,
  public_username: "brave🦉owl",
  show_public_username: true,
  show_in_leaderboards: false,
  rate_plan: "resident",
  theme: null,
  favorites: [],
  home_lat: 39.7392,
  home_lng: -104.9876,
  work_lat: null,
  work_lng: null,
  royalty_title: "Queen",
  display_name: "Queen brave🦉owl",
  ruling_color: null,
  ruling_border_color: null,
  ruling_alpha: null,
  badges: [],
} as unknown as Profile;

const AUTH = { token: "tok", expires: new Date(Date.now() + 3_600_000).toISOString() };

let body: HTMLElement;

const deps = () => ({ setAdminSession: vi.fn(), onAuthLost: vi.fn() });

const makeMounts = (): AccountPanelMounts => {
  const mk = (id: string): HTMLElement => {
    const n = document.createElement("div");
    n.dataset.panel = id;
    document.body.append(n);
    return n;
  };
  return { login: mk("login"), profile: mk("profile"), community: mk("community") };
};

/** Let the profile GET and the sections it builds settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

beforeEach(() => {
  document.body.replaceChildren();
  // Stubbed rather than trusted: the disclosure and the rate-plan cache both
  // write here, and real storage would leak state between tests.
  const fakeStorage = () => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  };
  vi.stubGlobal("sessionStorage", fakeStorage());
  vi.stubGlobal("localStorage", fakeStorage());
  body = document.createElement("section");
  document.body.append(body);
  api.fetchProfile.mockResolvedValue(PROFILE);
  api.updateProfile.mockResolvedValue(PROFILE);
  api.fetchRoyaltyTitles.mockResolvedValue({ royalty_titles: ["Queen", "King"] });
  api.fetchPoints.mockResolvedValue({ total_points: 0, entries: [] });
  api.fetchAdjectives.mockResolvedValue({ adjectives: ["brave"] });
  api.fetchEmojiNouns.mockResolvedValue({ emoji_nouns: [{ emoji: "🦉", word: "owl" }] });
  api.fetchRulingColors.mockResolvedValue({ ruling_colors: [], taken_pairs: [] });
});

afterEach(() => {
  document.body.replaceChildren();
});

// ---------- the mounting contract ----------

describe("panel mounting", () => {
  it("routes each group to its own panel when tabbed", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    // Login: session status and the way out.
    expect(mounts.login.querySelector(".account-status")).not.toBeNull();
    expect(
      [...mounts.login.querySelectorAll("button")].some(
        (b) => b.textContent === "Sign out",
      ),
    ).toBe(true);

    // Profile: the rider's own details.
    expect(mounts.profile.querySelector(".account-profile")).not.toBeNull();
    const profileText = mounts.profile.textContent ?? "";
    expect(profileText).toContain("Rate plan");
    expect(profileText).toContain("Home location");

    // Community: everything public-facing.
    const communityText = mounts.community.textContent ?? "";
    expect(mounts.community.querySelector(".community-settings")).not.toBeNull();
    expect(communityText).toContain("Public identity");
    expect(communityText).toContain("List me in leaderboards");
    expect(communityText).toContain("Badges");
    expect(communityText).toContain("Points");
  });

  it("keeps the profile's own details out of Community and vice versa", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    expect(mounts.profile.textContent).not.toContain("Public identity");
    expect(mounts.profile.textContent).not.toContain("Badges");
    expect(mounts.community.textContent).not.toContain("Rate plan");
    expect(mounts.community.textContent).not.toContain("Home location");
  });

  it("renders one stack into the body when untabbed", async () => {
    renderSignedInAccount(body, AUTH, deps());
    await settle();

    const text = body.textContent ?? "";
    expect(body.querySelector(".account-status")).not.toBeNull();
    expect(text).toContain("Public identity");
    expect(text).toContain("Rate plan");
    expect(text).toContain("Badges");
    expect(text).toContain("Points");
    expect(text).toContain("List me in leaderboards");
  });
});

// ---------- community settings disclosure ----------

describe("community settings disclosure", () => {
  const toggle = (mounts: AccountPanelMounts) =>
    mounts.community.querySelector<HTMLButtonElement>(
      ".community-settings__toggle",
    )!;
  const inner = (mounts: AccountPanelMounts) =>
    mounts.community.querySelector<HTMLElement>("#community-settings-body")!;

  it("starts open, labelled as a section heading", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    expect(toggle(mounts).getAttribute("aria-expanded")).toBe("true");
    expect(toggle(mounts).textContent).toContain("Community settings");
    expect(inner(mounts).hidden).toBe(false);
    // The control names what it controls, both ways.
    expect(toggle(mounts).getAttribute("aria-controls")).toBe(
      inner(mounts).id,
    );
  });

  it("collapses to a short gear pill and back", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    toggle(mounts).click();
    expect(toggle(mounts).getAttribute("aria-expanded")).toBe("false");
    expect(toggle(mounts).classList.contains("is-collapsed")).toBe(true);
    expect(toggle(mounts).textContent).toContain("Settings");
    expect(inner(mounts).hidden).toBe(true);

    toggle(mounts).click();
    expect(toggle(mounts).getAttribute("aria-expanded")).toBe("true");
    expect(inner(mounts).hidden).toBe(false);
  });

  it("keeps focus on the toggle when collapsing from inside", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    const inside = inner(mounts).querySelector<HTMLElement>("button, input");
    inside?.focus();
    expect(inner(mounts).contains(document.activeElement)).toBe(true);

    toggle(mounts).click();
    expect(document.activeElement).toBe(toggle(mounts));
  });

  it("remembers the collapsed state for the session", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();
    toggle(mounts).click(); // collapse

    // A fresh render (a token change, say) reopens collapsed.
    document.body.replaceChildren();
    const next = makeMounts();
    const body2 = document.createElement("section");
    document.body.append(body2);
    renderSignedInAccount(body2, AUTH, { ...deps(), panels: next });
    await settle();
    expect(toggle(next).getAttribute("aria-expanded")).toBe("false");
  });

  it("links to the leaderboard rather than embedding it", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    const trigger = document.createElement("button");
    trigger.className = "leaderboard-toggle";
    const bar = document.createElement("div");
    bar.className = "topbar__right";
    bar.append(trigger);
    document.body.append(bar);
    const clicked = vi.fn();
    trigger.addEventListener("click", clicked);

    mounts.community
      .querySelector<HTMLButtonElement>(".community-leaderboard button")!
      .click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});

// ---------- picking a location ----------

describe("home and work locations", () => {
  const rowFor = (mounts: AccountPanelMounts, label: string): HTMLElement =>
    [...mounts.profile.querySelectorAll<HTMLElement>(".account-field")].find(
      (r) => r.textContent?.includes(label),
    )!;
  const button = (row: HTMLElement, text: string) =>
    [...row.querySelectorAll("button")].find((b) => b.textContent === text);

  it("only offers 'Pick on map' when a picker was supplied", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();
    expect(button(rowFor(mounts, "Home location"), "Pick on map")?.hidden).toBe(
      true,
    );

    document.body.replaceChildren();
    const next = makeMounts();
    const body2 = document.createElement("section");
    document.body.append(body2);
    renderSignedInAccount(body2, AUTH, {
      ...deps(),
      panels: next,
      pickLocation: async () => null,
    });
    await settle();
    expect(button(rowFor(next, "Home location"), "Pick on map")?.hidden).toBe(
      false,
    );
  });

  it("saves the picked point as a pair, rounded to five decimals", async () => {
    const mounts = makeMounts();
    const pickLocation = vi
      .fn()
      .mockResolvedValue({ lat: 39.739215678, lng: -104.987612345 });
    renderSignedInAccount(body, AUTH, {
      ...deps(),
      panels: mounts,
      pickLocation,
    });
    await settle();

    api.updateProfile.mockClear();
    button(rowFor(mounts, "Work location"), "Pick on map")!.click();
    await settle();

    expect(pickLocation).toHaveBeenCalledWith("work");
    // Both halves together, per the API contract; ~1 m of precision, which is
    // finer than any of these sources actually resolve.
    expect(api.updateProfile).toHaveBeenCalledWith({
      work_lat: 39.73922,
      work_lng: -104.98761,
    });
  });

  it("writes nothing when the rider cancels the pick", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, {
      ...deps(),
      panels: mounts,
      pickLocation: async () => null,
    });
    await settle();

    api.updateProfile.mockClear();
    button(rowFor(mounts, "Home location"), "Pick on map")!.click();
    await settle();
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it("reports where home and work are so the map can pin them", async () => {
    const onLocationsChanged = vi.fn();
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, {
      ...deps(),
      panels: mounts,
      onLocationsChanged,
    });
    await settle();

    expect(onLocationsChanged).toHaveBeenLastCalledWith({
      home: { lat: 39.7392, lng: -104.9876 },
      work: null,
    });
  });

  it("clears the pins when the panel goes away", async () => {
    const onLocationsChanged = vi.fn();
    const mounts = makeMounts();
    const handle = renderSignedInAccount(body, AUTH, {
      ...deps(),
      panels: mounts,
      onLocationsChanged,
    });
    await settle();

    handle.dispose();
    expect(onLocationsChanged).toHaveBeenLastCalledWith({
      home: null,
      work: null,
    });
  });
});

// ---------- rate plan ----------

describe("rate plan", () => {
  const select = (mounts: AccountPanelMounts) =>
    [...mounts.profile.querySelectorAll<HTMLSelectElement>("select")].find(
      (s) => s.getAttribute("aria-label") === "Rate plan",
    )!;

  it("offers the Pass variants in the same list, no separate control", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    const values = [...select(mounts).options].map((o) => o.value);
    expect(values).toContain("resident");
    expect(values).toContain("resident_plus");
    // Nothing else in Profile is a Pass toggle.
    expect(mounts.profile.textContent).not.toMatch(/VeoPlus Pass\b.*check/i);
  });

  it("shows the account's plan, not whatever this device remembers", async () => {
    api.fetchProfile.mockResolvedValue({ ...PROFILE, rate_plan: "equity" });
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    expect(select(mounts).value).toBe("equity");
  });

  it("saves a change to the account", async () => {
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    api.updateProfile.mockClear();
    const s = select(mounts);
    s.value = "visitor";
    s.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(api.updateProfile).toHaveBeenCalledWith({ rate_plan: "visitor" });
  });

  it("pushes this device's plan up when the account has none yet", async () => {
    // A rider who picked a plan before signing in, or on this device only.
    localStorage.setItem("scooter_fyi.rate_plan", "resident_plus");
    api.fetchProfile.mockResolvedValue({ ...PROFILE, rate_plan: null });
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    // The Pass variant is shown (only this device can know it) and the base
    // plan is sent up, so the two stop disagreeing.
    expect(select(mounts).value).toBe("resident_plus");
    expect(api.updateProfile).toHaveBeenCalledWith({ rate_plan: "resident" });
  });

  it("prompts when neither the account nor the device has a plan", async () => {
    api.fetchProfile.mockResolvedValue({ ...PROFILE, rate_plan: null });
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    expect(select(mounts).value).toBe("");
    // Nothing invented on the rider's behalf.
    const rateWrites = api.updateProfile.mock.calls.filter(
      (c) => "rate_plan" in (c[0] as object),
    );
    expect(rateWrites).toHaveLength(0);
  });
});

// ---------- lifecycle ----------

describe("lifecycle", () => {
  it("refresh() updates the countdown without rebuilding the panel", async () => {
    const mounts = makeMounts();
    const handle = renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    const before = mounts.profile.querySelector(".account-profile");
    handle.refresh();
    expect(mounts.profile.querySelector(".account-profile")).toBe(before);
  });

  it("reports a rejected token through onAuthLost instead of rendering", async () => {
    const { ApiError } = await vi.importActual<typeof import("./api.ts")>("./api.ts");
    api.fetchProfile.mockRejectedValue(
      new ApiError("token rejected", "TOKEN_REJECTED"),
    );
    const d = deps();
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...d, panels: mounts });
    await settle();

    expect(d.onAuthLost).toHaveBeenCalled();
  });

  it("offers a retry when the profile fails to load", async () => {
    api.fetchProfile.mockRejectedValue(new Error("offline"));
    const mounts = makeMounts();
    renderSignedInAccount(body, AUTH, { ...deps(), panels: mounts });
    await settle();

    const err = mounts.profile.querySelector(".account-error");
    expect(err?.getAttribute("role")).toBe("alert");
    expect(
      [...mounts.profile.querySelectorAll("button")].some(
        (b) => b.textContent === "Retry",
      ),
    ).toBe(true);
  });
});
