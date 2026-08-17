////////////////////////////////////////////////////////////
// engine.js
////////////////////////////////////////////////////////////
// This simulator and the code of the referenced modules is/are 
// the property of Antti Koskinen (anttikoskinen@mac.com)
// All Rights reserved, contact by email for any inquiries.
////////////////////////////////////////////////////////////

import { playCommentary, resetCommentaryQueue } from "./commentary.js";
import { HighScoreManager } from './highscores.js';
import {
  normalizeTrack, decodeTrackFromParam, DRAFT_STORAGE_KEY, LINE_CAPTURE_KEY,
  hasGeo, metersToLatLng, latLngToMeters, latLngToWorldPx, worldPxToLatLng,
  haversineMeters, buildRacingLineFromGhost, chaseRacingLine, ghostFromRacingLine,
  RACING_LINE_COLORS, trackFromSessionCsv, sessionCsvToGhost,
  createOfficialSpeedtrack, loadUserTrackPresets, countryFlagEmoji,
  countryGroupForPlace, presetGeoLatLng, LAST_RIDE_STORAGE_KEY, geoFromSavedEntry
} from './trackSchema.js';

const trackConfigs = {};

// --- Canvas and Context ---
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const followCam = { tx: 0, ty: 0, scale: 1 };
let zoomStopIndex = 0;

// --- Track Setup Variables ---
let currentTrackKey = 'official';
let currentTrack = createOfficialSpeedtrack();
normalizeTrack(currentTrack);
trackConfigs.official = currentTrack;

let buoys = [];
let timingLine = { x1: 0, y1: 0, x2: 0, y2: 0 };
let gates = { start: null, finish: null, parallelStart: null, parallelFinish: null };

// We'll store the offset used to center the track on the canvas.
let trackOffset = { x: 0, y: 0 };

const availableTrackKeys = ['official'];

// --- Additional Variables for Turn Apex Logic ---
let turnStates = {};
const THROTTLE_WINDOW = 0.5; // last 0.5s of throttle at the mark
// Must actually round the mark — not merely recede from a distant buoy.
const APEX_ZONE_M = 16;
const COMMENTARY_TIGHT_LINE_M = 8;
const OPTIMAL_SPEED_WINDOW_KMH = 8;
const APEX_RECEDING_EPS_PX = 0.75;

function initTurnStates() {
  turnStates = {};
  buoys.forEach(b => {
    if (b.turnIndex != null) {
      turnStates[b.turnIndex] = {
        apexReached: false,
        approached: false,
        previousDistance: null,
        minDistance: Infinity,
        apexSpeed: 0,
        throttleQueue: [],
        queueTime: 0
      };
    }
  });
}

// Add this helper function at the top level, before it's used
function lineIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
    // Calculate denominator
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (den == 0) return false;

    // Calculate intersection parameters
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;

    // Check if intersection occurs within both line segments
    return (t >= 0 && t <= 1 && u >= 0 && u <= 1);
}

// Make sure computedGates is declared at the top level
let computedGates = null;

// Geo-anchored tracks: mercator world pixels -> canvas pixels (rotation-aware).
let geoCanvasTransform = null; // { zoom, scale, offsetX, offsetY }
// Streaming tile budget for the padded camera view (not a one-shot canvas bake).
const GEO_TILE_BUDGET = 96;
const GEO_TILE_CACHE_MAX = 420;
const GEO_MAX_INFLIGHT = 10;
const GEO_PREFETCH_PAD_TILES = 2;
const GEO_LOOKAHEAD_SEC = 7;
const GEO_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
// Short viewport side at race zoom. Matches a fitted Official Speedtrack
// (~90–160 m) with a little extra look-ahead so large courses aren't a peephole.
const RACE_VIEW_METERS = 160;

function computeGeoCanvasTransform() {
  geoCanvasTransform = null;
  if (currentTrack) delete currentTrack._geoPxPerMeter;
  if (!hasGeo(currentTrack)) return;
  if (!canvas.width || !canvas.height) return;

  const geo = currentTrack.geo;
  const latRad = geo.origin.lat * Math.PI / 180;
  // Native imagery near ~0.25 m/world-px. Visible tiles are streamed at a
  // camera-dependent zoom, so this no longer has to drop for a full-canvas bake.
  let zoom = Math.round(Math.log2(156543.03392 * Math.cos(latRad) / 0.25));
  zoom = Math.max(12, Math.min(19, zoom));

  const toMerc = (mx, my) => {
    const ll = metersToLatLng(geo, mx, my);
    return latLngToWorldPx(ll.lat, ll.lng, zoom);
  };
  const mercPts = [];
  currentTrack.buoys.forEach(b => mercPts.push(toMerc(b.x, b.y)));
  if (currentTrack.gate) {
    const addSeg = s => {
      if (s && [s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)) {
        mercPts.push(toMerc(s.x1, s.y1), toMerc(s.x2, s.y2));
      }
    };
    addSeg(currentTrack.gate.start);
    addSeg(currentTrack.gate.finish);
  }
  if (currentTrack.startPosition && Number.isFinite(currentTrack.startPosition.x)) {
    mercPts.push(toMerc(currentTrack.startPosition.x, currentTrack.startPosition.y));
  }
  if (currentTrack.parallelTrack) {
    currentTrack.buoys.forEach(b => {
      mercPts.push(toMerc(b.x, b.y + (currentTrack.trackSeparation || 0)));
    });
  }
  // Include session/ghost GPS path so the rider isn't fitted out of view
  const ghostForFit =
    (currentGhost?.frames?.length && currentGhost) ||
    (typeof ghostDataMap !== 'undefined' && ghostDataMap.get(currentTrackKey)) ||
    null;
  if (ghostForFit?.frames?.length) {
    const step = Math.max(1, Math.ceil(ghostForFit.frames.length / 40));
    for (let i = 0; i < ghostForFit.frames.length; i += step) {
      const f = ghostForFit.frames[i];
      if (Number.isFinite(f.x) && Number.isFinite(f.y)) mercPts.push(toMerc(f.x, f.y));
    }
    const last = ghostForFit.frames[ghostForFit.frames.length - 1];
    if (last && Number.isFinite(last.x)) mercPts.push(toMerc(last.x, last.y));
  }
  if (!mercPts.length) return;

  // Race zoom is a fixed "altitude" (short viewport side ≈ RACE_VIEW_METERS),
  // not a fit of the whole course. Large venues pan; Z cycles, pinch zooms in/out.
  const m0 = toMerc(0, 0);
  const m1 = toMerc(100, 0);
  const mercPerMeter = Math.hypot(m1.x - m0.x, m1.y - m0.y) / 100;
  const targetPpm = Math.min(canvas.width, canvas.height) / RACE_VIEW_METERS;
  const scale = (mercPerMeter > 0) ? (targetPpm / mercPerMeter) : 1;

  let cx, cy;
  if (currentTrack.startPosition && Number.isFinite(currentTrack.startPosition.x)) {
    const s = toMerc(currentTrack.startPosition.x, currentTrack.startPosition.y);
    cx = s.x;
    cy = s.y;
  } else {
    const xs = mercPts.map(p => p.x), ys = mercPts.map(p => p.y);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  }

  geoCanvasTransform = {
    zoom,
    scale,
    offsetX: canvas.width / 2 - cx * scale,
    offsetY: canvas.height / 2 - cy * scale
  };

  // Calibrate pixels-per-meter for physics from geographic ground truth.
  const p0 = mercatorToCanvas(toMerc(0, 0));
  const p1 = mercatorToCanvas(toMerc(100, 0));
  const pxDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const ll0 = metersToLatLng(geo, 0, 0);
  const ll1 = metersToLatLng(geo, 100, 0);
  const groundDist = haversineMeters(ll0, ll1);
  if (groundDist > 0) {
    currentTrack._geoPxPerMeter = pxDist / groundDist;
  }
}

function mercatorToCanvas(wx, wy) {
  const t = geoCanvasTransform;
  return { x: wx * t.scale + t.offsetX, y: wy * t.scale + t.offsetY };
}

function canvasToMercator(px, py) {
  const t = geoCanvasTransform;
  return { x: (px - t.offsetX) / t.scale, y: (py - t.offsetY) / t.scale };
}

// --- Compute Buoys Function ---
function computeBuoys() {
  // Geo tracks: build rotation-aware mercator transform before placing anything.
  computeGeoCanvasTransform();

  // 1) Build intermediate buoy positions in LOCAL canvas pixels (no trackOffset).
  // trackOffset is applied only after centroid centering for non-geo tracks.
  const rawBuoyData = currentTrack.buoys.map(b => {
    const p = trackMetersToLocalPixel(b.x, b.y);
    return {
      px: p.x,
      py: p.y,
      turnIndex: b.turnIndex ?? null,
      aliases: b.aliases ?? [],
      apexRadius: b.apexRadius ?? 20,
      optimalSpeed: b.optimalSpeed
    };
  });

  // 2) If there's a parallel track, add its buoys to centroid calculation
  let totalPoints = [...rawBuoyData];
  if (currentTrack.parallelTrack) {
    const sep = currentTrack.trackSeparation || 0;
    const parallelBuoys = currentTrack.buoys.map((b, i) => {
      const p = trackMetersToLocalPixel(b.x, b.y + sep);
      return { ...rawBuoyData[i], px: p.x, py: p.y };
    });
    totalPoints = [...totalPoints, ...parallelBuoys];
  }

  // 3-4) Center non-geo tracks on canvas; geo tracks are already centered via transform.
  if (geoCanvasTransform) {
    trackOffset.x = 0;
    trackOffset.y = 0;
  } else {
    const centroid = totalPoints.reduce((acc, b) => ({
      x: acc.x + b.px,
      y: acc.y + b.py
    }), { x: 0, y: 0 });
    centroid.x /= totalPoints.length;
    centroid.y /= totalPoints.length;
    trackOffset.x = canvas.width / 2 - centroid.x;
    trackOffset.y = canvas.height / 2 - centroid.y;
  }

  // 5) Create the final buoys array, applying offset
  buoys = rawBuoyData.map(b => ({
    x: b.px + trackOffset.x,
    y: b.py + trackOffset.y,
    turnIndex: b.turnIndex,
    aliases: b.aliases,
    apexRadius: b.apexRadius,
    optimalSpeed: b.optimalSpeed
  }));

  // 6) Compute timing system
  if (currentTrack.useGates) {
    // Set parent reference for gates
    currentTrack.gates.parent = currentTrack;
    
    // Use gate system
    computedGates = currentTrack.gates.computeGates(trackMetersToPixel);
    
    if (currentTrack.gates.sameStartFinish) {
      gates = {
        start: computedGates.start,
        finish: computedGates.start,
        parallelStart: computedGates.parallelStart,
        parallelFinish: computedGates.parallelStart
      };
    } else {
      gates = {
        start: computedGates.start,
        finish: computedGates.finish,
        parallelStart: computedGates.parallelStart,
        parallelFinish: computedGates.parallelFinish
      };
    }
    
    // Clear timing line
    timingLine = { x1: 0, y1: 0, x2: 0, y2: 0 };
  } else {
    // Use old timing line system
  timingLine = currentTrack.computeTimingLine(buoys, canvas);
    // Clear gates
    gates = { start: null, finish: null, parallelStart: null, parallelFinish: null };
  }

  // 7) Initialize apex states for these buoys
  initTurnStates();

  // 8) Kick tile prefetch for the current camera (streamed, not baked)
  prefetchGeoTiles();
}

// --- Satellite tiles (streamed around the follow camera) ---
const geoTileCache = new Map(); // key -> {status, img, z, x, y, lastUsed, priority}

function updateGeoAttribution(show) {
  let div = document.getElementById('geoAttribution');
  if (!div) {
    div = document.createElement('div');
    div.id = 'geoAttribution';
    div.style.cssText = `
      position: fixed; bottom: 4px; right: 6px; z-index: 999;
      color: rgba(255,255,255,0.65); font: 10px sans-serif;
      text-shadow: 0 0 3px #000; pointer-events: none; display: none;
    `;
    div.textContent = 'Imagery \u00A9 Esri \u2014 Maxar, Earthstar Geographics';
    document.body.appendChild(div);
  }
  div.style.display = show ? 'block' : 'none';
}

function geoTileKey(z, x, y) {
  return z + '/' + x + '/' + y;
}

function wrapTileX(x, z) {
  const n = 1 << z;
  return ((x % n) + n) % n;
}

function screenToWorld(sx, sy, s, tx, ty) {
  s = s ?? followCam.scale ?? 1;
  tx = tx ?? followCam.tx;
  ty = ty ?? followCam.ty;
  return { x: (sx - tx) / s, y: (sy - ty) / s };
}

function cameraWorldBounds(padFrac, extraWorld, s, tx, ty) {
  const w = canvas.width;
  const h = canvas.height;
  const padX = w * padFrac;
  const padY = h * padFrac;
  const corners = [
    screenToWorld(-padX, -padY, s, tx, ty),
    screenToWorld(w + padX, -padY, s, tx, ty),
    screenToWorld(-padX, h + padY, s, tx, ty),
    screenToWorld(w + padX, h + padY, s, tx, ty)
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  if (extraWorld) {
    const dx = Math.cos(heading) * extraWorld;
    const dy = Math.sin(heading) * extraWorld;
    if (dx >= 0) maxX += dx; else minX += dx;
    if (dy >= 0) maxY += dy; else minY += dy;
  }
  return { minX, minY, maxX, maxY };
}

function worldBoundsToMercator(b) {
  const pts = [
    canvasToMercator(b.minX, b.minY),
    canvasToMercator(b.maxX, b.minY),
    canvasToMercator(b.minX, b.maxY),
    canvasToMercator(b.maxX, b.maxY)
  ];
  return {
    minX: Math.min(pts[0].x, pts[1].x, pts[2].x, pts[3].x),
    maxX: Math.max(pts[0].x, pts[1].x, pts[2].x, pts[3].x),
    minY: Math.min(pts[0].y, pts[1].y, pts[2].y, pts[3].y),
    maxY: Math.max(pts[0].y, pts[1].y, pts[2].y, pts[3].y)
  };
}

function tileRangeAtZoom(z, merc, tZoom) {
  const k = Math.pow(2, z - tZoom);
  return {
    z,
    tx0: Math.floor(merc.minX * k / 256),
    tx1: Math.floor(merc.maxX * k / 256),
    ty0: Math.floor(merc.minY * k / 256),
    ty1: Math.floor(merc.maxY * k / 256)
  };
}

function chooseDrawZoom(merc, tZoom) {
  let z = tZoom;
  for (;;) {
    const r = tileRangeAtZoom(z, merc, tZoom);
    const count = (r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1);
    if (count <= GEO_TILE_BUDGET || z <= 8) return r;
    z -= 1;
  }
}

function requestGeoTile(z, x, y, priority) {
  if (z < 0 || z > 19) return null;
  const n = 1 << z;
  if (y < 0 || y >= n) return null;
  x = wrapTileX(x, z);
  const key = geoTileKey(z, x, y);
  let e = geoTileCache.get(key);
  if (e) {
    e.lastUsed = performance.now();
    if (priority < e.priority) e.priority = priority;
    return e;
  }
  e = {
    status: 'queued',
    img: null,
    z, x, y,
    lastUsed: performance.now(),
    priority
  };
  geoTileCache.set(key, e);
  pumpGeoTileQueue();
  return e;
}

function pumpGeoTileQueue() {
  let inflight = 0;
  for (const e of geoTileCache.values()) {
    if (e.status === 'loading') inflight++;
  }
  while (inflight < GEO_MAX_INFLIGHT) {
    let best = null;
    for (const e of geoTileCache.values()) {
      if (e.status !== 'queued') continue;
      if (!best ||
          e.priority < best.priority ||
          (e.priority === best.priority && e.lastUsed > best.lastUsed)) {
        best = e;
      }
    }
    if (!best) break;
    best.status = 'loading';
    inflight++;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      best.img = img;
      best.status = 'ok';
      pumpGeoTileQueue();
    };
    img.onerror = () => {
      best.status = 'error';
      pumpGeoTileQueue();
    };
    img.src = `${GEO_TILE_URL}/${best.z}/${best.y}/${best.x}`;
  }
}

function pruneGeoTileCache(keepKeys) {
  if (geoTileCache.size <= GEO_TILE_CACHE_MAX) return;
  const entries = [];
  for (const [k, e] of geoTileCache) {
    if (e.status === 'loading') continue;
    entries.push([k, e]);
  }
  entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [k] of entries) {
    if (geoTileCache.size <= GEO_TILE_CACHE_MAX) break;
    if (keepKeys.has(k)) continue;
    geoTileCache.delete(k);
  }
}

function tileWorldRect(z, x, y) {
  const t = geoCanvasTransform;
  const s = Math.pow(2, t.zoom - z);
  const wx0 = x * 256 * s;
  const wy0 = y * 256 * s;
  const p0 = mercatorToCanvas(wx0, wy0);
  const p1 = mercatorToCanvas(wx0 + 256 * s, wy0 + 256 * s);
  return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
}

function drawCachedTileImage(z, x, y, dest) {
  x = wrapTileX(x, z);
  const e = geoTileCache.get(geoTileKey(z, x, y));
  if (e?.status === 'ok' && e.img) {
    ctx.drawImage(e.img, dest.x, dest.y, dest.w, dest.h);
    e.lastUsed = performance.now();
    return true;
  }
  return false;
}

function drawTileWithFallback(z, x, y) {
  const dest = tileWorldRect(z, x, y);
  if (drawCachedTileImage(z, x, y, dest)) return true;

  for (let k = 1; k <= 6 && z - k >= 8; k++) {
    const pz = z - k;
    const px = x >> k;
    const py = y >> k;
    const e = geoTileCache.get(geoTileKey(pz, wrapTileX(px, pz), py));
    if (e?.status === 'ok' && e.img) {
      const frac = 256 / (1 << k);
      const sx = (x - (px << k)) * frac;
      const sy = (y - (py << k)) * frac;
      ctx.drawImage(e.img, sx, sy, frac, frac, dest.x, dest.y, dest.w, dest.h);
      e.lastUsed = performance.now();
      return true;
    }
  }

  const cz = z + 1;
  if (cz <= 19) {
    let any = false;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cd = {
          x: dest.x + dest.w * dx / 2,
          y: dest.y + dest.h * dy / 2,
          w: dest.w / 2,
          h: dest.h / 2
        };
        if (drawCachedTileImage(cz, x * 2 + dx, y * 2 + dy, cd)) any = true;
      }
    }
    if (any) return true;
  }
  return false;
}

function geoLookaheadWorld() {
  const mps = (speed * speedConversion) / 3.6;
  return mps * GEO_LOOKAHEAD_SEC * pixelsPerMeter();
}

