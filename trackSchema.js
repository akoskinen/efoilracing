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
//   schemaVersion: 3,
//   name, author, notes,
//   startTechnique: { timetrial, elimination, notes },  // optional briefing copy
//   scale: 4,                          // meters -> pixels in the simulator
//   buoyColorScheme: 'nautical'|'league',  // turn-buoy paint by pass side
//   buoys: [{ x, y, type: 'turn'|'marker', rounding: 'left'|'right'|'neutral',
//             apexRadius, optimalSpeed }],
//   visits: [{ buoy: 0, side: 'left'|'right'|'neutral'|'360-left'|'360-right' }],
//             buoy = index into buoys; side = path on that side, either side, or 360 wrap.
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
// Share URLs omit racingLines, notes, and startTechnique so the link
// fits a QR code and WhatsApp. Drafts and JSON export keep the full track.
////////////////////////////////////////////////////////////

export const TRACK_SCHEMA_VERSION = 3;
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

/**
 * Which side of the buoy the rider passes.
 * Right = path on the buoy's right; Left = path on the buoy's left.
 * Neutral = either side. Legacy port = path on the right; starboard = left.
 */
export function normalizeRounding(rounding) {
  if (rounding === 'right' || rounding === 'port') return 'right';
  if (rounding === 'left' || rounding === 'starboard') return 'left';
  if (rounding === 'neutral') return 'neutral';
  return 'left';
}

export function normalizePassSide(side) {
  if (side === '360-left') return '360-left';
  if (side === '360-right' || side === '360' || side === 'full') return '360-right';
  if (side === 'neutral' || side === 'either') return 'neutral';
  return normalizeRounding(side);
}

export function is360Pass(side) {
  const s = normalizePassSide(side);
  return s === '360-left' || s === '360-right';
}

export function passSideLabel(side) {
  const s = normalizePassSide(side);
  if (s === '360-left') return '360° Left';
  if (s === '360-right') return '360° Right';
  if (s === 'neutral') return 'Neutral';
  return s === 'right' ? 'Right' : 'Left';
}

export function flipPassSide(side) {
  const s = normalizePassSide(side);
  if (s === 'neutral') return 'neutral';
  if (s === '360-right') return '360-left';
  if (s === '360-left') return '360-right';
  return s === 'right' ? 'left' : 'right';
}

/** Persist left/right/neutral; 360 visits keep a left/right rounding fallback. */
export function storedRounding(side) {
  const s = normalizePassSide(side);
  return is360Pass(s) ? 'right' : s;
}

export const BUOY_COLOR_SCHEMES = {
  nautical: {
    left: '#2e7d32',
    right: '#c62828',
    neutral: '#ffd54a',
    '360': '#1565c0'
  },
  league: {
    left: '#ff8c00',
    right: '#ffffff',
    neutral: '#ffd54a',
    '360': '#1565c0'
  }
};
export const MARKER_BUOY_FILL = '#FF8800';

export function normalizeBuoyColorScheme(scheme) {
  return scheme === 'league' ? 'league' : 'nautical';
}

export function passSideColorKey(side) {
  const s = normalizePassSide(side);
  if (is360Pass(s)) return '360';
  if (s === 'neutral') return 'neutral';
  return s === 'right' ? 'right' : 'left';
}

/** Color role for a physical turn buoy: any 360 visit wins, else the first visit. */
export function buoyColorSide(track, buoyIndex) {
  const visits = (track?.visits || []).filter(v => v.buoy === buoyIndex);
  const spin = visits.find(v => is360Pass(v.side));
  if (spin) return normalizePassSide(spin.side);
  if (visits.length) return normalizePassSide(visits[0].side);
  const rounding = track?.buoys?.[buoyIndex]?.rounding;
  return rounding ? normalizePassSide(rounding) : 'left';
}

export function turnBuoyPaint(scheme, side) {
  const name = normalizeBuoyColorScheme(scheme);
  const key = passSideColorKey(side);
  const fill = BUOY_COLOR_SCHEMES[name][key];
  const light = key === 'neutral' || (name === 'league' && key === 'right');
  return {
    fill,
    stroke: light ? '#222' : '#fff',
    label: light ? '#222' : '#fff'
  };
}

