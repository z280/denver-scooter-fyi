// Ride-mode wizard shell + screen router (Screens 1 → 2 → 2.5 → 3 → 4 → 6).
//
// This module owns the *chrome*, never a screen: the modal element, the
// orientation-adaptive two-pane grid, back/next navigation, the focus trap,
// Escape handling, and deep-link fast-forward. The screens themselves register
// themselves into a `Map<ScreenId, ScreenFactory>` from their own modules
// (phase F2), so adding Screen 3 must never touch this file.
//
// Discipline copied from ride-wizard.ts: `document.createElement` only (never
// innerHTML), a `shell()` rebuild helper, a `cleanupFns[]` teardown list, and a
// hooks interface instead of importing main.ts state. Focus trapping is new —
// nothing in the repo had one to copy — and lives in `trapFocus()` below.
//
// Orientation (per the frontend plan's "Layout, keyboard, deep link, theme,
// entry"): the grid is CSS-driven — `@media (orientation: landscape)` lays the
// panes out as columns (2fr 3fr on Screen 4 for the 40/60 split) and portrait
// stacks them as rows — while a `matchMedia("(orientation: landscape)")`
// listener flips `is-landscape`/`is-portrait` on the root so JS and CSS agree.
// On a flip, screens RE-SLOT their panes through `ctx.setPanes()`; they are
// never rebuilt, so nothing typed or selected is lost when a phone turns.

/** Owner's screen numbering. There is deliberately no Screen 5, and 2.5 is the
 *  Usuals picker — never renumber (master plan, Part 0 numbering note).
 *  Deliberately declared here rather than imported: the shell must stand alone
 *  (F1 lands it before any screen exists). It is member-for-member identical to
 *  `ride-session.ts`'s `WizardScreenId`, so the two are mutually assignable and
 *  either can be aliased to the other later without touching a call site. */
export type ScreenId = "1" | "2" | "2.5" | "3" | "4" | "6";

/** The linear flow `next()` walks. Screen 2.5 is a *detour* off Screen 2 (the
 *  Usuals picker returns to 2), so it is deliberately absent here. */
export const RIDE_SCREEN_FLOW: readonly ScreenId[] = ["1", "2", "3", "4", "6"];

/** Every screen id, flow steps plus detours — the registry's key domain. */
export const RIDE_SCREEN_IDS: readonly ScreenId[] = [
  "1",
  "2",
  "2.5",
  "3",
  "4",
  "6",
];

export type RideOrientation = "landscape" | "portrait";

/** Landscape column ratio. `even` = 1fr 1fr (Screen 2's halves); `40-60` =
 *  2fr 3fr (Screen 4's route list / map split). Portrait always stacks. */
export type RidePaneSplit = "even" | "40-60";

/** Dev flag gating the 🧭 Ride button's swap from "arm the HUD" to "open the
 *  wizard". Default-off until F3 completes, then default-on (frontend plan,
 *  "Entry"). UI-pref key, hence the hyphenated convention. */
export const RIDE_MODAL_FLAG_KEY = "scooter-fyi-ride-modal";

/** Which face Screen 6 shows for a rider who came in through the device
 *  card's "Use in Ride Mode" survey (`ride-preflight.ts`). Not a
 *  `RideOptions` field — it changes nothing about the ride, only whether
 *  the rider still needs the Start-in-Veo link. */
export type RideStartIntent = "already-started" | "need-link";

/** The three `RideOptions` fields the pre-ride survey asks about, carried
 *  on the entry so the integrator can seed the session doc with them at
 *  `onOpen` time.
 *
 *  Structurally typed rather than imported from `api.ts` on purpose: this
 *  module is the wizard's chrome and deliberately imports no app state (see
 *  the file header). A three-boolean shape is assignable to the matching
 *  slice of `RideOptions` either way, so the integrator can spread it
 *  straight into an options blob with no cast. */
export interface RidePreflightChoices {
  navigation: boolean;
  save_tracks: boolean;
  cost_hud: boolean;
}

/** How the wizard was entered. A device deep link (`?ride=`) or a device
 *  popup's "Ride this" fast-forwards the landing screen; it never bypasses
 *  Screen 1's auth/GPS gates (those are Screen 1's own `skip` rules). */
