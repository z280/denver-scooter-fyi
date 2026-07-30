// Ambient types for the hand-written map-auth.js session accessors.
//
// This used to be a verbatim copy of veo-audit/scripts/client/map-auth.js,
// kept unmodified per that repo's AGENT_INSTRUCTIONS.md. Upstream deleted
// the whole scripts/client/ drop-in set in 2661e78 along with the
// /map-auth/* routes, so there is no longer an upstream to stay in sync
// with and the file is now maintained here.
//
// The blob's shape is owned by auth-storage.ts (ride-mode F1) — AuthBlob is an
// alias of it so the two can never drift. Note that `issued_at` is OPTIONAL
// there: the session-minting endpoints return exactly `{token, expires}`
// (API.md), so a required `issued_at` was never true on the wire. What the
// client does stamp is `rotated_at`, the silent refresh's staleness clock.

import type { StoredSession } from "./auth-storage.ts";

export type AuthBlob = StoredSession;

export function getAuth(): AuthBlob | null;
export function isAuthenticated(): boolean;
export function signOut(): Promise<void>;
