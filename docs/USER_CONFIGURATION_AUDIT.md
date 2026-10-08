# Every user configuration in the app

Written while rebuilding the account menu (2026-10-07). It is the ground truth
the rebuild was designed against: what a rider can configure, where each answer
is stored, where it is read, and — the column that mattered most — **where, if
anywhere, they can actually set it.**

Three things were wrong, and all three were the same shape: a field that was
stored, validated and read, with no control attached to it.

---

## 1. Per-ride: `RideOptions`

Stored on `tracked_rides.ride_options` (JSONB, 4 KB cap, client-owned). The
server reads only `save_tracks`, `battery_modeling`, `nav_improvement`,
`end_survey`, `own_device`. Defaults come from `defaultRideOptions()`.

| Field | Default | Where it was askable | Read by |
|---|---|---|---|
| `navigation` | `false` | Preflight, Screen 2 panel | Screens 3/4 |
| `save_tracks` | `savesTracks()` | Preflight, Screen 2 panel | Track recorder |
| `cost_hud` | `true` | **Preflight only** | `ride-hud` display + `autoStart` |
| `speedometer` | `"classic"` | **Nowhere at all** | `ride-hud` display |
| `battery_modeling` | `true` | Screen 2 panel (🏆) | Post-ride |
| `nav_improvement` | `true` | Screen 2 panel (🏆) | Route feedback |
| `end_survey` | `true` | Screen 2 panel (🏆) | Post-ride |
| `own_device` | `false` | Device pick / home bar / free ride | Everywhere |

**`speedometer` was unreachable.** Validated in `ride-session.ts`, persisted,
read by the HUD, and carrying a post-ride feedback token — with no screen in the
app able to set it. Every rider was pinned to `"classic"` forever.

**`cost_hud` was nearly unreachable.** Asked on one screen, `ride-preflight.ts`,
which only opens from a device card's "Use in Ride Mode". Every other route into
ride mode took the default silently.

Both are standing preferences now (`ride-display-prefs.ts`), seeding each ride,
following the `save_tracks` precedent exactly.

### The speedometer enum is asymmetric

`ride-hud.ts` derives two flags from one field:

```ts
speedoClassicVisible = liveDoc.options.speedometer === "classic";
speedoDigitalVisible = liveDoc.options.speedometer !== "none";
```

| value | analog dial | digital mph |
|---|---|---|
| `"classic"` | yes | yes |
| `"digital"` | no | yes |
| `"none"` | no | no |

So the three options are **both / digital-only / neither**, not the
"analog / digital / off" the names imply, and no stored value means "dial without
numbers". Left as it is: redefining `"classic"` to mean dial-only would silently
take the mph readout away from every existing rider. The new control carries a
sentence per option instead of relying on the names.

### `cost_hud` is not only a display flag

```ts
// ride-preflight.ts
autoStart: !answers.cost_hud || answers.startIntent === "already-started",
```

Turning the cost readout off means "don't involve me in Veo's meter", which also
skips the Veo start link. That coupling is only safe because the question is
asked per ride, so the preflight row stayed where it is and the standing
preference seeds it. Promoting it fully would need `startIntent` asked
separately — otherwise a rider who once turned the readout off would never be
offered a start link again, on any ride, with nothing on screen saying so.

---

## 2. Account: `Profile`

Server-side, `GET`/`PUT /api/v1/profile`.

| Field | Surface |
|---|---|
| `email`, `phone_number`, `phone_verified`, `sms_opted_out` | Edit Profile modal |
| `rate_plan` | In-Ride tab (was Profile tab) |
| `home_lat/lng`, `work_lat/lng` | **Navigation tab's Home/Work slots**; draws map pins |
| `saved_places` | **New.** Navigation tab's four slots and every other saved place. Encrypted at rest server-side (API `src/place_crypto.py`) |
| `public_username`, `royalty_title`, `ruling_color`, `ruling_border_color` | Community tab |
| `show_public_username`, `show_in_leaderboards` | Community tab |
| `badges`, `display_name`, `ride_totals` | Read-only |
| `theme` | **Stored, never read.** The app themes from `scooter-fyi-theme` locally. |
| `favorites` | **Superseded by `saved_places`.** The original plaintext column; the server folds it in on read and the client never touches it. |

