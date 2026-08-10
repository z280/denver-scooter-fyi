// Screens 2 + 2.5 (frontend plan, `ride-screen-select.ts` row; master Part 0
// Screen 2, Decision 4, Risk 11). This is DISAMBIGUATION, not discovery —
// "there should be literally 1 device within 4m of the user in most cases…
// 'next to' vs 'nearby'." The existing 🛴 Find wheels wizard and Recommended
// drawer remain the discovery surfaces and are untouched by this program.
//
// ---------------------------------------------------------------------------
// DECISION — reusing `ride-deeplink.ts`'s reverse plate lookup instead of
// adding one to `GbfsPlates`.
//
// The lane brief suggested adding a `plate -> device_id` method to
// `GbfsPlates` itself (`cachedPlateFor` only goes the other way). But
// `ride-deeplink.ts` already ships exactly that capability as a tested, pure
// export — `reversePlateLookup(plate, deviceIds, plateFor)`, an exact-match
// scan over `cachedPlateFor` with the same case/separator normalization this
// screen needs for its OWN manual-plate path (a rider who types
// "10-25 543" should match the same way a `?ride=plate:10-25 543` deep link
// does). Building a SECOND normalization inside `gbfs.ts` would risk the two
// drifting apart, and `gbfs.ts` sitting one layer below `ride-deeplink.ts`
// architecturally is the wrong place to import `ride-deeplink.ts`'s
// normalization back into. So: this screen imports `reversePlateLookup` (and
// leaves `gbfs.ts` untouched) rather than adding a redundant reverse index.
// The "reverse lookup on GbfsPlates" the plan asks for still happens — it's
// just implemented as a scan over `GbfsPlates.cachedPlateFor`, exactly like
// the deep-link path already does.
// ---------------------------------------------------------------------------
//
// Screen 2.5 (the Usuals picker) registers as its OWN screen, id `"2.5"` —
// ride-modal.ts already has first-class support for it as a non-flow detour
// (`RIDE_SCREEN_IDS` includes `"2.5"`, `ctx.go("2.5")` works, and `next()`
// on a screen outside `RIDE_SCREEN_FLOW` falls back to `back()` by design —
// see that file's own comments). So this is a real registered screen, not an
// inline overlay bolted onto Screen 2's own factory.
//
// Screen 2's SECONDARY pane is shared real estate: "Ride Mode Options" is
// `ride-settings.ts`'s content (a sibling F2 lane, not yet landed), but only
// ONE factory can own `registerRideScreen("2", …)`. This module owns that
// registration (it owns Screens 2 + 2.5 per the lane split) and exposes
// `deps.buildOptionsPanel` as the seam `ride-settings.ts` plugs into — see
// `RideOptionsPanelBuilder` below and the lane report's `interface_contract`.
// Until that lands, `buildFallbackOptionsPanel` renders a working
// [Usuals] / [NEXT >>] pair so the flow is never a dead end on its own.

import {
  registerRideScreen,
  type RideScreen,
  type RideScreenContext,
} from "./ride-modal.ts";
import { distanceMeters, type Locate, type LngLat } from "./locate.ts";
import type { Devices, ModelKey } from "./devices.ts";
import { modelKeyOf } from "./devices.ts";
import { MODEL_NAMES } from "./model-catalog.ts";
import { GbfsPlates } from "./gbfs.ts";
import {
  VEHICLE_IDENTIFIER_RE,
  reversePlateLookup,
} from "./ride-deeplink.ts";
import {
  createRideKeypad,
  applyNativeNumericInput,
  sanitizeNumeric,
  type RideKeypadHandle,
} from "./ride-keypad.ts";
import { isAuthenticated } from "./map-auth.js";
import { markUndoFree } from "./ios-shake-undo.ts";
import {
  listRideUsuals as defaultListRideUsuals,
  type DeviceProperties,
  type DevicesResponse,
  type RideUsual,
} from "./api.ts";
import { applyCascades, optionsFromRideUsual } from "./ride-settings.ts";
import type { RideSessionStore } from "./ride-session.ts";

// ---------------------------------------------------------------------------
// Tunables (master Decision 4 / Risk 11)
// ---------------------------------------------------------------------------

/** Show the 6 nearest devices… */
export const MAX_CANDIDATES = 6;
/** …within 150 m. */
export const MAX_RANGE_M = 150;
/** Auto-preselect the nearest device when it is at most this close… */
export const AUTO_PRESELECT_MAX_M = 8;
/** …AND the fix's accuracy is at most this good. Both inclusive (`<=`). */
export const AUTO_PRESELECT_MAX_ACCURACY_M = 15;
/** Above this accuracy (or with no fix at all) the manual-plate path is the
 *  primary one — a soft hint, not a gate; the ranked list still shows. */
