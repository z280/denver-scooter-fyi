// "Recenter" — a crosshair button that puts the map back on you.
//
// WHY IT IS ITS OWN BUTTON. MapLibre's GeolocateControl overloads one button
// with two jobs. Its watch has three states, and a tap means something
// different in each: from OFF it turns location on, from ACTIVE_LOCK it turns
// location off, and from BACKGROUND (you panned the map away) it recenters.
// So the same button, in the same visual state, was either "turn GPS off" or
// "take me back", depending on whether the rider had touched the map since —
// which nobody tracks, and nobody should have to.
//
// Now the GPS button only ever means on/off, and coming back to yourself is
// this button. It appears exactly when it has something to do: GPS on, and
// the map not already looking at you. That is also why it has no disabled
// state — a control that cannot do anything is not shown at all, rather than
// sitting there greyed out inviting a tap.

import type maplibregl from "maplibre-gl";

import { track } from "./telemetry.ts";

/** How far off-centre before the map counts as "not on you".
 *
 *  Generous on purpose: this is measured in SCREEN pixels, and a rider
 *  standing still with a jittery urban fix would otherwise make the button
 *  flicker in and out as the dot wanders a few pixels. Roughly a thumb's
 *  width — far enough that you meant to move the map. */
const OFF_CENTRE_PX = 64;

export interface RecenterDeps {
  /** The live fix, or null when GPS is off / has no answer yet. The button
   *  is hidden whenever this is null — there is nowhere to recenter TO. */
  current(): { lng: number; lat: number } | null;
  onFix(cb: () => void): () => void;
}

export class RecenterControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private container: HTMLElement | null = null;
  private btn: HTMLButtonElement | null = null;
  private offFix: (() => void) | null = null;

  constructor(private readonly deps: RecenterDeps) {}

  private readonly sync = (): void => {
    if (!this.btn || !this.map) return;
    const here = this.deps.current();
    let show = false;
    if (here) {
      // Screen-space, not degrees: "centred" is a thing the rider judges by
      // looking at the map, and a degree is a different distance at every
      // zoom level. project() answers in exactly the units the question is
      // asked in.
      const p = this.map.project([here.lng, here.lat]);
      const c = this.map.project(this.map.getCenter());
      show = Math.hypot(p.x - c.x, p.y - c.y) > OFF_CENTRE_PX;
    }
    this.btn.hidden = !show;
  };

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group recenter-ctrl";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recenter-ctrl__btn";
    btn.title = "Recenter";
    btn.setAttribute("aria-label", "Recenter the map on your location");
    // Crosshair, in the house 24x24 stroke convention.
    btn.innerHTML = "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of [
      "M12 2v3", "M12 19v3", "M2 12h3", "M19 12h3",
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", "12");
    ring.setAttribute("cy", "12");
    ring.setAttribute("r", "6");
    svg.appendChild(ring);
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "12");
    dot.setAttribute("r", "1.6");
    dot.setAttribute("fill", "currentColor");
    dot.setAttribute("stroke", "none");
    svg.appendChild(dot);
    btn.appendChild(svg);

    btn.addEventListener("click", () => {
      const here = this.deps.current();
      if (!here) return;
      track("recenter", {});
      // Zoom is left alone. The rider chose it, and this button's promise is
      // "put me back in the middle", not "reset my view".
      map.easeTo({ center: [here.lng, here.lat], duration: 500 });
    });

    container.appendChild(btn);
    this.container = container;
    this.btn = btn;

    // Three things can change the answer: the map moving, a new fix, and GPS
    // being turned on or off (which arrives as a fix, or as staleness that
    // `current()` reports on the next move).
    map.on("move", this.sync);
    this.offFix = this.deps.onFix(this.sync);
    this.sync();
    return container;
  }

  onRemove(): void {
    this.map?.off("move", this.sync);
    this.offFix?.();
    this.offFix = null;
    this.container?.remove();
    this.container = null;
    this.btn = null;
    this.map = null;
  }
}
