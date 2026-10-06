// Denver's own micromobility rules, on the map.
//
// WHERE THIS CAME FROM, AND WHY IT MATTERS THAT IT IS THE CITY'S.
// `docs/ALONG_THE_WAY_PLAN.md` §11.6 recorded a verified negative: Veo
// publishes no `geofencing_zones` feed (checked 2026-10-06 — its
// `system_information` returns 200, `geofencing_zones` 404), so the app could
// not tell a rider where riding is barred, where the speed is capped, or where
// a ride may not end. That section said the honest options were to find a
// city source or build nothing, because a boundary we cannot source is exactly
// the confident wrong claim this codebase refuses elsewhere.
//
// This is the city source: Denver DOTI, released under a Colorado Open Records
// Act request, received 2026-10-06. `scripts/build-zones.mjs` turns the twelve
// bare `Feature` files of that export into `public/micromobility-zones.geojson`
// and is where the classification decisions are written down.
//
// WHAT THIS IS NOT. It is the CITY's rulebook, which is not identical to VEO's
// fee rule — the operator's own geofence is what actually charges somebody,
// and we still cannot see it. So the copy says what the city requires and
// never promises what Veo will charge. Two of the six classes carry a rule we
// are inferring (school land is a parcel set with no hours attached; Glendale
// is a jurisdiction, not a restriction), and both carry a `zone_note` saying
// so rather than being drawn as though we knew.

import type { Map as MLMap } from "maplibre-gl";
import { bandBefore } from "./map-bands.ts";
import type { InspectHit, InspectPoint, InspectSource } from "./map-inspect.ts";

const SRC = "micromobility-zones";

/** The classes `scripts/build-zones.mjs` emits. */
export type ZoneKind =
  | "no_ride"
  | "no_parking"
  | "slow_no_parking"
  | "slow"
  | "school"
  | "outside_denver";

/** What a rider can switch on and off. Three groups rather than six toggles:
 *  the rules are one question ("what does the city not let me do here?"), and
 *  the other two are context a rider mostly does not want drawn.
 *
 *  `rules` is ON by default, because it is the only layer in this app that can
 *  stop somebody breaking a law they did not know about. The other two are
 *  off: school land is 211 polygons of parcel boundary whose restriction we
 *  cannot state, and Glendale is a line that matters once. */
export const ZONE_GROUPS = {
  rules: {
    label: "Slow & no-parking zones",
    kinds: ["no_ride", "no_parking", "slow_no_parking", "slow"] as ZoneKind[],
    defaultOn: true,
  },
  schools: {
    label: "School grounds",
    kinds: ["school"] as ZoneKind[],
    defaultOn: false,
  },
  outside: {
    label: "Outside Denver",
    kinds: ["outside_denver"] as ZoneKind[],
    defaultOn: false,
  },
} as const;

export type ZoneGroup = keyof typeof ZONE_GROUPS;

/** Colour per class.
 *
 *  Chosen against what the map already uses rather than from a palette: the
 *  boundary overlays are blue/teal/brown and the equity areas are purple, so
 *  the rules take the warm end, and they take it in the order of how much they
 *  cost a rider — red stops you, orange stops the ride ending, amber slows you
 *  down. The two inferred classes are deliberately grey: a colour that reads
 *  as a rule, for a thing we cannot state as one, would be the lie. */
export const ZONE_COLOR: Record<ZoneKind, string> = {
  no_ride: "#c1121f",
  no_parking: "#e07a00",
  slow_no_parking: "#e07a00",
  slow: "#eab308",
  school: "#8a8f98",
  outside_denver: "#8a8f98",
};

/** Muted is the default, for the same reason the equity overlay's is: these
 *  cover real area, and a rider needs to see the scooters through them. The
 *  LINE carries where the boundary is; the fill only says which side you are
 *  on. */
const PAINT = {
  muted: { fill: 0.08, line: 0.5, width: 1.1 },
  full: { fill: 0.22, line: 0.95, width: 1.8 },
} as const;

export interface ZoneFeatureProps {
  zone_kind: ZoneKind;
  zone_label: string;
  zone_venue?: string;
  zone_note?: string;
}