function currentGeoTilePlan(forPrefetch) {
  if (!geoCanvasTransform || !canvas.width) return null;
  const tZoom = geoCanvasTransform.zoom;
  let s, tx, ty;
  if (forPrefetch) {
    const target = followTargetScale();
    const cur = followCam.scale || 1;
    const rsx = pos.x * cur + followCam.tx;
    const rsy = pos.y * cur + followCam.ty;
    s = target;
    tx = rsx - pos.x * target;
    ty = rsy - pos.y * target;
  }
  const look = forPrefetch ? geoLookaheadWorld() : 0;
  const world = cameraWorldBounds(forPrefetch ? 0.15 : 0.06, look, s, tx, ty);
  const merc = worldBoundsToMercator(world);
  const range = chooseDrawZoom(merc, tZoom);
  if (!forPrefetch) return range;

  const tilePx = 256 * Math.pow(2, tZoom - range.z) * geoCanvasTransform.scale;
  const extra = Math.max(GEO_PREFETCH_PAD_TILES, Math.ceil(look / Math.max(tilePx, 1)));
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  range.tx0 -= GEO_PREFETCH_PAD_TILES + (hx < -0.3 ? extra : 0);
  range.tx1 += GEO_PREFETCH_PAD_TILES + (hx > 0.3 ? extra : 0);
  range.ty0 -= GEO_PREFETCH_PAD_TILES + (hy < -0.3 ? extra : 0);
  range.ty1 += GEO_PREFETCH_PAD_TILES + (hy > 0.3 ? extra : 0);
  return range;
}

function enqueueTileRange(range, basePriority) {
  if (!range) return new Set();
  const n = 1 << range.z;
  const keep = new Set();
  for (let ty = range.ty0; ty <= range.ty1; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = range.tx0; tx <= range.tx1; tx++) {
      const e = requestGeoTile(range.z, tx, ty, basePriority);
      if (e) keep.add(geoTileKey(e.z, e.x, e.y));
    }
  }
  // Low-res parents so zoom-out / first pan has coverage while children load
  if (range.z > 8) {
    const pz = range.z - 1;
    const pn = 1 << pz;
    for (let ty = range.ty0 >> 1; ty <= range.ty1 >> 1; ty++) {
      if (ty < 0 || ty >= pn) continue;
      for (let tx = range.tx0 >> 1; tx <= range.tx1 >> 1; tx++) {
        const e = requestGeoTile(pz, tx, ty, basePriority + 2);
        if (e) keep.add(geoTileKey(e.z, e.x, e.y));
      }
    }
  }
  return keep;
}

function prefetchGeoTiles() {
  if (!geoCanvasTransform) {
    updateGeoAttribution(false);
    return;
  }
  const keep = enqueueTileRange(currentGeoTilePlan(true), 1) || new Set();
  pruneGeoTileCache(keep);
}

function drawGeoTiles() {
  if (!geoCanvasTransform) {
    updateGeoAttribution(false);
    return false;
  }
  const vis = currentGeoTilePlan(false);
  const pre = currentGeoTilePlan(true);
  const keep = enqueueTileRange(pre, 1) || new Set();
  const visKeep = enqueueTileRange(vis, 0);
  if (visKeep) visKeep.forEach(k => keep.add(k));

  let drawn = false;
  if (vis) {
    const n = 1 << vis.z;
    for (let ty = vis.ty0; ty <= vis.ty1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = vis.tx0; tx <= vis.tx1; tx++) {
        if (drawTileWithFallback(vis.z, tx, ty)) drawn = true;
      }
    }
  }
  pruneGeoTileCache(keep);
  updateGeoAttribution(drawn);
  return drawn;
}

// --- Audio Manager ---
const AudioManager = {
    sounds: {
        wind: document.getElementById('windAudio'),
        music: document.getElementById('musicAudio'),
        boomStop: document.getElementById('boomStopAudio'),
        collision: document.getElementById('collisionAudio')
    },
    
    init() {
        // Set up audio elements
        this.sounds.music.loop = true;
        this.sounds.wind.loop = true;
        
        // Start wind sound with zero volume
        this.sounds.wind.volume = 0;
        this.playSound('wind').catch(err => console.warn('Failed to start wind sound:', err));
        
        // Add error handlers
        Object.values(this.sounds).forEach(audio => {
            audio.addEventListener('error', (e) => {
                console.warn('Audio error:', e);
            });
        });
        
        // Add ended handler for wind sound to ensure it keeps playing
        this.sounds.wind.addEventListener('ended', () => {
            this.playSound('wind').catch(err => console.warn('Wind sound restart failed:', err));
        });
    },
    
    ensureWindPlaying() {
        const wind = this.sounds.wind;
        if (wind.paused) {
            this.playSound('wind').catch(err => console.warn('Failed to resume wind sound:', err));
        }
    },
    
    playSound(soundId, options = {}) {
        const sound = this.sounds[soundId];
        if (!sound) {
            console.warn(`Sound not found: ${soundId}`);
            return Promise.reject(new Error(`Sound not found: ${soundId}`));
        }
        
        return new Promise((resolve, reject) => {
            try {
                // Reset the sound to beginning
                sound.currentTime = 0;
                
                // Set volume if specified
                if (typeof options.volume === 'number') {
                    sound.volume = Math.max(0, Math.min(1, options.volume));
                }
                
                // Play the sound
                const playPromise = sound.play();
                
                if (playPromise !== undefined) {
                    playPromise
                        .then(() => resolve())
                        .catch(error => {
                            console.warn(`Failed to play ${soundId}:`, error);
                            reject(error);
                        });
      } else {
                    resolve();
                }
            } catch (error) {
                console.warn(`Error playing ${soundId}:`, error);
                reject(error);
            }
        });
    },
    
    stopSound(soundId) {
        const sound = this.sounds[soundId];
        if (!sound) return;
        
        try {
            sound.pause();
            sound.currentTime = 0;
        } catch (error) {
            console.warn(`Error stopping ${soundId}:`, error);
        }
    },
    
    fadeOutMusic(duration = 2000) {
        const music = this.sounds.music;
        if (!music || music.paused) return;
        
        let volume = music.volume;
        const steps = 50;
        const step = 1 / steps;
        const interval = duration / steps;
        
        const fade = () => {
            volume = Math.max(0, volume - step);
            music.volume = volume;
            
            if (volume > 0) {
                setTimeout(fade, interval);
            } else {
                this.stopSound('music');
                music.volume = 1.0; // Reset volume for next play
            }
        };
        
        fade();
    },

    pauseMusic() {
        const music = this.sounds.music;
        if (!music || music.paused) return;
        try { music.pause(); } catch (error) {
            console.warn('Error pausing music:', error);
        }
    },

    resumeMusic() {
        const music = this.sounds.music;
        if (!music || !music.paused) return;
        music.play().catch(err => console.warn('Failed to resume music:', err));
    },

    pauseWind() {
        const wind = this.sounds.wind;
        if (!wind || wind.paused) return;
        try { wind.pause(); } catch (error) {
            console.warn('Error pausing wind:', error);
        }
    }
};

// Initialize audio manager
AudioManager.init();

// --- Canvas Resize ---
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  computeBuoys();
  resetFollowCamera();
}
window.addEventListener('resize', resizeCanvas);

function savedTrackKey(id) {
  return 'saved_' + id;
}

function rememberLastRide(key) {
  if (key && key.startsWith('saved_')) {
    localStorage.setItem(LAST_RIDE_STORAGE_KEY, key.slice('saved_'.length));
  }
}

function trackFromPreset(preset) {
  const track = JSON.parse(JSON.stringify(preset.track));
  track.name = preset.name || track.name;
  const geo = geoFromSavedEntry(preset);
  if (geo) {
    const rotationDeg = Number(track.geo?.rotationDeg);
    track.geo = {
      origin: { ...geo.origin },
      rotationDeg: Number.isFinite(rotationDeg) ? rotationDeg : (geo.rotationDeg || 0)
    };
  }
  return track;
}

function hydrateSavedTracks() {
  loadUserTrackPresets().forEach(p => {
    registerCustomTrack(savedTrackKey(p.id), trackFromPreset(p));
  });
}

// --- Custom Track Registration (from designer / share links) ---
function registerCustomTrack(key, track) {
  normalizeTrack(track);
  if (!track.name || !String(track.name).trim()) track.name = 'Custom Track';
  trackConfigs[key] = track;
  installTrackRacingGhosts(key, track);
  if (!availableTrackKeys.includes(key)) availableTrackKeys.push(key);
}

function resetRideForNewTrack() {
  speed = 0;
  bankAngleDeg = 0;
  wakeTrail = [];
  lapActive = false;
  validCrossing = false;
  idealLineData = null;
  showIdealLine = false;
  ghostWakeTrail = [];
  zoomStopIndex = 0;
  const music = AudioManager.sounds.music;
  if (music && !music.paused) {
    music.pause();
    music.currentTime = 0;
  }
}

function selectTrack(key) {
  if (!trackConfigs[key]) return;
  currentTrackKey = key;
  currentTrack = trackConfigs[key];
  window.currentTrackKey = key;
  rememberLastRide(key);
  resetRideForNewTrack();
  computeBuoys();
  placePlayerAtStart();
  if (currentTrack?.racingLines?.some(l => l.ghost?.frames?.length)) {
    if (!keepCurrentGhost || !currentGhost) {
      applyChaseGhostFromTrack(currentTrack);
    }
  } else {
    currentGhost = ghostDataMap.get(currentTrackKey) || null;
    activeChaseLineId = null;
    updateLineGhostSelector(currentTrack);
  }
  updateGhostStats();
  updateRacingLineToggleVisibility();
  if (key !== 'custom') {
    const url = new URL(window.location);
    url.searchParams.set('track', currentTrackKey);
    url.searchParams.delete('data');
    window.history.replaceState({}, '', url);
  }
}

// --- World atlas (T) ---
const ATLAS_WORLD = { lat: 22, lng: 12, zoom: 2.35 };
const ATLAS_TRANSITION_MS = 6000;
const ATLAS_ZOOM_STOPS = [3, 6, 9, 12, 15, 17, 18];
const ATLAS_LAYER_TILE_MAX = 96;
const ATLAS_ZOOM_ARRIVE = 0.62;
const RIDE_REVEAL_MS = 500;
const INTRO_STAGGER_MS = 100;
const INTRO_LINE_MS = 10000;
const INTRO_LINE_CAM_TAU = 0.62;
let rideOverlay = 1;
let rideOverlayFrom = 1;
let rideOverlayTo = 1;
let rideOverlayT0 = 0;
let rideOverlayPending = false;
let rideConcealDone = null;
let rideIntroActive = false;
let rideIntroPending = false;
let rideIntroT0 = 0;
let rideIntroFrame = null;
let introCamReturning = false;
const rideHudEls = [
  document.getElementById('lapTimeDisplay'),
  document.getElementById('speedDisplay'),
  document.getElementById('bankAngleDisplay'),
  document.getElementById('lapHistory'),
  document.getElementById('ghostInfo'),
  document.getElementById('ghostControls')
].filter(Boolean);
const ATLAS_DOT_R = 9;
const ATLAS_HIT_R = 22;
const ATLAS_HIT_R_TOUCH = 48;
const atlasEls = {
  hud: document.getElementById('atlasHud'),
  card: document.getElementById('atlasCard'),
  layouts: document.getElementById('atlasLayouts'),
  layoutsBtn: document.getElementById('atlasLayoutsBtn'),
  empty: document.getElementById('atlasEmpty'),
  confirm: document.getElementById('atlasConfirm'),
  hint: document.getElementById('atlasHint')
};
const atlas = {
  open: false,
  view: { ...ATLAS_WORLD },
  anim: null,
  pins: [],
  layouts: [],
  selectedKey: null,
  hoverKey: null,
  openedAt: 0,
  usedTouch: false,
  ignoreClickUntil: 0,
  concealing: false,
  pendingFrom: null,
  pointers: new Map(),
  pinchStartDist: 0,
  pinchFired: false,
  tap: null
};

function escAtlas(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function atlasEaseInOut(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function atlasLogLerp(a, b, t) {
  const a0 = Math.max(0.5, a);
  const b0 = Math.max(0.5, b);
  return Math.exp(Math.log(a0) + (Math.log(b0) - Math.log(a0)) * t);
}

function atlasScreenCenter() {
  return { x: canvas.width / 2, y: canvas.height / 2 };
}

/** Camera so `lat/lng` sits at a screen pixel — zoom is always toward that point. */
function atlasViewLookingAt(lat, lng, zoom, screenX, screenY) {
  const world = latLngToWorldPx(lat, lng, zoom);
  const cx = world.x - (screenX - canvas.width / 2);
  const cy = world.y - (screenY - canvas.height / 2);
  const ll = worldPxToLatLng(cx, cy, zoom);
  return { lat: ll.lat, lng: ll.lng, zoom };
}

function atlasEffectiveZoomForTrack(track) {
  if (!hasGeo(track) || !canvas.width || !canvas.height) return 12.5;
  const geo = track.geo;
  const latRad = geo.origin.lat * Math.PI / 180;
  let z = Math.round(Math.log2(156543.03392 * Math.cos(latRad) / 0.25));
  z = Math.max(12, Math.min(19, z));
  const m0 = latLngToWorldPx(geo.origin.lat, geo.origin.lng, z);
  const ll1 = metersToLatLng(geo, 100, 0);
  const m1 = latLngToWorldPx(ll1.lat, ll1.lng, z);
  const mercPerM = Math.hypot(m1.x - m0.x, m1.y - m0.y) / 100;
  const targetPpm = Math.min(canvas.width, canvas.height) / RACE_VIEW_METERS;
  const scale = mercPerM > 0 ? targetPpm / mercPerM : 1;
  return z + Math.log2(Math.max(0.02, scale));
}

/** Lat/lng the ride camera frames: start position, not the geo origin pin. */
function atlasRideLookLatLng(track) {
  if (!hasGeo(track)) return null;
  const sp = track.startPosition;
  if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.y)) {
    return metersToLatLng(track.geo, sp.x, sp.y);
  }
  return { lat: track.geo.origin.lat, lng: track.geo.origin.lng };
}

function cameraLookLatLng() {
  if (hasGeo(currentTrack) && geoCanvasTransform && canvas.width) {
    const s = followCam.scale || 1;
    const wx = (canvas.width / 2 - followCam.tx) / s;
    const wy = (canvas.height / 2 - followCam.ty) / s;
    const merc = canvasToMercator(wx, wy);
    return worldPxToLatLng(merc.x, merc.y, geoCanvasTransform.zoom);
  }
  if (hasGeo(currentTrack)) return atlasRideLookLatLng(currentTrack);
  return { lat: ATLAS_WORLD.lat, lng: ATLAS_WORLD.lng };
}

function atlasZoomProgress(u, fromZoom, toZoom) {
  const goingIn = toZoom > fromZoom + 0.2;
  if (!goingIn) return atlasEaseInOut(u);
  const zU = Math.min(1, u / ATLAS_ZOOM_ARRIVE);
  return atlasEaseInOut(zU);
}

function startAtlasFocusAnim({ lat, lng, fromZoom, toZoom, fromScreen, toScreen, onDone }) {
  atlas.anim = {
    lat,
    lng,
    fromZoom,
    toZoom,
    fromScreen: { x: fromScreen.x, y: fromScreen.y },
    toScreen: { x: toScreen.x, y: toScreen.y },
    t0: performance.now(),
    dur: ATLAS_TRANSITION_MS,
    onDone: onDone || null
  };
  prefetchAtlasStops(lat, lng, fromZoom, toZoom);
}

function cameraLatLngZoom() {
  if (hasGeo(currentTrack) && geoCanvasTransform) {
    const look = cameraLookLatLng();
    const scale = (geoCanvasTransform.scale || 1) * (followCam.scale || 1);
    return {
      lat: look.lat,
      lng: look.lng,
      zoom: geoCanvasTransform.zoom + Math.log2(Math.max(0.02, scale))
    };
  }
  return { ...ATLAS_WORLD };
}

function buildAtlasPins() {
  const presets = loadUserTrackPresets();
  const byKey = new Map();
  const layouts = [];
  for (const p of presets) {
    const ll = presetGeoLatLng(p);
    if (!ll) {
      layouts.push(p);
      continue;
    }
    const g = countryGroupForPlace(p.place);
    const key = g.code || '__geo__';
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        code: g.code,
        name: g.code ? g.name : 'On the map',
        flag: countryFlagEmoji(g.code),
        presets: [],
        lat: 0,
        lng: 0
      });
    }
    const bucket = byKey.get(key);
    bucket.presets.push(p);
    bucket.lat += ll.lat;
    bucket.lng += ll.lng;
  }
  const pins = [...byKey.values()].map(b => {
    b.presets.sort((a, c) =>
      String(a.name || '').localeCompare(String(c.name || ''), 'en', { sensitivity: 'base' })
    );
    return {
      ...b,
      lat: b.lat / b.presets.length,
      lng: b.lng / b.presets.length
    };
  });
  pins.sort((a, b) => a.lng - b.lng);
  return { pins, layouts };
}

function currentAtlasCountryKey() {
  if (!currentTrackKey.startsWith('saved_')) return null;
  const id = currentTrackKey.slice('saved_'.length);
  const pin = atlas.pins.find(p => p.presets.some(t => t.id === id));
  return pin ? pin.key : null;
}

function atlasLatLngToScreen(lat, lng, view) {
  const world = latLngToWorldPx(lat, lng, view.zoom);
  const c = latLngToWorldPx(view.lat, view.lng, view.zoom);
  return {
    x: canvas.width / 2 + (world.x - c.x),
    y: canvas.height / 2 + (world.y - c.y)
  };
}

function pinOpacity(pin, index, now) {
  const t = (now - atlas.openedAt) / 1000;
  const start = ATLAS_TRANSITION_MS / 1000 * 0.72 + index * 0.08;
  let a = Math.max(0, Math.min(1, (t - start) / 0.55));
  if (atlas.anim && atlas.anim.toZoom > atlas.anim.fromZoom + 0.2) {
    const u = Math.min(1, (now - atlas.anim.t0) / atlas.anim.dur);
    a *= 1 - atlasZoomProgress(u, atlas.anim.fromZoom, atlas.anim.toZoom);
  }
  return a;
}

function activateAtlasPin(pin) {
  if (!pin?.presets?.length) return;
  if (atlas.selectedKey === pin.key) {
    diveToPreset(pin.presets[0]);
    return;
  }
  showAtlasCountry(pin);
}

function hitAtlasPin(sx, sy) {
  let best = null;
  let bestD = atlas.usedTouch ? ATLAS_HIT_R_TOUCH : ATLAS_HIT_R;
  atlas.pins.forEach((pin, i) => {
    if (pinOpacity(pin, i, performance.now()) < 0.4) return;
    const p = atlasLatLngToScreen(pin.lat, pin.lng, atlas.view);
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d < bestD) {
      best = pin;
      bestD = d;
    }
  });
  return best;
}

