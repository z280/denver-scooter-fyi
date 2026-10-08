// §2.4's list, on screen. The derivation lives in `plan-list.ts` and every
// number and sentence here comes from it — this file owns layout, focus and
// taps, and makes no claim of its own about time, money or risk.
//
// WHY A PANEL AND NOT WIZARD SCREENS, same argument `arrival-panel.ts` makes
// and for the same rider: the two questions this needs were already answered on
// the home bar (where to, and need wheels), so there is nothing left to ask.
// What is left is to show what we found, over the map the plans are drawn on.
//
// THE WALK-ONLY ROW IS SHOWN AND CANNOT BE CHOSEN, which is deliberate and is
// not an oversight. Master §6.2 ranks the direct walk against everything else
// precisely so the rider can see that riding is or is not worth it, and §2.4
// puts it in the list. But there is no walk-to-destination flow in this app to
// hand them to — the arrival panel walks a rider to a SCOOTER. Offering a
// button that goes nowhere is worse than offering none, so the row carries its
// time as a comparison and says plainly that it needs nothing from us. When a
// walking flow exists this is the one place to wire it.

import { parseCorrection } from "./free-minutes-control.ts";
import type { PlanListView, PlanRow } from "./plan-list.ts";
import type { RidePriority } from "./recommend.ts";

export interface PlanListPanelDeps {
  /** The rider picked a plan with a vehicle to walk to. */
  onChoose(row: PlanRow): void;
  /** §2.2 — "I've got about this many left". `null` clears the correction and
   *  hands the figure back to the estimate. A caller that does not wire it gets
   *  the figure as a read-only readout, which is still worth showing: knowing
   *  the number the plans were priced with is most of the point. */
  onCorrectFreeMinutes?(minutes: number | null): void;
  /** Dismissed — back to the map. */
  onCancel(): void;
  /** Search again against the current fleet. Optional: a caller that cannot
   *  re-search simply does not offer the button. */
  onRefresh?(): void;
  /** Open the place an "ideal scooter" is configured. Optional, and this
   *  module stays ignorant of where that is — the spec panel lives in a
   *  drawer and this one knows nothing about drawers. Absent, the prompt is
   *  still shown as a sentence: "the app can do this and you have not set it
   *  up" is worth knowing even where this surface cannot open it. */
  onConfigureSpec?(): void;
  /** The rider stood their ideal scooter down for this search, or put it back.
   *  Absent and the sheet is shown as a read-only statement, which is still
   *  worth having: knowing a filter is in force explains a short list. */
  onToggleIdealSpec?(inUse: boolean): void;
  /** The three answers the find-wheels interview offers, so a rider can change
   *  their mind without walking back through it. Same values and the same
   *  words, because they are the same question.
   *
   *  `priority()` reads the current answer rather than capturing it: the wizard
   *  may have set it a moment ago and this panel is rebuilt on every re-solve. */
  priority?(): RidePriority | null;
  onSetPriority?(priority: RidePriority): void;
  /** "Show me where I swap." Minimises this drawer and puts the hand-off
   *  vehicle on the map. Offered per row and only on a row that HAS a
   *  hand-off. */
  onShowSwitchover?(row: PlanRow): void;
}

export interface PlanListPanelHandle {
  /** Repaint against a fresh search. Keeps the panel open, because a rider
   *  mid-read should not have it close under them. */
  update(view: PlanListView): void;
  destroy(): void;
}

/** The interview's three answers, with the wizard's own wording — shortened
 *  only where a button cannot carry a sentence. The SAME words matter: a rider
 *  who answered "Least walking distance" a moment ago should recognise the
 *  control that lets them change it.
 *
 *  Option 4 ("use existing map filters") is deliberately absent. It is not a
 *  fourth priority — the wizard's own comment says nothing wipes the filters
 *  any more, so it describes an intent with no behaviour behind it. Offering it
 *  here would be a button that does nothing. */
const PRIORITY_OPTIONS: readonly { value: RidePriority; label: string }[] = [
  { value: "type", label: "Exact type" },
  { value: "quality", label: "Condition" },
  { value: "distance", label: "Least walking" },
];

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

