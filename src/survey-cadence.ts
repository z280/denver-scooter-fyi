// How often the post-ride survey is allowed to ask the long questions.
//
// THE PROBLEM. "How likely are you to recommend navigating via Scooter.fyi?"
// is a worthwhile question once. Asked after every single ride it is a tax, and
// it is the question most likely to be the reason a rider starts tapping Skip —
// at which point the survey loses the answers that ARE per-ride (was this
// scooter any good, was this route any good) along with the one that is not.
//
// The API agrees, as it happens: `nav_nps` earns no points and gates no award
// (scooter-fyi-api `api_ride_surveys.py` — every award reads
// `would_ride_again`/`issues`/`model_bonus`/`nav_route_rating`/
// `nav_qualitative`). So asking it less costs the rider nothing and costs us a
// sample rate we never needed.
//
// WHY A LOCAL COUNT. It is a cadence, not a fact about the rider, and it must
// work signed out — a guest rides and surveys too. Same storage discipline as
// `favorites.ts` and `filter-presets.ts`: a versioned blob, every read
// validated, every access try/catch wrapped, and a corrupt or missing value
// degrades to zero. Degrading to zero means "ask", which is the right way for
// this mistake to fall: a rider seeing one extra NPS question after clearing
// their site data has lost nothing.

export const SURVEY_COUNT_KEY = "scooter-fyi-surveys-submitted";

/** Ask on the first survey, then every tenth.
 *
 *  Pure, and takes the count rather than reading it, so the rule is assertable
 *  without storage. The count is surveys ALREADY submitted, so zero is a rider
 *  who has never answered one.
 *
 *  Ten, because the question is about the product rather than the ride: the
 *  answer barely moves between consecutive trips, and a rider who rides daily
 *  then meets it about once a fortnight. */
export function shouldAskNps(surveysSubmitted: number): boolean {
  if (!Number.isFinite(surveysSubmitted) || surveysSubmitted < 0) return true;
  return Math.floor(surveysSubmitted) % 10 === 0;
}

interface StoredCount {
  v: 1;
  n: number;
}

/** Session mirror, used ONLY when storage refuses writes — private mode or
 *  quota. Without it a rider in a private window would be counted at zero
 *  forever and asked the long question after every ride, which is precisely
 *  the behavior this module exists to stop. Null while storage works, so there
 *  is one source of truth in the normal case (the shape `favorites.ts` landed
 *  on for the same reason). */
let sessionCount: number | null = null;

export function surveysSubmitted(): number {
  if (sessionCount !== null) return sessionCount;
  try {
    const raw = localStorage.getItem(SURVEY_COUNT_KEY);
    if (!raw) return 0;
    const blob = JSON.parse(raw) as StoredCount;
    if (blob?.v !== 1 || typeof blob.n !== "number" || !Number.isFinite(blob.n)) {
      return 0;
    }
    return Math.max(0, Math.floor(blob.n));
  } catch {
    return 0;
  }
}

/** Count one. Returns the new total so a caller can decide without a second
 *  read. Called on a SUBMIT, never on a Skip: a skipped survey asked its
 *  questions and got nothing, so counting it would spend the rider's turn in
 *  the cadence on an answer we never received. */
export function recordSurveySubmitted(): number {
  const next = surveysSubmitted() + 1;
  try {
    localStorage.setItem(SURVEY_COUNT_KEY, JSON.stringify({ v: 1, n: next }));
    sessionCount = null;
  } catch {
    sessionCount = next;
  }
  return next;
}

/** Test/HMR seam — forget the session mirror so a fresh case starts clean. */
export function resetSurveyCadence(): void {
  sessionCount = null;
}
