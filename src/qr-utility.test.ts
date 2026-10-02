// @vitest-environment happy-dom
//
// The QR tool: the dial's arithmetic, the plate extraction that mirrors the
// server's, and the modal's two outcomes. See `qr-utility.ts`'s header for why
// one scanner behind a dial rather than two buttons with a camera flow each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  QR_UTILITY_MODES,
  modeAngle,
  modeSpec,
  openQrUtility,
  plateFromQr,
  rotateMode,
  type QrUtilityDeps,
} from "./qr-utility.ts";

describe("the dial's arithmetic", () => {
  it("wraps in both directions", () => {
    // A dial that silently stops is a dial a rider keeps pushing — and with two
    // positions, clamping would make one direction dead.
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

  it("handles a delta bigger than the dial", () => {
    const n = QR_UTILITY_MODES.length;
    expect(rotateMode("features", n * 3)).toBe("features");
    expect(rotateMode("features", -n * 3 - 1)).toBe(rotateMode("features", -1));
  });

  it("spreads the positions evenly over the full circle", () => {
    const angles = QR_UTILITY_MODES.map((m) => modeAngle(m.mode));
    expect(angles[0]).toBe(0);
    expect(new Set(angles).size).toBe(QR_UTILITY_MODES.length);
    for (const a of angles) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(360);
    }
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

  it("treats a bare payload as the plate, like the server does", () => {
    // Covers a plain-text sticker, which is the fallback `qr.py`'s own header
    // says to keep until a real sticker has been checked.
    expect(plateFromQr("  1234567 ")).toBe("1234567");
  });

  it("falls back rather than failing on a malformed escape", () => {
    const got = plateFromQr("x?number=%E0%A4%A");
    expect(got).not.toBeNull();
    // One bad %-sequence must not lose the whole scan.
    expect(got).toContain("number=");
  });

  it("reads nothing out of nothing", () => {
    expect(plateFromQr("")).toBeNull();
    expect(plateFromQr("   ")).toBeNull();
  });

  it("falls through to the bare reading on an EMPTY number, exactly as the server does", () => {
    // `qr.py`'s regex is `[^&]+` too, so `number=` with nothing after it is not a
    // match there either, and its fallback is the same "treat the whole trimmed
    // payload as the plate". The result is a plate that resolves to no vehicle,
    // which the rider is told — and that beats the two sides disagreeing about
    // what a sticker says.
    expect(plateFromQr("x?number=")).toBe("x?number=");
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
  const notches = () =>
    [...root().querySelectorAll<HTMLButtonElement>(".qr-utility__notch")];
  const notch = (mode: string) =>
    notches().find((b) => b.dataset.mode === mode)!;
  const scanBtn = () =>
    root().querySelector<HTMLButtonElement>(".qr-utility__scan")!;
  const pointer = () => root().querySelector<HTMLElement>(".qr-utility__pointer")!;
  const status = () => root().querySelector<HTMLElement>(".qr-utility__status");

  it("renders one notch per mode, as a radiogroup", () => {
    open();
    expect(notches()).toHaveLength(QR_UTILITY_MODES.length);
    const dial = root().querySelector(".qr-utility__dial")!;
    expect(dial.getAttribute("role")).toBe("radiogroup");
    for (const b of notches()) expect(b.getAttribute("role")).toBe("radio");
  });

  it("names each notch for assistive tech — a glyph is not a label", () => {
    open();
    for (const spec of QR_UTILITY_MODES) {
      expect(notch(spec.mode).getAttribute("aria-label")).toBe(spec.label);
    }
  });

  it("starts on the first mode, and says what it will do", () => {
    open();
    const first = QR_UTILITY_MODES[0];
    expect(notch(first.mode).getAttribute("aria-checked")).toBe("true");
    expect(root().textContent).toContain(first.label);
    expect(root().textContent).toContain(first.detail);
  });

  it("can be opened on a chosen mode", () => {
    open({ initialMode: "ride" });
    expect(notch("ride").getAttribute("aria-checked")).toBe("true");
  });

  it("turns to a tapped notch, pointer and all", () => {
    open();
    notch("ride").click();
    expect(notch("ride").getAttribute("aria-checked")).toBe("true");
    expect(notch("features").getAttribute("aria-checked")).toBe("false");
    // The pointer's direction IS the readout — the only reason a dial beats a
    // list.
    expect(pointer().style.transform).toBe(`rotate(${modeAngle("ride")}deg)`);
    expect(root().textContent).toContain(modeSpec("ride").detail);
  });

  it("turns on the arrow keys, in both directions", () => {
    open();
    const press = (key: string) =>
      notches()
        .find((b) => b.getAttribute("aria-checked") === "true")!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    press("ArrowRight");
    expect(notch("ride").getAttribute("aria-checked")).toBe("true");
    press("ArrowLeft");
    expect(notch("features").getAttribute("aria-checked")).toBe("true");
    // Up/down work too — a dial has no one axis.
    press("ArrowDown");
    expect(notch("ride").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps only the chosen notch in the tab order", () => {
    open();
    expect(notch("features").tabIndex).toBe(0);
    expect(notch("ride").tabIndex).toBe(-1);
    notch("ride").click();
    expect(notch("ride").tabIndex).toBe(0);
    expect(notch("features").tabIndex).toBe(-1);
  });

  it("features mode hands the RAW payload on and gets out of the way", () => {
    const { onConfirmFeatures, onRideScan } = open();
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

  it("drops a previous answer when the dial turns", async () => {
    open({ initialMode: "ride", onRideScan: async () => "an old answer" });
    scanBtn().click();
    await vi.waitFor(() => expect(status()?.textContent).toBe("an old answer"));
    notch("features").click();
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
    // and the mode they dialled in.
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