/** 1-based number among turn buoys (markers skipped). Placement order, not course order. */
export function physicalBuoyNumber(track, buoyIndex) {
  let n = 0;
  for (let i = 0; i <= buoyIndex; i++) {
    if (track.buoys[i] && track.buoys[i].type !== 'marker') n += 1;
  }
  return n;
}

/** 1-based course-order visits that use this physical buoy. */
export function visitNumbersForBuoy(track, buoyIndex) {
  return (track?.visits || [])
    .map((v, i) => v.buoy === buoyIndex ? i + 1 : null)
    .filter(n => n != null);
}

/** Number painted on the mark: first visit in course order. Extra visits keep this id. */
export function firstVisitNumber(track, buoyIndex) {
  const nums = visitNumbersForBuoy(track, buoyIndex);
  return nums[0] ?? physicalBuoyNumber(track, buoyIndex);
}

export function ensureVisits(track) {
  if (!track || !Array.isArray(track.buoys)) return track;
  const valid = v =>
    v && Number.isInteger(v.buoy) && track.buoys[v.buoy] &&
    track.buoys[v.buoy].type !== 'marker';
  if (!Array.isArray(track.visits)) {
    track.visits = [];
    track.buoys.forEach((b, i) => {
      if (b.type === 'marker') return;
      track.visits.push({ buoy: i, side: normalizePassSide(b.rounding) });
    });
  } else {
    track.visits = track.visits.filter(valid).map(v => ({
      buoy: v.buoy,
      side: normalizePassSide(v.side || track.buoys[v.buoy].rounding)
    }));
  }
  return track;
}

/** v1 stored leave-to-port/starboard as left/right; invert those to path-side. */
export function migrateTrackSchema(track) {
  if (!track || typeof track !== 'object') return track;
  const v = Number(track.schemaVersion) || 1;
  if (v < 2) {
    (track.buoys || []).forEach(b => {
      if (b.type === 'marker') return;
      if (b.rounding === 'port') b.rounding = 'right';
      else if (b.rounding === 'starboard') b.rounding = 'left';
      else b.rounding = b.rounding === 'right' ? 'left' : 'right';
    });
  }
  ensureVisits(track);
  track.schemaVersion = TRACK_SCHEMA_VERSION;
  ensureStartTechnique(track);
  return track;
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
    buoyColorScheme: 'nautical',
    buoys: [
      { x: 150, y: 30,  type: 'turn', rounding: 'right', apexRadius: 40, optimalSpeed: 30 },
      { x: 150, y: 110, type: 'turn', rounding: 'right', apexRadius: 40, optimalSpeed: 30 },
      { x: 10,  y: 110, type: 'turn', rounding: 'right', apexRadius: 40, optimalSpeed: 30 },
      { x: 10,  y: 30,  type: 'turn', rounding: 'right', apexRadius: 40, optimalSpeed: 30 }
    ],
    visits: [
      { buoy: 0, side: 'right' },
      { buoy: 1, side: 'right' },
      { buoy: 2, side: 'right' },
      { buoy: 3, side: 'right' }
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
 * Pass side: #1 right, #2 left, #3 right, then #2 right and #1 right on the return.
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
      'Pass #1 on the right, #2 on the left, #3 on the right, then #2 and #1 on the right returning. ' +
      'Timing line at #1, parallel to #2–#3. ' +
      'Theoretical line ~325 m, target lap ~30 s @ ~39 km/h.',
    scale: 4,
    buoyColorScheme: 'nautical',
    buoys: [
      { x: p1.x, y: p1.y, type: 'turn', rounding: 'right', apexRadius: 40, optimalSpeed: 30 },
      { x: p2.x, y: p2.y, type: 'turn', rounding: 'left', apexRadius: 40, optimalSpeed: 30 },
      { x: p3.x, y: p3.y, type: 'turn', rounding: 'right', apexRadius: 40, optimalSpeed: 30 }
    ],
    visits: [
      { buoy: 0, side: 'right' },
      { buoy: 1, side: 'left' },
      { buoy: 2, side: 'right' },
      { buoy: 1, side: 'right' },
      { buoy: 0, side: 'right' }
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

/** Mirror layout across a vertical axis through the bbox center; swap left/right pass side. */
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
      buoy.rounding = storedRounding(flipPassSide(buoy.rounding));
    }
  });
  (track.visits || []).forEach(v => {
    v.side = flipPassSide(v.side);
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

export const TRACK_LIBRARY_KIND = 'efoil-track-library';
export const LAST_RIDE_STORAGE_KEY = 'efoil_last_ride_id';

export function countryGroupForPlace(place) {
  const code = String(place?.countryCode || '').toUpperCase();
  const name = String(place?.countryName || '').trim();
  if (!code) return { code: '', name: 'No location', sort: '\uffff' };
  return { code, name: name || code, sort: (name || code).toLocaleUpperCase('en') };
}

/** Lat/lng for a saved track: geo origin first, then stored place. */
export function presetGeoLatLng(preset) {
  if (hasGeo(preset?.track)) {
    return { lat: preset.track.geo.origin.lat, lng: preset.track.geo.origin.lng };
  }
  const lat = Number(preset?.place?.lat);
  const lng = Number(preset?.place?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return null;
}

export function groupPresetsByCountry(presets) {
  const groups = new Map();
  (presets || []).forEach(p => {
    const g = countryGroupForPlace(p.place);
    const key = g.code || '__none__';
    if (!groups.has(key)) groups.set(key, { ...g, presets: [] });
    groups.get(key).presets.push(p);
  });
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.code === '' && b.code !== '') return 1;
    if (b.code === '' && a.code !== '') return -1;
    return a.sort.localeCompare(b.sort, 'en');
  });
  ordered.forEach(g => {
    g.presets.sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' })
    );
  });
  return ordered;
}

