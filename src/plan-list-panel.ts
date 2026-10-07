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
}

export interface PlanListPanelHandle {
  /** Repaint against a fresh search. Keeps the panel open, because a rider
   *  mid-read should not have it close under them. */
  update(view: PlanListView): void;
  destroy(): void;
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

export function createPlanListPanel(
  root: HTMLElement,
  view: PlanListView,
  deps: PlanListPanelDeps,
): PlanListPanelHandle {
  let destroyed = false;

  const panel = el("div", "planlist");
  const head = el("div", "planlist__head");
  head.append(el("div", "planlist__title", "How to get there"));
  // Shape, size and centring come from style.css's shared dismiss rule, which
  // `.planlist__close` is listed in — a dismiss is the one control that is the
  // same shape everywhere in the app.
  const close = el("button", "planlist__close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => deps.onCancel());

  const notes = el("div", "planlist__notes");
  // ABOVE THE PLANS, not below them. The free-minute figure is an INPUT to every
  // price in the list, so a rider who reads a price and then finds the control
  // has read a number they are about to be told was a guess.
  const free = el("div", "planlist__free");
  const body = el("div", "planlist__body");
  panel.append(head, close, notes, free, body);
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
    lines.push({ text: v.estimateNote, cls: "planlist__note--quiet" });
    notes.replaceChildren(
      ...lines.map((l) => el("p", `planlist__note ${l.cls}`, l.text)),
    );
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

    const go = el("button", "planlist__go", "Take this one");
    go.type = "button";
    go.addEventListener("click", () => {
      if (destroyed) return;
      deps.onChoose(row);
    });
    card.append(go);
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

  function render(v: PlanListView): void {
    renderNotes(v);
    renderFree(v);
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
