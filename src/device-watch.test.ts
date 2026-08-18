// @vitest-environment happy-dom
//
// Watching the scooter a rider claimed. The failure this exists for: they pick
// one three blocks away, somebody standing next to it unlocks it, and the app
// says nothing until they arrive at a bare patch of pavement.
import { describe, expect, it } from "vitest";

import {
  MISSING_TICKS_BEFORE_GONE,
  goneMessage,
  watchDevice,
  type DeviceGoneReason,
  type DeviceSnapshot,
} from "./device-watch.ts";

const OK: DeviceSnapshot = {
  vehicleIdentifier: "abc",
  inUse: false,
  rentable: true,
  looksRideable: true,
};

function harness(snapshots: (DeviceSnapshot | undefined)[]) {
  let i = 0;
  const ticks: (() => void)[] = [];
  const gone: DeviceGoneReason[] = [];
  const handle = watchDevice("abc", {
    lookup: () => snapshots[Math.min(i, snapshots.length - 1)],
    onRefresh: (cb) => {
      ticks.push(cb);
      return () => void ticks.splice(ticks.indexOf(cb), 1);
    },
    onGone: (r) => void gone.push(r),
  });
  return {
    gone,
    handle,
    listeners: () => ticks.length,
    tick(n = 1) {
      for (let k = 0; k < n; k += 1) {
        i += 1;
        for (const cb of [...ticks]) cb();
      }
    },
  };
}

describe("officially gone", () => {
  it("catches Veo saying someone is on it", () => {
    // is_reserved means IN USE on this operator, not a held booking.
    const h = harness([OK, { ...OK, inUse: true }]);
    h.tick();
    expect(h.gone).toEqual(["in_use"]);
  });

  it("catches a vehicle that stops accepting rentals", () => {
    const h = harness([OK, { ...OK, rentable: false }]);
    h.tick();
    expect(h.gone).toEqual(["not_rentable"]);
  });

  it("reports the most specific reason, not the vaguest true one", () => {
    // In use AND unrideable: the rider should hear what actually happened.
    const h = harness([OK, { ...OK, inUse: true, looksRideable: false }]);
    h.tick();
    expect(h.gone).toEqual(["in_use"]);
  });
});

describe("unofficially gone", () => {
  it("says so when the feed still offers it but our own signals disagree", () => {
    const h = harness([OK, { ...OK, looksRideable: false }]);
    h.tick();
    expect(h.gone).toEqual(["unofficial"]);
  });

  it("is worded as doubt, not as fact", () => {
    // It is our inference, not the operator's. Overstating it spends the
    // trust the official cases need.
    expect(goneMessage("Lunar 🐸 928", "unofficial")).toMatch(/may not/i);
    expect(goneMessage("Lunar 🐸 928", "in_use")).toMatch(/just took/i);
  });
});

describe("vanishing from the feed", () => {
  it("does NOT cry wolf on a single missed poll", () => {
    // GBFS feeds drop and re-add vehicles for reasons that have nothing to do
    // with anybody riding them. Alarming on one absence would train the rider
    // to ignore the alert, which costs more than the seconds it saves.
    const h = harness([OK, undefined]);
    h.tick();
    expect(h.gone).toEqual([]);
  });

  it("gives up after enough consecutive misses", () => {
    const h = harness([OK, undefined]);
    h.tick(MISSING_TICKS_BEFORE_GONE);
    expect(h.gone).toEqual(["vanished"]);
  });

  it("forgives a gap that fills back in", () => {
    const snaps = [OK, undefined, OK, undefined];
    let i = 0;
    const gone: DeviceGoneReason[] = [];
    const ticks: (() => void)[] = [];
    watchDevice("abc", {
      lookup: () => snaps[Math.min(i, snaps.length - 1)],
      onRefresh: (cb) => { ticks.push(cb); return () => {}; },
      onGone: (r) => void gone.push(r),
    });
    for (let k = 1; k < snaps.length; k += 1) { i = k; ticks.forEach((c) => c()); }
    expect(gone).toEqual([]);
  });
});

describe("discipline", () => {
  it("checks immediately, since it may already be gone", () => {
    // Between the rider choosing it and the watcher starting.
    const h = harness([{ ...OK, inUse: true }]);
    expect(h.gone).toEqual(["in_use"]);
  });

  it("tells the rider once, not on every tick afterwards", () => {
    const h = harness([{ ...OK, inUse: true }]);
    h.tick(5);
    expect(h.gone).toEqual(["in_use"]);
  });

  it("stops listening when stopped", () => {
    const h = harness([OK]);
    expect(h.listeners()).toBe(1);
    h.handle.stop();
    expect(h.listeners()).toBe(0);
  });

  it("says nothing after being stopped", () => {
    const h = harness([OK, { ...OK, inUse: true }]);
    h.handle.stop();
    h.tick();
    expect(h.gone).toEqual([]);
  });
});
