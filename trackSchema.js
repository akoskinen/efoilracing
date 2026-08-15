////////////////////////////////////////////////////////////
// trackSchema.js
////////////////////////////////////////////////////////////
// Declarative track format shared by the simulator (engine.js)
// and the Track Designer (designer.js).
//
// All coordinates are in TRACK METERS (y grows "up" on screen).
//
// Declarative track shape:
// {
//   schemaVersion: 1,
//   name, author, notes,
//   scale: 4,                          // meters -> pixels in the simulator
//   buoys: [{ x, y, type: 'turn'|'marker', rounding: 'left'|'right',
//             apexRadius, optimalSpeed }],
//   gate: {
//     sameStartFinish: true,
//     directional: false,              // ALL crossings must match `direction`
//     directionalFinish: false,        // only finish crossings must match
//     direction: { x: 1, y: 0 },       // required crossing direction (meters)
//     start:  { x1, y1, x2, y2 },      // meters
//     finish: { x1, y1, x2, y2 }       // meters, used when !sameStartFinish
//   },
//   startPosition: { x, y, headingDeg }, // headingDeg: 0 = +x, 90 = +y (up)
//   geo: {                               // optional real-world anchor
//     origin: { lat, lng },              // lat/lng of track meters (0,0)
//     rotationDeg: 0                     // CCW rotation of the +x axis from East
//   }
// }
////////////////////////////////////////////////////////////

export const TRACK_SCHEMA_VERSION = 1;
export const DRAFT_STORAGE_KEY = 'efoil_track_draft';
export const LINE_CAPTURE_KEY = 'efoil_line_capture';
export const LINE_RECORD_META_KEY = 'efoil_line_record_meta';

// Palette for multiple circuits on one venue (Munich-style heat formats).
export const RACING_LINE_COLORS = ['#00e5ff', '#ff6bcb', '#ffd54a', '#7cfc00', '#ff7043'];

function lz() {
  const g = (typeof window !== 'undefined') ? window.LZString : null;
  if (!g) throw new Error('lz-string library not loaded (lib/lz-string.min.js)');
  return g;
}

export function isDeclarativeTrack(track) {
  return !!(track && track.gate);
}

/** Buoy rounding side: leave the mark to your left or right. Legacy port/starboard map to left/right. */
export function normalizeRounding(rounding) {
  if (rounding === 'right' || rounding === 'starboard') return 'right';
  if (rounding === 'left' || rounding === 'port') return 'left';
  return 'left';
}

// --- Geo anchoring (WGS84 / Web Mercator, matching Leaflet & Esri tiles) ---
export const WGS84_RADIUS = 6378137.0;
const WGS84_CIRCUMFERENCE = 2 * Math.PI * WGS84_RADIUS;
const M_PER_DEG_LAT = WGS84_CIRCUMFERENCE / 360; // ~111319.49 m

export function hasGeo(track) {
  return !!(track && track.geo && track.geo.origin &&
    Number.isFinite(track.geo.origin.lat) && Number.isFinite(track.geo.origin.lng));
}

export function metersToLatLng(geo, x, y) {
  const r = ((geo.rotationDeg || 0) * Math.PI) / 180;
  const east = x * Math.cos(r) - y * Math.sin(r);
  const north = x * Math.sin(r) + y * Math.cos(r);
  const lat = geo.origin.lat + north / M_PER_DEG_LAT;
  const lng = geo.origin.lng + east / (M_PER_DEG_LAT * Math.cos(geo.origin.lat * Math.PI / 180));
  return { lat, lng };
}

export function latLngToMeters(geo, lat, lng) {
  const north = (lat - geo.origin.lat) * M_PER_DEG_LAT;
  const east = (lng - geo.origin.lng) * M_PER_DEG_LAT * Math.cos(geo.origin.lat * Math.PI / 180);
  const r = (-(geo.rotationDeg || 0) * Math.PI) / 180;
  return {
    x: east * Math.cos(r) - north * Math.sin(r),
    y: east * Math.sin(r) + north * Math.cos(r)
  };
}

