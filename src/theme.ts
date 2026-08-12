// Light/dark theming. The theme is a `data-theme` attribute on <html> that
// all CSS tokens key off, plus a matching basemap flavor swap on the live
// map. Three inputs, in priority order:
//   1. sun-sync — follows actual sunrise/sunset in Denver (opt-in toggle)
//   2. a manual choice from the ☀/☾ controls (persisted)
//   3. the OS prefers-color-scheme
// The no-FOUC script in index.html mirrors this resolution for first paint;
// keep the storage keys and logic in the two places identical.

import type maplibregl from "maplibre-gl";
import { setBasemapFlavor, type Flavor } from "./map.ts";
import { track } from "./telemetry.ts";

export type Theme = "light" | "dark";

const THEME_KEY = "scooter-fyi-theme";
const SUN_KEY = "scooter-fyi-theme-sun";
const SUN_TIMES_KEY = "scooter-fyi-sun-times";

// Denver, CO — the app's fixed service area, so no geolocation needed.
const DENVER_LAT = 39.7392;
const DENVER_LNG = -104.9903;
const DENVER_TZ = "America/Denver";

interface SunTimes {
  /** Epoch ms, from api.sunrise-sunset.org (UTC ISO, formatted=0). */
  sunrise: number;
  sunset: number;
  /** YYYY-MM-DD in America/Denver. The cache is only valid on this date —
   *  sun times are absolute instants, so yesterday's sunset would otherwise
   *  classify all of today's daylight as "after sunset" = dark. */
  date: string;
}

/** Today's calendar date in Denver (en-CA formats as YYYY-MM-DD). Also what
 *  we pass to the API: its default "today" is resolved in UTC, which from
 *  ~6 PM Denver time onward is already tomorrow. */
function denverDateToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: DENVER_TZ });
}

// ---------- Theme resolution ----------

function storedTheme(): Theme | null {
  try {
    const s = localStorage.getItem(THEME_KEY);
    return s === "light" || s === "dark" ? s : null;
  } catch {
    return null;
  }
}

function osTheme(): Theme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function themeForTimes(times: SunTimes, now = Date.now()): Theme {
  return now >= times.sunrise && now < times.sunset ? "light" : "dark";
}

function cachedSunTimes(): SunTimes | null {
  try {
    const raw = localStorage.getItem(SUN_TIMES_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as SunTimes;
    if (t.date !== denverDateToday()) return null; // stale — never trust it
    return Number.isFinite(t.sunrise) && Number.isFinite(t.sunset) ? t : null;
  } catch {
    return null;
  }
}

export function initialTheme(): Theme {
  if (isSunSyncEnabled()) {
    const times = cachedSunTimes();
    if (times) return themeForTimes(times);
  }
  return storedTheme() ?? osTheme();
}

// ---------- Applying a theme ----------

// The single app map, bound by ThemeControl.onAdd. Basemap swaps before the
// style finishes loading would throw, so they queue in `pendingFlavor` and
// flush on the map's load event.
let boundMap: maplibregl.Map | null = null;
let mapLoaded = false;
let pendingFlavor: Flavor | null = null;

function bindMap(map: maplibregl.Map): void {
  // One map per app is the design. Fail loudly on a second bind rather than
  // silently rebinding and orphaning the first map's theme updates.
  if (boundMap && boundMap !== map) {
    throw new Error("theme.ts is already bound to a different map");
  }
  boundMap = map;
  mapLoaded = map.isStyleLoaded() === true;
  map.once("load", () => {
    mapLoaded = true;
    if (pendingFlavor) {
      setBasemapFlavor(map, pendingFlavor);
      pendingFlavor = null;
    }
  });
}

function unbindMap(map: maplibregl.Map): void {
  if (boundMap === map) {
    boundMap = null;
    mapLoaded = false;
    pendingFlavor = null;
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Set the theme everywhere: <html> attribute (drives all CSS tokens), the
 *  basemap flavor, the browser-chrome `theme-color`, and a `scooter:theme`
 *  event for UI that renders theme state (the toggle control, the ride
 *  HUD's 3D buildings). */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // The static meta reflects the OS scheme at best; the app theme can
  // diverge (manual pick, sun-sync), so keep browser chrome in step here.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0d1117" : "#ffffff");
  if (boundMap) {
    if (mapLoaded) setBasemapFlavor(boundMap, theme);
    else pendingFlavor = theme;
  }
  window.dispatchEvent(new CustomEvent<Theme>("scooter:theme", { detail: theme }));
}

/** A deliberate user pick (toggle control, ride HUD ☀/☾): persists and turns
 *  sun-sync off, since the user is overriding it. */
export function setManualTheme(theme: Theme): void {
  if (isSunSyncEnabled()) setSunSync(false, { reapply: false });
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode — theme still applies for this page load */
  }
  applyTheme(theme);
}

// ---------- Sun-sync (sunrise/sunset in Denver) ----------

let sunTimer: number | undefined;

// In-memory source of truth; storage is a best-effort persistence layer.
// If this were read back from localStorage, enabling sun-sync with storage
// unavailable (private mode) would silently no-op: the post-fetch re-check
// would see "disabled" and bail while the toggle showed active.
let sunSyncOn = ((): boolean => {
  try {
    return localStorage.getItem(SUN_KEY) === "1";
  } catch {
    return false;
  }
})();

export function isSunSyncEnabled(): boolean {
  return sunSyncOn;
}

/** Turn sun-sync on/off. Off reverts to the manual/OS theme (unless the
 *  caller is about to apply its own, e.g. a manual toggle). Emits
 *  `scooter:sunsync` so toggle UI can mirror the state. */
export function setSunSync(on: boolean, opts?: { reapply?: boolean }): void {
  sunSyncOn = on;
  try {
    if (on) localStorage.setItem(SUN_KEY, "1");
    else localStorage.removeItem(SUN_KEY);
  } catch {
    /* private mode — in-memory flag still works for this page load */
  }
  window.clearTimeout(sunTimer);
  if (on) {
    void syncToSun();
  } else if (opts?.reapply !== false) {
    applyTheme(storedTheme() ?? osTheme());
  }
  window.dispatchEvent(new CustomEvent<boolean>("scooter:sunsync", { detail: on }));
}

/** Resume sun-sync (if enabled) on app start, and re-evaluate whenever the
 *  tab becomes visible again — timers don't fire reliably in hidden tabs. */
export function startSunSync(): void {
  if (isSunSyncEnabled()) void syncToSun();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isSunSyncEnabled()) void syncToSun();
  });
}

