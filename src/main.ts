import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { fetchDevicesAuto, type BoundaryLayer } from "./api.ts";
import { createMap } from "./map.ts";
import {
  Devices,
  DEVICE_INTERACTIVE_LAYERS,
  ALL_RIDE_TYPES,
  ALL_MODELS,
  gaugeColor,
  type RideType,
  type ModelKey,
  type QualityFilter,
  type IconStyle,
  type DataSource,
} from "./devices.ts";
import { RecommendedDevices } from "./recommend.ts";
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
import { RideHud } from "./ride-hud.ts";
import { RideWizard } from "./ride-wizard.ts";
import { EquityRanks } from "./equity.ts";
import { HexDensity, type HexSize } from "./hexdensity.ts";
import {
  consumePendingMagicLink,
  requestMagicLink,
  isProbablyEmail,
} from "./auth-magic-link.ts";
import {
  renderGoogleButton,
  promptGoogleOneTap,
  isGoogleConfigured,
} from "./auth-google.ts";
import { fetchSessionInfo, isAdminSession } from "./auth-session.ts";
import { type EquityRank } from "./config.ts";
import { indexFeature, type IndexedFeature } from "./geo.ts";
import { OVERLAY_BY_LAYER, OVERLAYS, REFRESH_MS } from "./config.ts";
import { getAuth, isAuthenticated, signOut } from "./map-auth.js";

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
const equity = new EquityRanks(overlays, () => renderEquityMetric());
const hexDensity = new HexDensity(map, need("hexbin-legend"));
// Hex density and the region choropleth both shade the map by count, so only
// one runs at a time — turning one on clears the other. Assigned by their
// wire functions.
let clearChoropleth: () => void = () => {};
let clearHexDensity: () => void = () => {};
const freshness = new Freshness(
  need("freshness"),
  need("freshness-text"),
  need("freshness-count"),
);
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
let rideTypesOn: ReadonlySet<RideType> = new Set(ALL_RIDE_TYPES);
let modelsOn: ReadonlySet<ModelKey> = new Set(ALL_MODELS);
let minBatteryPct = 0;
let qualityOn: QualityFilter = "any";
let lastAreaState: AreaFilterState | null = null;
// Chip-clear + preset hooks, assigned by their wire* functions.
let clearRideTypeFilter: () => void = () => {};
let clearModelFilter: () => void = () => {};
let clearBatteryMin: () => void = () => {};
let clearQualityFilter: () => void = () => {};
let resetAllFilters: () => void = () => {};
let resetIconography: () => void = () => {};

const RIDE_TYPE_CHIP_LABEL: Record<RideType, string> = {
  standing: "🛴 Standing only",
  sitting: "🚲 Sitting only",
};

const QUALITY_CHIP_LABEL: Partial<Record<QualityFilter, string>> = {
  "no-risk": "Hiding high-risk",
  "ok-only": "✓ Reliable only",
};

