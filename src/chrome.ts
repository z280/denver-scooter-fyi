// App chrome: the fixed top bar, the collapsible left ribbon, and popup
// cleanup on mode switches. The ribbon is the existing #drawer-tabs strip —
// this module only gives it an open/closed state (body.ribbon-open) driven
// by the top bar's hamburger; wireDrawers() in main.ts keeps owning the
// tabs themselves (including the top bar's profile button, which drives
// the right-side account drawer).

import { markSvg } from "./mark.ts";

const RIBBON_KEY = "scooter-fyi-ribbon";

/** Swap the top bar's placeholder glyph for the real mark.
 *
 *  The 🛴 in the markup is a pre-hydration fallback so the bar never renders
 *  empty; this replaces it once the module loads. Only the BRAND uses of that
 *  emoji change — the ones that mean "a standing scooter" (the ride-type
 *  filter, the No Standing preset, the device tiers) are about a vehicle
 *  class, not about us, and swapping those would say the wrong thing. */
export function installBrandMark(): void {
  const slot = document.querySelector(".topbar__brand-glyph");
  if (!slot) return;
  slot.replaceChildren(markSvg("topbar__brand-mark"));
}

/** Everything that can be left open over the map. Registered by the owners
 *  (devices/clusters) so mode switches can sweep all of it at once. */
type PopupCloser = () => void;
const popupClosers: PopupCloser[] = [];

export function registerPopupCloser(fn: PopupCloser): void {
  popupClosers.push(fn);
}

/** Close every open floating surface: device + cluster popups and the
 *  hover tooltip (registered closers), plus the details modal and the icon
 *  lightbox. Called on every mode switch so no popup outlives the surface
 *  it was opened from. The modals close via their own ✕ so their close()
 *  runs and detaches the document-level Escape listener — a bare .remove()
 *  would orphan it. */
export function closeAllPopups(): void {
  for (const close of popupClosers) close();
  document
    .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")
    ?.click();
  document
    .querySelector<HTMLButtonElement>(".icon-lightbox .icon-lightbox__close")
    ?.click();
}

function storedRibbon(): boolean | null {
  try {
    const v = localStorage.getItem(RIBBON_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function persistRibbon(open: boolean): void {
  try {
    localStorage.setItem(RIBBON_KEY, open ? "1" : "0");
  } catch {
    /* private mode — the state still applies for this page load */
  }
}

let hamburger: HTMLButtonElement | null = null;

/** Screens where the ribbon and an open surface fight over the same pixels.
 *  The same 640px breakpoint the ribbon's own default uses: above it the
 *  strip and a drawer sit side by side and nothing has to give way. */
function tightScreen(): boolean {
  // No matchMedia (an older embedded webview, a test that stubbed it away)
  // reads as a wide screen on purpose: the failure mode of a wrong `true`
  // is a menu that vanishes for no visible reason.
  return window.matchMedia?.("(max-width: 640px)").matches === true;
}

function applyRibbon(open: boolean, opts?: { keepDrawer?: boolean }): void {
  document.body.classList.toggle("ribbon-open", open);
  hamburger?.setAttribute("aria-expanded", String(open));
  // Anyone anchored to the ribbon (the icon legend) re-measures on this.
  window.dispatchEvent(new CustomEvent<boolean>("scooter:ribbon", { detail: open }));
  if (!open && !opts?.keepDrawer) {
    // A drawer without its tab strip has no visible origin — close it.
    // Left-ribbon drawers only: the right (profile) drawer hangs off the
    // top bar's own button and survives a ribbon collapse.
    //
    // `keepDrawer` is the yield below: there the strip is standing aside FOR
    // an open drawer, so closing that drawer is exactly backwards.
    const active = document.querySelector<HTMLButtonElement>(
      "#drawer-tabs .drawer-tab.is-active",
    );
    active?.click();
  }
  if (open && tightScreen()) {
    // The other direction. On a phone the profile drawer is full height and
    // the ribbon slides out underneath it, so the strip appearing has to
    // dismiss it — the rider asked for the menu, and two full-height
    // surfaces over one screen leaves neither usable.
    document
      .querySelector<HTMLButtonElement>(".drawer-tab--topbar.is-active")
      ?.click();
  }
}

/** True while the ribbon is collapsed because a surface wanted the room,
 *  rather than because the rider collapsed it. Only the first case is
 *  restored: someone who tucked the strip away themselves should not find
 *  it back when a popup closes. */
let yielded = false;

/** Stand the ribbon aside for a drawer or popup that needs the screen.
 *
 *  A no-op on a wide screen (nothing is in anyone's way) and when the strip
 *  is already closed (the phone default), which is also why this does not
 *  persist: yielding is not a preference, and restoring it has to put back
 *  exactly the state we took away. */
export function yieldRibbonToDrawer(): void {
  if (!tightScreen() || !isRibbonOpen()) return;
  yielded = true;
  applyRibbon(false, { keepDrawer: true });
}

/** Give the ribbon back, if we were the ones who took it. */
export function restoreRibbonAfterDrawer(): void {
  if (!yielded) return;
  yielded = false;
  if (!isRibbonOpen()) applyRibbon(true);
}

/** Programmatic ribbon control — setDrawer() opens the ribbon before it
 *  synthesizes tab clicks, so a drawer never opens out of a hidden strip.
 *  Programmatic opens do NOT persist: only the hamburger records a
 *  preference, otherwise one tap of Analysis (which auto-opens the ribbon
 *  for its drawer) would permanently override the mobile closed default. */
export function setRibbonOpen(
  open: boolean,
  opts?: { persist?: boolean },
): void {
  if (document.body.classList.contains("ribbon-open") === open) return;
  // A deliberate open or close settles the question: whatever we had
  // borrowed is no longer ours to give back.
  yielded = false;
  applyRibbon(open);
  if (opts?.persist) persistRibbon(open);
}

export function isRibbonOpen(): boolean {
  return document.body.classList.contains("ribbon-open");
}

/** Wire the top bar. Call once, after createMap() has run (the GPS/theme
 *  cluster is adopted out of the map's control container). */
export function initChrome(): void {
  hamburger = document.getElementById("ribbon-toggle") as HTMLButtonElement | null;

  // The GPS + theme MapLibre controls register in the map's top-left corner
  // container. #map is a fixed-position element — a stacking context — so
  // CSS alone can never paint that corner above the top bar. Adopting the
  // corner *container* into the bar keeps MapLibre's addControl/removeControl
  // bookkeeping intact (the node is moved, never replaced; the controls
  // stay its children).
  const corner = document.querySelector<HTMLElement>(".maplibregl-ctrl-top-left");
  const leftCluster = document.querySelector<HTMLElement>(".topbar__left");
  if (corner && leftCluster) leftCluster.append(corner);

  // Default: open on desktop, closed on phones; a stored choice wins.
  const open = storedRibbon() ?? !window.matchMedia("(max-width: 640px)").matches;
  applyRibbon(open);

  hamburger?.addEventListener("click", () => {
    setRibbonOpen(!isRibbonOpen(), { persist: true });
  });
}
