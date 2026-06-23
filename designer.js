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
  LINE_CAPTURE_KEY, LINE_RECORD_META_KEY,
  RACING_LINE_COLORS, newRacingLineId, defaultRacingLineName,
  buildRacingLineFromGhost
} from './trackSchema.js';

// --- DOM ---
const canvas = document.getElementById('designCanvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvasWrap');

const els = {
  trackName: document.getElementById('trackName'),
  trackAuthor: document.getElementById('trackAuthor'),
  trackNotes: document.getElementById('trackNotes'),
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
let drag = null;
let undoStack = [];
let geoOn = false;
let map = null; // Leaflet map, created lazily
let rotationUndoPushed = false;

const BUOY_HIT_PX = 14;
const HANDLE_HIT_PX = 10;

// --- Coordinate transforms (CSS pixels <-> track meters) ---
function cssSize() {
  return { w: canvas.clientWidth, h: canvas.clientHeight };
}
function geoActive() {
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
  (t.buoys || []).forEach(b => {
    if (b.type !== 'marker') b.type = 'turn';
    if (b.type === 'turn' && !b.rounding) b.rounding = 'port';
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
  const turns = turnBuoys();
  if (turns.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(124,252,0,0.75)';
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

  const lineGreen = 'rgba(124,252,0,0.95)';
  ctx.fillStyle = lineGreen;
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
    // Offset label perpendicular to the segment so it clears the arrowhead
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
  track.buoys.forEach((b, i) => {
    const p = mToPx(b.x, b.y);
    const isTurn = b.type !== 'marker';
    if (isTurn) turnNo += 1;
    const r = isTurn ? 10 : 5;

    // Rounding direction arc
    if (isTurn && b.rounding) {
      drawRoundingArrow(p.x, p.y, r + 8, b.rounding === 'starboard');
    }

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

    if (selection && selection.kind === 'buoy' && selection.index === i) {
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

// Visual rounding hint: port = counterclockwise on screen, starboard = clockwise.
function drawRoundingArrow(x, y, r, clockwise) {
  const startA = -Math.PI / 2;
  const sweep = Math.PI * 1.5;
  const endA = clockwise ? startA + sweep : startA - sweep;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, startA, endA, !clockwise);
  ctx.stroke();
  // Arrowhead at arc end, tangent direction
  const tx = clockwise ? -Math.sin(endA) : Math.sin(endA);
  const ty = clockwise ? Math.cos(endA) : -Math.cos(endA);
  const px = x + r * Math.cos(endA);
  const py = y + r * Math.sin(endA);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  drawArrowhead(px, py, Math.atan2(-ty, -tx), 6);
  ctx.restore();
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

  // Endpoint handles
  [p1, p2].forEach(p => {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#FF4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(p.x - 4, p.y - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  });

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
        selection = hit;
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
          ? { x: snap(m.x), y: snap(m.y), type: 'turn', rounding: 'port', apexRadius: 40, optimalSpeed: 30 }
          : { x: snap(m.x), y: snap(m.y), type: 'marker', apexRadius: 40 };
        track.buoys.push(buoy);
        selection = { kind: 'buoy', index: track.buoys.length - 1 };
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
  Object.entries(modeButtons).forEach(([key, btn]) => btn.classList.toggle('active', key === m));
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
    case 'f': case 'F': fitView(); break;
    case 'Escape':
      setMode('select');
      els.shareModal.classList.remove('open');
      break;
    case 'Delete': case 'Backspace':
      if (selection && selection.kind === 'buoy') {
        e.preventDefault();
        deleteSelectedBuoy();
      }
      break;
  }
});

// --- Buoy operations ---
function deleteSelectedBuoy() {
  if (!selection || selection.kind !== 'buoy') return;
  pushUndo();
  track.buoys.splice(selection.index, 1);
  selection = null;
  commit();
}

function moveBuoy(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= track.buoys.length) return;
  pushUndo();
  const [b] = track.buoys.splice(index, 1);
  track.buoys.splice(target, 0, b);
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
    chase.className = 'mini';
    chase.textContent = line.chase ? '\u2605' : '\u2606';
    chase.title = line.chase ? 'Default chase ghost' : 'Set as chase ghost';
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
  let turnNo = 0;
  track.buoys.forEach((b, i) => {
    const isTurn = b.type !== 'marker';
    if (isTurn) turnNo += 1;
    const item = document.createElement('div');
    item.className = 'buoyItem' + (selection?.kind === 'buoy' && selection.index === i ? ' selected' : '');

    const tag = document.createElement('span');
    tag.className = 'tag ' + (isTurn ? 'turn' : 'marker');
    tag.textContent = isTurn ? String(turnNo) : 'M';
    item.appendChild(tag);

    const coords = document.createElement('span');
    coords.className = 'coords';
    let distHint = '';
    if (isTurn && hasGeo(track)) {
      const turns = track.buoys.filter(bb => bb.type !== 'marker');
      const tIdx = turns.indexOf(b);
      if (tIdx > 0) {
        const prev = turns[tIdx - 1];
        const gnd = groundDistanceMeters(track.geo, prev.x, prev.y, b.x, b.y);
        distHint = ` · ${gnd.toFixed(0)} m from prev`;
      }
    }
    coords.textContent = `${b.x.toFixed(0)}, ${b.y.toFixed(0)} m` +
      (isTurn && b.rounding ? ` · ${b.rounding}` : '') + distHint;
    item.appendChild(coords);

    const up = document.createElement('button');
    up.className = 'mini'; up.textContent = '\u25B2'; up.title = 'Earlier in rounding order';
    up.addEventListener('click', ev => { ev.stopPropagation(); moveBuoy(i, -1); });
    const down = document.createElement('button');
    down.className = 'mini'; down.textContent = '\u25BC'; down.title = 'Later in rounding order';
    down.addEventListener('click', ev => { ev.stopPropagation(); moveBuoy(i, 1); });
    const del = document.createElement('button');
    del.className = 'mini'; del.textContent = '\u2715'; del.title = 'Delete buoy';
    del.addEventListener('click', ev => {
      ev.stopPropagation();
      selection = { kind: 'buoy', index: i };
      deleteSelectedBuoy();
    });
    item.appendChild(up); item.appendChild(down); item.appendChild(del);

    item.addEventListener('click', () => {
      selection = { kind: 'buoy', index: i };
      refreshOnly();
    });
    els.buoyList.appendChild(item);
  });
}

function refreshBuoyProps() {
  const sel = selection?.kind === 'buoy' ? track.buoys[selection.index] : null;
  els.buoyProps.style.display = sel ? '' : 'none';
  if (!sel) return;
  const isTurn = sel.type !== 'marker';
  setInput(els.buoyType, isTurn ? 'turn' : 'marker');
  els.rowRounding.style.display = isTurn ? '' : 'none';
  els.rowOptimalSpeed.style.display = isTurn ? '' : 'none';
  if (isTurn) {
    setInput(els.buoyRounding, sel.rounding || 'port');
    setInput(els.buoyOptimalSpeed, sel.optimalSpeed ?? 30);
  }
  setInput(els.buoyX, sel.x);
  setInput(els.buoyY, sel.y);
}

function refreshStats() {
  const s = trackStats(track);
  const area = s.bbox ? `${Math.round(s.bbox.w)} × ${Math.round(s.bbox.h)} m` : '–';
  let legsHtml = '';
  if (hasGeo(track) && s.legDistances.length) {
    legsHtml = '<br>Legs (ground): ' + s.legDistances
      .map(l => `<b>${l.from}→${l.to}: ${l.groundM.toFixed(0)} m</b>`)
      .join(', ');
  }
  const lineCount = (track.racingLines || []).filter(l => l.points?.length >= 2).length;
  els.stats.innerHTML =
    `Turn buoys: <b>${s.turnCount}</b> &nbsp; Markers: <b>${s.markerCount}</b><br>` +
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
  const sel = selection?.kind === 'buoy' ? track.buoys[selection.index] : null;
  if (!sel) return;
  pushUndo();
  sel.type = els.buoyType.value;
  if (sel.type === 'turn' && !sel.rounding) sel.rounding = 'port';
  commit();
});
els.buoyRounding.addEventListener('change', () => {
  const sel = selection?.kind === 'buoy' ? track.buoys[selection.index] : null;
  if (!sel) return;
  pushUndo();
  sel.rounding = els.buoyRounding.value;
  commit();
});
els.buoyOptimalSpeed.addEventListener('change', () => {
  const sel = selection?.kind === 'buoy' ? track.buoys[selection.index] : null;
  if (!sel) return;
  pushUndo();
  sel.optimalSpeed = Number(els.buoyOptimalSpeed.value) || 30;
  commit();
});
els.buoyX.addEventListener('change', () => {
  const sel = selection?.kind === 'buoy' ? track.buoys[selection.index] : null;
  if (!sel) return;
  pushUndo();
  sel.x = Number(els.buoyX.value) || 0;
  commit();
});
els.buoyY.addEventListener('change', () => {
  const sel = selection?.kind === 'buoy' ? track.buoys[selection.index] : null;
  if (!sel) return;
  pushUndo();
  sel.y = Number(els.buoyY.value) || 0;
  commit();
});
els.btnDeleteBuoy.addEventListener('click', deleteSelectedBuoy);

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
      pts.push({ name: `Turn ${turnNo} (${b.rounding || 'port'})`, type: 'turn', x: b.x, y: b.y, ...ll(b.x, b.y) });
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

// --- Topbar actions ---
document.getElementById('btnFit').addEventListener('click', fitView);
document.getElementById('btnUndo').addEventListener('click', undo);

document.getElementById('btnNew').addEventListener('click', () => {
  if (!confirm('Start a new track? The current draft will be replaced.')) return;
  pushUndo();
  track = withDefaults(createDefaultTrack());
  selection = null;
  if (geoOn) setGeoOn(false);
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

document.getElementById('btnExport').addEventListener('click', () => {
  const json = JSON.stringify(serializeTrack(track), null, 2);
  downloadFile(`${trackSlug()}.track.json`, 'application/json', json);
});

document.getElementById('btnImport').addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const { errors } = validateTrack(parsed);
    if (errors.length) {
      alert('Could not import track:\n' + errors.join('\n'));
      return;
    }
    pushUndo();
    track = withDefaults(parsed);
    selection = null;
    if (hasGeo(track) !== geoOn) setGeoOn(hasGeo(track));
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
