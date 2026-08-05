// Signed-in body of the Account drawer. wireAccount() in main.ts keeps the
// signed-out sign-in doors and top-level dispatch; the whole signed-in view
// lives here so the profile surface can grow without growing main.ts (the
// new-module split docs/API_INTEGRATION_PLAN.md prescribes).

import {
  ApiError,
  fetchAdjectives,
  fetchEmojiNouns,
  fetchPoints,
  fetchProfile,
  fetchRoyaltyTitles,
  fetchRulingColors,
  regenerateUsername,
  requestPhoneCode,
  setUsername,
  updateProfile,
  verifyPhoneNumber,
  type PointsEntry,
  type Profile,
  type ProfileUpdate,
} from "./api.ts";
import { fetchSessionInfo, isAdminSession } from "./auth-session.ts";
import { openAdminModal } from "./admin-modal.ts";
import { signOut } from "./map-auth.js";
import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import {
  applyServerRatePlan,
  saveRatePlan,
  setRatePlanSyncHook,
  toApiRatePlan,
} from "./ride-cost.ts";
import { reverseGeocode } from "./geocode.ts";
import type { HomeWorkPoints } from "./home-work-pins.ts";
import { formatUsPhone, isProbablyUsPhone } from "./auth-sms.ts";
import { TERRITORY_FILL_OPACITY, hexWithAlpha } from "./leaderboard.ts";

/** Where each group of sections mounts when the drawer is tabbed. Omitting
 *  this renders everything into one body, as the drawer did before tabs —
 *  which keeps this module usable (and testable) on its own. */
export interface AccountPanelMounts {
  /** Session status, admin badge, sign out. */
  login: HTMLElement;
  /** Contact details, rate plan, home and work. */
  profile: HTMLElement;
  /** Public identity, privacy, badges, points. */
  community: HTMLElement;
}

export interface AccountSignedInDeps {
  /** Push resolved admin status to the device layer (popup gates). */
  setAdminSession(on: boolean): void;
  /** The server rejected the token mid-use; storage is already cleared —
   *  re-render the drawer so it reflects the signed-out state. */
  onAuthLost(): void;
  /** Tab mount points; absent means the legacy single-body layout. */
  panels?: AccountPanelMounts;
  /** The profile is (in)complete. Lets the tab strip carry the nag, so it is
   *  visible from Community or Local Data too — the ten points are easy to
   *  miss when the hint only lives on the tab you are not looking at. */
  onCompletenessChanged?(complete: boolean): void;
  /** Whether the backend can actually send a text right now (`sms_enabled`
   *  from /auth/config), or null while that is still unknown. Read on every
   *  render rather than captured, because the config resolves independently
   *  of the profile and may land after this panel is built. */
  smsEnabled?(): boolean | null;
  /** Let the rider drop a point on the map for home or work. Absent means
   *  the row offers only "Use my location" and "Clear", as it always has —
   *  which is also what keeps this module free of any map import. */
  pickLocation?(kind: "home" | "work"): Promise<{ lat: number; lng: number } | null>;
  /** Home/work moved (or were cleared): redraw the pins. */
  onLocationsChanged?(points: HomeWorkPoints): void;
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

/** Inline feedback line: the drawer's one feedback mechanism (no toasts). */
interface StatusLine {
  node: HTMLParagraphElement;
  set(msg: string, isError?: boolean): void;
  clear(): void;
}

function makeStatus(): StatusLine {
  const node = el("p", "account-magic-status");
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  return {
    node,
    set(msg, isError = false) {
      node.textContent = msg;
      node.classList.toggle("account-magic-status--error", isError);
    },
    clear() {
      this.set("");
    },
  };
}

function accountSection(title: string): HTMLElement {
  const sec = el("section", "account-section");
  sec.append(el("h3", "account-section__title", title));
  return sec;
}

/** Known badge ids → chip emoji. Unknown ids (the API adds badges without
 *  notice) fall back to a generic medal and the server-provided label. */
const BADGE_EMOJI: Record<string, string> = {
  first_report: "📝",
  reporter_10: "🗣️",
  ghost_hunter: "👻",
  discount_watchdog: "🏷️",
  miles_10: "🛴",
  miles_100: "🏁",
  streak_7: "🔥",
};

/** Unique-id counter for combobox aria wiring (ids must be document-unique). */
let comboUid = 0;

/** Feather's `settings` gear, matching the inline-SVG convention used for
 *  every other icon in the app. */
function gearIcon(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "3");
  const path = document.createElementNS(NS, "path");
  path.setAttribute(
    "d",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  );
  svg.append(circle, path);
  return svg;
}

// Whether the community settings block is expanded. sessionStorage, not
// localStorage: it is view state, not a preference, and the "keep profile
// data on the server" rule is about the profile, not about which sections
// happen to be open.
const COMMUNITY_OPEN_KEY = "scooter_fyi.community_settings_open";

