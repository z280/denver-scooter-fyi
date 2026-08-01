// @vitest-environment happy-dom
//
// The sign-in doors. The properties worth pinning down are the ones that cost
// a rider something when they break: a door that shouldn't be offered isn't
// rendered, an emailed code survives the drawer's one legitimate rebuild, and
// the Google button never stacks a second copy of itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildLoginPanel,
  type LoginPanelDeps,
  type LoginPanelState,
} from "./account-login.ts";
import type { AuthConfig } from "./auth-config.ts";

let host: HTMLElement;

const blankState = (): LoginPanelState => ({
  email: "",
  sentEmail: "",
  phone: "",
  sentPhone: "",
});

const cfg = (over: Partial<AuthConfig> = {}): AuthConfig =>
  ({
    googleEnabled: false,
    googleClientId: null,
    magicLinkEnabled: true,
    codeEnabled: true,
    smsEnabled: false,
    ...over,
  }) as AuthConfig;

/** Everything injected, so nothing here touches the network. */
const build = (over: Partial<LoginPanelDeps> = {}) =>
  buildLoginPanel(host, {
    cfg: cfg(),
    state: blankState(),
    onSignedIn: vi.fn(),
    requestLoginCode: vi.fn().mockResolvedValue(undefined),
    requestMagicLink: vi.fn().mockResolvedValue(undefined),
    verifyEmailCode: vi.fn().mockResolvedValue(undefined),
    renderGoogleButton: vi.fn().mockResolvedValue(undefined),
    buildSmsDoor: vi.fn(),
    ...over,
  });

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  document.body.replaceChildren();
});

// ---------- which doors appear ----------

describe("door gating", () => {
  it("always offers the email door", () => {
    build();
    expect(host.querySelector("form.account-magic")).not.toBeNull();
    expect(host.querySelector("form.account-code")).not.toBeNull();
  });

  it("omits Google entirely when the backend has not enabled it", () => {
    const renderGoogleButton = vi.fn();
    build({ cfg: cfg({ googleEnabled: false }), renderGoogleButton });
    expect(host.querySelector(".account-google")).toBeNull();
    expect(renderGoogleButton).not.toHaveBeenCalled();
  });

  it("omits Google when enabled but no client id came back", () => {
    const renderGoogleButton = vi.fn();
    build({
      cfg: cfg({ googleEnabled: true, googleClientId: null }),
      renderGoogleButton,
    });
    expect(host.querySelector(".account-google")).toBeNull();
    expect(renderGoogleButton).not.toHaveBeenCalled();
  });

  it("omits the SMS door unless the backend says texts are configured", () => {
    const buildSmsDoor = vi.fn();
    build({ cfg: cfg({ smsEnabled: false }), buildSmsDoor });
    expect(buildSmsDoor).not.toHaveBeenCalled();

    host.replaceChildren();
    build({ cfg: cfg({ smsEnabled: true }), buildSmsDoor });
    expect(buildSmsDoor).toHaveBeenCalledTimes(1);
    // It gets the same caller-owned state object the email door mutates.
    expect(buildSmsDoor.mock.calls[0][1]).toMatchObject({
      state: expect.objectContaining({ phone: "", sentPhone: "" }),
    });
  });
});

// ---------- the Google stacking guard ----------

describe("Google button", () => {
  const googleCfg = cfg({ googleEnabled: true, googleClientId: "cid-123" });

  it("renders into the container once renderGoogle is called", () => {
    const renderGoogleButton = vi.fn().mockResolvedValue(undefined);
    const handle = build({ cfg: googleCfg, renderGoogleButton });
    expect(renderGoogleButton).not.toHaveBeenCalled(); // deferred, not automatic
    handle.renderGoogle();
    expect(renderGoogleButton).toHaveBeenCalledTimes(1);
    expect(renderGoogleButton.mock.calls[0][0]).toBe(
      host.querySelector(".account-google"),
    );
    expect(renderGoogleButton.mock.calls[0][1]).toBe("cid-123");
  });

  it("clears the container first, so a second call cannot stack two buttons", () => {
    const renderGoogleButton = vi
      .fn()
      .mockImplementation((container: HTMLElement) => {
        container.append(document.createElement("iframe"));
        return Promise.resolve();
      });
    const handle = build({ cfg: googleCfg, renderGoogleButton });
    handle.renderGoogle();
    handle.renderGoogle();
    expect(host.querySelectorAll(".account-google iframe")).toHaveLength(1);
  });

  it("empties the container on dispose", () => {
    const renderGoogleButton = vi
      .fn()
      .mockImplementation((container: HTMLElement) => {
        container.append(document.createElement("iframe"));
        return Promise.resolve();
      });
    const handle = build({ cfg: googleCfg, renderGoogleButton });
    handle.renderGoogle();
    handle.dispose();
    expect(host.querySelector(".account-google")?.childElementCount).toBe(0);
  });
});

