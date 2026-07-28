// Ambient types for the hand-written map-auth.js session store.
//
// This used to be a verbatim copy of veo-audit/scripts/client/map-auth.js,
// kept unmodified per that repo's AGENT_INSTRUCTIONS.md. Upstream deleted
// the whole scripts/client/ drop-in set in 2661e78 along with the
// /map-auth/* routes, so there is no longer an upstream to stay in sync
// with and the file is now maintained here.

export interface AuthBlob {
  token: string;
  expires: string;
  issued_at: string;
}

export function getAuth(): AuthBlob | null;
export function isAuthenticated(): boolean;
export function signOut(): Promise<void>;
