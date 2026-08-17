////////////////////////////////////////////////////////////
// designer.js — eFoil Racing Track Designer
////////////////////////////////////////////////////////////
// Visual editor for the declarative track format defined in
// trackSchema.js. Drafts are handed to the simulator through
// localStorage (Test Ride) or compressed share URLs.
////////////////////////////////////////////////////////////

import {
  createDefaultTrack, validateTrack, trackStats, trackBBox,
  encodeTrackForUrl, decodeTrackFromParam, serializeTrack,
  saveDraft, loadDraft,
  hasGeo, metersToLatLng, latLngToMeters, groundDistanceMeters,
  latLngToWorldPx, metersPerPixel,
  LINE_CAPTURE_KEY, LINE_RECORD_META_KEY,
  RACING_LINE_COLORS, newRacingLineId, defaultRacingLineName,
  buildRacingLineFromGhost,
  BUILTIN_TRACK_PRESETS, loadUserTrackPresets, saveUserTrackPreset,
  deleteUserTrackPreset, getTrackPresetById,
  flipTrackLayout, patchUserTrackPreset, replaceUserTrackPreset, countryFlagEmoji,
  geoFromSavedEntry, placeFromTrack, normalizeRounding, migrateTrackSchema,
  ensureVisits, normalizePassSide, passSideLabel, physicalBuoyNumber,
  groupPresetsByCountry, exportTrackLibrary, parseTrackImport, mergeImportedTrackPresets,
  ensureStartTechnique, nominalLapTimeSec, nominalLapDistanceM
} from './trackSchema.js';

// --- DOM ---
const canvas = document.getElementById('designCanvas');
let ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvasWrap');

const els = {
  trackName: document.getElementById('trackName'),
  trackAuthor: document.getElementById('trackAuthor'),
  trackNotes: document.getElementById('trackNotes'),
  startTimetrial: document.getElementById('startTimetrial'),
  startElimination: document.getElementById('startElimination'),
  startNotes: document.getElementById('startNotes'),
  chkSameStartFinish: document.getElementById('chkSameStartFinish'),
  chkDirectional: document.getElementById('chkDirectional'),
  chkDirectionalFinish: document.getElementById('chkDirectionalFinish'),
  rowDirection: document.getElementById('rowDirection'),
  selDirection: document.getElementById('selDirection'),
  buoyList: document.getElementById('buoyList'),
  buoyProps: document.getElementById('buoyProps'),
  buoyType: document.getElementById('buoyType'),
  buoyRounding: document.getElementById('buoyRounding'),
  rowRounding: document.getElementById('rowRounding'),
  rowOptimalSpeed: document.getElementById('rowOptimalSpeed'),
  buoyOptimalSpeed: document.getElementById('buoyOptimalSpeed'),
  buoyX: document.getElementById('buoyX'),
  buoyY: document.getElementById('buoyY'),
  btnDeleteBuoy: document.getElementById('btnDeleteBuoy'),
  btnAddVisit: document.getElementById('btnAddVisit'),
  stats: document.getElementById('stats'),
  warnings: document.getElementById('warnings'),
  toolGateFinish: document.getElementById('toolGateFinish'),
  shareModal: document.getElementById('shareModal'),
  shareUrl: document.getElementById('shareUrl'),
  qrContainer: document.getElementById('qrContainer'),
  importFile: document.getElementById('importFile'),
  chkGeoMap: document.getElementById('chkGeoMap'),
  geoControls: document.getElementById('geoControls'),
  geoSearch: document.getElementById('geoSearch'),
  geoRotation: document.getElementById('geoRotation'),
  geoRotationSlider: document.getElementById('geoRotationSlider'),
  geoOriginInfo: document.getElementById('geoOriginInfo'),
  geoMapDiv: document.getElementById('geoMap'),
  lineList: document.getElementById('lineList')
};

// --- State ---
let track = null;
let view = { cx: 80, cy: 60, pxPerM: 4 };
let mode = 'select'; // select | addTurn | addMarker | gateStart | gateFinish | start | geoMove
let selection = null; // { kind:'buoy', index } | null
let showDistanceLegs = true;
let drag = null;
let undoStack = [];
let geoOn = false;
let map = null; // Leaflet map, created lazily
let rotationUndoPushed = false;

const BUOY_HIT_PX = 14;
const HANDLE_HIT_PX = 10;

// --- Poster render target (briefing PNG export) ---
// When set, the draw helpers render into the poster canvas instead of the
// live editor canvas: cssSize() reports the poster layout size and the geo
// (Leaflet) transform is bypassed — the poster draws satellite imagery
// itself and keeps the plain meters transform for all track elements.
let poster = null; // { ctx, w, h }

// --- Coordinate transforms (CSS pixels <-> track meters) ---
function cssSize() {
  if (poster) return { w: poster.w, h: poster.h };
  return { w: canvas.clientWidth, h: canvas.clientHeight };
}
function geoActive() {
  if (poster) return false;
  return geoOn && map && hasGeo(track);
}
function mToPx(mx, my) {
  if (geoActive()) {
    const ll = metersToLatLng(track.geo, mx, my);
    const pt = map.latLngToContainerPoint([ll.lat, ll.lng]);
    return { x: pt.x, y: pt.y };
  }
  const { w, h } = cssSize();
  return {
    x: w / 2 + (mx - view.cx) * view.pxPerM,
    y: h / 2 - (my - view.cy) * view.pxPerM
  };
}
function pxToM(px, py) {
  if (geoActive()) {
    const ll = map.containerPointToLatLng(L.point(px, py));
    return latLngToMeters(track.geo, ll.lat, ll.lng);
  }
  const { w, h } = cssSize();
  return {
    x: view.cx + (px - w / 2) / view.pxPerM,
    y: view.cy - (py - h / 2) / view.pxPerM
  };
}
const snap = v => Math.round(v * 10) / 10;

// --- Track defaults / loading ---
function withDefaults(t) {
  migrateTrackSchema(t);
  ensureVisits(t);
  (t.buoys || []).forEach(b => {
    if (b.type !== 'marker') b.type = 'turn';
    if (b.type === 'turn') b.rounding = normalizeRounding(b.rounding);
    if (b.apexRadius == null) b.apexRadius = 40;
    if (b.type === 'turn' && b.optimalSpeed == null) b.optimalSpeed = 30;
  });
  if (!t.gate.direction) t.gate.direction = { x: 1, y: 0 };
  if (!Array.isArray(t.racingLines)) t.racingLines = [];
  t.racingLines.forEach((line, i) => {
    if (!line.id) line.id = newRacingLineId();
    if (!line.name) line.name = defaultRacingLineName(i);
    if (!line.color) line.color = RACING_LINE_COLORS[i % RACING_LINE_COLORS.length];
    if (line.visible == null) line.visible = true;
    if (!line.points) line.points = [];
  });
  if (t.racingLines.length && !t.racingLines.some(l => l.chase)) {
    const recorded = t.racingLines.find(l => l.points?.length >= 2) || t.racingLines[0];
    recorded.chase = true;
  }
  return t;
}

function loadInitialTrack() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('data')) {
    const { track: decoded } = decodeTrackFromParam(params.get('data'));
    if (decoded) return withDefaults(decoded);
  }
  const draft = loadDraft();
  if (draft) return withDefaults(draft);
  return withDefaults(createDefaultTrack());
}

// --- Undo ---
function pushUndo() {
  undoStack.push(JSON.stringify(serializeTrack(track)));
  if (undoStack.length > 60) undoStack.shift();
}
function undo() {
  if (!undoStack.length) return;
  track = withDefaults(JSON.parse(undoStack.pop()));
  selection = null;
  commit();
}

// --- Commit pipeline ---
function commit() {
  saveDraft(track);
  refreshUI();
  draw();
}
function refreshOnly() {
  refreshUI();
  draw();
}

// --- Canvas sizing ---
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (map) map.invalidateSize({ animate: false });
  draw();
}
new ResizeObserver(resizeCanvas).observe(wrap);

function fitView() {
  if (geoActive()) {
    fitMapToTrack();
    return;
  }
  const bbox = trackBBox(track);
  if (!bbox) return;
  const { w, h } = cssSize();
  const pad = 1.25;
  const spanX = Math.max(bbox.w, 40) * pad;
  const spanY = Math.max(bbox.h, 40) * pad;
  view.cx = (bbox.minX + bbox.maxX) / 2;
  view.cy = (bbox.minY + bbox.maxY) / 2;
  view.pxPerM = Math.min(w / spanX, h / spanY);
  view.pxPerM = Math.max(0.4, Math.min(25, view.pxPerM));
  draw();
}

// --- Geo map (Leaflet, driven programmatically by the canvas handlers) ---
function ensureMap() {
  if (map) return map;
  map = L.map('geoMap', {
    zoomControl: false,
    attributionControl: true,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    zoomSnap: 0,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false,
    inertia: false
  });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Imagery &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics'
  }).addTo(map);
  map.setView([45.0, 10.0], 4);
  map.on('move zoom moveend zoomend', draw);
  return map;
}

function setGeoOn(on) {
  geoOn = on;
  els.geoMapDiv.classList.toggle('on', on);
  els.geoControls.style.display = on ? '' : 'none';
  setInput(els.chkGeoMap, on);
  if (on) {
    ensureMap();
    map.invalidateSize({ animate: false });
    if (hasGeo(track)) fitMapToTrack();
  } else {
    fitView();
  }
  refreshOnly();
}

function bboxCenter() {
  const b = trackBBox(track);
  return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
}

function fitMapToTrack() {
  if (!map || !hasGeo(track)) return;
  const b = trackBBox(track);
  if (!b) return;
  const corners = [
    [b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.minY], [b.maxX, b.maxY]
  ].map(([x, y]) => {
    const ll = metersToLatLng(track.geo, x, y);
    return [ll.lat, ll.lng];
  });
  map.fitBounds(L.latLngBounds(corners).pad(0.3), { animate: false });
  draw();
}

// Anchor (or re-anchor) the track so its bounding-box center lands on lat/lng.
function anchorTrackAt(lat, lng) {
  if (!track.geo || !track.geo.origin) {
    track.geo = { origin: { lat, lng }, rotationDeg: 0 };
  }
  const c = bboxCenter();
  const cur = metersToLatLng(track.geo, c.x, c.y);
  track.geo.origin.lat += lat - cur.lat;
  track.geo.origin.lng += lng - cur.lng;
}

// Change rotation while keeping the track's bbox center fixed on the map.
function setRotation(deg) {
  if (!hasGeo(track)) return;
  const c = bboxCenter();
  const before = metersToLatLng(track.geo, c.x, c.y);
  track.geo.rotationDeg = deg;
  const after = metersToLatLng(track.geo, c.x, c.y);
  track.geo.origin.lat += before.lat - after.lat;
  track.geo.origin.lng += before.lng - after.lng;
}

// --- Rendering ---
function draw() {
  const { w, h } = cssSize();
  if (w === 0 || h === 0 || !track) return;

  if (geoOn) {
    // Satellite imagery shows through the transparent canvas
    ctx.clearRect(0, 0, w, h);
    if (!geoActive()) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const msg = 'Find your venue (search above the rotation control), then press "Move track to map center"';
      ctx.font = '14px sans-serif';
      const tw = ctx.measureText(msg).width;
      ctx.fillRect(w / 2 - tw / 2 - 14, h / 2 - 24, tw + 28, 44);
      ctx.fillStyle = '#fff';
      ctx.fillText(msg, w / 2 - tw / 2, h / 2 + 3);
      return;
    }
    // Keep px-per-meter in sync with the map zoom for snapping/hit logic
    const a = mToPx(0, 0), b = mToPx(10, 0);
    view.pxPerM = Math.hypot(b.x - a.x, b.y - a.y) / 10;
  } else {
    // Water background
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1f7ea0');
    grad.addColorStop(1, '#155f7c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    drawGrid(w, h);
  }

  drawSequenceLine();
  drawRacingLines();
  drawGates();
  drawStartPos();
  drawBuoys();
  drawScaleBar(w, h);
}

function drawGrid(w, h) {
  const minor = 10, major = 50;
  const topLeft = pxToM(0, 0);
  const botRight = pxToM(w, h);
  if (view.pxPerM * minor > 5) {
    drawGridLines(topLeft, botRight, minor, 'rgba(255,255,255,0.06)');
  }
  drawGridLines(topLeft, botRight, major, 'rgba(255,255,255,0.14)', true);
}

function drawGridLines(topLeft, botRight, step, color, labels = false) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.font = '10px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  const x0 = Math.floor(topLeft.x / step) * step;
  for (let x = x0; x <= botRight.x; x += step) {
    const p = mToPx(x, 0);
    ctx.beginPath();
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, cssSize().h);
    ctx.stroke();
    if (labels) ctx.fillText(`${x}m`, p.x + 3, cssSize().h - 6);
  }
  const y0 = Math.floor(botRight.y / step) * step;
  for (let y = y0; y <= topLeft.y; y += step) {
    const p = mToPx(0, y);
    ctx.beginPath();
    ctx.moveTo(0, p.y);
    ctx.lineTo(cssSize().w, p.y);
    ctx.stroke();
    if (labels) ctx.fillText(`${y}m`, 4, p.y - 3);
  }
}