function atlasPinsInteractive() {
  if (atlas.anim && atlas.anim.toZoom < atlas.anim.fromZoom - 0.2) return false;
  return atlas.pins.some((pin, i) => pinOpacity(pin, i, performance.now()) >= 0.4);
}

function atlasChromeTarget(el) {
  return !!(el && el.closest && el.closest('#atlasCard, #atlasLayouts, #atlasLayoutsBtn, #atlasEmpty, #atlasConfirm'));
}

function resetAtlasPointers() {
  atlas.pointers.clear();
  atlas.pinchStartDist = 0;
  atlas.pinchFired = false;
  atlas.tap = null;
}

function atlasPointerCenterAndDist() {
  const pts = [...atlas.pointers.values()];
  if (pts.length < 2) return { dist: 0, x: 0, y: 0 };
  const a = pts[0], b = pts[1];
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  };
}

function atlasPinchZoomToCurrent() {
  if (!atlas.open || atlas.concealing) return;
  if (atlas.anim && atlas.anim.toZoom > atlas.anim.fromZoom + 0.2) return;
  closeAtlas();
}

function contactsAreViewPinch(points) {
  if (!points || points.length !== 2) return false;
  const w = window.innerWidth;
  const a = points[0], b = points[1];
  const left = w * 0.25;
  const right = w * 0.75;
  if (a.x < left || a.x > right || b.x < left || b.x > right) return false;
  // Two-thumb racing sits on opposite halves and is far apart — never a pinch.
  const split = (a.x - w / 2) * (b.x - w / 2) < 0;
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  if (split && dist > w * 0.28) return false;
  return true;
}

function handleAtlasPinch() {
  const pts = [...atlas.pointers.values()];
  if (!contactsAreViewPinch(pts)) return;
  const cd = atlasPointerCenterAndDist();
  if (cd.dist < 8) return;
  if (atlas.pinchStartDist < 8) {
    atlas.pinchStartDist = cd.dist;
    return;
  }
  if (atlas.pinchFired) return;
  const ratio = cd.dist / atlas.pinchStartDist;
  // Same as race: spread (pinch out) zooms in — here, back to the pulsating current course.
  if (ratio > 1.18) {
    atlas.pinchFired = true;
    atlasPinchZoomToCurrent();
  }
}

function closeAtlasCards() {
  atlas.selectedKey = null;
  atlasEls.card.classList.remove('open');
  atlasEls.layouts.classList.remove('open');
  atlasEls.card.innerHTML = '';
  atlasEls.layouts.innerHTML = '';
}

function renderAtlasTrackList(host, title, flag, presets) {
  const tracks = presets.map(p =>
    `<button type="button" data-track-id="${escAtlas(p.id)}">${escAtlas(p.name || 'Untitled')}</button>`
  ).join('');
  host.innerHTML =
    `<div class="atlas-card-head">` +
    (flag ? `<span class="atlas-flag">${flag}</span>` : '') +
    `<span>${escAtlas(title)}</span></div>` +
    `<div class="atlas-card-list">${tracks}</div>`;
  host.classList.add('open');
}

function showAtlasCountry(pin) {
  atlas.selectedKey = pin.key;
  atlasEls.layouts.classList.remove('open');
  renderAtlasTrackList(atlasEls.card, pin.name, pin.flag, pin.presets);
}

function showAtlasLayouts() {
  atlas.selectedKey = '__layouts__';
  atlasEls.card.classList.remove('open');
  renderAtlasTrackList(atlasEls.layouts, 'Layouts', '', atlas.layouts);
}

function refreshAtlasChrome() {
  const { pins, layouts } = buildAtlasPins();
  atlas.pins = pins;
  atlas.layouts = layouts;
  const empty = !pins.length && !layouts.length;
  atlasEls.empty.classList.toggle('open', empty);
  atlasEls.layoutsBtn.classList.toggle('show', layouts.length > 0 && !empty);
  if (atlas.selectedKey === '__layouts__') {
    if (layouts.length) showAtlasLayouts();
    else closeAtlasCards();
  } else if (atlas.selectedKey) {
    const pin = pins.find(p => p.key === atlas.selectedKey);
    if (pin) showAtlasCountry(pin);
    else closeAtlasCards();
  }
}

function setRideHudOpacity(a) {
  const v = Math.max(0, Math.min(1, a));
  const events = v >= 0.99 ? '' : 'none';
  rideHudEls.forEach(el => {
    el.style.opacity = String(v);
    el.style.pointerEvents = events;
  });
}

function rideOverlayEase(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function startRideReveal() {
  rideConcealDone = null;
  rideOverlay = 1;
  rideOverlayFrom = 1;
  rideOverlayTo = 1;
  rideOverlayT0 = 0;
  rideOverlayPending = false;
  rideIntroActive = true;
  rideIntroPending = true;
  rideIntroT0 = 0;
  rideIntroFrame = null;
  introCamReturning = false;
  if (trackHasRacingLines(currentTrack)) setShowRacingLines(true);
  setRideHudOpacity(0);
}

function startRideConceal(onDone) {
  rideIntroActive = false;
  rideIntroPending = false;
  rideIntroT0 = 0;
  rideIntroFrame = null;
  introCamReturning = false;
  rideConcealDone = onDone || null;
  if (rideOverlay <= 0.001) {
    rideOverlay = 0;
    rideOverlayFrom = 0;
    rideOverlayTo = 0;
    rideOverlayT0 = 0;
    rideOverlayPending = false;
    setRideHudOpacity(0);
    if (onDone) onDone();
    return;
  }
  rideOverlayFrom = rideOverlay;
  rideOverlayTo = 0;
  rideOverlayPending = true;
  rideOverlayT0 = 0;
}

function stepRideOverlay(now) {
  if (rideOverlayPending) {
    rideOverlayPending = false;
    rideOverlayT0 = now;
    rideOverlay = rideOverlayFrom;
    setRideHudOpacity(rideOverlay);
    return rideOverlay;
  }
  if (!rideOverlayT0) {
    rideOverlay = rideOverlayTo;
    return rideOverlay;
  }
  const t = (now - rideOverlayT0) / RIDE_REVEAL_MS;
  if (t <= 0) {
    rideOverlay = rideOverlayFrom;
    setRideHudOpacity(rideOverlay);
    return rideOverlay;
  }
  if (t >= 1) {
    rideOverlay = rideOverlayTo;
    rideOverlayT0 = 0;
    setRideHudOpacity(rideOverlay);
    const done = rideConcealDone;
    rideConcealDone = null;
    if (done) done();
    return rideOverlay;
  }
  const e = rideOverlayEase(t);
  rideOverlay = rideOverlayFrom + (rideOverlayTo - rideOverlayFrom) * e;
  setRideHudOpacity(rideOverlay);
  return rideOverlay;
}

function stepRideIntro(now) {
  if (!rideIntroActive) return;
  if (rideIntroPending) {
    rideIntroPending = false;
    rideIntroT0 = now;
  }
}

function introFadeAt(ageMs, startMs) {
  const u = Math.max(0, Math.min(1, (ageMs - startMs) / RIDE_REVEAL_MS));
  return rideOverlayEase(u);
}

function turnBuoysInOrder() {
  return buoys
    .filter(b => b.turnIndex != null)
    .sort((a, b) => a.turnIndex - b.turnIndex);
}

function introFocusRacingLine() {
  if (!showRacingLines) return null;
  const vis = (currentTrack?.racingLines || []).filter(
    l => l.visible !== false && l.points?.length >= 2
  );
  if (!vis.length) return null;
  return vis.find(l => l.chase) || vis[0];
}

function getRideIntro(now) {
  if (!rideIntroActive) return null;
  if (!rideIntroT0) {
    return {
      gates: 0,
      turnFade: () => 0,
      turns: [],
      markers: 0,
      rider: 0,
      lineProg: 0,
      line: null,
      hud: 0
    };
  }
  const age = now - rideIntroT0;
  const turns = turnBuoysInOrder();
  const gates = introFadeAt(age, 0);
  const turnStart = RIDE_REVEAL_MS;
  const turnFade = i => introFadeAt(age, turnStart + i * INTRO_STAGGER_MS);
  const lastTurnStart = turns.length
    ? turnStart + (turns.length - 1) * INTRO_STAGGER_MS
    : 0;
  const markersStart = turns.length ? lastTurnStart + RIDE_REVEAL_MS : turnStart;
  const markers = introFadeAt(age, markersStart);
  const rider = markers;
  const hud = markers;
  const line = introFocusRacingLine();
  const lineStart = markersStart + RIDE_REVEAL_MS;
  const lineProg = line
    ? Math.max(0, Math.min(1, (age - lineStart) / INTRO_LINE_MS))
    : 1;
  if (gates >= 1 && markers >= 1 && lineProg >= 1) {
    rideIntroActive = false;
    setRideHudOpacity(1);
    return null;
  }
  return { gates, turnFade, turns, markers, rider, hud, line, lineProg };
}

function setAtlasOpen(on) {
  atlas.open = on;
  document.body.classList.toggle('atlas-open', on);
  canvas.style.cursor = '';
  if (atlasEls.hud) atlasEls.hud.style.cursor = '';
  if (atlasEls.hint) {
    atlasEls.hint.textContent = on
      ? (('ontouchstart' in window)
        ? 'Pinch out · current course · tap a country for tracks'
        : 'T or Esc to return')
      : 'T world map';
  }
  resetAtlasPointers();
  if (on) {
    setRideHudOpacity(0);
    return;
  }
  atlas.anim = null;
  atlas.hoverKey = null;
  atlas.concealing = false;
  closeAtlasCards();
  atlasEls.empty.classList.remove('open');
  atlasEls.layoutsBtn.classList.remove('show');
  atlasEls.confirm.classList.remove('open');
  startRideReveal();
  if (rideSimPaused && !lapActive) resumeRideSim({ music: false });
}

function pauseRideSim() {
  if (!rideSimPaused) {
    rideSimPaused = true;
    rideSimPauseAt = performance.now();
  }
  AudioManager.pauseMusic();
  AudioManager.pauseWind();
}

function resumeRideSim({ music = true } = {}) {
  if (rideSimPaused && rideSimPauseAt) {
    const held = performance.now() - rideSimPauseAt;
    if (lapActive && lapStartTime) lapStartTime += held;
    if (ghostPreviewStart) ghostPreviewStart += held;
  }
  rideSimPaused = false;
  rideSimPauseAt = 0;
  if (music) AudioManager.resumeMusic();
}

function showAtlasConfirm() {
  atlasEls.confirm.classList.add('open');
  pauseRideSim();
}

function hideAtlasConfirm() {
  atlasEls.confirm.classList.remove('open');
}

function keepRacingFromAtlasConfirm() {
  hideAtlasConfirm();
  resumeRideSim({ music: true });
}

function beginAtlasWorldFlight() {
  refreshAtlasChrome();
  const from = atlas.pendingFrom || cameraLatLngZoom();
  atlas.pendingFrom = null;
  const center = atlasScreenCenter();
  atlas.view = { ...from };
  atlas.openedAt = performance.now();
  startAtlasFocusAnim({
    lat: from.lat,
    lng: from.lng,
    fromZoom: from.zoom,
    toZoom: ATLAS_WORLD.zoom,
    fromScreen: center,
    toScreen: center
  });
  setAtlasOpen(true);
}

function openAtlas({ immediate } = {}) {
  if (atlas.open || atlas.concealing) return;
  hideAtlasConfirm();
  if (immediate) {
    refreshAtlasChrome();
    atlas.view = { ...ATLAS_WORLD };
    atlas.openedAt = performance.now() - ATLAS_TRANSITION_MS;
    rideOverlay = 0;
    rideOverlayFrom = 0;
    rideOverlayTo = 0;
    rideOverlayT0 = 0;
    rideConcealDone = null;
    setRideHudOpacity(0);
    setAtlasOpen(true);
    return;
  }
  atlas.pendingFrom = cameraLatLngZoom();
  atlas.concealing = true;
  startRideConceal(() => {
    atlas.concealing = false;
    beginAtlasWorldFlight();
  });
}

function closeAtlas() {
  if (!atlas.open) return;
  hideAtlasConfirm();
  closeAtlasCards();
  resetAtlasPointers();
  const to = cameraLatLngZoom();
  if (!hasGeo(currentTrack)) {
    setAtlasOpen(false);
    return;
  }
  const pin = atlasLatLngToScreen(to.lat, to.lng, atlas.view);
  startAtlasFocusAnim({
    lat: to.lat,
    lng: to.lng,
    fromZoom: atlas.view.zoom,
    toZoom: to.zoom,
    fromScreen: pin,
    toScreen: atlasScreenCenter(),
    onDone: () => setAtlasOpen(false)
  });
}

function requestAtlas() {
  if (atlas.concealing) return;
  if (atlas.open) {
    closeAtlas();
    return;
  }
  if (lapActive) {
    showAtlasConfirm();
    return;
  }
  openAtlas();
}

function diveToPreset(preset) {
  if (!preset?.track) return;
  resetAtlasPointers();
  const key = savedTrackKey(preset.id);
  registerCustomTrack(key, trackFromPreset(preset));
  closeAtlasCards();
  const track = trackConfigs[key] || trackFromPreset(preset);
  const look = atlasRideLookLatLng(track) || presetGeoLatLng(preset);
  if (!look) {
    selectTrack(key);
    setAtlasOpen(false);
    return;
  }
  const fromScreen = atlasLatLngToScreen(look.lat, look.lng, atlas.view);
  startAtlasFocusAnim({
    lat: look.lat,
    lng: look.lng,
    fromZoom: atlas.view.zoom,
    toZoom: atlasEffectiveZoomForTrack(track),
    fromScreen,
    toScreen: atlasScreenCenter(),
    onDone: () => {
      selectTrack(key);
      setAtlasOpen(false);
    }
  });
}

function stepAtlas(now) {
  if (!atlas.anim) return;
  const u = Math.min(1, (now - atlas.anim.t0) / atlas.anim.dur);
  const e = atlasZoomProgress(u, atlas.anim.fromZoom, atlas.anim.toZoom);
  const zoom = atlasLogLerp(atlas.anim.fromZoom, atlas.anim.toZoom, e);
  const sx = atlas.anim.fromScreen.x + (atlas.anim.toScreen.x - atlas.anim.fromScreen.x) * e;
  const sy = atlas.anim.fromScreen.y + (atlas.anim.toScreen.y - atlas.anim.fromScreen.y) * e;
  atlas.view = atlasViewLookingAt(atlas.anim.lat, atlas.anim.lng, zoom, sx, sy);
  if (u >= 1) {
    const done = atlas.anim.onDone;
    atlas.anim = null;
    if (done) done();
  }
}

function atlasLayerRect(lat, lng, viewZoom, z) {
  const scale = Math.pow(2, viewZoom - z);
  const tileSize = 256 * scale;
  const center = latLngToWorldPx(lat, lng, z);
  const ox = canvas.width / 2 - center.x * scale;
  const oy = canvas.height / 2 - center.y * scale;
  const n = 1 << z;
  return {
    z, scale, tileSize, ox, oy, n,
    tx0: Math.floor(-ox / tileSize) - 1,
    ty0: Math.max(0, Math.floor(-oy / tileSize) - 1),
    tx1: Math.ceil((canvas.width - ox) / tileSize) + 1,
    ty1: Math.min(n - 1, Math.ceil((canvas.height - oy) / tileSize) + 1)
  };
}

function atlasLayerTileCount(r) {
  return (r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1);
}

function atlasStopsInRange(fromZoom, toZoom) {
  const lo = Math.min(fromZoom, toZoom) - 1;
  const hi = Math.max(fromZoom, toZoom) + 1;
  const stops = ATLAS_ZOOM_STOPS.filter(z => z >= lo && z <= hi);
  const dest = Math.max(fromZoom, toZoom);
  if (dest >= 11) {
    const z0 = Math.max(12, Math.min(19, Math.floor(dest)));
    const z1 = Math.max(12, Math.min(19, Math.round(dest)));
    [z0, z1].forEach(z => {
      if (!stops.includes(z)) stops.push(z);
    });
  }
  stops.sort((a, b) => a - b);
  return stops;
}

function forEachAtlasLayerTile(r, fn) {
  for (let ty = r.ty0; ty <= r.ty1; ty++) {
    for (let tx = r.tx0; tx <= r.tx1; tx++) {
      fn(wrapTileX(tx, r.z), ty, tx);
    }
  }
}

function prefetchAtlasStops(lat, lng, fromZoom, toZoom) {
  const stops = atlasStopsInRange(fromZoom, toZoom).slice();
  stops.sort((a, b) => {
    const pa = Math.min(Math.abs(a - fromZoom), Math.abs(a - toZoom) * 0.35);
    const pb = Math.min(Math.abs(b - fromZoom), Math.abs(b - toZoom) * 0.35);
    return pa - pb;
  });
  stops.forEach((z, i) => {
    const r = atlasLayerRect(lat, lng, z, z);
    forEachAtlasLayerTile(r, (wx, ty) => {
      requestGeoTile(z, wx, ty, i);
    });
  });
}

function atlasKeepKeys(lat, lng, fromZoom, toZoom) {
  const keep = new Set();
  atlasStopsInRange(fromZoom, toZoom).forEach(z => {
    const r = atlasLayerRect(lat, lng, z, z);
    forEachAtlasLayerTile(r, (wx, ty) => {
      keep.add(geoTileKey(z, wx, ty));
    });
  });
  return keep;
}

function drawAtlasLayer(r, alpha, keep) {
  if (alpha <= 0.02) return false;
  let drawn = false;
  ctx.save();
  ctx.globalAlpha = alpha;
  forEachAtlasLayerTile(r, (wx, ty, tx) => {
    requestGeoTile(r.z, wx, ty, 0);
    const key = geoTileKey(r.z, wx, ty);
    keep.add(key);
    const e = geoTileCache.get(key);
    if (e?.status === 'ok' && e.img) {
      ctx.drawImage(
        e.img,
        r.ox + tx * r.tileSize,
        r.oy + ty * r.tileSize,
        r.tileSize,
        r.tileSize
      );
      drawn = true;
    }
  });
  ctx.restore();
  return drawn;
}

function drawWorldTiles(lat, lng, zoom) {
  const fromZ = atlas.anim ? atlas.anim.fromZoom : zoom;
  const toZ = atlas.anim ? atlas.anim.toZoom : zoom;
  const stops = atlasStopsInRange(fromZ, toZ);
  const keep = atlasKeepKeys(
    atlas.anim ? atlas.anim.lat : lat,
    atlas.anim ? atlas.anim.lng : lng,
    fromZ,
    toZ
  );

  let base = stops[0] ?? ATLAS_ZOOM_STOPS[0];
  for (const z of stops) {
    if (z > zoom + 0.05) break;
    const r = atlasLayerRect(lat, lng, zoom, z);
    if (atlasLayerTileCount(r) <= ATLAS_LAYER_TILE_MAX) base = z;
  }
  const next = stops.find(z => z > base) ?? base;

  const baseRect = atlasLayerRect(lat, lng, zoom, base);
  let drawn = drawAtlasLayer(baseRect, 1, keep);

  if (next !== base) {
    const nextRect = atlasLayerRect(lat, lng, zoom, next);
    if (atlasLayerTileCount(nextRect) <= ATLAS_LAYER_TILE_MAX) {
      const span = Math.max(0.35, next - base);
      const t = Math.max(0, Math.min(1, (zoom - base + span * 0.15) / span));
      const fade = t * t * (3 - 2 * t);
      if (drawAtlasLayer(nextRect, fade, keep)) drawn = true;
    }
  }

  pruneGeoTileCache(keep);
  updateGeoAttribution(drawn);
}

function drawAtlas() {
  const v = atlas.view;
  ctx.fillStyle = '#0c1a22';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawWorldTiles(v.lat, v.lng, v.zoom);
  ctx.fillStyle = 'rgba(6,14,20,0.32)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const now = performance.now();
  const currentKey = currentAtlasCountryKey();
  atlas.pins.forEach((pin, i) => {
    const a = pinOpacity(pin, i, now);
    if (a <= 0) return;
    const p = atlasLatLngToScreen(pin.lat, pin.lng, v);
    const selected = atlas.selectedKey === pin.key || atlas.hoverKey === pin.key;
    const pulse = pin.key === currentKey
      ? 1 + 0.18 * Math.sin(now / 280)
      : 1;
    const r = ATLAS_DOT_R * pulse * (selected ? 1.15 : 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 213, 74, 0.22)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd54a';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    ctx.restore();
  });
}

function atlasPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function onAtlasMove(e) {
  if (!atlas.open || atlas.usedTouch) return;
  const { x, y } = atlasPointerPos(e);
  const pin = hitAtlasPin(x, y);
  atlas.hoverKey = pin ? pin.key : null;
  const pointer = pin ? 'pointer' : '';
  canvas.style.cursor = pointer;
  if (atlasEls.hud) atlasEls.hud.style.cursor = pointer;
  if (pin && atlas.selectedKey !== pin.key) showAtlasCountry(pin);
}

function onAtlasClick(e) {
  if (!atlas.open) return;
  if (atlasEls.confirm.classList.contains('open')) return;
  if (performance.now() < (atlas.ignoreClickUntil || 0)) return;
  const { x, y } = atlasPointerPos(e);
  const pin = hitAtlasPin(x, y);
  if (pin) {
    activateAtlasPin(pin);
    return;
  }
  if (!atlasPinsInteractive()) return;
  if (atlas.selectedKey) {
    closeAtlasCards();
    return;
  }
  closeAtlas();
}

function onAtlasTap(clientX, clientY) {
  atlas.usedTouch = true;
  if (performance.now() < (atlas.ignoreClickUntil || 0)) return;
  onAtlasClick({ clientX, clientY });
  atlas.ignoreClickUntil = performance.now() + 600;
}

function onAtlasPointerDown(e) {
  if (!atlas.open) return;
  if (atlasEls.confirm.classList.contains('open')) return;
  if (atlasChromeTarget(e.target)) return;
  e.preventDefault();
  atlas.usedTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
  atlas.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  if (atlas.pointers.size >= 2) {
    atlas.tap = null;
    const cd = atlasPointerCenterAndDist();
    atlas.pinchStartDist = cd.dist;
    atlas.pinchFired = false;
    return;
  }
  atlas.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
}

function onAtlasPointerMove(e) {
  if (!atlas.open) return;
  if (!atlas.pointers.has(e.pointerId)) {
    if (e.pointerType !== 'touch' && !atlasChromeTarget(e.target)) onAtlasMove(e);
    return;
  }
  atlas.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (atlas.pointers.size >= 2) {
    atlas.tap = null;
    handleAtlasPinch();
    return;
  }
  if (atlas.tap && atlas.tap.id === e.pointerId) {
    const d = Math.hypot(e.clientX - atlas.tap.x, e.clientY - atlas.tap.y);
    if (d > 16) atlas.tap.moved = true;
  } else if (e.pointerType !== 'touch') {
    onAtlasMove(e);
  }
}

function onAtlasPointerUp(e) {
  if (!atlas.open) return;
  const tap = atlas.tap;
  const wasTap = tap && tap.id === e.pointerId && !tap.moved && atlas.pointers.size <= 1 && !atlas.pinchFired;
  atlas.pointers.delete(e.pointerId);
  if (atlas.pointers.size < 2) {
    atlas.pinchStartDist = 0;
    atlas.pinchFired = false;
  }
  if (wasTap) {
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (touch) {
      onAtlasTap(tap.x, tap.y);
    } else {
      onAtlasClick({ clientX: tap.x, clientY: tap.y });
      atlas.ignoreClickUntil = performance.now() + 600;
    }
  }
  if (tap && tap.id === e.pointerId) atlas.tap = null;
}

if (atlasEls.layoutsBtn) {
  atlasEls.layoutsBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (atlas.selectedKey === '__layouts__') closeAtlasCards();
    else showAtlasLayouts();
  });
}
if (atlasEls.card) {
  atlasEls.card.addEventListener('click', e => {
    const btn = e.target.closest('[data-track-id]');
    if (btn) diveToPreset(loadUserTrackPresets().find(p => p.id === btn.getAttribute('data-track-id')));
  });
}
if (atlasEls.layouts) {
  atlasEls.layouts.addEventListener('click', e => {
    const btn = e.target.closest('[data-track-id]');
    if (btn) diveToPreset(loadUserTrackPresets().find(p => p.id === btn.getAttribute('data-track-id')));
  });
}
document.getElementById('atlasConfirmYes')?.addEventListener('click', () => {
  hideAtlasConfirm();
  lapActive = false;
  validCrossing = false;
  openAtlas();
});
document.getElementById('atlasConfirmNo')?.addEventListener('click', keepRacingFromAtlasConfirm);

