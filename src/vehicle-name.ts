// What to call a scooter.
//
// The API derives "Lunar 🐸" from the vehicle identifier (sql/073) and puts it
// on the public payload. It deliberately does NOT add the plate suffix that
// tells two Lunar 🐸s apart, because the public payload carries no plate — but
// this app resolves its own plates from Veo's GBFS feed, so the disambiguating
// digits are ours to add once we already have them.
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
): string {
  if (!publicName) return modelName || "Veo Unknown";
  const suffix = plateSuffix(plate);
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
