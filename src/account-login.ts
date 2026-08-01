// The signed-out half of the Account drawer: the sign-in doors. Lifted out of
// main.ts unchanged so it can mount into a tab panel like every other section,
// and so its behaviour is testable without standing up the whole app.
//
// Form state (a typed address, an already-sent code) is deliberately owned by
// the CALLER, not by this module: the drawer legitimately rebuilds once when
// /auth/config resolves, and codes are rate-limited per address — wiping a
// code the rider has already been emailed is expensive.

import { AuthSendError, isProbablyCode, isProbablyEmail } from "./auth-magic-link.ts";
import {
  requestLoginCode as defaultRequestLoginCode,
  requestMagicLink as defaultRequestMagicLink,
  verifyEmailCode as defaultVerifyEmailCode,
} from "./auth-magic-link.ts";
import { renderGoogleButton as defaultRenderGoogleButton } from "./auth-google.ts";
import { buildSmsDoor as defaultBuildSmsDoor } from "./sms-door.ts";
import type { AuthConfig } from "./auth-config.ts";

/** Sign-in form state that outlives a rebuild. Shared with the SMS door, which
 *  keeps the phone half under the same contract. */
export interface LoginPanelState {
  email: string;
  sentEmail: string;
  phone: string;
  sentPhone: string;
}

export interface LoginPanelDeps {
  /** Backend sign-in capabilities; null until /auth/config resolves, which is
   *  what makes the one legitimate signed-out rebuild happen. */
  cfg: AuthConfig | null;
  state: LoginPanelState;
  /** A session now exists. Today: reload, so every fetch picks up the token. */
  onSignedIn(): void;
  requestLoginCode?: typeof defaultRequestLoginCode;
  requestMagicLink?: typeof defaultRequestMagicLink;
  verifyEmailCode?: typeof defaultVerifyEmailCode;
  renderGoogleButton?: typeof defaultRenderGoogleButton;
  buildSmsDoor?: typeof defaultBuildSmsDoor;
}

export interface LoginPanelHandle {
  /** Render (or re-render) the Google button. Google Identity Services draws
   *  into the container's layout box, so calling this while the panel is
   *  hidden yields a 0px-wide button — the caller defers to first show. */
  renderGoogle(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Build the sign-in doors into `host`. */
export function buildLoginPanel(
  host: HTMLElement,
  deps: LoginPanelDeps,
): LoginPanelHandle {
  const cfg = deps.cfg;
  const state = deps.state;
  const requestLoginCode = deps.requestLoginCode ?? defaultRequestLoginCode;
  const requestMagicLink = deps.requestMagicLink ?? defaultRequestMagicLink;
  const verifyEmailCode = deps.verifyEmailCode ?? defaultVerifyEmailCode;
  const renderGoogleButton = deps.renderGoogleButton ?? defaultRenderGoogleButton;
  const buildSmsDoor = deps.buildSmsDoor ?? defaultBuildSmsDoor;

  const intro = el("p", "account-intro");
  intro.textContent =
    "Sign in to report problems and (soon) track your rides. The map works fully without an account.";
  host.append(intro);

  // Sign in with Google — shown only when the backend's /auth/config says
  // it's enabled and hands back a client id (the single source of truth;
  // no third-party script loads otherwise). `cfg` is null until that fetch
  // resolves, which triggers a re-render.
  let googleWrap: HTMLElement | null = null;
  const clientId = cfg?.googleEnabled ? cfg.googleClientId : null;
  if (clientId) {
    googleWrap = el("div", "account-google");
    host.append(googleWrap, el("div", "account-or", "or"));
  }

  const renderGoogle = (): void => {
    if (!googleWrap || !clientId) return;
    // GIS appends into whatever is there; clearing first is what stops a
    // second call (a deferred first paint, say) from stacking two buttons.
    googleWrap.replaceChildren();
    void renderGoogleButton(googleWrap, clientId, {
      onSignedIn: () => deps.onSignedIn(),
      onError: (err) => {
        const msg = el("p", "account-error", err.message);
        googleWrap?.after(msg);
      },
    });
  };

  // Email sign-in (Postmark). Two independent ways to finish, each its own
  // email (matching the scooter-fyi-api backend):
  //   • a typed AA000AA code (POST /auth/code → /auth/code/verify), the
  //     in-tab default; and
  //   • a magic link (POST /auth/magic-link), redeemed on return by
  //     consumePendingMagicLink().
  const emailForm = el("form", "account-magic");
  const emailInput = el("input", "select");
  emailInput.type = "email";
  emailInput.required = true;
  emailInput.placeholder = "you@email.com";
  emailInput.autocomplete = "email";
  emailInput.setAttribute("aria-label", "Email address");
  const emailSubmit = el("button", "login-btn", "Email me a sign-in code");
  emailSubmit.type = "submit";
  // Secondary door: a magic link instead of a typed code.
  const linkBtn = el("button", "text-btn", "Prefer a link? Email me one instead");
  linkBtn.type = "button";
  const emailStatus = el("p", "account-magic-status");
  emailStatus.setAttribute("role", "status");
  emailStatus.setAttribute("aria-live", "polite");
  emailForm.append(emailInput, emailSubmit, linkBtn, emailStatus);

  // Step 2: enter the emailed AA000AA code. Hidden until a code is sent;
  // the link door never needs it.
  const codeForm = el("form", "account-code");
  codeForm.hidden = true;
  const codeHint = el(
    "p",
    "account-magic-status",
    "📧 Check your inbox and enter the code (like AB123XY, valid 10 minutes):",
  );
  const codeInput = el("input", "select");
  codeInput.type = "text";
  codeInput.autocomplete = "one-time-code";
  codeInput.autocapitalize = "characters";
  codeInput.spellcheck = false;
  codeInput.maxLength = 9; // AA000AA (7) plus a stray space/hyphen or two
  codeInput.placeholder = "AB123XY";
  codeInput.setAttribute("aria-label", "Sign-in code");
  const codeSubmit = el("button", "login-btn", "Verify code");
  codeSubmit.type = "submit";
  const codeStatus = el("p", "account-magic-status");
  codeStatus.setAttribute("role", "status");
  codeStatus.setAttribute("aria-live", "polite");
  codeForm.append(codeHint, codeInput, codeSubmit, codeStatus);

  // Restore state from before an auth-config rebuild, if any.
  emailInput.value = state.email;
  let sentEmail = state.sentEmail;
  if (sentEmail && emailInput.value.trim() === sentEmail) {
    codeForm.hidden = false;
    emailSubmit.textContent = "Resend code";
  } else {
    sentEmail = "";
    state.sentEmail = "";
  }
  const validEmail = (): string | null => {
    const email = emailInput.value.trim();
    if (!isProbablyEmail(email)) {
      emailStatus.textContent = "Enter a valid email address.";
      return null;
    }
    return email;
  };
  // A code is bound to the address it was sent to; if the user edits the
  // email after we revealed the code step, retract it so they can't verify
  // an old code against a new address (or vice-versa).
  emailInput.addEventListener("input", () => {
    state.email = emailInput.value;
    if (sentEmail && emailInput.value.trim() !== sentEmail) {
      sentEmail = "";
      state.sentEmail = "";
      codeForm.hidden = true;
      codeStatus.textContent = "";
      emailSubmit.textContent = "Email me a sign-in code";
    }
  });
  // Distinct copy for a rate-limit vs a generic failure — don't tell the
  // user to retry the exact thing that's being throttled.
  const sendFailMsg = (err: unknown, noun: string): string =>
    err instanceof AuthSendError && err.status === 429
      ? `Too many requests — wait a minute before asking for another ${noun}.`
      : `Couldn't send the ${noun} right now — please try again.`;

  // Primary: email a typed code, then reveal the code-entry step.
  emailForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = validEmail();
    if (!email) return;
    emailSubmit.disabled = true;
    linkBtn.disabled = true;
    emailStatus.textContent = "Sending…";
    requestLoginCode(email)
      .then(() => {
        sentEmail = email;
        state.sentEmail = email;
        emailSubmit.disabled = false;
        linkBtn.disabled = false;
        emailSubmit.textContent = "Resend code";
        emailStatus.textContent = "";
        codeForm.hidden = false;
        codeInput.focus();
      })
      .catch((err: unknown) => {
        emailSubmit.disabled = false;
        linkBtn.disabled = false;
        emailStatus.textContent = sendFailMsg(err, "code");
      });
  });

