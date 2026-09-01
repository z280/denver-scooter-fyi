// First-party, cookieless usage telemetry.
//
// Everything here answers to the promise in README.md's "On tracking"
// section: no third-party scripts, no cookies, no persistent identifier.
// Events carry a per-tab session id (sessionStorage — dies with the tab)
// and nothing else; daily-unique counting happens server-side with a
// salt that is destroyed after two days (scooter-fyi-api sql/061).
//
// The event-name allowlist below is mirrored by hand in the API's
// src/api_telemetry.py ALLOWED_EVENTS — update both together. The server
// silently drops names it doesn't know, so a version skew degrades to
// missing data, never errors.
//
// Failure posture: telemetry can NEVER break the app. Every exported
// function swallows its own errors, flushes bypass api.ts (an analytics
// failure must not surface ApiError UI or recurse into api_error), and a
// failed flush drops the batch — for aggregate data, duplicates from
// retries are worse than gaps.

// Mirrors api.ts's API_BASE rather than importing it: api.ts calls
// trackApiError, and keeping this module import-free breaks the cycle.
const API_BASE = import.meta.env.DEV ? "" : "https://data.scooter.fyi";

export const TELEMETRY_EVENTS = [
  // lifecycle
  "page_load",
  "page_hide",
  "install_prompt",
  // navigation
  "mode_switch",
  // The home bar's own funnel: opened -> destination chosen -> wheels
  // answered. Worth its own event because the drop-off between those three is
  // the whole question the redesign is a bet on.
  "home_bar",
  // The walk-to-scooter panel: manual arrival, start-nav, confirm-started,
  // open-in-veo. The split between "started nav" and "opened Veo" is the
  // measurable version of "did the handoff work".
  "arrival_panel",
  // The strip under the map: how often riders go back to what they are on,
  // and how often they end from there rather than from inside the HUD.
  "active_vehicle",
  // Dibs: claimed, dropped, certificate shown. The certificate count is the
  // interesting one — it is the only event that means the thing got shown to
  // another human.
  "dibs",
  // Which of the four dibs alerts fired. The ratio of `taken` to the
  // countdowns is the honest measure of whether dibs is worth anything.
  "dibs_alert",
  // The watched scooter went while the rider was walking to it, and why.
  "device_gone",
  "drawer_open",
  // The founder's note on the About page is collapsed by default; this is
  // the OPEN only, never the close, so the count reads as "people who chose
  // to read it" rather than "people who poked at it".
  "about_founder_open",
  // The crosshair button. Worth counting on its own: if it is tapped often,
  // the map is losing riders more than it should.
  "recenter",
  // Free-ride mode from the top bar — GPS track on, no vehicle, no
  // destination, no timer.
  "ride_mode_free",
  "account_tab",
  "theme_change",
  // features
  "control_change",
  "filter_preset",
  // My Scooters. `favorite_added` carries WHICH entry point (the panel's
  // button or the device popup's star) and whether it was already kept —
  // the ratio of those answers is what says whether the popup star is
  // pulling its weight. `favorite_removed` carries why. Never a
  // vehicle_identifier: attaching a device to a session is the one thing
  // this system is built not to do.
  "favorite_added",
  "favorite_removed",
  "favorite_notify",
  "area_filter",
  "geocode_search",
  "hex_tool",
  "cluster_tool",
  // device popup
  "popup_open",
  "popup_action",
  // ride wizard funnel
  "ride_open",
  "ride_screen",
  "ride_complete",
  "ride_abandon",
  // auth funnel
  "auth_start",
  "auth_success",
  "auth_error",
  // health
  "api_error",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];
export type TelemetryProps = Record<string, string | number | boolean>;

// Hyphenated key: the opt-out is a UI preference, not app state.
export const OPT_OUT_KEY = "scooter-fyi-telemetry";
// Dotted keys: per-tab session id and the first-visit-today stamp are
// app state (docs/PLAN_RIDE_MODE_FRONTEND.md naming convention).
const SESSION_KEY = "scooter_fyi.tsid";
const DAY_STAMP_KEY = "scooter_fyi.tday";

