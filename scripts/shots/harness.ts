// Screenshot harness. Mounts the surfaces this branch changed with fixture
// data, offline. Not part of the app: `scripts/shots.mjs` serves it through
// the dev server, screenshots it, and the pair is deleted afterwards.
import { buildNavPanel } from "../../src/account-nav.ts";
import { buildTripPanel } from "../../src/trip-panel.ts";
import { createNavHud } from "../../src/ride-nav-hud.ts";
import { encodePolyline, type LngLatCoord } from "../../src/polyline-encode.ts";
import { startTrip } from "../../src/trip-legs.ts";
import type { RouteManeuver } from "../../src/api.ts";

const el = (id: string): HTMLElement => document.getElementById(id)!;

// --- Navigation preferences, with a profile that has an unverified phone:
// the state the SMS switch exists to explain.
buildNavPanel(el("navprefs-host"), { phoneVerified: () => false });

// --- Your trip, mid multi-leg plan.
const HOME = { label: "Home", lat: 39.7285, lon: -105.0345 };
const HANDOFF = { label: "Liftoff 🍉 167", lat: 39.73, lon: -105.0 };
startTrip({ plannedRides: 2, dest: HOME, handOffs: [HANDOFF] });
const tripState = () => ({
  dest: HOME,
  routeSeconds: 14 * 60,
  routeMeters: 3400,
  nowMs: Date.now(),
});
buildTripPanel(el("trip-host"), {
  state: tripState,
  showOnMap: () => {},
  onClear: () => {},
  clearBlockedReason: () => null,
});
const second = buildTripPanel(el("trip-host-2"), {
  state: tripState,
  showOnMap: () => {},
  onClear: () => {},
  clearBlockedReason: () => null,
});
void second;
// Arm the confirm on the second copy, so one shot shows both states.
const prime = [...el("trip-host-2").querySelectorAll("button")].find(
  (b) => b.textContent === "Clear my trip",
);
prime?.click();

// --- The directions list, with its magnifiers.
const coords: LngLatCoord[] = [];
for (let i = 0; i <= 12; i += 1) coords.push([-104.99 + i * 0.0004, 39.74 + i * 0.0002]);
const man = (begin: number, instruction: string, streets: string[]): RouteManeuver => ({
  instruction,
  type: 8,
  street_names: streets,
  length_meters: 180,
  time_seconds: 60,
  begin_shape_index: begin,
  end_shape_index: begin + 3,
});
createNavHud(el("navhud"), {
  route: {
    profile: "safe",
    rideRouteId: "r1",
    distanceM: 3400,
    durationS: 840,
    polyline: encodePolyline(coords),
    maneuvers: [
      man(0, "Head north on Blake St", ["Blake St"]),
      man(3, "Turn right onto 20th St", ["20th St"]),
      man(6, "Turn left onto Larimer St", ["Larimer St"]),
      man(9, "Arrive at Home", []),
    ],
  },
  dest: { lat: 39.7285, lon: -105.0345 },
  onDismiss: () => {},
  onCompress: () => {},
  onPreviewStep: () => {},
  fetchRoute: () => new Promise(() => {}),
});
// Open the directions panel so the rows (and their 🔍) are on screen.
el("navhud").querySelector<HTMLButtonElement>(".nav-hud__arrow--left")?.click();