if (atlasEls.hud) {
  const opts = { passive: false };
  atlasEls.hud.addEventListener('pointerdown', onAtlasPointerDown, opts);
  atlasEls.hud.addEventListener('pointermove', onAtlasPointerMove, opts);
  atlasEls.hud.addEventListener('pointerup', onAtlasPointerUp);
  atlasEls.hud.addEventListener('pointercancel', onAtlasPointerUp);
}

{
  const opts = { passive: false };
  canvas.addEventListener('pointerdown', onAtlasPointerDown, opts);
  canvas.addEventListener('pointermove', onAtlasPointerMove, opts);
  canvas.addEventListener('pointerup', onAtlasPointerUp);
  canvas.addEventListener('pointercancel', onAtlasPointerUp);
}
canvas.addEventListener('mousemove', onAtlasMove);
canvas.addEventListener('click', onAtlasClick);

function trackHasRacingLines(track) {
  return (track?.racingLines || []).some(l => l.visible !== false && l.points?.length >= 2);
}

function setShowRacingLines(on) {
  showRacingLines = !!on;
  const cb = document.getElementById('showRacingLines');
  if (cb) cb.checked = showRacingLines;
}

function setKeepCurrentGhost(on) {
  keepCurrentGhost = !!on;
  window.keepCurrentGhost = keepCurrentGhost;
  const cb = document.getElementById('keepGhost');
  if (cb) cb.checked = keepCurrentGhost;
}

function updateRacingLineToggleVisibility() {
  const row = document.getElementById('racingLineToggleRow');
  if (row) row.style.display = trackHasRacingLines(currentTrack) ? '' : 'none';
}

function installTrackRacingGhosts(trackKey, track) {
  if (!track?.racingLines) return;
  track.racingLines.forEach(line => {
    const ghost = ghostFromRacingLine(line);
    if (ghost) {
      ghost.trackKey = trackKey;
      ghostDataMap.set(`${trackKey}_${line.id}`, ghost);
    }
  });
  updateLineGhostSelector(track);
}

function applyChaseGhostFromTrack(track) {
  const line = chaseRacingLine(track);
  if (!line) return;
  const ghost = ghostFromRacingLine(line);
  if (!ghost) return;
  ghost.trackKey = currentTrackKey;
  currentGhost = ghost;
  activeChaseLineId = line.id;
  showGhost = true;
  const showGhostCheckbox = document.getElementById('showGhost');
  if (showGhostCheckbox) showGhostCheckbox.checked = true;
  updateLineGhostSelector(track);
}

function updateLineGhostSelector(track) {
  let sel = document.getElementById('lineGhostSelect');
  const linesWithGhost = (track?.racingLines || []).filter(l => l.ghost?.frames?.length);
  if (linesWithGhost.length <= 1) {
    if (sel) sel.remove();
    return;
  }
  const host = document.getElementById('ghostInfo');
  if (!host) return;
  if (!sel) {
    sel = document.createElement('select');
    sel.id = 'lineGhostSelect';
    sel.style.cssText = 'display:block; margin-top:4px; font-size:12px; max-width:220px;';
    host.appendChild(sel);
    sel.addEventListener('change', () => {
      const line = currentTrack.racingLines.find(l => l.id === sel.value);
      if (!line) return;
      const ghost = ghostFromRacingLine(line);
      if (!ghost) return;
      ghost.trackKey = currentTrackKey;
      currentGhost = ghost;
      activeChaseLineId = line.id;
      showGhost = true;
      updateGhostStats();
    });
  }
  sel.innerHTML = '';
  linesWithGhost.forEach(line => {
    const opt = document.createElement('option');
    opt.value = line.id;
    opt.textContent = line.name || line.id;
    if (line.id === activeChaseLineId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function showRecordLineBanner() {
  const line = currentTrack?.racingLines?.find(l => l.id === recordLineId);
  const name = line?.name || 'racing line';
  const banner = document.createElement('div');
  banner.id = 'recordLineBanner';
  banner.style.cssText = `
    position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 1000;
    background: rgba(124,252,0,0.92); color: #10300a; padding: 10px 18px;
    border-radius: 8px; font-family: sans-serif; font-size: 14px; font-weight: 600;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35); text-align: center; max-width: 92vw;
  `;
  banner.textContent = `Recording "${name}" — complete one clean lap (no buoy hits)`;
  document.body.appendChild(banner);
}

function showLineCaptureOverlay(lapTime, capture) {
  const overlay = document.createElement('div');
  overlay.id = 'lineCaptureOverlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.72);
    display: flex; align-items: center; justify-content: center; font-family: sans-serif;
  `;
  const box = document.createElement('div');
  box.style.cssText = `
    background: #1d242b; color: #e8eef3; border: 1px solid #303b46; border-radius: 12px;
    padding: 24px 28px; max-width: 420px; text-align: center;
  `;
  const pts = capture.points?.length || 0;
  box.innerHTML = `
    <h2 style="margin:0 0 8px; color:#7cfc00; font-size:20px;">Racing line captured</h2>
    <p style="margin:0 0 16px; color:#8fa3b3; font-size:14px; line-height:1.5;">
      Lap ${lapTime.toFixed(2)}s saved as <b>${capture.lineName || 'racing line'}</b>
      (${pts} path points + chase ghost).
    </p>
    <a href="designer.html" style="
      display:inline-block; background:#7cfc00; color:#10300a; font-weight:700;
      padding:10px 18px; border-radius:8px; text-decoration:none; font-size:14px;
    ">Return to Designer</a>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function addDesignerLink(text, href) {
  const link = document.getElementById('designerLink');
  if (!link) return;
  link.href = href;
  link.textContent = text;
}

// --- URL Parameter Handling ---
function parseURLParams() {
  const params = new URLSearchParams(window.location.search);

  if (params.has('data')) {
    // Shared custom track encoded in the URL
    const { track, errors } = decodeTrackFromParam(params.get('data'));
    if (track) {
      registerCustomTrack('custom', track);
      addDesignerLink('Open in Designer', 'designer.html?data=' + params.get('data'));
      selectTrack('custom');
    } else {
      console.warn('Could not load shared track:', errors);
      alert('Could not load the shared track:\n' + errors.join('\n'));
    }
  } else if (params.get('track') === 'draft') {
    // Draft handed over from the designer via localStorage
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw) {
      try {
        const track = JSON.parse(raw);
        if (!hasGeo(track)) {
          const match = loadUserTrackPresets().find(p =>
            (p.name || p.track?.name) === track.name);
          const geo = match ? geoFromSavedEntry(match) : null;
          if (geo) track.geo = geo;
        }
        registerCustomTrack('draft', track);
        addDesignerLink('\u2190 Back to Designer', 'designer.html');
        selectTrack('draft');
      } catch (e) {
        console.warn('Could not load draft track:', e);
      }
    }
  } else if (params.has('track')) {
    const trackFromURL = params.get('track');
    if (trackConfigs[trackFromURL]) {
      selectTrack(trackFromURL);
    } else if (trackConfigs[savedTrackKey(trackFromURL)]) {
      selectTrack(savedTrackKey(trackFromURL));
    }
  }

  // Check for fullscreen parameter
  if (params.has('fullscreen') && params.get('fullscreen') === 'true') {
    // Small delay to ensure everything is loaded
    setTimeout(() => {
      toggleFullScreen();
    }, 500);
  }

  if (params.has('recordLine')) {
    recordLineId = params.get('recordLine');
    showRecordLineBanner();
    showGhost = false;
    const showGhostCheckbox = document.getElementById('showGhost');
    if (showGhostCheckbox) showGhostCheckbox.checked = false;
  }
}

// --- Fullscreen Toggle ---
function toggleFullScreen() {
  if (!document.fullscreenElement) {
    // Enter fullscreen
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    } else if (document.documentElement.webkitRequestFullscreen) { /* Safari */
      document.documentElement.webkitRequestFullscreen();
    } else if (document.documentElement.msRequestFullscreen) { /* IE11 */
      document.documentElement.msRequestFullscreen();
    }
  } else {
    // Exit fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) { /* Safari */
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) { /* IE11 */
      document.msExitFullscreen();
    }
  }
  
  // Update fullscreen button state
  updateFullscreenButtonState();
}

// Add this to window's global scope so it can be called from buttons or links
window.toggleFullScreen = toggleFullScreen;

// --- Fullscreen Button ---
function createFullscreenButton() {
  const button = document.createElement('div');
  button.id = 'fullscreen-button';
  button.innerHTML = '[ ]';
  button.title = 'Toggle Fullscreen';
  
  // Add CSS for the button
  const style = document.createElement('style');
  style.textContent = `
    #fullscreen-button {
      position: fixed;
      top: 15px;
      right: 15px;
      color: rgba(255, 255, 255, 0.5);
      font-family: monospace;
      font-size: 16px;
      padding: 5px 8px;
      cursor: pointer;
      z-index: 1000;
      border-radius: 4px;
      user-select: none;
      transition: all 0.2s ease;
    }
    
    #fullscreen-button:hover {
      color: rgba(255, 255, 255, 0.9);
      transform: scale(1.1);
    }
  `;
  document.head.appendChild(style);
  
  // Add click handler
  button.addEventListener('click', () => {
    toggleFullScreen();
  });
  
  // Add to document
  document.body.appendChild(button);
  
  // Set initial state
  updateFullscreenButtonState();
  
  // Add fullscreen change listener
  document.addEventListener('fullscreenchange', updateFullscreenButtonState);
  document.addEventListener('webkitfullscreenchange', updateFullscreenButtonState);
  document.addEventListener('mozfullscreenchange', updateFullscreenButtonState);
  document.addEventListener('MSFullscreenChange', updateFullscreenButtonState);
}

function updateFullscreenButtonState() {
  const button = document.getElementById('fullscreen-button');
  if (!button) return;
  
  if (document.fullscreenElement) {
    button.innerHTML = '[ x ]';
    button.title = 'Exit Fullscreen (Esc)';
  } else {
    button.innerHTML = '[ ]';
    button.title = 'Enter Fullscreen';
  }
}

// --- Game Physics and Control Variables ---
const maxSpeed       = 100;
const timeToMaxSpeed = 18;
const accelRate      = maxSpeed / timeToMaxSpeed;
const decelRate      = 12.333;
const speedConversion= 0.6;
// Legacy pixel-speed tuning (built-ins at ~4 px/m). Kept only as the reference
// for meter-based collision thresholds that were authored in canvas pixels.
const SPEED_CALIBRATION_PX_PER_M = 4;
const COLLISION_RADIUS_M = 12 / SPEED_CALIBRATION_PX_PER_M; // 3 m

// Current meters→pixels ratio for the active track layout (collisions, etc.).
function pixelsPerMeter() {
  if (geoCanvasTransform &&
      Number.isFinite(currentTrack._geoPxPerMeter) &&
      currentTrack._geoPxPerMeter > 0) {
    return currentTrack._geoPxPerMeter;
  }
  const s = currentTrack && currentTrack.scale;
  return (Number.isFinite(s) && s > 0) ? s : SPEED_CALIBRATION_PX_PER_M;
}

// Advance the rider in TRACK METERS using HUD km/h, then project to canvas.
// This keeps ground speed correct regardless of how much the track is fit-scaled.
function advancePositionBySpeed(speedKmh, dt) {
  const mps = speedKmh / 3.6;
  if (mps <= 0 || dt <= 0) return;

  const samplePx = 8;
  const m0 = pixelToTrackMeters(pos.x, pos.y);
  const m1 = pixelToTrackMeters(
    pos.x + Math.cos(heading) * samplePx,
    pos.y + Math.sin(heading) * samplePx
  );
  let dx = m1.x - m0.x;
  let dy = m1.y - m0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  dx = (dx / len) * mps * dt;
  dy = (dy / len) * mps * dt;
  const p = trackMetersToPixel(m0.x + dx, m0.y + dy);
  pos.x = p.x;
  pos.y = p.y;
}

const BANK_ANGLE_MAX = 55;
const bankRate0to30  = 40;
const bankRate30to55 = 10;
let bankAngleDeg     = 0;
const bankDecay      = 0.9;

function updateBankAngle(dt) {
  let targetSign = 0;
  if (keys['ArrowLeft'])  targetSign = -1;
  if (keys['ArrowRight']) targetSign =  1;
  
  if (targetSign !== 0) {
    let currentMag = Math.abs(bankAngleDeg);
    let sign = Math.sign(bankAngleDeg);
    if (sign === 0) sign = targetSign;
    if (sign !== targetSign) {
      currentMag = 0;
      bankAngleDeg = 0;
      sign = targetSign;
    }
    let rate = (currentMag < 30) ? bankRate0to30 : bankRate30to55;
    currentMag += rate * dt;
    if (currentMag > BANK_ANGLE_MAX) currentMag = BANK_ANGLE_MAX;
    bankAngleDeg = sign * currentMag;
  } else {
    if (Math.abs(bankAngleDeg) < 0.5) {
      bankAngleDeg = 0;
    } else {
      const decayPow = Math.pow(bankDecay, 60 * dt);
      bankAngleDeg *= decayPow;
      if (Math.abs(bankAngleDeg) < 0.05) bankAngleDeg = 0;
    }
  }
}

// --- Turn Radius Interpolation ---
const baseline30Data = [
  { speed:10, radius:10 },
  { speed:15, radius:15 },
  { speed:30, radius:30 },
  { speed:40, radius:65 },
  { speed:60, radius:80 }
];
const reduceData = [
  { speed:10, factor:0.85 },
  { speed:15, factor:0.82 },
  { speed:30, factor:0.83 },
  { speed:40, factor:0.85 },
  { speed:60, factor:0.90 }
];

function interpPiecewise(table, spd){
  let s = Math.max(10, Math.min(60, spd));
  for (let i = 1; i < table.length; i++){
    const prev = table[i - 1];
    const cur  = table[i];
    if (s >= prev.speed && s <= cur.speed) {
      const span   = cur.speed - prev.speed;
      const ratio  = (s - prev.speed) / span;
      const valPrev= (prev.radius !== undefined) ? prev.radius : prev.factor;
      const valCur = (cur.radius  !== undefined) ? cur.radius  : cur.factor;
      return valPrev + (valCur - valPrev) * ratio;
    }
  }
  if (s <= table[0].speed) {
    return (table[0].radius !== undefined) ? table[0].radius : table[0].factor;
  }
  const last = table[table.length - 1];
  return (last.radius !== undefined) ? last.radius : last.factor;
}

function getTurnRadius(speedKmh, angleDeg) {
  let ang = Math.max(0, Math.min(55, angleDeg));
  const base30    = interpPiecewise(baseline30Data, speedKmh);
  const factorMax = interpPiecewise(reduceData,          speedKmh);
  const radiusAt50= base30 * factorMax;
  
  if (ang < 30) {
    const frac = ang / 30;
    const bigVal = 5000;
    return bigVal + frac * (base30 - bigVal);
  } else if (ang <= 50) {
    const frac = (ang - 30) / 20;
    return base30 + frac * (radiusAt50 - base30);
  } else {
    return radiusAt50;
  }
}

const turnGain  = 15;
const lowFactor = 0.02084;

// --- Movement & Telemetry ---
let heading = 0;
let speed   = 0;
const pos   = { x: 0, y: 0 };
let oldPos  = { x: 0, y: 0 };

let lapActive      = false;
let lapStartTime   = 0;
let currentLapTime = 0;
let validCrossing  = false;
let lastCrossingTime = 0;
let rideSimPaused = false;
let rideSimPauseAt = 0;
let prevPos = { x: 0, y: 0 };
let wakeTrail = [];
let showIdealLine = false;
let idealLineData = null;

// Change laps array to a Map to store laps per track
let lapsMap = new Map(); // Store laps for each track

let distanceTraveled = 0;
let topSpeedKmh      = 0;
let minSpeedKmh      = Infinity;
let sumSpeeds        = 0;
let frameCount       = 0;
let lastPosTelemetry = { x: 0, y: 0 };

let collidedThisLap  = false;
let penaltySeconds   = 0;

// --- Ghost Data & Functions ---
let ghostDataMap = new Map(); // Store ghosts for each track
let recordedGhost = [];
let ghostStats = {
    lapTime: 0,
    topSpeed: 0,
    avgSpeed: 0
};

// Add ghost wake trail array
let ghostWakeTrail = [];

// Add a variable to store the current ghost separately from the last completed lap
let currentGhost = null;
let lastValidGhost = null;
let keepCurrentGhost = false;  // This should already exist, tied to the checkbox

// Add a new variable to control ghost visibility
let showGhost = false;

// Milestone 3 — racing line record mode (from designer)
let recordLineId = null;
let activeChaseLineId = null;
let showRacingLines = true;

function pixelToTrackMeters(px, py) {
  const cx = px - trackOffset.x;
  const cy = py - trackOffset.y;
  if (geoCanvasTransform) {
    const w = canvasToMercator(cx, cy);
    const ll = worldPxToLatLng(w.x, w.y, geoCanvasTransform.zoom);
    return latLngToMeters(currentTrack.geo, ll.lat, ll.lng);
  }
  return {
    x: cx / currentTrack.scale,
    y: (canvas.height - cy) / currentTrack.scale
  };
}

// Track meters -> canvas pixels without trackOffset (used for layout / centering).
function trackMetersToLocalPixel(mx, my) {
  if (geoCanvasTransform) {
    const ll = metersToLatLng(currentTrack.geo, mx, my);
    const w = latLngToWorldPx(ll.lat, ll.lng, geoCanvasTransform.zoom);
    return mercatorToCanvas(w.x, w.y);
  }
  return {
    x: mx * currentTrack.scale,
    y: canvas.height - (my * currentTrack.scale)
  };
}

function trackMetersToPixel(mx, my) {
  const local = trackMetersToLocalPixel(mx, my);
  return {
    x: local.x + trackOffset.x,
    y: local.y + trackOffset.y
  };
}

// Position the player at the track's declarative start position (in track
// meters) when available, otherwise at the legacy bottom-center spot.
// Must be called after computeBuoys() so trackOffset is up to date.
function placePlayerAtStart() {
  const sp = currentTrack.startPosition;
  if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.y)) {
    const p = trackMetersToPixel(sp.x, sp.y);
    pos.x = p.x;
    pos.y = p.y;
    // headingDeg: 0 = +x in track meters, 90 = +y (north on track grid).
    // For geo tracks, convert to screen-space so heading matches the map rotation.
    const deg = sp.headingDeg ?? 90;
    const rad = deg * Math.PI / 180;
    const ahead = trackMetersToPixel(
      sp.x + Math.cos(rad) * 5,
      sp.y + Math.sin(rad) * 5
    );
    heading = Math.atan2(ahead.y - p.y, ahead.x - p.x);
  } else {
    pos.x = (canvas.width / 2) - 4;
    pos.y = canvas.height - 150;
    heading = -Math.PI / 2; // Point upward (-90 degrees)
  }
  prevPos.x = pos.x;
  prevPos.y = pos.y;
  resetFollowCamera();
}

