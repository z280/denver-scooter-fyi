// Rider stats: what share of rentals never left the kerb.
//
// THE NUMBER. `/api/v1/fleet/outcomes` aggregates counters the ingest has
// maintained since sql/072, incremented the moment each rental completes.
// Because Veo's feed marks a vehicle `is_reserved` while it is IN USE rather
// than while somebody holds a booking, a "no-go" is an ATTEMPT: a rider
// unlocked a vehicle and it took them nowhere. That is why it is worth putting
// on screen at all.
//
// THE VOICE, which is the whole reason this module is shaped the way it is.
// `docs/ANALYTICS_PLAN.md` states the rule: **same numbers, different verbs.
// scooter.fyi reports. WSYV argues.** A rider deserves to know what share of
// rentals go nowhere for the same reason they deserve a battery level — it is
// consumer information about a service. scooter.fyi is pro-rider and is not an
// advocacy platform; it takes no position on who is to blame, and the copy
// below never supplies one. A no-go is an attempt that went nowhere; the cause
// might be the vehicle, the app, the weather, or somebody changing their mind
// after unlocking, and this panel does not pretend to know which.
//
// So `VOICES` is a copy table and nothing else. It selects words. It must
// never select a different filter, window or threshold — the moment the two
// properties can disagree about a number, neither is worth quoting, and the
// numbers are the only asset either site has.
//
// THREE THINGS ARE ALWAYS RENDERED, because a percentage without them is the
// kind of figure that gets quoted back at you naked:
//
//   * the window — these counters have never reset, so this is a lifetime
//     figure and NOT "today". An unlabelled rate reads as "now".
//   * the radius — the codebase holds three different ideas of how far is
//     "moved" (ANALYTICS_PLAN §0.2). Until that is settled the figure says
//     which circle it was counted at instead of letting a reader assume.
//   * the sample — the fleet total, and for a model under the floor, "not
//     enough rides yet" in place of a percentage. A model with n=7 keeps its
//     counts and loses its rate; it does not quietly vanish from the list,
//     because a list that drops its thin rows looks complete and isn't.

import {
  fetchFleetOutcomes,
  NoDataError,
  type FleetOutcomeModel,
  type FleetOutcomesResponse,
} from "./api.ts";

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

/** Which site is rendering. The parameter behind `/embed/stats?voice=`.
 *
 *  `rider` is scooter.fyi: practical, second person, about your next trip.
 *  `civic` is weseeyouveo.com: the same figures addressed to a city rather
 *  than to a rider. Neither changes what is counted. */
export type StatsVoice = "rider" | "civic";

export interface VoiceCopy {
  /** Panel heading. */
  title: string;
  /** One line under the heading, before any number. */
  standfirst: string;
  /** Label on the headline rate. */
  headlineLabel: string;
  /** Label over the per-model breakdown. */
  modelsLabel: string;
  /** Shown when the feed came back with nothing counted. */
  empty: string;
  /** Shown when the feed could not be reached at all. */
  unavailable: string;
  /** Cross-promotion: the other property, named and linked. */
  crossPromo: { lead: string; label: string; href: string };
}

export const VOICES: Record<StatsVoice, VoiceCopy> = {
  rider: {
    title: "Did the rental go anywhere?",
    // Consumer information, stated as such. No villain, named or implied.
    standfirst:
      "Every unlock we have seen, and whether it turned into a trip. Useful before you tap one.",
    headlineLabel: "of rentals never left the kerb",
    modelsLabel: "By model",
    empty: "No rentals counted yet. This fills in as the fleet gets ridden.",
    unavailable: "Stats are unavailable right now. The map is unaffected.",
    crossPromo: {
      lead: "Following Denver's scooter contract?",
      label: "We See You Veo",
      href: "https://weseeyouveo.com",
    },
  },
  civic: {
    title: "Rentals that went nowhere",
    standfirst:
      "Measured from Veo's own public feed: unlocks that never produced a trip.",
    headlineLabel: "of rentals never left the kerb",
    modelsLabel: "By model",
    empty: "No rentals counted yet.",
    unavailable: "Stats are unavailable right now.",
    crossPromo: {
      lead: "Riding today?",
      label: "Scooter.fyi",
      href: "https://scooter.fyi",
    },
  },
};

/** A rate as a percentage with one decimal, or null straight through.
 *
 *  One decimal because the difference between 9.1% and 9% is the difference
 *  between a measurement and a round number, and this one was measured. */
export function formatRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return `${(rate * 100).toFixed(1)}%`;
}

/** "1 in 11" — the headline rate said the way people repeat it.
 *
 *  Shown BESIDE the percentage, never instead of it: the ratio is what gets
 *  remembered and the percentage is what can be checked. */
