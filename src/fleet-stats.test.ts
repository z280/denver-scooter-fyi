// @vitest-environment happy-dom
//
// The rider-stats panel.
//
// Two kinds of assertion here, and the second kind is the reason this file is
// long. The first is arithmetic and formatting. The second pins the VOICE and
// the DISCLOSURES, because both are requirements rather than taste:
//
//   * scooter.fyi is pro-rider and is NOT an advocacy platform. The copy
//     reports what was counted and never assigns blame — the same figures
//     carry a civic voice on weseeyouveo.com, and the voice may select words
//     only. If a `voice` ever changed a filter, a window or a threshold, the
//     two properties could disagree about a number and neither would be worth
//     quoting. That is the regression the "same numbers" test exists for.
//   * window, sample and radius are always on screen. A percentage without
//     them gets quoted back at you naked, and this one is cumulative — an
//     unlabelled rate reads as "today" when it is every rental we have seen.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FleetOutcomesResponse } from "./api.ts";
import {
  VOICES,
  buildFleetStats,
  renderFleetStats,
  formatOdds,
  formatRate,
  provenanceText,
  type StatsVoice,
} from "./fleet-stats.ts";

function payload(over: Partial<FleetOutcomesResponse> = {}): FleetOutcomesResponse {
  return {
    window: "lifetime",
    counted_since: "sql/072",
    radius_meters: 16,
    rentals: 214_846,
    no_gos: 19_551,
    no_go_rate: 0.091,
    min_rentals_for_rate: 200,
    vehicles: 7_534,
    by_model: [
      { model: "Rover", rentals: 300, no_gos: 150, vehicles: 12, no_go_rate: 0.5 },
      {
        model: "Cosmo",
        rentals: 200_000,
        no_gos: 18_000,
        vehicles: 7_000,
        no_go_rate: 0.09,
      },
      { model: "Halo", rentals: 7, no_gos: 3, vehicles: 2, no_go_rate: null },
    ],
    ...over,
  };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.replaceChildren(host);
});

function render(over: Partial<FleetOutcomesResponse> = {}, voice: StatsVoice = "rider") {
  host.replaceChildren(buildFleetStats(payload(over), voice));
  return host;
}

describe("formatting", () => {
  it("keeps one decimal, because 9.1% was measured and 9% is a round number", () => {
    expect(formatRate(0.091)).toBe("9.1%");
    expect(formatRate(0.5)).toBe("50.0%");
  });

  it("passes a withheld rate straight through as null", () => {
    expect(formatRate(null)).toBeNull();
  });

  it("gives the ratio people actually repeat", () => {
    expect(formatOdds(0.091)).toBe("about 1 in 11");
    expect(formatOdds(0.5)).toBe("about 1 in 2");
  });

  it("has no ratio for a zero or a withheld rate", () => {
    // "1 in Infinity" is the bug this guards.
    expect(formatOdds(0)).toBeNull();
    expect(formatOdds(null)).toBeNull();
  });
});

describe("the disclosures that make the figure quotable", () => {
  it("says the window is every rental, not today's", () => {
    // These counters have never reset. An unlabelled percentage reads as
    // "now", and this is a lifetime figure.
    expect(render().textContent).toContain("All rentals we have seen");
  });

  it("states the sample: rentals and vehicles", () => {
    const text = render().textContent ?? "";
    expect(text).toContain("214,846");
    expect(text).toContain("7,534");
  });

  it("states the radius it was counted at", () => {
    // The app holds three different ideas of how far is "moved" (16 m, 25 m,
    // 50 m — docs/ANALYTICS_PLAN.md §0.2). Until that is settled the figure
    // travels with the circle it was measured against.
    expect(render().textContent).toContain("16 m");
  });

  it("reads the radius off the payload rather than printing a constant", () => {
    expect(provenanceText(payload({ radius_meters: 50 }))).toContain("50 m");
    expect(provenanceText(payload({ radius_meters: 50 }))).not.toContain("16 m");
  });

  it("says the number does not explain itself", () => {
    // A no-go is an attempt that went nowhere. The cause might be the
    // vehicle, the app, the weather, or a rider changing their mind — the
    // panel counts and must not attribute.
    expect(render().textContent).toContain("does not say why");
  });
});

describe("the headline", () => {
  it("leads with the rate and the ratio", () => {
    const text = render().textContent ?? "";
    expect(text).toContain("9.1%");
    expect(text).toContain("about 1 in 11");
    expect(text).toContain("never left the kerb");
  });

  it("shows counts instead of a rate when the whole fleet is under the floor", () => {
    // Possible on a fresh deployment. The counts are the only honest thing
    // to put on screen, and "0.0%" would be a lie about a thin sample.
    const headline = render({ rentals: 40, no_gos: 4, no_go_rate: null }).querySelector(
      ".stats-headline",
    );
    expect(headline?.textContent).toContain("too few for a rate yet");
    // No invented percentage over a sample of 40 — "0.0%" or "10.0%" here
    // would be a confident-looking figure the counts do not support.
    expect(headline?.textContent).not.toContain("%");
  });

  it("reports nothing counted as nothing counted", () => {
    const text = render({ rentals: 0, no_gos: 0, no_go_rate: null, by_model: [] })
      .textContent ?? "";
    expect(text).toContain("No rentals counted yet");
    // No headline, no provenance line about a sample of zero.
    expect(text).not.toContain("never left the kerb");
  });
});

