// The in-ride companion: a full-screen, glanceable 2D HUD. During a ride it
// shows exactly three things — speed, elapsed cost, equity flag — in huge
// type; everything else (comparisons, distance, advocacy) waits for the
// end-of-ride summary. All browser-API, zero backend.
//
// The clock is an estimate: we can't see Veo's billing clock, so start
// offers a countdown ("I'll start the scooter in N seconds" — set up the
// phone, then scan the QR) and the running clock has ±15s/±1m nudges to
// square it with the Veo app mid-ride.

import maplibregl, { type Map as MLMap } from "maplibre-gl";
import { pointInAny, type IndexedFeature } from "./geo.ts";
import { distanceMeters, type LngLat } from "./locate.ts";
import { FIRST_DEVICE_LAYER, ALL_MODELS, type ModelKey } from "./devices.ts";

/** The slice of the device layer the HUD drives: ride-scoped tap behavior
 *  and on-map visibility filtering. */
export interface RideDeviceControl {
  setRideActive(on: boolean): void;
  setRideModelFilter(models: ReadonlySet<ModelKey> | null): void;
}
import { applyTheme, currentTheme, initialTheme } from "./theme.ts";
import { RATE_PLANS, COMPARATOR, type RatePlanKey } from "./config.ts";
import {
  comparatorCostCents,
  formatCents,
  planFor,
  rideCostCents,
  savedRatePlan,
  saveRatePlan,
} from "./ride-cost.ts";

type HudState = "hidden" | "armed" | "countdown" | "riding" | "summary";

/** Speed EMA smoothing factor — heavy enough that GPS jitter doesn't make
 *  the number twitch, light enough to feel live. */
const SPEED_ALPHA = 0.35;
/** Ignore fixes implying > 45 mph — GPS teleports, not scooters. */
const MAX_PLAUSIBLE_MPS = 20;

/** Follow-cam framing during a ride: zoomed in, pitched for a 3D-ish
 *  perspective, bearing tracking the direction of travel. */
const RIDE_ZOOM = 17;
const RIDE_PITCH = 60;
/** Analog speedometer full-scale, in mph. Denver caps scooters ~15 mph, so
 *  18 gives a little headroom with the top of the dial as a "too fast" zone. */
const SPEEDO_MAX_MPH = 18;
/** Dial sweep: needle travels from -135° (empty, lower-left) to +135°
 *  (full, lower-right) — a classic 270° automotive gauge. */
const SPEEDO_SWEEP = 270;
const SPEEDO_START = -135;
const MPS_TO_MPH = 2.23694;
/** Below this speed heading is unreliable, so we hold the last good bearing
 *  rather than spinning the map on GPS noise while stopped. */
const BEARING_MIN_MPS = 1.5;
const BUILDINGS_3D_LAYER = "ride-buildings-3d";
/** Fraction of viewport height to push the rider's marker BELOW center, so
 *  the road ahead (bearing-up) fills most of the screen instead of the
 *  ground already behind them. ~0.3 puts the dot ~80% of the way down. */
const RIDE_FOCUS_OFFSET_FRAC = 0.3;

/** 3D-building extrusion fill per app theme (paint expression territory —
 *  MapLibre paints don't read CSS variables). */
function buildingsColor(): string {
  return currentTheme() === "dark" ? "#1b2733" : "#d3d7e0";
}

export class RideHud {
  private state: HudState = "hidden";
  private root: HTMLElement;
  private watchId: number | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private tickTimer: number | undefined;
  private countdownTimer: number | undefined;

  private startedAt = 0;
  private smoothedMps = 0;
  private distanceM = 0;
  private lastFix: { pos: LngLat; t: number } | null = null;
  private startPos: LngLat | null = null;
  private startedInZone = false;
  private userMarker: maplibregl.Marker | null = null;
  private lastBearing = 0;
  private following = false;
  private needleEl: SVGElement | null = null;
  /** Map camera state captured on ride start, restored on exit. */
  private savedView: { center: LngLat; zoom: number; pitch: number; bearing: number } | null = null;
  /** Which models the follow-cam shows (HUD "Show" pills). Reset to all at
   *  the start of each ride; all-selected means no filter (also shows
   *  unrecognized hardware), an empty selection shows none. */
  private rideModels = new Set<ModelKey>(ALL_MODELS);

