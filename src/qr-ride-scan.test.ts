// What a scanned sticker means to a ride. The decision only — see
// `qr-ride-scan.ts`'s header for the five doors that used to each tie a scooter
// to a ride at a different point in the flow, and none of them once it was
// running.
import { describe, expect, it } from "vitest";

import { qrRideAction, qrRideMessage, type ScannedVehicle } from "./qr-ride-scan.ts";
import type { RideOptions } from "./api.ts";
import { blankRideSession, type RideSessionDoc } from "./ride-session.ts";

const OPTIONS: RideOptions = {
  cost_hud: true,
  speedometer: "classic",
  theme: "auto",
  navigation: false,
  save_tracks: true,
  battery_modeling: false,
  nav_improvement: false,
  end_survey: false,
  own_device: false,
};

const VEHICLE: ScannedVehicle = {
  vehicleIdentifier: "a1b2c3d4e5f60701",
  deviceId: "d1",
  plate: "1234567",
  name: "Lunar 🐸 928",
};

function doc(over: Partial<RideSessionDoc>): RideSessionDoc {
  return { ...blankRideSession(OPTIONS), ...over };
}

describe("qrRideAction", () => {
  it("starts a ride when nothing is in flight", () => {
    expect(qrRideAction(null, VEHICLE, VEHICLE.plate)).toEqual({
      kind: "start",
      vehicle: VEHICLE,
    });
    // `idle` and `done` are both "nothing in flight". A finished ride keeps its
    // device and startedAtMs as the record of what happened, which is exactly
    // why neither may be read as unfinished.
    for (const state of ["idle", "done"] as const) {
      expect(
        qrRideAction(doc({ state, device: { own: true } }), VEHICLE, VEHICLE.plate).kind,
      ).toBe("start");
    }
  });

  it("resumes a wizard rather than restarting it", () => {
    const a = qrRideAction(
      doc({ state: "wizard", screen: "3", dest: { label: "Home", lat: 1, lon: 2 } }),
      VEHICLE,
      VEHICLE.plate,
    );
    expect(a).toEqual({ kind: "resume", vehicle: VEHICLE, screen: "3" });
  });

  it("resumes an empty wizard too — the screen they got to is where they were going", () => {
    const a = qrRideAction(doc({ state: "wizard", screen: "2" }), VEHICLE, VEHICLE.plate);
    expect(a.kind).toBe("resume");
  });

  it("associates with a live ride that has no server row", () => {
    // The gap the whole mode exists for: started recording, then got on a Veo
    // scooter, with nothing anywhere to say which one.
    for (const state of ["riding", "countdown"] as const) {
      const a = qrRideAction(
        doc({ state, rideId: null, private: true, startedAtMs: 1 }),
        VEHICLE,
        VEHICLE.plate,
      );
      expect(a).toEqual({ kind: "associate", vehicle: VEHICLE });
    }
  });

  it("refuses to re-point a ride whose vehicle the server already stamped", () => {
    // `POST /tracked-rides` fixed it at the start and nothing the client does
    // moves it. Accepting would leave the doc disagreeing with the server about
    // what was ridden — and the doc is what the survey submits.
    const a = qrRideAction(
      doc({ state: "riding", rideId: "ride-1", startedAtMs: 1 }),
      VEHICLE,
      VEHICLE.plate,
    );
    expect(a).toEqual({ kind: "already", vehicle: VEHICLE });
  });

  it("does nothing over a ride still owed its post-ride screens", () => {
    for (const state of ["ending", "survey", "eligibility"] as const) {
      expect(qrRideAction(doc({ state }), VEHICLE, VEHICLE.plate).kind).toBe(
        "post_ride",
      );
    }
  });

  it("separates 'could not read it' from 'read it, do not know it'", () => {
    // Different problems with different next steps: aim the camera again, versus
    // the scooter is not in the fleet right now.
    expect(qrRideAction(null, null, null)).toEqual({ kind: "unreadable" });
    expect(qrRideAction(null, null, "1234567")).toEqual({
      kind: "unknown_vehicle",
      plate: "1234567",
    });
  });

  it("reports an unresolvable scan regardless of what the session holds", () => {
    // The session cannot make up for a scan that named nothing.
    for (const state of ["riding", "wizard", "idle", "survey"] as const) {
      expect(qrRideAction(doc({ state }), null, "999").kind).toBe("unknown_vehicle");
    }
  });
});

describe("qrRideMessage", () => {
  it("names the scooter wherever one was resolved", () => {
    const withVehicle = [
      { kind: "start" as const, vehicle: VEHICLE },
      { kind: "resume" as const, vehicle: VEHICLE, screen: "3" as const },
      { kind: "associate" as const, vehicle: VEHICLE },
    ];
    for (const a of withVehicle) {
      expect(qrRideMessage(a)).toContain(VEHICLE.name);
    }
  });

  it("says why nothing changed on an already-tied ride", () => {
    // The one case where silence would read as a bug.
    const text = qrRideMessage({ kind: "already", vehicle: VEHICLE });
    expect(text).toMatch(/already tied/i);
    expect(text).toMatch(/nothing to change/i);
  });

  it("quotes the plate it could not place, so the rider can check it", () => {
    expect(qrRideMessage({ kind: "unknown_vehicle", plate: "1234567" })).toContain(
      "1234567",
    );
  });

  it("has a distinct sentence for every outcome", () => {
    const all = [
      qrRideMessage({ kind: "start", vehicle: VEHICLE }),
      qrRideMessage({ kind: "resume", vehicle: VEHICLE, screen: "3" }),
      qrRideMessage({ kind: "associate", vehicle: VEHICLE }),
      qrRideMessage({ kind: "already", vehicle: VEHICLE }),
      qrRideMessage({ kind: "post_ride" }),
      qrRideMessage({ kind: "unreadable" }),
      qrRideMessage({ kind: "unknown_vehicle", plate: "1" }),
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const m of all) expect(m.length).toBeGreaterThan(0);
  });
});
