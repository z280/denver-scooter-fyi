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
  RIDE_OPTIONS_FOOTNOTE,
  RIDE_OPTION_ROWS,
  RIDE_PROVIDER_NAME,
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
// The seven ℹ info modals — verbatim copy fidelity. These strings are
// transcribed word-for-word from RIDE_MODE_OVERHAUL_PLAN.md Part 0 "Screen 2"
// — any future edit to that doc's copy should show up here as a failing test.
// No "theme" row/modal: removed in favor of the app's two existing live theme
// fixtures (the map's ThemeControl and the ride HUD's toggle-night button) —
// see ride-settings.ts's own module header for why.
// ---------------------------------------------------------------------------

describe("RIDE_OPTION_ROWS — Screen 2 table copy, verbatim", () => {
  it("matches the owner's table, in order, with the right 🏆 flags", () => {
    expect(RIDE_OPTION_ROWS.map((r) => [r.id, r.label, r.trophy])).toEqual([
      ["cost_hud", "Est. Veo Cost HUD", false],
      ["speedometer", "Speedometer", false],
      ["navigation", "Destination Navigation", false],
      ["save_tracks", "Save ride tracks locally", false],
      ["battery_modeling", "Improve battery modeling", true],
      ["nav_improvement", "Navigation Improvement", true],
      ["end_survey", "End ride survey", true],
    ]);
  });

  it("carries the exact footnote", () => {
    expect(RIDE_OPTIONS_FOOTNOTE).toBe("🏆 Earns points for leaderboards");
  });

  it("RIDE_PROVIDER_NAME is Veo today", () => {
    expect(RIDE_PROVIDER_NAME).toBe("Veo");
  });
});

