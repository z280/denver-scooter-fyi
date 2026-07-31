// auth-storage.ts — the ONE owner of the browser-side session blob.
//
// Before ride mode, three files each open-coded the same storage access:
// map-auth.js (`getAuth`/`signOut`), auth-session.ts (`persistSession`/
// `clearSession`) and api.ts (the 401 clear). Every one of them named the key
// itself and reached straight for `sessionStorage`, so "update all the mirrors
// together" was a manual, forgettable chore. This module is that chore's
// replacement: the key, the JSON shape, the try/catch degradation, the expiry
// self-clear, the one-time sessionStorage promote and the rotation stamp live
// here, and the three callers delegate.
//
// Ride-mode phase F1 moves the blob from sessionStorage to **localStorage**
// under the SAME key, because a tab-lifetime session cannot survive the tab
// churn an in-ride flow causes (a Veo app handoff, a magic-link round trip, a
// reload mid-ride). `promoteLegacySession()` carries any pre-migration
// sessionStorage blob over on first read so the deploy signs nobody out.
//
// Degradation rules, in order of preference:
//   read  — localStorage, then sessionStorage (a legacy blob, or the fallback
//           below). Never throws; unreadable storage reads as "signed out".
//   write — localStorage, falling back to sessionStorage when localStorage
//           rejects the write (private mode). A caller that cares learns the
//           write failed from the returned boolean, the way `saveRatePlan`
//           reports it, instead of claiming the device saved something.

/** The session blob's key. localStorage since F1; sessionStorage before it. */
export const AUTH_STORAGE_KEY = "scooter_fyi.map_auth";

/** How old the current token may get before the silent refresh rotates it.
 *  Rider sessions are 30-day sliding (`POST /api/v1/auth/refresh` rotates and
 *  REVOKES the presented token, 60/h per account), so refreshing on every load
 *  would both burn the budget and race other tabs. A day is comfortably inside
 *  the 30-day window and makes the refresh a once-per-day event per device. */
export const REFRESH_STALE_MS = 24 * 60 * 60 * 1000;

/** The persisted session. `token`/`expires` are what the auth endpoints mint
 *  (API.md: "Session-minting endpoints return exactly `{token, expires}`");
 *  the other two are client-stamped and both optional:
 *
 *  - `rotated_at` — when THIS client wrote THIS token (sign-in or refresh).
 *    The silent refresh's staleness clock. A blob without one is either
 *    pre-F1 or promoted from sessionStorage, i.e. of unknown age → stale.
 *  - `issued_at` — only present if a server ever sends it; used as a
 *    fallback stamp. Nothing in the app requires it.
 *
 *  Unknown fields are preserved on read (the blob is stored verbatim), so a
 *  future server addition survives a rotation. */
export interface StoredSession {
  token: string;
  expires: string; // ISO 8601
  issued_at?: string; // ISO 8601, server-sent if at all
  rotated_at?: string; // ISO 8601, stamped locally on write
}

// ---------------------------------------------------------------------------
// Raw web-storage access. Every read/write/remove is wrapped: `localStorage`
// can throw on the property access itself (storage disabled), on getItem, and
// on setItem (private-mode quota of zero), and it is simply absent in a
// non-DOM environment.
// ---------------------------------------------------------------------------

type StorageKind = "local" | "session";

function pick(kind: StorageKind): Storage | null {
  try {
    return (kind === "local" ? localStorage : sessionStorage) ?? null;
  } catch {
    return null;
  }
}