const ENDPOINT = "/api/v1/telemetry/events";
const FLUSH_AT = 20;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_PROP_VALUE_CHARS = 120;

// Per-event sampling, decided once per session so funnels stay coherent.
// 1 = keep everything; tune down if an event ever gets noisy.
const SAMPLE: Partial<Record<TelemetryEventName, number>> = {};

interface QueuedEvent {
  n: TelemetryEventName;
  t: number;
  sid: string;
  p?: TelemetryProps;
}

const known = new Set<string>(TELEMETRY_EVENTS);
let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sessionId = "";
let authState = false;
let initialized = false;
let eventCount = 0;

function randomId(chars: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = new Uint8Array(chars);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function sid(): string {
  if (sessionId) return sessionId;
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      sessionId = stored;
    } else {
      sessionId = randomId(12);
      sessionStorage.setItem(SESSION_KEY, sessionId);
    }
  } catch {
    sessionId = randomId(12); // storage blocked: id lives for the page
  }
  return sessionId;
}

/** True unless dev mode, the local opt-out, or GPC/DNT says no. */
export function telemetryEnabled(): boolean {
  try {
    // DEV covers `vite dev` AND vitest; tests opt back in via MODE.
    if (import.meta.env.DEV && import.meta.env.MODE !== "test") return false;
    if (localStorage.getItem(OPT_OUT_KEY) === "off") return false;
    const nav = navigator as Navigator & {
      globalPrivacyControl?: boolean;
    };
    if (nav.globalPrivacyControl === true) return false;
    if (navigator.doNotTrack === "1") return false;
    return true;
  } catch {
    return false;
  }
}

export function setTelemetryOptOut(off: boolean): void {
  try {
    if (off) localStorage.setItem(OPT_OUT_KEY, "off");
    else localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    // storage blocked — nothing to persist, telemetryEnabled() already
    // returns false in that case.
  }
}

export function telemetryOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === "off";
  } catch {
    return true;
  }
}

/** Reflected as a boolean in batch context; never an account id. */
export function setAuthState(authenticated: boolean): void {
  authState = authenticated;
}

function viewportBucket(): string {
  const w = window.innerWidth;
  if (w < 480) return "xs";
  if (w < 768) return "sm";
  if (w < 1024) return "md";
  if (w < 1440) return "lg";
  return "xl";
}

function deviceContext(): { dc: string; os: string } {
  const ua = navigator.userAgent;
  let os = "other";
  if (/iPhone|iPod/.test(ua)) os = "ios";
  else if (/iPad/.test(ua)) os = "ios";
  else if (/Android/.test(ua)) os = "android";
  else if (/Windows/.test(ua)) os = "windows";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "mac";
  else if (/Linux|X11/.test(ua)) os = "linux";
  let dc = "desktop";
  if (/iPad/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) {
    dc = "tablet";
  } else if (/Mobi|iPhone|iPod/.test(ua)) {
    dc = "mobile";
  }
  return { dc, os };
}

function referrerHost(): string {
  try {
    const ref = document.referrer;
    if (!ref) return "direct";
    const host = new URL(ref).hostname;
    if (!host || host === location.hostname) return "direct";
    return host;
  } catch {
    return "direct";
  }
}

function currentTheme(): string {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "other";
}

function cleanProps(props: TelemetryProps): TelemetryProps {
  const out: TelemetryProps = {};
  let n = 0;
  for (const [key, value] of Object.entries(props)) {
    if (n >= 12) break;
    if (typeof value === "string") {
      out[key] = value.slice(0, MAX_PROP_VALUE_CHARS);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      continue;
    }
    n += 1;
  }
  return out;
}

