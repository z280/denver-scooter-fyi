// Recommended Devices: the persistent, filter-aware home of the ranked
// picks the Find-a-ride interview produces. The wizard collects the
// rider's priority + location and hands them here; this drawer renders the
// ranked list and re-ranks automatically on every filter change and data
// refresh (it reads devices.visibleFeatures(), so the map's filters are
// the list's filters). Selection previews the dashed walking route; the
// bottom button hands off to native walking directions.

import type { Map as MLMap, LngLatBoundsLike } from "maplibre-gl";
import { modelKeyOf, type Devices, type ModelKey } from "./devices.ts";
import type { DeviceProperties } from "./api.ts";
import {
  distanceMeters,
  walkMinutes,
  formatWalk,
  type Locate,
  type LngLat,
} from "./locate.ts";
import { RELIABILITY_LABEL, type ReliabilityTier } from "./reliability.ts";

/** The interview's three ranking factors. All three always contribute;
 *  the one the rider picks just carries most of the weight. */
export type RidePriority = "type" | "quality" | "distance";

/** Model preference, asked only when "Exact device type" is the priority.
 *  Users pick the Veo model by name (Astro / Cosmo / Apollo / Rover). */
export type RideTypeChoice = ModelKey;

export interface RecommendContext {
  from: LngLat;
  priority: RidePriority;
  typeChoice: RideTypeChoice;
}

export interface RankedOption {
  id: string;
  name: string;
  /** Recognized Veo model — drives the row's badge glyph. */
  model: ModelKey | null;
  desc: string;
  lng: number;
  lat: number;
  meters: number;
  battery: number | null;
  tier: ReliabilityTier;
  warnings: string[];
  score: number;
}

// The picked factor DOMINATES: 30× each remaining factor. Break-even math
// for "least walking distance": the two non-priority factors can swing a
// score by at most 0.65 (0.5 × quality range 1.0 + 0.5 × type-nudge range
// 0.3), while distance moves PRIORITY_WEIGHT/MAX_WALK_M per meter — so the
// most extra walk that battery/quality can override is 0.65 × 2500 / 15
// ≈ 108 m, about a minute. Anything farther, the closer device wins.
// (At the previous 6.0 that window was ~270 m — enough to rank a 3-min
// walk below a 5-min one, the exact UAT complaint.)
const PRIORITY_WEIGHT = 15;
const OTHER_WEIGHT = 0.5;
/** Distance beyond which the walk score bottoms out (and candidates are
 *  effectively out of walking range). */
const MAX_WALK_M = 2_500;
const RESULT_COUNT = 5;

