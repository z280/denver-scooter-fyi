// Scan-to-identify — "what is this scooter, and why isn't it on my map?"
// (docs/FLEET_REPORTS_PLAN.md §2.7, §4.2(4)-(6); API.md `/vehicles/resolve`
// with `explain=true`).
//
// A rider standing in front of a scooter the map does not show reads its
// absence as a bug in the app. The client cannot look past its own feed —
// `vehicle_identifier` is a salted hash only the server can compute — so the
// identify call goes to the server, which reads `device_state` and answers for
// vehicles that have LEFT the feed too.
//
// WHICH REASON, SAID IN ITS OWN SENTENCE. The plan's four-way table, as the
// owner's 2026-10-09 rules leave it:
//
//   on the map    It is there. If it carries a report it is labelled High risk
//                 (or Unknown risk) — reports never hide a scooter any more, so
//                 the plan's "suppressed" reason no longer exists.
//   filtered      It is there, and the rider's OWN filters hide it — the one
//                 reason they can fix, so we offer to.
//   missing       Veo's feed stopped carrying it. When and roughly where (the
//                 API rounds `last_seen` to ~100 m) we last saw it.
//   gone          Missing, and an admin confirmed it is not coming back.
//
// Plus the ways a scan can fail to name anything at all. None of them falls
// through to a generic "we don't know about this scooter" — that is exactly
// the dead end this exists to remove.
//
// Read-only: identifying changes nothing, earns nothing and needs no session
// (the endpoint is public, 30/min per IP).

import { ApiError, NoDataError, fetchIdentify } from "./api.ts";
import { plateFromQr } from "./qr-utility.ts";
import {
  denverShortDate,
  reportRisk,
  reportRiskNote,
  reportTypeLabel,
} from "./report-labels.ts";
import { RELIABILITY_LABEL } from "./reliability.ts";

export interface IdentifyOpenReport {
  report_type: string;
  reason: string | null;
  reported_at: string | null;
  risk: "high_risk" | "unknown" | string | null;
}

export interface IdentifyResponse {
  device_id: string | null;
  vehicle_identifier: string;
  status: "on_map" | "missing" | "gone" | string;
  negative_report_risk?: "high_risk" | "unknown" | null;
  negative_report_reason?: string | null;
  negative_report_reason_detail?: string | null;
  negative_report_since?: string | null;
  open_reports?: IdentifyOpenReport[];
  last_observed_at?: string | null;
  hours_missing?: number | null;
  last_seen?: { lat: number; lon: number } | null;
  gone_acknowledged_at?: string | null;
  public_name?: string | null;
  vehicle_model_name?: string | null;
  form_factor?: string | null;
  as_of?: string | null;
}

export type IdentifyOutcome =
  | { kind: "found"; data: IdentifyResponse }
  /** Nothing in the payload could be a plate — no request was made. */
  | { kind: "unreadable" }
  /** No vehicle we have ever tracked carries the plate (or more than one). */
  | { kind: "never_tracked" }
  | { kind: "rate_limited"; retryAfter?: number }
  | { kind: "error" };

/** `GET /api/v1/vehicles/resolve?qr=…&explain=true`. Never rejects. A payload
 *  `plateFromQr` reads as nothing (a wifi code, a URL) is `unreadable` without
 *  a network call; the server's own `400 unreadable` maps to the same. */
export async function identifyScan(
  rawValue: string,
  get: (raw: string) => Promise<IdentifyResponse> = fetchIdentify<IdentifyResponse>,
): Promise<IdentifyOutcome> {
  if (plateFromQr(rawValue) === null) return { kind: "unreadable" };
  try {
    const data = await get(rawValue);
    return { kind: "found", data };
  } catch (err) {
    if (err instanceof NoDataError && err.status === 404) return { kind: "never_tracked" };
    if (err instanceof ApiError) {
      if (err.status === 429) return { kind: "rate_limited", retryAfter: err.retryAfter };
      if (err.status === 400) return { kind: "unreadable" };
    }
    return { kind: "error" };
  }
}

/** What the map can say about a vehicle the server says is on it. */
export type MapVisibility =
  /** Drawn on the rider's map right now. */
  | "visible"
  /** In the client's feed, but the rider's own filters hide it. */
  | "filtered"
  /** In the feed, out of service or reserved — hidden by the map's default
   *  "hide unavailable" setting. */
  | "unavailable"
  /** Not in the client's copy of the feed (it is older than the server's). */
  | "absent";

export interface IdentifyContext {
  visibility(deviceId: string | null, vehicleIdentifier: string): MapVisibility;
  /** "Models: Cosmo · ≥ 50%" — the live filters, or "". */
  filterSummary(): string;
  now?: number;
}

export type IdentifyAction = "show" | "clear_filters" | "last_seen";

export interface IdentifyView {
  /** "Lunar 🐸 · Apollo", or a plain fallback. */
  title: string;
  /** Machine-readable reason, for tests and telemetry. */
  reason:
    | "on_map"
    | "filtered"
    | "unavailable"
    | "stale_feed"
    | "missing"
    | "gone"
    | "unreadable"
    | "never_tracked"
    | "rate_limited"
    | "error";
  lines: string[];
  actions: IdentifyAction[];
}

