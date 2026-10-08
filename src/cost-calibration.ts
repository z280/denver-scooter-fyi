// §11.2's second half — stop making the rider reconcile our clock by hand.
//
// THE PROBLEM, in the plan's own words: "The HUD offers ±15s/±1m nudges and a
// reset because we cannot see Veo's billing clock. That is an honest
// workaround, and it has become the rider's job."
//
// We cannot see Veo's clock. But a rider who shows us a receipt has shown us
// what Veo billed, and the gap between that and our own figure for the same
// ride is MEASURABLE. If every ride comes in a minute and twenty short, the
// next estimate should start there — which is the difference between a counter
// that is roughly right and one a rider trusts.
//
// WHERE THE INPUT COMES FROM, and why not Screen 8. The plan's original source
// was Screen 8's "type the real cost" form, and that form was deleted for
// strong reasons recorded in `ride-post-s8.ts`: it yanked focus between
// fields, riders never reached Submit, so `endTrackedRide` never fired and the
// ride never reached the donation flow at all. Reinstating it would buy a
// better cost estimate at the price of every ride's donation. The receipt
// reader is the source instead: the rider was going to look at that screenshot
// anyway, it carries a real total and real minutes, and it asks nothing at the
// moment they are trying to put their phone away.
//
// WHAT THIS DELIBERATELY IS NOT:
//
//   - NOT A PRICE CORRECTION. The offset is in TIME, not money. Veo's rates are
//     published and `config.ts` holds them; if our prices were wrong the fix
//     would be the rate table, not a fudge factor. What we genuinely cannot see
//     is WHEN the meter started, so that is the only thing adjusted.
//   - NOT A PER-VEHICLE OR PER-PLAN MODEL. The gap is about how long it takes a
//     rider to go from our clock starting to Veo's — a human interval, not a
//     property of a scooter. One figure per device is the honest resolution.
//   - NOT APPLIED TO THE RIDE CLOCK. The clock is how long the rider has been
//     riding, which they can check against their own watch; inflating it would
//     make the one honest number on the HUD wrong. Only the COST estimate moves.
//   - NOT A SERVER FEATURE. It is one small number learned from this rider's own
//     receipts on this device. Syncing it would need an endpoint, a migration
//     and a conflict story to improve a figure that is already an estimate.

export const CALIBRATION_KEY = "scooter-fyi-cost-calibration";

const BLOB_V = 1;

/** How many samples to keep.
 *
 *  Five, because the median of five is the first window where a single bad
 *  reading cannot move the answer and the rider still sees it respond within a
 *  week of ordinary riding. A longer window would make the figure slower to
 *  correct itself than the habit it is measuring. */
export const MAX_SAMPLES = 5;

/** Below two samples there is no offset at all.
 *
 *  One receipt is an anecdote. A rider whose single reading came from the trip
 *  where they scanned, took a phone call and unlocked four minutes later would
 *  carry that four minutes into every estimate afterwards — and they would have
 *  no idea why, because one sample also gives them nothing to compare it to. */
export const MIN_SAMPLES = 2;

/** The widest gap worth believing, in minutes, either way.
 *
 *  Beyond this the likelier explanations are all boring: a receipt matched to
 *  the wrong ride, an OCR misread, a rider who walked away mid-ride, or the
 *  app reloaded and lost a start time. A twenty-minute "calibration" would
 *  silently wreck every estimate afterwards, and the rider would experience it
 *  as the app being broken rather than as a setting to clear. Samples outside
 *  it are dropped on the way in and never stored. */
export const MAX_PLAUSIBLE_GAP_MIN = 10;

