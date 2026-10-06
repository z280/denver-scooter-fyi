// The standalone stats page, for framing on weseeyouveo.com.
//
// WHY THIS EXISTS AS A PAGE. The same figures belong on both properties, and
// the alternative — each site computing its own — is the one thing that would
// make neither worth quoting. So there is one endpoint, one renderer, and one
// stylesheet; this entry point is a thin wrapper that reads a voice off the
// URL and hands it to `renderFleetStats`.
//
// WHAT `?voice=` MAY DO: select words. `docs/ANALYTICS_PLAN.md` §4 states the
// constraint and `fleet-stats.ts` holds the copy table that implements it —
// the parameter must never pick a different filter, window or threshold. An
// unrecognised value falls back to the rider voice rather than throwing: a
// typo in somebody's embed code should cost the wording, not the page.
//
// WHAT THIS PAGE DELIBERATELY IS NOT: it carries no map, no basemap, no
// account state and no telemetry. It is a panel of numbers that a third-party
// page can frame without pulling scooter.fyi's application into someone
// else's document.

import "./stats.css";
import "./embed.css";

import { renderFleetStats, type StatsVoice } from "./fleet-stats.ts";

/** Read the voice, treating anything unexpected as the default.
 *
 *  Exported for the test: the fallback is the interesting behaviour, because
 *  the failure it prevents (a blank panel on a host page nobody at
 *  scooter.fyi can edit) is invisible from here. */
export function voiceFromSearch(search: string): StatsVoice {
  const raw = new URLSearchParams(search).get("voice");
  return raw === "civic" ? "civic" : "rider";
}

/** Tell the framing page how tall the panel is.
 *
 *  An iframe cannot size itself, so without this the host has to guess a
 *  height and either clips the model list or leaves a band of empty page
 *  under it. The host opts in by listening for the message; one that does not
 *  is unaffected.
 *
 *  Posted to "*" because the panel is public, noindex, read-only content —
 *  there is nothing here worth restricting to an origin, and an allowlist
 *  would have to be edited every time somebody embeds it. Nothing is ever
 *  READ from the host: this page has no message listener at all. */
function publishHeight(): void {
  const send = (): void => {
    const height = Math.ceil(document.documentElement.scrollHeight);
    window.parent?.postMessage({ type: "scooterfyi:stats-height", height }, "*");
  };
  send();
  // The panel's height changes once — loading placeholder to rendered — and
  // again if the host resizes it narrow enough to rewrap.
  new ResizeObserver(send).observe(document.documentElement);
}

const root = document.getElementById("fleet-stats");
if (root) {
  void renderFleetStats(root, voiceFromSearch(location.search)).finally(
    publishHeight,
  );
}
