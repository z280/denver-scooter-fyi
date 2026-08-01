// "Tap the map to set your home" — a one-shot point picker for the Profile
// tab's home and work addresses.
//
// Two deliberate shapes here. The map click handler is registered ONCE and
// gated on a flag, matching every other handler in this app (nothing calls
// map.off anywhere, and churning listeners per pick would be the first place
// a leak could hide). The Escape handler is the opposite: it exists only
// while a pick is pending, and it listens in the CAPTURE phase, because the
// drawer's own document-level Escape would otherwise close the drawer out
// from under the rider when they only meant to cancel the pick.

export interface PickedPoint {
  lat: number;
  lng: number;
}

/** The slice of MapLibre this module needs — narrow enough to fake in a test
 *  without standing up a real GL context. */
export interface PickMap {
  on(type: "click", listener: (e: { lngLat: { lat: number; lng: number } }) => void): unknown;
  getCanvas(): { style: { cursor: string } };
}

export interface MapPickDeps {
  /** Fired on enter (true) and exit (false) so the app can dim the drawer,
   *  suppress device popups, and put up an instruction bar. */
  onModeChange?(active: boolean): void;
  /** Copy for the instruction bar; defaults to a generic prompt. */
  hint?: string;
}

export interface MapPickHandle {
  /** Resolves with the point, or null if cancelled. Never rejects. Starting
   *  a second pick cancels the first. */
  pick(opts?: { hint?: string }): Promise<PickedPoint | null>;
  isPicking(): boolean;
  cancel(): void;
  dispose(): void;
}

const BAR_ID = "map-pick-bar";

export function createMapPick(
  map: PickMap,
  deps: MapPickDeps = {},
): MapPickHandle {
  let resolveCurrent: ((p: PickedPoint | null) => void) | null = null;
  let bar: HTMLElement | null = null;
  let disposed = false;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    // Swallow it: the drawer's document handler would close the drawer, and
    // the rider asked to cancel a pick, not to leave.
    e.preventDefault();
    e.stopPropagation();
    finish(null);
  };

  const showBar = (hint: string): void => {
    bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.className = "map-pick-bar";
    bar.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = hint;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "text-btn map-pick-bar__cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => finish(null));
    bar.append(text, cancel);
    document.body.append(bar);
  };

  const teardown = (): void => {
    document.removeEventListener("keydown", onKeyDown, true);
    bar?.remove();
    bar = null;
    map.getCanvas().style.cursor = "";
    deps.onModeChange?.(false);
  };

  const finish = (p: PickedPoint | null): void => {
    const resolve = resolveCurrent;
    if (!resolve) return;
    resolveCurrent = null;
    teardown();
    resolve(p);
  };

  // Registered once, for the life of the map; inert unless a pick is pending.
  map.on("click", (e) => {
    if (!resolveCurrent) return;
    finish({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  });

  return {
    pick(opts = {}) {
      if (disposed) return Promise.resolve(null);
      // A second pick supersedes the first — the rider moved on.
      finish(null);
      return new Promise<PickedPoint | null>((resolve) => {
        resolveCurrent = resolve;
        map.getCanvas().style.cursor = "crosshair";
        showBar(opts.hint ?? deps.hint ?? "Tap the map to set this location");
        document.addEventListener("keydown", onKeyDown, true);
        deps.onModeChange?.(true);
      });
    },
    isPicking() {
      return resolveCurrent !== null;
    },
    cancel() {
      finish(null);
    },
    dispose() {
      disposed = true;
      finish(null);
    },
  };
}
