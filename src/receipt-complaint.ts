// Phase 8 §8.5 — the complaint. Pure: it builds a draft and decides which way
// to hand it over. It never sends anything, and it cannot send anything.
//
// ---------------------------------------------------------------------------
// THE RIDER SENDS IT, FROM THEIR OWN ADDRESS. That is not a limitation to route
// around: sending it ourselves would mean this project asserting a contract claim
// on somebody's behalf, from an address they do not control.
//
// A `mailto:` IS THE MECHANISM, NOT A CLIPBOARD COPY, and the reason is §10's
// CC: text in a body cannot set a recipient. A copied body leaves the rider to
// type the addresses themselves, which is exactly where an opted-in CC silently
// fails to happen. So the primary action opens their own mail client with `to`,
// `cc`, `subject` and `body` already populated — the CC is a real header rather
// than a line of prose.
//
// THE FALLBACK'S CONDITION IS NOT "WHEN THE BODY WOULD OVERFLOW", because that
// is not implementable:
//
//   * no client exposes a "this would overflow" signal, and a `mailto:` that is
//     too long OPENS A SILENTLY TRUNCATED DRAFT rather than failing — the worst
//     available outcome, a complaint that looks sent and is missing its figures;
//   * the limit applies to the FULLY PERCENT-ENCODED URI, not to the body, and
//     encoding can more than double a body's length. Measuring the body measures
//     the wrong string.
//
// So: build the whole URI, measure the ENCODED length, and take the clipboard
// route past a conservative threshold. And the clipboard route is available as
// its own control regardless, so the rider is never dependent on our estimate of
// a limit we cannot query.
// ---------------------------------------------------------------------------

import { EQUITY_DISCOUNT_CITATION } from "./config.ts";
import { formatCents } from "./ride-cost.ts";
import type { VerdictResult } from "./receipt-verdict.ts";

/** Past this many characters of ENCODED URI, take the clipboard route.
 *
 *  Chosen BELOW the smallest limit in common circulation rather than tuned to any
 *  one client: the limits vary by client and platform, none of them is queryable,
 *  and the failure mode on the wrong side is a draft that opens truncated and
 *  looks fine. A conservative threshold costs a rider one extra paste; a tuned
 *  one costs them a complaint with its figures missing. */
export const MAILTO_MAX_URI_CHARS = 1800;

/** An established overcharge. The ONLY thing a complaint can be built from.
 *
 *  THIS IS THE GATE, and it is a type for the same reason `ConfirmedReceipt` is.
 *  §8.7 requires that NEITHER complaint path is reachable until the rider has
 *  confirmed the figures — "gating only one of them means an unconfirmed
 *  complaint can still be opened and sent". A boolean checked in two places is
 *  exactly the shape that gets checked in one. Instead both routes take this, it
 *  is only produced by `overchargeFinding()`, and that only accepts a verdict of
 *  `overcharged` — which in turn can only come from a `ConfirmedReceipt`. The
 *  whole chain is confirm → verdict → finding → complaint, and no link can be
 *  skipped. */
export interface OverchargeFinding {
  readonly __overcharge: true;
  verdict: VerdictResult;
}

/** Promote an `overcharged` verdict into something a complaint can be built
 *  from. `null` for every other verdict — a complaint built on `cannot_tell` is
 *  the rider spending their credibility on our uncertainty. */
export function overchargeFinding(verdict: VerdictResult): OverchargeFinding | null {
  if (verdict.verdict !== "overcharged") return null;
  if (verdict.expected === null) return null;
  return { __overcharge: true, verdict };
}

