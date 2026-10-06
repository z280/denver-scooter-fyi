// Asking for location at page load, rather than waiting to be asked.
//
// WHAT CHANGED AND WHY. `locate.ts`'s header used to say location was
// "strictly opt-in — nothing here runs until the user taps the geolocate
// button". That was a defensible default for a map you browse and the wrong
// one for a map you use standing on a pavement: almost everything this app
// computes is relative to where the rider is — the walk estimate on every
// popup, "worth the walk" ranking, the 75 m proximity gates, which scooter
// Screen 2 preselects — and all of it sat behind a button a first-time visitor
// has no reason to press. A rider who opens the app is already outside.
//
// The browser's own permission prompt is still the gate. Nothing here can
// grant anything; it decides only WHEN to ask, and the honest answer is "while
// the rider is looking at the map they just opened, not three taps into a ride
// wizard".
//
// THREE RULES THIS MODULE EXISTS TO KEEP:
//
//  1. Never ask a rider who already said no. A `denied` permission makes
//     `trigger()` an error flash in the UI and nothing else — the browser will
//     not re-prompt, so asking again only produces the error. We read the
//     Permissions API first and stay silent on `denied`.
//  2. Never ask twice. A deep link into a live ride (`?ride=`) resumes with a
//     watch already running, and `ride-resume-prompt.ts` may have triggered
//     before the map even finished loading. An existing fix means the job is
//     already done.
//  3. An already-granted permission must not look like a question. Where the
//     state is `granted` the trigger is silent and instant, which is the whole
//     payoff of asking early — the second visit opens centred on the rider.
//
// Permissions API support is not universal (older Safari has no
// `navigator.permissions.query` for geolocation, and some engines reject the
// name). Everywhere it is missing we fall through to asking, which is exactly
// what a browser without it does anyway: show the prompt, or error silently if
// the rider blocked us.

/** What came of the attempt. Returned rather than logged so a caller can act
 *  on it (and so this is assertable without a browser). */
export type LocateOnLoadOutcome =
  /** Permission was already granted: locating started with no prompt. */
  | "granted"
  /** We asked. Whether the rider says yes is now between them and the
   *  browser — `Locate`'s own `onFix`/`onError` listeners carry the answer. */
  | "prompted"
  /** The rider has blocked us. Nothing was asked and nothing was triggered. */
  | "denied"
  /** A fix was already in hand, so there was nothing to ask for. */
  | "already"
  /** No geolocation in this browser at all. */
  | "unsupported";

export interface LocateOnLoadDeps {
  /** `Locate.trigger` — starts the watch, prompting if the browser must. */
  trigger(): void;
  /** `Locate.current() !== null`, i.e. a fresh fix is already in hand. */
  hasFix(): boolean;
  /** Overridden in tests. Resolves the geolocation permission state, or null
   *  when this browser cannot say. */
  permission?(): Promise<PermissionState | null>;
  /** Overridden in tests. False when the browser has no geolocation. */
  supported?(): boolean;
}

function defaultSupported(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

/** Read the geolocation permission state, or null if we cannot.
 *
 *  Every failure mode here means the same thing — "we do not know" — so they
 *  all collapse to null rather than to a guess: a missing `permissions`, a
 *  `query` that rejects on the name (some engines), and a state string this
 *  code does not recognise.
 */
async function defaultPermission(): Promise<PermissionState | null> {
  try {
    const perms = navigator.permissions;
    if (!perms?.query) return null;
    const status = await perms.query({
      name: "geolocation" as PermissionName,
    });
    const state = status?.state;
    return state === "granted" || state === "denied" || state === "prompt"
      ? state
      : null;
  } catch {
    return null;
  }
}

/** Ask for location now, unless one of the three rules above says not to.
 *
 *  Never throws and never rejects: a page that fails to load because the
 *  location courtesy call went wrong would be a far worse bug than the feature
 *  is a benefit.
 */
export async function requestLocationOnLoad(
  deps: LocateOnLoadDeps,
): Promise<LocateOnLoadOutcome> {
  try {
    if (deps.hasFix()) return "already";
    const supported = deps.supported ?? defaultSupported;
    if (!supported()) return "unsupported";

    const state = await (deps.permission ?? defaultPermission)();
    // Re-check after the await: the Permissions API is a round trip, and a
    // rider who tapped the geolocate button during it has already answered.
    if (deps.hasFix()) return "already";
    if (state === "denied") return "denied";

    deps.trigger();
    return state === "granted" ? "granted" : "prompted";
  } catch {
    return "unsupported";
  }
}
