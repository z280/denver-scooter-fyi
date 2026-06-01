import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { fetchDevicesAuto, type BoundaryLayer } from "./api.ts";
import { createMap } from "./map.ts";
import {
  Devices,
  type ColorMode,
  type DeviceFilter,
} from "./devices.ts";
import { type BatteryBucket } from "./battery.ts";
import { Overlays } from "./overlays.ts";
import { renderCompliance } from "./compliance.ts";
import { Freshness } from "./freshness.ts";
import { Clusters } from "./clusters.ts";
import { AreaFilter, type AreaFilterElements } from "./area-filter.ts";
import { OVERLAYS, REFRESH_MS } from "./config.ts";
import { getAuth, isAuthenticated, signIn, signOut } from "./map-auth.js";

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const map = createMap("map");
if (import.meta.env.DEV) (window as unknown as { __map: unknown }).__map = map;
const devices = new Devices(map);
const overlays = new Overlays(map, need("choropleth-legend"));
const freshness = new Freshness(need("freshness"), need("freshness-text"));
const clusters = new Clusters(
  map,
  need("cluster-list"),
  need<HTMLInputElement>("cluster-min"),
  need<HTMLButtonElement>("cluster-find"),
  need<HTMLSelectElement>("cluster-region-layer"),
  overlays,
);

// Populated by buildLayerToggles so AreaFilter can programmatically check
// the matching overlay box when the user picks a category.
const layerInputs = new Map<BoundaryLayer, HTMLInputElement>();

// Kick off network-independent work immediately so dots/compliance arrive fast.
const devicesPromise = fetchDevicesAuto().catch((e) => {
  console.error("initial device fetch failed", e);
  return null;
});
void renderCompliance(need("compliance"));
wireSecretUnlock();
wireAccount();

map.on("load", async () => {
  devices.addLayers();
  buildLayerToggles();
  wireDeviceFilter();
  wireHideUnavailable();
  wireBatteryFilter();
  wireRangeFloor();
  wireColorBy();
  wireChoropleth();
  wireNeighborhoodSearch();
  wireDrawers();
  wireAreaFilter();

  const resp = await devicesPromise;
  if (resp) {
    devices.setData(resp);
    clusters.update(devices.visibleFeatures());
    freshness.update(resp.metadata.snapshot_time, resp.metadata.device_count);
  } else {
    freshness.error();
  }
  startRefreshLoop();
});

// ---------- Controls ----------

function buildLayerToggles(): void {
  const list = need("layer-list");
  for (const def of OVERLAYS) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "layer-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = def.layer;
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await overlays.toggle(def.layer, input.checked);
      } catch (e) {
        console.error(`overlay ${def.layer} failed`, e);
        input.checked = false;
      } finally {
        input.disabled = false;
      }
    });

    const swatch = document.createElement("span");
    swatch.className = "layer-item__swatch";
    swatch.style.background = def.color;
    swatch.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "layer-item__label";
    text.textContent = def.label;

    label.append(input, swatch, text);
    li.append(label);
    list.append(li);
    layerInputs.set(def.layer, input);
  }
}

/** Programmatically enable an overlay (used when the area filter activates). */
function setOverlayChecked(layer: BoundaryLayer, checked: boolean): void {
  const cb = layerInputs.get(layer);
  if (!cb || cb.checked === checked) return;
  cb.checked = checked;
  cb.dispatchEvent(new Event("change"));
}

function wireDeviceFilter(): void {
  // Scope to the device-filter segmented widget so other .seg-btn groups
  // (e.g. the Color-by toggle in Tools) aren't swept up by the global
  // selector this used to use.
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      "#device-filter-seg .seg-btn",
    ),
  );
  const select = (btn: HTMLButtonElement) => {
    for (const b of btns) {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    devices.setFilter(btn.dataset.filter as DeviceFilter);
    clusters.update(devices.visibleFeatures());
  };
  btns.forEach((btn, i) => {
    btn.addEventListener("click", () => select(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = btns[(i + 1) % btns.length];
        next.focus();
        select(next);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = btns[(i - 1 + btns.length) % btns.length];
        prev.focus();
        select(prev);
      }
    });
  });
}

function wireHideUnavailable(): void {
  const cb = need<HTMLInputElement>("hide-unavailable");
  cb.addEventListener("change", () => {
    devices.setHideUnavailable(cb.checked);
    clusters.update(devices.visibleFeatures());
  });
}

