// The device-photos client: the two endpoints the popup's final row calls,
// and the error mapping that decides what a rider is told when one fails.
// The failure paths carry the weight here — 409 (device already holds its
// three photos) and 503 (photo storage unconfigured) can never succeed on
// retry, so collapsing them into a generic "something went wrong" would send
// riders re-shooting a photo forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cleared: string[] = [];
let token: string | null = "tok-1";

vi.mock("./map-auth.js", () => ({
  getAuth: () => (token ? { token } : null),
  isAuthenticated: () => token !== null,
}));
vi.mock("./auth-storage.ts", () => ({
  clearStoredSessionIfToken: (t: string) => {
    cleared.push(t);
    return true;
  },
}));

import { ApiError } from "./api.ts";
import {
  MAX_DEVICE_PHOTO_BYTES,
  MAX_PHOTOS_PER_DEVICE,
  fetchDevicePhotos,
  photoErrorText,
  supportsPhotos,
  uploadDevicePhoto,
} from "./device-photos.ts";

const VID = "0123456789abcdef"; // 16 lowercase hex, the API's exact shape

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A File of a given byte length without allocating the bytes twice. */
function fakeFile(bytes: number, name = "scooter.jpg"): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cleared.length = 0;
  token = "tok-1";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supportsPhotos", () => {
  it("accepts exactly 16 lowercase hex — the API's path pattern", () => {
    expect(supportsPhotos(VID)).toBe(true);
  });

  it("rejects shapes the API would 422: short, long, uppercase, non-hex", () => {
    expect(supportsPhotos("0123456789abcde")).toBe(false); // 15
    expect(supportsPhotos("0123456789abcdef0")).toBe(false); // 17
    expect(supportsPhotos("0123456789ABCDEF")).toBe(false); // uppercase
    expect(supportsPhotos("0123456789abcdeg")).toBe(false); // 'g'
    expect(supportsPhotos("")).toBe(false);
  });
});

describe("fetchDevicePhotos", () => {
  it("normalizes the listing and counts what it can actually render", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        vehicle_identifier: VID,
        // A count that disagrees with the array is the server's, not ours —
        // the UI iterates the array, so that is what count must describe.
        count: 99,
        photos: [
          {
            id: 7,
            photo_url: "https://cdn.example/1.jpg",
            created_at: "2026-07-20T10:00:00+00:00",
            uploaded_by: "Turbo 🦔",
          },
          {
            id: 8,
            photo_url: "https://cdn.example/2.jpg",
            created_at: "2026-07-21T10:00:00+00:00",
            uploaded_by: null, // uploader keeps their username private
          },
        ],
      }),
    );
    const list = await fetchDevicePhotos(VID);
    expect(list.count).toBe(2);
    expect(list.photos[0].id).toBe(7);
    expect(list.photos[0].uploaded_by).toBe("Turbo 🦔");
    expect(list.photos[1].uploaded_by).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/v1/devices/${VID}/photos`);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("survives a listing with the photos key missing entirely", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ vehicle_identifier: VID }));
    const list = await fetchDevicePhotos(VID);
    expect(list.count).toBe(0);
    expect(list.photos).toEqual([]);
  });

  it("throws NO_AUTH without ever hitting the network when signed out", async () => {
    token = null;
    await expect(fetchDevicePhotos(VID)).rejects.toMatchObject({
      code: "NO_AUTH",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("uploadDevicePhoto", () => {
  it("posts the file as multipart `photo` with the bearer token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 12,
        vehicle_identifier: VID,
        photo_url: "https://cdn.example/12.jpg",
        created_at: "2026-08-01T12:00:00+00:00",
      }),
    );
    const photo = await uploadDevicePhoto(VID, fakeFile(1024));
    expect(photo.id).toBe(12);
    expect(photo.photo_url).toBe("https://cdn.example/12.jpg");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/v1/devices/${VID}/photos`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-1");
    // Setting Content-Type by hand would strip the multipart boundary.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      "content-type",
    );
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("photo")).toBeInstanceOf(File);
  });

  it("rejects an over-10 MB photo locally, without spending the upload", async () => {
    await expect(
      uploadDevicePhoto(VID, fakeFile(MAX_DEVICE_PHOTO_BYTES + 1)),
    ).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the 409 the 4th photo on a device returns", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "full" }, 409));
    await expect(uploadDevicePhoto(VID, fakeFile(10))).rejects.toMatchObject({
      status: 409,
    });
  });

  it("carries Retry-After off a 429 so the rider can be told how long", async () => {
    // Regression: the multipart path can't use authedFetchJSON, so it doesn't
    // inherit api.ts's shared Retry-After parsing — and uploads are the one
    // photo call with a limit (20/hour) riders actually reach.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "slow down" }), {
        status: 429,
        headers: { "Retry-After": "600" },
      }),
    );
    const err = await uploadDevicePhoto(VID, fakeFile(10)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 429, retryAfter: 600 });
    // …and that value has to survive into what the rider reads.
    expect(photoErrorText(err, "upload")).toContain("10 min");
  });

  it("leaves retryAfter unset when the header is absent or an HTTP-date", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", {
        status: 429,
        headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
    );
    const err = await uploadDevicePhoto(VID, fakeFile(10)).catch(
      (e: unknown) => e,
    );
    expect((err as { retryAfter?: number }).retryAfter).toBeUndefined();
    expect(photoErrorText(err, "upload")).toContain("Too many");
  });

  it("clears the stale session on 401 and reports TOKEN_REJECTED", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "nope" }, 401));
    await expect(uploadDevicePhoto(VID, fakeFile(10))).rejects.toMatchObject({
      code: "TOKEN_REJECTED",
    });
    // Only the token that was actually rejected — never a blind sign-out.
    expect(cleared).toEqual(["tok-1"]);
  });

  it("refuses to upload at all when signed out", async () => {
    token = null;
    await expect(uploadDevicePhoto(VID, fakeFile(10))).rejects.toMatchObject({
      code: "NO_AUTH",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("photoErrorText", () => {
  const http = (status: number, retryAfter?: number): ApiError =>
    new ApiError("x", "HTTP_ERROR", { status, retryAfter });

  it("names the cap on 409 rather than inviting a retry", () => {
    expect(photoErrorText(http(409), "upload")).toContain(
      String(MAX_PHOTOS_PER_DEVICE),
    );
  });

  it("distinguishes too-large, bad-part, and unconfigured storage", () => {
    expect(photoErrorText(http(413), "upload")).toContain("10 MB");
    expect(photoErrorText(http(422), "upload")).toContain("photo");
    expect(photoErrorText(http(503), "upload")).toContain("storage");
  });

  it("turns Retry-After seconds into minutes on 429", () => {
    expect(photoErrorText(http(429, 600), "upload")).toContain("10 min");
    // No Retry-After — still a rate-limit message, just without the number.
    expect(photoErrorText(http(429), "upload")).toContain("Too many");
  });

  it("points a signed-out or expired session at the Account tab", () => {
    expect(photoErrorText(new ApiError("x", "NO_AUTH"), "list")).toContain(
      "Sign in",
    );
    expect(
      photoErrorText(new ApiError("x", "TOKEN_REJECTED"), "upload"),
    ).toContain("Sign in");
  });

  it("falls back to wording that matches what was being attempted", () => {
    expect(photoErrorText(new Error("offline"), "upload")).toContain(
      "Upload failed",
    );
    expect(photoErrorText(new Error("offline"), "list")).toContain(
      "load photos",
    );
  });
});