// --- Follow camera (smooth edge tracking, no wrap) ---
const FOLLOW_MARGIN_FRAC = 0.28;
const FOLLOW_MARGIN_MIN = 140;
const FOLLOW_TAU = 0.45;
const CAM_SCALE_TAU = 0.42;
const OVERVIEW_CENTER_TAU = 0.65;
// Z cycles: race zoom → 1 km → 5 km → race zoom
const ZOOM_STOPS_M = [0, 1000, 5000];
let zoomHintUntil = 0;

function isOverviewZoom() {
  return zoomStopIndex > 0;
}

function overviewMeters() {
  return ZOOM_STOPS_M[zoomStopIndex] || 0;
}

function followTargetScale() {
  const meters = overviewMeters();
  const ppm = pixelsPerMeter();
  if (!meters || !ppm || !canvas.width || !canvas.height) return 1;
  const view = Math.min(canvas.width, canvas.height);
  return Math.max(0.02, view / (meters * ppm));
}

function zoomStopTitle(index) {
  const m = ZOOM_STOPS_M[index] || 0;
  if (!m) return 'Race zoom';
  return m >= 1000 ? `Overview — ${m / 1000} km` : `Overview — ${m} m`;
}

function nextZoomHint() {
  const last = ZOOM_STOPS_M.length - 1;
  if (zoomStopIndex === last && 'ontouchstart' in window) {
    return 'pinch out · world map';
  }
  const next = (zoomStopIndex + 1) % ZOOM_STOPS_M.length;
  const m = ZOOM_STOPS_M[next] || 0;
  if (!m) return 'Z · race zoom';
  return m >= 1000 ? `Z · ${m / 1000} km overview` : `Z · ${m} m overview`;
}

function resetFollowCamera() {
  const s = followTargetScale();
  followCam.scale = s;
  if (isOverviewZoom() && canvas.width) {
    followCam.tx = canvas.width / 2 - pos.x * s;
    followCam.ty = canvas.height / 2 - pos.y * s;
  } else {
    followCam.tx = pos.x * (1 - s);
    followCam.ty = pos.y * (1 - s);
  }
}

function updateFollowCamera(dt) {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return;

  const targetScale = followTargetScale();
  const scaleA = 1 - Math.exp(-dt / CAM_SCALE_TAU);
  const oldS = followCam.scale || 1;
  const newS = oldS + (targetScale - oldS) * scaleA;
  const focus = introLineCameraFocus(rideIntroFrame);
  const px = focus ? focus.x : pos.x;
  const py = focus ? focus.y : pos.y;
  const hd = focus ? focus.heading : heading;
  const rsx = px * oldS + followCam.tx;
  const rsy = py * oldS + followCam.ty;
  followCam.scale = newS;
  followCam.tx = rsx - px * newS;
  followCam.ty = rsy - py * newS;

  const s = followCam.scale;
  let tx;
  let ty;
  let tau = isOverviewZoom() ? OVERVIEW_CENTER_TAU : FOLLOW_TAU;
  if (focus) {
    const look = Math.min(70, 28 / Math.max(0.25, s));
    const lx = px + Math.cos(hd) * look;
    const ly = py + Math.sin(hd) * look;
    tx = w / 2 - lx * s;
    ty = h / 2 - ly * s;
    tau = INTRO_LINE_CAM_TAU;
    introCamReturning = true;
  } else if (isOverviewZoom()) {
    tx = w / 2 - pos.x * s;
    ty = h / 2 - pos.y * s;
  } else {
    const mx = Math.max(FOLLOW_MARGIN_MIN, w * FOLLOW_MARGIN_FRAC);
    const my = Math.max(FOLLOW_MARGIN_MIN, h * FOLLOW_MARGIN_FRAC);
    const look = Math.min(110, (speed * speedConversion / 55) * 85);
    const fx = pos.x + Math.cos(heading) * look;
    const fy = pos.y + Math.sin(heading) * look;
    tx = followCam.tx;
    ty = followCam.ty;
    const sx = fx * s + tx;
    const sy = fy * s + ty;
    if (sx < mx) tx += mx - sx;
    else if (sx > w - mx) tx += (w - mx) - sx;
    if (sy < my) ty += my - sy;
    else if (sy > h - my) ty += (h - my) - sy;
  }

  if (!focus && introCamReturning) {
    tau = Math.max(tau, 0.9);
  }

  const a = 1 - Math.exp(-dt / tau);
  followCam.tx += (tx - followCam.tx) * a;
  followCam.ty += (ty - followCam.ty) * a;
  if (introCamReturning && !focus) {
    const dx = tx - followCam.tx;
    const dy = ty - followCam.ty;
    if (dx * dx + dy * dy < 36) introCamReturning = false;
  }
}

function worldMarkerScale() {
  const s = followCam.scale || 1;
  return s < 0.995 ? 1 / s : 1;
}

function withWorldMarker(x, y, fn) {
  const m = worldMarkerScale();
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(m, m);
  fn();
  ctx.restore();
}

function cycleZoomStop(dir = 1) {
  const n = ZOOM_STOPS_M.length;
  const step = dir < 0 ? -1 : 1;
  zoomStopIndex = (zoomStopIndex + step + n) % n;
  zoomHintUntil = performance.now() + 1800;
  prefetchGeoTiles();
}

/** Discrete zoom for pinch: +1 zooms out (race→1km→5km), -1 zooms in. Clamps at ends (no Z-style wrap). */
function nudgeZoomStop(dir) {
  const n = ZOOM_STOPS_M.length;
  const next = zoomStopIndex + (dir < 0 ? -1 : 1);
  if (next < 0 || next >= n) return false;
  zoomStopIndex = next;
  zoomHintUntil = performance.now() + 1800;
  prefetchGeoTiles();
  return true;
}

