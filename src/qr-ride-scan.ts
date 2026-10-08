// What a scanned sticker does to a ride — the decision, kept apart from the
// modal that shows it and the integrator that performs it.
//
// THE PROBLEM IT CLOSES. Tying a scooter to a ride used to depend entirely on
// WHICH DOOR the rider came through. Screen 2's picker, a typed plate, a `?ride=`
// deep link, the popup's "Use in Ride Mode", the walk flow's arrival panel —
// five routes, each setting the device at a different point in the flow, and
// none of them available once the ride was running. So a rider who started
// recording and then got on a Veo scooter had no way to say so, and the ride
// went into the record as having been on nothing in particular: no model-bonus
// question, no vehicle on the survey, nothing to correlate.
//
// The scan is the association, and it is the same gesture wherever the rider is
// in the flow. What differs is only what the session already knows, which is
// what this function answers.
//
// FOUR OUTCOMES, because there are four honest things to say:
//
//   START       nothing in flight. Open the wizard on this scooter.
//   RESUME      a wizard was in progress. Put the scooter in it and go back to
//               the screen they left — never a fresh `open`, which would reset
//               the doc and throw their destination and route away.
//   ASSOCIATE   a ride is running with no server row (the free-ride path). Name
//               the vehicle it is on.
//   ALREADY     a ride is running WITH a server row. Its vehicle was stamped
//               into `tracked_rides` when it started and nothing the client
//               does moves it, so say so rather than letting the local doc
//               disagree with the server about what was ridden — the doc is
//               what the survey submits.
//
// Plus the two ways a scan can fail to name anything: an unreadable payload, and
// a plate that resolves to no vehicle in the current feed.

import type { RideSessionDoc, RideState } from "./ride-session.ts";
import type { DeviceProperties } from "./api.ts";
import { normalizePlate, type ResolveResult } from "./plates.ts";
import { vehicleDisplayName } from "./vehicle-name.ts";

/** A vehicle the scan resolved to, in the terms the session doc wants. */
export interface ScannedVehicle {
  vehicleIdentifier: string;
  deviceId: string;
  plate: string;
  /** Rider-facing name, for the sentence. */
  name: string;
}

export type QrRideAction =
  | { kind: "start"; vehicle: ScannedVehicle }
  | { kind: "resume"; vehicle: ScannedVehicle; screen: RideSessionDoc["screen"] }
  | { kind: "associate"; vehicle: ScannedVehicle }
  | { kind: "already"; vehicle: ScannedVehicle }
  /** The payload carried nothing that looks like a plate. */
  | { kind: "unreadable" }
  /** A plate, but no vehicle in the feed carries it. */
  | { kind: "unknown_vehicle"; plate: string }
  /** The ride is over but its post-ride screens are still owed answers.
   *  Scanning cannot help with that, and starting something new over it would
   *  lose the summary the rider has not finished. */
  | { kind: "post_ride" };

const LIVE_STATES: readonly RideState[] = ["riding", "countdown"];

/** Which of the four things a scan means, given what the session holds.
 *
 *  Pure. `doc` is the live session doc (null for none), `vehicle` is whatever
 *  the scan resolved to (null when it resolved to nothing). */
export function qrRideAction(
  doc: RideSessionDoc | null,
  vehicle: ScannedVehicle | null,
  plate: string | null,
): QrRideAction {
  if (!vehicle) {
    return plate === null ? { kind: "unreadable" } : { kind: "unknown_vehicle", plate };
  }
  if (!doc) return { kind: "start", vehicle };

  if (
    doc.state === "ending" ||
    doc.state === "survey" ||
    doc.state === "eligibility"
  ) {
    return { kind: "post_ride" };
  }

  if (LIVE_STATES.includes(doc.state)) {
    // A ride with a server row already named its vehicle, irrevocably.
    return doc.rideId === null
      ? { kind: "associate", vehicle }
      : { kind: "already", vehicle };
  }

  if (doc.state === "wizard") {
    // A wizard mid-flight is a resume whether or not it has answers yet: the
    // scooter goes in, and the rider lands back on the screen they left. With
    // nothing answered that screen is wherever they got to, which is where
    // they were going anyway.
    return { kind: "resume", vehicle, screen: doc.screen };
  }

  // `idle` and `done` are both "nothing in flight" — a finished ride keeps its
  // device and `startedAtMs` as the record of what happened, which is exactly
  // why neither may be mistaken for an unfinished one.
  return { kind: "start", vehicle };
}

