// @vitest-environment happy-dom
//
// The story panel.
//
// `rider-story.ts` owns the rules and its own tests assert them against the
// payload. What is left for this file is what only a DOM can be wrong about:
// that the third-party lane is invisible until asked for, that the disclosure
// on screen tracks the draft it describes, that a dropped connection does not
// cost somebody their words, and that typing does not fight the caret.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountStoryPanel } from "./rider-story-sheet.ts";
import { __resetStoryStore, loadDrafts } from "./story-store.ts";
import type { StoryContext } from "./rider-story.ts";

const CONTEXT: StoryContext = {
  happenedAt: "2026-10-06T14:02:00.000Z",
  vehicleModel: "Cosmo",
  appAssessment: "ok",
};

const HOODS = ["Baker", "Five Points", "Montbello"];

let root: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  __resetStoryStore();
  root = document.createElement("div");
  document.body.replaceChildren(root);
});

function mount(over: Partial<Parameters<typeof mountStoryPanel>[1]> = {}) {
  const submit =
    vi.fn<(draftId: string, payload: unknown) => Promise<void>>(async () => {});
  const panel = mountStoryPanel(root, {
    origin: "failed_start",
    context: CONTEXT,
    neighborhoods: HOODS,
    submit,
    ...over,
  });
  return { panel, submit };
}

const text = () => root.querySelector<HTMLTextAreaElement>(".story-panel__text")!;
const tick = () => root.querySelector<HTMLInputElement>('.story-panel__switch input')!;
const sendBtn = () => root.querySelector<HTMLButtonElement>('[data-role="send"]')!;
const statusText = () => root.querySelector<HTMLElement>('[data-role="status"]')?.textContent ?? "";

function type(value: string): void {
  const box = text();
  box.value = value;
  box.dispatchEvent(new Event("input"));
}

function setTick(on: boolean): void {
  const t = tick();
  t.checked = on;
  t.dispatchEvent(new Event("change"));
}

describe("it opens as one question", () => {
  it("asks, and asks nothing else", () => {
    mount();
    expect(root.querySelector(".story-panel__prompt")?.textContent).toBe("What happened?");
    // No neighbourhood, no identity, no disclosure until the rider asks for
    // the lane that needs them.
    expect(root.querySelector(".story-panel__select")).toBeNull();
    expect(root.querySelector(".story-panel__disclose")).toBeNull();
  });

  it("offers the box a shape to fill, never a sentence to accept", () => {
    mount();
    expect(text().value).toBe("");
    expect(text().placeholder).not.toBe("");
  });

  it("does not offer the third-party lane when we could not load the list", () => {
    // We could not file it correctly, so we do not pretend we can.
    mount({ neighborhoods: null });
    expect(root.querySelector(".story-panel__switch")).toBeNull();
    expect(root.textContent).not.toMatch(/We See You Veo/);
  });
});

describe("typing", () => {
  it("does not rebuild the panel under the rider's caret", () => {
    mount();
    const before = text();
    type("It wouldn't start");
    // Same node: a re-render on input would move the caret to the end on
    // every keystroke, which makes editing a typed sentence impossible.
    expect(text()).toBe(before);
  });

  it("keeps every keystroke, so a backgrounded tab costs nothing", () => {
    mount();
    type("half a thought");
    expect(loadDrafts()[0]?.text).toBe("half a thought");
  });

  it("will not send an empty story, and says what it wants", () => {
    mount();
    expect(sendBtn().disabled).toBe(true);
    type("x");
    expect(sendBtn().disabled).toBe(false);
  });
});

describe("the third-party lane is opt-in", () => {
  it("starts off", () => {
    mount();
    expect(tick().checked).toBe(false);
    expect(sendBtn().textContent).toBe("Save this");
  });

  it("reveals what filing it there requires, only once asked", () => {
    mount();
    type("It threw an error.");
    setTick(true);
    expect(root.querySelector(".story-panel__select")).not.toBeNull();
    expect(root.querySelector(".story-panel__disclose")).not.toBeNull();
    expect(sendBtn().textContent).toBe("Send");
  });

  it("holds the send until a neighbourhood is picked, and says why", () => {
    mount();
    type("It threw an error.");
    setTick(true);
    expect(sendBtn().disabled).toBe(true);
    expect(statusText()).toMatch(/neighbourhood/i);
  });

  it("sends nothing anywhere when the tick stays off", async () => {
    const { submit } = mount();
    type("Just telling you.");
    sendBtn().click();
    await vi.waitFor(() => expect(root.textContent).toMatch(/saved on this device/i));
    expect(submit).not.toHaveBeenCalled();
    // The copy has to say so: "Saved" alone reads as having gone somewhere.
    expect(root.textContent).toMatch(/nothing was sent anywhere/i);
  });
});

