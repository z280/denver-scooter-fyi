// @vitest-environment happy-dom
//
// Phase 11 §11.1's speech layer. Thin on purpose, so what is pinned here is the
// handful of things that are easy to get wrong and silent when they are: the iOS
// priming call, the mute, and the fact that one failure must not swallow the rest.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Announcement } from "./ride-announce.ts";
import { createRideVoice, type VoiceDeps } from "./ride-voice.ts";

function fakeSynth() {
  const spoken: string[] = [];
  return {
    spoken,
    cancel: vi.fn(),
    speaking: false,
    speak: vi.fn((u: SpeechSynthesisUtterance) => {
      spoken.push(u.text);
    }),
  };
}

function deps(over: Partial<VoiceDeps> = {}): VoiceDeps & { synth: ReturnType<typeof fakeSynth> } {
  const synth = fakeSynth();
  return {
    synth: synth as never,
    makeUtterance: (text: string) => ({ text }) as SpeechSynthesisUtterance,
    vibrate: vi.fn(() => true),
    ...over,
  } as never;
}

const say = (text: string, haptic = true): Announcement => ({ kind: "turn", text, haptic });

beforeEach(() => localStorage.clear());

describe("priming, which is the whole fix on iOS", () => {
  it("speaks an empty utterance so the queue is unlocked inside the gesture", () => {
    // Safari will not speak unless `speechSynthesis` has been touched inside a
    // user gesture, and by the time the first turn cue is due that gesture is long
    // gone. Without this the feature works for every tester on Android and for
    // nobody on iOS — and it fails SILENTLY.
    const d = deps();
    createRideVoice(d).prime();
    expect(d.synth.speak).toHaveBeenCalledTimes(1);
    expect(d.synth.spoken).toEqual([""]);
  });

  it("is a no-op, not a crash, where there is no speech engine", () => {
    const voice = createRideVoice({ synth: null, makeUtterance: null });
    expect(() => voice.prime()).not.toThrow();
  });

  it("survives a platform that throws from speak", () => {
    const d = deps();
    d.synth.speak.mockImplementation(() => {
      throw new Error("not allowed");
    });
    expect(() => createRideVoice(d).prime()).not.toThrow();
  });
});

describe("delivery", () => {
  it("speaks each announcement in order", () => {
    const d = deps();
    createRideVoice(d).deliver([say("first"), say("second")]);
    expect(d.synth.spoken).toEqual(["first", "second"]);
  });

  it("buzzes ONCE for the batch, not once per utterance", () => {
    // The buzz means "listen". Buzzing three times for three utterances says the
    // opposite.
    const d = deps();
    createRideVoice(d).deliver([say("a"), say("b"), say("c")]);
    expect(d.vibrate).toHaveBeenCalledTimes(1);
  });

  it("does not buzz when nothing in the batch asked for it", () => {
    const d = deps();
    createRideVoice(d).deliver([say("a", false)]);
    expect(d.vibrate).not.toHaveBeenCalled();
  });

  it("keeps speaking after one utterance fails", () => {
    // The next one may be the free-minute warning.
    const d = deps();
    let n = 0;
    d.synth.speak.mockImplementation((u: SpeechSynthesisUtterance) => {
      n += 1;
      if (n === 1) throw new Error("nope");
      d.synth.spoken.push(u.text);
    });
    createRideVoice(d).deliver([say("dropped"), say("delivered")]);
    expect(d.synth.spoken).toEqual(["delivered"]);
  });

  it("still buzzes on a platform that cannot speak", () => {
    // The two halves are detected separately: iOS Safari speaks and does not
    // vibrate, and plenty of desktop browsers do the reverse. Treating them as
    // one capability would silence the half that works.
    const vibrate = vi.fn(() => true);
    createRideVoice({ synth: null, makeUtterance: null, vibrate }).deliver([say("a")]);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("skips an empty utterance rather than queueing silence", () => {
    const d = deps();
    createRideVoice(d).deliver([say("   ")]);
    expect(d.synth.spoken).toEqual([]);
  });

  it("does nothing at all with an empty batch", () => {
    const d = deps();
    createRideVoice(d).deliver([]);
    expect(d.vibrate).not.toHaveBeenCalled();
    expect(d.synth.speak).not.toHaveBeenCalled();
  });
});

describe("the mute", () => {
  it("silences both halves", () => {
    const d = deps();
    const voice = createRideVoice(d);
    voice.setMuted(true);
    voice.deliver([say("a")]);
    expect(d.synth.spoken).toEqual([]);
    expect(d.vibrate).not.toHaveBeenCalled();
  });

  it("stops the current utterance, because a rider who mutes wants silence now", () => {
    const d = deps();
    const voice = createRideVoice(d);
    voice.deliver([say("long sentence")]);
    voice.setMuted(true);
    expect(d.synth.cancel).toHaveBeenCalled();
  });

  it("is remembered across rides", () => {
    // A HUD that cannot be silenced gets closed, and one that forgets gets muted
    // again every single ride.
    createRideVoice(deps()).setMuted(true);
    expect(createRideVoice(deps()).muted()).toBe(true);
  });

  it("is forgotten when cleared", () => {
    const first = createRideVoice(deps());
    first.setMuted(true);
    first.setMuted(false);
    expect(createRideVoice(deps()).muted()).toBe(false);
  });

  it("defaults to UNMUTED when storage is unreadable", () => {
    // The feature's value is that it speaks, and a private-mode rider who wanted
    // silence can mute again. Defaulting to muted would ship the feature off.
    //
    // THE STORAGE IS INJECTED, not spied on. The first version of this test used
    // `vi.spyOn(Storage.prototype, "getItem")` and PASSED with the default
    // flipped to muted — the spy never reached the module's call, so the catch
    // branch was never entered and the assertion was decoration. Found by
    // mutation. A dependency a test cannot reach is a dependency a test cannot
    // pin.
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(createRideVoice({ ...deps(), storage: throwing }).muted()).toBe(false);
  });

  it("treats a missing storage the same way", () => {
    expect(createRideVoice({ ...deps(), storage: null }).muted()).toBe(false);
  });

  it("still holds for this ride when storage refuses the write", () => {
    const d = deps();
    const voice = createRideVoice({
      ...d,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {},
      },
    });
    voice.setMuted(true);
    expect(voice.muted()).toBe(true);
    voice.deliver([say("a")]);
    expect(d.synth.spoken).toEqual([]);
  });
});