export function formatOdds(rate: number | null): string | null {
  if (rate === null || rate <= 0 || rate > 1) return null;
  return `about 1 in ${Math.round(1 / rate)}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Metres, rounded, for the provenance line. */
function formatMeters(m: number): string {
  return `${Math.round(m)} m`;
}

/** The provenance line. Not a footnote in the sense of "ignorable" — it is
 *  what makes the figure above it quotable, and it is built from the payload
 *  rather than hard-coded so it cannot drift from what was counted. */
export function provenanceText(data: FleetOutcomesResponse): string {
  const window = data.window === "lifetime" ? "All rentals we have seen" : data.window;
  return (
    `${window} — ${formatCount(data.rentals)} across ` +
    `${formatCount(data.vehicles)} vehicles. A rental counts as going nowhere ` +
    `when the vehicle stayed within ${formatMeters(data.radius_meters)} of ` +
    `where it was unlocked. It does not say why.`
  );
}

function modelRow(m: FleetOutcomeModel, floor: number): HTMLElement {
  const row = el("li", "stat-row");
  row.append(el("span", "stat-row__name", m.model));

  const rate = formatRate(m.no_go_rate);
  if (rate === null) {
    // Thin sample. The counts stay — this row is honest about being thin,
    // which is a different statement from being absent.
    row.append(el("span", "stat-row__value stat-row__value--thin", "not enough rides yet"));
    row.append(
      el(
        "span",
        "stat-row__sample",
        `${formatCount(m.rentals)} rentals — a rate needs ${formatCount(floor)}`,
      ),
    );
  } else {
    row.append(el("span", "stat-row__value", rate));
    row.append(
      el(
        "span",
        "stat-row__sample",
        `${formatCount(m.no_gos)} of ${formatCount(m.rentals)} rentals`,
      ),
    );
  }
  return row;
}

/** Build the panel from a payload. Pure DOM, no fetching — which is what
 *  lets the embed and the drawer share one implementation, and lets the
 *  tests assert the copy without a network. */
export function buildFleetStats(
  data: FleetOutcomesResponse,
  voice: StatsVoice = "rider",
): DocumentFragment {
  const copy = VOICES[voice];
  const frag = document.createDocumentFragment();

  frag.append(el("h3", "stats-title", copy.title));
  frag.append(el("p", "stats-standfirst", copy.standfirst));

  if (data.rentals <= 0) {
    frag.append(el("p", "stats-empty", copy.empty));
    return frag;
  }

  const headline = el("div", "stats-headline");
  const rate = formatRate(data.no_go_rate);
  if (rate === null) {
    // The fleet itself under the floor. Possible on a fresh deployment, and
    // the counts are the only honest thing to show.
    headline.append(el("strong", "stats-headline__value", formatCount(data.no_gos)));
    headline.append(
      el(
        "span",
        "stats-headline__label",
        `rentals went nowhere, of ${formatCount(data.rentals)} — too few for a rate yet`,
      ),
    );
  } else {
    headline.append(el("strong", "stats-headline__value", rate));
    headline.append(el("span", "stats-headline__label", copy.headlineLabel));
    const odds = formatOdds(data.no_go_rate);
    if (odds) headline.append(el("span", "stats-headline__odds", odds));
  }
  frag.append(headline);

  frag.append(el("p", "stats-provenance", provenanceText(data)));

  if (data.by_model.length > 0) {
    frag.append(el("h4", "stats-subtitle", copy.modelsLabel));
    const list = el("ul", "stat-list");
    for (const m of data.by_model) {
      list.append(modelRow(m, data.min_rentals_for_rate));
    }
    frag.append(list);
  }

  // Cross-promotion, one line, at the bottom. The two properties point at
  // each other because they serve different questions, not because they are
  // the same project wearing two hats.
  const promo = el("p", "stats-promo");
  promo.append(document.createTextNode(`${copy.crossPromo.lead} `));
  const link = el("a", undefined, copy.crossPromo.label);
  link.href = copy.crossPromo.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  promo.append(link);
  frag.append(promo);

  return frag;
}

/** Per-panel network budget: a hung feed must become "unavailable" rather
 *  than leaving the drawer on its loading placeholder forever. The same
 *  reasoning as `compliance.ts`, and the same number. */
const STATS_FETCH_TIMEOUT_MS = 12_000;

/** Fetch and render. Every throw lands in the catch — a drawer stuck on
 *  "Loading…" is the failure mode this guards, because the placeholder is
 *  static markup and only a successful replaceChildren clears it. */
export async function renderFleetStats(
  root: HTMLElement,
  voice: StatsVoice = "rider",
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATS_FETCH_TIMEOUT_MS);
  try {
    const data = await fetchFleetOutcomes(controller.signal);
    root.replaceChildren(buildFleetStats(data, voice));
  } catch (err) {
    const copy = VOICES[voice];
    const frag = document.createDocumentFragment();
    frag.append(el("h3", "stats-title", copy.title));
    // NoDataError is the server saying "not yet", which is a different
    // sentence from "we could not reach it".
    frag.append(
      el(
        "p",
        "stats-empty",
        err instanceof NoDataError ? copy.empty : copy.unavailable,
      ),
    );
    root.replaceChildren(frag);
  } finally {
    clearTimeout(timer);
  }
}