describe("the disclosure describes this draft", () => {
  function discloseText(): string {
    return root.querySelector(".story-panel__disclose")?.textContent ?? "";
  }

  it("names the neighbourhood the rider actually picked", () => {
    mount();
    type("x");
    setTick(true);
    const hood = root.querySelector<HTMLSelectElement>(".story-panel__select")!;
    hood.value = "Montbello";
    hood.dispatchEvent(new Event("change"));
    expect(discloseText()).toContain("Montbello");
  });

  it("switches between 'identifies nobody' and the address as the rider does", () => {
    mount();
    type("x");
    setTick(true);
    expect(discloseText()).toMatch(/no name, no email, no account/i);

    const anon = root.querySelectorAll<HTMLInputElement>(".story-panel__switch input")[1];
    anon.checked = false;
    anon.dispatchEvent(new Event("change"));
    expect(discloseText()).not.toMatch(/no name, no email, no account/i);
    expect(discloseText()).toMatch(/email/i);
  });

  it("names the vehicle and the app's own verdict, because both are sent", () => {
    mount();
    type("x");
    setTick(true);
    expect(discloseText()).toContain("Cosmo");
    expect(discloseText()).toMatch(/what this app thought/i);
  });
});

describe("sending", () => {
  async function sendIt(submit?: () => Promise<void>) {
    const m = mount(
      submit
        ? { submit: vi.fn<(d: string, p: unknown) => Promise<void>>(submit) }
        : {},
    );
    type("Third dead one this week.");
    setTick(true);
    const hood = root.querySelector<HTMLSelectElement>(".story-panel__select")!;
    hood.value = "Montbello";
    hood.dispatchEvent(new Event("change"));
    sendBtn().click();
    return m;
  }

  it("sends the payload under the draft's own id, so a retry is not a second story", async () => {
    const { submit } = await sendIt();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const [draftId, payload] = submit.mock.calls[0];
    expect(typeof draftId).toBe("string");
    const sent = payload as { source: string; sessionId: string };
    expect(sent.source).toBe("scooter.fyi");
    // The session field is this story's own id — already in the URL, so it
    // discloses nothing further, and it cannot join the story to a ride, a
    // telemetry session or an account.
    expect(sent.sessionId === "" || sent.sessionId === draftId).toBe(true);
  });

  it("forgets the story once it has gone", async () => {
    await sendIt();
    await vi.waitFor(() => expect(root.textContent).toMatch(/sent/i));
    expect(loadDrafts()).toEqual([]);
  });

  it("keeps the words when the network refuses", async () => {
    await sendIt(async () => {
      throw new Error("offline");
    });
    await vi.waitFor(() => expect(root.textContent).toMatch(/couldn't send/i));
    // The one failure that must not cost somebody three typed sentences.
    expect(loadDrafts()[0]?.text).toBe("Third dead one this week.");
    expect(root.textContent).toMatch(/saved here/i);
  });
});

describe("declining", () => {
  it("deletes rather than keeping it for later", async () => {
    mount();
    type("started and thought better of it");
    root.querySelectorAll<HTMLButtonElement>("button")[1].click();
    expect(loadDrafts()).toEqual([]);
  });
});

describe("keyboard focus survives the panel's own rebuilds", () => {
  it("stays on the We See You Veo box after ticking it", () => {
    mount();
    tick().focus();
    setTick(true);
    expect(document.activeElement).toBe(tick());
    expect(tick().checked).toBe(true);
  });

  it("stays on the anonymous box and the neighbourhood list after changing them", () => {
    mount();
    setTick(true);
    const anon = () => root.querySelector<HTMLInputElement>('[data-focus-key="anonymous"]')!;
    anon().focus();
    anon().checked = !anon().checked;
    anon().dispatchEvent(new Event("change"));
    expect(document.activeElement).toBe(anon());

    const hood = () => root.querySelector<HTMLSelectElement>('[data-focus-key="neighborhood"]')!;
    hood().focus();
    hood().value = HOODS[1];
    hood().dispatchEvent(new Event("change"));
    expect(document.activeElement).toBe(hood());
    expect(hood().value).toBe(HOODS[1]);
  });

  it("does not steal focus that was elsewhere", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    mount();
    outside.focus();
    setTick(true);
    expect(document.activeElement).toBe(outside);
  });
});
