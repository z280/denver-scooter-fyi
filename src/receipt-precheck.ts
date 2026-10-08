// The local pre-check, and the reason it exists is cost — ours and the
// rider's.
//
// §8.4's `receipt-verdict.ts` already answers "was this charge too high?"
// purely, on this device, from numbers the rider typed off their own receipt.
// Until now nothing asked it before the upload: every "didn't get the
// discount?" report sent a photograph of a receipt over a phone connection, to
// be stored for eighteen months and read on a server, INCLUDING the ones whose
// own figures say the charge was right.
//
// So this runs the verdict first. A receipt whose arithmetic already matches
// the Equity Area rate has nothing to claim, and saying so on the device is
// better for everyone in it:
//
//   - the rider gets an answer in no time instead of after an upload, and keeps
//     their photo;
//   - we do not pay to read an image to learn what the typed figures already
//     said;
//   - and the claims queue stays made of claims.
//
// IT IS A PRE-CHECK, NEVER A GATE. The rider can send anyway, and the surface
// has to offer that, for three reasons that are all realistic rather than
// theoretical: our geography may be wrong (we only know a polygon the trip
// touched if the rider pinned it or we matched the ride), their tier may be
// wrong in our copy of it, and the contract reading this prices against is one
// reading. A tool that refused to file a report because its own estimate said
// not to would be the app overruling the person it is for.
//
// WHAT IT DOES NOT DO: any OCR, on device or off. There is nothing to read —
// the rider has already typed the minutes and the cost, which is what §8.3
// settled on because "receipt layouts change without notice, and a misread
// total is a rider sent to lose an argument in public". The image still goes up
// when a report is actually sent, because that is the evidence; what this saves
// is the ones that never needed sending.

import { confirmRead, receiptVerdict, type VerdictResult } from "./receipt-verdict.ts";
import type { RatePlan } from "./config.ts";

export interface PrecheckInput {
  /** Veo's billed minutes, as the rider typed them. */
  minutes: number;
  /** The charge, cents. Null when the rider gave only a subtotal — which is
   *  allowed by the form and means there is no total to compare. */
  totalCents: number | null;
  /** Did the trip demonstrably start or end inside an Equity Area? Three-valued
   *  for the same reason `VerdictContext` is: "we did not look" is not "we
   *  looked and it was outside". */
  startedOrEndedInArea: boolean | null;
  rate: RatePlan | null;
  taxRate: number;
}

export type PrecheckOutcome =
  /** Send it. Either the figures suggest an overcharge, or we genuinely cannot
   *  tell — and the whole point of the report is that the server CAN look. */
  | { kind: "send"; verdict: VerdictResult | null }
  /** The rider's own figures match the discounted rate. Nothing to claim, so
   *  nothing to upload — unless they say otherwise. */
  | {
      kind: "nothing_to_claim";
      verdict: VerdictResult;
      /** What the trip should have cost under the Equity Area rate, cents. */
      expectedCents: number;
      /** What they were charged, cents. */
      chargeCents: number;
    };

/** Run the §8.4 bar against what the rider typed, before anything is uploaded.
 *
 *  `send` IS THE DEFAULT FOR EVERY UNCERTAINTY, and the asymmetry is the whole
 *  design. A report we did not need costs an upload. A report we talked the
 *  rider out of costs them the claim — and they came here because they believe
 *  they were overcharged, which is a belief we have no standing to overrule
 *  from a figure we could not even compute.
 *
 *  So this returns `nothing_to_claim` ONLY on a positive `correct`: the
 *  geography was established, the tier was known, the arithmetic was done and
 *  it matched. Every `cannot_tell` sends. */
export function precheckReceipt(input: PrecheckInput): PrecheckOutcome {
  // No total, nothing to compare. The form allows a subtotal-only report and
  // the server prices it; this cannot.
  if (input.totalCents === null) return { kind: "send", verdict: null };
  const receipt = confirmRead({
    minutes: input.minutes,
    totalCents: input.totalCents,
  });
  // `confirmRead` refuses figures that cannot be on a receipt. Its refusal is
  // the form's business, not ours — this is a pre-check, and the one thing it
  // must not do is swallow a report because a field needs fixing.
  if (receipt === null) return { kind: "send", verdict: null };
  const verdict = receiptVerdict(receipt, {
    startedOrEndedInArea: input.startedOrEndedInArea,
    rate: input.rate,
    taxRate: input.taxRate,
  });
  if (verdict.verdict !== "correct" || verdict.expected === null) {
    return { kind: "send", verdict };
  }
  return {
    kind: "nothing_to_claim",
    verdict,
    expectedCents: verdict.expected.total,
    chargeCents: receipt.totalCents,
  };
}

/** What to tell a rider whose own figures say the charge was right.
 *
 *  It states the comparison and stops. No congratulation — "good news, you
 *  were charged correctly" is the app being pleased about a rate the rider is
 *  entitled to — and no instruction, because whether to file anyway is theirs
 *  to decide and they know things we do not. */
export function nothingToClaimSentence(outcome: {
  expectedCents: number;
  chargeCents: number;
}): string {
  const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
  return (
    `Your figures match the Equity Area rate: ${money(outcome.chargeCents)} ` +
    `charged against ${money(outcome.expectedCents)} expected. There is ` +
    `nothing here to claim, so we haven't uploaded your receipt.`
  );
}
