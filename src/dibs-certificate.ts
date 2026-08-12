// The certificate of dibs.
//
// This is the artifact — the thing a rider holds up. Everything about it is
// shaped by that one use: two people at one scooter, one of them saying "I
// called dibs", the other saying "prove it".
//
// So it is legible at arm's length, at a stranger's viewing angle, in Denver
// sun: big name, big time, high contrast, no scrolling. It is faintly absurd
// on purpose — a seal, a serif, a "WITNESSETH" — because the honest framing is
// that this is a joke that happens to work, and pretending otherwise would
// oversell it. The disclaimer says so in the rider's own interest: somebody
// who thinks the app reserved their scooter will be angrier at us than at the
// person who took it.
//
// It carries a QR because the moment it gets shown is the moment somebody else
// hears about both the app and dibs.

import {
  dibsOn,
  DIBS_MAX_TOTAL_MS,
  DIBS_MAX_WALK_MINUTES,
  DIBS_START_GRACE_MS,
  denverStamp,
  type Dibs,
} from "./dibs.ts";
import { fyiSvg, markSvg } from "./mark.ts";
import { track } from "./telemetry.ts";

export interface DibsCertificateHandle {
  close(): void;
}

/** Open the certificate over everything. Returns a handle so a caller that
 *  tears its surface down can take the certificate with it. */
