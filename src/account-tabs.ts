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

/** Feather-style paths, matching the inline-SVG convention used for every
 *  other icon in the app: log-in, user, users, database. */
const TAB_ICON_PATHS: Record<AccountTabId, string[]> = {
  login: [
    "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4",
    "M10 17l5-5-5-5",
    "M15 12H3",
  ],
  profile: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M12 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0"],
  community: [
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
    "M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M23 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  local: [
    "M12 5m-9 0a9 3 0 1 0 18 0a9 3 0 1 0-18 0",
    "M21 12c0 1.66-4 3-9 3s-9-1.34-9-3",
    "M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5",
  ],
};

function tabIcon(id: AccountTabId): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "account-tab__icon");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // Decorative: the label beside it already names the tab.
  svg.setAttribute("aria-hidden", "true");
  for (const d of TAB_ICON_PATHS[id]) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

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
  /** Mark a tab as needing attention (a dot on the label). */
  setFlagged(id: AccountTabId, on: boolean): void;
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
    tab.append(tabIcon(id), el("span", "account-tab__label", TAB_LABELS[id]));
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
    setFlagged(id, on) {
      const tab = tabs.get(id)!;
      tab.classList.toggle("has-flag", on);
      // Announced, not just drawn: a dot nobody can hear is not a signal.
      if (on) tab.setAttribute("aria-description", "needs attention");
      else tab.removeAttribute("aria-description");
    },
    dispose() {
      strip.removeEventListener("click", onClick);
      strip.removeEventListener("keydown", onKeyDown);
    },
  };
}
