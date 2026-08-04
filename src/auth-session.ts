// Shared session persistence for the sign-in doors (Google, magic link,
// typed code, SMS). The whole rest of the app reads auth state through
// map-auth.js — getAuth()/isAuthenticated() and, in api.ts,
// fetchDevicesAuto(). All of those key off ONE thing: a JSON blob under
// storage["scooter_fyi.map_auth"] shaped { token, expires }.
//
// map-auth.js is now just the accessor trio over that blob: its own retired
// GitHub redirect sign-in is gone, and the sign-in doors write the blob here
// instead. Once written, every gated feature (the private device fetch, the
// "Unlock in Veo" button, the account drawer) treats the user as signed in
// with zero further changes.
//
// LONGEVITY (ride-mode phase F1): the blob lives in **localStorage** now, not
// sessionStorage — a tab-lifetime session cannot survive the tab churn an
// in-ride flow causes (the Veo app handoff, a magic-link round trip, a reload
// mid-ride), and everything in-ride depends on the session outliving the tab.
// auth-storage.ts owns that move, including the one-time promote of any
// pre-migration sessionStorage blob. This module adds the other half the
// backend's API.md ("Accounts & sessions") specifies: rider sessions are
// 30-day **sliding**, extended by POST /api/v1/auth/refresh — see the silent
// refresh at the bottom of this file, and read its guards before touching it.

import { ApiError, API_BASE, authedFetchJSON } from "./api.ts";
import {
  AUTH_STORAGE_KEY as STORAGE_KEY,
  type StoredSession,
  clearStoredSession,
  isSessionStale,
  readLiveSession,
  readStoredSession,
  replaceStoredSession,
  withRotationStamp,
  writeStoredSession,
} from "./auth-storage.ts";
import { getAuth } from "./map-auth.js";

/** The session blob's storage key. Owned by auth-storage.ts; re-exported here
 *  because this module was the mirror callers used to import it from. */
export const AUTH_STORAGE_KEY = STORAGE_KEY;

/** The minimal session the API mints and map-auth reads back. Same shape the
 *  storage layer persists (it adds the client-stamped `rotated_at`). */
export type Session = StoredSession;

/** True when a payload from an auth endpoint looks like a usable session. */
export function isSession(v: unknown): v is Session {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Session).token === "string" &&
    typeof (v as Session).expires === "string"
  );
}

/** Persist a freshly-minted session so map-auth picks it up. Stamped with the
 *  local write time, which is what the silent refresh's staleness clock reads —
 *  a rider who just signed in must not be refreshed on their next load.
 *  Returns false when storage rejected the write (private mode), so a caller
 *  can say the sign-in won't stick rather than implying it saved. */
export function persistSession(session: Session): boolean {
  return writeStoredSession(withRotationStamp(session));
}

/** Drop the stored session (local sign-out). */
export function clearSession(): void {
  clearStoredSession();
}

/** Identity for the current session, from GET /api/v1/auth/session
 *  (see the backend's API.md). The token alone carries no identity, so
 *  this is how the UI learns the email / scopes to decide what to show. */
