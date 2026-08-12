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
//   ARRIVED   the three things a rider does at the scooter: start navigation,
//             open Veo to unlock it, or say it's already unlocked.
//
// The arrived face is deliberately not a countdown. Screen 6 counted down from
// tapping "Open in Veo" because it had no other way to know the ride began; a
// rider standing at the scooter can just say so, and the button that says so
// is the same size as the one that opens Veo.

import { veoDeepLink } from "./config.ts";
import { track } from "./telemetry.ts";
import { formatWalkLeg, type WalkState } from "./walk-leg.ts";

export interface ArrivalVehicle {
  /** "Lunar 🐸 928" — the rider-facing identity, not a 16-hex id. */
  name: string;
  /** Plate, for the Veo deep link. Absent means Veo can only be opened cold. */
  plate?: string;
}

export interface ArrivalPanelDeps {
  vehicle: ArrivalVehicle;
  /** Where they're headed, echoed so the panel is self-explanatory if the
   *  rider put the phone away during the walk. */
  destinationLabel: string;
  /** Enter the 3D follow-cam and start the ride. */
  onStartNavigation(): void;
  /** "It's unlocked, I'm on it." */
  onConfirmStarted(): void;
  /** Dismiss the whole thing — changed my mind. */
  onCancel(): void;
}

export interface ArrivalPanelHandle {
  update(state: WalkState): void;
  destroy(): void;
}

export function createArrivalPanel(
  root: HTMLElement,
  deps: ArrivalPanelDeps,
): ArrivalPanelHandle {
  let arrived = false;
  let destroyed = false;

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

  function renderWalking(state: WalkState): void {
    title.textContent = `🚶 ${formatWalkLeg(state)}`;
    sub.textContent = `to ${deps.vehicle.name}`;
    body.replaceChildren();

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
    sub.textContent = `Heading to ${deps.destinationLabel}`;
    body.replaceChildren();

    // ORDER IS THE ARGUMENT. Starting navigation is what the rider came here
    // to do and is the only button that works whether or not Veo cooperates,
    // so it leads. Unlocking is a Veo problem, not ours; it sits below,
    // full-width but quieter.
    const nav = el("button", "arrival__action arrival__action--primary");
    nav.type = "button";
    nav.append(
      el("span", "arrival__action-glyph", "🧭"),
      el("span", "", "Start 3D navigation"),
    );
    nav.addEventListener("click", () => {
      track("arrival_panel", { action: "start_nav" });
      deps.onStartNavigation();
    });

    const started = el("button", "arrival__action", "✅ It's unlocked — let's go");
    started.type = "button";
    started.addEventListener("click", () => {
      track("arrival_panel", { action: "confirm_started" });
      deps.onConfirmStarted();
    });

    body.append(nav, started);

    const href = deps.vehicle.plate ? veoDeepLink(deps.vehicle.plate) : null;
    if (href) {
      const veo = el("a", "arrival__action arrival__action--veo", "▶️ Open in Veo");
      veo.href = href;
      veo.rel = "noopener";
      veo.addEventListener("click", () => {
        track("arrival_panel", { action: "open_veo" });
      });
      body.append(veo);
      body.append(
        el("p", "arrival__note",
          "Unlock it in Veo, then come back and tap “It's unlocked”."),
      );
    } else {
      body.append(
        el("p", "arrival__note",
          "Unlock it in the Veo app, then tap “It's unlocked”."),
      );
    }
  }

  function setArrived(): void {
    if (arrived || destroyed) return;
    arrived = true;
    panel.classList.add("is-arrived");
    renderArrived();
  }

  return {
    update(state) {
      if (destroyed) return;
      if (state.arrived) setArrived();
      else if (!arrived) renderWalking(state);
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