function wireBatteryFilter(): void {
  const root = need("battery-filter");
  const hint = need("battery-filter-hint");
  const btns = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".batt-btn"),
  );
  const selected = new Set<BatteryBucket>();

  const push = (): void => {
    devices.setBatteryFilter(selected.size > 0 ? new Set(selected) : null);
    clusters.update(devices.visibleFeatures());
  };

  for (const btn of btns) {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const b = Number(btn.dataset.bucket) as BatteryBucket;
      if (selected.has(b)) {
        selected.delete(b);
        btn.setAttribute("aria-pressed", "false");
        btn.classList.remove("is-active");
      } else {
        selected.add(b);
        btn.setAttribute("aria-pressed", "true");
        btn.classList.add("is-active");
      }
      push();
    });
  }

  // Disable the whole widget until the fleet returns enough unique range
  // values to make four buckets. Re-render whenever thresholds change.
  devices.onThresholdsChange((t) => {
    const enabled = t !== null;
    for (const btn of btns) btn.disabled = !enabled;
    hint.hidden = enabled;
    if (!enabled && selected.size > 0) {
      // Drop any latent selection so the user isn't left with a hidden,
      // active filter when data arrives sparse.
      selected.clear();
      for (const btn of btns) {
        btn.setAttribute("aria-pressed", "false");
        btn.classList.remove("is-active");
      }
      push();
    }
  });
}

// Authenticated-only switch that hides any device with current_range_meters
// below 40 km. Reveals itself if the user is already signed in; otherwise
// stays tucked away so unauthed visitors don't see a control they can't trust.
function wireRangeFloor(): void {
  const FLOOR_METERS = 40_000;
  const section = document.getElementById("range-floor-section");
  const cb = document.getElementById("range-floor-enable") as
    | HTMLInputElement
    | null;
  if (!section || !cb) return;

  if (isAuthenticated()) section.hidden = false;

  cb.addEventListener("change", () => {
    devices.setMinRangeMeters(cb.checked ? FLOOR_METERS : null);
    clusters.update(devices.visibleFeatures());
  });

  // Auth state can change mid-tab (sign-in callback lands on the same page,
  // sign-out reloads). Re-evaluate on focus so the section appears without
  // a manual refresh, and stand down the filter on sign-out.
  window.addEventListener("focus", () => {
    const authed = isAuthenticated();
    section.hidden = !authed;
    if (!authed && cb.checked) {
      cb.checked = false;
      devices.setMinRangeMeters(null);
      clusters.update(devices.visibleFeatures());
    }
  });
}

function wireColorBy(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#color-by-seg .seg-btn"),
  );
  const select = (btn: HTMLButtonElement) => {
    for (const b of btns) {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    devices.setColorMode((btn.dataset.color as ColorMode) || "type");
  };
  btns.forEach((btn, i) => {
    btn.addEventListener("click", () => select(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = btns[(i + 1) % btns.length];
        next.focus();
        select(next);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = btns[(i - 1 + btns.length) % btns.length];
        prev.focus();
        select(prev);
      }
    });
  });
}

function wireChoropleth(): void {
  const select = need<HTMLSelectElement>("choropleth-select");
  select.addEventListener("change", async () => {
    const layer = (select.value || null) as BoundaryLayer | null;
    select.disabled = true;
    try {
      await overlays.setChoropleth(layer);
    } catch (e) {
      console.error("choropleth failed", e);
      select.value = "";
      await overlays.setChoropleth(null);
    } finally {
      select.disabled = false;
    }
  });
}

function wireNeighborhoodSearch(): void {
  const input = need<HTMLInputElement>("neighborhood-search");
  const datalist = need<HTMLDataListElement>("neighborhood-options");
  const clearBtn = need<HTMLButtonElement>("neighborhood-clear");
  const labelToValue = new Map<string, string>();
  let populated = false;

  const populate = async () => {
    if (populated) return;
    populated = true;
    try {
      const list = await overlays.neighborhoodList();
      const frag = document.createDocumentFragment();
      for (const { value, label } of list) {
        labelToValue.set(label.toLowerCase(), value);
        const opt = document.createElement("option");
        opt.value = label;
        frag.append(opt);
      }
      datalist.replaceChildren(frag);
    } catch (e) {
      console.error("neighborhood list failed", e);
      populated = false;
    }
  };

  input.addEventListener("focus", populate, { once: true });
  input.addEventListener("change", async () => {
    await populate();
    const value = labelToValue.get(input.value.trim().toLowerCase());
    if (!value) return;
    await overlays.highlightNeighborhood(value);
    clearBtn.hidden = false;
  });

  clearBtn.addEventListener("click", async () => {
    input.value = "";
    clearBtn.hidden = true;
    await overlays.highlightNeighborhood(null);
    input.focus();
  });
}

