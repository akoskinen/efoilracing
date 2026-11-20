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
| **Z** | Cycle the camera: race zoom → **chase view** → **1 km** → **5 km** → race zoom. Pinch follows the same stops |
| **P** | Toggle racing line. Top-right **P Show Path** / **P Hide Path** stays put when the course has a line |
| G | Keep the current ghost, or restore the previous lap. Top-left **Customize ghost** |
| **T** | World atlas (Esc or T again returns). Top-right **T World Map**. **C** and **N** still work while the map is open |
| **F** | Fullscreen. Top-right **F Fullscreen** |
| **N** | Show or hide the ghost's rider name. Top-right **N Ghost name**, in the same group as the other blue links |
| **C** | **C Custom boards**, including from the world map. The board fills the view: Standard, KOSKINEN, MAKA, VARKEVISSER, and ARPA. Swipe it or use the blue arrows beside the board. On a desktop the sliders sit beside the board, and Shift+Left / Shift+Right move between boards. On a phone, tap the board to flip to the sliders. Up and Down move between the settings, Left and Right change the value, Enter saves, Esc eases the sliders back to the last save and closes. **Reset** restores that board's stock setup |

The top-right group is **C Custom boards** • **N Ghost name**, then **T World Map** • **F Fullscreen**, then **P Hide Path** when the course has a line. Top-left stays **Design a track**, with **Edit current track** under it. That opens the designer on the course you are riding.

HUD chrome (T / F / P / C / N, **Edit current track**, and **Customize ghost**) must work with a **finger** as well as a mouse. The race canvas captures touches for steer/throttle; new overlay controls need a ~44 px hit target and `bindChromeTap` (pointer/touch down, not `click` alone) so the canvas cannot steal the tap. Always verify on a touch device, not only with a cursor.

**Race zoom** uses an edge dead-zone follow camera (the rider stays in frame without wrapping the world). **Chase view** eases the camera down behind the rider and turns with heading, lagging a little so a quick lean does not spin the lake. Under about 10 km/h that wide tilt stays put. From there to 45 km/h the camera closes in to about 15 m behind the board and tips further forward, into a third-person view. In chase the board is the real 1.60 m by 0.60 m on the water, and the wake stays a slim 2 px line. Buoys lie flat on the water and take the ground's perspective; the turn numbers stay upright markers. At the 1 km and 5 km overviews the buoys shrink to dots with the map and keep their white ring, while the board stays a little large so the rider is easy to find. The tilted view keeps the same satellite zoom and loads extra tiles around it, so the water does not end in an empty wedge. **1 km** and **5 km** ease back to a top-down view with the rider centered. Every step of Z, and every pinch between those stops, moves the camera rather than cutting.

**T** opens a world map of saved geo tracks (country pins, then a dive to the venue). From the chase view the camera eases up to a top-down picture of the same water, then zooms out; the satellite stays on screen instead of fading to a cut. The flight always looks at the selected start, not a lerp from world-center, and race-level tiles crossfade in before the camera arrives. Mid-lap T pauses the race and music until you keep racing or leave. See [docs/MILESTONE-6.md](docs/MILESTONE-6.md).

On geo tracks, satellite tiles **stream around the camera** and prefetch along heading/speed so panning and zoom-out should not flash empty water. Lower-zoom parents fill in while higher-zoom tiles load.

The top-left stack is **Design a track** and **Edit current track**. **Edit current track** hands the course you are riding to the designer, including a saved course so Save updates that same one. A test ride from the designer changes the first link to **Back to Designer**. Under those links is the **ghost** block (previous lap by default, with a green ahead / yellow behind delta while you race), then a **ghost timeline** when a ghost is loaded, then **Customize ghost**, then your recorded laps. Drag the timeline to scrub an imported session (skip the pre-lap wait); Play/Pause freezes the pink rider. Crossing the gate starts your lap from that scrubbed point. **Customize ghost** hides **G Keep current ghost** (toggles to **G Use previous lap**), Export, and Choose file. Tap outside the panel to dismiss it. Import a **ghost JSON**, a **session CSV**, or an app **GPX** there (Choose file / drop). Both the app CSV (`lat_deg`, `lon_deg`, …) and the admin CSV (`time_utc`, `lat`, `lon`, `spd_kmh`, `hdg`, `hacc`, …) are accepted, whether the file is comma- or semicolon-delimited. The ghost is the whole ride in the file, including the path before the timed lap and any later laps, timed on the wall clock. Admin fixes with horizontal accuracy worse than 50 m are skipped. A GPX from the app (`trkpt` plus `speed` in m/s and compass `heading`) is imported the same way. If a geo track is already selected, GPS is projected through that track’s origin. Otherwise a temporary session map is created. iPhone-rate (~1 Hz) CSVs are spline-smoothed to ~20 Hz for replay (extra samples in tight turns); ~20 Hz Dragy logs stay as captured.

## Designer

- Draw buoys, gates, and start heading on water or a blank grid.
- **Satellite map**: search a venue, move/rotate/flip the layout, export GPX/KML/CSV.
- **Test Ride** opens the simulator with the draft; **← Back to Designer** sits at the top of the track list.
- **Export JSON** — current track, all tracks in one country, or a full library backup. Import merges backups into Saved tracks (existing ids skipped).
- **Tracks** menu:
  - **Saved tracks** — full course including world location, grouped by country with flag emojis. Opening one jumps the map to that venue.
  - **Presets** — layout templates (Official Speedtrack 70 / 55 / 105 m). Applying a preset keeps the current map location.
- Record a racing line from the simulator; share a compressed layout-only URL + QR (ghosts stay local); export a race-briefing poster.

## Architecture (short)

| File | Role |
|---|---|
| `trackSchema.js` | Shared track JSON, geo math, Official Speedtrack, session CSV → ghost, saved-track library |
| `engine.js` | Physics, follow camera, streamed tiles, world atlas, ghosts, lap timing |
| `designer.js` / `designer.html` | Visual editor on Leaflet + Esri tiles |
| `trackConfigs.js` | Built-in arcade tracks |

Motion is integrated in **track meters** (`km/h / 3.6`), then projected to pixels. That keeps HUD speed honest when a large geo course is fit-scaled onto the canvas.

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