export interface RideModalEntry {
  /** 16-hex vehicle identifier to preselect on Screen 2. */
  vehicleIdentifier?: string;
  /** A plate that either resolved the identifier above, or (on a reverse-lookup
   *  miss) prefills Screen 2's manual-plate path — never a dead end. */
  plate?: string;
  /** Landing screen for a fast-forward; defaults to Screen 2 when a device is
   *  named, Screen 1 otherwise. Screens registered *before* the target still
   *  run when their `skip()` says they must (Screen 1's gates). */
  fastForwardTo?: ScreenId;
  /** Pre-ride survey answers (`ride-preflight.ts`). The integrator folds
   *  these into the fresh session doc's `RideOptions` in `onOpen`; nothing
   *  in this module reads them. */
  preflight?: RidePreflightChoices;
  /** Screen 6 should start the ride the moment it mounts, rather than
   *  rendering its Start-in-Veo buttons and countdown.
   *
   *  Set when the survey established there is nothing left to ask about
   *  Veo — the rider said they had already unlocked it, or they turned the
   *  cost HUD off (which per spec removes the consideration of starting Veo
   *  altogether). Screen 6 stays IN the flow either way because it is the
   *  reducer's only legal seat for `rideStarted`; this is what keeps it from
   *  re-asking a question the rider already answered on the device card. */
  autoStart?: boolean;
}

export type RideModalCloseReason =
  | "escape"
  | "close-button"
  /** The flow ran past its last screen — Screen 6 handing off to the HUD. */
  | "handoff"
  | "programmatic"
  /** Re-entered (another deep link / popup tap) while already open. */
  | "reopen";

/** Everything the shell needs from the app, so this module imports no app
 *  state. The integrator supplies these once via `wireRideModal()`. */
export interface RideModalHooks {
  /** Center the map on the deep-linked device and open its popup —
   *  `devices.jumpToDevice`, which needs the device's coordinates, so the
   *  caller looks them up (see the integrator note in the lane report). */
  jumpToDevice?(vehicleIdentifier: string): void;
  /** Ran once at wire time, before any render — F3's seat for
   *  `ride-session.ts` recovery (frontend plan: "Recovery on load (in
   *  `wireRideModal()`, before first render)"). */
  onWired?(): void;
  onOpen?(entry: RideModalEntry): void;
  onClose?(reason: RideModalCloseReason): void;
  /** Every screen change, including the first — `ride-session.ts` persists the
   *  screen on every transition. */
  onScreenChange?(id: ScreenId): void;
  /** The flow ran off the end of `RIDE_SCREEN_FLOW` (Screen 6 → countdown).
   *  Fires immediately before the `handoff` close. */
  onComplete?(): void;
}

/** What a screen may ask of the router. Handed to the factory; every method
 *  no-ops once the screen has been replaced, so a late timer callback from a
 *  torn-down screen cannot navigate. */
export interface RideScreenContext {
  readonly entry: RideModalEntry;
  readonly hooks: RideModalHooks;
  /** Current orientation. Also delivered to `onOrientationChange`. */
  orientation(): RideOrientation;
  /** Re-slot the panes without rebuilding the screen — the orientation flip
   *  path (e.g. Screen 2 hands the right pane to the keypad in landscape and
   *  renders nothing there in portrait). Pass `null` to collapse to one pane. */
  setPanes(primary: HTMLElement, secondary?: HTMLElement | null): void;
  setTitle(title: string): void;
  setSplit(split: RidePaneSplit): void;
  go(id: ScreenId): void;
  /** Next step in `RIDE_SCREEN_FLOW`, skipping screens whose registration says
   *  to. From a detour (2.5) this is `back()`. Past the last screen it fires
   *  `hooks.onComplete()` and closes with reason `handoff`. */
  next(): void;
  back(): void;
  canGoBack(): boolean;
  close(reason?: RideModalCloseReason): void;
  /** Teardown for this screen: run when the screen is replaced or the modal
   *  closes, in registration order. The screen's own `destroy()` runs first. */
  onCleanup(fn: () => void): void;
}

/** A built screen. `primary` is the left pane in landscape / top in portrait;
 *  `secondary` is the right / bottom pane, omitted for a single-pane screen. */
export interface RideScreen {
  title: string;
  primary: HTMLElement;
  secondary?: HTMLElement | null;
  /** Defaults to `even`. Screen 4 wants `40-60`. */
  split?: RidePaneSplit;
  /** Focused when the screen mounts; otherwise the first focusable element. */
  initialFocus?: HTMLElement | null;
  /** The phone turned. Re-slot panes / attach-or-detach the keypad here —
   *  never rebuild state. */
  onOrientationChange?(orientation: RideOrientation): void;
  destroy?(): void;
}

