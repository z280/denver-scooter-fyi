// "Your dibs & watches" — the top of the Tools drawer.
//
// ONE LIST, NOT TWO. This used to be two sections, My dibs above Watched
// scooters, and most of the second was a copy of the first: claiming a
// scooter arms a watch on it, so a rider holding two claims saw each scooter
// twice, under two headings, with two different sets of buttons. The owner's
// ask (2026-10-09) was to show every dib and every watch in one clear place,
// so this is one row per SCOOTER:
//
//   ✋ a dib — the same hand the popup, the toasts and the dibs sheets use.
//      Tapping it opens the certificate, because the certificate is what a
//      claim is for. Its clock is the claim's (`countdownFor`), and if the
//      claim also carries a watch the row says so rather than repeating it.
//   🔔 a watch with no claim under it — from the end of a ride, or added by an
//      admin. The bell is `showMovedToast`'s glyph, the alert this row is
//      waiting to send. Tapping it centres the map on the scooter, which is
//      what the list's Show button did.
//
// Release and Stop stay, one per row. Releasing a dib also stops the watch
// that rode in with it: `device-notify.ts` says a watch dies with the
// connection it rests on, and a released claim is no connection at all.
//
// ADMIN: ADD BY PLATE. A session the server calls an admin gets a plate field
// (`setAdmin`), built into a host the ⚙ Admin drawer owns (`admin-drawer.ts`)
// — the rows it adds land in this list. It is BUILT only for an admin rather than
// hidden from everybody else, so an ordinary rider's DOM never carries it.
// The watch it makes is client-side like every other, so UI gating is all the
// gating there is — `device-notify.ts`'s header has the argument and the
// rule (`WATCH_RULES.admin`).
//
// THE CLOCKS TICK WITHOUT REBUILDING. The old list re-rendered every second,
// which threw away keyboard focus on its own buttons once a second. Rows are
// rebuilt only when the set of rows changes; the tick updates text in place.

import { ApiError, NoDataError, resolveVehiclePlate } from "./api.ts";
import {
  WATCH_RULES,
  isWatched,
  loadWatches,
  unwatchMoved,
  watchMoved,
  watchSlotsLeft,
  type WatchOrigin,
  type WatchedDevice,
} from "./device-notify.ts";
import { dropDibs, loadDibs, type Dibs } from "./dibs.ts";
import { distanceMeters, formatWalk, type LngLat } from "./locate.ts";
import { countdownFor, formatCountdown } from "./my-dibs.ts";
import { MAX_PLATE_LEN, normalizePlate } from "./plates.ts";
import { track } from "./telemetry.ts";

/** The two row icons. Exported so tests assert the glyph rather than restate
 *  it, and so nothing else in the drawer invents a third. */
export const DIBS_ICON = "✋";
export const WATCH_ICON = "🔔";

const TICK_MS = 1_000;

/** What a scooter in the live feed looks like to the add-by-plate form. */
export interface FoundVehicle {
  name: string;
  lat: number;
  lon: number;
}

export type PlateLookup =
  | { kind: "hit"; vehicleIdentifier: string }
  /** 404 — the API does not distinguish "nobody has this plate" from "more
   *  than one vehicle does", so neither can we. */
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "rate_limited"; retryAfter: number | null }
  | { kind: "error" };

/** `GET /api/v1/vehicles/resolve`, classified. Never rejects. Not the cached
 *  `plates.ts` resolver: that one remembers a miss for two minutes, which is
 *  right for a scan and wrong for an admin retyping a plate they mistyped. */
export async function lookupPlate(
  plate: string,
  resolve: (p: string) => Promise<{ vehicle_identifier: string }> = resolveVehiclePlate,
): Promise<PlateLookup> {
  try {
    const res = await resolve(plate);
    const vid = String(res?.vehicle_identifier ?? "").toLowerCase();
    return /^[0-9a-f]{16}$/.test(vid)
      ? { kind: "hit", vehicleIdentifier: vid }
      : { kind: "not_found" };
  } catch (e) {
    if (e instanceof NoDataError && e.status === 404) return { kind: "not_found" };
    if (e instanceof ApiError && (e.status === 400 || e.status === 422)) {
      return { kind: "invalid" };
    }
    if (e instanceof ApiError && e.status === 429) {
      return { kind: "rate_limited", retryAfter: e.retryAfter ?? null };
    }
    return { kind: "error" };
  }
}

