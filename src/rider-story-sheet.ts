// The one-question sheet.
//
// `rider-story.ts` holds every decision this file renders. It decides nothing
// — which is why the consent rules are tested against the payload rather than
// against this DOM.
//
// THE SHAPE, AND WHY IT IS THIS SHAPE. The panel opens as ONE question and a
// box. Everything else — neighbourhood, who you are, where it goes — appears
// only when the rider asks for it by ticking the box that sends it onward.
// A rider who just wants to tell us what happened answers one question and is
// done; a rider who wants it to reach We See You Veo opts into the three
// fields that filing it there requires. Putting those three up front would
// turn the highest-value capture in the app back into a form, which is the
// thing it exists to get away from.
//
// THE DISCLOSURE IS NOT A LINK. It is a list, on screen, built from the draft,
// and it appears the moment the tick goes on. Somebody deciding whether to
// hand their words to a third party should not have to go and find out what
// that means.

import {
  STORY_PLACEHOLDER,
  STORY_MAX_LENGTH,
  buildStoryPayload,
  newStoryDraft,
  storyBlockedReason,
  storyLede,
  storyPrompt,
  wsyvDisclosure,
  type StoryContext,
  type StoryDraft,
  type StoryOrigin,
} from "./rider-story.ts";
import { clearDraft, saveDraft } from "./story-store.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Distinct enough, and never a reason a story cannot be saved:
 *  `crypto.randomUUID` is absent over plain HTTP and on older WebViews. The
 *  receiving route accepts 8–64 of `[A-Za-z0-9_-]`, which both branches
 *  satisfy. */
function newStoryId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    /* fall through */
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface StoryPanelDeps {
  origin: StoryOrigin;
  context: StoryContext;
  /** The instrument's neighbourhood list. Fetched by the host, because a
   *  panel that fetches is a panel that cannot be rendered in a test without
   *  a network. Null or empty means we could not reach it — the send option
   *  is then not offered at all, since we could not file it correctly. */
  neighborhoods: readonly string[] | null;
  submit(draftId: string, payload: unknown): Promise<void>;
  /** Called once the rider is finished with the panel, however it ended. */
  onDone?(): void;
}

export interface StoryPanel {
  destroy(): void;
}

/** Mount the panel into `root`. Returns a handle; the host owns the lifetime.
 *
 *  The draft is saved locally on every edit — a story half-typed when the
 *  phone rings has to still be there. It is deleted the moment it is sent, or
 *  when the rider dismisses it. */