function turnBuoys() {
  return track.buoys.filter(b => b.type !== 'marker');
}

function drawSequenceLine() {
  if (!poster && !showDistanceLegs) return;
  const turns = turnBuoys();
  if (turns.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(124,252,0,0.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  turns.forEach((b, i) => {
    const p = mToPx(b.x, b.y);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  const first = mToPx(turns[0].x, turns[0].y);
  ctx.lineTo(first.x, first.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgb(124,252,0)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < turns.length; i++) {
    const cur = turns[i];
    const next = turns[(i + 1) % turns.length];
    const a = mToPx(cur.x, cur.y);
    const b = mToPx(next.x, next.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    drawArrowhead(mid.x, mid.y, ang, 9);

    const distM = hasGeo(track)
      ? groundDistanceMeters(track.geo, cur.x, cur.y, next.x, next.y)
      : Math.hypot(next.x - cur.x, next.y - cur.y);
    const off = segLen > 0 ? 20 : 0;
    const lx = mid.x - Math.sin(ang) * off;
    const ly = mid.y + Math.cos(ang) * off;
    ctx.fillText(`${distM.toFixed(1)} m`, lx, ly);
  }
  ctx.restore();
}

function drawArrowhead(x, y, angle, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.6, size * 0.55);
  ctx.lineTo(-size * 0.6, -size * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawRacingLines() {
  if (!track.racingLines?.length) return;
  track.racingLines.forEach(line => {
    if (line.visible === false || !line.points || line.points.length < 2) return;
    const pts = line.points.map(p => mToPx(p.x, p.y));
    const color = line.color || RACING_LINE_COLORS[0];

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.82;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    let distAlong = 0;
    const arrowSpacing = 42;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      let d = arrowSpacing - (distAlong % arrowSpacing);
      while (d <= segLen) {
        const t = d / segLen;
        drawArrowhead(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, ang, 7);
        d += arrowSpacing;
      }
      distAlong += segLen;
    }
    ctx.restore();
  });
}

function drawBuoys() {
  let turnNo = 0;
  const selBuoy = selectedBuoyIndex();
  track.buoys.forEach((b, i) => {
    const p = mToPx(b.x, b.y);
    const isTurn = b.type !== 'marker';
    if (isTurn) turnNo += 1;
    const r = isTurn ? 10 : 5;

    if (isTurn) drawVisitHints(i, p, r);

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isTurn ? '#FFE44D' : '#FF8800';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();

    if (isTurn) {
      ctx.fillStyle = '#222';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(turnNo), p.x, p.y + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    if (selBuoy === i) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#36b6e5';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
}

function selectedBuoyIndex() {
  if (selection?.kind === 'buoy') return selection.index;
  if (selection?.kind === 'visit') {
    const v = track.visits?.[selection.index];
    return v ? v.buoy : null;
  }
  return null;
}

function inboundHeadingForVisit(visitIndex) {
  const v = track.visits[visitIndex];
  const b = track.buoys[v.buoy];
  let from = null;
  if (visitIndex > 0) {
    from = track.buoys[track.visits[visitIndex - 1].buoy];
  } else if (track.startPosition && Number.isFinite(track.startPosition.x)) {
    from = track.startPosition;
  } else if (track.visits.length > 1) {
    from = track.buoys[track.visits[track.visits.length - 1].buoy];
  }
  if (!from || (from.x === b.x && from.y === b.y)) return Math.PI / 2;
  return Math.atan2(b.y - from.y, b.x - from.x);
}

function inboundHeadingRad(buoyIndex) {
  const at = (track.visits || []).findIndex(v => v.buoy === buoyIndex);
  if (at >= 0) return inboundHeadingForVisit(at);
  const b = track.buoys[buoyIndex];
  let from = null;
  for (let j = buoyIndex - 1; j >= 0; j--) {
    if (track.buoys[j].type !== 'marker') {
      from = track.buoys[j];
      break;
    }
  }
  if (!from && track.startPosition && Number.isFinite(track.startPosition.x)) {
    from = track.startPosition;
  }
  if (!from) return Math.PI / 2;
  return Math.atan2(b.y - from.y, b.x - from.x);
}

function drawVisitHints(buoyIndex, p, r) {
  const at = (track.visits || [])
    .map((v, i) => ({ v, i }))
    .filter(x => x.v.buoy === buoyIndex);
  if (!at.length) {
    const side = track.buoys[buoyIndex].rounding;
    if (side) drawPassSideHint(buoyIndex, p, r + 8, normalizePassSide(side), '#fff', null);
    return;
  }
  at.forEach((entry, pass) => {
    const radius = r + 8 + pass * 10;
    const color = pass === 0 ? '#fff' : '#ffe44d';
    drawPassSideHint(buoyIndex, p, radius, normalizePassSide(entry.v.side), color, entry.i);
  });
}

function strokeShortArc(p, r, a0, a1, tip, color) {
  const size = 6.5;
  const trim = (size * 0.85) / r;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  // a0 → a1 is the short clockwise sweep. Never take the long way around.
  if (tip.a === a1) ctx.arc(p.x, p.y, r, a0, a1 - trim, false);
  else ctx.arc(p.x, p.y, r, a0 + trim, a1, false);
  ctx.stroke();
  const ex = p.x + r * Math.cos(tip.a);
  const ey = p.y + r * Math.sin(tip.a);
  drawArrowhead(
    ex + Math.cos(tip.tang) * size * 0.55,
    ey + Math.sin(tip.tang) * size * 0.55,
    tip.tang,
    size
  );
  ctx.restore();
}

function draw360Hint(p, r, fwd, goRight, color) {
  const size = 6.5;
  const gapPx = 4;
  const open = Math.max(0.18, (size * 1.55 + gapPx) / r);
  const sweep = Math.PI * 2 - open;
  const a0 = fwd + Math.PI;
  const dir = goRight ? 1 : -1;
  const a1 = a0 + dir * sweep;
  const tang = a1 + dir * Math.PI / 2;
  const endTrim = (size * 0.7) / r;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, a0, a1 - dir * endTrim, dir < 0);
  ctx.stroke();
  const ex = p.x + r * Math.cos(a1);
  const ey = p.y + r * Math.sin(a1);
  drawArrowhead(
    ex + Math.cos(tang) * size * 0.55,
    ey + Math.sin(tang) * size * 0.55,
    tang,
    size
  );
  ctx.restore();
}

// Pass-side hint: Right/Left = path on that side; 360 Left/Right = almost-full wrap.
function drawPassSideHint(buoyIndex, p, r, side, color = '#fff', visitIndex = null) {
  const b = track.buoys[buoyIndex];
  const h = (visitIndex != null)
    ? inboundHeadingForVisit(visitIndex)
    : inboundHeadingRad(buoyIndex);
  const ahead = mToPx(b.x + Math.cos(h) * 8, b.y + Math.sin(h) * 8);
  const fwd = Math.atan2(ahead.y - p.y, ahead.x - p.x);

  if (side === '360-left' || side === '360-right' || side === '360') {
    draw360Hint(p, r, fwd, side !== '360-left', color);
    return;
  }

  const sideSign = side === 'right' ? 1 : -1;
  const midA = fwd + sideSign * Math.PI / 2;
  const sweep = Math.PI * 0.85;
  const a0 = midA - sweep / 2;
  const a1 = midA + sweep / 2;
  const fx = Math.cos(fwd);
  const fy = Math.sin(fwd);
  const align = tang => Math.cos(tang) * fx + Math.sin(tang) * fy;
  const cwTip = { a: a1, tang: a1 + Math.PI / 2 };
  const ccwTip = { a: a0, tang: a0 - Math.PI / 2 };
  const tip = align(cwTip.tang) >= align(ccwTip.tang) ? cwTip : ccwTip;
  strokeShortArc(p, r, a0, a1, tip, color);
}

function drawGates() {
  const gate = track.gate;
  if (!gate) return;
  const same = gate.sameStartFinish !== false;
  drawGateSegment(gate.start, same ? 'START / FINISH' : 'START');
  if (!same && gate.finish) drawGateSegment(gate.finish, 'FINISH');

  // Required-direction arrow at the start gate midpoint
  if ((gate.directional || gate.directionalFinish) && gate.start) {
    const seg = (gate.directionalFinish && !same && gate.finish) ? gate.finish : gate.start;
    const mid = mToPx((seg.x1 + seg.x2) / 2, (seg.y1 + seg.y2) / 2);
    const d = gate.direction || { x: 1, y: 0 };
    const ang = Math.atan2(-d.y, d.x);
    ctx.fillStyle = 'rgba(255,80,80,0.95)';
    drawArrowhead(mid.x + Math.cos(ang) * 16, mid.y + Math.sin(ang) * 16, ang, 10);
  }
}

function drawGateSegment(seg, label) {
  if (!seg) return;
  const p1 = mToPx(seg.x1, seg.y1);
  const p2 = mToPx(seg.x2, seg.y2);
  ctx.save();
  ctx.strokeStyle = '#FF4444';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  // Endpoint handles (editor chrome, skipped on poster exports)
  if (!poster) {
    [p1, p2].forEach(p => {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#FF4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(p.x - 4, p.y - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    });
  }

  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  ctx.font = 'bold 10px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  const widthM = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  ctx.fillText(`${label} (${widthM.toFixed(0)} m)`, mid.x + 8, mid.y - 8);
  ctx.restore();
}

function drawStartPos() {
  const sp = track.startPosition;
  if (!sp || !Number.isFinite(sp.x)) return;
  const p = mToPx(sp.x, sp.y);
  const deg = sp.headingDeg ?? 90;
  const ang = Math.atan2(-Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180));
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-8, 8);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-8, -8);
  ctx.closePath();
  ctx.fillStyle = '#00e5ff';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  ctx.font = 'bold 10px sans-serif';
  ctx.fillStyle = 'rgba(0,229,255,0.9)';
  ctx.fillText('START POS', p.x + 12, p.y + 16);
}

function drawScaleBar(w, h) {
  const x0 = 16, y0 = h - 22;
  let barLenPx, labelM;

  if (geoActive()) {
    // Measure true ground distance along track +x so the bar is accurate at any rotation.
    const pA = mToPx(0, 0);
    const pB = mToPx(50, 0);
    const pxPer50 = Math.hypot(pB.x - pA.x, pB.y - pA.y);
    if (pxPer50 < 5) return;
    labelM = niceRound(50 * (80 / pxPer50));
    barLenPx = pxPer50 * (labelM / 50);
    const dx = (pB.x - pA.x) / pxPer50;
    const dy = (pB.y - pA.y) / pxPer50;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + dx * barLenPx, y0 + dy * barLenPx);
    ctx.moveTo(x0 - dy * 4, y0 + dx * 4);
    ctx.lineTo(x0 + dy * 4, y0 - dx * 4);
    ctx.moveTo(x0 + dx * barLenPx - dy * 4, y0 + dy * barLenPx + dx * 4);
    ctx.lineTo(x0 + dx * barLenPx + dy * 4, y0 + dy * barLenPx - dx * 4);
    ctx.stroke();
    ctx.font = '11px sans-serif';
    ctx.fillText(`${labelM} m`, x0 + dx * barLenPx / 2 - 14, y0 + dy * barLenPx / 2 - 8);
    ctx.restore();
    return;
  }

  const targetPx = 100;
  labelM = niceRound(targetPx / view.pxPerM);
  barLenPx = labelM * view.pxPerM;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x0 + barLenPx, y0);
  ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0 + 5);
  ctx.moveTo(x0 + barLenPx, y0 - 5); ctx.lineTo(x0 + barLenPx, y0 + 5);
  ctx.stroke();
  ctx.font = '11px sans-serif';
  ctx.fillText(`${labelM} m`, x0 + barLenPx / 2 - 12, y0 - 8);
  ctx.restore();
}

function niceRound(v) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  for (const s of steps) if (v <= s) return s;
  return 1000;
}

// --- Hit testing ---
function hitTest(px, py) {
  // Buoys (topmost priority, reverse order so later buoys win)
  for (let i = track.buoys.length - 1; i >= 0; i--) {
    const p = mToPx(track.buoys[i].x, track.buoys[i].y);
    if (Math.hypot(px - p.x, py - p.y) <= BUOY_HIT_PX) {
      return { kind: 'buoy', index: i };
    }
  }
  // Gate endpoints
  const gate = track.gate;
  const segs = [];
  if (gate?.start) segs.push({ which: 'start', seg: gate.start });
  if (gate?.sameStartFinish === false && gate.finish) segs.push({ which: 'finish', seg: gate.finish });
  for (const { which, seg } of segs) {
    const p1 = mToPx(seg.x1, seg.y1);
    const p2 = mToPx(seg.x2, seg.y2);
    if (Math.hypot(px - p1.x, py - p1.y) <= HANDLE_HIT_PX) return { kind: 'gateEnd', which, end: 1 };
    if (Math.hypot(px - p2.x, py - p2.y) <= HANDLE_HIT_PX) return { kind: 'gateEnd', which, end: 2 };
  }
  // Start position marker
  const sp = track.startPosition;
  if (sp && Number.isFinite(sp.x)) {
    const p = mToPx(sp.x, sp.y);
    if (Math.hypot(px - p.x, py - p.y) <= BUOY_HIT_PX) return { kind: 'startPos' };
  }
  // Gate line (move whole gate)
  for (const { which, seg } of segs) {
    const p1 = mToPx(seg.x1, seg.y1);
    const p2 = mToPx(seg.x2, seg.y2);
    if (distToSegment(px, py, p1, p2) <= 7) return { kind: 'gateLine', which };
  }
  return null;
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

// --- Pointer interaction ---
function eventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

const activePointers = new Map();
let pinch = null;

function pointerCenterAndDist() {
  const pts = [...activePointers.values()];
  if (pts.length < 2) return null;
  return {
    x: (pts[0].x + pts[1].x) / 2,
    y: (pts[0].y + pts[1].y) / 2,
    dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
  };
}

function zoomCanvasAt(p, factor) {
  if (factor === 1) return;
  if (geoOn && map) {
    const newZ = Math.max(3, Math.min(19, map.getZoom() + Math.log2(factor)));
    map.setZoomAround(L.point(p.x, p.y), newZ, { animate: false });
    draw();
    return;
  }
  const before = pxToM(p.x, p.y);
  view.pxPerM = Math.max(0.4, Math.min(25, view.pxPerM * factor));
  const after = pxToM(p.x, p.y);
  view.cx += before.x - after.x;
  view.cy += before.y - after.y;
  draw();
}

function trackPointer(e) {
  activePointers.set(e.pointerId, eventPos(e));
}

function releasePointer(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinch = null;
}

function beginPinchIfNeeded() {
  if (activePointers.size !== 2) return;
  const cd = pointerCenterAndDist();
  if (!cd || cd.dist < 2) return;
  pinch = { lastDist: cd.dist };
  drag = null;
}

// Block Safari/iOS page zoom gestures over the map area.
['gesturestart', 'gesturechange', 'gestureend'].forEach(type => {
  wrap.addEventListener(type, e => e.preventDefault(), { passive: false });
});

canvas.addEventListener('pointerdown', e => {
  trackPointer(e);
  beginPinchIfNeeded();
  if (pinch) return;

  if (e.button !== 0) return;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers */ }
  const p = eventPos(e);
  const m = pxToM(p.x, p.y);

  // While the map is on but the track is not anchored yet, only allow map panning
  if (geoOn && !geoActive()) {
    drag = { kind: 'panMap', startPx: p, startCenter: map.getCenter() };
    return;
  }

  if (mode === 'geoMove') {
    pushUndo();
    drag = {
      kind: 'geoMove',
      startLL: map.containerPointToLatLng(L.point(p.x, p.y)),
      origOrigin: { ...track.geo.origin }
    };
    return;
  }

  if (mode === 'select') {
    const hit = hitTest(p.x, p.y);
    if (hit) {
      pushUndo();
      if (hit.kind === 'buoy') {
        const vi = (track.visits || []).findIndex(v => v.buoy === hit.index);
        selection = vi >= 0 ? { kind: 'visit', index: vi } : hit;
        const b = track.buoys[hit.index];
        drag = { kind: 'buoy', index: hit.index, offX: b.x - m.x, offY: b.y - m.y };
        refreshUI();
      } else if (hit.kind === 'gateEnd') {
        drag = { kind: 'gateEnd', which: hit.which, end: hit.end };
      } else if (hit.kind === 'gateLine') {
        const seg = track.gate[hit.which];
        drag = { kind: 'gateLine', which: hit.which, startM: m, orig: { ...seg } };
      } else if (hit.kind === 'startPos') {
        const sp = track.startPosition;
        drag = { kind: 'startPos', offX: sp.x - m.x, offY: sp.y - m.y };
      }
    } else {
      selection = null;
      drag = geoActive()
        ? { kind: 'panMap', startPx: p, startCenter: map.getCenter() }
        : { kind: 'pan', startPx: p, startView: { cx: view.cx, cy: view.cy } };
      refreshUI();
    }
  } else if (mode === 'addTurn' || mode === 'addMarker') {
    drag = { kind: 'addPending', startPx: p };
  } else if (mode === 'addVisit') {
    const hit = hitTest(p.x, p.y);
    if (hit?.kind === 'buoy' && track.buoys[hit.index].type !== 'marker') {
      pushUndo();
      if (!track.visits) track.visits = [];
      track.visits.push({ buoy: hit.index, side: 'right' });
      selection = { kind: 'visit', index: track.visits.length - 1 };
      setMode('select');
      commit();
    }
    return;
  } else if (mode === 'gateStart' || mode === 'gateFinish') {
    pushUndo();
    const which = (mode === 'gateStart') ? 'start' : 'finish';
    track.gate[which] = { x1: snap(m.x), y1: snap(m.y), x2: snap(m.x), y2: snap(m.y) };
    drag = { kind: 'gateDraw', which };
  } else if (mode === 'start') {
    pushUndo();
    if (!track.startPosition) track.startPosition = { x: 0, y: 0, headingDeg: 0 };
    track.startPosition.x = snap(m.x);
    track.startPosition.y = snap(m.y);
    drag = { kind: 'startAim', originM: { x: m.x, y: m.y } };
    draw();
  }
});

canvas.addEventListener('pointermove', e => {
  trackPointer(e);

  if (pinch && activePointers.size >= 2) {
    e.preventDefault();
    const cd = pointerCenterAndDist();
    if (!cd || cd.dist < 2) return;
    const factor = cd.dist / pinch.lastDist;
    zoomCanvasAt({ x: cd.x, y: cd.y }, factor);
    pinch.lastDist = cd.dist;
    return;
  }

  if (!drag) return;
  const p = eventPos(e);
  const m = pxToM(p.x, p.y);

  switch (drag.kind) {
    case 'pan': {
      const dx = (p.x - drag.startPx.x) / view.pxPerM;
      const dy = (p.y - drag.startPx.y) / view.pxPerM;
      view.cx = drag.startView.cx - dx;
      view.cy = drag.startView.cy + dy;
      draw();
      break;
    }
    case 'panMap': {
      const z = map.getZoom();
      const startWorld = map.project(drag.startCenter, z);
      const target = map.unproject(
        startWorld.subtract(L.point(p.x - drag.startPx.x, p.y - drag.startPx.y)), z);
      map.setView(target, z, { animate: false });
      break;
    }
    case 'geoMove': {
      const ll = map.containerPointToLatLng(L.point(p.x, p.y));
      track.geo.origin.lat = drag.origOrigin.lat + (ll.lat - drag.startLL.lat);
      track.geo.origin.lng = drag.origOrigin.lng + (ll.lng - drag.startLL.lng);
      refreshOnly();
      break;
    }
    case 'buoy': {
      const b = track.buoys[drag.index];
      b.x = snap(m.x + drag.offX);
      b.y = snap(m.y + drag.offY);
      refreshOnly();
      break;
    }
    case 'gateEnd': {
      const seg = track.gate[drag.which];
      if (drag.end === 1) { seg.x1 = snap(m.x); seg.y1 = snap(m.y); }
      else { seg.x2 = snap(m.x); seg.y2 = snap(m.y); }
      refreshOnly();
      break;
    }
    case 'gateLine': {
      const dx = m.x - drag.startM.x;
      const dy = m.y - drag.startM.y;
      const seg = track.gate[drag.which];
      seg.x1 = snap(drag.orig.x1 + dx);
      seg.y1 = snap(drag.orig.y1 + dy);
      seg.x2 = snap(drag.orig.x2 + dx);
      seg.y2 = snap(drag.orig.y2 + dy);
      refreshOnly();
      break;
    }
    case 'startPos': {
      track.startPosition.x = snap(m.x + drag.offX);
      track.startPosition.y = snap(m.y + drag.offY);
      refreshOnly();
      break;
    }
    case 'gateDraw': {
      const seg = track.gate[drag.which];
      seg.x2 = snap(m.x);
      seg.y2 = snap(m.y);
      refreshOnly();
      break;
    }
    case 'startAim': {
      const dx = m.x - drag.originM.x;
      const dy = m.y - drag.originM.y;
      if (Math.hypot(dx, dy) > 3 / view.pxPerM * 3) {
        track.startPosition.headingDeg = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
        refreshOnly();
      }
      break;
    }
  }
});

canvas.addEventListener('pointerup', e => {
  const wasPinch = !!pinch;
  releasePointer(e);
  if (wasPinch) return;

  const p = eventPos(e);
  if (drag) {
    if (drag.kind === 'addPending') {
      const moved = Math.hypot(p.x - drag.startPx.x, p.y - drag.startPx.y);
      if (moved < 5) {
        pushUndo();
        const m = pxToM(p.x, p.y);
        const buoy = (mode === 'addTurn')
          ? { x: snap(m.x), y: snap(m.y), type: 'turn', rounding: 'right', apexRadius: 40, optimalSpeed: 30 }
          : { x: snap(m.x), y: snap(m.y), type: 'marker', apexRadius: 40 };
        track.buoys.push(buoy);
        if (mode === 'addTurn') {
          if (!track.visits) track.visits = [];
          track.visits.push({ buoy: track.buoys.length - 1, side: 'right' });
          selection = { kind: 'visit', index: track.visits.length - 1 };
        } else {
          selection = { kind: 'buoy', index: track.buoys.length - 1 };
        }
      }
    } else if (drag.kind === 'gateDraw') {
      const seg = track.gate[drag.which];
      if (Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) < 2) {
        // Degenerate drag: place a default 30 m vertical gate centered here
        seg.y1 = snap(seg.y1 - 15);
        seg.y2 = snap(seg.y2 + 15);
      }
      setMode('select');
    } else if (drag.kind === 'startAim' || drag.kind === 'geoMove') {
      setMode('select');
    } else if (drag.kind === 'panMap') {
      drag = null;
      return; // map panning doesn't modify the track — skip commit
    }
    drag = null;
    commit();
  }
});

canvas.addEventListener('pointercancel', e => {
  releasePointer(e);
  if (activePointers.size === 0) {
    pinch = null;
    if (drag?.kind === 'panMap') drag = null;
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = eventPos(e);
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomCanvasAt(p, factor);
}, { passive: false });

// --- Modes ---
const modeButtons = {
  select: document.getElementById('toolSelect'),
  addTurn: document.getElementById('toolAddTurn'),
  addMarker: document.getElementById('toolAddMarker'),
  gateStart: document.getElementById('toolGate'),
  gateFinish: document.getElementById('toolGateFinish'),
  start: document.getElementById('toolStart'),
  geoMove: document.getElementById('toolGeoMove')
};

function setMode(m) {
  mode = m;
  Object.entries(modeButtons).forEach(([key, btn]) => {
    if (btn) btn.classList.toggle('active', key === m);
  });
  if (els.btnAddVisit) els.btnAddVisit.classList.toggle('active', m === 'addVisit');
  canvas.style.cursor = (m === 'select') ? 'default' : 'crosshair';
}
Object.entries(modeButtons).forEach(([key, btn]) => btn.addEventListener('click', () => setMode(key)));

// --- Keyboard ---
document.addEventListener('keydown', e => {
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (typing) return;
  switch (e.key) {
    case 'v': case 'V': setMode('select'); break;
    case 'b': case 'B': setMode('addTurn'); break;
    case 'm': case 'M': setMode('addMarker'); break;
    case 'g': case 'G': setMode('gateStart'); break;
    case 's': case 'S': setMode('start'); break;
    case 'p': case 'P':
      if (track.racingLines?.length) {
        pushUndo();
        const show = track.racingLines.every(l => l.visible === false);
        track.racingLines.forEach(l => { l.visible = show; });
        commit();
      }
      break;
    case 'd': case 'D':
      showDistanceLegs = !showDistanceLegs;
      draw();
      break;
    case 'f': case 'F': fitView(); break;
    case 'Escape':
      setMode('select');
      els.shareModal.classList.remove('open');
      closeExportModal();
      break;
    case 'Delete': case 'Backspace':
      if (selection?.kind === 'visit') {
        e.preventDefault();
        deleteSelectedVisit();
      } else if (selection && selection.kind === 'buoy') {
        e.preventDefault();
        deleteSelectedBuoy();
      }
      break;
  }
});

// --- Buoy operations ---
function deleteSelectedBuoy() {
  const idx = selectedBuoyIndex();
  if (idx == null) return;
  pushUndo();
  track.visits = (track.visits || [])
    .filter(v => v.buoy !== idx)
    .map(v => ({ ...v, buoy: v.buoy > idx ? v.buoy - 1 : v.buoy }));
  track.buoys.splice(idx, 1);
  selection = null;
  commit();
}

function deleteSelectedVisit() {
  if (selection?.kind !== 'visit') return;
  pushUndo();
  track.visits.splice(selection.index, 1);
  selection = null;
  commit();
}

function moveVisit(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= track.visits.length) return;
  pushUndo();
  const [v] = track.visits.splice(index, 1);
  track.visits.splice(target, 0, v);
  selection = { kind: 'visit', index: target };
  commit();
}

function moveBuoy(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= track.buoys.length) return;
  pushUndo();
  const [b] = track.buoys.splice(index, 1);
  track.buoys.splice(target, 0, b);
  (track.visits || []).forEach(v => {
    if (v.buoy === index) v.buoy = target;
    else if (delta > 0 && v.buoy > index && v.buoy <= target) v.buoy -= 1;
    else if (delta < 0 && v.buoy >= target && v.buoy < index) v.buoy += 1;
  });
  if (selection?.kind === 'buoy' && selection.index === index) selection.index = target;
  commit();
}

