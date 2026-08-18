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
| **Z** | Cycle zoom: race → **1 km** → **5 km** → race |
| **P** | Toggle racing line. Top-right **P Show Path** / **P Hide Path** |
| G | Keep racing against the current ghost. Top-left **Customize ghost** |
| **T** | World atlas (Esc or T again returns). Top-right **T World Map** |
| **F** | Fullscreen. Top-right **F Fullscreen** |

HUD chrome (T / F / P, and **Customize ghost**) must work with a **finger** as well as a mouse. The race canvas captures touches for steer/throttle; new overlay controls need a ~44 px hit target and `bindChromeTap` (pointer/touch down, not `click` alone) so the canvas cannot steal the tap. Always verify on a touch device, not only with a cursor.

**Race zoom** uses an edge dead-zone follow camera (the rider stays in frame without wrapping the world). **1 km** and **5 km** ease the rider to the center of the viewport — a quick **Z Z** (out then back) is also a smooth recenter.

**T** opens a world map of saved geo tracks (country pins, then a dive to the venue). The flight always looks at the selected start, not a lerp from world-center, and race-level tiles crossfade in before the camera arrives. Mid-lap T pauses the race and music until you keep racing or leave. See [docs/MILESTONE-6.md](docs/MILESTONE-6.md).

On geo tracks, satellite tiles **stream around the camera** and prefetch along heading/speed so panning and zoom-out should not flash empty water. Lower-zoom parents fill in while higher-zoom tiles load.

The top-left telemetry block starts with the **current ghost** (your previous lap by default). **Customize ghost** sits under Design a track / ← Back to Designer and hides Keep / Export / Choose file / Use previous lap. Import a **ghost JSON** or a **session CSV** there (Choose file / drop). If a geo track is already selected, GPS is projected through that track’s origin. Otherwise a temporary session map is created.

## Designer

- Draw buoys, gates, and start heading on water or a blank grid.
- **Satellite map**: search a venue, move/rotate/flip the layout, export GPX/KML/CSV.
- **Test Ride** opens the simulator with the draft; **← Back to Designer** sits at the top of the track list.
- **Export JSON** — current track, all tracks in one country, or a full library backup. Import merges backups into Saved tracks (existing ids skipped).
- **Tracks** menu:
  - **Saved tracks** — full course including world location, grouped by country with flag emojis. Opening one jumps the map to that venue.
  - **Presets** — layout templates (Official Speedtrack 70 / 55 / 105 m). Applying a preset keeps the current map location.
- Record a racing line from the simulator; share a compressed URL + QR; export a race-briefing poster.

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
