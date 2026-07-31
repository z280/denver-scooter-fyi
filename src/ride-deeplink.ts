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
//   `?ride=plate:<PLATE>` → resolved through the GbfsPlates **reverse** lookup
//                           after an explicit awaited `prime()` (at page load no
//                           GPS fix has primed the index yet). A miss — a down
//                           or CORS-closed feed leaves the index empty, and the
//                           plate may simply have left the feed — falls through
//                           to Screen 2's manual-plate path with the plate
//                           prefilled. Never a dead end.
//
// Gating: `wireRideDeepLink()` deliberately does NOT read the
// `scooter-fyi-ride-modal` dev flag itself — the flag belongs at the call site,
// alongside the 🧭 Ride button's own swap, so both entrances into the wizard flip
// together (`if (isRideModalEnabled()) wireRideDeepLink({...})` until F3 makes it
// default-on). Keeping the check out of here also means a test never has to
// arrange localStorage to exercise the plumbing.

import { GbfsPlates } from "./gbfs.ts";
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
  /** Every device id in the last feed response, **unfiltered** —
   *  `devices.allFeatures().map((f) => f.properties.device_id)`. Supplying this
   *  is all the `plate:` form needs: the module primes its own `GbfsPlates`
   *  index and reverse-looks-up over these ids. Deliberately not
   *  `visibleFeatures()`: a leftover map filter must never hide the scooter the
   *  rider is standing next to. */
  deviceIds?(): Iterable<string>;
  /** Override the plate index prime (tests). Defaults to this module's own
   *  `GbfsPlates.prime()`; it never rejects, and a failure just leaves the
   *  index empty (→ the manual-plate path). */
  primePlates?(): Promise<void>;
  /** Override plate → vehicle identifier resolution (tests). Defaults to
   *  `reversePlateLookup` over `deviceIds()`. */
  resolvePlate?(plate: string): string | null;
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

/** Plate comparison form: trimmed, uppercased, inner whitespace and separators
 *  dropped. Veo plates are all-digit today; this keeps a hand-typed
 *  `plate:10-255 43` matching the feed's `1025543`. */
export function normalizePlate(raw: string): string {
  return (raw || "").trim().toUpperCase().replace(/[\s-]+/g, "");
}

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
 *  `plateFor` is `GbfsPlates.cachedPlateFor` (device id → plate, the direction
 *  the index actually holds). Exact match only — a nearest-neighbour guess
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

// ---------- default plate resolution (this module's own GbfsPlates) ----------
//
// devices.ts keeps its GbfsPlates index private and primes it on the first GPS
// fix; a page-load deep link has no fix yet, so the module holds its own
// instance and primes it explicitly. It is built lazily — only a `plate:` link
// ever fetches the public feed — and there is at most one extra fetch per
// session. (A follow-up could hand devices.ts's own index out instead; that is a
// devices.ts change this lane deliberately does not make.)
let deepLinkPlates: GbfsPlates | null = null;

function plateIndex(): GbfsPlates {
  deepLinkPlates ??= new GbfsPlates();
  return deepLinkPlates;
}

function defaultPrimePlates(): Promise<void> {
  return plateIndex().prime();
}

/** Drop the lazily-built plate index (its TTL and failure cooldown with it).
 *  Exists for tests and HMR — production builds it at most once. */
export function resetRideDeepLinkPlates(): void {
  deepLinkPlates = null;
}

function defaultResolvePlate(
  plate: string,
  deviceIds: (() => Iterable<string>) | undefined,
): string | null {
  if (!deviceIds) return null;
  const index = plateIndex();
  return reversePlateLookup(plate, deviceIds(), (id) =>
    index.cachedPlateFor(id),
  );
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

  // Plate form: prime the index first — at page load no GPS fix has primed it,
  // and devices.ts only primes on the first fix, which the poor-GPS path may
  // never get.
  const prime = hooks.primePlates ?? defaultPrimePlates;
  try {
    await prime();
  } catch (e) {
    // prime() never rejects by contract; belt and braces so a future change
    // can't turn a deep link into an unhandled rejection.
    console.error("ride deep link: plate index prime failed", e);
  }
  const resolve =
    hooks.resolvePlate ??
    ((plate: string) => defaultResolvePlate(plate, hooks.deviceIds));
  let vehicleIdentifier: string | null = null;
  try {
    vehicleIdentifier = resolve(link.plate);
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
