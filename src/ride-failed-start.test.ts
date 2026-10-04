// The failed-start report's decision and its words — see
// `ride-failed-start.ts`'s header for why the signal needs a rider to give it
// at all, and what the fleet infers in its absence.
import { describe, expect, it, vi } from "vitest";

import {
  failedStartCounted,
  failedStartMessage,
  reportFailedStart,
} from "./ride-failed-start.ts";
import type { DeviceReport } from "./reports.ts";

const ID = "0123456789abcdef";

describe("reportFailedStart", () => {
  it("sends not_rideable against the vehicle, with the rider's position", async () => {
    const sent: DeviceReport[] = [];
    const result = await reportFailedStart(
      { vehicleIdentifier: ID, lat: 39.74, lng: -104.99 },
      async (r) => {
        sent.push(r);
        return { deduped: false };
      },
    );
    expect(sent).toEqual([
      {
        vehicle_identifier: ID,
        report_type: "not_rideable",
        lat: 39.74,
        lng: -104.99,
      },
    ]);
    expect(result.outcome).toBe("reported");
    expect(failedStartCounted(result.outcome)).toBe(true);
  });

  it("omits the position entirely rather than sending half of one", async () => {
    const sent: DeviceReport[] = [];
    await reportFailedStart({ vehicleIdentifier: ID, lat: 39.74 }, async (r) => {
      sent.push(r);
      return { deduped: false };
    });
    expect(sent[0]).not.toHaveProperty("lat");
    expect(sent[0]).not.toHaveProperty("lng");

    // ...and a NaN is not a position either. `/reports/summary` skips rows
    // with a NULL position, which is a cleaner outcome than a row that
    // regionalizes to nowhere.
    sent.length = 0;
    await reportFailedStart(
      { vehicleIdentifier: ID, lat: Number.NaN, lng: -104.99 },
      async (r) => {
        sent.push(r);
        return { deduped: false };
      },
    );
    expect(sent[0]).not.toHaveProperty("lat");
  });

  it("reads a dedupe as a success — the flag is live either way", async () => {
    const result = await reportFailedStart(
      { vehicleIdentifier: ID },
      async () => ({ deduped: true }),
    );
    expect(result.outcome).toBe("deduped");
    expect(failedStartCounted(result.outcome)).toBe(true);
    expect(result.message).toMatch(/already/i);
  });

  it("sends nothing for a vehicle we cannot name", async () => {
    const submit = vi.fn();
    for (const id of [null, "", "tooshort"]) {
      const result = await reportFailedStart({ vehicleIdentifier: id }, submit);
      expect(result.outcome).toBe("unreportable");
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("never throws — a refusal becomes a sentence", async () => {
    const result = await reportFailedStart({ vehicleIdentifier: ID }, () =>
      Promise.reject(new Error("offline")),
    );
    expect(result.outcome).toBe("failed");
    expect(failedStartCounted(result.outcome)).toBe(false);
    // Still tells them to go and get another scooter: the report failing
    // does not make the scooter work.
    expect(result.message).toMatch(/pick another/i);
  });

  it("has a distinct sentence for every outcome", () => {
    const outcomes = ["reported", "deduped", "unreportable", "failed"] as const;
    const messages = outcomes.map(failedStartMessage);
    expect(new Set(messages).size).toBe(outcomes.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(0);
  });

  it("promises the consequence it can keep, and not the one it cannot", () => {
    // "the next rider sees the warning" is true and ours to deliver. "we'll
    // get it fixed" would be Veo's to deliver, and we cannot.
    expect(failedStartMessage("reported")).toMatch(/next rider/i);
    expect(failedStartMessage("reported")).not.toMatch(/fix|repair/i);
  });
});
