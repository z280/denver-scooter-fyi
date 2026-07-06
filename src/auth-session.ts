// Shared session persistence for the alternative sign-in doors (Google,
// magic link). The whole rest of the app reads auth state through
// map-auth.js — getAuth()/isAuthenticated()/apiFetch() and, in api.ts,
// fetchDevicesAuto(). All of those key off ONE thing: a JSON blob under
// sessionStorage["scooter_fyi.map_auth"] shaped { token, expires }.
//
// map-auth.js is a verbatim upstream copy that must not be modified, so
// rather than teach it new sign-in flows, the Google / magic-link modules
// just write that same blob here. Once written, every gated feature (the
// private device fetch, the "Unlock in Veo" button, the account drawer)
// treats the user as signed in with zero further changes.
//
// NOTE on longevity: map-auth uses sessionStorage, so these sessions live
// for the tab's lifetime. docs/API_REQUIREMENTS.md §2.1 calls for longer
// rider sessions in localStorage with a silent refresh; that's a follow-up
// that would move this key and add a refresh call. Matching the existing
// sessionStorage contract now is what makes the doors work with the current
// app untouched.

import { API_BASE } from "./api.ts";
import { getAuth } from "./map-auth.js";

/** Mirror of map-auth.js's private STORAGE_KEY. */
export const AUTH_STORAGE_KEY = "scooter_fyi.map_auth";

/** The minimal session the API mints and map-auth reads back. */
export interface Session {
  token: string;
  expires: string; // ISO 8601
  issued_at?: string;
}

/** True when a payload from an auth endpoint looks like a usable session. */
export function isSession(v: unknown): v is Session {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Session).token === "string" &&
    typeof (v as Session).expires === "string"
  );
}

/** Persist a freshly-minted session so map-auth picks it up. */
export function persistSession(session: Session): void {
  try {
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable (private mode) — the sign-in simply won't stick */
  }
}

/** Drop the stored session (local sign-out). */
export function clearSession(): void {
  try {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Identity for the current session, from GET /api/v1/auth/session
 *  (docs/API_REQUIREMENTS.md §2.1). The token alone carries no identity, so
 *  this is how the UI learns the email / scopes to decide what to show. */
export interface SessionInfo {
  email?: string;
  scopes?: string[];
  supporter?: boolean;
  admin?: boolean;
  expires?: string;
}

/** Fetch the current session's identity, or null if not signed in / the
 *  endpoint is unreachable (so the UI degrades to "just signed in"). */
export async function fetchSessionInfo(): Promise<SessionInfo | null> {
  const auth = getAuth();
  if (!auth) return null;
  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/session`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionInfo;
  } catch {
    return null;
  }
}

/** Whether the session has administrator rights. Trusts ONLY the server's
 *  admin signal (an `admin` flag or `admin` scope). Admin is Google-exclusive:
 *  the API stamps the scope from the verified allowlisted email and
 *  deliberately withholds it from magic-link sessions even for allowlisted
 *  emails. A client-side email-allowlist fallback would falsely surface
 *  "Administrator Mode" for those magic-link sessions, so there is none. */
export function isAdminSession(info: SessionInfo | null): boolean {
  if (!info) return false;
  return info.admin === true || (info.scopes?.includes("admin") ?? false);
}
