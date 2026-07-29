// Signed-in body of the Account drawer. wireAccount() in main.ts keeps the
// signed-out sign-in doors and top-level dispatch; the whole signed-in view
// lives here so the profile surface can grow without growing main.ts (the
// new-module split docs/API_INTEGRATION_PLAN.md prescribes).

import {
  ApiError,
  fetchAdjectives,
  fetchEmojiNouns,
  fetchProfile,
  fetchRoyaltyTitles,
  regenerateUsername,
  setUsername,
  updateProfile,
  type Profile,
  type ProfileUpdate,
} from "./api.ts";
import { fetchSessionInfo, isAdminSession } from "./auth-session.ts";
import { signOut } from "./map-auth.js";
import { RATE_PLANS, type RatePlanKey } from "./config.ts";
import {
  applyServerRatePlan,
  saveRatePlan,
  setRatePlanSyncHook,
  toApiRatePlan,
} from "./ride-cost.ts";
import { reverseGeocode } from "./geocode.ts";

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

  body.append(status, adminSlot, profileSlot, signoutBtn);

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

  // Status line of the rate-plan control, once built — the sync hook below
  // reports there whichever picker (drawer or HUD) triggered it.
  let rateSyncStatus: StatusLine | null = null;

  /** All profile writes funnel through here so the cache, the completion
   *  hint, and interested sections stay in sync. */
  const savePatch = async (patch: ProfileUpdate): Promise<Profile> => {
    const updated = await updateProfile(patch);
    if (!disposed) {
      profile = updated;
      refreshHint();
    }
    return updated;
  };

  // ----- Completion hint (10 one-time points; criteria mirror the API) ----
  const hint = el(
    "p",
    "account-hint",
    "⭐ Complete your profile — email, phone, rate plan, and one location — to earn 10 bonus points.",
  );
  const refreshHint = (): void => {
    hint.hidden = profile ? isProfileComplete(profile) : true;
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
    save(v: string | null): Promise<unknown>;
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
        .then(() => {
          savedValue = v;
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
    const rowEl = el("div", "account-field__row");
    const value = el("span", "account-location__value");
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
    clearBtn.addEventListener("click", () => putPair(null, null));

    rowEl.append(value, useBtn, clearBtn);
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
  }

  interface Combo {
    node: HTMLElement;
    /** The picked canonical value, or an exact label/value match of what
     *  was typed; null when nothing valid is selected. */
    chosen(): string | null;
  }

  /** Lightweight combobox: text input filtering a curated list client-side
   *  (the lexicons are small and fetched once), listbox of ≤8 matches,
   *  Arrow/Enter/Escape keyboard support. No free text reaches the API —
   *  only canonical entry values. */
  const makeCombo = (label: string, entries: ComboEntry[]): Combo => {
    const wrap = el("div", "combo");
    const input = el("input", "select");
    input.type = "text";
    input.placeholder = label;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-label", label);
    const list = el("ul", "combo__list");
    list.setAttribute("role", "listbox");
    list.hidden = true;

    let picked: ComboEntry | null = null;
    let matches: ComboEntry[] = [];
    let highlighted = -1;

    const close = (): void => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
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
      chosen() {
        if (picked) return picked.value;
        const typed = input.value.trim().toLowerCase();
        if (!typed) return null;
        const exact = entries.find(
          (e) =>
            e.label.toLowerCase() === typed || e.value.toLowerCase() === typed,
        );
        return exact ? exact.value : null;
      },
    };
  };

  // ----- Public identity section -----------------------------------------

  const buildIdentitySection = (p: Profile): HTMLElement => {
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
        adj.adjectives.map((a) => ({ value: a, label: a })),
      );
      const nounCombo = makeCombo(
        "Emoji noun",
        nouns.emoji_nouns.map((n) => ({
          value: n.emoji,
          label: `${n.emoji} ${n.word}`,
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
        const adjective = adjCombo.chosen() ?? undefined;
        const emoji = nounCombo.chosen() ?? undefined;
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
    const noneOpt = el("option", undefined, "No title");
    noneOpt.value = "";
    titleSelect.append(noneOpt);
    void fetchRoyaltyTitles()
      .then((res) => {
        if (disposed) return;
        for (const t of res.royalty_titles) {
          const opt = el("option", undefined, t);
          opt.value = t;
          titleSelect.append(opt);
        }
        titleSelect.value = p.royalty_title ?? "";
        titleSelect.disabled = false;
      })
      .catch(() => {
        if (!disposed) titleStatus.set("Couldn't load titles.", true);
      });
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
    titleWrap.append(titleSelect, titleStatus.node);
    sec.append(titleWrap);

    return sec;
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
        save: (v) => savePatch({ email: v }),
      }),
      textField({
        label: "Phone",
        type: "tel",
        value: p.phone_number ?? "",
        placeholder: "+1 303 555 0123",
        autocomplete: "tel",
        fallbackError: "Couldn't save your phone number.",
        save: (v) => savePatch({ phone_number: v }),
      }),
    );

    // Rate plan: one flat list, VeoPlus variants included (per PR #37 — a
    // single field, not a rate + a separate Pass checkbox). The server
    // stores only the base plan; saveRatePlan()'s sync hook pushes it.
    const rateWrap = el("div", "account-field");
    rateWrap.append(el("span", "control-label", "Rate plan"));
    const rateSelect = el("select", "select");
    rateSelect.setAttribute("aria-label", "Rate plan");
    const rateStatus = makeStatus();
    const localKey = applyServerRatePlan(p.rate_plan);
    if (!localKey) {
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
    if (localKey) rateSelect.value = localKey;
    rateSelect.addEventListener("change", () => {
      const key = rateSelect.value as RatePlanKey;
      if (!RATE_PLANS.some((pl) => pl.key === key)) return;
      rateStatus.set("Saving…");
      // Persists locally and, via the sync hook below, PUTs the base plan.
      // A VeoPlus-variant switch with the same base is local-only; say so.
      const before = profile?.rate_plan ?? null;
      saveRatePlan(key);
      if (toApiRatePlan(key) === before) {
        rateStatus.set("Saved on this device.");
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

    // Privacy toggles: immediate PUT, rollback on failure.
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
    sec.append(
      toggle("Show my username on public photos", "show_public_username"),
      toggle("List me in leaderboards", "show_in_leaderboards"),
      privacyStatus.node,
    );

    return sec;
  };

  // ----- Rate-plan account sync (registered while this panel is alive) ---
  setRatePlanSyncHook((plan) => {
    updateProfile({ rate_plan: plan })
      .then((updated) => {
        if (disposed) return;
        profile = updated;
        refreshHint();
        rateSyncStatus?.set("Saved to your account.");
      })
      .catch((err: unknown) => {
        // localStorage already has the change; only the account sync failed.
        console.warn("rate plan sync failed", err);
        if (!disposed) {
          rateSyncStatus?.set(
            describeError(err, "Saved on this device; couldn't sync to your account."),
            true,
          );
        }
      });
  });

  // ----- Load & assemble -------------------------------------------------

  const loadProfile = (): void => {
    profileSlot.replaceChildren(
      el("p", "account-magic-status", "Loading profile…"),
    );
    fetchProfile()
      .then((p) => {
        if (disposed) return;
        profile = p;
        profileSlot.replaceChildren(
          buildIdentitySection(p),
          buildProfileSection(p),
        );
      })
      .catch((e: unknown) => {
        if (disposed) return;
        if (e instanceof ApiError && e.code === "TOKEN_REJECTED") {
          deps.onAuthLost();
          return;
        }
        const err = el("p", "account-error", "Couldn't load your profile.");
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
    },
    dispose() {
      disposed = true;
      setRatePlanSyncHook(null);
    },
  };
}
