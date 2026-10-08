// Phase 11 §11.1/§11.3. What is pinned here is WHEN the app speaks, which is the
// whole question: a turn cue that arrives late is worse than none, and a cue that
// repeats trains the rider to stop listening.
import { describe, expect, it } from "vitest";

import { EQUITY_AREA_RATE } from "./config.ts";
import {
  FREE_MINUTE_WARNINGS,
  INITIAL_ANNOUNCE_STATE,
  TURN_LEAD_MAX_METERS,
  TURN_LEAD_MIN_METERS,
  TURN_LEAD_SECONDS,
  announce,
  clampFreeMinutes,
  turnLeadMeters,
  type AnnounceInput,
  type AnnounceState,
} from "./ride-announce.ts";

function input(over: Partial<AnnounceInput> = {}): AnnounceInput {
  return {
    status: "riding",
    speedMps: 5,
    maneuver: null,
    insideEquityArea: false,
    freeMinutesLeft: null,
    blocked: false,
    muted: false,
    ...over,
  };
}

const turn = (metersAway: number, index = 0) => ({
  index,
  instruction: "Turn right onto Larimer Street",
  metersAway,
});

/** Feed a sequence of samples, returning every announcement in order. */
function run(samples: Partial<AnnounceInput>[], from: AnnounceState = INITIAL_ANNOUNCE_STATE) {
  let state = from;
  const all: ReturnType<typeof announce>["announcements"] = [];
  for (const s of samples) {
    const r = announce(input(s), state);
    state = r.state;
    all.push(...r.announcements);
  }
  return { all, state };
}

describe("the turn distance scales with speed", () => {
  it("is further out the faster you are going", () => {
    // §11.1: "a fixed 100 m is too late at 15 mph and absurd at walking pace".
    expect(turnLeadMeters(5)).toBe(5 * TURN_LEAD_SECONDS); // ~11 mph → 40 m
    expect(turnLeadMeters(10)).toBe(10 * TURN_LEAD_SECONDS); // ~22 mph → 80 m
    expect(turnLeadMeters(10)).toBeGreaterThan(turnLeadMeters(5));
  });

  it("has a floor, so a stopped rider is not told about a turn they are sitting on", () => {
    expect(turnLeadMeters(0)).toBe(TURN_LEAD_MIN_METERS);
    expect(turnLeadMeters(1)).toBe(TURN_LEAD_MIN_METERS);
  });

  it("has a ceiling, so two turns are not announced as one", () => {
    expect(turnLeadMeters(100)).toBe(TURN_LEAD_MAX_METERS);
  });

  it("survives a garbage speed rather than producing NaN metres", () => {
    // A fix with no speed field, or a negative one from a bad sensor.
    for (const bad of [NaN, -5, Infinity]) {
      expect(Number.isFinite(turnLeadMeters(bad)), String(bad)).toBe(true);
    }
    expect(turnLeadMeters(NaN)).toBe(TURN_LEAD_MIN_METERS);
  });
});

describe("one utterance per maneuver", () => {
  it("speaks a turn once it is inside the lead distance", () => {
    const { all } = run([{ maneuver: turn(200) }, { maneuver: turn(30) }]);
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("turn");
    expect(all[0].text).toBe("Turn right onto Larimer Street");
  });

  it("does not repeat it across a re-route or a GPS wobble", () => {
    // Dedup is BY MANEUVER INDEX, so the same turn re-reported — which is what a
    // re-route or a jittery fix produces — cannot speak twice.
    const { all } = run([
      { maneuver: turn(30) },
      { maneuver: turn(28) },
      { maneuver: turn(35) },
      { maneuver: turn(10) },
    ]);
    expect(all).toHaveLength(1);
  });

  it("speaks the NEXT maneuver, which is a different index", () => {
    const { all } = run([{ maneuver: turn(30, 0) }, { maneuver: turn(30, 1) }]);
    expect(all).toHaveLength(2);
    expect(all.every((a) => a.kind === "turn")).toBe(true);
  });

  it("buzzes, because the rider has the phone in a pocket", () => {
    const { all } = run([{ maneuver: turn(20) }]);
    expect(all[0].haptic).toBe(true);
  });
});

