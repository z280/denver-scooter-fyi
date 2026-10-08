// Sign in with Google (Google Identity Services).
//
// Flow: GIS hands us a signed ID token (a JWT credential); we POST it to the
// API's POST /api/v1/auth/google, which verifies it against Google's JWKS
// (see the backend's API.md) and mints the bearer session we then
// persist via auth-session. Admin scope is decided server-side from the
// verified email against ADMIN_EMAILS.
//
// One entry point: renderGoogleButton(), the official personalized button
// ("Continue as <name>" for users with a Google session). It is called only
// by the two sign-in surfaces that show it — the Account drawer's sign-in
// block (account-login.ts, once the drawer is actually open) and the ride
// wizard's sign-in screen (ride-screen-auth.ts).
//
// LAZY, AND NEVER AT BOOT (owner directive 2026-10-08). Google's script
// (accounts.google.com/gsi/client) is injected the first time one of those
// surfaces renders the button — never on page load, and never for a rider
// who doesn't open sign-in. There is no automatic One Tap prompt: the old
// on-load promptGoogleOneTap() loaded Google's script for every signed-out
// visitor, and it is gone on purpose. Don't add a prompt() back.
//
// DORMANT until configured: even on a sign-in surface nothing loads unless
// the backend's GET /api/v1/auth/config reports google_enabled and hands back
// a client id (see auth-config.ts). Callers pass that id into
// renderGoogleButton; this module never reads a compile-time flag.

import { API_BASE } from "./api.ts";
import { isSession, persistSession } from "./auth-session.ts";
import { track } from "./telemetry.ts";

const GSI_SRC = "https://accounts.google.com/gsi/client";

// Minimal shape of the bits of Google Identity Services we call.
interface GsiIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: { credential: string }) => void;
    auto_select?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  disableAutoSelect(): void;
}
type GsiWindow = Window & {
  google?: { accounts: { id: GsiIdApi } };
};

export interface GoogleAuthHandlers {
  /** Called after the session is persisted; typically reloads the app. */
  onSignedIn: () => void;
  onError?: (err: Error) => void;
}

let scriptPromise: Promise<GsiIdApi> | null = null;
let initialized = false;
let handlers: GoogleAuthHandlers | null = null;

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

/** Load + initialize GIS once with the shared credential callback. The
 *  client id comes from the backend's /auth/config (the single source of
 *  truth) — callers only invoke this when config says Google is enabled and
 *  hands back a non-empty id. Returns null if the id is missing. */
async function ensureInit(
  clientId: string,
  h: GoogleAuthHandlers,
): Promise<GsiIdApi | null> {
  if (!clientId) return null;
  handlers = h; // latest caller's handlers win; every caller reloads on success
  const id = await loadGis();
  if (!initialized) {
    id.initialize({
      client_id: clientId,
      callback: (response) => {
        track("auth_start", { method: "google" });
        exchangeCredential(response.credential)
          .then(() => {
            track("auth_success", { method: "google" });
            handlers?.onSignedIn();
          })
          .catch((e) => {
            track("auth_error", { method: "google", key: "exchange" });
            handlers?.onError?.(e as Error);
          });
      },
    });
    initialized = true;
  }
  return id;
}

/** Render the official personalized "Continue with Google" button into
 *  `container`. Callers gate on the /auth/config google_enabled flag first. */
export async function renderGoogleButton(
  container: HTMLElement,
  clientId: string,
  h: GoogleAuthHandlers,
): Promise<void> {
  try {
    const id = await ensureInit(clientId, h);
    id?.renderButton(container, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "left",
    });
  } catch (e) {
    // GIS blocked (adblock / privacy / offline) — surface it rather than
    // leaving an unhandled rejection; magic-link sign-in still works.
    h.onError?.(e as Error);
  }
}
