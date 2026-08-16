# Milestone 6 — World atlas & smooth tile flights

This note captures **what shipped** after Milestone 5 and **why** the atlas camera and tiles are shaped this way. The old bottom-right radio list (Speed / Dubai / Sicily / Belgium) could not represent a growing library of saved geo tracks. **T** is now a world map: pick a country, dive to the venue, ride.

## Problems we hit

1. **Late pan across continents.** The first flight lerped lat/lng from a world-center (Greece) toward the venue. At low zoom that looks fine; in the last second the camera still had a huge remaining ground distance and **swept across Europe**. Fix: never lerp the look-at point. The camera **always looks at the selected track**. The pin glides from its screen position to the center while zoom changes around that lat/lng (`atlasViewLookingAt`). Pull-out stays on the current course — no pan back to `ATLAS_WORLD`.

2. **Blurry z12 until the flight ended.** Dive used a hardcoded `toZoom: 12.5` (5 km / atlas stop), then `selectTrack` switched to the race renderer (~native z16–19, 160 m viewport). High-res tiles popped in **after** the 6 s move. Fix: fly to the **real race effective zoom** (`nativeZoom + log2(scale)` for 160 m), prefetch race-level tiles from the start of the dive, and **finish zoom at 62%** of the flight so the last ~2.3 s hold at destination while z15/17/18 crossfade.

3. **Cannot draw z18 across a world-sized view.** Overlaying race tiles while the camera is still at zoom ~10 would request thousands of tiles. Atlas only draws a stop when the viewport tile count is ≤ **96** (same budget as the ride streamer). That is why arriving at race zoom *before* `onDone` matters: z18 only becomes drawable near destination.

4. **Look-at was the geo origin, ride view is the start.** Pins and `presetGeoLatLng` use `geo.origin` (track meters 0,0). The ride camera centers **start position**. Landing on the origin, then `selectTrack`, jumped the shoreline. Dive and pull-out now look at `atlasRideLookLatLng` / screen-center mercator (`cameraLookLatLng`).

5. **HUD and rider popped on handoff.** Atlas `display:none` + a CSS class swap flashed full opacity for a frame. Some canvas draws (`globalAlpha = 0.45`) **replaced** the fade instead of multiplying. Overlay opacity is driven from JS; nested draws use `*=`. Fade-out is a single 0.5 s overlay. Fade-in is a **sequenced intro** (gates → turns → markers/rider → racing line).

## Atlas camera

| Constant | Value | Why |
|---|---|---|
| `ATLAS_WORLD` | lat 22, lng 12, zoom 2.35 | World framing (not a lerp target for the look-at) |
| `ATLAS_TRANSITION_MS` | 6000 | One long ease-in/out flight |
| `ATLAS_ZOOM_ARRIVE` | 0.62 | Zoom-in reaches dest zoom at 62%; last 38% holds so hi-res can load |
| Zoom curve | cubic ease-in/out on **log zoom** | Linear zoom spends too long in empty mid-levels |
| Zoom-out | Full 6 s ease | Leave race tiles on screen longer at the start |

`atlasViewLookingAt(lat, lng, zoom, screenX, screenY)` sets the view so that lat/lng sits on a given screen pixel. Dive: `fromScreen` = current pin/start on the atlas, `toScreen` = canvas center. Pull-out: stay centered on the ride look-at.

Empty ocean click, Esc, or T again returns to the current course (mid-lap T asks first).

## Atlas tiles (smooth LOD)

Stops: **z3, z6, z9, z12, z15, z17, z18**, plus `floor(dest)` / `round(dest)` so the landing zoom is in the set.

- Prefetch only those viewports (dozens of tiles), not every integer zoom.
- Draw the highest stop whose tile count ≤ `ATLAS_LAYER_TILE_MAX` (96) as the **base**.
- **Crossfade** the next stop when it also fits the budget. Fade starts slightly early (`+15%` of the span) so the swap is not a cut.
- Prefetch priority: `min(|z − fromZoom|, |z − toZoom| × 0.35)` so **destination tiles load first** while the world layer is already on screen.
- Keep keys for prefetched stops during LRU prune so the flight does not delete tiles it is about to show.
- Ride-view tiles already in `geoTileCache` are reused on the way out.

Do **not** draw z17 while `view.zoom` is still ~10. The budget gate is the only thing that keeps the dive from stalling the network.

After `onDone`, `selectTrack` uses the same native zoom and start-centered transform, so the first ride frame should match the last atlas frame (satellite continuity). Track overlays then play the intro.

## Landing sequence (fade-in)

Fade-**out** to atlas is still a single 0.5 s alpha on rider, track, and HUD, then the zoom-out starts.

Fade-**in** after the camera arrives:

1. Start/finish line(s) — 0.5 s
2. Turn buoys first→last — 0.5 s each, **0.1 s stagger**
3. Marker buoys, rider, HUD — 0.5 s together
4. Visible racing line — **5 s** draw-along from start to finish (chase line if several are visible)

The first ride frame keeps overlays at 0 so tiles can settle (`intro.turns` must be `[]` even before `rideIntroT0` is set, or `drawTrack` throws).

## Mid-lap T

The confirm dialog **pauses simulation and music** (pause, do not rewind). Keep racing / Esc resumes both and shifts `lapStartTime` by the pause duration. Leave lap opens the atlas with music still paused; returning to ride resumes physics but not music until the next `startLap`.

## Library (simulator + designer)

Saved designer tracks load from `localStorage` (`efoil_track_presets_v1`). Official Speedtrack is a silent fallback, not a radio list.

- Atlas: hover/tap country → glass card; **one-track country: the yellow pin dives straight in**. Unplaced tracks → Layouts. Empty library: atlas + designer CTA.
- Designer **Export JSON**: current track, all tracks in one country, or the full library (`kind: efoil-track-library`). Import merges backups; existing ids are skipped.

## Files

- `engine.js` — atlas camera, LOD stops, intro sequence, lap/music pause
- `index.html` — atlas HUD, confirm dialog, ride overlay opacity
- `trackSchema.js` — library export/import, `presetGeoLatLng`, last-ride key
- `designer.js` / `designer.html` — export dialog (current / country / all)
