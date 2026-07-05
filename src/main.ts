import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { fetchDevicesAuto, type BoundaryLayer } from "./api.ts";
import { createMap } from "./map.ts";
import {
  Devices,
  DEVICE_INTERACTIVE_LAYERS,
  type DeviceFilter,
} from "./devices.ts";
import { type BatteryBucket } from "./battery.ts";
import { Overlays } from "./overlays.ts";
import { renderCompliance } from "./compliance.ts";
import { Freshness } from "./freshness.ts";
import { Clusters } from "./clusters.ts";
import {
  AreaFilter,
  type AreaFilterElements,
  type AreaFilterState,
} from "./area-filter.ts";
import { FilterChips, type Chip } from "./filter-chips.ts";
import { Locate } from "./locate.ts";
import { OVERLAY_BY_LAYER, OVERLAYS, REFRESH_MS } from "./config.ts";
import { getAuth, isAuthenticated, signIn, signOut } from "./map-auth.js";

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const { map, geolocate } = createMap("map");
if (import.meta.env.DEV) (window as unknown as { __map: unknown }).__map = map;
const locate = new Locate(map, geolocate);
const devices = new Devices(map, locate);
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

// ---------- Active-filter chips ----------
// One chip per live constraint, floating over the map so closed drawers
// never hide state. The wire* functions below stash just enough of their
// internal state here for refreshChips() to read, and each chip's ✕
// resets the originating control through its normal event path so the
// drawer UI stays in sync.
const chips = new FilterChips(need("filter-chips"));
let currentDeviceFilter: DeviceFilter = "all";
let batterySelection: ReadonlySet<BatteryBucket> = new Set();
let clearBatterySelection: () => void = () => {};
let lastAreaState: AreaFilterState | null = null;

const DEVICE_CHIP_LABEL: Partial<Record<DeviceFilter, string>> = {
  scooter: "🛴 Scooters only",
  bicycle: "🚲 E-bikes only",
};

const BUCKET_CHIP_LABEL: Record<BatteryBucket, string> = {
  0: "bottom 25%",
  1: "25–50%",
  2: "50–75%",
  3: "top 25%",
};

function refreshChips(): void {
  const active: Chip[] = [];

  const deviceLabel = DEVICE_CHIP_LABEL[currentDeviceFilter];
  if (deviceLabel) {
    active.push({
      id: "device-type",
      label: deviceLabel,
      onClear: () => {
        document
          .querySelector<HTMLButtonElement>(
            '#device-filter-seg .seg-btn[data-filter="all"]',
          )
          ?.click();
      },
    });
  }

  const hideCb = need<HTMLInputElement>("hide-unavailable");
  if (hideCb.checked) {
    active.push({
      id: "availability",
      label: "Hiding unavailable",
      onClear: () => {
        hideCb.checked = false;
        hideCb.dispatchEvent(new Event("change"));
      },
    });
  }

  if (batterySelection.size > 0) {
    const parts = [...batterySelection]
      .sort((a, b) => a - b)
      .map((b) => BUCKET_CHIP_LABEL[b]);
    active.push({
      id: "battery",
      label: `⚡ Range: ${parts.join(", ")}`,
      onClear: clearBatterySelection,
    });
  }

  const display = lastAreaState?.display;
  if (lastAreaState?.polygons && display) {
    const layerLabel = OVERLAY_BY_LAYER[display.layer].label;
    active.push({
      id: "area",
      label: display.subset
        ? `📍 ${display.subset.length} × ${layerLabel}`
        : `📍 ${layerLabel}`,
      onClear: () => {
        const enable = need<HTMLInputElement>("area-filter-enable");
        enable.checked = false;
        enable.dispatchEvent(new Event("change"));
      },
    });
  }

  chips.render(active);
}

// Kick off network-independent work immediately so dots/compliance arrive fast.
const devicesPromise = fetchDevicesAuto().catch((e) => {
  console.error("initial device fetch failed", e);
  return null;
});
void renderCompliance(need("compliance")).catch((e) => {
  console.error("compliance render failed", e);
});
wireSecretUnlock();
wireAccount();

