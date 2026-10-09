// The popup's facts strip: battery, and how far that battery goes.
//
// TWO RANGE FIGURES ARRIVE ON EVERY DEVICE, and for a long time the card showed
// the wrong one. `current_range_meters` is Veo's own estimate, passed straight
// through from their feed. `estimated_range_meters` is ours: battery % × 364 m
// (scooter-fyi-api `src/battery_model.py`, `usable_range_meters`), measured by
// following 220 Denver vehicles from ≥95% to ≤5% charge and summing the routed
// distance of every rental in between. Median 36.4 km per full charge, against
// a 67 km rating. It counts standby drain, so it is deliberately conservative;
// live, it runs about 0.8× Veo's figure.
//
// OURS IS THE HEADLINE because it is the one measured on these streets. Veo's
// stays on the card, quietly, underneath: a rider who has just seen 43 km in
// the Veo app deserves to know why we said 34, and the comparison is the whole
// argument for this app having its own number.
//
// WHEN OURS IS MISSING, Veo's goes in the headline, LABELLED as Veo's. A bare
// figure would be read as ours, and ours is the claim the About drawer makes.
//
// Kept out of devices.ts so it can be rendered and asserted on directly,
// rather than pinned by matching that file's source text.

/** Metres of real riding per percentage point of charge. Mirrors the API's
 *  `OBSERVED_METERS_PER_SOC_POINT`; the API computes `estimated_range_meters`
 *  from it, so this copy is for the About drawer's sentence and the tests, not
 *  for re-deriving the figure client-side. */
export const OBSERVED_METERS_PER_SOC_POINT = 364;

/** The API marks a reading "stale" once the vehicle has been parked this long
 *  (`STALE_READING_SECONDS = TRAIN_MAX_PARKED_SECONDS = 3600`, `>=`): past an
 *  hour parked, the reported charge may have stopped moving. The hint's
 *  wording ("parked 1 h+") is this number, so change both together. */
export const STALE_READING_SECONDS = 3600;

export const STALE_HINT = "Parked 1 h+: charge may be out of date.";
export const OURS_EXPLAINER = "Ours is measured full-to-empty in Denver.";

export interface FactsStripInput {
  batteryPercent: number | null;
  /** `estimated_range_meters` — ours. */
  ourRangeMeters: number | null;
  /** `current_range_meters` — Veo's. */
  veoRangeMeters: number | null;
  /** `battery_reading`: "fresh" | "stale" | "unknown", or absent on old payloads. */
  batteryReading: string | null | undefined;
  deviceId: string;
  coords: [number, number];
  /** Whether this device's range circle is on the map right now. */
  showing: boolean;
}

/** Metres → "34 km", or "1.8 km" under 10 km where the decimal still matters
 *  to somebody deciding whether to bother. */
export function formatKm(meters: number): string {
  const tenths = Math.round(meters / 100) / 10;
  return tenths < 10 ? `${tenths.toFixed(1)} km` : `${Math.round(meters / 1000)} km`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const usable = (m: number | null): m is number => m !== null && Number.isFinite(m) && m >= 0;

/** The metres the "Show on map" circle should be drawn at: ours when we have
 *  it, Veo's otherwise, null when neither. The circle is the headline figure
 *  drawn on the map, so it must be the same number as the headline. */
export function headlineRangeMeters(
  ours: number | null,
  veo: number | null,
): number | null {
  if (usable(ours)) return ours;
  if (usable(veo)) return veo;
  return null;
}

/** The whole strip's HTML, or "" when the feed told us neither battery nor
 *  range — not an empty bar announcing that we know nothing. */
export function renderFactsStrip(input: FactsStripInput): string {
  const { batteryPercent, deviceId, coords, showing } = input;
  const ours = usable(input.ourRangeMeters) ? input.ourRangeMeters : null;
  const veo = usable(input.veoRangeMeters) ? input.veoRangeMeters : null;
  const radius = headlineRangeMeters(ours, veo);

  const facts: string[] = [];
  if (batteryPercent !== null) {
    facts.push(
      `<span class="device-popup__fact">${batteryPercent < 25 ? "🪫" : "🔋"} ${batteryPercent}%</span>`,
    );
  }
  if (radius !== null) {
    const label =
      ours !== null
        ? `~${formatKm(ours)} real-world`
        : `~${formatKm(radius)} <span class="device-popup__fact-qual">(Veo's estimate)</span>`;
    facts.push(
      `<span class="device-popup__fact">${label}</span>` +
        `<button
           type="button"
           class="device-popup__action device-popup__action--inline"
           data-action="toggle-range"
           data-device="${escapeHtml(deviceId)}"
           data-lng="${coords[0]}"
           data-lat="${coords[1]}"
           data-radius="${radius}"
         >${showing ? "Hide on map" : "Show on map"}</button>`,
    );
  }
  if (facts.length === 0) return "";

  // The muted line. Only says what is true of the figures actually shown.
  const note: string[] = [];
  if (ours !== null) {
    note.push(veo !== null ? `Veo estimates ${formatKm(veo)}.` : "", OURS_EXPLAINER);
  }
  if (radius !== null && input.batteryReading === "stale") note.push(STALE_HINT);
  const noteText = note.filter(Boolean).join(" ");
  const noteHtml = noteText
    ? `<p class="device-popup__range-note">${escapeHtml(noteText)}</p>`
    : "";

  return `<div class="device-popup__facts">${facts.join(
    `<span class="device-popup__fact-sep" aria-hidden="true">·</span>`,
  )}${noteHtml}</div>`;
}
