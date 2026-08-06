// Sign in by text — the phone equivalent of the emailed-code door.
//
//   1. requestSmsCode(phone) → POST /api/v1/auth/sms/code → 202. The API
//      texts a short AA000AA code (2 letters, 3 digits, 2 letters; 10-minute
//      TTL) through z280-comms.
//   2. verifySmsCode(phone, code) exchanges it at
//      POST /api/v1/auth/sms/code/verify for the session, which we persist
//      exactly as the email doors do.
//
// Two things make this door different from the email one, and both surface
// in the UI rather than being swallowed here:
//
//   • **Opting out is real and permanent-ish.** Anyone can text STOP to the
//     sender and block themselves — across every application sharing that
//     number, not just us. The API answers 409 with a sentence written to be
//     shown to a human, naming the exact keyword and number that undo it. We
//     carry that sentence through untouched (SmsOptedOut): a paraphrase
//     names a keyword that doesn't work.
//   • **US numbers only.** The sender is a US handset. We check the shape
//     locally so a rider gets an instant, specific answer instead of
//     spending one of their three hourly texts to be told no.

import { API_BASE } from "./api.ts";
import { AuthSendError } from "./auth-magic-link.ts";
import { isSession, persistSession } from "./auth-session.ts";
import { track } from "./telemetry.ts";

/** The recipient has blocked texts from the shared sender. `message` is the
 *  server's own sentence — show it verbatim, it names the keyword and number
 *  that unblock. Not retryable. */
export class SmsOptedOut extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsOptedOut";
  }
}

/** Digits only, +1 prepended, or null if it isn't a usable US number.
 *  Mirrors the backend's accounts.normalize_us_phone so the two agree on
 *  what "(303) 555-1212" means. */
export function normalizeUsPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 10) digits = "1" + digits;
  if (digits.length !== 11 || !digits.startsWith("1")) return null;
  const area = digits.slice(1, 4);
  const exchange = digits.slice(4, 7);
  // Area code and exchange both start 2-9, and neither is an N11 service
  // code (211/311/…/911). Deliberately NOT the widely copied [2-9][0-8]\d
  // area-code rule, which predates 929/934/959/984 and would reject a
  // rider's real number.
  if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange)) return null;
  if (area.endsWith("11") || exchange.endsWith("11")) return null;
  return "+" + digits;
}

export function isProbablyUsPhone(raw: string): boolean {
  return normalizeUsPhone(raw) !== null;
}

/** (303) 555-1212 — for echoing a number back at the person who typed it. */
export function formatUsPhone(raw: string): string {
  const e164 = normalizeUsPhone(raw);
  if (!e164) return raw;
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** FastAPI puts a plain-string HTTPException detail in `detail`. */
async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) {
      return body.detail.trim();
    }
  } catch {
    /* not JSON — fall through */
  }
  return "";
}

async function throwForStatus(res: Response, noun: string): Promise<never> {
  const detail = await detailOf(res);
  if (res.status === 409) throw new SmsOptedOut(detail || "That number has blocked our texts.");
  // 400 carries a specific, showable reason ("enter a US phone number…",
  // "that number can't receive texts…"); anything else gets generic copy
  // from the caller, since the server's wording isn't guaranteed friendly.
  throw new AuthSendError(res.status, res.status === 400 && detail ? detail : `Could not send the ${noun} (HTTP ${res.status})`);
}

/**
 * Ask the API to text a sign-in code. Resolves on success (202/200); the
 * caller then shows the code-entry step.
 */
export async function requestSmsCode(phone: string): Promise<void> {
  const e164 = normalizeUsPhone(phone);
  if (!e164) throw new Error("Enter a US phone number, like (303) 555-1212");
  const res = await fetch(`${API_BASE}/api/v1/auth/sms/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ phone_number: e164 }),
  });
  if (res.status !== 202 && res.status !== 200) await throwForStatus(res, "code");
  track("auth_start", { method: "sms" });
}

/**
 * Exchange a texted code (with the number it went to) for a session and
 * persist it. The API burns the code on success and caps wrong tries.
 *
 * Typing this code back is also what marks the number VERIFIED server-side
 * — it is the only proof of ownership the backend accepts.
 */
export async function verifySmsCode(phone: string, code: string): Promise<void> {
  const e164 = normalizeUsPhone(phone);
  if (!e164) throw new Error("Enter a US phone number, like (303) 555-1212");
  const res = await fetch(`${API_BASE}/api/v1/auth/sms/code/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // Backend normalizes too, but send it clean so what we validated is
    // what we submitted.
    body: JSON.stringify({
      phone_number: e164,
      code: (code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    }),
  });
  if (!res.ok) {
    track("auth_error", { method: "sms", key: String(res.status) });
    const detail = await detailOf(res);
    // 409 here is a contested number, not an opt-out — the server's
    // sentence explains it and tells them what to do.
    if (res.status === 409) throw new AuthSendError(409, detail || "That number needs an operator to sort out.");
    throw new AuthSendError(res.status, `Code invalid or expired (HTTP ${res.status})`);
  }
  const data: unknown = await res.json();
  if (!isSession(data)) throw new Error("Verification returned no session");
  persistSession(data);
  track("auth_success", { method: "sms" });
}
