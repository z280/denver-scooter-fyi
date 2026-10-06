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
import { FIRST_DEVICE_LAYER } from "./devices.ts";

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

export class MicromobilityZones {
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
  ) {}

  isVisible(group: ZoneGroup): boolean {
    return this.visible[group];
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Show or hide one group. Safe before the geometry has loaded — it awaits
   *  the fetch, like the equity overlay's own setter. */
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
      FIRST_DEVICE_LAYER,
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
      FIRST_DEVICE_LAYER,
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

  /** Draw whatever the defaults say, once. Called at wire time; never awaited
   *  by the caller, because a boundary overlay has no business holding up the
   *  rest of the map's startup. */
  async start(): Promise<void> {
    await this.ensureLayers();
  }
}
