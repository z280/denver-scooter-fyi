// @vitest-environment happy-dom
//
// §12.5, the half `device-action-tiers.test.ts` cannot reach: that the CARD
// actually honours the table. A tier rule nothing consults is a comment.
//
// Two of these assertions exist because the thing they pin was broken and
// nobody noticed: 📷 Take Photo and ☑️ Confirm Features had no proximity gate at
// all, and the card's blocked buttons explained themselves with `title`, which
// does not exist on a phone.
import { describe, expect, it } from "vitest";

import {
  ACTION_RULES,
  AT_THE_VEHICLE_M,
  actionsInTier,
} from "./device-action-tiers.ts";
import { readSource, withoutComments } from "../tests/helpers/source-text.ts";

// COMMENTS STRIPPED. devices.ts documents every one of these gates at length,
// naming the actions and the constants, so a raw scan would find `allow("ride")`
// in a paragraph explaining `allow("ride")` and call the gate wired.
const devicesSrc = withoutComments(readSource("src/devices.ts"));

describe("the card consults the table rather than its own numbers", () => {
  it("has no proximity radius of its own at all", () => {
    // The three the card used to carry were 75, 100 and a 1125 computed inline.
    // Each was defensible alone; together they were the drift §12.2 names.
    //
    // THEY BRIEFLY SURVIVED AS ALIASES for the tier constants, and that was a
    // half-measure this assertion used to bless: an alias keeps the shape of the
    // thing that drifted, and it let the unlock and ride gates go on computing
    // their own proximity while ACTION_RULES declared rules nothing read. Now
    // there is nowhere here for a fourth radius to appear.
    expect(devicesSrc).not.toMatch(/^const UNLOCK_PROXIMITY_M\b/m);
    expect(devicesSrc).not.toMatch(/^const RIDE_MAX_WALK_M\b/m);
    expect(devicesSrc).not.toMatch(/^const PARKING_REPORT_PROXIMITY_M\b/m);
  });

  it("asks the table for EVERY gate, leaving no rule declared and unread", () => {
    // The finding this closes: `ACTION_RULES.open_in_veo` and `.ride` were in
    // the table and never consulted, so two entries in the single source of
    // truth were decorative. The radii happened to match, so nothing was
    // broken — which is exactly why it would have survived.
    for (const action of ["open_in_veo", "ride", "report_parking", "report_device", "take_photo", "show_photos", "confirm_features"]) {
      expect(devicesSrc, action).toContain(`allow("${action}")`);
    }
    // Every at_the_vehicle and in_reach rule is consulted — `anywhere` rules
    // that gate nothing (details, dibs) need no call site.
    for (const action of [...actionsInTier("at_the_vehicle"), ...actionsInTier("in_reach")]) {
      expect(devicesSrc, action).toContain(`allow("${action}")`);
    }
  });

  it("gates both of the actions that had no radius at all", () => {
    // The finding, restated so a revert reads as a failure: these were
    // reachable from anywhere on earth.
    expect(ACTION_RULES.take_photo.tier).toBe("at_the_vehicle");
    expect(ACTION_RULES.confirm_features.tier).toBe("at_the_vehicle");
    // And the card asks about them, rather than rendering them unconditionally.
    expect(devicesSrc).toContain('allow("take_photo")');
    expect(devicesSrc).toContain('allow("confirm_features")');
    expect(devicesSrc).toContain('allow("report_device")');
  });

  it("runs the parking report at the same radius as everything else", () => {
    expect(AT_THE_VEHICLE_M).toBe(75);
    expect(ACTION_RULES.report_parking.tier).toBe("at_the_vehicle");
    expect(devicesSrc).toContain('allow("report_parking")');
  });

  it("words the distance per tier, since the right unit differs", () => {
    // Feet for "are you standing at it", walk MINUTES for "will you walk there".
    // The pace that converts them lives in locate.ts beside the walk router that
    // quotes it, so the card supplies the wording and the tier module stays pure.
    expect(devicesSrc).toMatch(/describeDistance: \(meters, tier\) =>/);
    expect(devicesSrc).toMatch(/tier === "in_reach" \? formatWalk\(meters\)/);
  });
});

describe("blocked is a sentence, delivered by tap", () => {
  // WHETHER EVERY BLOCKED BUTTON ACTUALLY CARRIES ITS REASON is asserted over
  // the RENDERED popup in `devices-popup-gate.test.ts`, not here. A first
  // version of this test pattern-matched the template literals in this file's
  // source and was wrong twice over: the report chips build their attributes in
  // a separate variable, so the regex could not see them, and matching source
  // text proves what the code looks like rather than what it renders.
  it("delivers the reason from the attribute, not from a captured variable", () => {
    // The three hand-wired handlers this replaced each passed a captured
    // string, which is how 📷 Take Photo came to announce a sign-in hint to a
    // rider who was signed in and merely 400 m away.
    expect(devicesSrc).toContain('".device-popup__actbtn[data-blocked]"');
    expect(devicesSrc).toContain("showHint(btn.dataset.blocked");
  });
});

describe("the report chips", () => {
  it("still read their reason from data-blocked and stay tappable", () => {
    expect(devicesSrc).toContain("const blocked = chip.dataset.blocked;");
    expect(devicesSrc).toMatch(/reportBlockedAttr = reportBlockedReason/);
  });
});

describe("the admin exemption is one rule, not four coincidences", () => {
  it("is applied in the tier module and nowhere re-derived per action", () => {
    // Every at_the_vehicle action goes through the same `allow(...)`, which is
    // the only place `admin` is consulted for proximity.
    for (const a of actionsInTier("at_the_vehicle")) {
      expect(ACTION_RULES[a].tier, a).toBe("at_the_vehicle");
    }
    // The card builds one context, once.
    expect(devicesSrc).toMatch(/const gateCtx: GateContext = \{/);
    expect(devicesSrc.match(/const gateCtx: GateContext = \{/g)).toHaveLength(1);
  });
});

describe("§12.3 — the card is ordered by what the rider decides on", () => {
  it("keeps Vehicle ID and Parked for out of the popup's own stat list", () => {
    // Both are AUDITING facts. In the stat list they carried the same visual
    // weight as battery and equipment, which are what the rider actually
    // chooses on, and sat above ~8 full-width action buttons — so the rider
    // scrolled past the controls to reach the facts the controls depend on.
    const statBlock = devicesSrc.slice(
      devicesSrc.indexOf("const statRows: string[] = []"),
      devicesSrc.indexOf("const detailRows: string[] = []"),
    );
    expect(statBlock).not.toContain("<dt>Vehicle ID</dt>");
    expect(statBlock).not.toContain("<dt>Parked for</dt>");
  });

  it("moves them, rather than removing them", () => {
    // `Parked for` is the dwell figure — the compliance signal this whole app
    // exists to publish — and it keeps its peer-median context. One tap
    // further from the decision, not gone.
    const detailBlock = devicesSrc.slice(devicesSrc.indexOf("const detailRows: string[] = []"));
    expect(detailBlock).toContain("<dt>Vehicle ID</dt>");
    expect(detailBlock).toContain("<dt>Parked for</dt>");
    expect(detailBlock).toContain("dwell_peer_median_hours");
  });
});
