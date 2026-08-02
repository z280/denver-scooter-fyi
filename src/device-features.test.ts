// @vitest-environment happy-dom
//
// device-features.ts: the "☑️ Confirm Features" survey.
//
// What is defended here, in rough order of "what would actually go wrong":
//
//  * NEITHER toggle is pressed by default, and Send stays disabled until
//    every question is answered. That is the whole reason the data is worth
//    collecting — a pre-pressed answer is an answer nobody gave.
//  * The condition follow-up only offers features the rider confirmed
//    present, and un-ticking a presence answer prunes the stale condition
//    claim. Without the pruning the API 422s on a contradiction the rider
//    can no longer even see on screen.
//  * A WRONG PLATE is never blocked, never validated locally, and never
//    treated as an error. The server owns that rule; a client copy of it
//    would drift and would hand out a free plate oracle.
//  * Points copy is read from /points/schedule, with a fallback that
//    matches src/points.py — so "+124 pts" can never promise a number the
//    ledger doesn't pay.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FEATURE_POINTS_FALLBACK,
  FEATURE_STATUS_LABEL,
  asFeatureStatus,
  describeSubmitError,
  emptyAnswers,
  featurePointsFor,
  openConfirmFeatures,
  presentFeatures,
  prunePoorCondition,
  readDeviceFeatures,
  readyToSubmit,
  summarizeFeatures,
  toRequestBody,
  type FeatureAnswerState,
} from "./device-features.ts";
import { ReportHttpError } from "./reports.ts";

