// Two standing answers about calling dibs, kept on the device.
//
// WHY THESE ARE PREFERENCES AND NOT PROMPTS. Calling dibs is the one thing in
// this app with a deadline: the claim is worth having from the moment a rider
// decides on a scooter, and the moment they decide is the moment they are
// walking. A dialog asking "shall I claim this?" arrives exactly when they have
// stopped looking at the phone — so the answer is given once, in settings, and
// the claim is made without asking again.
//
// Same storage discipline as every other preference module here (`plan-prefs`,
// `ride-display-prefs`): a versionless single key per answer, every read
// validated, every read and write wrapped, and a corrupt value degrades to the
// default rather than throwing.

export const AUTO_DIBS_KEY = "scooter-fyi-auto-dibs";
export const DIBS_SMS_KEY = "scooter-fyi-dibs-sms";

/** Read a stored boolean, falling back to `fallback` for anything unexpected.
 *
 *  "1"/"0" rather than JSON: these are one bit each, and a JSON parse gives a
 *  corrupt value more ways to be interesting than it needs. */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean): boolean {
  try {
    localStorage.setItem(key, on ? "1" : "0");
    return true;
  } catch {
    // Private mode or quota. The caller says "applied, not saved" rather than
    // claiming a preference that will be gone next visit.
    return false;
  }
}

/** Claim dibs automatically on a scooter the rider has chosen off a route.
 *
 *  DEFAULT ON, which is a decision and not an oversight. A rider who has picked
 *  a scooter out of a plan and started walking to it has expressed exactly the
 *  intent dibs records; making them press a second button to say it again is
 *  asking twice. The claim is also free to them and costs nobody else anything
 *  irreversible — `dibs.ts`'s own rules cap the count, the walk and the clock,
 *  and anyone standing at the scooter can still ride it.
 *
 *  Off is a real answer: a rider who finds the certificate flow or the alerts
 *  intrusive turns this off and nothing claims on their behalf again. */
export function autoDibs(): boolean {
  return readFlag(AUTO_DIBS_KEY, true);
}

export function setAutoDibs(on: boolean): boolean {
  return writeFlag(AUTO_DIBS_KEY, on);
}

/** Text me if somebody takes the scooter I called dibs on.
 *
 *  DEFAULT OFF, and the opposite reasoning to the one above. An SMS reaches a
 *  rider who has put the phone away, which is the point — and is also why it
 *  must be asked for rather than assumed. A text nobody opted into is a text
 *  that arrives as an intrusion no matter how useful its content.
 *
 *  REQUIRES A VERIFIED PHONE, which this module does not check: it stores an
 *  answer and has no session. The surface offering it is what knows whether
 *  there is a number to send to, and `account-nav.ts` disables the control with
 *  the reason rather than letting a rider switch on a delivery that cannot
 *  happen. */
export function dibsSmsAlerts(): boolean {
  return readFlag(DIBS_SMS_KEY, false);
}

export function setDibsSmsAlerts(on: boolean): boolean {
  return writeFlag(DIBS_SMS_KEY, on);
}
