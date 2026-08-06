// "Install the app" nudge: a mobile-only, on-load banner suggesting the
// rider add Scooter.fyi to their Home Screen. There's no single cross-browser
// API for this — iOS Safari never fires `beforeinstallprompt`, and Chrome
// only fires it after its own engagement heuristics, so a button wired to
// that event would often silently do nothing on first visit. Instead we
// always hand the rider our own platform-appropriate steps.
import { track } from "./telemetry.ts";

const DISMISSED_KEY = "scooter-fyi-install-dismissed";
const ICON_URL = "/icon-192.png";

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* private mode — banner just reappears next load, harmless */
  }
}

/** iPadOS 13+ Safari reports a desktop Mac user agent; multi-touch is the
 *  only reliable tell left that it's actually a touch device. */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function isMobileDevice(): boolean {
  return isIOS() || /Android|IEMobile|BlackBerry|webOS/i.test(navigator.userAgent);
}

/** True once already launched from a Home Screen icon — iOS sets its own
 *  `navigator.standalone` flag; every other platform reports display-mode. */
function isStandalone(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

// Inline glyphs rather than worded descriptions ("square with an arrow") —
// same stroke-icon style as every other icon in the app (24x24, currentColor)
// so they sit in the sentence instead of reading like a foreign import.
const SHARE_GLYPH = `<span class="install-modal__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></span>`;
const MENU_GLYPH = `<span class="install-modal__glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.75" fill="currentColor"/><circle cx="12" cy="12" r="1.75" fill="currentColor"/><circle cx="12" cy="19" r="1.75" fill="currentColor"/></svg></span>`;

const IOS_STEPS = [
  `Tap the ${SHARE_GLYPH} Share button in the toolbar.`,
  "Scroll down and tap “Add to Home Screen.”",
  "Tap “Add” in the top-right corner.",
];
const ANDROID_STEPS = [
  `Tap the ${MENU_GLYPH} menu button in your browser's toolbar.`,
  "Tap “Add to Home screen” or “Install app.”",
  "Confirm by tapping “Add” or “Install.”",
];

/** Steps-only modal, opened once the rider taps Install. Mirrors the close/
 *  backdrop/Escape wiring devices.ts's openFloatingModal uses for the
 *  Battery Rankings modal, kept as its own small copy rather than importing
 *  from devices.ts (unrelated module, no shared state). */
function openInstructions(steps: string[]): void {
  document.querySelector(".install-modal")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "install-modal";
  backdrop.innerHTML = `
    <div class="install-modal__card" role="dialog" aria-modal="true" aria-labelledby="install-modal-title">
      <div class="install-modal__head">
        <img class="install-modal__icon" src="${ICON_URL}" width="36" height="36" alt="" />
        <h3 id="install-modal-title">Add to Home Screen</h3>
        <button type="button" class="install-modal__close" aria-label="Close">&times;</button>
      </div>
      <ol class="install-modal__steps">
        ${steps.map((s) => `<li>${s}</li>`).join("")}
      </ol>
    </div>`;
  const close = (): void => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector(".install-modal__close")?.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
}

/** Stack the banner directly above the bottom mode-switch pill, reading its
 *  live position rather than duplicating that pill's own responsive/
 *  orientation breakpoints here — it moves for several independent reasons
 *  (narrow-width wrap, short-landscape lift) and this tracks all of them.
 *  If the pill is currently hidden (`display: none`, e.g. mid-ride) its rect
 *  collapses to all-zero — skip the update rather than shove the banner
 *  off-screen; the CSS fallback `bottom` (or the last good value) holds. */
function repositionAboveModeSwitch(banner: HTMLElement): void {
  const modeSwitch = document.getElementById("mode-switch");
  const rect = modeSwitch?.getBoundingClientRect();
  if (!rect || rect.height === 0) return;
  const gap = 10;
  banner.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
}

function showBanner(): void {
  const steps = isIOS() ? IOS_STEPS : ANDROID_STEPS;
  const banner = document.createElement("div");
  banner.className = "install-banner";
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Install suggestion");
  banner.innerHTML = `
    <img class="install-banner__icon" src="${ICON_URL}" width="40" height="40" alt="" />
    <div class="install-banner__text">
      <strong>Install Scooter.fyi</strong>
      <span>Add to your Home Screen for quick access</span>
    </div>
    <button type="button" class="install-banner__install">Install</button>
    <button type="button" class="install-banner__close" aria-label="Dismiss">&times;</button>
  `;

  document.body.appendChild(banner);
  track("install_prompt", { step: "shown" });
  repositionAboveModeSwitch(banner);
  const onResize = (): void => repositionAboveModeSwitch(banner);
  window.addEventListener("resize", onResize);

  const close = (): void => {
    track("install_prompt", { step: "dismissed" });
    window.removeEventListener("resize", onResize);
    setDismissed();
    banner.remove();
  };
  banner
    .querySelector(".install-banner__close")
    ?.addEventListener("click", close);
  banner
    .querySelector(".install-banner__install")
    ?.addEventListener("click", () => {
      track("install_prompt", { step: "accepted" });
      window.removeEventListener("resize", onResize);
      setDismissed();
      banner.remove();
      openInstructions(steps);
    });
}

/** Chrome/Edge auto-show their own install mini-infobar based on their own
 *  engagement heuristics; left alone, a rider could get nagged twice — once
 *  by that, once by ours. `preventDefault()` suppresses only the automatic
 *  popup, not the browser's installability (its own menu entry still works,
 *  and it's what our own "no native prompt" instructions already point at).
 *  Scoped to the same mobile + non-standalone gate as our banner, and left
 *  suppressed even once dismissed — dismissing our nudge should mean no
 *  install nagging at all, not just no more of *ours*. */
function suppressNativePrompt(): void {
  if (!isMobileDevice() || isStandalone()) return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
  });
}

/** Mobile-only on-load nudge to add the app to the Home Screen. No-ops on
 *  desktop, inside an already-installed shell, or once dismissed. */
export function initInstallPrompt(): void {
  suppressNativePrompt();
  if (dismissed() || isStandalone() || !isMobileDevice()) return;
  // A beat after load so the banner doesn't compete with the map's first
  // paint — it's a suggestion, not a blocker.
  window.setTimeout(showBanner, 1500);
}
