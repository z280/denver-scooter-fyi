// The QR tool — one scan, two jobs, and a dial that says which.
//
// WHY A DIAL AND NOT TWO BUTTONS. The two jobs ask for the same thing (point
// the camera at the sticker) and differ only in what happens next, so two
// buttons would be two camera flows to keep in step and two places for the
// scan's failure sentences to drift apart. One scanner, one mode selector in
// front of it, and the mode decides the outcome. It also leaves room: a third
// job added here is a label on the dial, not a third flow.
//
// WHAT THE SCAN IS. The raw payload, verbatim, exactly as `qr-scan.ts`'s header
// insists — this module parses nothing it does not have to.
//
// It has to parse one thing. Mode `ride` needs to know WHICH vehicle before it
// can touch the ride session, and the server-side identifier is a salted hash a
// browser cannot compute. So the plate comes out of the payload here (the same
// `&number=` parameter the API's own `extract_plate` reads, with the same
// treat-the-whole-payload fallback) and is reverse-resolved against the live
// device feed — `ride-deeplink.ts`'s `reversePlateLookup`, the index this app
// already builds. Mode `features` parses nothing: the server resolves the scan
// itself (`qr_raw_value` on the feature report), which is why that mode works
// for a scooter missing from the feed and this one does not.

import { isQrScannerOpen, openQrScanner } from "./qr-scan.ts";
import { trapFocusWithin } from "./modal-focus-trap.ts";

// ---------------------------------------------------------------------------
// The modes
// ---------------------------------------------------------------------------

export type QrUtilityMode = "features" | "ride";

export interface QrUtilityModeSpec {
  mode: QrUtilityMode;
  glyph: string;
  /** On the dial. Two words at most — it is read at a glance on a phone. */
  label: string;
  /** Under the dial, saying what the scan will do. */
  detail: string;
}

/** Dial order is deliberate: Confirm Features first because it is the one a
 *  rider does standing still with nothing else in flight, and the ride mode
 *  second because what it does depends on a session the rider already has. */
export const QR_UTILITY_MODES: readonly QrUtilityModeSpec[] = [
  {
    mode: "features",
    glyph: "☑️",
    label: "Confirm features",
    detail:
      "Tell us what's bolted to this scooter — a bell, a cup holder, a phone holder, a basket — and whether they work.",
  },
  {
    mode: "ride",
    glyph: "🧭",
    label: "Ride mode",
    detail:
      "Start a ride on this scooter, pick up a ride you were setting up, or tell a ride you already started which scooter it's on.",
  },
];

export function modeSpec(mode: QrUtilityMode): QrUtilityModeSpec {
  return QR_UTILITY_MODES.find((m) => m.mode === mode) ?? QR_UTILITY_MODES[0];
}

/** Turn the dial by `delta` positions, wrapping. Wrapping rather than clamping
 *  because a dial that silently stops is a dial a rider keeps pushing — and
 *  with two positions, clamping would make one of the two directions dead. */
export function rotateMode(
  current: QrUtilityMode,
  delta: number,
): QrUtilityMode {
  const i = QR_UTILITY_MODES.findIndex((m) => m.mode === current);
  const from = i === -1 ? 0 : i;
  const n = QR_UTILITY_MODES.length;
  const next = (((from + delta) % n) + n) % n;
  return QR_UTILITY_MODES[next].mode;
}

/** The angle the dial's pointer sits at for a mode, in degrees clockwise from
 *  straight up. Positions are spread evenly over the full circle so the
 *  pointer's direction is itself the readout. Pure, so the geometry is
 *  assertable without a DOM. */
export function modeAngle(mode: QrUtilityMode): number {
  const i = QR_UTILITY_MODES.findIndex((m) => m.mode === mode);
  const at = i === -1 ? 0 : i;
  return (360 / QR_UTILITY_MODES.length) * at;
}

// ---------------------------------------------------------------------------
// Plate extraction — mirrors the server, on purpose
// ---------------------------------------------------------------------------

/** The same parameter the API's `qr.py` `extract_plate` reads, with a
 *  deliberately STRICTER bare-payload fallback.
 *
 *  THIS IS A COPY OF A SERVER RULE, which the repo normally refuses to make.
 *  It is allowed here for one reason: nothing is DECIDED by it. The plate is
 *  used to look a vehicle up in a feed the client already has, and a wrong
 *  guess resolves to nothing and says so. Mode `features` — the one where a
 *  scan is evidence rather than a lookup key — still sends the raw payload and
 *  lets the server extract it, so the rule that matters still has one owner.
 *
 *  WHERE IT DIVERGES, AND WHY IT HAS TO. `qr.py`'s fallback is "no `number=`?
 *  treat the whole trimmed payload as the plate", and that is right there: the
 *  server hashes the result and compares, so a payload that is not a plate
 *  simply fails to match. Here the result is a SENTENCE. Returning the whole
 *  payload made `qr-ride-scan.ts`'s `unreadable` branch unreachable — every
 *  wifi credential, URL and contact card came back as a plate nobody could
 *  place, and the rider was told "Plate WIFI:S:MyNetwork;… isn't in the live
 *  fleet right now" when the truthful answer is that they scanned the wrong
 *  sticker.
 *
 *  So the bare fallback accepts only what could be a plate: digits, and a
 *  plausible number of them. Every observed Veo plate is all-digit — the same
 *  observation `ride-keypad.ts` is built on, and the reason the plate field
 *  carries `inputmode="numeric"`. If Veo ever ships an alphanumeric plate this
 *  loosens here, in one place, with the keypad. */
