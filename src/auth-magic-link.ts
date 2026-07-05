// Sign in with a magic link (Postmark-delivered).
//
// Two steps, mapped to docs/API_REQUIREMENTS.md §2.3:
//   1. requestMagicLink(email) → POST /api/v1/auth/magic-link. The API always
//      answers 202 (no account-existence oracle) and emails a one-time link
//      like https://denver.scooter.fyi/auth?ml=<token>.
//   2. The user taps that link and lands back on the site; redeemMagicLink()
//      (via consumePendingMagicLink() at startup) exchanges ?ml=<token> at
//      POST /api/v1/auth/redeem for the bearer session, which we persist.
//
// No third-party script, no client id — magic links are the lighter first
// door. This module is safe to wire at startup now: consumePendingMagicLink()
// is inert unless a ?ml= param is actually present, so it stays dormant until
// the endpoints exist and a real link is followed.

import { API_BASE } from "./api.ts";
import { isSession, persistSession } from "./auth-session.ts";

/** Query param carrying the one-time token on the return link. */
const MAGIC_PARAM = "ml";

/** Loose email sanity check — the API is the real validator; this just keeps
 *  obviously-bad input from generating a request. */
export function isProbablyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
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
    throw new Error(`Could not send sign-in link (HTTP ${res.status})`);
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