// --- Sidebar / UI sync ---
function setInput(el, value) {
  if (document.activeElement === el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value ?? '';
}

function refreshUI() {
  setInput(els.trackName, track.name);
  setInput(els.trackAuthor, track.author);
  setInput(els.trackNotes, track.notes);
  const st = ensureStartTechnique(track);
  setInput(els.startTimetrial, st.timetrial);
  setInput(els.startElimination, st.elimination);
  setInput(els.startNotes, st.notes);

  const gate = track.gate;
  setInput(els.chkSameStartFinish, gate.sameStartFinish !== false);
  setInput(els.chkDirectional, gate.directional);
  setInput(els.chkDirectionalFinish, gate.directionalFinish);
  els.toolGateFinish.style.display = gate.sameStartFinish === false ? '' : 'none';
  const showDir = gate.directional || gate.directionalFinish;
  els.rowDirection.style.display = showDir ? '' : 'none';
  if (showDir) {
    const d = gate.direction || { x: 1, y: 0 };
    setInput(els.selDirection, `${d.x},${d.y}`);
  }

  refreshGeoUI();
  rebuildLineList();
  rebuildBuoyList();
  refreshBuoyProps();
  refreshStats();
  refreshWarnings();
}

function rebuildLineList() {
  els.lineList.innerHTML = '';
  if (!track.racingLines.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--muted); font-size:12px; padding:4px 0;';
    empty.textContent = 'No racing lines yet — add a variant, then record a lap.';
    els.lineList.appendChild(empty);
    return;
  }

  track.racingLines.forEach((line, i) => {
    const item = document.createElement('div');
    item.className = 'lineItem';

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = line.color || RACING_LINE_COLORS[i % RACING_LINE_COLORS.length];
    swatch.title = 'Cycle color';
    swatch.style.cursor = 'pointer';
    swatch.addEventListener('click', () => {
      pushUndo();
      const idx = RACING_LINE_COLORS.indexOf(line.color);
      line.color = RACING_LINE_COLORS[(idx + 1) % RACING_LINE_COLORS.length];
      commit();
    });
    item.appendChild(swatch);

    const name = document.createElement('input');
    name.className = 'lineName';
    name.type = 'text';
    name.value = line.name || defaultRacingLineName(i);
    name.spellcheck = false;
    name.addEventListener('change', () => {
      pushUndo();
      line.name = name.value.trim() || defaultRacingLineName(i);
      commit();
    });
    item.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'lineMeta';
    const ptCount = line.points?.length || 0;
    const lap = line.ghost?.lapTime;
    meta.textContent = ptCount >= 2
      ? `${ptCount} pts${lap ? ` · ${lap.toFixed(1)}s` : ''}`
      : 'not recorded';
    item.appendChild(meta);

    const vis = document.createElement('button');
    vis.className = 'mini';
    vis.textContent = line.visible === false ? '\u25CB' : '\u25CF';
    vis.title = line.visible === false ? 'Show line on map' : 'Hide line on map';
    vis.addEventListener('click', () => {
      pushUndo();
      line.visible = line.visible === false;
      commit();
    });
    item.appendChild(vis);

    const chase = document.createElement('button');
    chase.className = 'mini' + (line.chase ? ' chase-on' : '');
    chase.textContent = line.chase ? '\u2605' : '\u2606';
    chase.title = line.chase ? 'Default chase ghost' : 'Set as chase ghost';
    chase.setAttribute('aria-pressed', line.chase ? 'true' : 'false');
    chase.addEventListener('click', () => {
      pushUndo();
      track.racingLines.forEach(l => { l.chase = false; });
      line.chase = true;
      commit();
    });
    item.appendChild(chase);

    const rec = document.createElement('button');
    rec.className = 'mini record';
    rec.textContent = '\u25CF Rec';
    rec.title = 'Record this line in the simulator';
    rec.addEventListener('click', () => startLineRecording(line.id));
    item.appendChild(rec);

    const del = document.createElement('button');
    del.className = 'mini';
    del.textContent = '\u2715';
    del.title = 'Delete line';
    del.addEventListener('click', () => {
      if (!confirm(`Delete racing line "${line.name}"?`)) return;
      pushUndo();
      track.racingLines.splice(i, 1);
      commit();
    });
    item.appendChild(del);

    els.lineList.appendChild(item);
  });
}