describe("RIDE_INFO_MODAL_COPY — Screen 2 ℹ modal copy, verbatim", () => {
  const P = FALLBACK_RIDE_MODE_POINTS;

  it("cost_hud", () => {
    expect(RIDE_INFO_MODAL_COPY.cost_hud.title).toBe("Estimate Veo Cost HUD");
    expect(RIDE_INFO_MODAL_COPY.cost_hud.body(P)).toBe(
      "The app can show a Heads Up Display with your expected ride cost, based on what we know about the duration of your trip and the rate provided. This helps avoid end of ride surprises. Note: The Veo app will always be the authority on ride cost.",
    );
  });

  it("speedometer", () => {
    expect(RIDE_INFO_MODAL_COPY.speedometer.title).toBe("Speedometer");
    expect(RIDE_INFO_MODAL_COPY.speedometer.body(P)).toBe(
      "We've found that the speedometers on the Veo devices are really hard to read, especially in the bright colorado sun. So, we provide ON by default both a classic and digital readout of your speed tracked by GPS. Disable if you don't like fun or convenience. Always keep your eyes on where you're going!",
    );
  });

  it("navigation (Destination Navigation)", () => {
    expect(RIDE_INFO_MODAL_COPY.navigation.title).toBe("Destination Navigation");
    expect(RIDE_INFO_MODAL_COPY.navigation.body(P)).toBe(
      "We're trying to make not just 'good' directions, but, THE BEST directions for scooters and eBikes in Denver! Unlike the big name providers, we specifically AVOID paths that City of Denver reports as High Injury Network (HIN) roads. Our primary route type provides a direct safe route using safe infrastructure as much as possible, and we also give you options to avoid hills and save battery, stay out of the sun as much as possible, and just take the most direct route.",
    );
  });

  it("save_tracks (Save Ride Tracks)", () => {
    expect(RIDE_INFO_MODAL_COPY.save_tracks.title).toBe("Save Ride Tracks");
    expect(RIDE_INFO_MODAL_COPY.save_tracks.body(P)).toBe(
      "This option allows you to trace where you've been on the map display, and also save waypoints of your location to your local device. Tracking information is not persisted to Scooter.fyi unless you opt to share.",
    );
  });

  it("battery_modeling — 8 pts base + 2 pts/2 km, fallback values", () => {
    expect(RIDE_INFO_MODAL_COPY.battery_modeling.title).toBe("Improve battery modeling");
    expect(RIDE_INFO_MODAL_COPY.battery_modeling.body(P)).toBe(
      "*Why*: Veo's data seems to suggest that every single one of their fleet has the same distance capability on a full charge. We think that's kind of fake, and we want to build a more accurate prediction of device range. *How*: This feature requires association with a specific Veo scooter, and saved ride tracks donated at the end of your trip. You'll need to start the scooter approximately at the location where you started ride mode, and end the scooter ride where you end the ride mode, report the battery percentage showed in the Veo app at the end of your trip, and donate your saved ride tracks (stored waypoints). With all conditions met, you'll earn **8 pts** for a valid trip + **2 points per 2 kilometer** tracked (rounded up). *Our Usage*: After awarding points, the stored trip data is disassociated from your personal account and used along with the provided start and end percentages to improve our understanding of expected range vs reported battery for Veo devices.",
    );
  });

  it("nav_improvement — 4 + 6 + 2/3 km, the 5→6 pts qualitative-feedback correction", () => {
    expect(RIDE_INFO_MODAL_COPY.nav_improvement.title).toBe("Improve Navigation");
    const body = RIDE_INFO_MODAL_COPY.nav_improvement.body(P);
    expect(body).toBe(
      "We want to provide the BEST navigation for users in Denver, and we need your help. At the end of your ride return to the app to complete a quick survey about your route, and donate your trip data in order to earn points. Earn **4 points** for following the selected route and providing a rating, **6 pts** for qualitative feedback, plus **2 points per 3 km** of valid trip data (rounded up, so a 1 km trip gets 2 points). After points award, navigation records used for navigation improvement are disassociated with your account.",
    );
    expect(body).toContain("**6 pts**");
    expect(body).not.toContain("5 pts");
  });

  it("end_survey (End Survey) — 4 pts", () => {
    expect(RIDE_INFO_MODAL_COPY.end_survey.title).toBe("End Survey");
    expect(RIDE_INFO_MODAL_COPY.end_survey.body(P)).toBe(
      "Collect details about the scooter/glider/bike you just rode in order to help Scooter.fyi users to continue to find the best scooters available. Survey provides **4 pts**.",
    );
  });

  it("the 🏆 bodies re-render live schedule numbers, not just the fallback", () => {
    const live: ResolvedRideModePoints = {
      ...FALLBACK_RIDE_MODE_POINTS,
      batteryBase: 10,
      navQualitativeFeedback: 12,
      surveyPoints: 6,
    };
    expect(RIDE_INFO_MODAL_COPY.battery_modeling.body(live)).toContain("**10 pts**");
    expect(RIDE_INFO_MODAL_COPY.nav_improvement.body(live)).toContain("**12 pts**");
    expect(RIDE_INFO_MODAL_COPY.end_survey.body(live)).toContain("**6 pts**");
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
  it("renders all 7 rows in the owner's table order", () => {
    const panel = renderRideOptionsPanel({
      options: BASE_OPTIONS,
      context: ctx(),
      onChange: vi.fn(),
    });
    const rows = [...panel.element.querySelectorAll<HTMLElement>(".ride-settings__row")];
    expect(rows.map((r) => r.dataset.option)).toEqual([
      "cost_hud",
      "speedometer",
      "navigation",
      "save_tracks",
      "battery_modeling",
      "nav_improvement",
      "end_survey",
    ]);
    panel.destroy();
  });

  it("marks the current value active on each row", () => {
    const panel = renderRideOptionsPanel({
      options: { ...BASE_OPTIONS, speedometer: "digital" },
      context: ctx(),
      onChange: vi.fn(),
    });
    const speedoRow = panel.element.querySelector('[data-option="speedometer"]')!;
    expect(
      speedoRow.querySelector('[data-value="digital"]')?.classList.contains("is-active"),
    ).toBe(true);
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

  it("a disabled row's buttons cannot be clicked into changing anything", () => {
    const onChange = vi.fn();
    const panel = renderRideOptionsPanel({
      options: { ...BASE_OPTIONS, own_device: true },
      context: ctx({ private: true }),
      onChange,
    });
    const onBtn = panel.element.querySelector<HTMLButtonElement>(
      '[data-option="battery_modeling"] [data-value="on"]',
    )!;
    expect(onBtn.disabled).toBe(true);
    onBtn.click();
    expect(onChange).not.toHaveBeenCalled();
    panel.destroy();
  });

  it("disables the three 🏆 rows for a guest/private context, with sign-in copy shown", () => {
    const panel = renderRideOptionsPanel({
      options: BASE_OPTIONS,
      context: ctx({ private: true, authenticated: false }),
      onChange: vi.fn(),
    });
    for (const id of ["battery_modeling", "nav_improvement", "end_survey"]) {
      const row = panel.element.querySelector<HTMLElement>(`[data-option="${id}"]`)!;
      expect(row.classList.contains("ride-settings__row--disabled")).toBe(true);
      const buttons = [...row.querySelectorAll<HTMLButtonElement>(".seg-btn")];
      expect(buttons.every((b) => b.disabled)).toBe(true);
      const reason = row.querySelector<HTMLElement>(".ride-settings__reason")!;
      expect(reason.hidden).toBe(false);
      expect(reason.textContent).toMatch(/Sign in/);
    }
    // The four non-trophy rows stay fully enabled.
    for (const id of ["cost_hud", "speedometer", "navigation", "save_tracks"]) {
      const row = panel.element.querySelector<HTMLElement>(`[data-option="${id}"]`)!;
      expect(row.classList.contains("ride-settings__row--disabled")).toBe(false);
    }
    panel.destroy();
  });

  it("update() re-syncs rows for a new options/context snapshot without rebuilding the DOM", () => {
    const panel = renderRideOptionsPanel({ options: BASE_OPTIONS, context: ctx(), onChange: vi.fn() });
    const row = panel.element.querySelector('[data-option="battery_modeling"]')!;
    expect(row.classList.contains("ride-settings__row--disabled")).toBe(false);

    panel.update({ ...BASE_OPTIONS, own_device: true }, ctx({ private: true }));
    // Same DOM node — re-synced in place, not replaced.
    expect(panel.element.querySelector('[data-option="battery_modeling"]')).toBe(row);
    expect(row.classList.contains("ride-settings__row--disabled")).toBe(true);
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
      '[data-option="speedometer"] .ride-settings__info',
    )!;
    infoBtn.click();
    const heading = document.querySelector("#ride-info-modal-title");
    expect(heading?.textContent).toBe("Speedometer");
    panel.destroy();
    expect(document.querySelector(".ranks-modal")).toBeNull();
  });
});

describe("openRideInfoModal", () => {
  it("falls back to document.body when no wizard is mounted", () => {
    const close = openRideInfoModal("cost_hud");
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

  it("renders bold/italic markers as real elements, not literal asterisks", () => {
    const close = openRideInfoModal("battery_modeling", FALLBACK_RIDE_MODE_POINTS);
    const body = document.querySelector(".ride-info-modal__body")!;
    expect(body.querySelector("strong")?.textContent).toBe("8 pts");
    expect(body.querySelector("em")?.textContent).toBe("Why");
    expect(body.textContent).not.toContain("**");
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
    openRideInfoModal("cost_hud");
    expect(document.querySelectorAll(".ranks-modal").length).toBe(1);
    const close2 = openRideInfoModal("navigation");
    expect(document.querySelectorAll(".ranks-modal").length).toBe(1);
    expect(document.querySelector("#ride-info-modal-title")?.textContent).toBe(
      "Destination Navigation",
    );
    close2();
  });
});