function refreshChips(): void {
  const active: Chip[] = [];

  if (rideTypesOn.size < ALL_RIDE_TYPES.length) {
    const only = [...rideTypesOn][0];
    active.push({
      id: "ride-type",
      label: only ? RIDE_TYPE_CHIP_LABEL[only] : "🚫 No ride types",
      onClear: clearRideTypeFilter,
    });
  }

  if (modelsOn.size < ALL_MODELS.length) {
    const names = [...modelsOn].map(
      (m) => m[0].toUpperCase() + m.slice(1),
    );
    active.push({
      id: "models",
      label: names.length ? `Models: ${names.join(", ")}` : "🚫 No models",
      onClear: clearModelFilter,
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

  if (minBatteryPct > 0) {
    active.push({
      id: "battery",
      label: `🔋 ≥ ${minBatteryPct}%`,
      onClear: clearBatteryMin,
    });
  }

  const qualityLabel = QUALITY_CHIP_LABEL[qualityOn];
  if (qualityLabel) {
    active.push({
      id: "quality",
      label: qualityLabel,
      onClear: clearQualityFilter,
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
wireRideHud();

// If the user just followed a magic link (?ml=<token>), redeem it before the
// account UI settles; on success reload so every fetch goes out authenticated.
// Inert when no token is present, so it's harmless before the endpoints exist.
void consumePendingMagicLink().then((ok) => {
  if (ok) location.reload();
});

// Google One Tap: for signed-out visitors, auto-prompt the top-right One Tap
// dialog on load (when Google is configured). GIS manages its own cooldown so
// this isn't nagging. Signed-in users are skipped.
if (isGoogleConfigured() && !isAuthenticated()) {
  void promptGoogleOneTap({ onSignedIn: () => location.reload() });
}

// ---------- Ride HUD ----------

// The v1∪v2 disadvantaged-area polygons power the HUD's equity-ride flags.
// Fetched lazily on first ride and cached (loadBoundary caches too).
let equityZonesCache: Promise<IndexedFeature[]> | null = null;
function equityZones(): Promise<IndexedFeature[]> {
  equityZonesCache ??= Promise.all([
    overlays.loadBoundary("v1"),
    overlays.loadBoundary("v2"),
  ]).then((responses) =>
    responses.flatMap((r) => r.features.map((f) => indexFeature(f))),
  );
  return equityZonesCache;
}

function wireRideHud(): void {
  const hud = new RideHud(need("ride-hud"), equityZones, map);
  need("ride-open").addEventListener("click", () => hud.open());
}

// ---------- Recommended Devices ----------

// The persistent home of the Find-a-ride interview's ranked picks; re-ranks
// on every filter change. Created at map load, fed by the wizard's
// onInterviewDone hook in wireModes().
let recommended: RecommendedDevices | null = null;

function wireRecommended(): void {
  recommended = new RecommendedDevices(
    need("recommended-body"),
    devices,
    locate,
    map,
  );
}

map.on("load", async () => {
  devices.addLayers();
  buildLayerToggles();
  wireRideTypes();
  wireModels();
  wireHideUnavailable();
  wireBatterySlider();
  wireQuality();
  wireClearFilters();
  wireIconography();
  wireRecommended();
  wireChoropleth();
  wireHexDensity();
  wireDrawers();
  const areaFilter = wireAreaFilter();
  wireModes();
  wireEquityRanks();

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
    equity.update(resp.features);
    hexDensity.update(resp.features);
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
  // Warm the default-selected ranks' polygons so the estimate populates.
  void equity.warm();
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

/** Generic single-select segmented control. Returns a programmatic setter
 *  (used by presets/chips) keyed on the same value the buttons carry. */
function wireSeg(
  rootSel: string,
  valueOf: (b: HTMLButtonElement) => string,
  onChange: (value: string) => void,
): (value: string) => void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`${rootSel} .seg-btn`),
  );
  const select = (btn: HTMLButtonElement): void => {
    for (const b of btns) {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    onChange(valueOf(btn));
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
  return (value) => {
    const btn = btns.find((b) => valueOf(b) === value);
    if (btn && !btn.classList.contains("is-active")) select(btn);
  };
}

/** Multi-toggle button group where everything starts enabled and a click
 *  disables that one member. Returns a "re-enable everything" resetter. */
function wireToggleGroup<T extends string>(
  btns: HTMLButtonElement[],
  valueOf: (b: HTMLButtonElement) => T,
  all: readonly T[],
  onChange: (enabled: Set<T>) => void,
): () => void {
  const enabled = new Set<T>(all);
  const sync = (): void => {
    for (const b of btns) {
      const on = enabled.has(valueOf(b));
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    onChange(new Set(enabled));
  };
  for (const btn of btns) {
    btn.addEventListener("click", () => {
      const v = valueOf(btn);
      if (enabled.has(v)) enabled.delete(v);
      else enabled.add(v);
      sync();
    });
  }
  return () => {
    if (enabled.size === all.length) return;
    for (const v of all) enabled.add(v);
    sync();
  };
}

function wireRideTypes(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      "#ride-type-filter .toggle-pill",
    ),
  );
  clearRideTypeFilter = wireToggleGroup(
    btns,
    (b) => b.dataset.ride as RideType,
    ALL_RIDE_TYPES,
    (enabled) => {
      rideTypesOn = enabled;
      devices.setRideTypes(enabled);
      clusters.update(devices.visibleFeatures());
      refreshChips();
    },
  );
}

function wireModels(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#model-filter .toggle-card"),
  );
  clearModelFilter = wireToggleGroup(
    btns,
    (b) => b.dataset.model as ModelKey,
    ALL_MODELS,
    (enabled) => {
      modelsOn = enabled;
      devices.setModels(enabled);
      clusters.update(devices.visibleFeatures());
      refreshChips();
    },
  );
}

function wireQuality(): void {
  const set = wireSeg(
    "#quality-seg",
    (b) => b.dataset.quality ?? "any",
    (v) => {
      qualityOn = v as QualityFilter;
      devices.setQuality(qualityOn);
      clusters.update(devices.visibleFeatures());
      refreshChips();
    },
  );
  clearQualityFilter = () => set("any");
}

function wireClearFilters(): void {
  resetAllFilters = () => {
    clearRideTypeFilter();
    clearModelFilter();
    clearBatteryMin();
    clearQualityFilter();
    const hideCb = need<HTMLInputElement>("hide-unavailable");
    if (hideCb.checked) {
      hideCb.checked = false;
      hideCb.dispatchEvent(new Event("change"));
    }
    const areaCb = need<HTMLInputElement>("area-filter-enable");
    if (areaCb.checked) {
      areaCb.checked = false;
      areaCb.dispatchEvent(new Event("change"));
    }
  };
  need<HTMLButtonElement>("clear-filters").addEventListener("click", () =>
    resetAllFilters(),
  );
}

function wireHideUnavailable(): void {
  const cb = need<HTMLInputElement>("hide-unavailable");
  cb.addEventListener("change", () => {
    devices.setHideUnavailable(cb.checked);
    clusters.update(devices.visibleFeatures());
    refreshChips();
  });
}

function wireBatterySlider(): void {
  const slider = need<HTMLInputElement>("battery-min");
  const out = need<HTMLOutputElement>("battery-min-value");
  const syncVisual = (): void => {
    const v = Number(slider.value);
    // The slider wears the gauge's color for its current value, so the
    // control and the map rings speak the same language.
    const color = gaugeColor(v);
    slider.style.accentColor = v === 0 ? "" : color;
    out.textContent = v === 0 ? "Off" : `≥ ${v}%`;
    out.style.color = v === 0 ? "" : color;
  };
  slider.addEventListener("input", () => {
    syncVisual();
    minBatteryPct = Number(slider.value);
    devices.setMinBattery(minBatteryPct);
    clusters.update(devices.visibleFeatures());
    refreshChips();
  });
  syncVisual();
  clearBatteryMin = () => {
    if (slider.value === "0") return;
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
  };
}

// ---------- Iconography ----------

// Icon style (device use / model / data), the data source that colors the
// gauge ring and the "data" badge, and the gauge toggle itself (default on).
function wireIconography(): void {
  const setStyle = wireSeg(
    "#icon-style-seg",
    (b) => b.dataset.style ?? "use",
    (v) => devices.setIconStyle(v as IconStyle),
  );
  const setSource = wireSeg(
    "#data-source-seg",
    (b) => b.dataset.source ?? "battery",
    (v) => devices.setDataSource(v as DataSource),
  );
  const gauge = need<HTMLInputElement>("gauge-toggle");
  gauge.addEventListener("change", () => devices.setGauge(gauge.checked));

  resetIconography = () => {
    setStyle("use");
    setSource("battery");
    if (!gauge.checked) {
      gauge.checked = true;
      gauge.dispatchEvent(new Event("change"));
    }
  };
}

function wireChoropleth(): void {
  const select = need<HTMLSelectElement>("choropleth-select");
  // Reset to Off without re-triggering the change handler's side effects.
  clearChoropleth = () => {
    if (!select.value) return;
    select.value = "";
    void overlays.setChoropleth(null);
  };
  select.addEventListener("change", async () => {
    const layer = (select.value || null) as BoundaryLayer | null;
    if (layer) clearHexDensity(); // mutually exclusive with hex density
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

function wireHexDensity(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#hexbin-seg .seg-btn"),
  );
  const select = (btn: HTMLButtonElement): void => {
    for (const b of btns) {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    const size = (btn.dataset.hex || "") as HexSize | "";
    if (size) clearChoropleth(); // mutually exclusive with the choropleth
    hexDensity.setSize(size || null);
  };
  // Reset to Off (used when the choropleth takes over).
  clearHexDensity = () => {
    const off = btns.find((b) => b.dataset.hex === "");
    if (off && !off.classList.contains("is-active")) select(off);
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

// ---------- Use-case modes ----------

// Two surfaces over one map. "Find a ride" runs the guided wizard
// (ride-wizard.ts): location consent → interview → ranked options; while
// it's active the analysis drawer tabs hide and the 🧭 Ride HUD button
// appears. "Analysis" is the full civic/data surface with every drawer.
// The Account (login) tab is shared by both. Exiting ride mode — declining
// consent, closing the wizard, or tapping Analysis — always resets the map
// to its fresh-load defaults so the wizard's presets never leak.
function wireModes(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      "#mode-switch .mode-btn[data-mode]",
    ),
  );
  let applying = false;
  let rideActive = false;

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
  /** Run a preset with the `applying` guard up so its synthetic events
   *  don't count as manual "custom" changes. */
  const applyPreset = (fn: () => void): void => {
    applying = true;
    try {
      fn();
    } finally {
      applying = false;
    }
  };

  const clearOverlays = (): void => {
    for (const input of layerInputs.values()) {
      if (input.checked) {
        input.checked = false;
        input.dispatchEvent(new Event("change"));
      }
    }
  };

  // Fresh-load defaults. Exiting ride mode runs this so the map comes back
  // "normal": every filter cleared, iconography back to its defaults
  // (device-use badges, battery gauge on), overlays and the walk line gone.
  const applyNormal = (): void => {
    resetAllFilters();
    resetIconography();
    setSelect("choropleth-select", "");
    clearHexDensity();
    clearOverlays();
    setDrawer(null);
    locate.clearLine();
  };

  // Map preset behind the wizard: a clean slate showing available devices.
  const applyRide = (): void => {
    resetAllFilters();
    setChecked("hide-unavailable", true);
    setSelect("choropleth-select", "");
    clearOverlays();
    setDrawer(null);
  };

  const applyAnalysis = (): void => {
    resetAllFilters();
    setSelect("choropleth-select", "v1");
    setDrawer("compliance");
  };

  /** Swap the visible surface: ride hides the analysis tabs (Account stays)
   *  and reveals the HUD button; the map container also resizes when the
   *  wizard docks as a side panel on small screens. */
  const setRideSurface = (on: boolean): void => {
    rideActive = on;
    document.body.classList.toggle("mode-ride", on);
    need("ride-open").hidden = !on;
    map.resize();
  };

  const wizard = new RideWizard(need("ride-wizard"), locate, {
    onConsentGranted: () => applyPreset(applyRide),
    onExit: () => exitRide(),
    onLoginHint: () => {
      const tab = document.querySelector<HTMLButtonElement>(
        '.drawer-tab[data-drawer="person"]',
      );
      if (tab && !tab.classList.contains("is-active")) tab.click();
    },
    // Interview finished: the Recommended Devices drawer takes over as the
    // home of the ranked list (and keeps re-ranking with the filters).
    onInterviewDone: (priority, typeChoice, from) => {
      recommended?.setContext({ from, priority, typeChoice });
      setDrawer("recommended");
    },
  });

  const exitRide = (): void => {
    if (!rideActive) return;
    if (wizard.isOpen()) wizard.close();
    setRideSurface(false);
    applyPreset(applyNormal);
    setActive("analysis");
  };

  const enterRide = (): void => {
    setDrawer(null);
    setRideSurface(true);
    setActive("ride");
    wizard.start();
  };

  for (const btn of btns) {
    btn.addEventListener("click", () => {
      if (btn.dataset.mode === "ride") {
        enterRide();
      } else if (rideActive) {
        exitRide(); // back to a normal map — no surprise choropleth
      } else {
        applyPreset(applyAnalysis);
        setActive("analysis");
      }
    });
  }

  // Manual changes to any drawer control drop the mode back to custom.
  // Capture phase so the presets' own synthetic events (guarded by
  // `applying`) never count. Ride mode is exempt: its surface has no
  // analysis controls to customize.
  const toCustom = (e: Event): void => {
    if (applying || rideActive) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.(".drawer")) setActive(null);
  };
  document.addEventListener("change", toCustom, true);
  document.addEventListener("click", toCustom, true);
}

// ---------- Equity ranks ----------

// Rank toggles (1–6, default 1+2) drive a live "% of the fleet in the
// selected ranks" estimate and the "Equity Ranking (Selected)" map overlay.
// The two overlay checkboxes (one in Areas, one beside the toggles) mirror
// each other and the underlying overlay state.
function wireEquityRanks(): void {
  const rankBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#rank-toggles .rank-btn"),
  );
  const overlayInputs = [
    need<HTMLInputElement>("equity-selected-overlay"),
    need<HTMLInputElement>("equity-selected-overlay-mirror"),
  ];

  const syncRankButtons = () => {
    const selected = equity.getSelected();
    for (const btn of rankBtns) {
      const on = selected.has(Number(btn.dataset.rank) as EquityRank);
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  };
  syncRankButtons();

  for (const btn of rankBtns) {
    btn.addEventListener("click", async () => {
      const rank = Number(btn.dataset.rank) as EquityRank;
      const nowOn = !equity.getSelected().has(rank);
      btn.disabled = true;
      try {
        await equity.toggleRank(rank, nowOn);
      } finally {
        btn.disabled = false;
      }
      syncRankButtons();
    });
  }

  const setOverlay = async (visible: boolean, source: HTMLInputElement) => {
    for (const input of overlayInputs) input.checked = visible;
    source.disabled = true;
    try {
      await equity.setOverlayVisible(visible);
    } finally {
      source.disabled = false;
    }
  };
  for (const input of overlayInputs) {
    input.addEventListener("change", () => void setOverlay(input.checked, input));
  }
}

function renderEquityMetric(): void {
  const el = document.getElementById("equity-rank-metric");
  if (!el) return;
  const selected = [...equity.getSelected()].sort((a, b) => a - b);
  if (selected.length === 0) {
    el.textContent = "Select one or more ranks to estimate.";
    return;
  }
  const { percent, inside, total } = equity.estimate();
  const ranks = `Ranks ${selected.join(", ")}`;
  if (percent === null) {
    el.textContent = equity.isUnavailable()
      ? "Equity-rank boundaries aren't published yet — check back once the city map is live."
      : `${ranks}: computing…`;
    return;
  }
  el.innerHTML =
    `<strong>${percent.toFixed(1)}%</strong> of devices are in ` +
    `<span class="equity-metric__ranks">${ranks}</span> right now ` +
    `<span class="equity-metric__count">(${inside.toLocaleString()} of ${total.toLocaleString()})</span>`;
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
  // Admin status is resolved once per token (identity comes from
  // /auth/session, not the token blob). Cached so the minute-tick re-render
  // and focus re-render don't refetch.
  let adminCheckedToken: string | null = null;
  let adminIsOn = false;
  let adminEmail: string | undefined;

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
      body.append(status);

      // Administrator Mode badge, shown once we've confirmed the session is
      // on the admin allowlist (Google + verified allowlisted email → admin
      // scope, enforced server-side).
      if (adminIsOn && adminCheckedToken === auth.token) {
        const badge = el("div", "account-admin");
        const brow = el("div", "account-admin__row");
        brow.append(
          el("span", "account-admin__icon", "🛡️"),
          el("strong", undefined, "Administrator Mode"),
        );
        badge.append(brow);
        if (adminEmail) badge.append(el("p", "account-admin__email", adminEmail));
        body.append(badge);
      }

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
      body.append(signoutBtn);

      // Resolve admin status once per token, then re-render to reveal the
      // badge. Marking the token as checked up front prevents the minute
      // re-render from refetching.
      if (adminCheckedToken !== auth.token) {
        adminCheckedToken = auth.token;
        void fetchSessionInfo().then((info) => {
          adminIsOn = isAdminSession(info);
          adminEmail = info?.email;
          if (adminIsOn) render();
        });
      }

      // Re-render once a minute to keep the countdown current.
      countdownTimer = window.setTimeout(render, 60_000);
    } else {
      const intro = el("p", "account-intro");
      intro.textContent =
        "Sign in to report problems and (soon) track your rides. The map works fully without an account.";
      body.append(intro);

      // Sign in with Google — only when a client id is configured (otherwise
      // no third-party script loads). Its callback persists a session, so we
      // reload to refetch everything authenticated.
      if (isGoogleConfigured()) {
        const gWrap = el("div", "account-google");
        body.append(gWrap);
        void renderGoogleButton(gWrap, {
          onSignedIn: () => location.reload(),
          onError: (err) => {
            const msg = el("p", "account-error", err.message);
            gWrap.after(msg);
          },
        });
        body.append(el("div", "account-or", "or"));
      }

      // Magic link — always available (Postmark). Emails a one-time sign-in
      // link; consumePendingMagicLink() redeems it when the user returns.
      const form = el("form", "account-magic");
      const input = el("input", "select");
      input.type = "email";
      input.required = true;
      input.placeholder = "you@email.com";
      input.autocomplete = "email";
      input.setAttribute("aria-label", "Email address");
      const submit = el("button", "login-btn", "Email me a sign-in link");
      submit.type = "submit";
      const status = el("p", "account-magic-status");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      form.append(input, submit, status);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const email = input.value.trim();
        if (!isProbablyEmail(email)) {
          status.textContent = "Enter a valid email address.";
          return;
        }
        submit.disabled = true;
        status.textContent = "Sending…";
        requestMagicLink(email)
          .then(() => {
            form.replaceChildren(
              el(
                "p",
                "account-magic-status",
                "📧 Check your inbox for a sign-in link (valid 15 minutes).",
              ),
            );
          })
          .catch(() => {
            submit.disabled = false;
            status.textContent = "Couldn't send right now — please try again.";
          });
      });
      body.append(form);
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
      equity.update(resp.features);
      hexDensity.update(resp.features);
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
