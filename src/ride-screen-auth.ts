// Screen 1 — Auth & GPS (frontend plan, `ride-screen-auth.ts` row; master Part
// 0 Screen 1). Skippable entirely once the rider is signed in AND geolocation
// permission is already granted — "If neither applies the screen never
// appears; proceed to Screen 2." A device deep link changes the LANDING
// screen (`resolveStartScreen` in ride-modal.ts), never these gates: an
// unauthenticated deep-link entry still sees this screen (so [Ride as Guest]
// keeps it one tap) and an ungranted-GPS entry still gets the GPS prompt
// (tracking needs it).
//
// ---------------------------------------------------------------------------
// DECISION — a fourth sign-in door.
//
// The owner's vision (Part 0) lists three doors: Email Me a Link | Email Me a
// Code | Login w/ Google. `auth-sms.ts` landed on this branch after that
// vision was written, and `auth-config.ts` already gates it behind a live
// `smsEnabled` capability flag exactly like the other three (fail-closed,
// same as Google). Folding it INTO the "Email Me a Code" copy would need a
// door that switches between an email field and a phone field — a UX change
// `sms-door.ts` doesn't offer, and inventing one here would duplicate logic
// that already exists. `sms-door.ts` is instead a complete, self-contained
// two-step door (`buildSmsDoor`) built for exactly the "drop it in as another
// option" shape its own module doc describes ("mirrors the email code door
// exactly... because a rider who has used one should recognise the other").
// So: SMS ships as a clearly-labeled FOURTH door ("Text Me a Code"), reusing
// `buildSmsDoor` verbatim — same as `main.ts`'s account drawer does — rather
// than merging it into the email door. This is the "your call, document the
// decision" the lane brief asked for.
// ---------------------------------------------------------------------------
//
// GPS: the "Enable GPS" tap calls `Locate.trigger()` from INSIDE the tap
// handler — the permission prompt needs a user gesture — with the async
// `navigator.permissions.query` leap-past exactly as `ride-wizard.ts`'s
// `start()` does it: query once, no live `onchange` subscription, and if the
// browser already reports "granted" (this origin was approved some other
// way, or between wire time and now) fetch a fix immediately instead of
// waiting on a tap that will never see a permission dialog.

import {
  registerRideScreen,
  type RideScreen,
  type RideScreenContext,
} from "./ride-modal.ts";
import type { Locate } from "./locate.ts";
import { isAuthenticated } from "./map-auth.js";
import { markUndoFree } from "./ios-shake-undo.ts";
import {
  loadAuthConfig as defaultLoadAuthConfig,
  type AuthConfig,
} from "./auth-config.ts";
import {
  AuthSendError,
  isProbablyCode,
  isProbablyEmail,
  requestLoginCode,
  requestMagicLink,
  verifyEmailCode,
} from "./auth-magic-link.ts";
import { renderGoogleButton } from "./auth-google.ts";
import { buildSmsDoor, type SmsDoorState } from "./sms-door.ts";

/** The subset of `Locate` this screen touches — narrowed so a test fake needs
 *  no real MapLibre `GeolocateControl`. */
export type LocateLike = Pick<Locate, "current" | "trigger" | "onFix" | "onError">;

export type GeoPermissionState = "granted" | "denied" | "prompt" | "unknown";

export interface RideScreenAuthDeps {
  locate: LocateLike;
  /** Injected for tests; defaults to `auth-config.ts`'s memoized loader. */
  loadAuthConfig?(): Promise<AuthConfig>;
  /** Every sign-in door in this app reloads on success so the new bearer
   *  token is picked up by every later fetch (`main.ts`'s account drawer,
   *  `sms-door.ts`). Defaults to `() => location.reload()`; injected so tests
   *  can observe it without actually navigating. */
  onSignedIn?(): void;
  /** One-shot `navigator.permissions.query({name:"geolocation"})`, resolving
   *  its current state — `"unknown"` when the Permissions API itself is
   *  unavailable (older Safari). Defaults to the real thing; injected for
   *  tests (happy-dom has no Permissions API). */
  queryGeoPermission?(): Promise<GeoPermissionState>;
  /** True when the rider arrived here mid-task — they named a destination on
   *  the home bar and are on their way. See the skip rule below. */
  hasDestination?(): boolean;
}

