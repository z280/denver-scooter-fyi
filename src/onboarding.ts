// First-run onboarding: a skippable, seven-screen tour of the ideas that make
// Scooter.fyi worth using (model choice, rideability, Ride Mode, routing,
// contributions, territory).
//
// The tour's job is NOT to explain every feature — it is to land five ideas
// in under 60 seconds (see docs discussion / success criteria): pick your
// model, avoid bad scooters, Ride Mode is built for riding, contributions
// help everyone, and there's a territory game. One idea per screen, big
// visuals, skippable at any time, replayable from the About drawer.
//
// This module owns only the overlay DOM + its localStorage flags. What
// happens AFTER the tour (entering Find-a-ride, the legend, the first
// tooltip) is main.ts's integration business, injected via OnboardingHooks —
// so this file needs no map, no wizard, and its tests need neither.

import { trapFocusWithin } from "./modal-focus-trap.ts";

// Hyphenated key: a UI preference, not app state (telemetry.ts's own
// convention note).
export const ONBOARDED_KEY = "scooter-fyi-onboarded";

export interface OnboardingHooks {
  /** Final CTA ("Start Exploring"): hand the user straight to Find-a-ride so
   *  they are never left wondering what to do next. Not called on Skip. */
  onStartExploring: () => void;
}

export interface OnboardingScreen {
  id: string;
  headline: string;
  /** Inner HTML of the screen's body — illustration + copy. Static, author-
   *  controlled strings only; nothing user-supplied ever lands here. */
  body: string;
}

/** True once the tour has been completed OR skipped — either way, never
 *  auto-show it again. Replay stays available from the About drawer. */
export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true; // storage blocked: never risk nagging on every load
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* private mode — the dismissal still holds for this page load */
  }
}

const CHECK = `<span class="onb-check" aria-hidden="true">✓</span>`;

function modelCard(model: string, img: string): string {
  return `
    <figure class="onb-model">
      <img src="${img}" alt="" loading="lazy" />
      <figcaption>${CHECK} ${model}</figcaption>
    </figure>`;
}

function tierCard(tone: "ok" | "unknown" | "risk", label: string): string {
  return `
    <div class="onb-tier onb-tier--${tone}">
      <span class="onb-tier__scooter" aria-hidden="true">🛴</span>
      <span class="onb-tier__badge">${label}</span>
    </div>`;
}

// One entry per screen, in order. Exported so tests (and any future
// "what does the tour promise" audit) can read the copy without opening
// the overlay.
export const ONBOARDING_SCREENS: readonly OnboardingScreen[] = [
  {
    id: "welcome",
    headline: "The companion app for Denver scooter riders.",
    body: `
      <p class="onb-sub">Find better scooters, ride smarter, and help improve
      Denver's scooter community.</p>
      <div class="onb-hero" aria-hidden="true">🛴</div>`,
  },
  {
    id: "models",
    headline: "Find the scooter you actually want.",
    body: `
      <div class="onb-models" aria-hidden="true">
        ${modelCard("Astro", "/astro.png")}
        ${modelCard("Cosmo", "/cosmo.png")}
        ${modelCard("Apollo", "/apollo.png")}
      </div>
      <p>Filter by model, standing or seated, minimum battery, rideability —
      even by neighborhood. Save your favorite combos and reuse them in one
      tap.</p>`,
  },
  {
    id: "rideability",
    headline: "Avoid bad scooters.",
    body: `
      <div class="onb-tiers" aria-hidden="true">
        ${tierCard("ok", "🟢 Likely Rideable")}
        ${tierCard("unknown", "🟡 Unknown Risk")}
        ${tierCard("risk", "🔴 High Risk")}
      </div>
      <p>Scooter.fyi analyzes failed starts, dwell time, rider reports, and
      other signals to help you avoid scooters that may waste your walk.</p>
      <p class="onb-callout">Battery tells you how long it might last.<br />
      <strong>Rideability</strong> tells you whether it's worth walking to.</p>`,
  },
  {
    id: "ride-mode",
    headline: "Ride Mode",
    body: `
      <div class="onb-phone" aria-hidden="true">
        <div class="onb-phone__screen">
          <span class="onb-phone__speed">14<small>mph</small></span>
          <span class="onb-phone__stat">💵 $3.40</span>
          <span class="onb-phone__stat">⏱ 12:26</span>
          <span class="onb-phone__stat">🧭 Turn left on Blake St</span>
        </div>
      </div>
      <p>Built specifically for Denver scooter riders.</p>
      <p>Rotate your phone and enjoy a dashboard designed for the landscape
      phone mounts found on many Veo scooters.</p>`,
  },
  {
    id: "routing",
    headline: "Smarter routing",
    body: `
      <div class="onb-routes" aria-hidden="true">
        <span class="onb-route">🛡️ Safe &amp; Protected</span>
        <span class="onb-route">🔋 The Range Maximizer</span>
        <span class="onb-route">🌳 The Shaded Canopy</span>
        <span class="onb-route">⚡ Commuter Express</span>
      </div>
      <p>Ride the way you want. Stick to safer streets, dodge hills to
      stretch your battery, chase shade on hot days, or take the most
      direct line.</p>`,
  },
  {
    id: "contribute",
    headline: "Help improve the map",
    body: `
      <div class="onb-report" aria-hidden="true">
        <span class="onb-tier__badge onb-report__from">🟡 Unknown Risk</span>
        <span class="onb-report__arrow">→ 📝 →</span>
        <span class="onb-tier__badge onb-report__to">🟢 Likely Rideable</span>
      </div>
      <p>Every contribution makes Scooter.fyi better.</p>
      <p>Report damaged scooters. Confirm rideability. Improve
      recommendations.</p>`,
  },
  {
    id: "territory",
    headline: "Claim your part of Denver",
    body: `
      <div class="onb-hexes" aria-hidden="true">
        <span class="onb-hex" style="--hex: #e69f00"></span>
        <span class="onb-hex" style="--hex: #0072b2"></span>
        <span class="onb-hex" style="--hex: #009e73"></span>
        <span class="onb-hex" style="--hex: #cc79a7"></span>
        <span class="onb-hex" style="--hex: #56b4e9"></span>
      </div>
      <div class="onb-identities" aria-hidden="true">
        <span class="onb-identity">Resourceful 🌈</span>
        <span class="onb-identity">Curious 🦉</span>
        <span class="onb-identity">Fearless 🐺</span>
      </div>
      <p>Earn contribution points. Compete for territory. Become known across
      Denver without revealing your identity.</p>`,
  },
];