export function openDibsCertificate(dibs: Dibs): DibsCertificateHandle {
  track("dibs", { action: "certificate" });
  let destroyed = false;

  const backdrop = el("div", "dibs-cert");
  const card = el("div", "dibs-cert__card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "dibs-cert-title");

  const close = el("button", "dibs-cert__close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");

  const title = el("h2", "dibs-cert__title", "Certificate of Dibbs");
  title.id = "dibs-cert-title";

  const brand = el("div", "dibs-cert__brand");
  brand.append(markSvg("dibs-cert__mark"));
  const word = el("span", "dibs-cert__word");
  word.append(
    document.createTextNode("scooter"),
    el("span", "dibs-cert__tld", ".fyi"),
  );
  brand.append(word);

  const body = el("div", "dibs-cert__body");
  // "FYI" leads, because that is what this is — a notice, delivered to
  // somebody who did not ask for one.
  const fyi = el("div", "dibs-cert__fyi");
  fyi.append(fyiSvg());
  body.append(fyi);
  const claim = el("p", "dibs-cert__claim");
  claim.append(
    el("strong", "", dibs.claimedBy),
    document.createTextNode(" has dibbs on "),
    el("strong", "", dibs.vehicleName),
  );
  if (dibs.plate) {
    claim.append(el("span", "dibs-cert__plate", ` (plate ${dibs.plate})`));
  }
  body.append(claim);
  body.append(
    el("p", "dibs-cert__lede", "called at"),
    // THE FIELD THE WHOLE THING TURNS ON. Denver time, to the second,
    // because two claims on one scooter land in the same minute easily and
    // the minute is not the answer to the question being settled.
    el("p", "dibs-cert__when", denverStamp(dibs.claimedAt)),
  );

  // THE QR COMES FROM THE SERVER, and only exists once the claim has been
  // registered. It encodes THIS certificate's verification URL, not a generic
  // link to the app — the point is that the person being shown it can check
  // the claim, and a QR that only opens the homepage checks nothing.
  //
  // Generated server-side rather than here for the same reason the timestamp
  // is: an artifact the holder's own device produced is not evidence about
  // the holder. It also keeps one QR encoder in the codebase instead of two.
  const qrWrap = el("div", "dibs-cert__qr");
  const qrCap = el("p", "dibs-cert__qr-cap");
  if (dibs.registration) {
    const img = el("img");
    img.src = dibs.registration.qrUrl;
    img.alt = "Scan to verify this claim";
    img.loading = "eager";
    qrWrap.append(img);
    qrCap.textContent = "Scan to verify";
    qrCap.title = dibs.registration.verifyUrl;
  } else {
    // Said plainly. A certificate with a missing QR and no explanation looks
    // broken; one that says it could not be registered is merely honest, and
    // the timestamp on it is still the rider's own claim.
    qrCap.textContent =
      "Couldn't reach the server to register this one — the time above is from this phone.";
    qrCap.classList.add("dibs-cert__qr-cap--warn");
  }

  // The disclaimer lives in the rules above, as rule one. Repeating it here
  // was saying the same sentence twice on one card.
  const fine = el(
    "p",
    "dibs-cert__fine",
    "Show this, don't send it. A screenshot of a certificate isn't one.",
  );

  // THE ANIMATION IS THE POINT, and it is not decoration.
  //
  // A certificate is one screenshot away from being forged: crop somebody
  // else's, or your own from an hour ago, and the still image is identical to
  // the real one. So the real one MOVES, and says in words that it has to —
  // an anti-forgery measure nobody has been told about protects nobody.
  //
  // WHAT MOVES IS A COUNTDOWN, not just a shimmer. A sweeping highlight is
  // motion that carries no information: it proves the page is live and
  // nothing else, and a reader has no way to tell a real one from a looping
  // GIF. A countdown ticking down in SECONDS is different — it has to agree
  // with the expiry printed above it, it changes every second so a still is
  // instantly stale, and it is the thing the rider actually wants to know.
  // The shimmer stays underneath it, because motion at the edge of vision is
  // what makes somebody glance down in the first place.
  const live = el("div", "dibs-cert__live");
  const sweep = el("span", "dibs-cert__sweep");
  const clock = el("span", "dibs-cert__clock");
  clock.setAttribute("aria-live", "off");
  const liveText = el("span", "dibs-cert__live-text", "left — valid only while this is counting");
  live.append(sweep, clock, liveText);

  // Driven by rAF rather than setInterval: a backgrounded tab throttles both,
  // but rAF resumes on the exact frame the certificate becomes visible again,
  // which is the moment somebody is being shown it.
  let raf = 0;
  const tick = (): void => {
    if (destroyed) return;
    const left = Math.max(0, dibs.claimedAt + DIBS_MAX_TOTAL_MS - Date.now());
    const mins = Math.floor(left / 60_000);
    const secs = Math.floor((left % 60_000) / 1000);
    clock.textContent = `${mins}:${String(secs).padStart(2, "0")}`;
    live.classList.toggle("is-expired", left <= 0);
    if (left <= 0) {
      // Say what it is rather than freezing on 0:00 and looking broken.
      liveText.textContent = "these dibbs are null and void";
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  tick();

  const rules = el("details", "dibs-cert__rules");
  const summary = el("summary", "", "The rules of dibbs");
  const list = el("ol");
  for (const rule of [
    "Dibbs isn't a reservation. Veo doesn't offer one. This is a timestamp and whatever standing it earns you in person — nothing stops anyone riding anything.",
    `${DIBS_START_GRACE_MS / 60_000} minutes to set off, or the claim is void. Not ${DIBS_START_GRACE_MS / 60_000} minutes to arrive — ${DIBS_START_GRACE_MS / 60_000} to move.`,
    `${DIBS_MAX_WALK_MINUTES} minutes' walk, maximum. You can't call dibbs on something you couldn't plausibly reach.`,
    `${DIBS_MAX_TOTAL_MS / 60_000} minutes and it's over, however well you walked.`,
    "A certificate only counts while it's moving. A screenshot doesn't.",
  ]) {
    list.append(el("li", "", rule));
  }
  rules.append(summary, list);

  card.append(close, brand, title, body, live, qrWrap, qrCap, rules, fine);
  backdrop.append(card);
  document.body.append(backdrop);

  const dismiss = (): void => {
    destroyed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    // Capture, and stopped: a certificate opened from inside the ride wizard
    // must not close the wizard out from under the rider when they only meant
    // to put the certificate away. Same reasoning as map-pick's Escape.
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  };
  document.addEventListener("keydown", onKey, true);
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismiss();
  });
  close.focus();

  return { close: dismiss };
}

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


/** "You've got dibbs" — the confirmation, with the certificate one tap away.
 *
 *  Calling dibbs used to throw the full certificate over the map. That is the
 *  wrong response to a confirmation: the rider tapped a small button and is
 *  probably about to start walking, and a full-screen document is something
 *  they now have to dismiss. This tells them it worked, names what they got,
 *  and lets them open the certificate if and when somebody asks.
 *
 *  It dismisses itself, because a confirmation that needs dismissing is a
 *  second thing to do about something that already succeeded. */
export function showDibsConfirmation(dibs: Dibs): void {
  document.querySelector(".dibs-toast")?.remove();

  const toast = el("div", "dibs-toast");
  toast.setAttribute("role", "status");

  const text = el("div", "dibs-toast__text");
  text.append(
    el("strong", "", "You've got dibbs"),
    el("span", "dibs-toast__what", ` on ${dibs.vehicleName}`),
  );

  const view = el("button", "dibs-toast__view", "View certificate");
  view.type = "button";
  view.addEventListener("click", () => {
    toast.remove();
    // Re-read rather than closing over the claim: by now the server
    // registration may have landed, and that copy has the QR on it.
    openDibsCertificate(dibsOn(dibs.vehicleIdentifier) ?? dibs);
  });

  toast.append(el("span", "dibs-toast__glyph", "✋"), text, view);
  document.body.append(toast);

  const timer = window.setTimeout(() => toast.remove(), 9000);
  toast.addEventListener("click", (e) => {
    if (e.target === toast) {
      window.clearTimeout(timer);
      toast.remove();
    }
  });
}