  // Secondary: email a magic link instead (self-contained; redeemed on
  // return), and tuck the code step away if it was showing.
  linkBtn.addEventListener("click", () => {
    const email = validEmail();
    if (!email) return;
    emailSubmit.disabled = true;
    linkBtn.disabled = true;
    emailStatus.textContent = "Sending…";
    requestMagicLink(email)
      .then(() => {
        // Re-enable so the user can resend or switch back to the code door.
        emailSubmit.disabled = false;
        linkBtn.disabled = false;
        sentEmail = "";
        state.sentEmail = "";
        codeForm.hidden = true;
        emailStatus.textContent =
          "📧 Check your inbox for a sign-in link (valid 15 minutes).";
      })
      .catch((err: unknown) => {
        emailSubmit.disabled = false;
        linkBtn.disabled = false;
        emailStatus.textContent = sendFailMsg(err, "link");
      });
  });

  codeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    // Defensive: the form is hidden until a code is sent, but never verify
    // against an empty address (it'd be a confusing server-side failure).
    if (!sentEmail) {
      codeStatus.textContent = "Request a sign-in code first.";
      return;
    }
    const code = codeInput.value;
    if (!isProbablyCode(code)) {
      codeStatus.textContent = "Enter the code from your email (like AB123XY).";
      return;
    }
    codeSubmit.disabled = true;
    codeStatus.textContent = "Verifying…";
    // Success persists the session; the caller reloads so every fetch is authed.
    verifyEmailCode(sentEmail, code)
      .then(() => deps.onSignedIn())
      .catch((err: unknown) => {
        codeSubmit.disabled = false;
        codeStatus.textContent =
          err instanceof AuthSendError && err.status === 429
            ? "Too many tries — request a new code."
            : "That code didn't work — check it or resend.";
      });
  });

  host.append(emailForm, codeForm);

  // Sign in by text — shown only when the backend says z280-comms is
  // configured (fail-closed in auth-config.ts, so a rider is never
  // invited to type their phone number into a door that can't work).
  if (cfg?.smsEnabled) {
    host.append(el("div", "account-or", "or"));
    buildSmsDoor(host, {
      el,
      state,
      // Same as the email door: the session is persisted, so reload to
      // let every fetch pick up the bearer token.
      onSignedIn: () => deps.onSignedIn(),
    });
  }

  return {
    renderGoogle,
    dispose() {
      // Drop the GIS iframe so a rebuild starts from a clean container.
      googleWrap?.replaceChildren();
    },
  };
}