`theme` is a dead column from the client's side; `favorites` is a draining one.
Neither is written. Removing a server field is a cross-repo change, and the
`favorites` fold-in has to run over live traffic before its column can go.

---

## 3. Device: localStorage

Thirty-three keys. The ones that are genuinely rider preferences:

| Key | What |
|---|---|
| `scooter-fyi-speedometer` | **New.** Standing speedometer style |
| `scooter-fyi-cost-hud` | **New.** Standing cost-readout toggle |
| `scooter-fyi-save-tracks` | Standing save-tracks answer (the precedent) |
| `scooter_fyi.rate_plan` + `scooter_fyi.veoplus` | Rate plan cache; Pass refinement the server cannot hold |
| `scooter-fyi-favorites` | Saved places, including the four slots. Mirrored to `saved_places` while signed in (`saved-places-sync.ts`) |
| `scooter-fyi-recent-dests` | Recent destinations |
| `scooter-fyi-theme`, `scooter-fyi-theme-sun` | Theme and sun-sync |
| `scooter_fyi.ride_voice_muted` | Voice mute |
| `scooter_fyi.ride_spec` | Ideal-scooter spec |
| `scooter-fyi-filter-presets` | Saved map filters |
| `scooter-fyi-ride-prefs` | Find-wheels interview answers |
| `scooter-fyi-notify-moved` | Move watches |

The rest is UI state (`-onboarded`, `-ribbon`, `-install-dismissed`, `-tip-*`,
`-triple-tap-nudge`), session data (`.ride_session`, `.map_auth`, `-dibs`,
`-story-drafts`, `-surveys-submitted`), telemetry ids, and view hints
(`.account_tab`, `.community_settings_open`).

---

## 4. Mid-ride: the wrench panel

The HUD's adjust panel has Display chips — Timer, Est. cost, Speedo classic,
Speedo digital — plus a Rate select and a Voice mute.

**The chips are strictly more expressive than the stored enum**: they toggle the
two speed readouts independently, so they can show the dial without the numbers,
which no `speedometer` value can. They are also **ride-scoped and unpersisted** —
the handler assigns instance fields and nothing else, so every tap is forgotten
when the ride ends.

That was the shape of the gap this rebuild closed from the other side: a
mid-ride control richer than the stored field, and a stored field with no entry
point. The settings tab now owns the standing answer; the chips still override
for one ride.

---

## 5. What is still open

- **`RideOptions.theme`** is in the blob and resolved from localStorage instead.
  Harmless, but two sources of truth for one idea.
- **Profile `home`/`work` vs the Home/Work favourite slots.** Now one control,
  not two: the profile panel's own location editors are gone and the Navigation
  tab's slots are the single place a rider sets either. The two plaintext
  columns are still written, from the slot rows, because the map pins and the
  profile-completion award read them — dropping them is an API migration, not a
  client edit. The slots also reach `saved_places`, which is the encrypted
  replacement, through `favorites.ts`'s sync hook.
- **`cost_hud` as a fully standing setting**, which needs the `autoStart`
  decision above.
Both of the bugs this audit originally listed here are now fixed:

- ~~Two concurrent focus traps recurse.~~ Fixed. `modal-focus-trap.ts` keeps a
  recovery stack and the topmost live trap owns stray focus;
  `ride-modal.ts`'s own trap registers with it. It was reachable in a real
  browser — starting a ride while the tour is up threw "Maximum call stack size
  exceeded" — not only by a synthesised click, as first thought.
- ~~`setDevice` does not re-apply the option cascades.~~ Fixed. The pure rules
  moved to `ride-option-cascades.ts` (no DOM, no API client) so the type-only
  reducer can import them, and `open`, `setDevice` and `setOptions` all apply
  them. `options.own_device` now follows the device too — Screen 2's own-device
  option set only the device, so the `own_device` rules never fired for a pick
  made there, and `guest_or_private` was covering all three by accident.
