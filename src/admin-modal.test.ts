// @vitest-environment happy-dom
//
// The 🛡️ Manage admins modal. The allowlist is the one list in this app that
// can lock its own editors out, so the tests that matter are the guard rails:
// the last admin's Remove is disabled rather than clicked into a 409,
// removing YOURSELF asks first, and every write redraws from its own response
// instead of chasing it with a second fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => {
  class FakePopup {
    setLngLat(): this {
      return this;
    }
    setHTML(): this {
      return this;
    }
    addTo(): this {
      return this;
    }
    getElement(): null {
      return null;
    }
    remove(): this {
      return this;
    }
    on(): this {
      return this;
    }
  }
  return { default: { Popup: FakePopup } };
});
vi.mock("./map-auth.js", () => ({
  isAuthenticated: () => true,
  getAuth: () => ({ token: "tok-1" }),
}));
vi.mock("./geocode.ts", () => ({ reverseGeocode: () => Promise.resolve(null) }));

import { openAdminModal } from "./admin-modal.ts";

const ME = "boss@example.com";
const OTHER = "second@example.com";

const entry = (email: string, is_you = false) => ({
  email,
  added_by: "cli",
  added_at: "2026-07-01T00:00:00+00:00",
  is_you,
});

const listing = (admins: unknown[]) =>
  new Response(JSON.stringify({ count: admins.length, admins }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const card = () => document.querySelector<HTMLElement>(".ranks-modal__card");
const rows = () => [...(card()?.querySelectorAll(".admin-modal__row") ?? [])];
const statusText = () =>
  card()?.querySelector(".admin-modal__status")?.textContent ?? "";

async function open(
  admins: unknown[],
  fetchMock?: ReturnType<typeof vi.fn>,
  opts?: Parameters<typeof openAdminModal>[0],
) {
  const mock = fetchMock ?? vi.fn().mockResolvedValue(listing(admins));
  vi.stubGlobal("fetch", mock);
  openAdminModal(opts);
  await vi.waitFor(() =>
    expect(card()?.querySelector(".admin-modal__list")?.textContent).not.toContain(
      "Loading",
    ),
  );
  return mock;
}

beforeEach(() => {
  document.querySelector(".ranks-modal")?.remove();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelector(".ranks-modal")?.remove();
});

describe("admin modal — listing", () => {
  it("renders each admin with attribution and marks which one is you", async () => {
    await open([entry(ME, true), entry(OTHER)]);
    expect(rows()).toHaveLength(2);
    expect(rows()[0].className).toContain("is-you");
    expect(rows()[0].textContent).toContain("added by cli");
    expect(rows()[1].className).not.toContain("is-you");
  });

  it("explains a failed load instead of showing an empty list", async () => {
    await open([], vi.fn().mockResolvedValue(new Response("no", { status: 500 })));
    expect(card()?.querySelector(".admin-modal__list")?.textContent).toContain(
      "Couldn't load",
    );
  });

  it("says so plainly when the allowlist is empty", async () => {
    await open([]);
    expect(card()?.querySelector(".admin-modal__list")?.textContent).toContain(
      "Nobody is on the allowlist",
    );
  });
});

describe("admin modal — the lockout guard", () => {
  it("disables Remove for the last admin rather than firing a doomed 409", async () => {
    const mock = await open([entry(ME, true)]);
    const btn = card()?.querySelector<HTMLButtonElement>(".admin-modal__remove");
    expect(btn?.disabled).toBe(true);
    expect(btn?.getAttribute("title")).toContain("can't be left empty");
    btn?.click();
    // One call: the initial GET. The click did nothing.
    expect(mock.mock.calls).toHaveLength(1);
  });

  it("enables Remove again once a second admin exists", async () => {
    await open([entry(ME, true), entry(OTHER)]);
    for (const btn of card()?.querySelectorAll<HTMLButtonElement>(
      ".admin-modal__remove",
    ) ?? []) {
      expect(btn.disabled).toBe(false);
    }
  });

  it("surfaces the API's own 409 wording if the server refuses anyway", async () => {
    // The client-side guard can be out of date — someone else may have
    // removed an admin since this list loaded. The refusal must still read.
    const mock = vi
      .fn()
      .mockResolvedValueOnce(listing([entry(ME, true), entry(OTHER)]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "refusing to remove the last admin — add another first" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      );
    await open([], mock);
    card()
      ?.querySelector<HTMLButtonElement>(`.admin-modal__remove[data-email="${OTHER}"]`)
      ?.click();
    await vi.waitFor(() => expect(statusText()).toContain("last admin"));
  });
});

describe("admin modal — writes", () => {
  it("confirms before removing your own access, and aborts on cancel", async () => {
    const mock = await open([entry(ME, true), entry(OTHER)]);
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    card()
      ?.querySelector<HTMLButtonElement>(`.admin-modal__remove[data-email="${ME}"]`)
      ?.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain(ME);
    expect(mock.mock.calls).toHaveLength(1); // still just the initial GET
  });

  it("removes someone else without asking, and redraws from the response", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(listing([entry(ME, true), entry(OTHER)]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 1,
            admins: [entry(ME, true)],
            email: OTHER,
            removed: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    await open([], mock);
    card()
      ?.querySelector<HTMLButtonElement>(`.admin-modal__remove[data-email="${OTHER}"]`)
      ?.click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(statusText()).toContain(`Removed ${OTHER}`);
    // Exactly two calls: the GET and the DELETE. No follow-up refetch.
    expect(mock.mock.calls).toHaveLength(2);
    const [url, init] = mock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(url).toContain(`email=${encodeURIComponent(OTHER)}`);
  });

  it("revokes this session's admin state when you remove YOURSELF", async () => {
    // The server's answer is live, the client's copy is not: the admin flag
    // is pushed into Devices once per token and /auth/session is read once
    // per panel build. Without a hand-off, the rider keeps the proximity
    // bypass and the Administrator Mode badge until they reload — which is
    // exactly what the confirmation promised would not happen.
    const onAdminRevoked = vi.fn();
    const mock = vi
      .fn()
      .mockResolvedValueOnce(listing([entry(ME, true), entry(OTHER)]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 1,
            admins: [entry(OTHER)],
            email: ME,
            removed: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    await open([], mock, { onAdminRevoked });
    vi.stubGlobal("confirm", () => true);
    card()
      ?.querySelector<HTMLButtonElement>(`.admin-modal__remove[data-email="${ME}"]`)
      ?.click();

    await vi.waitFor(() => expect(onAdminRevoked).toHaveBeenCalledOnce());
    // …and the modal closes: a list you can no longer read, with buttons
    // that would now 403, is not a screen worth leaving up.
    await vi.waitFor(() => expect(document.querySelector(".ranks-modal")).toBeNull());
  });

  it("does NOT revoke anything when you remove someone else", async () => {
    const onAdminRevoked = vi.fn();
    const mock = vi
      .fn()
      .mockResolvedValueOnce(listing([entry(ME, true), entry(OTHER)]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 1,
            admins: [entry(ME, true)],
            email: OTHER,
            removed: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    await open([], mock, { onAdminRevoked });
    card()
      ?.querySelector<HTMLButtonElement>(`.admin-modal__remove[data-email="${OTHER}"]`)
      ?.click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(onAdminRevoked).not.toHaveBeenCalled();
    expect(document.querySelector(".ranks-modal")).not.toBeNull();
  });

  it("revokes nothing when the self-removal did not actually happen", async () => {
    // removed: false — the row was already gone. Nothing changed, so the
    // session keeps whatever it had.
    const onAdminRevoked = vi.fn();
    const mock = vi
      .fn()
      .mockResolvedValueOnce(listing([entry(ME, true), entry(OTHER)]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 2,
            admins: [entry(ME, true), entry(OTHER)],
            email: ME,
            removed: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    await open([], mock, { onAdminRevoked });
    vi.stubGlobal("confirm", () => true);
    card()
      ?.querySelector<HTMLButtonElement>(`.admin-modal__remove[data-email="${ME}"]`)
      ?.click();
    await vi.waitFor(() => expect(statusText()).toContain("wasn't on the list"));
    expect(onAdminRevoked).not.toHaveBeenCalled();
  });

  it("adds an admin and reports an idempotent no-op honestly", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(listing([entry(ME, true)]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 1,
            admins: [entry(ME, true)],
            email: ME,
            added: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    await open([], mock);
    const input = card()?.querySelector<HTMLInputElement>(".admin-modal__input");
    input!.value = ME;
    card()?.querySelector<HTMLFormElement>(".admin-modal__add")?.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await vi.waitFor(() => expect(statusText()).toContain("already an admin"));
    const [, init] = mock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: ME });
  });

  it("reports a rejected address without clearing what was typed", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(listing([entry(ME, true)]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "not an email address" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    await open([], mock);
    const input = card()?.querySelector<HTMLInputElement>(".admin-modal__input");
    input!.value = "nonsense";
    card()?.querySelector<HTMLFormElement>(".admin-modal__add")?.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await vi.waitFor(() => expect(statusText()).toContain("email address"));
    // Their typing survives the error — retyping a corrected address beats
    // starting over.
    expect(input!.value).toBe("nonsense");
    expect(
      card()?.querySelector<HTMLButtonElement>(".admin-modal__submit")?.disabled,
    ).toBe(false);
  });
});