// Web-mercator world pixel coordinates at a given tile zoom (256px tiles).
export function latLngToWorldPx(lat, lng, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const sinLat = Math.sin(lat * Math.PI / 180);
  return {
    x: (lng + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  };
}

export function worldPxToLatLng(wx, wy, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const lng = wx / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * wy / scale;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

export function metersPerPixel(lat, zoom) {
  return Math.cos(lat * Math.PI / 180) * WGS84_CIRCUMFERENCE / (256 * Math.pow(2, zoom));
}

export function haversineMeters(a, b) {
  const toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat);
  const dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * WGS84_RADIUS * Math.asin(Math.sqrt(s));
}

// Ground distance between two track-meter points on a geo-anchored track.
export function groundDistanceMeters(geo, ax, ay, bx, by) {
  return haversineMeters(
    metersToLatLng(geo, ax, ay),
    metersToLatLng(geo, bx, by)
  );
}

export function createDefaultTrack(name = 'New Track') {
  return {
    schemaVersion: TRACK_SCHEMA_VERSION,
    name,
    author: '',
    notes: '',
    scale: 4,
    buoys: [
      { x: 150, y: 30,  type: 'turn', rounding: 'left', apexRadius: 40, optimalSpeed: 30 },
      { x: 150, y: 110, type: 'turn', rounding: 'left', apexRadius: 40, optimalSpeed: 30 },
      { x: 10,  y: 110, type: 'turn', rounding: 'left', apexRadius: 40, optimalSpeed: 30 },
      { x: 10,  y: 30,  type: 'turn', rounding: 'left', apexRadius: 40, optimalSpeed: 30 }
    ],
    gate: {
      sameStartFinish: true,
      directional: false,
      directionalFinish: false,
      direction: { x: 1, y: 0 },
      start: { x1: 80, y1: 10, x2: 80, y2: 50 },
      finish: null
    },
    startPosition: { x: 50, y: 30, headingDeg: 0 }
  };
}

/**
 * Official Speedtrack triangle in track meters.
 * Legs: #1→#2 70 m, #2→#3 55 m, #3→#1 105 m.
 * Rounding (spec): #1 left, #2 left, #3 right.
 * Timing line sits at buoy #1, parallel to #2→#3.
 */
export function createOfficialSpeedtrack() {
  const d12 = 70;
  const d23 = 55;
  const d31 = 105;
  const cosA = (d31 * d31 + d12 * d12 - d23 * d23) / (2 * d31 * d12);
  const angleA = Math.acos(Math.min(1, Math.max(-1, cosA)));

  // #1 at origin, #2 along +y, #3 to the right (+x) of the 1→2 heading.
  const b1 = { x: 0, y: 0 };
  const b2 = { x: 0, y: d12 };
  const b3 = { x: d31 * Math.sin(angleA), y: d31 * Math.cos(angleA) };

  // Gate: one end on buoy #1, other end along the #2→#3 heading (same angle).
  const v23x = b3.x - b2.x;
  const v23y = b3.y - b2.y;
  const len23 = Math.hypot(v23x, v23y) || 1;
  const ux = v23x / len23;
  const uy = v23y / len23;
  const gateLen = 47;

  const ox = 80;
  const oy = 50;
  const r2 = v => Math.round(v * 100) / 100;
  const move = p => ({ x: r2(p.x + ox), y: r2(p.y + oy) });
  const p1 = move(b1);
  const p2 = move(b2);
  const p3 = move(b3);

  return {
    schemaVersion: TRACK_SCHEMA_VERSION,
    name: 'Official Speedtrack',
    author: '',
    notes:
      'Official Speedtrack — 70 / 55 / 105 m triangle. ' +
      'Round #1 left, #2 left, #3 right. Timing line at #1, parallel to #2–#3. ' +
      'Theoretical line ~325 m, target lap ~30 s @ ~39 km/h.',
    scale: 4,
    buoys: [
      { x: p1.x, y: p1.y, type: 'turn', rounding: 'left', apexRadius: 40, optimalSpeed: 30 },
      { x: p2.x, y: p2.y, type: 'turn', rounding: 'left', apexRadius: 40, optimalSpeed: 30 },
      { x: p3.x, y: p3.y, type: 'turn', rounding: 'right', apexRadius: 40, optimalSpeed: 30 }
    ],
    gate: {
      sameStartFinish: true,
      directional: false,
      directionalFinish: false,
      // Cross heading along #1→#2 into the course
      direction: { x: 0, y: 1 },
      start: {
        x1: p1.x,
        y1: p1.y,
        x2: r2(b1.x + ux * gateLen + ox),
        y2: r2(b1.y + uy * gateLen + oy)
      },
      finish: null
    },
    startPosition: {
      x: r2(b1.x + ox),
      y: r2(b1.y - 45 + oy),
      headingDeg: 90
    }
  };
}

/** Mirror layout across a vertical axis through the bbox center; swap left/right rounding. */
export function flipTrackLayout(track) {
  const b = trackBBox(track);
  const cx = b ? (b.minX + b.maxX) / 2 : 0;
  const fx = x => 2 * cx - x;
  const flipPt = p => p && Number.isFinite(p.x) ? { ...p, x: fx(p.x) } : p;
  const flipSeg = s => isSegment(s)
    ? { ...s, x1: fx(s.x1), x2: fx(s.x2) }
    : s;

  (track.buoys || []).forEach(buoy => {
    buoy.x = fx(buoy.x);
    if (buoy.type !== 'marker') {
      buoy.rounding = normalizeRounding(buoy.rounding) === 'right' ? 'left' : 'right';
    }
  });
  if (track.gate) {
    track.gate.start = flipSeg(track.gate.start);
    track.gate.finish = flipSeg(track.gate.finish);
    if (track.gate.direction && Number.isFinite(track.gate.direction.x)) {
      track.gate.direction = { x: -track.gate.direction.x, y: track.gate.direction.y };
    }
  }
  if (track.startPosition && Number.isFinite(track.startPosition.x)) {
    track.startPosition.x = fx(track.startPosition.x);
    if (Number.isFinite(track.startPosition.headingDeg)) {
      track.startPosition.headingDeg = ((180 - track.startPosition.headingDeg + 540) % 360) - 180;
    }
  }
  (track.racingLines || []).forEach(line => {
    if (Array.isArray(line.points)) {
      line.points = line.points.map(p => flipPt(p));
    }
    if (line.ghost?.frames) {
      line.ghost.frames = line.ghost.frames.map(f => ({ ...f, x: fx(f.x) }));
    }
  });
  return track;
}

export const BUILTIN_TRACK_PRESETS = [
  {
    id: 'official-speedtrack',
    name: 'Official Speedtrack',
    builtin: true,
    meta: '70·55·105 m',
    create: createOfficialSpeedtrack
  }
];

export const TRACK_PRESETS_STORAGE_KEY = 'efoil_track_presets_v1';

function newPresetId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** ISO 3166-1 alpha-2 → regional-indicator flag emoji (FI → 🇫🇮). */
export function countryFlagEmoji(iso2) {
  const cc = String(iso2 || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(
    0x1F1E6 + cc.charCodeAt(0) - 65,
    0x1F1E6 + cc.charCodeAt(1) - 65
  );
}

/** Venue used to group saved tracks by country. */
export function placeFromTrack(track) {
  if (!hasGeo(track)) return null;
  const lat = track.geo.origin.lat;
  const lng = track.geo.origin.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    rotationDeg: Number(track.geo.rotationDeg) || 0
  };
}

/** Layout-only clone for templates (no geo / racing lines) so it can be placed anywhere. */
export function trackAsPresetTemplate(track, name) {
  const s = serializeTrack(track);
  delete s.geo;
  delete s.racingLines;
  s.name = (name && String(name).trim()) || s.name || 'Saved preset';
  s.notes = s.notes || '';
  return s;
}

/** Full track clone for the saved-tracks list, including map location. */
export function trackAsSavedTrack(track, name) {
  const s = serializeTrack(track);
  s.name = (name && String(name).trim()) || s.name || 'Saved track';
  return s;
}

export function loadUserTrackPresets() {
  try {
    const raw = localStorage.getItem(TRACK_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(p => p && p.id && p.track && Array.isArray(p.track.buoys));
  } catch (e) {
    return [];
  }
}

function saveUserTrackPresets(list) {
  localStorage.setItem(TRACK_PRESETS_STORAGE_KEY, JSON.stringify(list));
}

export function saveUserTrackPreset(track, name) {
  const list = loadUserTrackPresets();
  const preset = {
    id: newPresetId(),
    name: (name && String(name).trim()) || track.name || 'Saved track',
    savedAt: new Date().toISOString(),
    kind: 'track',
    track: trackAsSavedTrack(track, name)
  };
  const place = placeFromTrack(track);
  if (place) preset.place = place;
  list.unshift(preset);
  saveUserTrackPresets(list);
  return preset;
}

export function replaceUserTrackPreset(id, track, name) {
  const list = loadUserTrackPresets();
  const i = list.findIndex(p => p.id === id);
  if (i < 0) return null;
  const nm = (name && String(name).trim()) || track.name || list[i].name;
  const next = {
    ...list[i],
    name: nm,
    savedAt: new Date().toISOString(),
    kind: 'track',
    track: trackAsSavedTrack(track, nm)
  };
  const place = placeFromTrack(track);
  if (place) next.place = { ...(list[i].place || {}), ...place };
  list[i] = next;
  saveUserTrackPresets(list);
  return next;
}

export function patchUserTrackPreset(id, patch) {
  const list = loadUserTrackPresets();
  const i = list.findIndex(p => p.id === id);
  if (i < 0) return null;
  const next = { ...list[i], ...patch, id: list[i].id, track: list[i].track };
  if (patch.place) next.place = { ...(list[i].place || {}), ...patch.place };
  list[i] = next;
  saveUserTrackPresets(list);
  return next;
}

export function deleteUserTrackPreset(id) {
  const list = loadUserTrackPresets().filter(p => p.id !== id);
  saveUserTrackPresets(list);
  return list;
}

export function getTrackPresetById(id) {
  const builtin = BUILTIN_TRACK_PRESETS.find(p => p.id === id);
  if (builtin) {
    return {
      id: builtin.id,
      name: builtin.name,
      builtin: true,
      kind: 'preset',
      track: builtin.create()
    };
  }
  const saved = loadUserTrackPresets().find(p => p.id === id);
  if (!saved) return null;
  return { ...saved, builtin: false, kind: saved.kind || 'track' };
}

/** Restore a saved track's map anchor from geo, or from stored/looked-up place. */
export function geoFromSavedEntry(entry) {
  if (hasGeo(entry?.track)) {
    return {
      origin: { ...entry.track.geo.origin },
      rotationDeg: Number(entry.track.geo.rotationDeg) || 0
    };
  }
  const p = entry?.place;
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
    return {
      origin: { lat: p.lat, lng: p.lng },
      rotationDeg: Number(p.rotationDeg) || 0
    };
  }
  return null;
}

function isSegment(s) {
  return !!s && [s.x1, s.y1, s.x2, s.y2].every(v => Number.isFinite(v));
}

function segLength(s) {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

export function trackBBox(track) {
  const pts = [];
  (track.buoys || []).forEach(b => {
    if (Number.isFinite(b?.x) && Number.isFinite(b?.y)) pts.push({ x: b.x, y: b.y });
  });
  const addSeg = s => {
    if (isSegment(s)) pts.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
  };
  if (track.gate) { addSeg(track.gate.start); addSeg(track.gate.finish); }
  if (track.startPosition && Number.isFinite(track.startPosition.x)) {
    pts.push({ x: track.startPosition.x, y: track.startPosition.y });
  }
  if (pts.length === 0) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}

export function validateTrack(track) {
  const errors = [];
  const warnings = [];

  if (!track || typeof track !== 'object') {
    return { errors: ['Track data is not an object'], warnings };
  }
  if (!Array.isArray(track.buoys)) {
    errors.push('Track has no buoy list');
  } else {
    track.buoys.forEach((b, i) => {
      if (!Number.isFinite(b?.x) || !Number.isFinite(b?.y)) {
        errors.push(`Buoy ${i + 1} has invalid coordinates`);
      }
    });
    const turns = track.buoys.filter(b => b.type !== 'marker');
    if (turns.length < 2) warnings.push('Fewer than 2 turn buoys — the course has no real lap shape yet');
  }

  if (!track.gate || !isSegment(track.gate.start)) {
    errors.push('Track needs a start/finish gate');
  } else {
    if (segLength(track.gate.start) < 5) warnings.push('Start gate is narrower than 5 m');
    if (track.gate.sameStartFinish === false && !isSegment(track.gate.finish)) {
      errors.push('Separate finish gate is enabled but has not been placed');
    }
  }

  if (!track.name || !String(track.name).trim()) warnings.push('Track has no name');
  if (!track.startPosition || !Number.isFinite(track.startPosition.x)) {
    warnings.push('No start position set — the rider will start at a default spot');
  }

  const bbox = trackBBox(track);
  if (bbox && (bbox.w > 300 || bbox.h > 160)) {
    warnings.push(`Track area is ${Math.round(bbox.w)} × ${Math.round(bbox.h)} m — may not fit on smaller screens (recommended max ~300 × 160 m)`);
  }

  return { errors, warnings };
}

export function trackStats(track) {
  const turns = (track.buoys || []).filter(b => b.type !== 'marker' && Number.isFinite(b?.x));
  let lapLengthM = 0;
  let lapLengthGroundM = 0;
  const legDistances = [];
  if (turns.length >= 2) {
    for (let i = 0; i < turns.length; i++) {
      const a = turns[i];
      const b = turns[(i + 1) % turns.length];
      const trackDist = Math.hypot(b.x - a.x, b.y - a.y);
      lapLengthM += trackDist;
      const groundDist = hasGeo(track)
        ? groundDistanceMeters(track.geo, a.x, a.y, b.x, b.y)
        : trackDist;
      lapLengthGroundM += groundDist;
      legDistances.push({ from: i + 1, to: (i + 1) % turns.length + 1, trackM: trackDist, groundM: groundDist });
    }
  }
  return {
    turnCount: turns.length,
    markerCount: (track.buoys || []).length - turns.length,
    lapLengthM,
    lapLengthGroundM: hasGeo(track) ? lapLengthGroundM : lapLengthM,
    legDistances,
    gateWidthM: (track.gate && isSegment(track.gate.start)) ? segLength(track.gate.start) : 0,
    bbox: trackBBox(track)
  };
}

// Converts a declarative track into the runtime shape engine.js expects
// (useGates flag, gates.computeGates(), direction flags, buoy turnIndex).
// Legacy function-based configs (no `gate` field) are returned untouched.
export function normalizeTrack(track) {
  if (!isDeclarativeTrack(track)) return track;
  const gate = track.gate;
  const sameStartFinish = gate.sameStartFinish !== false;

  let turnCounter = 0;
  (track.buoys || []).forEach(b => {
    if (b.type === 'marker') {
      b.turnIndex = null;
    } else {
      turnCounter += 1;
      b.turnIndex = turnCounter;
      b.rounding = normalizeRounding(b.rounding);
    }
    if (b.aliases == null) b.aliases = (b.turnIndex != null) ? [b.turnIndex] : [];
    if (b.apexRadius == null) b.apexRadius = 40;
  });

  track.useGates = true;
  track.requiresDirectionalGates = !!gate.directional;
  track.directionalFinishGate = !!gate.directionalFinish;

  track.gates = {
    sameStartFinish,
    computeGates: function(trackMetersToPixel) {
      const seg = g => {
        const p1 = trackMetersToPixel(g.x1, g.y1);
        const p2 = trackMetersToPixel(g.x2, g.y2);
        return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
      };
      const out = { start: seg(gate.start) };
      out.finish = (sameStartFinish || !isSegment(gate.finish)) ? out.start : seg(gate.finish);
      if (track.parallelTrack) {
        const sep = track.trackSeparation || 0;
        const shift = g => ({ x1: g.x1, y1: g.y1 + sep, x2: g.x2, y2: g.y2 + sep });
        out.parallelStart = seg(shift(gate.start));
        out.parallelFinish = (sameStartFinish || !isSegment(gate.finish))
          ? out.parallelStart
          : seg(shift(gate.finish));
      }
      return out;
    }
  };

  return track;
}

// --- Racing line path simplification (Ramer–Douglas–Peucker) ---
function perpDistM(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function simplifyPath(points, toleranceM = 1.5) {
  if (!points || points.length <= 2) {
    return (points || []).map(p => ({ x: p.x, y: p.y }));
  }
  const pts = points.map(p => ({ x: p.x, y: p.y }));
  const keep = new Set([0, pts.length - 1]);

  function douglasPeucker(start, end) {
    let maxDist = 0;
    let maxIdx = 0;
    const a = pts[start];
    const b = pts[end];
    for (let i = start + 1; i < end; i++) {
      const d = perpDistM(pts[i], a, b);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceM) {
      keep.add(maxIdx);
      douglasPeucker(start, maxIdx);
      douglasPeucker(maxIdx, end);
    }
  }
  douglasPeucker(0, pts.length - 1);
  return [...keep].sort((a, b) => a - b).map(i => ({ x: pts[i].x, y: pts[i].y }));
}

function thinGhostFrames(frames, maxFrames = 400) {
  if (!frames || frames.length <= maxFrames) return frames || [];
  const step = Math.ceil(frames.length / maxFrames);
  const out = [];
  for (let i = 0; i < frames.length; i += step) out.push(frames[i]);
  const last = frames[frames.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function expandGhostFrames(frames) {
  return (frames || []).map(f => ({
    time: f.t ?? f.time ?? 0,
    x: f.x,
    y: f.y,
    heading: f.h ?? f.heading ?? 0
  }));
}

// Turn a recorded simulator lap into a shareable racing line + chase ghost.
export function buildRacingLineFromGhost(rawFrames, lapTime, options = {}) {
  const { toleranceM = 1.5, maxGhostFrames = 400 } = options;
  if (!rawFrames || rawFrames.length < 2) return null;

  const pathPoints = rawFrames.map(f => ({ x: f.x, y: f.y }));
  const points = simplifyPath(pathPoints, toleranceM);
  const thin = thinGhostFrames(rawFrames, maxGhostFrames);
  const frames = thin.map(f => ({
    t: Math.round(f.time * 10) / 10,
    x: Math.round(f.x * 10) / 10,
    y: Math.round(f.y * 10) / 10,
    h: Math.round(f.heading * 100) / 100
  }));

  return {
    points,
    ghost: {
      lapTime: Math.round(lapTime * 10) / 10,
      frames
    }
  };
}

export function newRacingLineId() {
  return 'l' + Date.now().toString(36).slice(-7);
}

export function defaultRacingLineName(index) {
  return `Line ${String.fromCharCode(65 + (index % 26))}`;
}

export function chaseRacingLine(track) {
  if (!track?.racingLines?.length) return null;
  return track.racingLines.find(l => l.chase && l.ghost?.frames?.length) ||
    track.racingLines.find(l => l.ghost?.frames?.length) ||
    null;
}

export function ghostFromRacingLine(line) {
  if (!line?.ghost?.frames?.length) return null;
  const frames = expandGhostFrames(line.ghost.frames);
  const time = line.ghost.lapTime ?? frames[frames.length - 1]?.time ?? 0;
  let distance = 0;
  for (let i = 1; i < frames.length; i++) {
    distance += Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y);
  }
  return {
    trackLineId: line.id,
    lineName: line.name || '',
    time,
    distance,
    avgSpeed: time > 0 ? (distance / time) * 3.6 : 0,
    frames
  };
}

// Keep only the declarative source fields (drops runtime fields added by
// normalizeTrack) and round coordinates to keep share URLs short.
export function serializeTrack(track) {
  const r1 = v => Math.round(v * 10) / 10;
  const seg = s => isSegment(s) ? { x1: r1(s.x1), y1: r1(s.y1), x2: r1(s.x2), y2: r1(s.y2) } : null;
  const out = {
    schemaVersion: track.schemaVersion || TRACK_SCHEMA_VERSION,
    name: track.name || '',
    author: track.author || '',
    notes: track.notes || '',
    scale: track.scale || 4,
    buoys: (track.buoys || []).map(b => {
      const o = { x: r1(b.x), y: r1(b.y) };
      if (b.type === 'marker') o.type = 'marker';
      else o.rounding = normalizeRounding(b.rounding);
      if (b.apexRadius != null && b.apexRadius !== 40) o.apexRadius = b.apexRadius;
      if (b.optimalSpeed != null) o.optimalSpeed = b.optimalSpeed;
      return o;
    }),
    gate: track.gate ? {
      sameStartFinish: track.gate.sameStartFinish !== false,
      directional: !!track.gate.directional,
      directionalFinish: !!track.gate.directionalFinish,
      direction: track.gate.direction || { x: 1, y: 0 },
      start: seg(track.gate.start),
      finish: seg(track.gate.finish)
    } : null
  };
  if (track.startPosition && Number.isFinite(track.startPosition.x)) {
    out.startPosition = {
      x: r1(track.startPosition.x),
      y: r1(track.startPosition.y),
      headingDeg: Math.round(track.startPosition.headingDeg ?? 90)
    };
  }
  if (hasGeo(track)) {
    const r6 = v => Math.round(v * 1e6) / 1e6;
    out.geo = {
      origin: { lat: r6(track.geo.origin.lat), lng: r6(track.geo.origin.lng) },
      rotationDeg: r1(track.geo.rotationDeg || 0)
    };
  }
  if (Array.isArray(track.racingLines) && track.racingLines.length) {
    const lines = track.racingLines
      .filter(l => l && l.id)
      .map(l => {
        const o = {
          id: l.id || newRacingLineId(),
          name: l.name || '',
          color: l.color || RACING_LINE_COLORS[0]
        };
        if (l.points?.length >= 2) {
          o.points = l.points.map(p => ({ x: r1(p.x), y: r1(p.y) }));
        }
        if (l.ghost?.frames?.length) {
          o.ghost = {
            lapTime: r1(l.ghost.lapTime),
            frames: l.ghost.frames.map(f => ({
              t: r1(f.t ?? f.time),
              x: r1(f.x),
              y: r1(f.y),
              h: Math.round((f.h ?? f.heading ?? 0) * 100) / 100
            }))
          };
        }
        if (l.chase) o.chase = true;
        if (l.visible === false) o.visible = false;
        return o;
      });
    if (lines.length) out.racingLines = lines;
  }
  return out;
}

export function encodeTrackForUrl(track) {
  return lz().compressToEncodedURIComponent(JSON.stringify(serializeTrack(track)));
}

export function decodeTrackFromParam(param) {
  try {
    const json = lz().decompressFromEncodedURIComponent(param);
    if (!json) return { track: null, errors: ['Could not decode track data'] };
    const track = JSON.parse(json);
    const { errors } = validateTrack(track);
    return errors.length ? { track: null, errors } : { track, errors: [] };
  } catch (e) {
    return { track: null, errors: ['Invalid track data: ' + e.message] };
  }
}

export function saveDraft(track) {
  localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(serializeTrack(track)));
}

export function loadDraft() {
  const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const track = JSON.parse(raw);
    return validateTrack(track).errors.length ? null : track;
  } catch (e) {
    return null;
  }
}

// --- Session CSV (eFoil Racing iOS app) → simulator ghost ---

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseSessionCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  const meta = {};
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.slice(1).trim().match(/^([^:]+):\s*(.*)$/);
      if (m) meta[m[1].trim()] = m[2].trim();
      continue;
    }
    if (line.toLowerCase().startsWith('time,') || line.includes('lat_deg')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    return { meta, headers: [], rows: [], errors: ['No CSV header row found (expected lat_deg / Time columns)'] };
  }

  const headers = parseCsvLine(lines[headerIdx]);
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 8) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
    const lat = Number(row.lat_deg);
    const lon = Number(row.lon_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    row._lat = lat;
    row._lon = lon;
    row._speedKmh = Number(row.speed_kmh);
    if (!Number.isFinite(row._speedKmh) && Number.isFinite(Number(row.speed_mps))) {
      row._speedKmh = Number(row.speed_mps) * 3.6;
    }
    row._headingDeg = Number(row.heading_deg);
    row._lapElapsed = Number(row.lap_elapsed_s);
    const lapIdx = Number(row.lap_index);
    row._lapIndex = Number.isFinite(lapIdx) ? lapIdx : null;
    const tUnix = Number(row.t_unix);
    if (Number.isFinite(tUnix)) {
      row._tUnix = tUnix;
    } else if (row.t_iso) {
      const ms = Date.parse(row.t_iso);
      row._tUnix = Number.isFinite(ms) ? ms / 1000 : null;
    } else {
      row._tUnix = null;
    }
    rows.push(row);
  }

  if (!rows.length) {
    return { meta, headers, rows, errors: ['CSV has a header but no valid GPS samples'] };
  }
  return { meta, headers, rows, errors: [] };
}

