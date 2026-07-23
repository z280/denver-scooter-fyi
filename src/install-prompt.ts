// "Install the app" nudge: a mobile-only, on-load banner suggesting the
// rider add Scooter.fyi to their Home Screen. There's no single cross-browser
// API for this — iOS Safari never fires `beforeinstallprompt`, and Chrome
// only fires it after its own engagement heuristics, so a button wired to
// that event would often silently do nothing on first visit. Instead we
// always hand the rider our own platform-appropriate steps.

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

const IOS_STEPS = [
  "Tap the Share button (square with an arrow) in the toolbar.",
  "Scroll down and tap “Add to Home Screen.”",
  "Tap “Add” in the top-right corner.",
];
const ANDROID_STEPS = [
  "Tap the ⋮ menu button in your browser's toolbar.",
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
 *  (narrow-width wrap, short-landscape lift) and this tracks all of them. */
function repositionAboveModeSwitch(banner: HTMLElement): void {
  const modeSwitch = document.getElementById("mode-switch");
  const gap = 10;
  const bottom = modeSwitch
    ? Math.round(window.innerHeight - modeSwitch.getBoundingClientRect().top + gap)
    : 12;
  banner.style.bottom = `${bottom}px`;
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
  repositionAboveModeSwitch(banner);
  const onResize = (): void => repositionAboveModeSwitch(banner);
  window.addEventListener("resize", onResize);

  const close = (): void => {
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
      window.removeEventListener("resize", onResize);
      setDismissed();
      banner.remove();
      openInstructions(steps);
    });
}

/** Mobile-only on-load nudge to add the app to the Home Screen. No-ops on
 *  desktop, inside an already-installed shell, or once dismissed. */
export function initInstallPrompt(): void {
  if (dismissed() || isStandalone() || !isMobileDevice()) return;
  // A beat after load so the banner doesn't compete with the map's first
  // paint — it's a suggestion, not a blocker.
  window.setTimeout(showBanner, 1500);
}