function communitySettingsOpen(): boolean {
  try {
    return sessionStorage.getItem(COMMUNITY_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function rememberCommunitySettingsOpen(open: boolean): void {
  try {
    sessionStorage.setItem(COMMUNITY_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* private mode — it just reopens expanded next time */
  }
}

/** True once every completion criterion the API scores is met (email AND
 *  rate plan AND phone AND at least one of home/work) — worth 10 points. */
function isProfileComplete(p: Profile): boolean {
  const home = p.home_lat != null && p.home_lng != null;
  const work = p.work_lat != null && p.work_lng != null;
  return !!(p.email && p.phone_number && p.rate_plan && (home || work));
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
  // The one client-side copy of the profile; every successful PUT replaces
  // it with the server's response, and controls re-sync from it.
  let profile: Profile | null = null;
  // The signed-in email from /auth/session — a sensible suggestion for an
  // empty profile email field.
  let sessionEmail: string | undefined;

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

  // Everything profile-shaped renders in here, between the status header
  // and the sign-out button.
  const profileSlot = el("div", "account-profile");

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

  // Everything community-shaped renders here: identity, privacy, badges,
  // points. Empty (and unmounted) in the legacy single-body layout, where
  // those sections stay in profileSlot with the rest.
  const communitySlot = el("div", "account-community");

  const mounts = deps.panels;
  if (mounts) {
    mounts.login.append(status, adminSlot, signoutBtn);
    mounts.profile.append(profileSlot);
    mounts.community.append(communitySlot);
  } else {
    body.append(status, adminSlot, profileSlot, signoutBtn);
  }

  // Resolve admin status once per panel build (wireAccount rebuilds only on
  // token change, so this is once per token).
  void fetchSessionInfo().then((info) => {
    if (disposed) return;
    sessionEmail = info?.email;
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
      // 🛡️ Manage admins — the allowlist is a database table (API sql/021),
      // and this is the first way to edit it without the GitHub-gated
      // portal. Rendered inside the admin branch, so it exists only for
      // someone the server has already called an admin; the endpoints
      // behind it are require_admin regardless.
      const manage = el("button", "account-admin__manage", "🛡️ Manage admins");
      manage.type = "button";
      manage.addEventListener("click", () =>
        openAdminModal({
          onAuthLost: () => deps.onAuthLost(),
          // Removing your OWN row is the one action here that changes what
          // this session may do. The server already knows — is_admin_email
          // is evaluated per request — but the client's copy of "am I admin"
          // is pushed once per token, so without this the rider keeps the
          // proximity bypass and this very badge until they reload. Dropping
          // the flag also re-gates any open device popup (see
          // Devices.setAdminSession).
          onAdminRevoked: () => {
            deps.setAdminSession(false);
            adminSlot.replaceChildren();
          },
        }),
      );
      badge.append(manage);
      adminSlot.append(badge);
    }
  });

  /** Turn a write failure into user-facing copy. TOKEN_REJECTED flips the
   *  drawer to signed-out as a side effect (storage is already cleared). */
  const describeError = (e: unknown, fallback: string): string => {
    if (e instanceof ApiError) {
      if (e.code === "TOKEN_REJECTED") {
        deps.onAuthLost();
        return "Your session ended — sign in again.";
      }
      if (e.status === 429) {
        const mins = e.retryAfter
          ? Math.max(1, Math.ceil(e.retryAfter / 60))
          : null;
        return mins
          ? `Too many changes — try again in ~${mins}m.`
          : "Too many changes — try again later.";
      }
      if (typeof e.detail === "string" && e.detail) return e.detail;
      if (e.errorKey) return `That change wasn't accepted (${e.errorKey}).`;
    }
    return navigator.onLine === false
      ? "You look offline — change not saved."
      : fallback;
  };

  // The phone verification row, once built — the handle's refresh() nudges
  // it so a late /auth/config answer reaches it without a rebuild.
  let phoneVerifyRow: { syncCapability(): void } | null = null;
  // Status line of the rate-plan control, once built — the sync hook below
  // reports there whichever picker (drawer or HUD) triggered it.
  let rateSyncStatus: StatusLine | null = null;
  // Fires after any successful profile PUT; the points section listens to
  // notice the one-time completion award landing.
  let onProfileSaved: (() => void) | null = null;

  /** All profile writes funnel through here so the cache, the completion
   *  hint, and interested sections stay in sync. Writes are sequenced:
   *  when PUTs overlap (independent fields each have their own Save), only
   *  the latest write's response becomes the cache, so an early response
   *  arriving late can't roll the cache back. */
  let saveSeq = 0;
  const savePatch = async (patch: ProfileUpdate): Promise<Profile> => {
    const seq = ++saveSeq;
    const updated = await updateProfile(patch);
    if (!disposed && seq === saveSeq) {
      profile = updated;
      refreshHint();
      publishLocations();
      onProfileSaved?.();
    }
    return updated;
  };

  /** Keep the map's home/work pins in step with the profile. */
  const publishLocations = (): void => {
    if (!deps.onLocationsChanged) return;
    const p = profile;
    deps.onLocationsChanged({
      home:
        p?.home_lat != null && p.home_lng != null
          ? { lat: p.home_lat, lng: p.home_lng }
          : null,
      work:
        p?.work_lat != null && p.work_lng != null
          ? { lat: p.work_lat, lng: p.work_lng }
          : null,
    });
  };

  // ----- Completion hint (10 one-time points; criteria mirror the API) ----
  const hint = el(
    "p",
    "account-hint",
    "⭐ Complete your profile — email, phone, rate plan, and one location — to earn 10 bonus points.",
  );
  const refreshHint = (): void => {
    const complete = profile ? isProfileComplete(profile) : true;
    hint.hidden = complete;
    deps.onCompletenessChanged?.(complete);
  };

  // ----- Field builders --------------------------------------------------

  /** Labeled text input with an explicit Save revealed on edit (submit via
   *  the button or Enter — never blur alone; mobile keyboards dismiss
   *  unpredictably). Empty saves as null (both fields are nullable). */
  const textField = (opts: {
    label: string;
    type: string;
    value: string;
    placeholder: string;
    autocomplete?: string;
    fallbackError: string;
    /** Resolves with the canonical stored value (the server may normalize,
     *  e.g. phone numbers) so the field can re-sync after save. */
    save(v: string | null): Promise<string | null>;
  }): HTMLElement => {
    const wrap = el("div", "account-field");
    wrap.append(el("span", "control-label", opts.label));
    const form = el("form", "account-field__row");
    const input = el("input", "select");
    input.type = opts.type;
    input.value = opts.value;
    input.placeholder = opts.placeholder;
    if (opts.autocomplete) input.setAttribute("autocomplete", opts.autocomplete);
    input.setAttribute("aria-label", opts.label);
    const saveBtn = el("button", "text-btn account-field__save", "Save");
    saveBtn.type = "submit";
    saveBtn.hidden = true;
    const fieldStatus = makeStatus();
    let savedValue = opts.value;
    input.addEventListener("input", () => {
      saveBtn.hidden = input.value.trim() === savedValue;
      fieldStatus.clear();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v === savedValue || saveBtn.disabled) return;
      saveBtn.disabled = true;
      fieldStatus.set("Saving…");
      opts
        .save(v === "" ? null : v)
        .then((canonical) => {
          savedValue = canonical ?? "";
          input.value = savedValue;
          saveBtn.disabled = false;
          saveBtn.hidden = true;
          fieldStatus.set("Saved.");
        })
        .catch((err: unknown) => {
          saveBtn.disabled = false;
          fieldStatus.set(describeError(err, opts.fallbackError), true);
        });
    });
    form.append(input, saveBtn);
    wrap.append(form, fieldStatus.node);
    return wrap;
  };

  /** Home/Work row: reverse-geocoded readout plus one-shot "Use my
   *  location" (deliberately not the map-bound Locate control — the drawer
   *  wants a single fix, no camera movement) and Clear. Coordinates PUT as
   *  a pair, per the API contract. */
  const locationRow = (kind: "home" | "work", label: string): HTMLElement => {
    const wrap = el("div", "account-field");
    wrap.append(el("span", "control-label", label));
    // The value gets its own line: with three actions beside it, a street
    // address (or a coordinate pair) would wrap mid-number in a 300px drawer.
    const rowEl = el("div", "account-field__row account-location");
    const value = el("span", "account-location__value");
    const pickBtn = el("button", "text-btn", "Pick on map");
    pickBtn.type = "button";
    // Only offered when the drawer was handed a picker — the module stays
    // free of any map import, and its tests stay free of a map.
    pickBtn.hidden = !deps.pickLocation;
    const useBtn = el("button", "text-btn", "Use my location");
    useBtn.type = "button";
    const clearBtn = el("button", "text-btn", "Clear");
    clearBtn.type = "button";
    const rowStatus = makeStatus();

    const coords = (): { lat: number | null; lng: number | null } =>
      kind === "home"
        ? { lat: profile?.home_lat ?? null, lng: profile?.home_lng ?? null }
        : { lat: profile?.work_lat ?? null, lng: profile?.work_lng ?? null };

    const renderValue = (): void => {
      const { lat, lng } = coords();
      if (lat == null || lng == null) {
        value.textContent = "Not set";
        clearBtn.hidden = true;
        return;
      }
      clearBtn.hidden = false;
      value.textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      void reverseGeocode(lat, lng).then((addr) => {
        const cur = coords();
        if (addr && cur.lat === lat && cur.lng === lng) {
          value.textContent = addr;
        }
      });
    };

    const putPair = (lat: number | null, lng: number | null): void => {
      useBtn.disabled = true;
      clearBtn.disabled = true;
      rowStatus.set("Saving…");
      const patch: ProfileUpdate =
        kind === "home"
          ? { home_lat: lat, home_lng: lng }
          : { work_lat: lat, work_lng: lng };
      savePatch(patch)
        .then(() => {
          rowStatus.set("Saved.");
          renderValue();
        })
        .catch((err: unknown) => {
          rowStatus.set(
            describeError(err, `Couldn't save your ${kind} location.`),
            true,
          );
        })
        .finally(() => {
          useBtn.disabled = false;
          clearBtn.disabled = false;
        });
    };

    useBtn.addEventListener("click", () => {
      if (!("geolocation" in navigator)) {
        rowStatus.set("This browser can't share your location.", true);
        return;
      }
      useBtn.disabled = true;
      rowStatus.set("Locating…");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          putPair(
            Number(pos.coords.latitude.toFixed(5)),
            Number(pos.coords.longitude.toFixed(5)),
          );
        },
        () => {
          useBtn.disabled = false;
          rowStatus.set(
            "Location unavailable — allow location access and retry.",
            true,
          );
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    });
    pickBtn.addEventListener("click", () => {
      const pick = deps.pickLocation;
      if (!pick) return;
      rowStatus.set("Tap the map…");
      void pick(kind).then((point) => {
        if (disposed) return;
        if (!point) {
          rowStatus.clear();
          return;
        }
        // Same 5-decimal store as every other way of setting this (~1 m,
        // which is finer than any of these sources actually resolve).
        putPair(
          Number(point.lat.toFixed(5)),
          Number(point.lng.toFixed(5)),
        );
      });
    });
    clearBtn.addEventListener("click", () => putPair(null, null));

    rowEl.append(value, pickBtn, useBtn, clearBtn);
    wrap.append(rowEl, rowStatus.node);
    renderValue();
    return wrap;
  };

  // ----- Combo input (adjective / emoji-noun pickers) --------------------

  interface ComboEntry {
    /** Canonical value sent to the API. */
    value: string;
    /** What the user sees and types against. */
    label: string;
    /** Extra strings that count as an exact match (e.g. the noun word,
     *  so "owl" resolves without typing the emoji). */
    terms?: string[];
  }

  /** What the input currently resolves to: nothing typed, typed text that
   *  matches no curated entry (must not be silently dropped), or a value. */
  type ComboResolution =
    | { kind: "empty" }
    | { kind: "unmatched" }
    | { kind: "value"; value: string };

  interface Combo {
    node: HTMLElement;
    resolve(): ComboResolution;
  }

  /** Lightweight combobox: text input filtering a curated list client-side
   *  (the lexicons are small and fetched once), listbox of ≤8 matches,
   *  Arrow/Enter/Escape keyboard support. No free text reaches the API —
   *  only canonical entry values. */
  const makeCombo = (label: string, entries: ComboEntry[]): Combo => {
    const uid = `combo-${++comboUid}`;
    const wrap = el("div", "combo");
    const input = el("input", "select");
    input.type = "text";
    input.placeholder = label;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-label", label);
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", `${uid}-list`);
    const list = el("ul", "combo__list");
    list.id = `${uid}-list`;
    list.setAttribute("role", "listbox");
    list.hidden = true;

    let picked: ComboEntry | null = null;
    let matches: ComboEntry[] = [];
    let highlighted = -1;

    const close = (): void => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      highlighted = -1;
    };
    const pick = (entry: ComboEntry): void => {
      picked = entry;
      input.value = entry.label;
      close();
    };
    const renderList = (): void => {
      const q = input.value.trim().toLowerCase();
      matches = (
        q
          ? entries.filter((e) => e.label.toLowerCase().includes(q))
          : entries
      ).slice(0, 8);
      list.replaceChildren(
        ...matches.map((entry, i) => {
          const li = el("li", "combo__option", entry.label);
          li.id = `${uid}-opt-${i}`;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", String(i === highlighted));
          // mousedown beats the input's blur, so the pick lands first.
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            pick(entry);
          });
          return li;
        }),
      );
      list.hidden = matches.length === 0;
      input.setAttribute("aria-expanded", String(!list.hidden));
      // Announce and reveal the keyboard highlight.
      if (highlighted >= 0 && highlighted < matches.length) {
        input.setAttribute("aria-activedescendant", `${uid}-opt-${highlighted}`);
        list.children[highlighted]?.scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    };

    input.addEventListener("input", () => {
      picked = null;
      highlighted = -1;
      renderList();
    });
    input.addEventListener("focus", renderList);
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // Swallow it while the list is open: Escape should close the
        // dropdown, not the whole drawer (document-level handler).
        if (!list.hidden) e.stopPropagation();
        close();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) renderList();
        if (!matches.length) return;
        const delta = e.key === "ArrowDown" ? 1 : -1;
        highlighted =
          (highlighted + delta + matches.length) % matches.length;
        renderList();
        return;
      }
      if (e.key === "Enter" && !list.hidden && highlighted >= 0) {
        e.preventDefault();
        pick(matches[highlighted]);
      }
    });

    wrap.append(input, list);
    return {
      node: wrap,
      resolve() {
        if (picked) return { kind: "value", value: picked.value };
        const typed = input.value.trim().toLowerCase();
        if (!typed) return { kind: "empty" };
        const exact = entries.find(
          (e) =>
            e.label.toLowerCase() === typed ||
            e.value.toLowerCase() === typed ||
            e.terms?.some((t) => t.toLowerCase() === typed),
        );
        return exact ? { kind: "value", value: exact.value } : { kind: "unmatched" };
      },
    };
  };

  // ----- Public identity section -----------------------------------------

  const buildIdentitySection = (): HTMLElement => {
    const sec = accountSection("Public identity");

    const line = el("div", "username-line");
    const displayEl = el("div", "username-line__display");
    const rawEl = el("div", "username-line__raw");
    line.append(displayEl, rawEl);
    const renderNameLine = (): void => {
      const name = profile?.display_name ?? profile?.public_username ?? "—";
      displayEl.textContent = name;
      const raw = profile?.public_username ?? "";
      rawEl.textContent = raw;
      rawEl.hidden = !raw || raw === name;
    };
    renderNameLine();

    const nameStatus = makeStatus();
    const regenBtn = el("button", "text-btn", "New random name");
    regenBtn.type = "button";
    const chooseBtn = el("button", "text-btn", "Choose…");
    chooseBtn.type = "button";
    const actions = el("div", "account-field__row");
    actions.append(regenBtn, chooseBtn);
    const pickerSlot = el("div");

    /** display_name is a server-side generated column (title + " " + name);
     *  mirror the formula locally so a username change needs no refetch. */
    const applyUsername = (newName: string): void => {
      if (!profile) return;
      profile.public_username = newName;
      profile.display_name = profile.royalty_title
        ? `${profile.royalty_title} ${newName}`
        : newName;
      renderNameLine();
    };

    // Regenerate and set share ONE 10/hour rate-limit bucket — a 429 from
    // either locks both until the window lapses (and survives reopening
    // the picker, since the lock lives on the buttons themselves).
    let usernameActions: HTMLButtonElement[] = [regenBtn, chooseBtn];
    const lockUsernameActions = (seconds: number): void => {
      for (const b of usernameActions) b.disabled = true;
      window.setTimeout(
        () => {
          if (disposed) return;
          for (const b of usernameActions) b.disabled = false;
          nameStatus.clear();
        },
        Math.max(1, seconds) * 1000,
      );
    };
    const handleUsernameError = (err: unknown, fallback: string): void => {
      if (err instanceof ApiError && err.status === 429) {
        nameStatus.set(describeError(err, fallback), true);
        lockUsernameActions(err.retryAfter ?? 15 * 60);
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        nameStatus.set("That combination is taken — pick another.", true);
        return;
      }
      nameStatus.set(describeError(err, fallback), true);
    };

    regenBtn.addEventListener("click", () => {
      regenBtn.disabled = true;
      nameStatus.set("Rolling…");
      regenerateUsername()
        .then((res) => {
          if (disposed) return;
          regenBtn.disabled = false;
          applyUsername(res.public_username);
          nameStatus.set("Saved.");
        })
        .catch((err: unknown) => {
          if (disposed) return;
          regenBtn.disabled = false;
          handleUsernameError(err, "Couldn't roll a new name.");
        });
    });

    // Picker: built lazily on first expand (fetches both lexicons once).
    let pickerBuilt = false;
    let pickerVisible = false;
    const buildPicker = async (): Promise<void> => {
      const [adj, nouns] = await Promise.all([
        fetchAdjectives(),
        fetchEmojiNouns(),
      ]);
      if (disposed) return;
      const adjCombo = makeCombo(
        "Adjective",
        // Listed the way the name renders (capitalized) while `value`
        // stays the curated lowercase word the API validates against.
        // Matching is case-insensitive both ways, so typing "brave"
        // still finds it.
        adj.adjectives.map((a) => ({
          value: a,
          label: a[0].toUpperCase() + a.slice(1),
        })),
      );
      const nounCombo = makeCombo(
        "Emoji noun",
        nouns.emoji_nouns.map((n) => ({
          value: n.emoji,
          label: `${n.emoji} ${n.word}`,
          // Typing just the word (no emoji) still resolves.
          terms: [n.word],
        })),
      );
      const applyBtn = el("button", "login-btn login-btn--secondary", "Apply");
      applyBtn.type = "button";
      usernameActions = [regenBtn, chooseBtn, applyBtn];
      const pickerHint = el(
        "p",
        "account-magic-status",
        "Pick either half (or both) — the other stays as-is.",
      );
      applyBtn.addEventListener("click", () => {
        const adj = adjCombo.resolve();
        const noun = nounCombo.resolve();
        // Typed-but-unmatched text must not be silently dropped from the
        // PUT — the server only accepts curated values.
        if (adj.kind === "unmatched" || noun.kind === "unmatched") {
          nameStatus.set(
            "Pick options from the lists — free text can't be saved.",
            true,
          );
          return;
        }
        const adjective = adj.kind === "value" ? adj.value : undefined;
        const emoji = noun.kind === "value" ? noun.value : undefined;
        if (!adjective && !emoji) {
          nameStatus.set(
            "Pick an adjective or an emoji noun from the lists first.",
            true,
          );
          return;
        }
        applyBtn.disabled = true;
        nameStatus.set("Saving…");
        setUsername({ adjective, emoji })
          .then((res) => {
            if (disposed) return;
            applyBtn.disabled = false;
            applyUsername(res.public_username);
            nameStatus.set("Saved.");
            // Hiding the picker removes the focused Apply button from the
            // tab order — hand focus back to its toggle.
            if (pickerSlot.contains(document.activeElement)) chooseBtn.focus();
            pickerSlot.hidden = true;
            pickerVisible = false;
          })
          .catch((err: unknown) => {
            if (disposed) return;
            applyBtn.disabled = false;
            handleUsernameError(err, "Couldn't save that name.");
          });
      });
      pickerSlot.append(adjCombo.node, nounCombo.node, applyBtn, pickerHint);
    };
    chooseBtn.addEventListener("click", () => {
      if (!pickerBuilt) {
        pickerBuilt = true;
        pickerVisible = true;
        nameStatus.set("Loading word lists…");
        buildPicker()
          .then(() => {
            if (!disposed) nameStatus.clear();
          })
          .catch(() => {
            if (disposed) return;
            pickerBuilt = false;
            pickerVisible = false;
            nameStatus.set("Couldn't load the word lists — try again.", true);
          });
        return;
      }
      pickerVisible = !pickerVisible;
      pickerSlot.hidden = !pickerVisible;
    });

    sec.append(line, actions, pickerSlot, nameStatus.node);

    // Royalty title: curated list in PICKER order (related titles adjacent)
    // — render exactly as served, never sorted. Purely decorative and not
    // unique; written via PUT /profile.
    const titleWrap = el("div", "account-field");
    titleWrap.append(el("span", "control-label", "Royalty title"));
    const titleSelect = el("select", "select");
    titleSelect.setAttribute("aria-label", "Royalty title");
    titleSelect.disabled = true;
    const titleStatus = makeStatus();
    const titleRetry = el("button", "text-btn", "Retry");
    titleRetry.type = "button";
    titleRetry.hidden = true;
    const noneOpt = el("option", undefined, "No title");
    noneOpt.value = "";
    titleSelect.append(noneOpt);
    // Retryable: the panel only rebuilds on token change, so a failed
    // lexicon fetch must not permanently dead-end the control.
    const loadTitles = (): void => {
      titleRetry.hidden = true;
      titleStatus.clear();
      fetchRoyaltyTitles()
        .then((res) => {
          if (disposed) return;
          titleSelect.replaceChildren(noneOpt);
          for (const t of res.royalty_titles) {
            const opt = el("option", undefined, t);
            opt.value = t;
            titleSelect.append(opt);
          }
          titleSelect.value = profile?.royalty_title ?? "";
          titleSelect.disabled = false;
        })
        .catch(() => {
          if (disposed) return;
          titleStatus.set("Couldn't load titles.", true);
          titleRetry.hidden = false;
        });
    };
    titleRetry.addEventListener("click", loadTitles);
    loadTitles();
    titleSelect.addEventListener("change", () => {
      const prev = profile?.royalty_title ?? "";
      const next = titleSelect.value || null;
      titleSelect.disabled = true;
      titleStatus.set("Saving…");
      savePatch({ royalty_title: next })
        .then(() => {
          titleStatus.set("Saved.");
          renderNameLine();
        })
        .catch((err: unknown) => {
          titleSelect.value = prev;
          titleStatus.set(describeError(err, "Couldn't save the title."), true);
        })
        .finally(() => {
          titleSelect.disabled = false;
        });
    });
    titleWrap.append(titleSelect, titleRetry, titleStatus.node);
    sec.append(titleWrap);

    sec.append(buildColorsBlock());

    return sec;
  };

  // ----- Ruling colors ----------------------------------------------------


  const buildColorsBlock = (): HTMLElement => {
    const wrap = el("div", "account-field");
    wrap.append(el("span", "control-label", "Ruling colors"));
    const rowEl = el("div", "account-field__row");
    const preview = el("span", "color-preview");
    const editBtn = el("button", "text-btn");
    editBtn.type = "button";
    const editorSlot = el("div");
    const colorsStatus = makeStatus();

    const renderPreview = (): void => {
      const f = profile?.ruling_color;
      const b = profile?.ruling_border_color;
      if (f && b) {
        preview.hidden = false;
        preview.style.background = hexWithAlpha(f, TERRITORY_FILL_OPACITY);
        preview.style.borderColor = b;
        editBtn.textContent = "Edit";
      } else {
        preview.hidden = true;
        editBtn.textContent = "Pick your colors";
      }
    };
    renderPreview();

    const closeEditor = (): void => {
      // Tearing the editor down removes the focused button from the DOM —
      // hand focus back to the toggle instead of dropping it on <body>.
      if (editorSlot.contains(document.activeElement)) editBtn.focus();
      editorSlot.replaceChildren();
    };

    interface PaletteData {
      colors: { hex: string; name: string }[];
      taken: Set<string>;
    }

    /** The claimed-pair set, with our own current claim carved out so the
     *  grids never grey the user out of the pair they already hold (e.g.
     *  when only re-opening the editor). */
    const toPalette = (res: {
      ruling_colors: { hex: string; name: string }[];
      taken_pairs: { fill: string; border: string }[];
    }): PaletteData => {
      const taken = new Set(
        res.taken_pairs.map((tp) => `${tp.fill}|${tp.border}`),
      );
      if (profile?.ruling_color && profile.ruling_border_color) {
        taken.delete(`${profile.ruling_color}|${profile.ruling_border_color}`);
      }
      return { colors: res.ruling_colors, taken };
    };

    const buildEditor = (palette: PaletteData): void => {
      let { taken } = palette;
      let fill = profile?.ruling_color ?? null;
      let border = profile?.ruling_border_color ?? null;

      const editor = el("div", "color-editor");
      const livePreview = el("span", "color-preview color-preview--live");

      const makeGrid = (
        kind: "fill" | "border",
      ): { node: HTMLElement; update(): void } => {
        const grid = el("div", "swatch-grid");
        grid.setAttribute(
          "aria-label",
          kind === "fill" ? "Fill color" : "Border color",
        );
        const buttons: HTMLButtonElement[] = palette.colors.map((c) => {
          const btn = el("button", "swatch");
          btn.type = "button";
          btn.style.background = c.hex;
          btn.title = c.name;
          btn.setAttribute("aria-label", c.name);
          btn.dataset.hex = c.hex;
          btn.addEventListener("click", () => {
            if (kind === "fill") fill = c.hex;
            else border = c.hex;
            updateAll();
          });
          return btn;
        });
        grid.append(...buttons);

        // Roving tabindex: one tab stop per grid (not 128), arrows move
        // within it. Columns are read from the live grid layout.
        let focusIdx = 0;
        const applyTabStops = (): void => {
          buttons.forEach((b, i) => {
            b.tabIndex = i === focusIdx ? 0 : -1;
          });
        };
        applyTabStops();
        grid.addEventListener("focusin", (e) => {
          const i = buttons.indexOf(e.target as HTMLButtonElement);
          if (i >= 0 && i !== focusIdx) {
            focusIdx = i;
            applyTabStops();
          }
        });
        grid.addEventListener("keydown", (e) => {
          const cols =
            getComputedStyle(grid).gridTemplateColumns.split(" ").length || 1;
          const step =
            e.key === "ArrowRight"
              ? 1
              : e.key === "ArrowLeft"
                ? -1
                : e.key === "ArrowDown"
                  ? cols
                  : e.key === "ArrowUp"
                    ? -cols
                    : 0;
          if (!step) return;
          e.preventDefault();
          // Walk in the pressed direction, skipping disabled swatches.
          let i = focusIdx + step;
          while (i >= 0 && i < buttons.length && buttons[i].disabled) i += step;
          if (i < 0 || i >= buttons.length) return;
          focusIdx = i;
          applyTabStops();
          buttons[i].focus();
        });

        return {
          node: grid,
          update() {
            for (const btn of buttons) {
              const hex = btn.dataset.hex!;
              const selected = kind === "fill" ? hex === fill : hex === border;
              btn.setAttribute("aria-pressed", String(selected));
              // Grey out the other half's picks that can't pair with the
              // current selection: same color, or an already-claimed pair.
              const conflict =
                kind === "fill"
                  ? border != null &&
                    (hex === border || taken.has(`${hex}|${border}`))
                  : fill != null &&
                    (hex === fill || taken.has(`${fill}|${hex}`));
              btn.disabled = conflict;
              btn.classList.toggle("swatch--taken", conflict);
            }
            // If the roving tab stop just got disabled, the grid would fall
            // out of the tab order entirely — move it to an enabled swatch.
            if (buttons[focusIdx].disabled) {
              const first = buttons.findIndex((b) => !b.disabled);
              if (first >= 0) focusIdx = first;
              applyTabStops();
            }
          },
        };
      };

      const fillGrid = makeGrid("fill");
      const borderGrid = makeGrid("border");

      // No fill-opacity slider. It used to live here, writing
      // `ruling_alpha`, which made the map's legibility a per-rider
      // setting: one territory at 10% next to one at 100% read as "empty"
      // versus "solid" rather than as two equal claims, and turning yours
      // up was a way to shout. Every territory now renders at
      // TERRITORY_FILL_OPACITY, so a hexagon's shade says who holds it and
      // nothing else. The preview below shows exactly that.
      const previewRow = el("div", "alpha-row");

      const applyBtn = el("button", "login-btn", "Apply");
      applyBtn.type = "button";
      const clearBtn = el("button", "text-btn", "Clear colors");
      clearBtn.type = "button";
      const cancelBtn = el("button", "text-btn", "Cancel");
      cancelBtn.type = "button";

      const updateAll = (): void => {
        fillGrid.update();
        borderGrid.update();
        livePreview.style.background = fill
          ? hexWithAlpha(fill, TERRITORY_FILL_OPACITY)
          : "transparent";
        livePreview.style.borderColor = border ?? "transparent";
        applyBtn.disabled = !(
          fill &&
          border &&
          fill !== border &&
          !taken.has(`${fill}|${border}`)
        );
        clearBtn.hidden = !(
          profile?.ruling_color && profile.ruling_border_color
        );
      };

      applyBtn.addEventListener("click", () => {
        if (!fill || !border) return;
        applyBtn.disabled = true;
        colorsStatus.set("Claiming…");
        // `ruling_alpha` is deliberately NOT sent: nothing reads it any
        // more, and writing it would keep a dead setting looking alive.
        savePatch({ ruling_color: fill, ruling_border_color: border })
          .then(() => {
            colorsStatus.set("Saved — this pair is yours.");
            renderPreview();
            closeEditor();
          })
          .catch((err: unknown) => {
            if (err instanceof ApiError && err.status === 409) {
              // Someone claimed the pair between palette load and Apply.
              // Refresh the claim set, re-grey, and keep the selection so
              // the user only has to adjust one half.
              colorsStatus.set(
                "Someone just claimed that combo — pick a different pair.",
                true,
              );
              void fetchRulingColors()
                .then((res) => {
                  taken = toPalette(res).taken;
                })
                .catch(() => {
                  /* refetch failed — the stale set stays and the next
                     Apply may 409 again, but the editor must not dead-end */
                })
                .finally(() => {
                  // Always re-grey and re-enable Apply, refetch or not;
                  // otherwise a failed refetch leaves Apply stuck disabled.
                  if (!disposed) updateAll();
                });
              return;
            }
            colorsStatus.set(
              describeError(err, "Couldn't save your colors."),
              true,
            );
            updateAll();
          });
      });

      clearBtn.addEventListener("click", () => {
        clearBtn.disabled = true;
        colorsStatus.set("Releasing…");
        // Both null together releases the claim.
        savePatch({ ruling_color: null, ruling_border_color: null })
          .then(() => {
            colorsStatus.set("Colors cleared — the pair is released.");
            renderPreview();
            closeEditor();
          })
          .catch((err: unknown) => {
            clearBtn.disabled = false;
            colorsStatus.set(
              describeError(err, "Couldn't clear your colors."),
              true,
            );
          });
      });

      cancelBtn.addEventListener("click", () => {
        colorsStatus.clear();
        closeEditor();
      });

      previewRow.append(livePreview);
      const buttonRow = el("div", "account-field__row");
      buttonRow.append(applyBtn, clearBtn, cancelBtn);
      editor.append(
        el("p", "control-label", "Fill"),
        fillGrid.node,
        el("p", "control-label", "Border"),
        borderGrid.node,
        previewRow,
        buttonRow,
      );
      editorSlot.replaceChildren(editor);
      updateAll();
    };

    editBtn.addEventListener("click", () => {
      if (editorSlot.childElementCount > 0) {
        closeEditor();
        return;
      }
      editBtn.disabled = true;
      colorsStatus.set("Loading palette…");
      // Fetched fresh on every open so taken_pairs reflects the present.
      fetchRulingColors()
        .then((res) => {
          if (disposed) return;
          editBtn.disabled = false;
          colorsStatus.clear();
          buildEditor(toPalette(res));
        })
        .catch((err: unknown) => {
          if (disposed) return;
          editBtn.disabled = false;
          colorsStatus.set(
            describeError(err, "Couldn't load the palette."),
            true,
          );
        });
    });

    rowEl.append(preview, editBtn);
    wrap.append(rowEl, editorSlot, colorsStatus.node);
    return wrap;
  };

  /** Phone verification: the difference between a number we can contact and
   *  a number that can sign you in.
   *
   *  A number saved through PUT /profile is a contact detail, and contact
   *  details are not proof of anything — anyone can type anyone's number.
   *  Only typing back a texted code marks it verified, and only a verified
   *  number opens the SMS sign-in door. Without this row a rider would save
   *  their number, try to sign in by text, and silently land in a SECOND,
   *  empty account, because the backend refuses to resolve an unverified
   *  number to an existing one (and it refuses for good reason: otherwise
   *  claiming a stranger's number would intercept their sign-in).
   *
   *  Returns a handle so the Phone field can refresh it after a save —
   *  changing your number drops the verification, by design. */
  const phoneVerificationRow = (
    initial: Profile,
  ): {
    node: HTMLElement;
    update(p: Profile): void;
    /** Re-evaluate the SMS capability gate. A no-op unless the answer
     *  actually changed, so the drawer's minute tick can call it without
     *  wiping a code the rider is halfway through typing. */
    syncCapability(): void;
  } => {
    const wrap = el("div", "account-field");
    const line = el("p", "account-magic-status");
    line.setAttribute("role", "status");
    line.setAttribute("aria-live", "polite");
    const verifyBtn = el("button", "text-btn", "Verify by text");
    verifyBtn.type = "button";

    // Revealed only after a code is sent.
    const codeForm = el("form", "account-field__row");
    codeForm.hidden = true;
    const codeInput = el("input", "select");
    codeInput.type = "text";
    codeInput.autocomplete = "one-time-code";
    codeInput.autocapitalize = "characters";
    codeInput.spellcheck = false;
    codeInput.maxLength = 9;
    codeInput.placeholder = "AB123XY";
    codeInput.setAttribute("aria-label", "Verification code");
    const codeSubmit = el("button", "text-btn", "Confirm");
    codeSubmit.type = "submit";
    codeForm.append(codeInput, codeSubmit);
    const status = makeStatus();

    let phone = initial.phone_number ?? "";
    let lastProfile: Profile = initial;
    let lastSms: boolean | null | undefined;

    const render = (p: Profile): void => {
      lastProfile = p;
      phone = p.phone_number ?? "";
      codeForm.hidden = true;
      status.clear();
      verifyBtn.disabled = false;
      if (!phone) {
        // Nothing to verify. Say nothing rather than nagging.
        wrap.hidden = true;
        return;
      }
      wrap.hidden = false;

      // Gate on the CAPABILITY before the data. `phone_verified: false`
      // describes the record, not whether the server can do anything about
      // it — and a blank COMMS_TOKEN is a supported configuration, so this
      // is a steady state, not a deploy blip. Offering "Verify by text"
      // when no text can be sent produces a button whose only outcome is
      // a 503. Facts about the number still get stated; only the offer and
      // the nag to act on it are withheld.
      const sms = deps.smsEnabled?.() ?? null;
      lastSms = sms;
      if (sms !== true) {
        verifyBtn.hidden = true;
        if (p.phone_verified) {
          line.textContent = `✓ ${formatUsPhone(phone)} is verified — you can sign in with it.`;
          return;
        }
        // Nothing true and useful left to say about an unverified number
        // we cannot offer to verify.
        wrap.hidden = true;
        return;
      }
      if (p.sms_opted_out) {
        // They chose this. It cannot be undone from here — only a text
        // from that handset clears it, because consent belongs to the
        // person holding the phone, not to a checkbox in our UI.
        // Scope stated explicitly: the block lives at the shared gateway,
        // so it covers every application sending from that number, not just
        // us. A rider who reads it as scooter.fyi-only will be surprised by
        // what else stops — and by what UNSTOP turns back on.
        line.textContent =
          "🚫 Texts are blocked for this number — that applies to every service " +
          "texting from it, not just scooter.fyi. Reply UNSTOP to our last " +
          "message to allow them again.";
        verifyBtn.hidden = true;
        return;
      }
      if (p.phone_verified) {
        line.textContent = `✓ ${formatUsPhone(phone)} is verified — you can sign in with it.`;
        verifyBtn.hidden = true;
        return;
      }
      line.textContent =
        "This number isn't verified yet. Verify it to sign in by text.";
      verifyBtn.hidden = false;
      // US-only door: don't offer a button that can only fail.
      if (!isProbablyUsPhone(phone)) {
        line.textContent =
          "Sign-in by text is US-only, so this number can't be verified.";
        verifyBtn.hidden = true;
      }
    };

    verifyBtn.addEventListener("click", () => {
      verifyBtn.disabled = true;
      status.set("Sending…");
      requestPhoneCode(phone)
        .then((r) => {
          verifyBtn.disabled = false;
          status.set(`Texted ${formatUsPhone(r.phone_number)} — enter the code (valid 10 minutes).`);
          verifyBtn.textContent = "Resend";
          codeForm.hidden = false;
          codeInput.focus();
        })
        .catch((err: unknown) => {
          verifyBtn.disabled = false;
          // describeError surfaces the server's own sentence for a 409,
          // which is the one that names the keyword that unblocks.
          status.set(describeError(err, "Couldn't send the code — try again."), true);
        });
    });

    codeForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = codeInput.value.replace(/[^A-Za-z0-9]/g, "");
      if (!/^[A-Za-z0-9]{6,10}$/.test(code)) {
        status.set("Enter the code from the text (like AB123XY).", true);
        return;
      }
      codeSubmit.disabled = true;
      status.set("Verifying…");
      verifyPhoneNumber(phone, code).then(
        () => {
          // The code is BURNED now — single-use, server-side. So from here
          // on nothing may report a failure that implies the rider should
          // try that code again, because it never will work.
          codeSubmit.disabled = false;
          codeForm.hidden = true;
          status.set("Verified.");
          // Re-read rather than assuming: the server decides what the
          // account now looks like. Chained separately from the verify —
          // not with .catch() on the same chain — so a failed refresh can't
          // be reported as a failed verification. It isn't one, and telling
          // them to re-enter a spent code would send them in circles.
          // Worst case the row reads stale until the panel is reopened.
          fetchProfile()
            .then((fresh) => {
              if (disposed) return;
              profile = fresh;
              render(fresh);
              status.set("Verified.");
            })
            .catch(() => {
              /* the "Verified." above still stands */
            });
        },
        (err: unknown) => {
          codeSubmit.disabled = false;
          status.set(
            describeError(err, "That code didn't work — check it or resend."),
            true,
          );
        },
      );
    });

    wrap.append(line, verifyBtn, codeForm, status.node);
    render(initial);
    return {
      node: wrap,
      update: render,
      syncCapability() {
        // Only when the answer actually moved — a re-render resets the code
        // form, and this runs on the same minute tick as the countdown.
        if ((deps.smsEnabled?.() ?? null) !== lastSms) render(lastProfile);
      },
    };
  };

  // ----- Profile section -------------------------------------------------

  const buildProfileSection = (p: Profile): HTMLElement => {
    const sec = accountSection("Profile");
    refreshHint();
    sec.append(hint);

    sec.append(
      textField({
        label: "Email",
        type: "email",
        value: p.email ?? "",
        placeholder: sessionEmail ?? "you@email.com",
        autocomplete: "email",
        fallbackError: "Couldn't save your email.",
        save: (v) => savePatch({ email: v }).then((u) => u.email),
      }),
    );

    // Saving a DIFFERENT number drops its verification server-side (proof
    // belongs to a number, not to an account), so the row below re-reads
    // from the save response rather than assuming it still says "verified".
    const phoneVerify = phoneVerificationRow(p);
    phoneVerifyRow = phoneVerify;
    sec.append(
      textField({
        label: "Phone",
        type: "tel",
        value: p.phone_number ?? "",
        placeholder: "(303) 555-1212",
        autocomplete: "tel",
        fallbackError: "Couldn't save your phone number.",
        save: (v) =>
          savePatch({ phone_number: v }).then((u) => {
            phoneVerify.update(u);
            return u.phone_number;
          }),
      }),
      phoneVerify.node,
    );

    // Rate plan. One flat list: the option labels themselves say whether a
    // VeoPlus Pass applies, so there is no separate Pass control.
    //
    // The account is the source of truth here — a plan chosen on a phone
    // should price a ride opened on a laptop. The server has one field and
    // it holds the base plan only; the Pass is a local pricing refinement it
    // cannot represent. So exactly one local write remains, and it is a
    // CACHE, never an input: the HUD's cost ticker reads the plan
    // synchronously while a ride is starting and cannot wait for a profile
    // GET, and a signed-out rider has no profile to read at all.
    const rateWrap = el("div", "account-field");
    rateWrap.append(el("span", "control-label", "Rate plan"));
    const rateSelect = el("select", "select");
    rateSelect.setAttribute("aria-label", "Rate plan");
    const rateStatus = makeStatus();
    // Server wins on the base plan; the local Pass refinement survives when
    // the two agree, and the cache is refreshed on the way through.
    const shownKey = applyServerRatePlan(p.rate_plan);
    if (!shownKey) {
      const opt = el("option", undefined, "Choose your plan…");
      opt.value = "";
      opt.disabled = true;
      opt.selected = true;
      rateSelect.append(opt);
    }
    for (const plan of RATE_PLANS) {
      const opt = el("option", undefined, plan.label);
      opt.value = plan.key;
      rateSelect.append(opt);
    }
    if (shownKey) rateSelect.value = shownKey;
    // This device knows a plan the account does not — push it up so the two
    // converge instead of silently disagreeing until the next change.
    if (shownKey && !p.rate_plan) {
      void savePatch({ rate_plan: toApiRatePlan(shownKey) }).catch(() => {
        /* the next change retries; the ticker is already correct locally */
      });
    }
    rateSelect.addEventListener("change", () => {
      const key = rateSelect.value as RatePlanKey;
      if (!RATE_PLANS.some((pl) => pl.key === key)) return;
      // saveRatePlan refreshes the cache and fires the sync hook, which owns
      // the PUT and the status messaging. Report a cache-write failure
      // afterwards so it wins over the hook's optimistic copy — the account
      // still saved, but this device won't remember the Pass.
      if (!saveRatePlan(key)) {
        rateStatus.set(
          "Saved to your account, but not to this device (private browsing?).",
          true,
        );
      }
    });
    rateWrap.append(rateSelect, rateStatus.node);
    sec.append(rateWrap);
    // The hook fires from ANY picker (the HUD adjust panel too) while this
    // panel is alive; route its outcome to this section's status line.
    rateSyncStatus = rateStatus;

    sec.append(
      locationRow("home", "Home location"),
      locationRow("work", "Work location"),
    );

    return sec;
  };

  // ----- Privacy toggles --------------------------------------------------
  // These govern what other riders see, so they live beside the identity
  // editors in Community rather than with the rider's own contact details.

  const buildPrivacyToggles = (p: Profile): HTMLElement[] => {
    const privacyStatus = makeStatus();
    const toggle = (
      label: string,
      field: "show_public_username" | "show_in_leaderboards",
    ): HTMLElement => {
      const lab = el("label", "switch account-switch");
      const input = el("input");
      input.type = "checkbox";
      input.checked = p[field];
      lab.append(input, el("span", undefined, label));
      input.addEventListener("change", () => {
        const next = input.checked;
        input.disabled = true;
        privacyStatus.set("Saving…");
        savePatch({ [field]: next } as ProfileUpdate)
          .then(() => privacyStatus.set("Saved."))
          .catch((err: unknown) => {
            input.checked = !next;
            privacyStatus.set(
              describeError(err, "Couldn't save that setting."),
              true,
            );
          })
          .finally(() => {
            input.disabled = false;
          });
      });
      return lab;
    };
    return [
      toggle("Show my username on public photos", "show_public_username"),
      toggle("List me in leaderboards", "show_in_leaderboards"),
      privacyStatus.node,
    ];
  };

  // ----- Badges section ---------------------------------------------------

  const buildBadgesSection = (p: Profile): HTMLElement => {
    const sec = accountSection("Badges");
    if (!p.badges.length) {
      // Shown (not hidden) even when empty: it advertises the feature.
      sec.append(
        el(
          "p",
          "account-hint",
          "No badges yet — file a report or log a ride to earn your first.",
        ),
      );
      return sec;
    }
    const rowEl = el("div", "badge-row");
    for (const badge of p.badges) {
      const chip = el(
        "span",
        "badge-chip",
        `${BADGE_EMOJI[badge.id] ?? "🏅"} ${badge.label}`,
      );
      const earned = new Date(badge.earned_at).toLocaleDateString();
      chip.title = `${badge.label} — earned ${earned}`;
      chip.setAttribute("aria-label", chip.title);
      rowEl.append(chip);
    }
    sec.append(rowEl);
    return sec;
  };

  // ----- Points section ---------------------------------------------------

  const buildPointsSection = (): HTMLElement => {
    const sec = accountSection("Points");
    const total = el("div", "points-total");
    const emptyMsg = el("p", "account-hint", "No points yet.");
    emptyMsg.hidden = true;
    const list = el("ul", "points-ledger");
    const moreBtn = el("button", "text-btn", "Load more");
    moreBtn.type = "button";
    moreBtn.hidden = true;
    const ptsStatus = makeStatus();
    const LIMIT = 10;
    // Cursor for the next page: the oldest entry's created_at, passed back
    // to the API verbatim (server timestamps carry the offset it requires).
    let oldest: string | null = null;
    let wasComplete = profile ? isProfileComplete(profile) : false;

    const entryItem = (en: PointsEntry): HTMLLIElement => {
      const confirmed = en.status === "confirmed";
      const li = el(
        "li",
        confirmed ? "points-entry" : "points-entry points-entry--muted",
      );
      const label = el(
        "span",
        "points-entry__label",
        en.action.replace(/_/g, " ") + (confirmed ? "" : ` (${en.status})`),
      );
      const date = new Date(en.created_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      const idTail = en.vehicle_identifier
        ? ` · …${en.vehicle_identifier.slice(-4)}`
        : "";
      const meta = el(
        "span",
        "points-entry__meta",
        `+${en.points} · ${date}${idTail}`,
      );
      li.append(label, meta);
      return li;
    };

    const load = (before?: string): void => {
      moreBtn.disabled = true;
      ptsStatus.set("Loading…");
      fetchPoints({ limit: LIMIT, before })
        .then((res) => {
          if (disposed) return;
          moreBtn.disabled = false;
          ptsStatus.clear();
          total.textContent = `⭐ ${res.total_points.toLocaleString()} points`;
          const items = res.entries.map(entryItem);
          if (before) list.append(...items);
          else list.replaceChildren(...items);
          emptyMsg.hidden = list.childElementCount > 0;
          if (res.entries.length) {
            oldest = res.entries[res.entries.length - 1].created_at;
          }
          // A full page suggests more history; a short one is the end.
          moreBtn.hidden = res.entries.length < LIMIT;
        })
        .catch((err: unknown) => {
          if (disposed) return;
          moreBtn.disabled = false;
          ptsStatus.set(describeError(err, "Couldn't load your points."), true);
        });
    };

    moreBtn.addEventListener("click", () => load(oldest ?? undefined));

    // When a PUT completes the profile, the one-time +10 lands server-side;
    // reload page 1 so the award shows up without a manual refresh.
    onProfileSaved = () => {
      if (!profile) return;
      const nowComplete = isProfileComplete(profile);
      if (nowComplete && !wasComplete) {
        wasComplete = true;
        load();
      }
    };

    load();
    sec.append(total, emptyMsg, list, moreBtn, ptsStatus.node);
    return sec;
  };

  // ----- Rate-plan account sync ------------------------------------------
  // Registered only once the profile GET has resolved: the gate compares
  // against the SERVER's value (not localStorage), so a failed sync PUT is
  // retried on the next pick even with an unchanged base, and a pre-load
  // pick can't PUT ahead of the initial GET and then be overwritten by it.
  const registerRateSync = (): void => {
    setRatePlanSyncHook((plan) => {
      if (profile?.rate_plan === plan) {
        // Base plan already on the account — this was a local-only change
        // (e.g. a VeoPlus-variant flip the API doesn't model).
        rateSyncStatus?.set("Saved on this device.");
        return;
      }
      rateSyncStatus?.set("Saving…");
      savePatch({ rate_plan: plan })
        .then(() => {
          if (!disposed) rateSyncStatus?.set("Saved to your account.");
        })
        .catch((err: unknown) => {
          // localStorage already has the change; only the account sync
          // failed. Picking any plan again retries (the server-value gate
          // above still sees the mismatch).
          console.warn("rate plan sync failed", err);
          if (!disposed) {
            rateSyncStatus?.set(
              describeError(
                err,
                "Saved on this device; couldn't sync to your account.",
              ),
              true,
            );
          }
        });
    });
  };

  // ----- Community settings ----------------------------------------------
  // Everything that decides how this rider appears to everyone else: the
  // public username, the royalty title, the ruling colours their territory
  // is drawn in, and who gets to see any of it.

  const buildCommunitySettings = (p: Profile): HTMLElement => {
    const wrap = el("section", "community-settings");
    const toggle = el("button", "community-settings__toggle");
    toggle.type = "button";
    toggle.id = "community-settings-toggle";
    toggle.setAttribute("aria-controls", "community-settings-body");
    const gear = gearIcon();
    const label = el("span", "community-settings__label");
    toggle.append(gear, label);

    const inner = el("div", "community-settings__body");
    inner.id = "community-settings-body";
    inner.append(buildIdentitySection(), ...buildPrivacyToggles(p));

    // Open by default — this is where a new rider names themselves — but it
    // collapses to a plain gear pill once they are done with it.
    let open = communitySettingsOpen();
    const paint = (): void => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.classList.toggle("is-collapsed", !open);
      // Two labels, one control: the full heading while it reads as a
      // section header, the short one once it is just a way back in.
      label.textContent = open ? "Community settings" : "Settings";
      inner.hidden = !open;
    };
    toggle.addEventListener("click", () => {
      open = !open;
      // Collapsing removes the focused control from the page, so hand focus
      // back to the toggle rather than dropping it on the body.
      if (!open && inner.contains(document.activeElement)) toggle.focus();
      paint();
      rememberCommunitySettingsOpen(open);
    });
    paint();

    wrap.append(toggle, inner);
    return wrap;
  };

  /** A way through to the territory map, which is where ruling colours and
   *  the leaderboard opt-in actually show up. Linked, not embedded: the
   *  leaderboard owns map layers and pauses the choropleth and hex density
   *  while it is open, and two owners for that state would fight. */
  const buildLeaderboardLink = (): HTMLElement => {
    const wrap = el("div", "account-section community-leaderboard");
    const btn = el("button", "text-btn", "Open the leaderboard 🏆");
    btn.type = "button";
    btn.addEventListener("click", () => {
      document
        .querySelector<HTMLElement>(".topbar__right .leaderboard-toggle")
        ?.click();
    });
    wrap.append(btn);
    return wrap;
  };

  // ----- Load & assemble -------------------------------------------------

  const loadProfile = (): void => {
    const loading = el("p", "account-magic-status", "Loading profile…");
    loading.setAttribute("role", "status");
    profileSlot.replaceChildren(loading);
    fetchProfile()
      .then((p) => {
        if (disposed) return;
        profile = p;
        // Tabbed: contact/rate/location on Profile, everything public-facing
        // on Community. Untabbed: one stack, as before. Both branches build
        // in the same synchronous turn, so the Points section's
        // onProfileSaved subscription is in place before any save can land.
        if (mounts) {
          profileSlot.replaceChildren(buildProfileSection(p));
          communitySlot.replaceChildren(
            buildCommunitySettings(p),
            buildBadgesSection(p),
            buildPointsSection(),
            buildLeaderboardLink(),
          );
        } else {
          profileSlot.replaceChildren(
            buildIdentitySection(),
            buildProfileSection(p),
            ...buildPrivacyToggles(p),
            buildBadgesSection(p),
            buildPointsSection(),
          );
        }
        registerRateSync();
        publishLocations();
      })
      .catch((e: unknown) => {
        if (disposed) return;
        if (e instanceof ApiError && e.code === "TOKEN_REJECTED") {
          deps.onAuthLost();
          return;
        }
        // role=alert: with the container-level aria-live gone, a silent
        // paragraph would leave screen-reader users on "Loading…" forever.
        const err = el("p", "account-error", "Couldn't load your profile.");
        err.setAttribute("role", "alert");
        const retry = el("button", "text-btn", "Retry");
        retry.type = "button";
        retry.addEventListener("click", loadProfile);
        profileSlot.replaceChildren(err, retry);
      });
  };
  loadProfile();

  return {
    refresh() {
      expirySpan.textContent = formatRemaining(auth.expires);
      // /auth/config resolves independently of the profile, and the
      // signed-in render key is the token alone — so nothing rebuilds when
      // the answer lands. This is how it gets through.
      phoneVerifyRow?.syncCapability();
    },
    dispose() {
      disposed = true;
      setRatePlanSyncHook(null);
      // The pins belong to this session's profile; a signed-out map should
      // not still be showing where they live.
      deps.onLocationsChanged?.({ home: null, work: null });
    },
  };
}