export interface ZoneCollection {
  type: "FeatureCollection";
  name?: string;
  source?: { agency: string; obtained_via: string; received: string };
  features: {
    type: "Feature";
    properties: ZoneFeatureProps;
    geometry: { type: string; coordinates: unknown };
  }[];
}

let cache: Promise<ZoneCollection> | null = null;

/** Fetch the zones once per page. Cached as the PROMISE so two concurrent
 *  callers share one request — the same discipline `equity-areas.ts` uses. */
export function loadZones(
  fetchImpl: typeof fetch = fetch,
): Promise<ZoneCollection> {
  cache ??= fetchImpl("/micromobility-zones.geojson")
    .then((r) => {
      if (!r.ok) throw new Error(`zones: HTTP ${r.status}`);
      return r.json() as Promise<ZoneCollection>;
    })
    .catch((e: unknown) => {
      // Drop the cache so a later attempt can retry rather than inheriting a
      // rejection for the life of the page.
      cache = null;
      throw e;
    });
  return cache;
}

/** Test/HMR seam. */
export function resetZonesForTest(): void {
  cache = null;
}

/** The sentence a rider gets for a zone. Pure, so the wording is assertable
 *  without a map.
 *
 *  Venue first when there is one: "Ball Arena · Slow zone" is how somebody
 *  standing there thinks about it, and the venue is the part they can verify
 *  by looking up. */
export function zoneSentence(p: ZoneFeatureProps): string {
  const head = p.zone_venue ? `${p.zone_venue} · ${p.zone_label}` : p.zone_label;
  return p.zone_note ? `${head} — ${p.zone_note}` : head;
}

/** Which groups a kind belongs to. One kind, one group, but written as a
 *  lookup so a future class that spans two does not need this rewritten. */
export function groupOf(kind: ZoneKind): ZoneGroup | null {
  for (const [name, spec] of Object.entries(ZONE_GROUPS)) {
    if ((spec.kinds as readonly ZoneKind[]).includes(kind)) {
      return name as ZoneGroup;
    }
  }
  return null;
}

/** Worst first: the order a rider needs to hear about overlapping zones in. */
const KIND_SEVERITY: ZoneKind[] = [
  "no_ride",
  "slow_no_parking",
  "no_parking",
  "slow",
  "school",
  "outside_denver",
];

/** Emoji per class for the triple-tap card. Matches the colour logic above:
 *  stop, no-end, slow, and the two greys. */
const KIND_ICON: Record<ZoneKind, string> = {
  no_ride: "⛔",
  no_parking: "🅿️",
  slow_no_parking: "🐢",
  slow: "🐢",
  school: "🏫",
  outside_denver: "🧭",
};

/** What each class means for a rider, for classes whose feature carries no
 *  `zone_note` of its own. Deliberately no speed figure for slow zones: the
 *  city's export names the zones but not the limit, and a number we cannot
 *  source is exactly the confident wrong claim this file refuses. */
const KIND_MEANING: Record<ZoneKind, string> = {
  no_ride: "Riding is not permitted here at any time.",
  no_parking: "You may ride through, but not end a ride here.",
  slow_no_parking: "Speed is limited here and you may not end a ride.",
  slow: "Speed is limited here.",
  school: "School grounds. Restrictions are likely, but the city's export does not say when they apply.",
  outside_denver: "A separate city. Denver's rules, and this app's numbers, stop at this line.",
};

/** What to DO about it, where there is a clear answer. */
const KIND_ADVICE: Partial<Record<ZoneKind, string>> = {
  no_ride: "Walk the scooter through, and start or end your ride outside the line.",
  no_parking: "Park outside the shaded area before you end your ride.",
  slow_no_parking: "Take it easy through here, and park outside the shaded area.",
  slow: "Ride slowly through here. If the scooter slows down on its own, that may be Veo enforcing a slow zone rather than a fault.",
};

function escapeZoneHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One entry per distinct zone, worst first. Overlapping polygons of the same
 *  zone (a venue drawn in pieces) collapse to one. */