export type RideScreenFactory = (ctx: RideScreenContext) => RideScreen;

/** Registration-time context for `skip` — deliberately without navigation, so
 *  a gate predicate cannot move the flow while the flow is being resolved. */
export interface RideScreenSkipContext {
  readonly entry: RideModalEntry;
  readonly hooks: RideModalHooks;
}

export interface RideScreenRegistration {
  factory: RideScreenFactory;
  /** True → the router walks straight past this screen. Screen 1 returns true
   *  when the rider is authenticated AND geolocation is already granted;
   *  Screens 3/4 return true when navigation is off. */
  skip?(ctx: RideScreenSkipContext): boolean;
}

// ---------- module state ----------

const registry = new Map<ScreenId, RideScreenRegistration>();
let modalHooks: RideModalHooks = {};
let current: RideModal | null = null;

const ORIENTATION_QUERY = "(orientation: landscape)";
const TITLE_ID = "ride-modal-title";

/** Register (or replace) a screen. Returns an unregister function so a lane
 *  can tear its screen down in a test or on HMR. */
export function registerRideScreen(
  id: ScreenId,
  registration: RideScreenFactory | RideScreenRegistration,
): () => void {
  const reg: RideScreenRegistration =
    typeof registration === "function"
      ? { factory: registration }
      : registration;
  registry.set(id, reg);
  return () => {
    if (registry.get(id) === reg) registry.delete(id);
  };
}

/** Which screens are wired right now, in flow order (debug + tests). */
export function registeredRideScreens(): ScreenId[] {
  return RIDE_SCREEN_IDS.filter((id) => registry.has(id));
}

/** Store the app hooks and run F3's recovery seat. The integrator's single
 *  `main.ts` call. */
export function wireRideModal(hooks: RideModalHooks = {}): void {
  modalHooks = hooks;
  hooks.onWired?.();
}

/** Is the 🧭 Ride button allowed to open the wizard yet? Dev flag until F3
 *  completes (frontend plan, "Entry"), read defensively — private mode throws
 *  on `localStorage` access in some browsers. */
export function isRideModalEnabled(): boolean {
  try {
    const raw = localStorage.getItem(RIDE_MODAL_FLAG_KEY);
    return raw === "1" || raw === "true" || raw === "on";
  } catch {
    return false;
  }
}

/** Open the wizard. Re-entering while open (a second deep link, a popup's
 *  "Ride this") closes the live instance with reason `reopen` and starts
 *  clean — the new entry wins. */
export function openRideModal(entry: RideModalEntry = {}): void {
  if (current) closeRideModal("reopen");
  const modal = new RideModal(entry, modalHooks);
  current = modal;
  modal.open();
}

export function closeRideModal(
  reason: RideModalCloseReason = "programmatic",
): void {
  current?.close(reason);
}

export function isRideModalOpen(): boolean {
  return current !== null;
}

/** The live screen id, or null when the wizard is closed. */
export function currentRideScreen(): ScreenId | null {
  return current?.screenId() ?? null;
}

/** The live modal root, for tests and for F2 screens that need to hang a
 *  floating layer inside the dialog rather than on `document.body`. */
export function rideModalRoot(): HTMLElement | null {
  return current?.element() ?? null;
}

/** Close anything open, forget every registration and hook. Exists for tests
 *  and HMR — production wires once. */
export function resetRideModal(): void {
  closeRideModal("programmatic");
  registry.clear();
  modalHooks = {};
}

// ---------- the shell ----------

class RideModal {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly grid: HTMLElement;
  private readonly primaryPane: HTMLElement;
  private readonly secondaryPane: HTMLElement;

  private readonly stack: ScreenId[] = [];
  private screen: RideScreen | null = null;
  /** Bumped on every render so a stale context's methods no-op. */
  private generation = 0;

  /** Modal-lifetime teardown (document listeners, the media-query listener). */
  private readonly cleanupFns: (() => void)[] = [];
  /** Current screen's teardown, from `ctx.onCleanup`. */
  private screenCleanupFns: (() => void)[] = [];

  private orientationValue: RideOrientation = "portrait";
  private previouslyFocused: Element | null = null;
  private closed = false;

