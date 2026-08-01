// The Account drawer's tab shell: four tabs over four panels, and nothing
// else. This module knows no app state — it hands out mount points and
// reports which one is showing, so the drawer's contents can be rebuilt on
// sign-in/sign-out without the strip (or the rider's chosen tab) going with
// them. That separation is the whole point: wireAccount() rebuilds panel
// CONTENTS, never the strip.
//
// Keyboard behaviour follows the ARIA authoring practices for tabs: one tab
// stop for the whole strip (roving tabindex), arrows move and select, Home
// and End jump to the ends.

export type AccountTabId = "login" | "profile" | "community" | "local";

export const ACCOUNT_TAB_IDS: readonly AccountTabId[] = [
  "login",
  "profile",
  "community",
  "local",
] as const;

const TAB_LABELS: Record<AccountTabId, string> = {
  login: "Login",
  profile: "Profile",
  community: "Community",
  local: "Local Data",
};

export interface AccountTabsDeps {
  /** Tab shown on construction. Defaults to "login". */
  initial?: AccountTabId;
  /** Fired after a panel becomes visible — the seam lazy panels use to build
   *  or refresh themselves only once they can actually be seen (a hidden
   *  panel has no layout, which is how a Google button renders 0px wide). */
  onShow?(id: AccountTabId): void;
  /** Fired when a disabled tab is activated, so the caller can explain why
   *  instead of leaving the rider with a control that silently ignores them. */
  onBlocked?(id: AccountTabId): void;
}

export interface AccountTabsHandle {
  /** The tablist element, already mounted in the host. */
  readonly strip: HTMLElement;
  panel(id: AccountTabId): HTMLElement;
  /** Select a tab. A disabled tab is refused unless `force` (used when auth
   *  is lost while standing on a tab that just became unavailable). */
  select(id: AccountTabId, opts?: { focus?: boolean; force?: boolean }): void;
  selected(): AccountTabId;
  setEnabled(id: AccountTabId, on: boolean): void;
  isEnabled(id: AccountTabId): boolean;
  dispose(): void;
}

/** Where the drawer should land after the reload every sign-in door performs.
 *  sessionStorage, not localStorage: a one-shot view hint, not a preference,
 *  and it must not outlive the tab. */
const TAB_HINT_KEY = "scooter_fyi.account_tab";

export function writeTabHint(id: AccountTabId): void {
  try {
    sessionStorage.setItem(TAB_HINT_KEY, id);
  } catch {
    /* private mode — the drawer just opens on its default tab */
  }
}

/** Read the hint and consume it, so it steers exactly one open. */
export function takeTabHint(): AccountTabId | null {
  try {
    const v = sessionStorage.getItem(TAB_HINT_KEY);
    if (v) sessionStorage.removeItem(TAB_HINT_KEY);
    return ACCOUNT_TAB_IDS.includes(v as AccountTabId)
      ? (v as AccountTabId)
      : null;
  } catch {
    return null;
  }
}

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

/** Build the tab strip and its four panels into `host`. */
export function createAccountTabs(
  host: HTMLElement,
  deps: AccountTabsDeps = {},
): AccountTabsHandle {
  const strip = el("div", "account-tabs");
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", "Account sections");

  const tabs = new Map<AccountTabId, HTMLButtonElement>();
  const panels = new Map<AccountTabId, HTMLElement>();
  const enabled = new Map<AccountTabId, boolean>();

  for (const id of ACCOUNT_TAB_IDS) {
    const tab = el("button", "account-tab");
    tab.type = "button";
    tab.id = `account-tab-${id}`;
    tab.dataset.tab = id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `account-panel-${id}`);
    tab.setAttribute("aria-selected", "false");
    tab.tabIndex = -1;
    tab.append(el("span", "account-tab__label", TAB_LABELS[id]));
    tabs.set(tab.dataset.tab as AccountTabId, tab);

    const panel = el("div", "account-panel");
    panel.id = `account-panel-${id}`;
    panel.dataset.panel = id;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    // Focusable so keyboard users can reach panel content that starts with
    // non-focusable text.
    panel.tabIndex = 0;
    panel.hidden = true;
    panels.set(id, panel);

    enabled.set(id, true);
    strip.append(tab);
  }

  host.append(strip, ...panels.values());

  let current: AccountTabId = deps.initial ?? "login";

  const applyTabStops = (): void => {
    for (const [id, tab] of tabs) tab.tabIndex = id === current ? 0 : -1;
  };

  const paint = (): void => {
    for (const [id, tab] of tabs) {
      const on = id === current;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
      const panel = panels.get(id)!;
      panel.hidden = !on;
    }
    applyTabStops();
  };

  const select: AccountTabsHandle["select"] = (id, opts = {}) => {
    if (!enabled.get(id) && !opts.force) {
      deps.onBlocked?.(id);
      return;
    }
    const changed = id !== current;
    current = id;
    paint();
    if (opts.focus) tabs.get(id)?.focus();
    if (changed) deps.onShow?.(id);
  };

  const onClick = (e: MouseEvent): void => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      ".account-tab",
    );
    if (!btn?.dataset.tab) return;
    select(btn.dataset.tab as AccountTabId);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const order = ACCOUNT_TAB_IDS;
    const from = order.indexOf(current);
    let next = -1;
    if (e.key === "ArrowRight") next = (from + 1) % order.length;
    else if (e.key === "ArrowLeft") next = (from - 1 + order.length) % order.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = order.length - 1;
    if (next < 0) return;
    e.preventDefault();
    // Selection follows focus (the panels are cheap), except on a disabled
    // tab, where focus still moves so the rider can hear why it's dimmed.
    const target = order[next];
    if (enabled.get(target)) {
      select(target, { focus: true });
    } else {
      tabs.get(target)?.focus();
      deps.onBlocked?.(target);
    }
  };

  strip.addEventListener("click", onClick);
  strip.addEventListener("keydown", onKeyDown);
  paint();
  // Announce the initial panel so lazily-built panels get their first build.
  deps.onShow?.(current);

  return {
    strip,
    panel(id) {
      return panels.get(id)!;
    },
    select,
    selected() {
      return current;
    },
    setEnabled(id, on) {
      enabled.set(id, on);
      const tab = tabs.get(id)!;
      // aria-disabled, not `disabled`: a disabled button is unfocusable,
      // which would drop the tab out of the roving order and leave assistive
      // tech with no way to discover it or hear the reason.
      tab.setAttribute("aria-disabled", String(!on));
      tab.classList.toggle("is-disabled", !on);
    },
    isEnabled(id) {
      return enabled.get(id) ?? false;
    },
    dispose() {
      strip.removeEventListener("click", onClick);
      strip.removeEventListener("keydown", onKeyDown);
    },
  };
}
