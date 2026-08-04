// Crowdsourced model reports: when the fleet shows a vehicle whose model we
// don't recognize ("Veo Unknown"), riders can tell us what it is with a
// short description and an optional photo. Posts multipart to the API's
// report-ingestion surface (see "Rider reports" in the backend's API.md — a new
// /reports/model endpoint). Anonymous is allowed; a bearer token rides along
// when the user happens to be signed in so the report can be weighted.

import { API_BASE } from "./api.ts";
import { getAuth } from "./map-auth.js";

/** The device-failure report types the API accepts (POST
 *  /api/v1/reports/device). `improperly_parked` is a parking-compliance
 *  report — it feeds the reports summary/export but, unlike the others, does
 *  NOT flip has_negative_report / reliability_tier server-side. */
export type DeviceReportType =
  /** Renamed from `failed_unlock` (scooter-fyi-api sql/037). Broader than "the
   *  unlock failed" — it is the rider's answer to "could you ride it?",
   *  matching the "Likely rideable" tier language on the map. */
  | "not_rideable"
  | "dead_battery"
  | "damaged"
  | "not_found"
  | "improperly_parked";

export interface DeviceReport {
  /** Stable per-vehicle HMAC (public). The API requires ≥16 chars. */
  vehicle_identifier: string;
  report_type: DeviceReportType;
  lat?: number;
  lng?: number;
}

/** One-tap device-failure report. Returns whether the API de-duped it
 *  against a recent identical report. Anonymous is allowed; a bearer token
 *  rides along when signed in. Throws on network/HTTP failure. */
export async function submitDeviceReport(
  report: DeviceReport,
): Promise<{ deduped: boolean }> {
  const body: Record<string, unknown> = {
    vehicle_identifier: report.vehicle_identifier,
    report_type: report.report_type,
  };
  // Field names must match the API's DeviceReportIn model (lat/lng). Sending
  // coords is what lets a report be regionalized in /reports/summary (which
  // skips rows with NULL lat/lng), so getting these keys right matters.
  if (report.lat !== undefined && report.lng !== undefined) {
    body.lat = report.lat;
    body.lng = report.lng;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const auth = getAuth();
  if (auth) headers.Authorization = `Bearer ${auth.token}`;

  const res = await fetch(`${API_BASE}/api/v1/reports/device`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Report failed (HTTP ${res.status})`);
  const data = (await res.json()) as { deduped?: boolean };
  return { deduped: data.deduped === true };
}

// --- Device features -------------------------------------------------------

/** One "☑️ Confirm Features" submission (POST
 *  /api/v1/reports/device-features). Field names match the API's
 *  `DeviceFeatureReportIn` exactly — getting one wrong is a 422, not a soft
 *  failure. */
export interface DeviceFeatureReport {
  /** Stable per-vehicle HMAC — exactly 16 lowercase hex chars. */
  vehicle_identifier: string;
  /** The rotating GBFS bike_id we had on screen. Audit trail only. */
  device_id?: string;
  /** As typed. NEVER validated or normalized here: the server owns the
   *  match rule, and a wrong plate is an accepted, unpaid report rather
   *  than an error — see the header of `device-features.ts` for why the
   *  client deliberately has no opinion about it. */
  submitted_plate: string;
  has_bell: boolean;
  has_cup_holder: boolean;
  has_phone_holder: boolean;
  /** Cosmo only — the one model the survey asks about a basket. Omitted
   *  entirely for every other model rather than sent as `false`, because a
   *  question nobody was shown has no answer to report; see
   *  `device-features.ts`'s `toRequestBody`. */
  has_basket?: boolean;
  /** Must equal `poor_condition.length === 0`. The API rejects the
   *  contradiction with a 422 rather than normalizing it. */
  all_good_condition: boolean;
  /** Subset of the features this same report says are present. */
  poor_condition: string[];
  lat?: number;
  lng?: number;
}

export interface DeviceFeatureReportResult {
  id: number;
  /** Did the typed plate match? `false` means stored, graded-out, unpaid. */
  plate_valid: boolean;
  points_awarded: number;
  /** The status the vehicle carried when the report landed — i.e. the one
   *  that chose the award. Not the status after: that isn't knowable until
   *  the server's ten-minute grading job runs. */
  feature_status: string;
  deduped: boolean;
}

/** Submit a device-feature confirmation. Anonymous is allowed (the report
 *  still counts toward the consensus, it just earns nothing); a bearer token
 *  rides along when signed in, which is what makes it points-eligible.
 *  Throws `ReportHttpError` on a non-2xx so the modal can distinguish a
 *  validation bug from a dropped connection. */
export async function submitDeviceFeatureReport(
  report: DeviceFeatureReport,
): Promise<DeviceFeatureReportResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const auth = getAuth();
  if (auth) headers.Authorization = `Bearer ${auth.token}`;

  const res = await fetch(`${API_BASE}/api/v1/reports/device-features`, {
    method: "POST",
    headers,
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new ReportHttpError(res.status);
  const data = (await res.json()) as Partial<DeviceFeatureReportResult>;
  return {
    id: Number(data.id ?? 0),
    plate_valid: data.plate_valid === true,
    points_awarded: Number(data.points_awarded ?? 0),
    feature_status: String(data.feature_status ?? "needs_features_confirmed"),
    deduped: data.deduped === true,
  };
}

/** A non-2xx response from a report POST. Carries the status so callers can
 *  distinguish "your session expired" (401 — the photo needs a bearer token,
 *  the description doesn't) from a generic failure. */
export class ReportHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Report failed (HTTP ${status})`);
    this.name = "ReportHttpError";
    this.status = status;
  }
}

export interface ModelReport {
  device_id: string;
  /** Stable per-vehicle HMAC when present — lets the API tie reports to a
   *  specific vehicle across trips. */
  vehicle_identifier?: string | null;
  /** Required by the API: an empty description is a hard 422 ("description
   *  is required") whether or not a photo is attached. The photo is the
   *  optional half, not an alternative. */
  description: string;
  photo?: File | null;
  lng?: number;
  lat?: number;
}

/** Submit a model report. Throws on network/HTTP failure so the caller can
 *  surface an inline error. */
export async function submitModelReport(report: ModelReport): Promise<void> {
  const form = new FormData();
  form.set("device_id", report.device_id);
  if (report.vehicle_identifier) {
    form.set("vehicle_identifier", report.vehicle_identifier);
  }
  form.set("description", report.description.trim());
  if (report.lng !== undefined && report.lat !== undefined) {
    form.set("lng", String(report.lng));
    form.set("lat", String(report.lat));
  }
  if (report.photo) form.set("photo", report.photo);

  const headers: Record<string, string> = {};
  const auth = getAuth();
  if (auth) headers.Authorization = `Bearer ${auth.token}`;

  const res = await fetch(`${API_BASE}/api/v1/reports/model`, {
    method: "POST",
    headers, // no Content-Type: the browser sets the multipart boundary
    body: form,
  });
  if (!res.ok) throw new ReportHttpError(res.status);
}