export function distinctZones(
  props: readonly ZoneFeatureProps[],
): ZoneFeatureProps[] {
  const seen = new Map<string, ZoneFeatureProps>();
  for (const p of props) {
    const k = `${p.zone_kind}|${p.zone_label}|${p.zone_venue ?? ""}`;
    if (!seen.has(k)) seen.set(k, p);
  }
  const rank = (k: ZoneKind): number => {
    const i = KIND_SEVERITY.indexOf(k);
    return i < 0 ? KIND_SEVERITY.length : i;
  };
  return [...seen.values()].sort((a, b) => rank(a.zone_kind) - rank(b.zone_kind));
}

/** Title for the triple-tap card. Generic on purpose: the rows below name
 *  each zone, and repeating the first row's name as the title read as a
 *  stutter. */
export function zoneInspectTitle(zones: readonly ZoneFeatureProps[]): string {
  return zones.length > 1 ? "Denver rules here" : "Denver rule here";
}

/** Body for the triple-tap card. Pure, so the copy is assertable. */
export function buildZoneInspectHtml(zones: readonly ZoneFeatureProps[]): string {
  const items = zones
    .map((z) => {
      const name = z.zone_venue ? `${z.zone_venue} · ${z.zone_label}` : z.zone_label;
      const meaning = z.zone_note ?? KIND_MEANING[z.zone_kind] ?? "";
      const advice = KIND_ADVICE[z.zone_kind];
      return `
        <li class="zone-inspect__item zone-inspect__item--${escapeZoneHtml(z.zone_kind)}">
          <span class="zone-inspect__icon" aria-hidden="true">${KIND_ICON[z.zone_kind] ?? "📍"}</span>
          <div>
            <p class="zone-inspect__name">${escapeZoneHtml(name)}</p>
            <p class="zone-inspect__meaning">${escapeZoneHtml(meaning)}</p>
            ${advice ? `<p class="zone-inspect__advice">${escapeZoneHtml(advice)}</p>` : ""}
          </div>
        </li>`;
    })
    .join("");
  return `
    <div class="zone-inspect">
      <ul class="zone-inspect__list">${items}</ul>
      <p class="zone-inspect__source">
        These are the City of Denver's rules, from its own zone map (DOTI,
        released under an open-records request, October 2026). Veo's in-app
        geofence is what actually slows a scooter or charges a fee, and it may
        not match these lines exactly.
      </p>
    </div>`;
}

export class MicromobilityZones implements InspectSource {
  private layersAdded = false;
  private muted = true;
  private visible: Record<ZoneGroup, boolean> = {
    rules: ZONE_GROUPS.rules.defaultOn,
    schools: ZONE_GROUPS.schools.defaultOn,
    outside: ZONE_GROUPS.outside.defaultOn,
  };

  constructor(
    private readonly map: MLMap,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Opens the triple-tap card. Injected, like the equity overlay's, so
     *  this module does not pull in devices.ts and the whole popup stack. */
    private readonly openCard: (title: string, html: string) => void = () => {},
  ) {}

