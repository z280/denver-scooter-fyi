// The Local Data tab: the rides this device recorded, and what the rider can
// do with them.
//
// Waypoints never leave the device unless the rider donates them, so this is
// the only place a track can be looked at or deleted. That makes delete a
// first-class control here, not a nicety — for a private ride there is no
// server copy to fall back on, and no other screen that can remove it.
//
// The track store is INJECTED, never opened here: openTrackStore() falls back
// to a fresh in-memory adapter when IndexedDB is unavailable, so a second
// caller would quietly read an empty store and report that the rider has no
// rides. ride-post-s10.ts carries the same warning for the same reason.

import { donateTrack as defaultDonateTrack } from "./api.ts";
import { distanceMeters } from "./locate.ts";
import {
  decodeTrackBatch,
  TRACK_FALLBACK_WARNING,
  type StoredTrackBatch,
  type StoredTrackRide,
  type TrackStore,
} from "./track-store.ts";
import {
  DONATION_DISCLOSURE_TEXT,
  describeDonateError,
  isAlreadyDonatedError,
} from "./ride-post-s10.ts";
import type { TrackRouteHandle } from "./track-route.ts";

/** A track flattened back into something drawable. */
export interface TrackPath {
  /** GeoJSON order: [lng, lat]. */
  coords: [number, number][];
  /** Epoch ms per coordinate, parallel to `coords`. */
  times: number[];
  meters: number;
  /** Batches whose payload would not decode. Reported, never thrown: one bad
   *  batch should cost the rider that segment, not the whole ride. */
  skippedBatches: number;
}

export interface LocalTrackSummary {
  trackId: string;
  rideId: string | null;
  private: boolean;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  waypointCount: number;
  batchCount: number;
  /** Only a server ride with sealed batches can be donated: a private ride is
   *  signed with a client-random key the server has never seen. */
  donatable: boolean;
}

export interface LocalDataDeps {
  /** main.ts's lazy singleton. See the note at the top of this file. */
  getTrackStore(): Promise<TrackStore>;
  route?: TrackRouteHandle;
  donateTrack?: typeof defaultDonateTrack;
  isSignedIn(): boolean;
  confirm?(message: string): boolean;
  now?(): number;
  /** Injected for tests; defaults to a Blob + anchor-click download. */
  download?(filename: string, text: string): void;
}

export interface LocalDataHandle {
  /** Re-read the store and repaint. Called when the tab is shown. */
  refresh(): Promise<void>;
  /** Drop any drawn route (tab switch, drawer close, sign-out). */
  clearSelection(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Rebuild a ride's path from its sealed batches. Each batch carries points
 *  as [dt_ms, lat, lon, acc] relative to its own t0, so timestamps come back
 *  as t0 + dt and coordinates get flipped into GeoJSON order. */
export function flattenTrackBatches(
  batches: readonly StoredTrackBatch[],
): TrackPath {
  const coords: [number, number][] = [];
  const times: number[] = [];
  let skippedBatches = 0;
  let meters = 0;
  let prev: { lat: number; lng: number } | null = null;

  const ordered = [...batches].sort((a, b) => a.seq - b.seq);
  for (const batch of ordered) {
    let payload;
    try {
      payload = decodeTrackBatch(batch.jws);
    } catch {
      skippedBatches += 1;
      continue;
    }
    for (const [dt, lat, lon] of payload.pts) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      coords.push([lon, lat]);
      times.push(payload.t0 + dt);
      const here = { lat, lng: lon };
      if (prev) meters += distanceMeters(prev, here);
      prev = here;
    }
  }
  return { coords, times, meters, skippedBatches };
}

export function summarizeRide(ride: StoredTrackRide): LocalTrackSummary {
  const endedAtMs = ride.lastPointMs;
  return {
    trackId: ride.trackId,
    rideId: ride.rideId,
    private: ride.private,
    startedAtMs: ride.createdAtMs,
    endedAtMs,
    durationMs:
      endedAtMs != null && endedAtMs > ride.createdAtMs
        ? endedAtMs - ride.createdAtMs
        : null,
    waypointCount: ride.waypointCount,
    batchCount: ride.batchCount,
    donatable: !ride.private && ride.rideId != null && ride.batchCount > 0,
  };
}

/** One ride as a GeoJSON FeatureCollection: a single LineString feature (a
 *  Point when only one waypoint survived — RFC 7946 requires two positions
 *  for a LineString) with the ride's metadata in `properties`.
 *
 *  Timestamps ride in `properties.coordinate_times`, one ISO string per
 *  coordinate, parallel to the geometry — RFC 7946 has no standard slot for
 *  per-vertex time, and parallel-array-in-properties is the convention GPX
 *  converters and geojson.io both understand. Coordinates are already in
 *  GeoJSON [lng, lat] order and 6-decimal precision from the store. */
export function trackToGeoJson(
  summary: LocalTrackSummary,
  path: TrackPath,
): Record<string, unknown> {
  const geometry =
    path.coords.length === 1
      ? { type: "Point", coordinates: path.coords[0] }
      : { type: "LineString", coordinates: path.coords };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry,
        properties: {
          name: `Scooter.fyi ride — ${formatWhen(summary.startedAtMs)}`,
          track_id: summary.trackId,
          ride_id: summary.rideId,
          private: summary.private,
          started_at: new Date(summary.startedAtMs).toISOString(),
          ended_at:
            summary.endedAtMs != null
              ? new Date(summary.endedAtMs).toISOString()
              : null,
          duration_ms: summary.durationMs,
          waypoint_count: path.coords.length,
          distance_meters: Math.round(path.meters),
          skipped_batches: path.skippedBatches,
          coordinate_times: path.times.map((t) => new Date(t).toISOString()),
        },
      },
    ],
  };
}