describe("silence", () => {
  it("says nothing while muted", () => {
    expect(run([{ maneuver: turn(10), muted: true }]).all).toEqual([]);
  });

  it("says nothing over a popup or a modal", () => {
    expect(run([{ maneuver: turn(10), blocked: true }]).all).toEqual([]);
  });

  it("says nothing when the ride is not riding", () => {
    for (const status of ["idle", "setup", "paused", "ended"]) {
      expect(run([{ maneuver: turn(10), status }]).all, status).toEqual([]);
    }
  });

  it("does NOT mark a silenced turn as spoken, so it lands when the popup closes", () => {
    const { all } = run([
      { maneuver: turn(30), blocked: true },
      { maneuver: turn(25) },
    ]);
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("turn");
  });

  it("keeps watching the boundary while silent, rather than announcing it late", () => {
    // A rider who is muted crosses boundaries like anybody else. If the baseline
    // froze, the crossing would surface at some arbitrary later moment — out of
    // place and wrong. Silence means "say nothing", never "stop watching".
    const { all } = run([
      { insideEquityArea: false },
      { insideEquityArea: true, muted: true }, // crossed in, silently
      { insideEquityArea: true }, // unmuted, still inside: nothing to report
    ]);
    expect(all).toEqual([]);
  });
});

describe("the equity-area boundary — the most on-mission event here", () => {
  it("announces the rate on entry, not a saving", () => {
    // A saving needs a baseline and the rider's tier is not this module's
    // business. The number they will be billed at is a fact.
    const { all } = run([{ insideEquityArea: false }, { insideEquityArea: true }]);
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("equity_entered");
    expect(all[0].text).toContain(`${EQUITY_AREA_RATE.perMinCents} cents a minute`);
    expect(all[0].haptic).toBe(true);
  });

  it("announces leaving too, because the rate goes back up", () => {
    const { all } = run([
      { insideEquityArea: false },
      { insideEquityArea: true },
      { insideEquityArea: false },
    ]);
    expect(all.map((a) => a.kind)).toEqual(["equity_entered", "equity_left"]);
  });

  it("says nothing on the FIRST sample, which only establishes a baseline", () => {
    // A rider who starts inside an area has not just entered it.
    expect(run([{ insideEquityArea: true }]).all).toEqual([]);
    expect(run([{ insideEquityArea: false }]).all).toEqual([]);
  });

  it("treats unloaded polygons as unknown, never as outside", () => {
    // Reading null as `false` would announce LEAVING an area the app has not
    // looked at yet.
    const { all } = run([
      { insideEquityArea: true },
      { insideEquityArea: null },
      { insideEquityArea: null },
    ]);
    expect(all).toEqual([]);
  });

  it("does not re-announce while the rider stays inside", () => {
    const { all } = run([
      { insideEquityArea: false },
      { insideEquityArea: true },
      { insideEquityArea: true },
      { insideEquityArea: true },
    ]);
    expect(all).toHaveLength(1);
  });
});

describe("the free-minute cliff", () => {
  it("warns at each threshold, once", () => {
    const { all } = run([
      { freeMinutesLeft: 20 },
      { freeMinutesLeft: 10 },
      { freeMinutesLeft: 9 },
      { freeMinutesLeft: 5 },
      { freeMinutesLeft: 2 },
    ]);
    expect(all.map((a) => a.kind)).toEqual([
      "free_minutes",
      "free_minutes",
      "free_minutes",
    ]);
    expect(all[0].text).toContain("10 minutes");
    expect(all[2].text).toContain("2 minutes");
  });

  it("announces the urgent threshold when a sample skips past several", () => {
    // A backgrounded tab, or a long gap between fixes. Announcing "10 minutes
    // left" to a rider with 2 is worse than saying nothing.
    const { all } = run([{ freeMinutesLeft: 20 }, { freeMinutesLeft: 2 }]);
    expect(all).toHaveLength(1);
    expect(all[0].text).toContain("2 minutes");
    expect(all[0].text).not.toContain("10");
  });

  it("does not then re-announce the thresholds it skipped", () => {
    const { all } = run([
      { freeMinutesLeft: 20 },
      { freeMinutesLeft: 2 },
      { freeMinutesLeft: 2 },
      { freeMinutesLeft: 1 },
    ]);
    expect(all).toHaveLength(1);
  });

  it("says when they are gone, once", () => {
    const { all } = run([
      { freeMinutesLeft: 1 },
      { freeMinutesLeft: 0 },
      { freeMinutesLeft: 0 },
    ]);
    expect(all.map((a) => a.kind)).toEqual(["free_minutes", "free_minutes_gone"]);
    expect(all[1].text).toContain("paying by the minute");
  });

  it("says nothing at all for a tier with no allowance", () => {
    // Four of the five tiers. A cliff warning to somebody with no cliff is noise
    // that teaches them to ignore the one signal that matters.
    expect(run([{ freeMinutesLeft: null }, { freeMinutesLeft: null }]).all).toEqual([]);
  });

  it("uses singular for one minute", () => {
    const { all } = run([{ freeMinutesLeft: 1 }]);
    expect(all[0].text).toBe("1 minute of your free time left.");
  });

  it("covers every declared threshold", () => {
    // A threshold added to the list without a path to being announced is a
    // comment.
    for (const t of FREE_MINUTE_WARNINGS) {
      const { all } = run([{ freeMinutesLeft: t + 1 }, { freeMinutesLeft: t }]);
      expect(all.length, `threshold ${t}`).toBeGreaterThan(0);
    }
  });
});

