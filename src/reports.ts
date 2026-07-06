// Crowdsourced model reports: when the fleet shows a vehicle whose model we
// don't recognize ("Veo Unknown"), riders can tell us what it is with a
// short description and an optional photo. Posts multipart to the API's
// report-ingestion surface (see docs/API_REQUIREMENTS.md §3 — a new
// /reports/model endpoint). Anonymous is allowed; a bearer token rides along
// when the user happens to be signed in so the report can be weighted.

import { API_BASE } from "./api.ts";
import { getAuth } from "./map-auth.js";

export interface ModelReport {
  device_id: string;
  /** Stable per-vehicle HMAC when present — lets the API tie reports to a
   *  specific vehicle across trips. */
  vehicle_identifier?: string | null;
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
  if (!res.ok) throw new Error(`Report failed (HTTP ${res.status})`);
}
