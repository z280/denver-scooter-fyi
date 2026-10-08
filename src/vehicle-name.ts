// What to call a scooter.
//
// The API derives "Lunar 🐸" from the vehicle identifier (sql/073) and now
// ships the disambiguating digits with it, as `plate_suffix`.
//
// It used to withhold them, and this app recovered them client-side from a
// full plate. A full plate is still a fallback (signed-in riders get one from
// our `/vehicles/plates`, plates.ts), but only for nearby vehicles and never
// for a guest — so the rider standing in a cluster of four identically-named
// scooters, who is the entire reason the digits exist, could be the one not
// to get them. Preferring the server's copy is what makes them reliable.
//
// WHY A NAME AT ALL. "Cosmo" is what a scooter IS; "Lunar 🐸 928" is WHICH
// one. Which one is the thing a rider says out loud, shows on a certificate,
// and argues about on a pavement — and it is the only one of the two that
// survives being read to somebody who has never used the app.

/** Last three alphanumerics of the plate — what is printed on the deck, so a
 *  rider can check the name against the thing in front of them. */
export function plateSuffix(plate: string | null | undefined): string | null {
  if (!plate) return null;
  const chars = String(plate).replace(/[^a-zA-Z0-9]/g, "");
  return chars.length >= 3 ? chars.slice(-3) : chars || null;
}

/** "Lunar 🐸 928", "Lunar 🐸", or the model as a last resort.
 *
 *  Falls back rather than inventing: an older payload carries no public_name,
 *  and a scooter called "undefined 928" is worse than one called "Cosmo". */
export function vehicleDisplayName(
  publicName: string | null | undefined,
  plate: string | null | undefined,
  modelName: string | null | undefined,
  /** The server's `plate_suffix`, preferred over deriving one from a plate we
   *  resolved ourselves — it is present whenever the API knows the vehicle,
   *  where a full plate needs a sign-in and a nearby-vehicle lookup. */
  serverSuffix?: string | null,
): string {
  if (!publicName) return modelName || "Veo Unknown";
  const suffix = serverSuffix || plateSuffix(plate);
  return suffix ? `${publicName} ${suffix}` : publicName;
}

/** "Veo Cosmo" -> "Cosmo".
 *
 *  The model catalogue's display names carry the maker, which is right on a
 *  popup card and wrong anywhere the maker is already named. The dibs
 *  certificate prints provider + type + name, so handing it the prefixed
 *  string produced "Veo Veo Cosmo Veo Cosmo". */
export function bareModelName(modelName: string | null | undefined): string {
  if (!modelName) return "";
  return String(modelName).replace(/^\s*Veo\s+/i, "").trim();
}

// ---------------------------------------------------------------------------
// Qualified names: what it is, then which one
// ---------------------------------------------------------------------------
//
// `vehicleDisplayName` answers WHICH ONE, and its own note above says why that
// is the useful half on a pavement. But in a LIST — the plan list's leg lines,
// above all — "Ride Onward 🌳 500 19 min to Liftoff 🍉 167" tells a rider
// nothing about what they are being sent to sit on. Onward and Liftoff could
// be two Astros, two Rovers, or one of each, and whether a leg is standing on
// a scooter or sitting on a Rover changes the answer to "will I take this
// plan" more than the name does.
//
// So where a name appears as part of a CHOICE rather than as a label on a
// thing in front of you, the type comes first and the name disambiguates it:
//
//     Cosmo Onward 🌳 500
//
// OPERATOR FIRST WHERE THERE IS MORE THAN ONE. Denver has exactly one, so
// prefixing every line with "Veo" today would be four characters of noise on
// every row of a list that is already tight. The parameter exists because the
// moment a second operator appears the model name alone stops identifying
// anything — two operators can both have something called a Cosmo, and the
// rider's app, account and unlock flow all differ by operator. Building the
// seam now costs one optional argument; retrofitting it later means finding
// every place a vehicle is named.

export interface QualifiedNameParts {
  publicName: string | null | undefined;
  modelName: string | null | undefined;
  /** The server's `plate_suffix`. */
  suffix?: string | null;
  /** Shown only when the city has more than one operator; see above. */
  operator?: string | null;
}

/** "Cosmo Onward 🌳 500" — or with an operator, "Veo Cosmo Onward 🌳 500".
 *
 *  Degrades in the order the parts actually go missing. An older payload with
 *  no `public_name` yields the bare type, which is still true and still useful;
 *  a vehicle with no recognised model yields the name alone, which is what we
 *  always showed. It never prints an empty segment or a doubled operator —
 *  `bareModelName` strips the maker the catalogue carries, so passing
 *  `operator: "Veo"` with a model of "Veo Cosmo" gives "Veo Cosmo" and not
 *  "Veo Veo Cosmo", which is the exact bug the dibs certificate hit. */
export function qualifiedVehicleName(parts: QualifiedNameParts): string {
  const type = bareModelName(parts.modelName);
  const which = parts.publicName
    ? parts.suffix
      ? `${parts.publicName} ${parts.suffix}`
      : parts.publicName
    : "";
  const segments = [parts.operator?.trim() || "", type, which].filter(
    (seg) => seg.length > 0,
  );
  // Nothing at all is the one case worth a fallback rather than an empty
  // string: a blank where a vehicle should be reads as a rendering fault.
  if (segments.length === 0) return "Unknown vehicle";
  return segments.join(" ");
}
