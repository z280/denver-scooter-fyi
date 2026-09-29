// The Favorite Scooters panel — the Tools drawer list, and the one button that
// keeps a scooter.
//
// It renders; it decides nothing. Every judgement it shows comes from
// `my-scooters.ts` (`locationOf`, `favoriteTitle`, `keepErrorMessage`) or
// from the server, which is why that module is pure and this one is not
// tested for rules it does not hold.
//
// WHY IT LIVES IN TOOLS, beside My dibs. The two are the same shape — a
// short personal list of specific vehicles, only meaningful signed in — and a
// rider looking for "the scooters I keep" looks where "the claims I hold"
// already is. My dibs sits above it because dibs EXPIRE and favourites do
// not: everything in this section will still be here in ten minutes.
//
// THE TWO SERVER RULES ARE NOT REIMPLEMENTED HERE:
//
//   The gate. `keep()` hands the server the raw QR payload and the current
//   fix and renders whatever comes back. It does not check the distance, does
//   not parse the payload, and does not work out which scooter was scanned —
//   the identifier is a salted hash a browser cannot compute.
//
//   The withholding. Every row asks `locationOf` and renders exactly one of
//   its two shapes. There is no `lastKnownPosition` anywhere in this file,
//   and there must never be: a row that keeps showing where an in-use scooter
//   "was" is the whole rule undone, wearing a helpful face.

import {
  keepFavoriteDevice,
  listFavoriteDevices,
  forgetFavoriteDevice,
  updateFavoriteDevice,
  type FavoriteDevice,
} from "./api.ts";
import { isAuthenticated } from "./map-auth.js";
import { distanceMeters, formatWalk, type LngLat } from "./locate.ts";
import { openQrScanner } from "./qr-scan.ts";
import { track } from "./telemetry.ts";
import {
  KEEP_SIGNIN_HINT,
  STATE_LABEL,
  favoriteTitle,
  keepErrorMessage,
  locationOf,
} from "./my-scooters.ts";

export interface MyScootersDeps {
  /** The <section> to show/hide, the <ul> to fill, and the keep button. */
  section: HTMLElement;
  list: HTMLElement;
  keepButton: HTMLButtonElement;
  status: HTMLElement;
  /** Where the rider is, for the walk estimate and for the gate's fix. Null
   *  when location is off — keeping then fails with the server's own
   *  "you'll need to be standing at this one", which is the honest message. */
  locate: { current(): LngLat | null };
  /** Centre the map on one. Absent means the row is not clickable. */
  onShowOnMap?(f: FavoriteDevice): void;
  /** Injected for tests. */
  scan?: typeof openQrScanner;
  signedIn?(): boolean;
  api?: {
    list?: typeof listFavoriteDevices;
    keep?: typeof keepFavoriteDevice;
    update?: typeof updateFavoriteDevice;
    forget?: typeof forgetFavoriteDevice;
  };
}