function ago(hours: number): string {
  if (hours < 1) return "under an hour ago";
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(hours / 24);
  return `${d} days ago`;
}

/** The report lines, for every status: the label it carries and what stands. */
function reportLines(d: IdentifyResponse): string[] {
  const lines: string[] = [];
  const r = reportRisk(d);
  if (r) {
    const since = denverShortDate(d.negative_report_since);
    const label = r.risk === "high_risk" ? RELIABILITY_LABEL.risk : RELIABILITY_LABEL.unknown;
    lines.push(`Labelled ${label}: ${r.phrase}${since ? ` (since ${since})` : ""}.`);
    const note = reportRiskNote(d);
    if (note) lines.push(note);
  }
  const open = d.open_reports ?? [];
  if (open.length > 0) {
    lines.push(
      "Open reports: " +
        open
          .map((o) => {
            const date = denverShortDate(o.reported_at);
            return (
              reportTypeLabel(o.report_type, o.reason) +
              (date ? ` · ${date}` : "") +
              (o.risk === "unknown" ? " (anonymous, unconfirmed)" : "")
            );
          })
          .join("; ") +
        ".",
    );
    lines.push("Reports clear when the scooter is moved 100 m or more (and charged, if it wouldn't ride), or when a rider's test ride says it's fixed.");
  }
  return lines;
}

/** Turn an outcome into the card. Pure. */
export function identifyView(outcome: IdentifyOutcome, ctx: IdentifyContext): IdentifyView {
  switch (outcome.kind) {
    case "unreadable":
      return {
        title: "Not a scooter code",
        reason: "unreadable",
        lines: ["That doesn't look like a scooter's QR code. Try the sticker on the handlebar stem."],
        actions: [],
      };
    case "never_tracked":
      return {
        title: "Unknown scooter",
        reason: "never_tracked",
        lines: ["We've never tracked a scooter with that plate. It may be brand new, or not a Veo."],
        actions: [],
      };
    case "rate_limited":
      return {
        title: "Too many scans",
        reason: "rate_limited",
        lines: ["That's a lot of lookups in a minute — wait a moment and scan again."],
        actions: [],
      };
    case "error":
      return {
        title: "Couldn't look it up",
        reason: "error",
        lines: ["Couldn't reach us — check your connection and scan again."],
        actions: [],
      };
  }

  const d = outcome.data;
  const title =
    [d.public_name, d.vehicle_model_name ? `Veo ${d.vehicle_model_name}` : null]
      .filter(Boolean)
      .join(" · ") || (d.form_factor === "bicycle" ? "E-bike" : "Scooter");
  const reports = reportLines(d);

  if (d.status === "gone") {
    const since = denverShortDate(d.gone_acknowledged_at ?? d.last_observed_at);
    return {
      title,
      reason: "gone",
      lines: [
        `This scooter is permanently gone from the fleet${since ? ` (confirmed ${since})` : ""}. It won't be back on the map.`,
        ...reports,
      ],
      actions: [],
    };
  }

  if (d.status === "missing") {
    const when =
      typeof d.hours_missing === "number" && Number.isFinite(d.hours_missing)
        ? ago(d.hours_missing)
        : null;
    const lastDate = denverShortDate(d.last_observed_at);
    return {
      title,
      reason: "missing",
      lines: [
        `Veo's feed stopped showing this scooter${when ? ` ${when}` : ""}${lastDate ? ` (last seen ${lastDate})` : ""}. It may be in a van for charging or repair, or switched off.`,
        ...(d.last_seen ? ["We can show roughly where we last saw it (to within about 100 m)."] : []),
        ...reports,
      ],
      actions: d.last_seen ? ["last_seen"] : [],
    };
  }

  // On the map — always, whatever its reports say.
  const vis = ctx.visibility(d.device_id, d.vehicle_identifier);
  if (vis === "filtered") {
    const summary = ctx.filterSummary();
    return {
      title,
      reason: "filtered",
      lines: [
        `It's on the map, but your filters hide it${summary ? ` (${summary})` : ""}.`,
        ...reports,
      ],
      actions: ["clear_filters"],
    };
  }
  if (vis === "unavailable") {
    return {
      title,
      reason: "unavailable",
      lines: [
        "It's on the map, but Veo has it out of service or reserved right now, and the map hides those by default (Filters → show unavailable).",
        ...reports,
      ],
      actions: [],
    };
  }
  if (vis === "absent") {
    return {
      title,
      reason: "stale_feed",
      lines: [
        "It's in the latest feed, newer than your map — it'll appear on the next refresh.",
        ...reports,
      ],
      actions: [],
    };
  }
  return {
    title,
    reason: "on_map",
    lines: [
      reports.length > 0 ? "It's on the map." : "It's on the map, with no open reports.",
      ...reports,
    ],
    actions: ["show"],
  };
}