function sampledOut(name: TelemetryEventName): boolean {
  const rate = SAMPLE[name];
  if (rate === undefined || rate >= 1) return false;
  // Stable per (session, event): the whole session keeps or drops the
  // event uniformly, so within-session funnels never have holes.
  let hash = 0;
  const key = sid() + name;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash / 0xffffffff >= rate;
}

function batchBody(): string {
  return JSON.stringify({
    v: 1,
    page: {
      vp: viewportBucket(),
      ...deviceContext(),
      ref: referrerHost(),
      theme: currentTheme(),
      auth: authState,
    },
    events: queue,
  });
}

function flush(useBeacon: boolean): void {
  if (!queue.length) return;
  const body = batchBody();
  queue = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const url = API_BASE + ENDPOINT;
  try {
    if (useBeacon && "sendBeacon" in navigator) {
      // sendBeacon can refuse (quota/size); fall through to keepalive
      // fetch instead of dropping the batch.
      const queued = navigator.sendBeacon(
        url,
        new Blob([body], { type: "application/json" }),
      );
      if (queued) return;
    }
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // Dropped batch — deliberate. See module header.
    });
  } catch {
    // Same: never let telemetry throw into the app.
  }
}

/** Queue one event. Silently no-ops when disabled or the name is unknown. */
export function track(name: TelemetryEventName, props?: TelemetryProps): void {
  try {
    if (!telemetryEnabled()) return;
    if (!known.has(name)) return;
    if (sampledOut(name)) return;
    const event: QueuedEvent = { n: name, t: Date.now(), sid: sid() };
    if (props) event.p = cleanProps(props);
    queue.push(event);
    eventCount += 1;
    if (queue.length >= FLUSH_AT) {
      flush(false);
    } else if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush(false);
      }, FLUSH_INTERVAL_MS);
    }
  } catch {
    // Never break the caller.
  }
}

// Strip identifying path segments down to route templates so api_error
// can't leak a device id or plate into props. Matches the API's own
// route-template convention.
export function normalizePath(path: string): string {
  return path
    .split("?")[0]
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8,}$/i.test(seg)) return ":id";
      if (/^[A-Za-z0-9_-]{16,}$/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

export function trackApiError(
  path: string,
  status: number,
  errorKey?: string,
): void {
  try {
    track("api_error", {
      path: normalizePath(path),
      status,
      key: errorKey ?? "other",
    });
  } catch {
    // Never break the caller.
  }
}

function firstOfDay(): boolean {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(DAY_STAMP_KEY) === today) return false;
    localStorage.setItem(DAY_STAMP_KEY, today);
    return true;
  } catch {
    return false;
  }
}

function durationBucket(ms: number): string {
  if (ms < 10_000) return "<10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 1_800_000) return "5-30m";
  return "30m+";
}

/**
 * Wire lifecycle events and flush triggers. Called once from main.ts
 * boot. Also adopts the window "scooter:track" CustomEvent channel so
 * modules can emit without importing this file (the scooter:theme /
 * scooter:ribbon pattern).
 */
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;
  try {
    const loadedAt = Date.now();
    let hidReported = false;

    window.addEventListener("scooter:track", (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { n?: string; p?: TelemetryProps }
        | undefined;
      if (detail?.n && known.has(detail.n)) {
        track(detail.n as TelemetryEventName, detail.p);
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") {
        hidReported = false;
        return;
      }
      if (!hidReported) {
        hidReported = true;
        track("page_hide", {
          dur_bucket: durationBucket(Date.now() - loadedAt),
          events: eventCount,
        });
      }
      flush(true);
    });
    window.addEventListener("pagehide", () => flush(true));

    track("page_load", { first_of_day: firstOfDay() });
  } catch {
    // Telemetry init failure is invisible by design.
  }
}

/** Test-only: clear module state between test cases. */
export function _resetTelemetryForTests(): void {
  queue = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  sessionId = "";
  authState = false;
  initialized = false;
  eventCount = 0;
}
