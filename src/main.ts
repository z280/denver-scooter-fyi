import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import {
  fetchDevicesAuto,
  type BoundaryLayer,
  type DeviceInclude,
} from "./api.ts";
import { createMap } from "./map.ts";
import { initialTheme, startSunSync, ThemeControl } from "./theme.ts";
import {
  Devices,
  DEVICE_INTERACTIVE_LAYERS,
  ALL_RIDE_TYPES,
  ALL_MODELS,
  gaugeColor,
  iconPreviewURL,
  whenModelIconsReady,
  type RideType,
  type ModelKey,
  type QualityFilter,
  type IconStyle,
  type ModelIcon,
  type DataSource,
  type GaugeDisplay,
  type GaugeThickness,
  type GaugePlacement,
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
import { HexDensity, type HexSize, type HexMetric } from "./hexdensity.ts";
import {
  consumePendingMagicLink,
  requestMagicLink,
  requestLoginCode,
  verifyEmailCode,
  isProbablyEmail,
  isProbablyCode,
  AuthSendError,
} from "./auth-magic-link.ts";
import {
  renderGoogleButton,
  promptGoogleOneTap,
} from "./auth-google.ts";
import { loadAuthConfig, type AuthConfig } from "./auth-config.ts";
import {
  fetchSessionInfo,
  isAdminSession,
} from "./auth-session.ts";
import { type EquityRank } from "./config.ts";
import { indexFeature, type IndexedFeature } from "./geo.ts";
import { OVERLAY_BY_LAYER, OVERLAYS, REFRESH_MS } from "./config.ts";
import { getAuth, isAuthenticated, signOut } from "./map-auth.js";
import { initInstallPrompt } from "./install-prompt.ts";
import { initChrome, setRibbonOpen } from "./chrome.ts";

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const theme0 = initialTheme();
document.documentElement.dataset.theme = theme0;
const { map, geolocate } = createMap("map", theme0);
// Added AFTER createMap (which registers geolocate in top-left) so the
// theme toggle sits directly right of the location control once chrome.ts
// adopts the corner into the top bar.
map.addControl(new ThemeControl(theme0), "top-left");
initChrome();
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
  need("freshness-map"),
);

/** Filtered devices inside the current viewport, for the pill's Map line. */
function countDevicesInViewport(): number {
  const bounds = map.getBounds();
  let n = 0;
  for (const f of devices.visibleFeatures()) {
    const [lng, lat] = f.geometry.coordinates;
    if (bounds.contains([lng, lat])) n++;
  }
  return n;
}
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
// Ride mode fetches the lean payload (the API's low-end-phone diet); the
// analysis surface needs the h3 + rank extras. Assigned by wireModes /
// startRefreshLoop.
let leanFetch = false;
let requestRefresh: () => void = () => {};

function fetchIncludes(): DeviceInclude[] {
  return leanFetch ? [] : ["h3", "ranks"];
}