async function fetchSunTimes(): Promise<SunTimes | null> {
  // Pin the date explicitly: the API's default "today" resolves in UTC, so
  // Denver evenings (UTC has rolled over) would get tomorrow's times.
  const date = denverDateToday();
  try {
    const res = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${DENVER_LAT}&lng=${DENVER_LNG}&formatted=0&date=${date}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status: string;
      results?: { sunrise: string; sunset: string };
    };
    if (body.status !== "OK" || !body.results) return null;
    const times: SunTimes = {
      sunrise: Date.parse(body.results.sunrise),
      sunset: Date.parse(body.results.sunset),
      date,
    };
    if (!Number.isFinite(times.sunrise) || !Number.isFinite(times.sunset)) {
      return null;
    }
    try {
      // Cached for the index.html no-FOUC script: yesterday's times are close
      // enough for a correct first paint; this fetch refreshes them daily.
      localStorage.setItem(SUN_TIMES_KEY, JSON.stringify(times));
    } catch {
      /* cache miss is fine */
    }
    return times;
  } catch {
    return null;
  }
}

async function syncToSun(): Promise<void> {
  const times = (await fetchSunTimes()) ?? cachedSunTimes();
  // Re-check after the await: the user may have toggled off mid-fetch.
  if (!isSunSyncEnabled()) return;
  if (!times) {
    // Offline/blocked with no valid cache. Keep the current theme but retry
    // in a minute — enabling sun-sync must never be a silent permanent
    // no-op behind an active-looking toggle.
    window.clearTimeout(sunTimer);
    sunTimer = window.setTimeout(() => void syncToSun(), 60_000);
    return;
  }
  applyTheme(themeForTimes(times));
  scheduleSunFlip(times);
}

function scheduleSunFlip(times: SunTimes): void {
  window.clearTimeout(sunTimer);
  const now = Date.now();
  const next = [times.sunrise, times.sunset]
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];
  // Past both boundaries (evening): the flip is tomorrow's sunrise, which we
  // don't have yet — just re-fetch in 6h. +1s margin lands past the boundary.
  const delay = next !== undefined ? next - now + 1000 : 6 * 3600_000;
  sunTimer = window.setTimeout(() => void syncToSun(), delay);
}

// ---------- The map toggle control ----------

/** The three-state theme toggle: ☀ Day → ☾ Night → ☀/☾ Auto → ☀ Day.
 *  Day/Night are manual picks (persisted, sun-sync off); Auto follows
 *  actual sunrise/sunset in Denver (the old "Sun sync" toggle, absorbed
 *  here). The icon shows the CURRENT state — CSS keys off data-mode. */
export type ThemeMode = Theme | "auto";

export class ThemeControl implements maplibregl.IControl {
  private theme: Theme;
  private map: maplibregl.Map | null = null;
  private container: HTMLDivElement | null = null;
  private btn: HTMLButtonElement | null = null;
  private readonly media = window.matchMedia("(prefers-color-scheme: dark)");

  private readonly onMedia = (e: MediaQueryListEvent): void => {
    // A stored manual choice or sun-sync overrides the OS preference.
    if (storedTheme() || isSunSyncEnabled()) return;
    applyTheme(e.matches ? "dark" : "light");
  };

  // Theme or sync state changed from anywhere (this control, sun-sync's
  // day/night flips, the ride HUD) — track and re-render, so every path
  // stays in sync through the events.
  private readonly onTheme = (e: Event): void => {
    this.theme = (e as CustomEvent<Theme>).detail;
    this.render();
  };
  private readonly onSunSync = (): void => {
    this.render();
  };

