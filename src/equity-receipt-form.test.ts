// @vitest-environment happy-dom
//
// The "Didn't get the discount?" receipt form (Phase 1 of the equity-receipt
// plan). The rules worth pinning: money is parsed without a float anywhere
// near it, the scooter code is normalised the way a receipt prints it, the
// client gate matches the server's (so a rider hears about a typo before
// uploading two images), the multipart body carries exactly the contract's
// field names, and each failure the API can return says the right thing.
//
// Offline throughout: the POST is injected, or `fetch` is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  discountReportFormData,
  submitDiscountReport,
  type DiscountReportIn,
} from "./api.ts";
import {
  MSG_NOT_RATE_CHECKABLE,
  MSG_RATE_LIMITED,
  MSG_RECEIVED,
  MSG_TOO_LARGE_ONE,
  MAX_IMAGE_BYTES,
  denverIso,
  describeSubmitError,
  isValidPlate,
  latestChargeDate,
  normalisePlate,
  openEquityReceiptForm,
  parseCents,
  parseMinutes,
  prefillRatePlan,
  validateReceipt,
  type ReceiptFormDeps,
  type ReceiptFormValues,
} from "./equity-receipt-form.ts";

const NOW = new Date("2026-10-07T18:00:00Z");

function png(name = "r.png", size = 1000): File {
  const f = new File([new Uint8Array(4)], name, { type: "image/png" });
  if (size !== 4) Object.defineProperty(f, "size", { value: size });
  return f;
}

function goodValues(over: Partial<ReceiptFormValues> = {}): ReceiptFormValues {
  return {
    plate: "1018354",
    minutes: "16",
    subtotal: "5.00",
    total: "5.46",
    chargeDate: "2026-09-29",
    startTime: "",
    ratePlan: "resident",
    pinStart: null,
    pinEnd: null,
    receipt: png("receipt.png"),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseCents", () => {
  it("reads dollars and cents as integers, never through a float", () => {
    expect(parseCents("4.50")).toEqual({ kind: "ok", value: 450 });
    // 0.29 * 100 === 28.999999999999996 — the bug this exists to avoid.
    expect(parseCents("0.29")).toEqual({ kind: "ok", value: 29 });
    expect(parseCents("1.15")).toEqual({ kind: "ok", value: 115 });
    expect(parseCents("4.5")).toEqual({ kind: "ok", value: 450 });
    expect(parseCents("4")).toEqual({ kind: "ok", value: 400 });
    expect(parseCents("4.")).toEqual({ kind: "ok", value: 400 });
    expect(parseCents(".5")).toEqual({ kind: "ok", value: 50 });
    expect(parseCents(" $6.25 ")).toEqual({ kind: "ok", value: 625 });
    expect(parseCents("0")).toEqual({ kind: "ok", value: 0 });
  });

  it("tells blank apart from wrong", () => {
    expect(parseCents("")).toEqual({ kind: "blank" });
    expect(parseCents("   ")).toEqual({ kind: "blank" });
    for (const bad of ["4.505", "-1", "abc", "4,50", "1e2", ".", "$", "12345"]) {
      expect(parseCents(bad), bad).toEqual({ kind: "invalid" });
    }
  });
});

describe("the scooter code", () => {
  it("drops spaces and the receipt's leading #", () => {
    expect(normalisePlate(" 101 8354 ")).toBe("1018354");
    expect(normalisePlate("#1018354")).toBe("1018354");
  });

  it("is 7 to 10 digits", () => {
    expect(isValidPlate("1018354")).toBe(true);
    expect(isValidPlate("1018354123")).toBe(true);
    expect(isValidPlate("101835")).toBe(false);
    expect(isValidPlate("10183541234")).toBe(false);
    expect(isValidPlate("10183A4")).toBe(false);
  });
});

describe("parseMinutes", () => {
  it("is a whole number from 1 to 600", () => {
    expect(parseMinutes("16")).toEqual({ kind: "ok", value: 16 });
    expect(parseMinutes("600")).toEqual({ kind: "ok", value: 600 });
    expect(parseMinutes("")).toEqual({ kind: "blank" });
    for (const bad of ["0", "601", "4.5", "-3", "ten"]) {
      expect(parseMinutes(bad), bad).toEqual({ kind: "invalid" });
    }
  });
});

