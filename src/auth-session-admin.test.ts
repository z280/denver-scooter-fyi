// isAdminSession — which signal in GET /api/v1/auth/session means "admin".
//
// The API's `admin` boolean is the authorization answer (`is_admin_email`,
// either sign-in door). The `admin` SCOPE only records that the Google door
// was used, and it stopped gating access server-side. Reading the scope as
// "is this an admin" is what left an allowlisted operator signed in by magic
// link admin to every endpoint while the map showed no Administrator Mode and
// blocked ▶️ Start in Veo and 🧭 Use in Ride Mode at any distance.
import { describe, expect, it } from "vitest";

import { isAdminSession } from "./auth-session.ts";

describe("isAdminSession", () => {
  it("trusts the server's admin boolean — the magic-link admin case", () => {
    // No admin scope will ever be stamped on this session, and it is still
    // admin to every endpoint that matters.
    expect(
      isAdminSession({ email: "boss@example.com", scopes: ["rider"], admin: true }),
    ).toBe(true);
  });

  it("still honours the scope, for sessions minted before the flag existed", () => {
    expect(
      isAdminSession({ email: "boss@example.com", scopes: ["rider", "admin"] }),
    ).toBe(true);
  });

  it("is false for an ordinary rider", () => {
    expect(
      isAdminSession({ email: "rider@example.com", scopes: ["rider"] }),
    ).toBe(false);
  });

  it("takes admin: false at its word even if something else looks adminish", () => {
    // The server said no. There is no client-side second opinion — no email
    // allowlist, no inference from the address.
    expect(
      isAdminSession({ email: "admin@example.com", scopes: ["rider"], admin: false }),
    ).toBe(false);
  });

  it("is false with no session at all", () => {
    expect(isAdminSession(null)).toBe(false);
  });

  it("survives a response missing scopes entirely", () => {
    expect(isAdminSession({ email: "boss@example.com", admin: true })).toBe(true);
    expect(isAdminSession({ email: "rider@example.com" })).toBe(false);
  });
});
