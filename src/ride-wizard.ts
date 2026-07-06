// "Find a ride" wizard: the guided, rider-facing surface. A short flow —
// location consent → awaiting the device's permission prompt → one
// interview question (what matters most) → a playful processing beat →
// ranked options with routes — that ends with a walking-directions handoff.
//
// Location is strictly consent-first: nothing touches geolocation until the
// rider agrees in step one, and declining hands them straight back to
// Analysis mode (via hooks.onExit). Ranking is fully client-side over the
// already-fetched fleet, so the wizard adds zero network cost.

import type { Map as MLMap, LngLatBoundsLike } from "maplibre-gl";
import type { Devices } from "./devices.ts";
import type { DeviceProperties } from "./api.ts";
import {
  distanceMeters,
  walkMinutes,
  formatWalk,
  walkingDirectionsUrl,
  type Locate,
  type LngLat,
} from "./locate.ts";
import { RELIABILITY_LABEL, type ReliabilityTier } from "./reliability.ts";

/** The interview's three ranking factors. All three always contribute;
 *  the one the rider picks just carries most of the weight. */
export type RidePriority = "type" | "quality" | "distance";

/** Device-type preference, asked only when "Exact device type" is the
 *  priority. Maps onto Veo's line-up via model name + use type. */
export type RideTypeChoice = "standing" | "seated" | "ebike";

export interface RideWizardHooks {
  /** Consent granted — apply the ride map preset (caller guards its own
   *  synthetic events). Runs inside the Yes tap's user gesture. */
  onConsentGranted(): void;
  /** Rider declined consent, dismissed the wizard, or location failed —
   *  return to Analysis mode and reset the map. */
  onExit(): void;
  /** "Log in to save your preferences" hint tapped — open the Account drawer. */
  onLoginHint(): void;
}

interface RankedOption {
  id: string;
  name: string;
  desc: string;
  lng: number;
  lat: number;
  meters: number;
  battery: number | null;
  tier: ReliabilityTier;
  warnings: string[];
  score: number;
}

const PRIORITY_WEIGHT = 2.4; // the picked factor
const OTHER_WEIGHT = 0.8; // the two remaining factors
/** Distance beyond which the walk score bottoms out (and candidates are
 *  effectively out of walking range). */
const MAX_WALK_M = 2_500;
const RESULT_COUNT = 5;

const PROCESSING_LINES = [
  "Scanning the fleet…",
  "Checking batteries…",
  "Measuring your walks…",
  "Dodging the ghost scooters…",
];

export class RideWizard {
  private step: "consent" | "awaiting" | "interview" | "processing" | "results" | null =
    null;
  private priority: RidePriority = "distance";
  private typeChoice: RideTypeChoice = "standing";
  private selected: RankedOption | null = null;
  private cleanupFns: (() => void)[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly devices: Devices,
    private readonly locate: Locate,
    private readonly map: MLMap,
    private readonly hooks: RideWizardHooks,
  ) {}

  /** Open the wizard at the consent step. */
  start(): void {
    this.root.hidden = false;
    this.renderConsent();
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Tear the wizard down without firing onExit (the caller is already
   *  handling the mode change). */
  close(): void {
    this.runCleanups();
    this.step = null;
    this.selected = null;
    this.locate.clearLine();
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private exit(): void {
    this.close();
    this.hooks.onExit();
  }

  private runCleanups(): void {
    for (const fn of this.cleanupFns.splice(0)) fn();
  }

  // ---------- Shared shell ----------

  private shell(title: string, ...content: HTMLElement[]): void {
    this.runCleanups();
    const header = el("header", "ride-wizard__header");
    const h = el("h2", "ride-wizard__title", title);
    h.id = "ride-wizard-title";
    const closeBtn = el("button", "ride-wizard__close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close Find a ride");
    closeBtn.addEventListener("click", () => this.exit());
    header.append(h, closeBtn);

    const body = el("div", "ride-wizard__body");
    body.append(...content);
    this.root.replaceChildren(header, body);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && this.isOpen()) this.exit();
    };
    document.addEventListener("keydown", onKey);
    this.cleanupFns.push(() => document.removeEventListener("keydown", onKey));
  }

  // ---------- Step 1: location consent ----------

