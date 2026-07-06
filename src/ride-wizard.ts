// "Find a ride" wizard: the guided entry into ride mode. A short flow —
// location consent → awaiting the device's permission prompt → one
// interview question (what matters most) → a playful processing beat —
// that ends by handing the rider's answers to the Recommended Devices
// drawer (recommend.ts), which renders and maintains the ranked list.
//
// Location is strictly consent-first: nothing touches geolocation until the
// rider agrees in step one, and declining hands them straight back to
// Analysis mode (via hooks.onExit).

import type { Locate, LngLat } from "./locate.ts";
import type { RidePriority, RideTypeChoice } from "./recommend.ts";

export interface RideWizardHooks {
  /** Consent granted — apply the ride map preset (caller guards its own
   *  synthetic events). Runs inside the Yes tap's user gesture. */
  onConsentGranted(): void;
  /** Rider declined consent, dismissed the wizard, or location failed —
   *  return to Analysis mode and reset the map. */
  onExit(): void;
  /** "Log in to save your preferences" hint tapped — open the Account drawer. */
  onLoginHint(): void;
  /** Interview + processing finished: hand the answers to the Recommended
   *  Devices drawer. The wizard closes itself right after. */
  onInterviewDone(
    priority: RidePriority,
    typeChoice: RideTypeChoice,
    from: LngLat,
  ): void;
}

const PROCESSING_LINES = [
  "Scanning the fleet…",
  "Checking batteries…",
  "Measuring your walks…",
  "Dodging the ghost scooters…",
];

export class RideWizard {
  private step: "consent" | "awaiting" | "interview" | "processing" | null =
    null;
  private priority: RidePriority = "distance";
  private typeChoice: RideTypeChoice = "standing";
  private cleanupFns: (() => void)[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly locate: Locate,
    private readonly hooks: RideWizardHooks,
  ) {}

  /** Open the wizard at the consent step. */
  start(): void {
    this.root.hidden = false;
    this.renderConsent();
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Tear the wizard down without firing onExit (the caller is already
   *  handling the mode change). */
  close(): void {
    this.runCleanups();
    this.step = null;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private exit(): void {
    this.close();
    this.hooks.onExit();
  }

  private runCleanups(): void {
    for (const fn of this.cleanupFns.splice(0)) fn();
  }

  // ---------- Shared shell ----------

  private shell(title: string, ...content: HTMLElement[]): void {
    this.runCleanups();
    const header = el("header", "ride-wizard__header");
    const h = el("h2", "ride-wizard__title", title);
    h.id = "ride-wizard-title";
    const closeBtn = el("button", "ride-wizard__close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close Find a ride");
    closeBtn.addEventListener("click", () => this.exit());
    header.append(h, closeBtn);

    const body = el("div", "ride-wizard__body");
    body.append(...content);
    this.root.replaceChildren(header, body);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && this.isOpen()) this.exit();
    };
    document.addEventListener("keydown", onKey);
    this.cleanupFns.push(() => document.removeEventListener("keydown", onKey));
  }

  // ---------- Step 1: location consent ----------

  private renderConsent(): void {
    this.step = "consent";
    const p = el(
      "p",
      "ride-wizard__lede",
      "We need to enable location services to activate “Find a ride” mode — is that cool?",
    );
    const sub = el(
      "p",
      "ride-wizard__hint",
      "Your location stays on this device; we only use it to measure walks.",
    );
    const row = el("div", "ride-wizard__actions");
    const yes = el("button", "login-btn", "Yes, use my location");
    yes.type = "button";
    const no = el("button", "login-btn login-btn--secondary", "No thanks");
    no.type = "button";
    yes.addEventListener("click", () => {
      // Still inside the tap: the browser treats the permission prompt as
      // user-initiated.
      this.hooks.onConsentGranted();
      this.renderAwaiting();
    });
    no.addEventListener("click", () => this.exit());
    row.append(yes, no);
    this.shell("Find a ride", p, sub, row);
  }

  // ---------- Step 2: waiting on the device permission prompt ----------

  private renderAwaiting(): void {
    this.step = "awaiting";
    const already = this.locate.current();
    if (already) {
      this.renderInterview();
      return;
    }

    const spinner = el("div", "ride-wizard__spinner");
    spinner.setAttribute("aria-hidden", "true");
    const p = el("p", "ride-wizard__lede", "Awaiting approval on your device…");
    const sub = el(
      "p",
      "ride-wizard__hint",
      "Look for your browser's location prompt.",
    );
    this.shell("Find a ride", spinner, p, sub);

    const unFix = this.locate.onFix(() => {
      if (this.step === "awaiting") this.renderInterview();
    });
    const unErr = this.locate.onError(() => {
      if (this.step === "awaiting") this.renderLocationFailed();
    });
    this.cleanupFns.push(unFix, unErr);
    this.locate.trigger();
  }