export function mountStoryPanel(
  root: HTMLElement,
  deps: StoryPanelDeps,
): StoryPanel {
  let draft: StoryDraft = newStoryDraft(
    newStoryId(),
    deps.origin,
    deps.context,
  );
  let status: string | null = null;
  let sending = false;
  let finished = false;
  let destroyed = false;

  const canOfferWsyv =
    Array.isArray(deps.neighborhoods) && deps.neighborhoods.length > 0;

  function update(patch: Partial<StoryDraft>): void {
    draft = { ...draft, ...patch };
    // Persist on every keystroke-ish change. Cheap, and the alternative is
    // losing somebody's words to a backgrounded tab.
    saveDraft(draft);
  }

  function render(): void {
    if (destroyed) return;
    root.replaceChildren();

    if (finished) {
      const done = el("p", "story-panel__status", status ?? "Thanks.");
      done.setAttribute("role", "status");
      root.append(done);
      return;
    }

    root.append(el("p", "story-panel__lede", storyLede(deps.origin)));

    const label = el("label", "story-panel__prompt", storyPrompt(deps.origin));
    const box = el("textarea", "story-panel__text");
    box.rows = 3;
    box.placeholder = STORY_PLACEHOLDER;
    box.maxLength = STORY_MAX_LENGTH;
    box.value = draft.text;
    box.id = `story-text-${draft.id}`;
    label.htmlFor = box.id;
    box.addEventListener("input", () => {
      // No re-render on input: rebuilding the panel under a typing rider
      // would move the caret. Only the button's state depends on this.
      draft = { ...draft, text: box.value };
      saveDraft(draft);
      refreshSendState();
    });
    root.append(label, box);

    // Everything below is the third-party lane, and it is opt-in.
    if (canOfferWsyv) {
      const sendRow = el("label", "story-panel__switch");
      const tick = el("input");
      tick.type = "checkbox";
      tick.checked = draft.sendToWsyv;
      tick.addEventListener("change", () => {
        update({ sendToWsyv: tick.checked });
        render();
      });
      sendRow.append(tick, el("span", undefined, "Also send this to We See You Veo"));
      root.append(sendRow);
      root.append(
        el(
          "p",
          "story-panel__hint",
          "A Denver rider-advocacy project. They collect riders' accounts; we don't speak for them and they don't speak for us.",
        ),
      );

      if (draft.sendToWsyv) root.append(renderWsyvFields());
    }

    const actions = el("div", "story-panel__actions");
    const sendBtn = el("button", "login-btn story-panel__send");
    sendBtn.type = "button";
    sendBtn.dataset.role = "send";
    sendBtn.textContent = draft.sendToWsyv ? "Send" : "Save this";
    sendBtn.addEventListener("click", () => void onSend());
    const skipBtn = el("button", "login-btn login-btn--ghost", "Not now");
    skipBtn.type = "button";
    skipBtn.addEventListener("click", onSkip);
    actions.append(sendBtn, skipBtn);
    root.append(actions);

    const note = el("p", "story-panel__status");
    note.dataset.role = "status";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    root.append(note);

    refreshSendState();
  }

  /** The send button's state, updated without a re-render so the caret stays
   *  where the rider left it. */
  function refreshSendState(): void {
    const btn = root.querySelector<HTMLButtonElement>('[data-role="send"]');
    const note = root.querySelector<HTMLElement>('[data-role="status"]');
    if (!btn || !note) return;
    const blocked = sending ? "Sending…" : storyBlockedReason(draft);
    btn.disabled = sending || blocked !== null;
    // The reason is shown, never merely implied by a dead button: a disabled
    // control that will not say what it wants is how a form wastes somebody's
    // time.
    note.textContent = status ?? (draft.text.trim() ? blocked : null) ?? "";
  }

  function renderWsyvFields(): HTMLElement {
    const box = el("div", "story-panel__wsyv");

    const hoodLabel = el("label", "story-panel__field", "Your neighbourhood");
    const hood = el("select", "story-panel__select");
    hood.id = `story-hood-${draft.id}`;
    hoodLabel.htmlFor = hood.id;
    const blank = el("option", undefined, "Pick one…");
    blank.value = "";
    hood.append(blank);
    for (const name of deps.neighborhoods ?? []) {
      const opt = el("option", undefined, name);
      opt.value = name;
      hood.append(opt);
    }
    hood.value = draft.neighborhood;
    hood.addEventListener("change", () => {
      update({ neighborhood: hood.value });
      // Re-render: the disclosure names the neighbourhood, so it has to
      // change with it or it stops being the thing that gets sent.
      render();
    });
    box.append(hoodLabel, hood);

    const anonRow = el("label", "story-panel__switch");
    const anon = el("input");
    anon.type = "checkbox";
    anon.checked = draft.anonymous;
    anon.addEventListener("change", () => {
      update({ anonymous: anon.checked });
      render();
    });
    anonRow.append(anon, el("span", undefined, "Send it anonymously"));
    box.append(anonRow);

    if (!draft.anonymous) {
      const mailLabel = el("label", "story-panel__field", "Email they can reach you on");
      const mail = el("input", "story-panel__input");
      mail.type = "email";
      mail.id = `story-mail-${draft.id}`;
      mailLabel.htmlFor = mail.id;
      mail.value = draft.contactEmail;
      mail.addEventListener("input", () => {
        draft = { ...draft, contactEmail: mail.value };
        saveDraft(draft);
        refreshSendState();
      });
      box.append(mailLabel, mail);
    }

    // The disclosure. Built from the draft, so it cannot describe something
    // other than what `buildStoryPayload` will send.
    box.append(el("p", "story-panel__disclose-head", "They'll receive:"));
    const list = el("ul", "story-panel__disclose");
    for (const line of wsyvDisclosure(draft)) {
      list.append(el("li", undefined, line));
    }
    box.append(list);
    return box;
  }

  async function onSend(): Promise<void> {
    if (sending) return;
    if (storyBlockedReason(draft) !== null) {
      refreshSendState();
      return;
    }

    if (!draft.sendToWsyv) {
      // Kept here and nowhere else. Saying so plainly matters: "Saved" with
      // no destination reads as having been sent somewhere.
      status = "Saved on this device. Nothing was sent anywhere.";
      finished = true;
      render();
      deps.onDone?.();
      return;
    }

    // WSYV's session field gets THIS STORY'S OWN ID and nothing else. That id
    // is already in the request URL, so it discloses nothing further — and it
    // means no identifier that could join this story to anything else we hold
    // (a ride, a telemetry session, an account) ever leaves. An anonymous
    // story sends an empty string instead; `buildStoryPayload` enforces that.
    const payload = buildStoryPayload(draft, draft.id);
    if (!payload) {
      refreshSendState();
      return;
    }
    sending = true;
    status = null;
    refreshSendState();
    try {
      await deps.submit(draft.id, payload);
      if (destroyed) return;
      // Sent means gone from here: this app has no business keeping a private
      // copy of what a rider disclosed to somebody else.
      clearDraft(draft.id);
      status = "Sent. Thanks — that's the part a count can't carry.";
      finished = true;
    } catch {
      if (destroyed) return;
      // The draft stays. A rider who typed three sentences must not lose them
      // to a dropped connection.
      status = "Couldn't send it just now — it's saved here, so try again later.";
    } finally {
      sending = false;
    }
    if (!destroyed) {
      render();
      if (finished) deps.onDone?.();
    }
  }

  function onSkip(): void {
    // Dismissing deletes. An unsent story nobody wanted to write should not
    // sit on the device waiting to be rediscovered.
    clearDraft(draft.id);
    finished = true;
    status = "No problem.";
    render();
    deps.onDone?.();
  }

  render();

  return {
    destroy(): void {
      destroyed = true;
      root.replaceChildren();
    },
  };
}