export const WEAK_ACCURACY_HINT_M = 25;

const METERS_TO_FEET = 3.280839895;

/** Feet, rounded — distances in this screen are always feet, never the
 *  minutes/miles `formatWalk` (locate.ts) speaks; the two serve different
 *  scales ("next to" vs "worth the walk"). */
export function formatFeet(meters: number): string {
  return `${Math.round(meters * METERS_TO_FEET)} ft`;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface Candidate {
  /** GBFS `device_id` / `bike_id` — what `GbfsPlates` keys on. */
  deviceId: string;
  /** 16-hex, lowercased — the API's `vehicle_identifier`; what actually gets
   *  stored on the ride session and sent to `POST /tracked-rides`. */
  vehicleIdentifier: string;
  model: ModelKey | null;
  lng: number;
  lat: number;
  /** Haversine metres from the resolved fix; `Infinity` with no fix. */
  meters: number;
  plate: string | null;
}

/** One feature → one Candidate, or null when it can't be ride-mode-selected
 *  (no usable 16-hex `vehicle_identifier` — a device the API could never
 *  start a tracked ride against — or non-finite coordinates). */
export function candidateFromFeature(
  feature: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>,
  fix: LngLat | null,
  resolvePlate: (deviceId: string) => string | null,
): Candidate | null {
  const p = feature.properties;
  const vid = (p.vehicle_identifier ?? "").toLowerCase();
  if (!VEHICLE_IDENTIFIER_RE.test(vid)) return null;
  const coords = feature.geometry?.coordinates;
  const lng = coords?.[0];
  const lat = coords?.[1];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return {
    deviceId: p.device_id,
    vehicleIdentifier: vid,
    model: modelKeyOf(p),
    lng,
    lat,
    meters: fix ? distanceMeters(fix, { lng, lat }) : Number.POSITIVE_INFINITY,
    plate: (p.vehicle_plate ? String(p.vehicle_plate) : null) ?? resolvePlate(p.device_id),
  };
}

/** Every candidate the current feed can support, keyed by `device_id` — the
 *  full lookup table both ranking AND the manual-plate reverse resolution
 *  share (a typed plate can resolve to a device outside the ranked window). */
export function candidatesById(
  features: DevicesResponse["features"],
  fix: LngLat | null,
  resolvePlate: (deviceId: string) => string | null,
): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const f of features) {
    const c = candidateFromFeature(f, fix, resolvePlate);
    if (c) out.set(c.deviceId, c);
  }
  return out;
}

/** Plain distance sort — no `rankDevices` weighting (priority weights are
 *  meaningless at 4 m). */
export function rankByDistance(
  all: ReadonlyMap<string, Candidate>,
  opts: { maxMeters?: number; limit?: number } = {},
): Candidate[] {
  const maxMeters = opts.maxMeters ?? MAX_RANGE_M;
  const limit = opts.limit ?? MAX_CANDIDATES;
  return [...all.values()]
    .filter((c) => c.meters <= maxMeters)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, limit);
}

/** Master Risk 11: auto-preselect only within 8 m AND with accuracy ≤15 m —
 *  both boundaries inclusive. Missing/unknown accuracy never preselects. */
export function shouldAutoPreselect(
  nearest: Candidate | undefined,
  accuracyM: number | null | undefined,
): boolean {
  if (!nearest) return false;
  if (!(nearest.meters <= AUTO_PRESELECT_MAX_M)) return false;
  if (accuracyM === null || accuracyM === undefined) return false;
  return accuracyM <= AUTO_PRESELECT_MAX_ACCURACY_M;
}

// ---------------------------------------------------------------------------
// Manual-plate resolution
// ---------------------------------------------------------------------------

export interface PlatesLike {
  prime(): Promise<void>;
  cachedPlateFor(deviceId: string): string | null;
}

export type PlateCheckResult =
  | { kind: "empty" }
  | { kind: "already_selected" }
  | { kind: "switch"; candidate: Candidate }
  | { kind: "unresolved" };

/** Resolve a typed plate against the current feed. `selectedDeviceId` is the
 *  device (if any) already highlighted, so a match against IT is a silent
 *  confirmation rather than a "switch". A plate that resolves to a
 *  `device_id` the CURRENT feed snapshot doesn't have a candidate for (left
 *  the feed since `deviceIds` was captured, or never had a usable
 *  `vehicle_identifier`) reads as `unresolved`, exactly like a plate nobody
 *  has ever heard of — "stays on manual-plate path if not in feed". */