function drawZoomHint() {
  const now = performance.now();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '13px sans-serif';
  if (now < zoomHintUntil) {
    ctx.globalAlpha *= Math.min(1, (zoomHintUntil - now) / 400);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${zoomStopTitle(zoomStopIndex)}  (Z)`, canvas.width / 2, 42);
  } else {
    ctx.globalAlpha *= 0.45;
    ctx.fillStyle = '#fff';
    ctx.fillText(nextZoomHint(), canvas.width / 2, 22);
  }
  ctx.restore();
}

// Required crossing direction for directional gates, in pixel space.
function gateDirectionPx() {
  const d = (currentTrack.gate && currentTrack.gate.direction) || { x: 1, y: 0 };
  const p0 = trackMetersToPixel(0, 0);
  const p1 = trackMetersToPixel(d.x, d.y);
  const vx = p1.x - p0.x;
  const vy = p1.y - p0.y;
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

function recordGhostData(timeSec) {
  if (!lapActive) return;
  const trackM = pixelToTrackMeters(pos.x, pos.y);
  // Calculate the current average speed based on sumSpeeds and frameCount
  const currentAvgSpeed = frameCount > 0 ? sumSpeeds / frameCount : 0;
  // Add current speed data to the ghost frame
  recordedGhost.push({
    time: timeSec,
    x: trackM.x,
    y: trackM.y,
    heading,
    speedKmh: speed * speedConversion, // Current speed
    avgSpeedKmh: currentAvgSpeed       // Running average speed
  });
}

function getGhostPosition(t, ghostData) {
  if (!ghostData || !ghostData.frames || !Array.isArray(ghostData.frames) || ghostData.frames.length === 0) {
    return null;
  }
  
  const frames = ghostData.frames;
  
  // Handle case where time is before first frame
  if (t <= frames[0].time) {
    return { ...frames[0] };
  }
  
  // Handle case where time is after last frame
  const lastIndex = frames.length - 1;
  if (t >= frames[lastIndex].time) {
    return { ...frames[lastIndex] };
  }
  
  // Binary search to find closest frame pair more efficiently
  let low = 0;
  let high = frames.length - 1;
  
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    
    if (frames[mid].time <= t && (mid === lastIndex || frames[mid + 1].time >= t)) {
      // Found the lower bound frame
      const prev = frames[mid];
      const next = frames[mid + 1];
      
      // Calculate how far between frames we are (0.0 to 1.0)
      const ratio = (t - prev.time) / (next.time - prev.time);
      
      // Linear interpolation between frames
      return {
        x: prev.x + ratio * (next.x - prev.x),
        y: prev.y + ratio * (next.y - prev.y),
        heading: prev.heading + ratio * (next.heading - prev.heading),
        headingSpace: prev.headingSpace || next.headingSpace,
        time: t,
        speedKmh: prev.speedKmh
      };
    }
    
    if (frames[mid].time > t) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  
  // Fallback: use first frame (should not reach here if data is valid)
  return { ...frames[0] };
}

// GPS / session ghosts store heading in track-meter radians; legacy sim ghosts
// store screen-space heading. Convert at draw time so refits stay correct.
function ghostFrameHeadingToScreen(frame) {
  if (!frame) return 0;
  if (frame.headingSpace === 'trackMeters' || frame.headingSpace === 'track') {
    const rad = frame.heading || 0;
    const p = trackMetersToPixel(frame.x, frame.y);
    const ahead = trackMetersToPixel(
      frame.x + Math.cos(rad) * 5,
      frame.y + Math.sin(rad) * 5
    );
    return Math.atan2(ahead.y - p.y, ahead.x - p.x);
  }
  return frame.heading || 0;
}

// Free-running preview clock so session ghosts are visible before a lap starts.
let ghostPreviewStart = 0;

function ghostPlaybackTimeSec() {
  const now = (rideSimPaused && rideSimPauseAt) ? rideSimPauseAt : performance.now();
  if (lapActive && lapStartTime) {
    return (now - lapStartTime) / 1000;
  }
  if (ghostPreviewStart) {
    return (now - ghostPreviewStart) / 1000;
  }
  return 0;
}

function startGhostPreview() {
  ghostPreviewStart = performance.now();
  ghostWakeTrail = [];
}

function drawGhostFrame() {
    if (!showGhost || !currentGhost) {
        return;
    }
    // Need an active lap or a free preview (session CSV import starts preview).
    if (!lapActive && !ghostPreviewStart) {
        return;
    }

    if (!currentGhost.frames || !Array.isArray(currentGhost.frames) || currentGhost.frames.length === 0) {
        return;
    }

    const timeSec = ghostPlaybackTimeSec();
    // Loop preview so long sessions keep animating while you wait to start
    const lapDur = currentGhost.time || currentGhost.frames[currentGhost.frames.length - 1]?.time || 0;
    const playT = (!lapActive && lapDur > 0) ? (timeSec % Math.max(lapDur, 0.1)) : timeSec;

    const frame = getGhostPosition(playT, currentGhost);
    if (!frame) {
        return;
    }

    let ghostX, ghostY;
    if (currentTrack.parallelTrack) {
        const parallel = trackMetersToPixel(
            frame.x,
            frame.y + currentTrack.trackSeparation
        );
        ghostX = parallel.x;
        ghostY = parallel.y;
    } else {
        const p = trackMetersToPixel(frame.x, frame.y);
        ghostX = p.x;
        ghostY = p.y;
    }

    drawGhost(ghostX, ghostY, ghostFrameHeadingToScreen(frame));

    ghostWakeTrail.push({ x: ghostX, y: ghostY });
    const targetWakeLength = 200;
    while (ghostWakeTrail.length > 1 && totalTrailDistance(ghostWakeTrail) > targetWakeLength) {
        ghostWakeTrail.shift();
    }
}

// Separate function to draw the ghost racer at a given position
function drawGhost(x, y, heading) {
  withWorldMarker(x, y, () => {
    ctx.rotate(heading - Math.PI / 2);
    ctx.globalAlpha *= 0.25;
    ctx.beginPath();
    ctx.moveTo(0, 12.5);
    ctx.bezierCurveTo(4, 7.5, 4, -7.5, 0, -12.5);
    ctx.bezierCurveTo(-4, -7.5, -4, 7.5, 0, 12.5);
    ctx.closePath();
    ctx.fillStyle = '#ff88ff';
    ctx.fill();
  });
}

function startLap(){
  lapStartTime = performance.now();
  currentLapTime = 0;
  lapActive = true;
  
  // Clear ghost wake trail
  ghostWakeTrail = [];
  
  // Initialize ghost if available
  if (showGhost || ghostDataMap.has(currentTrackKey)) {
    // Get the stored ghost for this track
    const trackGhost = ghostDataMap.get(currentTrackKey);
    
    // Use current ghost if we're keeping it, otherwise use the stored track ghost
    if (trackGhost) {
      if (!keepCurrentGhost || !currentGhost) {
        currentGhost = trackGhost;
        showGhost = true;
      }
      
      // Update ghost stats display
      updateGhostStats();
    }
  }
  
  // Reset collision tracking
  collidedThisLap = false;
  penaltySeconds = 0;
  
  // Reset telemetry
  distanceTraveled = 0;
  topSpeedKmh = 0;
  minSpeedKmh = Infinity;
  sumSpeeds = 0;
  frameCount = 0;
  lastPosTelemetry = { x: pos.x, y: pos.y };
  
  // Reset ghost recording
  recordedGhost = [];

  initTurnStates();
  resetCommentaryQueue();
  
  // Start music
  AudioManager.playSound('music')
    .catch(err => console.warn('Failed to play music:', err));
  
  // Play appropriate commentary based on starting speed
  const speedKmh = speed * speedConversion;
  let startKey = "start_under30";
  if (speedKmh > 50) startKey = "start_over50";
  else if (speedKmh > 30) startKey = "start_30_50";
  playCommentary(startKey, { interrupt: true });
}

// Calculate average speed properly
function calculateAvgSpeed(distance, time) {
  if (!time || time <= 0) return 0;
  // Calculate the average speed directly from distance and time
  // Distance is in meters, time is in seconds
  // (distance / time) gives m/s, multiply by 3.6 to convert to km/h
  return (distance / time) * 3.6; // Convert m/s to km/h
}

function completeLap() {
    // Calculate the final lap time based on the current time
    const rawSec = (performance.now() - lapStartTime) / 1000;
    currentLapTime = rawSec;
    
    if (collidedThisLap) {
        currentLapTime += penaltySeconds;
    }
    
    // Play sound effects
    AudioManager.playSound('boomStop')
        .catch(err => console.warn('Failed to play boom stop sound:', err));
    AudioManager.fadeOutMusic();
    
    // Calculate average speed using arithmetic mean of speed readings
    // This will match what the speedometer shows when speed is constant
    const avgSpeedKmh = frameCount > 0 ? sumSpeeds / frameCount : 0;
    
    // Get or create laps array for current track
    if (!lapsMap.has(currentTrackKey)) {
        lapsMap.set(currentTrackKey, []);
    }
    const trackLaps = lapsMap.get(currentTrackKey);
    
    // Store lap data for telemetry with collision status
    trackLaps.unshift({
        finalTime: currentLapTime,
        distance: distanceTraveled,
        topSpeed: topSpeedKmh,
        minSpeed: (minSpeedKmh === Infinity ? 0 : minSpeedKmh),
        avgSpeed: avgSpeedKmh,
        collided: collidedThisLap
    });
    if (trackLaps.length > 4) trackLaps.pop(); // Keep only last 4 laps
    
    // Update display with penalty if applicable
    const lapTimeStr = currentLapTime.toFixed(3);
    const penaltyText = collidedThisLap ? ` (+${penaltySeconds}s penalty!)` : '';
    document.getElementById('lapTimeDisplay').innerText = `Laptime: ${lapTimeStr}${penaltyText}`;
    
    // Add lap to history
    const historyDiv = document.getElementById('lapHistory');
    const lapEntry = document.createElement('div');
    lapEntry.innerHTML = `Lap: ${lapTimeStr}s | Top: ${topSpeedKmh.toFixed(1)} | Avg: ${avgSpeedKmh.toFixed(1)} | Min: ${minSpeedKmh.toFixed(1)} km/h${collidedThisLap ? ` (+${penaltySeconds}s penalty!)` : ''}`;
    historyDiv.insertBefore(lapEntry, historyDiv.firstChild);
    
    // Set lap to inactive before any potential game pause
    lapActive = false;
    
    // Force a redraw of the telemetry to update the display
    // This ensures telemetry is updated before any highscore form appears
    drawTelemetry();
    
    // Only store ghost data if it's a valid lap
    if (!collidedThisLap && currentLapTime > 10 && distanceTraveled > 100) {
        if (recordLineId) {
            const built = buildRacingLineFromGhost(recordedGhost, currentLapTime);
            if (built) {
                const line = currentTrack?.racingLines?.find(l => l.id === recordLineId);
                const capture = {
                    lineId: recordLineId,
                    lineName: line?.name || '',
                    points: built.points,
                    ghost: built.ghost
                };
                localStorage.setItem(LINE_CAPTURE_KEY, JSON.stringify(capture));
                showLineCaptureOverlay(currentLapTime, capture);
                recordLineId = null;
                const banner = document.getElementById('recordLineBanner');
                if (banner) banner.remove();
            }
            return;
        }

        // Store distance in the ghost data
        const newGhostData = {
    trackKey: currentTrackKey,
            distance: distanceTraveled,
            time: currentLapTime,
            avgSpeed: avgSpeedKmh, // Store the calculated average speed
            frames: recordedGhost.map(frame => ({
                ...frame,
                finalLapTime: currentLapTime
            }))
        };
        
        // Store as last valid ghost
        lastValidGhost = newGhostData;
        
        // If we're not keeping the current ghost, update it for this track
        if (!keepCurrentGhost) {
            currentGhost = lastValidGhost;
            ghostDataMap.set(currentTrackKey, lastValidGhost);
        }
        
        // Update ghost stats display
        updateGhostStats();

        // After recording ghost data, show input form if it's a good time
        setTimeout(() => {
            highScoreManager.showInputForm(currentLapTime, recordedGhost);
        }, 500);
        
        // Always enable ghost racing for the next lap with a valid ghost
        showGhost = true;
        // Update checkbox if it exists
        const ghostCheckbox = document.getElementById('showGhost');
        if (ghostCheckbox) {
            ghostCheckbox.checked = true;
        }
  } else if (recordLineId && collidedThisLap) {
    const banner = document.getElementById('recordLineBanner');
    if (banner) {
      banner.textContent = 'Buoy hit — try again for a clean lap (no collisions)';
      banner.style.background = 'rgba(255,93,93,0.92)';
      banner.style.color = '#fff';
    }
  }
}

// --- Input Handling ---
const keys = {};

document.addEventListener('keydown', function(e) {
  // Don't process keyboard shortcuts if game is paused or if typing in an input
  if (gamePaused || (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    return;
  }

  if (atlasEls.confirm.classList.contains('open')) {
    if (e.key === 'Escape') keepRacingFromAtlasConfirm();
    return;
  }

  if (atlas.open) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (atlas.selectedKey) closeAtlasCards();
      else closeAtlas();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      closeAtlas();
    }
    return;
  }
  
  switch(e.key) {
    case 'ArrowUp':
    case 'i':
    case 'I':
      e.preventDefault();
      keys['ArrowUp'] = true;
      break;
    case 'ArrowDown':
    case 'k':
    case 'K':
      e.preventDefault();
      keys['ArrowDown'] = true;
      break;
    case 'ArrowLeft':
    case 'j':
    case 'J':
      e.preventDefault();
      keys['ArrowLeft'] = true;
      break;
    case 'ArrowRight':
    case 'l':
    case 'L':
      e.preventDefault();
      keys['ArrowRight'] = true;
      break;
    // Keep your other cases
  }

  // Toggle 'P' to show/hide the racing line path
  if (e.key === 'p' || e.key === 'P') {
    if (trackHasRacingLines(currentTrack)) {
      setShowRacingLines(!showRacingLines);
    }
  }

  // Toggle 'G' to keep racing against the current ghost
  if (e.key === 'g' || e.key === 'G') {
    setKeepCurrentGhost(!keepCurrentGhost);
  }

  // Press 'T' for the world atlas
  if (e.key === 't' || e.key === 'T') {
    requestAtlas();
  }

  // Cycle Z: race zoom → 1 km → 5 km → race zoom
  if (e.key === 'z' || e.key === 'Z') {
    cycleZoomStop();
  }
});

document.addEventListener('keyup', function(e) {
  switch(e.key) {
    case 'ArrowUp':
    case 'i':
    case 'I':
      keys['ArrowUp'] = false;
      break;
    case 'ArrowDown':
    case 'k':
    case 'K':
      keys['ArrowDown'] = false;
      break;
    case 'ArrowLeft':
    case 'j':
    case 'J':
      keys['ArrowLeft'] = false;
      break;
    case 'ArrowRight':
    case 'l':
    case 'L':
      keys['ArrowRight'] = false;
      break;
    // Keep your other cases
  }

  // Keep your other existing key handlers
  // ...
});

// --- Intersection & Timing Line Crossing ---
function orientation(p, q, r){
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function linesIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2){
  const p1 = { x: ax1, y: ay1 }, p2 = { x: ax2, y: ay2 };
  const p3 = { x: bx1, y: by1 }, p4 = { x: bx2, y: by2 };
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) {
    if ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)) return true;
  }
  return false;
}

// Modify the checkGateCrossing function to be simpler and more reliable
function checkGateCrossing(oldPos, newPos) {
    // First check if we're using gates
    if (currentTrack.useGates) {
        if (!computedGates) return false;
        
        // For directional-gate tracks, check direction before allowing crossing
        if (currentTrack.requiresDirectionalGates) {
            if (lineIntersection(
                oldPos.x, oldPos.y,
                newPos.x, newPos.y,
                computedGates.start.x1, computedGates.start.y1,
                computedGates.start.x2, computedGates.start.y2
            )) {
                const dir = gateDirectionPx();
                const dot = (newPos.x - oldPos.x) * dir.x + (newPos.y - oldPos.y) * dir.y;
                if (dot < 0) {
                    return false; // Ignore crossings against the required direction
                }
                return 'start';
            }
            return false;
        }

        // For other tracks using gates
        if (computedGates.start && lineIntersection(
            oldPos.x, oldPos.y,
            newPos.x, newPos.y,
            computedGates.start.x1, computedGates.start.y1,
            computedGates.start.x2, computedGates.start.y2
        )) {
            // With a shared start/finish gate, the crossing means "finish"
            // while a lap is running and "start" otherwise
            if (currentTrack.gates.sameStartFinish) {
                return lapActive ? 'finish' : 'start';
            }
            return 'start';
        }
        
        if (!currentTrack.gates.sameStartFinish && computedGates.finish) {
            if (lineIntersection(
                oldPos.x, oldPos.y,
                newPos.x, newPos.y,
                computedGates.finish.x1, computedGates.finish.y1,
                computedGates.finish.x2, computedGates.finish.y2
            )) {
                return 'finish';
            }
        }
        return false;
    } else {
        // For tracks using timing line
        if (lineIntersection(
            oldPos.x, oldPos.y,
            newPos.x, newPos.y,
    timingLine.x1, timingLine.y1,
    timingLine.x2, timingLine.y2
  )) {
            // If lap is active, this is a finish. If not, this is a start
            return lapActive ? 'finish' : 'start';
        }
    }
    return false;
}

// --- Collision Detection with Buoys ---
function checkBuoyCollisions(){
  if (!lapActive || collidedThisLap) return;

  const hitRadiusPx = COLLISION_RADIUS_M * pixelsPerMeter();
  for (const b of buoys) {
    const dx   = b.x - pos.x;
    const dy   = b.y - pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < hitRadiusPx) {
      penaltySeconds += 10;
      collidedThisLap = true;
      AudioManager.playSound('collision')
          .catch(err => console.warn('Failed to play collision sound:', err));
      break;
    }
  }
}

// --- THROTTLE USAGE ---
function updateThrottleQueue(st, dt) {
  // st => turnStates entry
  const throttlePressed = !!keys['ArrowUp'];
  st.throttleQueue.push({ pressed: throttlePressed, dt: dt });
  st.queueTime += dt;

  // pop from front if exceed 0.5s
  while (st.queueTime > THROTTLE_WINDOW && st.throttleQueue.length > 0) {
    const oldest = st.throttleQueue.shift();
    st.queueTime -= oldest.dt;
  }
}

// --- APEX DETECTION ---
function apexZonePx(buoy) {
  const ppm = pixelsPerMeter();
  // Designer values (~20–40) are leftover canvas pixels at the 4 px/m scale.
  // Larger numbers are treated as meters. Floor is APEX_ZONE_M either way.
  let radiusM = APEX_ZONE_M;
  if (typeof buoy.apexRadius === "number" && buoy.apexRadius > 0) {
    const authoredM = buoy.apexRadius > 15
      ? buoy.apexRadius / SPEED_CALIBRATION_PX_PER_M
      : buoy.apexRadius;
    radiusM = Math.max(APEX_ZONE_M, authoredM);
  }
  return radiusM * ppm;
}

function checkBuoyApexes(dt) {
  const ppm = pixelsPerMeter();
  buoys.forEach(b => {
    if (b.turnIndex == null) return;
    const st = turnStates[b.turnIndex];
    if (!st || st.apexReached) return;

    const dist = Math.hypot(b.x - pos.x, b.y - pos.y);
    const zonePx = apexZonePx(b);

    if (dist > zonePx) {
      st.previousDistance = null;
      st.approached = false;
      st.minDistance = Infinity;
      st.throttleQueue = [];
      st.queueTime = 0;
      return;
    }

    if (dist < st.minDistance) st.minDistance = dist;
    updateThrottleQueue(st, dt);

    if (st.previousDistance == null) {
      st.previousDistance = dist;
      return;
    }

    if (dist + APEX_RECEDING_EPS_PX < st.previousDistance) {
      st.approached = true;
    }

    const receding = dist > st.previousDistance + APEX_RECEDING_EPS_PX;
    st.previousDistance = dist;

    if (!st.approached || !receding) return;

    st.apexReached = true;
    st.apexSpeed = speed * speedConversion;
    handleApexCommentary(b, st, ppm);
  });
}

function handleApexCommentary(buoy, st, ppm) {
  let pressedTime = 0;
  for (const item of st.throttleQueue) {
    if (item.pressed) pressedTime += item.dt;
  }
  const fractionEngaged = (st.queueTime > 0) ? (pressedTime / st.queueTime) : 0;
  const throttleGood = fractionEngaged > 0.6;

  const optimal = (typeof buoy.optimalSpeed === "number") ? buoy.optimalSpeed : 30;
  const nearOptimal = Math.abs(st.apexSpeed - optimal) <= OPTIMAL_SPEED_WINDOW_KMH;
  const tightLine = st.minDistance < COMMENTARY_TIGHT_LINE_M * ppm;

  let eventKey = "turn_generic";
  if (nearOptimal) {
    const line = tightLine ? "tightline" : "wideline";
    const throttle = throttleGood ? "goodthrottle" : "latethrottle";
    eventKey = `turn_optimalspeed_${line}_${throttle}`;
  }

  playCommentary(eventKey);
}

// --- Update Function ---
function update(dt){
  // Store previous position before updating
  prevPos.x = pos.x;
  prevPos.y = pos.y;
  
  if (keys['ArrowUp']) {
    speed += accelRate * dt;
  }
  if (keys['ArrowDown']) {
    speed -= decelRate * dt;
  }
  speed = Math.max(0, Math.min(maxSpeed, speed));
  
  updateBankAngle(dt);
  
  const speedKmh = speed * speedConversion;
  const radius   = getTurnRadius(speedKmh, Math.abs(bankAngleDeg));
  const angleRad = (bankAngleDeg * Math.PI) / 180;
  const turnFactor = Math.sign(bankAngleDeg) * (Math.abs(angleRad) * turnGain) * ((1 / radius) + lowFactor);
  heading += turnFactor * dt;

  advancePositionBySpeed(speedKmh, dt);
  updateFollowCamera(dt);

  // Update wind volume based on speed and ensure it's playing
  AudioManager.ensureWindPlaying();
  AudioManager.sounds.wind.volume = speed / maxSpeed;
  
  document.getElementById('speedDisplay').innerText    = `Speed: ${speedKmh.toFixed(1)} km/h`;
  document.getElementById('bankAngleDisplay').innerText= `Bank: ${bankAngleDeg.toFixed(0)}°`;

  // Update ghost stats with the correct average speed
  if (currentGhost && showGhost) {
    // Make sure ghost stats are updated with the correct speed
    updateGhostStats();
  }
  
  if (currentTrack.directionalFinishGate) {
    debugDirectionalCrossing();
  }
  handleLapTiming();
  
  if (lapActive) {
    if (speedKmh > topSpeedKmh) topSpeedKmh = speedKmh;
    if (speedKmh < minSpeedKmh) minSpeedKmh = speedKmh;
    sumSpeeds += speedKmh;
    frameCount++;
    
    let distM;
    if (geoCanvasTransform) {
      const m0 = pixelToTrackMeters(lastPosTelemetry.x, lastPosTelemetry.y);
      const m1 = pixelToTrackMeters(pos.x, pos.y);
      const ll0 = metersToLatLng(currentTrack.geo, m0.x, m0.y);
      const ll1 = metersToLatLng(currentTrack.geo, m1.x, m1.y);
      distM = haversineMeters(ll0, ll1);
    } else {
      const distPx = Math.hypot(pos.x - lastPosTelemetry.x, pos.y - lastPosTelemetry.y);
      distM = distPx / currentTrack.scale;
    }
    distanceTraveled += distM;
    lastPosTelemetry.x = pos.x;
    lastPosTelemetry.y = pos.y;
    
    checkBuoyCollisions();
    checkBuoyApexes(dt);

    const rawSec = (performance.now() - lapStartTime) / 1000;
    // Update currentLapTime continuously during active lap
    currentLapTime = rawSec;
    recordGhostData(rawSec);
    
    // Update lap time display
    updateLapTimeDisplay();
    } else {
    // Update lap time display for inactive lap
    updateLapTimeDisplay();
  }
}

// --- Wake Trail and Drawing ---
function totalTrailDistance(trail){
  let d = 0;
  for (let i = 1; i < trail.length; i++){
    d += Math.hypot(
      trail[i].x - trail[i-1].x,
      trail[i].y - trail[i-1].y
    );
  }
  return d;
}

function drawWake(){
  const m = worldMarkerScale();
  // Draw player wake
  if (wakeTrail.length < 2) return;
  for (let i = 1; i < wakeTrail.length; i++){
    const t = i / wakeTrail.length;
    const alpha = t;
    ctx.beginPath();
    ctx.moveTo(wakeTrail[i-1].x, wakeTrail[i-1].y);
    ctx.lineTo(wakeTrail[i].x, wakeTrail[i].y);
    ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
    ctx.lineWidth = 2 * m;
    ctx.stroke();
  }

  // Draw ghost wake during active laps or free preview
  if ((lapActive || ghostPreviewStart) && ghostWakeTrail.length >= 2) {
    for (let i = 1; i < ghostWakeTrail.length; i++){
      const t = i / ghostWakeTrail.length;
      const alpha = t;
      ctx.beginPath();
      ctx.moveTo(ghostWakeTrail[i-1].x, ghostWakeTrail[i-1].y);
      ctx.lineTo(ghostWakeTrail[i].x, ghostWakeTrail[i].y);
      ctx.strokeStyle = `rgba(255,136,255,${alpha.toFixed(2)})`;
      ctx.lineWidth = 2 * m;
      ctx.stroke();
    }
  }
}

function drawBuoyDot(x, y, isTurn) {
  withWorldMarker(x, y, () => {
    const r = isTurn ? 8 : 4;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 2 * Math.PI);
    ctx.fillStyle = isTurn ? '#FFE44D' : '#FF8800';
    ctx.fill();
    ctx.lineWidth = isTurn ? 2 : 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  });
}

function drawOneBuoy(b) {
  const isTurn = b.turnIndex != null;
  drawBuoyDot(b.x, b.y, isTurn);
  if (isTurn) {
    withWorldMarker(b.x, b.y, () => {
      ctx.font = '12px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(String(b.turnIndex), 11, -8);
    });
  }
  if (currentTrack.parallelTrack) {
    const parallel = trackMetersToPixel(
      pixelToTrackMeters(b.x, b.y).x,
      pixelToTrackMeters(b.x, b.y).y + currentTrack.trackSeparation
    );
    drawBuoyDot(parallel.x, parallel.y, isTurn);
  }
}

function drawTimingLines() {
  const gateW = worldMarkerScale();
  if (currentTrack.useGates) {
    ctx.beginPath();
    ctx.moveTo(gates.start.x1, gates.start.y1);
    ctx.lineTo(gates.start.x2, gates.start.y2);
    ctx.strokeStyle = '#FF0000';
    ctx.lineWidth = gateW;
    ctx.stroke();

    if (!currentTrack.gates.sameStartFinish) {
      ctx.beginPath();
      ctx.moveTo(gates.finish.x1, gates.finish.y1);
      ctx.lineTo(gates.finish.x2, gates.finish.y2);
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = gateW;
      ctx.stroke();
    }

    if (currentTrack.parallelTrack) {
      ctx.beginPath();
      ctx.moveTo(gates.parallelStart.x1, gates.parallelStart.y1);
      ctx.lineTo(gates.parallelStart.x2, gates.parallelStart.y2);
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = gateW;
      ctx.stroke();

      if (!currentTrack.gates.sameStartFinish) {
        ctx.beginPath();
        ctx.moveTo(gates.parallelFinish.x1, gates.parallelFinish.y1);
        ctx.lineTo(gates.parallelFinish.x2, gates.parallelFinish.y2);
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = gateW;
        ctx.stroke();
      }
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(timingLine.x1, timingLine.y1);
    ctx.lineTo(timingLine.x2, timingLine.y2);
    ctx.strokeStyle = '#FF0000';
    ctx.lineWidth = gateW;
    ctx.stroke();
  }
}

function withDrawAlpha(a, fn) {
  if (a <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= a;
  fn();
  ctx.restore();
}

function drawTrack(intro) {
  if (intro) {
    withDrawAlpha(intro.gates, drawTimingLines);
    (intro.turns || []).forEach((b, i) => {
      withDrawAlpha(intro.turnFade(i), () => drawOneBuoy(b));
    });
    buoys.forEach(b => {
      if (b.turnIndex != null) return;
      withDrawAlpha(intro.markers, () => drawOneBuoy(b));
    });
    return;
  }

  buoys.forEach(b => drawOneBuoy(b));
  drawTimingLines();
}

function drawTelemetry() {
  ctx.save();
    ctx.font = '14px monospace';
  ctx.fillStyle = '#fff';
  let x = 20, y = 88;
    
    ctx.fillText(`${currentTrack.name} Telemetry:`, x, y);
  y += 20;
    
    const trackLaps = lapsMap.get(currentTrackKey) || [];
    
    if (trackLaps.length === 0) {
        ctx.fillText('No laps recorded', x, y);
    } else {
        trackLaps.forEach((lap, idx) => {
    // Calculate correct lap number: newest lap (idx 0) should have highest number
    const lapNumber = trackLaps.length - idx;
    ctx.fillText(`Lap ${lapNumber}:`, x, y);
    y += 18;
            if (lap.collided) {
                ctx.fillText(`  Time:   ${lap.finalTime.toFixed(2)} s  (+${penaltySeconds}s penalty!)`, x, y);
            } else {
    ctx.fillText(`  Time:   ${lap.finalTime.toFixed(2)} s`, x, y);
            }
    y += 18;
    ctx.fillText(`  Dist:   ${lap.distance.toFixed(1)} m`, x, y);
    y += 18;
    ctx.fillText(`  TopSpd: ${lap.topSpeed.toFixed(1)} km/h`, x, y);
    y += 18;
    ctx.fillText(`  MinSpd: ${lap.minSpeed.toFixed(1)} km/h`, x, y);
    y += 18;
    ctx.fillText(`  AvgSpd: ${lap.avgSpeed.toFixed(1)} km/h`, x, y);
    y += 24;
  });
    }
  ctx.restore();
}

function drawRacer() {
  withWorldMarker(pos.x, pos.y, () => {
    ctx.rotate(heading - Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 12.5);
    ctx.bezierCurveTo(4, 7.5, 4, -7.5, 0, -12.5);
    ctx.bezierCurveTo(-4, -7.5, -4, 7.5, 0, 12.5);
    ctx.closePath();
    ctx.fillStyle = '#00ccff';
    ctx.fill();
  });
}

// --- Ideal Line Toggle ---
function loadIdealLineForCurrentTrack() {
  const trackKey = currentTrackKey;
  
  // Reset ideal line data
  idealLineData = null;
  
  // If this track doesn't have an ideal line, don't try to load it
  if (!trackConfigs[trackKey]?.hasIdealLine) {
      return;
    }
  
  // Create a unique filename based on the track
  const filename = `${trackKey}_idealline.json`;
  
  // Try to load from localStorage first
  const storedData = localStorage.getItem(filename);
  if (storedData) {
    try {
      const data = JSON.parse(storedData);
    idealLineData = data;
      // Ideal line loaded from localStorage
      return;
    } catch (e) {
      // If there's an error parsing the data, proceed to load from server
    }
  }
  
  // Load from server
  fetch(`ideallines/${filename}`)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Failed to load ideal line: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      idealLineData = data;
      // Store in localStorage for future use
      localStorage.setItem(filename, JSON.stringify(data));
      // Ideal line loaded from server
    })
    .catch(error => {
      console.warn('Error loading ideal line:', error);
    });
}

function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

function polylinePointAt(pts, dist) {
  if (!pts || !pts.length) return null;
  if (pts.length === 1 || dist <= 0) {
    const h = pts.length > 1
      ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x)
      : 0;
    return { x: pts[0].x, y: pts[0].y, heading: h };
  }
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (acc + len >= dist) {
      const t = (dist - acc) / (len || 1);
      return {
        x: pts[i - 1].x + dx * t,
        y: pts[i - 1].y + dy * t,
        heading: Math.atan2(dy, dx)
      };
    }
    acc += len;
  }
  const n = pts.length;
  return {
    x: pts[n - 1].x,
    y: pts[n - 1].y,
    heading: Math.atan2(pts[n - 1].y - pts[n - 2].y, pts[n - 1].x - pts[n - 2].x)
  };
}

function racingLineFitsView(pts) {
  if (!pts || pts.length < 2 || !canvas.width || !canvas.height) return true;
  const s = followCam.scale || 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = 96 / s;
  return (maxX - minX) <= canvas.width / s - pad && (maxY - minY) <= canvas.height / s - pad;
}

function introLineCameraFocus(intro) {
  if (!intro?.line || intro.lineProg <= 0) return null;
  const pts = intro.line.points.map(p => trackMetersToPixel(p.x, p.y));
  if (pts.length < 2 || racingLineFitsView(pts)) return null;
  const total = polylineLength(pts);
  if (!(total > 1)) return null;
  return polylinePointAt(pts, total * intro.lineProg);
}

function strokePolylineUntil(pts, untilLen) {
  if (pts.length < 2 || untilLen <= 0) return 0;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + len <= untilLen) {
      ctx.lineTo(pts[i].x, pts[i].y);
      acc += len;
      continue;
    }
    const t = (untilLen - acc) / (len || 1);
    ctx.lineTo(
      pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
      pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t
    );
    acc = untilLen;
    break;
  }
  ctx.stroke();
  return acc;
}

function drawRacingLineArrowhead(x, y, angle, size) {
  withWorldMarker(x, y, () => {
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.6, size * 0.55);
    ctx.lineTo(-size * 0.6, -size * 0.55);
    ctx.closePath();
    ctx.fill();
  });
}

function drawOneRacingLine(line, color, progress) {
  const pts = line.points.map(p => trackMetersToPixel(p.x, p.y));
  if (pts.length < 2) return;
  const total = polylineLength(pts);
  const until = total * Math.max(0, Math.min(1, progress));
  if (until <= 0.5) return;

  const m = worldMarkerScale();
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha *= 0.75;
  ctx.lineWidth = 3 * m;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  strokePolylineUntil(pts, until);
  ctx.restore();
  ctx.save();
  ctx.fillStyle = color;

  let distAlong = 0;
  const arrowSpacing = 48 * m;
  for (let j = 1; j < pts.length; j++) {
    const a = pts[j - 1];
    const b = pts[j];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    let d = arrowSpacing - (distAlong % arrowSpacing);
    while (d <= segLen && distAlong + d <= until) {
      const t = d / segLen;
      drawRacingLineArrowhead(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, ang, 8);
      d += arrowSpacing;
    }
    distAlong += segLen;
    if (distAlong >= until) break;
  }
  ctx.restore();
}

function drawTrackRacingLines(intro) {
  if (!showRacingLines) return;
  const lines = currentTrack?.racingLines;
  if (!lines?.length) return;

  if (intro) {
    if (!intro.line || intro.lineProg <= 0) return;
    const color = intro.line.color || RACING_LINE_COLORS[0];
    drawOneRacingLine(intro.line, color, intro.lineProg);
    return;
  }

  lines.forEach((line, i) => {
    if (line.visible === false || !line.points || line.points.length < 2) return;
    const color = line.color || RACING_LINE_COLORS[i % RACING_LINE_COLORS.length];
    drawOneRacingLine(line, color, 1);
  });
}

function drawIdealLine() {
  if (!showIdealLine) return;
  if (!idealLineData || !idealLineData.frames) return;

  if (idealLineData.trackKey && idealLineData.trackKey !== currentTrackKey) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
  ctx.lineWidth   = worldMarkerScale();
  ctx.beginPath();

  let started = false;
  for (let i = 0; i < idealLineData.frames.length; i++) {
    const frame = idealLineData.frames[i];
    const { x: px, y: py } = trackMetersToPixel(frame.x, frame.y);
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.restore();
}

// --- Main Game Loop ---
let lastTimestamp = 0;
let gamePaused = false;

function gameLoop(timestamp) {
  if (gamePaused) {
    requestAnimationFrame(gameLoop);
    return;
  }
  
  if (!lastTimestamp) lastTimestamp = timestamp;
  let dt = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;
  if (dt > 0.1) dt = 0.1;

  const settleReveal = (rideOverlayPending && rideOverlayTo > rideOverlayFrom) || rideIntroPending;
  stepRideOverlay(timestamp);
  stepRideIntro(timestamp);

  if (atlas.open) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stepAtlas(timestamp);
    if (atlas.open) {
      drawAtlas();
      requestAnimationFrame(gameLoop);
      return;
    }
    // Same frame as the dive/pull-out landing: start the sequenced intro
    // before drawing ride overlays, or the full racing line pops for a frame.
    stepRideIntro(timestamp);
  }

  rideIntroFrame = getRideIntro(timestamp);
  if (rideIntroFrame) setRideHudOpacity(rideIntroFrame.hud);

  if (!settleReveal && !rideSimPaused) {
    wakeTrail.push({ x: pos.x, y: pos.y });
    const targetWakeLength = (speed / maxSpeed) * 200;
    while (wakeTrail.length > 1 && totalTrailDistance(wakeTrail) > targetWakeLength) {
      wakeTrail.shift();
    }
    update(dt);
  } else if (rideIntroFrame) {
    updateFollowCamera(dt);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = geoCanvasTransform ? '#0c1a22' : '#222';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const camS = followCam.scale || 1;
  ctx.setTransform(camS, 0, 0, camS, followCam.tx, followCam.ty);
  drawGeoTiles();
  const intro = rideIntroFrame;
  const reveal = rideOverlay;
  if (geoCanvasTransform) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const overlayA = intro ? intro.gates : reveal;
    const overlay = 0.32 + 0.10 * overlayA;
    ctx.fillStyle = `rgba(6,14,20,${overlay})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(camS, 0, 0, camS, followCam.tx, followCam.ty);
  }

  if (intro) {
    ctx.save();
    drawTrackRacingLines(intro);
    drawTrack(intro);
    withDrawAlpha(intro.rider, () => {
      drawWake();
      drawGhostFrame();
      drawRacer();
    });
    ctx.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    withDrawAlpha(intro.hud, () => {
      drawTouchZones();
      drawTelemetry();
      drawZoomHint();
    });
  } else if (reveal > 0.001) {
    ctx.save();
    ctx.globalAlpha *= reveal;
    drawIdealLine();
    drawTrackRacingLines();
    drawTrack();
    drawWake();
    drawGhostFrame();
    drawRacer();
    ctx.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.globalAlpha *= reveal;
    drawTouchZones();
    drawTelemetry();
    drawZoomHint();
    ctx.restore();
  }

  requestAnimationFrame(gameLoop);
}

