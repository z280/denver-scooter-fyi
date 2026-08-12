// The floating panel that carries a rider from "I picked that one" to "I'm
// moving" — first while walking to the scooter, then once they're standing at
// it.
//
// WHY A PANEL AND NOT MORE WIZARD SCREENS. The old flow ran the rider through
// a numbered sequence (gates, pick a device, where to, routes, open in Veo)
// even when the answer to most of it was already known: they had tapped a
// specific scooter on the map and typed a destination into the home bar. Being
// asked again, one full-screen step at a time, while standing on a pavement,
// is the worst place in the app to be asked anything. So when the device and
// the destination are both known there is no wizard — there is this, floating
// over the map the rider is walking across.
//
// TWO FACES, ONE PANEL:
//
//   WALKING   the routed walk, its ETA, the vehicle's name, and a way to say
//             "I'm here" before GPS agrees.
//   ARRIVED   one thing: choose the route.
//
// WHY THE ARRIVED FACE DOES NOT UNLOCK THE SCOOTER. It used to offer Open in
// Veo alongside everything else, which meant a rider could start the meter and
// then spend two minutes reading route options. Veo bills from unlock. So the
// unlock belongs strictly after the route is settled, and it already lives
// there — Screen 6 is downstream of Screen 4's route choice, and this panel
// hands off into that.
//
// This is a deliberate reversal: the panel was specified with the Veo buttons
// on it. Charging a rider for the time they spend deciding is the more
// expensive mistake, so the later rule wins and the buttons moved rather than
// being duplicated in two places.

import { track } from "./telemetry.ts";
import { formatWalkLeg, type WalkState } from "./walk-leg.ts";
import {
  DIBS_START_GRACE_MS,
  dibsMsLeft,
  type Dibs,
} from "./dibs.ts";

export interface ArrivalVehicle {
  /** "Lunar 🐸 928" — the rider-facing identity, not a 16-hex id. */
  name: string;
  /** Plate, for the Veo deep link. Absent means Veo can only be opened cold. */
  plate?: string;
}

export interface ArrivalPanelDeps {
  vehicle: ArrivalVehicle;
  /** Where they're headed, echoed so the panel is self-explanatory if the
   *  rider put the phone away during the walk. Null when they only asked to
   *  be walked to the scooter — the ride flow will ask. */
  destinationLabel: string | null;
  /** Hand off to route selection. Unlocking and starting navigation both
   *  happen downstream of it — see the module header. */
  onChooseRoute(): void;
  /** Dismiss the whole thing — changed my mind. */
  onCancel(): void;
  /** The rider's claim on this vehicle, if they called dibbs. Re-read on each
   *  update so the panel reflects progress rather than a stale copy. */
  dibs?(): Dibs | null;
}

export interface ArrivalPanelHandle {
  update(state: WalkState): void;
  /** The scooter went while the rider was walking to it. Takes over the panel
   *  entirely — continuing to show a walk ETA to a scooter somebody else is
   *  riding is the app knowing something and not saying it. */
  reportGone(message: string): void;
  destroy(): void;
}

