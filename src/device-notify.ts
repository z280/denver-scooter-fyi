// "Tell me if it moves" — for a scooter the rider is already connected to.
//
// READ THIS BEFORE ADDING AN ENTRY POINT. This feature shipped once with a
// bell on every device popup: tap any scooter on the map, get told when it
// moves. That version is GONE, and not because it did not work.
//
// "Notify me when this vehicle leaves this address" is a tracking tool with a
// mobility skin on it. The scooter parked outside a house is a proxy for the
// person in the house: an ex's place, a partner's, a shelter's. Armed from the
// map, with no account and no proximity, it told a stranger the moment
// somebody left — which is a thing this app must not be able to do, however
// many riders would have used it for "can I get that one after dinner".
//
// So the capability now requires a PRESENT, DEMONSTRATED CONNECTION to the
// specific vehicle, and it dies when that connection does. There are exactly
// two origins, and `WATCH_RULES` below is the whole of the policy:
//
//   * `dibs` — a scooter the rider has CLAIMED while building a route. Dibs
//     already requires the vehicle to be within a 15-minute walk and expires
//     in at most 25 minutes (`dibs.ts`), so a watch inherits both: you cannot
//     arm one for a scooter across town, and it cannot outlive the trip.
//     Capped at TWO, tighter than dibs' own ceiling of three.
//   * `ride_end` — the scooter the rider has just finished riding. One, for a
//     few hours, offered once at the end of the ride.
//
// Both origins answer "is this vehicle still available to ME", which is the
// question the feature was for. Neither can be pointed at a vehicle the rider
// has never been to, because arming one requires having claimed it (and walked
// toward it) or ridden it.
//
// EXPIRY IS PART OF THE SAFETY ARGUMENT, not housekeeping. A watch with no end
// is a standing subscription to one address's comings and goings. Every watch
// carries `expiresAt`, `loadWatches` drops the expired, and the two lifetimes
// above are deliberately short.
//
// WHAT THIS REPLACED BEFORE THAT, AND WHY IT IS NOT THE SAME FEATURE.
//
// The old feature was "keep this one": a server-side list of favourite
// vehicles. It cost a sign-in, a QR scan and a fix within 75 m of the scooter,
// and in exchange it told you where a scooter you liked was parked — which the
// map already does, for every scooter, to anybody, with no scan. The gate was
// the heaviest in the app and the payoff was a filtered view of public data.
// Meanwhile the thing a rider actually wants to know about a specific scooter
// is the one thing a map cannot tell them by sitting there: that it has gone.
//
// So the question flips. Not "remember this scooter for me" but "tell me when
// this one moves", which is a notification, needs no account, needs no scan,
// and is worth something the map is not already doing.
//
// WHERE THE SHAPE COMES FROM. `docs/ALONG_THE_WAY_PLAN.md` §4.4 specified
// per-vehicle alerts as an opt-in, off by default, delivered through the same
// in-app + Notification API path `dibs-notify.ts` uses, carrying no location
// ("the rider opens the app to see where, which they were going to do
// anyway"). §9.3's table says the same thing about the event that matters:
// "your pickup is gone" is the one worth interrupting somebody for. This is
// that — and note that §9.3's phrasing is already the gated version: YOUR
// pickup. The generalisation onto any scooter on the map was the mistake, and
// walking it back lands exactly where the plan started.
//
// AND WHY IT IS LOCAL. A watch is a thing this browser is doing for the next
// few hours, not a fact about a person. Keeping it client-side means it works
// signed out — which is most visitors — and means no new endpoint, no new
// stored association between an account and a vehicle, and nothing to delete
// later. Same storage discipline as `favorites.ts` and `filter-presets.ts`: a
// versioned blob, every read validated, every access try/catch wrapped, and a
// corrupt blob degrades to "watching nothing" rather than throwing.
//
// WHAT IT CANNOT DO, said plainly because the copy must not overpromise: the
// check runs on the device feed's own refresh, in this tab, while the page is
// alive. A closed tab hears nothing. §9.4 is explicit that the backgrounded
// half of this needs an API-side watcher, which is not in this repo — so the
// rider-facing copy promises "while the app is open" and nothing more.

import { distanceMeters, type LngLat } from "./locate.ts";

export const NOTIFY_MOVED_KEY = "scooter-fyi-notify-moved";

/** Where a watch is allowed to come from. See the header: these two are the
 *  whole list, and adding a third is a policy change, not a feature. */