  constructor(
    private readonly entry: RideModalEntry,
    private readonly hooks: RideModalHooks,
  ) {
    this.root = el("div", "ride-modal");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", TITLE_ID);

    this.card = el("div", "ride-modal__card");
    // Focus target of last resort: a screen with nothing focusable still gets
    // focus inside the dialog, so the trap has something to hold.
    this.card.tabIndex = -1;

    const header = el("header", "ride-modal__header");
    this.backBtn = el("button", "ride-modal__back");
    this.backBtn.type = "button";
    this.backBtn.textContent = "‹ Back";
    this.backBtn.setAttribute("aria-label", "Back to the previous step");
    this.backBtn.addEventListener("click", () => this.back());
    this.titleEl = el("h2", "ride-modal__title");
    this.titleEl.id = TITLE_ID;
    const closeBtn = el("button", "ride-modal__close");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close ride setup");
    closeBtn.addEventListener("click", () => this.close("close-button"));
    header.append(this.backBtn, this.titleEl, closeBtn);

    this.grid = el("div", "ride-modal__grid");
    this.grid.dataset.split = "even";
    this.grid.dataset.panes = "2";
    this.primaryPane = el("section", "ride-modal__pane ride-modal__pane--primary");
    this.secondaryPane = el(
      "section",
      "ride-modal__pane ride-modal__pane--secondary",
    );
    this.grid.append(this.primaryPane, this.secondaryPane);

    this.card.append(header, this.grid);
    this.root.append(this.card);
  }

  element(): HTMLElement {
    return this.root;
  }

  screenId(): ScreenId | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  open(): void {
    this.previouslyFocused = document.activeElement;
    this.watchOrientation();
    document.body.append(this.root);
    this.trapFocus();
    this.bindEscape();
    this.hooks.onOpen?.(this.entry);
    // The deep link lands the rider on the device: center + popup happen
    // regardless of which screen the auth/GPS gates put them on, so the map
    // behind the wizard is already right when they arrive at Screen 2.
    if (this.entry.vehicleIdentifier) {
      try {
        this.hooks.jumpToDevice?.(this.entry.vehicleIdentifier);
      } catch (e) {
        console.error("ride deep link: jumpToDevice failed", e);
      }
    }
    this.render(resolveStartScreen(this.entry, this.hooks), "replace");
  }