let openTour: HTMLElement | null = null;

/** Show the tour unless it has already been completed/skipped. Returns
 *  whether it was shown. */
export function maybeShowOnboarding(hooks: OnboardingHooks): boolean {
  if (hasOnboarded()) return false;
  showOnboarding(hooks);
  return true;
}

/** Show the tour unconditionally (the About drawer's replay path). */
export function showOnboarding(hooks: OnboardingHooks): void {
  if (openTour) return; // one tour at a time — replay clicks can't stack
  const root = document.createElement("div");
  root.className = "onboarding";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Welcome to Scooter.fyi");
  openTour = root;

  let index = 0;
  const last = ONBOARDING_SCREENS.length - 1;
  const restoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const untrap = trapFocusWithin(root, () => openTour === root);

  const close = (finished: boolean): void => {
    // Completed OR skipped both count as "seen" — a skipper has said no
    // once, and asking again on every load is exactly the nag this flag
    // exists to prevent.
    markOnboarded();
    untrap();
    root.removeEventListener("keydown", onKeyDown);
    root.remove();
    openTour = null;
    restoreFocus?.focus();
    if (finished) hooks.onStartExploring();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(false);
    } else if (e.key === "ArrowRight" && index < last) {
      e.preventDefault();
      index++;
      render();
    } else if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      index--;
      render();
    }
  };
  root.addEventListener("keydown", onKeyDown);

  const render = (): void => {
    const screen = ONBOARDING_SCREENS[index];
    const first = index === 0;
    const final = index === last;
    root.innerHTML = `
      <div class="onboarding__card">
        <div class="onboarding__top">
          <span class="onboarding__progress">${index + 1} / ${
            ONBOARDING_SCREENS.length
          }</span>
          <button type="button" class="onboarding__skip" data-onb="skip">Skip</button>
        </div>
        <h2 class="onboarding__headline">${screen.headline}</h2>
        <div class="onboarding__body">${screen.body}</div>
        <div class="onboarding__dots" aria-hidden="true">
          ${ONBOARDING_SCREENS.map(
            (_, i) =>
              `<span class="onboarding__dot${i === index ? " is-active" : ""}"></span>`,
          ).join("")}
        </div>
        <div class="onboarding__actions">
          ${first ? "" : `<button type="button" class="onboarding__back" data-onb="back">Back</button>`}
          <button type="button" class="onboarding__next" data-onb="${
            final ? "finish" : "next"
          }">${first ? "Get Started" : final ? "Start Exploring" : "Next"}</button>
        </div>
      </div>`;
    root.querySelector<HTMLButtonElement>(".onboarding__next")?.focus();
  };

  root.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-onb]",
    );
    if (!btn) return;
    switch (btn.dataset.onb) {
      case "skip":
        close(false);
        break;
      case "back":
        index = Math.max(0, index - 1);
        render();
        break;
      case "next":
        index = Math.min(last, index + 1);
        render();
        break;
      case "finish":
        close(true);
        break;
    }
  });

  render();
  document.body.append(root);
  root.querySelector<HTMLButtonElement>(".onboarding__next")?.focus();
}