export interface MyScootersHandle {
  /** Re-read the list. Called after a keep from elsewhere (the device popup)
   *  and when the Tools drawer opens. Calls that land while a read is already
   *  in flight share it rather than starting a second. */
  refresh(): Promise<void>;
  /** Open the camera and keep whatever it reads. Shared with the popup's ⭐,
   *  so both entry points run the same flow and report the same failures.
   *
   *  `report` is where the rider is LOOKING. The panel's status line lives
   *  in the Tools drawer, which is off-screen when the tap came from a map
   *  popup — so the popup passes its own hint line, and every sentence this
   *  flow says goes there too. Same sentences, second surface; nothing about
   *  the flow forks. */
  keep(
    prefill?: { vehicleIdentifier?: string; nickname?: string },
    opts?: { report?(text: string): void },
  ): Promise<void>;
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

export function wireMyScooters(deps: MyScootersDeps): MyScootersHandle {
  const cleanupFns: (() => void)[] = [];
  const signedIn = deps.signedIn ?? (() => isAuthenticated());
  const api = {
    list: deps.api?.list ?? listFavoriteDevices,
    keep: deps.api?.keep ?? keepFavoriteDevice,
    update: deps.api?.update ?? updateFavoriteDevice,
    forget: deps.api?.forget ?? forgetFavoriteDevice,
  };

  let favorites: FavoriteDevice[] = [];
  let busy = false;

  const say = (text: string): void => {
    deps.status.textContent = text;
    deps.status.hidden = !text;
  };

  const render = (): void => {
    deps.list.replaceChildren();
    for (const f of favorites) deps.list.append(row(f));
    // Hidden entirely when there is nothing to show AND nothing to do — an
    // empty heading is a permanent reminder of a feature you are not using,
    // the same rule My dibs follows. Signed in with none kept, the section
    // stays: the Keep button is the point.
    deps.section.hidden = !signedIn();
  };

  const row = (f: FavoriteDevice): HTMLLIElement => {
    const li = el("li", "my-scooters__item");
    const head = el("div", "my-scooters__head");
    head.append(el("span", "my-scooters__name", favoriteTitle(f)));
    head.append(el("span", `my-scooters__state is-${f.state}`, STATE_LABEL[f.state]));
    li.append(head);

    const loc = locationOf(f);
    if (loc.kind === "withheld") {
      // SAYS why, never a blank. A rider who sees an empty space assumes a
      // bug and reloads; one who reads the sentence understands the product.
      li.append(el("p", "my-scooters__withheld", loc.sentence));
    } else {
      const here = deps.locate.current();
      const bits: string[] = [];
      if (here) {
        const metres = distanceMeters(here, { lng: loc.lon, lat: loc.lat });
        bits.push(formatWalk(metres));
      }
      if (loc.battery !== null) bits.push(`${loc.battery}% charge`);
      li.append(el("p", "my-scooters__where", bits.join(" · ") || "Parked nearby"));
      if (deps.onShowOnMap) {
        const show = el("button", "text-btn", "Show on map");
        show.type = "button";
        show.addEventListener("click", () => deps.onShowOnMap?.(f));
        li.append(show);
      }
    }

    const actions = el("div", "my-scooters__actions");

    const notify = el("label", "switch");
    const notifyBox = el("input");
    notifyBox.type = "checkbox";
    notifyBox.checked = f.notify_on_available;
    notifyBox.addEventListener("change", () => {
      notifyBox.disabled = true;
      void api
        .update(f.vehicle_identifier, { notify_on_available: notifyBox.checked })
        .then(() => {
          f.notify_on_available = notifyBox.checked;
          track("favorite_notify", { on: notifyBox.checked });
        })
        .catch(() => {
          notifyBox.checked = !notifyBox.checked;
          say("Couldn't save that — try again in a moment.");
        })
        .finally(() => {
          notifyBox.disabled = false;
        });
    });
    // No location in the alert, and the label says so rather than letting a
    // rider assume otherwise: it fires when the scooter comes free, and they
    // open the app to see where.
    notify.append(notifyBox, el("span", "", "Tell me when it's free"));
    actions.append(notify);

    const forget = el("button", "text-btn", "Let go");
    forget.type = "button";
    forget.addEventListener("click", () => {
      forget.disabled = true;
      void api
        .forget(f.vehicle_identifier)
        .then(async () => {
          track("favorite_removed", { reason: "rider" });
          await reload();
          say(`Let go of ${favoriteTitle(f)}.`);
        })
        .catch(() => {
          forget.disabled = false;
          say("Couldn't let that one go — try again in a moment.");
        });
    });
    actions.append(forget);
    li.append(actions);
    return li;
  };

  // One read at a time. The drawer re-reads every time it opens, and a rider
  // flicking Tools open/shut/open must not stack requests whose answers land
  // out of order. `refresh()` joins a read already in flight; `reload()` is
  // for after a keep or a let-go, where a read that STARTED before the write
  // could come back without it — so it always starts fresh, and the
  // generation check drops whatever the older read brings back.
  let inflight: Promise<void> | null = null;
  let generation = 0;

  const reload = (): Promise<void> => {
    const gen = ++generation;
    const p = (async () => {
      if (!signedIn()) {
        favorites = [];
        render();
        return;
      }
      try {
        const res = await api.list();
        if (gen !== generation) return;
        favorites = res.favorite_devices;
      } catch {
        if (gen !== generation) return;
        // Leave whatever was on screen rather than blanking the list on a
        // dropped request: a rider's kept scooters are not news, and an empty
        // list reads as "they're gone".
        say("Couldn't refresh — showing what we last had.");
      }
      render();
    })().finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  };

  const refresh = (): Promise<void> => inflight ?? reload();

  const keep: MyScootersHandle["keep"] = (prefill, opts) =>
    new Promise<void>((resolve) => {
      // Every sentence this flow says goes to the Tools status line (where
      // the panel's own button looks) AND to the caller's surface when it
      // has one (the popup's hint line, which is where a ⭐ tap looks).
      const tell = (text: string): void => {
        say(text);
        if (text) opts?.report?.(text);
      };
      let keepStarted = false;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (busy) return resolve();
      if (!signedIn()) {
        tell(KEEP_SIGNIN_HINT);
        return resolve();
      }
      const scan = deps.scan ?? openQrScanner;
      scan({
        prompt: "Scan the QR code on the scooter you want to keep.",
        onScan(raw) {
          keepStarted = true;
          const here = deps.locate.current();
          if (!here) {
            // The server would refuse this anyway, for the same reason. Said
            // here so the rider is not sent to the camera twice.
            tell("Turn location on — we have to know you're standing at it.");
            return finish();
          }
          busy = true;
          tell("Keeping…");
          void api
            .keep({
              qr_raw_value: raw,
              lat: here.lat,
              lng: here.lng,
              ...(prefill?.vehicleIdentifier
                ? { vehicle_identifier: prefill.vehicleIdentifier }
                : {}),
              ...(prefill?.nickname ? { nickname: prefill.nickname } : {}),
            })
            .then(async (res) => {
              track("favorite_added", {
                entry: prefill?.vehicleIdentifier ? "popup" : "panel",
                already: res.already_favorited,
              });
              await reload();
              const name = res.favorite ? favoriteTitle(res.favorite) : "that one";
              tell(
                res.already_favorited
                  ? `${name} is already yours.`
                  : res.points_awarded > 0
                    ? `Kept ${name} — and that's ${res.points_awarded} points for the first scan.`
                    : `Kept ${name}.`,
              );
            })
            .catch((err) => tell(keepErrorMessage(err)))
            .finally(() => {
              busy = false;
              finish();
            });
        },
        onClose() {
          // openQrScanner closes before it delivers onScan, so a successful
          // scan reaches us as onClose → onScan in one turn. Wait a microtask:
          // if onScan starts the keep path, it will set `keepStarted` first.
          queueMicrotask(() => {
            if (!keepStarted) finish();
          });
        },
      });
    });

  const onKeepClick = (): void => {
    void keep();
  };
  deps.keepButton.addEventListener("click", onKeepClick);
  cleanupFns.push(() =>
    deps.keepButton.removeEventListener("click", onKeepClick),
  );

  void refresh();

  return {
    refresh,
    keep,
    destroy() {
      for (const fn of cleanupFns.splice(0)) fn();
    },
  };
}