export function createPlanListPanel(
  root: HTMLElement,
  view: PlanListView,
  deps: PlanListPanelDeps,
): PlanListPanelHandle {
  let destroyed = false;

  const panel = el("div", "planlist");
  const head = el("div", "planlist__head");
  head.append(el("div", "planlist__title", "How to get there"));
  // A LABELLED BUTTON AT THE END, not a corner ×, and the move into the drawer
  // is what decided that.
  //
  // This used to be a 34px × pinned to the card's top-right by the shared
  // dismiss rule, which works on a card floating over a map and does not work
  // here: `.planlist` is no longer `position: fixed`, so the absolute × landed
  // against the DRAWER and stacked underneath the drawer's own close button.
  // Two ×s in one corner, and a tap on the wrong one closes the whole menu.
  //
  // It also says what it does now, which a × cannot. Dismissing this section
  // is not closing anything — the ranked scooters are immediately below and
  // that is where the rider lands, so "Pick a scooter myself" names the thing
  // that is about to happen.
  const close = el("button", "planlist__dismiss", "Pick a scooter myself");
  close.type = "button";
  close.addEventListener("click", () => deps.onCancel());

  const notes = el("div", "planlist__notes");
  // ABOVE THE PLANS, not below them. The free-minute figure is an INPUT to every
  // price in the list, so a rider who reads a price and then finds the control
  // has read a number they are about to be told was a guess.
  const free = el("div", "planlist__free");
  // Between the notes and the plans: it is about the list below it, and a
  // rider who sets a spec up wants the list to change under them.
  const specPrompt = el("div", "planlist__specprompt");
  specPrompt.hidden = true;
  // ABOVE THE PLANS, with the free-minute figure, because both are INPUTS to
  // every row below. A rider who reads a short list and only then finds the
  // filter that shortened it has been told the city is empty.
  const controls = el("div", "planlist__controls");
  const body = el("div", "planlist__body");
  panel.append(head, notes, free, controls, specPrompt, body, close);
  root.replaceChildren(panel);

  function renderNotes(v: PlanListView): void {
    const lines: { text: string; cls: string }[] = [];
    // The risk warning first. It is the only note that bears on whether a plan
    // will work at all, and a rider who stops reading after one line should
    // have read that one.
    if (v.riskWarning) lines.push({ text: v.riskWarning, cls: "planlist__note--warn" });
    if (v.relaxedLabels.length > 0) {
      lines.push({
        text: `To find anything we had to give up: ${v.relaxedLabels.join(", ")}.`,
        cls: "planlist__note--warn",
      });
    }
    if (v.capRelaxed) {
      lines.push({
        text:
          "We looked slightly further than your walking limit to avoid a " +
          "flagged scooter.",
        cls: "planlist__note--warn",
      });
    }
    // WHAT THE RIDER ASKED FOR, first among the quiet notes. It goes above the
    // cap and the ordering because it is the only one that answers "did this
    // list hear me at all" — and that question is why this note exists: the
    // interview's answer used to reach the scooter ranking and never the plans.
    if (v.interviewNote) {
      lines.push({ text: v.interviewNote, cls: "planlist__note--quiet" });
    }
    // The rider's own cap, said plainly. Not a warning — nothing went wrong and
    // nothing was given up by the search; they asked for this. But it goes
    // ABOVE the estimate note, because the question it answers ("why am I not
    // being shown the cheap one") is one somebody is asking right now.
    if (v.capNote) {
      lines.push({ text: v.capNote, cls: "planlist__note--quiet" });
    }
    // Why the order is not simply cheapest-first. Above the estimate note for
    // the same reason the cap note is: it answers a question somebody is
    // asking right now, looking at a list whose second row is cheaper than its
    // first.
    if (v.idealSplitNote) {
      lines.push({ text: v.idealSplitNote, cls: "planlist__note--quiet" });
    }
    lines.push({ text: v.estimateNote, cls: "planlist__note--quiet" });
    notes.replaceChildren(
      ...lines.map((l) => el("p", `planlist__note ${l.cls}`, l.text)),
    );
  }

  /** The offer to set up an ideal scooter, or nothing.
   *
   *  A PROMPT AND NOT A NAG. It appears only when there are multi-scooter
   *  plans on the list — the one case where the app would actually use the
   *  answer — and it is a plain row with a button, not a dismissible banner,
   *  because the thing that makes it go away is answering it.
   *
   *  The button is handed up rather than wired here: this module knows nothing
   *  about drawers, and the spec panel lives in one. Absent, the row still
   *  renders as a sentence, because "the app can do this and you have not set
   *  it up" is worth knowing even where this surface cannot open it.
   *
   *  It also says what it is FOR. "Set up your ideal scooter" alone is a
   *  chore; naming the consequence — that plans will favour it — is the part
   *  that makes it worth a tap. */
  function renderSpecPrompt(v: PlanListView): void {
    specPrompt.replaceChildren();
    specPrompt.hidden = !v.needsSpec;
    if (!v.needsSpec) return;
    specPrompt.append(
      el(
        "p",
        "planlist__note planlist__note--quiet",
        "No ideal scooter set up yet — tell us what you like and we'll put more of a split trip on it.",
      ),
    );
    if (deps.onConfigureSpec) {
      const btn = el("button", "planlist__again", "Set up my ideal scooter");
      btn.type = "button";
      btn.addEventListener("click", () => deps.onConfigureSpec?.());
      specPrompt.append(btn);
    }
  }

  function renderFree(v: PlanListView): void {
    const copy = v.freeMinutes;
    if (!copy) {
      // Null means this tier has no free hour. Nothing to show and nothing for
      // the rider to correct.
      free.replaceChildren();
      free.hidden = true;
      return;
    }
    free.hidden = false;
    const head2 = el("p", "planlist__freehead", copy.headline);
    const note = el("p", "planlist__freenote", copy.basisNote);
    const children: HTMLElement[] = [head2, note];

    if (deps.onCorrectFreeMinutes) {
      const row = el("div", "planlist__freerow");
      const id = "planlist-free-input";
      const label = el("label", "planlist__freelabel", copy.correctionLabel);
      label.htmlFor = id;
      const input = el("input", "planlist__freeinput");
      input.id = id;
      // `number` with bounds so a phone offers the numeric keypad and the
      // browser refuses an impossible figure before we have to.
      input.type = "number";
      input.min = "0";
      input.max = "60";
      input.step = "1";
      input.inputMode = "numeric";
      input.placeholder = "min";
      const save = el("button", "planlist__freesave", "Use this");
      save.type = "button";
      const commit = (): void => {
        if (destroyed) return;
        // `parseCorrection` owns the clamping and the refusal: an empty or
        // non-numeric box clears the correction rather than becoming a zero,
        // because "I did not answer" and "I have none left" are different
        // answers and only one of them is the rider's.
        deps.onCorrectFreeMinutes?.(parseCorrection(input.value));
      };
      save.addEventListener("click", commit);
      input.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") {
          e.preventDefault();
          commit();
        }
      });
      row.append(label, input, save);
      children.push(row);

      if (copy.corrected) {
        const undo = el("button", "planlist__freeundo", "Use our estimate instead");
        undo.type = "button";
        undo.addEventListener("click", () => {
          if (destroyed) return;
          deps.onCorrectFreeMinutes?.(null);
        });
        children.push(undo);
      }
    }
    free.replaceChildren(...children);
  }

  function renderRow(row: PlanRow): HTMLElement {
    const card = el("div", "planlist__row");
    if (row.isWalkOnly) card.classList.add("planlist__row--walk");

    const top = el("div", "planlist__rowhead");
    top.append(el("span", "planlist__headline", row.headline));
    const figures = el("span", "planlist__figures");
    figures.append(el("span", "planlist__mins", row.minutesLabel));
    // The walk costs nothing, and printing "$0.00" beside it reads as a price
    // we computed rather than the absence of one.
    if (!row.isWalkOnly) figures.append(el("span", "planlist__cost", row.costLabel));
    top.append(figures);
    card.append(top);

    if (row.chips.length > 0) {
      const chips = el("div", "planlist__chips");
      for (const chip of row.chips) {
        chips.append(el("span", `planlist__chip planlist__chip--${chip.kind}`, chip.text));
      }
      card.append(chips);
    }

    const legs = el("ol", "planlist__legs");
    for (const line of row.legLines) {
      legs.append(el("li", `planlist__leg planlist__leg--${line.mode}`, line.text));
    }
    card.append(legs);

    // §5.2: the disclosures travel with the plan, in the plan's own details,
    // where a rider opens any plan they are considering. Collapsed, not hidden
    // — a <details> is still in the document and still findable, which an
    // off-screen drawer is not.
    if (row.disclosures.length > 0) {
      const details = el("details", "planlist__why");
      details.append(el("summary", "planlist__whysummary", "Why this is cheaper"));
      const list = el("ul", "planlist__whylist");
      for (const d of row.disclosures) {
        list.append(el("li", `planlist__whyitem planlist__whyitem--${d.kind}`, d.text));
      }
      details.append(list);
      card.append(details);
    }

    // `isWalkOnly` OR nothing to walk to: two conditions for one button because
    // the consequence of getting it wrong is the thing this row exists to avoid.
    // A row with no `firstVehicle` has nowhere to send the rider, and
    // `onChoose` would return silently — a button that does nothing when tapped,
    // which is worse than no button and indistinguishable from a broken app.
    if (row.isWalkOnly || row.firstVehicle === null) {
      card.append(
        el(
          "p",
          "planlist__note planlist__note--quiet",
          row.isWalkOnly
            ? "No scooter needed — set off whenever you like."
            : "We cannot point you at this one's first scooter — try Look again.",
        ),
      );
      return card;
    }

    const actions = el("div", "planlist__actions");
    const go = el("button", "planlist__go", "Take this one");
    go.type = "button";
    go.addEventListener("click", () => {
      if (destroyed) return;
      deps.onChoose(row);
    });
    actions.append(go);

    // 🔍 WHERE DO I SWAP. Only on a row that HAS a hand-off, and only when the
    // host can act on it.
    //
    // The hand-off is the one part of a split plan the text cannot convey.
    // "Park it and take another" names an action, not a PLACE — and the place
    // is what decides whether the plan is acceptable at all: a swap on the
    // rider's own route is nothing, a swap three blocks off it is the reason to
    // pick a different row. So this is a LOOK and not a commitment: it puts the
    // vehicle on the map and leaves the plan unchosen, which is why it sits
    // beside "Take this one" rather than replacing it.
    if (row.switchoverVehicle && deps.onShowSwitchover) {
      const peek = el("button", "planlist__peek", "🔍");
      peek.type = "button";
      // The glyph is decorative and unreadable to a screen reader; the label
      // carries the whole meaning, and names the SWAP rather than the icon.
      peek.setAttribute("aria-label", "Show me where I swap scooters");
      peek.title = "Show me where I swap scooters";
      peek.addEventListener("click", () => {
        if (destroyed) return;
        deps.onShowSwitchover?.(row);
      });
      actions.append(peek);
    }
    card.append(actions);
    return card;
  }

  function renderBody(v: PlanListView): void {
    if (v.rows.length === 0) {
      // Reachable only with an empty fleet AND no walk-only plan, which
      // `rankPlans` does not produce today. Said plainly rather than rendered
      // as an empty box, because a blank panel reads as a bug.
      body.replaceChildren(
        el(
          "p",
          "planlist__note planlist__note--warn",
          "Nothing we can offer right now — no scooter nearby matches what you asked for.",
        ),
      );
      return;
    }
    body.replaceChildren(...v.rows.map((row) => renderRow(row)));
  }

  // NO SCROLL-EDGE FADE ANY MORE. This card used to be a fixed overlay and so
  // its own scroll container, which clipped a half-scrolled row's button flat
  // against its bottom edge; a `mask-image` fade and an `is-at-end` class
  // existed to make that read as "there is more below". The card is a section
  // inside the Recommended drawer now, and the DRAWER scrolls — so there is no
  // inner edge to clip anything, and nothing for the panel to measure. CSS
  // cannot ask whether a box overflows, which is why this had to live here;
  // once the box stopped overflowing, so did the reason.

  /** "Proceed with your ideal scooter?" and the three interview answers.
   *
   *  ONE BLOCK because they are one question asked twice over: the sheet is the
   *  standing answer and the priority is this trip's. Separating them would put
   *  two preference controls in one card with nothing saying how they relate.
   *
   *  Rendered only where there is something to decide — no sheet and no
   *  `onSetPriority` wiring means an empty block, which `:empty` hides. */
  function renderControls(v: PlanListView): void {
    controls.replaceChildren();
    if (v.idealSpec) {
      const row = el("div", "planlist__specrow");
      const label = el("label", "planlist__specswitch");
      const box = el("input");
      box.type = "checkbox";
      box.checked = v.idealSpec.inUse;
      // Disabled rather than hidden when the host cannot act on it: the
      // SENTENCE is the useful part, and a live-looking switch that does
      // nothing is worse than a plain statement.
      box.disabled = !deps.onToggleIdealSpec;
      box.addEventListener("change", () => deps.onToggleIdealSpec?.(box.checked));
      label.append(box, el("span", undefined, "Use my ideal scooter"));
      row.append(label);
      row.append(el("p", "planlist__specsummary", v.idealSpec.summary));
      if (deps.onConfigureSpec) {
        const edit = el("button", "planlist__specedit", "Configure");
        edit.type = "button";
        edit.addEventListener("click", () => deps.onConfigureSpec?.());
        row.append(edit);
      }
      controls.append(row);
    }
    if (deps.onSetPriority) {
      const current = deps.priority?.() ?? null;
      const group = el("div", "planlist__prio");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "What matters most");
      group.append(el("p", "planlist__priohead", "What matters most"));
      for (const opt of PRIORITY_OPTIONS) {
        const btn = el("button", "planlist__priobtn", opt.label);
        btn.type = "button";
        const on = current === opt.value;
        btn.classList.toggle("is-on", on);
        // `aria-pressed` and not `aria-selected`: these are toggle buttons in a
        // group, not tabs, and nothing here reveals a panel.
        btn.setAttribute("aria-pressed", String(on));
        btn.addEventListener("click", () => deps.onSetPriority?.(opt.value));
        group.append(btn);
      }
      controls.append(group);
    }
  }

  function render(v: PlanListView): void {
    renderNotes(v);
    renderControls(v);
    renderFree(v);
    renderSpecPrompt(v);
    renderBody(v);
    if (deps.onRefresh) {
      const again = el("button", "planlist__again", "Look again");
      again.type = "button";
      again.addEventListener("click", () => deps.onRefresh?.());
      body.append(again);
    }
  }

  render(view);

  return {
    update(next) {
      if (destroyed) return;
      render(next);
    },
    destroy() {
      destroyed = true;
      root.replaceChildren();
    },
  };
}