// --- Ghost Export / Import Controls ---
const exportGhostBtn  = document.getElementById('exportGhostBtn');
const importGhostFile = document.getElementById('importGhostFile');
const clearGhostBtn   = document.getElementById('clearGhostBtn');

exportGhostBtn.addEventListener('click', () => {
  if (!ghostDataMap.size > 0) {
    alert('No ghost data to export yet. Complete at least one lap.');
    return;
  }
  const jsonData = JSON.stringify(Array.from(ghostDataMap.values()));
  const blob = new Blob([jsonData], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href  = url;
  link.download = 'lapData.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
});

// Add a new function to calculate average speed correctly
function calculateAverageSpeed(distance, time) {
    if (!time || time <= 0) return 0;
    return (distance / time) * 3.6; // Convert m/s to km/h
}

function updateGhostStats() {
    const statsElement = document.getElementById('ghostStats');
    if (!currentGhost) {
        statsElement.textContent = `No ghost for ${currentTrack.name}`;
        return;
    }

    // Get the lap time and recorded average speed if available
    const lastFrame = currentGhost.frames[currentGhost.frames.length - 1];
    const time = lastFrame.finalLapTime ?? currentGhost.time ?? lastFrame.time;
    let avgSpeed = 0;
    
    // Try to get the average speed from stored ghost data
    if (currentGhost.avgSpeed !== undefined) {
        // Use pre-calculated average speed if available
        avgSpeed = currentGhost.avgSpeed;
    } else if (currentGhost.frames && currentGhost.frames.length > 0) {
        // If not available, try to calculate from frame data if possible
        // First check if frames have speed data
        if (currentGhost.frames[0].avgSpeedKmh !== undefined) {
            // Use the last frame's average speed
            const lastFrame = currentGhost.frames[currentGhost.frames.length - 1];
            avgSpeed = lastFrame.avgSpeedKmh || 0;
        } else {
            // Fall back to distance/time calculation as a last resort
            const distance = currentGhost.distance;
            if (distance && distance > 0) {
                avgSpeed = calculateAverageSpeed(distance, time);
            }
        }
    }
    
    const prefix = currentGhost.lineName || currentTrack.name;
    statsElement.replaceChildren();
    const nameLine = document.createElement('span');
    nameLine.textContent = `${prefix} Ghost`;
    const timeLine = document.createElement('span');
    timeLine.className = 'ghost-time';
    timeLine.textContent = `Time: ${time.toFixed(2)}s, Avg Speed: ${avgSpeed.toFixed(1)} km/h`;
    statsElement.append(nameLine, timeLine);
}

function applyImportedGhost(ghost, message) {
  if (!ghost?.frames?.length) {
    alert('No ghost frames to import.');
    return false;
  }
  ghost.trackKey = ghost.trackKey || currentTrackKey;
  ghostDataMap.set(ghost.trackKey, ghost);
  // Also bind to the active track so racing against it works immediately
  if (ghost.trackKey !== currentTrackKey) {
    const bound = { ...ghost, trackKey: currentTrackKey };
    ghostDataMap.set(currentTrackKey, bound);
  }
  currentGhost = ghostDataMap.get(currentTrackKey);
  setKeepCurrentGhost(true);
  showGhost = true;
  // Refit the map so the GPS path is on-screen (buoy-only fit hides lake rides)
  computeBuoys();
  placePlayerAtStart();
  startGhostPreview();
  updateGhostStats();
  if (message) alert(message);
  return true;
}

async function importSessionCsvText(text, fileName) {
  // With a geo-anchored track selected: project GPS through THAT track's
  // real-world origin — never re-center or invent a new layout.
  if (hasGeo(currentTrack)) {
    const { ghost, errors, warnings } = sessionCsvToGhost(text, currentTrack.geo, {
      trackKey: currentTrackKey,
      riderLabel: fileName
    });
    if (errors.length) throw new Error(errors.join('\n'));
    const note = warnings.length ? `\n\nNote: ${warnings.join(' ')}` : '';
    applyImportedGhost(ghost,
      `Session CSV imported as ghost on “${currentTrack.name}” ` +
      `(${ghost.frames.length} frames, ${ghost.time.toFixed(1)}s, ${ghost.distance.toFixed(0)} m).\n` +
      `Positions are real GPS via this track’s map anchor.\n` +
      `The pink ghost should start replaying immediately; cross the gate to race it.` + note);
    return;
  }

  // No geo track selected — only then build a temporary replay map from GPS.
  const built = trackFromSessionCsv(text, {
    trackKey: 'session',
    name: 'Session Replay',
    riderLabel: fileName
  });
  if (built.errors.length) throw new Error(built.errors.join('\n'));

  registerCustomTrack('session', built.track);
  selectTrack('session');
  placePlayerAtStart();
  speed = 0;
  bankAngleDeg = 0;
  wakeTrail = [];
  lapActive = false;

  const note = built.warnings.length ? `\n\nNote: ${built.warnings.join(' ')}` : '';
  applyImportedGhost(
    { ...built.ghost, trackKey: 'session' },
    `No geo track was selected, so a temporary Session Replay map was created from GPS.\n` +
    `For racing on your Orlando course: open that track first, then import the CSV.\n` +
    `Ghost: ${built.ghost.frames.length} frames, ${built.ghost.time.toFixed(1)}s, ${built.ghost.distance.toFixed(0)} m.` +
    note
  );
}

// Update the ghost import handler
importGhostFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const label = document.getElementById('fileLabel');
  if (label) label.textContent = file.name;
  try {
    const text = await file.text();
    const looksCsv = /\.csv$/i.test(file.name) ||
      text.trimStart().startsWith('# ExportVersion') ||
      /^Time,.*lat_deg/m.test(text);

    if (looksCsv) {
      await importSessionCsvText(text, file.name);
      return;
    }

    const imported = JSON.parse(text);

    if (Array.isArray(imported)) {
      imported.forEach(ghost => {
        if (ghost.trackKey && ghost.frames) {
          ghostDataMap.set(ghost.trackKey, ghost);
        }
      });
      currentGhost = ghostDataMap.get(currentTrackKey) || null;
      updateGhostStats();
      alert('Ghost data imported successfully! It will appear on your next lap.');
    } else if (imported.trackKey && imported.frames) {
      applyImportedGhost(imported, 'Ghost data imported successfully! It will appear on your next lap.');
    } else if (imported.frames) {
      applyImportedGhost(
        { ...imported, trackKey: currentTrackKey },
        'Ghost data imported successfully! It will appear on your next lap.'
      );
    } else {
      alert('Invalid ghost data file format.');
    }
  } catch (err) {
    alert('Failed to read file: ' + (err?.message || err));
  } finally {
    // Allow re-importing the same file
    e.target.value = '';
  }
});

