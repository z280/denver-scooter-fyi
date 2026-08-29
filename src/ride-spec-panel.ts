// The "my ideal scooter" sheet, and the two controls that bridge it to the
// map.
//
// WHAT LIVES WHERE. `ride-spec.ts` owns what a spec MEANS and how it projects
// onto a filter; `ride-spec-store.ts` owns where specs live and whether the
// map is still showing one. This module is the DOM over both, and it holds no
// rule of its own — every decision it renders is a function call into one of
// those two, so a rule can be argued with in a test rather than dug out of an
// event handler.
//
// THE TWO CONTROLS, and why they are in the Filters drawer rather than
// somewhere of their own:
//
//   Show only my ideal scooters   spec → map. Lit while the map matches, and
//                                 it clears itself the moment the rider
//                                 nudges any filter, because a toggle that
//                                 stays on over filters it no longer
//                                 describes is the UI telling a lie.
//   Save these as my ideal…       map → spec. Opens the sheet seeded from
//                                 what they already set, everything marked
//                                 PREFER.
//
// A rider who wants "show me only the ones I'd ride" looks in Filters. Making
// them find a different surface first is the thing this feature exists to
// stop.
//
// House rules, as everywhere else in this app: `document.createElement` only
// (never innerHTML), a `cleanupFns[]` teardown list, a real focus trap.

import { isAuthenticated } from "./map-auth.js";
import { trapFocusWithin } from "./modal-focus-trap.ts";
import { track } from "./telemetry.ts";
import { FEATURE_FILTER_KEYS, type FeatureFilterKey } from "./device-features.ts";
import { ALL_MODELS, MODEL_NAMES, type ModelKey } from "./model-catalog.ts";
import type { FilterSnapshot } from "./filter-presets.ts";
import {
  DEFAULT_MAX_WALK_MINUTES,
  defaultSpec,
  fromFilterSnapshot,
  relaxationLadder,
  type RideSpec,
  type SpecField,
} from "./ride-spec.ts";
import {
  LOCAL_SPEC_NAME,
  MAX_RIDE_SPECS,
  SpecAttachment,
  deleteSpec,
  listSpecs,
  saveSpec,
  type NamedSpec,
  type SpecStoreDeps,
} from "./ride-spec-store.ts";

export interface RideSpecPanelDeps {
  /** The Filters drawer's live state — `main.ts`'s `snapshotFilters`, the
   *  same function `wireFilterPresets` is handed. */
  snapshot(): FilterSnapshot;
  /** Drive every control to match. Async: an area restore may fetch
   *  polygons. */
  apply(s: FilterSnapshot): Promise<void>;
  /** Injected for tests; defaults to the real session check. */
  signedIn?(): boolean;
  /** Injected for tests; defaults to the real store. */
  store?: Partial<SpecStoreDeps>;
}

export interface RideSpecPanelHandle {
  /** Hand this every filter change — `devices.onCountsChange` is the one
   *  signal that fires for all of them. Clears the toggle when the rider has
   *  edited away from the spec. */
  onFiltersChanged(): void;
  /** The spec currently driving the map, if any — the corridor search's seed
   *  once Phase 2 lands. */
  activeSpec(): RideSpec | null;
  destroy(): void;
}

const FEATURE_LABEL: Record<FeatureFilterKey, string> = {
  bell: "🔔 Bell",
  basket: "🧺 Basket",
  cup_holder: "🥤 Cup holder",
  missing: "¯\\_(ツ)_/¯ Not yet confirmed",
};

const QUALITY_LABEL: Record<RideSpec["minQuality"], string> = {
  any: "Anything",
  "no-risk": "Nothing flagged high-risk",
  "ok-only": "Only likely-rideable",
};

const FIELD_LABEL: Record<SpecField, string> = {
  models: "Model",
  features: "Equipment",
  min_battery: "Battery",
  min_quality: "Quality",
  must_reach: "Range",
};

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