function startLineRecording(lineId) {
  const { errors } = validateTrack(track);
  if (errors.length) {
    alert('Fix these before recording:\n' + errors.join('\n'));
    return;
  }
  saveDraft(track);
  localStorage.setItem(LINE_RECORD_META_KEY, JSON.stringify({ lineId }));
  window.location.href = `index.html?track=draft&recordLine=${encodeURIComponent(lineId)}`;
}

function absorbLineCapture() {
  const raw = localStorage.getItem(LINE_CAPTURE_KEY);
  if (!raw) return false;
  localStorage.removeItem(LINE_CAPTURE_KEY);
  localStorage.removeItem(LINE_RECORD_META_KEY);
  try {
    const capture = JSON.parse(raw);
    if (!capture?.lineId || !capture?.points) return false;
    pushUndo();
    let line = track.racingLines.find(l => l.id === capture.lineId);
    if (!line) {
      line = {
        id: capture.lineId,
        name: capture.lineName || defaultRacingLineName(track.racingLines.length),
        color: RACING_LINE_COLORS[track.racingLines.length % RACING_LINE_COLORS.length],
        visible: true,
        points: [],
        chase: track.racingLines.every(l => !l.chase)
      };
      track.racingLines.push(line);
    }
    line.points = capture.points;
    if (capture.ghost) line.ghost = capture.ghost;
    if (!track.racingLines.some(l => l.chase)) line.chase = true;
    commit();
    return true;
  } catch (e) {
    console.warn('Could not absorb line capture:', e);
    return false;
  }
}

function refreshGeoUI() {
  setInput(els.chkGeoMap, geoOn);
  els.geoControls.style.display = geoOn ? '' : 'none';
  const anchored = hasGeo(track);
  if (anchored) {
    const deg = Math.round(track.geo.rotationDeg || 0);
    setInput(els.geoRotation, deg);
    setInput(els.geoRotationSlider, deg);
    els.geoOriginInfo.textContent =
      `Anchor: ${track.geo.origin.lat.toFixed(6)}, ${track.geo.origin.lng.toFixed(6)}`;
  } else {
    els.geoOriginInfo.textContent = 'Not anchored to a location yet';
  }
  ['btnExportGpx', 'btnExportKml', 'btnExportCsv', 'toolGeoMove'].forEach(id => {
    document.getElementById(id).disabled = !anchored;
  });
}

function rebuildBuoyList() {
  els.buoyList.innerHTML = '';
  ensureVisits(track);
  if (!track.visits.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--muted); font-size:12px; padding:4px 0;';
    empty.textContent = 'No turns yet — place a turn buoy, or Add a turn on an existing one.';
    els.buoyList.appendChild(empty);
    return;
  }
  track.visits.forEach((v, i) => {
    const item = document.createElement('div');
    item.className = 'buoyItem' + (selection?.kind === 'visit' && selection.index === i ? ' selected' : '');

    const tag = document.createElement('span');
    tag.className = 'tag turn';
    tag.textContent = String(i + 1);
    item.appendChild(tag);

    const coords = document.createElement('span');
    coords.className = 'coords';
    const n = physicalBuoyNumber(track, v.buoy);
    coords.textContent = `Buoy #${n} \u00B7 ${passSideLabel(v.side)}`;
    item.appendChild(coords);

    const up = document.createElement('button');
    up.className = 'mini'; up.textContent = '\u25B2'; up.title = 'Earlier in course order';
    up.addEventListener('click', ev => { ev.stopPropagation(); moveVisit(i, -1); });
    const down = document.createElement('button');
    down.className = 'mini'; down.textContent = '\u25BC'; down.title = 'Later in course order';
    down.addEventListener('click', ev => { ev.stopPropagation(); moveVisit(i, 1); });
    const del = document.createElement('button');
    del.className = 'mini'; del.textContent = '\u2715'; del.title = 'Remove this turn';
    del.addEventListener('click', ev => {
      ev.stopPropagation();
      selection = { kind: 'visit', index: i };
      deleteSelectedVisit();
    });
    item.appendChild(up); item.appendChild(down); item.appendChild(del);

    item.addEventListener('click', () => {
      selection = { kind: 'visit', index: i };
      refreshOnly();
    });
    els.buoyList.appendChild(item);
  });
}

function refreshBuoyProps() {
  const buoyIdx = selectedBuoyIndex();
  const sel = buoyIdx != null ? track.buoys[buoyIdx] : null;
  els.buoyProps.style.display = sel ? '' : 'none';
  if (!sel) return;
  const isTurn = sel.type !== 'marker';
  setInput(els.buoyType, isTurn ? 'turn' : 'marker');
  els.rowRounding.style.display = isTurn ? '' : 'none';
  els.rowOptimalSpeed.style.display = isTurn ? '' : 'none';
  if (isTurn) {
    const visit = selection?.kind === 'visit'
      ? track.visits[selection.index]
      : (track.visits || []).find(v => v.buoy === buoyIdx);
    setInput(els.buoyRounding, visit ? normalizePassSide(visit.side) : normalizePassSide(sel.rounding));
    setInput(els.buoyOptimalSpeed, sel.optimalSpeed ?? 30);
  }
  setInput(els.buoyX, sel.x);
  setInput(els.buoyY, sel.y);
}

function refreshStats() {
  const s = trackStats(track);
  const area = s.bbox ? `${Math.round(s.bbox.w)} × ${Math.round(s.bbox.h)} m` : '–';
  let legsHtml = '';
  if (s.legDistances.length) {
    legsHtml = '<br>Legs' + (hasGeo(track) ? ' (ground)' : '') + ': ' + s.legDistances
      .map(l => {
        const m = hasGeo(track) ? l.groundM : l.trackM;
        return `<b>${l.from}→${l.to}: ${m.toFixed(1)} m</b>`;
      })
      .join(', ');
  }
  const lineCount = (track.racingLines || []).filter(l => l.points?.length >= 2).length;
  els.stats.innerHTML =
    `Turn buoys: <b>${s.turnCount}</b> &nbsp; Course turns: <b>${s.visitCount}</b> &nbsp; Markers: <b>${s.markerCount}</b><br>` +
    `Lap length: <b>${Math.round(s.lapLengthGroundM)} m</b>` +
    (hasGeo(track) ? ' <span style="color:var(--muted)">(ground)</span>' : '') + '<br>' +
    `Gate width: <b>${s.gateWidthM.toFixed(0)} m</b><br>` +
    `Racing lines: <b>${lineCount}</b><br>` +
    `Track area: <b>${area}</b>` + legsHtml;
}

function refreshWarnings() {
  const { errors, warnings } = validateTrack(track);
  els.warnings.innerHTML = '';
  const add = (text, cls) => {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = text;
    els.warnings.appendChild(div);
  };
  errors.forEach(t => add(t, 'error'));
  warnings.forEach(t => add(t, 'warning'));
  if (!errors.length && !warnings.length) add('Track is ready to ride \u2713', 'ok');
}

// --- Sidebar input handlers ---
els.trackName.addEventListener('input', () => { track.name = els.trackName.value; saveDraft(track); });
els.trackAuthor.addEventListener('input', () => { track.author = els.trackAuthor.value; saveDraft(track); });
els.trackNotes.addEventListener('input', () => { track.notes = els.trackNotes.value; saveDraft(track); });
els.startTimetrial.addEventListener('input', () => {
  ensureStartTechnique(track).timetrial = els.startTimetrial.value;
  saveDraft(track);
});
els.startElimination.addEventListener('input', () => {
  ensureStartTechnique(track).elimination = els.startElimination.value;
  saveDraft(track);
});
els.startNotes.addEventListener('input', () => {
  ensureStartTechnique(track).notes = els.startNotes.value;
  saveDraft(track);
});

els.chkSameStartFinish.addEventListener('change', () => {
  pushUndo();
  track.gate.sameStartFinish = els.chkSameStartFinish.checked;
  if (!track.gate.sameStartFinish && !track.gate.finish && track.gate.start) {
    // Seed a finish gate offset from the start gate so there is something to drag
    const s = track.gate.start;
    track.gate.finish = { x1: s.x1 + 30, y1: s.y1, x2: s.x2 + 30, y2: s.y2 };
  }
  commit();
});
els.chkDirectional.addEventListener('change', () => {
  pushUndo();
  track.gate.directional = els.chkDirectional.checked;
  commit();
});
els.chkDirectionalFinish.addEventListener('change', () => {
  pushUndo();
  track.gate.directionalFinish = els.chkDirectionalFinish.checked;
  commit();
});
els.selDirection.addEventListener('change', () => {
  pushUndo();
  const [x, y] = els.selDirection.value.split(',').map(Number);
  track.gate.direction = { x, y };
  commit();
});