export interface CalibrationSample {
  /** Our own billed-minute figure for that ride. */
  ourMinutes: number;
  /** What Veo's receipt said. */
  veoMinutes: number;
  atMs: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSample(v: unknown): CalibrationSample | null {
  if (!isRecord(v)) return null;
  const { ourMinutes, veoMinutes, atMs } = v;
  if (
    typeof ourMinutes !== "number" ||
    typeof veoMinutes !== "number" ||
    typeof atMs !== "number" ||
    !Number.isFinite(ourMinutes) ||
    !Number.isFinite(veoMinutes) ||
    !Number.isFinite(atMs)
  ) {
    return null;
  }
  if (!isPlausible(ourMinutes, veoMinutes)) return null;
  return { ourMinutes, veoMinutes, atMs };
}

/** Both figures have to be real billed minutes, and the gap has to be one a
 *  human could produce. Checked on the way IN and again on the way OUT, so a
 *  blob written by an older build — or by hand — cannot put an implausible
 *  figure into every estimate. */
export function isPlausible(ourMinutes: number, veoMinutes: number): boolean {
  if (!Number.isFinite(ourMinutes) || !Number.isFinite(veoMinutes)) return false;
  if (ourMinutes < 1 || veoMinutes < 1) return false;
  return Math.abs(veoMinutes - ourMinutes) <= MAX_PLAUSIBLE_GAP_MIN;
}

export function loadSamples(): CalibrationSample[] {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as { v?: unknown; samples?: unknown };
    if (!isRecord(blob) || blob.v !== BLOB_V) return [];
    if (!Array.isArray(blob.samples)) return [];
    const out: CalibrationSample[] = [];
    for (const s of blob.samples) {
      const parsed = parseSample(s);
      if (parsed !== null) out.push(parsed);
    }
    return out.slice(-MAX_SAMPLES);
  } catch {
    return [];
  }
}

