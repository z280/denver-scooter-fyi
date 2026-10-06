// Privacy Policy and Terms of Use, inside the map's attribution.
//
// WHERE THEY USED TO BE: one place, inside the collapsed founder's note in the
// About drawer — three taps deep, behind a `<details>` nobody opens, and
// nowhere at all for the majority of visitors who never open a drawer. The
// governing documents of a site with accounts and usage events cannot be a
// thing you have to go looking for.
//
// WHY THEY ARE NOT THEIR OWN CONTROL ANY MORE. They were, briefly: a "Legal"
// chip registered into the bottom-left stack directly under the attribution.
// It fitted — measured, at 390×844 — and it was still wrong. That corner
// already holds the ⓘ, and the ⓘ is not decoration: it carries the
// OSM/Protomaps attribution that is a CONDITION of the basemap licence, which
// is why `style.css` has a standing rule that it must open. Putting a second
// pill of the same size and shape immediately beside it made the one button
// with a legal obligation attached to it harder to find and harder to hit.
//
// So the links go INSIDE the ⓘ rather than beside it. They are the same kind
// of thing a reader opens that button for — who made this, and under what
// terms — and MapLibre's `customAttribution` is the seam built for it. The
// corner goes back to two controls, the ⓘ gets its space back, and the
// documents are still one tap from anywhere on the map.
//
// THE COST, STATED: they are now behind a tap rather than on screen. That is
// the trade — a visible second pill that degraded a licence obligation, or a
// one-tap panel that does not. The About drawer still carries them in prose,
// which is where somebody looking for them deliberately goes.

import { LEGAL_LINKS } from "./config.ts";

/** The links as attribution entries.
 *
 *  MapLibre renders these as trusted HTML inside the attribution bar, so the
 *  markup is built from `LEGAL_LINKS` rather than interpolated from anything a
 *  user or a server can reach — the list is a module constant, and it stays
 *  that way.
 *
 *  `noopener noreferrer` for the same reason it was there before: these open a
 *  document we want riders to trust, and without it the opened page gets a
 *  handle on this one.
 */
export function legalAttribution(): string[] {
  return LEGAL_LINKS.map(
    (spec) =>
      `<a href="${spec.href}" target="_blank" rel="noopener noreferrer">${spec.label}</a>`,
  );
}