  private renderConsent(): void {
    this.step = "consent";
    const p = el(
      "p",
      "ride-wizard__lede",
      "We need to enable location services to activate “Find a ride” mode — is that cool?",
    );
    const sub = el(
      "p",
      "ride-wizard__hint",
      "Your location stays on this device; we only use it to measure walks.",
    );
    const row = el("div", "ride-wizard__actions");
    const yes = el("button", "login-btn", "Yes, use my location");
    yes.type = "button";
    const no = el("button", "login-btn login-btn--secondary", "No thanks");
    no.type = "button";
    yes.addEventListener("click", () => {
      // Still inside the tap: the browser treats the permission prompt as
      // user-initiated.
      this.hooks.onConsentGranted();
      this.renderAwaiting();
    });
    no.addEventListener("click", () => this.exit());
    row.append(yes, no);
    this.shell("Find a ride", p, sub, row);
  }

  // ---------- Step 2: waiting on the device permission prompt ----------

  private renderAwaiting(): void {
    this.step = "awaiting";
    const already = this.locate.current();
    if (already) {
      this.renderInterview();
      return;
    }

    const spinner = el("div", "ride-wizard__spinner");
    spinner.setAttribute("aria-hidden", "true");
    const p = el("p", "ride-wizard__lede", "Awaiting approval on your device…");
    const sub = el(
      "p",
      "ride-wizard__hint",
      "Look for your browser's location prompt.",
    );
    this.shell("Find a ride", spinner, p, sub);

    const unFix = this.locate.onFix(() => {
      if (this.step === "awaiting") this.renderInterview();
    });
    const unErr = this.locate.onError(() => {
      if (this.step === "awaiting") this.renderLocationFailed();
    });
    this.cleanupFns.push(unFix, unErr);
    this.locate.trigger();
  }

  private renderLocationFailed(): void {
    const p = el(
      "p",
      "ride-wizard__lede",
      "We couldn't get your location — it may be blocked for this site.",
    );
    const row = el("div", "ride-wizard__actions");
    const back = el("button", "login-btn login-btn--secondary", "Back to Analysis");
    back.type = "button";
    back.addEventListener("click", () => this.exit());
    row.append(back);
    this.shell("Find a ride", p, row);
  }

  // ---------- Step 3: the interview ----------

  private renderInterview(): void {
    this.step = "interview";
    const q = el(
      "p",
      "ride-wizard__lede",
      "What do you care about MOST? (All three are factored in.)",
    );

    const options: { value: RidePriority; label: string; desc: string }[] = [
      {
        value: "type",
        label: "Exact device type",
        desc: "Get the ride you want, even if it's a longer walk.",
      },
      {
        value: "quality",
        label: "Device quality & battery life",
        desc: "Healthy scooter, full charge.",
      },
      {
        value: "distance",
        label: "Least walking distance",
        desc: "The closest thing that rolls.",
      },
    ];

    const list = el("div", "ride-wizard__choices");
    list.setAttribute("role", "radiogroup");
    const typeRow = el("div", "ride-wizard__typerow");
    typeRow.hidden = this.priority !== "type";

    const choiceBtns: HTMLButtonElement[] = [];
    const syncChoices = (): void => {
      for (const b of choiceBtns) {
        const on = b.dataset.priority === this.priority;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", String(on));
      }
      typeRow.hidden = this.priority !== "type";
    };
    options.forEach((opt, i) => {
      const btn = el("button", "ride-wizard__choice");
      btn.type = "button";
      btn.dataset.priority = opt.value;
      btn.setAttribute("role", "radio");
      btn.append(
        el("strong", undefined, `${i + 1}. ${opt.label}`),
        el("span", "ride-wizard__choice-desc", opt.desc),
      );
      btn.addEventListener("click", () => {
        this.priority = opt.value;
        syncChoices();
      });
      choiceBtns.push(btn);
      list.append(btn);
    });

    // Type sub-picker, shown only when "Exact device type" is the priority.
    typeRow.append(el("span", "ride-wizard__typerow-label", "Which type?"));
    const typeDefs: { value: RideTypeChoice; label: string }[] = [
      { value: "standing", label: "🛴 Standing scooter" },
      { value: "seated", label: "🪑 Seated scooter" },
      { value: "ebike", label: "🚲 E-bike" },
    ];
    const typeBtns: HTMLButtonElement[] = [];
    const syncTypes = (): void => {
      for (const b of typeBtns) {
        const on = b.dataset.type === this.typeChoice;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", String(on));
      }
    };
    for (const def of typeDefs) {
      const b = el("button", "ride-wizard__typechip", def.label);
      b.type = "button";
      b.dataset.type = def.value;
      b.addEventListener("click", () => {
        this.typeChoice = def.value;
        syncTypes();
      });
      typeBtns.push(b);
      typeRow.append(b);
    }
    syncChoices();
    syncTypes();

    const row = el("div", "ride-wizard__actions");
    const go = el("button", "login-btn", "Find my ride");
    go.type = "button";
    go.addEventListener("click", () => this.renderProcessing());
    row.append(go);

    const hint = el("p", "ride-wizard__hint");
    const hintBtn = el("button", "text-btn", "Log in");
    hintBtn.type = "button";
    hintBtn.addEventListener("click", () => this.hooks.onLoginHint());
    hint.append(document.createTextNode("Hint: "), hintBtn, document.createTextNode(" to save your preferences."));

    this.shell("Find a ride", q, list, typeRow, row, hint);
  }

