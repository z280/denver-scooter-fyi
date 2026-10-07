// Phase 8 §8.5/§8.7. The assertions that matter here are about what reaches
// Veo and what cannot: the CC must be a real recipient on both paths, both paths
// must carry the same content, and neither may be reachable from an unconfirmed
// receipt.
import { describe, expect, it } from "vitest";

import {
  EQUITY_DISCOUNT_CITATION,
  RATE_PLANS,
  VEO_SUPPORT_EMAIL,
  complaintReady,
  type RatePlanKey,
} from "./config.ts";
import { equityAreaEstimateWithTax } from "./ride-cost.ts";
import {
  MAILTO_MAX_URI_CHARS,
  complaintDraft,
  complaintRoute,
  mailtoUri,
  overchargeFinding,
  type ComplaintFacts,
} from "./receipt-complaint.ts";
import { confirmRead, receiptVerdict } from "./receipt-verdict.ts";

const rate = (key: RatePlanKey) => RATE_PLANS.find((p) => p.key === key)!;
const MINUTES = 15;
const EXPECTED = equityAreaEstimateWithTax(MINUTES * 60_000, 0).total; // $2.95
const BASE_FARE = 100 + MINUTES * 25; // $4.75, the discount not applied

function verdict(totalCents: number, key: RatePlanKey = "resident") {
  return receiptVerdict(confirmRead({ minutes: MINUTES, totalCents }), {
    startedOrEndedInArea: true,
    rate: rate(key),
    taxRate: 0,
  });
}

function facts(over: Partial<ComplaintFacts> = {}): ComplaintFacts {
  return {
    accountId: "rider@example.com",
    tripDate: "2026-10-06",
    minutes: MINUTES,
    chargedCents: BASE_FARE,
    areaName: "Equity Area 014",
    ...over,
  };
}

const finding = () => overchargeFinding(verdict(BASE_FARE))!;
const TO = "support@example.com";

describe("the gate: neither path is reachable without a finding", () => {
  it("refuses every verdict but overcharged", () => {
    // §8.7: "gating only one of them means an unconfirmed complaint can still be
    // opened and sent". So the gate is a TYPE both paths take, not a boolean
    // checked in two places — which is the shape that gets checked in one.
    expect(overchargeFinding(verdict(EXPECTED))).toBeNull(); // correct
    expect(overchargeFinding(verdict(EXPECTED + 5))).toBeNull(); // inside_margin
    expect(overchargeFinding(verdict(EXPECTED, "resident_plus"))).toBeNull(); // veoplus
    expect(
      overchargeFinding(
        receiptVerdict(confirmRead({ minutes: MINUTES, totalCents: BASE_FARE }), {
          startedOrEndedInArea: null,
          rate: rate("resident"),
          taxRate: 0,
        }),
      ),
    ).toBeNull(); // no_geography
  });

  it("accepts an overcharge, and only through a confirmed receipt", () => {
    // The chain is confirm → verdict → finding → complaint, and no link can be
    // skipped: `receiptVerdict` takes a `ConfirmedReceipt` and only
    // `confirmRead()` makes one.
    const f = overchargeFinding(verdict(BASE_FARE));
    expect(f).not.toBeNull();
    expect(f!.__overcharge).toBe(true);
  });
});

describe("the body carries the complaint's whole case", () => {
  const draft = () => complaintDraft(finding(), facts(), TO);

  it("names the account, the trip, both figures and the citation", () => {
    const body = draft().body;
    expect(body).toContain("rider@example.com");
    expect(body).toContain("2026-10-06");
    expect(body).toContain("15 min");
    expect(body).toContain("$4.75"); // charged
    expect(body).toContain("$2.95"); // expected
    expect(body).toContain("$1.80"); // the difference
    expect(body).toContain(EQUITY_DISCOUNT_CITATION);
  });

  it("puts the citation underneath the facts, not woven into them", () => {
    const body = draft().body;
    expect(body.indexOf("Charged:")).toBeLessThan(body.indexOf(EQUITY_DISCOUNT_CITATION));
  });

  it("reads like a billing query, with no adjectives", () => {
    // At the single-receipt level an overcharge is indistinguishable from a bug.
    const body = draft().body.toLowerCase();
    for (const word of ["illegal", "owe me", "refund", "violation", "overcharged", "unfair"]) {
      expect(body, word).not.toContain(word);
    }
  });

  it("omits the area name rather than guessing one", () => {
    const body = complaintDraft(finding(), facts({ areaName: undefined }), TO).body;
    expect(body).toContain("designated Equity Area");
    expect(body).not.toContain("(undefined)");
  });

  it("breaks the expected figure into its parts, so it can be argued with", () => {
    const body = draft().body;
    expect(body).toContain("unlock $1.00");
    expect(body).toContain("$0.13");
  });
});