  close(reason: RideModalCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownScreen();
    for (const fn of this.cleanupFns.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.error("ride modal cleanup failed", e);
      }
    }
    this.root.remove();
    if (current === this) current = null;
    const prev = this.previouslyFocused;
    if (prev instanceof HTMLElement && prev.isConnected) {
      try {
        prev.focus();
      } catch {
        /* the launching element went away — nothing to restore to */
      }
    }
    this.hooks.onClose?.(reason);
  }

  // ---------- navigation ----------

  private render(id: ScreenId, mode: "push" | "replace"): void {
    this.teardownScreen();
    if (mode === "replace") this.stack.length = 0;
    this.stack.push(id);
    this.generation += 1;
    const gen = this.generation;
    const ctx = this.makeContext(gen);

    const reg = registry.get(id);
    let screen: RideScreen;
    try {
      screen = reg ? reg.factory(ctx) : placeholderScreen(id, this.entry);
    } catch (e) {
      // A screen that cannot build must not strand the rider inside a
      // half-drawn dialog — say so and leave the ✕ reachable.
      console.error(`ride screen ${id} failed to build`, e);
      screen = brokenScreen(id);
    }
    this.screen = screen;

    this.root.dataset.screen = id;
    this.setTitle(screen.title);
    this.setSplit(screen.split ?? "even");
    this.slot(screen.primary, screen.secondary ?? null);
    this.syncBack();
    this.hooks.onScreenChange?.(id);

    // Land inside the screen's own content — never on the header's ✕, which
    // would announce "Close ride setup" as the rider's first impression of every
    // step. Panes first, then the card, which is `tabindex="-1"` precisely so
    // the trap always has a holder. Text-entry fields are skipped too: focusing
    // one on mount pops the native keyboard over a screen nobody has read yet.
    // A screen that *wants* its field focused (Screen 3's "Where to?" bar) says
    // so via `initialFocus`.
    const focusTarget =
      screen.initialFocus ??
      firstFocusable(this.primaryPane, { skipTextEntry: true }) ??
      firstFocusable(this.secondaryPane, { skipTextEntry: true }) ??
      this.card;
    try {
      focusTarget.focus();
    } catch {
      /* detached or unfocusable — the trap's focusin guard picks it up */
    }
  }

  private makeContext(gen: number): RideScreenContext {
    const live = (): boolean => !this.closed && this.generation === gen;
    return {
      entry: this.entry,
      hooks: this.hooks,
      orientation: () => this.orientationValue,
      setPanes: (primary, secondary) => {
        if (!live()) return;
        this.slot(primary, secondary ?? null);
      },
      setTitle: (title) => {
        if (live()) this.setTitle(title);
      },
      setSplit: (split) => {
        if (live()) this.setSplit(split);
      },
      go: (next) => {
        if (live()) this.go(next);
      },
      next: () => {
        if (live()) this.next();
      },
      back: () => {
        if (live()) this.back();
      },
      canGoBack: () => this.stack.length > 1,
      close: (reason) => {
        if (live()) this.close(reason ?? "programmatic");
      },
      onCleanup: (fn) => {
        if (live()) this.screenCleanupFns.push(fn);
        else fn();
      },
    };
  }

  private go(id: ScreenId): void {
    if (this.screenId() === id) return;
    this.render(id, "push");
  }

  private next(): void {
    const from = this.screenId();
    if (from === null) return;
    // A detour (2.5 — the Usuals picker) has no linear successor: applying a
    // Usual returns to the screen that opened it.
    if (!RIDE_SCREEN_FLOW.includes(from)) {
      this.back();
      return;
    }
    const target = nextFlowScreen(from, this.entry, this.hooks);
    if (target === null) {
      this.hooks.onComplete?.();
      this.close("handoff");
      return;
    }
    this.render(target, "push");
  }

  private back(): void {
    if (this.stack.length < 2) return;
    this.stack.pop();
    const to = this.stack.pop();
    if (to === undefined) return;
    this.render(to, "push");
  }

  private syncBack(): void {
    this.backBtn.hidden = this.stack.length < 2;
  }

  // ---------- panes, title, orientation ----------

  private setTitle(title: string): void {
    this.titleEl.textContent = title;
  }

  private setSplit(split: RidePaneSplit): void {
    this.grid.dataset.split = split;
  }

  /** Re-slotting is called far more often than the panes actually change —
   *  e.g. Screen 2 calls `ctx.setPanes(root, currentSecondary())` on every
   *  focus/blur of its plate/battery fields, with `primary` (`root`) always
   *  the SAME element. `replaceChildren` on a pane that already contains
   *  exactly that element still removes-then-reappends it, and removing a
   *  node that contains focus synchronously blurs it back to `<body>` —
   *  which a screen watching for a real blur (Screen 2's keypad-detach path)
   *  reads as "the rider tapped away" and reacts to, even though nothing
   *  actually changed. Skipping the no-op reassignment keeps focus (and any
   *  keypad attached to it) intact across a re-slot that isn't swapping
   *  anything. */
  private slot(primary: HTMLElement, secondary: HTMLElement | null): void {
    if (this.primaryPane.firstElementChild !== primary || this.primaryPane.childElementCount !== 1) {
      this.primaryPane.replaceChildren(primary);
    }
    if (secondary) {
      if (this.secondaryPane.firstElementChild !== secondary || this.secondaryPane.childElementCount !== 1) {
        this.secondaryPane.replaceChildren(secondary);
      }
      this.secondaryPane.hidden = false;
      this.grid.dataset.panes = "2";
    } else {
      if (this.secondaryPane.childElementCount !== 0) {
        this.secondaryPane.replaceChildren();
      }
      this.secondaryPane.hidden = true;
      this.grid.dataset.panes = "1";
    }
  }

  private watchOrientation(): void {
    const mm =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(ORIENTATION_QUERY)
        : null;
    if (!mm) {
      // No matchMedia (very old browser, or a bare test harness): portrait is
      // the safe assumption — stacked rows fit any viewport, and the CSS media
      // query still lays landscape out correctly on its own.
      this.applyOrientation("portrait");
      return;
    }
    this.applyOrientation(mm.matches ? "landscape" : "portrait");
    const onChange = (e: MediaQueryListEvent): void => {
      this.applyOrientation(e.matches ? "landscape" : "portrait");
    };
    if (typeof mm.addEventListener === "function") {
      mm.addEventListener("change", onChange);
      this.cleanupFns.push(() => mm.removeEventListener("change", onChange));
    } else if (typeof mm.addListener === "function") {
      // Safari < 14 — the only listener surface it has.
      mm.addListener(onChange);
      this.cleanupFns.push(() => mm.removeListener(onChange));
    }
  }

  private applyOrientation(orientation: RideOrientation): void {
    this.orientationValue = orientation;
    this.root.classList.toggle("is-landscape", orientation === "landscape");
    this.root.classList.toggle("is-portrait", orientation === "portrait");
    try {
      this.screen?.onOrientationChange?.(orientation);
    } catch (e) {
      console.error("ride screen orientation handler failed", e);
    }
  }

  // ---------- focus trap + Escape ----------

  private bindEscape(): void {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || this.closed) return;
      // A floating layer over the wizard owns Escape while it is open — the
      // shared `.ranks-modal` shell (F2's eight ℹ info modals), the install
      // sheet and the icon lightbox each add their own document-level Escape
      // listener, and document listeners on the same node all fire.
      if (document.querySelector(".ranks-modal, .install-modal, .icon-lightbox")) {
        return;
      }
      this.close("escape");
    };
    document.addEventListener("keydown", onKey);
    this.cleanupFns.push(() => document.removeEventListener("keydown", onKey));
  }

  /** Keep Tab inside the dialog, and pull focus back if anything outside
   *  steals it. New in this program — there was no in-repo trap to copy. */
  private trapFocus(): void {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || this.closed) return;
      const focusables = focusableWithin(this.root);
      if (focusables.length === 0) {
        e.preventDefault();
        this.card.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === this.card || !this.root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !this.root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    this.root.addEventListener("keydown", onKeyDown);
    this.cleanupFns.push(() =>
      this.root.removeEventListener("keydown", onKeyDown),
    );

    // Programmatic focus (or the browser cycling in from its own chrome) can
    // land outside the dialog without a Tab keydown ever reaching us. Recover
    // onto the card rather than a control: it re-announces the dialog, can't
    // summon a keyboard, and Tab from there walks the panes normally.
    const onFocusIn = (e: FocusEvent): void => {
      if (this.closed) return;
      const target = e.target;
      if (target instanceof Node && this.root.contains(target)) return;
      this.card.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    this.cleanupFns.push(() =>
      document.removeEventListener("focusin", onFocusIn),
    );
  }

  // ---------- teardown ----------

  private teardownScreen(): void {
    const screen = this.screen;
    this.screen = null;
    if (screen?.destroy) {
      try {
        screen.destroy();
      } catch (e) {
        console.error("ride screen destroy failed", e);
      }
    }
    for (const fn of this.screenCleanupFns.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.error("ride screen cleanup failed", e);
      }
    }
    this.screenCleanupFns = [];
    this.primaryPane.replaceChildren();
    this.secondaryPane.replaceChildren();
  }
}