  isVisible(group: ZoneGroup): boolean {
    return this.visible[group];
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Have the zone layers been drawn at all? False until the geometry
   *  fetch resolves, and for good if it failed. */
  isLoaded(): boolean {
    return this.layersAdded;
  }

  /** `InspectSource`: the city zones drawn under `point`. Only what is
   *  DRAWN counts: a group switched off in Areas is not on the map, and
   *  explaining an invisible polygon would answer a question nobody asked.
   *  Top of the stack (map-bands.ts), so a zone wins over the equity area
   *  and territory beneath it. */
  hitAt(point: InspectPoint): InspectHit | null {
    if (!this.layersAdded || typeof this.map.queryRenderedFeatures !== "function") {
      return null;
    }
    const props = this.map
      .queryRenderedFeatures([point.x, point.y], { layers: [`${SRC}-fill`] })
      .map((f) => f.properties as ZoneFeatureProps);
    return this.hitForZones(props);
  }

  /** The hit for a set of zone properties. Split out so the content and the
   *  key are testable without rendering. */
  hitForZones(props: readonly ZoneFeatureProps[]): InspectHit | null {
    const zones = distinctZones(props);
    if (!zones.length) return null;
    return {
      key:
        "zone:" +
        zones.map((z) => `${z.zone_kind}/${z.zone_label}/${z.zone_venue ?? ""}`).join("+"),
      open: () => this.openCard(zoneInspectTitle(zones), buildZoneInspectHtml(zones)),
    };
  }

  /** Show or hide one group. Safe before the geometry has loaded — it awaits
   *  the fetch, like the equity overlay's own setter.
   *
   *  This and `setMuted` are the ONLY entry points: both materialise the
   *  layers on first call, so `main.ts` applying the markup's defaults is also
   *  what draws them. There is deliberately no separate `start()` — a method
   *  whose doc said "called at wire time" while nothing but the tests called
   *  it is worse than no method at all. */
  async setVisible(group: ZoneGroup, on: boolean): Promise<void> {
    // State before the await: `ensureLayers` builds the filters from these,
    // and the fetch can outlive the call that asked. (The equity overlay
    // carries the same note, for the same flash-of-the-wrong-look reason.)
    this.visible[group] = on;
    await this.ensureLayers();
    this.applyFilters();
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    await this.ensureLayers();
    this.applyPaint();
  }

  /** One source and two layers for all six classes, with the colour driven by
   *  a `match` on the feature's own `zone_kind`.
   *
   *  Six sources and twelve layers would be the obvious shape and the wrong
   *  one: every added layer costs a draw pass, the classes never need
   *  different ordering between themselves, and a single filter expression is
   *  what lets a group toggle be one `setFilter` rather than six visibility
   *  writes that can disagree with each other. */
  private async ensureLayers(): Promise<void> {
    if (this.layersAdded) return;
    const data = await loadZones(this.fetchImpl);
    // Re-check after the await: two concurrent callers can both pass the guard
    // above before either finishes, and addSource throws on a duplicate id.
    if (this.layersAdded) return;

    const colorExpr: unknown[] = ["match", ["get", "zone_kind"]];
    for (const [kind, color] of Object.entries(ZONE_COLOR)) {
      colorExpr.push(kind, color);
    }
    colorExpr.push("#8a8f98"); // an unknown class is drawn, greyed, not dropped

    this.map.addSource(SRC, { type: "geojson", data: data as never });
    this.map.addLayer(
      {
        id: `${SRC}-fill`,
        type: "fill",
        source: SRC,
        paint: {
          "fill-color": colorExpr as never,
          "fill-opacity": (this.muted ? PAINT.muted : PAINT.full).fill,
        },
      },
      bandBefore(this.map, "zones"),
    );
    this.map.addLayer(
      {
        id: `${SRC}-line`,
        type: "line",
        source: SRC,
        layout: { "line-join": "round" },
        paint: {
          "line-color": colorExpr as never,
          "line-width": (this.muted ? PAINT.muted : PAINT.full).width,
          "line-opacity": (this.muted ? PAINT.muted : PAINT.full).line,
        },
      },
      bandBefore(this.map, "zones"),
    );
    this.layersAdded = true;
    this.applyFilters();
  }

  /** The visible kinds, as one filter per layer. An empty set has to produce a
   *  filter that matches NOTHING — `["in", field]` with no values is an error
   *  in some MapLibre versions and a match-everything in others, so the empty
   *  case is written explicitly. */
  private applyFilters(): void {
    const kinds: string[] = [];
    for (const [name, spec] of Object.entries(ZONE_GROUPS)) {
      if (this.visible[name as ZoneGroup]) kinds.push(...spec.kinds);
    }
    const filter = kinds.length
      ? (["in", ["get", "zone_kind"], ["literal", kinds]] as unknown)
      : (["==", ["literal", 1], ["literal", 0]] as unknown);
    this.map.setFilter(`${SRC}-fill`, filter as never);
    this.map.setFilter(`${SRC}-line`, filter as never);
  }

  private applyPaint(): void {
    const p = this.muted ? PAINT.muted : PAINT.full;
    this.map.setPaintProperty(`${SRC}-fill`, "fill-opacity", p.fill);
    this.map.setPaintProperty(`${SRC}-line`, "line-opacity", p.line);
    this.map.setPaintProperty(`${SRC}-line`, "line-width", p.width);
  }
}
