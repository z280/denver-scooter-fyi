// Rider-contributed photos of a specific scooter — the client half of the
// API's "Device photos" surface (see API.md § Device photos):
//
//   POST /api/v1/devices/{vehicle_identifier}/photos   multipart `photo`
//   GET  /api/v1/devices/{vehicle_identifier}/photos   oldest first
//
// Both require a bearer session. The photos themselves are public: `photo_url`
// points at an unauthenticated R2 object, so a URL keeps working anywhere once
// you have it — only the *listing* is session-gated, like every other rider
// endpoint here.
//
// Uploads are multipart, which is why this doesn't ride on api.ts's
// `authedFetchJSON` (that helper JSON-serializes its body and sets
// Content-Type, and a fixed Content-Type loses the multipart boundary). The
// 401 path still mirrors it — a rejected token is cleared through the same
// compare-and-set helper, so a second tab holding a freshly rotated session
// isn't signed out by this one's stale 401.

import { API_BASE, ApiError, authedFetchJSON } from "./api.ts";
import { clearStoredSessionIfToken } from "./auth-storage.ts";
import { getAuth } from "./map-auth.js";

/** Server-side cap (src/api_device_photos.py, MAX_PHOTOS_PER_DEVICE). The 4th
 *  upload is a hard 409 — mirrored here so the UI can say so before spending
 *  the rider's upload. */
export const MAX_PHOTOS_PER_DEVICE = 3;

/** 10 MB (MAX_DEVICE_PHOTO_BYTES). Over it is a 413 — checked client-side
 *  first so a phone photo that's too big fails instantly instead of after the
 *  upload. */
export const MAX_DEVICE_PHOTO_BYTES = 10 * 1024 * 1024;

export interface DevicePhoto {
  id: number;
  photo_url: string;
  created_at: string;
  /** Uploader's public_username, joined at read time — null when that user
   *  keeps `show_public_username` off. Never assume it's stable. */
  uploaded_by: string | null;
}

export interface DevicePhotoList {
  vehicle_identifier: string;
  count: number;
  /** Oldest first, as the API returns them. */
  photos: DevicePhoto[];
}

/** The API's path parameter is `^[0-9a-f]{16}$` — exactly 16 lowercase hex,
 *  stricter than the ≥16 length check the report endpoints accept. A device
 *  whose identifier doesn't match can't have photos at all, so the UI hides
 *  the buttons rather than offering a guaranteed 422. */
export function supportsPhotos(vehicleIdentifier: string): boolean {
  return /^[0-9a-f]{16}$/.test(vehicleIdentifier);
}

/** List a device's visible photos, oldest first. Throws ApiError (NO_AUTH
 *  when signed out, TOKEN_REJECTED on 401, HTTP_ERROR otherwise). */
export async function fetchDevicePhotos(
  vehicleIdentifier: string,
  signal?: AbortSignal,
): Promise<DevicePhotoList> {
  const raw = await authedFetchJSON<Partial<DevicePhotoList>>(
    `/api/v1/devices/${encodeURIComponent(vehicleIdentifier)}/photos`,
    { signal },
  );
  const photos = Array.isArray(raw?.photos) ? raw.photos : [];
  return {
    vehicle_identifier: String(raw?.vehicle_identifier ?? vehicleIdentifier),
    // Trust the array's length over the server's `count` for anything the UI
    // renders from — they agree, but only one of them can be iterated.
    count: photos.length,
    photos: photos.map((p) => ({
      id: Number(p.id ?? 0),
      photo_url: String(p.photo_url ?? ""),
      created_at: String(p.created_at ?? ""),
      uploaded_by: p.uploaded_by == null ? null : String(p.uploaded_by),
    })),
  };
}

/** Upload one photo. Throws ApiError carrying the HTTP status so the caller
 *  can tell "device is full" (409) from "too big" (413) from "photo storage
 *  isn't configured on this deployment" (503). */
export async function uploadDevicePhoto(
  vehicleIdentifier: string,
  photo: File,
): Promise<DevicePhoto> {
  if (photo.size > MAX_DEVICE_PHOTO_BYTES) {
    // Fail before the upload rather than after: the server's own 413 costs
    // the rider the full transfer of a photo it was always going to reject.
    throw new ApiError("photo too large", "HTTP_ERROR", { status: 413 });
  }
  const auth = getAuth();
  if (!auth) throw new ApiError("not authenticated", "NO_AUTH");

  const form = new FormData();
  form.set("photo", photo);
  const res = await fetch(
    `${API_BASE}/api/v1/devices/${encodeURIComponent(vehicleIdentifier)}/photos`,
    {
      method: "POST",
      // No Content-Type: the browser sets the multipart boundary.
      headers: { Accept: "application/json", Authorization: `Bearer ${auth.token}` },
      body: form,
    },
  );
  if (res.status === 401) {
    clearStoredSessionIfToken(auth.token);
    throw new ApiError("token rejected", "TOKEN_REJECTED");
  }
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status}`, "HTTP_ERROR", {
      status: res.status,
    });
  }
  const data = (await res.json()) as Partial<DevicePhoto>;
  return {
    id: Number(data?.id ?? 0),
    photo_url: String(data?.photo_url ?? ""),
    created_at: String(data?.created_at ?? ""),
    uploaded_by: null, // the upload response doesn't join the username
  };
}

/** Rider-facing text for a failed photo call. Every documented failure of
 *  these two endpoints gets its own sentence — a bare "something went wrong"
 *  on a full device (409) or an unconfigured deployment (503) would send the
 *  rider retrying something that can never succeed. */
export function photoErrorText(err: unknown, action: "upload" | "list"): string {
  const api = err instanceof ApiError ? err : null;
  if (api?.code === "NO_AUTH" || api?.code === "TOKEN_REJECTED") {
    return "Sign in (Account tab) to add or view photos.";
  }
  switch (api?.status) {
    case 409:
      return `This scooter already has ${MAX_PHOTOS_PER_DEVICE} photos — that's the limit.`;
    case 413:
      return "That photo is over 10 MB. Try a smaller one.";
    case 422:
      return "That file didn't look like a photo. Try again.";
    case 429:
      return api.retryAfter
        ? `Too many uploads — try again in ${Math.ceil(api.retryAfter / 60)} min.`
        : "Too many uploads for now — try again later.";
    case 503:
      return "Photo storage isn't available right now. Try again later.";
    default:
      return action === "upload"
        ? "Upload failed. Check your connection and try again."
        : "Couldn't load photos. Check your connection and try again.";
  }
}