async function defaultQueryGeoPermission(): Promise<GeoPermissionState> {
  const permissions =
    typeof navigator !== "undefined" ? navigator.permissions : undefined;
  if (!permissions?.query) return "unknown";
  try {
    const status = await permissions.query({
      name: "geolocation" as PermissionName,
    });
    return status.state as GeoPermissionState;
  } catch {
    return "unknown";
  }
}

function defaultReload(): void {
  try {
    location.reload();
  } catch {
    /* not navigable (a test harness, an embedded webview) — nothing to do */
  }
}

/** Register Screen 1. Call once at startup (the `wireX()` convention this
 *  program's house rules ask for); returns an unregister function for
 *  tests/HMR. */
export function wireRideScreenAuth(deps: RideScreenAuthDeps): () => void {
  const loadCfg = deps.loadAuthConfig ?? defaultLoadAuthConfig;
  const onSignedIn = deps.onSignedIn ?? defaultReload;
  const queryPermission = deps.queryGeoPermission ?? defaultQueryGeoPermission;

  // Primed once, at wire time: main.ts calls this at app boot, well before
  // the rider can reach the wizard, so by the time `resolveStartScreen` asks
  // `skip()` the async query has almost always already resolved. A live fix
  // is an even stronger signal and wins immediately without waiting on the
  // Permissions API at all — and covers browsers with no Permissions API.
  let gpsGranted = deps.locate.current() !== null;
  // Shared across this outer priming query AND `buildScreen`'s own inner one
  // (see `ScreenDeps.triggerOnceForGrant`): both independently detect
  // "granted" (a real race whenever the wizard opens before this outer query
  // has resolved, which is exactly when `buildScreen` mounts and starts its
  // own query), and without this guard both would call `trigger()` — a
  // harmless-but-wasteful duplicate geolocation request. At most one fires.
  let triggeredForCachedGrant = false;
  function triggerOnceForGrant(): void {
    if (triggeredForCachedGrant) return;
    triggeredForCachedGrant = true;
    // Permission is already granted (not a fresh prompt) — safe to trigger
    // outside a user gesture. Without this, `skip()` starts returning true
    // the instant permission resolves, but no fix is ever requested, so the
    // rider reaches Screen 6 and waits indefinitely for a GPS fix that never
    // arrives.
    deps.locate.trigger();
  }
  if (!gpsGranted) {
    void queryPermission().then((state) => {
      if (state === "granted") {
        gpsGranted = true;
        triggerOnceForGrant();
      }
    });
  }

  const hasDestination = deps.hasDestination ?? (() => false);

  const unregister = registerRideScreen("1", {
    // TWO GATES, AND ONLY ONE OF THEM IS A GATE.
    //
    // Location is a real prerequisite: navigation without a fix is not a
    // degraded experience, it is no experience. Signing in is not — this
    // screen's own copy offers "Ride as Guest", so the account was always
    // optional and this screen was pitching, not gating.
    //
    // Pitching is fine to a rider who opened the wizard cold. It is not fine
    // to one who has already typed a destination into the home bar and picked
    // how they are getting there: they are mid-task, standing somewhere, and
    // the app answered "take me here" with "sign in first". So once a
    // destination is on the session, location alone decides.
    //
    // The sign-in offer is not lost — the profile button is always on screen,
    // and the post-ride screens ask when there is something to attribute.
    skip: (ctx) => {
      // A FREE RIDE HAS NOTHING TO GATE. It is a private, local, own-device
      // ride: there is no account to attribute it to, no destination to
      // navigate to, and no Veo to unlock. Both gates below are about things
      // it does not do, and the whole promise of the button is one tap — so
      // stopping a rider on a sign-in screen here would be asking them to
      // answer a question that has no bearing on what happens next.
      //
      // Location is not required either: the recorder starts and the watch
      // fills in. Refusing to begin until a fix lands would lose the first
      // seconds of the ride, which is the part a rider cannot go back for.
      if (ctx.entry.freeRide) return true;
      const located = gpsGranted || deps.locate.current() !== null;
      if (!located) return false;
      return isAuthenticated() || hasDestination();
    },
    factory: (ctx: RideScreenContext): RideScreen =>
      buildScreen(ctx, {
        locate: deps.locate,
        loadCfg,
        onSignedIn,
        queryPermission,
        onGpsGranted: () => {
          gpsGranted = true;
        },
        triggerOnceForGrant,
      }),
  });
  return unregister;
}

