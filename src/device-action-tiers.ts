// §12.2 — three named tiers, and every action on the device card declares which
// one it is in.
//
// WHY A TABLE AND NOT FOUR GATES. Before this, the card's proximity rules were
// four independent decisions that happened to be defensible one at a time, and
// the pattern across them was the wrong way round: the cheap actions were gated
// and the expensive ones were not. `📷 Take Photo` attached rider evidence to a
// specific vehicle from any distance on earth, and `☑️ Confirm Features`
// asserted what equipment a scooter has — both ungated — while *reporting bad
// parking*, a complaint about a thing you can see, was correctly gated. Nobody
// chose that; it is what four separately-reasonable gates add up to.
//
// So the rule is declared once, the radius per tier is one number, and an action
// that does not appear in `ACTION_RULES` does not typecheck.
//
// ---------------------------------------------------------------------------
// ADMINS ARE EXEMPT FROM PROXIMITY, NEVER FROM SIGN-IN.
//
// The justification was already written at the parking-report gate and is the
// general one, so it moves here: THE GATE IS A CREDIBILITY CHECK, NOT A DATA
// DEPENDENCY. Every one of these reports is built from the DEVICE's coordinates
// and never the reporter's, so a distant admin files exactly the same report,
// and an admin working a compliance queue from a desk is doing the job.
//
// Sign-in is a different kind of requirement — the endpoint refuses without a
// bearer token — so no role is exempt from it, which is already how the card's
// unlock gate behaves.
// ---------------------------------------------------------------------------

/** The three tiers. Named, because "75" and "100" in four places is not a rule,
 *  it is four coincidences. */
export type ActionTier =
  /** Reading public data, or a purely local act. No radius. */
  | "anywhere"
  /** "I could walk to this" — starts a journey. */
  | "in_reach"
  /** "I am standing here and I can see it": any claim about this vehicle's
   *  condition, position or equipment, and the unlock. */
  | "at_the_vehicle";

/** ONE radius for `at_the_vehicle`, and the unlock's own is it.
 *
 *  Generous enough to tolerate consumer-GPS scatter (~20–40 m), tight enough
 *  that being inside it means "you are at this scooter".
 *
 *  THIS TIGHTENS REPORTS FROM 100 m TO 75 m, and that is the plan's call rather
 *  than a tidy-up. The 100 m this replaces had a real argument behind it — you
 *  can see a badly-parked scooter from across the street — and the counter-
 *  argument wins anyway: a second radius for the same claim-type is a
 *  distinction no rider can perceive and nobody will maintain, and the drift it
 *  produced is exactly how the card ended up with four gates nobody designed
 *  together. One number, named, in one place. */
export const AT_THE_VEHICLE_M = 75;

/** How far away a scooter can be and still be worth walking to: a fifteen-
 *  minute walk at the 4.5 km/h pace the walk router quotes, which is the limit
 *  dibs already uses. Past it a claim is speculation and the walk is a hike. */
export const IN_REACH_M = Math.round(((4.5 * 1000) / 60) * 15); // ~1125 m

/** Every action the device card offers. Exhaustive by construction: a new
 *  action without a rule below is a type error, which is §12.5's "no action may
 *  ship without declaring a tier" enforced by the compiler rather than by a
 *  reviewer remembering. */
export type DeviceAction =
  | "open_in_veo"
  | "ride"
  | "report_parking"
  | "report_device"
  | "take_photo"
  | "show_photos"
  | "confirm_features"
  | "details"
  | "dibs";

export interface ActionRule {
  tier: ActionTier;
  /** The endpoint refuses without a bearer token. No role is exempt. */
  requiresSignIn: boolean;
  /** What to say when sign-in is what is missing. Each action's own words,
   *  because "sign in to do this" is useless and the existing sentences are
   *  already good. */
  signInHint?: string;
  /** Too far away. `{distance}` is substituted with a formatted figure.
   *
   *  PER ACTION, NOT PER TIER, because one sentence per tier does not fit:
   *  "this comes from riders at the scooter" is right for a report and wrong
   *  for the unlock, which is not a report about anything. §12.4's finding was
   *  that the existing sentences are already good and the bug is purely that a
   *  phone never shows them — so they are kept, verbatim where they existed,
   *  rather than replaced with one generic line. Falls back to the tier's own
   *  wording when an action has nothing more specific to say. */
  tooFarHint?: string;
  /** No GPS fix. Same reasoning. */
  noFixHint?: string;
}

