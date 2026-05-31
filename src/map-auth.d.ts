// Ambient types for the hand-written, drop-in map-auth.js helper.
// The .js file is verbatim from veo-audit/scripts/client/map-auth.js and
// must not be modified (per AGENT_INSTRUCTIONS.md); these declarations live
// alongside it so the TS app can import it with type safety.

export interface AuthBlob {
  token: string;
  expires: string;
  issued_at: string;
}

export interface ApiError extends Error {
  code: "NO_AUTH" | "TOKEN_REJECTED" | "HTTP_ERROR";
  status?: number;
}

export function getAuth(): AuthBlob | null;
export function isAuthenticated(): boolean;
export function signIn(nextPath?: string): void;
export function signOut(): Promise<void>;
export function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T>;