beforeEach(() => {
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

describe("status vocabulary", () => {
  it("uses the owner's three labels verbatim", () => {
    expect(FEATURE_STATUS_LABEL.needs_features_confirmed).toBe(
      "Needs features confirmed",
    );
    expect(FEATURE_STATUS_LABEL.needs_review).toBe("Needs review");
    expect(FEATURE_STATUS_LABEL.up_to_date).toBe("Up to date");
  });

  it("treats an unknown or missing status as needing confirmation", () => {
    // Both the API's own default and the safe answer: it invites a report
    // rather than silently suppressing the button.
    for (const raw of [undefined, null, "", "brand_new_status", 7]) {
      expect(asFeatureStatus(raw)).toBe("needs_features_confirmed");
    }
  });

  it("passes the two real statuses through", () => {
    expect(asFeatureStatus("needs_review")).toBe("needs_review");
    expect(asFeatureStatus("up_to_date")).toBe("up_to_date");
  });

  it("pays the owner's three tiers when offline", () => {
    expect(FEATURE_POINTS_FALLBACK.needs_features_confirmed).toBe(12);
    expect(FEATURE_POINTS_FALLBACK.needs_review).toBe(124);
    expect(FEATURE_POINTS_FALLBACK.up_to_date).toBe(6);
  });

  it("prefers the server's schedule over the baked-in fallback", () => {
    // The whole point of /points/schedule: a retuned constant reaches the
    // copy on the next deploy without anyone remembering a second place.
    const schedule = { device_features_review: { points: 24 } };
    expect(featurePointsFor("needs_review", schedule)).toBe(24);
  });

  it("falls back when the schedule is missing that action", () => {
    expect(featurePointsFor("needs_review", {})).toBe(124);
    expect(featurePointsFor("needs_review", null)).toBe(124);
  });
});

// ---------------------------------------------------------------------------
// Answer state
// ---------------------------------------------------------------------------

function a(over: Partial<FeatureAnswerState> = {}): FeatureAnswerState {
  return { ...emptyAnswers(), ...over };
}

describe("answer state", () => {
  it("starts with nothing answered", () => {
    const empty = emptyAnswers();
    expect(empty.bell).toBeNull();
    expect(empty.cup_holder).toBeNull();
    expect(empty.phone_holder).toBeNull();
    expect(empty.allGood).toBeNull();
  });

  it("offers only confirmed-present features to the condition follow-up", () => {
    const state = a({ bell: true, cup_holder: false, phone_holder: true });
    expect(presentFeatures(state)).toEqual(["bell", "phone_holder"]);
  });

  it("treats an unanswered presence question as not present", () => {
    expect(presentFeatures(a({ bell: true }))).toEqual(["bell"]);
  });

  it("prunes a condition claim when the feature is toggled back to absent", () => {
    const state = a({ bell: false, cup_holder: true, poor: ["bell", "cup_holder"] });
    expect(prunePoorCondition(state)).toEqual(["cup_holder"]);
  });
});

// ---------------------------------------------------------------------------
// Send gating
// ---------------------------------------------------------------------------

describe("readyToSubmit", () => {
  const complete = a({
    bell: true,
    cup_holder: true,
    phone_holder: true,
    allGood: true,
    plate: "1025543",
  });

  it("accepts a fully answered survey", () => {
    expect(readyToSubmit(complete)).toBe(true);
  });

  it("refuses while any presence question is unanswered", () => {
    for (const key of ["bell", "cup_holder", "phone_holder"] as const) {
      expect(readyToSubmit({ ...complete, [key]: null })).toBe(false);
    }
  });

  it("refuses while the condition question is unanswered", () => {
    expect(readyToSubmit({ ...complete, allGood: null })).toBe(false);
  });

  it("refuses without a plate", () => {
    expect(readyToSubmit({ ...complete, plate: "" })).toBe(false);
    expect(readyToSubmit({ ...complete, plate: "   " })).toBe(false);
  });

  it("refuses 'not all good' with nothing itemised", () => {
    // Mirrors the API's own 422. Stopping the rider at a disabled button
    // with the follow-up visible beats a validation error after Send.
    expect(readyToSubmit({ ...complete, allGood: false, poor: [] })).toBe(false);
  });

  it("accepts 'not all good' once something is named", () => {
    expect(
      readyToSubmit({ ...complete, allGood: false, poor: ["bell"] }),
    ).toBe(true);
  });

  it("accepts 'not all good' on a scooter with none of the three features", () => {
    // There is nothing to itemise, so the follow-up is never shown — and a
    // question with no answerable options must not deadlock the button.
    expect(
      readyToSubmit(
        a({
          bell: false,
          cup_holder: false,
          phone_holder: false,
          allGood: false,
          plate: "1025543",
        }),
      ),
    ).toBe(true);
  });

  it("does not care whether the plate is right", () => {
    expect(readyToSubmit({ ...complete, plate: "not-a-plate" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

describe("toRequestBody", () => {
  it("sends unanswered presence questions as false", () => {
    // Unreachable through the UI (Send is disabled), but the wire type is
    // boolean and a null would be a 422.
    const body = toRequestBody(emptyAnswers());
    expect(body.has_bell).toBe(false);
    expect(body.has_cup_holder).toBe(false);
    expect(body.has_phone_holder).toBe(false);
  });

  it("derives all_good_condition from the pruned list", () => {
    // The API requires the two to agree; deriving is the only way they
    // cannot disagree.
    const body = toRequestBody(
      a({ bell: true, allGood: false, poor: ["bell"] }),
    );
    expect(body.all_good_condition).toBe(false);
    expect(body.poor_condition).toEqual(["bell"]);
  });

  it("reports 'all good' when the rider's complaint pruned away", () => {
    const body = toRequestBody(
      a({ bell: false, allGood: false, poor: ["bell"] }),
    );
    expect(body.all_good_condition).toBe(true);
    expect(body.poor_condition).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

function open(over: Record<string, unknown> = {}) {
  const submit = vi.fn().mockResolvedValue({
    id: 1,
    plate_valid: true,
    points_awarded: 12,
    feature_status: "needs_features_confirmed",
    deduped: false,
  });
  const close = openConfirmFeatures({
    deviceId: "dev1",
    vehicleIdentifier: "8c4a1f0d2e9b7a35",
    modelName: "Cosmo",
    status: "needs_features_confirmed",
    submit: submit as never,
    loadSchedule: (() => new Promise(() => {})) as never,
    ...over,
  });
  return { submit, close };
}

const pick = (id: string): HTMLButtonElement => {
  const b = document.querySelector<HTMLButtonElement>(`[data-pick="${id}"]`);
  if (!b) throw new Error(`no control ${id}`);
  return b;
};
const sendBtn = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-action="submit"]')!;
const plateField = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(".device-features__plate-input")!;

function answerEverything(allGood = true): void {
  pick("bell-yes").click();
  pick("cup_holder-no").click();
  pick("phone_holder-yes").click();
  pick(allGood ? "allgood-yes" : "allgood-no").click();
  plateField().value = "1025543";
  plateField().dispatchEvent(new Event("input"));
}

describe("the survey UI", () => {
  it("asks about the device by name", () => {
    open();
    expect(document.body.textContent).toContain("Does this Cosmo have…");
  });

  it("falls back to 'scooter' for an unrecognized model", () => {
    open({ modelName: null });
    expect(document.body.textContent).toContain("Does this scooter have…");
  });

  it("asks the owner's four questions", () => {
    open();
    const text = document.body.textContent ?? "";
    expect(text).toContain("a working bell?");
    expect(text).toContain("a cup holder?");
    expect(text).toContain("a phone holder?");
    expect(text).toContain("And they're all in good condition?");
  });

  it("presses NEITHER toggle by default", () => {
    open();
    for (const id of [
      "bell-yes", "bell-no",
      "cup_holder-yes", "cup_holder-no",
      "phone_holder-yes", "phone_holder-no",
      "allgood-yes", "allgood-no",
    ]) {
      expect(pick(id).classList.contains("is-on")).toBe(false);
      expect(pick(id).getAttribute("aria-checked")).toBe("false");
    }
  });

  it("shows the status and what it pays", () => {
    open({ status: "needs_review" });
    expect(document.body.textContent).toContain("Needs review");
    expect(document.body.textContent).toContain("+124 pts");
  });

  it("upgrades its points copy when the schedule lands", async () => {
    open({
      status: "needs_review",
      loadSchedule: (async () => ({ device_features_review: { points: 24 } })) as never,
    });
    expect(document.body.textContent).toContain("+124 pts");
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("+24 pts");
    });
  });

  it("keeps Send disabled until every question is answered", () => {
    open();
    expect(sendBtn().disabled).toBe(true);
    pick("bell-yes").click();
    pick("cup_holder-no").click();
    pick("phone_holder-yes").click();
    pick("allgood-yes").click();
    expect(sendBtn().disabled).toBe(true); // still no plate
    plateField().value = "1025543";
    plateField().dispatchEvent(new Event("input"));
    expect(sendBtn().disabled).toBe(false);
  });

  it("does not re-render on every plate keystroke", () => {
    // A full render would steal focus out of the field mid-typing.
    open();
    answerEverything();
    const field = plateField();
    field.focus();
    field.value = "10255";
    field.dispatchEvent(new Event("input"));
    expect(document.activeElement).toBe(field);
    expect(plateField()).toBe(field);
  });
});

describe("the condition follow-up", () => {
  it("stays hidden while everything is in good condition", () => {
    open();
    answerEverything(true);
    expect(document.querySelectorAll("[data-poor]").length).toBe(0);
  });

  it("offers only the features the rider confirmed present", () => {
    open();
    answerEverything(false);
    const offered = Array.from(
      document.querySelectorAll<HTMLElement>("[data-poor]"),
    ).map((n) => n.dataset.poor);
    expect(offered).toEqual(["bell", "phone_holder"]); // cup holder was "No"
  });

  it("is not shown at all when nothing is present to itemise", () => {
    open();
    pick("bell-no").click();
    pick("cup_holder-no").click();
    pick("phone_holder-no").click();
    pick("allgood-no").click();
    expect(document.querySelectorAll("[data-poor]").length).toBe(0);
    plateField().value = "1025543";
    plateField().dispatchEvent(new Event("input"));
    expect(sendBtn().disabled).toBe(false);
  });

  it("blocks Send until the rider names something", () => {
    open();
    answerEverything(false);
    expect(sendBtn().disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-poor="bell"]')!.click();
    expect(sendBtn().disabled).toBe(false);
  });

  it("prunes a claim when its feature is flipped back to absent", () => {
    open();
    answerEverything(false);
    document.querySelector<HTMLButtonElement>('[data-poor="bell"]')!.click();
    pick("bell-no").click();
    // The bell option is gone AND the claim went with it, so Send is
    // blocked again rather than posting a contradiction the API 422s.
    expect(document.querySelector('[data-poor="bell"]')).toBeNull();
    expect(sendBtn().disabled).toBe(true);
  });
});

describe("submitting", () => {
  it("posts the answers and the plate as typed", async () => {
    const { submit } = open();
    answerEverything(true);
    plateField().value = "  #1025543 ";
    plateField().dispatchEvent(new Event("input"));
    sendBtn().click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0][0]).toMatchObject({
      vehicle_identifier: "8c4a1f0d2e9b7a35",
      device_id: "dev1",
      submitted_plate: "  #1025543 ",
      has_bell: true,
      has_cup_holder: false,
      has_phone_holder: true,
      all_good_condition: true,
      poor_condition: [],
    });
  });

  it("reports what the server actually paid", async () => {
    const { submit } = open();
    submit.mockResolvedValue({
      id: 1, plate_valid: true, points_awarded: 124,
      feature_status: "needs_review", deduped: false,
    });
    answerEverything();
    sendBtn().click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("+124 pts");
    });
  });

  it("never blocks a wrong plate, and says so kindly afterwards", async () => {
    // The server owns the plate rule. The client's job is to send whatever
    // was typed and then report the outcome without treating a wrong plate
    // as a rejection of work the rider actually did.
    const { submit } = open();
    submit.mockResolvedValue({
      id: 1, plate_valid: false, points_awarded: 0,
      feature_status: "needs_features_confirmed", deduped: false,
    });
    answerEverything();
    plateField().value = "0000000";
    plateField().dispatchEvent(new Event("input"));
    expect(sendBtn().disabled).toBe(false);
    sendBtn().click();
    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("didn't match");
      expect(text).toContain("still recorded");
    });
  });

  it("explains a zero-point but valid submission", async () => {
    const { submit } = open();
    submit.mockResolvedValue({
      id: 1, plate_valid: true, points_awarded: 0,
      feature_status: "up_to_date", deduped: false,
    });
    answerEverything();
    sendBtn().click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("already earned points");
    });
  });

  it("keeps the survey open and retryable when the POST fails", async () => {
    const { submit } = open();
    submit.mockRejectedValue(new Error("offline"));
    answerEverything();
    sendBtn().click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Couldn't send that");
    });
    expect(sendBtn().disabled).toBe(false);
  });

  it("notifies the caller with the outcome", async () => {
    const onSubmitted = vi.fn();
    open({ onSubmitted });
    answerEverything();
    sendBtn().click();
    await vi.waitFor(() =>
      expect(onSubmitted).toHaveBeenCalledWith({
        plateValid: true,
        pointsAwarded: 12,
      }),
    );
  });

  it("cannot be double-submitted", async () => {
    const { submit } = open();
    let resolve!: (v: unknown) => void;
    submit.mockReturnValue(new Promise((r) => (resolve = r)));
    answerEverything();
    sendBtn().click();
    expect(sendBtn().disabled).toBe(true);
    sendBtn().click();
    resolve({
      id: 1, plate_valid: true, points_awarded: 12,
      feature_status: "needs_features_confirmed", deduped: false,
    });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });
});

