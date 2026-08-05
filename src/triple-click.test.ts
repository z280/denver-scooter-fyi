// @vitest-environment happy-dom
//
// The triple-click recognizer. Pure logic with an injected clock, so every
// timing case here is exact rather than approximately-fast-enough.
import { describe, expect, it } from "vitest";

import {
  TRIPLE_CLICK_COUNT,
  TRIPLE_CLICK_WINDOW_MS,
  createTripleClickDetector,
} from "./triple-click.ts";

describe("createTripleClickDetector", () => {
  it("fires on the third consecutive click on the same key", () => {
    const d = createTripleClickDetector<string>();
    expect(d.register("a", 0)).toBe(false);
    expect(d.register("a", 100)).toBe(false);
    expect(d.register("a", 200)).toBe(true);
  });

  it("does not fire on one or two clicks", () => {
    const d = createTripleClickDetector<string>();
    expect(d.register("a", 0)).toBe(false);
    expect(d.count()).toBe(1);
    expect(d.register("a", 50)).toBe(false);
    expect(d.count()).toBe(2);
  });

  it("measures the window between consecutive clicks, not from the first", () => {
    const d = createTripleClickDetector<string>();
    const slow = TRIPLE_CLICK_WINDOW_MS - 1;
    // Total elapsed is well past one window, but no single gap is.
    expect(d.register("a", 0)).toBe(false);
    expect(d.register("a", slow)).toBe(false);
    expect(d.register("a", slow * 2)).toBe(true);
  });

  it("a gap longer than the window starts a fresh run", () => {
    const d = createTripleClickDetector<string>();
    d.register("a", 0);
    d.register("a", 100);
    // Too late to be the third — becomes the first of a new run.
    expect(d.register("a", 100 + TRIPLE_CLICK_WINDOW_MS + 1)).toBe(false);
    expect(d.count()).toBe(1);
  });

  it("accepts a click exactly at the window edge", () => {
    const d = createTripleClickDetector<string>();
    d.register("a", 0);
    d.register("a", TRIPLE_CLICK_WINDOW_MS);
    expect(d.register("a", TRIPLE_CLICK_WINDOW_MS * 2)).toBe(true);
  });

  it("switching keys mid-run restarts the count on the new key", () => {
    const d = createTripleClickDetector<string>();
    d.register("a", 0);
    d.register("a", 50);
    expect(d.register("b", 100)).toBe(false);
    expect(d.count()).toBe(1);
    // ...and the run that follows is b's, not a resumption of a's.
    expect(d.register("b", 150)).toBe(false);
    expect(d.register("b", 200)).toBe(true);
  });

  it("six clicks read as two triples, not four fires", () => {
    const d = createTripleClickDetector<string>();
    const fires = [0, 50, 100, 150, 200, 250].map((t) => d.register("a", t));
    expect(fires).toEqual([false, false, true, false, false, true]);
  });

  it("reset() abandons an in-progress run", () => {
    const d = createTripleClickDetector<string>();
    d.register("a", 0);
    d.register("a", 50);
    d.reset();
    expect(d.count()).toBe(0);
    expect(d.register("a", 100)).toBe(false);
    expect(d.count()).toBe(1);
  });

  it("honors a custom required count", () => {
    const d = createTripleClickDetector<string>(TRIPLE_CLICK_WINDOW_MS, 2);
    expect(d.register("a", 0)).toBe(false);
    expect(d.register("a", 10)).toBe(true);
  });

  it("TRIPLE_CLICK_COUNT is the default the copy quotes", () => {
    const d = createTripleClickDetector<string>();
    let fired = false;
    for (let i = 0; i < TRIPLE_CLICK_COUNT; i++) fired = d.register("a", i * 10);
    expect(fired).toBe(true);
  });
});