/** What to tell the rider.
 *
 *  Each line says what happened to their ride, because that is the thing they
 *  cannot see from behind the camera. The two failures say what to do next; the
 *  `already` line says why we are NOT doing the thing they asked for, which is
 *  the one case where silence would read as a bug. */
export function qrRideMessage(action: QrRideAction): string {
  switch (action.kind) {
    case "start":
      return `Starting a ride on ${action.vehicle.name}…`;
    case "resume":
      return `${action.vehicle.name} it is — picking your ride setup back up.`;
    case "associate":
      return `Got it — your ride is on ${action.vehicle.name}.`;
    case "already":
      // Honest about the limit rather than pretending to re-point a ride whose
      // vehicle the server fixed at the start.
      return "This ride is already tied to a scooter — that was settled when it started, so there's nothing to change.";
    case "post_ride":
      return "Finish wrapping up your last ride first — the summary's still waiting on you.";
    case "unreadable":
      return "That doesn't look like a scooter's QR code. Try the sticker on the handlebar stem.";
    case "unknown_vehicle":
      return `Plate ${action.plate} isn't in the live fleet right now — it may have just been picked up, or be out of the service area.`;
  }
}

// ---------------------------------------------------------------------------
// Plate → vehicle, for the scan
// ---------------------------------------------------------------------------

export interface ScanResolveDeps {
  /** The signed-in plate index's synchronous read (`PlateIndex.cachedPlateFor`);
   *  always null for a guest. */
  plateFor(deviceId: string): string | null;
  /** The public `/vehicles/resolve` (plates.ts's `resolvePlate`). */
  resolve(plate: string): Promise<ResolveResult>;
}

const VID_RE = /^[0-9a-f]{16}$/;

/** Resolve a scanned sticker's plate to a vehicle in the live feed.
 *
 *  WHY THE PLATE IS THE BRIDGE. The sticker carries a plate; the session doc
 *  wants a `vehicle_identifier`, which is a salted hash the browser cannot
 *  compute. Three ways across, cheapest first:
 *   1. the feed's own `vehicle_plate` (admin/private feeds only);
 *   2. the signed-in plate index — answers it already holds for nearby
 *      vehicles, so a signed-in rider's scan usually costs no request;
 *   3. our public `GET /api/v1/vehicles/resolve`, which works signed out and
 *      reveals no plate the rider isn't already holding.
 *  Never Veo's servers. The answer is matched against the devices on the map
 *  (by device_id, then vehicle_identifier): a vehicle we can't show is a
 *  vehicle we can't start a ride on. */
export async function resolveScannedPlate(
  plate: string,
  features: ReadonlyArray<GeoJSON.Feature<GeoJSON.Point, DeviceProperties>>,
  deps: ScanResolveDeps,
): Promise<ScannedVehicle | null> {
  const wanted = normalizePlate(plate);
  if (wanted === "") return null;

  const asVehicle = (
    f: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>,
    resolvedPlate: string,
  ): ScannedVehicle | null => {
    const vid = String(f.properties.vehicle_identifier ?? "").toLowerCase();
    if (!VID_RE.test(vid)) return null;
    return {
      vehicleIdentifier: vid,
      deviceId: f.properties.device_id,
      plate: resolvedPlate,
      name: vehicleDisplayName(
        f.properties.public_name,
        resolvedPlate,
        f.properties.vehicle_model_name,
        f.properties.plate_suffix,
      ),
    };
  };

  for (const f of features) {
    const fed = f.properties.vehicle_plate;
    if (fed && normalizePlate(String(fed)) === wanted) {
      const v = asVehicle(f, String(fed));
      if (v) return v;
    }
  }

  for (const f of features) {
    let cached: string | null = null;
    try {
      cached = deps.plateFor(f.properties.device_id);
    } catch {
      continue;
    }
    if (cached !== null && normalizePlate(cached) === wanted) {
      const v = asVehicle(f, plate);
      if (v) return v;
    }
  }

  // Public reverse lookup. Never rejects — an error or a miss is "no match".
  let r: ResolveResult;
  try {
    r = await deps.resolve(plate);
  } catch {
    return null;
  }
  if (r.kind !== "hit") return null;
  const f =
    features.find((x) => x.properties.device_id === r.deviceId) ??
    features.find(
      (x) =>
        String(x.properties.vehicle_identifier ?? "").toLowerCase() ===
        r.vehicleIdentifier,
    );
  return f ? asVehicle(f, plate) : null;
}