els.buoyType.addEventListener('change', () => {
  const idx = selectedBuoyIndex();
  const sel = idx != null ? track.buoys[idx] : null;
  if (!sel) return;
  pushUndo();
  const wasTurn = sel.type !== 'marker';
  sel.type = els.buoyType.value;
  if (sel.type === 'turn' && !sel.rounding) sel.rounding = 'right';
  if (wasTurn && sel.type === 'marker') {
    track.visits = (track.visits || []).filter(v => v.buoy !== idx);
  } else if (!wasTurn && sel.type === 'turn') {
    if (!track.visits) track.visits = [];
    track.visits.push({ buoy: idx, side: 'right' });
  }
  commit();
});
els.buoyRounding.addEventListener('change', () => {
  const idx = selectedBuoyIndex();
  if (idx == null) return;
  pushUndo();
  const side = normalizePassSide(els.buoyRounding.value);
  if (selection?.kind === 'visit' && track.visits[selection.index]) {
    track.visits[selection.index].side = side;
  } else {
    const visit = (track.visits || []).find(v => v.buoy === idx);
    if (visit) visit.side = side;
    track.buoys[idx].rounding = (side === '360-left' || side === '360-right' || side === '360')
      ? 'right' : side;
  }
  commit();
});
els.buoyOptimalSpeed.addEventListener('change', () => {
  const idx = selectedBuoyIndex();
  const sel = idx != null ? track.buoys[idx] : null;
  if (!sel) return;
  pushUndo();
  sel.optimalSpeed = Number(els.buoyOptimalSpeed.value) || 30;
  commit();
});
els.buoyX.addEventListener('change', () => {
  const idx = selectedBuoyIndex();
  const sel = idx != null ? track.buoys[idx] : null;
  if (!sel) return;
  pushUndo();
  sel.x = Number(els.buoyX.value) || 0;
  commit();
});
els.buoyY.addEventListener('change', () => {
  const idx = selectedBuoyIndex();
  const sel = idx != null ? track.buoys[idx] : null;
  if (!sel) return;
  pushUndo();
  sel.y = Number(els.buoyY.value) || 0;
  commit();
});
els.btnDeleteBuoy.addEventListener('click', deleteSelectedBuoy);
if (els.btnAddVisit) {
  els.btnAddVisit.addEventListener('click', () => setMode('addVisit'));
}

// --- Geo controls ---
els.chkGeoMap.addEventListener('change', () => setGeoOn(els.chkGeoMap.checked));

async function geoSearch() {
  const q = els.geoSearch.value.trim();
  if (!q) return;
  ensureMap();
  const coords = q.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (coords) {
    map.setView([Number(coords[1]), Number(coords[2])], 16, { animate: false });
    draw();
    return;
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const results = await res.json();
    if (!results.length) {
      alert(`No results for "${q}" — try adding the city or country, or paste "lat, lng" coordinates.`);
      return;
    }
    map.setView([Number(results[0].lat), Number(results[0].lon)], 15, { animate: false });
    draw();
  } catch (err) {
    alert('Venue search failed (network?): ' + err.message);
  }
}
document.getElementById('btnGeoSearch').addEventListener('click', geoSearch);
els.geoSearch.addEventListener('keydown', e => {
  if (e.key === 'Enter') geoSearch();
});

document.getElementById('btnGeoPlace').addEventListener('click', () => {
  ensureMap();
  pushUndo();
  const c = map.getCenter();
  anchorTrackAt(c.lat, c.lng);
  commit();
});

document.getElementById('btnFlipTrack').addEventListener('click', () => {
  pushUndo();
  flipTrackLayout(track);
  commit();
});

els.geoRotation.addEventListener('change', () => {
  if (!hasGeo(track)) return;
  pushUndo();
  setRotation(Number(els.geoRotation.value) || 0);
  commit();
});
els.geoRotationSlider.addEventListener('input', () => {
  if (!hasGeo(track)) return;
  if (!rotationUndoPushed) {
    pushUndo();
    rotationUndoPushed = true;
  }
  setRotation(Number(els.geoRotationSlider.value) || 0);
  refreshOnly();
});
els.geoRotationSlider.addEventListener('change', () => {
  rotationUndoPushed = false;
  commit();
});

document.getElementById('btnGeoRemove').addEventListener('click', () => {
  if (!track.geo) return;
  if (!confirm('Remove the real-world location anchor from this track?')) return;
  pushUndo();
  delete track.geo;
  setGeoOn(false);
  commit();
});

// --- GPS exports (buoy coordinates for the on-water crew) ---
function geoWaypoints() {
  const pts = [];
  const ll = (x, y) => metersToLatLng(track.geo, x, y);
  let turnNo = 0, markerNo = 0;
  track.buoys.forEach(b => {
    if (b.type !== 'marker') {
      turnNo += 1;
      pts.push({ name: `Turn ${turnNo} (pass ${normalizeRounding(b.rounding)})`, type: 'turn', x: b.x, y: b.y, ...ll(b.x, b.y) });
    } else {
      markerNo += 1;
      pts.push({ name: `Marker ${markerNo}`, type: 'marker', x: b.x, y: b.y, ...ll(b.x, b.y) });
    }
  });
  const gate = track.gate;
  const addGate = (seg, label) => {
    if (!seg) return;
    pts.push({ name: `${label} gate A`, type: 'gate', x: seg.x1, y: seg.y1, ...ll(seg.x1, seg.y1) });
    pts.push({ name: `${label} gate B`, type: 'gate', x: seg.x2, y: seg.y2, ...ll(seg.x2, seg.y2) });
  };
  if (gate) {
    addGate(gate.start, gate.sameStartFinish !== false ? 'Start/Finish' : 'Start');
    if (gate.sameStartFinish === false) addGate(gate.finish, 'Finish');
  }
  if (track.startPosition && Number.isFinite(track.startPosition.x)) {
    const sp = track.startPosition;
    pts.push({ name: 'Start position', type: 'start', x: sp.x, y: sp.y, ...ll(sp.x, sp.y) });
  }
  return pts;
}

const xmlEscape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

document.getElementById('btnExportGpx').addEventListener('click', () => {
  const wpts = geoWaypoints().map(p =>
    `  <wpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">\n    <name>${xmlEscape(p.name)}</name>\n  </wpt>`
  ).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="efoil.racing Track Designer" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata><name>${xmlEscape(track.name || 'Track')}</name></metadata>\n` +
    `${wpts}\n</gpx>\n`;
  downloadFile(`${trackSlug()}.gpx`, 'application/gpx+xml', gpx);
});

document.getElementById('btnExportKml').addEventListener('click', () => {
  const marks = geoWaypoints().map(p =>
    `    <Placemark>\n      <name>${xmlEscape(p.name)}</name>\n      <Point><coordinates>${p.lng.toFixed(7)},${p.lat.toFixed(7)},0</coordinates></Point>\n    </Placemark>`
  ).join('\n');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>${xmlEscape(track.name || 'Track')}</name>\n` +
    `${marks}\n  </Document>\n</kml>\n`;
  downloadFile(`${trackSlug()}.kml`, 'application/vnd.google-earth.kml+xml', kml);
});

document.getElementById('btnExportCsv').addEventListener('click', () => {
  const rows = geoWaypoints().map(p =>
    `"${p.name.replace(/"/g, '""')}",${p.type},${p.lat.toFixed(7)},${p.lng.toFixed(7)},${p.x.toFixed(1)},${p.y.toFixed(1)}`
  );
  const csv = 'name,type,lat,lng,x_m,y_m\n' + rows.join('\n') + '\n';
  downloadFile(`${trackSlug()}.csv`, 'text/csv', csv);
});

// --- Race briefing poster export (PNG) ---
// Renders the track map at high resolution with a semi-transparent briefing
// panel: title, author, nominal laptime, start technique, race notes and a
// scan-to-ride QR code. Satellite imagery is composited in when the track
// is geo-anchored.

const POSTER_SCALE = 2;          // device px per layout px
const POSTER_W = 1200;           // layout px
const POSTER_H = 848;            // ~A4 landscape ratio
const POSTER_MARGIN = 32;
const POSTER_PANEL_W = 400;      // left-column layout
const POSTER_PANEL_H = 306;      // bottom-band layout

const TITLE_FONT = 'Pacifico, "Brush Script MT", cursive';
const BODY_FONT = 'Georgia, "Times New Roman", serif';

const pacificoFace = new FontFace('Pacifico', "url('lib/fonts/pacifico.woff2')");
let pacificoPromise = null;
function ensurePacifico() {
  if (!pacificoPromise) {
    pacificoPromise = pacificoFace.load()
      .then(face => { document.fonts.add(face); })
      .catch(() => {}); // poster falls back to the generic cursive font
  }
  return pacificoPromise;
}

function esriTileUrl(z, x, y) {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

function loadTileImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('tile load failed'));
    img.src = url;
  });
}

// Composites Esri World Imagery under the track. Must run while the poster
// render target is active (uses pxToM/mToPx with the poster view).
// Returns false when tiles could not be loaded so the caller can fall back.
async function drawPosterSatellite(pctx, w, h) {
  const geo = track.geo;
  const lat0 = geo.origin.lat;

  // Smallest zoom whose imagery resolution meets the poster's device px/m
  let zoom = 19;
  for (let z = 3; z <= 19; z++) {
    if (1 / metersPerPixel(lat0, z) >= view.pxPerM * POSTER_SCALE) { zoom = z; break; }
  }

  const cornersM = [pxToM(0, 0), pxToM(w, 0), pxToM(0, h), pxToM(w, h)];
  const worldBounds = z => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    cornersM.forEach(m => {
      const ll = metersToLatLng(geo, m.x, m.y);
      const p = latLngToWorldPx(ll.lat, ll.lng, z);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });
    return { minX, minY, maxX, maxY };
  };

  let wb = worldBounds(zoom);
  const tileSpan = b =>
    (Math.floor(b.maxX / 256) - Math.floor(b.minX / 256) + 1) *
    (Math.floor(b.maxY / 256) - Math.floor(b.minY / 256) + 1);
  while (zoom > 3 && tileSpan(wb) > 150) {
    zoom -= 1;
    wb = worldBounds(zoom);
  }

  const tx0 = Math.floor(wb.minX / 256), tx1 = Math.floor(wb.maxX / 256);
  const ty0 = Math.floor(wb.minY / 256), ty1 = Math.floor(wb.maxY / 256);
  const tilesCanvas = document.createElement('canvas');
  tilesCanvas.width = (tx1 - tx0 + 1) * 256;
  tilesCanvas.height = (ty1 - ty0 + 1) * 256;
  const tctx = tilesCanvas.getContext('2d');

  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      jobs.push(
        loadTileImage(esriTileUrl(zoom, tx, ty))
          .then(img => { tctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256); return true; })
          .catch(() => false)
      );
    }
  }
  const results = await Promise.all(jobs);
  const ok = results.filter(Boolean).length;
  if (ok === 0 || ok < results.length * 0.7) return false;

  // Affine transform world px -> poster layout px, solved from three
  // reference points in track meters (handles geo rotation exactly).
  const refs = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }].map(m => {
    const c = mToPx(m.x, m.y);
    const ll = metersToLatLng(geo, m.x, m.y);
    return { c, wp: latLngToWorldPx(ll.lat, ll.lng, zoom) };
  });
  const [O, U, V] = refs;
  const du = { x: U.wp.x - O.wp.x, y: U.wp.y - O.wp.y };
  const dv = { x: V.wp.x - O.wp.x, y: V.wp.y - O.wp.y };
  const cu = { x: U.c.x - O.c.x, y: U.c.y - O.c.y };
  const cv = { x: V.c.x - O.c.x, y: V.c.y - O.c.y };
  const det = du.x * dv.y - du.y * dv.x;
  if (Math.abs(det) < 1e-12) return false;
  const a = (cu.x * dv.y - cv.x * du.y) / det;
  const c = (du.x * cv.x - dv.x * cu.x) / det;
  const b = (cu.y * dv.y - cv.y * du.y) / det;
  const d = (du.x * cv.y - dv.x * cu.y) / det;
  const e = O.c.x - (a * O.wp.x + c * O.wp.y);
  const f = O.c.y - (b * O.wp.x + d * O.wp.y);

  pctx.save();
  pctx.transform(a, b, c, d, e, f);
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(tilesCanvas, tx0 * 256, ty0 * 256);
  pctx.restore();

  // Slight darkening so the neon track colors keep their contrast
  pctx.fillStyle = 'rgba(4,10,16,0.18)';
  pctx.fillRect(0, 0, w, h);
  return true;
}

function drawPosterWater(pctx, w, h) {
  const grad = pctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#1f7ea0');
  grad.addColorStop(1, '#155f7c');
  pctx.fillStyle = grad;
  pctx.fillRect(0, 0, w, h);
}