export type WatchOrigin = "dibs" | "ride_end";

/** The policy, as data, so every caller is held to the same numbers and the
 *  tests can read them rather than restate them.
 *
 *  `max` is per origin rather than overall on purpose: the two are different
 *  capabilities with different justifications, and letting a rider spend their
 *  ride-end watch on a third claimed scooter would quietly merge them. */
export const WATCH_RULES: Record<
  WatchOrigin,
  { max: number; ttlMs: number }
> = {
  // Two, against dibs' own ceiling of three. The third claim in a group is
  // the one a rider is least committed to, and the alert is worth most for
  // the pickup they are actually walking to. The TTL is a backstop only —
  // the caller passes the claim's real `dibsExpiresAt`, which is sooner.
  dibs: { max: 2, ttlMs: 25 * 60_000 },
  // One scooter, because there is one scooter you just got off. Two would
  // mean one from an earlier ride, which is the "a vehicle I am no longer
  // connected to" case this whole design exists to refuse.
  //
  // Two hours: long enough for "can I get it again after dinner", short
  // enough that it is not a subscription to wherever it ends up overnight.
  ride_end: { max: 1, ttlMs: 2 * 60 * 60_000 },
};

/** Total ceiling, derived rather than declared so it cannot drift from the
 *  rules above. Used for the storage read's own sanity slice. */
export const MAX_WATCHED_DEVICES =
  WATCH_RULES.dibs.max + WATCH_RULES.ride_end.max;

/** How far a scooter has to be from where we started watching before we call it
 *  moved.
 *
 *  FIFTY, AND IT IS MEASURED RATHER THAN CHOSEN. The API's own
 *  `ride_watch.py` recorded this against the live fleet on 2026-08-10:
 *  consecutive samples of a vehicle somebody was riding moved 320 m on
 *  average, with 68% of steps over 50 m — against 1.2 m for the rest of the
 *  fleet, with 0.2% of steps over 50 m. So 50 m is a line with a known error
 *  rate on both sides: a parked scooter's GPS crosses it about one sample in
 *  five hundred, and a ridden one crosses it two times in three.
 *
 *  That matters because the two mistakes cost different amounts. A missed move
 *  is noticed a minute later on the next poll; a false one buzzes a rider's
 *  phone about a scooter that never left, and the second time that happens they
 *  stop believing the alert. So the line sits where the jitter does not reach.
 *
 *  Deliberately wider than the ingest's own `stationary_threshold_meters`
 *  (config.json: 16 m), which answers a different question — it is tuned for
 *  reconstructing trip history from a feed the server trusts, where a false
 *  MOVED is a data error it can live with.
 *
 *  ONE NUMBER, NOT TWO. The texted tier of this feature (ALONG_THE_WAY_PLAN
 *  §9.7, master §13.8) composes its message server-side around this same 50 m,
 *  and says so in words the rider reads: "no longer within 50m of where you
 *  scanned". A rider who gets the text and then opens the app is the COMMON
 *  case — the text is for when the app is shut — so a second threshold here is
 *  how the two end up disagreeing in front of the one person who sees both. */
export const MOVED_METERS = 50;

/** A vehicle missing from ONE device response is not a vehicle that is gone —
 *  the same rule, for the same reason, as `device-watch.ts`'s own
 *  `MISSING_TICKS_BEFORE_GONE`: GBFS feeds drop and re-add vehicles between
 *  polls for reasons that have nothing to do with anybody riding them. Two
 *  consecutive misses on the 90-second device refresh is about three minutes. */
export const MISSING_TICKS_BEFORE_GONE = 2;

export interface WatchedDevice {
  /** 16-hex `vehicle_identifier` — stable across the GBFS id rotations that
   *  make `device_id` useless for this. */
  vehicleIdentifier: string;
  /** Rider-facing name ("Lunar 🐸 928"), stored rather than re-derived: the
   *  alert has to name the scooter, and by the time it fires the device may
   *  have left the feed entirely and have no name left to look up. */
  name: string;
  /** Where it was when the watch started. The whole comparison. */
  lat: number;
  lon: number;
  /** When the rider asked, ms since epoch. Shown in the list, and what the cap
   *  evicts on. */
  since: number;
  /** Which of the two permitted connections to the vehicle this watch rests
   *  on. Not decoration: it picks the cap, it is what the list shows the rider
   *  about why they are watching, and a stored watch with an unrecognised
   *  origin is treated as corrupt and dropped. */
  origin: WatchOrigin;
  /** When this watch stops existing, ms since epoch. Absolute rather than a
   *  duration so a tab left open overnight expires it on the next read instead
   *  of restarting its clock. A dibs watch gets the claim's own expiry. */
  expiresAt: number;
}

