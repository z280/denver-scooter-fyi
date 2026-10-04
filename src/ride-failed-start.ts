// "It won't start" — the one reliability signal nobody was collecting.
//
// WHY THIS EXISTS, in the order the pieces matter.
//
// `number_failed_starts` on the device feed is INFERRED, never reported. The
// API's ingest (scooter-fyi-api `src/device_state.py`) calls a failed start
// "same spot, new bike_id": Veo rotates a vehicle's GBFS id when somebody
// unlocks it, so a rotation with no movement means somebody opened it and did
// not go anywhere. That is a good proxy and it is the only one we had, which
// leaves three holes:
//
//   * It needs Veo to rotate the id. A scooter that beeps and refuses before
//     the unlock completes may never produce one, so the clearest failure of
//     all — it would not ride — is the one the feed is quietest about.
//   * Ingest runs on a two-minute cycle. A rotation in the same cycle as a
//     real move reads as MOVED.
//   * `quality.py` needs TWO inferred failed starts to call a device
//     high-risk, or one plus 24 h of dwell. A freshly-dropped scooter with one
//     rotation against it stays "Likely rideable" — which is exactly how a
//     rider walks to three likely-rideable scooters in a row and finds all
//     three broken.
//
// The rider's own report is the signal that closes all three, and it already
// has a pipeline: `POST /reports/device` with `not_rideable` flips
// `has_negative_report` for 24 h, which overrides the tier outright. What it
// did NOT have was a place to be given. The only button that sent one lived in
// the device popup's report row — a surface a rider is not looking at while
// standing over a scooter that will not turn on, three taps into a ride they
// are trying to begin. So the signal was lost at the exact moment it was most
// certain, and the fleet kept calling those scooters rideable.
//
// This module is the decision and the words, kept pure and apart from the
// screen that shows them, because the screen is a DOM test and this is the
// part worth asserting on directly.
//
// ONE RULE ABOUT THE 24-HOUR FLAG. It is scoped to the vehicle's current h3_10
// cell server-side: the moment the scooter moves, the flag goes stale and the
// device is rideable again. That is correct and deliberate — somebody came and
// collected it — and it is why this report is worth sending even about a
// scooter that will be fine tomorrow. Nothing here needs to know about that;
// it is written down so nobody "fixes" the report into something stickier.

import type { DeviceReport } from "./reports.ts";

/** What came of telling us. Four outcomes, because three of them are things
 *  the rider should be told in different words and the fourth is "we never
 *  had anything to send". */
export type FailedStartOutcome =
  /** Stored. The fleet now knows. */
  | "reported"
  /** The API recognised it as a repeat of a recent identical report. Still a
   *  success from the rider's side — somebody (possibly them) already said
   *  so, and the signal is live. */
  | "deduped"
  /** We never knew which vehicle this was, so there was nothing to report
   *  against. A manual-plate ride whose plate never resolved, or an own-device
   *  ride, which has no Veo scooter in it at all. */
  | "unreportable"
  /** The network or the server refused. */
  | "failed";

/** True when the report actually reached the fleet's reliability signal. */
export function failedStartCounted(outcome: FailedStartOutcome): boolean {
  return outcome === "reported" || outcome === "deduped";
}

/** What to say about it.
 *
 *  Each line says what happened to the information, because that is the only
 *  thing the rider gains by having told us — they still have no scooter. The
 *  success copy promises the specific, true consequence (other riders see it)
 *  and never a vaguer, bigger one (it will be fixed). */
export function failedStartMessage(outcome: FailedStartOutcome): string {
  switch (outcome) {
    case "reported":
      return "Thanks — we've marked this one as not rideable, so the next rider sees the warning on the map.";
    case "deduped":
      return "Someone's already reported this one as not rideable — it's flagged on the map.";
    case "unreportable":
      return "We couldn't tell which scooter this was, so there's nothing to flag. Pick another and you're on your way.";
    case "failed":
      return "Couldn't send the report just now — the scooter still isn't rideable, so go ahead and pick another.";
  }
}

/** What the screen we came from should do next. A rider who has just told us a
 *  scooter is broken wants a different scooter, so the useful next step is
 *  always the picker — the only question is whether we also owe them a word
 *  about the report. */
export interface FailedStartResult {
  outcome: FailedStartOutcome;
  message: string;
}

export interface FailedStartSubject {
  /** 16-hex `vehicle_identifier`. Null for an own-device ride, or a
   *  manual-plate pick whose plate never reverse-resolved. */
  vehicleIdentifier: string | null;
  /** Where the rider is standing. Sent when known: `/reports/summary` skips
   *  rows with a NULL position, so a report without one still counts toward
   *  the device's own flag but drops out of every regional rollup. */
  lat?: number;
  lng?: number;
}

/** Send it, and say what came of it.
 *
 *  NEVER THROWS. A rider standing over a dead scooter has one thing left to
 *  do — pick another one — and an exception propagating out of a report is how
 *  a flow strands them on an error instead. The refusal becomes a sentence and
 *  the flow carries on, which is the same posture `reports.ts`'s other callers
 *  take. */
export async function reportFailedStart(
  subject: FailedStartSubject,
  submit: (report: DeviceReport) => Promise<{ deduped: boolean }>,
): Promise<FailedStartResult> {
  const id = subject.vehicleIdentifier;
  // The API requires ≥16 chars and it is a salted hash the browser cannot
  // compute, so a short one is a bug upstream of here, not something to pad.
  if (!id || id.length < 16) {
    return {
      outcome: "unreportable",
      message: failedStartMessage("unreportable"),
    };
  }
  const report: DeviceReport = {
    vehicle_identifier: id,
    report_type: "not_rideable",
  };
  if (
    typeof subject.lat === "number" &&
    Number.isFinite(subject.lat) &&
    typeof subject.lng === "number" &&
    Number.isFinite(subject.lng)
  ) {
    report.lat = subject.lat;
    report.lng = subject.lng;
  }
  try {
    const { deduped } = await submit(report);
    const outcome: FailedStartOutcome = deduped ? "deduped" : "reported";
    return { outcome, message: failedStartMessage(outcome) };
  } catch {
    return { outcome: "failed", message: failedStartMessage("failed") };
  }
}