function readRaw(kind: StorageKind): string | null {
  try {
    return pick(kind)?.getItem(AUTH_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(kind: StorageKind, value: string): boolean {
  try {
    const store = pick(kind);
    if (!store) return false;
    store.setItem(AUTH_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

function removeRaw(kind: StorageKind): void {
  try {
    pick(kind)?.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* storage unavailable — there is nothing to clear */
  }
}

/** Drop the pre-migration sessionStorage copy — the housekeeping half of the
 *  promote, and the reason a signed-out session can never come back.
 *
 *  No-op when both globals resolve to the SAME storage object: then the
 *  "legacy" entry and the live one are one and the same, and removing it would
 *  delete the session instead of tidying up after it. Real browsers keep the
 *  two separate, so this only fires where something aliases them — a test that
 *  stubs one fake store for both (api.test.ts does, deliberately, so its cases
 *  pass on either side of this migration) or an exotic embedded webview. */
function dropLegacyCopy(): void {
  const local = pick("local");
  if (local !== null && local === pick("session")) return;
  removeRaw("session");
}

// ---------------------------------------------------------------------------
// Blob shape + clocks
// ---------------------------------------------------------------------------

/** Parse a stored blob, or null when it is missing/corrupt/shapeless. */
export function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const session = parsed as StoredSession;
  if (typeof session.token !== "string" || !session.token) return null;
  if (typeof session.expires !== "string" || !session.expires) return null;
  return session;
}

/** Past its expiry. An unparseable `expires` counts as expired: the token
 *  would 401 on first use anyway, and pretending it is live keeps a dead
 *  session on screen. */
export function isExpired(session: StoredSession, nowMs = Date.now()): boolean {
  const at = Date.parse(session.expires);
  if (!Number.isFinite(at)) return true;
  return at <= nowMs;
}

/** The rotation clock: when this token was written locally, falling back to a
 *  server-sent `issued_at`. Undefined when neither is present or parseable. */
function rotatedAtMs(session: StoredSession): number | undefined {
  for (const stamp of [session.rotated_at, session.issued_at]) {
    if (typeof stamp !== "string" || !stamp) continue;
    const at = Date.parse(stamp);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

/** Whether the silent refresh should rotate this token. Unknown age → stale
 *  (a promoted pre-F1 blob wants exactly one rotation to become a 30-day
 *  sliding session). A stamp in the future is treated as fresh rather than
 *  stale, so a skewed device clock cannot turn every load into a refresh. */
export function isSessionStale(
  session: StoredSession,
  nowMs = Date.now(),
): boolean {
  const at = rotatedAtMs(session);
  if (at === undefined) return true;
  if (at > nowMs) return false;
  return nowMs - at >= REFRESH_STALE_MS;
}

/** Stamp `rotated_at` — call on every locally-originated write (sign-in,
 *  refresh), never on the promote (a promoted blob's age is unknown). */
export function withRotationStamp<T extends StoredSession>(
  session: T,
  nowMs = Date.now(),
): T {
  return { ...session, rotated_at: new Date(nowMs).toISOString() };
}

// ---------------------------------------------------------------------------
// One-time sessionStorage → localStorage promote
// ---------------------------------------------------------------------------

let promoted = false;

/** Move a pre-F1 sessionStorage blob to localStorage. Idempotent and cheap to
 *  call; returns true only when a blob was actually promoted.
 *
 *  Resolution order matters:
 *  - no legacy blob → nothing to do (the common case forever after).
 *  - legacy blob expired → drop it; never promote a dead token.
 *  - localStorage already holds a live session → that one wins (it is either
 *    newer or the same); the legacy copy is removed so it cannot come back.
 *  - otherwise promote, and remove the legacy copy ONLY if the write landed.
 *    A failed write (private mode) keeps the legacy copy as the fallback read
 *    source, so a degraded browser stays signed in for the tab's life exactly
 *    as it did before this migration. */
export function promoteLegacySession(): boolean {
  const legacy = parseStoredSession(readRaw("session"));
  if (!legacy) return false;
  if (isExpired(legacy)) {
    dropLegacyCopy();
    return false;
  }
  const current = parseStoredSession(readRaw("local"));
  if (current && !isExpired(current)) {
    dropLegacyCopy();
    return false;
  }
  if (!writeRaw("local", JSON.stringify(legacy))) return false;
  dropLegacyCopy();
  return true;
}

// ---------------------------------------------------------------------------
// Read / write / clear
// ---------------------------------------------------------------------------

/** The stored session as-is — no expiry filtering. Runs the one-time promote
 *  on the first call of the page load, so no caller has to remember to. */
export function readStoredSession(): StoredSession | null {
  if (!promoted) {
    promoted = true;
    promoteLegacySession();
  }
  return (
    parseStoredSession(readRaw("local")) ??
    // Legacy blob whose promote could not write, or the write fallback below.
    parseStoredSession(readRaw("session"))
  );
}

/** The stored session if it is still live, clearing it if not. This is
 *  `getAuth()`'s body: the expiry self-clear is load-bearing (an expired token
 *  must stop being sent and the UI must fall back to signed-out). */
export function readLiveSession(): StoredSession | null {
  const session = readStoredSession();
  if (!session) return null;
  if (isExpired(session)) {
    clearStoredSession();
    return null;
  }
  return session;
}

/** Persist a session verbatim. localStorage first, sessionStorage as the
 *  private-mode fallback; false when neither accepted the write (the sign-in
 *  then simply won't stick past this page load). */
export function writeStoredSession(session: StoredSession): boolean {
  const raw = JSON.stringify(session);
  if (writeRaw("local", raw)) {
    // A stale legacy copy would otherwise shadow this one on a browser where
    // localStorage later starts throwing.
    dropLegacyCopy();
    return true;
  }
  return writeRaw("session", raw);
}

/** Compare-and-set for the silent refresh: replace `presentedToken` with the
 *  rotated session, but only if it is still the token in storage.
 *
 *  Rotation revokes exactly the token it was handed, so if another tab (or a
 *  magic-link redemption in this one) has since written a DIFFERENT session,
 *  that session is live and ours is not the one to keep. Returns false in that
 *  case, having written nothing — the freshly-minted token is simply dropped.
 *  A cleared blob (someone signed out mid-flight) also declines: signing the
 *  user back in behind their own sign-out would be a bug, not a recovery. */
export function replaceStoredSession(
  presentedToken: string,
  next: StoredSession,
  nowMs = Date.now(),
): boolean {
  const current = readStoredSession();
  if (!current || current.token !== presentedToken) return false;
  return writeStoredSession(withRotationStamp(next, nowMs));
}

/** Drop the session from BOTH storages. Removing the legacy copy too is not
 *  housekeeping: leaving it behind would let the next `readStoredSession()`
 *  promote a signed-out session back to life. */
export function clearStoredSession(): void {
  removeRaw("local");
  removeRaw("session");
}

/** The 401 guard: clear the session only if `token` is still the stored one.
 *
 *  The hazard this exists for: `POST /auth/refresh` rotates and revokes in one
 *  transaction, so two tabs refreshing together means one of them presents an
 *  already-revoked token and gets a 401 — for a token that storage no longer
 *  holds. Clearing on that 401 (which is what api.ts did unconditionally)
 *  signs out the tab holding the VALID rotated token. Any authed call can hit
 *  the same race, so the guard lives here and covers all of them.
 *
 *  Returns true when the rejected token is gone (cleared, or nothing stored),
 *  false when a different session was left in place. */
export function clearStoredSessionIfToken(token: string): boolean {
  const current = readStoredSession();
  if (current && current.token !== token) return false;
  clearStoredSession();
  return true;
}