function wireAreaFilter(): void {
  const elements: AreaFilterElements = {
    enable: need<HTMLInputElement>("area-filter-enable"),
    body: need("area-filter-body"),
    category: need<HTMLSelectElement>("area-filter-category"),
    multi: need("area-filter-multi"),
    search: need<HTMLInputElement>("area-filter-search"),
    options: need("area-filter-options"),
    status: need("area-filter-status"),
    clear: need<HTMLButtonElement>("area-filter-clear"),
  };
  // The overlay layer the area filter currently "owns" — when it changes (or
  // becomes null), we release the prior layer: clear its subset filter and
  // turn its checkbox off, so manually re-enabling it shows all polygons.
  let managed: BoundaryLayer | null = null;

  new AreaFilter(overlays, elements, (state) => {
    devices.setAreaFilter(state.polygons);

    const nextLayer = state.display?.layer ?? null;
    if (managed && managed !== nextLayer) {
      void overlays.setSubset(managed, null);
      setOverlayChecked(managed, false);
    }
    if (state.display) {
      void overlays.setSubset(state.display.layer, state.display.subset);
      setOverlayChecked(state.display.layer, true);
    }
    managed = nextLayer;

    clusters.update(devices.visibleFeatures());
  });
}

function wireDrawers(): void {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".drawer-tab"),
  );
  const drawers = new Map<string, HTMLElement>();
  for (const tab of tabs) {
    const id = tab.dataset.drawer;
    if (!id) continue;
    const drawer = document.getElementById(`drawer-${id}`);
    if (drawer) drawers.set(id, drawer);
  }

  let active: string | null = null;

  const setActive = (id: string | null): void => {
    active = id;
    for (const tab of tabs) {
      const isActive = tab.dataset.drawer === id;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-pressed", String(isActive));
    }
    for (const [drawerId, drawer] of drawers) {
      const open = drawerId === id;
      drawer.classList.toggle("is-open", open);
      drawer.setAttribute("aria-hidden", String(!open));
    }
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const id = tab.dataset.drawer ?? null;
      setActive(active === id ? null : id);
    });
  }

  for (const drawer of drawers.values()) {
    const closeBtn = drawer.querySelector<HTMLButtonElement>(".drawer-close");
    closeBtn?.addEventListener("click", () => {
      const id = drawer.id.replace(/^drawer-/, "");
      setActive(null);
      // Return focus to the tab so keyboard users don't lose their place.
      const tab = tabs.find((t) => t.dataset.drawer === id);
      tab?.focus();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && active) {
      const lastActive = active;
      setActive(null);
      const tab = tabs.find((t) => t.dataset.drawer === lastActive);
      tab?.focus();
    }
  });
}

// ---------- Secret unlock ----------

// Reveal the Account drawer tab via a deliberately fiddly but mobile-friendly
// gesture on the freshness pill: tap 10 times in quick succession, or hold
// for 10s straight. No on-screen feedback — the reveal itself is the signal.
function wireSecretUnlock(): void {
  const target = document.getElementById("freshness");
  const tab = document.querySelector<HTMLButtonElement>(
    '.drawer-tab[data-drawer="person"]',
  );
  if (!target || !tab) return;

  const TAP_TARGET = 10;
  const TAP_RESET_MS = 2000;
  const HOLD_MS = 10_000;

  let taps = 0;
  let resetTimer: number | undefined;
  let holdTimer: number | undefined;
  let pressActive = false;

  const unlock = (): void => {
    taps = 0;
    window.clearTimeout(resetTimer);
    window.clearTimeout(holdTimer);
    revealAccountTab();
    tab.focus();
  };

  const endPress = (): void => {
    pressActive = false;
    window.clearTimeout(holdTimer);
  };

  target.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pressActive = true;
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      if (pressActive) unlock();
    }, HOLD_MS);
  });

  target.addEventListener("pointerup", (e) => {
    if (!pressActive) return;
    endPress();
    taps += 1;
    window.clearTimeout(resetTimer);
    if (taps >= TAP_TARGET) {
      unlock();
    } else {
      resetTimer = window.setTimeout(() => {
        taps = 0;
      }, TAP_RESET_MS);
    }
    e.preventDefault();
  });

  target.addEventListener("pointercancel", endPress);
  target.addEventListener("pointerleave", endPress);
}

