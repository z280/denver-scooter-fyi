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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const devicesSrc = readFileSync(
  join(import.meta.dirname, "devices.ts"),
  "utf8",
);

describe("the card consults the table rather than its own numbers", () => {
  it("has no literal proximity radius of its own left", () => {
    // The three the card used to carry were 75, 100 and a 1125 computed inline.
    // Each was defensible alone; together they were the drift §12.2 names. A
    // literal here is how a fourth appears.
    const consts = devicesSrc.match(/^const (?:UNLOCK_PROXIMITY_M|PARKING_REPORT_PROXIMITY_M|RIDE_MAX_WALK_M) = .*$/gm);
    expect(consts).toHaveLength(3);
    for (const line of consts ?? []) {
      expect(line).toMatch(/AT_THE_VEHICLE_M|IN_REACH_M/);
      // No bare number in the VALUE. Comments are stripped first: the `IN_REACH_M`
      // line documents "~1125 m" for the reader, which is the figure's meaning
      // and not a second source for it.
      const value = line.split("=").slice(1).join("=").split("//")[0];
      expect(value, line).not.toMatch(/\b\d{2,}\b/);
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
    expect(devicesSrc).toMatch(/const PARKING_REPORT_PROXIMITY_M = AT_THE_VEHICLE_M;/);
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
