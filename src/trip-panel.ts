// "Where am I actually going, and what did I agree to?" — the one question the
// app could not answer once the wizard closed.
//
// THE GAP. A rider who chose a two-scooter plan, closed the list and started
// riding had nowhere to look it up. The destination lived on the session doc,
// the hand-offs lived in the trip ledger, the ETA lived on the chosen route,
// and the preference that shaped the whole thing lived in the account drawer —
// four places, none of them a page you could open. The HUD shows "Leg 2 of 3",
// which tells you where you are in a plan you can no longer read.
//
// SO THIS IS A READING SURFACE, not a second place to change things. The one
// control is the stepper, and the preference row says where to change itself
// rather than offering a duplicate select — a setting with two homes is a
// setting that disagrees with itself.
//
// IT DERIVES EVERY STEP RATHER THAN STORING ONE. The ledger keeps a count, a
// destination and the hand-off points, which is enough: step N ends at hand-off
// N, the last step ends at the destination, and everything before
// `completed.length` is behind you. Storing a rendered itinerary would mean a
// second copy of the trip that goes stale the moment the rider re-solves, and
// the re-solve is the normal case rather than the exception.

import {
  activeTrip,
  currentLeg,
  legDestination,
  tripTotals,
  type ActiveTrip,
  type TripDest,
} from "./trip-legs.ts";
import { HAND_OFF_CAP_OPTIONS, handOffCap } from "./plan-prefs.ts";
import { formatCents } from "./ride-cost.ts";

export interface TripPanelState {
  /** Where the rider said they were going, however they said it: the live
   *  ride's own destination, or the trip they lined up before starting. Null
   *  when they have not said. */
  dest: TripDest | null;
  /** The chosen route's duration in seconds, when a route has been chosen.
   *  Null on a ride with navigation off, which is the default — and then there
   *  is no ETA to show, rather than a made-up one. */
  routeSeconds: number | null;
  /** Metres along the chosen route, same conditions. */
  routeMeters: number | null;
  /** Clock, injected so the arrival time is testable. */
  nowMs: number;
}

/** One line of the itinerary. */
export interface TripStep {
  /** 1-based. */
  index: number;
  /** Where this step ends. */
  to: string;
  /** It ends at a hand-off rather than at the destination. */
  handOff: boolean;
  /** Already ridden. */
  done: boolean;
  /** The one being ridden now. */
  current: boolean;
}

/** The itinerary, derived. Empty when there is no multi-leg trip — a one-ride
 *  journey has no steps worth stepping through, and a stepper over a single
 *  item is chrome. */
export function tripSteps(trip: ActiveTrip | null): TripStep[] {
  if (trip === null) return [];
  const steps: TripStep[] = [];
  const now = currentLeg(trip);
  for (let i = 1; i <= trip.plannedRides; i += 1) {
    const handOffDest = trip.handOffs[i - 1];
    steps.push({
      index: i,
      // A hand-off we could not name still gets a step, because the step is
      // real even when the label is not — "your next scooter" is true and
      // leaving the row out would make the plan look shorter than it is.
      to:
        handOffDest !== undefined
          ? handOffDest.label || "your next scooter"
          : trip.dest?.label || "your destination",
      handOff: i < trip.plannedRides,
      done: i < now || i <= trip.completed.length,
      current: i === now,
    });
  }
  return steps;
}

/** "arriving ~10:58 · 21 min", or null when there is no route to say it from.
 *
 *  NO ETA RATHER THAN A GUESSED ONE. Navigation is off by default, so most
 *  rides have no chosen route — and an arrival time derived from a straight
 *  line would be the one figure on this panel a rider could check against their
 *  own watch and find wrong. */
export function etaLine(state: TripPanelState): string | null {
  const seconds = state.routeSeconds;
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  const at = new Date(state.nowMs + minutes * 60_000);
  const clock = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `arriving ~${clock} · ${minutes} min`;
}

/** The distance line, or null. Miles, like every other distance the rider is
 *  shown. */
export function distanceLine(state: TripPanelState): string | null {
  const meters = state.routeMeters;
  if (meters === null || !Number.isFinite(meters) || meters < 0) return null;
  return `${(meters / 1609.344).toFixed(1)} mi`;
}

/** What the rider's hand-off setting currently says, in its own words. */
export function routingPreferenceLabel(): string {
  const cap = handOffCap();
  const option = HAND_OFF_CAP_OPTIONS.find((o) => o.value === cap);
  return option?.label ?? "Any number of switches";
}

