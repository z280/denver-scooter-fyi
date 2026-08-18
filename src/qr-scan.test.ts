// @vitest-environment happy-dom
//
// qr-scan.ts: the camera QR scanner.
//
// The camera and the decoder are injected here — what is defended is the
// modal's contract, not the platform's: the raw payload is delivered
// verbatim and exactly once, the stream's tracks are stopped on every exit
// path (a camera light left on after the modal closed reads as "it's still
// recording"), and dismissal never delivers a scan.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { openQrScanner } from "./qr-scan.ts";

beforeEach(() => {
  document.body.replaceChildren();
});

function fakeStream() {
  const track = { stop: vi.fn() };
  return {
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    track,
  };
}

describe("openQrScanner", () => {
  it("delivers the decoded payload verbatim, once, and stops the camera", async () => {
    const { stream, track } = fakeStream();
    const onScan = vi.fn();
    openQrScanner({
      onScan,
      getStream: () => Promise.resolve(stream),
      decodeFrame: () => Promise.resolve("https://veo.example/q?number=1025543&x=✓"),
    });
    await vi.waitFor(() => expect(onScan).toHaveBeenCalled());
    expect(onScan).toHaveBeenCalledExactlyOnceWith(
      "https://veo.example/q?number=1025543&x=✓",
    );
    expect(track.stop).toHaveBeenCalled();
    // The scanner closed itself before delivering the payload.
    expect(document.querySelector(".qr-scan")).toBeNull();
  });

  it("keeps polling frames until one decodes", async () => {
    const { stream } = fakeStream();
    const onScan = vi.fn();
    const decodeFrame = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("payload");
    openQrScanner({
      onScan,
      getStream: () => Promise.resolve(stream),
      decodeFrame,
    });
    await vi.waitFor(() => expect(onScan).toHaveBeenCalledWith("payload"), {
      timeout: 3000,
    });
    expect(decodeFrame.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("cancelling stops the camera and never delivers a scan", async () => {
    const { stream, track } = fakeStream();
    const onScan = vi.fn();
    const onClose = vi.fn();
    openQrScanner({
      onScan,
      onClose,
      getStream: () => Promise.resolve(stream),
      // Never decodes: the rider gives up.
      decodeFrame: () => Promise.resolve(null),
    });
    await vi.waitFor(() => expect(track.stop).not.toHaveBeenCalled());
    document
      .querySelector<HTMLButtonElement>(".qr-scan__close")!
      .click();
    expect(onClose).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(onScan).not.toHaveBeenCalled();
    expect(document.querySelector(".qr-scan")).toBeNull();
  });

  it("stops a stream that arrives after the rider already closed", async () => {
    // getUserMedia's permission prompt can outlive the modal: the rider
    // cancels, THEN grants. The late stream must not stay live.
    const { stream, track } = fakeStream();
    let deliver: (s: MediaStream) => void = () => {};
    const close = openQrScanner({
      onScan: vi.fn(),
      getStream: () =>
        new Promise<MediaStream>((resolve) => {
          deliver = resolve;
        }),
    });
    close();
    deliver(stream);
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalled());
  });

  it("says so when the camera can't start", async () => {
    openQrScanner({
      onScan: vi.fn(),
      getStream: () => Promise.reject(new Error("denied")),
    });
    await vi.waitFor(() => {
      expect(document.querySelector(".qr-scan__status")?.textContent).toContain(
        "Couldn't start the camera",
      );
    });
    // Denied camera is a dead end for scanning but not a trap: the modal
    // stays up with its close button.
    expect(document.querySelector(".qr-scan__close")).not.toBeNull();
  });

  it("opens at most one scanner at a time", () => {
    const { stream } = fakeStream();
    openQrScanner({
      onScan: vi.fn(),
      getStream: () => Promise.resolve(stream),
      decodeFrame: () => Promise.resolve(null),
    });
    openQrScanner({
      onScan: vi.fn(),
      getStream: () => Promise.resolve(stream),
      decodeFrame: () => Promise.resolve(null),
    });
    expect(document.querySelectorAll(".qr-scan").length).toBe(1);
  });
});