describe("dismissal", () => {
  it("closes on Escape", () => {
    open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".device-features")).toBeNull();
  });

  it("never leaves two open at once", () => {
    open();
    open();
    expect(document.querySelectorAll(".device-features").length).toBe(1);
  });

  it("TEARS DOWN the previous modal rather than just unhooking its DOM", () => {
    // Same leak, same reasoning as ride-preflight's: a removed node leaves
    // the Escape handler and `trapFocusWithin`'s document `focusin` handler
    // live, and the orphaned trap never stops thinking it is active.
    const onClose = vi.fn();
    open({ onClose });
    expect(onClose).not.toHaveBeenCalled();
    open();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not let an orphaned focus trap steal focus", () => {
    open();
    const stale = document.querySelector<HTMLElement>(".device-features__card");
    open();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(document.activeElement).not.toBe(stale);
  });
});

// ---------------------------------------------------------------------------
// Failure copy
// ---------------------------------------------------------------------------

describe("describeSubmitError", () => {
  it("names a 422 as our bug, not the rider's connection", () => {
    // Unreachable through the UI (readyToSubmit enforces the same rules the
    // API validates), which is exactly why "check your connection" would be
    // the wrong thing to say if it ever fires.
    const msg = describeSubmitError(new ReportHttpError(422));
    expect(msg).toContain("bug");
    expect(msg).not.toContain("connection");
  });

  it("tells a rate-limited rider to wait rather than retry blindly", () => {
    expect(describeSubmitError(new ReportHttpError(429))).toContain("break");
  });

  it("distinguishes an expired session", () => {
    expect(describeSubmitError(new ReportHttpError(401))).toContain("session");
  });

  it("distinguishes a scooter that left the fleet", () => {
    expect(describeSubmitError(new ReportHttpError(404))).toContain("fleet");
  });

  it("distinguishes a server fault from a client one", () => {
    expect(describeSubmitError(new ReportHttpError(503))).toContain("server");
  });

  it("falls back to the connection message when we never heard back", () => {
    // A genuine network failure has no status — this is the one case the
    // original blanket message was actually right about.
    expect(describeSubmitError(new TypeError("fetch failed"))).toContain(
      "connection",
    );
  });
});