interface ScreenDeps {
  locate: LocateLike;
  loadCfg(): Promise<AuthConfig>;
  onSignedIn(): void;
  queryPermission(): Promise<GeoPermissionState>;
  /** De-dupes against the outer wire-time priming query — see its own doc
   *  comment. */
  triggerOnceForGrant(): void;
  /** Flips the module-level cache in `wireRideScreenAuth` so a LATER
   *  `resolveStartScreen`/`nextFlowScreen` call (e.g. re-opening the wizard
   *  after this tab already granted GPS) sees it without re-querying. */
  onGpsGranted(): void;
}

function buildScreen(ctx: RideScreenContext, deps: ScreenDeps): RideScreen {
  let destroyed = false;
  const root = el("div", "ride-wizard__body ride-screen-auth");
  const authSection = el("div", "ride-screen-auth__section");
  const gpsSection = el("div", "ride-screen-auth__section");
  root.append(authSection, gpsSection);

  // ---------------- GPS ----------------
  let gpsGranted = deps.locate.current() !== null;

  // The header's Next mirrors [Ride as Guest]: GPS is the only REQUIRED
  // information on this screen (signing in is optional — guests ride too),
  // so Next lights up as soon as location is granted.
  const syncHeaderNext = (): void => ctx.setNextEnabled(gpsGranted);
  syncHeaderNext();

  const renderGps = (): void => {
    gpsSection.replaceChildren();
    if (gpsGranted) return;
    const lede = el(
      "p",
      "ride-wizard__lede",
      "Turn on location to find the scooter you're standing next to.",
    );
    const hint = el(
      "p",
      "ride-wizard__hint",
      "Your location stays on this device unless you opt to save ride tracks.",
    );
    const actions = el("div", "ride-wizard__actions");
    const btn = el("button", "login-btn", "Enable GPS");
    btn.type = "button";
    const status = el("p", "ride-wizard__hint");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    btn.addEventListener("click", () => {
      btn.disabled = true;
      status.textContent = "Awaiting approval on your device…";
      // Still inside the tap: the browser treats the permission prompt as
      // user-initiated.
      deps.locate.trigger();
    });
    actions.append(btn);
    gpsSection.append(lede, hint, actions, status);
  };
  renderGps();

  const maybeAdvance = (): void => {
    if (!destroyed && isAuthenticated() && gpsGranted) ctx.next();
  };

  const gpsStatusEl = (): HTMLElement | null =>
    gpsSection.querySelector<HTMLElement>('[role="status"]');
  const gpsButtonEl = (): HTMLButtonElement | null =>
    gpsSection.querySelector<HTMLButtonElement>("button");

  const unFix = deps.locate.onFix(() => {
    if (destroyed || gpsGranted) return;
    gpsGranted = true;
    deps.onGpsGranted();
    syncHeaderNext();
    renderGps();
    maybeAdvance();
  });
  const unErr = deps.locate.onError(() => {
    if (destroyed || gpsGranted) return;
    const status = gpsStatusEl();
    if (status) {
      status.textContent =
        "We couldn't get your location — it may be blocked for this site.";
    }
    const btn = gpsButtonEl();
    if (btn) btn.disabled = false;
  });
  ctx.onCleanup(unFix);
  ctx.onCleanup(unErr);

  if (!gpsGranted) {
    void deps.queryPermission().then((state) => {
      if (destroyed || gpsGranted || state !== "granted") return;
      gpsGranted = true;
      deps.onGpsGranted();
      syncHeaderNext();
      // No prompt will fire (already granted) — safe to call outside a tap.
      // De-duped against the outer wire-time query (see `triggerOnceForGrant`'s
      // own doc comment) — whichever of the two resolves "granted" first is
      // the one that actually calls `locate.trigger()`.
      deps.triggerOnceForGrant();
      renderGps();
      maybeAdvance();
    });
  }

  // ---------------- Auth ----------------
  let authCfg: AuthConfig | null = null;
  const smsState: SmsDoorState = { phone: "", sentPhone: "" };

  const renderAuth = (): void => {
    authSection.replaceChildren();
    if (isAuthenticated()) return;

    const guestBtn = el(
      "button",
      "login-btn login-btn--secondary",
      "Ride as Guest",
    );
    guestBtn.type = "button";
    guestBtn.addEventListener("click", () => ctx.next());
    authSection.append(
      el(
        "p",
        "ride-wizard__lede",
        "Sign in to track this ride and earn points, or ride as a guest.",
      ),
      guestBtn,
      el("div", "account-or", "or"),
    );

    if (authCfg?.googleEnabled && authCfg.googleClientId) {
      const clientId = authCfg.googleClientId;
      const gWrap = el("div", "account-google");
      authSection.append(gWrap);
      void renderGoogleButton(gWrap, clientId, {
        onSignedIn: () => deps.onSignedIn(),
        onError: (err) => {
          gWrap.after(el("p", "account-error", err.message));
        },
      });
      authSection.append(el("div", "account-or", "or"));
    }

    buildEmailDoor(authSection, deps.onSignedIn);

    // The fourth door — see the module header's DECISION note.
    if (authCfg?.smsEnabled) {
      authSection.append(el("div", "account-or", "or"));
      buildSmsDoor(authSection, {
        el,
        state: smsState,
        onSignedIn: () => deps.onSignedIn(),
      });
    }
  };
  renderAuth();
  void deps.loadCfg().then((cfg) => {
    if (destroyed) return;
    authCfg = cfg;
    renderAuth();
  });

  return {
    title: "Sign in & location",
    primary: root,
    destroy() {
      destroyed = true;
    },
  };
}

