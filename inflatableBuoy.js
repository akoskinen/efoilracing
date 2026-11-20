////////////////////////////////////////////////////////////
// inflatableBuoy.js — white pyramid race buoy for the chase camera.
// 1.5 m tall. The SFT mark is a transparent navy plate; the vinyl
// shows through the letters. Overhead views keep the flat disc.
////////////////////////////////////////////////////////////

import { depthAt, projectClipped, projectHeight } from './chaseCam.js';

export const INFLATABLE_HEIGHT_M = 1.5;
export const INFLATABLE_SIDE_M = 2;

const LIGHT = normalize({ x: 0.35, y: 0.5, z: 0.79 });

let sftLogo = null;
const tintCache = new Map();

export function sftLogoImage() {
  if (!sftLogo && typeof Image !== 'undefined') {
    sftLogo = new Image();
    sftLogo.decoding = 'async';
    sftLogo.src = new URL('./assets/buoy/sft.png', import.meta.url).href;
  }
  return sftLogo;
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalize(v) {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

function addScaled(p, dir, s) {
  return { x: p.x + dir.x * s, y: p.y + dir.y * s, z: p.z + dir.z * s };
}

/** Square pyramid. `facing` is the direction one face looks, in world radians. */
export function inflatableFrame(x, y, facing, ppm) {
  const height = INFLATABLE_HEIGHT_M * ppm;
  const side = INFLATABLE_SIDE_M * ppm;
  const radius = (side / 2) * Math.SQRT2;
  const corners = [];
  for (let k = 0; k < 4; k++) {
    const a = facing - Math.PI / 4 + k * Math.PI / 2;
    corners.push({
      x: x + Math.cos(a) * radius,
      y: y + Math.sin(a) * radius,
      z: 0
    });
  }
  return {
    apex: { x, y, z: height },
    corners,
    side,
    height,
    radius
  };
}

function outward(apex, b, c) {
  return {
    x: (b.x + c.x) / 2 - apex.x,
    y: (b.y + c.y) / 2 - apex.y,
    z: 0
  };
}

export function faceNormal(apex, b, c) {
  let n = cross(sub(b, apex), sub(c, apex));
  if (dot(n, outward(apex, b, c)) < 0) n = { x: -n.x, y: -n.y, z: -n.z };
  return normalize(n);
}

/**
 * Logo rectangle on one face, largest size that stays inside the triangle.
 * Returns TL, TR, BR, BL in world pixels, or null.
 */
export function logoQuadOnFace(apex, baseL, baseR, aspect) {
  const mid = {
    x: (baseL.x + baseR.x) / 2,
    y: (baseL.y + baseR.y) / 2,
    z: (baseL.z + baseR.z) / 2
  };
  const edge = sub(baseR, baseL);
  const side = Math.hypot(edge.x, edge.y, edge.z);
  const toApex = sub(apex, mid);
  const slant = Math.hypot(toApex.x, toApex.y, toApex.z);
  if (!(side > 0) || !(slant > 0) || !(aspect > 0)) return null;
  const up = { x: toApex.x / slant, y: toApex.y / slant, z: toApex.z / slant };
  // Outside the face, left-to-right follows the viewer's right so the mark is not mirrored.
  const out = outward(apex, baseL, baseR);
  let right = cross(out, up);
  const rm = Math.hypot(right.x, right.y, right.z);
  if (!(rm > 1e-6)) right = { x: edge.x / side, y: edge.y / side, z: edge.z / side };
  else right = { x: right.x / rm, y: right.y / rm, z: right.z / rm };

  const pad = 0.1;
  let chosen = null;
  for (let i = 92; i >= 30; i--) {
    const w = side * (i / 100);
    const h = w / aspect;
    const bottom = slant * 0.9;
    const top = bottom - h;
    if (top < slant * 0.2) continue;
    const halfTop = (top / slant) * (side / 2) * (1 - pad);
    const halfBot = (bottom / slant) * (side / 2) * (1 - pad);
    if (w / 2 > halfTop || w / 2 > halfBot) continue;
    chosen = { w, h, top, bottom };
    break;
  }
  if (!chosen) return null;

  const centerS = (chosen.top + chosen.bottom) / 2;
  const center = addScaled(apex, { x: -up.x, y: -up.y, z: -up.z }, centerS);
  const hw = chosen.w / 2;
  const hh = chosen.h / 2;
  const tl = {
    x: center.x - right.x * hw + up.x * hh,
    y: center.y - right.y * hw + up.y * hh,
    z: center.z - right.z * hw + up.z * hh
  };
  const tr = {
    x: center.x + right.x * hw + up.x * hh,
    y: center.y + right.y * hw + up.y * hh,
    z: center.z + right.z * hw + up.z * hh
  };
  const br = {
    x: center.x + right.x * hw - up.x * hh,
    y: center.y + right.y * hw - up.y * hh,
    z: center.z + right.z * hw - up.z * hh
  };
  const bl = {
    x: center.x - right.x * hw - up.x * hh,
    y: center.y - right.y * hw - up.y * hh,
    z: center.z - right.z * hw - up.z * hh
  };
  return [tl, tr, br, bl];
}

function squareAt(x, y, facing, radius) {
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const a = facing - Math.PI / 4 + k * Math.PI / 2;
    pts.push({ x: x + Math.cos(a) * radius, y: y + Math.sin(a) * radius, z: 0 });
  }
  return pts;
}

function fillPoly(ctx, poly, color) {
  if (!poly || poly.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function vinyl(shade) {
  const v = Math.round(255 * Math.max(0, Math.min(1, shade)));
  return `rgb(${v},${v},${v})`;
}

function drawTriangleImage(ctx, img, s0, s1, s2, d0, d1, d2) {
  const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denom) < 1e-4) return;
  const map = (dx0, dx1, dx2) => (
    dx0 * (s1.y - s2.y) + dx1 * (s2.y - s0.y) + dx2 * (s0.y - s1.y)
  ) / denom;
  const mapE = (dx0, dx1, dx2) => (
    dx0 * (s1.x * s2.y - s2.x * s1.y) +
    dx1 * (s2.x * s0.y - s0.x * s2.y) +
    dx2 * (s0.x * s1.y - s1.x * s0.y)
  ) / denom;
  const a = map(d0.x, d1.x, d2.x);
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
  const e = mapE(d0.x, d1.x, d2.x);
  const b = map(d0.y, d1.y, d2.y);
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
  const f = mapE(d0.y, d1.y, d2.y);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function bilinear(quad, u, v) {
  const tl = quad[0];
  const tr = quad[1];
  const br = quad[2];
  const bl = quad[3];
  const x = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x;
  const y = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y;
  const z = (1 - u) * (1 - v) * tl.z + u * (1 - v) * tr.z + u * v * br.z + (1 - u) * v * bl.z;
  return { x, y, z };
}

function tintedLogo(img, shade) {
  const key = Math.round(Math.max(0, Math.min(1, shade)) * 24);
  const hit = tintCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, c.width, c.height);
  const s = key / 24;
  const data = im.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] *= s;
    data[i + 1] *= s;
    data[i + 2] *= s;
  }
  g.putImageData(im, 0, 0);
  tintCache.set(key, c);
  return c;
}

