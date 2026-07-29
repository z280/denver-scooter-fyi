// The "text me a code" sign-in door, as a self-contained pair of forms.
//
// Lives in its own module rather than inline in main.ts's wireAccount() for
// the reason docs/API_INTEGRATION_PLAN.md gives generally, and one specific
// to this door: it is the only sign-in path with a failure mode that is not
// an error — a recipient who has opted out of texts. That deserves its own
// copy and its own visual treatment, and mixing it into the email door's
// handlers would blur both.
//
// Shape mirrors the email code door exactly (ask → reveal code step →
// verify → reload), because a rider who has used one should recognise the
// other. Two steps, one code, same AA000AA format.

import { AuthSendError } from "./auth-magic-link.ts";
import {
  SmsOptedOut,
  formatUsPhone,
  isProbablyUsPhone,
  normalizeUsPhone,
  requestSmsCode,
  verifySmsCode,
} from "./auth-sms.ts";

/** Survives the one legitimate signed-out rebuild (auth-config resolving).
 *  Texts are limited to 3/hour per number — silently wiping a sent code
 *  would cost the rider a third of their hourly allowance. */
export interface SmsDoorState {
  phone: string;
  sentPhone: string;
}

type El = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) => HTMLElementTagNameMap[K];

export interface SmsDoorDeps {
  el: El;
  state: SmsDoorState;
  /** Called after the session is persisted. */
  onSignedIn(): void;
}

/** Build and append the phone + code forms. */
export function buildSmsDoor(container: HTMLElement, deps: SmsDoorDeps): void {
  const { el, state } = deps;

  const phoneForm = el("form", "account-magic");
  const phoneInput = el("input", "select");
  phoneInput.type = "tel";
  phoneInput.required = true;
  phoneInput.placeholder = "(303) 555-1212";
  phoneInput.autocomplete = "tel-national";
  phoneInput.inputMode = "tel";
  phoneInput.setAttribute("aria-label", "Mobile phone number");
  const phoneSubmit = el("button", "login-btn", "Text me a sign-in code");
  phoneSubmit.type = "submit";
  const phoneStatus = el("p", "account-magic-status");
  phoneStatus.setAttribute("role", "status");
  phoneStatus.setAttribute("aria-live", "polite");
  phoneForm.append(phoneInput, phoneSubmit, phoneStatus);

  // Step 2: type the texted code back. Hidden until one is sent.
  const codeForm = el("form", "account-code");
  codeForm.hidden = true;
  const codeHint = el("p", "account-magic-status", "");
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

  const hint = (phone: string): string =>
    `📱 We texted ${formatUsPhone(phone)} — enter the code (like AB123XY, valid 10 minutes):`;

  // Restore state from before an auth-config rebuild, if any.
  phoneInput.value = state.phone;
  let sentPhone = state.sentPhone;
  if (sentPhone && normalizeUsPhone(phoneInput.value) === sentPhone) {
    codeForm.hidden = false;
    codeHint.textContent = hint(sentPhone);
    phoneSubmit.textContent = "Resend code";
  } else {
    sentPhone = "";
    state.sentPhone = "";
  }

  // A code is bound to the number it was texted to; if the rider edits the
  // number after we revealed the code step, retract it so they can't verify
  // an old code against a new number.
  phoneInput.addEventListener("input", () => {
    state.phone = phoneInput.value;
    if (sentPhone && normalizeUsPhone(phoneInput.value) !== sentPhone) {
      sentPhone = "";
      state.sentPhone = "";
      codeForm.hidden = true;
      codeStatus.textContent = "";
      phoneSubmit.textContent = "Text me a sign-in code";
    }
  });

  phoneForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = phoneInput.value.trim();
    if (!isProbablyUsPhone(raw)) {
      // Checked locally so this costs no message: sends are capped at
      // 3/hour per number, and spending one to be told the number is
      // malformed helps nobody.
      phoneStatus.textContent = "Enter a US mobile number, like (303) 555-1212.";
      return;
    }
    const phone = normalizeUsPhone(raw)!;
    phoneSubmit.disabled = true;
    phoneStatus.textContent = "Sending…";
    requestSmsCode(phone)
      .then(() => {
        sentPhone = phone;
        state.sentPhone = phone;
        phoneSubmit.disabled = false;
        phoneSubmit.textContent = "Resend code";
        phoneStatus.textContent = "";
        codeHint.textContent = hint(phone);
        codeForm.hidden = false;
        codeInput.focus();
      })
      .catch((err: unknown) => {
        phoneSubmit.disabled = false;
        codeForm.hidden = true;
        if (err instanceof SmsOptedOut) {
          // Verbatim, and styled as information rather than an error: the
          // rider did this on purpose, and this sentence is the only place
          // the exact unblock keyword and number appear. Retrying achieves
          // nothing until they send that text.
          phoneStatus.textContent = err.message;
          phoneStatus.className = "account-magic-status account-optout";
          phoneSubmit.disabled = true;
          return;
        }
        phoneStatus.className = "account-magic-status";
        if (err instanceof AuthSendError && err.status === 429) {
          phoneStatus.textContent =
            "Too many texts requested — wait a few minutes before asking for another.";
        } else if (err instanceof AuthSendError && err.status === 400) {
          // The server's own reason ("that number can't receive texts…").
          phoneStatus.textContent = err.message;
        } else if (err instanceof AuthSendError && err.status === 503) {
          phoneStatus.textContent = "Text sign-in is unavailable right now — try email.";
        } else {
          phoneStatus.textContent = "Couldn't send the text right now — please try again.";
        }
      });
  });

  codeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!sentPhone) {
      codeStatus.textContent = "Request a code first.";
      return;
    }
    const code = codeInput.value.replace(/[^A-Za-z0-9]/g, "");
    if (!/^[A-Za-z0-9]{6,10}$/.test(code)) {
      codeStatus.textContent = "Enter the code from the text (like AB123XY).";
      return;
    }
    codeSubmit.disabled = true;
    codeStatus.textContent = "Verifying…";
    verifySmsCode(sentPhone, code)
      .then(() => deps.onSignedIn())
      .catch((err: unknown) => {
        codeSubmit.disabled = false;
        if (err instanceof AuthSendError && err.status === 409) {
          // A contested number — the server's sentence says what to do, and
          // no amount of retrying will change it.
          codeStatus.textContent = err.message;
          return;
        }
        codeStatus.textContent =
          err instanceof AuthSendError && err.status === 429
            ? "Too many tries — request a new code."
            : "That code didn't work — check it or resend.";
      });
  });

  container.append(phoneForm, codeForm);
}
