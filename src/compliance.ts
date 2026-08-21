import {
  fetchCompliance,
  fetchLatestSnapshot,
  NoDataError,
  type ComplianceResponse,
  type SnapshotMetadataResponse,
} from "./api.ts";
import { COMPLIANCE_THRESHOLD } from "./config.ts";

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

// The card used to render TWO sections, "V1 Disadvantaged Areas Map" and
// "V2", side by side — the two candidate equity maps, shown together
// because the city had not said which one the contract bound. It said, in
// August 2026: neither, it is the official Equity Area map. So the card
// reports ONE number now, against that map.
//
// The v1/v2 fields are still on the wire and still the record for the
// period before the clarification. They are not rendered here: a compliance
// card whose job is to answer "is Veo meeting the contract today" should
// not present three candidate answers to a question with one.

/** Per-feed network budget. Without this, a single stalled endpoint keeps its
 *  fetch pending forever; because we render via Promise.allSettled (waits for
 *  BOTH), one hung feed leaves the whole card stuck on "Loading…" indefinitely.
 *  A bounded timeout turns "hung" into "unavailable" so the card always renders. */
const COMPLIANCE_FETCH_TIMEOUT_MS = 12_000;

/** Run a signal-accepting fetch with a hard timeout. On expiry the underlying
 *  request is aborted and the promise rejects (caught by allSettled), so the
 *  feed renders as pending/unavailable rather than blocking the card. */
function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

export async function renderCompliance(root: HTMLElement): Promise<void> {
  // Everything below — fetching AND building the DOM — runs inside one guard.
  // The loading placeholder is static markup; the ONLY thing that clears it is
  // a successful replaceChildren() at the end. So any unhandled throw (a hung
  // feed, a value the render code chokes on) would otherwise leave the card
  // stuck on "Loading…" forever. The catch guarantees we always replace it.
  try {
    // Fetch both feeds in parallel. The "current" snapshot is the high-cadence
    // readout; the daily SLA window is the contractually-binding number. Each
    // can fail independently — a missing one renders as a pending row rather
    // than blowing up the whole card. Each is time-boxed so a slow/hung
    // endpoint can't pin the card on its loading state forever.
    const [snapshotR, slaR] = await Promise.allSettled([
      withTimeout(fetchLatestSnapshot, COMPLIANCE_FETCH_TIMEOUT_MS),
      withTimeout(fetchCompliance, COMPLIANCE_FETCH_TIMEOUT_MS),
    ]);

    const snapshot = snapshotR.status === "fulfilled" ? snapshotR.value : null;
    const sla = slaR.status === "fulfilled" ? slaR.value : null;

    // Hard failure only if BOTH feeds errored with something other than
    // NoDataError. Otherwise we can show partial data.
    if (!snapshot && !sla) {
      const card = el("div", "compliance__card");
      card.append(el("span", "compliance__title", "Equity compliance"));
      card.append(el("div", "compliance__foot", pendingReason(snapshotR, slaR)));
      root.replaceChildren(card);
      return;
    }

    const card = el("div", "compliance__card");
    card.append(renderOfficialSection(snapshot, sla));
    if (sla) {
      card.append(
        el(
          "div",
          "compliance__foot",
          `Target ≥ ${COMPLIANCE_THRESHOLD}% · SLA window ${sla.sla_date}`,
        ),
      );
    }
    root.replaceChildren(card);
  } catch (err) {
    console.error("compliance render failed", err);
    const card = el("div", "compliance__card");
    card.append(el("span", "compliance__title", "Equity compliance"));
    card.append(
      el("div", "compliance__foot", "Compliance data is temporarily unavailable."),
    );
    root.replaceChildren(card);
  }
}

