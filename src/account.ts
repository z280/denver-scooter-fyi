// Signed-in body of the Account drawer. wireAccount() in main.ts keeps the
// signed-out sign-in doors and top-level dispatch; the whole signed-in view
// lives here so the profile surface can grow without growing main.ts (the
// new-module split docs/API_INTEGRATION_PLAN.md prescribes).

import { fetchSessionInfo, isAdminSession } from "./auth-session.ts";
import { signOut } from "./map-auth.js";

export interface AccountSignedInDeps {
  /** Push resolved admin status to the device layer (popup gates). */
  setAdminSession(on: boolean): void;
  /** The server rejected the token mid-use; storage is already cleared —
   *  re-render the drawer so it reflects the signed-out state. */
  onAuthLost(): void;
}

export interface AccountHandle {
  /** Cheap in-place update (session countdown); never rebuilds DOM, so open
   *  editors and in-flight edits survive the minute tick and focus events. */
  refresh(): void;
  /** Clear timers/listeners before the container is torn down or rebuilt. */
  dispose(): void;
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

function formatRemaining(expiresIso: string): string {
  const ms = new Date(expiresIso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Build the signed-in account panel into `body` (assumed empty). Called
 *  once per token by wireAccount(); returns the refresh/dispose handle its
 *  re-render loop drives. */
export function renderSignedInAccount(
  body: HTMLElement,
  auth: { token: string; expires: string },
  deps: AccountSignedInDeps,
): AccountHandle {
  let disposed = false;

  const status = el("div", "account-status");
  const row = el("div", "account-status__row");
  row.append(
    el("span", "account-status__dot"),
    el("strong", undefined, "Signed in"),
  );
  const expirySpan = el("span", undefined, formatRemaining(auth.expires));
  const expiryP = el("p", "account-status__expiry");
  expiryP.append(document.createTextNode("Session expires in "), expirySpan);
  status.append(row, expiryP);

  // Administrator Mode badge slot, filled once /auth/session confirms the
  // session is on the admin allowlist (enforced server-side).
  const adminSlot = el("div");

  const signoutBtn = el("button", "login-btn login-btn--secondary", "Sign out");
  signoutBtn.type = "button";
  signoutBtn.addEventListener("click", async () => {
    signoutBtn.disabled = true;
    signoutBtn.textContent = "Signing out…";
    try {
      await signOut();
    } finally {
      // Reload so all data refetches drop back to the public endpoint
      // and the UI resets cleanly to the unauthenticated state.
      location.reload();
    }
  });

  body.append(status, adminSlot, signoutBtn);

  // Resolve admin status once per panel build (wireAccount rebuilds only on
  // token change, so this is once per token).
  void fetchSessionInfo().then((info) => {
    if (disposed) return;
    const adminOn = isAdminSession(info);
    // Popups need the status too: admins skip the Start proximity gate
    // (issue #18).
    deps.setAdminSession(adminOn);
    if (adminOn) {
      const badge = el("div", "account-admin");
      const brow = el("div", "account-admin__row");
      brow.append(
        el("span", "account-admin__icon", "🛡️"),
        el("strong", undefined, "Administrator Mode"),
      );
      badge.append(brow);
      if (info?.email) badge.append(el("p", "account-admin__email", info.email));
      adminSlot.append(badge);
    }
  });

  return {
    refresh() {
      expirySpan.textContent = formatRemaining(auth.expires);
    },
    dispose() {
      disposed = true;
    },
  };
}