// ---------- state that must survive a rebuild ----------

describe("form state across rebuilds", () => {
  it("restores a typed address and a sent code from caller-owned state", () => {
    const state: LoginPanelState = {
      email: "rider@example.com",
      sentEmail: "rider@example.com",
      phone: "",
      sentPhone: "",
    };
    build({ state });
    const input = host.querySelector<HTMLInputElement>(".account-magic input")!;
    expect(input.value).toBe("rider@example.com");
    // The code step stays open, because that code is already in their inbox.
    expect(host.querySelector<HTMLElement>("form.account-code")!.hidden).toBe(
      false,
    );
  });

  it("drops a sent code when the restored address no longer matches", () => {
    const state: LoginPanelState = {
      email: "new@example.com",
      sentEmail: "old@example.com",
      phone: "",
      sentPhone: "",
    };
    build({ state });
    expect(host.querySelector<HTMLElement>("form.account-code")!.hidden).toBe(
      true,
    );
    expect(state.sentEmail).toBe("");
  });

  it("records typing into the caller-owned state", () => {
    const state = blankState();
    build({ state });
    const input = host.querySelector<HTMLInputElement>(".account-magic input")!;
    input.value = "typed@example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.email).toBe("typed@example.com");
  });

  it("retracts the code step when the address is edited after sending", async () => {
    const state = blankState();
    const requestLoginCode = vi.fn().mockResolvedValue(undefined);
    build({ state, requestLoginCode });

    const form = host.querySelector<HTMLFormElement>("form.account-magic")!;
    const input = host.querySelector<HTMLInputElement>(".account-magic input")!;
    input.value = "rider@example.com";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(requestLoginCode).toHaveBeenCalledWith("rider@example.com");
    expect(state.sentEmail).toBe("rider@example.com");
    const codeForm = host.querySelector<HTMLElement>("form.account-code")!;
    expect(codeForm.hidden).toBe(false);

    input.value = "someone-else@example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(codeForm.hidden).toBe(true);
    expect(state.sentEmail).toBe("");
  });
});

// ---------- sign-in completion ----------

describe("completion", () => {
  it("reports a verified code through onSignedIn", async () => {
    const onSignedIn = vi.fn();
    const state = blankState();
    const verifyEmailCode = vi.fn().mockResolvedValue(undefined);
    build({
      state,
      onSignedIn,
      verifyEmailCode,
      requestLoginCode: vi.fn().mockResolvedValue(undefined),
    });

    const emailForm = host.querySelector<HTMLFormElement>("form.account-magic")!;
    const emailInput = host.querySelector<HTMLInputElement>(
      ".account-magic input",
    )!;
    emailInput.value = "rider@example.com";
    emailForm.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();

    const codeForm = host.querySelector<HTMLFormElement>("form.account-code")!;
    const codeInput = codeForm.querySelector<HTMLInputElement>("input")!;
    codeInput.value = "AB123XY";
    codeForm.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(verifyEmailCode).toHaveBeenCalledWith("rider@example.com", "AB123XY");
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("refuses to verify a malformed code without calling the API", () => {
    const verifyEmailCode = vi.fn();
    const state: LoginPanelState = {
      email: "rider@example.com",
      sentEmail: "rider@example.com",
      phone: "",
      sentPhone: "",
    };
    build({ state, verifyEmailCode });

    const codeForm = host.querySelector<HTMLFormElement>("form.account-code")!;
    codeForm.querySelector<HTMLInputElement>("input")!.value = "nope";
    codeForm.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(verifyEmailCode).not.toHaveBeenCalled();
  });
});
