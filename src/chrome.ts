// App chrome: the fixed top bar, the collapsible left ribbon, and popup
// cleanup on mode switches. The ribbon is the existing #drawer-tabs strip —
// this module only gives it an open/closed state (body.ribbon-open) driven
// by the top bar's hamburger; wireDrawers() in main.ts keeps owning the
// tabs themselves (including the top bar's profile button, which drives
// the right-side account drawer).

const RIBBON_KEY = "scooter-fyi-ribbon";

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

function applyRibbon(open: boolean): void {
  document.body.classList.toggle("ribbon-open", open);
  hamburger?.setAttribute("aria-expanded", String(open));
  // Anyone anchored to the ribbon (the icon legend) re-measures on this.
  window.dispatchEvent(new CustomEvent<boolean>("scooter:ribbon", { detail: open }));
  if (!open) {
    // A drawer without its tab strip has no visible origin — close it.
    // Left-ribbon drawers only: the right (profile) drawer hangs off the
    // top bar's own button and survives a ribbon collapse.
    const active = document.querySelector<HTMLButtonElement>(
      "#drawer-tabs .drawer-tab.is-active",
    );
    active?.click();
  }
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
