// map-auth.js — the browser-side session store for data.scooter.fyi.
//
// Despite the name, the GitHub "map-auth" OAuth flow this file was written
// for is gone: veo-audit 2661e78 removed /map-auth/denver, /map-auth/callback
// and /map-auth/logout end to end. What survives is the *storage half*, which
// is very much load-bearing — a {token, expires} blob under
// sessionStorage["scooter_fyi.map_auth"] that getAuth()/isAuthenticated()
// read back. The current sign-in doors (Google, magic link, typed code — see
// auth-session.ts) write that same blob, so every gated feature keys off this
// module. The retired redirect sign-in (signIn(), the /auth-callback landing
// page) has been removed; signOut() now revokes against the live
// POST /api/v1/auth/signout documented in the backend's API.md.

const STORAGE_KEY = "scooter_fyi.map_auth";
const API_BASE = "https://data.scooter.fyi";

/** Read the stashed auth blob; returns null if missing or expired. */
export function getAuth() {
  let raw;
  try { raw = sessionStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  if (!parsed || !parsed.token || !parsed.expires) return null;
  if (new Date(parsed.expires) <= new Date()) {
    // Expired — clear so we don't keep sending dead tokens.
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
    return null;
  }
  return parsed;
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
  try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
}
