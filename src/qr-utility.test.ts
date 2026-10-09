// @vitest-environment happy-dom
//
// The QR tool: the mode switch, the plate extraction that mirrors the server's,
// and the modal's two outcomes. See `qr-utility.ts`'s header for why one
// scanner behind a mode switch rather than two buttons with a camera flow each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  QR_UTILITY_MODES,
  modeSpec,
  openQrUtility,
  plateFromQr,
  rotateMode,
  wireQrUtility,
  type QrUtilityDeps,
} from "./qr-utility.ts";

describe("the mode switch's arithmetic", () => {
  it("wraps in both directions", () => {
    // Unordered jobs, not a scale: there is no "off the end" to protect, and
    // with two positions clamping would make one arrow direction dead.
    const first = QR_UTILITY_MODES[0].mode;
    const last = QR_UTILITY_MODES[QR_UTILITY_MODES.length - 1].mode;
    expect(rotateMode(last, 1)).toBe(first);
    expect(rotateMode(first, -1)).toBe(last);
  });

  it("walks every position and comes back", () => {
    let m = QR_UTILITY_MODES[0].mode;
    for (let i = 0; i < QR_UTILITY_MODES.length; i += 1) m = rotateMode(m, 1);
    expect(m).toBe(QR_UTILITY_MODES[0].mode);
  });

  it("handles a delta bigger than the switch", () => {
    const n = QR_UTILITY_MODES.length;
    expect(rotateMode("features", n * 3)).toBe("features");
    expect(rotateMode("features", -n * 3 - 1)).toBe(rotateMode("features", -1));
  });

  it("gives every mode a short label and a sentence saying what it does", () => {
    for (const spec of QR_UTILITY_MODES) {
      expect(spec.label.split(/\s+/).length).toBeLessThanOrEqual(2);
      expect(spec.detail.length).toBeGreaterThan(20);
      expect(spec.glyph.length).toBeGreaterThan(0);
      expect(modeSpec(spec.mode)).toBe(spec);
    }
  });
});

describe("plateFromQr", () => {
  it("reads the number parameter out of a rental deep link", () => {
    expect(
      plateFromQr("https://veoride.go.link/?adj_t=abc&number=1234567"),
    ).toBe("1234567");
    // Mirrors the server's own regex, which does not care where in the query it
    // sits.
    expect(plateFromQr("veo://ride?number=42&adj_t=x")).toBe("42");
  });

  it("percent-decodes it", () => {
    expect(plateFromQr("x?number=12%2D34")).toBe("12-34");
  });

  it("reads a malformed escape as not-a-plate rather than as the whole payload", () => {
    // A bad %-sequence falls through to the bare reading, and the bare reading
    // now refuses anything that is not digits — so this is `unreadable`, which
    // is the truthful answer. Previously it came back as the plate
    // "x?number=%E0%A4%A" and the rider was told that plate was not in the
    // fleet.
    expect(plateFromQr("x?number=%E0%A4%A")).toBeNull();
  });

  it("reads nothing out of nothing", () => {
    expect(plateFromQr("")).toBeNull();
    expect(plateFromQr("   ")).toBeNull();
  });

  it("reads an EMPTY number as not-a-plate", () => {
    // `qr.py`'s regex is `[^&]+` too, so `number=` with nothing after it is not
    // a match there either and it falls through the same way. The server's
    // fallback can afford to be loose because it hashes the result and
    // compares; this one composes a sentence, so it refuses to call a URL a
    // plate.
    expect(plateFromQr("x?number=")).toBeNull();
  });

  it("refuses every QR code that is not a scooter sticker", () => {
    // THE CASE THAT MOTIVATED THE STRICTNESS. With the loose fallback these all
    // came back as "plates", which made `qr-ride-scan.ts`'s `unreadable` branch
    // unreachable and told the rider that a wifi password was not in the live
    // fleet.
    for (const payload of [
      "WIFI:S:MyNetwork;T:WPA;P:hunter2;;",
      "https://example.com/some/page",
      "BEGIN:VCARD\nFN:A Person\nEND:VCARD",
      "mailto:someone@example.com",
      "not a plate at all",
    ]) {
      expect(plateFromQr(payload)).toBeNull();
    }
  });

  it("still accepts a plain-text plate sticker, which is what the fallback is for", () => {
    expect(plateFromQr("1234567")).toBe("1234567");
    expect(plateFromQr("  1234567 ")).toBe("1234567");
    // Loose on length — plate length is Veo's to change — strict on shape.
    expect(plateFromQr("425")).toBe("425");
    expect(plateFromQr("123456789012")).toBe("123456789012");
    expect(plateFromQr("12")).toBeNull();
    expect(plateFromQr("1234567890123")).toBeNull();
  });

  it("takes a `number=` parameter at its word, whatever shape it is", () => {
    // An explicit parameter is a claim about which vehicle this is, so it is
    // not second-guessed. Only the GUESS has to be careful — and this is also
    // what keeps us from refusing an alphanumeric plate if Veo ever ships one
    // through the deep link.
    expect(plateFromQr("veo://ride?number=AB-12")).toBe("AB-12");
  });
});