  constructor(initial: Theme) {
    this.theme = initial;
  }

  /** Auto when sun-sync drives the theme, else the live theme itself. */
  private mode(): ThemeMode {
    return isSunSyncEnabled() ? "auto" : this.theme;
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    bindMap(map);
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group theme-ctrl";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-ctrl__btn";
    btn.addEventListener("click", () => {
      // Cycle Day → Night → Auto → Day.
      const mode = this.mode();
      if (mode === "light") {
        track("theme_change", { theme: "dark" });
        setManualTheme("dark");
      } else if (mode === "dark") {
        track("theme_change", { theme: "sunsync" });
        setSunSync(true);
      } else {
        track("theme_change", { theme: "light" });
        setManualTheme("light");
      }
    });
    container.appendChild(btn);
    this.container = container;
    this.btn = btn;
    document.documentElement.dataset.theme = this.theme;
    this.media.addEventListener("change", this.onMedia);
    window.addEventListener("scooter:theme", this.onTheme);
    window.addEventListener("scooter:sunsync", this.onSunSync);
    this.render();
    return container;
  }

  onRemove(): void {
    this.media.removeEventListener("change", this.onMedia);
    window.removeEventListener("scooter:theme", this.onTheme);
    window.removeEventListener("scooter:sunsync", this.onSunSync);
    if (this.map) unbindMap(this.map);
    this.map = null;
    this.container?.remove();
    this.container = null;
    this.btn = null;
  }

  private render(): void {
    if (!this.btn) return;
    const mode = this.mode();
    this.btn.dataset.mode = mode;
    this.btn.dataset.theme = this.theme;
    const label =
      mode === "light"
        ? "Theme: Day — switch to Night"
        : mode === "dark"
          ? "Theme: Night — switch to Auto (sunrise/sunset)"
          : "Theme: Auto (sunrise/sunset) — switch to Day";
    this.btn.setAttribute("aria-label", label);
    this.btn.title = label;
    this.btn.removeAttribute("aria-pressed");
  }
}

// ---------------------------------------------------------------------------
// Theme modes, named out loud (drawer header)
// ---------------------------------------------------------------------------

/** The three modes as a labelled segmented control, mounted in the Account
 *  drawer's header.
 *
 *  IT REPLACES A CYCLING BUTTON on the map's top bar, and both halves of that
 *  are deliberate.
 *
 *  Off the top bar, because the top bar is for controls that move you around
 *  the MAP. Theme is a preference about the app; sitting there it borrowed a
 *  meaning it did not have (and, with the brushed-metal finish those controls
 *  wear, borrowed the look too).
 *
 *  Named rather than cycled, because one button showing one glyph asks the
 *  rider to remember both which mode they are in and what the next tap will
 *  do — and "Auto" is not guessable from any icon at all. Three labelled
 *  options say the whole state and every available choice at once, and cost
 *  one tap instead of up to three.
 */
export function mountThemeModes(host: HTMLElement): () => void {
  const MODES: readonly { mode: ThemeMode; label: string; glyph: string }[] = [
    { mode: "light", label: "Light", glyph: "☀️" },
    { mode: "dark", label: "Dark", glyph: "🌙" },
    // Sun-sync: the theme follows local sunrise/sunset. "Auto" is the word
    // riders expect from every other app that does this.
    { mode: "auto", label: "Auto", glyph: "🌗" },
  ];

  const current = (): ThemeMode =>
    isSunSyncEnabled() ? "auto" : currentTheme();

  const buttons = MODES.map(({ mode, label, glyph }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-modes__btn";
    btn.dataset.mode = mode;
    btn.append(
      Object.assign(document.createElement("span"), {
        className: "theme-modes__glyph",
        textContent: glyph,
        // The word beside it carries the meaning; the glyph is decoration and
        // must not be read out twice.
        ariaHidden: "true",
      }),
      Object.assign(document.createElement("span"), {
        className: "theme-modes__label",
        textContent: label,
      }),
    );
    btn.addEventListener("click", () => {
      if (current() === mode) return;
      track("theme_change", { theme: mode === "auto" ? "sunsync" : mode });
      if (mode === "auto") setSunSync(true);
      else setManualTheme(mode);
    });
    return btn;
  });

  const render = (): void => {
    const now = current();
    for (const btn of buttons) {
      const on = btn.dataset.mode === now;
      btn.classList.toggle("is-active", on);
      // A radio group, semantically: exactly one is chosen, and the others
      // are choices rather than toggles that happen to be off.
      btn.setAttribute("aria-checked", String(on));
      btn.setAttribute("role", "radio");
    }
  };

  host.setAttribute("role", "radiogroup");
  host.replaceChildren(...buttons);
  render();

  // Sun-sync flips the theme on its own at dawn and dusk, and the ride HUD
  // has its own night toggle — so this listens rather than assuming it is the
  // only writer.
  window.addEventListener("scooter:theme", render);
  window.addEventListener("scooter:sunsync", render);
  return () => {
    window.removeEventListener("scooter:theme", render);
    window.removeEventListener("scooter:sunsync", render);
    host.replaceChildren();
  };
}