const RIDE_TYPE_CHIP_LABEL: Record<RideType, string> = {
  standing: "🛴 Standing only",
  sitting: "🚲 Seated only",
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
// Analysis is the default surface, so the first fetch carries the full
// include set (h3 for hex density, ranks for the Battery Rankings modal).
const devicesPromise = fetchDevicesAuto(undefined, fetchIncludes()).catch((e) => {
  console.error("initial device fetch failed", e);
  return null;
});
void renderCompliance(need("compliance")).catch((e) => {
  console.error("compliance render failed", e);
});
wireAccount();
wireRideHud();
startSunSync();
wireFreshnessCollapse();
initInstallPrompt();

// If the user just followed a magic link (?ml=<token>), redeem it before the
// account UI settles; on success reload so every fetch goes out authenticated.
// Inert when no token is present, so it's harmless before the endpoints exist.
void consumePendingMagicLink().then((ok) => {
  if (ok) location.reload();
});

// Google One Tap: for signed-out visitors, auto-prompt the top-right One Tap
// dialog on load — but only if the backend's /auth/config says Google is
// enabled (the single source of truth) and hands back a client id. GIS
// manages its own cooldown so this isn't nagging. Signed-in users are skipped.
if (!isAuthenticated()) {
  void loadAuthConfig().then((cfg) => {
    if (cfg.googleEnabled && cfg.googleClientId && !isAuthenticated()) {
      void promptGoogleOneTap(cfg.googleClientId, {
        onSignedIn: () => location.reload(),
      });
    }
  });
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
  const hud = new RideHud(need("ride-hud"), equityZones, map, devices);
  need("ride-open").addEventListener("click", () => hud.open());
}

// ---------- Sun-synced theme ----------

// Auto mode (theme follows sunrise/sunset in Denver) lives in the map's
// three-state ☀/☾ ThemeControl now; here we only resume it on boot.

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

  // Keep the freshness pill's Filters line in sync with every filter
  // change (the first fire happens right after a setData() too), and the
  // Map line with both filter changes and camera moves.
  devices.onCountsChange((visible, total) => {
    freshness.setCounts(visible, total);
    freshness.setViewportCount(countDevicesInViewport());
  });
  map.on("moveend", () => {
    freshness.setViewportCount(countDevicesInViewport());
  });

  const resp = await devicesPromise;
  if (resp) {
    devices.setData(resp);
    equity.update(resp.features);
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

// Icon style (ride type / model / data), independent icon-data and
// gauge-data sources, the gauge toggle (default on), contextual example
// rows rendered with the real icon renderer, and the on-map legend.
/** Enlarge a preview icon in a dismissible modal overlay. Closes on the ✕, on
 *  a backdrop tap (an "additional tap"), or Escape. Moves focus into the
 *  dialog on open and restores it to the trigger on close. */
function openIconLightbox(url: string, label: string): void {
  document.querySelector(".icon-lightbox")?.remove();
  const returnFocusTo =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement("div");
  overlay.className = "icon-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", `${label} — enlarged icon`);

  const box = document.createElement("div");
  box.className = "icon-lightbox__box";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-lightbox__close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  const big = document.createElement("img");
  big.className = "icon-lightbox__img";
  big.src = url;
  big.alt = label;
  const cap = document.createElement("div");
  cap.className = "icon-lightbox__cap";
  cap.textContent = label;
  box.append(close, big, cap);
  overlay.append(box);

  const dismiss = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    returnFocusTo?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") dismiss();
  };
  // Explicit close button — stop its click from double-firing via the overlay.
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });
  // The overlay covers the whole screen, so a tap anywhere — backdrop or the
  // enlarged icon itself ("additional tap") — dismisses it.
  overlay.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  close.focus(); // move keyboard focus into the dialog
}