describe("the modal", () => {
  let close: (() => void) | null = null;

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    close?.();
    close = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  /** A scanner stub that hands back a payload when the rider taps Scan. */
  function fakeScan(payload: string) {
    const scan = vi.fn(((options: { onScan(v: string): void }) => {
      options.onScan(payload);
      return () => {};
    }) as unknown as NonNullable<QrUtilityDeps["scan"]>);
    return scan;
  }

  function open(over: Partial<QrUtilityDeps> = {}) {
    const onConfirmFeatures = vi.fn();
    const onRideScan = vi.fn(async () => "done");
    close = openQrUtility({
      onConfirmFeatures,
      onRideScan,
      scan: fakeScan("x?number=1234567"),
      ...over,
    });
    return { onConfirmFeatures, onRideScan };
  }

  const root = () => document.querySelector<HTMLElement>(".qr-utility")!;
  const segments = () =>
    [...root().querySelectorAll<HTMLButtonElement>(".qr-utility__mode")];
  const segment = (mode: string) =>
    segments().find((b) => b.dataset.mode === mode)!;
  const scanBtn = () =>
    root().querySelector<HTMLButtonElement>(".qr-utility__scan")!;
  const status = () => root().querySelector<HTMLElement>(".qr-utility__status");

  it("renders one segment per mode, as a radiogroup", () => {
    open();
    expect(segments()).toHaveLength(QR_UTILITY_MODES.length);
    const group = root().querySelector(".qr-utility__modes")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    for (const b of segments()) expect(b.getAttribute("role")).toBe("radio");
  });

  it("names each segment in text, with the glyph marked decorative", () => {
    // The word is the label now that it is on screen beside the glyph, so a
    // screen reader should say "Ride mode", not "compass, Ride mode".
    open();
    for (const spec of QR_UTILITY_MODES) {
      const btn = segment(spec.mode);
      expect(btn.textContent).toContain(spec.label);
      expect(
        btn.querySelector(".qr-utility__mode-glyph")!.getAttribute("aria-hidden"),
      ).toBe("true");
    }
  });

  it("points the selected segment at the sentence that explains it", () => {
    // A radio announces its own label and nothing else, so the detail below
    // the switch has to be attached deliberately or it is never read out.
    open({ initialMode: "features" });
    const detail = root().querySelector(".qr-utility__mode-detail")!;
    expect(detail.id).toBeTruthy();
    expect(segment("features").getAttribute("aria-describedby")).toBe(detail.id);
    // Only the selected one: the unselected description is not about anything
    // the rider has chosen.
    expect(segment("ride").getAttribute("aria-describedby")).toBeNull();
  });

  it("starts on the first mode, and says what it will do", () => {
    open();
    const first = QR_UTILITY_MODES[0];
    expect(segment(first.mode).getAttribute("aria-checked")).toBe("true");
    expect(root().textContent).toContain(first.label);
    expect(root().textContent).toContain(first.detail);
  });

  it("can be opened on a chosen mode", () => {
    open({ initialMode: "ride" });
    expect(segment("ride").getAttribute("aria-checked")).toBe("true");
  });

  it("moves to a tapped segment, and rewrites the explanation with it", () => {
    open();
    segment("ride").click();
    expect(segment("ride").getAttribute("aria-checked")).toBe("true");
    expect(segment("features").getAttribute("aria-checked")).toBe("false");
    expect(segment("ride").classList.contains("is-active")).toBe(true);
    expect(root().textContent).toContain(modeSpec("ride").detail);
    expect(root().textContent).not.toContain(modeSpec("features").detail);
  });

  it("moves on the arrow keys, in both axes", () => {
    open({ initialMode: "features" });
    const press = (key: string) =>
      segments()
        .find((b) => b.getAttribute("aria-checked") === "true")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
    press("ArrowRight");
    expect(segment("ride").getAttribute("aria-checked")).toBe("true");
    press("ArrowLeft");
    expect(segment("features").getAttribute("aria-checked")).toBe("true");
    // Up/down as well — a thumb that swipes has no one axis in mind.
    press("ArrowDown");
    expect(segment("ride").getAttribute("aria-checked")).toBe("true");
    press("Home");
    expect(segment(QR_UTILITY_MODES[0].mode).getAttribute("aria-checked")).toBe("true");
    press("End");
    expect(
      segment(QR_UTILITY_MODES[QR_UTILITY_MODES.length - 1].mode)
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps focus on the switch when a keystroke rebuilds it", () => {
    // Selecting re-renders the body, which destroys the focused button. Lose
    // focus here and one arrow press drops a keyboard rider onto <body>.
    open();
    segment("features").focus();
    segment("features").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(segment("ride"));
  });

  it("keeps only the chosen segment in the tab order", () => {
    open({ initialMode: "features" });
    expect(segment("features").tabIndex).toBe(0);
    expect(segment("ride").tabIndex).toBe(-1);
    segment("ride").click();
    expect(segment("ride").tabIndex).toBe(0);
    expect(segment("features").tabIndex).toBe(-1);
  });

  it("features mode hands the RAW payload on and gets out of the way", () => {
    const { onConfirmFeatures, onRideScan } = open({ initialMode: "features" });
    scanBtn().click();
    // Two stacked dialogs is one too many: it closes before handing off.
    expect(document.querySelector(".qr-utility")).toBeNull();
    expect(onConfirmFeatures).toHaveBeenCalledWith("x?number=1234567");
    expect(onRideScan).not.toHaveBeenCalled();
  });

  it("ride mode asks the caller and shows what it says", async () => {
    const onRideScan = vi.fn(async () => "Got it — your ride is on Lunar 🐸 928.");
    open({ initialMode: "ride", onRideScan });
    scanBtn().click();
    expect(onRideScan).toHaveBeenCalledWith("x?number=1234567");
    await vi.waitFor(() => expect(status()?.textContent).toContain("Lunar 🐸 928"));
    // Stays open: the sentence is the outcome, and closing would take it away.
    expect(document.querySelector(".qr-utility")).not.toBeNull();
  });

  it("blocks a second scan while the first is still being answered", async () => {
    let release: (v: string) => void = () => {};
    const onRideScan = vi.fn(
      () => new Promise<string>((r) => { release = r; }),
    );
    open({ initialMode: "ride", onRideScan });
    scanBtn().click();
    expect(scanBtn().disabled).toBe(true);
    release("done");
    await vi.waitFor(() => expect(scanBtn().disabled).toBe(false));
  });

  it("says something even when the caller rejects", async () => {
    const onRideScan = vi.fn(() => Promise.reject(new Error("boom")));
    open({ initialMode: "ride", onRideScan });
    scanBtn().click();
    await vi.waitFor(() =>
      expect(status()?.textContent).toMatch(/try scanning again/i),
    );
    expect(scanBtn().disabled).toBe(false);
  });

  it("drops a previous answer when the mode changes", async () => {
    open({ initialMode: "ride", onRideScan: async () => "an old answer" });
    scanBtn().click();
    await vi.waitFor(() => expect(status()?.textContent).toBe("an old answer"));
    segment("features").click();
    // The last mode's answer is no longer about anything.
    expect(status()).toBeNull();
  });

  it("tells the scanner what the scan is for", () => {
    const scan = fakeScan("x?number=1");
    open({ initialMode: "ride", scan });
    scanBtn().click();
    const prompt = (scan.mock.calls[0][0] as { prompt?: string }).prompt ?? "";
    expect(prompt).toMatch(/riding/i);
  });

  it("leaves Escape to the scanner while the camera is up", () => {
    // Both listeners are on `document`, so stopPropagation cannot separate
    // them — a rider backing out of the camera must not lose the tool behind it,
    // and the mode they selected.
    const scanner = document.createElement("div");
    scanner.className = "qr-scan";
    open();
    document.body.append(scanner);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".qr-utility")).not.toBeNull();

    scanner.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".qr-utility")).toBeNull();
  });

  it("closes on Escape and on the ✕", () => {
    open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".qr-utility")).toBeNull();

    open();
    root().querySelector<HTMLButtonElement>(".qr-utility__close")!.click();
    expect(document.querySelector(".qr-utility")).toBeNull();
  });

  it("only ever has one open", () => {
    open();
    open();
    expect(document.querySelectorAll(".qr-utility")).toHaveLength(1);
  });

  it("reports the close to the caller, once", () => {
    const onClose = vi.fn();
    close = openQrUtility({
      onConfirmFeatures: () => {},
      onRideScan: async () => "",
      scan: fakeScan("x"),
      onClose,
    });
    close();
    close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The wiring boundary. House rule, `docs/ALONG_THE_WAY_PLAN.md`: a new surface
// is a new module wired by one `wireX()` call, and `main.ts` does not grow —
// so which element opens this tool is this module's business, not the
// integrator's.
// ---------------------------------------------------------------------------

describe("wireQrUtility", () => {
  it("opens the tool on the button it was given, with both modes wired", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const open = vi.fn((_deps: QrUtilityDeps) => () => {});
    const onConfirmFeatures = vi.fn();
    const onRideScan = vi.fn(async () => "ok");

    wireQrUtility({ button, onConfirmFeatures, onRideScan, open });
    button.click();

    expect(open).toHaveBeenCalledTimes(1);
    const deps = open.mock.calls[0][0];
    // Passed through, not re-wrapped: the switch's two positions are the app's
    // to answer and this boundary must not become a second place that decides.
    deps.onConfirmFeatures("raw");
    void deps.onRideScan("raw");
    expect(onConfirmFeatures).toHaveBeenCalledWith("raw");
    expect(onRideScan).toHaveBeenCalledWith("raw");
  });

  it("hands back a teardown that really detaches", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const open = vi.fn((_deps: QrUtilityDeps) => () => {});
    const off = wireQrUtility({
      button,
      onConfirmFeatures: vi.fn(),
      onRideScan: vi.fn(async () => "ok"),
      open,
    });
    off();
    button.click();
    expect(open).not.toHaveBeenCalled();
  });
});
