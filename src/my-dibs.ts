// "My dibs" — the claims you are holding, in the Tools drawer.
//
// WHY THIS EXISTS. A claim is a promise with a clock on it: ten minutes to
// set off, twenty-five in total, three at once. Until now the only place any
// of that was visible was the popup of the scooter it was for — so a rider
// holding two claims had to find both scooters on the map to see either
// countdown, and the way you discovered a claim had expired was that it had.
//
// It is also the only honest place to RELEASE one. Dibs costs other riders
// something: the app stops offering them that scooter and dims it on their
// map. A rider who has changed their mind should be able to give it back in
// one tap from somewhere they can find, rather than by locating the scooter
// they have decided not to walk to.
//
// The list is device-local, like the claims themselves (`dibs.ts`). No fetch,
// no auth: this reads exactly what the rest of the app already believes.

import {
  dibsMsLeft,
  dropDibs,
  loadDibs,
  DIBS_START_GRACE_MS,
  type Dibs,
} from "./dibs.ts";
import { track } from "./telemetry.ts";

/** How often the countdowns re-render. A claim's whole point is the clock, so
 *  a stale one is worse than none — but nothing here needs sub-second
 *  precision, and a second is what the numbers are shown in. */
const TICK_MS = 1_000;

export interface MyDibsDeps {
  /** The <section> to show/hide, and the <ul> to fill. */
  section: HTMLElement;
  list: HTMLElement;
  /** Show the claim's certificate. */
  onOpenCertificate(dibs: Dibs): void;
  /** Tell the server the claim is given back. See `releaseDibs`. */
  onRelease(dibs: Dibs): void;
  /** Something changed — the map and any open popup need to know a claim
   *  went away. */
  onChanged(): void;
  /** Injected for tests. */
  now?(): number;
}

export interface MyDibsHandle {
  /** Re-read and repaint. Call when a claim is made elsewhere. */
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

/** "4:07", or "0:09" — mm:ss, because a countdown a rider is racing is read
 *  as a clock and not as a quantity. Never negative: an expired claim is
 *  removed rather than shown counting down past zero. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** What the clock on this row is counting DOWN to.
 *
 *  Two different deadlines, and which one matters changes as the rider walks:
 *  before they set off it is the ten-minute grace (the one they can still
 *  lose the claim to), and after it is the claim's own expiry. Showing both
 *  would be two countdowns competing for one glance — the same call the
 *  arrival panel already makes. */
export function countdownFor(
  d: Dibs,
  now: number,
): { ms: number; label: string; urgent: boolean } {
  if (d.startedWalkingAt === null) {
    const ms = Math.max(0, d.claimedAt + DIBS_START_GRACE_MS - now);
    return { ms, label: "to set off", urgent: ms <= 3 * 60_000 };
  }
  const ms = dibsMsLeft(d, now);
  return { ms, label: "left", urgent: ms <= 5 * 60_000 };
}

export function wireMyDibs(deps: MyDibsDeps): MyDibsHandle {
  const now = deps.now ?? (() => Date.now());
  let timer: number | null = null;
  let destroyed = false;

  const render = (): void => {
    if (destroyed) return;
    // `loadDibs` already drops anything expired, so this list is exactly the
    // live ones and never needs its own expiry check.
    const held = loadDibs(now());
    deps.section.hidden = held.length === 0;
    deps.list.replaceChildren();
    if (held.length === 0) return;

    for (const d of held) {
      const li = el("li", "my-dibs__row");
      const head = el("div", "my-dibs__head");
      head.append(el("span", "my-dibs__name", d.vehicleName));

      const { ms, label, urgent } = countdownFor(d, now());
      const clock = el(
        "span",
        `my-dibs__clock${urgent ? " is-urgent" : ""}`,
        `${formatCountdown(ms)} ${label}`,
      );
      // Announced on its own, not as part of the row: a screen reader should
      // hear the time change, not the whole list again.
      clock.setAttribute("role", "timer");
      head.append(clock);
      li.append(head);

      const actions = el("div", "my-dibs__actions");
      const cert = el("button", "my-dibs__btn", "Certificate");
      cert.type = "button";
      cert.addEventListener("click", () => deps.onOpenCertificate(d));
      actions.append(cert);

      const release = el("button", "my-dibs__btn my-dibs__btn--release", "Release");
      release.type = "button";
      release.addEventListener("click", () => {
        // No confirm. Releasing is the GENEROUS action — it gives a scooter
        // back to everyone else — and putting a speed bump in front of it
        // would be the app discouraging the thing it wants. Calling dibs
        // again costs one tap on the scooter.
        // Local first so the UI answers instantly, then the server, which
        // is what every OTHER rider's map reads. Not awaited: a release that
        // fails to reach us still expires on its own clock, and blocking the
        // button on the network would be the app hesitating over the one
        // action that costs the rider nothing.
        dropDibs(d.vehicleIdentifier, now());
        track("dibs", { action: "released_from_list" });
        render();
        deps.onRelease(d);
        deps.onChanged();
      });
      actions.append(release);
      li.append(actions);
      deps.list.append(li);
    }
  };

  render();
  timer = window.setInterval(render, TICK_MS);

  return {
    refresh: render,
    destroy() {
      destroyed = true;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      deps.list.replaceChildren();
    },
  };
}