export function exportTrackLibrary(presets) {
  return {
    kind: TRACK_LIBRARY_KIND,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    tracks: (presets || []).map(p => ({
      id: p.id,
      name: p.name,
      savedAt: p.savedAt || null,
      kind: 'track',
      place: p.place || placeFromTrack(p.track) || null,
      track: p.track
    }))
  };
}

function asLibraryEntry(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.track && Array.isArray(obj.track.buoys)) {
    return {
      id: obj.id,
      name: obj.name,
      savedAt: obj.savedAt || null,
      place: obj.place || null,
      track: obj.track
    };
  }
  if (Array.isArray(obj.buoys)) {
    return { name: obj.name, place: null, track: obj };
  }
  return null;
}

/** Parse a single-track file or a multi-track library backup. */
export function parseTrackImport(parsed) {
  if (parsed && (parsed.kind === TRACK_LIBRARY_KIND || Array.isArray(parsed.tracks))) {
    const entries = (parsed.tracks || []).map(asLibraryEntry).filter(Boolean);
    return {
      type: 'library',
      entries,
      errors: entries.length ? [] : ['No tracks found in this file']
    };
  }
  if (Array.isArray(parsed)) {
    const entries = parsed.map(asLibraryEntry).filter(Boolean);
    return {
      type: 'library',
      entries,
      errors: entries.length ? [] : ['No tracks found in this file']
    };
  }
  const one = asLibraryEntry(parsed);
  if (one) return { type: 'track', track: one.track, entry: one, errors: [] };
  return { type: null, errors: ['Unrecognized JSON — expected a track or an efoil track library'] };
}