export function checkTypedPlate(
  typedPlate: string,
  selectedDeviceId: string | null,
  deviceIds: Iterable<string>,
  plateFor: (deviceId: string) => string | null,
  all: ReadonlyMap<string, Candidate>,
): PlateCheckResult {
  const plate = typedPlate.trim();
  if (!plate) return { kind: "empty" };
  const deviceId = reversePlateLookup(plate, deviceIds, plateFor);
  if (!deviceId) return { kind: "unresolved" };
  if (deviceId === selectedDeviceId) return { kind: "already_selected" };
  const candidate = all.get(deviceId);
  if (!candidate) return { kind: "unresolved" };
  return { kind: "switch", candidate };
}

// ---------------------------------------------------------------------------
// Selection + session sync
// ---------------------------------------------------------------------------

export type Selection =
  | { kind: "device"; candidate: Candidate }
  | { kind: "own" }
  | { kind: "manual" }
  | null;

function titleFor(c: Candidate): string {
  // MODEL_NAMES, never a capitalized key: the "trike" key's rider-facing
  // name is "Rover" (model-catalog.ts).
  const name = c.model ? MODEL_NAMES[c.model] : "the scooter";
  return c.plate ? `${name} (plate ${c.plate})` : name;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Read-only subset of `Devices` this screen touches — deliberately
 *  `allFeatures()`, never `visibleFeatures()`: the rider's leftover map
 *  filters (model / battery / quality / area) must not hide the scooter
 *  they are standing next to. Narrowed to exactly these two members so a
 *  fake used in tests structurally CANNOT expose `visibleFeatures()` either —
 *  a call site that reached for it would fail to compile. */
export type DevicesLike = Pick<Devices, "allFeatures" | "onCountsChange">;

/** Read-only subset of `Locate`. GPS enablement is Screen 1's job; this
 *  screen only ever reads the current fix and reacts to refinements. */
export type LocateLike = Pick<Locate, "current" | "onFix">;

export type SessionLike = Pick<RideSessionStore, "current" | "dispatch">;

export interface RideOptionsPanelHooks {
  /** The panel's own [Usuals] control should call this — it navigates to
   *  Screen 2.5. */
  onUsuals(): void;
  /** The panel's own [NEXT >>] control should call this — it advances the
   *  flow (`ctx.next()`), same as every other screen's forward button. */
  onNext(): void;
  /** Master Part 0: "[Usuals] appears only for users with ≥1 saved ride-mode
   *  express settings" — this screen already fetches the list (it owns
   *  Screen 2.5's data too), so the panel doesn't have to. */
  hasUsuals: boolean;
  /** Whether [NEXT >>] should be enabled right now — mirrors this screen's
   *  own private `nextEnabled()` (a real device or "My own Device" picked,
   *  never the bare "manual entry" placeholder). Exposed so a real
   *  `buildOptionsPanel` (the integrator's glue in main.ts) can render a
   *  working forward button without reaching into this screen's private
   *  state — `buildFallbackOptionsPanel` below is the reference shape. */
  canProceed: boolean;
}

/** Renders Screen 2's "Ride Mode Options" content (the eight toggles + the
 *  ℹ info modals) into `container` — `ride-settings.ts`'s seam into this
 *  screen. See the module header's DECISION note. */
export type RideOptionsPanelBuilder = (
  container: HTMLElement,
  hooks: RideOptionsPanelHooks,
) => { dispose?(): void } | void;

export interface RideScreenSelectDeps {
  devices: DevicesLike;
  locate: LocateLike;
  session: SessionLike;
  /** Injected for tests; defaults to `ride-settings.ts`'s eventual builder
   *  via the integrator's wiring — omitted, this screen renders
   *  `buildFallbackOptionsPanel` instead. */
  buildOptionsPanel?: RideOptionsPanelBuilder;
  /** Injected for tests; defaults to one `GbfsPlates()` instance shared for
   *  the lifetime of this wiring (constructed once in `wireRideScreenSelect`,
   *  NOT `devices.ts`'s own private index — see the `ride-screen-select.ts`
   *  module-map row: devices.ts only primes on the first GPS fix, which the
   *  poor-GPS path may never get, so this screen primes its own). */
  plates?: PlatesLike;
  /** Injected for tests; defaults to `listRideUsuals` from api.ts. */
  listRideUsuals?(): Promise<RideUsual[]>;
}

/** Internal shape once the optional deps have their defaults filled in. */
type ResolvedDeps = RideScreenSelectDeps & {
  plates: PlatesLike;
  listRideUsuals(): Promise<RideUsual[]>;
};

/** Register Screens 2 and 2.5. Call once at startup; returns an unregister
 *  function for tests/HMR. */
export function wireRideScreenSelect(deps: RideScreenSelectDeps): () => void {
  const plates = deps.plates ?? new GbfsPlates();
  const listUsuals = deps.listRideUsuals ?? defaultListRideUsuals;
  const resolved: ResolvedDeps = { ...deps, plates, listRideUsuals: listUsuals };

  const unreg2 = registerRideScreen("2", {
    // F4 fix: the S8 [New Destination] loop (`ending(8) → wizard:3`) keeps
    // the same rideId/device and re-enters the wizard via
    // `openRideModal({ fastForwardTo: "3" })` — but `resolveStartScreen`
    // (ride-modal.ts) walks the flow from Screen 1 and returns the FIRST
    // registered screen that doesn't ask to be skipped, so with no skip
    // predicate here it stopped on Screen 2 (re-pick a device) instead of
    // landing on Screen 3, exactly the gap this lane's own header comment
    // flagged for the integrator. The signal is unambiguous and needs no new
    // plumbing: `doc.state === "wizard"` with a non-null `rideId` is the
    // New-Destination loop's own doc shape (`ride-session.ts`'s
    // `isRideLive` — a FRESH wizard "open" always starts with `rideId:
    // null`, per `blankRideSession`), so it can never misfire on an
    // ordinary device pick. Skipping here matters beyond UX: without it, a
    // rider who taps a device on this stray Screen 2 would `setDevice` a
    // DIFFERENT device onto an already-started tracked_rides row (legal per
    // `reduceRideSession`'s `setDevice` guard, which only checks
    // `doc.state === "wizard"`) with no server-side re-validation, and
    // walking the flow onward could re-reach Screen 6 and re-dispatch
    // `rideStarted`/`startTrackedRide` for a ride that is already live.
    skip: (ctx) => {
      const doc = resolved.session.current();
      if (doc !== null && doc.state === "wizard" && doc.rideId !== null) {
        return true;
      }
      // The device card's "Use in Ride Mode" survey (`ride-preflight.ts`)
      // path. Its whole premise is that the rider already answered "which
      // scooter?" by opening that scooter's popup, so re-asking here is
      // exactly the friction the shortcut exists to remove. The integrator
      // has already dispatched `setDevice` from the entry (main.ts's
      // `onOpen`), and this is gated on the device actually being there:
      // if that dispatch somehow didn't land, the rider gets this screen
      // rather than a flow that reaches Screen 6 with nothing selected and
      // silently runs off the end.
      return ctx.entry.preflight !== undefined && doc?.device != null;
    },
    factory: (ctx) => buildSelectScreen(ctx, resolved),
  });
  const unreg25 = registerRideScreen("2.5", {
    factory: (ctx) => buildUsualsScreen(ctx, resolved),
  });
  return () => {
    unreg2();
    unreg25();
  };
}

// ---------------------------------------------------------------------------
// Screen 2 — disambiguation
// ---------------------------------------------------------------------------

function buildSelectScreen(
  ctx: RideScreenContext,
  deps: ResolvedDeps,
): RideScreen {
  let destroyed = false;
  let fix: LngLat | null = deps.locate.current();
  let allCandidates = new Map<string, Candidate>();
  let ranked: Candidate[] = [];
  let selection: Selection = null;
  let plateValue = "";
  let platesReady = false;
  let usualsAvailable = false;
  // The handle `deps.buildOptionsPanel` returns — `ride-settings.ts`'s own
  // `RideOptionsPanelHandle.destroy()` doc says its caller must invoke this
  // "from the consumer's screen-teardown (ctx.onCleanup)" so an open ℹ modal
  // closes with the screen; also disposed before every rebuild below, since
  // each `buildOptionsPanel()` call replaces the previous panel's DOM.
  //
  // REBUILDS ARE MEMOIZED on the panel's actual inputs (`optionsPanelKey`).
  // render() runs on every GPS fix (~1/sec with the wizard up) and every
  // devices-feed refresh, and an unconditional dispose-and-rebuild here is
  // how the ℹ info modals used to close BY THEMSELVES moments after
  // opening: the fix-driven rebuild disposed the panel, and the panel's
  // destroy() dutifully closed its open modal. Nothing the panel renders
  // depends on the fix or the feed — only on whether [NEXT >>] should be
  // enabled and whether [Usuals] exists — so a rebuild outside those two
  // changing is pure destruction: it also stole focus from any panel
  // control the rider was touching.
  let optionsPanelHandle: { dispose?(): void } | undefined;
  let optionsPanelKey: string | null = null;

  // ---------------- confirm strip ----------------
  // Plate-only now — no Battery % field (see the module's FRICTION-REDUCTION
  // note below): the server derives its own battery reading from the GBFS
  // feed independently of anything a rider types. The plate field itself
  // only ever shows for manual entry (`confirmWrap.hidden`, synced in
  // `render()`) — a list/auto-selected candidate already carries its plate
  // from the GBFS match, so there is nothing to confirm or re-type.
  //
  // FRICTION-REDUCTION PASS: this screen used to always show both a Plate #
  // and a Battery % field, regardless of whether the rider had already
  // picked a ranked candidate (whose plate/battery the feed already knows).
  // Retyping a plate that's already resolved was pure friction, and asking
  // for battery % at all was redundant with the GBFS-derived reading the
  // server keeps independently — removed rather than fixed.
  const plateInput = el("input", "select") as HTMLInputElement;
  plateInput.type = "text"; // stays text even though only digits are accepted
  // today — see ride-keypad.ts's module doc: relax the filter below, not the
  // input `type`, if Veo ever ships an alphanumeric plate.
  plateInput.placeholder = "1234567";
  plateInput.setAttribute("aria-label", "Plate number, from the scooter's deck");
  applyNativeNumericInput(plateInput, { maxLength: 10 });
  // Typed here, shaken loose for the rest of the ride: a plate typed on the
  // native portrait keyboard leaves entries in WebKit's page-wide undo queue,
  // and every jolt of the deck then offers to undo them over the HUD. Script
  // -applied edits register nothing — see ios-shake-undo.ts. (The landscape
  // keypad was already safe for the same reason.)
  markUndoFree(plateInput);

  const plateWarning = el("p", "ride-option__warnings");
  plateWarning.hidden = true;
  plateWarning.setAttribute("role", "status");
  plateWarning.setAttribute("aria-live", "polite");

  const plateField = el("label", "ride-screen-select__field");
  plateField.append(
    el("span", "ride-screen-select__field-label", "Plate #"),
    plateInput,
  );
  const confirmWrap = el("div", "ride-screen-select__confirm");
  confirmWrap.append(plateField);

  const heading = el("p", "ride-modal__lede", "Select your ride:");
  const listEl = el("ol", "ride-options");
  const root = el("div", "ride-wizard__body ride-screen-select");
  root.append(heading, listEl, confirmWrap, plateWarning);

  const optionsPanelEl = el("div", "ride-wizard__body ride-screen-select__options");

  // ---------------- keypad (landscape only) ----------------
  const keypad: RideKeypadHandle = createRideKeypad({
    label: "Confirm keypad",
    onDone: () => {
      keypad.detach();
      reslotSecondary();
    },
  });

  function currentSecondary(): HTMLElement {
    return ctx.orientation() === "landscape" && keypad.attachedInput()
      ? keypad.element
      : optionsPanelEl;
  }
  function reslotSecondary(): void {
    if (!destroyed) ctx.setPanes(root, currentSecondary());
  }
  const onFieldFocus = (input: HTMLInputElement): void => {
    if (destroyed || ctx.orientation() !== "landscape") return;
    keypad.attach(input, { focus: false });
    reslotSecondary();
  };
  const onFieldBlur = (): void => {
    // A keypad button press never blurs the field (it calls preventDefault
    // on pointerdown), so a real blur means the rider tapped elsewhere —
    // fall back to the options pane. Detaching twice (Done already detached)
    // is idempotent.
    if (!destroyed && keypad.attachedInput()) {
      keypad.detach();
      reslotSecondary();
    }
  };
  plateInput.addEventListener("focus", () => onFieldFocus(plateInput));
  plateInput.addEventListener("blur", onFieldBlur);

  plateInput.addEventListener("input", () => {
    plateInput.value = sanitizeNumeric(plateInput.value, 10);
    onPlateChanged();
  });

  // ---------------- state helpers ----------------

  function nextEnabled(): boolean {
    return selection !== null && selection.kind !== "manual";
  }

  function syncSessionDevice(): void {
    if (selection === null) return;
    if (selection.kind === "own") {
      deps.session.dispatch({ type: "setDevice", device: { own: true } });
      return;
    }
    if (selection.kind === "manual") return; // nothing resolved to store yet
    // A real Veo device picked by an unauthenticated rider is STILL a private
    // ride (master glossary's "Ride" entry: private = "My own Device" OR
    // guest — a guest has no account for `POST /tracked-rides` to attribute a
    // `tracked_rides` row to, regardless of which device they picked; that
    // endpoint is session-authed, so a guest calling it would just 401).
    // Passed explicitly rather than left to the reducer's "own device or
    // already private" default — ride-session.ts's own `setDevice` doc calls
    // this out by name: "Screen 2 passes it explicitly when a guest signs in
    // mid-wizard, or when switching off own-device should make the ride
    // points-eligible again." Without this, `doc.private` would silently stay
    // `false` for a guest's real-device pick, which (a) leaves the Screen 2
    // 🏆 cascades showing points-earning options as available when they never
    // will be, and (b) leaves Screen 6 trying the authed-only
    // `POST /tracked-rides` for a rider with no session, which always fails.
    deps.session.dispatch({
      type: "setDevice",
      device: {
        vehicleIdentifier: selection.candidate.vehicleIdentifier,
        plate: selection.candidate.plate,
        model: selection.candidate.model,
        // No rider-entered battery % anymore (see the module's
        // FRICTION-REDUCTION note above) — the server derives its own
        // reading from the GBFS feed independently.
        batteryConfirmed: null,
      },
      private: !isAuthenticated(),
    });
  }

  function candidateByVehicleId(vid: string): Candidate | undefined {
    const want = vid.toLowerCase();
    for (const c of allCandidates.values()) {
      if (c.vehicleIdentifier === want) return c;
    }
    return undefined;
  }

  function selectCandidate(c: Candidate): void {
    selection = { kind: "device", candidate: c };
    plateWarning.hidden = true;
    render();
  }
  function selectOwn(): void {
    selection = { kind: "own" };
    plateWarning.hidden = true;
    render();
  }
  function selectManual(): void {
    selection = { kind: "manual" };
    render();
    try {
      plateInput.focus();
    } catch {
      /* not focusable yet — harmless */
    }
  }

  function onPlateChanged(): void {
    plateValue = plateInput.value;
    const had = selection?.kind === "device" ? selection.candidate.deviceId : null;
    const result = checkTypedPlate(
      plateValue,
      had,
      allCandidates.keys(),
      (id) => deps.plates.cachedPlateFor(id),
      allCandidates,
    );
    switch (result.kind) {
      case "empty":
        plateWarning.hidden = true;
        if (selection?.kind === "manual") selection = null;
        break;
      case "already_selected":
        plateWarning.hidden = true;
        break;
      case "switch":
        selection = { kind: "device", candidate: result.candidate };
        plateWarning.hidden = false;
        plateWarning.textContent = had
          ? `That plate doesn't match the highlighted scooter — switched to ${titleFor(result.candidate)}.`
          : `Matched ${titleFor(result.candidate)}.`;
        break;
      case "unresolved":
        selection = { kind: "manual" };
        plateWarning.hidden = !had;
        if (had) {
          plateWarning.textContent =
            "That plate doesn't match the highlighted scooter, and isn't in the live feed — switched to manual entry.";
        }
        break;
    }
    render();
  }

  // ---------------- rendering ----------------

  function render(): void {
    renderList();
    syncSessionDevice();
    buildOptionsPanel();
    // The header's own Next mirrors the options panel's [NEXT >>]: enabled
    // once a real device or "My Scooter/Bike" is picked.
    ctx.setNextEnabled(nextEnabled());
    // The plate field only ever makes sense for manual entry: a list/auto-
    // selected candidate's plate already came from the GBFS match (nothing
    // to confirm), and "My own Device" has no plate at all in the session
    // shape (`RideSessionOwnDevice` is just `{own: true}`). Hidden rather
    // than merely disabled in both cases — there is nothing useful to look
    // at, not just nothing to edit.
    confirmWrap.hidden = selection?.kind !== "manual";
  }

  function renderList(): void {
    listEl.replaceChildren();

    // "My Scooter/Bike" ALWAYS renders first — riding your own (non-Veo)
    // device is a first-class choice, not an afterthought buried under the
    // fleet list.
    const ownLi = el("li");
    const ownRow = el("button", "ride-option");
    ownRow.type = "button";
    ownRow.classList.toggle("is-selected", selection?.kind === "own");
    ownRow.append(el("div", "ride-option__title", "My Scooter/Bike"));
    ownRow.addEventListener("click", selectOwn);
    ownLi.append(ownRow);
    listEl.append(ownLi);

    if (fix === null) {
      listEl.append(
        el(
          "li",
          "ride-wizard__hint",
          "No GPS fix yet — enter your plate manually below for the best match.",
        ),
      );
    } else if ((fix.accuracy ?? Number.POSITIVE_INFINITY) > WEAK_ACCURACY_HINT_M) {
      listEl.append(
        el(
          "li",
          "ride-wizard__hint",
          "GPS signal is weak — double-check the plate below before you ride.",
        ),
      );
    }

    ranked.forEach((c, i) => {
      const li = el("li");
      const row = el("button", "ride-option");
      row.type = "button";
      const isSelected =
        selection?.kind === "device" && selection.candidate.deviceId === c.deviceId;
      row.classList.toggle("is-selected", isSelected);
      const title = el("div", "ride-option__title");
      title.append(el("span", "ride-option__rank", `${i + 1}`));
      if (c.model) {
        const glyph = el("img", "ride-option__glyph");
        glyph.src = `/${c.model}.png`;
        glyph.alt = "";
        title.append(glyph);
      }
      title.append(
        el("strong", undefined, c.model ? MODEL_NAMES[c.model] : "Scooter"),
      );
      if (c.plate) title.append(el("span", "ride-option__desc", `Plate ${c.plate}`));
      const meta = el(
        "div",
        "ride-option__meta",
        (i === 0 ? "📍 nearest · " : "") + formatFeet(c.meters),
      );
      row.append(title, meta);
      row.addEventListener("click", () => selectCandidate(c));
      li.append(row);
      listEl.append(li);
    });

    const manualLi = el("li");
    const manualRow = el("button", "ride-option");
    manualRow.type = "button";
    manualRow.classList.toggle("is-selected", selection?.kind === "manual");
    manualRow.append(
      el(
        "div",
        "ride-option__title",
        platesReady
          ? "None of these — enter plate manually"
          : "None of these — enter plate manually (loading plate index…)",
      ),
    );
    manualRow.addEventListener("click", selectManual);
    manualLi.append(manualRow);
    listEl.append(manualLi);
  }

  function buildOptionsPanel(): void {
    // See the `optionsPanelKey` note above: skip the rebuild when no
    // input the panel renders from has changed, so a GPS fix or feed
    // refresh can never close an open ℹ modal or steal focus mid-toggle.
    // doc.private IS such an input: the production builder captures it
    // into the panel's cascade context at build time, and switching
    // between "My Scooter/Bike" and a real Veo device flips it while
    // canProceed stays true — a key without it left the panel applying
    // cascades against a stale privacy state (forcing trophy options
    // off on a tracked ride, or leaving them on for a private one).
    const key = `${nextEnabled()}|${usualsAvailable}|${
      deps.session.current()?.private ?? false
    }`;
    if (optionsPanelKey === key) return;
    optionsPanelKey = key;
    optionsPanelHandle?.dispose?.();
    optionsPanelHandle = undefined;
    optionsPanelEl.replaceChildren();
    const hooks: RideOptionsPanelHooks = {
      onUsuals: () => ctx.go("2.5"),
      onNext: () => ctx.next(),
      hasUsuals: usualsAvailable,
      canProceed: nextEnabled(),
    };
    if (deps.buildOptionsPanel) {
      optionsPanelHandle = deps.buildOptionsPanel(optionsPanelEl, hooks) ?? undefined;
    } else {
      buildFallbackOptionsPanel(optionsPanelEl, hooks);
    }
  }

  function buildFallbackOptionsPanel(
    container: HTMLElement,
    hooks: RideOptionsPanelHooks,
  ): void {
    container.append(
      el("p", "ride-wizard__lede", "Ride Mode Options"),
      el(
        "p",
        "ride-wizard__hint",
        "The full options panel lands with ride-settings.ts.",
      ),
    );
    const actions = el("div", "ride-wizard__actions");
    if (hooks.hasUsuals) {
      const usualsBtn = el("button", "login-btn login-btn--secondary", "Usuals");
      usualsBtn.type = "button";
      usualsBtn.addEventListener("click", hooks.onUsuals);
      actions.append(usualsBtn);
    }
    const nextBtn = el("button", "login-btn", "NEXT >>");
    nextBtn.type = "button";
    nextBtn.disabled = !hooks.canProceed;
    nextBtn.addEventListener("click", hooks.onNext);
    actions.append(nextBtn);
    container.append(actions);
  }

  // ---------------- ranking ----------------

  function computeCandidates(): void {
    allCandidates = candidatesById(deps.devices.allFeatures(), fix, (id) =>
      deps.plates.cachedPlateFor(id),
    );
    ranked = rankByDistance(allCandidates);
  }

  function rerank(): void {
    if (destroyed) return;
    computeCandidates();
    if (selection === null) {
      const nearest = ranked[0];
      if (shouldAutoPreselect(nearest, fix?.accuracy)) {
        selection = { kind: "device", candidate: nearest };
      }
    } else if (selection.kind === "device") {
      // Keep the selection's own data (plate, distance) fresh across
      // re-ranks without dropping it just because it fell outside the
      // window — the rider's confirmed choice is never yanked by a re-rank.
      const fresh = allCandidates.get(selection.candidate.deviceId);
      if (fresh) selection = { kind: "device", candidate: fresh };
    }
    render();
  }

  // ---------------- mount ----------------

  computeCandidates();
  // A device deep link is authoritative over plain distance ranking; a
  // plate-only deep link (a reverse-lookup miss upstream) prefills the
  // manual path instead — "never a dead end" (ride-deeplink.ts's own words).
  if (ctx.entry.vehicleIdentifier) {
    const match = candidateByVehicleId(ctx.entry.vehicleIdentifier);
    if (match) selection = { kind: "device", candidate: match };
  }
  if (selection === null && ctx.entry.plate) {
    plateInput.value = ctx.entry.plate;
    plateValue = ctx.entry.plate;
  }
  rerank(); // applies distance auto-preselect only if still unselected; renders.

  void deps.plates.prime().then(() => {
    if (destroyed) return;
    platesReady = true;
    if (plateInput.value) {
      onPlateChanged(); // this screen's own fresh index may resolve it now
    } else {
      rerank(); // plates may have landed for already-ranked candidates too
    }
  });

  const unCount = deps.devices.onCountsChange(() => rerank());
  const unFix = deps.locate.onFix((pos) => {
    if (destroyed) return;
    fix = pos;
    rerank();
  });
  ctx.onCleanup(unCount);
  ctx.onCleanup(unFix);
  ctx.onCleanup(() => keypad.destroy());
  ctx.onCleanup(() => optionsPanelHandle?.dispose?.());

  if (isAuthenticated()) {
    void deps
      .listRideUsuals()
      .then((list) => {
        if (destroyed) return;
        usualsAvailable = list.length > 0;
        buildOptionsPanel();
      })
      .catch(() => {
        /* Usuals are a convenience; a failed fetch just hides the button. */
      });
  }

  return {
    title: "Select your ride",
    primary: root,
    secondary: optionsPanelEl,
    split: "even",
    onOrientationChange: (orientation) => {
      if (orientation === "portrait" && keypad.attachedInput()) keypad.detach();
      reslotSecondary();
    },
    destroy() {
      destroyed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Screen 2.5 — Usuals picker
// ---------------------------------------------------------------------------

function buildUsualsScreen(
  ctx: RideScreenContext,
  deps: ResolvedDeps,
): RideScreen {
  let destroyed = false;
  const root = el("div", "ride-wizard__body ride-screen-usuals");
  // Nothing on this detour is required — the header Next simply returns to
  // Screen 2 (a detour's `next()` is `back()`), same as Cancel.
  ctx.setNextEnabled(true);
  const cancelBtn = el("button", "login-btn login-btn--secondary", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => ctx.back());

  const status = el("p", "ride-wizard__hint", "Loading your saved Usuals…");
  const list = el("ol", "ride-options");
  root.append(
    el("p", "ride-wizard__lede", "Apply a saved Usual"),
    status,
    list,
    cancelBtn,
  );

  void deps
    .listRideUsuals()
    .then((usuals) => {
      if (destroyed) return;
      if (usuals.length === 0) {
        status.textContent = "No saved Usuals yet.";
        return;
      }
      status.remove();
      for (const usual of usuals) {
        const li = el("li");
        const row = el("button", "ride-option");
        row.type = "button";
        const title = el("div", "ride-option__title");
        title.append(el("strong", undefined, usual.name));
        row.append(title);
        if (usual.settings.label) {
          row.append(el("div", "ride-option__desc", usual.settings.label));
        }
        row.addEventListener("click", () => {
          // A Usual saved while signed in on a real device can carry 🏆
          // options a later guest/own-device context must still suppress
          // (`ride-settings.ts`'s `optionsFromRideUsual`/`applyCascades`
          // docs) — never dispatch the raw blob.
          const current = deps.session.current();
          const cascadeCtx = {
            private: current?.private ?? false,
            authenticated: isAuthenticated(),
          };
          deps.session.dispatch({
            type: "setOptions",
            options: applyCascades(
              optionsFromRideUsual(usual),
              cascadeCtx,
            ),
          });
          ctx.back();
        });
        li.append(row);
        list.append(li);
      }
    })
    .catch(() => {
      if (destroyed) return;
      status.textContent = "Couldn't load your Usuals right now.";
    });

  return {
    title: "Usuals",
    primary: root,
    destroy() {
      destroyed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

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