/** Score + rank the given features against the rider's context. Pure. */
export function rankDevices(
  feats: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>[],
  ctx: RecommendContext,
): RankedOption[] {
  const wants = ctx.priority;
  const weights: Record<RidePriority, number> = {
    type: wants === "type" ? PRIORITY_WEIGHT : OTHER_WEIGHT,
    quality: wants === "quality" ? PRIORITY_WEIGHT : OTHER_WEIGHT,
    distance: wants === "distance" ? PRIORITY_WEIGHT : OTHER_WEIGHT,
  };
  const wSum = weights.type + weights.quality + weights.distance;

  const out: RankedOption[] = [];
  for (const f of feats) {
    const p = f.properties;
    if (truthy(p.is_disabled) || truthy(p.is_reserved)) continue;
    const [lng, lat] = f.geometry.coordinates;
    const meters = distanceMeters(ctx.from, { lng, lat });
    if (meters > MAX_WALK_M) continue;

    const battery = numOrNull(p.battery_percent);
    const tier = normalizeTier(p.reliability_tier);
    const typeMatch = matchesType(p, ctx.typeChoice);

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
      model: modelKeyOf(p),
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

export interface WalkToRequest {
  name: string;
  plate: string | null;
  vehicleIdentifier: string | null;
  lat: number;
  lng: number;
}

export class RecommendedDevices {
  private ctx: RecommendContext | null = null;
  private selectedId: string | null = null;
  /** Start the in-app walk to the selected scooter. Injected by main.ts;
   *  absent in tests, where the button is simply inert. */
  private walkTo: ((req: WalkToRequest) => void) | null = null;

  setWalkTo(fn: (req: WalkToRequest) => void): void {
    this.walkTo = fn;
  }

  constructor(
    private readonly body: HTMLElement,
    private readonly devices: Devices,
    private readonly locate: Locate,
    private readonly map: MLMap,
  ) {
    // Re-rank on every filter change and data refresh: apply() notifies
    // count listeners after each setData, which is exactly the "the
    // visible fleet changed" signal this list keys off.
    devices.onCountsChange(() => {
      if (this.ctx) this.render();
    });
    this.render();
  }

  /** Interview finished — remember the rider's answers and render. */
  setContext(ctx: RecommendContext): void {
    this.ctx = ctx;
    this.selectedId = null;
    this.render();
  }

  hasContext(): boolean {
    return this.ctx !== null;
  }

  /** Drop the ranked list (used when exiting ride mode resets the map). */
  clear(): void {
    this.ctx = null;
    if (this.selectedId !== null) this.locate.clearLine();
    this.selectedId = null;
    this.render();
  }

  /** Told whether this drawer currently has a ranked list to show, so its
   *  tab can stay out of the menu until it does. A tab whose whole content is
   *  "go and do something else first" is a dead end wearing the same clothes
   *  as the seven tabs that aren't. */
  setAvailabilityListener(fn: (hasList: boolean) => void): void {
    this.onAvailability = fn;
    fn(this.ctx !== null);
  }
  private onAvailability: ((hasList: boolean) => void) | null = null;

  private render(): void {
    this.body.replaceChildren();
    // Fired on every render, including the empty ones: a re-rank that drops
    // to zero results is still a list the rider asked for and can act on
    // ("loosen a filter"), so the tab stays. It is the ABSENCE OF A CONTEXT —
    // never having run Find wheels — that hides it.
    this.onAvailability?.(this.ctx !== null);
    if (!this.ctx) {
      const p = el(
        "p",
        "recommend-empty",
        "Run 🛴 Find wheels and answer one question — your best options land here, ranked, and update live as you filter the map.",
      );
      this.body.append(p);
      return;
    }
    // Prefer a fresh fix over the interview-time one when available.
    const from = this.locate.current() ?? this.ctx.from;
    const ranked = rankDevices(this.devices.visibleFeatures(), {
      ...this.ctx,
      from,
    });

    // A re-rank can drop the selected device (filter change, data refresh).
    // Don't leave the walk preview pointing at a vanished recommendation.
    if (this.selectedId && !ranked.some((o) => o.id === this.selectedId)) {
      this.selectedId = null;
      this.locate.clearLine();
    }

    if (ranked.length === 0) {
      this.body.append(
        el(
          "p",
          "recommend-empty",
          "No rideable devices match your filters within walking range. Loosen a filter or try again in a minute — the fleet moves.",
        ),
      );
      return;
    }

    const intro = el(
      "p",
      "ride-wizard__hint",
      "Ranked for you — tap one to preview the walk. The list follows your filters.",
    );
    const list = el("ol", "ride-options");

    const routeBtn = el(
      "button",
      "login-btn ride-wizard__route",
      // "Route me to selected" described the mechanism and named the row's
      // state; this names what the rider is deciding — and it is the same
      // sentence as the popup's, because it does the same thing.
      "🛴 Use this device",
    );
    routeBtn.type = "button";
    const selectedNow = ranked.find((o) => o.id === this.selectedId) ?? null;
    routeBtn.disabled = selectedNow === null;
    routeBtn.addEventListener("click", () => {
      const sel = ranked.find((o) => o.id === this.selectedId);
      if (!sel) return;
      // In-app. This used to window.open() Google or Apple Maps — the app
      // ranking scooters for you and then handing you to a different app to
      // reach the one you picked.
      this.walkTo?.({
        name: sel.name,
        // The ranked row carries no plate or identifier; the walk only needs
        // somewhere to go, and the arrival panel's Veo handoff is downstream
        // of the ride flow, which resolves both from the map.
        plate: null,
        vehicleIdentifier: null,
        lat: sel.lat,
        lng: sel.lng,
      });
    });

    const rows: HTMLButtonElement[] = [];
    ranked.forEach((opt, i) => {
      const li = el("li");
      const row = el("button", "ride-option");
      row.type = "button";
      if (opt.id === this.selectedId) row.classList.add("is-selected");

      const title = el("div", "ride-option__title");
      title.append(el("span", "ride-option__rank", `${i + 1}`));
      if (opt.model) {
        const glyph = el("img", "ride-option__glyph");
        glyph.src = `/${opt.model}.png`;
        glyph.alt = "";
        title.append(glyph);
      }
      title.append(
        el("strong", undefined, opt.name),
        el("span", "ride-option__desc", opt.desc),
      );

      const meta = el("div", "ride-option__meta");
      meta.textContent = [
        `🚶 ${formatWalk(opt.meters)}`,
        opt.battery !== null ? `🔋 ${Math.round(opt.battery)}%` : "🔋 —",
        RELIABILITY_LABEL[opt.tier],
      ].join(" · ");

      row.append(title, meta);
      if (opt.warnings.length > 0) {
        row.append(
          el("div", "ride-option__warnings", `⚠ ${opt.warnings.join(" · ")}`),
        );
      }
      row.addEventListener("click", () => {
        this.selectedId = opt.id;
        for (const r of rows) r.classList.toggle("is-selected", r === row);
        routeBtn.disabled = false;
        this.previewRoute(from, opt);
      });
      rows.push(row);
      li.append(row);
      list.append(li);
    });

    this.body.append(intro, list, routeBtn);
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

/** Model preference match. A recognized model must match exactly; for
 *  mystery hardware, fall back to posture/form so the preference still
 *  means something. */
function matchesType(p: DeviceProperties, choice: RideTypeChoice): boolean {
  const mk = modelKeyOf(p);
  if (mk) return mk === choice;
  const seated = p.vehicle_use_type === "sitting";
  switch (choice) {
    case "astro":
      return p.form_factor === "scooter" && !seated;
    case "cosmo":
      return p.form_factor === "scooter" && seated;
    case "apollo":
      return p.form_factor === "bicycle";
    case "trike":
      // Nothing in the feed identifies a trike without the model name — the
      // posture/form pair it would match ("seated scooter") is exactly the
      // Cosmo's. Better to match nothing than to pass a Cosmo off as a Rover.
      return false;
  }
}