// ---------- flow resolution ----------

function skipContext(
  entry: RideModalEntry,
  hooks: RideModalHooks,
): RideScreenSkipContext {
  return { entry, hooks };
}

function shouldSkip(
  id: ScreenId,
  entry: RideModalEntry,
  hooks: RideModalHooks,
): boolean {
  const reg = registry.get(id);
  if (!reg) return false;
  try {
    return reg.skip?.(skipContext(entry, hooks)) === true;
  } catch (e) {
    // A throwing gate must not strand the rider — show the screen.
    console.error(`ride screen ${id} skip predicate failed`, e);
    return false;
  }
}

/** Landing screen. Walks the flow from Screen 1: a screen that is registered
 *  and does not ask to be skipped wins (Screen 1's auth/GPS gates survive a
 *  deep link, per the plan), while unregistered screens ahead of a
 *  fast-forward target are stepped over — an unwired screen can never gate
 *  anything, and must never turn a deep link into a dead end.
 *
 *  The fast-forward target is a FLOOR for that step-over, never an early exit:
 *  a registered screen still gets to answer `skip`, at the target as much as
 *  before it. Without that, the ordinary (deep-link-free) entry — whose target
 *  is Screen 1 — would land on Screen 1 unconditionally and Screen 1's own rule
 *  ("skipped entirely when `isAuthenticated()` and geolocation is already
 *  granted"; master Part 0: "If neither applies the screen never appears")
 *  would never fire. Same reasoning past the target: a `fastForwardTo: "3"` on
 *  a ride with navigation off must not park the rider on a screen its
 *  registration just said to skip. */