function persist(samples: CalibrationSample[]): boolean {
  try {
    localStorage.setItem(
      CALIBRATION_KEY,
      JSON.stringify({ v: BLOB_V, samples: samples.slice(-MAX_SAMPLES) }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Learn from one receipt. Returns the samples now held, so a caller can see
 *  whether anything was taken without a second read.
 *
 *  An implausible pair is DROPPED SILENTLY rather than reported: the rider is
 *  filing a receipt, not calibrating a clock, and an error about an internal
 *  estimate would be the app asking them to debug it. */
export function recordSample(input: {
  ourMinutes: number;
  veoMinutes: number;
  atMs?: number;
}): CalibrationSample[] {
  const { ourMinutes, veoMinutes } = input;
  if (!isPlausible(ourMinutes, veoMinutes)) return loadSamples();
  const next = [
    ...loadSamples(),
    { ourMinutes, veoMinutes, atMs: input.atMs ?? Date.now() },
  ].slice(-MAX_SAMPLES);
  persist(next);
  return next;
}

export function clearCalibration(): void {
  try {
    localStorage.removeItem(CALIBRATION_KEY);
  } catch {
    // Nothing to report: the figure this clears is an estimate's estimate, and
    // the next `recordSample` rewrites the blob wholesale anyway.
  }
}

/** The learned offset in MINUTES, positive when Veo bills more than we
 *  estimate. Zero when there is not enough to say.
 *
 *  THE MEDIAN, NOT THE MEAN. One receipt from the ride where the rider got
 *  distracted between the scan and the unlock is exactly the sample a mean
 *  would carry forever. With five samples the median needs three bad ones to
 *  shift, and three bad ones is a real pattern rather than an accident. */
export function calibrationOffsetMinutes(
  samples: CalibrationSample[] = loadSamples(),
): number {
  if (samples.length < MIN_SAMPLES) return 0;
  const deltas = samples
    .map((s) => s.veoMinutes - s.ourMinutes)
    .sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 1
    ? deltas[mid]
    : (deltas[mid - 1] + deltas[mid]) / 2;
}

/** The offset as milliseconds to ADD to an elapsed figure before pricing it.
 *
 *  Clamped at zero from below, and that asymmetry is deliberate: an offset that
 *  SHORTENED the estimate would under-quote a rider against the bill they are
 *  about to be charged, which is the one direction this feature must never move
 *  the number. Learning that we run long is still useful — it stops the figure
 *  drifting further — but it is used to stop correcting, never to discount. */
export function calibrationOffsetMs(
  samples: CalibrationSample[] = loadSamples(),
): number {
  return Math.max(0, calibrationOffsetMinutes(samples)) * 60_000;
}

/** The sentence the rider is shown, or null when there is nothing to say.
 *
 *  It names the direction in their terms ("short" means our figure was under
 *  Veo's) and never says "calibrated" or "offset" — the rider's question is
 *  "why is this number different from my bill", and the answer is a sentence
 *  about their rides, not about our arithmetic.
 *
 *  Null below `MIN_SAMPLES`, and null at a zero median even with enough
 *  samples: "your estimates have been running about 0 minutes short" is the app
 *  talking to itself. */
export function calibrationSentence(
  samples: CalibrationSample[] = loadSamples(),
): string | null {
  if (samples.length < MIN_SAMPLES) return null;
  const mins = calibrationOffsetMinutes(samples);
  if (mins === 0) return null;
  const magnitude = Math.abs(mins);
  const unit = magnitude === 1 ? "minute" : "minutes";
  const rounded =
    Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(1);
  const direction = mins > 0 ? "short" : "long";
  return (
    `From your last ${samples.length} receipts, our cost estimates have been ` +
    `running about ${rounded} ${unit} ${direction}.` +
    (mins > 0 ? " We've started them there instead." : "")
  );
}

// ---------------------------------------------------------------------------
// Matching a receipt to a ride
// ---------------------------------------------------------------------------
//
// A receipt carries a plate and a CHARGE DATE — no time of day
// (`equity-receipt-form.ts` records what a Veo receipt actually shows). The
// rides we recorded carry timestamps but not plates: `TrackedRide` holds a
// `vehicle_identifier`, and turning a printed plate into one needs the live
// feed, which is gone by the time a rider files a receipt for last Tuesday.
//
// So the match is on the DAY, and it REFUSES AMBIGUITY. One recorded ride that
// day means the receipt is about that ride. Two or more means we cannot tell,
// and a wrong pairing is exactly the sample that would teach us a four-minute
// offset from somebody else's trip. Learning nothing is free; learning the
// wrong thing is not.

/** A ride we recorded, reduced to the two things a match needs. */
export interface RideSpanForMatch {
  startedAtMs: number;
  endedAtMs: number | null;
}

/** Our own billed minutes for a span: Veo bills the started minute, so this is
 *  `ceil` with a floor of one, exactly as `billableMinutes` does — imported in
 *  spirit rather than in code, because this module prices nothing and pulling
 *  in `ride-cost.ts` for one `ceil` would couple the two for no gain.
 *
 *  Null for a ride with no end: an unfinished ride has no billed minutes, and
 *  "now minus started" for a row from last week is not a ride length. */
export function ourBilledMinutes(span: RideSpanForMatch): number | null {
  if (span.endedAtMs === null) return null;
  const ms = span.endedAtMs - span.startedAtMs;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** The Denver calendar day a timestamp falls in, as `YYYY-MM-DD`.
 *
 *  Denver and not the device's zone, for the reason `dibs.ts` already gives
 *  about its own clock: a rider in another timezone reading their Denver
 *  receipt would otherwise be matched against the wrong day, and the receipt's
 *  printed date is Veo's, which is Denver's. */
export function denverDay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(
      new Date(ms),
    );
  } catch {
    return null;
  }
}

/** Our minutes for the one ride that day, or null when there is no unambiguous
 *  answer. See the block comment above for why ambiguity refuses. */
export function matchOurMinutes(
  spans: readonly RideSpanForMatch[],
  chargeDate: string,
): number | null {
  const sameDay: number[] = [];
  for (const span of spans) {
    if (denverDay(span.startedAtMs) !== chargeDate) continue;
    const mins = ourBilledMinutes(span);
    if (mins !== null) sameDay.push(mins);
  }
  return sameDay.length === 1 ? sameDay[0] : null;
}

/** The whole of the host's job: given the rides we know about and a receipt,
 *  learn from it or do nothing. Returns whether a sample was taken, so a
 *  caller can tell without re-reading storage. */
export function learnFromReceipt(input: {
  spans: readonly RideSpanForMatch[];
  chargeDate: string;
  veoMinutes: number;
  atMs?: number;
}): boolean {
  const ourMinutes = matchOurMinutes(input.spans, input.chargeDate);
  if (ourMinutes === null) return false;
  // Asked directly rather than inferred from the stored list changing: once
  // the window is full a taken sample does not change its length, and a
  // caller told "nothing happened" when something did is worse than one told
  // nothing at all.
  if (!isPlausible(ourMinutes, input.veoMinutes)) return false;
  recordSample({ ourMinutes, veoMinutes: input.veoMinutes, atMs: input.atMs });
  return true;
}
