# Milestone 5 — Geo racing camera & venue library

This note captures **what shipped** after Milestone 4 and **why** it is shaped this way. The earlier baked satellite bitmap and “fit the whole course on screen” camera were fine for a small triangle; they broke down on real venues (Helsinki-scale legs, Orlando Speedtrack + session GPS).

## Problems we hit

1. **HUD speed vs world scale.** Motion used canvas pixels per second. Large geo tracks shrink meters→pixels to fit, so 30 km/h looked ~10× too fast. Physics now integrate in track meters, then `trackMetersToPixel`. Collisions use meter radii via `pixelsPerMeter()` from geographic ground truth.

2. **The rider left the map.** Follow-camera pan was added (no wrap — wrapping on a lake is nonsense). The old geo background was a **one-shot canvas bake** of whatever tiles covered the first viewport. As soon as the camera panned, the world was blank.

3. **Buoy size vs zoom.** An earlier experiment auto-zoomed from “next two buoys” vs full course and counter-scaled sprites. Changing buoy **pixel size while racing** made distance feel wrong; that design was removed. Overview zoom is now an explicit **Z cycle**, and markers are only counter-scaled in overview so they stay readable without rewriting race geometry.

## What shipped

### Follow camera

- **Race zoom:** edge dead zone (~16% / min 90 px), exponential lerp, slight look-ahead with speed. Layout stays in world canvas coordinates; the camera is a render transform only.
- **Overview (1 km and 5 km):** rider is **eased to viewport center** (no snap). Tracking stays centered while the stop is active.
- **Z Z** (out then back) recenters race zoom because the scale lerp preserves the rider’s screen position, and center is inside the dead zone.

Z cycles `race → 1 km → 5 km → race`. Both overview stops use the shorter viewport side as the named ground span.

### Streaming satellite tiles

Esri World Imagery is drawn **per frame** from a tile cache, not a baked bitmap.

- Visible mercator bounds come from the camera (screen corners → world → mercator).
- Draw zoom drops until the view stays near a ~96-tile budget (5 km must not request thousands of z18 tiles).
- Prefetch: pad around the view, extra tiles along heading × ~7 s of travel, plus parent zoom for coverage while children load.
- Fallback: parent source-rect, or one level of children, so loading is mostly invisible.
- LRU cache, capped inflight requests.
- On **Z**, prefetch uses the **target** scale so 1 km / 5 km tiles start loading during the ease.

Attribution stays on-screen: Imagery © Esri — Maxar, Earthstar Geographics.

### Session CSV → ghost

Onboard logs (`session_*.csv`) import as ghosts. Timing prefers real `lap_elapsed_s`; otherwise wall-clock `t_unix` (some files have `lap_index: -1` and elapsed all 0). Positions go through the **active track’s geo.origin**, never a re-centered origin. Ghosts preview immediately (loop until the rider starts a lap). Heading space is track meters.

### Designer: Tracks vs presets

Presets used to strip geo and apply the layout onto **wherever the map happened to be**. Opening “Tuorinniemi” on a Spanish lake is the wrong model.

- **Saved tracks** store the full serialized course **including** geo. Opening one moves the map to that venue. Country grouping uses reverse geocode (Nominatim) from origin, or the name after an em dash for older saves; flags are ISO 3166 regional-indicator emojis.
- **Presets** (Official Speedtrack) remain layout templates and keep the current location.
- Flip track mirrors the layout and swaps left/right pass side.

Official Speedtrack geometry: legs **70 / 55 / 105 m**, pass #1 right, #2 left, #3 right (path on that side of the buoy), gate with one end on #1 and the other 47 m along #2→#3.

### Simulator HUD

Designer return link lives **above** the track list (not top-left of the game). Ghost stats split onto two lines (name, then time/speed) and sit clear of the export panel.

## 3D map views (decision, not implemented)

A pitched chase camera is attractive and **does not require a paid 3D product**.

Efoil racing is almost entirely **flat water**. Photorealistic 3D tiles (Google, Mapbox mesh, Cesium ion premium) buy buildings and trees; on a lake they add cost and little racing value.

A free path:

- Drape the **same Esri tiles** on a ground plane (or skip DEM — lake DEMs often look like hills).
- **MapLibre GL JS** (open source) or a small custom WebGL plane: pitch, bearing, height.
- Designer stores an initial camera pose; the simulator reuses the follow/center lerp already built for 2D.

Tradeoff: ortho tiles stretch toward the horizon — hide with fog and the same tile budget/prefetch. Do this as a toggle after 2D overview feels solid; do not start with billed 3D.

## Files

- `engine.js` — meter motion, follow camera, zoom stops, tile stream
- `trackSchema.js` — Official Speedtrack, saved tracks + place/country, session CSV
- `designer.js` / `designer.html` — Tracks menu, country groups, apply-with-venue
- `index.html` / `highscores.js` — HUD layout, ghost stats lines
