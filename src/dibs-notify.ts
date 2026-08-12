// Telling a rider about their dibs while their phone is in their pocket.
//
// Dibs only works if it reaches somebody who is walking and not looking at a
// screen. That is the entire delivery problem: the rider has put the phone
// away, and the two things they need to hear — "it's gone" and "you're about
// to lose it" — both happen while they cannot see the app.
//
// FOUR MESSAGES, AND NO MORE. Each fires at most once per claim. A claim lasts
// twenty-five minutes at the outside, and a phone that buzzes five times in
// twenty-five minutes about a scooter is a phone that gets its notifications
// turned off — which costs the rider the one message that actually matters.
//
// PERMISSION IS ASKED FOR AT THE CLAIM, not at load. Somebody who has just
// tapped "call dibs" has a reason to be interrupted and knows what about; the
// same prompt on arrival at the map is the one everybody denies reflexively,
// and a denial is permanent. If it is denied, everything here still runs — it
// just lands in the app instead, which is where the rider will be when they
// next look.
//
// VIBRATION is best-effort and Android-only in practice: iOS Safari does not
// implement navigator.vibrate at all, including installed as a PWA. It is a
// bonus on the platforms that have it, never the delivery mechanism.

import { track } from "./telemetry.ts";
import {
  DIBS_START_GRACE_MS,
  dibsMsLeft,
  type Dibs,
} from "./dibs.ts";

export type DibsAlert = "taken" | "no_progress" | "ten_left" | "five_left";

/** The rider-facing copy, verbatim. Written to be read on a lock screen at a
 *  glance, mid-stride — which is why each one leads with a glyph and says the
 *  consequence in its first clause. */
export function dibsAlertText(alert: DibsAlert, vehicleName: string): string {
  switch (alert) {
    case "taken":
      return `😭 Someone started ${vehicleName}, despite your dibs. What an asshole!`;
    case "no_progress":
      return (
        "🐢 Doesn't look like you're making much progress towards the device " +
        "you called dibs on. Reminder: dibs expire in ten minutes unless " +
        "you're actively walking towards the device."
      );
    case "ten_left":
      return "⏳ Your dibs expire in ten minutes. You're on the way, keep going!";
    case "five_left":
      return (
        "🏃 RUN! You're almost there but you've only got five minutes before " +
        "your dibs expire."
      );
  }
}

/** Buzz patterns, matched to urgency rather than decorated. RUN gets a
 *  triple; a countdown gets one. Silently absent on iOS. */
const VIBRATION: Record<DibsAlert, number[]> = {
  taken: [120, 60, 120],
  no_progress: [80],
  ten_left: [80],
  five_left: [140, 70, 140, 70, 140],
};

export function vibrate(alert: DibsAlert): void {
  try {
    navigator.vibrate?.(VIBRATION[alert]);
  } catch {
    /* unsupported, or blocked without a prior gesture — never load-bearing */
  }
}

/** Ask once, at the moment the rider calls dibs. Resolves to whether we may
 *  notify; never throws, and never asks twice. */
export async function requestDibsNotifications(): Promise<boolean> {
  try {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export interface DibsNotifyDeps {
  /** Show it inside the app as well as (or instead of) on the lock screen.
   *  Always called: a rider looking at the screen should not be the one person
   *  who misses the message. */
  inApp(alert: DibsAlert, text: string): void;
  /** Bring the app back to the dibs it is about. Wired to the notification's
   *  click, so tapping "RUN!" lands on the walk rather than on a cold map. */
  onResume(dibs: Dibs): void;
}

/** Fires the four alerts for one claim. Driven by ticks rather than timers, so
 *  a backgrounded tab that misses its window still fires on the next tick it
 *  gets instead of silently skipping. */
export function createDibsNotifier(deps: DibsNotifyDeps) {
  const fired = new Set<string>();
  const key = (d: Dibs, a: DibsAlert): string => `${d.vehicleIdentifier}:${a}`;

  function fire(dibs: Dibs, alert: DibsAlert): void {
    const k = key(dibs, alert);
    if (fired.has(k)) return;
    fired.add(k);
    const text = dibsAlertText(alert, dibs.vehicleName);
    track("dibs_alert", { alert });
    vibrate(alert);
    deps.inApp(alert, text);
    try {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const n = new Notification("Scooter.fyi", {
        body: text,
        // Tagged per vehicle so a later alert REPLACES the earlier one rather
        // than stacking four notifications about one scooter.
        tag: `dibs-${dibs.vehicleIdentifier}`,
        renotify: true,
      } as NotificationOptions);
      n.onclick = () => {
        window.focus();
        n.close();
        deps.onResume(dibs);
      };
    } catch {
      /* the in-app copy already landed */
    }
  }

  return {
    /** The scooter went. Fires regardless of timing — this is the one alert
     *  that is about the world rather than about the clock. */
    taken(dibs: Dibs): void {
      fire(dibs, "taken");
    },

    /** Called on every progress update. `movingToward` is the tracker's read
     *  of whether the rider has actually set off. */
    tick(dibs: Dibs, now: number = Date.now()): void {
      const left = dibsMsLeft(dibs, now);
      if (left <= 0) return;
      const walking = dibs.startedWalkingAt !== null;

      if (!walking) {
        // Rule 1 is about to bite. Warned at the halfway point of the grace,
        // which is early enough to still make it and late enough not to nag
        // somebody who is putting their shoes on.
        if (now - dibs.claimedAt >= DIBS_START_GRACE_MS / 2) {
          fire(dibs, "no_progress");
        }
        return;
      }
      // On the way. The two countdowns, most urgent first — so a rider who
      // was backgrounded through the ten-minute mark gets RUN! rather than a
      // stale "keep going".
      if (left <= 5 * 60_000) fire(dibs, "five_left");
      else if (left <= 10 * 60_000) fire(dibs, "ten_left");
    },

    /** Forget a claim's history — it was dropped, or it expired. */
    forget(vehicleIdentifier: string): void {
      for (const k of [...fired]) {
        if (k.startsWith(`${vehicleIdentifier}:`)) fired.delete(k);
      }
    },
  };
}