export function createArrivalPanel(
  root: HTMLElement,
  deps: ArrivalPanelDeps,
): ArrivalPanelHandle {
  let arrived = false;
  let destroyed = false;
  let gone = false;

  const panel = el("div", "arrival");
  const head = el("div", "arrival__head");
  const title = el("div", "arrival__title");
  const sub = el("div", "arrival__sub");
  head.append(title, sub);

  const close = el("button", "arrival__close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Cancel");
  close.addEventListener("click", () => deps.onCancel());

  const body = el("div", "arrival__body");
  panel.append(head, close, body);
  root.replaceChildren(panel);

  /** The two clocks that matter while walking, and only when they matter.
   *
   *  Before they set off, the one that can lose them the scooter is the
   *  ten-minute grace — so that is the one shown, and it is the only one they
   *  can do anything about. Once they are moving, the grace is satisfied and
   *  irrelevant, so it is replaced by when the claim actually ends. Showing
   *  both at once would be two countdowns competing for the same glance, and
   *  the rider would have to work out which one was about to hurt them. */
  function dibsLine(): HTMLElement | null {
    const d = deps.dibs?.() ?? null;
    if (!d) return null;
    const left = dibsMsLeft(d);
    if (left <= 0) return el("p", "arrival__dibs is-urgent", "✋ Your dibbs expired");

    const mins = (ms: number): string => {
      const m = Math.floor(ms / 60_000);
      return m < 1 ? "under a minute" : `${m} min`;
    };
    if (d.startedWalkingAt === null) {
      const graceLeft = Math.max(0, d.claimedAt + DIBS_START_GRACE_MS - Date.now());
      return el(
        "p",
        `arrival__dibs${graceLeft <= 3 * 60_000 ? " is-urgent" : ""}`,
        `✋ Start walking within ${mins(graceLeft)} or your dibbs expire`,
      );
    }
    return el(
      "p",
      `arrival__dibs${left <= 5 * 60_000 ? " is-urgent" : ""}`,
      `✋ Dibbs hold for another ${mins(left)}`,
    );
  }

  function renderWalking(state: WalkState): void {
    title.textContent = `🚶 ${formatWalkLeg(state)}`;
    sub.textContent = `to ${deps.vehicle.name}`;
    body.replaceChildren();

    const dibs = dibsLine();
    if (dibs) body.append(dibs);

    if (state.error) {
      // Not an error state to the rider: the scooter is on the map and they
      // can see it. Say what is true and stay out of the way.
      body.append(
        el("p", "arrival__note",
          "Couldn't draw the walking route — the scooter is pinned on the map."),
      );
    }

    // Their eyes beat our radius, always.
    const here = el("button", "arrival__action", "I'm at the scooter");
    here.type = "button";
    here.addEventListener("click", () => {
      track("arrival_panel", { action: "manual_arrive" });
      setArrived();
    });
    body.append(here);
  }

  function renderArrived(): void {
    title.textContent = `You're at ${deps.vehicle.name}`;
    sub.textContent = deps.destinationLabel
      ? `Heading to ${deps.destinationLabel}`
      : "Ready when you are";
    body.replaceChildren();

    const go = el("button", "arrival__action arrival__action--primary");
    go.type = "button";
    go.append(
      el("span", "arrival__action-glyph", "🧭"),
      // Without a destination there is no route to choose yet, and saying
      // "choose your route" would promise a screen that has to ask a question
      // first.
      el("span", "", deps.destinationLabel ? "Choose your route" : "Start your ride"),
    );
    go.addEventListener("click", () => {
      track("arrival_panel", { action: "choose_route" });
      deps.onChooseRoute();
    });
    body.append(go);

    // Said plainly, because a rider standing at a scooter with the Veo app one
    // tap away needs a reason not to open it yet. "Veo starts charging when
    // you unlock" is that reason, and it is true.
    body.append(
      el("p", "arrival__note",
        deps.vehicle.plate
          ? `Pick your route first — you'll unlock ${deps.vehicle.name} in Veo on the next step, so the meter doesn't run while you decide.`
          : "Pick your route first — unlocking comes next, so the meter doesn't run while you decide."),
    );
  }

  function setArrived(): void {
    if (arrived || destroyed) return;
    arrived = true;
    panel.classList.add("is-arrived");
    renderArrived();
  }

  return {
    update(state) {
      if (destroyed || gone) return;
      if (state.arrived) setArrived();
      else if (!arrived) renderWalking(state);
    },
    reportGone(message) {
      if (destroyed || gone) return;
      gone = true;
      panel.classList.add("is-gone");
      title.textContent = `😞 ${message}`;
      sub.textContent = "Pick another one — the map is still behind this.";
      body.replaceChildren();
      const back = el("button", "arrival__action arrival__action--primary");
      back.type = "button";
      back.append(
        el("span", "arrival__action-glyph", "🗺️"),
        el("span", "", "Find another scooter"),
      );
      back.addEventListener("click", () => {
        track("arrival_panel", { action: "find_another" });
        deps.onCancel();
      });
      body.append(back);
    },
    destroy() {
      destroyed = true;
      root.replaceChildren();
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
