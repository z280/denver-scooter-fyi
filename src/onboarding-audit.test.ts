// §7.4 — the "what does the tour promise" audit, left behind as a test.
//
// `ONBOARDING_SCREENS` was already exported so an audit could read the copy
// without opening the overlay. Phase 7 was the first such audit, and this is it
// made permanent, because the failure it found is the kind that cannot be seen
// from inside the tour: the closing CTA ended by CLICKING
// `#mode-switch .mode-btn[data-mode="ride"]`, an element Phase 6 had deleted. The
// tour still rendered, still advanced, still looked right, and its final promise
// did nothing.
//
// A tour is a set of CLAIMS ABOUT THE APP. The rule (§7.2) is that the tour
// describes the app and the app does not chase the tour — so when a claim stops
// resolving, this fails and the SCREEN changes.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { functionBody, readSource } from "../tests/helpers/source-text.ts";
import { ONBOARDING_SCREENS } from "./onboarding.ts";

const ROOT = join(import.meta.dirname, "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const publicFiles = new Set(readdirSync(join(ROOT, "public")));
const main = readSource("src/main.ts");

const allCopy = ONBOARDING_SCREENS.map((s) => `${s.headline} ${s.body}`).join("\n");

/** `wireOnboarding`'s body, comments stripped — see
 *  `tests/helpers/source-text.ts` for the two corrections baked into that
 *  helper, both found by mutating the code these assertions are about. */
const onboardingWiring = functionBody(main, "function wireOnboarding(): void {");

describe("every element the tour names resolves", () => {
  it("names no DOM id that index.html does not have", () => {
    // The assertion that would have caught `#mode-switch`. Ids in the tour's own
    // markup (`onb-*` classes are the tour's) are not app ids; what matters is a
    // reference to something the APP owns.
    // Hex colours are not selectors. The territory screen sets `--hex: #e69f00`
    // on its hexagons, and a first version of this test demanded an element with
    // `id="e69f00"` — a false positive that would have had somebody "fix" the
    // copy to satisfy the audit, which is the tour chasing the app backwards.
    const ids = [...allCopy.matchAll(/#([a-z][a-z0-9-]{2,})/g)]
      .map((m) => m[1])
      .filter((id) => !/^[0-9a-f]{3,8}$/.test(id));
    for (const id of ids) {
      expect(html, `#${id} is named by the tour`).toContain(`id="${id}"`);
    }
  });

  it("names no data-mode selector, because modes are gone", () => {
    // §6.2 deleted the mode bar. A tour that reaches for `[data-mode=…]` is
    // reaching for the seam this program removed.
    expect(allCopy).not.toMatch(/data-mode/);
    expect(onboardingWiring).not.toMatch(/data-mode/);
  });

  it("ships every image it shows", () => {
    // A missing asset is a blank panel on the first screen a new rider sees, and
    // `loading="lazy"` means it fails silently and late.
    const srcs = [...allCopy.matchAll(/src="\/([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(publicFiles, `${src} is shown by the tour`).toContain(src);
    }
  });
});

describe("the copy describes the app as it is now", () => {
  it("does not sell Ride Mode as a destination", () => {
    // The mode vocabulary this app spent several PRs removing. "Ride Mode" as a
    // place you go is the exact claim §7.1 calls editorially broken.
    for (const screen of ONBOARDING_SCREENS) {
      expect(screen.headline, screen.id).not.toContain("Ride Mode");
      expect(screen.body, screen.id).not.toContain("Ride Mode");
    }
  });

  it("does not offer standing-or-seated as a filter, which was deleted", () => {
    // §6.3.3: posture is a property of the model, so the model IS the filter.
    // Promising a control that no longer exists is the same failure as the dead
    // CTA, one layer up.
    expect(allCopy).not.toMatch(/standing or seated/i);
    expect(allCopy).not.toMatch(/sitting or standing/i);
  });

  it("distinguishes a saved view from a saved spec", () => {
    // The tour is where a new rider forms this distinction, and the old copy
    // ("save your favorite combos and reuse them in one tap") collapsed the two.
    const models = ONBOARDING_SCREENS.find((s) => s.id === "models")!;
    expect(models.body).toMatch(/saved view/i);
    expect(models.body).toMatch(/ideal scooter/i);
  });

  it("mentions the hand-off plan, which is the thing the app now does", () => {
    // Phase 2's plan list. A rider who only discovers it by accident is a rider
    // we did not tell.
    expect(allCopy).toMatch(/swapping scooters mid-trip/i);
  });
});

describe("the tour is on, and still once per browser", () => {
  it("auto-shows again", () => {
    // One line, on purpose: turning it on is a decision, not a revert.
    expect(main).toMatch(/^const ONBOARDING_AUTOSHOW = true;$/m);
  });

  it("ends on the home bar's own question, not on a map state", () => {
    const body = onboardingWiring;
    expect(body).toContain("openForTrip()");
    // `openForDestination` answers one question for another surface and
    // dispatches nothing, so a tour ending there would collect a destination and
    // quietly drop it.
    expect(body).not.toContain("openForDestination");
    // find-wheels mode survives only as a FALLBACK, and only after the question.
    // `homeBar` is nullable, so an optional-call alone would make this CTA do
    // nothing if the init ordering changed — the §7.1 failure with a new cause
    // and no symptom. The assertion is on primacy, not absence.
    expect(body.indexOf("openForTrip()")).toBeLessThan(body.indexOf("enterFindWheels()"));
  });
});