// ---------------------------------------------------------------------------
// Reading the map payload
// ---------------------------------------------------------------------------

describe("readDeviceFeatures", () => {
  const known = {
    bell: true,
    cup_holder: false,
    phone_holder: true,
    poor_condition: ["bell"],
  };

  it("reads the object the raw-GeoJSON path hands over", () => {
    expect(readDeviceFeatures(known)).toEqual(known);
  });

  it("reads the JSON string MapLibre's property flattening produces", () => {
    // The click path stringifies nested properties. Both paths open the same
    // popup, so both have to land on the same object.
    expect(readDeviceFeatures(JSON.stringify(known))).toEqual(known);
  });

  it("reads 'nobody has confirmed this yet' as unknown, not as an error", () => {
    // The common case for most of the fleet on day one.
    for (const raw of [null, undefined, "", "null"]) {
      expect(readDeviceFeatures(raw)).toBeNull();
    }
  });

  it("treats unparseable junk as unknown rather than throwing", () => {
    // A popup that throws is a popup that never opens.
    expect(readDeviceFeatures("{not json")).toBeNull();
    expect(readDeviceFeatures(42)).toBeNull();
  });

  it("drops poor_condition entries it does not recognize", () => {
    const parsed = readDeviceFeatures({
      bell: true,
      cup_holder: true,
      phone_holder: true,
      poor_condition: ["bell", "basket", 7],
    });
    expect(parsed?.poor_condition).toEqual(["bell"]);
  });

  it("coerces missing booleans to false rather than undefined", () => {
    expect(readDeviceFeatures({})).toEqual({
      bell: false,
      cup_holder: false,
      phone_holder: false,
      poor_condition: [],
    });
  });
});

describe("summarizeFeatures", () => {
  it("lists what's on the scooter", () => {
    expect(
      summarizeFeatures({
        bell: true,
        cup_holder: true,
        phone_holder: false,
        poor_condition: [],
      }),
    ).toBe("🔔 Bell · 🥤 Cup holder");
  });

  it("flags the ones that need work", () => {
    expect(
      summarizeFeatures({
        bell: true,
        cup_holder: false,
        phone_holder: false,
        poor_condition: ["bell"],
      }),
    ).toBe("🔔 Bell (needs work)");
  });

  it("says so when someone looked and found none of the three", () => {
    // A different fact from nobody having looked — which is what
    // `readDeviceFeatures` returning null means, and which the popup renders
    // as the status label instead.
    expect(
      summarizeFeatures({
        bell: false,
        cup_holder: false,
        phone_holder: false,
        poor_condition: [],
      }),
    ).toBe("None of the three");
  });
});
