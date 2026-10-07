// Phase 11 §11.1/§11.3 — the voice is REACHED, and the two things about that
// wiring which fail silently when they are wrong.
//
// Source-level, like `plan-list-wired.test.ts`, and for the same reason: "the
// speech queue was never primed inside a gesture" and "the HUD never calls the
// announcer" are both invisible at runtime on the machines most people test on.
// An Android tester sees everything work either way.
import { describe, expect, it } from "vitest";

import { functionBody, readSource, withoutComments } from "../tests/helpers/source-text.ts";

const main = withoutComments(readSource("src/main.ts"));
const hud = withoutComments(readSource("src/ride-hud.ts"));
const nav = withoutComments(readSource("src/ride-nav-hud.ts"));

describe("the HUD actually speaks", () => {
  it("calls the announcer on every fix", () => {
    // Not on a timer of its own: the fix is when position, speed and the
    // boundary all change at once, and a second clock would announce a crossing
    // at a moment the rider was nowhere near.
    expect(hud).toContain("this.speakForFix()");
    expect(hud).toContain("announce(");
  });

  it("holds no thresholds or dedup of its own", () => {
    // All the deciding is in ride-announce.ts, where it is testable without a
    // HUD, a map and a speech engine. A copy here would be a second answer.
    const body = functionBody(hud, "  private speakForFix(): void {");
    expect(body).not.toMatch(/TURN_LEAD|FREE_MINUTE_WARNINGS/);
    expect(body).toContain("this.announceState");
  });

  it("never speaks over a popup or a modal", () => {
    // The same rule the follow-cam already follows.
    expect(functionBody(hud, "  private speakForFix(): void {")).toContain(
      "this.deviceCtl.hasOpenPopup()",
    );
  });

  it("stays quiet through a BRB, which keeps the geo watch alive", () => {
    // `pauseRide` with `continue_tracking` deliberately leaves the watcher
    // running, so fixes keep arriving while the rider is parked and in a shop
    // with the phone in a pocket. The baseline keeps updating — the announcer
    // does that while silent on purpose — so walking out of an area and back
    // during a BRB does not produce a spurious crossing on resume.
    expect(functionBody(hud, "  private speakForFix(): void {")).toContain(
      "!this.paused",
    );
  });

  it("reads the mute, rather than assuming it is off", () => {
    expect(functionBody(hud, "  private speakForFix(): void {")).toContain(
      "this.voice.muted()",
    );
  });
});

describe("the turn cue comes from the overlay that owns the match", () => {
  it("is reported by ride-nav-hud, not re-derived by the HUD", () => {
    // The matched shape index, the monotonic advance and the along-route distance
    // all live in the overlay. Rebuilding the match in the HUD would be a second
    // answer to "which turn is next", differing from the one on screen precisely
    // when they disagree — which is when it matters.
    expect(nav).toContain("function reportManeuver()");
    // CALLED, not merely defined. The first version asserted only that the
    // function existed, and passed with its call site removed — a reporter nobody
    // invokes is a reporter that reports nothing.
    expect(functionBody(nav, "    feedFix(lat, lng, accuracy) {")).toContain(
      "reportManeuver()",
    );
    expect(hud).toContain("onManeuver: (maneuver) => {");
    expect(functionBody(hud, "  private speakForFix(): void {")).toContain(
      "maneuver: this.navManeuver",
    );
    // The HUD does none of the geometry itself.
    expect(functionBody(hud, "  private speakForFix(): void {")).not.toMatch(
      /distanceAlongCoords|currentManeuverIndex|advanceMonotonic/,
    );
  });

  it("reports the SAME distance the card shows", () => {
    // Two derivations would let the spoken cue and the screen disagree about how
    // far the turn is.
    const body = functionBody(nav, "  function reportManeuver(): void {");
    expect(body).toContain("distanceAlongCoords(");
    expect(body).toContain("maneuver.begin_shape_index");
  });

  it("is cleared when guidance is dismissed", () => {
    // Otherwise the last reported maneuver sits there and is spoken the moment the
    // rider comes within range of a turn they are no longer being guided to.
    const dismiss = hud.slice(hud.indexOf("this.navDismissed = true;"));
    expect(dismiss.slice(0, 300)).toContain("this.navManeuver = null");
  });

  it("is cleared per ride", () => {
    // Asserted on the two statements being adjacent rather than on a function
    // slice: the first version sliced `enterRiding`, a CLASS method, with a helper
    // that closed on a bare `}` — so the slice ran to the end of the class, picked
    // up the dismiss handler's identical line, and passed with this one deleted.
    expect(hud).toMatch(
      /this\.announceState = INITIAL_ANNOUNCE_STATE;\s*\n\s*this\.navManeuver = null;/,
    );
  });
});

describe("priming, which is the whole fix on iOS", () => {
  it("is exposed so the Start tap's own handler can call it", () => {
    // Safari will not speak unless `speechSynthesis` has been touched inside a
    // user GESTURE, and a countdown firing from a timer is not one.
    expect(hud).toContain("primeVoice()");
  });

  it("is called when a ride is handed off", () => {
    expect(functionBody(hud, "  beginHandoff(handoff: TrackedRideHandoff): void {")).toContain(
      "this.primeVoice()",
    );
  });
});

describe("the free-minute figure comes from one place", () => {
  it("is the same estimate §2.2's control and the plan list use", () => {
    // Two derivations of the hour would let the warning and the plan prices
    // disagree about it.
    expect(main).toContain("planningFreeMinuteEstimate(");
    expect(functionBody(main, "function wireRideHud(): RideHud {")).toContain(
      "planningFreeMinuteEstimate(",
    );
  });

  it("stays silent on a pessimistic signed-out guess", () => {
    // "Your free minutes are used up", said on every ride to somebody who may
    // have a full hour, is a confident false statement — and it trains them to
    // ignore the one warning that matters. The figure is right for PRICING and
    // wrong to speak aloud.
    expect(functionBody(main, "function wireRideHud(): RideHud {")).toContain(
      'estimate.basis === "signed_out"',
    );
  });

  it("resolves the allowance ONCE per ride, not per fix", () => {
    // A balance that refreshes mid-ride can cross a threshold backwards and
    // announce it twice.
    expect(hud).toContain("this.freeAtStart = atStart === null ? null : clampFreeMinutes(atStart)");
    expect(functionBody(hud, "  private speakForFix(): void {")).not.toContain(
      "this.freeMinutesAtStart",
    );
  });
});

describe("the mute is reachable", () => {
  it("is a Display chip, and only when a voice is wired", () => {
    // A chip that silences nothing is worse than no chip.
    const body = functionBody(hud, "  private displayChipsMarkup(): string {");
    expect(body).toContain('chip("voice"');
    expect(body).toContain("if (this.voice)");
  });

  it("is labelled by what it IS, like every other chip in that row", () => {
    // "Voice" lit means voice is on. A chip labelled "Mute" that lights up when
    // muted reads as "muted is on" to half of readers and "press to mute" to the
    // other half.
    const body = functionBody(hud, "  private displayChipsMarkup(): string {");
    expect(body).toContain('"Voice"');
    expect(body).not.toContain('"Mute"');
  });
});