export function resolveStartScreen(
  entry: RideModalEntry,
  hooks: RideModalHooks = modalHooks,
): ScreenId {
  const target: ScreenId =
    entry.fastForwardTo ??
    (entry.vehicleIdentifier || entry.plate ? "2" : "1");
  const targetIndex = RIDE_SCREEN_FLOW.indexOf(target);
  // A detour target (2.5, which is deliberately not a flow step) sits past
  // every flow screen: step over all of them and land on it.
  const floor = targetIndex >= 0 ? targetIndex : RIDE_SCREEN_FLOW.length;
  for (let i = 0; i < RIDE_SCREEN_FLOW.length; i += 1) {
    const id = RIDE_SCREEN_FLOW[i];
    if (registry.has(id)) {
      if (!shouldSkip(id, entry, hooks)) return id;
      continue;
    }
    // Unwired: step over it only while it sits before the target. At or past
    // the target an unwired screen is where the rider is meant to land (F1's
    // placeholder, F2's real screen).
    if (i < floor) continue;
    return id;
  }
  return target;
}

/** The next flow screen after `from`, skipping every screen whose registration
 *  asks to be skipped. `null` = the flow is finished (Screen 6 → handoff). */
export function nextFlowScreen(
  from: ScreenId,
  entry: RideModalEntry,
  hooks: RideModalHooks = modalHooks,
): ScreenId | null {
  const start = RIDE_SCREEN_FLOW.indexOf(from);
  if (start < 0) return null;
  for (let i = start + 1; i < RIDE_SCREEN_FLOW.length; i += 1) {
    const id = RIDE_SCREEN_FLOW[i];
    if (shouldSkip(id, entry, hooks)) continue;
    return id;
  }
  return null;
}

// ---------- placeholder (a screen id nobody has registered yet) ----------

function placeholderScreen(id: ScreenId, entry: RideModalEntry): RideScreen {
  const wrap = el("div", "ride-modal__placeholder");
  wrap.append(
    el("p", "ride-modal__lede", `Screen ${id} isn't wired up yet.`),
    el(
      "p",
      "ride-modal__hint",
      entry.vehicleIdentifier
        ? `Entered for vehicle ${entry.vehicleIdentifier}.`
        : entry.plate
          ? `Entered for plate ${entry.plate}.`
          : "The wizard shell is here; its screens land in phase F2.",
    ),
  );
  return { title: `Ride setup — screen ${id}`, primary: wrap };
}

/** A screen factory threw. Honest copy, and the header's ✕ still works. */
function brokenScreen(id: ScreenId): RideScreen {
  const wrap = el("div", "ride-modal__placeholder");
  wrap.append(
    el("p", "ride-modal__lede", "Something went wrong opening this step."),
    el(
      "p",
      "ride-modal__hint",
      `Screen ${id} could not be drawn. Close this and try again.`,
    ),
  );
  return { title: "Ride setup", primary: wrap };
}

// ---------- focus helpers ----------

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]",
  "[tabindex]",
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const node of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (isFocusable(node)) out.push(node);
  }
  return out;
}

function firstFocusable(
  root: HTMLElement,
  opts: { skipTextEntry?: boolean } = {},
): HTMLElement | null {
  const all = focusableWithin(root);
  if (!opts.skipTextEntry) return all[0] ?? null;
  return all.find((node) => !isTextEntry(node)) ?? null;
}

/** Would focusing this element summon a software keyboard? */
function isTextEntry(node: HTMLElement): boolean {
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (node as HTMLInputElement).type;
  return (
    type !== "button" &&
    type !== "submit" &&
    type !== "reset" &&
    type !== "checkbox" &&
    type !== "radio" &&
    type !== "range" &&
    type !== "color" &&
    type !== "file"
  );
}

function isFocusable(node: HTMLElement): boolean {
  if (node.hasAttribute("disabled")) return false;
  if (node.getAttribute("aria-hidden") === "true") return false;
  if (node.tabIndex < 0) return false;
  // The `hidden` attribute is checked explicitly: browsers implement it as a
  // UA `display: none` rule that checkVisibility() catches, but happy-dom does
  // not, and the modal hides its Back button and secondary pane with it.
  if (node.hidden || node.closest("[hidden]") !== null) return false;
  const check = (
    node as HTMLElement & { checkVisibility?: () => boolean }
  ).checkVisibility;
  if (typeof check === "function" && !check.call(node)) return false;
  return true;
}

// ---------- DOM helper (ride-wizard.ts's, verbatim in spirit) ----------

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
