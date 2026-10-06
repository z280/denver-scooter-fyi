// The watched-scooters list — the Tools drawer section that replaced Favorite
// Scooters.
//
// IT STARTS NOTHING. There is no control in here that arms a watch, and there
// must not be: a watch requires a present connection to the specific vehicle
// (a claim, or a ride just finished) and is armed as part of that, never from
// a list. `device-notify.ts`'s header has the argument. What this panel is
// FOR is the other direction — seeing what is being watched and stopping it.
//
// It renders; it decides nothing. Every judgement it shows comes from
// `device-notify.ts`, which is pure for exactly that reason.
//
// WHY IT LIVES IN TOOLS, beside My dibs. Same shape as its predecessor and as
// the list above it: a short personal list of specific vehicles. My dibs sits
// above because a claim expires on a clock the rider is racing; a watch sits
// here because it ends when the world changes, not when a timer does.
//
// WHAT IT PROMISES, AND NOT MORE. The check runs on the device feed's own
// refresh, in this tab, while the page is alive — so the copy says "while the
// app is open" and never implies a closed tab will buzz. The server-side half
// of that is `docs/ALONG_THE_WAY_PLAN.md` §9.4's bounded API watcher and does
// not exist in this repo; promising it here would be the app writing a cheque
// another lane has not signed.
//
// NO LOCATION IN THE ALERT, which is §4.4's rule and `device-notify.ts`'s. The
// LIST may say where a scooter is — the rider is holding the phone and looking
// at it — but the notification says only that it went.

import { track } from "./telemetry.ts";
import { distanceMeters, formatWalk, type LngLat } from "./locate.ts";
import {
  MAX_WATCHED_DEVICES,
  loadWatches,
  unwatchMoved,
  type WatchedDevice,
} from "./device-notify.ts";

export interface DeviceNotifyPanelDeps {
  /** The <section> to show/hide and the <ul> to fill. */
  section: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  /** Where the rider is, for the walk estimate. Null when location is off, in
   *  which case rows simply carry no distance. */
  locate: { current(): LngLat | null };
  /** Centre the map on one. Absent means the row is not clickable. */
  onShowOnMap?(w: WatchedDevice): void;
  /** Called after a watch is dropped from here, so the map's own affordance
   *  (the popup's bell) and the notifier's miss counters stay in step. */
  onChanged?(): void;
  /** Injected for tests; defaults to the module's own store. */
  read?(): WatchedDevice[];
  remove?(vehicleIdentifier: string): WatchedDevice[];
}

export interface DeviceNotifyPanelHandle {
  /** Re-read and repaint. Called when the Tools drawer opens, after a watch is
   *  added from the map, and after one fires. */
  refresh(): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** The in-app half of the alert.
 *
 *  ALWAYS SHOWN, alongside the lock-screen notification or instead of it: a
 *  rider looking at the screen should not be the one person who misses the
 *  message, and most will have denied or never been asked for notification
 *  permission. Shares `.dibs-toast`'s geometry and styling deliberately — this
 *  and "someone took your dibs" are the same kind of interruption about the
 *  same kind of fact, and two toast designs in one app is two things to
 *  maintain and one inconsistency for the rider.
 *
 *  Not auto-dismissed. "It moved" is the whole content of the message and there
 *  is no second chance to read it — unlike a countdown, which is still true a
 *  minute later. */
export function showMovedToast(
  message: string,
  onShow?: () => void,
): void {
  document.querySelector(".dibs-toast")?.remove();

  const toast = el("div", "dibs-toast dibs-toast--urgent notify-moved-toast");
  // `alert`, not `status`: this interrupts on purpose.
  toast.setAttribute("role", "alert");

  const body = el("div", "dibs-toast__text");
  body.append(el("strong", "", message));
  toast.append(el("span", "dibs-toast__glyph", "🔔"), body);

  if (onShow) {
    const show = el("button", "dibs-toast__view", "Show me");
    show.type = "button";
    show.addEventListener("click", () => {
      toast.remove();
      onShow();
    });
    toast.append(show);
  }

  const close = el("button", "dibs-toast__view", "Dismiss");
  close.type = "button";
  close.addEventListener("click", () => toast.remove());
  toast.append(close);

  document.body.append(toast);
}

export function wireDeviceNotifyPanel(
  deps: DeviceNotifyPanelDeps,
): DeviceNotifyPanelHandle {
  const read = deps.read ?? loadWatches;
  const remove = deps.remove ?? unwatchMoved;
  let destroyed = false;

  function setStatus(text: string | null): void {
    deps.status.hidden = !text;
    deps.status.textContent = text ?? "";
  }

  function render(watches: readonly WatchedDevice[]): void {
    deps.list.replaceChildren();
    // Shown even when empty, unlike its predecessor: watching needs no account,
    // so there is no state in which the heading is a reminder of something the
    // visitor cannot have. The empty copy says where the switch is instead.
    deps.section.hidden = false;

    if (watches.length === 0) {
      const empty = el(
        "li",
        "notify-moved__empty",
        // No "go and do X" instruction, because there is no X: a watch comes
        // with a claim or with the end of a ride. Saying where watches come
        // from is honest; sending the rider to a button that does not exist
        // would not be.
        "Nothing watched. Claiming a scooter for a route, or finishing a ride on one, offers to watch it.",
      );
      deps.list.append(empty);
      setStatus(null);
      return;
    }

    const here = deps.locate.current();
    for (const w of watches) {
      const row = el("li", "notify-moved__row");

      const name = el("span", "notify-moved__name", w.name);
      row.append(name);

      // Distance is a convenience for somebody holding the phone, not part of
      // the alert — see the module header.
      if (here) {
        const away = distanceMeters(here, { lng: w.lon, lat: w.lat });
        row.append(el("span", "notify-moved__where", formatWalk(away)));
      }

      if (deps.onShowOnMap) {
        const show = el("button", "notify-moved__show", "Show");
        show.type = "button";
        show.setAttribute("aria-label", `Show ${w.name} on the map`);
        show.addEventListener("click", () => deps.onShowOnMap?.(w));
        row.append(show);
      }

      const stop = el("button", "notify-moved__stop", "Stop");
      stop.type = "button";
      stop.setAttribute("aria-label", `Stop watching ${w.name}`);
      stop.addEventListener("click", () => {
        track("device_notify_moved", { action: "off" });
        const next = remove(w.vehicleIdentifier);
        render(next);
        deps.onChanged?.();
      });
      row.append(stop);

      deps.list.append(row);
    }

    setStatus(
      watches.length >= MAX_WATCHED_DEVICES
        ? `That's all ${MAX_WATCHED_DEVICES} — stop watching one to add another.`
        : "We'll tell you when one of these moves, while the app is open.",
    );
  }

  render(read());

  return {
    refresh() {
      if (destroyed) return;
      render(read());
    },
    destroy() {
      destroyed = true;
      deps.list.replaceChildren();
    },
  };
}