function renderOfficialSection(
  snapshot: SnapshotMetadataResponse | null,
  sla: ComplianceResponse | null,
): HTMLElement {
  const section = el("section", "compliance__section");

  const head = el("div", "compliance__head");
  head.append(el("span", "compliance__title", "Official Equity Area Map"));

  const currentPct = toNum(snapshot?.percent_all_devices_equity);
  const slaPct = toNum(sla?.avg_percent_all_devices_equity);
  // Only the SERVER's boolean colors the pill. Deriving it here from the
  // percentage would mean a rounding difference between the two could show
  // a PASS pill over a failing number.
  const slaPass = sla?.compliance_equity_pass ?? null;

  if (slaPass !== null) {
    head.append(
      el(
        "span",
        `compliance__pill ${slaPass ? "is-pass" : "is-fail"}`,
        slaPass ? "PASS" : "FAIL",
      ),
    );
  }
  section.append(head);

  section.append(renderRow("Current %", currentPct, evalPass(currentPct)));
  section.append(renderRow("SLA Window %", slaPct, slaPass));

  // An SLA row exists but carries no equity figure. That is a real, nameable
  // state, not an error: the day predates the official map and the server's
  // reprocessing job has not reached it yet. Saying so beats two "—" rows
  // that read as a broken card, and beats a 0% that reads as a failure.
  if (sla && slaPct === null) {
    section.append(
      el(
        "div",
        "compliance__foot",
        "This day predates the city's official Equity Area map — it's being " +
          "reprocessed against it. Check the calendar for days already done.",
      ),
    );
  }

  return section;
}

/** A label + value + bar triplet. Renders a pending-style row when value
 *  is null. `pass` only colors the fill; missing values stay neutral. */
function renderRow(
  label: string,
  value: number | null,
  pass: boolean | null,
): HTMLElement {
  const row = el("div", "compliance__row");

  const header = el("div", "compliance__row-head");
  header.append(el("span", "compliance__row-label", label));
  header.append(
    el(
      "span",
      "compliance__row-value",
      value === null ? "—" : `${value.toFixed(1)}%`,
    ),
  );
  row.append(header);

  const bar = el("div", "compliance__bar");
  bar.setAttribute("role", "img");
  bar.setAttribute(
    "aria-label",
    value === null
      ? `${label}: no data`
      : `${label}: ${value.toFixed(1)} percent, target ≥ ${COMPLIANCE_THRESHOLD} percent`,
  );
  if (value !== null) {
    const fillClass =
      pass === null ? "" : pass ? " is-pass" : " is-fail";
    const fill = el("div", `compliance__fill${fillClass}`);
    fill.style.width = `${Math.min(100, Math.max(0, value))}%`;
    bar.append(fill);
  }
  const threshold = el("div", "compliance__threshold");
  threshold.style.left = `${COMPLIANCE_THRESHOLD}%`;
  threshold.title = `${COMPLIANCE_THRESHOLD}% target`;
  bar.append(threshold);
  row.append(bar);

  return row;
}

/** Coerce an API numeric field to a real number. The upstream serializes some
 *  decimal columns as JSON strings (e.g. `"21.82"`), and the per-device/percent
 *  fields are nullable. Calling `.toFixed()` on a string throws — and since the
 *  render runs after the fetch, that throw would leave the card stuck on its
 *  loading state. Returns null for null/undefined/blank/non-finite input so the
 *  row renders as pending ("—") instead of blowing up. */
function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Per-bar pass evaluation when we don't have an authoritative SLA boolean
 *  (i.e. the "Current %" row, which isn't itself the binding metric). */
function evalPass(pct: number | null): boolean | null {
  if (pct === null) return null;
  return pct >= COMPLIANCE_THRESHOLD;
}

function pendingReason(
  snapshotR: PromiseSettledResult<unknown>,
  slaR: PromiseSettledResult<unknown>,
): string {
  const slaNoData =
    slaR.status === "rejected" && slaR.reason instanceof NoDataError;
  const snapshotNoData =
    snapshotR.status === "rejected" && snapshotR.reason instanceof NoDataError;
  if (slaNoData && snapshotNoData) {
    return "No compliance snapshots have landed yet.";
  }
  return "Compliance data is temporarily unavailable.";
}
