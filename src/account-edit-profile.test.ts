// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openEditProfileModal } from "./account-edit-profile.ts";

const field = (label: string): HTMLElement => {
  const wrap = document.createElement("div");
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("aria-label", label);
  wrap.append(input);
  return wrap;
};

const card = () => document.querySelector<HTMLElement>(".account-editprofile__card");

beforeEach(() => {
  document.body.replaceChildren();
});

describe("the shell", () => {
  it("is a labelled modal dialog carrying the fields it was given, in order", () => {
    openEditProfileModal({ fields: [field("Email"), field("Phone")] });
    const c = card()!;
    expect(c.getAttribute("role")).toBe("dialog");
    expect(c.getAttribute("aria-modal")).toBe("true");
    expect(
      document.getElementById(c.getAttribute("aria-labelledby")!)?.textContent,
    ).toBe("Edit Profile");
    expect(
      [...c.querySelectorAll("input")].map((i) => i.getAttribute("aria-label")),
    ).toEqual(["Email", "Phone"]);
  });

  it("focuses the first field, because a rider who pressed Edit came to type", () => {
    openEditProfileModal({ fields: [field("Email")] });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Email");
  });
});

describe("closing", () => {
  it("closes on the ✕ and reports it", () => {
    const onClose = vi.fn();
    openEditProfileModal({ fields: [field("Email")], onClose });
    document.querySelector<HTMLButtonElement>(".account-editprofile__close")!.click();
    expect(card()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    openEditProfileModal({ fields: [field("Email")], onClose });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop click but not on a click inside the card", () => {
    openEditProfileModal({ fields: [field("Email")] });
    card()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card()).not.toBeNull();

    document
      .querySelector<HTMLElement>(".account-editprofile")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(card()).toBeNull();
  });

  it("stops listening for Escape once closed", () => {
    const onClose = vi.fn();
    openEditProfileModal({ fields: [field("Email")], onClose });
    document.querySelector<HTMLButtonElement>(".account-editprofile__close")!.click();
    // A listener left on `document` would be reachable by keyboard forever, and
    // would fire a second `onClose` for a dialog that is already gone.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    openEditProfileModal({ fields: [field("Email")] });
    expect(document.activeElement).not.toBe(opener);

    document.querySelector<HTMLButtonElement>(".account-editprofile__close")!.click();
    // A rider who closes a dialog with the keyboard and lands at the top of the
    // document has lost their place.
    expect(document.activeElement).toBe(opener);
  });

  it("is idempotent, so a double close fires onClose once", () => {
    const onClose = vi.fn();
    const close = openEditProfileModal({ fields: [field("Email")], onClose });
    close();
    close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the returned close works, for a session lost while the form is open", () => {
    const close = openEditProfileModal({ fields: [field("Email")] });
    close();
    expect(card()).toBeNull();
  });
});

describe("opening twice", () => {
  it("replaces the first rather than stacking two dialogs", () => {
    openEditProfileModal({ fields: [field("Email")] });
    openEditProfileModal({ fields: [field("Phone")] });
    expect(document.querySelectorAll(".account-editprofile")).toHaveLength(1);
    expect(
      card()!.querySelector("input")!.getAttribute("aria-label"),
    ).toBe("Phone");
  });
});