export interface ComplaintFacts {
  /** Where the query goes. INJECTED rather than read from `config.ts`.
   *
   *  The module reached into `VEO_SUPPORT_EMAIL` at first, and that made the
   *  length-threshold branch untestable: the address ships empty on purpose, so
   *  `complaintRoute` always took the no-address route and §8.7's "both sides of
   *  1,800" could not be asserted at all. A hidden dependency that only one
   *  branch can be reached through is a hidden dependency that hides a branch.
   *
   *  The caller passes `VEO_SUPPORT_EMAIL`; this module just builds the draft. */
  to: string;
  /** From §8.3's account-confirm step, and its only purpose: without it the
   *  complaint cannot credibly say whose trip this was. */
  accountId: string;
  /** The trip's own date, as the receipt gives it. */
  tripDate: string;
  /** Veo's billed minutes, as printed. */
  minutes: number;
  /** Total charged, cents. */
  chargedCents: number;
  /** "Equity Area 014", when we know which. Omitted rather than guessed. */
  areaName?: string;
  /** §10's opted-in CC. A real recipient, never a line of body text. */
  cc?: string;
}

export interface ComplaintDraft {
  to: string;
  /** Present only when the rider opted in. */
  cc?: string;
  subject: string;
  body: string;
}

/** The draft. Facts and a reference, no adjectives — at the single-receipt level
 *  an overcharge is indistinguishable from a bug, and this should read like the
 *  billing query it is. */
export function complaintDraft(
  finding: OverchargeFinding,
  facts: ComplaintFacts,
): ComplaintDraft {
  const expected = finding.verdict.expected!;
  const where = facts.areaName ? ` (${facts.areaName})` : "";
  const lines = [
    `Account: ${facts.accountId}`,
    `Trip: ${facts.tripDate}, ${facts.minutes} min, started or ended in a designated Equity Area${where}`,
    `Charged: ${formatCents(facts.chargedCents)}`,
    `Expected under the Equity Area rate: ${formatCents(expected.total)}` +
      ` (unlock ${formatCents(expected.unlock)} + ${facts.minutes} min at $0.13` +
      ` = ${formatCents(expected.perMin)}, tax ${formatCents(expected.tax)})`,
    `Difference: ${formatCents(finding.verdict.differenceCents!)}`,
    "",
    // The citation goes UNDERNEATH the facts, verbatim, never woven into them.
    EQUITY_DISCOUNT_CITATION,
    "",
    "Please review this trip's fare.",
  ];
  return {
    to: facts.to,
    ...(facts.cc ? { cc: facts.cc } : {}),
    subject: `Equity Area fare query — trip ${facts.tripDate}`,
    body: lines.join("\n"),
  };
}

/** The `mailto:` URI, fully encoded.
 *
 *  `encodeURIComponent` on every part, including `to` and `cc`: an address with a
 *  `+` in it is legal and common, and an unencoded one arrives as a space. */
export function mailtoUri(draft: ComplaintDraft): string {
  const params = [
    ...(draft.cc ? [`cc=${encodeURIComponent(draft.cc)}`] : []),
    `subject=${encodeURIComponent(draft.subject)}`,
    `body=${encodeURIComponent(draft.body)}`,
  ];
  return `mailto:${encodeURIComponent(draft.to)}?${params.join("&")}`;
}

export type ComplaintRoute =
  /** Open the rider's own mail client, everything populated. */
  | { kind: "mailto"; uri: string; draft: ComplaintDraft }
  /** Hand over the pieces to copy. `to` and `cc` are their OWN fields and never
   *  folded into `body` — a fallback that drops the CC into prose is the bug
   *  §8.5 exists to prevent. */
  | { kind: "clipboard"; draft: ComplaintDraft; reason: "too_long" | "no_address" };

/** Which way to hand the complaint over.
 *
 *  `no_address` is not a length problem and gets its own reason: with no
 *  recipient a `mailto:` opens a BLANK DRAFT, which looks like the feature
 *  working. The rider gets the copyable body and no recipient, which is honest,
 *  instead of a draft addressed to nobody. `config.ts`'s `complaintReady()` is
 *  the same check at the surface, for deciding whether to offer the action. */
export function complaintRoute(draft: ComplaintDraft): ComplaintRoute {
  if (!draft.to.includes("@")) return { kind: "clipboard", draft, reason: "no_address" };
  const uri = mailtoUri(draft);
  if (uri.length > MAILTO_MAX_URI_CHARS) {
    return { kind: "clipboard", draft, reason: "too_long" };
  }
  return { kind: "mailto", uri, draft };
}
