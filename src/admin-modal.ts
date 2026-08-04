// 🛡️ Manage admins — CRUD on the admin allowlist, opened from the
// Administrator Mode badge in the Account drawer.
//
// The allowlist is a database table (API sql/021) and this is the first UI
// for it that doesn't require the GitHub-gated portal. Two things about that
// shape the screen below:
//
//   * Adding an admin hands over exactly the power you hold, including this
//     screen. The copy says so rather than presenting it as adding a row.
//   * The API refuses to remove the last admin (409). The UI mirrors that
//     rather than discovering it — a disabled button with a reason beats a
//     request that was always going to fail.
//
// Both writes return the refreshed list, so every mutation redraws from its
// own response and never chases it with a second fetch.

import {
  ApiError,
  addAdmin,
  fetchAdmins,
  removeAdmin,
  type AdminEntry,
  type AdminList,
} from "./api.ts";
import { openFloatingModal } from "./devices.ts";

/** Short, locale-friendly date for the "added" column. */
function formatAdded(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rider-facing text for a failed allowlist call. The 409 is the one that
 *  most needs its own sentence: it is a refusal with a reason, not a fault. */
function adminErrorText(err: unknown, action: "load" | "add" | "remove"): string {
  const api = err instanceof ApiError ? err : null;
  if (api?.code === "NO_AUTH" || api?.code === "TOKEN_REJECTED") {
    return "Your session ended — sign in again.";
  }
  switch (api?.status) {
    case 400:
      return "That doesn't look like an email address.";
    case 403:
      return "You're no longer an admin, so this list is closed to you.";
    case 409:
      // The API's own detail names the way out (add another admin, or use
      // the portal); prefer it over anything invented here.
      return typeof api.detail === "string" && api.detail
        ? api.detail
        : "That's the last admin — add another first.";
    case 429:
      return api.retryAfter
        ? `Too many changes — try again in ~${Math.max(1, Math.ceil(api.retryAfter / 60))}m.`
        : "Too many changes — try again later.";
    default:
      if (action === "load") return "Couldn't load the admin list.";
      return action === "add" ? "Couldn't add that admin." : "Couldn't remove that admin.";
  }
}

function rowHtml(a: AdminEntry, soleAdmin: boolean): string {
  const added = formatAdded(a.added_at);
  const by = a.added_by ? `added by ${a.added_by}` : "added before we tracked who";
  // The last admin cannot be removed — the API refuses with a 409, so the
  // button says why instead of firing a doomed request.
  const removeBtn = soleAdmin
    ? `<button type="button" class="admin-modal__remove" disabled title="The allowlist can't be left empty — add another admin first.">Remove</button>`
    : `<button type="button" class="admin-modal__remove" data-email="${escapeHtml(a.email)}"${
        a.is_you ? ' data-self="1"' : ""
      }>Remove</button>`;
  return `<li class="admin-modal__row${a.is_you ? " is-you" : ""}">
      <div class="admin-modal__who">
        <span class="admin-modal__email">${escapeHtml(a.email)}</span>
        ${a.is_you ? `<span class="admin-modal__you">you</span>` : ""}
        <span class="admin-modal__meta">${escapeHtml(by)}${added ? ` · ${escapeHtml(added)}` : ""}</span>
      </div>
      ${removeBtn}
    </li>`;
}

/** Open the modal.
 *
 *  `onAuthLost` mirrors the Account drawer's handler so a rejected token
 *  flips the drawer to signed-out here too.
 *
 *  `onAdminRevoked` fires when the rider removes THEMSELVES and the server
 *  confirms it. It has to exist: the server's answer is live (is_admin_email
 *  is evaluated per request), but the client's copy is not — the admin flag
 *  is pushed into Devices once per token, and /auth/session is read once per
 *  panel build. Without this, someone who just revoked their own access
 *  keeps the proximity bypass and the Administrator Mode surface until they
 *  reload, which is precisely what the confirmation told them would not
 *  happen. */
export function openAdminModal(
  opts: { onAuthLost?: () => void; onAdminRevoked?: () => void } = {},
): void {
  openFloatingModal(
    "🛡️ Manage admins",
    `<div class="admin-modal">
       <p class="admin-modal__fine">Anyone here can see plate-level data, skip the map's proximity gates — and manage this list. Adding someone hands them exactly what you have.</p>
       <ul class="admin-modal__list" aria-live="polite">
         <li class="admin-modal__note">Loading…</li>
       </ul>
       <form class="admin-modal__add">
         <input type="email" class="admin-modal__input" placeholder="new.admin@example.com"
           aria-label="Email address to add as admin" autocomplete="off" required />
         <button type="submit" class="admin-modal__submit">Add admin</button>
       </form>
       <p class="admin-modal__status" role="status" aria-live="polite"></p>
     </div>`,
    (root) => wireAdminModal(root, opts),
  );
}

function wireAdminModal(
  root: HTMLElement | null,
  opts: { onAuthLost?: () => void; onAdminRevoked?: () => void },
): void {
  const list = root?.querySelector<HTMLElement>(".admin-modal__list");
  const form = root?.querySelector<HTMLFormElement>(".admin-modal__add");
  const input = root?.querySelector<HTMLInputElement>(".admin-modal__input");
  const submit = root?.querySelector<HTMLButtonElement>(".admin-modal__submit");
  const status = root?.querySelector<HTMLElement>(".admin-modal__status");
  if (!root || !list || !form || !input || !submit || !status) return;

  // Every path here is async and the modal can be closed (✕, backdrop,
  // Escape) mid-flight, so nothing touches the DOM without checking.
  const setStatus = (text: string): void => {
    if (root.isConnected) status.textContent = text;
  };
  /** Close through the shell's own ✕ so its Escape listener detaches too —
   *  a bare remove() would orphan a document-level handler. */
  const closeModal = (): void => {
    document
      .querySelector<HTMLButtonElement>(".ranks-modal .ranks-modal__close")
      ?.click();
  };
  const onError = (err: unknown, action: "load" | "add" | "remove"): void => {
    if (err instanceof ApiError && err.code === "TOKEN_REJECTED") {
      opts.onAuthLost?.();
    }
    setStatus(adminErrorText(err, action));
  };

  const render = (data: AdminList): void => {
    if (!root.isConnected) return;
    const soleAdmin = data.admins.length <= 1;
    list.innerHTML = data.admins.length
      ? data.admins.map((a) => rowHtml(a, soleAdmin)).join("")
      : `<li class="admin-modal__note">Nobody is on the allowlist.</li>`;
    list
      .querySelectorAll<HTMLButtonElement>(".admin-modal__remove[data-email]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const email = btn.dataset.email ?? "";
          // Removing yourself is allowed by the API while others remain, and
          // it is the one click here that can't be undone from this screen.
          if (
            btn.dataset.self === "1" &&
            !window.confirm(
              `Remove your own admin access (${email})? You'll lose this screen immediately.`,
            )
          ) {
            return;
          }
          const wasSelf = btn.dataset.self === "1";
          btn.disabled = true;
          setStatus(`Removing ${email}…`);
          removeAdmin(email)
            .then((res) => {
              if (wasSelf && res.removed) {
                // Hand the revocation to the session owner BEFORE redrawing:
                // it drops the admin flag (which re-gates any open device
                // popup) and takes down the Administrator Mode surface this
                // modal was opened from. Then close — a list you can no
                // longer read, with buttons that would now 403, is not a
                // screen worth leaving up.
                opts.onAdminRevoked?.();
                closeModal();
                return;
              }
              render(res);
              setStatus(
                res.removed ? `Removed ${res.email}.` : `${res.email} wasn't on the list.`,
              );
            })
            .catch((err: unknown) => {
              if (root.isConnected) btn.disabled = false;
              onError(err, "remove");
            });
        });
      });
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!email) return;
    submit.disabled = true;
    setStatus(`Adding ${email}…`);
    addAdmin(email)
      .then((res) => {
        render(res);
        input.value = "";
        setStatus(
          res.added
            ? `${res.email} is now an admin.`
            : `${res.email} was already an admin.`,
        );
      })
      .catch((err: unknown) => onError(err, "add"))
      .finally(() => {
        if (root.isConnected) submit.disabled = false;
      });
  });

  fetchAdmins()
    .then(render)
    .catch((err: unknown) => {
      if (root.isConnected) {
        list.innerHTML = `<li class="admin-modal__note">${escapeHtml(adminErrorText(err, "load"))}</li>`;
      }
      if (err instanceof ApiError && err.code === "TOKEN_REJECTED") {
        opts.onAuthLost?.();
      }
    });
}