export interface ToolsMineDeps {
  section: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  /** Where the admin form is built. Empty and hidden for everybody else. */
  adminHost: HTMLElement;
  locate: { current(): LngLat | null };
  onOpenCertificate(d: Dibs): void;
  onShowOnMap(w: WatchedDevice): void;
  /** A dib was released — the map has to un-dim it. */
  onDibsChanged?(): void;
  /** A watch was added or stopped — the notifier's per-vehicle bookkeeping
   *  and any open popup need to hear about it. */
  onWatchStopped?(vehicleIdentifier: string): void;
  onWatchAdded?(vehicleIdentifier: string): void;
  /** Look a resolved scooter up in the live feed. Null when it is not there. */
  findVehicle(vehicleIdentifier: string, plate: string): FoundVehicle | null;
  /** Injected for tests. */
  now?(): number;
  readDibs?(now: number): Dibs[];
  releaseDibs?(vehicleIdentifier: string, now: number): void;
  readWatches?(now: number): WatchedDevice[];
  stopWatch?(vehicleIdentifier: string): void;
  addWatch?(w: WatchedDevice): void;
  lookup?(plate: string): Promise<PlateLookup>;
}

export interface ToolsMineHandle {
  refresh(): void;
  /** Build (true) or tear down (false) the admin add-by-plate form. */
  setAdmin(on: boolean): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** "1 h 52 min", "38 min", "under a minute" — for a watch, whose clock runs in
 *  hours and is glanced at, not raced. */
export function formatWatchLeft(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return "under a minute";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Why this scooter is being watched, in the rider's words. */
export function watchOriginLabel(origin: WatchOrigin): string {
  switch (origin) {
    case "dibs":
      return "From your dibs";
    case "ride_end":
      return "Your last ride";
    case "admin":
      return "Admin watch";
  }
}

type Row =
  | { kind: "dibs"; dibs: Dibs; watch: WatchedDevice | null }
  | { kind: "watch"; watch: WatchedDevice };

/** One row per scooter: every held claim (soonest-expiring first, the order
 *  `loadDibs` keeps), then every watch that is not already on a claim's row,
 *  soonest-expiring first. Pure, so the merge is testable on its own. */
export function buildRows(
  dibs: readonly Dibs[],
  watches: readonly WatchedDevice[],
): Row[] {
  const byVid = new Map(watches.map((w) => [w.vehicleIdentifier, w]));
  const rows: Row[] = dibs.map((d) => ({
    kind: "dibs",
    dibs: d,
    watch: byVid.get(d.vehicleIdentifier) ?? null,
  }));
  const claimed = new Set(dibs.map((d) => d.vehicleIdentifier));
  const loose = watches
    .filter((w) => !claimed.has(w.vehicleIdentifier))
    .sort((a, b) => a.expiresAt - b.expiresAt);
  for (const w of loose) rows.push({ kind: "watch", watch: w });
  return rows;
}

export function wireToolsMine(deps: ToolsMineDeps): ToolsMineHandle {
  const now = deps.now ?? (() => Date.now());
  const readDibs = deps.readDibs ?? ((t: number) => loadDibs(t));
  const releaseDibs = deps.releaseDibs ?? ((vid: string, t: number) => void dropDibs(vid, t));
  const readWatches = deps.readWatches ?? ((t: number) => loadWatches(t));
  const stopWatch = deps.stopWatch ?? ((vid: string) => void unwatchMoved(vid));
  const addWatch = deps.addWatch ?? ((w: WatchedDevice) => void watchMoved(w));
  const lookup = deps.lookup ?? ((p: string) => lookupPlate(p));

  let destroyed = false;
  let timer: number | null = null;
  /** The ids the rows were built for; a change means rebuild, not retick. */
  let signature = "";
  let tickers: (() => void)[] = [];

  function setStatus(text: string | null): void {
    deps.status.hidden = !text;
    deps.status.textContent = text ?? "";
  }

  function sigOf(rows: Row[]): string {
    return rows
      .map((r) =>
        r.kind === "dibs"
          ? `d:${r.dibs.vehicleIdentifier}:${r.dibs.startedWalkingAt ?? ""}:${r.watch ? 1 : 0}`
          : `w:${r.watch.vehicleIdentifier}`,
      )
      .join("|");
  }

  function dibsRow(d: Dibs, watch: WatchedDevice | null): HTMLLIElement {
    const li = el("li", "tools-mine__row tools-mine__row--dibs");
    li.dataset.kind = "dibs";
    li.dataset.vid = d.vehicleIdentifier;

    const open = el("button", "tools-mine__open");
    open.type = "button";
    open.setAttribute("aria-label", `Open the certificate for ${d.vehicleName}`);
    open.append(el("span", "tools-mine__icon", DIBS_ICON));
    const text = el("span", "tools-mine__text");
    text.append(el("span", "tools-mine__name", d.vehicleName));
    const clock = el("span", "tools-mine__clock");
    clock.setAttribute("role", "timer");
    const state = el("span", "tools-mine__state");
    text.append(clock, state);
    open.append(text);
    // `openDibsCertificate` counts the showing itself; no second event here.
    open.addEventListener("click", () => deps.onOpenCertificate(d));
    li.append(open);

    const release = el("button", "tools-mine__act", "Release");
    release.type = "button";
    release.setAttribute("aria-label", `Release dibs on ${d.vehicleName}`);
    release.addEventListener("click", () => {
      // No confirm: releasing gives a scooter back to everybody else, and the
      // app should not put a speed bump in front of the generous action.
      releaseDibs(d.vehicleIdentifier, now());
      track("dibs", { action: "released_from_list" });
      // The watch that came with the claim goes with it. A watch from a ride or
      // an admin is a different connection and is left alone.
      if (watch && watch.origin === "dibs") {
        stopWatch(watch.vehicleIdentifier);
        deps.onWatchStopped?.(watch.vehicleIdentifier);
      }
      render(true);
      deps.onDibsChanged?.();
    });
    li.append(release);

    const tick = (): void => {
      const { ms, label, urgent } = countdownFor(d, now());
      clock.textContent = `${formatCountdown(ms)} ${label}`;
      clock.classList.toggle("is-urgent", urgent);
      const parts = [d.startedWalkingAt === null ? "Not set off yet" : "On your way"];
      if (watch) parts.push("watching for moves");
      state.textContent = parts.join(" · ");
    };
    tick();
    tickers.push(tick);
    return li;
  }

  function watchRow(w: WatchedDevice): HTMLLIElement {
    const li = el("li", "tools-mine__row tools-mine__row--watch");
    li.dataset.kind = "watch";
    li.dataset.vid = w.vehicleIdentifier;

    const open = el("button", "tools-mine__open");
    open.type = "button";
    open.setAttribute("aria-label", `Show ${w.name} on the map`);
    open.append(el("span", "tools-mine__icon", WATCH_ICON));
    const text = el("span", "tools-mine__text");
    text.append(el("span", "tools-mine__name", w.name));
    const clock = el("span", "tools-mine__clock");
    const state = el("span", "tools-mine__state");
    text.append(clock, state);
    open.append(text);
    open.addEventListener("click", () => deps.onShowOnMap(w));
    li.append(open);

    const stop = el("button", "tools-mine__act", "Stop");
    stop.type = "button";
    stop.setAttribute("aria-label", `Stop watching ${w.name}`);
    stop.addEventListener("click", () => {
      track("device_notify_moved", { action: "off" });
      stopWatch(w.vehicleIdentifier);
      deps.onWatchStopped?.(w.vehicleIdentifier);
      render(true);
    });
    li.append(stop);

    const tick = (): void => {
      clock.textContent = `${formatWatchLeft(w.expiresAt - now())} left`;
      const parts = [watchOriginLabel(w.origin)];
      // Distance is a convenience for somebody holding the phone; the alert
      // itself never carries a location (device-notify.ts).
      const here = deps.locate.current();
      if (here) parts.push(formatWalk(distanceMeters(here, { lng: w.lon, lat: w.lat })));
      state.textContent = parts.join(" · ");
    };
    tick();
    tickers.push(tick);
    return li;
  }

  function render(force = false): void {
    if (destroyed) return;
    const t = now();
    const watches = readWatches(t);
    const rows = buildRows(readDibs(t), watches);
    const sig = sigOf(rows);
    if (!force && sig === signature && deps.list.childElementCount > 0) {
      for (const tick of tickers) tick();
      return;
    }
    signature = sig;
    tickers = [];
    deps.section.hidden = false;
    deps.list.replaceChildren();

    if (rows.length === 0) {
      deps.list.append(el("li", "tools-mine__empty", "No dibs or watches right now."));
      setStatus(null);
      return;
    }
    for (const r of rows) {
      deps.list.append(r.kind === "dibs" ? dibsRow(r.dibs, r.watch) : watchRow(r.watch));
    }
    setStatus(
      watches.length > 0
        ? "We'll tell you if a watched scooter moves, while the app is open."
        : null,
    );
  }

  // ---------------------------------------------------------------------
  // Admin: add a scooter to watches by plate
  // ---------------------------------------------------------------------

  let adminOn = false;

  function buildAdminForm(): void {
    const host = deps.adminHost;
    host.replaceChildren();
    host.hidden = false;

    const form = el("form", "tools-mine__admin");
    form.id = "tools-admin-watch";
    form.noValidate = true;
    const label = el("label", "tools-mine__admin-label", "Plate number");
    label.htmlFor = "tools-admin-watch-plate";

    const row = el("div", "tools-mine__admin-row");
    const input = el("input", "tools-mine__admin-input");
    input.id = "tools-admin-watch-plate";
    input.type = "text";
    input.inputMode = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = MAX_PLATE_LEN;
    input.placeholder = "e.g. 1234567";
    const add = el("button", "tools-mine__admin-add", "Add");
    add.type = "submit";
    row.append(input, add);

    const hint = el(
      "p",
      "tools-mine__admin-hint",
      `Up to ${WATCH_RULES.admin.max} at once, each for ${formatWatchLeft(WATCH_RULES.admin.ttlMs)}.`,
    );
    const status = el("p", "tools-mine__admin-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const say = (text: string, isError = false): void => {
      status.textContent = text;
      status.classList.toggle("is-error", isError);
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void (async () => {
        const plate = normalizePlate(input.value);
        if (!plate) {
          say("Type a plate number.", true);
          input.focus();
          return;
        }
        if (plate.length > MAX_PLATE_LEN) {
          say(`Plates are at most ${MAX_PLATE_LEN} characters.`, true);
          return;
        }
        add.disabled = true;
        say(`Looking up ${plate}…`);
        try {
          const res = await lookup(plate);
          if (!adminOn || destroyed) return;
          switch (res.kind) {
            case "not_found":
              say(
                `No scooter on the map has plate ${plate}, or more than one does. Check the number and try again.`,
                true,
              );
              return;
            case "invalid":
              say(`${plate} doesn't look like a plate number.`, true);
              return;
            case "rate_limited":
              say(
                `Too many lookups — try again in ${res.retryAfter ?? 60} seconds.`,
                true,
              );
              return;
            case "error":
              say("Couldn't reach the server. Try again in a moment.", true);
              return;
            case "hit":
              break;
          }
          const vid = res.vehicleIdentifier;
          const found = deps.findVehicle(vid, plate);
          if (!found) {
            say(
              `Plate ${plate} is a scooter, but it isn't on this map right now. Wait for the next refresh and try again.`,
              true,
            );
            return;
          }
          const t = now();
          const existing = readWatches(t);
          if (isWatched(existing, vid)) {
            say(`Already watching ${found.name}.`);
            return;
          }
          const full = watchSlotsLeft(existing, "admin", t) <= 0;
          const oldest = full
            ? existing
                .filter((w) => w.origin === "admin")
                .sort((a, b) => a.since - b.since)[0]
            : undefined;
          addWatch({
            vehicleIdentifier: vid,
            name: found.name,
            lat: found.lat,
            lon: found.lon,
            since: t,
            origin: "admin",
            expiresAt: t + WATCH_RULES.admin.ttlMs,
          });
          track("device_notify_moved", { action: "on", origin: "admin" });
          deps.onWatchAdded?.(vid);
          input.value = "";
          say(
            `Watching ${found.name} for ${formatWatchLeft(WATCH_RULES.admin.ttlMs)} — it's in Tools.` +
              (oldest ? ` Stopped ${oldest.name} to stay at ${WATCH_RULES.admin.max}.` : ""),
          );
          render(true);
        } finally {
          add.disabled = false;
        }
      })();
    });

    form.append(label, row, hint, status);
    host.append(form);
  }

  render(true);
  timer = window.setInterval(() => render(), TICK_MS);

  return {
    refresh: () => render(true),
    setAdmin(on: boolean) {
      if (destroyed || on === adminOn) return;
      adminOn = on;
      if (on) buildAdminForm();
      else {
        deps.adminHost.replaceChildren();
        deps.adminHost.hidden = true;
      }
    },
    destroy() {
      destroyed = true;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      tickers = [];
      deps.list.replaceChildren();
      deps.adminHost.replaceChildren();
    },
  };
}