export const ACTION_RULES: Record<DeviceAction, ActionRule> = {
  // The unlock: the rider is about to start paying, at this vehicle.
  open_in_veo: {
    tier: "at_the_vehicle",
    requiresSignIn: true,
    signInHint: "Sign in (Account tab) to start rides here.",
    // Kept verbatim from the card, with the distance added: "too far away" with
    // no figure leaves the rider guessing whether to walk ten steps or ten
    // minutes, and this one is the primary CTA.
    tooFarHint: "You're too far away, sorry — that's {distance}.",
    noFixHint: "Turn on your location to start at the scooter.",
  },
  // NOT `at_the_vehicle`, and this is the one place the looser tier is the
  // whole point: "I'll ride this one" used to share the unlock's 75 m because
  // it used to mean "I am standing at this scooter". It starts a WALK now, so
  // the tight radius made the walk feature reachable only from the one place
  // you would never need it.
  ride: {
    tier: "in_reach",
    requiresSignIn: false,
    tooFarHint: "Too far to walk — that's {distance} away.",
    noFixHint: "Turn on your location to ride this scooter.",
  },
  // A claim about where this vehicle is parked.
  report_parking: {
    tier: "at_the_vehicle",
    requiresSignIn: false,
    // The card's own words, kept — only the distance is new. §12.4's point is
    // that these sentences are already good and the bug was that a phone never
    // showed them, so a rewrite here would be solving a problem nobody had.
    tooFarHint:
      "Walk within sight of this scooter to report its parking — you're {distance} away.",
    noFixHint: "Turn on your location to report bad parking.",
  },
  // A claim about whether it works — and the most consequential thing a rider
  // can do from this card: it labels the vehicle High risk for everybody until
  // it is cleared (a 100 m+ move, a rider's test ride, or an admin).
  report_device: {
    tier: "at_the_vehicle",
    requiresSignIn: false,
    tooFarHint:
      "You're too far away to report this one ({distance}). Reports come from riders at the scooter.",
    noFixHint:
      "Turn on your location to report this one — reports carry weight because they come from somebody who was there.",
  },
  // Rider evidence attached to a specific vehicle. It was ungated.
  take_photo: {
    tier: "at_the_vehicle",
    requiresSignIn: true,
    signInHint: "Sign in (Account tab) to add or view photos.",
    tooFarHint:
      "You're too far away to photograph this one ({distance}) — a photo is evidence about a scooter you can see.",
    noFixHint: "Turn on your location to photograph this one.",
  },
  // READING, so `anywhere` — and deliberately not symmetric with uploading. An
  // older photo of a scooter is worth looking at from anywhere, and that is
  // much of the point of having them.
  show_photos: {
    tier: "anywhere",
    requiresSignIn: true,
    signInHint: "Sign in (Account tab) to add or view photos.",
  },
  // A claim about what equipment this scooter has. It was ungated: a rider
  // could assert a basket onto a scooter in another neighbourhood.
  confirm_features: {
    tier: "at_the_vehicle",
    requiresSignIn: false,
    tooFarHint:
      "You're too far away to confirm this one's equipment ({distance}) — it needs somebody looking at it.",
    noFixHint: "Turn on your location to confirm this one's equipment.",
  },
  details: { tier: "anywhere", requiresSignIn: false },
  dibs: { tier: "anywhere", requiresSignIn: false },
};

export interface GateContext {
  /** Metres from the rider to the vehicle, or null with no GPS fix.
   *
   *  NULL IS NOT ZERO AND NOT INFINITY. "We have not looked" earns its own
   *  sentence: a rider with location off is one tap from being allowed, and
   *  telling them they are too far away when we do not know where they are is
   *  the app asserting something it cannot see. */
  distanceMeters: number | null;
  signedIn: boolean;
  admin: boolean;
  /** How to word the distance in a refusal, per tier. Optional, and the card
   *  passes one.
   *
   *  BECAUSE THE RIGHT UNIT DIFFERS BY TIER, and this module should not be the
   *  one deciding that. `at_the_vehicle` is about standing next to something, so
   *  feet; `in_reach` is about whether you will walk there, so MINUTES — and the
   *  pace that converts them lives in `locate.ts` beside the walk router that
   *  quotes it. Importing that here to borrow the conversion would drag a module
   *  that reads `navigator` into a pure one, and re-deriving the pace would give
   *  the card two answers for one walk. */
  describeDistance?(meters: number, tier: ActionTier): string;
}

export type Gate = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: Gate = { allowed: true };

export function radiusFor(tier: ActionTier): number | null {
  if (tier === "anywhere") return null;
  return tier === "in_reach" ? IN_REACH_M : AT_THE_VEHICLE_M;
}

/** Format metres the way the card already does elsewhere — feet under a
 *  quarter mile, then miles — so a gate's sentence reads like the rest of the
 *  popup rather than like a different app. */
export function formatDistance(meters: number): string {
  const feet = meters * 3.28084;
  if (feet < 1320) return `${Math.round(feet / 10) * 10} ft`;
  return `${(meters / 1609.344).toFixed(1)} mi`;
}

/** May the rider take this action from where they are?
 *
 *  ORDER MATTERS: sign-in is checked first. An admin is exempt from proximity
 *  and from nothing else, so checking proximity first would let a signed-out
 *  admin session past a gate the endpoint is going to refuse anyway, and the
 *  rider would learn that from a 401 instead of from this sentence. */
export function gate(action: DeviceAction, ctx: GateContext): Gate {
  const rule = ACTION_RULES[action];
  if (rule.requiresSignIn && !ctx.signedIn) {
    return {
      allowed: false,
      reason: rule.signInHint ?? "Sign in (Account tab) to do this.",
    };
  }
  const radius = radiusFor(rule.tier);
  if (radius === null) return ALLOWED;
  if (ctx.admin) return ALLOWED;
  if (ctx.distanceMeters === null) {
    return {
      allowed: false,
      reason:
        rule.noFixHint ??
        (rule.tier === "in_reach"
          ? "Turn on your location so we can tell how far this one is."
          : "Turn on your location to use this — it carries weight because it comes from somebody who was there."),
    };
  }
  if (ctx.distanceMeters <= radius) return ALLOWED;
  const distance =
    ctx.describeDistance?.(ctx.distanceMeters, rule.tier) ??
    formatDistance(ctx.distanceMeters);
  const template =
    rule.tooFarHint ??
    (rule.tier === "in_reach"
      ? "That one's a long way off ({distance}) — pick one closer, or zoom out and walk."
      : "You're too far away ({distance}). This comes from riders at the scooter.");
  return { allowed: false, reason: template.replace("{distance}", distance) };
}

/** Every action that claims something about a specific vehicle, for the test
 *  that there is exactly ONE radius among them. */
export function actionsInTier(tier: ActionTier): DeviceAction[] {
  return (Object.keys(ACTION_RULES) as DeviceAction[]).filter(
    (a) => ACTION_RULES[a].tier === tier,
  );
}
