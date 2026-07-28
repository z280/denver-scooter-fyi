// Email sign-in — magic link + verification code (Postmark-delivered).
//
// Two independent doors on the same email, matching the veo-audit backend
// (see the backend's API.md, "Accounts & sessions"). Each sends its OWN email:
//   • Link door:
//       1. requestMagicLink(email) → POST /api/v1/auth/magic-link → 202. The
//          API emails a one-time link like
//          https://denver.scooter.fyi/auth?ml=<token> (15-minute TTL).
//       2. The user taps it and lands back here; consumePendingMagicLink() at
//          startup exchanges ?ml=<token> at POST /api/v1/auth/redeem for the
//          bearer session.
//   • Code door:
//       1. requestLoginCode(email) → POST /api/v1/auth/code → 202. The API
//          emails a short AA000AA code (2 letters, 3 digits, 2 letters;
//          10-minute TTL).
//       2. The user types it; verifyEmailCode(email, code) exchanges it at
//          POST /api/v1/auth/code/verify for the session.
//   Either way we persist the returned {token, expires} session.
//
// No third-party script, no client id — email sign-in is the lighter door.
// consumePendingMagicLink() is inert unless a ?ml= param is present, and the
// code calls only run on user action, so all of this stays dormant until the
// user signs in.

import { API_BASE } from "./api.ts";
import { isSession, persistSession } from "./auth-session.ts";

/** Query param carrying the one-time token on the return link. */
const MAGIC_PARAM = "ml";

/** Carries the HTTP status so the UI can distinguish a rate-limit (429) from
 *  a generic failure and say something honest about it. */
export class AuthSendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthSendError";
  }
}

/** Loose email sanity check — the API is the real validator; this just keeps
 *  obviously-bad input from generating a request. */
export function isProbablyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Uppercase and drop spaces/hyphens the user may have typed, matching the
 *  backend's normalization before it validates/hashes the code. */
export function normalizeCode(value: string): string {
  return (value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Lenient shape check for the emailed code. The server is the authority on
 *  the exact format (AA000AA today); we deliberately don't hardcode it here so
 *  a future format change can't make the client silently reject a valid code.
 *  We only block obviously-incomplete input (anything 6–10 alphanumerics, once
 *  spaces/hyphens are stripped, earns a real verify attempt). */
export function isProbablyCode(value: string): boolean {
  return /^[A-Z0-9]{6,10}$/.test(normalizeCode(value));
}

/**
 * Ask the API to email a sign-in link. Resolves on success (202/200). The
 * caller should show a neutral "check your email" message regardless of
 * whether the address has an account.
 */
export async function requestMagicLink(email: string): Promise<void> {
  const trimmed = email.trim();
  if (!isProbablyEmail(trimmed)) throw new Error("Enter a valid email address");
  const res = await fetch(`${API_BASE}/api/v1/auth/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: trimmed }),
  });
  // 202 Accepted is the documented success; tolerate 200 too.
  if (res.status !== 202 && res.status !== 200) {
    throw new AuthSendError(
      res.status,
      `Could not send sign-in link (HTTP ${res.status})`,
    );
  }
}

/**
 * Ask the API to email a short AA000AA sign-in code (POST /api/v1/auth/code).
 * Separate email from the magic link. Resolves on success (202/200); the
 * caller then shows the code-entry step.
 */
export async function requestLoginCode(email: string): Promise<void> {
  const trimmed = email.trim();
  if (!isProbablyEmail(trimmed)) throw new Error("Enter a valid email address");
  const res = await fetch(`${API_BASE}/api/v1/auth/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: trimmed }),
  });
  if (res.status !== 202 && res.status !== 200) {
    throw new AuthSendError(
      res.status,
      `Could not send sign-in code (HTTP ${res.status})`,
    );
  }
}

/** Exchange a one-time token for a session and persist it. */
export async function redeemMagicLink(token: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/auth/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    throw new Error(`Sign-in link invalid or expired (HTTP ${res.status})`);
  }
  const data: unknown = await res.json();
  if (!isSession(data)) throw new Error("Sign-in link returned no session");
  persistSession(data);
}

/**
 * Exchange an emailed AA000AA verification code (with the email it was sent
 * to) for a session and persist it (POST /api/v1/auth/code/verify). Mirrors
 * redeemMagicLink for the code door — the API burns the code on success, and
 * caps wrong tries. Throws on a wrong/expired code.
 */
export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/auth/code/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // Backend normalizes too, but send it clean (uppercased, separators
    // stripped) so what we validate is what we submit.
    body: JSON.stringify({ email: email.trim(), code: normalizeCode(code) }),
  });
  if (!res.ok) {
    throw new AuthSendError(
      res.status,
      `Code invalid or expired (HTTP ${res.status})`,
    );
  }
  const data: unknown = await res.json();
  if (!isSession(data)) throw new Error("Verification returned no session");
  persistSession(data);
}

/**
 * If the current URL carries ?ml=<token>, redeem it and strip the param from
 * the address bar (so a refresh doesn't retry a burned token). Returns true
 * only when a token was present AND successfully redeemed. Safe to call
 * unconditionally at startup — with no param it does nothing.
 */
export async function consumePendingMagicLink(): Promise<boolean> {
  const url = new URL(location.href);
  const token = url.searchParams.get(MAGIC_PARAM);
  if (!token) return false;
  let ok = false;
  try {
    await redeemMagicLink(token);
    ok = true;
  } catch (e) {
    console.error("magic-link redemption failed", e);
  } finally {
    url.searchParams.delete(MAGIC_PARAM);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  return ok;
}