function wireIconography(): void {
  const styleDetail = need("icono-style-detail");
  const gaugeBody = need("gauge-body");
  const gaugeDetail = need("icono-gauge-detail");
  const iconDataSection = need("icon-data-section");
  const legendEl = need("icon-legend");
  const legendToggle = need<HTMLInputElement>("legend-toggle");
  const gauge = need<HTMLInputElement>("gauge-toggle");

  // Local mirrors of the devices-side iconography state, for rendering.
  let style: IconStyle = "use";
  let modelIcon: ModelIcon = "comic";
  let iconData: DataSource = "reliability";
  let gaugeData: DataSource = "battery";
  let thickness: GaugeThickness = "standard";
  let placement: GaugePlacement = "gap";
  const THICK_CHAR: Record<GaugeThickness, string> = {
    thin: "T",
    standard: "S",
    large: "L",
    xlarge: "X",
  };
  const PLACE_CHAR: Record<GaugePlacement, string> = {
    surrounding: "S",
    gap: "G",
    biggap: "B",
  };
  /** Ring spec → full icon key carrying the current design options, so the
   *  example rows and legend preview exactly what the map will draw. */
  const k = (inner: string, ring: string): string =>
    `ik|${inner}|${ring}|${THICK_CHAR[thickness]}${PLACE_CHAR[placement]}`;

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
  const icon = (
    key: string,
    title: string,
    overlay?: { text: string; color: string },
  ): HTMLImageElement => {
    const img = el("img", "icono-preview");
    const preview = iconPreviewURL(key, overlay);
    img.src = preview.url;
    // Canvases vary by design (rings grow outward from a fixed badge), so
    // previews scale to match the map's relative sizes.
    const size = Math.round(preview.logicalPx * 0.8);
    img.width = size;
    img.height = size;
    img.alt = title;
    img.title = `${title} — tap to enlarge`;
    // Tap any preview to inspect it at a legible size (item: enlarge-on-tap).
    img.addEventListener("click", () => openIconLightbox(preview.url, title));
    return img;
  };
  const item = (
    key: string,
    label: string,
    overlay?: { text: string; color: string },
  ): HTMLElement => {
    const row = el("div", "icono-item");
    row.append(icon(key, label, overlay), el("span", undefined, label));
    return row;
  };

  // Comic-vs-letter switch for the Model style, rebuilt with the detail rows.
  const modelIconToggle = (): HTMLElement => {
    const seg = el("div", "segmented icono-modelicon");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Model icon style");
    for (const [val, label] of [
      ["comic", "Comic"],
      ["letter", "Letter"],
    ] as const) {
      const b = el("button", "seg-btn", label);
      b.type = "button";
      b.setAttribute("role", "radio");
      const on = modelIcon === val;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
      b.addEventListener("click", () => {
        if (modelIcon === val) return;
        modelIcon = val;
        devices.setModelIcon(modelIcon);
        renderAll();
      });
      seg.append(b);
    }
    return seg;
  };

  // Only details pertinent to the selected icon style.
  const renderStyleDetail = (): void => {
    styleDetail.replaceChildren();
    if (style === "use") {
      styleDetail.append(
        el("p", "icono-detail__title", "Ride Types:"),
        item(k("use-sitting", "off"), "Seated"),
        item(k("use-standing", "off"), "Standing"),
      );
    } else if (style === "model") {
      const c = modelIcon === "comic";
      styleDetail.append(
        el("p", "icono-detail__title", "Device Models"),
        modelIconToggle(),
        item(k(c ? "msvg-astro" : "ml-astro", "off"), "Veo Astro — Standing scooter"),
        item(k(c ? "msvg-cosmo" : "ml-cosmo", "off"), "Veo Cosmo — One passenger glider (no pedals)"),
        item(k(c ? "msvg-apollo" : "ml-apollo", "off"), "Veo Apollo — Two passenger e-bike w/ pedals"),
      );
    } else {
      styleDetail.append(
        el(
          "p",
          "icono-detail__note",
          "Data display shows battery % or reliability indicator icon for each device.",
        ),
      );
      if (iconData === "battery") {
        styleDetail.append(
          item(k("db-3", "off"), "100%", { text: "100", color: "#ffffff" }),
          item(k("db-1", "off"), "50%", { text: "50", color: "#3a2a00" }),
          item(k("db-0", "off"), "25%", { text: "25", color: "#ffffff" }),
        );
      } else {
        styleDetail.append(
          item(k("dr-ok", "off"), "Likely Ridable"),
          item(k("dr-unknown", "off"), "Unknown"),
          item(k("dr-risk", "off"), "High Risk"),
        );
      }
    }
  };

  // Gauge section: nothing below the toggle line when off; examples match
  // the selected gauge data when on.
  const renderGaugeDetail = (): void => {
    gaugeBody.hidden = !gauge.checked;
    gaugeDetail.replaceChildren();
    if (!gauge.checked) return;
    if (gaugeData === "battery") {
      gaugeDetail.append(
        item(k("x", "b-100"), "Full"),
        item(k("x", "b-50"), "50%"),
        item(k("x", "b-25"), "25%"),
      );
    } else {
      gaugeDetail.append(
        item(k("x", "r-ok"), "Likely ridable"),
        item(k("x", "r-unknown"), "Unknown"),
        item(k("x", "r-risk"), "Questionable"),
      );
    }
  };

  // On-map legend: every icon + gauge-ring permutation for the current
  // settings, docked below the ribbon; hover for descriptions. A collapsed
  // ribbon's rect is parked off-screen, so the legend hangs from the top
  // bar instead.
  const positionLegend = (): void => {
    const tabs = document.getElementById("drawer-tabs");
    const topbar = document.getElementById("topbar");
    const anchor =
      document.body.classList.contains("ribbon-open") && tabs ? tabs : topbar;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    legendEl.style.top = `${Math.round(rect.bottom + 10)}px`;
  };
  const renderLegend = (): void => {
    legendEl.hidden = !legendToggle.checked;
    if (!legendToggle.checked) return;
    legendEl.replaceChildren();
    const head = (text: string): HTMLElement =>
      el("span", "icon-legend__head", text);

    legendEl.append(head("Icons"));
    if (style === "use") {
      legendEl.append(
        icon(k("use-sitting", "off"), "Seated ride (Cosmo glider or Apollo e-bike)"),
        icon(k("use-standing", "off"), "Standing scooter (Astro)"),
      );
    } else if (style === "model") {
      const c = modelIcon === "comic";
      legendEl.append(
        icon(k(c ? "msvg-astro" : "ml-astro", "off"), "Veo Astro — standing scooter"),
        icon(k(c ? "msvg-cosmo" : "ml-cosmo", "off"), "Veo Cosmo — one passenger glider (no pedals)"),
        icon(k(c ? "msvg-apollo" : "ml-apollo", "off"), "Veo Apollo — two passenger e-bike w/ pedals"),
        icon(k(c ? "model-unk" : "ml-unk", "off"), "Unrecognized model — tap its pin to tell us!"),
      );
    } else if (iconData === "battery") {
      legendEl.append(
        icon(k("db-3", "off"), "Battery: top quartile", { text: "100", color: "#ffffff" }),
        icon(k("db-2", "off"), "Battery: 50–75% quartile", { text: "65", color: "#1f3a14" }),
        icon(k("db-1", "off"), "Battery: 25–50% quartile", { text: "40", color: "#3a2a00" }),
        icon(k("db-0", "off"), "Battery: bottom quartile", { text: "15", color: "#ffffff" }),
        icon(k("db-x", "off"), "No battery data"),
      );
    } else {
      legendEl.append(
        icon(k("dr-ok", "off"), "Likely ridable"),
        icon(k("dr-unknown", "off"), "Unknown reliability"),
        icon(k("dr-risk", "off"), "High risk — rendered faded on the map"),
      );
    }

    if (gauge.checked) {
      legendEl.append(head("Gauge"));
      if (gaugeData === "battery") {
        legendEl.append(
          icon(k("x", "b-100"), "Gauge ring: 100% battery — full green ring"),
          icon(k("x", "b-75"), "Gauge ring: ~75% battery"),
          icon(k("x", "b-50"), "Gauge ring: ~50% battery (amber)"),
          icon(k("x", "b-25"), "Gauge ring: ~25% battery (red)"),
          icon(k("x", "b-x"), "Gauge ring: no battery data (thin gray outline)"),
        );
      } else {
        legendEl.append(
          icon(k("x", "r-ok"), "Gauge ring: likely ridable"),
          icon(k("x", "r-unknown"), "Gauge ring: unknown reliability"),
          icon(k("x", "r-risk"), "Gauge ring: questionable — high risk"),
        );
      }
    }
    positionLegend();
  };
  const renderAll = (): void => {
    renderStyleDetail();
    renderGaugeDetail();
    renderLegend();
  };

  const setGaugeSrc = wireSeg(
    "#data-source-seg",
    (b) => b.dataset.source ?? "battery",
    (v) => {
      gaugeData = v as DataSource;
      devices.setGaugeData(gaugeData);
      renderAll();
    },
  );
  const opposite = (s: DataSource): DataSource =>
    s === "battery" ? "reliability" : "battery";
  const setIconSrc = wireSeg(
    "#icon-data-seg",
    (b) => b.dataset.source ?? "reliability",
    (v) => {
      iconData = v as DataSource;
      devices.setIconData(iconData);
      // Keep the icon and ring showing different signals: flip the gauge to
      // the opposite source (icon reliability → battery ring, and vice
      // versa) whenever the gauge is on.
      if (gauge.checked) setGaugeSrc(opposite(iconData));
      renderAll();
    },
  );
  const setStyle = wireSeg(
    "#icon-style-seg",
    (b) => b.dataset.style ?? "use",
    (v) => {
      style = v as IconStyle;
      devices.setIconStyle(style);
      iconDataSection.hidden = style !== "data";
      // Entering Data icons: point the gauge at whatever the badge isn't
      // showing, so the two stay complementary.
      if (style === "data" && gauge.checked) setGaugeSrc(opposite(iconData));
      renderAll();
    },
  );
  // 📐 Design Options.
  const setDisplay = wireSeg(
    "#gauge-display-seg",
    (b) => b.dataset.display ?? "always",
    (v) => devices.setGaugeDisplay(v as GaugeDisplay),
  );
  const setThickness = wireSeg(
    "#gauge-thickness-seg",
    (b) => b.dataset.thickness ?? "standard",
    (v) => {
      thickness = v as GaugeThickness;
      devices.setGaugeThickness(thickness);
      renderAll(); // examples + legend preview the new ring weight
    },
  );
  const setPlacement = wireSeg(
    "#gauge-placement-seg",
    (b) => b.dataset.placement ?? "surrounding",
    (v) => {
      placement = v as GaugePlacement;
      devices.setGaugePlacement(placement);
      renderAll();
    },
  );
  gauge.addEventListener("change", () => {
    devices.setGauge(gauge.checked);
    // Turning the ring on in Data mode: default it to the badge's opposite.
    if (gauge.checked && style === "data") setGaugeSrc(opposite(iconData));
    renderAll();
  });
  // ✨ Icon size: scales the on-map badges (and their % text overlays).
  // The drawer previews keep their fixed size — they demonstrate style,
  // not scale.
  const iconSize = need<HTMLInputElement>("icon-size");
  const iconSizeValue = need("icon-size-value");
  const applyIconSize = (): void => {
    const pct = Number(iconSize.value) || 100;
    iconSizeValue.textContent = `${pct}%`;
    devices.setIconScale(pct / 100);
  };
  iconSize.addEventListener("input", applyIconSize);
  // ✨ Essentials-on-hover tooltip.
  const tooltipToggle = need<HTMLInputElement>("tooltip-toggle");
  tooltipToggle.addEventListener("change", () =>
    devices.setHoverTooltip(tooltipToggle.checked),
  );
  legendToggle.addEventListener("change", renderLegend);
  window.addEventListener("resize", () => {
    if (legendToggle.checked) positionLegend();
  });
  // Ribbon toggling moves the legend's anchor between strip and top bar.
  window.addEventListener("scooter:ribbon", () => {
    if (legendToggle.checked) positionLegend();
  });

  resetIconography = () => {
    if (modelIcon !== "comic") {
      modelIcon = "comic";
      devices.setModelIcon("comic");
    }
    setStyle("use");
    setIconSrc("reliability");
    setGaugeSrc("battery");
    setDisplay("always");
    setThickness("standard");
    setPlacement("gap");
    if (iconSize.value !== "100") {
      iconSize.value = "100";
      applyIconSize();
    }
    if (!gauge.checked) {
      gauge.checked = true;
      gauge.dispatchEvent(new Event("change"));
    }
    if (!tooltipToggle.checked) {
      tooltipToggle.checked = true;
      tooltipToggle.dispatchEvent(new Event("change"));
    }
  };

  // Model badges decode async — refresh previews once they land.
  void whenModelIconsReady().then(renderAll);
  renderAll();
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
  const metricRow = need("hexbin-metric-row");
  const metricSelect = need<HTMLSelectElement>("hexbin-metric-select");

  const select = (btn: HTMLButtonElement): void => {
    for (const b of btns) {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    const size = (btn.dataset.hex || "") as HexSize | "";
    if (size) clearChoropleth(); // mutually exclusive with the choropleth
    metricRow.hidden = !size;
    void hexDensity.setSize(size || null);
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

  metricSelect.addEventListener("change", () => {
    hexDensity.setMetric(metricSelect.value as HexMetric);
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
      // Synthetic clicks land on hidden tabs too — with the ribbon
      // collapsed that would open a drawer with no visible origin, so
      // reveal the strip first.
      setRibbonOpen(true);
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
    leanFetch = on; // riders get the lean payload; analysis gets extras
    document.body.classList.toggle("mode-ride", on);
    map.resize();
  };

  // The map only reserves the right strip while the wizard is actually
  // docked (mobile). Once the interview hands off to the ranked list the
  // wizard hides, so drop the reservation and resize — otherwise the map
  // stays shrunk and leaves an empty white bar where the panel used to be.
  const setWizardDocked = (on: boolean): void => {
    document.body.classList.toggle("wizard-open", on);
    map.resize();
  };

  const wizard = new RideWizard(need("ride-wizard"), locate, {
    onConsentGranted: () => applyPreset(applyRide),
    onExit: () => exitRide(),
    onLoginHint: () => {
      const tab = document.querySelector<HTMLButtonElement>(
        '.drawer-tab[data-drawer="account"]',
      );
      if (tab && !tab.classList.contains("is-active")) tab.click();
    },
    // Interview finished: the Recommended Devices drawer takes over as the
    // home of the ranked list (and keeps re-ranking with the filters).
    onInterviewDone: (priority, typeChoice, from) => {
      setWizardDocked(false);
      recommended?.setContext({ from, priority, typeChoice });
      setDrawer("recommended");
    },
  });

  const exitRide = (): void => {
    if (!rideActive) return;
    if (wizard.isOpen()) wizard.close();
    setWizardDocked(false);
    setRideSurface(false);
    applyPreset(applyNormal);
    // Recommendations are scoped to one Find-a-ride session: drop them so
    // re-entering never shows a stale list from the prior location/answers.
    recommended?.clear();
    setActive("analysis");
    // Ride-mode ticks fetched the lean payload; refresh now so analysis
    // tools (hex density, battery rankings) get their fields back promptly.
    requestRefresh();
  };

  const enterRide = (): void => {
    setDrawer(null);
    setRideSurface(true);
    setActive("ride");
    wizard.start();
    setWizardDocked(true);
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

// ---------- Freshness pill mobile collapse ----------

// On narrow screens the three-line pill shrinks to just the status dot;
// tapping expands it for a few seconds. Expansion is tap-triggered and
// collapse is idle-triggered (never tap-toggled) so a stray second tap
// can't flicker it shut while someone is reading.
function wireFreshnessCollapse(): void {
  const root = need("freshness");
  const modeSwitch = need("mode-switch");
  const mq = window.matchMedia("(max-width: 640px)");
  let expanded = false;
  let idleTimer: number | undefined;

  const sync = (): void => {
    root.classList.toggle("freshness--collapsed", mq.matches && !expanded);
    // While the pill is tap-expanded, its three lines of text can reach
    // well past the mode pill's own footprint — lift the pill clear rather
    // than let it sit on top of (and hide) that text. Read the freshness
    // pill's live rendered height instead of hardcoding one: the class
    // toggle above already applied, so this reflects the current expanded
    // or collapsed size exactly, including whatever the actual device
    // counts/timestamp text needs.
    const lifted = mq.matches && expanded;
    modeSwitch.style.setProperty(
      "--freshness-lift",
      lifted ? `${Math.ceil(root.getBoundingClientRect().height) + 10}px` : "0px",
    );
  };
  const scheduleCollapse = (): void => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      expanded = false;
      sync();
    }, 6_000);
  };

  root.addEventListener("click", () => {
    if (!mq.matches) return;
    expanded = true;
    sync();
    scheduleCollapse();
  });
  mq.addEventListener("change", () => {
    expanded = false;
    window.clearTimeout(idleTimer);
    sync();
  });
  sync();
}

// ---------- Account drawer ----------

// Renders the Account drawer body based on map-auth state and keeps the
// expiry countdown live. Also wires sign-in / sign-out handlers.
function wireAccount(): void {
  const body = document.getElementById("account-body");
  if (!body) return;

  let countdownTimer: number | undefined;
  // Admin status is resolved once per token (identity comes from
  // /auth/session, not the token blob). Cached so the minute-tick re-render
  // and focus re-render don't refetch.
  let adminCheckedToken: string | null = null;
  let adminIsOn = false;
  let adminEmail: string | undefined;
  // Backend sign-in capabilities (null until /auth/config resolves).
  let authCfg: AuthConfig | null = null;

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
          // Popups need the status too: admins skip the Start proximity
          // gate (issue #18).
          devices.setAdminSession(adminIsOn);
          render();
        });
      }

      // Re-render once a minute to keep the countdown current.
      countdownTimer = window.setTimeout(render, 60_000);
    } else {
      const intro = el("p", "account-intro");
      intro.textContent =
        "Sign in to report problems and (soon) track your rides. The map works fully without an account.";
      body.append(intro);

      // Sign in with Google — shown only when the backend's /auth/config says
      // it's enabled and hands back a client id (the single source of truth;
      // no third-party script loads otherwise). `authCfg` is null until that
      // fetch resolves, which triggers a re-render.
      if (authCfg?.googleEnabled && authCfg.googleClientId) {
        const clientId = authCfg.googleClientId;
        const gWrap = el("div", "account-google");
        body.append(gWrap);
        void renderGoogleButton(gWrap, clientId, {
          onSignedIn: () => location.reload(),
          onError: (err) => {
            const msg = el("p", "account-error", err.message);
            gWrap.after(msg);
          },
        });
        body.append(el("div", "account-or", "or"));
      }

      // Email sign-in (Postmark) — the only door for now. Two independent
      // ways to finish, each its own email (matching the scooter-fyi-api backend):
      //   • a typed AA000AA code (POST /auth/code → /auth/code/verify), the
      //     in-tab default; and
      //   • a magic link (POST /auth/magic-link), redeemed on return by
      //     consumePendingMagicLink().
      const emailForm = el("form", "account-magic");
      const emailInput = el("input", "select");
      emailInput.type = "email";
      emailInput.required = true;
      emailInput.placeholder = "you@email.com";
      emailInput.autocomplete = "email";
      emailInput.setAttribute("aria-label", "Email address");
      const emailSubmit = el("button", "login-btn", "Email me a sign-in code");
      emailSubmit.type = "submit";
      // Secondary door: a magic link instead of a typed code.
      const linkBtn = el("button", "text-btn", "Prefer a link? Email me one instead");
      linkBtn.type = "button";
      const emailStatus = el("p", "account-magic-status");
      emailStatus.setAttribute("role", "status");
      emailStatus.setAttribute("aria-live", "polite");
      emailForm.append(emailInput, emailSubmit, linkBtn, emailStatus);

      // Step 2: enter the emailed AA000AA code. Hidden until a code is sent;
      // the link door never needs it.
      const codeForm = el("form", "account-code");
      codeForm.hidden = true;
      const codeHint = el(
        "p",
        "account-magic-status",
        "📧 Check your inbox and enter the code (like AB123XY, valid 10 minutes):",
      );
      const codeInput = el("input", "select");
      codeInput.type = "text";
      codeInput.autocomplete = "one-time-code";
      codeInput.autocapitalize = "characters";
      codeInput.spellcheck = false;
      codeInput.maxLength = 9; // AA000AA (7) plus a stray space/hyphen or two
      codeInput.placeholder = "AB123XY";
      codeInput.setAttribute("aria-label", "Sign-in code");
      const codeSubmit = el("button", "login-btn", "Verify code");
      codeSubmit.type = "submit";
      const codeStatus = el("p", "account-magic-status");
      codeStatus.setAttribute("role", "status");
      codeStatus.setAttribute("aria-live", "polite");
      codeForm.append(codeHint, codeInput, codeSubmit, codeStatus);

      let sentEmail = "";
      const validEmail = (): string | null => {
        const email = emailInput.value.trim();
        if (!isProbablyEmail(email)) {
          emailStatus.textContent = "Enter a valid email address.";
          return null;
        }
        return email;
      };
      // A code is bound to the address it was sent to; if the user edits the
      // email after we revealed the code step, retract it so they can't verify
      // an old code against a new address (or vice-versa).
      emailInput.addEventListener("input", () => {
        if (sentEmail && emailInput.value.trim() !== sentEmail) {
          sentEmail = "";
          codeForm.hidden = true;
          codeStatus.textContent = "";
          emailSubmit.textContent = "Email me a sign-in code";
        }
      });
      // Distinct copy for a rate-limit vs a generic failure — don't tell the
      // user to retry the exact thing that's being throttled.
      const sendFailMsg = (err: unknown, noun: string): string =>
        err instanceof AuthSendError && err.status === 429
          ? `Too many requests — wait a minute before asking for another ${noun}.`
          : `Couldn't send the ${noun} right now — please try again.`;

      // Primary: email a typed code, then reveal the code-entry step.
      emailForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const email = validEmail();
        if (!email) return;
        emailSubmit.disabled = true;
        linkBtn.disabled = true;
        emailStatus.textContent = "Sending…";
        requestLoginCode(email)
          .then(() => {
            sentEmail = email;
            emailSubmit.disabled = false;
            linkBtn.disabled = false;
            emailSubmit.textContent = "Resend code";
            emailStatus.textContent = "";
            codeForm.hidden = false;
            codeInput.focus();
          })
          .catch((err: unknown) => {
            emailSubmit.disabled = false;
            linkBtn.disabled = false;
            emailStatus.textContent = sendFailMsg(err, "code");
          });
      });

      // Secondary: email a magic link instead (self-contained; redeemed on
      // return), and tuck the code step away if it was showing.
      linkBtn.addEventListener("click", () => {
        const email = validEmail();
        if (!email) return;
        emailSubmit.disabled = true;
        linkBtn.disabled = true;
        emailStatus.textContent = "Sending…";
        requestMagicLink(email)
          .then(() => {
            // Re-enable so the user can resend or switch back to the code door.
            emailSubmit.disabled = false;
            linkBtn.disabled = false;
            sentEmail = "";
            codeForm.hidden = true;
            emailStatus.textContent =
              "📧 Check your inbox for a sign-in link (valid 15 minutes).";
          })
          .catch((err: unknown) => {
            emailSubmit.disabled = false;
            linkBtn.disabled = false;
            emailStatus.textContent = sendFailMsg(err, "link");
          });
      });

      codeForm.addEventListener("submit", (e) => {
        e.preventDefault();
        // Defensive: the form is hidden until a code is sent, but never verify
        // against an empty address (it'd be a confusing server-side failure).
        if (!sentEmail) {
          codeStatus.textContent = "Request a sign-in code first.";
          return;
        }
        const code = codeInput.value;
        if (!isProbablyCode(code)) {
          codeStatus.textContent =
            "Enter the code from your email (like AB123XY).";
          return;
        }
        codeSubmit.disabled = true;
        codeStatus.textContent = "Verifying…";
        // Success persists the session; reload so every fetch is authed.
        verifyEmailCode(sentEmail, code)
          .then(() => location.reload())
          .catch((err: unknown) => {
            codeSubmit.disabled = false;
            codeStatus.textContent =
              err instanceof AuthSendError && err.status === 429
                ? "Too many tries — request a new code."
                : "That code didn't work — check it or resend.";
          });
      });

      body.append(emailForm, codeForm);
    }
  };

  render();

  // The Google door is driven by the backend's /auth/config (single source of
  // truth). Fetch it once and re-render when it lands so the button appears or
  // stays hidden to match the server — no compile-time frontend flag.
  void loadAuthConfig().then((cfg) => {
    authCfg = cfg;
    render();
  });

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
      const resp = await fetchDevicesAuto(inFlight.signal, fetchIncludes());
      devices.setData(resp);
      equity.update(resp.features);
      const visible = devices.visibleFeatures();
      clusters.update(visible);
      freshness.update(
        resp.metadata.snapshot_time,
        visible.length,
        resp.metadata.device_count,
      );
      void overlays.refreshChoropleth();
      void hexDensity.refresh();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("refresh failed", e);
        freshness.error();
      }
    }
  };

  requestRefresh = () => void tick();
  setInterval(tick, REFRESH_MS);
  // Refresh immediately when the tab becomes visible again after being hidden.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void tick();
  });
}
