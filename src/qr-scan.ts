// Camera QR scanner — the shared "point your phone at the sticker" surface.
//
// One job: open the camera, watch frames until a QR code decodes, hand the
// RAW payload string to the caller, close. No parsing, no validation, no
// opinion about what the payload means — the server owns all of that
// (scooter-fyi-api src/qr.py), for the same reason the features modal never
// validates the typed plate: a client-side rule is two deploys away from
// disagreeing with the server's, and the raw payload is exactly what the
// API wants logged.
//
// Decoding prefers the platform's own BarcodeDetector (hardware-assisted on
// most phones, and Chrome/Android has shipped it for years) and falls back
// to jsQR — a pure-JS decoder — everywhere else (iOS Safari has no
// BarcodeDetector). Both run against the same <video> element on a ~5/sec
// cadence: fast enough to feel instant, slow enough that the fallback's
// full-frame scan doesn't cook a phone.
//
// House rules, as everywhere else: `document.createElement` only, a
// `cleanupFns[]` teardown list, and a real focus trap.

import jsQR from "jsqr";
import { trapFocusWithin } from "./modal-focus-trap.ts";

// BarcodeDetector isn't in TypeScript's DOM lib yet; declare the sliver we
// use rather than pulling in a types package for one class.
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options?: {
      formats?: string[];
    }) => BarcodeDetectorLike;
  }
}

const ROOT_CLASS = "qr-scan";
const FRAME_INTERVAL_MS = 200;

export interface QrScannerOptions {
  /** One line above the viewfinder saying what the scan is for. */
  prompt?: string;
  /** Fires once, with the raw decoded payload, after the scanner has shut
   *  the camera down and closed. */
  onScan(rawValue: string): void;
  /** Fires on every dismissal — cancel AND successful scan alike (the
   *  scanner closes itself before delivering onScan). "Did they scan?" is
   *  answered by whether onScan fired, not by this. */
  onClose?(): void;
  /** Injected for tests; defaults to the rear camera via getUserMedia. */
  getStream?(): Promise<MediaStream>;
  /** Injected for tests; defaults to BarcodeDetector-else-jsQR. */
  decodeFrame?(video: HTMLVideoElement): Promise<string | null>;
}

/** Same one-at-a-time rule (and the same orphaned-handler reasoning) as
 *  `device-features.ts`'s modal. */
let activeClose: (() => void) | null = null;

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

function defaultGetStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error("camera unsupported"));
  }
  // facingMode is a preference, not a requirement — a laptop with only a
  // front camera still gets a working scanner rather than a refusal.
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
}

function makeDefaultDecoder(): (video: HTMLVideoElement) => Promise<string | null> {
  const Detector = window.BarcodeDetector;
  if (Detector) {
    const detector = new Detector({ formats: ["qr_code"] });
    return async (video) => {
      const codes = await detector.detect(video);
      return codes[0]?.rawValue || null;
    };
  }
  // jsQR path: sample the frame through a canvas. The canvas is reused
  // across frames — allocating a fresh backing store five times a second
  // is exactly the kind of churn a mid-ride phone doesn't need.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!ctx || !w || !h) return null;
    // Resizing reallocates the backing store and resets context state, so
    // only do it when the stream's dimensions actually changed (camera
    // switch, orientation flip) — not five times a second.
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    const code = jsQR(image.data, w, h);
    return code?.data || null;
  };
}

/** Open the scanner. Returns a close function; at most one is open at a
 *  time, layered above whatever modal launched it. */
export function openQrScanner(options: QrScannerOptions): () => void {
  activeClose?.();
  document.querySelector(`.${ROOT_CLASS}`)?.remove();

  const cleanupFns: (() => void)[] = [];
  let closed = false;
  let scanned = false;

  const backdrop = el("div", ROOT_CLASS);
  const card = el("div", `${ROOT_CLASS}__card`);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "qr-scan-title");

  const head = el("div", `${ROOT_CLASS}__head`);
  const title = el("h3", undefined, "📷 Scan the QR code");
  title.id = "qr-scan-title";
  const closeBtn = el("button", `${ROOT_CLASS}__close`, "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close scanner");
  head.append(title, closeBtn);

  const promptLine = el(
    "p",
    `${ROOT_CLASS}__prompt`,
    options.prompt ?? "Point your camera at the QR code on the scooter's deck.",
  );

  const viewport = el("div", `${ROOT_CLASS}__viewport`);
  const video = el("video", `${ROOT_CLASS}__video`);
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("aria-label", "Camera viewfinder");
  viewport.append(video, el("div", `${ROOT_CLASS}__reticle`));

  const status = el("p", `${ROOT_CLASS}__status`);
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  card.append(head, promptLine, viewport, status);
  backdrop.append(card);

  function close(): void {
    if (closed) return;
    closed = true;
    if (activeClose === close) activeClose = null;
    for (const fn of cleanupFns.splice(0)) fn();
    backdrop.remove();
    options.onClose?.();
  }

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  cleanupFns.push(() => document.removeEventListener("keydown", onKey));

  document.body.appendChild(backdrop);
  cleanupFns.push(trapFocusWithin(card, () => !closed));
  activeClose = close;

  const decode = options.decodeFrame ?? makeDefaultDecoder();

  void (options.getStream ?? defaultGetStream)()
    .then((stream) => {
      if (closed) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      cleanupFns.push(() => {
        for (const track of stream.getTracks()) track.stop();
      });
      // Both guarded: a non-starting preview must not kill the frame loop
      // (an injected decoder in tests — or a future capture path — may not
      // need the <video> at all, and a real failure surfaces as the loop
      // simply never seeing a frame).
      try {
        video.srcObject = stream;
        void Promise.resolve(video.play()).catch(() => {});
      } catch {
        /* see above */
      }

      // Recursive setTimeout rather than setInterval so a slow decode
      // (jsQR on a big frame) can't stack calls behind itself. One shared
      // timer id, registered for cleanup ONCE — only one tick is ever
      // pending, and pushing a fresh closure per frame would grow
      // cleanupFns by ~5 entries a second for as long as the rider aims.
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      cleanupFns.push(() => clearTimeout(pollTimer));
      const tick = (): void => {
        if (closed || scanned) return;
        void decode(video)
          .catch(() => null)
          .then((raw) => {
            if (closed || scanned) return;
            if (raw) {
              scanned = true;
              // Stop the camera the instant we have a payload — holding
              // the light on through the caller's next screen reads as
              // "it's still recording".
              close();
              options.onScan(raw);
              return;
            }
            pollTimer = setTimeout(tick, FRAME_INTERVAL_MS);
          });
      };
      tick();
    })
    .catch(() => {
      if (closed) return;
      status.textContent =
        "Couldn't start the camera — check that this site is allowed to use it, then try again.";
    });

  return close;
}