map.on("load", async () => {
  devices.addLayers();
  buildLayerToggles();
  wireDeviceFilter();
  wireHideUnavailable();
  wireBatteryFilter();
  wireColorBy();
  wireChoropleth();
  wireDrawers();
  const areaFilter = wireAreaFilter();
  wireModes();

  // Direct manipulation: clicking a visible region polygon toggles it in
  // the area filter (clicks on device dots/clusters keep their popups).
  overlays.enableRegionClicks((layer, regionName) => {
    void areaFilter.toggleRegionFromMap(layer, regionName);
  }, DEVICE_INTERACTIVE_LAYERS);

  // Keep the freshness pill's "Displaying x out of y" in sync with every
  // filter change. The first fire happens right after a setData() too.
  devices.onCountsChange((visible, total) => {
    freshness.setCounts(visible, total);
  });

  const resp = await devicesPromise;
  if (resp) {
    devices.setData(resp);
    const visible = devices.visibleFeatures();
    clusters.update(visible);
    freshness.update(
      resp.metadata.snapshot_time,
      visible.length,
      resp.metadata.device_count,
    );
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
    currentDeviceFilter = btn.dataset.filter as DeviceFilter;
    devices.setFilter(currentDeviceFilter);
    clusters.update(devices.visibleFeatures());
    refreshChips();
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
    refreshChips();
  });
}

function wireBatteryFilter(): void {
  const root = need("battery-filter");
  const hint = need("battery-filter-hint");
  const btns = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".batt-btn"),
  );
  const selected = new Set<BatteryBucket>();
  batterySelection = selected;

  const push = (): void => {
    devices.setBatteryFilter(selected.size > 0 ? new Set(selected) : null);
    clusters.update(devices.visibleFeatures());
    refreshChips();
  };

  const deselectAll = (): void => {
    selected.clear();
    for (const btn of btns) {
      btn.setAttribute("aria-pressed", "false");
      btn.classList.remove("is-active");
    }
    push();
  };
  clearBatterySelection = deselectAll;

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
        // Filtering by battery auto-enables range coloring so the map gives
        // immediate visual feedback. One-way convenience only: deselecting
        // buckets (or clearing the filter) never turns coloring back off.
        const colorCb = need<HTMLInputElement>("color-by-range");
        if (!colorCb.checked) {
          colorCb.checked = true;
          colorCb.dispatchEvent(new Event("change"));
        }
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
      deselectAll();
    }
  });
}