const NUMBER_RE = /[?&]number=([^&]+)/;
/** A bare payload is only a plate if it looks like one. Loose on length
 *  because plate length is Veo's to change and 7 digits is merely what we see
 *  today; strict on shape because that is what separates a sticker from a URL. */
const BARE_PLATE_RE = /^[0-9]{3,12}$/;

export function plateFromQr(rawValue: string): string | null {
  const m = NUMBER_RE.exec(rawValue);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[1]).trim();
      // A `number=` parameter is an explicit claim about which vehicle this
      // is, so whatever it holds is taken as the plate — shape and all. Only
      // the GUESS below has to be careful.
      return decoded === "" ? null : decoded;
    } catch {
      // One malformed %-sequence: fall through to the bare-payload reading
      // rather than failing the whole scan.
    }
  }
  const stripped = rawValue.trim();
  return BARE_PLATE_RE.test(stripped) ? stripped : null;
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export interface QrUtilityDeps {
  /** The mode the dial starts on. Defaults to the first. */
  initialMode?: QrUtilityMode;
  /** A scan landed in `features` mode: hand the raw payload to the Confirm
   *  Features flow, which sends it on and lets the server resolve the vehicle. */
  onConfirmFeatures(rawValue: string): void;
  /** A scan landed in `ride` mode. Resolves to the sentence to show the rider —
   *  what happened, or why nothing could. Resolving rather than throwing,
   *  because every outcome here is something to say rather than an error. */
  onRideScan(rawValue: string): Promise<string>;
  /** Injected for tests; defaults to the real camera scanner. */
  scan?: typeof openQrScanner;
  onClose?(): void;
}

const ROOT_CLASS = "qr-utility";

/** Same one-at-a-time rule, and the same reasoning about orphaned document
 *  handlers, as `device-features.ts`'s modal and `qr-scan.ts`'s own. */
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

