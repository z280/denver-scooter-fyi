// Sign in with Google (Google Identity Services / One Tap).
//
// Flow: GIS hands us a signed ID token (a JWT credential); we POST it to the
// API's POST /api/v1/auth/google, which verifies it against Google's JWKS
// (see docs/API_REQUIREMENTS.md §2.2) and mints the bearer session we then
// persist via auth-session. Admin scope is decided server-side from the
// verified email against ADMIN_EMAILS.
//
// DORMANT until configured: this loads a third-party script from Google
// (accounts.google.com/gsi/client) — the app's first external runtime
// dependency — so it does nothing, and loads nothing, unless a client id is
// provided. Set VITE_GOOGLE_CLIENT_ID (see config.GOOGLE_OAUTH_CLIENT_ID)
// and the API endpoint must exist. The UI wiring (a button in the Account
// drawer) is intentionally left for the same change that retires the GitHub
// gate; this module is the ready-to-call engine.

import { API_BASE } from "./api.ts";
import { GOOGLE_OAUTH_CLIENT_ID } from "./config.ts";
import { isSession, persistSession } from "./auth-session.ts";

const GSI_SRC = "https://accounts.google.com/gsi/client";

// Minimal shape of the bits of Google Identity Services we call.
interface GsiIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: { credential: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
  disableAutoSelect(): void;
}
type GsiWindow = Window & {
  google?: { accounts: { id: GsiIdApi } };
};

let scriptPromise: Promise<GsiIdApi> | null = null;

/** Load the GIS client script once and resolve its id API. */
function loadGis(): Promise<GsiIdApi> {
  const w = window as GsiWindow;
  if (w.google?.accounts?.id) return Promise.resolve(w.google.accounts.id);
  scriptPromise ??= new Promise<GsiIdApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      const api = (window as GsiWindow).google?.accounts?.id;
      if (api) resolve(api);
      else reject(new Error("Google Identity Services failed to initialize"));
    };
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** Exchange a Google ID token for our bearer session and persist it. */
async function exchangeCredential(credential: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!res.ok) {
    throw new Error(`Google sign-in rejected by API (HTTP ${res.status})`);
  }
  const data: unknown = await res.json();
  if (!isSession(data)) throw new Error("Google sign-in returned no session");
  persistSession(data);
}

export interface GoogleSignInOptions {
  /** Container to render the Google button into. */
  container: HTMLElement;
  /** Called after the session is persisted; typically re-renders the UI. */
  onSignedIn: () => void;
  onError?: (err: Error) => void;
  /** Also show the One Tap prompt. Off by default (it's interruptive). */
  oneTap?: boolean;
  /** Override the configured client id (mainly for tests). */
  clientId?: string;
}

/** Whether Google sign-in can be offered (a client id is configured). */
export function isGoogleConfigured(): boolean {
  return GOOGLE_OAUTH_CLIENT_ID.length > 0;
}

/**
 * Initialize GIS and render a "Continue with Google" button. No-ops with a
 * thrown error if no client id is configured, so callers should gate on
 * isGoogleConfigured() first.
 */
export async function initGoogleSignIn(
  opts: GoogleSignInOptions,
): Promise<void> {
  const clientId = opts.clientId ?? GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error("Google client id not configured");

  const id = await loadGis();
  id.initialize({
    client_id: clientId,
    cancel_on_tap_outside: true,
    callback: (response) => {
      exchangeCredential(response.credential)
        .then(() => opts.onSignedIn())
        .catch((e) => opts.onError?.(e as Error));
    },
  });
  id.renderButton(opts.container, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "pill",
    logo_alignment: "left",
  });
  if (opts.oneTap) id.prompt();
}
