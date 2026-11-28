# eFoil Racing

The official eFoil racing simulator and track designer by Antti Koskinen.

Practice a course **at the real venue**: satellite imagery, meter-accurate motion, ghosts from onboard session logs, and a designer that places buoys on the water.

- Simulator: [`index.html`](index.html)
- Track designer: [`designer.html`](designer.html)
- Live (GitHub Pages): https://akoskinen.github.io/efoilracing/

Fully static — no backend, no accounts. Tracks are JSON in **meters**. Geo-anchored tracks add a lat/lng origin and rotation so the same layout sits on Esri World Imagery.

## Run locally

Python’s HTTP server is enough. Bind IPv4; `localhost` on this machine has been flaky on IPv6.

```bash
python3 -m http.server 8081 --bind 127.0.0.1
```

Then open http://127.0.0.1:8081/ and http://127.0.0.1:8081/designer.html

## Simulator

| Control | Action |
|---|---|
| Arrows / IJKL | Steer and throttle |
| DualShock | Either stick sets the lean angle. Either trigger, L2 or R2, is the throttle and has to be held: full pull accelerates at the board's rate, a partial pull holds that fraction of top speed, and letting go slows you at the shared rate. Triangle cycles the camera like Z. Square opens board customization: d-pad up and down move between the settings, d-pad left and right change the value, L1 and R1 switch the board, Cross saves, Circle cancels. While racing, d-pad up toggles the ghost name and d-pad down keeps or releases the current ghost. Press a button once so the browser starts reading the pad |
| **Z** | Cycle the camera: **chase view** (where rides start) → race zoom → **1 km** → **5 km** → chase view. **Shift+Z** cycles the other way. Pinch follows the same stops |
| **P** | Toggle racing line. Top-right **P Show Path** / **P Hide Path** stays put when the course has a line |
| G | Keep the current ghost, or restore the previous lap. Top-left **Customize ghost** |
| **T** | World atlas (Esc or T again returns). Top-right **T World Map**. **C** and **N** still work while the map is open |
| **F** | Fullscreen. Top-right **F Fullscreen** |
| **N** | Show or hide the ghost's rider name. Top-right **N Ghost name**, in the same group as the other blue links |
| **B** | Leaderboard for the course you're on. It fills the screen. Filter on-water laps and simulator laps, the period (today, this week from Monday, this calendar year, all time), and the board brand. Each entry shows the brand and board. Esc closes it |
| **C** | **C Custom boards**, including from the world map. The board fills the view: Standard, KOSKINEN, MAKA, VARKEVISSER, and ARPA. Swipe it or use the blue arrows beside the board. On a desktop the sliders sit beside the board, and Shift+Left / Shift+Right move between boards. On a phone, tap the board to flip to the sliders. Up and Down move between the settings, Left and Right change the value, Enter saves, Esc eases the sliders back to the last save and closes. **Reset** restores that board's stock setup |

The top-right group is **C Custom boards** • **N Ghost name**, then **T World Map** • **F Fullscreen**, then **P Hide Path** when the course has a line. Top-left stays **Design a track**, with **Edit current track** under it. That opens the designer on the course you are riding.

HUD chrome (T / F / P / C / N, **Edit current track**, and **Customize ghost**) must work with a **finger** as well as a mouse. The race canvas captures touches for steer/throttle; new overlay controls need a ~44 px hit target and `bindChromeTap` (pointer/touch down, not `click` alone) so the canvas cannot steal the tap. Always verify on a touch device, not only with a cursor.