  constructor(
    container: HTMLElement,
    /** Lazily resolves the v1∪v2 equity polygons for the start/end flags. */
    private readonly equityZones: () => Promise<IndexedFeature[]>,
    /** The main map — the HUD frames it and drives a follow-cam during a
     *  ride, so the rider sees themselves move instead of a blank panel. */
    private readonly map: MLMap,
    /** Device layer control: ride-scoped tap behavior + visibility filter. */
    private readonly deviceCtl: RideDeviceControl,
  ) {
    this.root = container;
    this.root.addEventListener("click", (e) => this.onClick(e));
    // Re-acquire the wake lock when the tab comes back (the browser
    // silently releases it on hide).
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.state === "riding") void this.acquireWakeLock();
    });
    // The HUD's night palette rides on the app theme (data-theme CSS), but
    // the 3D buildings are a MapLibre paint — recolor them on theme change,
    // whichever control (HUD ☀/☾, map toggle, sun-sync) flipped it.
    window.addEventListener("scooter:theme", () => {
      if (this.map.getLayer(BUILDINGS_3D_LAYER)) {
        this.map.setPaintProperty(
          BUILDINGS_3D_LAYER,
          "fill-extrusion-color",
          buildingsColor(),
        );
      }
    });
  }

  /** Open the pre-ride start screen. */
  open(): void {
    this.setState("armed");
  }

  private setState(state: HudState): void {
    this.state = state;
    this.root.hidden = state === "hidden";
    // Only the riding state is a transparent frame over the live map; the
    // others are solid cards. `ride-active` on <body> hides the app chrome
    // (drawers, mode pill, chips, map controls) for every non-hidden state.
    const riding = state === "riding";
    this.root.classList.toggle("is-riding", riding);
    document.body.classList.toggle("ride-active", state !== "hidden");
    // Long-press-to-open device taps only while the follow-cam is live; drop
    // the ride-scoped visibility filter whenever we leave it.
    this.deviceCtl.setRideActive(riding);
    if (!riding) this.deviceCtl.setRideModelFilter(null);
    if (state === "armed") this.renderArmed();
  }

  // ---------- Pre-ride ----------

  private renderArmed(): void {
    const rate = savedRatePlan();
    const options = RATE_PLANS.map(
      (p) =>
        `<option value="${p.key}" ${p.key === rate ? "selected" : ""}>${p.label}</option>`,
    ).join("");
    this.root.innerHTML = `
      <div class="hud-card">
        <h2 class="hud-title">Ride companion</h2>
        <p class="hud-note">Speed, ride clock, and a cost estimate while you ride.
          The clock is unofficial — nudge it anytime to match the Veo app.</p>
        <p class="hud-note hud-note--landscape">📱 Mount your phone sideways — the ride view is built for landscape.</p>
        <label class="hud-field">
          <span>My Veo rate</span>
          <select id="hud-rate" class="select">
            <option value="" ${rate ? "" : "selected"} disabled>Choose your rate…</option>
            ${options}
          </select>
        </label>
        <div class="hud-start-row">
          <button type="button" class="hud-btn hud-btn--primary" data-hud="start-now">Start now</button>
          <button type="button" class="hud-btn" data-hud="start-delay">Start in
            <select id="hud-delay" class="hud-inline-select">
              <option>5</option><option selected>10</option><option>15</option><option>30</option>
            </select>s
          </button>
        </div>
        <button type="button" class="hud-btn hud-btn--ghost" data-hud="close">Close</button>
      </div>`;
    // Don't let the delay <select> tap bubble into the surrounding button.
    this.root
      .querySelector("#hud-delay")
      ?.addEventListener("click", (e) => e.stopPropagation());
  }

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-hud]");
    if (!btn) return;
    switch (btn.dataset.hud) {
      case "close":
        this.stopSensors();
        this.exitFollowCam();
        this.exitImmersive();
        this.restoreTheme();
        this.setState("hidden");
        break;
      case "start-now":
        this.beginCountdown(0);
        break;
      case "start-delay": {
        const sel = this.root.querySelector<HTMLSelectElement>("#hud-delay");
        this.beginCountdown(Number(sel?.value ?? 10));
        break;
      }
      case "cancel-countdown":
        window.clearInterval(this.countdownTimer);
        this.setState("armed");
        break;
      case "toggle-night":
        // Flips the WHOLE app (CSS tokens + basemap flavor), not just the
        // HUD — the constructor's theme listener recolors the 3D buildings.
        // Deliberately ride-scoped: no persistence, and sun-sync stays
        // enabled. A mid-ride glance at the other theme must not steal the
        // user's durable preference; exiting the HUD restores the resolved
        // theme (sun-sync > stored > OS).
        applyTheme(currentTheme() === "dark" ? "light" : "dark");
        break;
      case "adjust":
        this.root
          .querySelector(".hud-adjust-panel")
          ?.toggleAttribute("hidden");
        break;
      case "nudge":
        // Shift the *start* time: +15s on the clock means the ride started
        // 15s earlier, so subtract from startedAt.
        this.startedAt -= Number(btn.dataset.ms);
        // Never let the clock go negative.
        this.startedAt = Math.min(this.startedAt, Date.now());
        this.renderTick();
        break;
      case "reset-clock":
        this.startedAt = Date.now();
        this.renderTick();
        break;
      case "end":
        void this.endRide();
        break;
      case "dev": {
        const model = btn.dataset.model as ModelKey;
        if (this.rideModels.has(model)) this.rideModels.delete(model);
        else this.rideModels.add(model);
        const on = this.rideModels.has(model);
        btn.classList.toggle("is-on", on);
        btn.setAttribute("aria-pressed", String(on));
        this.applyRideModels();
        break;
      }
      case "done":
        this.exitImmersive();
        this.restoreTheme();
        this.setState("hidden");
        break;
    }
  }

  /** Chips for the adjust panel's "Show" row, reflecting the current
   *  selection. Deselecting all hides every device from the follow-cam. */
  private deviceChipsMarkup(): string {
    return (["astro", "cosmo", "apollo"] as ModelKey[])
      .map((m) => {
        const on = this.rideModels.has(m);
        const label = m[0].toUpperCase() + m.slice(1);
        return `<button type="button" class="hud-chip${on ? " is-on" : ""}" data-hud="dev" data-model="${m}" aria-pressed="${on}">${label}</button>`;
      })
      .join("");
  }

  /** Push the current model selection to the map. All selected → no filter
   *  (also shows unrecognized hardware); a partial set restricts to those
   *  models; none selected → an empty set hides every device. */
  private applyRideModels(): void {
    const all = this.rideModels.size === ALL_MODELS.length;
    this.deviceCtl.setRideModelFilter(all ? null : new Set(this.rideModels));
  }

  /** Undo any ride-scoped ☀/☾ flips: re-resolve the theme from its durable
   *  sources (sun-sync > stored choice > OS). No-op when nothing changed,
   *  so the basemap isn't rebuilt on every HUD exit. */
  private restoreTheme(): void {
    const resolved = initialTheme();
    if (resolved !== currentTheme()) applyTheme(resolved);
  }

  /** Best-effort immersive landscape: fullscreen the HUD and lock to
   *  landscape. Both are gated by browser support and only work from a user
   *  gesture / while fullscreen, so every call is guarded and failures are
   *  silent — the CSS still adapts to whatever orientation the OS gives us. */
  private async enterImmersive(): Promise<void> {
    try {
      // Fullscreen the whole document, NOT the HUD element — the follow-cam
      // map (#map) is a sibling of the HUD, so fullscreening just the HUD
      // would drop the map out of the fullscreen subtree and leave a black
      // void behind the frame.
      const el = document.documentElement as HTMLElement & {
        requestFullscreen?: () => Promise<void>;
      };
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen();
      }
    } catch {
      /* fullscreen denied — layout still reflows for landscape */
    }
    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      await orientation?.lock?.("landscape");
    } catch {
      /* orientation lock unsupported (desktop, iOS Safari) — that's fine */
    }
  }

  private exitImmersive(): void {
    try {
      (screen.orientation as ScreenOrientation & { unlock?: () => void })?.unlock?.();
    } catch {
      /* nothing to unlock */
    }
    try {
      if (document.fullscreenElement) void document.exitFullscreen?.();
    } catch {
      /* not in fullscreen */
    }
  }

  private beginCountdown(seconds: number): void {
    const rateSel = this.root.querySelector<HTMLSelectElement>("#hud-rate");
    const rate = (rateSel?.value || savedRatePlan() || "") as RatePlanKey | "";
    if (!rate) {
      rateSel?.classList.add("is-error");
      rateSel?.focus();
      return;
    }
    saveRatePlan(rate);

    // Go immersive from within this click gesture (both start paths pass
    // through here): fullscreen + a best-effort landscape lock, because the
    // whole reason Ride mode exists is that the Veo app has no landscape
    // view and the phone is mounted sideways on the handlebars.
    void this.enterImmersive();

    if (seconds <= 0) {
      void this.startRide();
      return;
    }
    this.setState("countdown");
    let remaining = seconds;
    const render = () => {
      this.root.innerHTML = `
        <div class="hud-card hud-card--countdown">
          <div class="hud-countdown">${remaining}</div>
          <p class="hud-note">Scan the QR and start the scooter — the clock
            starts when this hits zero.</p>
          <button type="button" class="hud-btn hud-btn--ghost" data-hud="cancel-countdown">Cancel</button>
        </div>`;
    };
    render();
    this.countdownTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(this.countdownTimer);
        void this.startRide();
      } else {
        render();
      }
    }, 1000);
  }

  // ---------- Riding ----------

  private async startRide(): Promise<void> {
    this.startedAt = Date.now();
    this.smoothedMps = 0;
    this.distanceM = 0;
    this.lastFix = null;
    this.startPos = null;
    this.startedInZone = false;
    this.lastBearing = 0;
    this.rideModels = new Set(ALL_MODELS); // every ride starts showing all
    this.setState("riding");
    this.renderRiding();
    this.enterFollowCam();
    this.startSensors();
    void this.acquireWakeLock();
  }

  /** Pitch the map into follow-cam framing and raise 3D buildings. Camera
   *  then tracks each GPS fix in onFix(). */
  private enterFollowCam(): void {
    const c = this.map.getCenter();
    this.savedView = {
      center: { lng: c.lng, lat: c.lat },
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
    };
    this.map.easeTo({ pitch: RIDE_PITCH, zoom: RIDE_ZOOM, duration: 600 });
    this.addBuildings3D();
    this.userMarker ??= new maplibregl.Marker({ element: makeUserDot() });
    this.following = true;
  }

  /** Restore the pre-ride 2D view and remove ride-only map decorations. */
  private exitFollowCam(): void {
    if (!this.following) return;
    this.following = false;
    this.userMarker?.remove();
    this.removeBuildings3D();
    if (this.savedView) {
      this.map.easeTo({
        center: [this.savedView.center.lng, this.savedView.center.lat],
        zoom: this.savedView.zoom,
        pitch: this.savedView.pitch,
        bearing: this.savedView.bearing,
        duration: 500,
      });
      this.savedView = null;
    } else {
      this.map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
    }
  }

  /** Raise building footprints into extrusions for a 3D feel. The basemap's
   *  vector tiles may not carry heights, so we coalesce to a modest uniform
   *  height — enough for a pitched cityscape. Inserted beneath the device
   *  pins so scooters stay visible. No-op if the buildings layer is absent. */
  private addBuildings3D(): void {
    if (this.map.getLayer(BUILDINGS_3D_LAYER)) return;
    const style = this.map.getStyle();
    const buildings = style.layers?.find(
      (l) => (l as { "source-layer"?: string })["source-layer"] === "buildings",
    ) as { source?: string } | undefined;
    if (!buildings?.source) return;
    const before = this.map.getLayer(FIRST_DEVICE_LAYER)
      ? FIRST_DEVICE_LAYER
      : undefined;
    try {
      this.map.addLayer(
        {
          id: BUILDINGS_3D_LAYER,
          type: "fill-extrusion",
          source: buildings.source,
          "source-layer": "buildings",
          paint: {
            "fill-extrusion-color": buildingsColor(),
            "fill-extrusion-height": [
              "coalesce",
              ["to-number", ["get", "render_height"]],
              ["to-number", ["get", "height"]],
              12,
            ],
            "fill-extrusion-base": [
              "coalesce",
              ["to-number", ["get", "render_min_height"]],
              0,
            ],
            "fill-extrusion-opacity": 0.85,
          },
        },
        before,
      );
    } catch {
      /* source-layer name differs in this basemap — pitched 2D is fine */
    }
  }

  private removeBuildings3D(): void {
    if (this.map.getLayer(BUILDINGS_3D_LAYER)) {
      this.map.removeLayer(BUILDINGS_3D_LAYER);
    }
  }

  private renderRiding(): void {
    // The map IS the screen. Only tiny cutouts sit over it, one per corner:
    //   top-left  — cost (transparent, contrasting)
    //   top-right — digital mph (transparent, contrasting)
    //   bottom-left  — ride clock + End (stop) + adjust (wrench)
    //   bottom-right — analog speedometer with an animated needle
    const rateOptions = RATE_PLANS.map(
      (p) =>
        `<option value="${p.key}" ${p.key === savedRatePlan() ? "selected" : ""}>${p.label}</option>`,
    ).join("");
    this.root.innerHTML = `
      <div class="hud-live">
        <div class="hud-corner hud-corner--tl">
          <span id="hud-cost" class="hud-readout hud-readout--cost"></span>
        </div>
        <div class="hud-corner hud-corner--tr">
          <span class="hud-readout hud-readout--mph"><b id="hud-mph">0</b><i>mph</i></span>
        </div>
        <div id="hud-zone" class="hud-zone-badge" hidden>🏷️ Equity zone</div>
        <div class="hud-corner hud-corner--bl">
          <span id="hud-clock" class="hud-readout hud-readout--clock">0:00</span>
          <div class="hud-cutout-btns">
            <button type="button" class="hud-round-btn hud-round-btn--stop" data-hud="end" aria-label="End ride">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
            </button>
            <button type="button" class="hud-round-btn" data-hud="adjust" aria-label="Adjust time and rate">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.121 2.121 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="hud-corner hud-corner--br">${speedoMarkup()}</div>

        <div class="hud-adjust-panel" hidden>
          <div class="hud-adjust-row">
            <button type="button" class="hud-btn" data-hud="nudge" data-ms="-60000">−1m</button>
            <button type="button" class="hud-btn" data-hud="nudge" data-ms="-15000">−15s</button>
            <button type="button" class="hud-btn" data-hud="reset-clock">reset</button>
            <button type="button" class="hud-btn" data-hud="nudge" data-ms="15000">+15s</button>
            <button type="button" class="hud-btn" data-hud="nudge" data-ms="60000">+1m</button>
          </div>
          <label class="hud-field">
            <span>Rate</span>
            <select id="hud-rate-live" class="select">${rateOptions}</select>
          </label>
          <div class="hud-adjust-row hud-devrow">
            <span class="hud-devrow__label">Show</span>
            ${this.deviceChipsMarkup()}
          </div>
          <div class="hud-adjust-row">
            <button type="button" class="hud-btn" data-hud="toggle-night">☀ / ☾ theme</button>
            <button type="button" class="hud-btn hud-btn--primary" data-hud="adjust">Done</button>
          </div>
        </div>
      </div>`;
    this.needleEl = this.root.querySelector<SVGElement>("#speedo-needle");
    // Live rate change from the adjust panel — recompute the cost ticker.
    this.root
      .querySelector<HTMLSelectElement>("#hud-rate-live")
      ?.addEventListener("change", (e) => {
        saveRatePlan((e.target as HTMLSelectElement).value as RatePlanKey);
        this.renderTick();
      });
    window.clearInterval(this.tickTimer);
    this.tickTimer = window.setInterval(() => this.renderTick(), 1000);
    this.renderTick();
  }

  private renderTick(): void {
    if (this.state !== "riding") return;
    const elapsed = Date.now() - this.startedAt;
    const clock = this.root.querySelector("#hud-clock");
    if (clock) clock.textContent = formatClock(elapsed);
    const cost = this.root.querySelector("#hud-cost");
    const rate = savedRatePlan();
    if (cost && rate) {
      cost.textContent = `≈ ${formatCents(rideCostCents(planFor(rate), elapsed))}`;
    }
    const mphValue = this.smoothedMps * MPS_TO_MPH;
    const mph = this.root.querySelector("#hud-mph");
    if (mph) mph.textContent = String(Math.round(mphValue));
    // Sweep the analog needle (CSS transition animates the motion).
    if (this.needleEl) {
      const clamped = Math.max(0, Math.min(SPEEDO_MAX_MPH, mphValue));
      const deg = SPEEDO_START + (clamped / SPEEDO_MAX_MPH) * SPEEDO_SWEEP;
      this.needleEl.style.transform = `rotate(${deg}deg)`;
    }
  }

  private startSensors(): void {
    if (!("geolocation" in navigator)) return;
    this.watchId = navigator.geolocation.watchPosition(
      (fix) => this.onFix(fix),
      () => {
        /* speed just stays at 0 without fixes; the clock still works */
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }

  private onFix(fix: GeolocationPosition): void {
    const pos: LngLat = { lng: fix.coords.longitude, lat: fix.coords.latitude };
    const t = fix.timestamp;

    if (!this.startPos) {
      this.startPos = pos;
      void this.flagEquityStart(pos);
    }

    // Prefer the device-reported speed; derive from successive fixes when
    // the platform doesn't provide one.
    let mps = fix.coords.speed;
    if ((mps === null || !Number.isFinite(mps)) && this.lastFix) {
      const dt = (t - this.lastFix.t) / 1000;
      if (dt > 0.5) mps = distanceMeters(this.lastFix.pos, pos) / dt;
    }
    if (mps !== null && Number.isFinite(mps!) && mps! <= MAX_PLAUSIBLE_MPS) {
      this.smoothedMps =
        this.smoothedMps + SPEED_ALPHA * (Math.max(0, mps!) - this.smoothedMps);
    }

    if (this.lastFix) {
      const step = distanceMeters(this.lastFix.pos, pos);
      const dt = (t - this.lastFix.t) / 1000;
      // Accumulate only plausible movement so GPS drift while stopped at a
      // light doesn't inflate the ride distance.
      if (dt > 0 && step / dt <= MAX_PLAUSIBLE_MPS && step > 1) {
        this.distanceM += step;
      }
    }
    this.lastFix = { pos, t };

    // Drive the follow-cam: recenter on the rider, bearing-up when moving.
    if (
      fix.coords.heading !== null &&
      Number.isFinite(fix.coords.heading) &&
      this.smoothedMps >= BEARING_MIN_MPS
    ) {
      this.lastBearing = fix.coords.heading;
    }
    this.userMarker?.setLngLat([pos.lng, pos.lat]).addTo(this.map);
    this.map.easeTo({
      center: [pos.lng, pos.lat],
      // Push the focal point down so the rider sits low on screen and sees
      // the road ahead. Screen-space offset, so it stays "toward the bottom"
      // regardless of which way the bearing-up map is rotated.
      offset: [0, this.map.getContainer().clientHeight * RIDE_FOCUS_OFFSET_FRAC],
      bearing: this.lastBearing,
      pitch: RIDE_PITCH,
      zoom: RIDE_ZOOM,
      duration: 700,
    });
    this.renderTick();
  }

  private async flagEquityStart(pos: LngLat): Promise<void> {
    try {
      const zones = await this.equityZones();
      this.startedInZone = pointInAny(pos.lng, pos.lat, zones);
      const el = this.root.querySelector<HTMLElement>("#hud-zone");
      if (el) el.hidden = !this.startedInZone;
    } catch {
      /* zones unavailable — flag simply doesn't show */
    }
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
      };
      this.wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      /* unsupported or denied — screen may sleep, everything else works */
    }
  }

  private stopSensors(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    window.clearInterval(this.tickTimer);
    window.clearInterval(this.countdownTimer);
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  // ---------- Summary ----------

  private async endRide(): Promise<void> {
    const elapsed = Date.now() - this.startedAt;
    const endPos = this.lastFix?.pos ?? null;
    this.stopSensors();
    this.exitFollowCam();

    let endedInZone = false;
    if (endPos) {
      try {
        endedInZone = pointInAny(
          endPos.lng,
          endPos.lat,
          await this.equityZones(),
        );
      } catch {
        /* flag stays off */
      }
    }

    const rate = savedRatePlan();
    const plan = planFor(rate ?? "resident");
    const veoCents = rideCostCents(plan, elapsed);
    const limeCents = comparatorCostCents(elapsed);
    const deltaCents = veoCents - limeCents;
    const miles = this.distanceM / 1609.344;
    const zoneRide = this.startedInZone || endedInZone;

    const rows: string[] = [
      row("Duration", formatClock(elapsed)),
      row("Distance", `${miles.toFixed(1)} mi`),
      row(`Est. Veo cost (${plan.key})`, formatCents(veoCents)),
      row(`With ${COMPARATOR.name}'s typical pricing`, formatCents(limeCents)),
    ];

    const monopolyLine =
      deltaCents > 0
        ? `<p class="hud-note hud-note--pointed">You paid ≈ ${formatCents(deltaCents)} more because Denver has one operator.
           A ${formatCents(COMPARATOR.weekPassCents)}/week ${COMPARATOR.name} pass would cover this in
           ${Math.max(1, Math.ceil(COMPARATOR.weekPassCents / Math.max(1, limeCents)))} rides.</p>`
        : "";

    const zoneLine = zoneRide
      ? `<p class="hud-zone">🏷️ This ride ${this.startedInZone ? "started" : "ended"} in an equity zone —
         Veo owes you the contract discount. Open the Veo app → History and check your receipt.</p>`
      : "";

    this.setState("summary");
    this.root.innerHTML = `
      <div class="hud-card">
        <h2 class="hud-title">Ride summary</h2>
        <dl class="hud-summary">${rows.join("")}</dl>
        ${zoneLine}
        ${monopolyLine}
        <p class="hud-note">Estimates from this device's clock and GPS — your Veo receipt is the bill.</p>
        <button type="button" class="hud-btn hud-btn--primary" data-hud="done">Done</button>
      </div>`;
  }
}

