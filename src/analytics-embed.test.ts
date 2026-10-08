// @vitest-environment happy-dom
//
// /analytics?embed=1 framed by weseeyouveo.com/data: the embed parameters
// survive the controls' URL rewrites, and the height is reported to the host
// with the same message protocol as /embed/stats.html.
import { describe, expect, it, vi } from "vitest";

import { embedParams, postEmbedHeight, withEmbedParams } from "./analytics-page.ts";

describe("analytics embed mode", () => {
  it("keeps only the embed parameters it knows", () => {
    expect(embedParams("?embed=1&theme=dark&days=90")).toBe("embed=1&theme=dark");
    expect(embedParams("?embed=0&theme=purple")).toBe("");
    expect(embedParams("")).toBe("");
  });

  it("carries them through the controls' own search string", () => {
    expect(withEmbedParams("?days=30&g=day", "embed=1&theme=light")).toBe("?days=30&g=day&embed=1&theme=light");
    expect(withEmbedParams("", "embed=1")).toBe("?embed=1");
    expect(withEmbedParams("?days=7", "")).toBe("?days=7");
  });

  it("posts the content height to the parent with the stats-embed style message", () => {
    const post = vi.fn();
    const fakeWin = {
      document,
      getComputedStyle: () => ({ marginTop: "8px", marginBottom: "8px" }),
      parent: { postMessage: post },
    } as unknown as Window;
    Object.defineProperty(document.body, "scrollHeight", { configurable: true, value: 3000 });
    const stop = postEmbedHeight(fakeWin);
    expect(post).toHaveBeenCalledWith({ type: "scooterfyi:analytics-height", height: 3016 }, "*");
    stop();
  });
});