/** Merge imported library entries into local saved tracks. Never overwrites an existing id. */
export function mergeImportedTrackPresets(entries) {
  const list = loadUserTrackPresets();
  const byId = new Map(list.map(p => [p.id, p]));
  let imported = 0;
  let skipped = 0;
  const names = [];
  for (const raw of entries || []) {
    const src = raw.track || raw;
    const { errors } = validateTrack(src);
    if (errors.length) {
      skipped += 1;
      continue;
    }
    if (raw.id && byId.has(raw.id)) {
      skipped += 1;
      continue;
    }
    const name = (raw.name && String(raw.name).trim()) || src.name || 'Imported track';
    const preset = {
      id: newPresetId(),
      name,
      savedAt: raw.savedAt || new Date().toISOString(),
      kind: 'track',
      track: trackAsSavedTrack(src, name)
    };
    if (raw.place) preset.place = raw.place;
    else {
      const place = placeFromTrack(preset.track);
      if (place) preset.place = place;
    }
    list.unshift(preset);
    byId.set(preset.id, preset);
    imported += 1;
    names.push(name);
  }
  if (imported) saveUserTrackPresets(list);
  return { imported, skipped, names };
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

function closestPointOnSeg(px, py, seg) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { x: seg.x1, y: seg.y1 };
  let t = ((px - seg.x1) * dx + (py - seg.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: seg.x1 + t * dx, y: seg.y1 + t * dy };
}

function distBetween(track, a, b) {
  const trackDist = Math.hypot(b.x - a.x, b.y - a.y);
  const groundDist = hasGeo(track)
    ? groundDistanceMeters(track.geo, a.x, a.y, b.x, b.y)
    : trackDist;
  return { trackM: trackDist, groundM: groundDist };
}

export function trackStats(track) {
  ensureVisits(track);
  const turns = (track.buoys || []).filter(b => b.type !== 'marker' && Number.isFinite(b?.x));
  const visits = track.visits || [];
  let lapLengthM = 0;
  let lapLengthGroundM = 0;
  const legDistances = [];

  const addLeg = (from, to, a, b) => {
    if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return;
    const d = distBetween(track, a, b);
    lapLengthM += d.trackM;
    lapLengthGroundM += d.groundM;
    legDistances.push({ from, to, trackM: d.trackM, groundM: d.groundM });
  };

  const visitPts = visits.map(v => track.buoys[v.buoy]);
  const startSeg = track.gate && isSegment(track.gate.start) ? track.gate.start : null;
  const finishSeg = (track.gate && track.gate.sameStartFinish === false && isSegment(track.gate.finish))
    ? track.gate.finish
    : startSeg;

  if (visitPts[0] && startSeg) {
    const p = closestPointOnSeg(visitPts[0].x, visitPts[0].y, startSeg);
    addLeg('Start', 1, p, visitPts[0]);
  }
  for (let i = 0; i < visitPts.length - 1; i++) {
    addLeg(i + 1, i + 2, visitPts[i], visitPts[i + 1]);
  }
  if (visitPts.length && finishSeg) {
    const last = visitPts[visitPts.length - 1];
    const p = closestPointOnSeg(last.x, last.y, finishSeg);
    addLeg(visitPts.length, 'Finish', last, p);
  }

  return {
    turnCount: turns.length,
    visitCount: visits.length,
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
  migrateTrackSchema(track);
  const gate = track.gate;
  const sameStartFinish = gate.sameStartFinish !== false;

  let turnCounter = 0;
  (track.buoys || []).forEach((b, i) => {
    if (b.type === 'marker') {
      b.turnIndex = null;
      b.aliases = [];
    } else {
      turnCounter += 1;
      b.rounding = storedRounding(b.rounding);
      const aliases = (track.visits || [])
        .map((v, vi) => v.buoy === i ? vi + 1 : null)
        .filter(n => n != null);
      b.aliases = aliases.length ? aliases : [turnCounter];
      b.turnIndex = b.aliases[0];
    }
    if (b.apexRadius == null) b.apexRadius = 40;
  });

  if (!Number.isFinite(track.scale) || track.scale <= 0) track.scale = 4;

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

export function ensureStartTechnique(track) {
  if (!track.startTechnique || typeof track.startTechnique !== 'object') {
    track.startTechnique = { timetrial: '', elimination: '', notes: '' };
  } else {
    if (typeof track.startTechnique.timetrial !== 'string') track.startTechnique.timetrial = '';
    if (typeof track.startTechnique.elimination !== 'string') track.startTechnique.elimination = '';
    if (typeof track.startTechnique.notes !== 'string') track.startTechnique.notes = '';
  }
  return track.startTechnique;
}

/** First visible racing line (chase if that variant is visible). */
export function visibleRacingLine(track) {
  const lines = track?.racingLines || [];
  const vis = lines.filter(l => l && l.visible !== false);
  if (!vis.length) return null;
  return vis.find(l => l.chase) || vis[0];
}

export function nominalLapTimeSec(track) {
  const line = visibleRacingLine(track);
  if (!line?.ghost) return null;
  const t = Number(line.ghost.lapTime);
  if (Number.isFinite(t) && t > 0) return t;
  const frames = line.ghost.frames;
  const last = frames?.[frames.length - 1];
  const t2 = Number(last?.t ?? last?.time);
  return Number.isFinite(t2) && t2 > 0 ? t2 : null;
}

function polylineLengthM(track, pts) {
  if (!pts || pts.length < 2) return null;
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (!Number.isFinite(a?.x) || !Number.isFinite(b?.x)) continue;
    d += hasGeo(track)
      ? groundDistanceMeters(track.geo, a.x, a.y, b.x, b.y)
      : Math.hypot(b.x - a.x, b.y - a.y);
  }
  return d > 0 ? d : null;
}

/** Real-world length of the visible line variant (ghost path, else simplified line). */
export function nominalLapDistanceM(track) {
  const line = visibleRacingLine(track);
  if (!line) return null;
  return polylineLengthM(track, line.ghost?.frames) ?? polylineLengthM(track, line.points);
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
// normalizeTrack) and round coordinates. Used for drafts, undo, and JSON export.
export function serializeTrack(track) {
  migrateTrackSchema(track);
  const r1 = v => Math.round(v * 10) / 10;
  const seg = s => isSegment(s) ? { x1: r1(s.x1), y1: r1(s.y1), x2: r1(s.x2), y2: r1(s.y2) } : null;
  const out = {
    schemaVersion: TRACK_SCHEMA_VERSION,
    name: track.name || '',
    author: track.author || '',
    notes: track.notes || '',
    scale: track.scale || 4,
    buoyColorScheme: normalizeBuoyColorScheme(track.buoyColorScheme),
    buoys: (track.buoys || []).map((b, i) => {
      const o = { x: r1(b.x), y: r1(b.y) };
      if (b.type === 'marker') o.type = 'marker';
      else {
        const first = (track.visits || []).find(v => v.buoy === i);
        const side = first ? normalizePassSide(first.side) : normalizePassSide(b.rounding);
        o.rounding = storedRounding(side);
      }
      if (b.apexRadius != null && b.apexRadius !== 40) o.apexRadius = b.apexRadius;
      if (b.optimalSpeed != null) o.optimalSpeed = b.optimalSpeed;
      return o;
    }),
    visits: (track.visits || []).map(v => ({
      buoy: v.buoy,
      side: normalizePassSide(v.side)
    })),
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
  const st = track.startTechnique;
  if (st && (String(st.timetrial || '').trim() || String(st.elimination || '').trim() || String(st.notes || '').trim())) {
    out.startTechnique = {
      timetrial: String(st.timetrial || ''),
      elimination: String(st.elimination || ''),
      notes: String(st.notes || '')
    };
  }
  return out;
}

/**
 * Course layout only — no racing lines, ghosts, or briefing copy.
 * Share links have to fit a QR code (~2.9k bytes) and survive WhatsApp paste.
 */
export function serializeTrackForShare(track) {
  const out = serializeTrack(track);
  delete out.racingLines;
  delete out.startTechnique;
  delete out.notes;
  if (!String(out.author || '').trim()) delete out.author;
  else out.author = String(out.author).trim();
  if (out.name) out.name = String(out.name).trim();
  if (out.buoyColorScheme === 'nautical') delete out.buoyColorScheme;
  (out.buoys || []).forEach(b => {
    delete b.optimalSpeed;
  });
  if (out.gate) {
    if (out.gate.sameStartFinish !== false) delete out.gate.sameStartFinish;
    if (!out.gate.directional) delete out.gate.directional;
    if (!out.gate.directionalFinish) delete out.gate.directionalFinish;
    if (!out.gate.finish) delete out.gate.finish;
    const d = out.gate.direction;
    if (d && d.x === 1 && d.y === 0) delete out.gate.direction;
  }
  return out;
}

export function encodeTrackForUrl(track) {
  return lz().compressToEncodedURIComponent(JSON.stringify(serializeTrackForShare(track)));
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

function frameTimeSec(frame) {
  const t = frame?.time ?? frame?.t;
  return Number.isFinite(t) ? t : 0;
}

/** Median positive sample interval in seconds (ignores pauses and jitter). */
export function medianFrameDtSec(frames) {
  const dts = [];
  for (let i = 1; i < (frames || []).length; i++) {
    const d = frameTimeSec(frames[i]) - frameTimeSec(frames[i - 1]);
    if (Number.isFinite(d) && d >= 0.01 && d <= 10) dts.push(d);
  }
  if (!dts.length) return 0;
  dts.sort((x, y) => x - y);
  const mid = Math.floor(dts.length / 2);
  return dts.length % 2 ? dts[mid] : (dts[mid - 1] + dts[mid]) / 2;
}

function lerpNum(a, b, t) {
  return a + (b - a) * t;
}

function lerpPt(a, b, t) {
  return { x: lerpNum(a.x, b.x, t), y: lerpNum(a.y, b.y, t) };
}

/** Centripetal Catmull-Rom (α=0.5) — stays closer to GPS than uniform CR on tight turns. */
function centripetalCatmullRom(p0, p1, p2, p3, t, alpha = 0.5) {
  const dist = (a, b) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return Math.pow(Math.max(d, 1e-6), alpha);
  };
  const t0 = 0;
  const t1 = t0 + dist(p0, p1);
  const t2 = t1 + dist(p1, p2);
  const t3 = t2 + dist(p2, p3);
  if (t2 - t1 < 1e-9) return { x: p1.x, y: p1.y };
  const tv = t1 + t * (t2 - t1);
  const mix = (pa, pb, ta, tb, u) => {
    const den = tb - ta;
    if (Math.abs(den) < 1e-12) return { x: pa.x, y: pa.y };
    return lerpPt(pa, pb, (u - ta) / den);
  };
  const a1 = mix(p0, p1, t0, t1, tv);
  const a2 = mix(p1, p2, t1, t2, tv);
  const a3 = mix(p2, p3, t2, t3, tv);
  const b1 = mix(a1, a2, t0, t2, tv);
  const b2 = mix(a2, a3, t1, t3, tv);
  return mix(b1, b2, t1, t2, tv);
}

function ghostPtAt(frames, i) {
  if (i <= 0) return frames[0];
  if (i >= frames.length) return frames[frames.length - 1];
  return frames[i];
}

function thinGhostFramesEven(frames, maxFrames) {
  if (!frames || frames.length <= maxFrames) return frames || [];
  const firstT = frameTimeSec(frames[0]);
  const lastT = frameTimeSec(frames[frames.length - 1]);
  const span = Math.max(lastT - firstT, 1e-6);
  const out = [frames[0]];
  let idx = 1;
  for (let k = 1; k < maxFrames - 1; k++) {
    const targetT = firstT + (span * k) / (maxFrames - 1);
    while (idx < frames.length - 1 && frameTimeSec(frames[idx]) < targetT) idx++;
    const pick = frames[idx];
    if (out[out.length - 1] !== pick) out.push(pick);
  }
  const last = frames[frames.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * If GPS is slower than ~8 Hz (iPhone ~1 Hz), resample the path with a
 * centripetal spline to ~10 Hz so replay is not a chain of 1 s chords.
 * Dragy-class 20 Hz logs are left alone. Stationary segments stay linear
 * so waiting-on-the-beach GPS jitter does not wiggle.
 */
export function smoothSparseGhostFrames(frames, options = {}) {
  if (!frames || frames.length < 3) {
    return { frames: frames || [], sampleHz: 0, smoothed: false };
  }
  const dt = medianFrameDtSec(frames);
  const sampleHz = dt > 0 ? 1 / dt : 0;
  const minHz = options.minHz ?? 8;
  const targetHz = options.targetHz ?? 10;
  if (!(sampleHz > 0) || sampleHz >= minHz) {
    return { frames, sampleHz, smoothed: false };
  }

  const minMoveM = options.minMoveM ?? 1;
  const out = [];
  const push = (f, from) => {
    const time = frameTimeSec(f);
    let heading = f.heading ?? f.h ?? 0;
    if (from && Math.hypot(f.x - from.x, f.y - from.y) > 0.15) {
      heading = Math.atan2(f.y - from.y, f.x - from.x);
    }
    const prev = out[out.length - 1];
    if (prev && Math.abs(time - prev.time) < 1e-4) return;
    out.push({
      ...f,
      time: Math.round(time * 1000) / 1000,
      x: Math.round(f.x * 100) / 100,
      y: Math.round(f.y * 100) / 100,
      heading: Math.round((heading || 0) * 1000) / 1000,
      speedKmh: Number.isFinite(f.speedKmh) ? Math.round(f.speedKmh * 10) / 10 : f.speedKmh
    });
  };

  push({ ...frames[0] }, null);
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    const t0 = frameTimeSec(a);
    const t1 = frameTimeSec(b);
    const segDt = t1 - t0;
    const move = Math.hypot(b.x - a.x, b.y - a.y);
    // Keep nearly-stationary GPS as endpoints (linear in the draw loop).
    // Splining beach-wait jitter would wiggle around the true sit-spot.
    const nInsert = (segDt > 0.04 && move >= minMoveM)
      ? Math.min(12, Math.max(0, Math.round(segDt * targetHz) - 1))
      : 0;
    if (nInsert > 0) {
      const p0 = ghostPtAt(frames, i - 1);
      const p3 = ghostPtAt(frames, i + 2);
      for (let k = 1; k <= nInsert; k++) {
        const t = k / (nInsert + 1);
        const xy = centripetalCatmullRom(p0, a, b, p3, t);
        push({
          time: lerpNum(t0, t1, t),
          x: xy.x,
          y: xy.y,
          heading: a.heading ?? a.h,
          headingSpace: a.headingSpace || b.headingSpace,
          speedKmh: lerpNum(a.speedKmh || 0, b.speedKmh || 0, t)
        }, out[out.length - 1]);
      }
    }
    push({ ...b }, out[out.length - 1]);
  }

  let result = out;
  const maxFrames = options.maxFrames;
  if (Number.isFinite(maxFrames) && result.length > maxFrames) {
    result = thinGhostFramesEven(result, maxFrames);
  }
  return { frames: result, sampleHz, smoothed: out.length > frames.length };
}

/** Simulator racing-line ghosts are already a fair curve; do not re-spline them. */
function isSimulatorRacingLineGhost(ghost) {
  if (!ghost) return false;
  if (ghost.source === 'sessionCsv' || ghost.geoBound) return false;
  if (ghost.trackLineId || (typeof ghost.lineName === 'string' && ghost.lineName.length)) return true;
  const f = ghost.frames?.[0];
  // Compact designer frames: { t, x, y, h } with no session heading space.
  if (f && f.t != null && f.time == null && f.headingSpace == null) return true;
  return false;
}

/**
 * Upsample an already-built ghost JSON if its median dt is sparse session GPS.
 * No-ops for dense logs, already-smoothed ghosts, and simulator racing lines.
 */
export function applySparseGhostSmoothing(ghost, options = {}) {
  if (!ghost?.frames?.length || ghost.smoothed) return { ghost, changed: false };
  if (isSimulatorRacingLineGhost(ghost)) return { ghost, changed: false };
  const maxFrames = options.maxFrames ?? 1600;
  const result = smoothSparseGhostFrames(ghost.frames, { ...options, maxFrames });
  if (!result.smoothed) {
    if (result.sampleHz && ghost.sampleHz == null) ghost.sampleHz = result.sampleHz;
    return { ghost, changed: false };
  }
  return {
    ghost: {
      ...ghost,
      frames: result.frames,
      sampleHz: result.sampleHz,
      smoothed: true
    },
    changed: true,
    note: `Smoothed ${result.sampleHz.toFixed(1)} Hz GPS to 10 Hz`
  };
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
  const maxFrames = options.maxFrames ?? 1600;

  let frames = [];
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
    const prevFrame = frames[frames.length - 1];
    if (prevFrame && Math.abs(elapsed - prevFrame.time) < 0.01) return;
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

  // Ground distance from full-resolution GPS path (before replay resampling).
  let distance = 0;
  for (let i = 1; i < lapRows.length; i++) {
    distance += haversineMeters(
      { lat: lapRows[i - 1]._lat, lng: lapRows[i - 1]._lon },
      { lat: lapRows[i]._lat, lng: lapRows[i]._lon }
    );
  }

  for (let i = 0; i < lapRows.length; i++) pushFrame(lapRows[i]);

  const smoothed = smoothSparseGhostFrames(frames, { maxFrames });
  frames = smoothed.frames;
  if (smoothed.smoothed) {
    warnings.push(`Smoothed ${smoothed.sampleHz.toFixed(1)} Hz GPS to 10 Hz`);
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
    sampleHz: smoothed.sampleHz || null,
    smoothed: !!smoothed.smoothed,
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
