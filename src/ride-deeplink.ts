// `?ride=` deep-link plumbing: a scanned QR / shared link that lands the rider
// straight in the ride wizard on the device they are standing next to.
//
// Shape (frontend plan, "Deep link" + phase F1): the param is read at load and
// stripped with `history.replaceState`, exactly like `?ml=` in
// auth-magic-link.ts — but with two deliberate differences:
//
//  1. **No reload.** The `?ml=` success path ends in `location.reload()` so
//     every later fetch goes out authenticated. `?ride=` must not: it opens the
//     modal directly, in this document, with the map already loaded behind it.
//  2. **`?ml=` is consumed first** when both params are present, so the
//     post-redeem reload re-enters the app authenticated with `?ride=` still in
//     the URL. Until the magic link settles we leave `?ride=` completely alone —
//     stripping it before the reload would throw the deep link away.
//
// Two param forms:
//   `?ride=<16 hex>`      → the API's `vehicle_identifier`, used as-is.
//   `?ride=plate:<PLATE>` → resolved through our public
//                           `GET /api/v1/vehicles/resolve` (plates.ts's
//                           `resolvePlate`) — public because the link already
//                           carries the plate, and the answer is only the ids
//                           our public feed publishes. Works signed out, needs
//                           no GPS fix, and never touches Veo's servers. A miss
//                           (no such plate, ambiguous, API down or rate
//                           limited) falls through to Screen 2's manual-plate
//                           path with the plate prefilled. Never a dead end.
//
// Gating: `wireRideDeepLink()` deliberately does NOT read the
// `scooter-fyi-ride-modal` dev flag itself — the flag belongs at the call site,
// alongside the 🧭 Ride button's own swap, so both entrances into the wizard flip
// together (`if (isRideModalEnabled()) wireRideDeepLink({...})` until F3 makes it
// default-on). Keeping the check out of here also means a test never has to
// arrange localStorage to exercise the plumbing.

import { normalizePlate as sharedNormalizePlate, resolvePlate as resolvePlateRemote } from "./plates.ts";
import { openRideModal, type RideModalEntry } from "./ride-modal.ts";

/** The deep-link param. */
export const RIDE_PARAM = "ride";
/** Mirrors auth-magic-link.ts's module-private `MAGIC_PARAM`. */
export const MAGIC_LINK_PARAM = "ml";
/** Prefix selecting the plate form, matched case-insensitively. */
export const PLATE_PREFIX = "plate:";
/** `vehicle_identifier` is exactly 16 hex chars (see api.ts). */
export const VEHICLE_IDENTIFIER_RE = /^[0-9a-fA-F]{16}$/;

export type RideDeepLink =
  | { kind: "vehicle"; vehicleIdentifier: string }
  | { kind: "plate"; plate: string };

export interface RideDeepLinkHooks {
  /** Override plate → `vehicle_identifier` resolution (tests). Defaults to the
   *  public `/vehicles/resolve` endpoint (plates.ts's `resolvePlate`). May be
   *  sync or async; null (or a rejection) is a miss → the manual-plate path. */
  resolvePlate?(plate: string): string | null | Promise<string | null>;
  /** Injected for tests; defaults to `ride-modal.ts`'s `openRideModal`. */
  openRideModal?(entry: RideModalEntry): void;
  /** The `consumePendingMagicLink()` promise main.ts already holds. Resolving
   *  `true` means the token was redeemed and a `location.reload()` is coming —
   *  we stand down and let the reloaded document handle `?ride=`. Omit it and
   *  we fall back to watching for the param's removal. */
  magicLinkSettled?: Promise<boolean | void>;
}

/** Parse a raw `ride` param value. Returns null for anything that is neither a
 *  16-hex identifier nor a non-empty `plate:` value. */
export function parseRideParam(raw: string | null | undefined): RideDeepLink | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (value.slice(0, PLATE_PREFIX.length).toLowerCase() === PLATE_PREFIX) {
    const plate = normalizePlate(value.slice(PLATE_PREFIX.length));
    return plate === "" ? null : { kind: "plate", plate };
  }
  if (VEHICLE_IDENTIFIER_RE.test(value)) {
    // The API emits lowercase hex; normalize so a hand-typed or
    // uppercase-mangled link still matches feature ids exactly.
    return { kind: "vehicle", vehicleIdentifier: value.toLowerCase() };
  }
  return null;
}

/** Plate comparison form — see plates.ts, which owns it now (the API's
 *  `/vehicles/resolve` normalizes the same way server-side). Re-exported so
 *  existing importers keep working. */
export const normalizePlate = sharedNormalizePlate;

/** Read the deep link without touching the URL. */
export function readRideDeepLink(href: string = location.href): RideDeepLink | null {
  try {
    return parseRideParam(new URL(href).searchParams.get(RIDE_PARAM));
  } catch {
    return null;
  }
}

/** Is a magic-link token still sitting in the URL? */
export function hasPendingMagicLink(href: string = location.href): boolean {
  try {
    return new URL(href).searchParams.get(MAGIC_LINK_PARAM) !== null;
  } catch {
    return false;
  }
}