/** Make the Account tab visible. Called either on SOS unlock or, for users
 *  who are already signed in (e.g. after the auth-callback redirect lands
 *  back here on next page load), at startup so they keep access to the
 *  drawer without re-doing the secret gesture. */
function revealAccountTab(): void {
  const tab = document.querySelector<HTMLButtonElement>(
    '.drawer-tab[data-drawer="person"]',
  );
  if (!tab) return;
  tab.classList.remove("is-hidden");
  tab.removeAttribute("hidden");
}

// ---------- Account drawer ----------

// Renders the Account drawer body based on map-auth state and keeps the
// expiry countdown live. Also wires sign-in / sign-out handlers.
function wireAccount(): void {
  const body = document.getElementById("account-body");
  if (!body) return;

  // If the user is already signed in (most common after the auth-callback
  // redirect lands them back on "/" with a fresh sessionStorage blob), the
  // hidden tab gate would otherwise lock them out of their own controls.
  if (isAuthenticated()) revealAccountTab();

  let countdownTimer: number | undefined;

  const formatRemaining = (expiresIso: string): string => {
    const ms = new Date(expiresIso).getTime() - Date.now();
    if (ms <= 0) return "expired";
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const render = (): void => {
    window.clearTimeout(countdownTimer);
    body.replaceChildren();
    const auth = getAuth();
    if (auth) {
      const status = el("div", "account-status");
      const row = el("div", "account-status__row");
      row.append(
        el("span", "account-status__dot"),
        el("strong", undefined, "Signed in"),
      );
      const expiryP = el("p", "account-status__expiry");
      expiryP.append(
        document.createTextNode("Session expires in "),
        el("span", undefined, formatRemaining(auth.expires)),
      );
      status.append(row, expiryP);
      const signoutBtn = el(
        "button",
        "login-btn login-btn--secondary",
        "Sign out",
      );
      signoutBtn.type = "button";
      signoutBtn.addEventListener("click", async () => {
        signoutBtn.disabled = true;
        signoutBtn.textContent = "Signing out…";
        try {
          await signOut();
        } finally {
          // Reload so all data refetches drop back to the public endpoint
          // and the UI resets cleanly to the unauthenticated state.
          location.reload();
        }
      });
      body.append(status, signoutBtn);
      // Re-render once a minute to keep the countdown current.
      countdownTimer = window.setTimeout(render, 60_000);
    } else {
      const intro = el("p", "account-intro");
      intro.append(
        document.createTextNode("Sign in with your "),
        el("strong", undefined, "scooter-club"),
        document.createTextNode(
          " GitHub account to unlock per-scooter plate numbers, dwell time, and start-attempt history.",
        ),
      );
      const signinBtn = el("button", "login-btn", "Sign in with GitHub");
      signinBtn.type = "button";
      signinBtn.addEventListener("click", () => {
        // Come back to wherever we were after the GitHub round-trip.
        signIn(location.pathname + location.search);
      });
      body.append(intro, signinBtn);
    }
  };

  render();

  // If the session expires mid-tab (or apiFetch cleared it after a 401),
  // the visible state will drift. Re-check on focus so the UI catches up.
  window.addEventListener("focus", render);
}

// ---------- Refresh loop ----------

function startRefreshLoop(): void {
  let inFlight: AbortController | null = null;

  const tick = async () => {
    if (document.hidden) return;
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const resp = await fetchDevicesAuto(inFlight.signal);
      devices.setData(resp);
      clusters.update(devices.visibleFeatures());
      freshness.update(resp.metadata.snapshot_time, resp.metadata.device_count);
      void overlays.refreshChoropleth();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("refresh failed", e);
        freshness.error();
      }
    }
  };

  setInterval(tick, REFRESH_MS);
  // Refresh immediately when the tab becomes visible again after being hidden.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void tick();
  });
}