/** Email sign-in: typed AA000AA code (primary) or a magic link (secondary).
 *  Mirrors `main.ts`'s `wireAccount()` email door verbatim — same copy, same
 *  status messages — so a rider who has signed in from the Account drawer
 *  recognizes this one. */
function buildEmailDoor(container: HTMLElement, onSignedIn: () => void): void {
  const emailForm = el("form", "account-magic");
  const emailInput = el("input", "select") as HTMLInputElement;
  emailInput.type = "email";
  emailInput.required = true;
  emailInput.placeholder = "you@email.com";
  emailInput.autocomplete = "email";
  emailInput.setAttribute("aria-label", "Email address");
  // Both sign-in fields keep their edits out of WebKit's undo queue: a rider
  // who signs in mid-wizard would otherwise carry an "Undo Typing" prompt
  // into the ride on every bump (ios-shake-undo.ts).
  markUndoFree(emailInput);
  const emailSubmit = el("button", "login-btn", "Email me a sign-in code");
  emailSubmit.type = "submit";
  const linkBtn = el(
    "button",
    "text-btn",
    "Prefer a link? Email me one instead",
  );
  linkBtn.type = "button";
  const emailStatus = el("p", "account-magic-status");
  emailStatus.setAttribute("role", "status");
  emailStatus.setAttribute("aria-live", "polite");
  emailForm.append(emailInput, emailSubmit, linkBtn, emailStatus);

  const codeForm = el("form", "account-code");
  codeForm.hidden = true;
  const codeHint = el(
    "p",
    "account-magic-status",
    "📧 Check your inbox and enter the code (like AB123XY, valid 10 minutes):",
  );
  const codeInput = el("input", "select") as HTMLInputElement;
  codeInput.type = "text";
  codeInput.autocomplete = "one-time-code";
  codeInput.autocapitalize = "characters";
  codeInput.spellcheck = false;
  codeInput.maxLength = 9; // AA000AA (7) plus a stray space/hyphen or two
  codeInput.placeholder = "AB123XY";
  codeInput.setAttribute("aria-label", "Sign-in code");
  markUndoFree(codeInput);
  const codeSubmit = el("button", "login-btn", "Verify code");
  codeSubmit.type = "submit";
  const codeStatus = el("p", "account-magic-status");
  codeStatus.setAttribute("role", "status");
  codeStatus.setAttribute("aria-live", "polite");
  codeForm.append(codeHint, codeInput, codeSubmit, codeStatus);

  let sentEmail = "";
  const validEmail = (): string | null => {
    const email = emailInput.value.trim();
    if (!isProbablyEmail(email)) {
      emailStatus.textContent = "Enter a valid email address.";
      return null;
    }
    return email;
  };
  emailInput.addEventListener("input", () => {
    if (sentEmail && emailInput.value.trim() !== sentEmail) {
      sentEmail = "";
      codeForm.hidden = true;
      codeStatus.textContent = "";
      emailSubmit.textContent = "Email me a sign-in code";
    }
  });
  const sendFailMsg = (err: unknown, noun: string): string =>
    err instanceof AuthSendError && err.status === 429
      ? `Too many requests — wait a minute before asking for another ${noun}.`
      : `Couldn't send the ${noun} right now — please try again.`;

  emailForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = validEmail();
    if (!email) return;
    emailSubmit.disabled = true;
    linkBtn.disabled = true;
    emailStatus.textContent = "Sending…";
    requestLoginCode(email)
      .then(() => {
        sentEmail = email;
        emailSubmit.disabled = false;
        linkBtn.disabled = false;
        emailSubmit.textContent = "Resend code";
        emailStatus.textContent = "";
        codeForm.hidden = false;
        codeInput.focus();
      })
      .catch((err: unknown) => {
        emailSubmit.disabled = false;
        linkBtn.disabled = false;
        emailStatus.textContent = sendFailMsg(err, "code");
      });
  });

  linkBtn.addEventListener("click", () => {
    const email = validEmail();
    if (!email) return;
    emailSubmit.disabled = true;
    linkBtn.disabled = true;
    emailStatus.textContent = "Sending…";
    requestMagicLink(email)
      .then(() => {
        emailSubmit.disabled = false;
        linkBtn.disabled = false;
        sentEmail = "";
        codeForm.hidden = true;
        emailStatus.textContent =
          "📧 Check your inbox for a sign-in link (valid 15 minutes).";
      })
      .catch((err: unknown) => {
        emailSubmit.disabled = false;
        linkBtn.disabled = false;
        emailStatus.textContent = sendFailMsg(err, "link");
      });
  });

  codeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!sentEmail) {
      codeStatus.textContent = "Request a sign-in code first.";
      return;
    }
    const code = codeInput.value;
    if (!isProbablyCode(code)) {
      codeStatus.textContent = "Enter the code from your email (like AB123XY).";
      return;
    }
    codeSubmit.disabled = true;
    codeStatus.textContent = "Verifying…";
    verifyEmailCode(sentEmail, code)
      .then(() => onSignedIn())
      .catch((err: unknown) => {
        codeSubmit.disabled = false;
        codeStatus.textContent =
          err instanceof AuthSendError && err.status === 429
            ? "Too many tries — request a new code."
            : "That code didn't work — check it or resend.";
      });
  });

  container.append(emailForm, codeForm);
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
