// The cross-option cascade rules: which 🏆 data-donation options a ride cannot
// offer, and the forcing function that suppresses them.
//
// WHY ITS OWN MODULE. These are pure functions of `RideOptions` plus one boolean,
// and they lived in `ride-settings.ts` — a 38 KB DOM module that imports the API
// client and `ride-modal.ts`. That put them out of reach of the one place that
// most needs them: `ride-session.ts`, the reducer, whose imports are
// deliberately type-only so the session doc's logic never drags a renderer in.
//
// The cost of that was a real bug. `setDevice` flips a ride to `private` when the
// rider picks their own device (or when a guest picks a real one), and
// `applyCascades`'s own doc comment says to run it "after any change that could
// affect a cascade — a device pick landing `own_device: true`" — but the reducer
// could not call it, so nothing did. A ride that became private kept
// `nav_improvement: true`, which the third rule below disables, and
// `ride-screen-routes.ts` reads that as consent to POST route feedback to a
// session-authed endpoint.
//
// So the rules move here, `ride-settings.ts` re-exports them unchanged for its
// own callers, and the reducer imports them directly.
//
// THE CONTEXT IS NARROWER HERE THAN IN `ride-settings.ts`, on purpose.
// `RideOptionsContext` carries `authenticated` as well, but no rule below reads
// it — it only refines the disabled-state COPY (`trophyDisabledMessage`, which
// stays in `ride-settings.ts` with the rest of the strings). Asking for just
// `private` is what lets the reducer call this: it knows whether a ride is
// private and has no business knowing whether anyone is signed in.
// `RideOptionsContext` is structurally assignable to `CascadeContext`, so every
// existing caller keeps passing exactly what it passed before.

import type { RideOptions } from "./api.ts";

/** All a cascade needs to know beyond the options themselves. */
export interface CascadeContext {
  private: boolean;
}

export type TrophyOptionKey = "battery_modeling" | "nav_improvement" | "end_survey";

export type DisableReason = "own_device" | "save_tracks_off" | "guest_or_private";

export interface OptionDisableState {
  disabled: boolean;
  /** In priority order — `own_device` first, then `save_tracks_off`, then
   *  `guest_or_private` — matching the order the master plan lists the three
   *  rules and the order `trophyDisabledMessage` picks copy from. */
  reasons: DisableReason[];
}

/** The three independent rules from the master plan, verbatim:
 *   - own-device disables battery_modeling AND end_survey (not nav — a
 *     private own-device ride disables nav too, but via the THIRD rule below,
 *     since own-device rides are always private; own-device does not gate nav
 *     directly).
 *   - save_tracks off disables battery_modeling AND nav_improvement (not
 *     survey — the survey doesn't need a track, just a Veo device + a
 *     `tracked_rides` row).
 *   - guest/private sessions disable ALL THREE (no `tracked_rides` row to
 *     survey or donate against, and `POST /ride-routes` is session-authed).
 *  Each rule is evaluated independently of whether the others happen to be
 *  true in practice (own-device rides ARE private, via the reducer) — this is
 *  a pure function of the inputs given, not an assumption about how
 *  `ride-session.ts` produces them. */
export function trophyOptionDisableStates(
  options: RideOptions,
  ctx: CascadeContext,
): Record<TrophyOptionKey, OptionDisableState> {
  const battery: DisableReason[] = [];
  if (options.own_device) battery.push("own_device");
  if (!options.save_tracks) battery.push("save_tracks_off");
  if (ctx.private) battery.push("guest_or_private");

  const nav: DisableReason[] = [];
  if (!options.save_tracks) nav.push("save_tracks_off");
  if (ctx.private) nav.push("guest_or_private");

  const survey: DisableReason[] = [];
  if (options.own_device) survey.push("own_device");
  if (ctx.private) survey.push("guest_or_private");

  return {
    battery_modeling: { disabled: battery.length > 0, reasons: battery },
    nav_improvement: { disabled: nav.length > 0, reasons: nav },
    end_survey: { disabled: survey.length > 0, reasons: survey },
  };
}

/** Force every disabled 🏆 field to `false`, leaving everything else (and any
 *  enabled 🏆 field) untouched. Run this after any change that could affect a
 *  cascade — a device pick landing `own_device: true`, a guest signing in, a
 *  Usual applied wholesale (a Usual saved while signed in on a real device
 *  can carry 🏆 options a later guest/own-device context must still
 *  suppress).
 *
 *  The reducer calls it on every transition that can move `private` or
 *  `own_device`, so "run this after" is enforced rather than remembered. */
export function applyCascades(
  options: RideOptions,
  ctx: CascadeContext,
): RideOptions {
  const states = trophyOptionDisableStates(options, ctx);
  return {
    ...options,
    battery_modeling: states.battery_modeling.disabled
      ? false
      : options.battery_modeling,
    nav_improvement: states.nav_improvement.disabled
      ? false
      : options.nav_improvement,
    end_survey: states.end_survey.disabled ? false : options.end_survey,
  };
}
