// Ride cost math for the HUD ticker and summary. Estimates only — the app
// never sees Veo's billing clock, which is why the HUD has clock-sync
// nudges and the summary allows editing the duration.

import { COMPARATOR, RATE_PLANS, type RatePlan, type RatePlanKey } from "./config.ts";
import { fetchPricing as defaultFetchPricing, type ApiRatePlan } from "./api.ts";

const RATE_STORAGE_KEY = "scooter_fyi.rate_plan";
const VEOPLUS_STORAGE_KEY = "scooter_fyi.veoplus";

export function planFor(key: RatePlanKey): RatePlan {
  return RATE_PLANS.find((p) => p.key === key) ?? RATE_PLANS[0];
}

/** Billable minutes: Veo bills per started minute. */
export function billableMinutes(elapsedMs: number): number {
  return Math.max(1, Math.ceil(elapsedMs / 60_000));
}

/** The two components `rideCostCents` sums, exposed so `estimateWithTax` can
 *  build its `{unlock, perMin}` breakdown from the SAME minute-billing logic
 *  — including the equity plan's 60-free-minutes credit — rather than
 *  re-deriving (and risking silently bypassing) it. This is the one place
 *  that logic lives; both `rideCostCents` and `estimateWithTax` are thin
 *  wrappers around it. */
function costComponents(
  plan: RatePlan,
  elapsedMs: number,
): { unlockCents: number; perMinCents: number } {
  let minutes = billableMinutes(elapsedMs);
  if (plan.key === "equity") {
    // 60 free minutes/day; the ticker can't know how much of today's hour
    // is already spent, so it optimistically prices only the overflow.
    minutes = Math.max(0, minutes - 60);
  }
  // VeoPlus (free unlocks) is a plan variant now — its unlockCents is 0.
  return { unlockCents: plan.unlockCents, perMinCents: minutes * plan.perMinCents };
}

export function rideCostCents(plan: RatePlan, elapsedMs: number): number {
  const { unlockCents, perMinCents } = costComponents(plan, elapsedMs);
  return unlockCents + perMinCents;
}

export function comparatorCostCents(elapsedMs: number): number {
  return COMPARATOR.unlockCents + billableMinutes(elapsedMs) * COMPARATOR.perMinCents;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Tax-aware breakdown (Screen 8's "Unlock $ + Per Min $ + Tax $ = Total $").
// ---------------------------------------------------------------------------

/** Fractional sales-tax rate baked in for offline / pre-`/meta/pricing`
 *  estimates — matches the API's own config default per Phase A1. Belongs on
 *  `config.ts` per the frontend plan's module map ("tax default baked into
 *  config.ts, refreshed from /meta/pricing"); it lives here instead because
 *  this lane's file ownership is `ride-cost.ts` only (`config.ts` isn't in
 *  it) — the identical constant is proposed for `config.ts` in this lane's
 *  `shared_file_edits` for the integrator to land, at which point this local
 *  copy should import it instead of redeclaring it. */
export const DEFAULT_TAX_RATE = 0.0915;

let cachedTaxRate = DEFAULT_TAX_RATE;

/** The tax rate `estimateWithTax` uses when the caller doesn't pass one:
 *  the last value `refreshTaxRate` fetched, or `DEFAULT_TAX_RATE` before the
 *  first successful fetch (or forever, offline / pre-A1). */
export function currentTaxRate(): number {
  return cachedTaxRate;
}

/** Refresh the cached tax rate from `GET /meta/pricing` (`fetchPricing` in
 *  api.ts). Never throws and never blocks a cost estimate on the network —
 *  call it opportunistically (e.g. on ride-wizard open); a failure or an
 *  out-of-range value just leaves the last known rate in place. */
export async function refreshTaxRate(
  fetcher: (signal?: AbortSignal) => Promise<{ tax_rate: number }> = defaultFetchPricing,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const res = await fetcher(signal);
    if (Number.isFinite(res.tax_rate) && res.tax_rate >= 0) {
      cachedTaxRate = res.tax_rate;
    }
  } catch {
    /* offline, or /meta/pricing not deployed yet — keep the last known rate */
  }
  return cachedTaxRate;
}

/** Test-only reset — `refreshTaxRate`'s cache is module-level state so every
 *  caller shares one freshly-fetched rate, which means tests must be able to
 *  put it back the way they found it. */
export function resetTaxRateForTests(rate: number = DEFAULT_TAX_RATE): void {
  cachedTaxRate = rate;
}

export interface RideCostBreakdown {
  /** Unlock fee, cents (0 for VeoPlus variants and the equity plan). */
  unlock: number;
  /** Per-minute charge, cents — already net of the equity plan's 60
   *  free-minutes credit, via the same `costComponents` `rideCostCents` uses. */
  perMin: number;
  /** Sales tax on `unlock + perMin`, cents, rounded to the nearest cent. */
  tax: number;
  /** `unlock + perMin + tax`. Additive-true: a `0` unlock/perMin (equity, or
   *  any VeoPlus variant before the free minutes run out) renders as an
   *  honest `$0.00` component, never folded away. */
  total: number;
}

/** Screen 8's cost breakdown: `{unlock, perMin, tax, total}`, layered on
 *  `rideCostCents`'s existing minute-billing logic (via `costComponents`) so
 *  the equity plan's free-minutes credit — and every other per-plan rule —
 *  keeps applying without being re-implemented here. `taxRate` defaults to
 *  `currentTaxRate()` (the last `refreshTaxRate` result, or
 *  `DEFAULT_TAX_RATE`). */
export function estimateWithTax(
  plan: RatePlan,
  elapsedMs: number,
  taxRate: number = currentTaxRate(),
): RideCostBreakdown {
  const { unlockCents, perMinCents } = costComponents(plan, elapsedMs);
  const subtotal = unlockCents + perMinCents;
  const tax = Math.round(subtotal * taxRate);
  return {
    unlock: unlockCents,
    perMin: perMinCents,
    tax,
    total: subtotal + tax,
  };
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

/** Persist the pick locally and offer it to the account sync hook.
 *  Returns false when localStorage rejected the write (private mode) so
 *  callers can say so instead of claiming the device saved it. The hook
 *  fires on every save — the account layer gates on the SERVER's current
 *  value, which both dedupes no-op PUTs and retries after a failed sync. */
export function saveRatePlan(key: RatePlanKey): boolean {
  let persisted = true;
  try {
    localStorage.setItem(RATE_STORAGE_KEY, key);
  } catch {
    /* private mode — the picker will just show again next ride */
    persisted = false;
  }
  syncHook?.(toApiRatePlan(key));
  return persisted;
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
