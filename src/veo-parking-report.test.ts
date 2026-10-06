// What we are allowed to put in a rider's own words.
//
// `veoParkingReportUrl` pre-fills a complaint that the RIDER submits, on Veo's
// own form, under their identity. Three things were taken out of it, and all
// three are the kind of thing that gets added back by someone being helpful:
// our dwell measurement, our salted vehicle identifier, and our name.
//
// These are absence tests, which are usually weak — so they assert the
// absence of each specific string AND that the useful content is still there,
// because "the body is empty" would otherwise pass every one of them.

import { describe, expect, it } from "vitest";

import { veoParkingReportUrl, type ParkingReportInput } from "./config.ts";

const AT: ParkingReportInput = {
  lat: 39.7392,
  lng: -104.9903,
  plate: "1025543",
  modelName: "Astro",
  address: "1234 Larimer St, Denver, CO",
};

function body(over: Partial<ParkingReportInput> = {}): string {
  const url = new URL(veoParkingReportUrl({ ...AT, ...over }));
  return url.searchParams.get("tf_description") ?? "";
}

describe("the Veo parking report body", () => {
  it("still carries everything the rider can see for themselves", () => {
    const b = body();
    expect(b).toContain("1025543");
    expect(b).toContain("Astro");
    expect(b).toContain("1234 Larimer St");
    expect(b).toContain("39.739200, -104.990300");
    expect(b).toContain("google.com/maps");
    // The one instruction that makes the report usable: Veo needs to know
    // WHICH problem, and only the rider standing there can say.
    expect(b.toLowerCase()).toContain("blocking sidewalk");
  });

  it("does not carry our dwell measurement", () => {
    // "Parked here for at least 3d 4h" is a claim from a two-minute ingest
    // cycle the rider never saw, filed under the rider's name as if they had
    // observed it.
    const b = body();
    expect(b).not.toMatch(/parked here for/i);
    expect(b).not.toMatch(/\bdwell/i);
    expect(b).not.toMatch(/\b\d+d \d+h\b/);
  });

  it("does not carry our vehicle identifier", () => {
    // A salted HMAC of the plate: Veo cannot resolve it, so it informs the
    // recipient of nothing and advertises an identifier scheme for free.
    const b = body();
    expect(b).not.toMatch(/vehicle id\b/i);
    expect(b).not.toMatch(/[0-9a-f]{16}/);
  });

  it("does not say where it was composed", () => {
    // The complaint is the rider's. Our name on it makes one person's report
    // look like an organised campaign — untrue, and the easiest way for the
    // whole class of them to be dismissed.
    const b = body();
    expect(b).not.toMatch(/scooter\.fyi/i);
    expect(b).not.toMatch(/reported via/i);
  });

  it("keeps our name out of the subject too", () => {
    const url = new URL(veoParkingReportUrl(AT));
    const subject = url.searchParams.get("tf_subject") ?? "";
    expect(subject).toContain("Improperly parked");
    expect(subject).not.toMatch(/scooter\.fyi/i);
  });

  it("falls back to coordinates without an address, and still says nothing extra", () => {
    const b = body({ address: null });
    expect(b).toContain("39.739200, -104.990300");
    expect(b).not.toMatch(/parked here for|scooter\.fyi|vehicle id\b/i);
  });
});
