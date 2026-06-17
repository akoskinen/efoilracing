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
//   buoys: [{ x, y, type: 'turn'|'marker', rounding: 'port'|'starboard',
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
      { x: 150, y: 30,  type: 'turn', rounding: 'port', apexRadius: 40, optimalSpeed: 30 },
      { x: 150, y: 110, type: 'turn', rounding: 'port', apexRadius: 40, optimalSpeed: 30 },
      { x: 10,  y: 110, type: 'turn', rounding: 'port', apexRadius: 40, optimalSpeed: 30 },
      { x: 10,  y: 30,  type: 'turn', rounding: 'port', apexRadius: 40, optimalSpeed: 30 }
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
      if (b.rounding) o.rounding = b.rounding;
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
