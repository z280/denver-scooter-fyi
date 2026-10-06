// Privacy Policy and Terms of Use, on the map, always.
//
// WHERE THEY USED TO BE: one place, inside the collapsed founder's note in the
// About drawer — three taps deep, behind a `<details>` nobody opens, and
// nowhere at all for the majority of visitors who never open a drawer. The
// governing documents of a site that collects usage events and runs accounts
// cannot be a thing you have to go looking for.
//
// WHY A MAP CONTROL AND NOT A DRAWER SECTION. Legal links live in a page
// footer; this app has no page, it has a map. The closest true equivalent is
// the attribution corner, which is already where a reader looks for "who made
// this and under what terms" — so this registers as its own control in the
// same bottom-left stack and renders BELOW the attribution, as the last row of
// one footer group rather than a competing surface somewhere else.
//
// WHY IT IS A CHIP THAT OPENS, NOT TWO LINKS IN A ROW. The first build of this
// put "Privacy · Terms" inline, and a screenshot at 390×844 settled it: the
// pill measured x 22–121 / y 725–752 against a home bar at x 78–311 /
// y 735–780. A phone's bottom edge is already fully committed — zoom control
// left, home bar centred, freshness pill right — and there is no width there
// for two links. The same measurement is why `style.css` lifts the attribution
// by 52px when it opens.
//
// So it collapses, exactly as the map's own attribution does: one ~50px chip
// that clears the home bar's left edge, and both documents one tap inside it.
// `<details>` rather than a modal because it is the repo's existing accordion
// pattern and it keeps the keyboard behaviour, the open state and the
// focusability for free — no JS, nothing to tear down, and it works before any
// script has run.
//
// It also follows the body-class rules the rest of this corner follows: the
// arrival panel and a live ride own it outright, and a rider mid-ride is not
// reading the terms of service.

import { LEGAL_LINKS } from "./config.ts";

const ROOT_CLASS = "legal-links";

/** A MapLibre `IControl`. Typed structurally rather than importing the
 *  interface, for the same reason `recenter.ts` does: this file then needs no
 *  maplibre import at all, and the tests need no map. */
export interface LegalLinksControl {
  onAdd(): HTMLElement;
  onRemove(): void;
}

/** Build the footer group. Exported separately from the control so the markup
 *  is assertable without a map. */
export function buildLegalLinks(): HTMLElement {
  const root = document.createElement("details");
  // `maplibregl-ctrl` so it inherits the corner's own spacing and sits in the
  // stack like every other control; the rest is ours.
  root.className = `maplibregl-ctrl ${ROOT_CLASS}`;

  const summary = document.createElement("summary");
  summary.className = `${ROOT_CLASS}__summary`;
  // "Legal" rather than "Privacy & terms": the chip has to fit in the ~56px
  // between the map's left edge and the home bar, and the panel it opens says
  // what is inside it.
  summary.textContent = "Legal";
  root.append(summary);

  const panel = document.createElement("div");
  panel.className = `${ROOT_CLASS}__panel`;
  // A nav landmark, named: a screen-reader user tabbing the map chrome should
  // be told what this group is, and "Privacy" on its own does not say.
  panel.setAttribute("role", "navigation");
  panel.setAttribute("aria-label", "Legal");

  for (const spec of LEGAL_LINKS) {
    const a = document.createElement("a");
    a.className = `${ROOT_CLASS}__link`;
    a.href = spec.href;
    a.target = "_blank";
    // `noopener` is not optional on a target=_blank to a document we want
    // riders to trust: without it the opened page gets a handle on this one.
    a.rel = "noopener noreferrer";
    a.textContent = spec.label;
    panel.append(a);
  }

  root.append(panel);
  return root;
}

/** The control. `main.ts` adds it to `bottom-left` AFTER the attribution, so
 *  it renders as that corner's last row. */
export function createLegalLinks(): LegalLinksControl {
  let el: HTMLElement | null = null;
  return {
    onAdd(): HTMLElement {
      el = buildLegalLinks();
      return el;
    },
    onRemove(): void {
      el?.remove();
      el = null;
    },
  };
}