describe("money before turns", () => {
  it("puts the boundary crossing ahead of the turn cue in one sample", () => {
    // A rider hears one thing at a time. A turn cue comes round again on the next
    // sample; a boundary crossing does not.
    const { all } = run([
      { insideEquityArea: false },
      { insideEquityArea: true, maneuver: turn(20) },
    ]);
    expect(all.map((a) => a.kind)).toEqual(["equity_entered", "turn"]);
  });
});

describe("clampFreeMinutes", () => {
  it("holds the figure inside the allowance it is about", () => {
    // A negative balance is "gone" and not a number to read out; one above the
    // hour is a bad estimate and not a bonus.
    expect(clampFreeMinutes(15)).toBe(15);
    expect(clampFreeMinutes(-10)).toBe(0);
    expect(clampFreeMinutes(900)).toBe(60);
  });

  it("floors a fractional figure rather than announcing a decimal", () => {
    expect(clampFreeMinutes(2.9)).toBe(2);
  });

  it("treats garbage as gone, not as a full hour", () => {
    // The safe direction: warning early costs the rider nothing, and a NaN that
    // became 60 would silence the cliff for the whole ride.
    expect(clampFreeMinutes(NaN)).toBe(0);
    expect(clampFreeMinutes(Infinity)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §11.5 — battery reach
//
// The deciding lives in `ride-reach.ts` and is tested there. What is pinned
// here is the part only the announcer owns: that it is said ONCE, that it is
// ordered against the other cues, and that every reason for silence silences
// it rather than hedging it.
// ---------------------------------------------------------------------------

const HERE = { lat: 39.7526, lng: -105.0 };
/** A destination far enough east that 1 km of range cannot cover it. */
const FAR = { lat: 39.7526, lon: -104.94 };

const shortReach = () => ({
  startRangeMeters: 1_000,
  travelledMeters: 0,
  at: HERE,
  dest: FAR,
});

describe("battery reach", () => {
  it("says it once, however many fixes arrive", () => {
    // The condition is STICKY — range only falls, distance only grows — so a
    // missing dedup would fire this on every fix for the rest of the ride.
    const { all } = run([
      { reach: shortReach() },
      { reach: shortReach() },
      { reach: { ...shortReach(), travelledMeters: 500 } },
    ]);
    expect(all.filter((a) => a.kind === "battery_reach")).toHaveLength(1);
  });

  it("buzzes, because it is worth acting on", () => {
    const { all } = run([{ reach: shortReach() }]);
    expect(all[0].kind).toBe("battery_reach");
    expect(all[0].haptic).toBe(true);
  });

  it("outranks a turn cue on the same fix", () => {
    // Not a money fact, but the one thing that can end the ride early — and a
    // turn cue comes round again on the next sample.
    const { all } = run([{ reach: shortReach(), maneuver: turn(30) }]);
    expect(all.map((a) => a.kind)).toEqual(["battery_reach", "turn"]);
  });

  it("comes after the money moments, which are the most on-mission", () => {
    const { all } = run([
      { insideEquityArea: false },
      { insideEquityArea: true, reach: shortReach() },
    ]);
    expect(all.map((a) => a.kind)).toEqual(["equity_entered", "battery_reach"]);
  });

  it("says nothing at all when the ride cannot answer the question", () => {
    // THE CONFIDENCE FLOOR, at the announcer's edge: `reach` absent is the one
    // check, and it must not produce a hedged warning.
    expect(run([{ reach: null }]).all).toEqual([]);
    expect(run([{}]).all).toEqual([]);
    expect(run([{ reach: { ...shortReach(), startRangeMeters: null } }]).all).toEqual([]);
    expect(run([{ reach: { ...shortReach(), dest: null } }]).all).toEqual([]);
    expect(run([{ reach: { ...shortReach(), at: null } }]).all).toEqual([]);
  });

  it("says nothing when the battery is fine", () => {
    expect(run([{ reach: { ...shortReach(), startRangeMeters: 50_000 } }]).all).toEqual([]);
  });

  it("is silenced by mute, by a popup, and by not riding", () => {
    for (const over of [
      { muted: true },
      { blocked: true },
      { status: "paused" },
    ]) {
      expect(run([{ reach: shortReach(), ...over }]).all).toEqual([]);
    }
  });

  it("is still owed after the silence lifts", () => {
    // Nothing is marked spoken while silent, so a warning withheld during a
    // BRB arrives when the rider is moving again — unlike a turn, it does not
    // stop being true.
    const { all } = run([
      { reach: shortReach(), muted: true },
      { reach: shortReach() },
    ]);
    expect(all.map((a) => a.kind)).toEqual(["battery_reach"]);
  });
});