function wireColorBy(): void {
  // Two coloring toggles, radio-like: range and reliability are different
  // lenses on the same dots, so turning one on turns the other off.
  const range = need<HTMLInputElement>("color-by-range");
  const rel = need<HTMLInputElement>("color-by-reliability");
  const sync = () => {
    devices.setColorMode(
      rel.checked ? "reliability" : range.checked ? "range" : "type",
    );
  };
  range.addEventListener("change", () => {
    if (range.checked) rel.checked = false;
    sync();
  });
  rel.addEventListener("change", () => {
    if (rel.checked) range.checked = false;
    sync();
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

function wireAreaFilter(): AreaFilter {
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

  return new AreaFilter(overlays, elements, (state) => {
    devices.setAreaFilter(state.polygons);
    lastAreaState = state;

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
    refreshChips();
  });
}

// ---------- Intent modes ----------

// One-tap presets over the existing controls — not separate apps. "Find a
// ride" sets the rider up (available devices, reliability coloring, offer
// location); "Audit" sets the civic view (v1 choropleth + compliance).
// Any manual control change afterwards clears the highlight: the user is
// in "custom" now, and the presets never fight them for state.
function wireModes(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#mode-switch .mode-btn"),
  );
  let applying = false;

  const setActive = (mode: string | null): void => {
    for (const b of btns) b.classList.toggle("is-active", b.dataset.mode === mode);
  };
  const setChecked = (id: string, on: boolean): void => {
    const cb = need<HTMLInputElement>(id);
    if (cb.checked !== on) {
      cb.checked = on;
      cb.dispatchEvent(new Event("change"));
    }
  };
  const setSelect = (id: string, value: string): void => {
    const sel = need<HTMLSelectElement>(id);
    if (sel.value !== value) {
      sel.value = value;
      sel.dispatchEvent(new Event("change"));
    }
  };
  const setDeviceFilter = (filter: string): void => {
    document
      .querySelector<HTMLButtonElement>(
        `#device-filter-seg .seg-btn[data-filter="${filter}"]`,
      )
      ?.click();
  };
  const setDrawer = (id: string | null): void => {
    const open = document.querySelector<HTMLButtonElement>(".drawer-tab.is-active");
    if (open && open.dataset.drawer !== id) open.click();
    if (id) {
      const tab = document.querySelector<HTMLButtonElement>(
        `.drawer-tab[data-drawer="${id}"]`,
      );
      if (tab && !tab.classList.contains("is-active")) tab.click();
    }
  };

  const applyRide = (): void => {
    setDeviceFilter("all");
    setChecked("hide-unavailable", true);
    setChecked("area-filter-enable", false);
    setChecked("color-by-range", false);
    setChecked("color-by-reliability", true);
    setSelect("choropleth-select", "");
    for (const input of layerInputs.values()) {
      if (input.checked) {
        input.checked = false;
        input.dispatchEvent(new Event("change"));
      }
    }
    setDrawer(null);
    // Offer location so walk times light up. Runs inside the button tap,
    // so the browser treats the permission prompt as user-initiated.
    locate.trigger();
  };

  const applyAudit = (): void => {
    setDeviceFilter("all");
    setChecked("hide-unavailable", false);
    setChecked("area-filter-enable", false);
    setChecked("color-by-range", false);
    setChecked("color-by-reliability", false);
    setSelect("choropleth-select", "v1");
    setDrawer("compliance");
  };

  for (const btn of btns) {
    btn.addEventListener("click", () => {
      applying = true;
      try {
        if (btn.dataset.mode === "ride") applyRide();
        else applyAudit();
      } finally {
        applying = false;
      }
      setActive(btn.dataset.mode ?? null);
    });
  }

  // Manual changes to any drawer control drop the mode back to custom.
  // Capture phase so the preset's own synthetic events (guarded by
  // `applying`) never count.
  const toCustom = (e: Event): void => {
    if (applying) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.(".drawer")) setActive(null);
  };
  document.addEventListener("change", toCustom, true);
  document.addEventListener("click", toCustom, true);
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

// Reveal the Account drawer tab when the user taps the freshness pill 9 times
// in a row. Each tap counts the same — no morse, no long/short distinction —
// so it works reliably on touchscreens. Idle > 2.5s resets the count.
// Right-clicking the pill (desktop) or holding it for 2s (mobile) opens a
// live readout of the tap progress that auto-hides 2.4s after the last tap.
function wireSecretUnlock(): void {
  const target = document.getElementById("freshness");
  const tab = document.querySelector<HTMLButtonElement>(
    '.drawer-tab[data-drawer="person"]',
  );
  if (!target || !tab) return;

  const TARGET_TAPS = 9;
  const RESET_MS = 2500;
  const POPUP_HIDE_MS = 2400;
  const LONG_PRESS_MS = 2000;

  let taps = 0;
  let pressStart = 0;
  let resetTimer: number | undefined;
  let popupTimer: number | undefined;
  let longPressTimer: number | undefined;
  let longPressTriggered = false;

  const popup = document.createElement("div");
  popup.className = "tap-popup";
  popup.setAttribute("role", "status");
  popup.setAttribute("aria-live", "polite");
  popup.hidden = true;
  document.body.appendChild(popup);

  const renderPopup = (): void => {
    if (popup.hidden) return;
    popup.textContent = taps ? `${taps} / ${TARGET_TAPS} taps` : "(awaiting taps)";
  };
  const showPopup = (): void => {
    popup.hidden = false;
    renderPopup();
    scheduleHide();
  };
  const hidePopup = (): void => {
    popup.hidden = true;
  };
  const scheduleHide = (): void => {
    window.clearTimeout(popupTimer);
    popupTimer = window.setTimeout(hidePopup, POPUP_HIDE_MS);
  };

  const reset = (): void => {
    taps = 0;
    renderPopup();
  };
  const scheduleReset = (): void => {
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(reset, RESET_MS);
  };

  target.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showPopup();
  });

  target.addEventListener("pointerdown", (e) => {
    // Only react to primary button / touch / pen.
    if (e.button !== undefined && e.button !== 0) return;
    pressStart = performance.now();
    longPressTriggered = false;
    window.clearTimeout(resetTimer);
    window.clearTimeout(longPressTimer);
    // Mobile-friendly alternative to right-click: holding 2s opens the popup.
    longPressTimer = window.setTimeout(() => {
      longPressTriggered = true;
      showPopup();
    }, LONG_PRESS_MS);
  });

  target.addEventListener("pointerup", (e) => {
    window.clearTimeout(longPressTimer);
    if (pressStart === 0) return;
    if (longPressTriggered) {
      // The hold was a "show popup" gesture, not a tap — don't record it.
      pressStart = 0;
      longPressTriggered = false;
      e.preventDefault();
      return;
    }
    pressStart = 0;
    taps += 1;
    if (!popup.hidden) {
      renderPopup();
      scheduleHide();
    }
    if (taps >= TARGET_TAPS) {
      reset();
      hidePopup();
      revealAccountTab();
      tab.focus();
    } else {
      scheduleReset();
    }
    e.preventDefault();
  });

  // Cancel an in-flight press if the pointer leaves the element.
  target.addEventListener("pointercancel", () => {
    window.clearTimeout(longPressTimer);
    pressStart = 0;
    longPressTriggered = false;
    scheduleReset();
  });
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
      const visible = devices.visibleFeatures();
      clusters.update(visible);
      freshness.update(
        resp.metadata.snapshot_time,
        visible.length,
        resp.metadata.device_count,
      );
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
