// The strip under the map that says what you are riding.
//
// WHY IT EXISTS. Once a ride starts, the vehicle stops being visible anywhere
// except inside the full-screen HUD. Back out of the HUD to look at the map —
// which riders do constantly, to see where they are going — and the app gives
// no sign that a ride is running at all, let alone on what. The one piece of
// state a rider most needs to keep hold of was the one the map forgot.
//
// So it is a permanent region, not another floating panel: reserved space
// below the map for as long as something is active, present whether the
// vehicle is a Veo or the rider's own. "My own scooter" is a first-class
// answer here — the app serves people who already own one, and a dock that
// only lit up for rentals would say otherwise every time they used it.
//
// It is deliberately thin. Everything expensive to render — the speedometer,
// the turn cues, the trail — belongs to the HUD. This is the always-visible
// answer to "what am I on, how is it doing, and how do I get back to it".

import { track } from "./telemetry.ts";

export interface ActiveVehicleState {
  /** Rider-facing identity: "Lunar 🐸 928", or "My scooter" for a private
   *  ride. Never a 16-hex identifier. */
  name: string;
  /** Model name where one is known — "Cosmo", "NIU KQi3". */
  model?: string | null;
  /** Live charge, when anything reports one. A private scooter has none
   *  unless the rider told us, which is exactly what the battery-logging
   *  work is for. */
  batteryPercent?: number | null;
  /** True for the rider's own device: the strip says so rather than implying
   *  a rental. */
  own?: boolean;
  /** Free text under the name — "3 min to your destination", "walking to it",
   *  "paused". The caller owns the wording; this module owns the shelf. */
  detail?: string | null;
}

export interface ActiveVehicleDeps {
  /** Re-open the surface this vehicle belongs to — the HUD mid-ride, the
   *  arrival panel while walking. */
  onOpen(): void;
  /** Absent means the strip shows no end action, which is right while
   *  walking: there is nothing to end yet. */
  onEnd?(): void;
}

export interface ActiveVehicleHandle {
  /** Null clears the strip and gives the space back to the map. */
  set(state: ActiveVehicleState | null): void;
  isShowing(): boolean;
  destroy(): void;
}

export function createActiveVehicle(
  root: HTMLElement,
  deps: ActiveVehicleDeps,
): ActiveVehicleHandle {
  let showing = false;
  let destroyed = false;

  function render(state: ActiveVehicleState | null): void {
    root.replaceChildren();
    showing = state !== null;
    // The body class is what actually reserves the space: the map's height is
    // computed against it, so the strip never covers the map it sits under.
    document.body.classList.toggle("has-active-vehicle", showing);
    root.hidden = !showing;
    if (!state) return;

    const bar = el("div", "active-vehicle");

    const open = el("button", "active-vehicle__main");
    open.type = "button";
    open.setAttribute("aria-label", `Back to ${state.name}`);

    const glyph = el("span", "active-vehicle__glyph", state.own ? "🛴" : "⚡");
    const text = el("span", "active-vehicle__text");
    const nameRow = el("span", "active-vehicle__name", state.name);
    text.append(nameRow);

    // One line of context, assembled from whatever is actually known. A dash
    // between absent things reads as a rendering fault, so the parts are
    // filtered before they are joined.
    const bits = [
      state.own ? "Your own" : null,
      state.model ?? null,
      state.batteryPercent !== null && state.batteryPercent !== undefined
        ? `🔋 ${Math.round(state.batteryPercent)}%`
        : null,
      state.detail ?? null,
    ].filter(Boolean) as string[];
    if (bits.length > 0) {
      text.append(el("span", "active-vehicle__meta", bits.join(" · ")));
    }

    open.append(glyph, text);
    open.addEventListener("click", () => {
      track("active_vehicle", { action: "open" });
      deps.onOpen();
    });
    bar.append(open);

    if (deps.onEnd) {
      const end = el("button", "active-vehicle__end", "End");
      end.type = "button";
      end.addEventListener("click", (e) => {
        // The strip's body is one big "take me back" target; ending is the
        // rarer, deliberate act and must not ride on top of it.
        e.stopPropagation();
        track("active_vehicle", { action: "end" });
        deps.onEnd?.();
      });
      bar.append(end);
    }

    root.append(bar);
  }

  render(null);

  return {
    set(state) {
      if (destroyed) return;
      render(state);
    },
    isShowing: () => showing,
    destroy() {
      destroyed = true;
      document.body.classList.remove("has-active-vehicle");
      root.replaceChildren();
      root.hidden = true;
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
