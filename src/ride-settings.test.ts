// @vitest-environment happy-dom
//
// ride-settings.ts: the RideOptions defaults, the three cross-option cascade
// rules (own-device, save-tracks-off, guest/private) as pure functions, the
// Usuals CRUD round-trip against a mocked api.ts, the points-schedule
// resolution + offline fallback, the eight ℹ info-modal copy blocks
// (snapshot-style, word-for-word against the master doc — this is what
// catches future copy drift), and a handful of DOM smoke tests for the
// options panel + info-modal shell.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PointsScheduleResponse, RideOptions, RideUsual } from "./api.ts";
import { ApiError, MAX_RIDE_USUALS } from "./api.ts";
import {
  openRideModal,
  registerRideScreen,
  resetRideModal,
  rideModalRoot,
} from "./ride-modal.ts";

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return {
    ...actual,
    listRideUsuals: vi.fn(),
    putRideUsual: vi.fn(),
    deleteRideUsual: vi.fn(),
    fetchPointsSchedule: vi.fn(),
  };
});

import { deleteRideUsual, fetchPointsSchedule, listRideUsuals, putRideUsual } from "./api.ts";
import {
  FALLBACK_RIDE_MODE_POINTS,
  RIDE_INFO_MODAL_COPY,
  RIDE_OPTION_ROWS,
  RIDE_PROVIDER_NAME,
  appendRichParagraph,
  applyCascades,
  cachedRideUsuals,
  defaultRideOptions,
  defaultRideOptionsFor,
  deleteRideUsualByName,
  describeRideUsualsError,
  isValidRideUsualName,
  loadRideModePoints,
  loadRideUsuals,
  openRideInfoModal,
  optionsFromRideUsual,
  renderRideOptionsPanel,
  resetRideUsualsCache,
  resolveRideModePoints,
  saveRideUsualAsNew,
  setRideUsualsChangeHook,
  trophyDisabledMessage,
  trophyOptionDisableStates,
  type OptionDisableState,
  type ResolvedRideModePoints,
  type RideOptionsContext,
} from "./ride-settings.ts";

const BASE_OPTIONS: RideOptions = {
  cost_hud: true,
  speedometer: "classic",
  theme: "auto",
  navigation: false,
  save_tracks: true,
  battery_modeling: true,
  nav_improvement: true,
  end_survey: true,
  own_device: false,
};

function ctx(over: Partial<RideOptionsContext> = {}): RideOptionsContext {
  return { private: false, authenticated: true, ...over };
}

const NOT_DISABLED: OptionDisableState = { disabled: false, reasons: [] };

beforeEach(() => {
  document.body.replaceChildren();
  resetRideUsualsCache();
  setRideUsualsChangeHook(null);
});