/** "scooter-fyi-ride-2026-08-08-1430.geojson" — start time, UTC, minute
 *  precision: sortable, filesystem-safe on every platform, and distinct for
 *  any two rides a rider can actually tell apart. */
export function geoJsonFilename(summary: LocalTrackSummary): string {
  const stamp = new Date(summary.startedAtMs)
    .toISOString()
    .slice(0, 16)
    .replace("T", "-")
    .replace(":", "");
  return `scooter-fyi-ride-${stamp}.geojson`;
}

/** Hand the rider a file the way every browser respects: an ephemeral
 *  object URL on a programmatic anchor click. The URL is revoked on a
 *  delay, not synchronously — revoking before the click settles cancels
 *  the download in some engines. */
function defaultDownload(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${Math.max(1, totalMin)} min`;
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function formatMiles(meters: number): string {
  return `${(meters / 1609.344).toFixed(1)} mi`;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

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

function statusLine(): {
  node: HTMLParagraphElement;
  set(msg: string, isError?: boolean): void;
  clear(): void;
} {
  const node = el("p", "account-magic-status");
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  return {
    node,
    set(msg, isError = false) {
      node.textContent = msg;
      node.classList.toggle("account-magic-status--error", isError);
    },
    clear() {
      this.set("");
    },
  };
}

/** A ride recorded within the last couple of minutes is probably still being
 *  written to — the drawer is hidden during a ride, so this is what a rider
 *  sees the moment one ends. */
const RECENT_MS = 2 * 60_000;

export function buildLocalDataPanel(
  host: HTMLElement,
  deps: LocalDataDeps,
): LocalDataHandle {
  const donate = deps.donateTrack ?? defaultDonateTrack;
  const confirmFn = deps.confirm ?? ((m: string) => window.confirm(m));
  const now = deps.now ?? (() => Date.now());

  let disposed = false;
  let selected: string | null = null;
  const abort = new AbortController();
  /** Tracks donated in this session, so the row can say so without a refetch. */
  const donated = new Set<string>();

  const intro = el(
    "p",
    "account-hint",
    "Rides this device recorded. They stay here — nothing is uploaded unless you donate it.",
  );
  const warning = el("p", "account-hint track-warning");
  warning.hidden = true;
  const list = el("ul", "track-list");
  const empty = el("p", "account-hint", "No rides recorded on this device yet.");
  empty.hidden = true;
  const panelStatus = statusLine();

  host.append(intro, warning, list, empty, panelStatus.node);

  const row = (
    store: TrackStore,
    summary: LocalTrackSummary,
  ): HTMLLIElement => {
    const li = el("li", "track-row");
    li.dataset.trackId = summary.trackId;
    if (selected === summary.trackId) li.classList.add("is-selected");

    const head = el("button", "track-row__head");
    head.type = "button";
    head.setAttribute("aria-pressed", String(selected === summary.trackId));
    head.append(el("span", "track-row__when", formatWhen(summary.startedAtMs)));

    // "waypoints", never "points": this app also has a rewards points
    // ledger, and "2 points" on a ride row reads as an award, not a track
    // length.
    const metaBits = [
      formatDuration(summary.durationMs),
      `${summary.waypointCount} waypoints`,
    ];
    const meta = el("span", "track-row__meta", metaBits.join(" · "));
    head.append(meta);

    const tags = el("div", "track-row__tags");
    const chip = (text: string, cls = ""): void => {
      tags.append(el("span", `chip ${cls}`.trim(), text));
    };
    if (summary.private) chip("Private", "chip--muted");
    if (donated.has(summary.trackId)) chip("Donated", "chip--good");
    if (summary.endedAtMs != null && now() - summary.endedAtMs < RECENT_MS) {
      chip("Just recorded", "chip--muted");
    }
    if (tags.childElementCount > 0) head.append(tags);

    const actions = el("div", "track-row__actions");
    const rowStatus = statusLine();

    // ----- show on map
    head.addEventListener("click", () => {
      if (selected === summary.trackId) {
        selected = null;
        deps.route?.clear();
        li.classList.remove("is-selected");
        head.setAttribute("aria-pressed", "false");
        return;
      }
      selected = summary.trackId;
      for (const other of list.querySelectorAll(".track-row")) {
        other.classList.toggle(
          "is-selected",
          (other as HTMLElement).dataset.trackId === summary.trackId,
        );
        other
          .querySelector(".track-row__head")
          ?.setAttribute(
            "aria-pressed",
            String((other as HTMLElement).dataset.trackId === summary.trackId),
          );
      }
      rowStatus.set("Drawing…");
      void store.storage
        .getBatches(summary.trackId)
        .then((batches) => {
          if (disposed || selected !== summary.trackId) return;
          const path = flattenTrackBatches(batches);
          if (path.coords.length === 0) {
            rowStatus.set("No waypoints were recorded for this ride.", true);
            deps.route?.clear();
            return;
          }
          deps.route?.show(path.coords);
          // Distance costs a full decode, so it is only known now — fill it
          // in rather than making every row pay for it on load.
          meta.textContent = `${metaBits.join(" · ")} · ${formatMiles(path.meters)}`;
          rowStatus.set(
            path.skippedBatches > 0
              ? `Showing on the map — ${path.skippedBatches} damaged segment(s) skipped.`
              : "Showing on the map.",
            path.skippedBatches > 0,
          );
        })
        .catch(() => {
          if (!disposed) rowStatus.set("Couldn't read this ride.", true);
        });
    });

    // ----- donate
    if (summary.donatable && deps.isSignedIn() && !donated.has(summary.trackId)) {
      const donateBtn = el("button", "text-btn", "Donate");
      donateBtn.type = "button";
      const consent = el("div", "track-row__consent");
      consent.hidden = true;
      consent.append(el("p", "account-hint", DONATION_DISCLOSURE_TEXT));
      const confirmBtn = el("button", "login-btn", "Donate this ride");
      confirmBtn.type = "button";
      const cancelBtn = el("button", "text-btn", "Cancel");
      cancelBtn.type = "button";
      const consentRow = el("div", "track-row__actions");
      consentRow.append(confirmBtn, cancelBtn);
      consent.append(consentRow);

      donateBtn.addEventListener("click", () => {
        consent.hidden = !consent.hidden;
      });
      cancelBtn.addEventListener("click", () => {
        consent.hidden = true;
      });
      confirmBtn.addEventListener("click", () => {
        const rideId = summary.rideId;
        if (!rideId || confirmBtn.disabled) return;
        confirmBtn.disabled = true;
        rowStatus.set("Uploading…");
        void store.storage
          .getBatches(summary.trackId)
          .then((batches) => {
            return donate(
              rideId,
              { batches: batches.map((b) => b.jws) },
              abort.signal,
            );
          })
          .then(() => {
            if (disposed) return;
            donated.add(summary.trackId);
            rowStatus.set("Donated — thank you.");
            consent.hidden = true;
            donateBtn.remove();
            consent.remove();
            chip("Donated", "chip--good");
            if (!head.contains(tags)) head.append(tags);
          })
          .catch((e: unknown) => {
            if (disposed) return;
            if (isAlreadyDonatedError(e)) {
              // Already up there: the outcome the rider wanted, not an error.
              donated.add(summary.trackId);
              rowStatus.set("Already donated.");
              consent.hidden = true;
              donateBtn.remove();
              consent.remove();
              return;
            }
            confirmBtn.disabled = false;
            rowStatus.set(describeDonateError(e), true);
          });
      });

      actions.append(donateBtn);
      li.append(head, actions, consent, rowStatus.node);
    } else {
      li.append(head, actions, rowStatus.node);
      if (summary.private) {
        actions.append(
          el(
            "span",
            "track-row__note",
            "Private ride — stays on this device.",
          ),
        );
      }
    }

    // ----- export
    // Same decode path as "show on map" (flattenTrackBatches), same
    // damaged-segment tolerance: one bad batch costs the rider that
    // segment, and the export says so rather than failing the file.
    const exportBtn = el("button", "text-btn track-row__export", "Export GeoJSON");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", () => {
      if (exportBtn.disabled) return;
      exportBtn.disabled = true;
      rowStatus.set("Exporting…");
      void store.storage
        .getBatches(summary.trackId)
        .then((batches) => {
          if (disposed) return;
          const path = flattenTrackBatches(batches);
          if (path.coords.length === 0) {
            rowStatus.set("No waypoints were recorded for this ride.", true);
            return;
          }
          const text = JSON.stringify(trackToGeoJson(summary, path), null, 2);
          (deps.download ?? defaultDownload)(geoJsonFilename(summary), text);
          rowStatus.set(
            path.skippedBatches > 0
              ? `Exported — ${path.skippedBatches} damaged segment(s) skipped.`
              : "Exported.",
            path.skippedBatches > 0,
          );
        })
        .catch(() => {
          if (!disposed) rowStatus.set("Couldn't read this ride.", true);
        })
        .then(() => {
          if (!disposed) exportBtn.disabled = false;
        });
    });
    actions.append(exportBtn);

    // ----- delete
    const deleteBtn = el("button", "text-btn track-row__delete", "Delete");
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => {
      if (
        !confirmFn(
          "Delete this ride from this device? This can't be undone.",
        )
      ) {
        return;
      }
      deleteBtn.disabled = true;
      rowStatus.set("Deleting…");
      void store
        .deleteRide(summary.trackId)
        .then(() => {
          if (disposed) return;
          if (selected === summary.trackId) {
            selected = null;
            deps.route?.clear();
          }
          return refresh();
        })
        .catch(() => {
          if (disposed) return;
          deleteBtn.disabled = false;
          rowStatus.set("Couldn't delete this ride.", true);
        });
    });
    actions.append(deleteBtn);

    return li;
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    panelStatus.set("Loading…");
    try {
      const store = await deps.getTrackStore();
      if (disposed) return;
      // Reads only: listRides and getBatches never write, unlike resumeRide,
      // which can wipe a chain whose nonce no longer matches.
      const rides = await store.storage.listRides();
      if (disposed) return;

      warning.hidden = store.durable;
      if (!store.durable) warning.textContent = TRACK_FALLBACK_WARNING;

      const summaries = rides
        .map(summarizeRide)
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      list.replaceChildren(...summaries.map((s) => row(store, s)));
      empty.hidden = summaries.length > 0;
      panelStatus.clear();
    } catch {
      if (disposed) return;
      panelStatus.set("Couldn't read this device's rides.", true);
    }
  };

  return {
    refresh,
    clearSelection() {
      selected = null;
      deps.route?.clear();
      for (const r of list.querySelectorAll(".track-row")) {
        r.classList.remove("is-selected");
        r.querySelector(".track-row__head")?.setAttribute("aria-pressed", "false");
      }
    },
    dispose() {
      disposed = true;
      abort.abort();
      deps.route?.clear();
    },
  };
}