const chooseFileBtn = document.getElementById('chooseFileBtn');
if (chooseFileBtn) {
  chooseFileBtn.addEventListener('click', () => importGhostFile.click());
}
// Update the checkbox handler
const showRacingLinesCheckbox = document.getElementById('showRacingLines');
if (showRacingLinesCheckbox) {
  showRacingLinesCheckbox.addEventListener('change', function(e) {
    setShowRacingLines(e.target.checked);
  });
}

document.getElementById('keepGhost').addEventListener('change', function(e) {
  setKeepCurrentGhost(e.target.checked);
});

// Update the clear button handler
clearGhostBtn.addEventListener('click', () => {
  ghostDataMap.clear();
  ghostWakeTrail = [];
  setKeepCurrentGhost(false);
  // Set currentGhost to null to fully clear it
  currentGhost = null; 
  showGhost = false;
  // Update checkbox
  const showGhostCheckbox = document.getElementById('showGhost');
  if (showGhostCheckbox) {
    showGhostCheckbox.checked = false;
  }
  updateGhostStats();
  alert('Ghost data cleared.');
});

function applyDefaultSavedTrack() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('data') || params.has('track')) return;
  const last = localStorage.getItem(LAST_RIDE_STORAGE_KEY);
  if (last && trackConfigs[savedTrackKey(last)]) {
    selectTrack(savedTrackKey(last));
    return;
  }
  const presets = loadUserTrackPresets();
  const geo = presets.find(p => presetGeoLatLng(p));
  const pick = geo || presets[0];
  if (pick) selectTrack(savedTrackKey(pick.id));
}

// --- Initialization ---
hydrateSavedTracks();
resizeCanvas();

// Parse URL parameters before initializing player position
parseURLParams();
applyDefaultSavedTrack();

// Initialize player position (track start position if defined, else default)
placePlayerAtStart();
updateGhostStats();

const bootParams = new URLSearchParams(window.location.search);
if (!loadUserTrackPresets().length && !bootParams.has('data') && bootParams.get('track') !== 'draft') {
  openAtlas({ immediate: true });
}

// Add drag and drop event handlers
const ghostControlsDiv = document.getElementById('ghostControls');

// Prevent default drag behaviors
ghostControlsDiv.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ghostControlsDiv.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
});

ghostControlsDiv.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ghostControlsDiv.style.backgroundColor = 'transparent';
});

// Handle the drop
ghostControlsDiv.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    ghostControlsDiv.style.backgroundColor = 'transparent';

    const file = e.dataTransfer.files[0];
    if (!file) return;
    const label = document.getElementById('fileLabel');
    if (label) label.textContent = file.name;

    try {
        const text = await file.text();
        const looksCsv = /\.csv$/i.test(file.name) ||
          text.trimStart().startsWith('# ExportVersion') ||
          /^Time,.*lat_deg/m.test(text);

        if (looksCsv) {
          await importSessionCsvText(text, file.name);
          return;
        }
        if (!/\.json$/i.test(file.name)) {
          alert('Please drop a .json ghost file or session .csv');
          return;
        }

        const imported = JSON.parse(text);
        if (Array.isArray(imported)) {
            imported.forEach(ghost => {
                if (ghost.trackKey && ghost.frames) {
                    ghostDataMap.set(ghost.trackKey, ghost);
                }
            });
            currentGhost = ghostDataMap.get(currentTrackKey) || null;
            updateGhostStats();
            alert('Ghost data imported successfully! It will appear on your next lap.');
        } else if (imported.frames) {
            applyImportedGhost(
              { ...imported, trackKey: imported.trackKey || currentTrackKey },
              'Ghost data imported successfully! It will appear on your next lap.'
            );
        } else {
            alert('Invalid ghost data file format.');
        }
    } catch (err) {
        alert('Failed to read file: ' + (err?.message || err));
    }
});

// Add near other initialization code
const touchControls = {
    activeZones: {
        leftUpper: false,  // Lean left
        leftLower: false,  // Lean right
        rightUpper: false, // Accelerate
        rightLower: false  // Decelerate
    },
    pinchStartDist: 0,
    pinchFired: false,

    init() {
        canvas.addEventListener('touchstart', this.handleTouch.bind(this), { passive: false });
        canvas.addEventListener('touchmove', this.handleTouch.bind(this), { passive: false });
        canvas.addEventListener('touchend', this.handleTouchEnd.bind(this), { passive: false });
        canvas.addEventListener('touchcancel', this.handleTouchEnd.bind(this), { passive: false });
    },

    pinchDistance(touches) {
        if (touches.length < 2) return 0;
        const a = touches[0], b = touches[1];
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    },

    resetPinch() {
        this.pinchStartDist = 0;
        this.pinchFired = false;
    },

    isViewPinch(touches) {
        if (!touches || touches.length !== 2) return false;
        return contactsAreViewPinch([
            { x: touches[0].clientX, y: touches[0].clientY },
            { x: touches[1].clientX, y: touches[1].clientY }
        ]);
    },

    handlePinch(e) {
        const dist = this.pinchDistance(e.touches);
        if (dist < 8) return true;
        if (this.pinchStartDist < 8) {
            this.pinchStartDist = dist;
            return true;
        }
        // One zoom stop per two-finger gesture; lift fingers to pinch again.
        if (this.pinchFired) return true;
        const ratio = dist / this.pinchStartDist;
        // Map-style: spread → zoom in toward race; pinch together → zoom out to overview.
        if (ratio > 1.18) {
            nudgeZoomStop(-1);
            this.pinchFired = true;
        } else if (ratio < 1 / 1.18) {
            // Already at 5 km: pinch out further opens the world atlas.
            if (!nudgeZoomStop(1)) requestAtlas();
            this.pinchFired = true;
        }
        return true;
    },

    clearRacingKeys() {
        Object.keys(this.activeZones).forEach(zone => {
            this.activeZones[zone] = false;
        });
        keys['ArrowLeft'] = false;
        keys['ArrowRight'] = false;
        keys['ArrowUp'] = false;
        keys['ArrowDown'] = false;
    },

    applyRacingTouches(touches) {
        Object.keys(this.activeZones).forEach(zone => {
            this.activeZones[zone] = false;
        });
        for (let i = 0; i < touches.length; i++) {
            const touch = touches[i];
            this.activeZones[this.getZone(touch.clientX, touch.clientY)] = true;
        }
        if (this.activeZones.leftUpper) {
            keys['ArrowLeft'] = true;
            keys['ArrowRight'] = false;
        } else if (this.activeZones.leftLower) {
            keys['ArrowLeft'] = false;
            keys['ArrowRight'] = true;
        } else {
            keys['ArrowLeft'] = false;
            keys['ArrowRight'] = false;
        }
        if (this.activeZones.rightUpper) {
            keys['ArrowUp'] = true;
            keys['ArrowDown'] = false;
        } else if (this.activeZones.rightLower) {
            keys['ArrowUp'] = false;
            keys['ArrowDown'] = true;
        } else {
            keys['ArrowUp'] = false;
            keys['ArrowDown'] = false;
        }
    },

    handleAtlasTouch(e) {
        if (atlasEls.confirm.classList.contains('open')) return;
        atlas.usedTouch = true;
        atlas.pointers.clear();
        for (let i = 0; i < e.touches.length; i++) {
            const t = e.touches[i];
            atlas.pointers.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
        if (e.touches.length >= 2) {
            atlas.tap = null;
            handleAtlasPinch();
            return;
        }
        if (e.type === 'touchstart' && e.touches.length === 1) {
            const t = e.touches[0];
            atlas.tap = { id: t.identifier, x: t.clientX, y: t.clientY, moved: false };
            atlas.pinchStartDist = 0;
            atlas.pinchFired = false;
            return;
        }
        if (atlas.tap && e.touches.length === 1) {
            const t = e.touches[0];
            if (Math.hypot(t.clientX - atlas.tap.x, t.clientY - atlas.tap.y) > 16) {
                atlas.tap.moved = true;
            }
        }
    },

    handleAtlasTouchEnd(e) {
        const tap = atlas.tap;
        for (let i = 0; i < e.changedTouches.length; i++) {
            atlas.pointers.delete(e.changedTouches[i].identifier);
        }
        if (e.touches.length < 2) {
            atlas.pinchStartDist = 0;
            atlas.pinchFired = false;
        }
        const endedTap = tap && e.touches.length === 0 && !tap.moved && !atlas.pinchFired;
        if (endedTap) onAtlasTap(tap.x, tap.y);
        if (e.touches.length === 0) atlas.tap = null;
    },

    getZone(x, y) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const midX = width / 2;
        
        if (x < midX) {
            const slope = height / midX;
            const touchY = height - y;
            const lineY = slope * x;
            return touchY > lineY ? 'leftUpper' : 'leftLower';
        } else {
            const slope = height / midX;
            const touchY = y;
            const lineY = slope * (x - midX);
            return touchY < lineY ? 'rightUpper' : 'rightLower';
        }
    },

    handleTouch(e) {
        e.preventDefault();

        if (atlas.open) {
            this.handleAtlasTouch(e);
            return;
        }

        if (this.isViewPinch(e.touches)) {
            this.clearRacingKeys();
            this.handlePinch(e);
            return;
        }
        this.resetPinch();
        this.applyRacingTouches(e.touches);
    },

    handleTouchEnd(e) {
        if (atlas.open) {
            this.handleAtlasTouchEnd(e);
            return;
        }
        if (e.touches.length < 2) {
            this.resetPinch();
        }
        if (e.touches.length === 0) {
            Object.keys(this.activeZones).forEach(zone => {
                this.activeZones[zone] = false;
            });
            keys['ArrowLeft'] = false;
            keys['ArrowRight'] = false;
            keys['ArrowUp'] = false;
            keys['ArrowDown'] = false;
        } else {
            this.handleTouch(e);
        }
    }
};

// Prevent default touch behaviors
document.addEventListener('touchmove', (e) => {
    e.preventDefault();
}, { passive: false });

document.addEventListener('gesturestart', (e) => {
    e.preventDefault();
});

// Initialize touch controls if device supports touch
if ('ontouchstart' in window) {
    touchControls.init();
}

if (atlasEls.hud && typeof PointerEvent === 'undefined') {
    const opts = { passive: false };
    atlasEls.hud.addEventListener('touchstart', e => {
        if (!atlas.open || atlasChromeTarget(e.target)) return;
        e.preventDefault();
        touchControls.handleAtlasTouch(e);
    }, opts);
    atlasEls.hud.addEventListener('touchmove', e => {
        if (!atlas.open || atlasChromeTarget(e.target)) return;
        e.preventDefault();
        touchControls.handleAtlasTouch(e);
    }, opts);
    atlasEls.hud.addEventListener('touchend', e => {
        if (!atlas.open) return;
        e.preventDefault();
        touchControls.handleAtlasTouchEnd(e);
    }, opts);
    atlasEls.hud.addEventListener('touchcancel', e => {
        if (!atlas.open) return;
        touchControls.handleAtlasTouchEnd(e);
    }, opts);
}

function drawTouchZones() {
    if (atlas.open) return;
    if (!('ontouchstart' in window)) return;

    const width = canvas.width;
    const height = canvas.height;
    const midX = width / 2;

    // One dashed split: left thumb crosses it for left/right, right thumb for faster/slower.
    ctx.save();
    ctx.strokeStyle = 'rgba(127, 212, 255, 0.55)';
    ctx.lineWidth = 1.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([8, 7]);
    ctx.beginPath();
    ctx.moveTo(0, height);
    ctx.lineTo(midX, 0);
    ctx.lineTo(width, height);
    ctx.stroke();
    ctx.restore();
}

function handleLapTiming() {
    const crossing = checkGateCrossing(prevPos, pos);
    
    if (!crossing) {
        // If directional gates and we're not actually crossing a gate,
        // check if we're moving away from the start line - helps reset validCrossing
        // if player backs away from the gate
        if (currentTrack.requiresDirectionalGates && validCrossing) {
            // Get distance to start gate
            if (computedGates && computedGates.start) {
                const gateMidX = (computedGates.start.x1 + computedGates.start.x2) / 2;
                const gateMidY = (computedGates.start.y1 + computedGates.start.y2) / 2;
                
                // Check if we're moving away from gate
                const distOld = Math.hypot(prevPos.x - gateMidX, prevPos.y - gateMidY);
                const distNew = Math.hypot(pos.x - gateMidX, pos.y - gateMidY);
                
                // If we're moving away from the gate by a significant amount
                if (distNew > distOld + 50) {
                    validCrossing = false;
                }
            }
        }
        return;
    }

    // Add debounce for crossing detection (500ms cooldown between detections)
    const now = performance.now();
    if (now - lastCrossingTime < 500) {
        return; // Ignore crossings that happen too quickly
    }
    
    // Update the last crossing time
    lastCrossingTime = now;

    if (currentTrack.useGates) {
        if (currentTrack.requiresDirectionalGates) {
            // Calculate crossing direction
            const dir = gateDirectionPx();
            const dot = (pos.x - prevPos.x) * dir.x + (pos.y - prevPos.y) * dir.y;
            if (dot < 0) {
                // Crossing against the required direction, reset valid crossing state
                validCrossing = false;
                return;
            }
            
            // Valid left-to-right crossing
            if (!validCrossing) {
                validCrossing = true;
                startLap();
            } else {
                completeLap();
                validCrossing = false;
            }
        } else {
            // Normal gate handling
            if (crossing === 'start') {
                // Only start a new lap if no lap is currently active
                if (!lapActive) {
                    startLap();
                }
                // If a lap is active, ignore the start gate crossing
            } else if (crossing === 'finish') {
                // Only complete lap if a lap is actually active
                if (!lapActive) {
                    return; // Ignore finish gate crossings when no lap is active
                }
                
                // Special handling for directional finish gates (e.g. Sicily)
                if (currentTrack.directionalFinishGate && crossing === 'finish') {
                    const dir = gateDirectionPx();
                    const dot = (pos.x - prevPos.x) * dir.x + (pos.y - prevPos.y) * dir.y;
                    if (dot <= 0) {
                        // Crossing against the required direction, ignore it
                        return;
                    }
                }
                
                completeLap();
            }
        }
    } else {
        // Old timing line system
        if (crossing === 'start') {
            // Only start a new lap if no lap is currently active
            if (!lapActive) {
                startLap();
            }
            // If a lap is active, ignore the start crossing
        } else if (crossing === 'finish') {
            // Only complete lap if a lap is actually active
            if (lapActive) {
                completeLap();
            }
        }
    }
}

// Add new gate crossing detection that checks direction
function crossedGateInCorrectDirection(oldPos, newPos, gate) {
    // Create gate vector (from point 1 to point 2)
    const gateVector = {
        x: gate.x2 - gate.x1,
        y: gate.y2 - gate.y1
    };
    
    // Create movement vector
    const moveVector = {
        x: newPos.x - oldPos.x,
        y: newPos.y - oldPos.y
    };
    
    // Calculate cross product to determine direction
    // For 2D vectors, cross product is just: (a.x * b.y - a.y * b.x)
    const crossProduct = gateVector.x * moveVector.y - gateVector.y * moveVector.x;
    
    // Positive cross product means counter-clockwise, negative means clockwise
    return crossProduct < 0; // Return true if crossing from left to right relative to gate
}

// Update the initialization section to properly initialize prevPos
function resetTrack() {
    speed = 0;
    bankAngleDeg = 0;
    wakeTrail = [];
    
    pos.x = (canvas.width / 2) - 4; // Shift 4px to the left
    pos.y = canvas.height - 150;
    prevPos.x = pos.x;
    prevPos.y = pos.y;
    
    heading = -Math.PI / 2;
    validCrossing = false;
    
    idealLineData = null;
    showIdealLine = false;
    ghostWakeTrail = [];
}

function updateLapTimeDisplay() {
    const lapTimeStr = currentLapTime.toFixed(2);
    const penaltyText = collidedThisLap ? ` (+${penaltySeconds}s penalty!)` : '';
    document.getElementById('lapTimeDisplay').innerText = `Laptime: ${lapTimeStr}${penaltyText}`;
}

// Export these for highscores.js before constructing HighScoreManager so the
// engine ↔ highscores circular import can resolve cleanly.
export function pauseGame() {
    gamePaused = true;
}

export function resumeGame() {
    gamePaused = false;
    lastTimestamp = performance.now();  // Prevent time jump
}

const highScoreManager = new HighScoreManager();

requestAnimationFrame(gameLoop);

// Make these variables accessible globally for the highscore system
window.currentTrackKey = currentTrackKey;
window.trackConfigs = trackConfigs;
window.updateGhostStats = updateGhostStats;
window.keepCurrentGhost = keepCurrentGhost;
window.ghostDataMap = ghostDataMap;
window.startLap = startLap; // Expose startLap function

// Add a helper function to enable ghost racing for debugging
window.enableGhostRacing = function() {
  const ghost = ghostDataMap.get(currentTrackKey);
  if (ghost) {
    currentGhost = ghost;
    setKeepCurrentGhost(true);
    showGhost = true;
    
    // Update checkboxes if they exist
    
    const showGhostCheckbox = document.getElementById('showGhost');
    if (showGhostCheckbox) {
      showGhostCheckbox.checked = true;
    }
    
    updateGhostStats();
    return true;
  } else {
    console.log("No ghost data available for track: " + currentTrackKey);
    return false;
  }
};

// Add a helper to disable ghost racing too
window.disableGhostRacing = function() {
  showGhost = false;
  
  const showGhostCheckbox = document.getElementById('showGhost');
  if (showGhostCheckbox) {
    showGhostCheckbox.checked = false;
  }
  
  return true;
};

// Add this function after handleLapTiming function
function debugDirectionalCrossing() {
    // Only run for tracks with a directional finish gate
    if (!currentTrack.directionalFinishGate) return;
    
    // Check if crossing the finish gate
    if (computedGates && computedGates.finish) {
        const isIntersecting = lineIntersection(
            prevPos.x, prevPos.y,
            pos.x, pos.y,
            computedGates.finish.x1, computedGates.finish.y1,
            computedGates.finish.x2, computedGates.finish.y2
        );
        
        if (isIntersecting) {
            // Check direction
            const moveVectorX = pos.x - prevPos.x;
            const isLeftToRight = moveVectorX > 0;
            
            console.log(`Sicily finish gate crossed: ${isLeftToRight ? 'LEFT TO RIGHT ✓' : 'RIGHT TO LEFT ✗'}`);
        }
    }
}

// Create fullscreen button
createFullscreenButton();
