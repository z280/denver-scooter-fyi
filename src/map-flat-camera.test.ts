// @vitest-environment happy-dom
//
// Only because importing `map.ts` evaluates `location.origin` at module load
// (its `ASSET_BASE`). The unit under test is DOM-free — it takes a plain
// object of gesture handlers — but the import is not.
import { describe, it, expect } from "vitest";
import { lockToFlatCamera, type FlatCameraHandles } from "./map.ts";

/** A map's gesture handlers, counted rather than mocked — the assertion is
 *  about which ones get switched off, so recording the calls is the whole
 *  fixture. Constructing a real MapLibre map needs WebGL, which is why this
 *  rule is extracted rather than tested through `createMap`. */
function handles(): FlatCameraHandles & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    dragRotate: { disable: () => void calls.push("dragRotate.disable") },
    touchZoomRotate: {
      disableRotation: () => void calls.push("touchZoomRotate.disableRotation"),
    },
    touchPitch: { disable: () => void calls.push("touchPitch.disable") },
    keyboard: { disableRotation: () => void calls.push("keyboard.disableRotation") },
  };
}

describe("lockToFlatCamera", () => {
  // THE 2D MAP IS NEVER TILTED (frontend plan §6.3.1). The app has exactly two
  // framings — this flat one and `ride-hud.ts`'s 3D follow-cam — and no
  // gesture may reach anything in between.
  //
  // This was a live bug, not a tidying opportunity: MapLibre enables pitch and
  // rotate by default, so a two-finger drag tilted the map, and the navigation
  // control is registered `showCompass: false`, which is the only control that
  // would put it back. A rider who tilted the map by accident was stuck with a
  // tilted map.

  it("takes tilt away from touch", () => {
    const h = handles();
    lockToFlatCamera(h);
    // The two-finger drag that caused the bug.
    expect(h.calls).toContain("touchPitch.disable");
  });

  it("takes tilt and spin away from the mouse and the keyboard too", () => {
    const h = handles();
    lockToFlatCamera(h);
    expect(h.calls).toContain("dragRotate.disable");
    expect(h.calls).toContain("touchZoomRotate.disableRotation");
    // shift+arrows reaches the same unreachable framing.
    expect(h.calls).toContain("keyboard.disableRotation");
  });

  it("disables every rotate/pitch gesture there is, so none is forgotten", () => {
    // Asserted as a SET rather than one-by-one: a handler added later that can
    // tilt the map should fail this, not slip past because nobody thought to
    // add a line for it.
    const h = handles();
    lockToFlatCamera(h);
    expect(new Set(h.calls)).toEqual(
      new Set([
        "dragRotate.disable",
        "touchZoomRotate.disableRotation",
        "touchPitch.disable",
        "keyboard.disableRotation",
      ]),
    );
  });

  it("does not touch zoom or pan", () => {
    // Panning and zooming are how a rider reads the map. Only tilt and spin
    // are being taken away, and a future edit that reaches for
    // `scrollZoom.disable()` should stand out as the mistake it would be.
    const h = handles();
    lockToFlatCamera(h);
    expect(h.calls.some((c) => c.includes("Zoom.disable"))).toBe(false);
    expect(h.calls.some((c) => c.includes("dragPan"))).toBe(false);
  });
});
