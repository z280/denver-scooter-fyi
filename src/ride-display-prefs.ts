// The rider's standing answers about what the ride screen SHOWS: the
// speedometer style and whether the Veo cost estimate is on.
//
// WHY THESE TWO MOVED HERE. Both are `RideOptions` fields, so both were
// per-ride values stored on `tracked_rides.ride_options` — and both had the
// same defect at opposite extremes:
//
//   * `cost_hud` was asked on exactly one screen (`ride-preflight.ts`), which
//     only opens from a device card's "Use in Ride Mode". Every other way into
//     ride mode took the default and never offered the question.
//   * `speedometer` was asked NOWHERE. The field was validated, persisted,
//     read by the HUD and carried a post-ride feedback token, and no screen in
//     the app could set it. Every rider was pinned to the shipped default
//     forever. That is not a resolved friction decision; it is a control that
//     went missing while its field came alive.
//
// So they become standing preferences, exactly as `save_tracks` did — see
// `track-preference.ts`, whose reasoning this follows and whose storage
// discipline this copies. `defaultRideOptions()` seeds each ride from here, so
// a ride still CARRIES its own value (the HUD keeps reading the session doc,
// the wrench panel's Display chips keep overriding mid-ride, and a stored ride
// still records what it actually showed). What changes is where the answer
// comes from when nobody has said otherwise for this ride.
//
// localStorage rather than the account, for the same reason as save_tracks:
// these describe this device's screen. A rider's phone wants the digital
// readout and their handlebar tablet wants the dial, and a preference that
// synced would make one of those two wrong on every ride.
//
// DEFAULTS ARE THE SHIPPED ONES — `speedometer: "classic"`, `cost_hud: true` —
// so a rider who never opens the panel sees exactly what they saw before. This
// is a move, not a change of behaviour.

import type { SpeedometerStyle } from "./api.ts";

const SPEEDO_KEY = "scooter-fyi-speedometer";
const COST_HUD_KEY = "scooter-fyi-cost-hud";

export const DEFAULT_SPEEDOMETER: SpeedometerStyle = "classic";
export const DEFAULT_COST_HUD = true;

/** The three styles, with the labels and the honest descriptions the settings
 *  control uses.
 *
 *  THE MAPPING IS ASYMMETRIC AND THE DESCRIPTIONS SAY SO. `ride-hud.ts` reads
 *  the one field into two independent flags:
 *
 *      speedoClassicVisible = speedometer === "classic";
 *      speedoDigitalVisible = speedometer !== "none";
 *
 *  so "classic" lights BOTH readouts and "digital" lights only the digital
 *  one. The three options are therefore "both / digital only / neither", not
 *  the "analog / digital / off" the key names imply, and there is no stored
 *  value meaning "dial without numbers". Left that way on purpose: "classic"
 *  showing both is what every existing rider currently sees, and redefining it
 *  to mean dial-only would silently take the mph readout away from all of
 *  them. The labels below describe what each value DOES, which is the part a
 *  rider needs to be told. */
export const SPEEDOMETER_STYLES: readonly {
  value: SpeedometerStyle;
  label: string;
  hint: string;
}[] = [
  { value: "classic", label: "Classic", hint: "Analog dial and digital mph." },
  { value: "digital", label: "Digital", hint: "Digital mph only — no dial." },
  { value: "none", label: "Hidden", hint: "No speed readout at all." },
];

function isSpeedometerStyle(v: unknown): v is SpeedometerStyle {
  return v === "classic" || v === "digital" || v === "none";
}

/** Storage can throw (private mode) and can hold anything (another tab, an
 *  older build, a hand-edited profile). Both collapse to the default: a value
 *  we cannot parse is not an answer, and reading garbage as a choice would
 *  show the rider a screen they never asked for. */
export function speedometerStyle(): SpeedometerStyle {
  try {
    const raw = localStorage.getItem(SPEEDO_KEY);
    return isSpeedometerStyle(raw) ? raw : DEFAULT_SPEEDOMETER;
  } catch {
    return DEFAULT_SPEEDOMETER;
  }
}

export function setSpeedometerStyle(style: SpeedometerStyle): boolean {
  if (!isSpeedometerStyle(style)) return false;
  try {
    localStorage.setItem(SPEEDO_KEY, style);
    return true;
  } catch {
    // A preference that cannot be stored is not worth failing on. The caller
    // reports it so the rider knows it won't survive the tab, which is the
    // same contract the rate-plan select already honours.
    return false;
  }
}

/** Whether the ride screen's running Veo cost estimate is on.
 *
 *  Only an explicit "0" is off, matching `savesTracks()`: never written and
 *  written-by-something-else are the same state — we have no answer — so both
 *  take the default. */
export function showsCostHud(): boolean {
  try {
    return localStorage.getItem(COST_HUD_KEY) !== "0";
  } catch {
    return DEFAULT_COST_HUD;
  }
}

export function setShowsCostHud(on: boolean): boolean {
  try {
    localStorage.setItem(COST_HUD_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}