// Compass degrees (0=N, 90=E) → direction angle in track meters (0=+x/East-ish, 90=+y/North-ish).
export function compassToTrackHeadingRad(compassDeg, rotationDeg = 0) {
  const c = (Number(compassDeg) || 0) * Math.PI / 180;
  const east = Math.sin(c);
  const north = Math.cos(c);
  const r = (-(Number(rotationDeg) || 0) * Math.PI) / 180;
  const dx = east * Math.cos(r) - north * Math.sin(r);
  const dy = east * Math.sin(r) + north * Math.cos(r);
  return Math.atan2(dy, dx);
}

function sessionLapGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    // lap_index -1 / missing means "not in a timed lap" in app exports
    const key = Number.isFinite(row._lapIndex) && row._lapIndex >= 0
      ? row._lapIndex
      : (row.Lap && String(row.Lap).trim() && !/^$/.test(row.Lap) ? String(row.Lap).trim() : 'session');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function groupWallElapsed(group) {
  const a = group.find(r => Number.isFinite(r._tUnix));
  const b = [...group].reverse().find(r => Number.isFinite(r._tUnix));
  if (a && b) return Math.max(0, b._tUnix - a._tUnix);
  return 0;
}

function groupLapElapsed(group) {
  const timed = group.filter(r => Number.isFinite(r._lapElapsed));
  if (timed.length < 2) return 0;
  const span = timed[timed.length - 1]._lapElapsed - timed[0]._lapElapsed;
  // All zeros (common when lap_index is -1) is not usable lap timing
  if (span <= 0.05) return 0;
  return span;
}