describe("the CC is a real recipient on BOTH paths", () => {
  it("is a mailto header, never body text", () => {
    // §10's CC is the reason the primary path is a mailto: at all — text in a
    // body cannot set a recipient.
    const draft = complaintDraft(finding(), facts({ cc: "council@example.gov" }), TO);
    expect(draft.cc).toBe("council@example.gov");
    expect(draft.body).not.toContain("council@example.gov");
    const uri = mailtoUri(draft);
    expect(uri).toContain(`cc=${encodeURIComponent("council@example.gov")}`);
  });

  it("survives the clipboard fallback as its own field", () => {
    // "A fallback that drops the CC into prose is the bug this section exists to
    // prevent." Asserted on the fallback's own shape, not on the body.
    const draft = complaintDraft(finding(), facts({ cc: "council@example.gov", accountId: "x".repeat(2200) }), TO);
    const route = complaintRoute(draft);
    expect(route.kind).toBe("clipboard");
    if (route.kind !== "clipboard") return;
    expect(route.draft.cc).toBe("council@example.gov");
    expect(route.draft.body).not.toContain("council@example.gov");
  });

  it("emits no cc parameter at all when the rider did not opt in", () => {
    const uri = mailtoUri(complaintDraft(finding(), facts(), TO));
    expect(uri).not.toContain("cc=");
  });
});

describe("the fallback is decided on the ENCODED URI", () => {
  it("measures the URI, not the body — encoding can more than double it", () => {
    // A body of newlines and spaces encodes to three characters each. Measuring
    // the body would clear a threshold the URI blows straight past.
    const draft = complaintDraft(finding(), facts({ accountId: "\n".repeat(500) }), TO);
    expect(draft.body.length).toBeLessThan(MAILTO_MAX_URI_CHARS);
    expect(mailtoUri(draft).length).toBeGreaterThan(MAILTO_MAX_URI_CHARS);
    expect(complaintRoute(draft).kind).toBe("clipboard");
  });

  it("opens the draft at exactly the threshold and copies one past it", () => {
    // §8.7 wants both sides, because the failure being prevented is a silently
    // truncated draft rather than an error. Built by growing the account id until
    // the URI lands on the boundary exactly.
    const atLength = (target: number) => {
      let pad = 0;
      for (let i = 0; i < 4000; i += 1) {
        const d = complaintDraft(finding(), facts({ accountId: "a".repeat(i) }), TO);
        if (mailtoUri(d).length === target) {
          pad = i;
          break;
        }
      }
      expect(pad, `no padding produced a ${target}-char URI`).toBeGreaterThan(0);
      return complaintDraft(finding(), facts({ accountId: "a".repeat(pad) }), TO);
    };

    const exact = atLength(MAILTO_MAX_URI_CHARS);
    expect(mailtoUri(exact).length).toBe(1800);
    expect(complaintRoute(exact).kind).toBe("mailto");

    const over = atLength(MAILTO_MAX_URI_CHARS + 1);
    expect(mailtoUri(over).length).toBe(1801);
    const route = complaintRoute(over);
    expect(route.kind).toBe("clipboard");
    if (route.kind === "clipboard") expect(route.reason).toBe("too_long");
  });

  it("encodes the recipient too, since a + in an address is legal", () => {
    // An unencoded `+` arrives as a space.
    const uri = mailtoUri({
      to: "a+b@example.com",
      subject: "s",
      body: "b",
    });
    expect(uri).toContain("a%2Bb%40example.com");
  });
});

describe("both paths carry the same content", () => {
  it("hands the clipboard route the very same draft", () => {
    // §8.5 made mailto: primary, and §8.7 notes that testing only the fallback
    // would let the normal draft omit everything. One draft, two ways out.
    const draft = complaintDraft(finding(), facts(), TO);
    const mail = complaintRoute(draft);
    expect(mail.kind).toBe("mailto");
    if (mail.kind !== "mailto") return;
    expect(mail.draft).toBe(draft);
    // And the body is recoverable from the URI the rider's client will open.
    const parsed = new URL(mail.uri);
    expect(decodeURIComponent(parsed.searchParams.get("body") ?? "")).toBe(draft.body);
  });
});

describe("a missing support address is its own answer", () => {
  it("copies rather than opening a draft addressed to nobody", () => {
    // config.ts's VEO_SUPPORT_EMAIL ships empty on purpose, so this is the LIVE
    // path today. A mailto: with an empty `to` opens a blank draft, which looks
    // like the feature working.
    const route = complaintRoute(complaintDraft(finding(), facts(), ""));
    expect(route.kind).toBe("clipboard");
    if (route.kind !== "clipboard") return;
    expect(route.reason).toBe("no_address");
    // And the rider still gets the whole case to paste — the body does not
    // depend on there being a recipient.
    expect(route.draft.body).toContain("$2.95");
  });

  it("is what config.ts's own gate reports, so the surface agrees", () => {
    expect(complaintReady()).toBe(VEO_SUPPORT_EMAIL.includes("@"));
    expect(complaintRoute(complaintDraft(finding(), facts(), VEO_SUPPORT_EMAIL)).kind).toBe(
      complaintReady() ? "mailto" : "clipboard",
    );
  });
});
