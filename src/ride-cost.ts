// Ride cost math for the HUD ticker and summary. Estimates only — the app
// never sees Veo's billing clock, which is why the HUD has clock-sync
// nudges and the summary allows editing the duration.

import { COMPARATOR, RATE_PLANS, type RatePlan, type RatePlanKey } from "./config.ts";

const RATE_STORAGE_KEY = "scooter_fyi.rate_plan";
const VEOPLUS_STORAGE_KEY = "scooter_fyi.veoplus";

export function planFor(key: RatePlanKey): RatePlan {
  return RATE_PLANS.find((p) => p.key === key) ?? RATE_PLANS[0];
}

/** Billable minutes: Veo bills per started minute. */
export function billableMinutes(elapsedMs: number): number {
  return Math.max(1, Math.ceil(elapsedMs / 60_000));
}

export function rideCostCents(
  plan: RatePlan,
  elapsedMs: number,
  /** VeoPlus Pass waives the per-ride unlock (start) fee. */
  waiveUnlock = false,
): number {
  let minutes = billableMinutes(elapsedMs);
  if (plan.key === "equity") {
    // 60 free minutes/day; the ticker can't know how much of today's hour
    // is already spent, so it optimistically prices only the overflow.
    minutes = Math.max(0, minutes - 60);
  }
  const unlock = waiveUnlock ? 0 : plan.unlockCents;
  return unlock + minutes * plan.perMinCents;
}

export function comparatorCostCents(elapsedMs: number): number {
  return COMPARATOR.unlockCents + billableMinutes(elapsedMs) * COMPARATOR.perMinCents;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The rider's chosen rate plan. Stored locally for now and labeled as an
 *  estimate; moves to the account profile (and behind sign-in) when the
 *  API's auth ships — see docs/API_REQUIREMENTS.md §2.4. */
export function savedRatePlan(): RatePlanKey | null {
  try {
    const v = localStorage.getItem(RATE_STORAGE_KEY);
    return v === "resident" || v === "visitor" || v === "equity" ? v : null;
  } catch {
    return null;
  }
}

export function saveRatePlan(key: RatePlanKey): void {
  try {
    localStorage.setItem(RATE_STORAGE_KEY, key);
  } catch {
    /* private mode — the picker will just show again next ride */
  }
}

/** VeoPlus Pass membership (free unlocks). Stored locally alongside the rate;
 *  moves to the account profile when auth ships. */
export function savedVeoPlus(): boolean {
  try {
    return localStorage.getItem(VEOPLUS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveVeoPlus(on: boolean): void {
  try {
    if (on) localStorage.setItem(VEOPLUS_STORAGE_KEY, "1");
    else localStorage.removeItem(VEOPLUS_STORAGE_KEY);
  } catch {
    /* private mode — the toggle just defaults off next ride */
  }
}
