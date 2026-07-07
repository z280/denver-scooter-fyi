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

export type Theme = "light" | "dark";

const THEME_KEY = "scooter-fyi-theme";
const SUN_KEY = "scooter-fyi-theme-sun";
const SUN_TIMES_KEY = "scooter-fyi-sun-times";

// Denver, CO — the app's fixed service area, so no geolocation needed.
const DENVER_LAT = 39.7392;
const DENVER_LNG = -104.9903;

interface SunTimes {
  /** Epoch ms, from api.sunrise-sunset.org (UTC ISO, formatted=0). */
  sunrise: number;
  sunset: number;
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

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Set the theme everywhere: <html> attribute (drives all CSS tokens), the
 *  basemap flavor, and a `scooter:theme` event for UI that renders theme
 *  state (the toggle control, the ride HUD's 3D buildings). */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
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

export function isSunSyncEnabled(): boolean {
  try {
    return localStorage.getItem(SUN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Turn sun-sync on/off. Off reverts to the manual/OS theme (unless the
 *  caller is about to apply its own, e.g. a manual toggle). Emits
 *  `scooter:sunsync` so toggle UI can mirror the state. */
export function setSunSync(on: boolean, opts?: { reapply?: boolean }): void {
  try {
    if (on) localStorage.setItem(SUN_KEY, "1");
    else localStorage.removeItem(SUN_KEY);
  } catch {
    /* private mode — works for this page load only */
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
  try {
    const res = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${DENVER_LAT}&lng=${DENVER_LNG}&formatted=0`,
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
  if (!times || !isSunSyncEnabled()) return;
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

/** Sun/moon button in the map's control stack. Shows the CURRENT mode
 *  (sun in light, moon in dark — CSS swaps the icon off data-theme);
 *  clicking makes a manual pick for the other theme. */
export class ThemeControl implements maplibregl.IControl {
  private theme: Theme;
  private container: HTMLDivElement | null = null;
  private btn: HTMLButtonElement | null = null;
  private readonly media = window.matchMedia("(prefers-color-scheme: dark)");

  private readonly onMedia = (e: MediaQueryListEvent): void => {
    // A stored manual choice or sun-sync overrides the OS preference.
    if (storedTheme() || isSunSyncEnabled()) return;
    applyTheme(e.matches ? "dark" : "light");
  };

  // Theme changed from anywhere (this control, sun-sync, ride HUD) — track
  // and re-render, so every path stays in sync through one event.
  private readonly onTheme = (e: Event): void => {
    this.theme = (e as CustomEvent<Theme>).detail;
    this.render();
  };

  constructor(initial: Theme) {
    this.theme = initial;
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    bindMap(map);
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group theme-ctrl";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-ctrl__btn";
    btn.addEventListener("click", () => {
      setManualTheme(this.theme === "dark" ? "light" : "dark");
    });
    container.appendChild(btn);
    this.container = container;
    this.btn = btn;
    document.documentElement.dataset.theme = this.theme;
    this.media.addEventListener("change", this.onMedia);
    window.addEventListener("scooter:theme", this.onTheme);
    this.render();
    return container;
  }

  onRemove(): void {
    this.media.removeEventListener("change", this.onMedia);
    window.removeEventListener("scooter:theme", this.onTheme);
    this.container?.remove();
    this.container = null;
    this.btn = null;
  }

  private render(): void {
    if (!this.btn) return;
    this.btn.dataset.theme = this.theme;
    const dark = this.theme === "dark";
    const label = dark ? "Switch to light theme" : "Switch to dark theme";
    this.btn.setAttribute("aria-pressed", String(dark));
    this.btn.setAttribute("aria-label", label);
    this.btn.title = label;
  }
}
