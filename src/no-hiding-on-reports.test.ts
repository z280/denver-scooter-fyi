// @vitest-environment happy-dom
//
// NO REPORT EVER HIDES A SCOOTER (owner, 2026-10-09).
//
// "Persist and flag as high risk should be the only result of any report …
// all scooters with a negative report should be labeled as 'high risk', not
// hidden from the map." The API dropped its `suppressed` flag for exactly this
// reason, and its docs tell clients not to drop a vehicle from the map, the
// available set or a route plan on any report field.
//
// So this file holds the frontend to it, two ways:
//   1. statically — the report fields are read only by modules that LABEL,
//      and never on a line that filters, skips or excludes;
//   2. by behaviour — a reported scooter is in the map's visible set, the
//      recommendation list and the planner's output.
//
// What a rider's OWN reliability filter ("Nothing flagged high-risk") does is
// theirs to choose and is not a report hiding anything; it reads the tier, as
// it did before reports existed, and Identify names it as "your filters".
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => ({ default: { Popup: class {} } }));

import { Devices } from "./devices.ts";
import { rankDevices } from "./recommend.ts";
import { DEFAULT_BOUNDS, rankPlans } from "./along-the-way.ts";
import { RATE_PLANS } from "./config.ts";
import { defaultSpec } from "./ride-spec.ts";
import type { DeviceProperties, DevicesResponse } from "./api.ts";
import type { Map as MLMap } from "maplibre-gl";
import type { Locate } from "./locate.ts";
import { withoutComments } from "../tests/helpers/source-text.ts";

