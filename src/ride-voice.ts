// Phase 11 §11.1 — the half that makes a noise. `ride-announce.ts` decides WHAT
// and WHEN; this speaks it, buzzes, and remembers the mute. It is deliberately
// thin, because everything interesting is testable on the other side of the seam.
//
// ---------------------------------------------------------------------------
// PRIMING IS THE WHOLE FIX ON iOS, and it is the one thing here that cannot be
// discovered by reading the API docs.
//
// Safari will not speak unless `speechSynthesis` has been touched inside a user
// GESTURE. Screen 6's start button is the only gesture guaranteed to precede a
// ride, so a silent utterance there is what makes every later one work. Without
// it this feature works for every tester on Android and for nobody on iOS — and
// it fails silently, which is the worst way for an audio feature to fail.
//
// `prime()` is therefore a separate call the ride-start path makes, not something
// `speak()` can do for itself: by the time the first turn cue is due, the gesture
// is long gone.
// ---------------------------------------------------------------------------

import type { Announcement } from "./ride-announce.ts";

const MUTE_KEY = "scooter_fyi.ride_voice_muted";

/** Injected so the tests do not need a speech engine and the module does not
 *  need a browser. Each is optional, and a missing one is a platform that cannot
 *  do that half — not an error. */
export interface VoiceDeps {
  /** `window.speechSynthesis`, when the platform has it. */
  synth?: {
    speak(utterance: SpeechSynthesisUtterance): void;
    cancel(): void;
    readonly speaking: boolean;
  } | null;
  /** Builds an utterance. Separate from `synth` because constructing a
   *  `SpeechSynthesisUtterance` is its own global. */
  makeUtterance?: ((text: string) => SpeechSynthesisUtterance) | null;
  /** `navigator.vibrate`, bound. Absent on iOS Safari and in every desktop
   *  browser, which is why audio has to work without it. */
  vibrate?: ((pattern: number | number[]) => boolean) | null;
  /** Where the mute is remembered. Defaults to `localStorage`.
   *
   *  INJECTED BECAUSE SPYING ON IT DID NOT WORK. The test for the
   *  storage-blocked default used `vi.spyOn(Storage.prototype, "getItem")`, and
   *  it passed with the default flipped from unmuted to muted — the spy never
   *  reached this module's call, so the `catch` branch was never entered and the
   *  assertion was decoration. Found by mutation.
   *
   *  A dependency a test cannot reach is a dependency a test cannot pin, and the
   *  fix is to hand it over rather than to find a cleverer spy. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

export interface RideVoice {
  /** Call inside the ride-start gesture. See the header. */
  prime(): void;
  /** Speak what the announcer produced, in order. */
  deliver(announcements: readonly Announcement[]): void;
  muted(): boolean;
  setMuted(muted: boolean): void;
  /** Stop mid-sentence — a rider who mutes wants silence now, not after the
   *  current utterance. */
  silence(): void;
}

type VoiceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): VoiceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Touching `localStorage` itself can throw where site data is blocked
    // outright, before any method is called.
    return null;
  }
}

function loadMuted(storage: VoiceStorage | null): boolean {
  try {
    return storage?.getItem(MUTE_KEY) === "1";
  } catch {
    // Storage blocked. Default to UNMUTED: the feature's value is that it speaks,
    // and a private-mode rider who wanted silence can mute again. Defaulting to
    // muted would ship the feature off.
    return false;
  }
}

export function createRideVoice(deps: VoiceDeps = {}): RideVoice {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  let muted = loadMuted(storage);
  const synth = deps.synth ?? null;
  const makeUtterance = deps.makeUtterance ?? null;
  const vibrate = deps.vibrate ?? null;

  const canSpeak = (): boolean => synth !== null && makeUtterance !== null;

  return {
    prime() {
      if (!canSpeak()) return;
      // A silent utterance, inside the gesture. Empty rather than a word: the
      // rider has just pressed Start and does not need to be told anything, and
      // every platform tested treats an empty utterance as a no-op that still
      // unlocks the queue.
      try {
        synth!.speak(makeUtterance!(""));
      } catch {
        // A platform that throws here is one that will not speak later either.
        // Nothing to recover: the HUD still works, it is just quiet.
      }
    },

    deliver(announcements) {
      if (muted || announcements.length === 0) return;
      // HAPTIC FIRST, AND ONLY ONCE for the batch. The buzz means "listen", so
      // buzzing three times for three utterances says the opposite.
      if (vibrate && announcements.some((a) => a.haptic)) {
        try {
          vibrate(120);
        } catch {
          /* a platform that refuses the pattern; the audio still carries it */
        }
      }
      if (!canSpeak()) return;
      for (const a of announcements) {
        if (a.text.trim() === "") continue;
        try {
          synth!.speak(makeUtterance!(a.text));
        } catch {
          // One utterance failing must not drop the rest: the next one may be
          // the free-minute warning.
        }
      }
    },

    muted: () => muted,

    setMuted(next) {
      muted = next;
      try {
        if (next) storage?.setItem(MUTE_KEY, "1");
        else storage?.removeItem(MUTE_KEY);
      } catch {
        // The mute still holds for this ride, which is the one that matters.
      }
      if (next) this.silence();
    },

    silence() {
      try {
        synth?.cancel();
      } catch {
        /* nothing to stop */
      }
    },
  };
}

/** Wire to the real platform, with every piece optional.
 *
 *  FEATURE-DETECTED RATHER THAN UA-SNIFFED, and the two halves are detected
 *  SEPARATELY: iOS Safari speaks and does not vibrate, and plenty of desktop
 *  browsers do the same. Treating them as one capability would silence the half
 *  that works. */
export function browserVoiceDeps(): VoiceDeps {
  const synth =
    typeof window !== "undefined" && "speechSynthesis" in window
      ? window.speechSynthesis
      : null;
  const makeUtterance =
    typeof window !== "undefined" && "SpeechSynthesisUtterance" in window
      ? (text: string) => new window.SpeechSynthesisUtterance(text)
      : null;
  const vibrate =
    typeof navigator !== "undefined" && typeof navigator.vibrate === "function"
      ? (pattern: number | number[]) => navigator.vibrate(pattern)
      : null;
  return { synth, makeUtterance, vibrate };
}