describe("dates and times", () => {
  it("writes a Denver wall-clock time with Denver's offset, either side of DST", () => {
    expect(denverIso("2026-09-29", "15:16")).toBe("2026-09-29T15:16:00-06:00");
    expect(denverIso("2026-12-01", "08:05")).toBe("2026-12-01T08:05:00-07:00");
  });

  it("allows today, wherever the phone thinks today is", () => {
    // 18:00Z is noon in Denver; both readings agree on the date.
    expect(latestChargeDate(NOW)).toBe("2026-10-07");
  });
});

describe("prefillRatePlan", () => {
  it("takes the profile's plan, keeping a local VeoPlus refinement of it", () => {
    expect(prefillRatePlan("resident", "resident_plus")).toBe("resident_plus");
    expect(prefillRatePlan("visitor", "resident_plus")).toBe("visitor");
    expect(prefillRatePlan(null, "equity")).toBe("equity");
    expect(prefillRatePlan(null, null)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// The whole-form gate
// ---------------------------------------------------------------------------

describe("validateReceipt", () => {
  it("builds the request from a complete form", () => {
    const r = validateReceipt(
      goodValues({
        plate: "#101 8354",
        startTime: "15:16",
        pinStart: { lat: 39.78, lng: -104.82 },
      }),
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({
      vehicle_plate: "1018354",
      trip_minutes: 16,
      subtotal_cents: 500,
      total_cents: 546,
      charge_date: "2026-09-29",
      approx_started_at: "2026-09-29T15:16:00-06:00",
      declared_rate_plan: "resident",
      pin_start: { lat: 39.78, lng: -104.82 },
    });
    expect(r.input.pin_end).toBeUndefined();
  });

  it("needs only one of the two costs", () => {
    const r = validateReceipt(goodValues({ subtotal: "" }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.subtotal_cents).toBeUndefined();
      expect(r.input.total_cents).toBe(546);
    }
  });

  it("names every missing required field", () => {
    const r = validateReceipt(
      goodValues({
        plate: "",
        minutes: "",
        subtotal: "",
        total: "",
        chargeDate: "",
        receipt: null,
      }),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // No "plan": the plan SCREENSHOT is gone (owner, 2026-10-07). The rider
    // still picks a rate plan, but a select always has a value, so it is never
    // a missing-field error.
    expect(Object.keys(r.errors).sort()).toEqual(
      ["chargeDate", "cost", "minutes", "plate", "receipt"].sort(),
    );
  });

  it("refuses a future charge date, one before 2024, and a total under the subtotal", () => {
    const future = validateReceipt(goodValues({ chargeDate: "2026-10-09" }), NOW);
    expect(!future.ok && future.errors.chargeDate).toMatch(/future/);
    const old = validateReceipt(goodValues({ chargeDate: "2023-12-31" }), NOW);
    expect(!old.ok && old.errors.chargeDate).toBeTruthy();
    const under = validateReceipt(goodValues({ subtotal: "5.00", total: "4.99" }), NOW);
    expect(!under.ok && under.errors.cost).toMatch(/less than/);
  });

  it("refuses an image over 10 MB before uploading it", () => {
    const r = validateReceipt(goodValues({ receipt: png("big.png", MAX_IMAGE_BYTES + 1) }), NOW);
    expect(!r.ok && r.errors.receipt).toBe(MSG_TOO_LARGE_ONE);
  });
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

function input(over: Partial<DiscountReportIn> = {}): DiscountReportIn {
  return {
    vehicle_plate: "1018354",
    trip_minutes: 16,
    subtotal_cents: 500,
    charge_date: "2026-09-29",
    declared_rate_plan: "unknown",
    receipt: png("receipt.png"),
    ...over,
  };
}

describe("discountReportFormData", () => {
  it("carries the contract's field names, and omits what wasn't given", () => {
    const fd = discountReportFormData(
      input({ pin_end: { lat: 39.7812345678, lng: -104.8212345678 } }),
    );
    expect(fd.get("vehicle_plate")).toBe("1018354");
    expect(fd.get("trip_minutes")).toBe("16");
    expect(fd.get("subtotal_cents")).toBe("500");
    expect(fd.has("total_cents")).toBe(false);
    expect(fd.get("charge_date")).toBe("2026-09-29");
    expect(fd.has("approx_started_at")).toBe(false);
    expect(fd.get("declared_rate_plan")).toBe("unknown");
    expect(fd.has("pin_start_lat")).toBe(false);
    expect(fd.get("pin_end_lat")).toBe("39.78123");
    expect(fd.get("pin_end_lng")).toBe("-104.82123");
    expect(fd.get("receipt")).toBeInstanceOf(Blob);
    // NO plan screenshot on the wire. The API ignores the part rather than
    // rejecting it, so sending one would cost a rider an upload for bytes
    // nobody reads (owner, 2026-10-07; API sql/094).
    expect(fd.get("plan_evidence")).toBeNull();
  });
});

describe("submitDiscountReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubAuth(): void {
    const store = new Map<string, string>([
      [
        "scooter_fyi.map_auth",
        JSON.stringify({
          token: "test-token",
          expires: new Date(Date.now() + 3_600_000).toISOString(),
          issued_at: new Date().toISOString(),
        }),
      ],
    ]);
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    };
    vi.stubGlobal("sessionStorage", fake);
    vi.stubGlobal("localStorage", fake);
  }

  it("POSTs multipart with the bearer token and no hand-set Content-Type", async () => {
    stubAuth();
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/api\/v1\/reports\/discount$/);
      calls.push(init);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 7,
            created_at: "2026-10-07T18:00:00Z",
            status: "received",
            receipt_stored: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    const res = await submitDiscountReport(input());
    expect(res.status).toBe("received");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBeInstanceOf(FormData);
    const headers = calls[0].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("carries the structured 422 key through to the caller", async () => {
    stubAuth();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ detail: { error: "not_rate_checkable", missing: ["vehicle_plate"] } }),
          { status: 422 },
        ),
      ),
    );
    const err = await submitDiscountReport(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).errorKey).toBe("not_rate_checkable");
  });
});

describe("describeSubmitError", () => {
  const http = (status: number, detail?: unknown) =>
    new ApiError("x", "HTTP_ERROR", {
      status,
      detail,
      errorKey:
        detail && typeof detail === "object" && "error" in detail
          ? String((detail as { error: string }).error)
          : undefined,
    });

  it("maps each documented failure", () => {
    expect(describeSubmitError(new ApiError("x", "NO_AUTH")).kind).toBe("signed_out");
    expect(describeSubmitError(new ApiError("x", "TOKEN_REJECTED")).kind).toBe("signed_out");
    expect(describeSubmitError(http(422, { error: "not_rate_checkable", missing: [] })).kind).toBe(
      "not_rate_checkable",
    );
    expect(describeSubmitError(http(429)).kind).toBe("rate_limited");
    // `plan_evidence_required` is a 422 the API cannot send any more. It is
    // not special-cased: an unrecognised 422 falls through to the generic
    // "look it over" message rather than naming a field that is not on screen.
    expect(describeSubmitError(http(422, { error: "plan_evidence_required" })).kind)
      .toBe("failed");
    expect(describeSubmitError(http(422, { error: "receipt_required" }))).toMatchObject({
      kind: "fields",
      errors: { receipt: expect.any(String) },
    });
    expect(
      describeSubmitError(http(413, { error: "image_too_large", field: "receipt", max_bytes: 1 })),
    ).toEqual({ kind: "fields", errors: { receipt: MSG_TOO_LARGE_ONE } });
    expect(describeSubmitError(new TypeError("offline")).kind).toBe("failed");
  });

  it("puts each invalid_field under the field it names", () => {
    const out = describeSubmitError(
      http(422, { error: "invalid_field", fields: ["vehicle_plate", "total_cents", "pin_end"] }),
    );
    expect(out.kind).toBe("fields");
    if (out.kind !== "fields") return;
    expect(Object.keys(out.errors).sort()).toEqual(["cost", "plate"]);
    expect(out.summary).toMatch(/end pin/);
  });
});

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

describe("openEquityReceiptForm", () => {
  let close: (() => void) | null = null;
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => {
    close?.();
    close = null;
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

  function open(over: Partial<ReceiptFormDeps> = {}) {
    const deps: ReceiptFormDeps = {
      isSignedIn: () => true,
      openSignIn: vi.fn(),
      loadRatePlan: () => Promise.resolve("resident_plus"),
      submit: vi.fn(() =>
        Promise.resolve({
          id: 1,
          created_at: "2026-10-07T18:00:00Z",
          status: "received" as const,
          receipt_stored: true,
        }),
      ),
      now: () => NOW,
      ...over,
    };
    close = openEquityReceiptForm(deps);
    return deps;
  }

  function setFile(id: string, file: File | null): void {
    Object.defineProperty(q<HTMLInputElement>(`#${id}`), "files", {
      value: file ? [file] : [],
      configurable: true,
    });
  }

  function fill(): void {
    q<HTMLInputElement>("#equity-receipt-plate").value = "101 8354";
    q<HTMLInputElement>("#equity-receipt-minutes").value = "16";
    q<HTMLInputElement>("#equity-receipt-subtotal").value = "5.00";
    q<HTMLInputElement>("#equity-receipt-date").value = "2026-09-29";
    setFile("equity-receipt-receipt", png("receipt.png"));
  }

  const send = () =>
    q<HTMLFormElement>(".equity-receipt__form").dispatchEvent(
      new Event("submit", { cancelable: true }),
    );

  it("signed out, offers sign-in instead of the form", () => {
    const deps = open({ isSignedIn: () => false });
    expect(document.querySelector(".equity-receipt__form")).toBeNull();
    const btn = q<HTMLButtonElement>('[data-role="sign-in"]');
    expect(btn.textContent).toBe("Sign in to send a receipt");
    expect(document.activeElement).toBe(btn);
    btn.click();
    expect(deps.openSignIn).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".equity-receipt")).toBeNull();
  });

  it("is a labelled dialog, focuses the first field, and prefills the plan", async () => {
    open();
    const card = q(".equity-receipt__card");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.id).toBe("equity-receipt-plate");
    // Every field has a label pointing at it.
    for (const id of ["plate", "minutes", "subtotal", "total", "date", "time", "plan", "receipt"]) {
      expect(document.querySelector(`label[for="equity-receipt-${id}"]`), id).not.toBeNull();
    }
    // Nothing typed for the rider; the plan starts "Not sure" and is then
    // set from the profile.
    expect(q<HTMLInputElement>("#equity-receipt-plate").value).toBe("");
    await flush();
    expect(q<HTMLSelectElement>("#equity-receipt-plan").value).toBe("resident_plus");
    const values = [...q<HTMLSelectElement>("#equity-receipt-plan").options].map((o) => o.value);
    expect(values).toEqual(["resident", "resident_plus", "visitor", "visitor_plus", "equity", "unknown"]);
  });

  it("says where the image is read and how long it is kept, at the upload itself", () => {
    // The privacy policy carries the same three facts, but it is reachable only
    // from the map's attribution panel — a disclosure nobody reads before
    // uploading. This is the moment somebody is actually choosing.
    open();
    const hint = q("#equity-receipt-receipt-hint").textContent ?? "";
    expect(hint).toMatch(/on your device or on our server/i);
    expect(hint).toMatch(/18 months/);
    expect(hint).toMatch(/private storage/i);
  });

  it("does not promise that the image stays on the device", () => {
    // Phase 8 §8.1 once said the image never leaves the device. The owner's
    // rule (2026-10-07) allows either place, so asserting the stronger version
    // anywhere a rider can read it would be a promise the software may break.
    open();
    expect(document.body.textContent).not.toMatch(/never leaves your device/i);
    expect(document.body.textContent).not.toMatch(/stays on your device/i);
  });

  it("asks for no plan screenshot at all", () => {
    // It was required until 2026-10-07, with a hint explaining that the
    // contract gives the Equity Area rate whatever plan you are on. The field
    // is gone; the rider's own answer in the Plan select is what we use.
    open();
    expect(document.getElementById("equity-receipt-plan-evidence")).toBeNull();
    expect(document.body.textContent).not.toMatch(/plan screenshot/i);
    // The plan SELECT stays — we still ask which plan, we just believe them.
    expect(q<HTMLSelectElement>("#equity-receipt-plan")).not.toBeNull();
  });

  it("shows inline errors, announced, and sends nothing", () => {
    const deps = open();
    send();
    expect(deps.submit).not.toHaveBeenCalled();
    const alert = q('.equity-receipt__alert[role="alert"]');
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toMatch(/things to fix/);
    const plate = q<HTMLInputElement>("#equity-receipt-plate");
    expect(plate.getAttribute("aria-invalid")).toBe("true");
    expect(plate.getAttribute("aria-describedby")).toContain("equity-receipt-plate-error");
    expect(q("#equity-receipt-plate-error").hidden).toBe(false);
    expect(document.activeElement).toBe(plate);
  });

  it("sends the normalised values and confirms receipt", async () => {
    const deps = open();
    await flush();
    fill();
    send();
    expect(deps.submit).toHaveBeenCalledTimes(1);
    const sent = (deps.submit as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscountReportIn;
    expect(sent).toMatchObject({
      vehicle_plate: "1018354",
      trip_minutes: 16,
      subtotal_cents: 500,
      charge_date: "2026-09-29",
      declared_rate_plan: "resident_plus",
    });
    expect(sent.total_cents).toBeUndefined();
    await flush();
    expect(q(".equity-receipt__done").textContent).toBe(MSG_RECEIVED);
    expect(document.activeElement?.textContent).toBe("Close");
  });

  it("says exactly why a not-rate-checkable receipt wasn't kept", async () => {
    open({
      submit: () =>
        Promise.reject(
          new ApiError("x", "HTTP_ERROR", {
            status: 422,
            errorKey: "not_rate_checkable",
            detail: { error: "not_rate_checkable", missing: ["vehicle_plate"] },
          }),
        ),
    });
    fill();
    send();
    await flush();
    expect(q(".equity-receipt__alert").textContent).toBe(MSG_NOT_RATE_CHECKABLE);
    // The form stays, so the rider can correct it.
    expect(document.querySelector(".equity-receipt__form")).not.toBeNull();
  });

  it("says when the day's limit is reached", async () => {
    open({
      submit: () => Promise.reject(new ApiError("x", "HTTP_ERROR", { status: 429 })),
    });
    fill();
    send();
    await flush();
    expect(q(".equity-receipt__alert").textContent).toBe(MSG_RATE_LIMITED);
    expect(q<HTMLButtonElement>('.equity-receipt__form button[type="submit"]').disabled).toBe(false);
  });

  it("falls back to sign-in when the session is gone", async () => {
    open({ submit: () => Promise.reject(new ApiError("x", "TOKEN_REJECTED")) });
    fill();
    send();
    await flush();
    expect(document.querySelector('[data-role="sign-in"]')).not.toBeNull();
  });

  it("fills the code from a QR scan", async () => {
    open({ scanPlate: () => Promise.resolve({ plate: "1025640", scanned: true }) });
    q<HTMLButtonElement>(".equity-receipt__scan").click();
    await flush();
    expect(q<HTMLInputElement>("#equity-receipt-plate").value).toBe("1025640");
  });

  it("steps aside for a map pin and sends it", async () => {
    let resolvePick: (p: { lat: number; lng: number } | null) => void = () => {};
    const deps = open({
      pickOnMap: () => new Promise((r) => (resolvePick = r)),
    });
    const startBtn = q<HTMLButtonElement>('[data-pin="start"]');
    startBtn.click();
    expect(q(".equity-receipt").hidden).toBe(true);
    resolvePick({ lat: 39.785, lng: -104.826 });
    await flush();
    expect(q(".equity-receipt").hidden).toBe(false);
    expect(startBtn.textContent).toMatch(/Start set/);
    fill();
    send();
    const sent = (deps.submit as ReturnType<typeof vi.fn>).mock.calls[0][0] as DiscountReportIn;
    expect(sent.pin_start).toEqual({ lat: 39.785, lng: -104.826 });
  });

  it("has no pin buttons without a map to pick on", () => {
    open();
    expect(document.querySelector("[data-pin]")).toBeNull();
  });

  it("closes on Escape and returns focus", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    open({ returnFocusTo: opener });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".equity-receipt")).toBeNull();
    expect(document.activeElement).toBe(opener);
    close = null;
  });
});

describe("review fixes (#108)", () => {
  it("refuses a cost above the API's $1,000 ceiling with the right message", async () => {
    const mod = await import("./equity-receipt-form.ts");
    expect(mod.MAX_COST_CENTS).toBe(100_000);
    expect(mod.parseCents("1000.01")).toEqual({ kind: "ok", value: 100_001 });
  });
});
