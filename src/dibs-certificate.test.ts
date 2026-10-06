// @vitest-environment happy-dom
//
// The claim confirmation's move-watch line.
//
// A watch is armed as part of the dibs claim (`devices.ts`'s
// `setClaimWatchHook`), and this toast is the ONLY place the rider is told it
// happened. A watch armed silently is one they cannot decide against, so the
// disclosure is part of the feature rather than a nicety — see
// `device-notify.ts`'s header for why this capability is gated at all.

import { beforeEach, describe, expect, it } from "vitest";

import { showDibsConfirmation } from "./dibs-certificate.ts";
import type { Dibs } from "./dibs.ts";

function dibs(over: Partial<Dibs> = {}): Dibs {
  return {
    vehicleIdentifier: "0123456789abcdef",
    vehicleName: "Lunar 🐸 928",
    plate: "1234567",
    claimedBy: "Someone with the app",
    claimedAt: 1_700_000_000_000,
    startMeters: 300,
    bestMeters: 300,
    startedWalkingAt: null,
    lat: 39.74,
    lon: -104.99,
    registration: null,
    ...over,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("showDibsConfirmation's watch line", () => {
  const toast = () => document.querySelector<HTMLElement>(".dibs-toast");

  it("reads exactly as it did before the feature existed when nothing was armed", () => {
    showDibsConfirmation(dibs());
    expect(toast()?.textContent).toContain("You've got dibs");
    expect(toast()?.textContent).toContain("Lunar 🐸 928");
    expect(toast()?.querySelector(".dibs-toast__watch")).toBeNull();
  });

  it("says so, in the same breath, when a watch rode along with the claim", () => {
    showDibsConfirmation(
      dibs(),
      "We'll tell you if Lunar 🐸 928 moves before you get there.",
    );
    const line = toast()?.querySelector(".dibs-toast__watch");
    expect(line?.textContent).toContain("moves before you get there");
    // One toast, not a second notice stacked on the first: the claim and the
    // watch are one event from the rider's side.
    expect(document.querySelectorAll(".dibs-toast")).toHaveLength(1);
  });

  it("still leads with the claim — the watch is the second sentence", () => {
    showDibsConfirmation(dibs(), "We'll tell you if it moves.");
    const text = toast()?.querySelector(".dibs-toast__text")?.textContent ?? "";
    expect(text.indexOf("You've got dibs")).toBeLessThan(
      text.indexOf("We'll tell you"),
    );
  });
});
