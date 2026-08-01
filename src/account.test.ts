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