interface StoredWatches {
  v: 1;
  watches: WatchedDevice[];
}

function isValidWatch(w: unknown): w is WatchedDevice {
  if (!w || typeof w !== "object") return false;
  const r = w as Record<string, unknown>;
  return (
    typeof r.vehicleIdentifier === "string" &&
    r.vehicleIdentifier.length >= 16 &&
    typeof r.name === "string" &&
    r.name.length > 0 &&
    typeof r.lat === "number" &&
    Number.isFinite(r.lat) &&
    typeof r.lon === "number" &&
    Number.isFinite(r.lon) &&
    typeof r.since === "number" &&
    Number.isFinite(r.since) &&
    (r.origin === "dibs" || r.origin === "ride_end") &&
    typeof r.expiresAt === "number" &&
    Number.isFinite(r.expiresAt)
  );
}

/** Session mirror, used ONLY when storage refuses writes — private mode or
 *  quota. Without it every add re-reads an empty store and the rider watches
 *  the scooter they just added disappear from the list (the exact bug
 *  `favorites.ts` carries a comment about, found on PR #74). Null while storage
 *  works, so there is one source of truth in the normal case. */
let sessionWatches: WatchedDevice[] | null = null;

/** Drop what has run out. Applied on every read rather than on a timer: a
 *  phone that slept through an expiry still has to come back to a list with
 *  nothing stale in it, and there is no background anything here to tick. */
export function liveWatches(
  watches: readonly WatchedDevice[],
  now: number = Date.now(),
): WatchedDevice[] {
  return watches.filter((w) => w.expiresAt > now);
}

