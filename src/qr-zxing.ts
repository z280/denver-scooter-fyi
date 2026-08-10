// The zxing-cpp (wasm) QR decoder, wrapped in the W3C BarcodeDetector shape.
//
// Split out of qr-scan.ts and loaded with a dynamic import on purpose:
// browsers with a native BarcodeDetector (Chrome/Android — hardware-assisted)
// never pay for this chunk, and everyone else (iOS Safari, desktop Safari,
// Firefox) only fetches it when the scanner actually opens. The wasm binary
// itself is lazier still — the ponyfill fetches it on first detect().
//
// The locateFile override is load-bearing: barcode-detector's default is to
// fetch the wasm from a CDN, and this app ships no third-party requests
// (README, "On tracking"). Importing the binary `?url` makes Vite bundle it
// as a same-origin hashed asset instead.

import {
  BarcodeDetector as ZxingBarcodeDetector,
  prepareZXingModule,
} from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

/** The sliver of the BarcodeDetector API qr-scan.ts consumes. */
export interface QrDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

export function createZxingDetector(): QrDetector {
  return new ZxingBarcodeDetector({ formats: ["qr_code"] }) as QrDetector;
}
