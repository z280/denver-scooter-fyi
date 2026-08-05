// Sign in with Google (Google Identity Services / One Tap).
//
// Flow: GIS hands us a signed ID token (a JWT credential); we POST it to the
// API's POST /api/v1/auth/google, which verifies it against Google's JWKS
// (see the backend's API.md) and mints the bearer session we then
// persist via auth-session. Admin scope is decided server-side from the
// verified email against ADMIN_EMAILS.
//
// Two entry points, one shared GIS init + callback:
//   - promptGoogleOneTap(): the automatic top-right One Tap prompt, fired on
//     load for signed-out visitors.
//   - renderGoogleButton(): the official personalized button in the Account
//     drawer (shows "Continue as <name>" for users with a Google session).
//
// DORMANT until configured: loads a third-party script from Google
// (accounts.google.com/gsi/client) — the app's first external runtime
// dependency — so it does nothing, and loads nothing, unless the backend's
// GET /api/v1/auth/config reports google_enabled and hands back a client id
// (see auth-config.ts). Callers pass that id into promptGoogleOneTap /
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
    cancel_on_tap_outside?: boolean;
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
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
  handlers = h; // latest caller's handlers win; both just reload on success
  const id = await loadGis();
  if (!initialized) {
    id.initialize({
      client_id: clientId,
      cancel_on_tap_outside: true,
      // Chrome is moving One Tap to FedCM; opt in so the prompt keeps working
      // as third-party-cookie One Tap is deprecated.
      use_fedcm_for_prompt: true,
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

/** Fire the automatic One Tap prompt (top-right). Call on load for
 *  signed-out visitors; GIS handles its own cooldown/backoff. */
export async function promptGoogleOneTap(
  clientId: string,
  h: GoogleAuthHandlers,
): Promise<void> {
  const id = await ensureInit(clientId, h).catch(() => null);
  id?.prompt();
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