**Race zoom** uses an edge dead-zone follow camera (the rider stays in frame without wrapping the world). **Chase view** eases the camera down behind the rider and turns with heading, lagging a little so a quick lean does not spin the lake. Under about 10 km/h that wide tilt stays put. From there to 45 km/h the camera closes in to about 15 m behind the board and tips further forward, into a third-person view. In chase the rider is a Lift X efoil (`assets/board/efoil.glb`, about 13,000 triangles), drawn at twice life size. Real sizes: a 1.60 m by 0.60 m deck, 85 cm from its underside to the wing, the motor pod about 10 cm above the wing, a 45 cm front wing, and the mast's trailing edge about 27 cm from the tail. Above 10 km/h the deck rises to 50 cm off the water with a soft shadow, easing in and out over 1.8 s. Below 10 km/h it settles back onto the water over 1.2 s. It rolls with the lean angle in a turn. Switching from a lean on one side to the other swings back through flat at no more than 110°/s, so a full 55° lean takes half a second to come up to flat. Letting go eases off no faster than that either. The wing is the pivot: the craft yaws about it, and a lean swings the deck to the inside of the turn. Up to about 43° the wing holds its 35 cm depth. Past that the rider brings the board higher on the mast, so the low rail stays 7 cm clear of the water while the wing and pod stay under. Only at the full 55° does the high wing tip break the surface, by about 1 cm, and it leaves a second slim wake that fades out over 25 m. The mast and wing below the water are clipped, and the main wake starts where the mast meets the water. Flying above about 14 km/h, the mast throws a sheet of spray off its trailing edge (`chaseSpray.js`). It's up to about 3,000 droplets drawn as soft three.js points with faint motion streaks, and it grows with speed. Off the foil the board pushes a displacement wake instead of the slim line: a wider wash behind it, plus a Kelvin pattern. Feathered crests ride out along two arms at 19.5° and spread sideways over time, with curved crests across between them one wavelength apart. It all fades out over about 20 m. Top-down views keep the flat board marker. Turn buoys stand up as inflatable SFT buoys, rendered with three.js (vendored in `lib/three/`, no build step); without WebGL they fall back to flat marks. A buoy penalty is a touch of that hull by the board or the mast, the same in every camera view; flat marker buoys use a 1.25 m disc against the board. Other buoys lie flat on the water and take the ground's perspective, and the turn numbers stay upright markers. At the 1 km and 5 km overviews the buoys shrink to dots with the map and keep their white ring, while the board stays a little large so the rider is easy to find. The tilted view keeps the same satellite zoom and loads extra tiles around it, so the water does not end in an empty wedge. **1 km** and **5 km** ease back to a top-down view with the rider centered. Every step of Z, and every pinch between those stops, moves the camera rather than cutting, and the board eases between its 2× chase size and the top-down marker size as the camera tilts instead of snapping. In chase view, **V Camera** opens sliders for the two speed thresholds and, at each, the eye height above the board, the distance behind the board's middle, and how far the camera looks down; the camera blends between them with speed. **First person** puts the eye 1.5 m above the middle of the board at the high-speed threshold. Settings are saved in the browser. At the high-speed threshold the horizon also tilts by a quarter of the lean angle, following it smoothly about 0.25 s behind.

**T** opens a world map of the 2026 courses in `efoil-tracks-2026.json`, plus any tracks saved in this browser (country pins, then a dive to the venue). From the chase view the camera eases up to a top-down picture of the same water, then zooms out; the satellite stays on screen instead of fading to a cut. The flight always looks at the selected start, not a lerp from world-center, and race-level tiles crossfade in before the camera arrives. Mid-lap T pauses the race and music until you keep racing or leave. See [docs/MILESTONE-6.md](docs/MILESTONE-6.md).

On geo tracks, satellite tiles **stream around the camera** and prefetch along heading/speed so panning and zoom-out should not flash empty water. Lower-zoom parents fill in while higher-zoom tiles load.

The top-left stack is **Design a track** and **Edit current track**. **Edit current track** hands the course you are riding to the designer, including a saved course so Save updates that same one. A test ride from the designer changes the first link to **Back to Designer**. Under those links is the **ghost** block (previous lap by default, with a green ahead / yellow behind delta while you race), then a **ghost timeline** when a ghost is loaded, then **Customize ghost**, then your recorded laps. Drag the timeline to scrub an imported session (skip the pre-lap wait); Play/Pause freezes the pink rider. A lap recorded in the simulator keeps the lean angle and ride height on every frame, so the pink rider rolls, takes off and settles the way that lap did, and its wake leaves the mast; at a full lean its wing tip throws the same short wake. Imported session logs have no lean, so those ghosts ride flat. Crossing the gate starts your lap from that scrubbed point. **Customize ghost** hides **G Keep current ghost** (toggles to **G Use previous lap**), Export, and Choose file. Tap outside the panel to dismiss it. Import a **ghost JSON**, a **session CSV**, or an app **GPX** there (Choose file / drop). Both the app CSV (`lat_deg`, `lon_deg`, …) and the admin CSV (`time_utc`, `lat`, `lon`, `spd_kmh`, `hdg`, `hacc`, …) are accepted, whether the file is comma- or semicolon-delimited. The ghost is the whole ride in the file, including the path before the timed lap and any later laps, timed on the wall clock. Admin fixes with horizontal accuracy worse than 50 m are skipped. A GPX from the app (`trkpt` plus `speed` in m/s and compass `heading`) is imported the same way. If a geo track is already selected, GPS is projected through that track’s origin. Otherwise a temporary session map is created. iPhone-rate (~1 Hz) CSVs are spline-smoothed to ~20 Hz for replay (extra samples in tight turns); ~20 Hz Dragy logs stay as captured.