  // ---------- Step 4: processing beat ----------

  private renderProcessing(): void {
    this.step = "processing";
    const spinner = el("div", "ride-wizard__spinner");
    spinner.setAttribute("aria-hidden", "true");
    const line = el("p", "ride-wizard__lede", PROCESSING_LINES[0]);
    this.shell("Finding your ride…", spinner, line);

    let i = 0;
    const rotate = window.setInterval(() => {
      i = (i + 1) % PROCESSING_LINES.length;
      line.textContent = PROCESSING_LINES[i];
    }, 450);
    const done = window.setTimeout(() => {
      window.clearInterval(rotate);
      if (this.step === "processing") this.renderResults();
    }, 1_400);
    this.cleanupFns.push(() => {
      window.clearInterval(rotate);
      window.clearTimeout(done);
    });
  }

  // ---------- Step 5: ranked results ----------

  private renderResults(): void {
    this.step = "results";
    this.selected = null;
    const from = this.locate.current();
    if (!from) {
      this.renderLocationFailed();
      return;
    }
    const ranked = this.rank(from);

    if (ranked.length === 0) {
      const p = el(
        "p",
        "ride-wizard__lede",
        "No rideable devices within walking range right now. Try again in a minute — the fleet moves.",
      );
      const row = el("div", "ride-wizard__actions");
      const back = el("button", "login-btn login-btn--secondary", "Back");
      back.type = "button";
      back.addEventListener("click", () => this.renderInterview());
      row.append(back);
      this.shell("Your best options", p, row);
      return;
    }

    const intro = el(
      "p",
      "ride-wizard__hint",
      "Ranked for you — tap one to preview the walk.",
    );
    const list = el("ol", "ride-options");

    const routeBtn = el("button", "login-btn ride-wizard__route", "Route me to selected");
    routeBtn.type = "button";
    routeBtn.disabled = true;
    routeBtn.addEventListener("click", () => {
      if (!this.selected) return;
      window.open(
        walkingDirectionsUrl({ lng: this.selected.lng, lat: this.selected.lat }),
        "_blank",
        "noopener",
      );
    });

    const rows: HTMLButtonElement[] = [];
    ranked.forEach((opt, i) => {
      const li = el("li");
      const row = el("button", "ride-option");
      row.type = "button";

      const title = el("div", "ride-option__title");
      title.append(
        el("span", "ride-option__rank", `${i + 1}`),
        el("strong", undefined, opt.name),
        el("span", "ride-option__desc", opt.desc),
      );

      const meta = el("div", "ride-option__meta");
      const bits = [
        `🚶 ${formatWalk(opt.meters)}`,
        opt.battery !== null ? `🔋 ${Math.round(opt.battery)}%` : "🔋 —",
        RELIABILITY_LABEL[opt.tier],
      ];
      meta.textContent = bits.join(" · ");

      row.append(title, meta);
      if (opt.warnings.length > 0) {
        row.append(
          el("div", "ride-option__warnings", `⚠ ${opt.warnings.join(" · ")}`),
        );
      }
      row.addEventListener("click", () => {
        this.selected = opt;
        for (const r of rows) r.classList.toggle("is-selected", r === row);
        routeBtn.disabled = false;
        this.previewRoute(from, opt);
      });
      rows.push(row);
      li.append(row);
      list.append(li);
    });

    this.shell("Your best options", intro, list, routeBtn);
  }