/** Strip `?ride=` from the address bar, leaving every other param and the hash
 *  intact — so a refresh doesn't reopen the wizard. Never reloads. */
export function stripRideParam(): void {
  try {
    const url = new URL(location.href);
    if (url.searchParams.get(RIDE_PARAM) === null) return;
    url.searchParams.delete(RIDE_PARAM);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (e) {
    console.error("ride deep link: could not strip the param", e);
  }
}

/** Read and strip in one step (the `?ml=` read-act-replaceState shape, minus
 *  the reload). Returns what was there, or null. */
export function consumeRideDeepLink(): RideDeepLink | null {
  const link = readRideDeepLink();
  stripRideParam();
  return link;
}

/** Exact-match reverse lookup: plate → device id, over the device ids given.
 *  `plateFor` is `PlateIndex.cachedPlateFor` (device id → plate, the direction
 *  the index actually holds — signed-in only, so for a guest this never
 *  matches and callers go on to `/vehicles/resolve`). Exact match only — a nearest-neighbour guess
 *  could hand back the wrong scooter, and missing beats wrong. */
export function reversePlateLookup(
  plate: string,
  deviceIds: Iterable<string>,
  plateFor: (deviceId: string) => string | null,
): string | null {
  const want = normalizePlate(plate);
  if (want === "") return null;
  for (const id of deviceIds) {
    let found: string | null = null;
    try {
      found = plateFor(id);
    } catch {
      continue;
    }
    if (found !== null && normalizePlate(found) === want) return id;
  }
  return null;
}

// ---------- default plate resolution ----------

/** Plate → `vehicle_identifier` via the public `/vehicles/resolve` endpoint.
 *  Null on a miss or when the API couldn't be asked. */
async function defaultResolvePlate(plate: string): Promise<string | null> {
  const r = await resolvePlateRemote(plate);
  return r.kind === "hit" ? r.vehicleIdentifier : null;
}

/** How long the fallback watcher waits for `?ml=` to be consumed before giving
 *  up and handling `?ride=` anyway (redemption is a single API round trip). */
const MAGIC_LINK_WAIT_MS = 10_000;
const MAGIC_LINK_POLL_MS = 100;

/**
 * The integrator's entry point: consume `?ride=` (after `?ml=`, never
 * reloading) and open the wizard. Safe to call unconditionally at startup —
 * with no param it does nothing.
 */
export function wireRideDeepLink(hooks: RideDeepLinkHooks = {}): void {
  // Nothing to do — and, crucially, nothing to strip.
  if (readRideDeepLink() === null) return;

  if (hasPendingMagicLink()) {
    void waitForMagicLink(hooks.magicLinkSettled).then((redeemed) => {
      // Redeemed → auth-magic-link's caller reloads; the fresh document runs
      // this again with `?ride=` intact and authenticated. Touching the URL now
      // would race that reload and lose the deep link.
      if (redeemed) return;
      return runRideDeepLink(hooks);
    });
    return;
  }
  void runRideDeepLink(hooks);
}

/** Resolves `true` when a magic link was redeemed (a reload is imminent). */
function waitForMagicLink(
  settled: Promise<boolean | void> | undefined,
): Promise<boolean> {
  if (settled) {
    return settled.then(
      (ok) => ok === true,
      // A rejected promise means redemption failed loudly — no reload is
      // coming, so the deep link is ours to handle.
      () => false,
    );
  }
  // No promise handed in: watch the URL instead. auth-magic-link.ts strips the
  // param in a `finally`, so its disappearance marks "settled"; a success also
  // reloads, which ends this document before the timer matters.
  return new Promise<boolean>((resolve) => {
    if (!hasPendingMagicLink()) {
      resolve(false);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (!hasPendingMagicLink() || Date.now() - started >= MAGIC_LINK_WAIT_MS) {
        clearInterval(timer);
        resolve(false);
      }
    }, MAGIC_LINK_POLL_MS);
  });
}

async function runRideDeepLink(hooks: RideDeepLinkHooks): Promise<void> {
  const link = consumeRideDeepLink();
  if (!link) return;
  const open = hooks.openRideModal ?? openRideModal;

  if (link.kind === "vehicle") {
    open({ vehicleIdentifier: link.vehicleIdentifier });
    return;
  }

  // Plate form: ask our API which vehicle carries this plate. No GPS fix and
  // no loaded map are needed — the answer is the vehicle's own identifier,
  // which Screen 2 matches against the feed once it has one.
  const resolve = hooks.resolvePlate ?? defaultResolvePlate;
  let vehicleIdentifier: string | null = null;
  try {
    const found = await resolve(link.plate);
    vehicleIdentifier = found ? found.toLowerCase() : null;
  } catch (e) {
    console.error("ride deep link: plate lookup failed", e);
  }
  // Hit → Screen 2 preselected (the plate rides along to prefill the confirm
  // field). Miss → Screen 2's manual-plate path, prefilled. Never a dead end.
  open(
    vehicleIdentifier
      ? { vehicleIdentifier, plate: link.plate }
      : { plate: link.plate },
  );
}
