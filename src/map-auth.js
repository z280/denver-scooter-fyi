// map-auth.js — the browser-side session accessors for data.scooter.fyi.
//
// Despite the name, the GitHub "map-auth" OAuth flow this file was written
// for is gone: veo-audit 2661e78 removed /map-auth/denver, /map-auth/callback
// and /map-auth/logout end to end. What survives is the *storage half*, which
// is very much load-bearing — a {token, expires} blob under
// storage["scooter_fyi.map_auth"] that getAuth()/isAuthenticated() read back.
// The current sign-in doors (Google, magic link, typed code, SMS — see
// auth-session.ts) write that same blob, so every gated feature keys off this
// module. The retired redirect sign-in (signIn(), the /auth-callback landing
// page) has been removed; signOut() now revokes against the live
// POST /api/v1/auth/signout documented in the backend's API.md.
//
// Ride-mode phase F1 moved the blob from sessionStorage to localStorage (same
// key, one-time promote of any pre-migration sessionStorage copy) and moved
// every storage detail into auth-storage.ts, which is now the single owner of
// the key, the JSON shape, the expiry self-clear and the rotation stamp. This
// file is deliberately left as the thin accessor trio the whole app imports:
// getAuth / isAuthenticated / signOut, unchanged in behavior.

import { clearStoredSession, readLiveSession } from "./auth-storage.ts";

const API_BASE = "https://data.scooter.fyi";

/** Read the stashed auth blob; returns null if missing or expired. An expired
 *  blob is cleared on the way out, so dead tokens stop being sent. */
export function getAuth() {
  return readLiveSession();
}

/** True if a non-expired token is present. */
export function isAuthenticated() {
  return getAuth() !== null;
}

/** Best-effort server-side revoke + local clear. The revoke is idempotent
 *  server-side and "must never fail the client", so a network error or a
 *  non-2xx is ignored — the local clear below is what the UI keys off. */
export async function signOut() {
  const auth = getAuth();
  if (auth) {
    try {
      await fetch(API_BASE + "/api/v1/auth/signout", {
        method: "POST",
        headers: { "Authorization": "Bearer " + auth.token },
      });
    } catch (e) { /* network error — we still clear locally */ }
  }
  clearStoredSession();
}