const SRC = join(process.cwd(), "src");
const FIELD = /has_negative_report|negative_report_|latest_report|needs_condition_check|reportRisk\(/;

/** Modules allowed to read the report fields, and what they do with them. */
const LABELLERS: Record<string, string> = {
  "api.ts": "wire types",
  "report-labels.ts": "turns the fields into words",
  "reliability.ts": "tier reasons and the verdict headline",
  "devices.ts": "verdict bar, last-report line, invite, map halo",
  "recommend.ts": "a warning on the list row",
  "plan-list.ts": "the plan's risk chip text",
  "device-features.ts": "whether to OFFER the condition check",
  "condition-check.ts": "condition-check wire types",
  "qr-identify.ts": "the identify card's sentences",
};

describe("statically: the report fields only ever label", () => {
  const files = readdirSync(SRC).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
  );

  it("are read only by labelling modules", () => {
    const readers = files.filter((f) =>
      FIELD.test(withoutComments(readFileSync(join(SRC, f), "utf8"))),
    );
    expect(readers.filter((f) => !(f in LABELLERS))).toEqual([]);
  });

  it("never sit on a line that filters, skips or excludes", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = withoutComments(readFileSync(join(SRC, f), "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (!FIELD.test(line)) return;
        if (/\.filter\(|\bcontinue\b|return false|\.splice\(|exclude|suppress/i.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("never reach the layers that draw the points themselves", () => {
    // The halo layer may read them (it IS the label); the point, cluster and
    // count layers must not, or a report could stop a dot being drawn.
    const src = readFileSync(join(SRC, "devices.ts"), "utf8");
    for (const layer of ["POINT_LAYER", "CLUSTER_LAYER", "COUNT_LAYER"]) {
      const at = src.indexOf(`id: ${layer},`);
      if (at === -1) continue;
      const block = src.slice(at, src.indexOf("});", at));
      expect(block, layer).not.toMatch(FIELD);
    }
  });

  it("no frontend code carries the retired suppression fields", () => {
    for (const f of files) {
      expect(readFileSync(join(SRC, f), "utf8"), f).not.toMatch(/suppressed_reason|suppressed_since|\bsuppressed\b\s*[?:]/);
    }
  });
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

const ORIGIN = { lat: 39.7392, lng: -104.9903 };
const M_LAT = 111_320;
const M_LNG = M_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const at = (east: number) => ({ lat: ORIGIN.lat, lng: ORIGIN.lng + east / M_LNG });

const REPORTS: Record<string, Partial<DeviceProperties>> = {
  high_risk_inaccessible: {
    has_negative_report: true,
    negative_report_risk: "high_risk",
    negative_report_reason: "inaccessible",
    needs_condition_check: true,
    latest_report: { report_type: "inaccessible", reason: null, observed_at: null, reported_at: null, anonymous: false },
    reliability_tier: "high_risk",
  },
  high_risk_flat: {
    has_negative_report: true,
    negative_report_risk: "high_risk",
    negative_report_reason: "not_rideable",
    negative_report_reason_detail: "flat_tire",
    reliability_tier: "high_risk",
  },
  unknown_faded: {
    has_negative_report: false,
    negative_report_risk: "unknown",
    negative_report_reason: "not_found",
    reliability_tier: "unknown",
  },
};

function feature(
  id: string,
  east: number,
  over: Partial<DeviceProperties> = {},
): GeoJSON.Feature<GeoJSON.Point, DeviceProperties> {
  const pos = at(east);
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [pos.lng, pos.lat] },
    properties: {
      device_id: id,
      vehicle_identifier: id.padEnd(16, "0").slice(0, 16),
      form_factor: "scooter",
      spatial_status: "denver_core",
      vehicle_model_name: "Cosmo",
      battery_percent: 90,
      current_range_meters: 20_000,
      number_failed_starts: 0,
      first_observed_at_location: new Date(Date.now() - 3_600_000).toISOString(),
      quality_designation: "good",
      reliability_tier: "ok",
      ...over,
    } as DeviceProperties,
  };
}

const fleet = () => [
  feature("clean", 100),
  ...Object.entries(REPORTS).map(([id, r], i) => feature(id, 150 + i * 40, r)),
];

describe("by behaviour: a reported scooter stays everywhere", () => {
  it("is in the map's visible set under the default filters", () => {
    const devices = new Devices(
      {
        getSource: () => ({ setData: vi.fn() }),
        hasImage: () => true,
        addImage: () => {},
        easeTo: () => {},
        getZoom: () => 16,
      } as unknown as MLMap,
      { onFix: () => () => {}, current: () => null } as unknown as Locate,
    );
    const resp: DevicesResponse = {
      type: "FeatureCollection",
      metadata: { cycle_id: "c", snapshot_time: "2026-10-09T18:00:00Z", device_count: 4, filters: {} },
      features: fleet(),
    };
    devices.setData(resp);
    const ids = devices.visibleFeatures().map((f) => f.properties.device_id);
    for (const id of Object.keys(REPORTS)) expect(ids).toContain(id);
  });

  it("is in the recommendation list, carrying its reason", () => {
    const ranked = rankDevices(fleet(), {
      from: ORIGIN,
      priority: "distance",
      typeChoice: "any",
    } as never);
    const ids = ranked.map((r) => r.id);
    for (const id of Object.keys(REPORTS)) expect(ids).toContain(id);
    expect(ranked.find((r) => r.id === "high_risk_inaccessible")?.warnings).toContain(
      "reported inaccessible",
    );
  });

  it("can still be offered by the planner", () => {
    // Only reported scooters in reach: the planner must still offer one rather
    // than pretend the fleet is empty.
    const res = rankPlans(
      Object.entries(REPORTS).map(([id, r], i) => feature(id, 120 + i * 30, r)),
      {
        from: ORIGIN,
        to: { lat: at(4000).lat, lon: at(4000).lng },
        spec: defaultSpec(),
        rate: RATE_PLANS.find((p) => p.key === "resident")!,
        freeMinutesLeft: 0,
        bounds: DEFAULT_BOUNDS,
        taxRate: 0,
        now: Date.parse("2026-10-02T12:00:00Z"),
      },
    );
    const ridden = res.plans.flatMap((p) =>
      p.legs.filter((l) => l.mode === "ride").map((l) => l.vehicle?.device_id),
    );
    expect(ridden.some((id) => id && id in REPORTS)).toBe(true);
  });

  it("is ranked by the planner exactly as the same tier without a report", () => {
    // The report fields never enter candidacy: strip them and nothing moves.
    const ctx = {
      from: ORIGIN,
      to: { lat: at(4000).lat, lon: at(4000).lng },
      spec: defaultSpec(),
      rate: RATE_PLANS.find((p) => p.key === "resident")!,
      freeMinutesLeft: 0,
      bounds: DEFAULT_BOUNDS,
      taxRate: 0,
      now: Date.parse("2026-10-02T12:00:00Z"),
    };
    const strip = (f: GeoJSON.Feature<GeoJSON.Point, DeviceProperties>) => {
      const p = { ...f.properties };
      for (const k of Object.keys(p)) {
        if (FIELD.test(k)) delete (p as Record<string, unknown>)[k];
      }
      return { ...f, properties: p };
    };
    const shape = (r: ReturnType<typeof rankPlans>) =>
      r.plans.map((p) => p.legs.map((l) => `${l.mode}:${l.vehicle?.device_id ?? ""}`).join(">"));
    expect(shape(rankPlans(fleet(), ctx))).toEqual(shape(rankPlans(fleet().map(strip), ctx)));
  });
});