function drawLogo(ctx, cam, img, shade, quad) {
  if (!img || !img.complete || !img.naturalWidth) return;
  const cols = 6;
  const rows = 3;
  const grid = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const p = bilinear(quad, i / cols, j / rows);
      const s = projectHeight(cam, p.x, p.y, p.z);
      if (!s) return;
      grid.push(s);
    }
  }
  const paint = tintedLogo(img, shade);
  const w = img.width;
  const h = img.height;
  const at = (i, j) => grid[j * (cols + 1) + i];
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u0 = (i / cols) * w;
      const u1 = ((i + 1) / cols) * w;
      const v0 = (j / rows) * h;
      const v1 = ((j + 1) / rows) * h;
      const d00 = at(i, j);
      const d10 = at(i + 1, j);
      const d11 = at(i + 1, j + 1);
      const d01 = at(i, j + 1);
      drawTriangleImage(ctx, paint, { x: u0, y: v0 }, { x: u1, y: v0 }, { x: u1, y: v1 }, d00, d10, d11);
      drawTriangleImage(ctx, paint, { x: u0, y: v0 }, { x: u1, y: v1 }, { x: u0, y: v1 }, d00, d11, d01);
    }
  }
  ctx.restore();
}

function circlePoints(x, y, radius) {
  const pts = [];
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: x + Math.cos(a) * radius, y: y + Math.sin(a) * radius, z: 0 });
  }
  return pts;
}

