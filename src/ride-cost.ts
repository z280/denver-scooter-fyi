// Ride cost math for the HUD ticker and summary. Estimates only — the app
// never sees Veo's billing clock, which is why the HUD has clock-sync
// nudges and the summary allows editing the duration.

import { COMPARATOR, RATE_PLANS, type RatePlan, type RatePlanKey } from "./config.ts";
import type { ApiRatePlan } from "./api.ts";

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
  const prev = savedRatePlan();
  try {
    localStorage.setItem(RATE_STORAGE_KEY, key);
  } catch {
    /* private mode — the picker will just show again next ride */
  }
  // The VeoPlus variants collapse to one server value (the Pass is a local
  // pricing refinement the API doesn't model), so only a base-plan change
  // is worth pushing to the account.
  if (syncHook && (!prev || toApiRatePlan(prev) !== toApiRatePlan(key))) {
    syncHook(toApiRatePlan(key));
  }
}

// ---------- Account sync (PUT /api/v1/profile { rate_plan }) ----------
// localStorage above stays the anonymous/offline source of truth; when a
// rider is signed in, the account profile's `rate_plan` wins on the base
// plan and every local change is pushed back. The account module injects
// the push so this module never depends on the API client at runtime.

/** Server representation of a plan: the local-only VeoPlus variant strips
 *  to its base (`resident_plus` → `resident`). */
export function toApiRatePlan(key: RatePlanKey): ApiRatePlan {
  return key === "equity"
    ? "equity"
    : (key.replace(/_plus$/, "") as ApiRatePlan);
}

/** Reconcile a signed-in profile's `rate_plan` with the local choice. The
 *  server wins on the base plan; the local VeoPlus refinement survives when
 *  the bases already agree (the server never knows about the Pass). The
 *  result is persisted to localStorage so the anonymous fallback stays
 *  fresh. A null server value leaves the local choice untouched. */
export function applyServerRatePlan(
  server: ApiRatePlan | null,
): RatePlanKey | null {
  const local = savedRatePlan();
  if (!server) return local;
  if (local && toApiRatePlan(local) === server) return local;
  try {
    localStorage.setItem(RATE_STORAGE_KEY, server);
  } catch {
    /* private mode — server value still returned for this session */
  }
  return server;
}

let syncHook: ((plan: ApiRatePlan) => void) | null = null;

/** Register (or clear) the push-to-account hook saveRatePlan() fires when
 *  the base plan changes. Registered by the account panel while signed in,
 *  so every picker — the HUD adjust panel included — syncs without knowing
 *  about the API. */
export function setRatePlanSyncHook(
  fn: ((plan: ApiRatePlan) => void) | null,
): void {
  syncHook = fn;
}
