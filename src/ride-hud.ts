// The in-ride companion: a full-screen, glanceable 2D HUD. During a ride it
// shows exactly three things — speed, elapsed cost, equity flag — in huge
// type; everything else (comparisons, distance, advocacy) waits for the
// end-of-ride summary. All browser-API, zero backend.
//
// The clock is an estimate: we can't see Veo's billing clock, so start
// offers a countdown ("I'll start the scooter in N seconds" — set up the
// phone, then scan the QR) and the running clock has ±15s/±1m nudges to
// square it with the Veo app mid-ride.

import { pointInAny, type IndexedFeature } from "./geo.ts";
import { distanceMeters, type LngLat } from "./locate.ts";
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
  private night = window.matchMedia("(prefers-color-scheme: dark)").matches;

  constructor(
    container: HTMLElement,
    /** Lazily resolves the v1∪v2 equity polygons for the start/end flags. */
    private readonly equityZones: () => Promise<IndexedFeature[]>,
  ) {
    this.root = container;
    this.root.addEventListener("click", (e) => this.onClick(e));
    // Re-acquire the wake lock when the tab comes back (the browser
    // silently releases it on hide).
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.state === "riding") void this.acquireWakeLock();
    });
  }

  /** Open the pre-ride start screen. */
  open(): void {
    this.setState("armed");
  }

  private setState(state: HudState): void {
    this.state = state;
    this.root.hidden = state === "hidden";
    this.root.classList.toggle("is-night", this.night);
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
        this.night = !this.night;
        this.root.classList.toggle("is-night", this.night);
        break;
      case "adjust":
        this.root
          .querySelector(".hud-adjust")
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
      case "done":
        this.setState("hidden");
        break;
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
    this.setState("riding");
    this.renderRiding();
    this.startSensors();
    void this.acquireWakeLock();
  }

  private renderRiding(): void {
    this.root.innerHTML = `
      <div class="hud-live">
        <div class="hud-speed"><span id="hud-mph">0</span><span class="hud-speed-unit">mph</span></div>
        <button type="button" class="hud-clockcost" data-hud="adjust" aria-label="Ride clock and cost — tap to adjust the clock">
          <span id="hud-clock">0:00</span>
          <span id="hud-cost" class="hud-cost"></span>
        </button>
        <div class="hud-adjust" hidden>
          <button type="button" class="hud-btn" data-hud="nudge" data-ms="-60000">−1m</button>
          <button type="button" class="hud-btn" data-hud="nudge" data-ms="-15000">−15s</button>
          <button type="button" class="hud-btn" data-hud="reset-clock">reset</button>
          <button type="button" class="hud-btn" data-hud="nudge" data-ms="15000">+15s</button>
          <button type="button" class="hud-btn" data-hud="nudge" data-ms="60000">+1m</button>
        </div>
        <div id="hud-zone" class="hud-zone" hidden>🏷️ Started in an equity zone — discount applies</div>
        <div class="hud-bottom">
          <button type="button" class="hud-btn hud-btn--ghost" data-hud="toggle-night">☀/☾</button>
          <button type="button" class="hud-btn hud-btn--end" data-hud="end">End ride</button>
        </div>
      </div>`;
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
    const mph = this.root.querySelector("#hud-mph");
    if (mph) mph.textContent = String(Math.round(this.smoothedMps * 2.23694));
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