function pickBestSessionLap(rows) {
  const groups = sessionLapGroups(rows);
  let best = null;
  for (const [key, group] of groups) {
    if (!group.length) continue;
    const moving = group.filter(r => (r._speedKmh || 0) > 3).length;
    let dist = 0;
    for (let i = 1; i < group.length; i++) {
      dist += haversineMeters(
        { lat: group[i - 1]._lat, lng: group[i - 1]._lon },
        { lat: group[i]._lat, lng: group[i]._lon }
      );
    }
    const lapElapsed = groupLapElapsed(group);
    const wallElapsed = groupWallElapsed(group);
    const elapsed = lapElapsed > 0 ? lapElapsed : wallElapsed;
    const score = dist + moving * 5;
    if (!best || score > best.score) {
      best = {
        key,
        rows: group,
        dist,
        elapsed,
        useLapElapsed: lapElapsed > 0,
        score
      };
    }
  }
  return best;
}

function rowGhostTime(row, t0, useLapElapsed) {
  if (useLapElapsed && Number.isFinite(row._lapElapsed)) {
    return Math.max(0, row._lapElapsed - t0);
  }
  if (Number.isFinite(row._tUnix) && Number.isFinite(t0)) {
    return Math.max(0, row._tUnix - t0);
  }
  return null;
}