// Word-wraps text (honoring explicit newlines) with the current pctx font.
function wrapPosterText(pctx, text, maxW) {
  const lines = [];
  String(text).split('\n').forEach(par => {
    if (par.trim() === '') { lines.push(''); return; }
    let line = '';
    par.trim().split(/\s+/).forEach(word => {
      const attempt = line ? line + ' ' + word : word;
      if (!line || pctx.measureText(attempt).width <= maxW) line = attempt;
      else { lines.push(line); line = word; }
    });
    lines.push(line);
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function briefingField(el, stored) {
  const typed = ((el && el.value) || stored || '').trim();
  if (typed) return typed;
  return ((el && el.placeholder) || '').trim();
}

function syncBriefingCopyFromSidebar() {
  if (els.trackNotes) track.notes = els.trackNotes.value;
  const st = ensureStartTechnique(track);
  st.timetrial = briefingField(els.startTimetrial, st.timetrial);
  st.elimination = briefingField(els.startElimination, st.elimination);
  st.notes = briefingField(els.startNotes, st.notes);
  return st;
}

function canEncodePosterQr(text) {
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    return true;
  } catch (err) {
    return false;
  }
}

function fmtNominalLaptime(sec) {
  return `${sec.toFixed(2)}s`;
}

function fmtLapDistance(m) {
  return `${Math.round(m)} m`;
}

function posterStatItems() {
  const t = nominalLapTimeSec(track);
  const d = nominalLapDistanceM(track);
  return [
    ['Nominal laptime', t != null ? fmtNominalLaptime(t) : '\u2014'],
    ['Lap distance', d != null ? fmtLapDistance(d) : '\u2014']
  ];
}

// Draws a heading in the script font, returns the new cursor y.
function drawPosterHeading(pctx, text, x, y, size = 21) {
  pctx.font = `${size}px ${TITLE_FONT}`;
  pctx.fillStyle = '#8fd8f5';
  pctx.textAlign = 'left';
  pctx.textBaseline = 'alphabetic';
  pctx.fillText(text, x, y + size);
  return y + size + 10;
}

// Body text with auto-shrink, then ellipsis truncation. Returns new cursor y.
function drawPosterBody(pctx, text, x, y, maxW, maxBottom) {
  const sizes = [13.5, 12.5, 11.5];
  let chosen = null;
  for (const size of sizes) {
    pctx.font = `${size}px ${BODY_FONT}`;
    const lines = wrapPosterText(pctx, text, maxW);
    const lh = size * 1.45;
    if (y + lines.length * lh <= maxBottom) { chosen = { size, lines, lh }; break; }
    chosen = { size, lines, lh }; // keep smallest; truncated below if needed
  }
  const { size, lh } = chosen;
  let { lines } = chosen;
  const maxLines = Math.max(1, Math.floor((maxBottom - y) / lh));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    let last = lines[lines.length - 1];
    pctx.font = `${size}px ${BODY_FONT}`;
    while (last && pctx.measureText(last + '\u2026').width > maxW) {
      last = last.slice(0, -1).trimEnd();
    }
    lines[lines.length - 1] = last + '\u2026';
  }
  pctx.font = `${size}px ${BODY_FONT}`;
  pctx.fillStyle = 'rgba(238,245,250,0.92)';
  pctx.textAlign = 'left';
  pctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => pctx.fillText(line, x, y + (i + 0.85) * lh));
  return y + lines.length * lh;
}

function drawPosterStats(pctx, x, y, maxW) {
  const items = posterStatItems();
  const colW = items.length === 1 ? maxW : maxW / 2;
  const rowH = 44;
  items.forEach((item, i) => {
    const cx = x + (i % 2) * colW;
    const cy = y + Math.floor(i / 2) * rowH;
    pctx.font = '10px -apple-system, Helvetica, sans-serif';
    pctx.fillStyle = 'rgba(160,190,210,0.85)';
    pctx.textAlign = 'left';
    pctx.textBaseline = 'alphabetic';
    try { pctx.letterSpacing = '1.5px'; } catch (err) { /* older canvas */ }
    pctx.fillText(item[0].toUpperCase(), cx, cy + 11);
    try { pctx.letterSpacing = '0px'; } catch (err) { /* older canvas */ }
    pctx.font = `bold 16px ${BODY_FONT}`;
    pctx.fillStyle = '#f2f7fb';
    pctx.fillText(item[1], cx, cy + 32);
  });
  return y + Math.ceil(items.length / 2) * rowH + 2;
}

function drawPosterSubhead(pctx, text, x, y) {
  pctx.font = '10px -apple-system, Helvetica, sans-serif';
  pctx.fillStyle = 'rgba(160,190,210,0.9)';
  pctx.textAlign = 'left';
  pctx.textBaseline = 'alphabetic';
  try { pctx.letterSpacing = '1.5px'; } catch (err) { /* older canvas */ }
  pctx.fillText(String(text).toUpperCase(), x, y + 11);
  try { pctx.letterSpacing = '0px'; } catch (err) { /* older canvas */ }
  return y + 16;
}

function drawPosterStartTechnique(pctx, x, y, maxW, maxBottom) {
  const st = ensureStartTechnique(track);
  const blocks = [
    ['Timetrial', (st.timetrial || '').trim()],
    ['Elimination', (st.elimination || '').trim()],
    ['Notes', (st.notes || '').trim()]
  ].filter(b => b[1]);
  if (!blocks.length) return y;
  y = drawPosterHeading(pctx, 'Start technique', x, y, 20);
  const n = blocks.length;
  blocks.forEach((block, i) => {
    const remain = maxBottom - y;
    if (remain < 22) return;
    const blockEnd = y + remain / (n - i);
    y = drawPosterSubhead(pctx, block[0], x, y + (i ? 6 : 2));
    y = drawPosterBody(pctx, block[1], x, y, maxW, Math.min(maxBottom, blockEnd));
  });
  return y;
}

// Renders the QR code with the vendored qrcode lib. Returns true on success.
function drawPosterQr(pctx, text, x, y, size) {
  let qr;
  try {
    qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
  } catch (err) {
    return false; // track too large for a QR code
  }
  const n = qr.getModuleCount();
  const quiet = 3;
  const cell = size / (n + quiet * 2);
  pctx.fillStyle = '#ffffff';
  pctx.beginPath();
  pctx.roundRect(x, y, size, size, 8);
  pctx.fill();
  pctx.fillStyle = '#0c1218';
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (!qr.isDark(r, col)) continue;
      pctx.fillRect(x + (quiet + col) * cell, y + (quiet + r) * cell, cell + 0.25, cell + 0.25);
    }
  }
  return true;
}

