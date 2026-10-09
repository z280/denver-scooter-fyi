// @vitest-environment happy-dom
//
// The popup's facts strip, rendered and read back as a DOM rather than matched
// as source text: OUR range is the headline, Veo's is the comparison under it,
// Veo's takes the headline (labelled) only when ours is missing, a stale
// reading says so, and the range circle is drawn at the headline's metres.
import { describe, expect, it } from "vitest";

import {
  OBSERVED_METERS_PER_SOC_POINT,
  STALE_HINT,
  formatKm,
  headlineRangeMeters,
  renderFactsStrip,
  type FactsStripInput,
} from "./range-facts.ts";

// A real live feature (2026-10-09): 93%, ours 33,852 m, Veo's 42,671 m.
const BASE: FactsStripInput = {
  batteryPercent: 93,
  ourRangeMeters: 33_852,
  veoRangeMeters: 42_671,
  batteryReading: "fresh",
  deviceId: "dev-1",
  coords: [-104.99, 39.74],
  showing: false,
};

function render(over: Partial<FactsStripInput> = {}): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderFactsStrip({ ...BASE, ...over });
  return host;
}
const facts = (h: HTMLElement) =>
  [...h.querySelectorAll(".device-popup__fact")].map((e) => e.textContent?.trim());
const note = (h: HTMLElement) =>
  h.querySelector(".device-popup__range-note")?.textContent ?? null;
const button = (h: HTMLElement) =>
  h.querySelector<HTMLButtonElement>('[data-action="toggle-range"]');

describe("the facts strip", () => {
  it("makes our real-world range the headline", () => {
    const h = render();
    expect(facts(h)).toEqual(["🔋 93%", "~34 km real-world"]);
    // Veo's figure is NOT in the headline.
    expect(facts(h).join(" ")).not.toContain("43");
  });

  it("puts Veo's estimate and what ours is directly beneath, in one muted line", () => {
    const h = render();
    expect(note(h)).toBe(
      "Veo estimates 43 km. Ours is measured full-to-empty in Denver.",
    );
    // Inside the strip, after the headline.
    const strip = h.querySelector(".device-popup__facts")!;
    expect(strip.lastElementChild?.className).toBe("device-popup__range-note");
  });

  it("draws the range circle at OUR metres", () => {
    const btn = button(render())!;
    expect(btn.textContent?.trim()).toBe("Show on map");
    expect(Number(btn.dataset.radius)).toBe(33_852);
    expect(btn.dataset.device).toBe("dev-1");
    expect(Number(btn.dataset.lng)).toBe(-104.99);
    expect(Number(btn.dataset.lat)).toBe(39.74);
    expect(button(render({ showing: true }))!.textContent?.trim()).toBe("Hide on map");
  });

  it("falls back to Veo's figure, labelled as Veo's, when ours is missing", () => {
    for (const missing of [null, Number.NaN]) {
      const h = render({ ourRangeMeters: missing });
      expect(facts(h)).toEqual(["🔋 93%", "~43 km (Veo's estimate)"]);
      // The circle follows the headline.
      expect(Number(button(h)!.dataset.radius)).toBe(42_671);
      // No comparison line: there is nothing to compare it with, and no
      // "ours is measured…" sentence about a number that is not on the card.
      expect(note(h)).toBeNull();
    }
  });

  it("adds the stale hint when the reading is stale", () => {
    const h = render({ batteryReading: "stale" });
    expect(note(h)).toBe(
      "Veo estimates 43 km. Ours is measured full-to-empty in Denver. " +
        STALE_HINT,
    );
    // It is about the API's real threshold: parked ≥ 1 hour.
    expect(STALE_HINT).toMatch(/1 h\+/);
    // Fresh and unknown readings get no hint.
    expect(note(render({ batteryReading: "unknown" }))).not.toContain(STALE_HINT);
    expect(note(render({ batteryReading: "fresh" }))).not.toContain(STALE_HINT);
  });

  it("keeps the stale hint on the Veo fallback too", () => {
    expect(note(render({ ourRangeMeters: null, batteryReading: "stale" }))).toBe(STALE_HINT);
  });

  it("says what ours is even when Veo gave no figure", () => {
    const h = render({ veoRangeMeters: null });
    expect(facts(h)).toEqual(["🔋 93%", "~34 km real-world"]);
    expect(note(h)).toBe("Ours is measured full-to-empty in Denver.");
  });

  it("shows battery alone, with no button or note, when neither range exists", () => {
    const h = render({ ourRangeMeters: null, veoRangeMeters: null, batteryReading: "stale" });
    expect(facts(h)).toEqual(["🔋 93%"]);
    expect(button(h)).toBeNull();
    expect(note(h)).toBeNull();
  });

  it("renders nothing at all when the feed told us nothing", () => {
    expect(
      renderFactsStrip({ ...BASE, batteryPercent: null, ourRangeMeters: null, veoRangeMeters: null }),
    ).toBe("");
  });

  it("uses the low-battery glyph under 25%", () => {
    expect(facts(render({ batteryPercent: 12, ourRangeMeters: 12 * 364 }))[0]).toBe("🪫 12%");
  });
});

describe("formatting", () => {
  it("rounds to whole km from 10 km up, one decimal below", () => {
    expect(formatKm(33_852)).toBe("34 km");
    expect(formatKm(42_671)).toBe("43 km");
    expect(formatKm(10_000)).toBe("10 km");
    expect(formatKm(1_820)).toBe("1.8 km");
    expect(formatKm(0)).toBe("0.0 km");
    // Rounds before choosing a format, so 9.96 km is "10 km", not "10.0 km".
    expect(formatKm(9_960)).toBe("10 km");
  });

  it("headline metres prefer ours, then Veo's", () => {
    expect(headlineRangeMeters(1, 2)).toBe(1);
    expect(headlineRangeMeters(null, 2)).toBe(2);
    expect(headlineRangeMeters(null, null)).toBeNull();
  });

  it("mirrors the API's measured constant", () => {
    expect(OBSERVED_METERS_PER_SOC_POINT).toBe(364);
  });
});
