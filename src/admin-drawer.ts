// ⚙ Admin — the one place admin controls live (owner request, 2026-10-09).
//
// Before this, admin controls were scattered: an "Admin tools" section at the
// bottom of Tools (the fe#72 traffic and events charts), the 🛡️ Manage admins
// launcher inside the Account drawer's Administrator Mode badge (fe#48), and,
// briefly, the add-a-watch-by-plate form. A rider's Tools drawer is now rider
// tools only, and everything an admin can do from the map is behind one tab.
//
// THE TAB EXISTS ONLY FOR AN ADMIN. It is in the markup with `hidden`, because
// `wireDrawers()` collects tabs once at boot and a tab added later would never
// open anything; tools-drawer.css pins `[hidden]` to `display: none
// !important` on this one tab, since `.drawer-tab`'s own `display` has beaten
// a plain `hidden` before (see index.html's note on the Compliance tab). The
// drawer's CONTROLS are stronger than hidden: they are built here when the
// session becomes an admin's and removed when it stops, so a rider's DOM never
// carries them at all.
//
// LIVE. `setAdmin` is driven by the same push the device popups use
// (`setAdminSession`, fe#48): it flips on when /auth/session says admin, off on
// sign-out and on self-removal from the Manage admins modal — and an open Admin
// drawer closes itself when that happens rather than staying up for somebody
// who can no longer use it.
//
// Every endpoint behind these controls is require_admin regardless; this is
// about who is OFFERED them. The add-by-plate watch is client-side, so for
// that one the UI gate is the whole gate (device-notify.ts, WATCH_RULES.admin).

import type { AnalyticsReportKind } from "./admin-analytics.ts";

/** The server's own admin portal (GitHub sign-in): cycles, failures,
 *  scheduler, regions, admins, analytics and campaigns. */
export const SERVER_ADMIN_URL = "https://data.scooter.fyi/admin";

export interface AdminDrawerDeps {
  /** The ribbon tab (`[data-drawer="admin"]`), in the markup with `hidden`. */
  tab: HTMLElement;
  /** The drawer's body, filled only while the session is an admin's. */
  body: HTMLElement;
  /** Close the drawer if it is open (its own × button, so `wireDrawers`
   *  does the bookkeeping). */
  close(): void;
  /** The add-a-watch-by-plate host that `tools-mine.ts` builds its form into.
   *  Stable across rebuilds, so the form and its status line survive. */
  watchHost: HTMLElement;
  openManageAdmins(): void;
  openReport(kind: AnalyticsReportKind): void;
}

export interface AdminDrawerHandle {
  setAdmin(on: boolean): void;
  isAdmin(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function section(id: string, title: string, hint?: string): HTMLElement {
  const sec = el("section", "control-group");
  const h = el("h3", "control-label", title);
  h.id = id;
  sec.setAttribute("aria-labelledby", id);
  sec.append(h);
  if (hint) sec.append(el("p", "control-hint", hint));
  return sec;
}

function button(id: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "preset-btn", label);
  b.id = id;
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function wireAdminDrawer(deps: AdminDrawerDeps): AdminDrawerHandle {
  let on = false;

  function build(): void {
    const watches = section(
      "admin-watch-label",
      "Watch a scooter by plate",
      "Adds it to Tools → Your dibs & watches, and tells you if it moves while the app is open.",
    );
    watches.append(deps.watchHost);

    const admins = section(
      "admin-manage-label",
      "Admins",
      "Who can see plate-level data, skip the map's proximity gates, and use this drawer.",
    );
    admins.append(button("admin-manage", "🛡️ Manage admins", deps.openManageAdmins));

    const analytics = section(
      "admin-analytics-label",
      "Traffic analytics",
      "From the daily telemetry rollups — aggregate only, same data as the server's dashboard.",
    );
    analytics.append(
      button("admin-traffic", "📈 Traffic overview", () => deps.openReport("traffic")),
      button("admin-events", "📊 Events by day", () => deps.openReport("events")),
    );

    const server = section(
      "admin-server-label",
      "Server",
      "Cycles, failures, scheduler, regions, admins, analytics and campaigns. Signs in with GitHub.",
    );
    const link = el("a", "preset-btn admin-drawer__server", "Server admin panel ↗");
    link.id = "admin-server-link";
    link.href = SERVER_ADMIN_URL;
    link.target = "_blank";
    link.rel = "noopener";
    server.append(link);

    deps.body.replaceChildren(watches, admins, analytics, server);
  }

  return {
    setAdmin(next: boolean) {
      if (next === on) return;
      on = next;
      deps.tab.hidden = !on;
      if (on) {
        build();
      } else {
        // Shut it first: an open drawer whose tab has vanished has no way
        // back out through the ribbon.
        if (deps.tab.classList.contains("is-active")) deps.close();
        deps.body.replaceChildren();
      }
    },
    isAdmin: () => on,
  };
}
