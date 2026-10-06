// @vitest-environment happy-dom
//
// The framed stats page's one decision: which voice to render.
//
// Worth its own test because the failure it prevents is invisible from here.
// The embed code lives on a page at weseeyouveo.com that nobody at
// scooter.fyi edits, so a typo in `?voice=` must cost the wording and not the
// panel — a blank iframe on somebody else's site is a bug no one here would
// see reported.

import { describe, expect, it } from "vitest";

import { VOICES } from "./fleet-stats.ts";
import { voiceFromSearch } from "./embed-stats.ts";

describe("the voice parameter", () => {
  it("selects the civic voice for weseeyouveo.com", () => {
    expect(voiceFromSearch("?voice=civic")).toBe("civic");
  });

  it("selects the rider voice for scooter.fyi", () => {
    expect(voiceFromSearch("?voice=rider")).toBe("rider");
  });

  it("falls back to the rider voice rather than rendering nothing", () => {
    for (const search of [
      "",
      "?",
      "?voice=",
      "?voice=RIDER", // case is not handled, and failing closed is correct
      "?voice=politics",
      "?theme=dark",
      "?voice=civic%00",
    ]) {
      expect(voiceFromSearch(search), search).toBe("rider");
    }
  });

  it("only ever returns a voice the copy table defines", () => {
    // The guard against a future `?voice=` value reaching VOICES[...] and
    // yielding undefined, which would throw inside the renderer and leave the
    // host with an empty frame.
    for (const search of ["?voice=civic", "?voice=rider", "?voice=nonsense"]) {
      expect(VOICES[voiceFromSearch(search)]).toBeDefined();
    }
  });
});