/** Haversine from session GPS centroid to a track geo origin (meters). */
export function sessionDistanceToGeoOrigin(rows, geo) {
  if (!rows?.length || !geo?.origin) return null;
  const lat = rows.reduce((s, r) => s + r._lat, 0) / rows.length;
  const lng = rows.reduce((s, r) => s + r._lon, 0) / rows.length;
  return haversineMeters({ lat, lng }, { lat: geo.origin.lat, lng: geo.origin.lng });
}

/**
 * Convert an eFoil Racing session CSV into a simulator ghost.
 * Positions are ALWAYS real GPS projected through the given geo anchor
 * (lat/lng → track meters). Nothing is re-centered onto buoys.
 * Heading is stored in track-meter radians (`headingSpace: 'trackMeters'`).
 */
export function sessionCsvToGhost(csvText, geo, options = {}) {
  const parsed = parseSessionCsv(csvText);
  if (parsed.errors.length) {
    return { ghost: null, track: null, errors: parsed.errors, warnings: [] };
  }
  if (!geo?.origin || !Number.isFinite(geo.origin.lat) || !Number.isFinite(geo.origin.lng)) {
    return { ghost: null, track: null, errors: ['A geo origin is required to project GPS into track meters'], warnings: [] };
  }

  const warnings = [];
  const best = pickBestSessionLap(parsed.rows);
  if (!best || best.rows.length < 2) {
    return { ghost: null, track: null, errors: ['Not enough GPS samples to build a ghost'], warnings };
  }

  const lapRows = best.rows;
  const useLapElapsed = !!best.useLapElapsed;
  const t0 = useLapElapsed
    ? lapRows.find(r => Number.isFinite(r._lapElapsed))?._lapElapsed ?? 0
    : lapRows.find(r => Number.isFinite(r._tUnix))?._tUnix ?? 0;
  if (!useLapElapsed) {
    warnings.push('No lap markers in CSV — using full session wall-clock time');
  }

  const distToOrigin = sessionDistanceToGeoOrigin(lapRows, geo);
  if (Number.isFinite(distToOrigin) && distToOrigin > 800) {
    warnings.push(
      `Session GPS is ~${Math.round(distToOrigin)} m from this track’s map anchor — ` +
      `confirm the Orlando (or correct) geo track is selected`
    );
  }

  const rotationDeg = geo.rotationDeg || 0;
  const maxFrames = options.maxFrames ?? 800;
  const step = Math.max(1, Math.ceil(lapRows.length / maxFrames));

  const frames = [];
  let sumSpeed = 0;
  let prevM = null;

  const pushFrame = (row) => {
    const m = latLngToMeters(geo, row._lat, row._lon);
    let heading = Number.isFinite(row._headingDeg)
      ? compassToTrackHeadingRad(row._headingDeg, rotationDeg)
      : 0;
    if (prevM) {
      const dx = m.x - prevM.x;
      const dy = m.y - prevM.y;
      if (Math.hypot(dx, dy) > 0.15) heading = Math.atan2(dy, dx);
    }
    prevM = m;

    let elapsed = rowGhostTime(row, t0, useLapElapsed);
    if (elapsed == null) elapsed = frames.length * 0.05;
    const speedKmh = Number.isFinite(row._speedKmh) ? row._speedKmh : 0;
    sumSpeed += speedKmh;
    frames.push({
      time: Math.round(elapsed * 1000) / 1000,
      x: Math.round(m.x * 100) / 100,
      y: Math.round(m.y * 100) / 100,
      heading: Math.round(heading * 1000) / 1000,
      headingSpace: 'trackMeters',
      speedKmh: Math.round(speedKmh * 10) / 10
    });
  };

  // Ground distance from full-resolution GPS path; frames are downsampled
  let distance = 0;
  for (let i = 1; i < lapRows.length; i++) {
    distance += haversineMeters(
      { lat: lapRows[i - 1]._lat, lng: lapRows[i - 1]._lon },
      { lat: lapRows[i]._lat, lng: lapRows[i]._lon }
    );
  }

  for (let i = 0; i < lapRows.length; i += step) {
    pushFrame(lapRows[i]);
  }
  const last = lapRows[lapRows.length - 1];
  const lastFrame = frames[frames.length - 1];
  const lastT = rowGhostTime(last, t0, useLapElapsed) ?? lastFrame.time;
  const lastM = latLngToMeters(geo, last._lat, last._lon);
  if (!lastFrame || Math.hypot(lastFrame.x - lastM.x, lastFrame.y - lastM.y) > 0.05 ||
      Math.abs(lastFrame.time - lastT) > 0.05) {
    pushFrame(last);
  }

  if (best.dist < 15) {
    warnings.push(`Selected lap only covers ~${best.dist.toFixed(1)} m — replay will look nearly stationary`);
  }

  const time = frames[frames.length - 1].time;
  const ghost = {
    trackKey: options.trackKey || 'session',
    source: 'sessionCsv',
    sessionId: parsed.meta.SessionId || null,
    riderLabel: options.riderLabel || null,
    geoBound: true,
    time,
    distance: Math.round(distance * 10) / 10,
    avgSpeed: time > 0 ? (distance / time) * 3.6 : (sumSpeed / Math.max(frames.length, 1)),
    frames
  };

  return { ghost, track: null, errors: [], warnings, meta: parsed.meta, lapKey: best.key };
}

