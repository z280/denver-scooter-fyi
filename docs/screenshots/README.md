# Screenshots

Produced by `scripts/shots.mjs` against `scripts/shots/harness.html` — see
that script's header for why a harness exists rather than just the app
(offline, the app cannot reach a multi-leg trip in progress, a profile with an
unverified phone, or a route with four maneuvers; the harness mounts those
panels directly with fixtures, against the real stylesheet).

    npx vite --port 5173 &
    node scripts/shots.mjs docs/screenshots

| File | What it shows |
| --- | --- |
| `zone-defaults.png` | The Areas drawer's shipped defaults over downtown: the city's rule zones (red/orange/yellow) and the Equity Areas (purple) both at FULL strength, and the Rover area as the muted teal quadrilateral through the middle. Scooter dots hidden so the three overlays are what the picture is about; taken against the dev server, since these are map layers and the harness has no map. |
| `chosen-pins.png` | The two chosen-scooter markers on the real map: a blue ⭐ on the scooter you start on, an orange 📍 on the hand-off. Taken against the dev server rather than the harness — these are map layers, and the harness has no map. |
| `nav-prefs.png` | Navigation preferences, Calling dibs: auto-dibs on by default, and the SMS switch greyed with the reason — this profile has a number nobody has verified. |
| `trip-clear.png` | Your trip, mid two-leg plan, with "Clear my trip" below the planning preference. |
| `trip-clear-confirm.png` | The same panel one tap later. The confirm is in the panel, not a `window.confirm`, and `refresh()` disarms it. |
| `nav-step-magnifier.png` | The Directions list, with a 🔍 on every row. (The instruction card showing through behind it is the harness's narrow container, not the real HUD, which is full-screen.) |
| `ribbon-open.png` | Phone width, tab strip out. |
| `ribbon-yielded.png` | The same, one tap on Filters later: the strip has stood aside and the drawer has the screen. It comes back when the drawer closes — and only if we were the ones who took it. |
