// @vitest-environment happy-dom
//
// Owner directive 2026-10-08: Google's sign-in script
// (accounts.google.com/gsi/client) is NOT loaded at boot. It loads only when a
// sign-in surface that shows the Google button is rendered, and there is no
// automatic One Tap prompt.
//
// Uses the REAL auth-google.ts loader — the point is to watch what it puts in
// <head> — but intercepts the append so happy-dom never tries to fetch the
// script from Google.
//
// The end-to-end version (the built site, booted in Chromium, signed out, with
// /auth/config saying Google is on) is in scripts/smoke.mjs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLoginPanel, whenDrawerOpen } from "./account-login.ts";
import type { AuthConfig } from "./auth-config.ts";
import { readSource, withoutComments } from "../tests/helpers/source-text.ts";

const GOOGLE_ON: AuthConfig = {
  googleEnabled: true,
  googleClientId: "cid-123",
  magicLinkEnabled: true,
  codeEnabled: true,
  smsEnabled: false,
};

let injected: string[];

function googleScripts(): string[] {
  return injected.filter((src) => src.startsWith("https://accounts.google.com"));
}

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  injected = [];
  const realAppend = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    if (node instanceof HTMLScriptElement) {
      injected.push(node.src);
      return node; // never actually loaded
    }
    return realAppend(node);
  });
});

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

/** The Account drawer as main.ts boots it for a signed-out visitor: the
 *  sign-in block built inside a CLOSED drawer, its Google render deferred. */
function bootSignedOutDrawer(): HTMLElement {
  const drawer = document.createElement("aside");
  drawer.id = "drawer-account";
  drawer.className = "drawer";
  const host = document.createElement("div");
  drawer.append(host);
  document.body.append(drawer);
  const panel = buildLoginPanel(host, {
    cfg: GOOGLE_ON,
    state: { email: "", sentEmail: "", phone: "", sentPhone: "" },
    onSignedIn: vi.fn(),
    buildSmsDoor: vi.fn(),
  });
  whenDrawerOpen(drawer, () => panel.renderGoogle());
  return drawer;
}

describe("Google's sign-in script is lazy", () => {
  it("is not added at boot for a signed-out visitor, even with Google enabled", async () => {
    bootSignedOutDrawer();
    await Promise.resolve();
    expect(googleScripts()).toEqual([]);
    expect(document.querySelector('script[src*="accounts.google.com"]')).toBeNull();
  });

  it("is added once the Account drawer's sign-in block is shown", async () => {
    const drawer = bootSignedOutDrawer();
    drawer.classList.add("is-open"); // what wireDrawers does on open
    await new Promise((r) => setTimeout(r, 0)); // MutationObserver + async init
    expect(googleScripts()).toEqual(["https://accounts.google.com/gsi/client"]);
  });

  it("renders straight away when the drawer is already open", async () => {
    const drawer = document.createElement("div");
    drawer.className = "is-open";
    const fn = vi.fn();
    whenDrawerOpen(drawer, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a cancelled wait never renders", async () => {
    const drawer = document.createElement("div");
    const fn = vi.fn();
    const cancel = whenDrawerOpen(drawer, fn);
    cancel();
    drawer.classList.add("is-open");
    await new Promise((r) => setTimeout(r, 0));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("no One Tap, no boot-time Google call (source)", () => {
  const google = withoutComments(readSource("src/auth-google.ts"));
  const main = withoutComments(readSource("src/main.ts"));

  it("auth-google.ts has no prompt() and no One Tap entry point", () => {
    expect(google).not.toMatch(/\.prompt\s*\(/);
    expect(google).not.toMatch(/promptGoogleOneTap/);
  });

  it("main.ts imports nothing from auth-google.ts", () => {
    expect(main).not.toMatch(/from\s+["']\.\/auth-google\.ts["']/);
  });

  it("main.ts renders the drawer's Google button only through whenDrawerOpen", () => {
    const calls = main.match(/\.renderGoogle\(\)/g) ?? [];
    expect(calls.length).toBe(1);
    expect(main).toMatch(/whenDrawerOpen\([\s\S]{0,120}\.renderGoogle\(\)/);
  });
});