/**
 * Build a minimal geo-anchored track that fits a session GPS path so the
 * simulator can show satellite imagery + play the ghost without a designer track.
 */
export function trackFromSessionCsv(csvText, options = {}) {
  const parsed = parseSessionCsv(csvText);
  if (parsed.errors.length) {
    return { track: null, ghost: null, errors: parsed.errors, warnings: [] };
  }

  const rows = parsed.rows;
  const lats = rows.map(r => r._lat);
  const lons = rows.map(r => r._lon);
  const origin = {
    lat: lats.reduce((a, b) => a + b, 0) / lats.length,
    lng: lons.reduce((a, b) => a + b, 0) / lons.length
  };
  const geo = { origin, rotationDeg: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const meters = rows.map(r => {
    const m = latLngToMeters(geo, r._lat, r._lon);
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
    return m;
  });

  // Pad so tiny sessions still get a sensible map frame
  const pad = Math.max(40, 0.15 * Math.max(maxX - minX, maxY - minY, 1));
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;

  const firstMoving = rows.find(r => (r._speedKmh || 0) > 3) || rows[0];
  const startM = latLngToMeters(geo, firstMoving._lat, firstMoving._lon);
  const startHeading = Number.isFinite(firstMoving._headingDeg)
    ? compassToTrackHeadingRad(firstMoving._headingDeg, 0) * 180 / Math.PI
    : 90;

  const track = {
    schemaVersion: TRACK_SCHEMA_VERSION,
    name: options.name || 'Session Replay',
    author: options.author || '',
    notes: parsed.meta.SessionId ? `Imported session ${parsed.meta.SessionId}` : 'Imported from session CSV',
    scale: 4,
    buoys: [
      { x: maxX, y: maxY, type: 'marker' },
      { x: maxX, y: minY, type: 'marker' },
      { x: minX, y: minY, type: 'marker' },
      { x: minX, y: maxY, type: 'marker' }
    ],
    gate: {
      sameStartFinish: true,
      directional: false,
      directionalFinish: false,
      direction: { x: 1, y: 0 },
      start: {
        x1: startM.x - 8, y1: startM.y - 2,
        x2: startM.x + 8, y2: startM.y + 2
      },
      finish: null
    },
    startPosition: {
      x: Math.round(startM.x * 10) / 10,
      y: Math.round(startM.y * 10) / 10,
      headingDeg: Math.round(startHeading)
    },
    geo
  };

  const converted = sessionCsvToGhost(csvText, geo, {
    trackKey: options.trackKey || 'session',
    riderLabel: options.riderLabel,
    maxFrames: options.maxFrames
  });

  return {
    track,
    ghost: converted.ghost,
    errors: converted.errors,
    warnings: converted.warnings,
    meta: parsed.meta,
    spanM: { w: maxX - minX, h: maxY - minY, samples: meters.length }
  };
}