  private renderLocationFailed(): void {
    const p = el(
      "p",
      "ride-wizard__lede",
      "We couldn't get your location — it may be blocked for this site.",
    );
    const row = el("div", "ride-wizard__actions");
    const back = el("button", "login-btn login-btn--secondary", "Back to Analysis");
    back.type = "button";
    back.addEventListener("click", () => this.exit());
    row.append(back);
    this.shell("Find a ride", p, row);
  }

  // ---------- Step 3: the interview ----------

  private renderInterview(): void {
    this.step = "interview";
    const q = el(
      "p",
      "ride-wizard__lede",
      "What do you care about MOST? (All three are factored in.)",
    );

    const options: { value: RidePriority; label: string; desc: string }[] = [
      {
        value: "type",
        label: "Exact device type",
        desc: "Get the ride you want, even if it's a longer walk.",
      },
      {
        value: "quality",
        label: "Device quality & battery life",
        desc: "Healthy scooter, full charge.",
      },
      {
        value: "distance",
        label: "Least walking distance",
        desc: "The closest thing that rolls.",
      },
    ];

    const list = el("div", "ride-wizard__choices");
    list.setAttribute("role", "radiogroup");
    const typeRow = el("div", "ride-wizard__typerow");
    typeRow.hidden = this.priority !== "type";

    const choiceBtns: HTMLButtonElement[] = [];
    const syncChoices = (): void => {
      for (const b of choiceBtns) {
        const on = b.dataset.priority === this.priority;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", String(on));
      }
      typeRow.hidden = this.priority !== "type";
    };
    options.forEach((opt, i) => {
      const btn = el("button", "ride-wizard__choice");
      btn.type = "button";
      btn.dataset.priority = opt.value;
      btn.setAttribute("role", "radio");
      btn.append(
        el("strong", undefined, `${i + 1}. ${opt.label}`),
        el("span", "ride-wizard__choice-desc", opt.desc),
      );
      btn.addEventListener("click", () => {
        this.priority = opt.value;
        syncChoices();
      });
      choiceBtns.push(btn);
      list.append(btn);
    });

    // Type sub-picker, shown only when "Exact device type" is the priority.
    typeRow.append(el("span", "ride-wizard__typerow-label", "Which type?"));
    const typeDefs: { value: RideTypeChoice; label: string }[] = [
      { value: "standing", label: "🛴 Standing scooter" },
      { value: "seated", label: "🪑 Seated scooter" },
      { value: "ebike", label: "🚲 E-bike" },
    ];
    const typeBtns: HTMLButtonElement[] = [];
    const syncTypes = (): void => {
      for (const b of typeBtns) {
        const on = b.dataset.type === this.typeChoice;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", String(on));
      }
    };
    for (const def of typeDefs) {
      const b = el("button", "ride-wizard__typechip", def.label);
      b.type = "button";
      b.dataset.type = def.value;
      b.addEventListener("click", () => {
        this.typeChoice = def.value;
        syncTypes();
      });
      typeBtns.push(b);
      typeRow.append(b);
    }
    syncChoices();
    syncTypes();

    const row = el("div", "ride-wizard__actions");
    const go = el("button", "login-btn", "Find my ride");
    go.type = "button";
    go.addEventListener("click", () => this.renderProcessing());
    row.append(go);

    const hint = el("p", "ride-wizard__hint");
    const hintBtn = el("button", "text-btn", "Log in");
    hintBtn.type = "button";
    hintBtn.addEventListener("click", () => this.hooks.onLoginHint());
    hint.append(document.createTextNode("Hint: "), hintBtn, document.createTextNode(" to save your preferences."));

    this.shell("Find a ride", q, list, typeRow, row, hint);
  }

  // ---------- Step 4: processing beat → handoff ----------

  private renderProcessing(): void {
    this.step = "processing";
    const spinner = el("div", "ride-wizard__spinner");
    spinner.setAttribute("aria-hidden", "true");
    const line = el("p", "ride-wizard__lede", PROCESSING_LINES[0]);
    this.shell("Finding your ride…", spinner, line);

    let i = 0;
    const rotate = window.setInterval(() => {
      i = (i + 1) % PROCESSING_LINES.length;
      line.textContent = PROCESSING_LINES[i];
    }, 450);
    const done = window.setTimeout(() => {
      window.clearInterval(rotate);
      if (this.step !== "processing") return;
      const from = this.locate.current();
      if (!from) {
        this.renderLocationFailed();
        return;
      }
      // Hand the ranked-list job to the Recommended Devices drawer and get
      // out of the way.
      this.hooks.onInterviewDone(this.priority, this.typeChoice, from);
      this.close();
    }, 1_400);
    this.cleanupFns.push(() => {
      window.clearInterval(rotate);
      window.clearTimeout(done);
    });
  }
}

// ---------- helpers ----------

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
