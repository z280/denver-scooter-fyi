// Whether this rider saves ride tracks — one standing answer, not a question
// asked per ride.
//
// It used to be a per-ride toggle on the pre-start survey, which is what put
// a full-screen options page in front of a rider who was already standing at
// a scooter with a destination chosen. The answer never actually varied: a
// rider who wants their tracks wants them every time, and a rider who doesn't
// is being asked to decline repeatedly. So it moved here, and the survey lost
// its last reason to exist.
//
// It lives in localStorage rather than on the account because the tracks
// themselves do (see `track-store.ts` and the Local Data panel's own copy:
// "Rides this device recorded. They stay here — nothing is uploaded unless
// you donate it."). A preference about device-local recording that only took
// effect once you signed in would be a strange promise to make, and syncing
// it would mean uploading a fact about a rider who has deliberately not
// uploaded anything.
//
// DEFAULT ON, matching the `save_tracks: true` that `defaultRideOptions()`
// has always shipped — this is a move, not a policy change, and a rider who
// never opens the panel keeps exactly the behaviour they had. Turning it off
// still cascades the same way it always did (`ride-settings.ts`'s
// `save_tracks_off` reason disables battery modelling and nav improvement,
// which have nothing to run on without a track).

const KEY = "scooter-fyi-save-tracks";

/** Storage can throw (Safari private mode) and can hold anything (another
 *  tab, a corrupted profile). Both collapse to the default rather than
 *  breaking a ride that has nothing to do with a preference read. */
export function savesTracks(): boolean {
  try {
    // Only an explicit "0" is off. Never written, or written by something
    // that isn't us (another tab, a corrupted profile, a future format), is
    // the same state as far as this can honestly tell: we have no answer, so
    // use the default. Reading garbage as "off" would silently stop
    // recording a rider's rides on the strength of a value we can't parse.
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSavesTracks(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* a preference that cannot be stored is not worth failing a ride over */
  }
}
