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

export function rideCostCents(plan: RatePlan, elapsedMs: number): number {
  let minutes = billableMinutes(elapsedMs);
  if (plan.key === "equity") {
    // 60 free minutes/day; the ticker can't know how much of today's hour
    // is already spent, so it optimistically prices only the overflow.
    minutes = Math.max(0, minutes - 60);
  }
  // VeoPlus (free unlocks) is a plan variant now — its unlockCents is 0.
  return plan.unlockCents + minutes * plan.perMinCents;
}

export function comparatorCostCents(elapsedMs: number): number {
  return COMPARATOR.unlockCents + billableMinutes(elapsedMs) * COMPARATOR.perMinCents;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The rider's chosen rate plan. Stored locally for now and labeled as an
 *  estimate; moves to the account profile (and behind sign-in) when the
 *  API's auth ships — see `PUT /api/v1/profile` in the backend's API.md.
 *  Migrates the retired standalone VeoPlus checkbox into the plan key. */
export function savedRatePlan(): RatePlanKey | null {
  try {
    const v = localStorage.getItem(RATE_STORAGE_KEY);
    let key = RATE_PLANS.some((p) => p.key === v) ? (v as RatePlanKey) : null;
    if (localStorage.getItem(VEOPLUS_STORAGE_KEY) === "1") {
      // Legacy flag from when VeoPlus was its own toggle — fold it into
      // the plan variant, then retire the flag.
      if (key === "resident" || key === "visitor") {
        key = `${key}_plus` as RatePlanKey;
        localStorage.setItem(RATE_STORAGE_KEY, key);
      }
      localStorage.removeItem(VEOPLUS_STORAGE_KEY);
    }
    return key;
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