function drawPosterTitle(pctx, x, y, maxW) {
  const name = track.name || 'Untitled Track';

  pctx.font = '11px -apple-system, Helvetica, sans-serif';
  pctx.fillStyle = 'rgba(143,216,245,0.9)';
  pctx.textAlign = 'left';
  pctx.textBaseline = 'alphabetic';
  try { pctx.letterSpacing = '4px'; } catch (err) { /* older canvas */ }
  pctx.fillText('RACE BRIEFING', x, y + 11);
  try { pctx.letterSpacing = '0px'; } catch (err) { /* older canvas */ }
  y += 24;

  let size = 40;
  pctx.font = `${size}px ${TITLE_FONT}`;
  while (size > 22 && pctx.measureText(name).width > maxW) {
    size -= 2;
    pctx.font = `${size}px ${TITLE_FONT}`;
  }
  const titleLines = wrapPosterText(pctx, name, maxW).slice(0, 2);
  pctx.fillStyle = '#ffffff';
  // Pacifico has deep descenders/swashes: give the lines generous height
  titleLines.forEach((line, i) => pctx.fillText(line, x, y + (i + 1) * size * 1.3));
  y += titleLines.length * size * 1.3 + size * 0.4;

  const byline = [];
  if (track.author && track.author.trim()) byline.push(`designed by ${track.author.trim()}`);
  byline.push(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
  pctx.font = `italic 13px ${BODY_FONT}`;
  pctx.fillStyle = 'rgba(180,205,222,0.9)';
  pctx.fillText(byline.join('  \u00B7  '), x, y + 10);
  y += 24;

  pctx.strokeStyle = 'rgba(255,255,255,0.18)';
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(x, y + 6);
  pctx.lineTo(x + maxW, y + 6);
  pctx.stroke();
  return y + 18;
}

function drawPosterPanel(pctx, panel, shareUrl) {
  const pad = 28;

  // Contrast vignette bleeding out from the panel side
  const wide = panel.w > panel.h;
  const grad = wide
    ? pctx.createLinearGradient(0, POSTER_H, 0, panel.y - 170)
    : pctx.createLinearGradient(0, 0, panel.x + panel.w + 190, 0);
  grad.addColorStop(0, 'rgba(5,10,15,0.55)');
  grad.addColorStop(1, 'rgba(5,10,15,0)');
  pctx.fillStyle = grad;
  pctx.fillRect(0, 0, POSTER_W, POSTER_H);

  // Panel chrome
  pctx.fillStyle = 'rgba(9,15,21,0.66)';
  pctx.strokeStyle = 'rgba(255,255,255,0.20)';
  pctx.lineWidth = 1.5;
  pctx.beginPath();
  pctx.roundRect(panel.x, panel.y, panel.w, panel.h, 18);
  pctx.fill();
  pctx.stroke();

  const notesText = (track.notes || '').trim();
  const qrOk = canEncodePosterQr(shareUrl);

  if (!wide) {
    // Left column: start technique first, then race notes; footer pinned to the bottom
    const x = panel.x + pad;
    const maxW = panel.w - pad * 2;
    let y = drawPosterTitle(pctx, x, panel.y + pad, maxW);
    y = drawPosterStats(pctx, x, y, maxW);

    const qrSize = 96;
    const footerH = qrOk ? qrSize : 22;
    const contentBottom = panel.y + panel.h - pad - footerH - 8;
    const afterStats = y + 8;
    const room = Math.max(0, contentBottom - afterStats);
    const startBottom = notesText ? afterStats + Math.max(room * 0.58, room - 130) : contentBottom;

    y = drawPosterStartTechnique(pctx, x, afterStats, maxW, startBottom);
    if (notesText) {
      y = drawPosterHeading(pctx, 'Race notes', x, y + 8, 20);
      drawPosterBody(pctx, notesText, x, y, maxW, contentBottom);
    }

    const qrTop = panel.y + panel.h - pad - footerH;
    pctx.textAlign = 'left';
    pctx.textBaseline = 'alphabetic';
    if (qrOk && drawPosterQr(pctx, shareUrl, x, qrTop, qrSize)) {
      pctx.font = `16px ${TITLE_FONT}`;
      pctx.fillStyle = '#8fd8f5';
      pctx.fillText('Scan to ride this track', x + qrSize + 16, qrTop + 38);
      pctx.font = `italic 12px ${BODY_FONT}`;
      pctx.fillStyle = 'rgba(180,205,222,0.85)';
      pctx.fillText('efoil.racing track designer', x + qrSize + 16, qrTop + 60);
    } else {
      pctx.font = `18px ${TITLE_FONT}`;
      pctx.fillStyle = '#8fd8f5';
      pctx.fillText('Design & ride at efoil.racing', x, qrTop + footerH - 4);
    }
    return;
  }

  // Bottom band: three columns — title/stats, start technique + notes, QR
  const x1 = panel.x + pad;
  const col1W = 330;
  const qrSize = 128;
  const x3 = panel.x + panel.w - pad - qrSize;
  const x2 = x1 + col1W + 30;
  const col2W = x3 - 26 - x2;
  const bottom = panel.y + panel.h - pad;

  let y1 = drawPosterTitle(pctx, x1, panel.y + pad, col1W);
  drawPosterStats(pctx, x1, y1, col1W);

  let y2 = panel.y + pad;
  const col2Room = bottom - y2;
  const startBottom = notesText ? y2 + Math.max(col2Room * 0.58, col2Room - 90) : bottom;
  y2 = drawPosterStartTechnique(pctx, x2, y2, col2W, startBottom);
  if (notesText) {
    y2 = drawPosterHeading(pctx, 'Race notes', x2, y2 + 8, 20);
    drawPosterBody(pctx, notesText, x2, y2, col2W, bottom);
  }

  const qrY = panel.y + pad + 6;
  const hasQr = qrOk && drawPosterQr(pctx, shareUrl, x3, qrY, qrSize);
  pctx.textAlign = 'center';
  pctx.textBaseline = 'alphabetic';
  if (hasQr) {
    pctx.font = `15px ${TITLE_FONT}`;
    pctx.fillStyle = '#8fd8f5';
    pctx.fillText('Scan to ride', x3 + qrSize / 2, qrY + qrSize + 28);
    pctx.font = `italic 11px ${BODY_FONT}`;
    pctx.fillStyle = 'rgba(180,205,222,0.85)';
    pctx.fillText('efoil.racing', x3 + qrSize / 2, qrY + qrSize + 46);
  } else {
    pctx.font = `16px ${TITLE_FONT}`;
    pctx.fillStyle = '#8fd8f5';
    pctx.fillText('efoil.racing', x3 + qrSize / 2, qrY + qrSize / 2);
  }
  pctx.textAlign = 'left';
}

async function renderBriefingPoster() {
  syncBriefingCopyFromSidebar();
  saveDraft(track);
  await ensurePacifico();

  const W = POSTER_W, H = POSTER_H, M = POSTER_MARGIN;
  const bbox = trackBBox(track);
  const wide = bbox ? bbox.w / Math.max(bbox.h, 1) >= 1.4 : false;

  const panel = wide
    ? { x: M, y: H - M - POSTER_PANEL_H, w: W - 2 * M, h: POSTER_PANEL_H }
    : { x: M, y: M, w: POSTER_PANEL_W, h: H - 2 * M };
  const free = wide
    ? { x: 0, y: 0, w: W, h: panel.y }
    : { x: panel.x + panel.w, y: 0, w: W - (panel.x + panel.w), h: H };

  const cnv = document.createElement('canvas');
  cnv.width = W * POSTER_SCALE;
  cnv.height = H * POSTER_SCALE;
  const pctx = cnv.getContext('2d');
  pctx.setTransform(POSTER_SCALE, 0, 0, POSTER_SCALE, 0, 0);

  // Fit the track into the free (non-panel) region
  const pad = 1.3;
  const spanX = Math.max(bbox ? bbox.w : 100, 40) * pad;
  const spanY = Math.max(bbox ? bbox.h : 100, 40) * pad;
  const pxPerM = Math.min(free.w / spanX, free.h / spanY);
  const bcx = bbox ? (bbox.minX + bbox.maxX) / 2 : 0;
  const bcy = bbox ? (bbox.minY + bbox.maxY) / 2 : 0;
  const pview = {
    pxPerM,
    cx: bcx - (free.x + free.w / 2 - W / 2) / pxPerM,
    cy: bcy - (H / 2 - (free.y + free.h / 2)) / pxPerM
  };

  // Swap the module render target so the existing draw helpers hit the poster
  const prevCtx = ctx, prevView = view, prevSelection = selection;
  ctx = pctx; view = pview; selection = null;
  poster = { ctx: pctx, w: W, h: H };
  let satellite = false;
  try {
    if (hasGeo(track)) {
      satellite = await drawPosterSatellite(pctx, W, H);
    }
    if (!satellite) {
      drawPosterWater(pctx, W, H);
      drawGrid(W, H);
    }
    drawSequenceLine();
    drawRacingLines();
    drawGates();
    drawStartPos();
    drawBuoys();
    drawScaleBar(W, H);
  } finally {
    ctx = prevCtx; view = prevView; selection = prevSelection;
    poster = null;
  }

  const shareUrl = new URL('index.html', window.location.href);
  shareUrl.search = '?data=' + encodeTrackForUrl(track);
  drawPosterPanel(pctx, panel, shareUrl.toString());

  if (satellite) {
    pctx.font = '9px -apple-system, Helvetica, sans-serif';
    pctx.fillStyle = 'rgba(255,255,255,0.7)';
    pctx.textAlign = 'right';
    pctx.textBaseline = 'alphabetic';
    pctx.fillText('Imagery \u00A9 Esri \u2014 Esri, Maxar, Earthstar Geographics', W - 8, H - 7);
    pctx.textAlign = 'left';
  }
  return cnv;
}

const briefingModal = document.getElementById('briefingModal');
const briefingPreview = document.getElementById('briefingPreview');
let briefingBlobUrl = null;

function closeBriefingModal() {
  briefingModal.classList.remove('open');
  briefingPreview.removeAttribute('src');
  if (briefingBlobUrl) {
    URL.revokeObjectURL(briefingBlobUrl);
    briefingBlobUrl = null;
  }
}

document.getElementById('btnBriefing').addEventListener('click', async () => {
  const { errors } = validateTrack(track);
  if (errors.length) {
    alert('Fix these before exporting the briefing:\n' + errors.join('\n'));
    return;
  }
  const btn = document.getElementById('btnBriefing');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Rendering\u2026';
  try {
    const cnv = await renderBriefingPoster();
    const blob = await new Promise(resolve => cnv.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed');
    if (briefingBlobUrl) URL.revokeObjectURL(briefingBlobUrl);
    briefingBlobUrl = URL.createObjectURL(blob);
    briefingPreview.src = briefingBlobUrl;
    briefingModal.classList.add('open');
  } catch (err) {
    alert('Briefing export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

document.getElementById('briefingDownload').addEventListener('click', () => {
  if (!briefingBlobUrl) return;
  const link = document.createElement('a');
  link.href = briefingBlobUrl;
  link.download = `${trackSlug()}-briefing.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

document.getElementById('briefingClose').addEventListener('click', closeBriefingModal);
briefingModal.addEventListener('click', e => {
  if (e.target === briefingModal) closeBriefingModal();
});

// --- Topbar actions ---
document.getElementById('btnFit').addEventListener('click', fitView);
document.getElementById('btnUndo').addEventListener('click', undo);

// --- Track Presets menu ---
const presetsMenuWrap = document.getElementById('presetsMenuWrap');
const presetsMenu = document.getElementById('presetsMenu');
const btnPresets = document.getElementById('btnPresets');

function closePresetsMenu() {
  presetsMenuWrap.classList.remove('open');
}

const ACTIVE_SAVED_KEY = 'efoil_active_saved_track_id';
let activeSavedTrackId = localStorage.getItem(ACTIVE_SAVED_KEY) || null;
let savedTrackFingerprint = null;

function trackFingerprint(t) {
  try {
    return JSON.stringify(serializeTrack(t));
  } catch (e) {
    return '';
  }
}

function setActiveSavedTrack(id, snapshotTrack) {
  activeSavedTrackId = id || null;
  if (activeSavedTrackId) localStorage.setItem(ACTIVE_SAVED_KEY, activeSavedTrackId);
  else localStorage.removeItem(ACTIVE_SAVED_KEY);
  const src = snapshotTrack || (id && getTrackPresetById(id)?.track) || null;
  savedTrackFingerprint = src ? trackFingerprint(src) : null;
}

function clearActiveSavedTrack() {
  setActiveSavedTrack(null, null);
}

function isActiveSavedDirty() {
  if (!activeSavedTrackId || !savedTrackFingerprint) return false;
  return trackFingerprint(track) !== savedTrackFingerprint;
}

if (activeSavedTrackId && !getTrackPresetById(activeSavedTrackId)) {
  clearActiveSavedTrack();
} else if (activeSavedTrackId) {
  const entry = getTrackPresetById(activeSavedTrackId);
  if (entry?.track) savedTrackFingerprint = trackFingerprint(entry.track);
}

const COUNTRY_CACHE_KEY = 'efoil_country_cache_v1';
const UNPLACED_COUNTRY = { code: '', name: 'No location', sort: '\uffff' };
let nominatimAt = 0;

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function loadCountryCache() {
  try {
    const raw = localStorage.getItem(COUNTRY_CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}

function saveCountryCache(cache) {
  localStorage.setItem(COUNTRY_CACHE_KEY, JSON.stringify(cache));
}

function geoCacheKey(lat, lng) {
  return 'geo:' + Number(lat).toFixed(3) + ',' + Number(lng).toFixed(3);
}

function nameCacheKey(q) {
  return 'name:' + String(q || '').trim().toLowerCase();
}

function placeQueryFromName(name) {
  const n = (name || '').trim();
  if (!n) return null;
  const dash = n.lastIndexOf(' - ');
  if (dash >= 0) {
    const tail = n.slice(dash + 3).trim();
    if (tail.length >= 3) return tail;
  }
  if (/^(official speedtrack|my preset|untitled|saved preset)$/i.test(n)) return null;
  return n;
}

function countryFromNominatim(data) {
  const item = Array.isArray(data) ? data[0] : data;
  const a = item?.address;
  const code = String(a?.country_code || '').toUpperCase();
  const name = String(a?.country || '').trim();
  if (!code) return null;
  const out = { countryCode: code, countryName: name || code };
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    out.lat = lat;
    out.lng = lon;
  }
  return out;
}

async function nominatimJson(url) {
  const wait = Math.max(0, 1100 - (Date.now() - nominatimAt));
  if (wait) await new Promise(r => setTimeout(r, wait));
  nominatimAt = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error('Nominatim ' + res.status);
  return res.json();
}

async function lookupCountry(place, name) {
  const cache = loadCountryCache();
  if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
    const ck = geoCacheKey(place.lat, place.lng);
    if (cache[ck]) return cache[ck];
    try {
      const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1' +
        `&accept-language=en&zoom=6&lat=${encodeURIComponent(place.lat)}&lon=${encodeURIComponent(place.lng)}`;
      const found = countryFromNominatim(await nominatimJson(url));
      if (found) {
        cache[ck] = found;
        saveCountryCache(cache);
        return found;
      }
    } catch (e) { /* fall through to name lookup */ }
  }
  const q = placeQueryFromName(name);
  if (!q) return null;
  const nk = nameCacheKey(q);
  if (cache[nk]) return cache[nk];
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1' +
      `&accept-language=en&q=${encodeURIComponent(q)}`;
    const found = countryFromNominatim(await nominatimJson(url));
    if (found) {
      cache[nk] = found;
      saveCountryCache(cache);
      return found;
    }
  } catch (e) { /* leave unplaced */ }
  return null;
}

function collectPresetMenuItems() {
  const items = [];
  BUILTIN_TRACK_PRESETS.forEach(p => {
    items.push({
      id: p.id,
      name: p.name,
      builtin: true,
      kind: 'preset',
      meta: p.meta || '',
      place: p.place || null,
      canDelete: false
    });
  });
  loadUserTrackPresets().forEach(p => {
    items.push({
      id: p.id,
      name: p.name || 'Untitled',
      builtin: false,
      kind: p.kind || 'track',
      meta: p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '',
      place: p.place || placeFromTrack(p.track),
      canDelete: true
    });
  });
  return items;
}

function countryGroupForItem(item) {
  const code = String(item.place?.countryCode || '').toUpperCase();
  const name = String(item.place?.countryName || '').trim();
  if (!code) return UNPLACED_COUNTRY;
  return { code, name: name || code, sort: (name || code).toLocaleUpperCase('en') };
}

function menuItemButton(p) {
  const selected = !p.builtin && p.id === activeSavedTrackId;
  const dirty = selected && isActiveSavedDirty();
  const row =
    `<button type="button" class="menu-item${p.kind === 'track' ? ' under-country' : ''}${selected ? ' selected' : ''}" data-apply="${escHtml(p.id)}">` +
    (selected ? '<span class="check" title="Current track">✓</span>' : '') +
    `<span>${escHtml(p.name)}${dirty ? ' •' : ''}</span>` +
    (p.meta ? `<span class="meta">${escHtml(p.meta)}</span>` : '') +
    (p.canDelete
      ? `<span class="del" data-del="${escHtml(p.id)}" title="Delete saved track">✕</span>`
      : '') +
    `</button>`;
  if (!selected) return row;
  return (
    `<div class="menu-track">` + row +
    `<div class="menu-track-actions">` +
    `<button type="button" data-track-action="overwrite" ${dirty ? '' : 'disabled'}>Save changes</button>` +
    `<button type="button" data-track-action="save-as">Save as…</button>` +
    `<button type="button" data-track-action="revert" ${dirty ? '' : 'disabled'}>Revert</button>` +
    `</div></div>`
  );
}

function countryGroupsHtml(items) {
  const groups = new Map();
  items.forEach(item => {
    const g = countryGroupForItem(item);
    const key = g.code || '__none__';
    if (!groups.has(key)) groups.set(key, { ...g, items: [] });
    groups.get(key).items.push(item);
  });

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.code === '' && b.code !== '') return 1;
    if (b.code === '' && a.code !== '') return -1;
    return a.sort.localeCompare(b.sort, 'en');
  });
  ordered.forEach(g => {
    g.items.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  });

  const parts = [];
  ordered.forEach(g => {
    const flag = countryFlagEmoji(g.code);
    parts.push(
      `<div class="menu-country">${escHtml(g.name)}` +
      (flag ? ` <span class="flag">${flag}</span>` : '') +
      `</div>`
    );
    g.items.forEach(p => parts.push(menuItemButton(p)));
  });
  return parts;
}

function renderPresetsMenu(items) {
  const saved = items.filter(i => i.kind !== 'preset');
  const presets = items.filter(i => i.kind === 'preset');
  const parts = [];

  parts.push('<div class="menu-label">Saved tracks</div>');
  if (!saved.length) {
    parts.push('<button type="button" class="menu-item" disabled><span style="color:var(--muted)">None yet — save a track to reopen it here</span></button>');
  } else {
    parts.push(...countryGroupsHtml(saved));
  }

  parts.push('<div class="menu-sep"></div>');
  parts.push('<div class="menu-label">Presets</div>');
  presets.forEach(p => parts.push(menuItemButton(p)));

  parts.push('<div class="menu-sep"></div>');
  parts.push('<div class="menu-actions">');
  parts.push('<button type="button" class="menu-item" data-action="save">Save current track…</button>');
  parts.push('<button type="button" class="menu-item" data-action="export">Export JSON backup\u2026</button>');
  parts.push('</div>');
  presetsMenu.innerHTML = parts.join('');
}

async function resolvePresetCountries(items) {
  let changed = false;
  for (const item of items) {
    if (item.kind === 'preset') continue;
    if (item.place?.countryCode && Number.isFinite(item.place.lat)) continue;
    const found = await lookupCountry(item.place, item.name);
    if (!found) continue;
    const prev = item.place || {};
    item.place = {
      ...found,
      ...prev,
      countryCode: found.countryCode,
      countryName: found.countryName,
      lat: Number.isFinite(prev.lat) ? prev.lat : found.lat,
      lng: Number.isFinite(prev.lng) ? prev.lng : found.lng
    };
    patchUserTrackPreset(item.id, { place: item.place });
    changed = true;
  }
  return changed;
}

function applyTrackFromMenu(nextTrack, { mode } = {}) {
  pushUndo();
  const currentGeo = hasGeo(track) ? { ...track.geo, origin: { ...track.geo.origin } } : null;
  track = withDefaults(nextTrack);
  if (mode === 'template') {
    if (currentGeo) track.geo = currentGeo;
    else if (track.geo) delete track.geo;
  }
  selection = null;
  if (hasGeo(track)) {
    if (!geoOn) setGeoOn(true);
    else {
      ensureMap();
      map.invalidateSize({ animate: false });
    }
  } else if (geoOn) {
    setGeoOn(false);
  }
  fitView();
  commit();
}

function refreshPresetsMenu() {
  const items = collectPresetMenuItems();
  renderPresetsMenu(items);
  resolvePresetCountries(items).then(changed => {
    if (changed && presetsMenuWrap.classList.contains('open')) {
      renderPresetsMenu(collectPresetMenuItems());
    }
  });
}

btnPresets.addEventListener('click', e => {
  e.stopPropagation();
  const willOpen = !presetsMenuWrap.classList.contains('open');
  if (willOpen) refreshPresetsMenu();
  presetsMenuWrap.classList.toggle('open', willOpen);
});

presetsMenu.addEventListener('click', async e => {
  e.stopPropagation();

  const trackAct = e.target.closest('[data-track-action]');
  if (trackAct) {
    e.preventDefault();
    const act = trackAct.getAttribute('data-track-action');
    if (act === 'overwrite') {
      if (!activeSavedTrackId) return;
      replaceUserTrackPreset(activeSavedTrackId, track, track.name);
      setActiveSavedTrack(activeSavedTrackId, track);
      refreshPresetsMenu();
      return;
    }
    if (act === 'save-as') {
      const name = prompt('Save as new track:', track.name || 'My track');
      if (name == null) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      track.name = trimmed;
      const created = saveUserTrackPreset(track, trimmed);
      commit();
      setActiveSavedTrack(created.id, track);
      refreshPresetsMenu();
      return;
    }
    if (act === 'revert') {
      if (!activeSavedTrackId) return;
      const entry = getTrackPresetById(activeSavedTrackId);
      if (!entry?.track) return;
      if (!confirm(`Revert “${entry.name}” to the last saved version? Unsaved edits will be lost.`)) return;
      const geo = geoFromSavedEntry(entry);
      const next = withDefaults(JSON.parse(JSON.stringify(entry.track)));
      if (geo) next.geo = geo;
      applyTrackFromMenu(next, { mode: 'saved' });
      setActiveSavedTrack(activeSavedTrackId, track);
      refreshPresetsMenu();
      return;
    }
    return;
  }

  const del = e.target.closest('[data-del]');
  if (del) {
    e.preventDefault();
    const id = del.getAttribute('data-del');
    const preset = loadUserTrackPresets().find(p => p.id === id);
    if (!preset) return;
    if (!confirm(`Delete saved track “${preset.name}”?`)) return;
    deleteUserTrackPreset(id);
    if (id === activeSavedTrackId) clearActiveSavedTrack();
    refreshPresetsMenu();
    return;
  }

  const applyBtn = e.target.closest('[data-apply]');
  if (applyBtn) {
    const id = applyBtn.getAttribute('data-apply');
    const entry = getTrackPresetById(id);
    if (!entry?.track) return;
    const isPreset = entry.kind === 'preset' || entry.builtin;
    if (isPreset) {
      const msg = hasGeo(track)
        ? `Apply “${entry.name}” here, keeping the current map location?`
        : `Replace the current track with “${entry.name}”?`;
      if (!confirm(msg)) return;
      const next = withDefaults(JSON.parse(JSON.stringify(entry.track)));
      applyTrackFromMenu(next, { mode: 'template' });
    } else {
      if (id === activeSavedTrackId) return;
      let geo = geoFromSavedEntry(entry);
      const canFind = !!(geo || placeQueryFromName(entry.name));
      const msg = canFind
        ? `Open “${entry.name}”? The map will move to that venue.`
        : `Open “${entry.name}”? This save has no map location.`;
      if (!confirm(msg)) return;
      let reconstructed = false;
      if (!geo) {
        const found = await lookupCountry(entry.place, entry.name);
        if (found && Number.isFinite(found.lat) && Number.isFinite(found.lng)) {
          geo = {
            origin: { lat: found.lat, lng: found.lng },
            rotationDeg: Number(found.rotationDeg) || 0
          };
          reconstructed = true;
          patchUserTrackPreset(entry.id, { place: { ...(entry.place || {}), ...found } });
        }
      }
      const next = withDefaults(JSON.parse(JSON.stringify(entry.track)));
      if (geo) next.geo = geo;
      applyTrackFromMenu(next, { mode: 'saved' });
      if (geo && reconstructed) {
        anchorTrackAt(geo.origin.lat, geo.origin.lng);
        commit();
      }
      setActiveSavedTrack(id, track);
    }
    closePresetsMenu();
    return;
  }

  const actionBtn = e.target.closest('[data-action]');
  if (!actionBtn) return;
  const action = actionBtn.getAttribute('data-action');
  if (action === 'save') {
    const name = prompt('Name for this saved track:', track.name || 'My track');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    track.name = trimmed;
    const created = saveUserTrackPreset(track, trimmed);
    commit();
    setActiveSavedTrack(created.id, track);
    refreshPresetsMenu();
    const where = hasGeo(track) ? ' (with map location)' : ' (no map location yet)';
    alert(`Saved “${trimmed}” to Tracks${where}.`);
  } else if (action === 'export') {
    closePresetsMenu();
    openExportModal();
  }
});

document.addEventListener('click', e => {
  if (!presetsMenuWrap.contains(e.target)) closePresetsMenu();
});

document.getElementById('btnNew').addEventListener('click', () => {
  if (!confirm('Start a new track? The current draft will be replaced.')) return;
  pushUndo();
  track = withDefaults(createDefaultTrack());
  selection = null;
  if (geoOn) setGeoOn(false);
  clearActiveSavedTrack();
  fitView();
  commit();
});

function trackSlug() {
  return (track.name || 'track').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track';
}

function downloadFile(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const exportModal = document.getElementById('exportModal');
const exportCountryWrap = document.getElementById('exportCountryWrap');
const exportCountrySel = document.getElementById('exportCountry');

function closeExportModal() {
  exportModal.classList.remove('open');
}

function exportScope() {
  return document.querySelector('input[name="exportScope"]:checked')?.value || 'current';
}

function refreshExportModal() {
  const saved = loadUserTrackPresets();
  const countries = groupPresetsByCountry(saved).filter(g => g.code);
  const countryLabel = document.getElementById('exportCountryChoice');
  const allLabel = document.getElementById('exportAllChoice');
  countryLabel.classList.toggle('is-disabled', !countries.length);
  allLabel.classList.toggle('is-disabled', !saved.length);
  document.querySelector('input[name="exportScope"][value="country"]').disabled = !countries.length;
  document.querySelector('input[name="exportScope"][value="all"]').disabled = !saved.length;

  exportCountrySel.innerHTML = countries.map(g => {
    const flag = countryFlagEmoji(g.code);
    const n = g.presets.length;
    const label = `${flag ? flag + ' ' : ''}${g.name} (${n})`;
    return `<option value="${escHtml(g.code)}">${escHtml(label)}</option>`;
  }).join('');

  const scope = exportScope();
  if ((scope === 'country' && !countries.length) || (scope === 'all' && !saved.length)) {
    document.querySelector('input[name="exportScope"][value="current"]').checked = true;
  }
  exportCountryWrap.classList.toggle('show', exportScope() === 'country' && countries.length);
}

function openExportModal() {
  refreshExportModal();
  exportModal.classList.add('open');
}

function downloadExport() {
  const scope = exportScope();
  if (scope === 'current') {
    const json = JSON.stringify(serializeTrack(track), null, 2);
    downloadFile(`${trackSlug() || 'track'}.track.json`, 'application/json', json);
    closeExportModal();
    return;
  }
  const saved = loadUserTrackPresets();
  let presets = saved;
  let slug = 'all';
  if (scope === 'country') {
    const code = exportCountrySel.value;
    const group = groupPresetsByCountry(saved).find(g => g.code === code);
    presets = group ? group.presets : [];
    slug = (group?.name || code || 'country').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'country';
  }
  if (!presets.length) {
    alert('No saved tracks to export for that choice.');
    return;
  }
  const json = JSON.stringify(exportTrackLibrary(presets), null, 2);
  downloadFile(`efoil-tracks-${slug}.json`, 'application/json', json);
  closeExportModal();
}

document.getElementById('btnExport').addEventListener('click', openExportModal);
document.getElementById('exportDownload').addEventListener('click', downloadExport);
document.getElementById('exportClose').addEventListener('click', closeExportModal);
exportModal.addEventListener('click', e => {
  if (e.target === exportModal) closeExportModal();
});
document.querySelectorAll('input[name="exportScope"]').forEach(radio => {
  radio.addEventListener('change', refreshExportModal);
});
exportCountrySel.addEventListener('click', e => e.stopPropagation());
exportCountrySel.addEventListener('mousedown', e => e.stopPropagation());

document.getElementById('btnImport').addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const imported = parseTrackImport(parsed);
    if (imported.errors.length) {
      alert('Could not import:\n' + imported.errors.join('\n'));
      return;
    }
    if (imported.type === 'library') {
      const result = mergeImportedTrackPresets(imported.entries);
      refreshPresetsMenu();
      if (!result.imported) {
        alert(result.skipped
          ? 'Nothing new to import — those tracks are already in Saved tracks.'
          : 'No valid tracks found in this file.');
        return;
      }
      const extra = result.skipped ? `\n${result.skipped} already saved and skipped.` : '';
      alert(`Imported ${result.imported} track${result.imported === 1 ? '' : 's'} into Saved tracks.${extra}`);
      return;
    }
    const { errors } = validateTrack(imported.track);
    if (errors.length) {
      alert('Could not import track:\n' + errors.join('\n'));
      return;
    }
    pushUndo();
    track = withDefaults(imported.track);
    selection = null;
    if (hasGeo(track) !== geoOn) setGeoOn(hasGeo(track));
    clearActiveSavedTrack();
    fitView();
    commit();
  } catch (err) {
    alert('Failed to read file: ' + err.message);
  }
});

document.getElementById('btnAddLine').addEventListener('click', () => {
  pushUndo();
  const i = track.racingLines.length;
  track.racingLines.push({
    id: newRacingLineId(),
    name: defaultRacingLineName(i),
    color: RACING_LINE_COLORS[i % RACING_LINE_COLORS.length],
    visible: true,
    points: [],
    chase: track.racingLines.every(l => !l.chase)
  });
  commit();
});

document.getElementById('btnTestRide').addEventListener('click', () => {
  const { errors } = validateTrack(track);
  if (errors.length) {
    alert('Fix these before riding:\n' + errors.join('\n'));
    return;
  }
  saveDraft(track);
  window.location.href = 'index.html?track=draft';
});

document.getElementById('btnShare').addEventListener('click', () => {
  const { errors } = validateTrack(track);
  if (errors.length) {
    alert('Fix these before sharing:\n' + errors.join('\n'));
    return;
  }
  saveDraft(track);
  const param = encodeTrackForUrl(track);
  const url = new URL('index.html', window.location.href);
  url.search = '?data=' + param;
  els.shareUrl.value = url.toString();
  els.qrContainer.innerHTML = '';
  try {
    const qr = qrcode(0, 'L');
    qr.addData(url.toString());
    qr.make();
    els.qrContainer.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
  } catch (err) {
    els.qrContainer.innerHTML = '<div style="color:#333; padding:20px; font-size:12px;">Track too large for a QR code — use the link instead.</div>';
  }
  els.shareModal.classList.add('open');
});

document.getElementById('btnCopyUrl').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.shareUrl.value);
    document.getElementById('btnCopyUrl').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('btnCopyUrl').textContent = 'Copy'; }, 1500);
  } catch (err) {
    els.shareUrl.select();
    document.execCommand('copy');
  }
});
document.getElementById('shareClose').addEventListener('click', () => els.shareModal.classList.remove('open'));
els.shareModal.addEventListener('click', e => {
  if (e.target === els.shareModal) els.shareModal.classList.remove('open');
});

// --- Init ---
track = loadInitialTrack();
setMode('select');
resizeCanvas();
fitView();
if (hasGeo(track)) setGeoOn(true);
if (absorbLineCapture()) {
  // Racing line returned from simulator record mode
}
refreshUI();
draw();
