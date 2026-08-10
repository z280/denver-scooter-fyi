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
// most phones, and Chrome/Android has shipped it for years), then a
// lazily-loaded zxing-cpp wasm decoder (`qr-zxing.ts`) everywhere else —
// iOS Safari has no BarcodeDetector, and zxing reads the glossy, worn,
// off-angle stickers that pure-JS jsQR gives up on. jsQR stays as the last
// resort for when the wasm chunk itself fails to arrive. All three decode
// the same center-cropped frame on a ~5/sec cadence.
//
// Three lessons from field testing on an iPhone 14 Pro Max are baked in:
// getUserMedia defaults to 640×480 unless you ask for more (a sticker at
// arm's length spans too few pixels to decode), the decoder should see the
// square region the viewfinder shows rather than the whole frame, and the
// phone's main camera cannot focus closer than ~20cm — hence the resolution
// constraints, the center crop, and the pull-back hint below.
//
// House rules, as everywhere else: `document.createElement` only, a
// `cleanupFns[]` teardown list, and a real focus trap.

import jsQR from "jsqr";
import { trapFocusWithin } from "./modal-focus-trap.ts";
import type { QrDetector } from "./qr-zxing.ts";

// BarcodeDetector isn't in TypeScript's DOM lib yet; declare the sliver we
// use rather than pulling in a types package for one class.
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => QrDetector;
  }
}

const ROOT_CLASS = "qr-scan";
const FRAME_INTERVAL_MS = 200;
/** Decode-canvas cap. A 1080p center crop downscaled to this loses nothing
 *  a sticker-sized code needs, and keeps zxing/jsQR under the frame
 *  budget on older phones. */
const MAX_DECODE_SIDE = 1024;

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
  // Every constraint here is an `ideal` preference, not a requirement — a
  // laptop with only a low-res front camera still gets a working scanner
  // rather than a refusal. The resolution ask is the important one:
  // without it browsers hand back 640×480, and a deck sticker at arm's
  // length spans too few of those pixels for any decoder to read.
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
}

function makeDefaultDecoder(): (video: HTMLVideoElement) => Promise<string | null> {
  // Native where the platform has it; the zxing wasm chunk otherwise —
  // resolved once, and a failed load resolves to null so every later
  // frame drops straight to jsQR instead of re-fetching a chunk that
  // isn't coming.
  const Native = window.BarcodeDetector;
  const detectorPromise: Promise<QrDetector | null> = Native
    ? Promise.resolve(new Native({ formats: ["qr_code"] }))
    : import("./qr-zxing.ts")
        .then((m) => m.createZxingDetector())
        .catch(() => null);

  // Every decoder reads the same reused canvas: the CENTER SQUARE of the
  // frame — which is what the square viewfinder actually shows under
  // object-fit: cover, so it is where the rider has been told to put the
  // code — downscaled to a cap. Cropping concentrates the decoder's work
  // on the pixels the rider is aiming, and the reuse avoids reallocating
  // a backing store five times a second.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!ctx || !vw || !vh) return null;
    const side = Math.min(vw, vh);
    const target = Math.min(side, MAX_DECODE_SIDE);
    // Resizing reallocates the buffer and resets context state, so only on
    // a real dimension change (camera switch, orientation flip).
    if (canvas.width !== target) canvas.width = target;
    if (canvas.height !== target) canvas.height = target;
    ctx.drawImage(
      video,
      (vw - side) / 2,
      (vh - side) / 2,
      side,
      side,
      0,
      0,
      target,
      target,
    );
    const detector = await detectorPromise;
    if (detector) {
      try {
        const codes = await detector.detect(canvas);
        return codes[0]?.rawValue || null;
      } catch {
        /* a mid-stream detector failure falls through to jsQR below */
      }
    }
    const image = ctx.getImageData(0, 0, target, target);
    const code = jsQR(image.data, target, target);
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

  // Always shown, because it is the fix for the most common real-world
  // failure: phone main cameras can't focus closer than ~20cm (the iPhone
  // 14 Pro's is worse than most), and the instinctive move — closer! — is
  // exactly wrong.
  const focusHint = el(
    "p",
    `${ROOT_CLASS}__hint`,
    "Blurry? Pull back a few inches — phone cameras can't focus up close.",
  );

  card.append(head, promptLine, viewport, focusHint, status);
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

      // Camera niceties, both best-effort and both non-standard enough to
      // be absent from TS's lib and from most test doubles — hence the
      // optional chaining and casts. Continuous autofocus stops the lens
      // hunting at sticker distance; the torch button only appears when
      // the track says it has one (glare and shade are real on a street).
      const track = stream.getVideoTracks?.()[0];
      const caps = track?.getCapabilities?.() as
        | (MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] })
        | undefined;
      if (caps?.focusMode?.includes("continuous")) {
        void track
          ?.applyConstraints({
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          })
          .catch(() => {});
      }
      if (caps?.torch) {
        let torchOn = false;
        const torchBtn = el("button", `${ROOT_CLASS}__torch`, "🔦");
        torchBtn.type = "button";
        torchBtn.setAttribute("aria-label", "Toggle flashlight");
        torchBtn.setAttribute("aria-pressed", "false");
        torchBtn.addEventListener("click", () => {
          torchOn = !torchOn;
          torchBtn.setAttribute("aria-pressed", torchOn ? "true" : "false");
          torchBtn.classList.toggle("is-on", torchOn);
          void track
            ?.applyConstraints({
              advanced: [{ torch: torchOn } as MediaTrackConstraintSet],
            })
            .catch(() => {});
        });
        viewport.append(torchBtn);
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