/**
 * Draw one chase-view buoy. `paint` is the pass-side color used as the
 * waterline ring. `facing` aims one face toward the course.
 */
export function drawInflatableBuoy(ctx, cam, { x, y, ppm, paint, facing, logo }) {
  const frame = inflatableFrame(x, y, facing || 0, ppm);
  const shadow = projectClipped(cam, circlePoints(x, y, frame.radius * 0.72));
  fillPoly(ctx, shadow, 'rgba(0,0,0,0.28)');
  fillPoly(ctx, projectClipped(cam, squareAt(x, y, facing || 0, frame.radius + 0.28 * ppm)), paint.stroke);
  fillPoly(ctx, projectClipped(cam, squareAt(x, y, facing || 0, frame.radius + 0.12 * ppm)), paint.fill);

  const faces = frame.corners.map((corner, k) => {
    const b = corner;
    const c = frame.corners[(k + 1) % 4];
    const normal = faceNormal(frame.apex, b, c);
    const centroid = {
      x: (frame.apex.x + b.x + c.x) / 3,
      y: (frame.apex.y + b.y + c.y) / 3,
      z: (frame.apex.z + b.z + c.z) / 3
    };
    return { b, c, normal, centroid, depth: depthAt(cam, centroid.x, centroid.y, centroid.z) };
  });
  faces.sort((a, b) => b.depth - a.depth);

  const logoReady = logo && logo.complete && logo.naturalWidth > 0;
  const aspect = logoReady ? logo.naturalWidth / logo.naturalHeight : 0;

  for (const face of faces) {
    const toEye = {
      x: cam.eyeX - face.centroid.x,
      y: cam.eyeY - face.centroid.y,
      z: cam.eyeZ - face.centroid.z
    };
    if (dot(face.normal, toEye) <= 0.02) continue;
    const nd = Math.max(0, dot(face.normal, LIGHT));
    const shade = 0.8 + 0.2 * nd;
    const hi = Math.min(1, shade * 1.08);
    const lo = shade * 0.86;
    const poly = projectClipped(cam, [frame.apex, face.b, face.c]);
    if (!poly) continue;
    const apexS = projectHeight(cam, frame.apex.x, frame.apex.y, frame.apex.z);
    const midS = projectHeight(
      cam,
      (face.b.x + face.c.x) / 2,
      (face.b.y + face.c.y) / 2,
      0
    );
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    if (apexS && midS) {
      const g = ctx.createLinearGradient(apexS.x, apexS.y, midS.x, midS.y);
      g.addColorStop(0, vinyl(hi));
      g.addColorStop(1, vinyl(lo));
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = vinyl(shade);
    }
    ctx.fill();

    const facingCam = dot(face.normal, normalize(toEye));
    if (logoReady && facingCam > 0.42) {
      const quad = logoQuadOnFace(frame.apex, face.b, face.c, aspect);
      if (quad) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
        ctx.closePath();
        ctx.clip();
        drawLogo(ctx, cam, logo, shade, quad);
        ctx.restore();
      }
    }

    if (poly.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = 'rgba(30, 40, 50, 0.38)';
      ctx.stroke();
    }
  }
}