## Designer

- Draw buoys, gates, and start heading on water or a blank grid.
- **Satellite map**: search a venue, move/rotate/flip the layout, export GPX/KML/CSV.
- **Test Ride** opens the simulator with the draft; **← Back to Designer** sits at the top of the track list.
- **Export JSON** — current track, all tracks in one country, or a full library backup. Import merges backups into Saved tracks (existing ids skipped).
- **Tracks** menu:
  - **Tracks** — the shipped 2026 courses, then any course saved in this browser. Each one includes its world location and is grouped by country with flag emojis. Opening one jumps the map to that venue. A shipped course is not editable in place; Save current track keeps a personal copy.
  - **Presets** — layout templates (Official Speedtrack 70 / 55 / 105 m). Applying a preset keeps the current map location.
- Record a racing line from the simulator; share a compressed layout-only URL + QR (ghosts stay local); export a race-briefing poster.

## Architecture (short)

| File | Role |
|---|---|
| `trackSchema.js` | Shared track JSON, geo math, Official Speedtrack, session CSV → ghost, saved-track library |
| `engine.js` | Physics, follow camera, streamed tiles, world atlas, ghosts, lap timing |
| `highscores.js` | Full-screen leaderboard. On-water and simulator laps, period and brand |
| `cloud.js` | Cloudflare board client. Laps and tracks. Empty URL keeps laps on this device |
| `cloudflare/` | Worker and D1 schema for the laps and the tracks |
| `designer.js` / `designer.html` | Visual editor on Leaflet + Esri tiles |
| `trackConfigs.js` | Built-in arcade tracks |

Motion is integrated in **track meters** (`km/h / 3.6`), then projected to pixels. That keeps HUD speed honest when a large geo course is fit-scaled onto the canvas.

## Cloud board

The leaderboard and the courses live on Cloudflare. The worker in `cloudflare/` stores both in one D1 database. The sim ships with that worker's address (`CLOUD_URL` in `cloud.js`), so every visitor loads the same laps. Saving a lap is public. Uploading a course still needs `Authorization: Bearer <WRITE_TOKEN>`.

The database id is already in `wrangler.toml`. After a change to the worker, publish it again:

```bash
cd cloudflare
npx wrangler d1 execute efoil-racing --remote --file=schema.sql
npx wrangler deploy
```

A lap recorded in the sim is posted as a simulator lap on a Lift Foils Lift X. On-water laps are the same record with `kind: "real"` and the board that was ridden. Week starts on Monday, and Season is the calendar year, both in the rider's local time. If the cloud cannot be reached, the board shows the laps saved on this device.

A browser can point at a different worker with `localStorage.setItem('efoil_cloud_url', 'https://...')`. The write token stays out of the site. A browser that should be allowed to upload a course sets `localStorage.setItem('efoil_cloud_token', '<the WRITE_TOKEN>')`.

`putTrack(key, track)` and `fetchTrack(key)` in `cloud.js` are the course side of the same worker. The designer still keeps courses locally until a save is wired through.

## Milestones

**1 — Data-driven tracks + designer MVP** — declarative schema, Test Ride, share URLs.

**2 — Map overlay** — Leaflet + Esri imagery, geo origin/rotation, GPS exports, simulator satellite background. Scale uses a shared mercator transform so designer and sim agree on the water.

**3 — Drive-the-line** — record a lap as a racing line + chase ghost, multiple colored variants per venue.

**4 — Briefing polish** — printable course-map poster from the designer.

**5 — Geo racing camera & venue library** — see [docs/MILESTONE-5.md](docs/MILESTONE-5.md).

**6 — World atlas & smooth tile flights** *(this drop)* — **T** world map, look-at-locked 6 s dives, LOD crossfades, sequenced landing. See [docs/MILESTONE-6.md](docs/MILESTONE-6.md).

### Next (not built)

A **pitched 3D chase view** can reuse the same Esri tiles on a flat water plane (MapLibre or a small WebGL ground), with the designer storing an initial camera pose. Paid photorealistic 3D (Google / Mapbox mesh) is a poor fit for lakes and is not required. See the reasoning in Milestone 5.

## License

All rights reserved. Contact Antti Koskinen (anttikoskinen@mac.com) for inquiries.