afterEach(() => {
  resetRideModal();
  document.querySelectorAll(".ranks-modal").forEach((n) => n.remove());
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("defaultRideOptions", () => {
  it("returns a fully-specified, sane blob", () => {
    expect(defaultRideOptions()).toEqual({
      cost_hud: true,
      speedometer: "classic",
      theme: "auto",
      navigation: false,
      save_tracks: true,
      battery_modeling: true,
      nav_improvement: true,
      end_survey: true,
      own_device: false,
    });
  });

  it("defaultRideOptionsFor cascades immediately for a guest baseline", () => {
    const d = defaultRideOptionsFor(ctx({ private: true, authenticated: false }));
    expect(d.battery_modeling).toBe(false);
    expect(d.nav_improvement).toBe(false);
    expect(d.end_survey).toBe(false);
  });

  it("defaultRideOptionsFor is unchanged for an authenticated, non-private context", () => {
    const d = defaultRideOptionsFor(ctx());
    expect(d).toEqual(defaultRideOptions());
  });
});

// ---------------------------------------------------------------------------
// Cross-option cascades — the three rules, independently and combined
// ---------------------------------------------------------------------------

describe("trophyOptionDisableStates", () => {
  it("own-device disables battery_modeling and end_survey, not nav_improvement", () => {
    const options: RideOptions = { ...BASE_OPTIONS, own_device: true };
    const states = trophyOptionDisableStates(options, ctx());
    expect(states.battery_modeling).toEqual({ disabled: true, reasons: ["own_device"] });
    expect(states.end_survey).toEqual({ disabled: true, reasons: ["own_device"] });
    expect(states.nav_improvement).toEqual(NOT_DISABLED);
  });

  it("save_tracks off disables battery_modeling and nav_improvement, not end_survey", () => {
    const options: RideOptions = { ...BASE_OPTIONS, save_tracks: false };
    const states = trophyOptionDisableStates(options, ctx());
    expect(states.battery_modeling).toEqual({ disabled: true, reasons: ["save_tracks_off"] });
    expect(states.nav_improvement).toEqual({ disabled: true, reasons: ["save_tracks_off"] });
    expect(states.end_survey).toEqual(NOT_DISABLED);
  });

  it("guest/private sessions disable all three 🏆 options", () => {
    const states = trophyOptionDisableStates(BASE_OPTIONS, ctx({ private: true, authenticated: false }));
    expect(states.battery_modeling).toEqual({ disabled: true, reasons: ["guest_or_private"] });
    expect(states.nav_improvement).toEqual({ disabled: true, reasons: ["guest_or_private"] });
    expect(states.end_survey).toEqual({ disabled: true, reasons: ["guest_or_private"] });
  });

  it("nothing is disabled when no rule applies", () => {
    const states = trophyOptionDisableStates(BASE_OPTIONS, ctx());
    expect(states.battery_modeling).toEqual(NOT_DISABLED);
    expect(states.nav_improvement).toEqual(NOT_DISABLED);
    expect(states.end_survey).toEqual(NOT_DISABLED);
  });

  it("stacks every applicable reason, own_device first, save_tracks_off second, guest/private last", () => {
    const options: RideOptions = { ...BASE_OPTIONS, own_device: true, save_tracks: false };
    const states = trophyOptionDisableStates(options, ctx({ private: true, authenticated: true }));
    expect(states.battery_modeling.reasons).toEqual([
      "own_device",
      "save_tracks_off",
      "guest_or_private",
    ]);
    // end_survey has no save_tracks_off rule — own_device then guest_or_private only.
    expect(states.end_survey.reasons).toEqual(["own_device", "guest_or_private"]);
    // nav_improvement has no own_device rule — save_tracks_off then guest_or_private.
    expect(states.nav_improvement.reasons).toEqual(["save_tracks_off", "guest_or_private"]);
  });
});

describe("applyCascades", () => {
  it("forces every disabled 🏆 field to false and leaves the rest untouched", () => {
    const options: RideOptions = { ...BASE_OPTIONS, own_device: true };
    const next = applyCascades(options, ctx({ private: true, authenticated: true }));
    expect(next.battery_modeling).toBe(false);
    expect(next.end_survey).toBe(false);
    // nav_improvement forced off too, via the guest/private rule (own-device
    // rides are always private) — not via an own_device rule of its own.
    expect(next.nav_improvement).toBe(false);
    expect(next.cost_hud).toBe(true);
    expect(next.speedometer).toBe("classic");
    expect(next.own_device).toBe(true);
  });

  it("is a no-op when nothing is disabled", () => {
    expect(applyCascades(BASE_OPTIONS, ctx())).toEqual(BASE_OPTIONS);
  });

  it("does not re-enable a field the rider had already turned off", () => {
    const options: RideOptions = { ...BASE_OPTIONS, end_survey: false };
    const next = applyCascades(options, ctx());
    expect(next.end_survey).toBe(false);
  });
});

describe("trophyDisabledMessage", () => {
  it("is null when nothing is disabled", () => {
    expect(trophyDisabledMessage([], true)).toBeNull();
  });

  it("prioritizes own_device copy over save_tracks/guest copy", () => {
    const msg = trophyDisabledMessage(["own_device", "save_tracks_off", "guest_or_private"], false);
    expect(msg).toMatch(/own device/i);
  });

  it("prioritizes save_tracks_off copy over guest/private copy", () => {
    const msg = trophyDisabledMessage(["save_tracks_off", "guest_or_private"], false);
    expect(msg).toMatch(/Save ride tracks locally/);
  });

  it("points an unauthenticated guest at sign-in", () => {
    expect(trophyDisabledMessage(["guest_or_private"], false)).toMatch(/Sign in/);
  });

  it("does not ask an already-signed-in rider (own-device) to sign in", () => {
    const msg = trophyDisabledMessage(["guest_or_private"], true);
    expect(msg).not.toBeNull();
    expect(msg).not.toMatch(/Sign in/i);
  });
});

// ---------------------------------------------------------------------------
// Points schedule resolution + offline fallback
// ---------------------------------------------------------------------------

describe("resolveRideModePoints", () => {
  it("falls back on every field for a null/missing schedule", () => {
    expect(resolveRideModePoints(null)).toEqual(FALLBACK_RIDE_MODE_POINTS);
    expect(resolveRideModePoints(undefined)).toEqual(FALLBACK_RIDE_MODE_POINTS);
    expect(resolveRideModePoints({})).toEqual(FALLBACK_RIDE_MODE_POINTS);
  });

  it("prefers live values, falling back field-by-field when partial", () => {
    const schedule: PointsScheduleResponse = {
      battery_contribution: { base: 10, per_step: 4 }, // step_km omitted
      ride_survey: 6, // bare-number encoding
    };
    const resolved = resolveRideModePoints(schedule);
    expect(resolved.batteryBase).toBe(10);
    expect(resolved.batteryPerStep).toBe(4);
    expect(resolved.batteryStepKm).toBe(FALLBACK_RIDE_MODE_POINTS.batteryStepKm);
    expect(resolved.surveyPoints).toBe(6);
    expect(resolved.navRouteFeedback).toBe(FALLBACK_RIDE_MODE_POINTS.navRouteFeedback);
  });

  it("resolves the complete live schedule exactly", () => {
    const schedule: PointsScheduleResponse = {
      battery_contribution: { base: 8, per_step: 2, step_km: 2 },
      nav_route_feedback: 4,
      nav_qualitative_feedback: 6,
      nav_distance_bonus: { per_step: 2, step_km: 3 },
      ride_survey: 4,
    };
    expect(resolveRideModePoints(schedule)).toEqual(FALLBACK_RIDE_MODE_POINTS);
  });
});

describe("loadRideModePoints", () => {
  it("resolves against the live schedule on success", async () => {
    vi.mocked(fetchPointsSchedule).mockResolvedValueOnce({
      battery_contribution: { base: 12, per_step: 2, step_km: 2 },
      nav_route_feedback: 4,
      nav_qualitative_feedback: 6,
      nav_distance_bonus: { per_step: 2, step_km: 3 },
      ride_survey: 4,
    });
    const p = await loadRideModePoints();
    expect(p.batteryBase).toBe(12);
  });

  it("falls back to the baked-in values when the fetch throws (offline / pre-A1 deploy)", async () => {
    vi.mocked(fetchPointsSchedule).mockRejectedValueOnce(new Error("network down"));
    const p = await loadRideModePoints();
    expect(p).toEqual(FALLBACK_RIDE_MODE_POINTS);
  });

  it("never throws even on a rejected fetch", async () => {
    vi.mocked(fetchPointsSchedule).mockRejectedValueOnce(new ApiError("boom", "HTTP_ERROR"));
    await expect(loadRideModePoints()).resolves.toEqual(FALLBACK_RIDE_MODE_POINTS);
  });
});

// ---------------------------------------------------------------------------
// The two remaining ℹ info modals — verbatim copy fidelity. These strings
// are transcribed word-for-word from RIDE_MODE_OVERHAUL_PLAN.md Part 0
// "Screen 2" — any future edit to that doc's copy should show up here as a
// failing test.
//
// FRICTION-REDUCTION PASS: down to two rows. No Theme row (the app has two
// existing live theme fixtures — the map's ThemeControl and the ride HUD's
// toggle-night button). No Est. Veo Cost HUD / Speedometer rows (neither
// `RideOptions` field was ever read by `ride-hud.ts` — both toggles were
// no-ops). No Improve battery modeling / Navigation Improvement / End ride
// survey rows (asking a rider to pre-commit to donating data before the ride
// even starts was backwards — Screens 9/10 already ask at the end, when the
// rider actually has the data). See ride-settings.ts's own module header for
// the full rationale on each.
// ---------------------------------------------------------------------------

describe("RIDE_OPTION_ROWS — Screen 2 table copy, verbatim", () => {
  it("matches the owner's table, in order, with the right 🏆 flags", () => {
    expect(RIDE_OPTION_ROWS.map((r) => [r.id, r.label, r.trophy])).toEqual([
      ["navigation", "Destination Navigation", false],
      ["save_tracks", "Save ride tracks locally", false],
    ]);
  });

  it("RIDE_PROVIDER_NAME is Veo today", () => {
    expect(RIDE_PROVIDER_NAME).toBe("Veo");
  });
});

describe("RIDE_INFO_MODAL_COPY — Screen 2 ℹ modal copy, verbatim", () => {
  const P = FALLBACK_RIDE_MODE_POINTS;

  it("navigation (Destination Navigation)", () => {
    expect(RIDE_INFO_MODAL_COPY.navigation.title).toBe("Destination Navigation");
    expect(RIDE_INFO_MODAL_COPY.navigation.body(P)).toBe(
      "We're trying to make not just 'good' directions, but, THE BEST directions for scooters and eBikes in Denver! Unlike the big name providers, we specifically AVOID paths that City of Denver reports as High Injury Network (HIN) roads. Our primary route type provides a direct safe route using safe infrastructure as much as possible, and we also give you options to avoid hills and save battery, stay out of the sun as much as possible, and just take the most direct route.",
    );
  });

  it("save_tracks (Save Ride Tracks) — includes the end-of-trip donation note", () => {
    expect(RIDE_INFO_MODAL_COPY.save_tracks.title).toBe("Save Ride Tracks");
    expect(RIDE_INFO_MODAL_COPY.save_tracks.body(P)).toBe(
      "This option allows you to trace where you've been on the map display, and also save waypoints of your location to your local device. Tracking information is not persisted to Scooter.fyi unless you opt to share. You may have the opportunity to donate your ride data for leaderboard points at the end of the trip IF you save ride tracks now.",
    );
  });

  it("every fallback POINT value is even (Decision 6) — step_km denominators are distances, not points, and are exempt", () => {
    const pointFields: (keyof ResolvedRideModePoints)[] = [
      "batteryBase",
      "batteryPerStep",
      "navRouteFeedback",
      "navQualitativeFeedback",
      "navDistancePerStep",
      "surveyPoints",
    ];
    for (const field of pointFields) {
      expect(FALLBACK_RIDE_MODE_POINTS[field] % 2).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// appendRichParagraph — direct coverage of the `**bold**`/`*italic*` parser.
// Adversarial-review fix: the friction-reduction pass removed every 🏆-row
// info-modal body that used markdown markers, so nothing left in
// RIDE_INFO_MODAL_COPY (see above — navigation/save_tracks are both plain
// text) exercises this branch anymore without a direct test.
// ---------------------------------------------------------------------------

describe("appendRichParagraph", () => {
  function renderedHTML(text: string): string {
    const container = document.createElement("div");
    appendRichParagraph(container, text);
    return container.innerHTML;
  }

  it("renders **bold** as <strong>", () => {
    expect(renderedHTML("plain **bold** plain")).toBe(
      "<p>plain <strong>bold</strong> plain</p>",
    );
  });

  it("renders *italic* as <em>", () => {
    expect(renderedHTML("plain *italic* plain")).toBe(
      "<p>plain <em>italic</em> plain</p>",
    );
  });

  it("renders multiple markers of both kinds in one string, preserving order and surrounding text", () => {
    expect(renderedHTML("**A** and *B* and **C**")).toBe(
      "<p><strong>A</strong> and <em>B</em> and <strong>C</strong></p>",
    );
  });

  it("plain text with no markers passes through untouched", () => {
    expect(renderedHTML("nothing special here")).toBe("<p>nothing special here</p>");
  });

  it("never uses innerHTML for the source text — a marker-free string containing HTML-special characters renders as literal text, not markup", () => {
    expect(renderedHTML("<img src=x> & \"quotes\"")).toBe(
      "<p>&lt;img src=x&gt; &amp; \"quotes\"</p>",
    );
  });
});

// ---------------------------------------------------------------------------
// Ride Usuals CRUD
// ---------------------------------------------------------------------------

describe("Ride Usuals CRUD", () => {
  const USUAL_A: RideUsual = {
    name: "commute",
    settings: { ...BASE_OPTIONS, label: "commute" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("cachedRideUsuals is null before the first load", () => {
    expect(cachedRideUsuals()).toBeNull();
  });

  it("loadRideUsuals populates the cache and notifies the change hook", async () => {
    vi.mocked(listRideUsuals).mockResolvedValueOnce([USUAL_A]);
    const hook = vi.fn();
    setRideUsualsChangeHook(hook);
    const list = await loadRideUsuals();
    expect(list).toEqual([USUAL_A]);
    expect(cachedRideUsuals()).toEqual([USUAL_A]);
    expect(hook).toHaveBeenCalledExactlyOnceWith([USUAL_A]);
  });

  it("saveRideUsualAsNew PUTs the trimmed name with settings.label mirroring it, and unshifts into the cache", async () => {
    vi.mocked(listRideUsuals).mockResolvedValueOnce([]);
    await loadRideUsuals();
    const saved: RideUsual = {
      name: "weekend",
      settings: { ...BASE_OPTIONS, label: "weekend" },
      created_at: "t",
      updated_at: "t",
    };
    vi.mocked(putRideUsual).mockResolvedValueOnce(saved);
    const result = await saveRideUsualAsNew("  weekend  ", BASE_OPTIONS);
    expect(putRideUsual).toHaveBeenCalledExactlyOnceWith(
      "weekend",
      { ...BASE_OPTIONS, label: "weekend" },
      undefined,
    );
    expect(result).toEqual(saved);
    expect(cachedRideUsuals()).toEqual([saved]);
  });

  it("saveRideUsualAsNew overwrites an existing same-name cache entry in place, not duplicating it", async () => {
    vi.mocked(listRideUsuals).mockResolvedValueOnce([USUAL_A]);
    await loadRideUsuals();
    const updated: RideUsual = {
      ...USUAL_A,
      settings: { ...USUAL_A.settings, navigation: true },
    };
    vi.mocked(putRideUsual).mockResolvedValueOnce(updated);
    await saveRideUsualAsNew("commute", { ...BASE_OPTIONS, navigation: true });
    expect(cachedRideUsuals()).toEqual([updated]);
  });

  it("deleteRideUsualByName removes it from the cache and notifies the hook", async () => {
    vi.mocked(listRideUsuals).mockResolvedValueOnce([USUAL_A]);
    await loadRideUsuals();
    const hook = vi.fn();
    setRideUsualsChangeHook(hook);
    vi.mocked(deleteRideUsual).mockResolvedValueOnce(undefined);
    await deleteRideUsualByName("commute");
    expect(deleteRideUsual).toHaveBeenCalledExactlyOnceWith("commute", undefined);
    expect(cachedRideUsuals()).toEqual([]);
    expect(hook).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("optionsFromRideUsual round-trips every RideOptions field and drops the label", () => {
    const options = optionsFromRideUsual(USUAL_A);
    expect(options).toEqual(BASE_OPTIONS);
    expect(Object.keys(options)).not.toContain("label");
  });

  it("isValidRideUsualName enforces 1–64 trimmed chars", () => {
    expect(isValidRideUsualName("commute")).toBe(true);
    expect(isValidRideUsualName("   ")).toBe(false);
    expect(isValidRideUsualName("")).toBe(false);
    expect(isValidRideUsualName("a".repeat(64))).toBe(true);
    expect(isValidRideUsualName("a".repeat(65))).toBe(false);
  });

  it("describeRideUsualsError maps known statuses to friendly, specific copy", () => {
    expect(
      describeRideUsualsError(new ApiError("x", "HTTP_ERROR", { status: 409 })),
    ).toContain(String(MAX_RIDE_USUALS));
    expect(
      describeRideUsualsError(new ApiError("x", "HTTP_ERROR", { status: 413 })),
    ).toMatch(/too large/);
    expect(
      describeRideUsualsError(new ApiError("x", "HTTP_ERROR", { status: 404 })),
    ).toMatch(/no longer exists/);
    expect(describeRideUsualsError(new Error("boom"))).toMatch(/try again/);
  });
});

// ---------------------------------------------------------------------------
// DOM smoke tests: the options panel + the ℹ modal shell
// ---------------------------------------------------------------------------

describe("renderRideOptionsPanel", () => {
  it("renders both rows in the owner's table order", () => {
    const panel = renderRideOptionsPanel({
      options: BASE_OPTIONS,
      context: ctx(),
      onChange: vi.fn(),
    });
    const rows = [...panel.element.querySelectorAll<HTMLElement>(".ride-settings__row")];
    expect(rows.map((r) => r.dataset.option)).toEqual(["navigation", "save_tracks"]);
    panel.destroy();
  });

  it("marks the current value active on each row", () => {
    const panel = renderRideOptionsPanel({
      options: { ...BASE_OPTIONS, navigation: true },
      context: ctx(),
      onChange: vi.fn(),
    });
    const navRow = panel.element.querySelector('[data-option="navigation"]')!;
    expect(navRow.querySelector('[data-value="on"]')?.classList.contains("is-active")).toBe(true);
    const tracksRow = panel.element.querySelector('[data-option="save_tracks"]')!;
    expect(tracksRow.querySelector('[data-value="on"]')?.classList.contains("is-active")).toBe(true);
    panel.destroy();
  });

  it("toggling save_tracks off calls onChange with battery+nav cascaded off, survey untouched", () => {
    const onChange = vi.fn();
    const panel = renderRideOptionsPanel({ options: BASE_OPTIONS, context: ctx(), onChange });
    const offBtn = panel.element.querySelector<HTMLButtonElement>(
      '[data-option="save_tracks"] [data-value="off"]',
    )!;
    offBtn.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as RideOptions;
    expect(next.save_tracks).toBe(false);
    expect(next.battery_modeling).toBe(false);
    expect(next.nav_improvement).toBe(false);
    expect(next.end_survey).toBe(true);
    panel.destroy();
  });

  // Neither remaining row (navigation, save_tracks) is ever cascade-disabled
  // — only the three now-removed 🏆 rows were. That cascade LOGIC is still
  // fully covered above (`trophyOptionDisableStates`/`applyCascades`), it
  // just no longer has a DOM row to render disabled through this panel.

  it("update() re-syncs a row's active value for a new options snapshot without rebuilding the DOM", () => {
    const panel = renderRideOptionsPanel({ options: BASE_OPTIONS, context: ctx(), onChange: vi.fn() });
    const row = panel.element.querySelector('[data-option="save_tracks"]')!;
    expect(row.querySelector('[data-value="on"]')?.classList.contains("is-active")).toBe(true);

    panel.update({ ...BASE_OPTIONS, save_tracks: false }, ctx());
    // Same DOM node — re-synced in place, not replaced.
    expect(panel.element.querySelector('[data-option="save_tracks"]')).toBe(row);
    expect(row.querySelector('[data-value="off"]')?.classList.contains("is-active")).toBe(true);
    panel.destroy();
  });

  it("[Usuals] only shows once the list is non-empty AND a handler is wired", () => {
    const panel = renderRideOptionsPanel({ options: BASE_OPTIONS, context: ctx(), onChange: vi.fn() });
    const btn = panel.element.querySelector<HTMLButtonElement>(".ride-settings__usuals-btn")!;
    expect(btn.hidden).toBe(true);
    panel.setUsualsAvailable(true);
    expect(btn.hidden).toBe(true); // no onOpenUsuals handler — stays hidden
    panel.destroy();

    const onOpenUsuals = vi.fn();
    const panel2 = renderRideOptionsPanel({
      options: BASE_OPTIONS,
      context: ctx(),
      onChange: vi.fn(),
      onOpenUsuals,
      usualsAvailable: true,
    });
    const btn2 = panel2.element.querySelector<HTMLButtonElement>(".ride-settings__usuals-btn")!;
    expect(btn2.hidden).toBe(false);
    btn2.click();
    expect(onOpenUsuals).toHaveBeenCalledTimes(1);
    panel2.destroy();
  });

  it("ℹ opens the matching info modal, and destroy() closes it", () => {
    const panel = renderRideOptionsPanel({ options: BASE_OPTIONS, context: ctx(), onChange: vi.fn() });
    const infoBtn = panel.element.querySelector<HTMLButtonElement>(
      '[data-option="navigation"] .ride-settings__info',
    )!;
    infoBtn.click();
    const heading = document.querySelector("#ride-info-modal-title");
    expect(heading?.textContent).toBe("Destination Navigation");
    panel.destroy();
    expect(document.querySelector(".ranks-modal")).toBeNull();
  });
});

describe("openRideInfoModal", () => {
  it("falls back to document.body when no wizard is mounted", () => {
    const close = openRideInfoModal("navigation");
    const modal = document.querySelector(".ranks-modal");
    expect(modal).not.toBeNull();
    expect(modal!.parentElement).toBe(document.body);
    close();
    expect(document.querySelector(".ranks-modal")).toBeNull();
  });

  it("mounts inside the live wizard root, not as a body-level sibling, so the wizard's focus trap doesn't yank focus back out", () => {
    registerRideScreen("2", () => ({
      title: "Screen 2",
      primary: document.createElement("div"),
    }));
    openRideModal({ fastForwardTo: "2" });
    const root = rideModalRoot();
    expect(root).not.toBeNull();

    const close = openRideInfoModal("navigation");
    const modal = document.querySelector(".ranks-modal");
    expect(modal).not.toBeNull();
    expect(modal!.parentElement).toBe(root);
    close();
  });

  it("Escape closes the modal", () => {
    const close = openRideInfoModal("save_tracks");
    expect(document.querySelector(".ranks-modal")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".ranks-modal")).toBeNull();
    close(); // idempotent — already closed
  });

  it("only one modal is open at a time — opening a second closes the first", () => {
    openRideInfoModal("save_tracks");
    expect(document.querySelectorAll(".ranks-modal").length).toBe(1);
    const close2 = openRideInfoModal("navigation");
    expect(document.querySelectorAll(".ranks-modal").length).toBe(1);
    expect(document.querySelector("#ride-info-modal-title")?.textContent).toBe(
      "Destination Navigation",
    );
    close2();
  });
});
