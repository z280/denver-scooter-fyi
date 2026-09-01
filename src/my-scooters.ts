// MY SCOOTERS — the vehicles a rider kept.
//
// Not `favorites.ts`. That module is saved PLACES — "Home", "Work", "the
// gazebo" — local, capped at twelve, no account needed, drawn as map pins.
// This is saved VEHICLES: server-side (the point is finding them from any
// phone), account-scoped, capped at ten, and gated on a physical scan. They
// share a word and nothing else, and merging them would put two
// cardinalities, two storage layers and two privacy postures in one file.
//
// THE CLIENT'S JOB HERE IS MOSTLY NOT BEING CLEVER. Two server rules run this
// feature and neither is reimplemented:
//
//   THE GATE. Keeping a vehicle needs a QR payload and a fix within 75 m of
//   it. This module validates NEITHER. It hands over the raw payload exactly
//   as `qr-scan.ts`'s own header says to — "a client-side rule is two deploys
//   away from disagreeing with the server's" — and renders whatever comes
//   back. It does not even resolve which scooter was scanned: the identifier
//   is a salted hash the browser cannot compute, and the server reads it off
//   the sticker.
//
//   THE WITHHOLDING. A kept vehicle's position and charge are absent while
//   somebody is riding it. The row must SAY so — "In use · we'll show you
//   where when it's parked" — never a blank, never a spinner, and above all
//   never the last known dot kept from before the transition. That cache is
//   the obvious helpful optimization and it defeats the whole rule, so this
//   module holds no position state between renders at all and there is a test
//   that a row going available → in_use loses the dot.
//
// A favourite is not a claim and not a reservation. Nothing here holds a
// vehicle, and no copy in this file may suggest otherwise.
//
// House rules: `document.createElement` only, a `cleanupFns[]` teardown list,
// and every network refusal rendered as a sentence rather than a code.

import { ApiError, type FavoriteDevice, type FavoriteState } from "./api.ts";

// ---------------------------------------------------------------------------
// Presentation — pure, and the part worth testing
// ---------------------------------------------------------------------------

/** What a row says about where the vehicle is.
 *
 *  A discriminated result rather than a string, so a renderer cannot
 *  accidentally print a position for a state that has none: the coordinates
 *  only exist on the one variant that carries them. */
export type FavoriteLocation =
  | { kind: "here"; lat: number; lon: number; battery: number | null }
  | { kind: "withheld"; reason: FavoriteState; sentence: string };

/** The rider-facing sentence for each state. Written to be read in a list,
 *  and to explain the absence rather than leave it to be discovered. */
export const WITHHELD_SENTENCE: Record<"in_use" | "gone", string> = {
  in_use: "In use — we'll show you where when it's parked.",
  gone: "We haven't seen this one in a while.",
};

export const STATE_LABEL: Record<FavoriteState, string> = {
  available: "Ready to ride",
  unavailable: "Not rentable right now",
  in_use: "In use",
  gone: "Not seen lately",
};

/** Where this favourite is, or why we are not saying.
 *
 *  KEYS OFF THE FLAG, NOT OFF THE ABSENCE. A missing `lat` could be a
 *  withheld position, a server that has not deployed yet, or a bug — and only
 *  one of those should be rendered as an explanation. Trusting the flag also
 *  means a server that (wrongly) sends both a flag and a position still
 *  withholds, which is the safe direction for the mistake to fall.
 */
export function locationOf(f: FavoriteDevice): FavoriteLocation {
  if (f.position_withheld) {
    const reason = f.state === "gone" ? "gone" : "in_use";
    return {
      kind: "withheld",
      reason: f.state,
      sentence: WITHHELD_SENTENCE[reason],
    };
  }
  if (typeof f.lat !== "number" || typeof f.lon !== "number") {
    // Not withheld and not located: the server said nothing useful. Say that
    // rather than inventing a position or rendering an empty row.
    return {
      kind: "withheld",
      reason: f.state,
      sentence: "We don't have a position for this one right now.",
    };
  }
  return {
    kind: "here",
    lat: f.lat,
    lon: f.lon,
    battery: typeof f.battery_percent === "number" ? f.battery_percent : null,
  };
}

/** What to call it: the rider's nickname, else the model, else honestly
 *  nothing-in-particular. Never the 16-hex identifier — that is a database
 *  key, and printing one at a rider is how an app tells them it does not
 *  really know what it is showing. */
export function favoriteTitle(f: FavoriteDevice): string {
  if (f.nickname && f.nickname.trim()) return f.nickname.trim();
  if (f.vehicle_model_name) return `My ${f.vehicle_model_name}`;
  return "My scooter";
}

/** The sentence for a refusal, in the rider's terms.
 *
 *  Every one of these is a thing they can act on, so none of them is rendered
 *  as a status code. `too_far_from_device` in particular has to explain
 *  itself: "your QR scan worked but you're not there" is baffling without the
 *  distance, and it is the one refusal an honest rider will hit.
 */
export function keepErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return "Couldn't reach the server — try again in a moment.";
  }
  const detail = err.detail as Record<string, unknown> | undefined;
  const key = typeof detail?.error === "string" ? detail.error : err.errorKey;
  switch (key) {
    case "too_far_from_device": {
      const away = typeof detail?.meters_away === "number"
        ? ` It was last seen about ${Math.round(detail.meters_away)} m away.`
        : "";
      return `You'll need to be standing at this one.${away}`;
    }
    case "qr_mismatch":
      return "That QR code doesn't match a scooter we know. Try scanning it again.";
    case "unknown_device":
      return "We don't have that scooter in the fleet yet — try again after the next refresh.";
    case "favorite_limit_reached": {
      const max = typeof detail?.max_favorites === "number"
        ? detail.max_favorites
        : 10;
      return `You already keep ${max} scooters — let one go before keeping another.`;
    }
    default:
      return err.status === 401
        ? "Sign in to keep a scooter."
        : "Couldn't keep that one — try again in a moment.";
  }
}