function row(label: string, value: string): string {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The rider's position marker on the follow-cam: a bright dot with a soft
 *  pulsing halo, legible against both day and night basemaps. */
function makeUserDot(): HTMLElement {
  const el = document.createElement("div");
  el.className = "ride-user-dot";
  return el;
}

// ---------- Analog speedometer ----------

const SPEEDO_CX = 100;
const SPEEDO_CY = 100;
const SPEEDO_R = 84;

/** Point on the dial at `mph` and `radius` (SVG coords). 0° = straight up,
 *  angle increases clockwise, matching the needle's rotate(). */
function speedoPoint(mph: number, radius: number): [number, number] {
  const deg = SPEEDO_START + (mph / SPEEDO_MAX_MPH) * SPEEDO_SWEEP;
  const a = (deg * Math.PI) / 180;
  return [SPEEDO_CX + radius * Math.sin(a), SPEEDO_CY - radius * Math.cos(a)];
}

/** Static markup for a car-style dial: outer track, a caution band near the
 *  top of the range, tick marks + numerals every 3 mph, and the needle
 *  (id=speedo-needle) that renderTick() rotates. */
function speedoMarkup(): string {
  const [tx, ty] = speedoPoint(0, SPEEDO_R);
  const [ux, uy] = speedoPoint(SPEEDO_MAX_MPH, SPEEDO_R);
  const track = `<path d="M ${r(tx)} ${r(ty)} A ${SPEEDO_R} ${SPEEDO_R} 0 1 1 ${r(ux)} ${r(uy)}" class="speedo-track"/>`;

  // Caution band 15→18 mph (Denver's cap sits ~15).
  const [cx0, cy0] = speedoPoint(15, SPEEDO_R);
  const [cx1, cy1] = speedoPoint(SPEEDO_MAX_MPH, SPEEDO_R);
  const caution = `<path d="M ${r(cx0)} ${r(cy0)} A ${SPEEDO_R} ${SPEEDO_R} 0 0 1 ${r(cx1)} ${r(cy1)}" class="speedo-caution"/>`;

  let ticks = "";
  for (let t = 0; t <= SPEEDO_MAX_MPH; t++) {
    const major = t % 3 === 0;
    const [x1, y1] = speedoPoint(t, SPEEDO_R - 3);
    const [x2, y2] = speedoPoint(t, SPEEDO_R - (major ? 15 : 8));
    ticks += `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" class="speedo-tick${major ? " speedo-tick--major" : ""}"/>`;
    if (major) {
      const [lx, ly] = speedoPoint(t, SPEEDO_R - 30);
      ticks += `<text x="${r(lx)}" y="${r(ly)}" class="speedo-num">${t}</text>`;
    }
  }

  return `
    <svg class="speedo" viewBox="0 0 200 200" role="img" aria-label="Speedometer, 0 to ${SPEEDO_MAX_MPH} mph">
      <circle cx="100" cy="100" r="96" class="speedo-face"/>
      ${track}${caution}${ticks}
      <text x="100" y="150" class="speedo-unit">mph</text>
      <polygon id="speedo-needle" class="speedo-needle" points="96.5,100 103.5,100 100,26" style="transform: rotate(${SPEEDO_START}deg)"/>
      <circle cx="100" cy="100" r="8" class="speedo-hub"/>
    </svg>`;
}

/** Round to 2 dp to keep the generated SVG path strings compact. */
function r(n: number): number {
  return Math.round(n * 100) / 100;
}