/** Open the QR tool. Returns a close function. */
export function openQrUtility(deps: QrUtilityDeps): () => void {
  activeClose?.();
  document.querySelector(`.${ROOT_CLASS}`)?.remove();

  let mode: QrUtilityMode = deps.initialMode ?? QR_UTILITY_MODES[0].mode;
  let closed = false;
  let busy = false;
  let status: string | null = null;
  const cleanupFns: (() => void)[] = [];

  const backdrop = el("div", ROOT_CLASS);
  const card = el("div", `${ROOT_CLASS}__card`);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", `${ROOT_CLASS}-title`);

  const head = el("div", `${ROOT_CLASS}__head`);
  const title = el("h3", undefined, "Scan a scooter");
  title.id = `${ROOT_CLASS}-title`;
  const closeBtn = el("button", `${ROOT_CLASS}__close`, "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => close());
  head.append(title, closeBtn);

  const body = el("div", `${ROOT_CLASS}__body`);
  card.append(head, body);
  backdrop.append(card);

  function close(): void {
    if (closed) return;
    closed = true;
    if (activeClose === close) activeClose = null;
    for (const fn of cleanupFns.splice(0)) fn();
    backdrop.remove();
    deps.onClose?.();
  }
  activeClose = close;

  function setMode(next: QrUtilityMode): void {
    if (next === mode) return;
    mode = next;
    // A new mode means the last mode's answer is no longer about anything.
    status = null;
    render();
  }

  // ---- The dial ----------------------------------------------------------
  //
  // A radiogroup underneath, which is what it actually is. The ring is the
  // visible affordance; the positions around it are the real controls, so
  // every one is a button a thumb or a screen reader can reach directly. Arrow
  // keys rotate, which is the behaviour a radiogroup already promises and the
  // only way a dial makes sense without a pointer.

  function buildDial(): HTMLElement {
    const wrap = el("div", `${ROOT_CLASS}__dial-wrap`);
    const dial = el("div", `${ROOT_CLASS}__dial`);
    dial.setAttribute("role", "radiogroup");
    dial.setAttribute("aria-label", "What the scan should do");

    const pointer = el("span", `${ROOT_CLASS}__pointer`);
    pointer.setAttribute("aria-hidden", "true");
    pointer.style.transform = `rotate(${modeAngle(mode)}deg)`;
    dial.append(pointer);

    for (const spec of QR_UTILITY_MODES) {
      const btn = el("button", `${ROOT_CLASS}__notch`);
      btn.type = "button";
      btn.dataset.mode = spec.mode;
      btn.setAttribute("role", "radio");
      const on = spec.mode === mode;
      btn.setAttribute("aria-checked", String(on));
      btn.setAttribute("aria-label", spec.label);
      btn.classList.toggle("is-active", on);
      // Only the selected notch is in the tab order, which is what a
      // radiogroup does — arrow keys move between them.
      btn.tabIndex = on ? 0 : -1;
      btn.style.setProperty("--notch-angle", `${modeAngle(spec.mode)}deg`);
      btn.append(el("span", `${ROOT_CLASS}__notch-glyph`, spec.glyph));
      btn.addEventListener("click", () => setMode(spec.mode));
      btn.addEventListener("keydown", (e) => {
        const key = (e as KeyboardEvent).key;
        const delta =
          key === "ArrowRight" || key === "ArrowDown"
            ? 1
            : key === "ArrowLeft" || key === "ArrowUp"
              ? -1
              : 0;
        if (delta === 0) return;
        e.preventDefault();
        setMode(rotateMode(mode, delta));
        // Follow the selection with focus, so a keyboard rider's next arrow
        // press turns the dial again rather than doing nothing.
        card
          .querySelector<HTMLButtonElement>(
            `.${ROOT_CLASS}__notch[aria-checked="true"]`,
          )
          ?.focus();
      });
      dial.append(btn);
    }

    wrap.append(dial);
    const spec = modeSpec(mode);
    wrap.append(el("p", `${ROOT_CLASS}__mode-label`, spec.label));
    wrap.append(el("p", `${ROOT_CLASS}__mode-detail`, spec.detail));
    return wrap;
  }

  // ---- Scanning ----------------------------------------------------------

  function onScanned(rawValue: string): void {
    if (closed) return;
    if (mode === "features") {
      // Hand off and get out of the way: Confirm Features is a modal of its
      // own, and two stacked dialogs is one too many.
      close();
      deps.onConfirmFeatures(rawValue);
      return;
    }
    busy = true;
    status = null;
    render();
    void deps.onRideScan(rawValue).then(
      (message) => {
        if (closed) return;
        busy = false;
        status = message;
        render();
      },
      () => {
        if (closed) return;
        busy = false;
        // `onRideScan` is documented as resolving rather than rejecting, but a
        // rider standing at a scooter is not who should find out otherwise.
        status = "Something went wrong reading that code — try scanning again.";
        render();
      },
    );
  }

  function startScan(): void {
    const scan = deps.scan ?? openQrScanner;
    scan({
      prompt:
        mode === "features"
          ? "Scan the QR code on this scooter to confirm its features"
          : "Scan the QR code on the scooter you're riding",
      onScan: (rawValue) => onScanned(rawValue),
    });
  }

  function render(): void {
    body.replaceChildren();
    body.append(buildDial());

    const scanBtn = el(
      "button",
      `${ROOT_CLASS}__scan login-btn`,
      busy ? "Working…" : "📷 Scan the QR code",
    );
    scanBtn.type = "button";
    scanBtn.disabled = busy;
    scanBtn.addEventListener("click", () => startScan());
    body.append(scanBtn);

    if (status) {
      const line = el("p", `${ROOT_CLASS}__status`, status);
      line.setAttribute("role", "status");
      line.setAttribute("aria-live", "polite");
      body.append(line);
    }

    body.append(
      el(
        "p",
        `${ROOT_CLASS}__note`,
        "The sticker is on the handlebar stem. Hold the phone about a hand's width back — closer than that and the camera can't focus.",
      ),
    );
  }

  render();
  document.body.append(backdrop);

  const untrap = trapFocusWithin(backdrop, () => !closed);
  cleanupFns.push(untrap);

  const onKey = (e: KeyboardEvent): void => {
    // The scanner owns Escape while it is up (`isQrScannerOpen`): both
    // listeners are on `document`, so backing out of the camera would otherwise
    // close this tool as well and lose the mode the rider had dialled in.
    if (e.key === "Escape" && !isQrScannerOpen()) close();
  };
  document.addEventListener("keydown", onKey);
  cleanupFns.push(() => document.removeEventListener("keydown", onKey));

  try {
    card
      .querySelector<HTMLButtonElement>(
        `.${ROOT_CLASS}__notch[aria-checked="true"]`,
      )
      ?.focus();
  } catch {
    /* detached — nothing to focus */
  }

  return close;
}