export function wireRideSpecPanel(
  deps: RideSpecPanelDeps,
): RideSpecPanelHandle | null {
  const toggle = document.getElementById(
    "spec-apply-toggle",
  ) as HTMLInputElement | null;
  const editBtn = document.getElementById("spec-edit") as HTMLButtonElement | null;
  const saveBtn = document.getElementById(
    "spec-save-from-filters",
  ) as HTMLButtonElement | null;
  const panel = document.getElementById("spec-panel");
  if (!toggle || !editBtn || !saveBtn || !panel) return null;

  const cleanupFns: (() => void)[] = [];
  const attachment = new SpecAttachment();
  const store: SpecStoreDeps = {
    signedIn: deps.signedIn ?? (() => isAuthenticated()),
    ...deps.store,
  };

  /** Specs as of the last load. Refreshed on open and after every write —
   *  never read through, because a stale list is how a rider deletes one
   *  spec and watches a different one disappear. */
  let specs: NamedSpec[] = [];
  /** The one the toggle applies. The first in the list until the rider picks
   *  another; null when they have none. */
  let chosen: NamedSpec | null = null;
  /** True while `apply()` is in flight, so the resulting filter changes are
   *  not read back as rider edits. */
  let applying = false;

  const status = (text: string, kind: "note" | "detached" = "note"): void => {
    const p = el("p", kind === "detached" ? "preset-note" : "preset-note", text);
    p.setAttribute("role", "status");
    panel.replaceChildren(p);
  };

  const clearStatus = (): void => panel.replaceChildren();

  const renderDetached = (name: string): void => {
    // Not just "detached": the rider needs the name to know what they can go
    // back to, and one tap to do it.
    const wrap = el("div", "preset-note");
    wrap.setAttribute("role", "status");
    wrap.append(
      el("span", undefined, `Filters changed — no longer showing “${name}”. `),
    );
    const back = el("button", "text-btn", `Back to “${name}”`);
    back.type = "button";
    back.addEventListener("click", () => {
      void applySpec();
    });
    wrap.append(back);
    panel.replaceChildren(wrap);
  };

  // ---- spec → map ---------------------------------------------------------
  const applySpec = async (): Promise<void> => {
    if (!chosen) return;
    const projected = attachment.attach(
      chosen.name,
      chosen.spec,
      deps.snapshot(),
    );
    toggle.checked = true;
    applying = true;
    try {
      await deps.apply(projected);
    } finally {
      applying = false;
    }
    status(`Showing only “${chosen.name}”.`);
    track("spec_applied_to_map", { source: "drawer" });
  };

  const unapplySpec = async (): Promise<void> => {
    const restore = attachment.detachAndRestore();
    toggle.checked = false;
    clearStatus();
    if (!restore) return;
    applying = true;
    try {
      await deps.apply(restore);
    } finally {
      applying = false;
    }
  };

  const onToggle = (): void => {
    if (toggle.checked) {
      if (!chosen) {
        // Nothing to apply. Refuse rather than silently doing nothing, and
        // send them to the one place that fixes it.
        toggle.checked = false;
        status("You haven't set an ideal scooter yet — tap Edit to make one.");
        return;
      }
      void applySpec();
    } else {
      void unapplySpec();
    }
  };
  toggle.addEventListener("change", onToggle);
  cleanupFns.push(() => toggle.removeEventListener("change", onToggle));

  // ---- the sheet ----------------------------------------------------------
  const openSheet = (seed: RideSpec, seedName: string): void => {
    let draft: RideSpec = {
      ...seed,
      features: [...seed.features],
      must: [...seed.must],
    };
    const sheetCleanup: (() => void)[] = [];

    const backdrop = el("div", "ranks-modal");
    // Wider and scrollable: this sheet carries more controls than the
    // 320px ranks card it borrows its shell from.
    const card = el("div", "ranks-modal__card spec-sheet");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "My ideal scooter");

    const close = (): void => {
      for (const fn of sheetCleanup.splice(0)) fn();
      backdrop.remove();
      editBtn.focus();
    };

    const header = el("div", "ranks-modal__head");
    header.append(el("h3", undefined, "🛴 My ideal scooter"));
    const x = el("button", "ranks-modal__close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", close);
    header.append(x);

    const body = el("div", "spec-sheet__body");

    body.append(
      el(
        "p",
        "control-hint",
        "What you'll ride. Mark a requirement “must” and we'll never offer " +
          "you anything else; leave it “prefer” and we'll give it up — in " +
          "the order below — rather than telling you there's nothing.",
      ),
    );

    // -- name --
    const nameRow = el("div", "preset-form__row");
    const nameInput = el("input", "select");
    nameInput.type = "text";
    nameInput.maxLength = 64;
    nameInput.value = seedName;
    nameInput.setAttribute("aria-label", "Name for this spec");
    nameRow.append(nameInput);
    body.append(el("h4", "control-sublabel", "Name"), nameRow);

    // -- must/prefer switches, rendered per requirement below its controls --
    //
    // `must_reach` deliberately never gets one: it is hard whenever it is on
    // (a vehicle that cannot get you there is not a worse candidate, it is
    // not a candidate), so a switch beside it would offer a choice that
    // changes nothing.
    const mustSwitch = (field: SpecField): HTMLElement => {
      const label = el("label", "switch");
      const box = el("input");
      box.type = "checkbox";
      box.checked = draft.must.includes(field);
      box.addEventListener("change", () => {
        draft = {
          ...draft,
          must: box.checked
            ? [...draft.must.filter((f) => f !== field), field]
            : draft.must.filter((f) => f !== field),
        };
        renderLadder();
      });
      label.append(box, el("span", undefined, `${FIELD_LABEL[field]} is a must`));
      return label;
    };

    // -- models --
    body.append(el("h4", "control-sublabel", "Model"));
    const anyModel = el("label", "switch");
    const anyModelBox = el("input");
    anyModelBox.type = "checkbox";
    anyModelBox.checked = draft.models === null;
    anyModel.append(anyModelBox, el("span", undefined, "Any model"));
    body.append(anyModel);

    const modelWrap = el("div", "quick-filters");
    const modelBoxes = new Map<ModelKey, HTMLInputElement>();
    for (const key of ALL_MODELS) {
      const label = el("label", "switch");
      const box = el("input");
      box.type = "checkbox";
      box.checked = draft.models?.includes(key) ?? false;
      box.addEventListener("change", () => {
        const on = [...modelBoxes]
          .filter(([, b]) => b.checked)
          .map(([k]) => k);
        draft = { ...draft, models: on };
        anyModelBox.checked = false;
      });
      modelBoxes.set(key, box);
      label.append(box, el("span", undefined, MODEL_NAMES[key]));
      modelWrap.append(label);
    }
    anyModelBox.addEventListener("change", () => {
      if (anyModelBox.checked) {
        draft = { ...draft, models: null };
        for (const b of modelBoxes.values()) b.checked = false;
      } else {
        draft = { ...draft, models: [] };
      }
      modelWrap.hidden = anyModelBox.checked;
    });
    modelWrap.hidden = draft.models === null;
    body.append(modelWrap, mustSwitch("models"));

    // -- features --
    body.append(el("h4", "control-sublabel", "Equipment"));
    body.append(
      el(
        "p",
        "control-hint",
        "Confirmed by a rider standing at the scooter. A vehicle nobody has " +
          "checked does not count as having one.",
      ),
    );
    const featureWrap = el("div", "quick-filters");
    for (const key of FEATURE_FILTER_KEYS) {
      const label = el("label", "switch");
      const box = el("input");
      box.type = "checkbox";
      box.checked = draft.features.includes(key);
      box.addEventListener("change", () => {
        draft = {
          ...draft,
          features: box.checked
            ? [...draft.features.filter((f) => f !== key), key]
            : draft.features.filter((f) => f !== key),
        };
        renderLadder();
      });
      label.append(box, el("span", undefined, FEATURE_LABEL[key]));
      featureWrap.append(label);
    }
    body.append(featureWrap, mustSwitch("features"));

    // -- battery --
    body.append(el("h4", "control-sublabel", "Minimum battery"));
    const battery = el("input");
    battery.type = "range";
    battery.min = "0";
    battery.max = "90";
    battery.step = "10";
    battery.value = String(draft.minBattery);
    const batteryOut = el("output", undefined, batteryLabel(draft.minBattery));
    battery.addEventListener("input", () => {
      draft = { ...draft, minBattery: Number(battery.value) };
      batteryOut.textContent = batteryLabel(draft.minBattery);
      renderLadder();
    });
    const batteryRow = el("div", "range-row");
    batteryRow.append(battery, batteryOut);
    body.append(batteryRow, mustSwitch("min_battery"));

    // -- quality --
    body.append(el("h4", "control-sublabel", "Quality"));
    const quality = el("select", "select");
    for (const key of ["any", "no-risk", "ok-only"] as const) {
      const opt = el("option", undefined, QUALITY_LABEL[key]);
      opt.value = key;
      if (draft.minQuality === key) opt.selected = true;
      quality.append(opt);
    }
    quality.addEventListener("change", () => {
      draft = { ...draft, minQuality: quality.value as RideSpec["minQuality"] };
      renderLadder();
    });
    body.append(quality, mustSwitch("min_quality"));

    // -- reach + walk --
    body.append(el("h4", "control-sublabel", "Getting there"));
    const reach = el("label", "switch");
    const reachBox = el("input");
    reachBox.type = "checkbox";
    reachBox.checked = draft.mustReach;
    reachBox.addEventListener("change", () => {
      draft = { ...draft, mustReach: reachBox.checked };
      renderLadder();
    });
    reach.append(
      reachBox,
      el("span", undefined, "Only ones with the charge to reach my destination"),
    );
    body.append(reach);
    body.append(
      el(
        "p",
        "control-hint",
        "Always a must when it's on — a scooter that can't get you there " +
          "isn't a worse option, it's not an option. A vehicle whose range " +
          "the feed never reported still counts: silence isn't proof it " +
          "won't make it.",
      ),
    );

    const walk = el("input");
    walk.type = "number";
    walk.min = "1";
    walk.max = "15";
    walk.value = String(draft.maxWalkMinutes);
    walk.setAttribute("aria-label", "Longest walk to a scooter, in minutes");
    walk.addEventListener("change", () => {
      const n = Number(walk.value);
      draft = {
        ...draft,
        maxWalkMinutes: Number.isFinite(n)
          ? Math.min(15, Math.max(1, Math.round(n)))
          : DEFAULT_MAX_WALK_MINUTES,
      };
      walk.value = String(draft.maxWalkMinutes);
    });
    const walkRow = el("div", "range-row");
    walkRow.append(el("span", undefined, "Longest walk (minutes)"), walk);
    body.append(walkRow);
    body.append(
      el(
        "p",
        "control-hint",
        "Capped at 15 — past that a dibs claim expires before you arrive.",
      ),
    );

    // -- the ladder, shown rather than described --
    const ladderBox = el("div", "spec-ladder");
    const renderLadder = (): void => {
      const ladder = relaxationLadder(draft);
      ladderBox.replaceChildren();
      ladderBox.append(el("h4", "control-sublabel", "If nothing matches"));
      if (ladder.length === 0) {
        ladderBox.append(
          el(
            "p",
            "control-hint",
            "Everything here is a must, so we'll tell you there's nothing " +
              "rather than offer you something else.",
          ),
        );
        return;
      }
      ladderBox.append(
        el("p", "control-hint", "We'll give these up, in this order:"),
      );
      const list = el("ol", "spec-ladder__list");
      for (const step of ladder) list.append(el("li", undefined, step.label));
      ladderBox.append(list);
    };
    renderLadder();
    body.append(ladderBox);

    // -- actions --
    const actions = el("div", "preset-form__row");
    const save = el("button", "login-btn", "Save");
    save.type = "button";
    save.addEventListener("click", () => {
      const name = nameInput.value.trim() || LOCAL_SPEC_NAME;
      save.disabled = true;
      void saveSpec(store, name, draft)
        .then(async ({ where }) => {
          await refreshSpecs(name);
          close();
          status(
            where === "account"
              ? `Saved “${name}” to your account.`
              : where === "device"
                ? `Saved “${name}” on this device.`
                : "Couldn't save — storage is unavailable (private mode?).",
          );
          track("spec_saved", { where });
        })
        .finally(() => {
          save.disabled = false;
        });
    });
    const cancel = el("button", "text-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", close);
    actions.append(save, cancel);

    if (specs.some((s) => s.name === seedName)) {
      const del = el("button", "text-btn", "Delete");
      del.type = "button";
      del.addEventListener("click", () => {
        del.disabled = true;
        void deleteSpec(store, seedName)
          .then(async () => {
            await refreshSpecs(null);
            close();
            status(`Deleted “${seedName}”.`);
          })
          .finally(() => {
            del.disabled = false;
          });
      });
      actions.append(del);
    }
    body.append(actions);

    card.append(header, body);
    backdrop.append(card);
    document.body.append(backdrop);

    const untrap = trapFocusWithin(card);
    sheetCleanup.push(untrap);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    sheetCleanup.push(() => document.removeEventListener("keydown", onKey));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });

    nameInput.focus();
  };

  // ---- loading + the two buttons -----------------------------------------
  const refreshSpecs = async (prefer: string | null): Promise<void> => {
    specs = await listSpecs(store);
    chosen =
      specs.find((s) => s.name === prefer) ??
      specs.find((s) => s.name === attachment.attachedName) ??
      specs[0] ??
      null;
    editBtn.textContent = chosen
      ? `🛴 Edit “${chosen.name}”`
      : "🛴 Set my ideal scooter";
    toggle.disabled = chosen === null;
  };

  const onEdit = (): void => {
    void refreshSpecs(chosen?.name ?? null).then(() => {
      if (chosen) {
        openSheet(chosen.spec, chosen.name);
      } else {
        // No spec yet: seed from whatever they already have set on the map
        // rather than an empty sheet. The filters they set ARE their
        // requirements, said once.
        openSheet(fromFilterSnapshot(deps.snapshot()), LOCAL_SPEC_NAME);
      }
    });
  };
  editBtn.addEventListener("click", onEdit);
  cleanupFns.push(() => editBtn.removeEventListener("click", onEdit));

  const onSaveFromFilters = (): void => {
    void refreshSpecs(chosen?.name ?? null).then(() => {
      if (specs.length >= MAX_RIDE_SPECS && !chosen) {
        status(`You already have ${MAX_RIDE_SPECS} — edit or delete one first.`);
        return;
      }
      // EVERYTHING COMES BACK AS A PREFERENCE. Promoting one to a must is a
      // decision only the rider can make, and doing it for them is how a
      // search starts coming back empty for reasons nobody chose.
      openSheet(fromFilterSnapshot(deps.snapshot()), suggestName(specs));
      track("spec_saved_from_map", {});
    });
  };
  saveBtn.addEventListener("click", onSaveFromFilters);
  cleanupFns.push(() =>
    saveBtn.removeEventListener("click", onSaveFromFilters),
  );

  void refreshSpecs(null);

  return {
    onFiltersChanged(): void {
      // A change WE made is not a rider edit. Guarding on the in-flight flag
      // as well as on the snapshot comparison, because `apply()` drives the
      // controls one at a time and every intermediate state differs from the
      // projection — without this, applying a spec would detach it halfway
      // through applying it.
      if (applying) return;
      if (attachment.noticeFilterChange(deps.snapshot())) {
        const name = chosen?.name ?? LOCAL_SPEC_NAME;
        toggle.checked = false;
        renderDetached(name);
        track("spec_detached_from_map", {});
      }
    },
    activeSpec(): RideSpec | null {
      return attachment.get() ? (chosen?.spec ?? null) : null;
    },
    destroy(): void {
      for (const fn of cleanupFns.splice(0)) fn();
    },
  };
}

function batteryLabel(pct: number): string {
  return pct === 0 ? "Any" : `${pct}%+`;
}

/** "Commuter", "Commuter 2", … — a name that does not collide with one they
 *  already have, so saving twice does not silently overwrite. */
function suggestName(existing: NamedSpec[]): string {
  const base = "My ideal scooter";
  const taken = new Set(existing.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 50; n += 1) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
  return base;
}

/** Re-exported so `main.ts` can seed the corridor search from the same spec
 *  the map is showing, once Phase 2 lands. */
export { defaultSpec };