/** The trip's running total so far, or null when there is no trip or nothing
 *  settled yet. `≥` when any banked leg was missing a figure, the same rule the
 *  HUD and Screen 8 use — three surfaces, one honesty. */
export function tripSpendLine(trip: ActiveTrip | null): string | null {
  if (trip === null || trip.completed.length === 0) return null;
  const totals = tripTotals(trip);
  const prefix = totals.partial ? "≥" : "≈";
  const legs = totals.legsDone === 1 ? "1 leg" : `${totals.legsDone} legs`;
  return `${prefix} ${formatCents(totals.costCents)} over ${legs} so far`;
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

export interface TripPanelDeps {
  /** Read fresh on every render rather than passed once: the destination, the
   *  route and the ledger all change while this drawer is closed. */
  state(): TripPanelState;
  /** Centre the map on a step's end point, so a rider can see where the
   *  hand-off actually is. Absent means the rows are text only, which keeps
   *  this module free of any map import. */
  showOnMap?(dest: TripDest): void;
  /** "I'm not going anywhere — just reset the map." Throw away the
   *  destination, the ledger, the plan and the pins.
   *
   *  Absent means no Clear button: the host owns all four of those stores,
   *  and a button that cleared only what this module can reach (nothing)
   *  would be a lie. */
  onClear?(): void;
  /** Why clearing is refused right now, in the rider's words, or null when it
   *  is allowed. A LIVE RIDE is the case this exists for: "clear my trip"
   *  cannot mean "silently discard the ride you are on", and a button that
   *  disappeared while riding would read as a missing feature rather than as
   *  a deliberate refusal. */
  clearBlockedReason?(): string | null;
}

export interface TripPanelHandle {
  /** Re-read everything. Called when the drawer opens. */
  refresh(): void;
  dispose(): void;
}

/** Mount the panel into a drawer body. */
export function buildTripPanel(
  host: HTMLElement,
  deps: TripPanelDeps,
): TripPanelHandle {
  let disposed = false;
  /** Which step the stepper is showing. Kept across refreshes when it is still
   *  a valid index, so a rider reading step 3 does not get yanked back to the
   *  current leg because a tick re-rendered underneath them. */
  let shown: number | null = null;
  /** The Clear button has been tapped once and is asking. */
  let confirming = false;

  const body = el("div", "trippanel");
  host.replaceChildren(body);

  const render = (): void => {
    if (disposed) return;
    const state = deps.state();
    const trip = activeTrip();
    const steps = tripSteps(trip);
    body.replaceChildren();

    // ---- Where you are going -------------------------------------------
    if (state.dest === null) {
      body.append(
        el(
          "p",
          "account-hint",
          "No destination yet. Tap “Where to?” at the bottom of the map and we'll work out how to get you there.",
        ),
      );
      // The preference still shows: a rider who came here to check it before
      // planning anything should find it rather than an empty page.
      body.append(preferenceRow());
      // No Clear row here, and this is the one place it is right to omit it:
      // there is no destination, so there is nothing to clear, and an enabled
      // button that does nothing teaches the rider it does nothing.
      return;
    }

    body.append(el("p", "trippanel__label", "Going to"));
    body.append(el("p", "trippanel__dest", state.dest.label || "a dropped pin"));
    const figures = [etaLine(state), distanceLine(state)].filter(
      (x): x is string => x !== null,
    );
    body.append(
      el(
        "p",
        "account-hint",
        figures.length > 0
          ? figures.join(" · ")
          : "No arrival estimate: turn-by-turn is off for this ride, so we have not routed it.",
      ),
    );

    // ---- This trip ------------------------------------------------------
    if (trip !== null) {
      const leg = legDestination(trip);
      body.append(
        el(
          "p",
          "trippanel__leg",
          `Leg ${currentLeg(trip)} of ${trip.plannedRides}${
            leg && leg !== trip.dest ? ` — to ${leg.label || "your next scooter"}` : ""
          }`,
        ),
      );
      const spend = tripSpendLine(trip);
      if (spend !== null) body.append(el("p", "account-hint", spend));
    }

    // ---- The plan, piece by piece ---------------------------------------
    if (steps.length > 1) {
      if (shown === null || shown < 1 || shown > steps.length) {
        shown = currentLeg(trip!);
      }
      const step = steps[shown - 1];
      const stepper = el("div", "trippanel__stepper");
      const prev = el("button", "text-btn", "‹ Back");
      prev.type = "button";
      prev.disabled = shown <= 1;
      prev.addEventListener("click", () => {
        if (shown !== null && shown > 1) shown -= 1;
        render();
      });
      const next = el("button", "text-btn", "Next ›");
      next.type = "button";
      next.disabled = shown >= steps.length;
      next.addEventListener("click", () => {
        if (shown !== null && shown < steps.length) shown += 1;
        render();
      });
      stepper.append(prev, el("span", "trippanel__stepcount", `Step ${step.index} of ${steps.length}`), next);
      body.append(stepper);

      const line = el(
        "p",
        `trippanel__step${step.done ? " is-done" : ""}${step.current ? " is-current" : ""}`,
        step.handOff ? `Ride to ${step.to}, then switch` : `Ride to ${step.to}`,
      );
      body.append(line);
      body.append(
        el(
          "p",
          "account-hint",
          step.done
            ? "Done."
            : step.current
              ? "This is the leg you are on."
              : "Still ahead. We will look for the scooter again when you get there — the one in the plan may have moved.",
        ),
      );

      const target =
        step.index <= trip!.handOffs.length ? trip!.handOffs[step.index - 1] : trip!.dest;
      if (deps.showOnMap && target) {
        const show = el("button", "text-btn", "Show on map");
        show.type = "button";
        show.addEventListener("click", () => deps.showOnMap?.(target));
        body.append(show);
      }
    }

    body.append(preferenceRow());
    const clear = clearRow();
    if (clear) body.append(clear);
  };

  /** "Clear my trip" — behind one confirm, because it throws away a
   *  destination the rider typed and a plan they chose, and there is no undo.
   *
   *  The confirm is IN THE PANEL rather than a `window.confirm`: this drawer
   *  is open on a phone over a map, and a native dialog there is a different
   *  surface with its own dismissal rules. `refresh()` disarms it, so closing
   *  the drawer and coming back never lands on a primed button. */
  function clearRow(): HTMLElement | null {
    if (!deps.onClear) return null;
    const wrap = el("div", "trippanel__clear");
    const blocked = deps.clearBlockedReason?.() ?? null;
    if (blocked !== null) {
      const btn = el("button", "text-btn", "Clear my trip");
      btn.type = "button";
      btn.disabled = true;
      wrap.append(btn, el("p", "account-hint", blocked));
      return wrap;
    }
    if (!confirming) {
      const btn = el("button", "text-btn", "Clear my trip");
      btn.type = "button";
      btn.addEventListener("click", () => {
        confirming = true;
        render();
      });
      wrap.append(
        btn,
        el(
          "p",
          "account-hint",
          "Forget where you were going and put the map back to just the scooters.",
        ),
      );
      return wrap;
    }
    const go = el("button", "text-btn is-danger", "Yes, clear it");
    go.type = "button";
    go.addEventListener("click", () => {
      confirming = false;
      deps.onClear?.();
      // Re-render from the host's NEW state rather than assuming the clear
      // worked: whatever it did or did not manage to drop, this panel shows
      // what is actually there afterwards.
      render();
    });
    const keep = el("button", "text-btn", "Keep it");
    keep.type = "button";
    keep.addEventListener("click", () => {
      confirming = false;
      render();
    });
    wrap.append(go, keep);
    wrap.append(
      el("p", "account-hint", "This cannot be undone. The trip is not saved anywhere else."),
    );
    return wrap;
  }

  /** The routing preference, read-only, saying where it lives.
   *
   *  A duplicate select here would be a second home for one setting, and two
   *  homes is how a setting comes to disagree with itself. */
  function preferenceRow(): HTMLElement {
    const wrap = el("div", "trippanel__pref");
    wrap.append(el("p", "trippanel__label", "Planning preference"));
    wrap.append(el("p", "trippanel__prefvalue", routingPreferenceLabel()));
    wrap.append(
      el(
        "p",
        "account-hint",
        "Change this under Account → In-Ride Preferences → Trip plans.",
      ),
    );
    return wrap;
  }

  render();

  return {
    refresh() {
      // The Clear confirm IS disarmed here, unlike the stepper below. The
      // asymmetry is deliberate: a half-answered "are you sure?" found on
      // re-opening is one tap from throwing the trip away, and the rider's
      // answer to it was for the moment they were asked, not for later.
      confirming = false;
      // The stepper's position is NOT reset here. A rider who opened the
      // drawer, read ahead to step 3 and left it open should find step 3 when
      // they look back, not wherever the ride has got to.
      render();
    },
    dispose() {
      disposed = true;
      host.replaceChildren();
    },
  };
}
