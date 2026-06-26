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

type Version = "v1" | "v2";

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
  // Fetch both feeds in parallel. The "current" snapshot is the high-cadence
  // readout; the daily SLA window is the contractually-binding number. Each
  // can fail independently — a missing one renders as a pending row rather
  // than blowing up the whole card. Each is time-boxed so a slow/hung endpoint
  // can't pin the card on its loading state forever.
  let snapshotR: PromiseSettledResult<SnapshotMetadataResponse>;
  let slaR: PromiseSettledResult<ComplianceResponse>;
  try {
    [snapshotR, slaR] = await Promise.allSettled([
      withTimeout(fetchLatestSnapshot, COMPLIANCE_FETCH_TIMEOUT_MS),
      withTimeout(fetchCompliance, COMPLIANCE_FETCH_TIMEOUT_MS),
    ]);
  } catch (err) {
    // Promise.allSettled never rejects, so reaching here means something
    // unexpected blew up before the await resolved. Replace the loading state
    // regardless so the card can never be stuck "Loading…" forever.
    console.error("compliance render failed", err);
    const card = el("div", "compliance__card");
    card.append(el("span", "compliance__title", "Equity compliance"));
    card.append(
      el(
        "div",
        "compliance__foot",
        "Compliance data is temporarily unavailable.",
      ),
    );
    root.replaceChildren(card);
    return;
  }

  const snapshot = snapshotR.status === "fulfilled" ? snapshotR.value : null;
  const sla = slaR.status === "fulfilled" ? slaR.value : null;

  // Hard failure only if BOTH feeds errored with something other than
  // NoDataError. Otherwise we can show partial data.
  if (!snapshot && !sla) {
    const card = el("div", "compliance__card");
    card.append(el("span", "compliance__title", "Equity compliance"));
    const reason = pendingReason(snapshotR, slaR);
    card.append(
      el("div", "compliance__foot", reason),
    );
    root.replaceChildren(card);
    return;
  }

  const card = el("div", "compliance__card");
  card.append(renderVersionSection("v1", snapshot, sla));
  card.append(renderVersionSection("v2", snapshot, sla));
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
}

function renderVersionSection(
  v: Version,
  snapshot: SnapshotMetadataResponse | null,
  sla: ComplianceResponse | null,
): HTMLElement {
  const section = el("section", "compliance__section");

  const head = el("div", "compliance__head");
  const title = el(
    "span",
    "compliance__title",
    `${v.toUpperCase()} Disadvantaged Areas Map`,
  );
  head.append(title);
  if (sla) {
    const pass = v === "v1" ? sla.compliance_v1_pass : sla.compliance_v2_pass;
    head.append(
      el(
        "span",
        `compliance__pill ${pass ? "is-pass" : "is-fail"}`,
        pass ? "PASS" : "FAIL",
      ),
    );
  }
  section.append(head);

  const currentPct =
    v === "v1"
      ? snapshot?.percent_all_devices_v1 ?? null
      : snapshot?.percent_all_devices_v2 ?? null;
  const slaPct = sla
    ? v === "v1"
      ? sla.avg_percent_all_devices_v1
      : sla.avg_percent_all_devices_v2
    : null;
  const slaPass = sla
    ? v === "v1"
      ? sla.compliance_v1_pass
      : sla.compliance_v2_pass
    : null;

  section.append(renderRow(`Current %`, currentPct, evalPass(currentPct)));
  section.append(renderRow(`SLA Window %`, slaPct, slaPass));

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