export function loadWatches(now: number = Date.now()): WatchedDevice[] {
  if (sessionWatches !== null) return liveWatches(sessionWatches, now);
  try {
    const raw = localStorage.getItem(NOTIFY_MOVED_KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as StoredWatches;
    if (blob?.v !== 1 || !Array.isArray(blob.watches)) return [];
    // Validate, expire, then cap — in that order, so a corrupt or stale row
    // cannot occupy one of the handful of slots a valid one needs.
    return liveWatches(blob.watches.filter(isValidWatch), now).slice(
      0,
      MAX_WATCHED_DEVICES,
    );
  } catch {
    return [];
  }
}

function persist(watches: WatchedDevice[]): boolean {
  try {
    localStorage.setItem(
      NOTIFY_MOVED_KEY,
      JSON.stringify({ v: 1, watches } satisfies StoredWatches),
    );
    sessionWatches = null;
    return true;
  } catch {
    sessionWatches = watches.slice();
    return false;
  }
}

/** Pure list logic, exported so the replace-and-cap rules are testable without
 *  touching storage.
 *
 *  Watching the same vehicle twice REPLACES rather than appends — re-claiming a
 *  scooter that has since been moved is how a rider re-arms the watch from its
 *  new position, and two rows for one scooter would alert twice. Newest first.
 *
 *  THE CAP IS PER ORIGIN and it drops the OLDEST of that origin — the claim
 *  the rider set off for first, or the earlier ride. A shared cap would let a
 *  third claimed scooter evict the watch on the one the rider just rode, which
 *  is two different capabilities spending each other's budget. */
export function addWatch(
  existing: readonly WatchedDevice[],
  watch: WatchedDevice,
): WatchedDevice[] {
  const kept = existing.filter(
    (w) => w.vehicleIdentifier !== watch.vehicleIdentifier,
  );
  const sameOrigin = [watch, ...kept.filter((w) => w.origin === watch.origin)]
    .slice(0, WATCH_RULES[watch.origin].max)
    .map((w) => w.vehicleIdentifier);
  const keptSet = new Set(sameOrigin);
  return [watch, ...kept].filter(
    (w) => w.origin !== watch.origin || keptSet.has(w.vehicleIdentifier),
  );
}

/** Whether a new watch of this origin would be refused, and why.
 *
 *  Exported because the UI has to be able to say "you are already watching two"
 *  rather than silently dropping the rider's oldest claim — and because the
 *  ride-end offer should not appear at all when it cannot be taken. */
export function watchSlotsLeft(
  existing: readonly WatchedDevice[],
  origin: WatchOrigin,
  now: number = Date.now(),
): number {
  const live = liveWatches(existing, now).filter((w) => w.origin === origin);
  return Math.max(0, WATCH_RULES[origin].max - live.length);
}

export function removeWatch(
  existing: readonly WatchedDevice[],
  vehicleIdentifier: string,
): WatchedDevice[] {
  return existing.filter((w) => w.vehicleIdentifier !== vehicleIdentifier);
}

/** Start watching. Returns the new list so a caller can re-render without a
 *  second read. */
export function watchMoved(watch: WatchedDevice): WatchedDevice[] {
  const next = addWatch(loadWatches(), watch);
  persist(next);
  return next;
}

/** Stop watching. */
export function unwatchMoved(vehicleIdentifier: string): WatchedDevice[] {
  const next = removeWatch(loadWatches(), vehicleIdentifier);
  persist(next);
  return next;
}

export function isWatched(
  watches: readonly WatchedDevice[],
  vehicleIdentifier: string,
): boolean {
  return watches.some((w) => w.vehicleIdentifier === vehicleIdentifier);
}

/** Test/HMR seam — drop the session mirror. */
export function resetWatchSession(): void {
  sessionWatches = null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** What the feed currently says about a watched vehicle. The caller builds this
 *  from the device response it already has — nothing here fetches. */
export interface DeviceNow {
  lat: number;
  lon: number;
  /** Veo's `is_reserved`, which on this operator means IN USE rather than held
   *  (see `device-watch.ts`'s own note on the GBFS quirk). */
  inUse: boolean;
}

export type MovedVerdict =
  /** Still where the rider left it, and still rentable. Nothing to say. */
  | { kind: "still" }
  /** Somebody rode it. */
  | { kind: "moved"; meters: number }
  /** Veo says it is in use — it is being ridden right now, and where it ends up
   *  is not knowable yet. Reported separately from `moved` because it is the
   *  more certain claim and the earlier one: the feed admits the rental before
   *  the position changes. */
  | { kind: "in_use" }
  /** It stopped appearing in the feed. */
  | { kind: "gone" };

/** Has this watched scooter stopped being there?
 *
 *  Pure, and takes the miss count rather than keeping one, so the whole rule is
 *  assertable with plain values.
 *
 *  ORDER IS THE POINT. The most certain, most specific reason wins, so the
 *  rider is told what actually happened rather than the vaguest true thing —
 *  the same discipline `device-watch.ts` applies to the same question. A
 *  vehicle that is both in use and 40 m away was ridden, and "someone's riding
 *  it" is what a rider can act on. */
export function movedVerdict(
  watch: WatchedDevice,
  now: DeviceNow | undefined,
  consecutiveMisses: number,
): MovedVerdict {
  if (!now) {
    return consecutiveMisses >= MISSING_TICKS_BEFORE_GONE
      ? { kind: "gone" }
      : { kind: "still" };
  }
  if (now.inUse) return { kind: "in_use" };
  const from: LngLat = { lng: watch.lon, lat: watch.lat };
  const to: LngLat = { lng: now.lon, lat: now.lat };
  const meters = distanceMeters(from, to);
  if (meters >= MOVED_METERS) return { kind: "moved", meters };
  return { kind: "still" };
}

/** Is this a verdict worth interrupting somebody for? */
export function isAlertable(v: MovedVerdict): boolean {
  return v.kind !== "still";
}

/** The message.
 *
 *  NO LOCATION, deliberately (ALONG_THE_WAY_PLAN §4.4): the alert says the
 *  scooter went, and the rider opens the app to see where — which they were
 *  going to do anyway. A lock-screen notification carrying coordinates is a
 *  lock-screen notification carrying somebody's whereabouts, and it renders on a
 *  screen anybody standing nearby can read.
 *
 *  Each line leads with a glyph and says the consequence in its first clause,
 *  because it is read at a glance, mid-stride, the way `dibs-notify.ts`'s copy
 *  is. The distance is not quoted either — "27 m" invites a rider to go and
 *  look at a spot the scooter is already leaving. */
export function movedMessage(name: string, verdict: MovedVerdict): string {
  switch (verdict.kind) {
    case "moved":
      return `🛴 ${name} has moved — somebody rode it.`;
    case "in_use":
      return `🛴 Someone's riding ${name} right now.`;
    case "gone":
      return `🫥 ${name} has dropped off the map.`;
    case "still":
      // Never sent. "We checked and it is fine" is not reassurance, it is
      // attrition (ALONG_THE_WAY_PLAN §9.3), and this exists only so the
      // switch is total.
      return `${name} hasn't moved.`;
  }
}

// ---------------------------------------------------------------------------
// The notifier
// ---------------------------------------------------------------------------

/** Ask for notification permission at the moment the rider turns a watch ON.
 *
 *  Not at load. Somebody who has just asked to be told when a scooter moves has
 *  a reason to be interrupted and knows what about; the same prompt on arrival
 *  at a map is the one everybody denies reflexively, and a denial is permanent.
 *  A denial costs nothing here: the alert still lands in the app, which is
 *  where the rider will be when they next look.
 *
 *  Same function, same reasoning, as `dibs-notify.ts`'s
 *  `requestDibsNotifications` — kept separate rather than shared because that
 *  one's doc comment is specifically about the claim, and a shared helper whose
 *  comment describes one of its two callers is worse than two short functions. */
export async function requestMovedNotifications(): Promise<boolean> {
  try {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export interface DeviceNotifyDeps {
  /** Show it inside the app as well as (or instead of) on the lock screen.
   *  Always called: a rider looking at the screen should not be the one person
   *  who misses the message. */
  inApp(message: string, watch: WatchedDevice): void;
  /** Tapping the notification brings the app back to the scooter it is about,
   *  rather than to a cold map. */
  onOpen(watch: WatchedDevice): void;
  /** Fires after an alert, so the caller can drop the watch: the question has
   *  been answered, and a watch that keeps running would re-ask it about a
   *  scooter that is now somewhere else entirely. */
  onFired(watch: WatchedDevice, verdict: MovedVerdict): void;
}

export interface DeviceNotifier {
  /** Run one pass over the current watch list against the current feed. Called
   *  on the device refresh the app already does — nothing here polls. */
  check(
    watches: readonly WatchedDevice[],
    lookup: (vehicleIdentifier: string) => DeviceNow | undefined,
  ): void;
  /** Forget a vehicle's miss count and fired flag — the rider stopped watching
   *  it, or re-armed the watch from a new position. */
  forget(vehicleIdentifier: string): void;
}

export function createDeviceNotifier(deps: DeviceNotifyDeps): DeviceNotifier {
  /** Consecutive feed responses a vehicle has been absent from. */
  const misses = new Map<string, number>();
  /** Already alerted about, so a second pass stays quiet. `onFired` normally
   *  removes the watch anyway, but a caller that does not must still not get a
   *  second buzz per refresh for the rest of the session. */
  const fired = new Set<string>();

  function notify(watch: WatchedDevice, verdict: MovedVerdict): void {
    if (fired.has(watch.vehicleIdentifier)) return;
    fired.add(watch.vehicleIdentifier);
    const message = movedMessage(watch.name, verdict);
    deps.inApp(message, watch);
    try {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const n = new Notification("Scooter.fyi", {
          body: message,
          // Tagged per vehicle, so a later alert about the same scooter
          // REPLACES the earlier one rather than stacking.
          tag: `moved-${watch.vehicleIdentifier}`,
        } as NotificationOptions);
        n.onclick = () => {
          window.focus();
          n.close();
          deps.onOpen(watch);
        };
      }
    } catch {
      /* the in-app copy already landed */
    }
    deps.onFired(watch, verdict);
  }

  return {
    check(watches, lookup) {
      // Vehicles nobody is watching any more must not keep a miss count, or a
      // re-armed watch inherits it and alerts on its first absent tick.
      const live = new Set(watches.map((w) => w.vehicleIdentifier));
      for (const id of [...misses.keys()]) {
        if (!live.has(id)) misses.delete(id);
      }
      for (const watch of watches) {
        if (fired.has(watch.vehicleIdentifier)) continue;
        const now = lookup(watch.vehicleIdentifier);
        if (now) misses.set(watch.vehicleIdentifier, 0);
        else {
          misses.set(
            watch.vehicleIdentifier,
            (misses.get(watch.vehicleIdentifier) ?? 0) + 1,
          );
        }
        const verdict = movedVerdict(
          watch,
          now,
          misses.get(watch.vehicleIdentifier) ?? 0,
        );
        if (isAlertable(verdict)) notify(watch, verdict);
      }
    },
    forget(vehicleIdentifier) {
      misses.delete(vehicleIdentifier);
      fired.delete(vehicleIdentifier);
    },
  };
}
