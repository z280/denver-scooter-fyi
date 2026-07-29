// Sign-in capabilities, fetched once from the backend's single source of
// truth: GET /api/v1/auth/config → { google_client_id, google_enabled,
// magic_link_enabled, code_enabled, sms_enabled } (scooter-fyi-api API.md §2).
// The frontend
// renders the Google door — and initializes GIS with the returned client id —
// straight from this, so "is Google on?" lives in exactly one place (the
// server) instead of a hardcoded frontend flag that can drift from it.
//
// Fail-closed for Google and SMS, fail-open for email. If the endpoint is
// unreachable we hide Google (no client id to trust) and hide the text door,
// but still show the email doors, which degrade gracefully to a friendly
// error if the server 503s. The asymmetry is deliberate: email is the door
// that must always be offered, whereas a text door we can't confirm is
// configured would invite someone to type their phone number for nothing.

import { API_BASE } from "./api.ts";

export interface AuthConfig {
  /** GIS client id to initialize with, or null when Google is unavailable. */
  googleClientId: string | null;
  googleEnabled: boolean;
  magicLinkEnabled: boolean;
  codeEnabled: boolean;
  /** Whether the backend can text a sign-in code (z280-comms configured). */
  smsEnabled: boolean;
}

const SAFE_DEFAULT: AuthConfig = {
  googleClientId: null,
  googleEnabled: false, // fail closed — never surface Google we can't verify
  magicLinkEnabled: true, // fail open — let email doors try; server 503s if off
  codeEnabled: true,
  smsEnabled: false, // fail closed — see above
};

let cached: Promise<AuthConfig> | null = null;

/** Load (and memoize) the backend's sign-in capabilities. Never rejects —
 *  resolves to SAFE_DEFAULT on any network/parse error. */
export function loadAuthConfig(): Promise<AuthConfig> {
  cached ??= fetch(`${API_BASE}/api/v1/auth/config`, {
    headers: { Accept: "application/json" },
  })
    .then(async (res): Promise<AuthConfig> => {
      if (!res.ok) return SAFE_DEFAULT;
      const d = (await res.json()) as Record<string, unknown>;
      return {
        googleClientId:
          typeof d.google_client_id === "string" && d.google_client_id
            ? d.google_client_id
            : null,
        googleEnabled: d.google_enabled === true,
        magicLinkEnabled: d.magic_link_enabled === true,
        codeEnabled: d.code_enabled === true,
        smsEnabled: d.sms_enabled === true,
      };
    })
    .catch(() => SAFE_DEFAULT);
  return cached;
}