  /** Dashed guide line + camera framing user ↔ candidate. */
  private previewRoute(from: LngLat, opt: RankedOption): void {
    this.locate.showLineTo({ lng: opt.lng, lat: opt.lat });
    const bounds: LngLatBoundsLike = [
      [Math.min(from.lng, opt.lng), Math.min(from.lat, opt.lat)],
      [Math.max(from.lng, opt.lng), Math.max(from.lat, opt.lat)],
    ];
    this.map.fitBounds(bounds, { padding: 90, maxZoom: 16.5, duration: 500 });
  }

  // ---------- Ranking ----------

  private rank(from: LngLat): RankedOption[] {
    const wants = this.priority;
    const weights: Record<RidePriority, number> = {
      type: wants === "type" ? PRIORITY_WEIGHT : OTHER_WEIGHT,
      quality: wants === "quality" ? PRIORITY_WEIGHT : OTHER_WEIGHT,
      distance: wants === "distance" ? PRIORITY_WEIGHT : OTHER_WEIGHT,
    };
    const wSum = weights.type + weights.quality + weights.distance;

    const out: RankedOption[] = [];
    for (const f of this.devices.visibleFeatures()) {
      const p = f.properties as DeviceProperties;
      if (truthy(p.is_disabled) || truthy(p.is_reserved)) continue;
      const [lng, lat] = f.geometry.coordinates;
      const meters = distanceMeters(from, { lng, lat });
      if (meters > MAX_WALK_M) continue;

      const battery = numOrNull(p.battery_percent);
      const tier = normalizeTier(p.reliability_tier);
      const typeMatch = matchesType(p, this.typeChoice);

      const distScore = 1 - meters / MAX_WALK_M;
      const batteryScore = battery === null ? 0.4 : battery / 100;
      const tierScore = tier === "ok" ? 1 : tier === "risk" ? 0 : 0.5;
      const qualityScore = 0.55 * batteryScore + 0.45 * tierScore;
      // With no explicit type preference, prefer devices whose model we can
      // actually name over mystery hardware — a mild nudge, not a filter.
      const typeScore =
        wants === "type" ? (typeMatch ? 1 : 0) : p.vehicle_model_name ? 1 : 0.7;

      const score =
        (weights.distance * distScore +
          weights.quality * qualityScore +
          weights.type * typeScore) /
        wSum;

      const warnings: string[] = [];
      const failed = numOrNull(p.number_failed_starts);
      if (failed !== null && failed > 0) {
        warnings.push(`${failed} failed start${failed === 1 ? "" : "s"}`);
      }
      if (truthy(p.has_negative_report)) warnings.push("negative report on file");
      if (tier === "risk") warnings.push("high risk");

      out.push({
        id: p.device_id,
        name: deviceName(p),
        desc: `${walkMinutes(meters)} min away`,
        lng,
        lat,
        meters,
        battery,
        tier,
        warnings,
        score,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, RESULT_COUNT);
  }
}

// ---------- helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeTier(tier: string | null | undefined): ReliabilityTier {
  if (tier === "ok" || tier === "unknown" || tier === "risk") return tier;
  if (tier === "high_risk") return "risk";
  return "unknown";
}

/** Friendly display name: known Veo model → "Veo Astro", else form factor. */
function deviceName(p: DeviceProperties): string {
  const model = (p.vehicle_model_name ?? "").trim();
  if (model) return `Veo ${model[0].toUpperCase()}${model.slice(1).toLowerCase()}`;
  return p.form_factor === "bicycle" ? "E-bike" : "Scooter";
}

/** Type preference match, keyed off the server-corrected `vehicle_use_type`
 *  (sitting vs standing) with model names as the tiebreaker. */
function matchesType(p: DeviceProperties, choice: RideTypeChoice): boolean {
  const model = (p.vehicle_model_name ?? "").trim().toLowerCase();
  const seated = p.vehicle_use_type === "sitting";
  switch (choice) {
    case "standing":
      return model === "astro" || (p.form_factor === "scooter" && !seated);
    case "seated":
      return model === "cosmo" || (p.form_factor === "scooter" && seated);
    case "ebike":
      return model === "apollo" || p.form_factor === "bicycle";
  }
}