describe("the per-model list", () => {
  it("renders every model the server sent, in the order it sent them", () => {
    // The server ranks worst publishable rate first; re-sorting here would
    // put the panel and the API at odds about what the finding is.
    const names = Array.from(render().querySelectorAll(".stat-row__name")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Rover", "Cosmo", "Halo"]);
  });

  it("keeps a thin model visible, with its counts and no percentage", () => {
    // A list that silently drops its thin rows looks complete and is not.
    const rows = render().querySelectorAll(".stat-row");
    const halo = rows[2];
    expect(halo.textContent).toContain("Halo");
    expect(halo.textContent).toContain("not enough rides yet");
    expect(halo.textContent).toContain("7 rentals");
    expect(halo.textContent).toContain("needs 200");
    expect(halo.querySelector(".stat-row__value--thin")).not.toBeNull();
  });

  it("shows a published model's numerator and denominator, not just its rate", () => {
    const cosmo = render().querySelectorAll(".stat-row")[1];
    expect(cosmo.textContent).toContain("9.0%");
    expect(cosmo.textContent).toContain("18,000 of 200,000 rentals");
  });

  it("renders a flawless model as 0.0% rather than as unknown", () => {
    // Zero is a finding — "this one always goes" — and must not be confused
    // with the withheld null that means "we don't know yet".
    const row = render({
      by_model: [
        { model: "Perfect", rentals: 5_000, no_gos: 0, vehicles: 90, no_go_rate: 0 },
      ],
    }).querySelector(".stat-row");
    expect(row?.textContent).toContain("0.0%");
    expect(row?.querySelector(".stat-row__value--thin")).toBeNull();
  });
});

describe("the voice", () => {
  it("offers exactly the two properties' voices", () => {
    expect(Object.keys(VOICES).sort()).toEqual(["civic", "rider"]);
  });

  it("renders the same numbers under either voice", () => {
    // THE rule from docs/ANALYTICS_PLAN.md: same numbers, different verbs.
    // The voice selects a copy table. If it could ever select a filter, a
    // window or a threshold, scooter.fyi and weseeyouveo.com could publish
    // different figures for the same question, and the numbers are the only
    // asset either site has.
    const figures = (voice: StatsVoice) =>
      Array.from(render({}, voice).querySelectorAll(".stat-row__value, .stats-headline__value"))
        .map((n) => n.textContent)
        .join("|");
    expect(figures("rider")).toBe(figures("civic"));
    expect(provenanceText(payload())).toContain("16 m"); // identical by construction
  });

  it("renders different words under each voice", () => {
    expect(render({}, "rider").querySelector(".stats-title")?.textContent).not.toBe(
      render({}, "civic").querySelector(".stats-title")?.textContent,
    );
  });

  it("never names a culprit in either voice", () => {
    // scooter.fyi is pro-rider, not anti-anybody, and the civic voice is
    // WSYV's to argue in — not this panel's. Neither copy table may carry
    // the verbs that turn a measurement into an accusation.
    const forbidden =
      /\b(fail(s|ed|ing|ure)?|broken|neglect\w*|blame|refus\w+|abandon\w+|should|must|demand\w*|monopol\w+)\b/i;
    for (const [name, copy] of Object.entries(VOICES)) {
      const words = [
        copy.title,
        copy.standfirst,
        copy.headlineLabel,
        copy.modelsLabel,
        copy.empty,
        copy.unavailable,
        copy.crossPromo.lead,
      ].join(" ");
      expect(words, `${name} voice`).not.toMatch(forbidden);
      // Nor Veo by name as the subject of a verb. Naming the operator as the
      // source of the data is fine; this panel does not make it an actor.
      expect(words, `${name} voice`).not.toMatch(/\bVeo (is|was|has|does|keeps|leaves)\b/);
    }
  });
});

describe("cross-promotion", () => {
  it("points each site at the other, not at itself", () => {
    const link = (voice: StatsVoice) =>
      render({}, voice).querySelector<HTMLAnchorElement>(".stats-promo a");
    expect(link("rider")?.href).toContain("weseeyouveo.com");
    expect(link("civic")?.href).toContain("scooter.fyi");
  });

  it("opens the other property without handing it a handle on this page", () => {
    const a = render().querySelector<HTMLAnchorElement>(".stats-promo a");
    expect(a?.target).toBe("_blank");
    expect(a?.rel).toContain("noopener");
    expect(a?.rel).toContain("noreferrer");
  });
});


describe("the story slot", () => {
  it("sits between the figures and the cross-promotion", () => {
    // A reader who has just seen what the fleet did is primed, and this is
    // the only asking moment where they came to read rather than to ride.
    const host = render();
    const slot = host.querySelector('[data-role="story-host"]');
    expect(slot).not.toBeNull();
    const promo = host.querySelector(".stats-promo")!;
    expect(slot!.compareDocumentPosition(promo) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    const models = host.querySelector(".stat-list")!;
    expect(models.compareDocumentPosition(slot!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it("is left empty by the renderer itself", () => {
    // The panel is mounted by the host. Keeping it out of this module is what
    // lets the figures render identically in the embed, which must NOT carry
    // a consent UI inside somebody else's page frame.
    expect(render().querySelector('[data-role="story-host"]')?.childNodes.length)
      .toBe(0);
  });

  it("is not offered at all when there is nothing to report yet", () => {
    // No figures, no primed reader — just an empty panel.
    const host = render({ rentals: 0, no_gos: 0, no_go_rate: null, by_model: [] });
    expect(host.querySelector('[data-role="story-host"]')).toBeNull();
  });

  it("hands the slot to the host only after the figures are on screen", async () => {
    const mountStory = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(payload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    try {
      await renderFleetStats(host, "rider", { mountStory });
      expect(mountStory).toHaveBeenCalledTimes(1);
      const slot = mountStory.mock.calls[0][0] as HTMLElement;
      expect(slot.isConnected).toBe(true);
      expect(host.textContent).toContain("9.1%");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("asks for no slot when the feed could not be read", async () => {
    const mountStory = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    try {
      await renderFleetStats(host, "rider", { mountStory });
      expect(mountStory).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
