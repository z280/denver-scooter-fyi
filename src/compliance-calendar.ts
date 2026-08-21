// 📅 Compliance calendar — did Veo hit the contract's equity-area target,
// day by day, for this calendar month and last.
//
// The daily SLA card answers "today". This answers "how often", which is a
// different and harder question to dodge: one missed morning is an
// operational hiccup, twenty-six of them in a row is the shape of a
// contract not being honored, and only a calendar makes the difference
// visible at a glance.
//
// WHY FOUR COLORS AND NOT TWO ---------------------------------------------
// The obvious build is red/green. It would be wrong, because "not green"
// covers three unrelated things:
//
//   pass    — the 6-9 AM window average met the 30% target
//   fail    — it did not
//   no data — the nightly job never computed that day (an outage, a gap)
//   pending — the day predates the city's official Equity Area map, and the
//             server's reprocessing job hasn't rebuilt it yet
//
// Painting the last two red would accuse Veo of missing a target on days
// nobody has measured. This app's whole standing rests on its numbers being
// defensible, so a day we cannot speak to is drawn as a day we cannot speak
// to. The server already distinguishes all four (see the API's
// /api/v1/compliance/calendar); this renders what it says rather than
// collapsing it.

import {
  fetchComplianceCalendar,
  type ComplianceCalendarDay,
  type ComplianceCalendarMonth,
  type ComplianceCalendarResponse,
} from "./api.ts";
import { openFloatingModal } from "./devices.ts";

/** Sunday-first, matching the US calendar convention riders expect. */
const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

const STATUS_LABEL: Record<ComplianceCalendarDay["status"], string> = {
  pass: "met the 30% target",
  fail: "missed the 30% target",
  no_data: "no data",
  pending: "not yet reprocessed",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "2026-08" -> "August 2026". Parsed as UTC noon deliberately: `new
 *  Date("2026-08-01")` is midnight UTC, which in Denver is July 31st, so a
 *  naive parse labels every month with the previous one's name. */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Which weekday column a YYYY-MM-DD date starts in (0 = Sunday).
 *
 *  Same UTC-noon trick, same reason: a date-only string is parsed as UTC,
 *  and `getDay()` reads local time, so west of Greenwich every date would
 *  land one column early. */
export function weekdayIndex(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/** One month's grid. Pure — the interesting logic (leading blanks, the four
 *  statuses, future days) is all here and testable without a DOM. */
export function monthGridHtml(month: ComplianceCalendarMonth): string {
  const heads = WEEKDAY_INITIALS.map(
    (w, i) =>
      `<div class="cal__weekday" aria-hidden="true" data-col="${i}">${w}</div>`,
  ).join("");

  // Leading blanks so the 1st lands in its real weekday column. Without
  // these the grid is still seven-wide but no longer a calendar — nobody
  // could match a cell to a day they remember.
  const lead = weekdayIndex(month.first_date);
  const blanks = Array.from(
    { length: lead },
    () => `<div class="cal__cell cal__cell--blank" aria-hidden="true"></div>`,
  ).join("");

  const cells = month.days
    .map((d) => {
      const dayNum = Number(d.date.slice(8, 10));
      // A day that hasn't happened is drawn as an empty slot, not as
      // missing data — nobody is owed a compliance number for tomorrow.
      const cls = d.in_future
        ? "cal__cell cal__cell--future"
        : `cal__cell is-${d.status.replace("_", "-")}`;
      const pct = d.percent === null ? "" : ` — ${d.percent.toFixed(1)}%`;
      const title = d.in_future
        ? `${d.date} — hasn't happened yet`
        : `${d.date} — ${STATUS_LABEL[d.status]}${pct}`;
      return (
        `<div class="${cls}" role="listitem" title="${escapeHtml(title)}" ` +
        `aria-label="${escapeHtml(title)}"><span class="cal__num">${dayNum}</span></div>`
      );
    })
    .join("");

  const met = month.pass_days;
  const missed = month.fail_days;
  const scored = met + missed;
  // "4 of 31" would be a lie on a month that is half over or half
  // unreprocessed. The denominator is the days we can actually speak to.
  const summary = scored
    ? `${met} of ${scored} measured day${scored === 1 ? "" : "s"} met the target`
    : "No measured days yet";

  return `
    <section class="cal__month">
      <h4 class="cal__title">${escapeHtml(monthTitle(month.month))}</h4>
      <div class="cal__grid" role="list">
        ${heads}${blanks}${cells}
      </div>
      <p class="cal__summary">${escapeHtml(summary)}</p>
    </section>`;
}

/** The full modal body for a loaded calendar. */
export function calendarHtml(data: ComplianceCalendarResponse): string {
  const months = data.months.map(monthGridHtml).join("");
  const anyPending = data.months.some((m) =>
    m.days.some((d) => d.status === "pending"),
  );
  // Only explain the pending color when there is one on screen. A legend
  // entry for a state the reader cannot see is just more to read.
  const pendingKey = anyPending
    ? `<span class="cal__key"><i class="cal__swatch is-pending"></i>Reprocessing</span>`
    : "";
  const pendingNote = anyPending
    ? `<p class="cal__note">Grey-striped days predate the city's official
       Equity Area map. They're being recomputed against it — that's a gap in
       our records, not a day Veo missed.</p>`
    : "";

  return `
    <div class="cal">
      <p class="cal__lede">
        The Veo contract requires ${data.threshold}% of the active fleet to be
        deployed in equity areas, averaged over the 6–9am window. Green days
        met it.
      </p>
      <div class="cal__legend">
        <span class="cal__key"><i class="cal__swatch is-pass"></i>Met</span>
        <span class="cal__key"><i class="cal__swatch is-fail"></i>Missed</span>
        <span class="cal__key"><i class="cal__swatch is-no-data"></i>No data</span>
        ${pendingKey}
      </div>
      ${months}
      ${pendingNote}
      <p class="cal__note cal__note--source">
        Measured against the City of Denver's official Equity Area map.
        Source: data.scooter.fyi.
      </p>
    </div>`;
}

/** Rider-facing text for a failed load. Deliberately does NOT say "Veo is
 *  non-compliant" or anything of the sort — our own endpoint being down
 *  says nothing about Veo. */
export function errorHtml(): string {
  return `
    <div class="cal">
      <p class="cal__lede">The compliance calendar isn't available right now.</p>
      <p class="cal__note">
        That's our data feed, not a verdict on Veo — try again in a minute.
      </p>
    </div>`;
}

/**
 * Open the calendar. Renders a loading state immediately, then swaps in the
 * grid: the fetch crosses the network and a modal that appears only after
 * it lands reads as a dead button.
 *
 * `fetcher` is injectable for tests.
 */
export function openComplianceCalendar(
  fetcher: (months?: number) => Promise<ComplianceCalendarResponse> =
    fetchComplianceCalendar,
): void {
  openFloatingModal(
    "Compliance calendar",
    `<div class="cal cal--loading" id="compliance-calendar-body">Loading…</div>`,
    (root) => {
      const body = root?.querySelector<HTMLElement>("#compliance-calendar-body");
      if (!body) return;
      void fetcher(2)
        .then((data) => {
          // The modal may have been closed while the fetch was in flight;
          // writing into a detached node is harmless but pointless.
          if (!body.isConnected) return;
          body.outerHTML = calendarHtml(data);
        })
        .catch((e) => {
          console.error("compliance calendar failed", e);
          if (body.isConnected) body.outerHTML = errorHtml();
        });
    },
  );
}