export interface SessionInfo {
  email?: string;
  scopes?: string[];
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
 *  admin signal, and `info.admin` is the one that answers the question:
 *  the API sets it from `is_admin_email` — the allowlist check `/private/*`
 *  actually enforces, which accepts EITHER sign-in door.
 *
 *  The `admin` SCOPE is kept in the check for older sessions only. It is a
 *  Google-exclusive marker of which door was used, and it stopped gating
 *  access on the API side; reading it as "is this an admin" is what left an
 *  allowlisted operator signed in by magic link admin to every endpoint
 *  while the map showed them no Administrator Mode and blocked the
 *  proximity-gated buttons at any distance.
 *
 *  Still no client-side email-allowlist fallback: the server decides. */
export function isAdminSession(info: SessionInfo | null): boolean {
  if (!info) return false;
  return info.admin === true || (info.scopes?.includes("admin") ?? false);
}

// ---------------------------------------------------------------------------
// Silent refresh (ride-mode phase F1)
// ---------------------------------------------------------------------------
// Rider sessions slide: POST /api/v1/auth/refresh returns the same
// `{token, expires}` blob with a fresh 30 days. It is NOT a free call —
// it rotates and REVOKES the presented token in one transaction, and is
// limited to 60/h per account. Two consequences shape everything below:
//
//  1. Refreshing on every load is a multi-tab race. Tab B refreshes the token
//     tab A just rotated, gets a 401 for a token that is no longer the stored
//     one, and an unconditional "401 → clear the blob" (which is what api.ts
//     did) signs out tab A's perfectly VALID session. Guard: api.ts now clears
//     only when the rejected token is still the stored token
//     (`clearStoredSessionIfToken`), and the write below is a compare-and-set
//     against the token we presented.
//  2. There is no reason to refresh a token we minted an hour ago. Guard: only
//     when the blob is stale — REFRESH_STALE_MS (24 h) since the last local
//     write, which `persistSession`/`replaceStoredSession` stamp into the blob
//     as `rotated_at`. A blob with no stamp (pre-F1, or promoted out of
//     sessionStorage) reads as stale and gets exactly one rotation, which is
//     how a legacy tab-lifetime session becomes a 30-day sliding one.
//
// Nothing here ever surfaces an error to the rider: a network failure or a 5xx
// leaves the existing session exactly as it was, and the token stays valid
// until its own expiry.

/** What the silent refresh did, for callers that want to log or react.
 *  - `no_session` — signed out (or the blob expired and self-cleared).
 *  - `fresh`       — a token younger than REFRESH_STALE_MS; no request sent.
 *  - `rotated`     — a new token is stored.
 *  - `raced`       — another tab won; its session is stored and intact. Not an
 *                    error, and specifically NOT a sign-out.
 *  - `signed_out`  — the server rejected the token we still hold; cleared.
 *  - `error`       — network/5xx/garbage response; the session is untouched. */
export type RefreshOutcome =
  | "no_session"
  | "fresh"
  | "rotated"
  | "raced"
  | "signed_out"
  | "error";

let silentRefresh: Promise<RefreshOutcome> | null = null;

async function runSilentRefresh(nowMs: number): Promise<RefreshOutcome> {
  // readLiveSession() also applies the expiry self-clear, so an already-dead
  // token is never presented to the endpoint.
  const current = readLiveSession();
  if (!current) return "no_session";
  if (!isSessionStale(current, nowMs)) return "fresh";

  let rotated: unknown;
  try {
    rotated = await authedFetchJSON<unknown>("/api/v1/auth/refresh", {
      method: "POST",
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === "TOKEN_REJECTED") {
      // api.ts re-read storage before clearing: a blob still present means it
      // holds someone else's freshly rotated token, not ours.
      return readStoredSession() ? "raced" : "signed_out";
    }
    if (err instanceof ApiError && err.code === "NO_AUTH") return "no_session";
    return "error";
  }
  if (!isSession(rotated)) return "error";
  // Compare-and-set: if the stored token changed while the request was in
  // flight, that session is the live one — drop ours rather than clobber it.
  return replaceStoredSession(current.token, rotated, nowMs)
    ? "rotated"
    : "raced";
}

/** Rotate the stored token if it is stale — the "silent refresh on load".
 *
 *  Fire-and-forget from `main.ts` (`void refreshSessionIfStale()`); it never
 *  throws and never blocks first render. Memoized for the page load: repeat
 *  calls get the same promise, so no amount of re-entry can spend more than
 *  one of the account's 60 refreshes per hour. `nowMs` is an injection point
 *  for tests, not a scheduling knob. */
export function refreshSessionIfStale(
  nowMs = Date.now(),
): Promise<RefreshOutcome> {
  silentRefresh ??= runSilentRefresh(nowMs);
  return silentRefresh;
}
