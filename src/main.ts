import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { fetchDevices, type BoundaryLayer } from "./api.ts";
import { createMap } from "./map.ts";
import { Devices, type DeviceFilter } from "./devices.ts";
import { Overlays } from "./overlays.ts";
import { renderCompliance } from "./compliance.ts";
import { Freshness } from "./freshness.ts";
import { Clusters } from "./clusters.ts";
import { OVERLAYS, REFRESH_MS } from "./config.ts";

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
);

// Kick off network-independent work immediately so dots/compliance arrive fast.
const devicesPromise = fetchDevices().catch((e) => {
  console.error("initial device fetch failed", e);
  return null;
});
void renderCompliance(need("compliance"));

map.on("load", async () => {
  devices.addLayers();
  buildLayerToggles();
  wireDeviceFilter();
  wireChoropleth();
  wireNeighborhoodSearch();
  wireResponsivePanel();

  const resp = await devicesPromise;
  if (resp) {
    devices.setData(resp);
    clusters.update(resp.features);
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
  }
}

function wireDeviceFilter(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".seg-btn"),
  );
  const select = (btn: HTMLButtonElement) => {
    for (const b of btns) {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    }
    devices.setFilter(btn.dataset.filter as DeviceFilter);
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

function wireResponsivePanel(): void {
  const toggle = need<HTMLButtonElement>("controls-toggle");
  const close = need<HTMLButtonElement>("controls-close");
  const panel = need("controls-panel");

  const setOpen = (open: boolean) => {
    panel.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () =>
    setOpen(!panel.classList.contains("is-open")),
  );
  close.addEventListener("click", () => {
    setOpen(false);
    toggle.focus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("is-open")) {
      setOpen(false);
      toggle.focus();
    }
  });
}

// ---------- Refresh loop ----------

function startRefreshLoop(): void {
  let inFlight: AbortController | null = null;

  const tick = async () => {
    if (document.hidden) return;
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const resp = await fetchDevices(inFlight.signal);
      devices.setData(resp);
      clusters.update(resp.features);
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
